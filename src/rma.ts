/* Returns & repairs (RMA).
 *
 * One case per returned unit (or batch of identical units): when it arrived, why, who diagnosed and
 * repaired it, photos at receipt / diagnosis / after repair, and how long it took. A case ends in one of:
 *   - restocked: put away for sale as a refurbished unit (已入库待上架 → 完成上架 → 售出);
 *   - scrapped, or returned to the customer.
 * Returns and repairs are their own stock (owner, 2026-11-11): nothing here writes regular WMS stock, and WMS
 * never lists REF- SKUs or has a returns warehouse. The case's stage is the unit's stock state.
 * A restocked refurbished unit can get a discount and a listing status for selling on the website;
 * the grade chosen when restocking sets the discount (A untouched, sold as new, B 10% off, C 20% off).
 *
 * Access: anyone who can view warehouse stock can view cases; warehouse managers register and close
 * cases; the assigned technician can update diagnosis, photos and mark the repair done; prices are set
 * by company admins and people with the MSRP pricing grant. Registration also records what the item is (machine, accessory,
 * material, other; machines need a serial), the reason and condition, and photos on receipt; whether it can be repaired
 * and who repairs it are decided in the repair step. Waiting for parts needs the parts named (waiting_for);
 * the refurbished discount can be chosen only once the repair is done. A return SKU
 * starting with REF- that is not in the item list yet is added as a name entry (ensureReturnItem); other SKUs must already exist. */
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { Database, Queryable } from './db.js';
import type { User } from './auth.js';
import { deny } from './errors.js';
import { returnsLevelFor, ensureReturnItem } from './wms.js';

export const rmaSchema = `
CREATE TABLE IF NOT EXISTS rma_cases(id text PRIMARY KEY, org_id text NOT NULL, number text NOT NULL, sku text NOT NULL, serial text NOT NULL DEFAULT '',
  qty integer NOT NULL DEFAULT 1 CHECK (qty > 0), kind text NOT NULL, channel text NOT NULL DEFAULT '', customer text NOT NULL DEFAULT '', order_ref text NOT NULL DEFAULT '',
  reason text NOT NULL, condition text NOT NULL DEFAULT '', received_at date NOT NULL, status text NOT NULL DEFAULT 'received',
  diagnosis text NOT NULL DEFAULT '', technician_id text, repair_notes text NOT NULL DEFAULT '', parts_used text NOT NULL DEFAULT '', repaired_at date,
  outcome text, restock_location text, grade text NOT NULL DEFAULT '', closed_at timestamptz, discount_pct numeric, sale_price numeric, listing text NOT NULL DEFAULT 'none',
  created_by text NOT NULL, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now());
CREATE UNIQUE INDEX IF NOT EXISTS rma_cases_number ON rma_cases(org_id, number);
CREATE TABLE IF NOT EXISTS rma_photos(id text PRIMARY KEY, org_id text NOT NULL, case_id text NOT NULL, kind text NOT NULL, name text NOT NULL, mime text NOT NULL,
  size integer NOT NULL, data bytea NOT NULL, uploader_id text NOT NULL, created_at timestamptz NOT NULL DEFAULT now());
CREATE INDEX IF NOT EXISTS rma_photos_case ON rma_photos(case_id);
CREATE TABLE IF NOT EXISTS rma_events(id text PRIMARY KEY, org_id text NOT NULL, case_id text NOT NULL, actor_id text NOT NULL, action text NOT NULL, note text NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT now());
CREATE INDEX IF NOT EXISTS rma_events_case ON rma_events(case_id, created_at);
ALTER TABLE rma_cases ADD COLUMN IF NOT EXISTS product_class text NOT NULL DEFAULT '';
ALTER TABLE rma_cases ADD COLUMN IF NOT EXISTS repairable text NOT NULL DEFAULT '';
ALTER TABLE rma_cases ADD COLUMN IF NOT EXISTS waiting_for text NOT NULL DEFAULT '';
ALTER TABLE rma_cases ADD COLUMN IF NOT EXISTS handler_id text;
ALTER TABLE rma_cases ADD COLUMN IF NOT EXISTS main_sku text NOT NULL DEFAULT '';
`;

export const RMA_STATUSES = ['received', 'diagnosing', 'waiting_parts', 'repairing', 'repaired', 'restocked', 'scrapped', 'returned'] as const;
const OPEN = ['received', 'diagnosing', 'waiting_parts', 'repairing', 'repaired'];
/* The stage people see: 等待维修 → 等待配件 → 完成维修 → (已入库待上架) → 完成上架 → 售出; or 报废 / 退回客户. */
export const stageOf = (c: { status: string; listing?: string }) =>
  c.status === 'waiting_parts' ? 'waiting_parts' : ['received', 'diagnosing', 'repairing'].includes(c.status) ? 'waiting_repair'
    : c.status === 'restocked' ? (c.listing === 'listed' ? 'listed' : c.listing === 'sold' ? 'sold' : 'restocked') : c.status;
const KINDS = ['return', 'warranty', 'repair', 'exchange'] as const;
const CHANNELS = ['website', 'amazon', 'dealer', 'other'] as const;
/* Three photo groups per return: on receipt, diagnosis, listing. 'repaired' is kept only for photos uploaded before. */
const PHOTO_KINDS = ['received', 'diagnosis', 'listing', 'repaired'] as const;
const CLASSES = ['machine', 'accessory', 'material', 'other'] as const;
/* Grade sets the refurbished discount: A = untouched, sold as new stock (no discount); B = 10% off; C = 20% off. */
export const GRADE_DISCOUNT: Record<string, number> = { A: 0, B: 10, C: 20 };
const PHOTO_MIME = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif']);
const MAX_PHOTO = 5 * 1024 * 1024, MAX_PHOTOS = 40;
const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use a date like 2026-11-02');
const id = z.string().min(1).max(100).regex(/^[A-Za-z0-9_-]+$/);
const sku = z.string().trim().min(1).max(80);
const nameOf = (u: any) => u ? (u.display_name || u.name_zh || u.name_en || u.id) : '';
const days = (a: any, b: any) => a && b ? Math.max(0, Math.round((new Date(b).getTime() - new Date(a).getTime()) / 86400000)) : null;
const ymd = (v: any) => v ? (v instanceof Date ? v.toISOString().slice(0, 10) : String(v).slice(0, 10)) : null;

export async function registerRmaRoutes(app: FastifyInstance, db: Database, o: { isAdmin: (u: User) => boolean; now?: () => number }) {
  const now = o.now || Date.now;
  const actorOf = (req: FastifyRequest): User => req.actor || deny(401, 'UNAUTHENTICATED', 'Authentication is required');
  const level = (u: User) => returnsLevelFor(u, o.isAdmin(u));
  const requireView = (u: User) => { if (level(u) === 'none') deny(403, 'RMA_FORBIDDEN', 'You do not have access to returns and repairs'); };
  const requireManage = (u: User) => { if (level(u) !== 'manage') deny(403, 'RMA_MANAGE_ONLY', 'Only warehouse managers can do this'); };
  const canPrice = (u: User) => o.isAdmin(u) || ((u as any).grants || []).includes('pricing_edit');
  const canWork = (u: User, c: any) => level(u) === 'manage' || (!!c.technician_id && c.technician_id === u.id);
  const event = (tx: Queryable, u: User, caseId: string, action: string, note = '') =>
    tx.query('INSERT INTO rma_events(id,org_id,case_id,actor_id,action,note) VALUES($1,$2,$3,$4,$5,$6)', [randomUUID(), u.org_id, caseId, u.id, action, note.slice(0, 2000)]);
  const audit = (tx: Queryable, u: User, action: string, objectId: string, details: unknown) =>
    tx.query('INSERT INTO audit_events(id,org_id,department_id,owner_id,actor_id,action,object_id,details) VALUES($1,$2,$3,$4,$5,$6,$7,$8)',
      [randomUUID(), u.org_id, u.department_id, u.id, u.id, action, objectId, JSON.stringify(details)]);
  const caseOf = async (tx: Queryable, u: User, caseId: string, lock = false) => {
    const c = (await tx.query('SELECT * FROM rma_cases WHERE id=$1 AND org_id=$2' + (lock ? ' FOR UPDATE' : ''), [caseId, u.org_id])).rows[0];
    if (!c) deny(404, 'NOT_FOUND', 'Return case not found');
    return c;
  };
  const people = async (org: string) => new Map((await db.query('SELECT id,display_name,name_zh,name_en,active,disabled_at,role,grants,is_admin FROM users WHERE org_id=$1', [org])).rows.map((p: any) => [p.id, p]));
  /* Technicians must be able to open the case, so only active people with warehouse access qualify. */
  const technicianOk = async (tx: Queryable, org: string, uid: string) => {
    const p = (await tx.query('SELECT * FROM users WHERE id=$1 AND org_id=$2 AND active=true AND disabled_at IS NULL', [uid, org])).rows[0];
    return !!p && level(p) !== 'none';
  };
  /* Every return links to its main SKU in the product library (the REF- SKU is the returned unit's own code). Old cases
     without one fall back to the REF- SKU without its prefix. Values: MSRP for everyone who sees returns; the landed cost
     only for people with cost access and main admins. */
  const mainOf = (c: any, cat: Map<string, any>) => { const m = String(c.main_sku || '').toLowerCase() || String(c.sku).toLowerCase().replace(/^ref-/, ''); return cat.get(m) || null; };
  const costOk = (u: User) => o.isAdmin(u) || ((u as any).grants || []).includes('product_cost_detail');
  const shape = (c: any, ppl: Map<string, any>, items: Map<string, any>, msrp: Map<string, number>, photoCount = 0, cat = new Map<string, any>(), withCost = false) => {
    const list = msrp.get(String(c.sku).toLowerCase()) ?? msrp.get(String(c.sku).toLowerCase().replace(/^ref-/, '')) ?? mainOf(c, cat)?.msrp ?? null, pct = c.discount_pct == null ? null : Number(c.discount_pct);
    const main = mainOf(c, cat), qty = Number(c.qty);
    return {
      mainSku: main?.sku || c.main_sku || '', mainName: main ? (main.name_zh || main.name_en || '') : '', handlerId: c.handler_id || c.created_by, handlerName: nameOf(ppl.get(c.handler_id || c.created_by)),
      unitMsrp: list, valueMsrp: list == null ? null : Math.round(list * qty * 100) / 100,
      ...(withCost ? { unitCost: main?.landed ?? null, valueCost: main?.landed == null ? null : Math.round(main.landed * qty * 100) / 100 } : {}),
      id: c.id, number: c.number, sku: c.sku, name: items.get(c.sku)?.name || '', serial: c.serial, qty: Number(c.qty), kind: c.kind, channel: c.channel,
      productClass: c.product_class || '', repairable: c.repairable || '',
      customer: c.customer, orderRef: c.order_ref, reason: c.reason, condition: c.condition, receivedAt: ymd(c.received_at), status: c.status, stage: stageOf(c), waitingFor: c.waiting_for || '',
      diagnosis: c.diagnosis, technicianId: c.technician_id, technicianName: nameOf(ppl.get(c.technician_id)), repairNotes: c.repair_notes, partsUsed: c.parts_used,
      repairedAt: ymd(c.repaired_at), outcome: c.outcome, restockLocation: c.restock_location, grade: c.grade, closedAt: c.closed_at,
      repairDays: days(c.received_at, c.repaired_at), openDays: OPEN.includes(c.status) ? days(c.received_at, new Date(now())) : null,
      msrp: list, discountPct: pct, salePrice: c.sale_price == null ? (list != null && pct != null ? Math.round(list * (100 - pct)) / 100 : null) : Number(c.sale_price),
      listing: c.listing, createdByName: nameOf(ppl.get(c.created_by)), createdAt: c.created_at, updatedAt: c.updated_at, photoCount,
    };
  };
  const lookups = async (org: string) => {
    const items = new Map((await db.query('SELECT sku,name FROM wms_items WHERE org_id=$1', [org])).rows.map((r: any) => [r.sku, r]));
    const msrp = new Map((await db.query('SELECT sku,msrp FROM product_catalog WHERE org_id=$1 AND msrp IS NOT NULL', [org])).rows.map((r: any) => [String(r.sku).toLowerCase(), Number(r.msrp)]));
    const cat = new Map((await db.query(`SELECT c.sku,c.name_zh,c.name_en,c.msrp,p.landed_usd FROM product_catalog c LEFT JOIN product_pricing p ON p.org_id=c.org_id AND p.sku=c.sku
      WHERE c.org_id=$1 AND lower(c.sku) NOT LIKE 'ref-%'`, [org])).rows.map((r: any) => [String(r.sku).toLowerCase(), { sku: r.sku, name_zh: r.name_zh, name_en: r.name_en,
        msrp: r.msrp == null ? null : Number(r.msrp), landed: r.landed_usd == null ? null : Number(r.landed_usd) }]));
    return { items, msrp, cat, ppl: await people(org) };
  };

  app.get('/rma', async req => {
    const u = actorOf(req); requireView(u);
    const { items, msrp, cat, ppl } = await lookups(u.org_id), withCost = costOk(u);
    const counts = new Map((await db.query('SELECT case_id,count(*)::int n FROM rma_photos WHERE org_id=$1 GROUP BY case_id', [u.org_id])).rows.map((r: any) => [r.case_id, r.n]));
    const rows = (await db.query('SELECT * FROM rma_cases WHERE org_id=$1 ORDER BY received_at DESC, created_at DESC LIMIT 1000', [u.org_id])).rows;
    const technicians = [...ppl.values()].filter((p: any) => p.active && !p.disabled_at && level(p) !== 'none').map((p: any) => ({ id: p.id, name: nameOf(p) })).sort((a, b) => a.name.localeCompare(b.name));
    const list = rows.map((c: any) => shape(c, ppl, items, msrp, counts.get(c.id) || 0, cat, withCost));
    // Value of the returns by stage (cost value for cost access, MSRP value for everyone): all, not repaired yet,
    // repaired and waiting to sell (after the grade discount), recovered by selling, and written off.
    const val = (x: any, k: 'valueCost' | 'valueMsrp') => Number(x[k] || 0), round = (n: number) => Math.round(n * 100) / 100;
    const sumBy = (k: 'valueCost' | 'valueMsrp') => {
      const pick = (f: (x: any) => boolean) => round(list.filter(f).reduce((a: number, x: any) => a + val(x, k), 0));
      return { total: pick(() => true), unrepaired: pick(x => ['waiting_repair', 'waiting_parts'].includes(x.stage)),
        toSell: round(list.filter(x => ['repaired', 'restocked', 'listed'].includes(x.stage)).reduce((a: number, x: any) => a + val(x, k) * (1 - (x.discountPct ?? 0) / 100), 0)),
        writtenOff: pick(x => ['scrapped', 'returned'].includes(x.stage)) };
    };
    const recovered = round(list.filter(x => x.stage === 'sold').reduce((a: number, x: any) => a + (x.salePrice ?? 0) * x.qty, 0));
    const handlers = [...ppl.values()].filter((p: any) => p.active && !p.disabled_at && level(p) === 'manage').map((p: any) => ({ id: p.id, name: nameOf(p) })).sort((a, b) => a.name.localeCompare(b.name));
    return {
      items: list, technicians, handlers, mainSkus: [...cat.values()].map(c => ({ sku: c.sku, name: c.name_zh || c.name_en || '' })),
      values: { msrp: { ...sumBy('valueMsrp'), recovered }, ...(withCost ? { cost: { ...sumBy('valueCost'), recovered } } : {}) },
      skus: [...items.values()].map((i: any) => ({ sku: i.sku, name: i.name })),
      canOperate: level(u) === 'manage', canPrice: canPrice(u), me: u.id,
    };
  });

  app.get<{ Params: { id: string } }>('/rma/:id', async req => {
    const u = actorOf(req); requireView(u);
    const c = await caseOf(db, u, id.parse(req.params.id));
    const { items, msrp, cat, ppl } = await lookups(u.org_id);
    const photos = (await db.query('SELECT id,kind,name,mime,size,uploader_id,created_at FROM rma_photos WHERE case_id=$1 ORDER BY created_at', [c.id])).rows
      .map((p: any) => ({ id: p.id, kind: p.kind, name: p.name, size: Number(p.size), byName: nameOf(ppl.get(p.uploader_id)), createdAt: p.created_at }));
    const events = (await db.query('SELECT * FROM rma_events WHERE case_id=$1 ORDER BY created_at, id', [c.id])).rows
      .map((e: any) => ({ id: e.id, action: e.action, note: e.note, byName: nameOf(ppl.get(e.actor_id)), at: e.created_at }));
    return { ...shape(c, ppl, items, msrp, photos.length, cat, costOk(u)), photos, events, canWork: canWork(u, c), canOperate: level(u) === 'manage', canPrice: canPrice(u) };
  });

  const createInput = z.object({
    sku, serial: z.string().trim().max(80).optional(), qty: z.number().int().min(1).max(500).default(1), kind: z.enum(KINDS).default('return'), channel: z.enum(CHANNELS).optional(),
    productClass: z.enum(CLASSES), repairable: z.enum(['yes', 'no']).optional(),
    customer: z.string().trim().max(120).optional(), orderRef: z.string().trim().max(80).optional(), reason: z.string().trim().min(2).max(2000),
    condition: z.string().trim().min(2).max(1000), receivedAt: day, technicianId: id.optional(), handlerId: id.optional(), mainSku: sku.optional(),
  }).strict();
  /** The main SKU must be a product in the product library (not a REF- return code). */
  const mainSkuOk = async (tx: Queryable, org: string, s: string) => {
    const r = (await tx.query("SELECT sku FROM product_catalog WHERE org_id=$1 AND lower(sku)=lower($2) AND lower(sku) NOT LIKE 'ref-%'", [org, s])).rows[0];
    if (!r) deny(400, 'RMA_MAIN_SKU', `Link the return to a product in the product library (${s} is not one)`, `请关联产品资料里已有的主 SKU（${s} 不在产品资料里）。`);
    return r.sku as string;
  };
  const handlerOk = async (tx: Queryable, org: string, uid: string) => {
    const p = (await tx.query('SELECT * FROM users WHERE id=$1 AND org_id=$2 AND active=true AND disabled_at IS NULL', [uid, org])).rows[0];
    if (!p || level(p) !== 'manage') deny(400, 'RMA_HANDLER', 'Choose an active colleague who manages returns as the handler', '处理人要选在职、有退货管理权限的同事。');
  };
  app.post('/rma', async (req, reply) => {
    const u = actorOf(req), v = createInput.parse(req.body); requireManage(u);
    if (v.receivedAt > new Date(now() + 86400000).toISOString().slice(0, 10)) deny(400, 'RMA_FUTURE_DATE', 'The received date cannot be in the future');
    if (v.receivedAt < '2000-01-01') deny(400, 'RMA_OLD_DATE', 'Check the received date: it is before 2000', '收货日期早于 2000 年，请检查是否填错。');
    if (v.productClass === 'machine' && !v.serial) deny(400, 'RMA_SERIAL_REQUIRED', 'A machine needs its serial number');
    const row = await db.transaction(async tx => {
      // Main SKU: required for new returns (given, or the SKU itself when it is a product-library SKU).
      const main = await mainSkuOk(tx, u.org_id, v.mainSku || v.sku.replace(/^REF-/i, ''));
      if (v.handlerId) await handlerOk(tx, u.org_id, v.handlerId);
      let item = (await tx.query('SELECT sku FROM wms_items WHERE org_id=$1 AND lower(sku)=lower($2)', [u.org_id, v.sku])).rows[0];
      if (!item && /^REF-[A-Za-z0-9]/i.test(v.sku)) item = { sku: await ensureReturnItem(tx, u.org_id, u.id, 'REF-' + v.sku.slice(4)) };
      if (!item) deny(400, 'RMA_UNKNOWN_SKU', 'This SKU is not in the item list; a return SKU starts with REF- (for example REF-XRF38)');
      if (v.technicianId && !(await technicianOk(tx, u.org_id, v.technicianId))) deny(400, 'RMA_TECHNICIAN', 'Choose an active colleague with warehouse access as technician');
      const year = v.receivedAt.slice(0, 4);
      const n = Number((await tx.query("SELECT count(*)::int n FROM rma_cases WHERE org_id=$1 AND number LIKE $2", [u.org_id, `RMA-${year}-%`])).rows[0].n) + 1;
      const caseId = randomUUID(), number = `RMA-${year}-${String(n).padStart(4, '0')}`;
      const c = (await tx.query(`INSERT INTO rma_cases(id,org_id,number,sku,serial,qty,kind,channel,customer,order_ref,reason,condition,received_at,technician_id,status,created_by,product_class,repairable,handler_id,main_sku)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20) RETURNING *`,
        [caseId, u.org_id, number, item.sku, v.serial || '', v.qty, v.kind, v.channel || '', v.customer || '', v.orderRef || '', v.reason, v.condition, v.receivedAt, v.technicianId || null, v.technicianId ? 'diagnosing' : 'received', u.id, v.productClass, v.repairable || '', v.handlerId || u.id, main])).rows[0];
      await event(tx, u, caseId, 'created', v.reason);
      await audit(tx, u, 'rma.created', caseId, { number, sku: item.sku, qty: v.qty });
      return c;
    });
    reply.code(201);
    return { id: row.id, number: row.number, status: row.status };
  });

  const updateInput = z.object({
    diagnosis: z.string().trim().max(5000).optional(), technicianId: id.nullable().optional(), repairNotes: z.string().trim().max(5000).optional(),
    partsUsed: z.string().trim().max(2000).optional(), waitingFor: z.string().trim().max(500).optional(), repairable: z.enum(['yes', 'no']).optional(), status: z.enum(['received', 'diagnosing', 'waiting_parts', 'repairing']).optional(),
    serial: z.string().trim().max(80).optional(), customer: z.string().trim().max(120).optional(), orderRef: z.string().trim().max(80).optional(), condition: z.string().trim().max(1000).optional(),
    receivedAt: day.optional(), handlerId: id.optional(), mainSku: sku.optional(),
  }).strict().refine(v => Object.keys(v).length > 0, 'Nothing to change');
  app.post<{ Params: { id: string } }>('/rma/:id/update', async req => {
    const u = actorOf(req), v = updateInput.parse(req.body), caseId = id.parse(req.params.id);
    return db.transaction(async tx => {
      const c = await caseOf(tx, u, caseId, true);
      if (!canWork(u, c)) deny(403, 'RMA_WORK_ONLY', 'Only warehouse managers or the assigned technician can update this case');
      if (!OPEN.includes(c.status)) deny(409, 'RMA_CLOSED', 'This case is closed');
      if (v.handlerId !== undefined || v.mainSku !== undefined) { if (level(u) !== 'manage') deny(403, 'RMA_MANAGE_ONLY', 'Only warehouse managers can do this'); if (v.handlerId) await handlerOk(tx, u.org_id, v.handlerId); if (v.mainSku) v.mainSku = await mainSkuOk(tx, u.org_id, v.mainSku); }
      if ((v.technicianId !== undefined || v.serial !== undefined || v.customer !== undefined || v.orderRef !== undefined || v.receivedAt !== undefined) && level(u) !== 'manage') deny(403, 'RMA_MANAGE_ONLY', 'Only warehouse managers can do this');
      if (v.technicianId && !(await technicianOk(tx, u.org_id, v.technicianId))) deny(400, 'RMA_TECHNICIAN', 'Choose an active colleague with warehouse access as technician');
      if (v.receivedAt !== undefined) { if (v.receivedAt > new Date(now() + 86400000).toISOString().slice(0, 10)) deny(400, 'RMA_FUTURE_DATE', 'The received date cannot be in the future'); if (v.receivedAt < '2000-01-01') deny(400, 'RMA_OLD_DATE', 'Check the received date: it is before 2000', '收货日期早于 2000 年，请检查是否填错。'); }
      const nextStatus = v.status ?? (c.status === 'repaired' && (v.diagnosis !== undefined || v.repairNotes !== undefined) ? 'repairing' : c.status);
      if (nextStatus === 'waiting_parts' && !(v.waitingFor ?? c.waiting_for ?? '').trim()) deny(400, 'RMA_PARTS_NEEDED', 'Say which parts you are waiting for');
      const col: Record<string, string> = { handlerId: 'handler_id', mainSku: 'main_sku', receivedAt: 'received_at', diagnosis: 'diagnosis', technicianId: 'technician_id', repairNotes: 'repair_notes', partsUsed: 'parts_used', waitingFor: 'waiting_for', repairable: 'repairable', status: 'status', serial: 'serial', customer: 'customer', orderRef: 'order_ref', condition: 'condition' };
      const sets: string[] = [], vals: unknown[] = [caseId];
      for (const [k, val] of Object.entries(v)) { vals.push(val); sets.push(`${col[k]}=$${vals.length}`); }
      if (v.status === undefined && c.status === 'received' && (v.technicianId || v.diagnosis)) sets.push("status='diagnosing'");
      if (c.status === 'repaired' && (v.diagnosis !== undefined || v.repairNotes !== undefined || v.status)) sets.push("repaired_at=NULL"), v.status === undefined && sets.push("status='repairing'");
      await tx.query(`UPDATE rma_cases SET ${sets.join(',')},updated_at=now() WHERE id=$1`, vals);
      const parts = [v.status && `status:${v.status}`, v.technicianId !== undefined && 'technician', v.diagnosis !== undefined && 'diagnosis', v.repairNotes !== undefined && 'repair notes', v.partsUsed !== undefined && 'parts', v.waitingFor && `waiting for: ${v.waitingFor}`, v.repairable && `repairable: ${v.repairable}`].filter(Boolean).join(', ');
      await event(tx, u, caseId, 'updated', parts);
      return { ok: true };
    });
  });

  app.post<{ Params: { id: string } }>('/rma/:id/repaired', async req => {
    const u = actorOf(req), v = z.object({ repairedAt: day.optional(), repairNotes: z.string().trim().max(5000).optional() }).strict().parse(req.body ?? {}), caseId = id.parse(req.params.id);
    return db.transaction(async tx => {
      const c = await caseOf(tx, u, caseId, true);
      if (!canWork(u, c)) deny(403, 'RMA_WORK_ONLY', 'Only warehouse managers or the assigned technician can update this case');
      if (!OPEN.includes(c.status) || c.status === 'repaired') deny(409, 'RMA_CLOSED', 'This case is already repaired or closed');
      if (!c.technician_id) deny(400, 'RMA_NEEDS_TECHNICIAN', 'Assign a technician first');
      if (!String(c.diagnosis || '').trim()) deny(400, 'RMA_NEEDS_DIAGNOSIS', 'Write the diagnosis first');
      const photos = Number((await tx.query("SELECT count(*)::int n FROM rma_photos WHERE case_id=$1 AND kind IN ('diagnosis','repaired')", [caseId])).rows[0].n);
      if (!photos) deny(400, 'RMA_NEEDS_PHOTO', 'Upload at least one diagnosis photo');
      const at = v.repairedAt || new Date(now()).toISOString().slice(0, 10);
      if (at < ymd(c.received_at)!) deny(400, 'RMA_DATE_ORDER', 'The repair date cannot be before the received date');
      await tx.query(`UPDATE rma_cases SET status='repaired',repaired_at=$2,repair_notes=COALESCE($3,repair_notes),updated_at=now() WHERE id=$1`, [caseId, at, v.repairNotes ?? null]);
      await event(tx, u, caseId, 'repaired', v.repairNotes || '');
      return { ok: true, repairDays: days(c.received_at, at) };
    });
  });

  const closeInput = z.object({ outcome: z.enum(['restock', 'scrap', 'return_customer']), location: z.string().max(20).optional() /* ignored: returns are not regular stock */, grade: z.enum(['A', 'B', 'C', 'new']).optional(), note: z.string().trim().max(1000).optional() }).strict();
  app.post<{ Params: { id: string } }>('/rma/:id/close', async req => {
    const u = actorOf(req), v = closeInput.parse(req.body), caseId = id.parse(req.params.id); requireManage(u);
    return db.transaction(async tx => {
      const c = await caseOf(tx, u, caseId, true);
      if (!OPEN.includes(c.status)) deny(409, 'RMA_CLOSED', 'This case is closed');
      if (v.outcome === 'restock') {
        const grade = v.grade === 'new' ? 'A' : (v.grade || 'B'), pct = GRADE_DISCOUNT[grade];
        if (c.status !== 'repaired' && grade !== 'A') deny(400, 'RMA_NOT_REPAIRED', 'Mark the repair as done before putting it back into stock');
        await tx.query(`UPDATE rma_cases SET status='restocked',outcome='restock',restock_location=NULL,grade=$2,discount_pct=$3,sale_price=NULL,closed_at=now(),updated_at=now() WHERE id=$1`, [caseId, grade, pct]);
      } else {
        await tx.query(`UPDATE rma_cases SET status=$2,outcome=$3,closed_at=now(),updated_at=now() WHERE id=$1`, [caseId, v.outcome === 'scrap' ? 'scrapped' : 'returned', v.outcome]);
      }
      await event(tx, u, caseId, 'closed:' + v.outcome, v.note || '');
      await audit(tx, u, 'rma.closed', caseId, v);
      return { ok: true };
    });
  });

  const priceInput = z.object({ discountPct: z.number().min(0).max(95).nullable().optional(), salePrice: z.number().min(0).max(1_000_000).nullable().optional(),
    listing: z.enum(['none', 'pending', 'listed', 'sold']).optional() }).strict().refine(v => Object.keys(v).length > 0, 'Nothing to change');
  app.post<{ Params: { id: string } }>('/rma/:id/price', async req => {
    const u = actorOf(req), v = priceInput.parse(req.body), caseId = id.parse(req.params.id);
    if (!canPrice(u)) deny(403, 'RMA_PRICE_ONLY', 'Only administrators or people with MSRP pricing access can set the sale price');
    return db.transaction(async tx => {
      const c = await caseOf(tx, u, caseId, true);
      if (v.discountPct !== undefined && !['repaired', 'restocked'].includes(c.status)) deny(409, 'RMA_DISCOUNT_AFTER_REPAIR', 'The refurbished discount can be chosen once the repair is done');
      if ((v.salePrice !== undefined || v.listing) && c.status !== 'restocked') deny(409, 'RMA_NOT_RESTOCKED', 'Only products back in stock can be priced for sale');
      const sets: string[] = [], vals: unknown[] = [caseId];
      if (v.discountPct !== undefined) { vals.push(v.discountPct); sets.push(`discount_pct=$${vals.length}`); }
      if (v.salePrice !== undefined) { vals.push(v.salePrice); sets.push(`sale_price=$${vals.length}`); }
      if (v.listing) { vals.push(v.listing); sets.push(`listing=$${vals.length}`); }
      // 售出 is a stage of the case only: returns are not regular stock, so nothing is written to WMS.
      await tx.query(`UPDATE rma_cases SET ${sets.join(',')},updated_at=now() WHERE id=$1`, vals);
      await event(tx, u, caseId, 'priced', [v.discountPct != null && `-${v.discountPct}%`, v.salePrice != null && `$${v.salePrice}`, v.listing && `listing:${v.listing}`].filter(Boolean).join(' '));
      await audit(tx, u, 'rma.priced', caseId, v);
      return { ok: true };
    });
  });

  const photoInput = z.object({ kind: z.enum(PHOTO_KINDS), name: z.string().trim().min(1).max(200), mime: z.string().max(100), dataBase64: z.string().min(4) }).strict();
  app.post<{ Params: { id: string } }>('/rma/:id/photos', { bodyLimit: Math.ceil(MAX_PHOTO * 4 / 3) + 4096 }, async (req, reply) => {
    const u = actorOf(req), v = photoInput.parse(req.body), caseId = id.parse(req.params.id);
    const c = await caseOf(db, u, caseId);
    if (!canWork(u, c)) deny(403, 'RMA_WORK_ONLY', 'Only warehouse managers or the assigned technician can update this case');
    if (!PHOTO_MIME.has(v.mime)) deny(400, 'RMA_PHOTO_TYPE', 'Photos must be PNG, JPEG, WebP or GIF');
    if (!/^[A-Za-z0-9+/]+={0,2}$/.test(v.dataBase64)) deny(400, 'RMA_PHOTO_INVALID', 'The photo could not be read');
    const data = Buffer.from(v.dataBase64, 'base64');
    if (!data.length || data.length > MAX_PHOTO) deny(400, 'RMA_PHOTO_TOO_LARGE', 'Photos must be 5 MB or smaller');
    if (Number((await db.query('SELECT count(*)::int n FROM rma_photos WHERE case_id=$1', [caseId])).rows[0].n) >= MAX_PHOTOS) deny(400, 'RMA_PHOTO_LIMIT', 'A case can have at most 40 photos');
    const photoId = randomUUID();
    await db.transaction(async tx => {
      await tx.query('INSERT INTO rma_photos(id,org_id,case_id,kind,name,mime,size,data,uploader_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)',
        [photoId, u.org_id, caseId, v.kind, v.name.replace(/[\\/\u0000-\u001f]/g, '_'), v.mime, data.length, data, u.id]);
      await event(tx, u, caseId, 'photo:' + v.kind, v.name);
    });
    reply.code(201);
    return { id: photoId, kind: v.kind, name: v.name, size: data.length };
  });

  app.get<{ Params: { id: string; photo: string } }>('/rma/:id/photos/:photo', async (req, reply) => {
    const u = actorOf(req); requireView(u);
    const p = (await db.query('SELECT mime,data,name FROM rma_photos WHERE id=$1 AND case_id=$2 AND org_id=$3', [id.parse(req.params.photo), id.parse(req.params.id), u.org_id])).rows[0];
    if (!p) deny(404, 'NOT_FOUND', 'Photo not found');
    reply.header('content-type', p.mime).header('cache-control', 'private, max-age=86400').header('x-content-type-options', 'nosniff');
    return reply.send(Buffer.from(p.data));
  });
}
