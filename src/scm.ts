/* Supply chain (SCM): a lean decision board.
 *
 * 1. Sales speed: Shopify orders are summed per SKU and day (scm_sales_daily). DS = daily units sold, over the last 365
 *    days and the last 30 days.
 * 2. Reorder suggestions: per SKU, what the US LA warehouse holds plus what is on the way, against
 *    DS × (lead time + target days + safety days). The gap is first covered from factory stock (ship it), the rest is
 *    a production order. Lead time comes from the product library (生产交期 + 头程时间, numbers in the text), or the default.
 * 3. In transit: one shipment per container or parcel with tracking, mode, ship date, days to arrive (ETA) and the SKUs
 *    and quantities on board. Stock is still kept only in WMS (CLAUDE.md rule 3): creating a shipment moves the goods
 *    to "in transit" with WMS movements (from a factory warehouse, or as new goods straight from production), and
 *    "arrived" moves them from in transit into the US LA warehouse.
 *
 * Access: grants supply (view) / supply_manage (manage), set on the SCM page; main admins manage. Nothing here shows
 * costs. No sales or stock data lives in this repository. */
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { Database, Queryable } from './db.js';
import type { User } from './auth.js';
import { deny } from './errors.js';
import { pushInbox } from './inbox.js';
import { wmsMoveLines, isReturnSku, warehouseLevelFor } from './wms.js';
import { isDropship } from './product-spec.js';
import type { ShopifyOptions } from './shopify.js';
import { SHOPIFY_API_VERSION } from './shopify.js';

export const scmSchema = `
CREATE TABLE IF NOT EXISTS scm_sales_daily(org_id text NOT NULL, sku text NOT NULL, day date NOT NULL, qty integer NOT NULL DEFAULT 0, PRIMARY KEY(org_id,sku,day));
CREATE TABLE IF NOT EXISTS scm_sync(org_id text PRIMARY KEY, last_at timestamptz, status text NOT NULL DEFAULT '', orders integer NOT NULL DEFAULT 0, units integer NOT NULL DEFAULT 0,
  since date, note text NOT NULL DEFAULT '');
CREATE TABLE IF NOT EXISTS scm_settings(org_id text PRIMARY KEY, target_days integer NOT NULL DEFAULT 30, safety_days integer NOT NULL DEFAULT 14, lead_days integer NOT NULL DEFAULT 60,
  updated_by text, updated_at timestamptz NOT NULL DEFAULT now());
ALTER TABLE scm_settings ADD COLUMN IF NOT EXISTS order_days integer NOT NULL DEFAULT 2;
ALTER TABLE scm_settings ADD COLUMN IF NOT EXISTS receive_days integer NOT NULL DEFAULT 5;
ALTER TABLE scm_settings ADD COLUMN IF NOT EXISTS buffer_days integer NOT NULL DEFAULT 0;
ALTER TABLE scm_settings ADD COLUMN IF NOT EXISTS production_days integer NOT NULL DEFAULT 30;
ALTER TABLE scm_settings ADD COLUMN IF NOT EXISTS first_leg_days integer NOT NULL DEFAULT 35;
CREATE TABLE IF NOT EXISTS scm_shipments(id text PRIMARY KEY, org_id text NOT NULL, number text NOT NULL, mode text NOT NULL DEFAULT 'sea', carrier text NOT NULL DEFAULT '',
  tracking text NOT NULL DEFAULT '', source text NOT NULL, shipped_on date NOT NULL, eta date NOT NULL, status text NOT NULL DEFAULT 'in_transit', arrived_on date,
  note text NOT NULL DEFAULT '', created_by text NOT NULL, created_at timestamptz NOT NULL DEFAULT now());
CREATE UNIQUE INDEX IF NOT EXISTS scm_shipments_number ON scm_shipments(org_id, number);
ALTER TABLE scm_shipments ADD COLUMN IF NOT EXISTS order_id text;
ALTER TABLE scm_shipments ADD COLUMN IF NOT EXISTS first_leg text NOT NULL DEFAULT '';
ALTER TABLE scm_shipments ADD COLUMN IF NOT EXISTS last_leg text NOT NULL DEFAULT '';
ALTER TABLE scm_shipments ADD COLUMN IF NOT EXISTS position text NOT NULL DEFAULT '';
ALTER TABLE scm_shipments ADD COLUMN IF NOT EXISTS position_on date;
CREATE TABLE IF NOT EXISTS scm_orders(id text PRIMARY KEY, org_id text NOT NULL, number text NOT NULL, factory text NOT NULL, ordered_on date NOT NULL,
  ready_on date, status text NOT NULL DEFAULT 'open', note text NOT NULL DEFAULT '', created_by text NOT NULL, created_at timestamptz NOT NULL DEFAULT now(), closed_on date);
CREATE UNIQUE INDEX IF NOT EXISTS scm_orders_number ON scm_orders(org_id, number);
ALTER TABLE scm_orders ADD COLUMN IF NOT EXISTS supplier text NOT NULL DEFAULT '';
ALTER TABLE scm_orders ADD COLUMN IF NOT EXISTS issued_on date;
ALTER TABLE scm_orders ADD COLUMN IF NOT EXISTS delivered_on date;
ALTER TABLE scm_orders ADD COLUMN IF NOT EXISTS updated_by text;
ALTER TABLE scm_orders ADD COLUMN IF NOT EXISTS updated_at timestamptz;
ALTER TABLE scm_orders ADD COLUMN IF NOT EXISTS edits integer NOT NULL DEFAULT 0;
UPDATE scm_orders SET status='issued' WHERE status='open';
CREATE TABLE IF NOT EXISTS scm_order_lines(order_id text NOT NULL, sku text NOT NULL, qty integer NOT NULL CHECK (qty >= 0), shipped integer NOT NULL DEFAULT 0, PRIMARY KEY(order_id, sku));
ALTER TABLE scm_shipments ADD COLUMN IF NOT EXISTS notified_on date;
ALTER TABLE scm_shipments ADD COLUMN IF NOT EXISTS notified_by text;
CREATE TABLE IF NOT EXISTS scm_shipment_lines(shipment_id text NOT NULL, sku text NOT NULL, qty integer NOT NULL CHECK (qty > 0), PRIMARY KEY(shipment_id, sku));
ALTER TABLE scm_shipment_lines ADD COLUMN IF NOT EXISTS received integer;
`;

const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use a date like 2026-11-12');
const sku = z.string().trim().min(1).max(80);
const ymd = (d: unknown) => d ? (d instanceof Date ? d.toISOString() : String(d)).slice(0, 10) : null;
const addDays = (date: string, n: number) => { const d = new Date(date + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
const r1 = (n: number) => Math.round(n * 10) / 10;
/** Daily sales (DS) and the forecast keep two decimals (owner, 2026-11-13): 0.04 a day must not show as 0. */
const r2 = (n: number) => Math.round(n * 100) / 100;
/** "25 天" + "海运 35 天" → 60. The numbers in the two product-library texts, added up; null when there are none. */
export const leadDaysOf = (production: unknown, firstLeg: unknown) => {
  const num = (s: unknown) => { const m = String(s ?? '').match(/\d+(?:\.\d+)?/); return m ? Number(m[0]) : null; };
  const a = num(production), b = num(firstLeg);
  return a == null && b == null ? null : Math.round((a || 0) + (b || 0));
};
export const daysIn = (s: unknown) => { const m = String(s ?? '').match(/\d+(?:\.\d+)?/); return m ? Math.round(Number(m[0])) : null; };
/** Supply-chain days to the US warehouse (owner, 2026-11-12): order + production + first leg + customs & receiving + buffer.
 *  Goods already finished at the factory skip production. */
export const supplyDaysOf = (o: { order: number; production: number; firstLeg: number; receive: number; buffer: number }) => ({
  full: o.order + o.production + o.firstLeg + o.receive + o.buffer, fromStock: o.order + o.firstLeg + o.receive + o.buffer });
/** Forecast daily sales from the last 30 and 60 days only (owner, 2026-11-13: Shopify gives this app 60 days of orders,
 *  so the 90-day, yearly and seasonal parts are gone): 60 % the last 30 days + 40 % the last 60 days. The trend compares
 *  the last 30 days with the 30 days before them: ≥ 1.3× is a burst, ≤ 0.7× a dip. */
/** A burst or dip only counts with at least this many units sold in the last 30 days (owner, 2026-11-13): 1 unit against
 *  0 is not a trend. */
export const TREND_MIN_UNITS = 3;
export const FORECAST_WEIGHTS = { last30: 0.6, last60: 0.4 } as const;
export function forecastOf(o: { ds30: number; ds60: number; prev30: number | null; sold30?: number }) {
  const enough = o.sold30 == null || o.sold30 >= TREND_MIN_UNITS, prev = o.prev30;
  const signal = !enough || prev == null ? 'steady' : prev > 0 && o.ds30 >= 1.3 * prev ? 'spike' : prev > 0 && o.ds30 <= 0.7 * prev ? 'dip' : prev <= 0 && o.ds30 > 0 ? 'spike' : 'steady';
  const ds = Math.max(0, FORECAST_WEIGHTS.last30 * o.ds30 + FORECAST_WEIGHTS.last60 * o.ds60);
  return { ds, season: 1, signal, trendPct: enough && prev != null && prev > 0 ? Math.round((o.ds30 / prev - 1) * 100) : null };
}
/** 头程 / 尾程 with their default days (owner, 2026-11-12): days to arrive = first leg + last mile. */
export const FIRST_LEGS = { air: 7, oa: 30, fast: 20, matson: 15 } as const;
export const LAST_LEGS = { express: 3, port: 4, truck: 7 } as const;
/** A SKU's suppliers from the product library (主供应商, 备选供应商1/2), in that order. */
export const suppliersOf = (attrs: any) => ['supplier', 'supplierAlt1', 'supplierAlt2'].map(k => String(attrs?.[k] ?? '').trim()).filter(Boolean);
const number = (v: { number?: string }) => !!(v.number && v.number.trim());
/** All lines finished: the order is delivered on that date. */
async function deliveredIfDone(tx: Queryable, id: string, on: string) {
  if ((await tx.query('SELECT 1 FROM scm_order_lines WHERE order_id=$1 AND shipped < qty', [id])).rows.length) return false;
  await tx.query("UPDATE scm_orders SET status='delivered',delivered_on=$2 WHERE id=$1", [id, on]);
  return true;
}
/** Reorder suggestion for one SKU (owner, 2026-11-12). ds = forecast daily units. Two totals drive it:
 *  finished goods (US + in transit + factory warehouses) decide what to ship from the factory; finished goods + work in
 *  progress (open purchase orders not finished yet) decide what to order from production, so nothing is ordered twice.
 *  Three statuses: 缺货风险 / 正常 / 库存过多. */
export function reorderOf(o: { ds: number; us: number; transit: number; factory: number; leadDays: number; targetDays: number; safetyDays: number; wip?: number }) {
  const horizon = o.leadDays + o.targetDays + o.safetyDays, wip = o.wip || 0;
  const need = Math.ceil(o.ds * horizon), have = o.us + o.transit, finished = have + o.factory, pipeline = finished + wip;
  const ship = Math.min(Math.max(0, need - have), o.factory), make = Math.max(0, need - pipeline), gap = Math.max(0, need - have);
  const cover = o.ds > 0 ? Math.floor(have / o.ds) : null;
  const coverFinished = o.ds > 0 ? Math.floor(finished / o.ds) : null, coverAll = o.ds > 0 ? Math.floor(pipeline / o.ds) : null;
  // risk: what is in the US or on the way runs out before a reorder can arrive; overstock: everything finished lasts 90+ days past the target
  const status = cover == null ? (finished > 0 ? 'overstock' : 'ok') : cover < o.leadDays ? 'risk' : coverFinished! > horizon + 90 ? 'overstock' : 'ok';
  const shortDays = cover != null && cover < o.leadDays ? o.leadDays - cover : 0;
  return { need, gap, ship, make, cover, coverFinished, coverAll, finished, pipeline, monthly: Math.ceil(o.ds * 30), status, shortDays, horizon };
}

/** SKUs on their way out (PIM 生命周期: 停产清存 / 下架封存) are sold down, not made again (owner, 2026-11-12):
 *  no production suggestion, and running out is the goal, so no stockout risk. Shipping factory stock still shows. */
export const STOPPING = ['clearance', 'eol'];
export function stoppingAdjust<T extends { make: number; status: string; shortDays: number }>(lifecycle: string, r: T): T & { stopping: boolean } {
  if (!STOPPING.includes(lifecycle)) return { ...r, stopping: false };
  return { ...r, make: 0, status: r.status === 'risk' ? 'ok' : r.status, shortDays: 0, stopping: true };
}

/** Dropship SKUs (PIM 供货方式 = 代发) ship from the supplier and are not stocked (owner, 2026-11-13):
 *  sales still show, but nothing to ship or make and no stockout risk. */
export function dropshipAdjust<T extends { ship: number; make: number; status: string; shortDays: number }>(mode: string, r: T): T & { dropship: boolean } {
  if (!isDropship(mode)) return { ...r, dropship: false };
  return { ...r, ship: 0, make: 0, status: r.status === 'risk' ? 'ok' : r.status, shortDays: 0, dropship: true };
}

export async function registerScmRoutes(app: FastifyInstance, db: Database, o: { isAdmin: (u: User) => boolean; shopify?: ShopifyOptions; now?: () => number }) {
  const now = o.now || Date.now, today = () => new Date(now()).toISOString().slice(0, 10);
  const actorOf = (req: FastifyRequest): User => req.actor || deny(401, 'UNAUTHENTICATED', 'Authentication is required');
  const grantsOf = (u: any): string[] => Array.isArray(u.grants) ? u.grants : [];
  const levelOf = (u: User) => o.isAdmin(u) || grantsOf(u).includes('supply_manage') ? 'manage' : grantsOf(u).includes('supply') || grantsOf(u).includes('products') ? 'view' : 'none';
  const requireView = (u: User) => { if (levelOf(u) === 'none') deny(403, 'SCM_FORBIDDEN', 'You do not have access to the supply chain', '你没有供应链的权限。'); };
  const requireManage = (u: User) => { if (levelOf(u) !== 'manage') deny(403, 'SCM_MANAGE_ONLY', 'Only supply-chain managers can do this', '只有供应链管理权限的人可以操作。'); };
  const audit = (tx: Queryable, u: User, action: string, objectId: string, details: unknown) =>
    tx.query('INSERT INTO audit_events(id,org_id,department_id,owner_id,actor_id,action,object_id,details) VALUES($1,$2,$3,$4,$5,$6,$7,$8)',
      [randomUUID(), u.org_id, u.department_id, u.id, u.id, action, objectId, JSON.stringify(details)]);
  const settingsOf = async (org: string, q: Queryable = db) => {
    const r = (await q.query('SELECT * FROM scm_settings WHERE org_id=$1', [org])).rows[0];
    return { targetDays: r?.target_days ?? 30, safetyDays: r?.safety_days ?? 14, orderDays: r?.order_days ?? 2, receiveDays: r?.receive_days ?? 5,
      bufferDays: r?.buffer_days ?? 0, productionDays: r?.production_days ?? 30, firstLegDays: r?.first_leg_days ?? 35 };
  };

  /* ---------- the board ---------- */
  app.get('/scm/board', async req => {
    const u = actorOf(req); requireView(u);
    const s = await settingsOf(u.org_id), t = today(), since365 = addDays(t, -365), since30 = addDays(t, -30);
    const catalog = (await db.query(`SELECT c.sku,c.name_zh,c.name_en,c.family,c.status,c.lead,COALESCE(c.attrs->>'firstLeg','') first_leg,COALESCE(c.attrs->>'moqUnit','') moq,
      COALESCE(c.attrs->>'series','') series,COALESCE(c.attrs->>'brand','') brand,COALESCE(c.attrs->>'supplyMode','') supply_mode,p.attrs pattrs FROM product_catalog c LEFT JOIN product_pricing p ON p.org_id=c.org_id AND p.sku=c.sku WHERE c.org_id=$1 AND lower(c.sku) NOT LIKE 'ref-%'`, [u.org_id])).rows;
    const sales = new Map<string, { d365: number; d30: number; d60: number; d90: number; ly: number }>();
    // Last year's next 90 days (seasonality): the 90 days that started a year ago.
    // 60 days: the window the reorder table shows next to 30 days (owner, 2026-11-13; Shopify gives this app 60 days of orders).
    const since90 = addDays(t, -90), since60 = addDays(t, -60), nextLyEnd = addDays(t, -275);
    for (const r of (await db.query(`SELECT lower(sku) k, sum(qty)::int q365, sum(CASE WHEN day >= $3 THEN qty ELSE 0 END)::int q30,
        sum(CASE WHEN day >= $5 THEN qty ELSE 0 END)::int q90, sum(CASE WHEN day < $6 THEN qty ELSE 0 END)::int qly,
        sum(CASE WHEN day >= $7 THEN qty ELSE 0 END)::int q60
        FROM scm_sales_daily WHERE org_id=$1 AND day >= $2 AND day < $4 GROUP BY 1`,
      [u.org_id, since365, since30, t, since90, nextLyEnd, since60])).rows) sales.set(r.k, { d365: Number(r.q365), d30: Number(r.q30), d60: Number(r.q60), d90: Number(r.q90), ly: Number(r.qly) });
    const stock = new Map<string, Record<string, number>>();
    for (const r of (await db.query('SELECT lower(sku) k, location, qty FROM wms_stock WHERE org_id=$1', [u.org_id])).rows) { if (!stock.has(r.k)) stock.set(r.k, {}); stock.get(r.k)![r.location] = Number(r.qty); }
    const sync = (await db.query('SELECT * FROM scm_sync WHERE org_id=$1', [u.org_id])).rows[0];
    const wipOf = new Map<string, number>();
    for (const r of (await db.query(`SELECT lower(l.sku) k, sum(GREATEST(l.qty - l.shipped, 0))::int q FROM scm_order_lines l JOIN scm_orders o ON o.id=l.order_id
      WHERE o.org_id=$1 AND o.status='issued' GROUP BY 1`, [u.org_id])).rows) wipOf.set(r.k, Number(r.q));
    // Days of sales in the table: up to 365, fewer when the history is shorter (DS is then over the days we have).
    const first = (await db.query('SELECT min(day) d FROM scm_sales_daily WHERE org_id=$1', [u.org_id])).rows[0]?.d;
    const span365 = first ? Math.max(1, Math.min(365, Math.round((Date.parse(t) - Date.parse(ymd(first)!)) / 86400000))) : 365, span30 = Math.min(30, span365), span60 = Math.min(60, span365), span90 = Math.min(90, span365);
    const canSupplier = levelOf(u) === 'manage';
    const items = catalog.map((c: any) => {
      const k = String(c.sku).toLowerCase(), sl = sales.get(k) || { d365: 0, d30: 0, d60: 0, d90: 0, ly: 0 }, st = stock.get(k) || {};
      const ds365 = sl.d365 / span365, ds30 = sl.d30 / span30, ds90 = sl.d90 / span90, ds60 = sl.d60 / span60;
      // The 30 days before the last 30, only when the history reaches back that far.
      const prev30 = span365 >= 60 ? (sl.d60 - sl.d30) / 30 : null;
      const fc = forecastOf({ ds30, ds60, prev30, sold30: sl.d30 });
      const us = st.us || 0, transit = st.transit || 0, factory = (st.dg || 0) + (st.jn || 0);
      // Production and first leg come from the product library; settings fill in what is missing (shown with *).
      const prodLib = daysIn(c.lead), legLib = daysIn(c.first_leg), production = prodLib ?? s.productionDays, firstLeg = legLib ?? s.firstLegDays;
      const days = supplyDaysOf({ order: s.orderDays, production, firstLeg, receive: s.receiveDays, buffer: s.bufferDays });
      // Finished goods at the factory ship first, so the clock is the shorter one while there is factory stock.
      const leadDays = factory > 0 ? days.fromStock : days.full;
      return { sku: c.sku, nameZh: c.name_zh || '', nameEn: c.name_en || '', family: c.family || '', lifecycle: c.status || '', series: c.series, brand: c.brand,
        ...(canSupplier ? { suppliers: suppliersOf(c.pattrs) } : {}), sold365: sl.d365, sold90: sl.d90, sold60: sl.d60, sold30: sl.d30,
        ds365: r2(ds365), ds90: r2(ds90), ds60: r2(ds60), ds30: r2(ds30), forecast: r2(fc.ds), season: fc.season, signal: fc.signal, trendPct: fc.trendPct, us, transit, dg: st.dg || 0, jn: st.jn || 0, factory, moq: c.moq || '', productionDays: production, firstLegDays: firstLeg,
        productionFromLibrary: prodLib != null, firstLegFromLibrary: legLib != null, supplyDays: days.full, stockDays: days.fromStock, leadDays,
        arriveOn: addDays(t, leadDays), leadFromLibrary: prodLib != null && legLib != null,
        wip: wipOf.get(k) || 0,
        ...dropshipAdjust(c.supply_mode, stoppingAdjust(c.status, reorderOf({ ds: fc.ds, us, transit, factory, leadDays, targetDays: s.targetDays, safetyDays: s.safetyDays, wip: wipOf.get(k) || 0 }))) };
    });
    const ships = (await db.query(`SELECT * FROM scm_shipments WHERE org_id=$1 AND (status IN ('in_transit','at_port') OR arrived_on >= $2) ORDER BY eta, number`, [u.org_id, addDays(t, -60)])).rows;
    const lines = ships.length ? (await db.query('SELECT * FROM scm_shipment_lines WHERE shipment_id=ANY($1::text[]) ORDER BY sku', [ships.map((x: any) => x.id)])).rows : [];
    const shipments = ships.map((x: any) => { const ls = lines.filter((l: any) => l.shipment_id === x.id).map((l: any) => ({ sku: l.sku, qty: Number(l.qty), ...(l.received != null ? { received: Number(l.received) } : {}) }));
      return { id: x.id, number: x.number, mode: x.mode, carrier: x.carrier, tracking: x.tracking, source: x.source, shippedOn: ymd(x.shipped_on), eta: ymd(x.eta), status: x.status,
        arrivedOn: ymd(x.arrived_on), note: x.note, lines: ls, units: ls.reduce((a: number, l: any) => a + l.qty, 0),
        notifiedOn: ymd(x.notified_on), orderId: x.order_id || null, firstLeg: x.first_leg || '', lastLeg: x.last_leg || '', position: x.position || '', positionOn: ymd(x.position_on),
        daysTotal: Math.max(1, Math.round((Date.parse(ymd(x.eta)!) - Date.parse(ymd(x.shipped_on)!)) / 86400000)), daysGone: Math.max(0, Math.round((Date.parse(t) - Date.parse(ymd(x.shipped_on)!)) / 86400000)), daysLeft: x.status === 'in_transit' ? Math.round((Date.parse(ymd(x.eta)!) - Date.parse(t)) / 86400000) : null }; });
    const ords = (await db.query(`SELECT o.*, (SELECT display_name FROM users WHERE id=o.updated_by) upd_name FROM scm_orders o WHERE org_id=$1 AND (status IN ('draft','issued') OR COALESCE(delivered_on, closed_on) >= $2) ORDER BY ordered_on DESC, number`, [u.org_id, addDays(t, -120)])).rows;
    const olines = ords.length ? (await db.query('SELECT * FROM scm_order_lines WHERE order_id=ANY($1::text[]) ORDER BY sku', [ords.map((x: any) => x.id)])).rows : [];
    const orders = ords.map((x: any) => { const ls = olines.filter((l: any) => l.order_id === x.id).map((l: any) => ({ sku: l.sku, qty: Number(l.qty), done: Number(l.shipped) }));
      const ready = ymd(x.ready_on), delivered = ymd(x.delivered_on), days = (a: string, b: string) => Math.round((Date.parse(a) - Date.parse(b)) / 86400000);
      return { id: x.id, number: x.number, supplier: canSupplier ? x.supplier : undefined, orderedOn: ymd(x.ordered_on), readyOn: ready, issuedOn: ymd(x.issued_on), deliveredOn: delivered,
        status: x.status, closedOn: ymd(x.closed_on), note: x.note, lines: ls, edits: Number(x.edits || 0), updatedBy: x.upd_name || '', updatedAt: x.updated_at || null,
        units: ls.reduce((a: number, l: any) => a + l.qty, 0), left: ls.reduce((a: number, l: any) => a + Math.max(0, l.qty - l.done), 0), done: ls.reduce((a: number, l: any) => a + l.done, 0),
        // On time: delivered by the expected date. Late: delivered after it. Overdue: in production past it.
        daysToReady: ready && x.status === 'issued' ? days(ready, t) : null, daysLate: ready && delivered ? Math.max(0, days(delivered, ready)) : null,
        onTime: ready && delivered ? delivered <= ready : null, overdue: ready && x.status === 'issued' && t > ready ? days(t, ready) : 0 }; });
    // 供应链看板: weekly units sold over the last 52 weeks, and the last 30 days against the 30 before
    // Whole weeks only: 52 blocks of 7 days ending yesterday, so no half week pulls the line down at either end.
    const blocks = new Map((await db.query(`SELECT (($3::date - day - 1) / 7)::int b, sum(qty)::int q FROM scm_sales_daily WHERE org_id=$1 AND day >= $2 AND day < $3 GROUP BY 1`,
      [u.org_id, addDays(t, -364), t])).rows.map((r: any) => [Number(r.b), Number(r.q)]));
    const firstDay = first ? ymd(first)! : t;
    const weekly = Array.from({ length: 52 }, (_, i) => 51 - i).map(b => ({ week: addDays(t, -7 * (b + 1)), units: blocks.get(b) || 0 })).filter(w => addDays(w.week, 7) > firstDay);
    const per = (await db.query(`SELECT sum(CASE WHEN day >= $2 THEN qty ELSE 0 END)::int a, sum(CASE WHEN day < $2 THEN qty ELSE 0 END)::int b FROM scm_sales_daily WHERE org_id=$1 AND day >= $3 AND day < $4`,
      [u.org_id, addDays(t, -30), addDays(t, -60), t])).rows[0];
    const salesTrend = { weekly, last30: Number(per?.a || 0), prev30: Number(per?.b || 0) };
    return { settings: s, items, shipments, orders, sales: salesTrend, canManage: levelOf(u) === 'manage', shopify: { configured: shopifyConfigured(), lastAt: sync?.last_at || null, status: sync?.status || '',
      orders: sync?.orders || 0, units: sync?.units || 0, since: ymd(sync?.since), note: sync?.note || '', daysOfHistory: first ? span365 : 0 } };
  });

  app.put('/scm/settings', async req => {
    const u = actorOf(req); requireManage(u);
    const d = (max: number) => z.number().int().min(0).max(max);
    const v = z.object({ targetDays: z.number().int().min(1).max(365), safetyDays: d(180), orderDays: d(60), receiveDays: d(60), bufferDays: d(120),
      productionDays: d(365), firstLegDays: d(180) }).strict().parse(req.body);
    await db.query(`INSERT INTO scm_settings(org_id,target_days,safety_days,order_days,receive_days,buffer_days,production_days,first_leg_days,updated_by,updated_at)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,now()) ON CONFLICT(org_id) DO UPDATE SET target_days=$2,safety_days=$3,order_days=$4,receive_days=$5,buffer_days=$6,
      production_days=$7,first_leg_days=$8,updated_by=$9,updated_at=now()`, [u.org_id, v.targetDays, v.safetyDays, v.orderDays, v.receiveDays, v.bufferDays, v.productionDays, v.firstLegDays, u.id]);
    await audit(db, u, 'scm.settings', u.org_id, v);
    return v;
  });

  /* ---------- Shopify sales (read only) ---------- */
  const shop = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.myshopify\.com$/.test(o.shopify?.shopDomain || '') ? o.shopify!.shopDomain! : null;
  const fetcher = o.shopify?.fetcher || fetch;
  const shopifyConfigured = () => !!shop && (!!o.shopify?.accessToken || (!!o.shopify?.clientId && !!o.shopify?.clientSecret));
  let token: { value: string; until: number } | null = null;
  const accessToken = async () => {
    if (o.shopify?.accessToken) return o.shopify.accessToken;
    if (token && now() < token.until - 60_000) return token.value;
    const r = await fetcher(`https://${shop}/admin/oauth/access_token`, { method: 'POST', redirect: 'error', headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
      body: new URLSearchParams({ grant_type: 'client_credentials', client_id: o.shopify!.clientId!, client_secret: o.shopify!.clientSecret! }) });
    const j: any = r.ok ? await r.json() : null;
    if (!j?.access_token) throw new Error('shopify_unavailable');
    token = { value: j.access_token, until: now() + Number(j.expires_in || 3600) * 1000 };
    return token.value;
  };
  const QUERY = `query WorkOSSales($q: String!, $after: String) { orders(first: 100, after: $after, query: $q, sortKey: CREATED_AT) {
    nodes { createdAt cancelledAt test lineItems(first: 100) { nodes { sku quantity } } } pageInfo { hasNextPage endCursor } } }`;
  /** Pull the last `days` days of Shopify orders and store units per SKU and day (the whole window is replaced). */
  async function syncSales(org: string, days: number) {
    const since = addDays(today(), -days), per = new Map<string, number>(); let orders = 0, units = 0, after: string | null = null, pages = 0;
    do {
      const r: Response = await fetcher(`https://${shop}/admin/api/${SHOPIFY_API_VERSION}/graphql.json`, { method: 'POST', redirect: 'error',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json', 'X-Shopify-Access-Token': await accessToken() },
        body: JSON.stringify({ query: QUERY, variables: { q: `created_at:>=${since}`, after } }) });
      const j: any = r.ok ? await r.json() : null;
      if (!j?.data?.orders || j.errors?.length) throw new Error('shopify_unavailable');
      for (const n of j.data.orders.nodes) {
        if (n.cancelledAt || n.test) continue; orders++;
        const d = String(n.createdAt).slice(0, 10);
        for (const li of n.lineItems?.nodes || []) { const s = String(li.sku || '').trim(); const q = Number(li.quantity) || 0; if (!s || q <= 0 || isReturnSku(s)) continue; per.set(`${s}\u0000${d}`, (per.get(`${s}\u0000${d}`) || 0) + q); units += q; }
      }
      after = j.data.orders.pageInfo?.hasNextPage ? j.data.orders.pageInfo.endCursor : null;
    } while (after && ++pages < 500);
    await db.transaction(async tx => {
      await tx.query('DELETE FROM scm_sales_daily WHERE org_id=$1 AND day >= $2', [org, since]);
      for (const [k, q] of per) { const [s, d] = k.split('\u0000'); await tx.query('INSERT INTO scm_sales_daily(org_id,sku,day,qty) VALUES($1,$2,$3,$4) ON CONFLICT(org_id,sku,day) DO UPDATE SET qty=$4', [org, s, d, q]); }
      await tx.query(`INSERT INTO scm_sync(org_id,last_at,status,orders,units,since,note) VALUES($1,now(),'ok',$2,$3,$4,$5)
        ON CONFLICT(org_id) DO UPDATE SET last_at=now(),status='ok',orders=$2,units=$3,since=$4,note=$5`, [org, orders, units, since, pages >= 500 ? 'stopped after 50,000 orders' : '']);
    });
    return { orders, units, since };
  }
  app.post('/scm/sync', async req => {
    const u = actorOf(req); requireManage(u);
    if (!shopifyConfigured()) deny(400, 'SCM_SHOPIFY_NOT_CONFIGURED', 'Shopify is not connected on the server yet', '服务器还没有连接 Shopify，请主管理员在部署配置里设置 Shopify。');
    const v = z.object({ days: z.number().int().min(1).max(400).default(365) }).strict().parse(req.body ?? {});
    try { const r = await syncSales(u.org_id, v.days); await audit(db, u, 'scm.sync', u.org_id, r); return r; }
    catch {
      await db.query(`INSERT INTO scm_sync(org_id,last_at,status) VALUES($1,now(),'failed') ON CONFLICT(org_id) DO UPDATE SET last_at=now(),status='failed'`, [u.org_id]);
      return deny(502, 'SCM_SHOPIFY_FAILED', 'Could not read orders from Shopify; check the app’s read_orders / read_all_orders access', '读取 Shopify 订单失败，请检查 Shopify 应用是否开了 read_orders 和 read_all_orders 权限。');
    }
  });

  /* ---------- shipments (in transit) ---------- */
  const shipInput = z.object({
    number: z.string().trim().min(1).max(60), mode: z.enum(['sea', 'air', 'express', 'truck']).optional(),
    // 头程 / 尾程 (owner, 2026-11-12), both required; their default days add up to the days to arrive
    firstLeg: z.enum(['air', 'oa', 'fast', 'matson']), lastLeg: z.enum(['express', 'port', 'truck']), carrier: z.string().trim().max(80).optional(), tracking: z.string().trim().max(120).optional(),
    source: z.enum(['dg', 'jn', 'new']), shippedOn: day, etaDays: z.number().int().min(0).max(180).optional(), eta: day.optional(), note: z.string().trim().max(1000).optional(),
    lines: z.array(z.object({ sku, qty: z.number().int().positive().max(1_000_000) }).strict()).min(1).max(300), orderId: z.string().uuid().optional(),
  }).strict();
  app.post('/scm/shipments', async (req, reply) => {
    const u = actorOf(req); requireManage(u);
    const v = shipInput.parse(req.body);
    // Days to arrive: what was entered, else the default days of the first leg + the last mile
    const eta = v.eta || addDays(v.shippedOn, v.etaDays ?? (FIRST_LEGS[v.firstLeg] + LAST_LEGS[v.lastLeg]));
    if (!eta) deny(400, 'SCM_ETA', 'Enter the days to arrive or the arrival date', '请填预计多少天到，或预计到港日期。');
    if (eta < v.shippedOn || v.shippedOn < '2000-01-01') deny(400, 'SCM_DATES', 'Check the ship and arrival dates', '请检查发货日期和预计到港日期。');
    const out = await db.transaction(async tx => {
      if ((await tx.query('SELECT 1 FROM scm_shipments WHERE org_id=$1 AND lower(number)=lower($2)', [u.org_id, v.number])).rows.length)
        deny(409, 'SCM_SHIPMENT_EXISTS', 'A shipment with this number already exists', '这个柜号 / 单号已经登记过了。');
      const sid = randomUUID();
      // Into "in transit" through WMS: from a factory warehouse, or as new goods straight from production.
      const moved = await wmsMoveLines(tx, u, { type: v.source === 'new' ? 'in' : 'transfer', from: v.source === 'new' ? 'transit' : v.source, to: 'transit', lines: v.lines,
        reason: `发柜 ${v.number}${v.tracking ? ' · ' + v.tracking : ''}`, reference: v.number.slice(0, 80), opDate: v.shippedOn });
      if (v.orderId && v.source === 'new') {
        const po = (await tx.query("SELECT id,status FROM scm_orders WHERE id=$1 AND org_id=$2 FOR UPDATE", [v.orderId, u.org_id])).rows[0];
        if (!po) deny(404, 'SCM_ORDER_NOT_FOUND', 'Purchase order not found', '找不到这张采购单。');
        if (po.status !== 'issued') deny(409, 'SCM_ORDER_STATE', 'Only an order in production can be shipped against', '只有已下达生产的采购单可以关联发柜。');
        for (const l of moved) await tx.query('UPDATE scm_order_lines SET shipped=LEAST(qty, shipped+$3) WHERE order_id=$1 AND lower(sku)=lower($2)', [po.id, l.sku, l.qty]);
        // All shipped: the order is done
        await deliveredIfDone(tx, po.id, v.shippedOn);
      }
      if (v.orderId && v.source !== 'new' && !(await tx.query('SELECT 1 FROM scm_orders WHERE id=$1 AND org_id=$2', [v.orderId, u.org_id])).rows.length) deny(404, 'SCM_ORDER_NOT_FOUND', 'Purchase order not found', '找不到这张采购单。');
      await tx.query(`INSERT INTO scm_shipments(id,org_id,number,mode,carrier,tracking,source,shipped_on,eta,note,created_by,order_id,first_leg,last_leg) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
        [sid, u.org_id, v.number, v.mode || (v.firstLeg === 'air' ? 'air' : 'sea'), v.carrier || '', v.tracking || '', v.source, v.shippedOn, eta, v.note || '', u.id, v.orderId || null, v.firstLeg, v.lastLeg]);
      for (const l of moved) await tx.query('INSERT INTO scm_shipment_lines(shipment_id,sku,qty) VALUES($1,$2,$3)', [sid, l.sku, l.qty]);
      await audit(tx, u, 'scm.shipment_created', sid, { number: v.number, lines: moved.length });
      return { id: sid, number: v.number, eta };
    });
    reply.code(201);
    return out;
  });
  /* Where the ship is (owner, 2026-11-12): carriers do not push positions here, so supply chain notes it (e.g. "过巴拿马运河")
     and can move the ETA when the schedule slips. */
  app.post<{ Params: { id: string } }>('/scm/shipments/:id/position', async req => {
    const u = actorOf(req); requireManage(u);
    const v = z.object({ position: z.string().trim().max(160), eta: day.optional() }).strict().parse(req.body);
    return db.transaction(async tx => {
      const sh = (await tx.query('SELECT * FROM scm_shipments WHERE id=$1 AND org_id=$2 FOR UPDATE', [String(req.params.id), u.org_id])).rows[0];
      if (!sh) deny(404, 'NOT_FOUND', 'Shipment not found', '找不到这个货柜。');
      if (v.eta && v.eta < ymd(sh.shipped_on)!) deny(400, 'SCM_DATES', 'Check the ship and arrival dates', '请检查发货日期和预计到港日期。');
      await tx.query('UPDATE scm_shipments SET position=$2,position_on=$3,eta=COALESCE($4,eta) WHERE id=$1', [sh.id, v.position, today(), v.eta || null]);
      await audit(tx, u, 'scm.shipment_position', sh.id, { number: sh.number, position: v.position, eta: v.eta, etaBefore: ymd(sh.eta) });
      return { ok: true };
    });
  });

  /* 采购下单 (owner, 2026-11-12): a purchase order is supply-chain data, not a formality. The supplier must be one the product
     library lists for every SKU on it (主供应商 / 备选供应商); it starts as a draft (other supply managers are told), is issued
     once the factory has confirmed — only then it counts as in production — and is delivered when all is finished, on time or
     late against the expected delivery date. Drafts and issued orders can be edited; quantities never drop below what is done. */
  const orderInput = z.object({
    number: z.string().trim().max(60).optional(), supplier: z.string().trim().min(1).max(120), orderedOn: day, readyOn: day, note: z.string().trim().max(1000).optional(),
    lines: z.array(z.object({ sku, qty: z.number().int().min(1).max(1_000_000) }).strict()).min(1).max(300),
  }).strict();
  const supplyManagers = async (tx: Queryable, org: string) => (await tx.query(`SELECT id FROM users WHERE org_id=$1 AND active=true AND grants ? 'supply_manage'`, [org])).rows.map((r: any) => r.id as string);
  /** The order lines, checked against the product library: SKUs exist, and the supplier is one of each SKU's suppliers. */
  const checkOrder = async (tx: Queryable, org: string, v: z.infer<typeof orderInput>) => {
    if (v.orderedOn < '2000-01-01' || v.readyOn < v.orderedOn) deny(400, 'SCM_DATES', 'Check the order date and the expected delivery date', '请检查下单日期和预计交期：预计交期不能早于下单日期。');
    const cat = new Map((await tx.query(`SELECT c.sku,c.lead,p.attrs FROM product_catalog c LEFT JOIN product_pricing p ON p.org_id=c.org_id AND p.sku=c.sku WHERE c.org_id=$1 AND lower(c.sku) = ANY($2::text[])`,
      [org, v.lines.map(l => l.sku.toLowerCase())])).rows.map((r: any) => [String(r.sku).toLowerCase(), r]));
    const missing = v.lines.filter(l => !cat.has(l.sku.toLowerCase())).map(l => l.sku);
    if (missing.length) deny(400, 'SCM_UNKNOWN_SKUS', `These SKUs are not in the product library: ${missing.join(', ')}`, `这些 SKU 不在产品资料里：${missing.join('、')}`);
    const wrong = v.lines.filter(l => !suppliersOf(cat.get(l.sku.toLowerCase()).attrs).some(x => x.toLowerCase() === v.supplier.toLowerCase())).map(l => cat.get(l.sku.toLowerCase()).sku);
    if (wrong.length) deny(400, 'SCM_SUPPLIER_NOT_IN_PIM', `In the product library, ${v.supplier} is not a supplier of: ${wrong.join(', ')}`,
      `产品资料里，这些 SKU 的供应商（主供应商 / 备选供应商）没有“${v.supplier}”：${wrong.join('、')}。请先在产品资料里补上，或换一家供应商。`);
    const merged = new Map<string, { sku: string; qty: number }>();
    for (const l of v.lines) { const k = l.sku.toLowerCase(); merged.set(k, { sku: cat.get(k).sku, qty: (merged.get(k)?.qty || 0) + l.qty }); }
    const supplier = suppliersOf(cat.get(v.lines[0].sku.toLowerCase()).attrs).find(x => x.toLowerCase() === v.supplier.toLowerCase())!;
    return { merged, supplier };
  };
  app.post('/scm/orders', async (req, reply) => {
    const u = actorOf(req); requireManage(u);
    const v = orderInput.parse(req.body);
    const out = await db.transaction(async tx => {
      const { merged, supplier } = await checkOrder(tx, u.org_id, v);
      const seq = Number((await tx.query("SELECT count(*)::int n FROM scm_orders WHERE org_id=$1 AND ordered_on=$2", [u.org_id, v.orderedOn])).rows[0].n) + 1;
      const number = v.number || `PO-${v.orderedOn.replace(/-/g, '')}-${String(seq).padStart(2, '0')}`;
      if ((await tx.query('SELECT 1 FROM scm_orders WHERE org_id=$1 AND lower(number)=lower($2)', [u.org_id, number])).rows.length)
        deny(409, 'SCM_ORDER_EXISTS', 'A purchase order with this number already exists', '这个采购单号已经有了。');
      const id = randomUUID();
      await tx.query(`INSERT INTO scm_orders(id,org_id,number,factory,supplier,ordered_on,ready_on,note,created_by,status) VALUES($1,$2,$3,'dg',$4,$5,$6,$7,$8,'draft')`,
        [id, u.org_id, number, supplier, v.orderedOn, v.readyOn, v.note || '', u.id]);
      for (const l of merged.values()) await tx.query('INSERT INTO scm_order_lines(order_id,sku,qty) VALUES($1,$2,$3)', [id, l.sku, l.qty]);
      await pushInbox(tx, { orgId: u.org_id, recipients: await supplyManagers(tx, u.org_id), actorId: u.id, kind: 'scm_order', title: `采购单草稿：${number}`,
        body: `${supplier} · ${merged.size} 个 SKU、${[...merged.values()].reduce((a, l) => a + l.qty, 0)} 件 · 预计交期 ${v.readyOn}。请在“供应链管理 → 采购下单”查看，和工厂确认后点“下达生产”。` });
      await audit(tx, u, 'scm.order_drafted', id, { number, supplier, readyOn: v.readyOn, lines: [...merged.values()] });
      return { id, number, status: 'draft' };
    });
    reply.code(201);
    return out;
  });
  const openOrder = async (tx: Queryable, u: User, id: string, allowed: string[]) => {
    const po = (await tx.query('SELECT * FROM scm_orders WHERE id=$1 AND org_id=$2 FOR UPDATE', [id, u.org_id])).rows[0];
    if (!po) deny(404, 'SCM_ORDER_NOT_FOUND', 'Purchase order not found', '找不到这张采购单。');
    if (!allowed.includes(po.status)) deny(409, 'SCM_ORDER_STATE', `This purchase order is ${po.status}`, po.status === 'delivered' ? '这张采购单已经交付了。' : po.status === 'closed' ? '这张采购单已经关闭了。' : po.status === 'draft' ? '这张采购单还是草稿，请先下达生产。' : '这张采购单已经下达生产了。');
    return po;
  };
  // 修改: drafts and orders in production; a line can never go below what is already finished
  app.post<{ Params: { id: string } }>('/scm/orders/:id/edit', async req => {
    const u = actorOf(req); requireManage(u);
    const v = orderInput.parse(req.body);
    return db.transaction(async tx => {
      const po = await openOrder(tx, u, String(req.params.id), ['draft', 'issued']);
      const { merged, supplier } = await checkOrder(tx, u.org_id, v);
      const before = (await tx.query('SELECT sku,qty,shipped FROM scm_order_lines WHERE order_id=$1', [po.id])).rows;
      const doneOf = new Map(before.map((l: any) => [String(l.sku).toLowerCase(), Number(l.shipped)]));
      const under = [...doneOf].filter(([k, d]) => d > 0 && (merged.get(k)?.qty || 0) < d).map(([k]) => k);
      if (under.length) deny(400, 'SCM_ORDER_BELOW_DONE', 'A quantity cannot go below what is already finished', `数量不能少于已经完工的数量：${under.join('、')}`);
      if (number(v) && v.number!.toLowerCase() !== String(po.number).toLowerCase() && (await tx.query('SELECT 1 FROM scm_orders WHERE org_id=$1 AND lower(number)=lower($2) AND id<>$3', [u.org_id, v.number, po.id])).rows.length)
        deny(409, 'SCM_ORDER_EXISTS', 'A purchase order with this number already exists', '这个采购单号已经有了。');
      await tx.query('DELETE FROM scm_order_lines WHERE order_id=$1', [po.id]);
      for (const l of merged.values()) await tx.query('INSERT INTO scm_order_lines(order_id,sku,qty,shipped) VALUES($1,$2,$3,$4)', [po.id, l.sku, l.qty, doneOf.get(l.sku.toLowerCase()) || 0]);
      await tx.query('UPDATE scm_orders SET number=COALESCE($2,number),supplier=$3,ordered_on=$4,ready_on=$5,note=$6,updated_by=$7,updated_at=now(),edits=edits+1 WHERE id=$1',
        [po.id, v.number || null, supplier, v.orderedOn, v.readyOn, v.note || '', u.id]);
      await audit(tx, u, 'scm.order_edited', po.id, { number: po.number, before: { supplier: po.supplier, readyOn: ymd(po.ready_on), lines: before.map((l: any) => ({ sku: l.sku, qty: Number(l.qty) })) },
        after: { supplier, readyOn: v.readyOn, lines: [...merged.values()] } });
      return { ok: true };
    });
  });
  // 下达生产: confirmed with the factory; from now on it counts as in production
  app.post<{ Params: { id: string } }>('/scm/orders/:id/issue', async req => {
    const u = actorOf(req); requireManage(u);
    return db.transaction(async tx => {
      const po = await openOrder(tx, u, String(req.params.id), ['draft']);
      await tx.query("UPDATE scm_orders SET status='issued',issued_on=$2 WHERE id=$1", [po.id, today()]);
      await pushInbox(tx, { orgId: u.org_id, recipients: await supplyManagers(tx, u.org_id), actorId: u.id, kind: 'scm_order', title: `采购单已下达生产：${po.number}`,
        body: `${po.supplier} · 预计交期 ${ymd(po.ready_on)}。` });
      await audit(tx, u, 'scm.order_issued', po.id, { number: po.number });
      return { ok: true };
    });
  });
  /* 完工入库: finished units go into a factory warehouse (WMS goods in); in production drops by as much. All finished = delivered. */
  app.post<{ Params: { id: string } }>('/scm/orders/:id/finish', async req => {
    const u = actorOf(req); requireManage(u);
    const v = z.object({ opDate: day, location: z.enum(['dg', 'jn']).default('dg'), lines: z.array(z.object({ sku, qty: z.number().int().positive().max(1_000_000) }).strict()).min(1).max(300) }).strict().parse(req.body);
    return db.transaction(async tx => {
      const po = await openOrder(tx, u, String(req.params.id), ['issued']);
      const lines = new Map((await tx.query('SELECT sku,qty,shipped FROM scm_order_lines WHERE order_id=$1 FOR UPDATE', [po.id])).rows.map((l: any) => [String(l.sku).toLowerCase(), l]));
      const bad = v.lines.filter(l => { const x = lines.get(l.sku.toLowerCase()); return !x || l.qty > Number(x.qty) - Number(x.shipped); });
      if (bad.length) deny(400, 'SCM_FINISH_TOO_MANY', 'More than is still in production', `完工数量不能超过还在生产的数量：${bad.map(l => l.sku).join('、')}`);
      const moves = v.lines.map(l => ({ sku: lines.get(l.sku.toLowerCase())!.sku, qty: l.qty }));
      await wmsMoveLines(tx, u, { type: 'in', from: v.location, to: v.location, lines: moves, reason: `完工入库 ${po.number}`, reference: String(po.number).slice(0, 80), opDate: v.opDate });
      for (const l of moves) await tx.query('UPDATE scm_order_lines SET shipped=shipped+$3 WHERE order_id=$1 AND sku=$2', [po.id, l.sku, l.qty]);
      const delivered = await deliveredIfDone(tx, po.id, v.opDate);
      await audit(tx, u, 'scm.order_finished', po.id, { number: po.number, location: v.location, lines: moves, delivered });
      return { ok: true, units: moves.reduce((a, l) => a + l.qty, 0), delivered };
    });
  });
  // 关闭 / 取消: a draft is cancelled, an order in production is closed short; neither counts as in production any more
  app.post<{ Params: { id: string } }>('/scm/orders/:id/close', async req => {
    const u = actorOf(req); requireManage(u);
    return db.transaction(async tx => {
      const po = await openOrder(tx, u, String(req.params.id), ['draft', 'issued']);
      await tx.query("UPDATE scm_orders SET status='closed',closed_on=$2 WHERE id=$1", [po.id, today()]);
      await audit(tx, u, 'scm.order_closed', po.id, { number: po.number, was: po.status });
      return { ok: true };
    });
  });

  /* WMS 到港入仓: shipments the supply chain marked at port, received by the warehouse line by line. Each line is confirmed
     with the quantity actually received and the bin (preferred or an alternate); what was not received stays in transit. */
  const whLevel = (u: User) => warehouseLevelFor(u, o.isAdmin(u));
  app.get('/wms/arrivals', async req => {
    const u = actorOf(req); if (whLevel(u) === 'none') deny(403, 'WMS_FORBIDDEN', 'You do not have access to inventory', '你没有库存管理的权限。');
    const ships = (await db.query(`SELECT s.*, (SELECT display_name FROM users WHERE id=s.notified_by) by_name FROM scm_shipments s WHERE org_id=$1 AND status='at_port' ORDER BY notified_on, number`, [u.org_id])).rows;
    const lines = ships.length ? (await db.query(`SELECT l.shipment_id,l.sku,l.qty,c.name_zh,c.name_en,b.bin1,b.bin2,b.bin3 FROM scm_shipment_lines l
      LEFT JOIN product_catalog c ON c.org_id=$2 AND lower(c.sku)=lower(l.sku) LEFT JOIN wms_bins b ON b.org_id=$2 AND lower(b.sku)=lower(l.sku) AND b.location='us'
      WHERE l.shipment_id=ANY($1::text[]) ORDER BY l.sku`, [ships.map((x: any) => x.id), u.org_id])).rows : [];
    return { canReceive: whLevel(u) === 'manage', arrivals: ships.map((x: any) => ({ id: x.id, number: x.number, mode: x.mode, carrier: x.carrier, tracking: x.tracking, eta: ymd(x.eta),
      notifiedOn: ymd(x.notified_on), notifiedBy: x.by_name || '', lines: lines.filter((l: any) => l.shipment_id === x.id).map((l: any) => ({ sku: l.sku, qty: Number(l.qty),
        nameZh: l.name_zh || '', nameEn: l.name_en || '', bins: [l.bin1 || '', l.bin2 || '', l.bin3 || ''] })) })) };
  });
  app.post<{ Params: { id: string } }>('/wms/arrivals/:id/receive', async req => {
    const u = actorOf(req); if (whLevel(u) !== 'manage') deny(403, 'WMS_MANAGE_ONLY', 'Only warehouse managers can receive goods', '只有库存管理权限的人可以入库。');
    const v = z.object({ opDate: day, lines: z.array(z.object({ sku: z.string().trim().min(1).max(80), received: z.number().int().min(0).max(1_000_000), slot: z.number().int().min(1).max(3).optional() }).strict()).min(1).max(500) }).strict().parse(req.body);
    return db.transaction(async tx => {
      const sh = (await tx.query('SELECT * FROM scm_shipments WHERE id=$1 AND org_id=$2 FOR UPDATE', [String(req.params.id), u.org_id])).rows[0];
      if (!sh) deny(404, 'NOT_FOUND', 'Shipment not found', '找不到这个货柜。');
      if (sh.status !== 'at_port') deny(409, 'SCM_NOT_AT_PORT', sh.status === 'arrived' ? 'This shipment has already been received' : 'Supply chain has not sent the arrival notice yet',
        sh.status === 'arrived' ? '这个货柜已经入库了。' : '供应链还没有发到港通知。');
      const shipped = new Map((await tx.query('SELECT sku,qty FROM scm_shipment_lines WHERE shipment_id=$1', [sh.id])).rows.map((l: any) => [String(l.sku).toLowerCase(), { sku: l.sku, qty: Number(l.qty) }]));
      const got = new Map(v.lines.map(l => [l.sku.toLowerCase(), l]));
      const missing = [...shipped.keys()].filter(k => !got.has(k)), extra = [...got.keys()].filter(k => !shipped.has(k));
      if (missing.length || extra.length) deny(400, 'WMS_ARRIVAL_LINES', 'Confirm every line of the shipment (and only those)', `请逐行确认这个货柜的每一个 SKU：${[...missing, ...extra].slice(0, 10).join('、')}`);
      const over = v.lines.filter(l => l.received > shipped.get(l.sku.toLowerCase())!.qty);
      if (over.length) deny(400, 'WMS_ARRIVAL_OVER', 'Received more than was shipped', `实收不能多于发货数量：${over.map(l => l.sku).join('、')}。多出来的请用“入库”另外登记。`);
      const moves = v.lines.filter(l => l.received > 0).map(l => ({ sku: shipped.get(l.sku.toLowerCase())!.sku, qty: l.received, ...(l.slot ? { slot: l.slot } : {}) }));
      if (moves.length) await wmsMoveLines(tx, u, { type: 'transfer', from: 'transit', to: 'us', lines: moves, reason: `到港入仓 ${sh.number}`, reference: String(sh.number).slice(0, 80), opDate: v.opDate });
      for (const l of v.lines) await tx.query('UPDATE scm_shipment_lines SET received=$3 WHERE shipment_id=$1 AND lower(sku)=lower($2)', [sh.id, l.sku, l.received]);
      await tx.query("UPDATE scm_shipments SET status='arrived',arrived_on=$2 WHERE id=$1", [sh.id, v.opDate]);
      const short = v.lines.map(l => ({ sku: l.sku, short: shipped.get(l.sku.toLowerCase())!.qty - l.received })).filter(x => x.short > 0);
      await audit(tx, u, 'wms.arrival_received', sh.id, { number: sh.number, lines: v.lines, short });
      return { ok: true, units: moves.reduce((a, l) => a + l.qty, 0), short };
    });
  });

  /* 到港通知 (owner, 2026-11-12): supply chain says the goods are at port; the warehouse then receives them line by line in
     WMS 到港入仓 (quantity and bin per SKU). Stock moves only on receipt. Warehouse managers get an in-app notice. */
  app.post<{ Params: { id: string } }>('/scm/shipments/:id/notify', async req => {
    const u = actorOf(req); requireManage(u);
    return db.transaction(async tx => {
      const sh = (await tx.query('SELECT * FROM scm_shipments WHERE id=$1 AND org_id=$2 FOR UPDATE', [String(req.params.id), u.org_id])).rows[0];
      if (!sh) deny(404, 'NOT_FOUND', 'Shipment not found', '找不到这个货柜。');
      if (sh.status !== 'in_transit') deny(409, 'SCM_ARRIVED', 'This shipment has already been sent to the warehouse', '这个货柜已经发过到港通知了。');
      await tx.query("UPDATE scm_shipments SET status='at_port',notified_on=$2,notified_by=$3 WHERE id=$1", [sh.id, today(), u.id]);
      const lines = (await tx.query('SELECT sku,qty FROM scm_shipment_lines WHERE shipment_id=$1', [sh.id])).rows;
      const wh = (await tx.query(`SELECT id FROM users WHERE org_id=$1 AND active=true AND grants ? 'warehouse_manage'`, [u.org_id])).rows.map((r: any) => r.id);
      await pushInbox(tx, { orgId: u.org_id, recipients: wh, actorId: u.id, kind: 'wms_arrival', title: `到港入仓：${sh.number}`,
        body: `${lines.length} 个 SKU、${lines.reduce((a: number, l: any) => a + Number(l.qty), 0)} 件已到港，请在“库存管理 → 到港入仓”逐行确认数量和库位后入库。` });
      await audit(tx, u, 'scm.shipment_notified', sh.id, { number: sh.number });
      return { ok: true, notified: wh.length };
    });
  });
}
