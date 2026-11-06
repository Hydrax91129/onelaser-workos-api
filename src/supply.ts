/* Smart supply chain: live stock health per SKU and inbound shipments.
 *
 * Nothing here keeps its own stock count. Quantities, sales speed and stock age are all read from
 * the WMS ledger (wms_stock, wms_movements):
 *   DS (daily sold)   US-warehouse goods-out movements over the last 7 / 30 / 90 days ÷ days
 *   stock age         first in, first out: the units on hand are the most recent ones that came into
 *                     the US warehouse; opening stock uses the received dates imported into supply_lots
 *   days of cover     US stock ÷ DS30
 * Shipments (vessel, B/L, containers, ETD/ETA, per-SKU lines) are the only data this module owns.
 * Their stock effect is written to the WMS ledger in the same transaction:
 *   depart   factory location → in transit (or goods in to in transit for new production)
 *   receive  the warehouse operator enters the counted quantity of every line; in transit → US.
 *            Any difference becomes a pending WMS count adjustment that a manager confirms.
 *
 * Access: view = grant supply / supply_manage or a company owner; shipments and settings need
 * supply_manage; receiving needs warehouse manage (warehouse_manage); stock value needs
 * product_cost_detail. Opening stock age is imported by company owners only.
 * Alerts go to the in-app inbox (pushInbox) of everyone with supply access, each one once. */
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { Database, Queryable } from './db.js';
import type { User } from './auth.js';
import { deny } from './errors.js';
import { pushInbox } from './inbox.js';
import { warehouseLevelFor } from './wms.js';

export const supplySchema = `
CREATE TABLE IF NOT EXISTS supply_settings(org_id text PRIMARY KEY, settings jsonb NOT NULL DEFAULT '{}', updated_by text, updated_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE IF NOT EXISTS supply_shipments(id text PRIMARY KEY, org_id text NOT NULL, vessel text NOT NULL, voyage text NOT NULL DEFAULT '', bl_no text NOT NULL DEFAULT '',
  containers text NOT NULL DEFAULT '', forwarder text NOT NULL DEFAULT '', origin_port text NOT NULL DEFAULT '', dest_port text NOT NULL DEFAULT '',
  etd date, eta date, status text NOT NULL DEFAULT 'booked', note text NOT NULL DEFAULT '', created_by text NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
  updated_by text, updated_at timestamptz NOT NULL DEFAULT now(), departed_at timestamptz, departed_by text, received_at timestamptz, received_by text);
CREATE INDEX IF NOT EXISTS supply_shipments_org ON supply_shipments(org_id,status);
CREATE TABLE IF NOT EXISTS supply_shipment_lines(shipment_id text NOT NULL, line_no integer NOT NULL, sku text NOT NULL, qty integer NOT NULL CHECK (qty > 0),
  cartons integer, from_location text NOT NULL DEFAULT 'dg', received_qty integer, PRIMARY KEY(shipment_id,line_no));
CREATE TABLE IF NOT EXISTS supply_lots(id text PRIMARY KEY, org_id text NOT NULL, sku text NOT NULL, received_on date NOT NULL, qty integer NOT NULL CHECK (qty > 0),
  ref text NOT NULL DEFAULT '', import_id text NOT NULL, created_at timestamptz NOT NULL DEFAULT now());
CREATE INDEX IF NOT EXISTS supply_lots_sku ON supply_lots(org_id,sku);
CREATE TABLE IF NOT EXISTS supply_lot_imports(id text PRIMARY KEY, org_id text NOT NULL, as_of date NOT NULL, rows integer NOT NULL, created_by text NOT NULL, created_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE IF NOT EXISTS supply_alert_log(key text PRIMARY KEY, created_at timestamptz NOT NULL DEFAULT now());
`;

/** Company defaults (KC, Nov 2026): ocean 40 days, 30 days safety stock, aged after 60 days, overstock past 120 days of cover. */
export const SUPPLY_DEFAULTS = { shipDays: 40, safetyDays: 30, agedDays: 60, overstockDays: 120, prodDaysMachine: 25, prodDaysOther: 12, orderCoverDays: 60 };
export type SupplySettings = typeof SUPPLY_DEFAULTS;
const days = (max: number, min = 0) => z.number().int().min(min).max(max);
const settingsInput = z.object({
  shipDays: days(180, 1), safetyDays: days(180), agedDays: days(730, 1), overstockDays: days(730, 1),
  prodDaysMachine: days(180), prodDaysOther: days(180), orderCoverDays: days(365),
}).partial().strict();

export const SHIP_STATUS = ['booked', 'at_sea', 'at_port', 'customs', 'received', 'cancelled'] as const;
const OPEN_AT_SEA = ['at_sea', 'at_port', 'customs'];
const FROM = ['dg', 'jn', 'new'] as const;
const DAY = 86400000;
const isMachine = (type: string) => /整机|machine/i.test(type || '');
const ymd = (d: any) => d == null ? null : (d instanceof Date ? d.toISOString().slice(0, 10) : String(d).slice(0, 10));
const dateStr = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use a YYYY-MM-DD date');
const skuStr = z.string().trim().min(1).max(80);
const txt = (n: number) => z.string().trim().max(n);
const nameOf = (u: any) => u ? (u.display_name || u.name_zh || u.name_en || u.id) : '';

export type StockRow = { us: number; transit: number; factory: number; onOrder: number; booked?: number; ds7: number; ds30: number; ds90: number;
  oldestAge: number | null; nextEtaDays: number | null; type: string; status: string };
/** Health of one SKU. States in priority order: stockout, reorder, idle, excess, aged, ok. */
export function assess(r: StockRow, s: SupplySettings) {
  const v = r.ds30, prod = isMachine(r.type) ? s.prodDaysMachine : s.prodDaysOther, lead = prod + s.shipDays;
  const pipeline = r.us + r.transit + r.factory + r.onOrder;
  const cover = v > 0 ? r.us / v : null;
  const reorderQty = v > 0 ? Math.max(0, Math.ceil(v * (lead + s.safetyDays + s.orderCoverDays) - pipeline)) : 0;
  // Factory units already booked on a ship are on their way: they count as inbound and are no longer free to send.
  const booked = r.booked || 0, free = Math.max(0, r.factory - booked);
  const transferQty = v > 0 && free > 0 ? Math.min(free, Math.max(0, Math.ceil(v * (s.shipDays + s.safetyDays + s.orderCoverDays) - r.us - r.transit - r.onOrder - booked))) : 0;
  const winding = ['eol', 'eolPlanned', 'clearance'].includes(r.status);
  const flags: string[] = [];
  // Out of stock before the next ship lands (with nothing on the water, before a new shipment could arrive).
  if (v > 0 && !winding && cover! < (r.nextEtaDays ?? s.shipDays)) flags.push('stockout');
  if (v > 0 && !winding && (pipeline < v * (lead + s.safetyDays) || transferQty > 0)) flags.push('reorder');
  if (r.us > 0 && v === 0) flags.push('idle');
  if (v > 0 && cover! > s.overstockDays) flags.push('excess');
  if (r.us > 0 && r.oldestAge != null && r.oldestAge > s.agedDays) flags.push('aged');
  const state = flags[0] || 'ok';
  return { state, flags, cover, lead, pipeline, reorderQty: flags.includes('reorder') ? reorderQty : 0, transferQty: flags.includes('reorder') ? transferQty : 0,
    trend: r.ds30 > 0 ? Math.round((r.ds7 / r.ds30 - 1) * 100) : null };
}

/** First in, first out: the units on hand are the newest arrivals. Returns average and oldest age in days. */
export function fifoAge(onHand: number, arrivals: { at: number; qty: number }[], now: number) {
  if (onHand <= 0) return { avgAge: null, oldestAge: null, agedUnits: 0, known: true, lots: [] as { age: number; qty: number }[] };
  const sorted = [...arrivals].filter(a => a.qty > 0).sort((a, b) => b.at - a.at);
  let left = onHand; const lots: { age: number; qty: number }[] = [];
  for (const a of sorted) { if (left <= 0) break; const q = Math.min(left, a.qty); lots.push({ age: Math.max(0, Math.floor((now - a.at) / DAY)), qty: q }); left -= q; }
  const known = left === 0;
  if (!known && lots.length) lots[lots.length - 1].qty += left; // units older than the ledger: counted with the oldest known arrival
  if (!lots.length) return { avgAge: null, oldestAge: null, agedUnits: 0, known: false, lots };
  const total = lots.reduce((n, l) => n + l.qty, 0);
  return { avgAge: Math.round(lots.reduce((n, l) => n + l.age * l.qty, 0) / total), oldestAge: lots[lots.length - 1].age, agedUnits: 0, known, lots };
}

export async function registerSupplyRoutes(app: FastifyInstance, db: Database, o: { isAdmin: (u: User) => boolean; now?: () => Date; intervalMs?: number }) {
  const now = () => (o.now ? o.now() : new Date());
  const actorOf = (req: FastifyRequest): User => req.actor || deny(401, 'UNAUTHENTICATED', 'Authentication is required', '请先登录。');
  const grantsOf = (u: any): string[] => Array.isArray(u.grants) ? u.grants : [];
  const canView = (u: User) => o.isAdmin(u) || grantsOf(u).includes('supply') || grantsOf(u).includes('supply_manage');
  const canManage = (u: User) => o.isAdmin(u) || grantsOf(u).includes('supply_manage');
  const canReceive = (u: User) => warehouseLevelFor(u, o.isAdmin(u)) === 'manage';
  const canValue = (u: User) => o.isAdmin(u) || grantsOf(u).includes('product_cost_detail');
  const requireView = (u: User) => { if (!canView(u)) deny(403, 'SUPPLY_FORBIDDEN', 'You do not have access to the supply chain', '你没有智能供应链的查看权限，请联系主管理员开通。'); };
  const requireManage = (u: User) => { if (!canManage(u)) deny(403, 'SUPPLY_MANAGE_ONLY', 'Only supply chain managers can change shipments and settings', '只有供应链管理权限的人可以登记船次和修改参数。'); };
  const audit = (tx: Queryable, u: User, action: string, objectId: string, details: unknown) =>
    tx.query('INSERT INTO audit_events(id,org_id,department_id,owner_id,actor_id,action,object_id,details) VALUES($1,$2,$3,$4,$5,$6,$7,$8)',
      [randomUUID(), u.org_id, u.department_id, u.id, u.id, action, objectId, JSON.stringify(details)]);

  const settingsOf = async (q: Queryable, org: string): Promise<SupplySettings> => {
    const row = (await q.query('SELECT settings FROM supply_settings WHERE org_id=$1', [org])).rows[0];
    return { ...SUPPLY_DEFAULTS, ...(row?.settings || {}) };
  };

  /* ---------- WMS ledger writes (same rules as wms.ts: never below zero, every change has a movement) ---------- */
  const stockOf = async (tx: Queryable, org: string, sku: string, loc: string) =>
    Number((await tx.query('SELECT qty FROM wms_stock WHERE org_id=$1 AND sku=$2 AND location=$3 FOR UPDATE', [org, sku, loc])).rows[0]?.qty ?? 0);
  const addStock = async (tx: Queryable, org: string, sku: string, loc: string, delta: number, label: string) => {
    const have = await stockOf(tx, org, sku, loc);
    if (have + delta < 0) deny(409, 'WMS_NEGATIVE_STOCK', `Not enough stock of ${sku} at ${label}: ${have} on hand, ${-delta} needed`, `${sku} 在${label}的库存不足：现有 ${have} 件，需要 ${-delta} 件`);
    await tx.query('INSERT INTO wms_stock(org_id,sku,location,qty) VALUES($1,$2,$3,$4) ON CONFLICT(org_id,sku,location) DO UPDATE SET qty=$4', [org, sku, loc, have + delta]);
  };
  const move = (tx: Queryable, u: User, m: { type: string; sku: string; location: string; to?: string | null; qty: number; reason: string; reference: string; status?: string; counted?: number | null; system?: number | null }) =>
    tx.query(`INSERT INTO wms_movements(id,org_id,type,sku,location,to_location,qty,counted,system_qty,reason,reference,status,created_by) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
      [randomUUID(), u.org_id, m.type, m.sku, m.location, m.to || null, m.qty, m.counted ?? null, m.system ?? null, m.reason.slice(0, 200), m.reference.slice(0, 80), m.status || 'done', u.id]);
  const LOC_ZH: Record<string, string> = { dg: '东莞工厂仓', jn: '济南工厂仓', transit: '在途', us: '美国仓' };

  /* ---------- shipments ---------- */
  const shipmentsOf = async (q: Queryable, org: string, today: number, filter = `status NOT IN ('cancelled') AND (status<>'received' OR received_at > now() - interval '45 days')`) => {
    const ships = (await q.query(`SELECT * FROM supply_shipments WHERE org_id=$1 AND ${filter} ORDER BY COALESCE(eta,etd,created_at::date), created_at`, [org])).rows;
    if (!ships.length) return [];
    const lines = (await q.query(`SELECT l.*,i.name FROM supply_shipment_lines l LEFT JOIN wms_items i ON i.org_id=$1 AND i.sku=l.sku WHERE l.shipment_id = ANY($2) ORDER BY l.line_no`, [org, ships.map((s: any) => s.id)])).rows;
    const people = new Map((await q.query('SELECT id,display_name,name_zh,name_en FROM users WHERE org_id=$1', [org])).rows.map((p: any) => [p.id, p]));
    return ships.map((s: any) => {
      const ls = lines.filter((l: any) => l.shipment_id === s.id).map((l: any) => ({ lineNo: l.line_no, sku: l.sku, name: l.name || l.sku, qty: Number(l.qty), cartons: l.cartons == null ? null : Number(l.cartons), from: l.from_location, received: l.received_qty == null ? null : Number(l.received_qty) }));
      const eta = ymd(s.eta), daysToEta = eta ? Math.round((Date.parse(eta) - today) / DAY) : null;
      return { id: s.id, vessel: s.vessel, voyage: s.voyage, blNo: s.bl_no, containers: s.containers, forwarder: s.forwarder, originPort: s.origin_port, destPort: s.dest_port,
        etd: ymd(s.etd), eta, status: s.status, note: s.note, lines: ls, units: ls.reduce((n: number, l: any) => n + l.qty, 0), daysToEta,
        late: s.status === 'at_sea' && daysToEta != null && daysToEta < 0, createdByName: nameOf(people.get(s.created_by)),
        receivedAt: s.received_at, receivedByName: nameOf(people.get(s.received_by)), departedAt: s.departed_at };
    });
  };
  const shipmentOf = async (tx: Queryable, u: User, id: string) => {
    const s = (await tx.query('SELECT * FROM supply_shipments WHERE id=$1 AND org_id=$2 FOR UPDATE', [id, u.org_id])).rows[0];
    if (!s) deny(404, 'NOT_FOUND', 'Shipment not found', '找不到这个船次。');
    return s;
  };
  const lineInput = z.object({ sku: skuStr, qty: z.number().int().positive().max(1_000_000), cartons: z.number().int().min(0).max(1_000_000).nullable().optional(), from: z.enum(FROM).optional() }).strict();
  const shipFields = {
    vessel: z.string().trim().min(1).max(120), voyage: txt(60), blNo: txt(80), containers: txt(400), forwarder: txt(120), originPort: txt(80), destPort: txt(80),
    etd: dateStr.nullable(), eta: dateStr.nullable(), note: txt(1000),
  };
  const createInput = z.object({ ...shipFields, lines: z.array(lineInput).min(1).max(200) }).partial({ voyage: true, blNo: true, containers: true, forwarder: true, originPort: true, destPort: true, etd: true, eta: true, note: true }).strict();
  const patchInput = z.object({ ...shipFields, status: z.enum(['at_sea', 'at_port', 'customs']), lines: z.array(lineInput).min(1).max(200) }).partial().strict();
  const checkLines = async (tx: Queryable, org: string, lines: z.infer<typeof lineInput>[]) => {
    const known = new Map((await tx.query('SELECT sku FROM wms_items WHERE org_id=$1', [org])).rows.map((r: any) => [r.sku.toLowerCase(), r.sku]));
    const missing = lines.map(l => l.sku).filter(s => !known.has(s.toLowerCase()));
    if (missing.length) deny(400, 'WMS_UNKNOWN_SKUS', `These SKUs do not exist yet: ${missing.slice(0, 10).join(', ')}`, `这些 SKU 还不存在，请先在 WMS 新增：${missing.slice(0, 10).join('、')}`);
    return lines.map(l => ({ ...l, sku: known.get(l.sku.toLowerCase())! }));
  };
  const writeLines = async (tx: Queryable, id: string, lines: (z.infer<typeof lineInput>)[]) => {
    await tx.query('DELETE FROM supply_shipment_lines WHERE shipment_id=$1', [id]);
    let n = 0;
    for (const l of lines) await tx.query('INSERT INTO supply_shipment_lines(shipment_id,line_no,sku,qty,cartons,from_location) VALUES($1,$2,$3,$4,$5,$6)', [id, ++n, l.sku, l.qty, l.cartons ?? null, l.from || 'dg']);
  };

  app.post('/supply/shipments', async (req, reply) => {
    const u = actorOf(req); requireManage(u);
    const v = createInput.parse(req.body);
    const id = await db.transaction(async tx => {
      const lines = await checkLines(tx, u.org_id, v.lines);
      const sid = randomUUID();
      await tx.query(`INSERT INTO supply_shipments(id,org_id,vessel,voyage,bl_no,containers,forwarder,origin_port,dest_port,etd,eta,note,created_by,updated_by) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$13)`,
        [sid, u.org_id, v.vessel, v.voyage || '', v.blNo || '', v.containers || '', v.forwarder || '', v.originPort || '', v.destPort || '', v.etd || null, v.eta || null, v.note || '', u.id]);
      await writeLines(tx, sid, lines);
      await audit(tx, u, 'supply.shipment.create', sid, { vessel: v.vessel, lines: lines.length, units: lines.reduce((n, l) => n + l.qty, 0) });
      return sid;
    });
    reply.code(201);
    return { id };
  });

  app.patch<{ Params: { id: string } }>('/supply/shipments/:id', async req => {
    const u = actorOf(req); requireManage(u);
    const v = patchInput.parse(req.body);
    return db.transaction(async tx => {
      const s = await shipmentOf(tx, u, req.params.id);
      if (['received', 'cancelled'].includes(s.status)) deny(409, 'SUPPLY_SHIPMENT_CLOSED', 'This shipment is closed', '这个船次已入库或已取消，不能再修改。');
      if (v.lines && s.status !== 'booked') deny(409, 'SUPPLY_LINES_LOCKED', 'Cargo lines are fixed once the ship has sailed', '已开船的船次不能再改货物明细；到货差异在确认入库时填写实收数量。');
      if (v.status && s.status === 'booked') deny(409, 'SUPPLY_NOT_DEPARTED', 'Mark the shipment as sailed first', '请先点“已开船”，再更新到港、清关状态。');
      const cols: [string, any][] = [];
      const map: Record<string, string> = { vessel: 'vessel', voyage: 'voyage', blNo: 'bl_no', containers: 'containers', forwarder: 'forwarder', originPort: 'origin_port', destPort: 'dest_port', etd: 'etd', eta: 'eta', note: 'note', status: 'status' };
      for (const [k, c] of Object.entries(map)) if ((v as any)[k] !== undefined) cols.push([c, (v as any)[k]]);
      if (cols.length) await tx.query(`UPDATE supply_shipments SET ${cols.map(([c], i) => `${c}=$${i + 3}`).join(',')},updated_by=$2,updated_at=now() WHERE id=$1`, [s.id, u.id, ...cols.map(x => x[1])]);
      if (v.lines) await writeLines(tx, s.id, await checkLines(tx, u.org_id, v.lines));
      await audit(tx, u, 'supply.shipment.update', s.id, { fields: Object.keys(v) });
      return { ok: true };
    });
  });

  /* Sailed: the goods leave the factory warehouse and are in transit. stockAlreadyInTransit is for shipments that were
   * already at sea when the opening stock was imported (their units are already counted in the in-transit location). */
  app.post<{ Params: { id: string } }>('/supply/shipments/:id/depart', async req => {
    const u = actorOf(req); requireManage(u);
    const v = z.object({ stockAlreadyInTransit: z.boolean().optional() }).strict().parse(req.body || {});
    return db.transaction(async tx => {
      const s = await shipmentOf(tx, u, req.params.id);
      if (s.status !== 'booked') deny(409, 'SUPPLY_ALREADY_DEPARTED', 'This shipment has already sailed', '这个船次已经开船了。');
      const lines = (await tx.query('SELECT * FROM supply_shipment_lines WHERE shipment_id=$1 ORDER BY line_no', [s.id])).rows;
      const ref = s.bl_no || s.vessel, reason = `船次开船 ${s.vessel}${s.voyage ? ' ' + s.voyage : ''}`;
      if (!v.stockAlreadyInTransit) for (const l of lines) {
        const qty = Number(l.qty);
        if (l.from_location === 'new') { await addStock(tx, u.org_id, l.sku, 'transit', qty, LOC_ZH.transit); await move(tx, u, { type: 'in', sku: l.sku, location: 'transit', qty, reason: reason + '（新生产直发）', reference: ref }); }
        else { await addStock(tx, u.org_id, l.sku, l.from_location, -qty, LOC_ZH[l.from_location]); await addStock(tx, u.org_id, l.sku, 'transit', qty, LOC_ZH.transit); await move(tx, u, { type: 'transfer', sku: l.sku, location: l.from_location, to: 'transit', qty, reason, reference: ref }); }
      }
      await tx.query(`UPDATE supply_shipments SET status='at_sea',departed_at=now(),departed_by=$2,updated_by=$2,updated_at=now() WHERE id=$1`, [s.id, u.id]);
      await audit(tx, u, 'supply.shipment.depart', s.id, { stockAlreadyInTransit: !!v.stockAlreadyInTransit, lines: lines.length });
      return { ok: true };
    });
  });

  /* Goods received: the warehouse operator counts every line. Counted units move from in transit to the US warehouse;
   * a shortage or surplus is recorded as a pending WMS count adjustment that the operator's manager confirms. */
  const receiveInput = z.object({ lines: z.array(z.object({ lineNo: z.number().int().positive(), received: z.number().int().min(0).max(1_000_000) }).strict()).min(1).max(200), note: txt(300).optional() }).strict();
  app.post<{ Params: { id: string } }>('/supply/shipments/:id/receive', async req => {
    const u = actorOf(req);
    if (!canReceive(u)) deny(403, 'SUPPLY_RECEIVE_WAREHOUSE_ONLY', 'Only warehouse operators can receive goods', '只有 WMS 仓库操作权限的人可以核对数量并确认入库。');
    const v = receiveInput.parse(req.body);
    return db.transaction(async tx => {
      const s = await shipmentOf(tx, u, req.params.id);
      if (!OPEN_AT_SEA.includes(s.status)) deny(409, 'SUPPLY_NOT_RECEIVABLE', s.status === 'received' ? 'This shipment has already been received' : 'Only a shipment that has sailed can be received',
        s.status === 'received' ? '这个船次已经入库了。' : '只有已开船的船次可以确认入库。');
      const lines = (await tx.query('SELECT * FROM supply_shipment_lines WHERE shipment_id=$1 ORDER BY line_no', [s.id])).rows;
      const counted = new Map(v.lines.map(l => [l.lineNo, l.received]));
      const missing = lines.filter((l: any) => !counted.has(l.line_no));
      if (missing.length) deny(400, 'SUPPLY_COUNT_EVERY_LINE', 'Enter the counted quantity of every line', `请逐行填写实收数量（还差第 ${missing.map((l: any) => l.line_no).join('、')} 行）。`);
      const ref = s.bl_no || s.vessel, reason = `船次到货入库 ${s.vessel}${s.voyage ? ' ' + s.voyage : ''}${v.note ? ' · ' + v.note : ''}`;
      let units = 0, differences = 0;
      for (const l of lines) {
        const shipped = Number(l.qty), got = counted.get(l.line_no)!, moved = Math.min(shipped, got);
        if (moved > 0) { await addStock(tx, u.org_id, l.sku, 'transit', -moved, LOC_ZH.transit); await addStock(tx, u.org_id, l.sku, 'us', moved, LOC_ZH.us); await move(tx, u, { type: 'transfer', sku: l.sku, location: 'transit', to: 'us', qty: moved, reason, reference: ref }); }
        if (got < shipped) { const sys = await stockOf(tx, u.org_id, l.sku, 'transit'), diff = shipped - got; differences++;
          await move(tx, u, { type: 'adjust', sku: l.sku, location: 'transit', qty: -Math.min(diff, sys), counted: Math.max(0, sys - diff), system: sys, reason: `到货少收 ${diff} 件（装箱 ${shipped}，实收 ${got}）· ${s.vessel}`, reference: ref, status: 'pending' }); }
        if (got > shipped) { const sys = await stockOf(tx, u.org_id, l.sku, 'us'), diff = got - shipped; differences++;
          await move(tx, u, { type: 'adjust', sku: l.sku, location: 'us', qty: diff, counted: sys + diff, system: sys, reason: `到货多收 ${diff} 件（装箱 ${shipped}，实收 ${got}）· ${s.vessel}`, reference: ref, status: 'pending' }); }
        await tx.query('UPDATE supply_shipment_lines SET received_qty=$3 WHERE shipment_id=$1 AND line_no=$2', [s.id, l.line_no, got]);
        units += moved;
      }
      await tx.query(`UPDATE supply_shipments SET status='received',received_at=now(),received_by=$2,updated_by=$2,updated_at=now() WHERE id=$1`, [s.id, u.id]);
      await audit(tx, u, 'supply.shipment.receive', s.id, { lines: lines.length, units, differences });
      return { units, differences };
    });
  });

  app.post<{ Params: { id: string } }>('/supply/shipments/:id/cancel', async req => {
    const u = actorOf(req); requireManage(u);
    return db.transaction(async tx => {
      const s = await shipmentOf(tx, u, req.params.id);
      if (s.status !== 'booked') deny(409, 'SUPPLY_CANCEL_BOOKED_ONLY', 'Only a shipment that has not sailed can be cancelled', '只有还没开船的船次可以取消。');
      await tx.query(`UPDATE supply_shipments SET status='cancelled',updated_by=$2,updated_at=now() WHERE id=$1`, [s.id, u.id]);
      await audit(tx, u, 'supply.shipment.cancel', s.id, {});
      return { ok: true };
    });
  });

  app.put('/supply/settings', async req => {
    const u = actorOf(req); requireManage(u);
    const v = settingsInput.parse(req.body);
    return db.transaction(async tx => {
      const next = { ...(await settingsOf(tx, u.org_id)), ...v };
      await tx.query(`INSERT INTO supply_settings(org_id,settings,updated_by) VALUES($1,$2,$3) ON CONFLICT(org_id) DO UPDATE SET settings=$2,updated_by=$3,updated_at=now()`, [u.org_id, JSON.stringify(next), u.id]);
      await audit(tx, u, 'supply.settings', u.org_id, v);
      return { settings: next };
    });
  });

  /* Opening stock age: the received date of each batch on hand in the US warehouse. Company owners only.
   * Replaces the lots of every SKU in the file; SKUs not in the file keep theirs. */
  const lotsInput = z.object({ asOf: dateStr, rows: z.array(z.object({ sku: skuStr, receivedOn: dateStr, qty: z.number().int().positive().max(1_000_000), ref: txt(80).optional() }).strict()).min(1).max(20000) }).strict();
  app.post('/supply/lots/import', async req => {
    const u = actorOf(req);
    if (!o.isAdmin(u)) deny(403, 'SUPPLY_LOTS_ADMIN_ONLY', 'Only company owners can import opening stock age', '只有主管理员可以导入期初库龄。');
    const v = lotsInput.parse(req.body);
    const today = now().toISOString().slice(0, 10);
    const late = v.rows.find(r => r.receivedOn > today);
    if (late) deny(400, 'SUPPLY_LOT_FUTURE_DATE', `The received date of ${late.sku} is in the future`, `${late.sku} 的入仓日期晚于今天，请检查。`);
    return db.transaction(async tx => {
      const rows = await checkLines(tx, u.org_id, v.rows.map(r => ({ sku: r.sku, qty: r.qty }))).then(ls => ls.map((l, i) => ({ ...v.rows[i], sku: l.sku })));
      const skus = [...new Set(rows.map(r => r.sku))], id = randomUUID();
      await tx.query('DELETE FROM supply_lots WHERE org_id=$1 AND sku = ANY($2)', [u.org_id, skus]);
      for (const r of rows) await tx.query('INSERT INTO supply_lots(id,org_id,sku,received_on,qty,ref,import_id) VALUES($1,$2,$3,$4,$5,$6,$7)', [randomUUID(), u.org_id, r.sku, r.receivedOn, r.qty, r.ref || '', id]);
      await tx.query('INSERT INTO supply_lot_imports(id,org_id,as_of,rows,created_by) VALUES($1,$2,$3,$4,$5)', [id, u.org_id, v.asOf, rows.length, u.id]);
      await audit(tx, u, 'supply.lots.import', id, { asOf: v.asOf, rows: rows.length, skus: skus.length });
      return { rows: rows.length, skus: skus.length };
    });
  });

  /* ---------- the live picture ---------- */
  async function overview(q: Queryable, org: string, withValue: boolean) {
    const t = now().getTime(), today = Date.parse(now().toISOString().slice(0, 10));
    const settings = await settingsOf(q, org);
    const items = (await q.query(`SELECT i.sku,i.name,i.type,c.name_zh,c.name_en,c.type AS cat_type,c.status FROM wms_items i LEFT JOIN product_catalog c ON c.org_id=i.org_id AND lower(c.sku)=lower(i.sku) WHERE i.org_id=$1 ORDER BY i.sku`, [org])).rows;
    const stock = new Map<string, Record<string, number>>();
    for (const r of (await q.query('SELECT sku,location,qty FROM wms_stock WHERE org_id=$1', [org])).rows) { if (!stock.has(r.sku)) stock.set(r.sku, {}); stock.get(r.sku)![r.location] = Number(r.qty); }
    const since = (d: number) => new Date(t - d * DAY);
    const sold = new Map((await q.query(`SELECT sku, COALESCE(sum(abs(qty)) FILTER (WHERE created_at >= $2),0) d7, COALESCE(sum(abs(qty)) FILTER (WHERE created_at >= $3),0) d30, COALESCE(sum(abs(qty)),0) d90, max(created_at) last_out
      FROM wms_movements WHERE org_id=$1 AND type='out' AND location='us' AND status='done' AND created_at >= $4 GROUP BY sku`, [org, since(7), since(30), since(90)])).rows.map((r: any) => [r.sku, r]));
    const lastOut = new Map((await q.query(`SELECT sku,max(created_at) at FROM wms_movements WHERE org_id=$1 AND type='out' AND location='us' AND status='done' GROUP BY sku`, [org])).rows.map((r: any) => [r.sku, r.at]));
    const lots = new Map<string, { at: number; qty: number }[]>();
    for (const r of (await q.query('SELECT sku,received_on,qty FROM supply_lots WHERE org_id=$1', [org])).rows) { if (!lots.has(r.sku)) lots.set(r.sku, []); lots.get(r.sku)!.push({ at: Date.parse(ymd(r.received_on)!), qty: Number(r.qty) }); }
    const arrivals = new Map<string, { at: number; qty: number }[]>();
    for (const r of (await q.query(`SELECT sku,qty,created_at,reference FROM wms_movements WHERE org_id=$1 AND status='done' AND qty>0 AND ((type='in' AND location='us') OR (type='transfer' AND to_location='us') OR (type='adjust' AND location='us'))`, [org])).rows) {
      if (r.reference === 'IMPORT' && lots.has(r.sku)) continue; // opening balance: the imported received dates replace the import day
      if (!arrivals.has(r.sku)) arrivals.set(r.sku, []);
      arrivals.get(r.sku)!.push({ at: new Date(r.created_at).getTime(), qty: Number(r.qty) });
    }
    const ships = await shipmentsOf(q, org, today);
    const inbound = new Map<string, { eta: string | null; qty: number; status: string; vessel: string; id: string }[]>();
    for (const s of ships.filter((s: any) => s.status !== 'received')) for (const l of s.lines) { if (!inbound.has(l.sku)) inbound.set(l.sku, []); inbound.get(l.sku)!.push({ eta: s.eta, qty: l.qty, status: s.status, vessel: s.vessel, id: s.id }); }
    const prices = withValue ? new Map((await q.query('SELECT sku,landed_usd,factory_usd FROM product_pricing WHERE org_id=$1', [org])).rows.map((r: any) => [r.sku.toLowerCase(), r.landed_usd ?? r.factory_usd])) : new Map();
    const out = items.map((it: any) => {
      const qty = stock.get(it.sku) || {}, us = qty.us || 0, transit = qty.transit || 0, factory = (qty.dg || 0) + (qty.jn || 0);
      const sd = sold.get(it.sku), ds7 = Number(sd?.d7 || 0) / 7, ds30 = Number(sd?.d30 || 0) / 30, ds90 = Number(sd?.d90 || 0) / 90;
      const age = fifoAge(us, [...(lots.get(it.sku) || []), ...(arrivals.get(it.sku) || [])], t);
      const inb = (inbound.get(it.sku) || []).sort((a, b) => String(a.eta || '9').localeCompare(String(b.eta || '9')));
      const onWater = inb.filter(x => x.status !== 'booked'), next = onWater.find(x => x.eta);
      const onOrder = inb.filter(x => x.status === 'booked').reduce((n, x) => n + x.qty, 0); // booked lines are still in factory stock or not yet produced
      const newOnOrder = (ships.filter((s: any) => s.status === 'booked').flatMap((s: any) => s.lines).filter((l: any) => l.sku === it.sku && l.from === 'new')).reduce((n: number, l: any) => n + l.qty, 0);
      const nextEtaDays = next ? Math.max(0, Math.round((Date.parse(next.eta!) - today) / DAY)) : null;
      const type = it.type || it.cat_type || '';
      const h = assess({ us, transit, factory, onOrder: newOnOrder, booked: onOrder - newOnOrder, ds7, ds30, ds90, oldestAge: age.oldestAge, nextEtaDays, type, status: it.status || '' }, settings);
      const agedUnits = age.lots.filter(l => l.age > settings.agedDays).reduce((n, l) => n + l.qty, 0);
      const unit = prices.get(it.sku.toLowerCase());
      return { sku: it.sku, name: it.name_zh || it.name || it.sku, nameEn: it.name_en || it.name || it.sku, type, status: it.status || '',
        qty: { us, dg: qty.dg || 0, jn: qty.jn || 0, transit, refurb: qty.refurb || 0 }, onOrder, ds7: round1(ds7), ds30: round1(ds30), ds90: round1(ds90), sold90: Number(sd?.d90 || 0),
        lastSoldAt: lastOut.get(it.sku) || null, avgAge: age.avgAge, oldestAge: age.oldestAge, ageKnown: age.known, agedUnits, inbound: inb,
        nextEta: next ? { date: next.eta, qty: next.qty, vessel: next.vessel, days: nextEtaDays } : null,
        ...h, cover: h.cover == null ? null : Math.round(h.cover), ...(withValue ? { unitUsd: unit == null ? null : Number(unit) } : {}) };
    }).filter((x: any) => x.qty.us + x.qty.transit + x.qty.dg + x.qty.jn + x.sold90 + x.onOrder > 0);
    const lastLots = (await q.query('SELECT as_of,rows,created_at FROM supply_lot_imports WHERE org_id=$1 ORDER BY created_at DESC LIMIT 1', [org])).rows[0];
    return { settings, items: out, shipments: ships, lastLotImport: lastLots ? { asOf: ymd(lastLots.as_of), rows: lastLots.rows, at: lastLots.created_at } : null };
  }
  const round1 = (n: number) => Math.round(n * 10) / 10;

  app.get('/supply/overview', async req => {
    const u = actorOf(req); requireView(u);
    const data = await overview(db, u.org_id, canValue(u));
    return { ...data, asOf: now().toISOString(), canManage: canManage(u), canReceive: canReceive(u), canImportLots: o.isAdmin(u), canSeeValue: canValue(u) };
  });

  /* ---------- daily alerts to the inbox; each alert is sent once (keys in supply_alert_log) ---------- */
  async function runAlerts() {
    let sent = 0;
    const d = now(), day = d.toISOString().slice(0, 10), week = `${d.getUTCFullYear()}-w${Math.floor((Date.parse(day) - Date.UTC(d.getUTCFullYear(), 0, 1)) / (7 * DAY))}`;
    const orgs = (await db.query('SELECT DISTINCT org_id FROM wms_items')).rows.map((r: any) => r.org_id);
    for (const org of orgs) {
      const people = (await db.query("SELECT id,grants FROM users WHERE org_id=$1 AND active=true AND disabled_at IS NULL AND COALESCE(quality_factory,'')=''", [org])).rows;
      const recipients = people.filter((p: any) => o.isAdmin(p as User) || grantsOf(p).includes('supply') || grantsOf(p).includes('supply_manage')).map((p: any) => p.id);
      if (!recipients.length) continue;
      const data = await overview(db, org, false);
      const alerts: { key: string; title: string; body: string }[] = [];
      for (const x of data.items) if (x.state === 'stockout') alerts.push({ key: `stockout:${org}:${x.sku}:${week}`, title: `${x.name} 即将断货：美国仓 ${x.qty.us} 件，约 ${x.cover ?? 0} 天卖完`, body: x.nextEta ? `下一船 ${x.nextEta.vessel} 预计 ${x.nextEta.date} 到港` : '目前没有在途船次' });
      for (const s of data.shipments) {
        if (s.status === 'at_sea' && s.daysToEta != null && s.daysToEta >= 0 && s.daysToEta <= 3) alerts.push({ key: `eta3:${s.id}:${s.eta}`, title: `${s.vessel} 预计 ${s.eta} 到港（${s.daysToEta === 0 ? '今天' : `还有 ${s.daysToEta} 天`}）`, body: `${s.lines.length} 个 SKU · ${s.units} 件，请安排提柜和入库` });
        if (s.late) alerts.push({ key: `late:${s.id}:${s.eta}`, title: `${s.vessel} 已过预计到港日 ${s.eta}，还没有到港`, body: '请向货代确认最新到港时间并更新 ETA' });
      }
      const aged = data.items.filter((x: any) => x.flags.includes('aged'));
      if (aged.length && d.getUTCDate() <= 7) alerts.push({ key: `aged:${org}:${day.slice(0, 7)}`, title: `本月存放过长的 SKU：${aged.length} 个（库龄超过 ${data.settings.agedDays} 天）`, body: aged.slice(0, 5).map((x: any) => `${x.sku} ${x.oldestAge} 天`).join('，') });
      for (const a of alerts) {
        const logged = await db.query('INSERT INTO supply_alert_log(key) VALUES($1) ON CONFLICT DO NOTHING RETURNING key', [a.key]);
        if (!logged.rows.length) continue;
        sent += await pushInbox(db, { orgId: org, recipients, actorId: 'system', kind: 'supply_alert', title: a.title, body: a.body });
      }
    }
    return sent;
  }
  if (o.intervalMs && o.intervalMs > 0) {
    const timer = setInterval(() => { runAlerts().catch(() => undefined); }, o.intervalMs);
    timer.unref?.();
    app.addHook('onClose', async () => clearInterval(timer));
  }
  return { runAlerts };
}
