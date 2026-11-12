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
ALTER TABLE scm_shipments ADD COLUMN IF NOT EXISTS position text NOT NULL DEFAULT '';
ALTER TABLE scm_shipments ADD COLUMN IF NOT EXISTS position_on date;
CREATE TABLE IF NOT EXISTS scm_orders(id text PRIMARY KEY, org_id text NOT NULL, number text NOT NULL, factory text NOT NULL, ordered_on date NOT NULL,
  ready_on date, status text NOT NULL DEFAULT 'open', note text NOT NULL DEFAULT '', created_by text NOT NULL, created_at timestamptz NOT NULL DEFAULT now(), closed_on date);
CREATE UNIQUE INDEX IF NOT EXISTS scm_orders_number ON scm_orders(org_id, number);
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
/** Forecast daily sales (owner, 2026-11-12: weigh seasonality and short bursts or dips).
 *  40 % the last 30 days, 30 % the last 90, 30 % the year — the year scaled by last year's next 90 days against the yearly
 *  average (seasonality, 0.5–2×, only with ≥ 300 days of history). A burst (30-day rate ≥ 1.3 × the 90-day rate) counts
 *  in only up to 2 × the 90-day rate so one viral week does not triple the order; a dip (≤ 0.7 ×) counts in fully. */
export function forecastOf(o: { ds30: number; ds90: number; ds365: number; nextLastYear: number | null; history: number }) {
  const season = o.history >= 300 && o.ds365 > 0 && o.nextLastYear != null ? Math.min(2, Math.max(0.5, o.nextLastYear / o.ds365)) : 1;
  const signal = o.ds90 > 0 && o.ds30 >= 1.3 * o.ds90 ? 'spike' : o.ds90 > 0 && o.ds30 <= 0.7 * o.ds90 ? 'dip' : o.ds90 <= 0 && o.ds30 > 0 ? 'spike' : 'steady';
  const recent = signal === 'spike' && o.ds90 > 0 ? Math.min(o.ds30, 2 * o.ds90) : o.ds30;
  const ds = Math.max(0, 0.4 * recent + 0.3 * o.ds90 + 0.3 * o.ds365 * season);
  return { ds, season: Math.round(season * 100) / 100, signal, trendPct: o.ds90 > 0 ? Math.round((o.ds30 / o.ds90 - 1) * 100) : null };
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
    const catalog = (await db.query(`SELECT sku,name_zh,name_en,family,status,lead,COALESCE(attrs->>'firstLeg','') first_leg,COALESCE(attrs->>'moqUnit','') moq FROM product_catalog WHERE org_id=$1 AND lower(sku) NOT LIKE 'ref-%'`, [u.org_id])).rows;
    const sales = new Map<string, { d365: number; d30: number; d90: number; ly: number }>();
    // Last year's next 90 days (seasonality): the 90 days that started a year ago.
    const since90 = addDays(t, -90), nextLyEnd = addDays(t, -275);
    for (const r of (await db.query(`SELECT lower(sku) k, sum(qty)::int q365, sum(CASE WHEN day >= $3 THEN qty ELSE 0 END)::int q30,
        sum(CASE WHEN day >= $5 THEN qty ELSE 0 END)::int q90, sum(CASE WHEN day < $6 THEN qty ELSE 0 END)::int qly
        FROM scm_sales_daily WHERE org_id=$1 AND day >= $2 AND day < $4 GROUP BY 1`,
      [u.org_id, since365, since30, t, since90, nextLyEnd])).rows) sales.set(r.k, { d365: Number(r.q365), d30: Number(r.q30), d90: Number(r.q90), ly: Number(r.qly) });
    const stock = new Map<string, Record<string, number>>();
    for (const r of (await db.query('SELECT lower(sku) k, location, qty FROM wms_stock WHERE org_id=$1', [u.org_id])).rows) { if (!stock.has(r.k)) stock.set(r.k, {}); stock.get(r.k)![r.location] = Number(r.qty); }
    const sync = (await db.query('SELECT * FROM scm_sync WHERE org_id=$1', [u.org_id])).rows[0];
    const wipOf = new Map<string, number>();
    for (const r of (await db.query(`SELECT lower(l.sku) k, sum(GREATEST(l.qty - l.shipped, 0))::int q FROM scm_order_lines l JOIN scm_orders o ON o.id=l.order_id
      WHERE o.org_id=$1 AND o.status='open' GROUP BY 1`, [u.org_id])).rows) wipOf.set(r.k, Number(r.q));
    // Days of sales in the table: up to 365, fewer when the history is shorter (DS is then over the days we have).
    const first = (await db.query('SELECT min(day) d FROM scm_sales_daily WHERE org_id=$1', [u.org_id])).rows[0]?.d;
    const span365 = first ? Math.max(1, Math.min(365, Math.round((Date.parse(t) - Date.parse(ymd(first)!)) / 86400000))) : 365, span30 = Math.min(30, span365), span90 = Math.min(90, span365);
    const items = catalog.map((c: any) => {
      const k = String(c.sku).toLowerCase(), sl = sales.get(k) || { d365: 0, d30: 0, d90: 0, ly: 0 }, st = stock.get(k) || {};
      const ds365 = sl.d365 / span365, ds30 = sl.d30 / span30, ds90 = sl.d90 / span90;
      const fc = forecastOf({ ds30, ds90, ds365, nextLastYear: span365 >= 300 ? sl.ly / 90 : null, history: span365 });
      const us = st.us || 0, transit = st.transit || 0, factory = (st.dg || 0) + (st.jn || 0);
      // Production and first leg come from the product library; settings fill in what is missing (shown with *).
      const prodLib = daysIn(c.lead), legLib = daysIn(c.first_leg), production = prodLib ?? s.productionDays, firstLeg = legLib ?? s.firstLegDays;
      const days = supplyDaysOf({ order: s.orderDays, production, firstLeg, receive: s.receiveDays, buffer: s.bufferDays });
      // Finished goods at the factory ship first, so the clock is the shorter one while there is factory stock.
      const leadDays = factory > 0 ? days.fromStock : days.full;
      return { sku: c.sku, nameZh: c.name_zh || '', nameEn: c.name_en || '', family: c.family || '', lifecycle: c.status || '', sold365: sl.d365, sold30: sl.d30,
        ds365: r1(ds365), ds90: r1(ds90), ds30: r1(ds30), forecast: r1(fc.ds), season: fc.season, signal: fc.signal, trendPct: fc.trendPct, us, transit, dg: st.dg || 0, jn: st.jn || 0, factory, moq: c.moq || '', productionDays: production, firstLegDays: firstLeg,
        productionFromLibrary: prodLib != null, firstLegFromLibrary: legLib != null, supplyDays: days.full, stockDays: days.fromStock, leadDays,
        arriveOn: addDays(t, leadDays), leadFromLibrary: prodLib != null && legLib != null,
        wip: wipOf.get(k) || 0,
        ...reorderOf({ ds: fc.ds, us, transit, factory, leadDays, targetDays: s.targetDays, safetyDays: s.safetyDays, wip: wipOf.get(k) || 0 }) };
    });
    const ships = (await db.query(`SELECT * FROM scm_shipments WHERE org_id=$1 AND (status IN ('in_transit','at_port') OR arrived_on >= $2) ORDER BY eta, number`, [u.org_id, addDays(t, -60)])).rows;
    const lines = ships.length ? (await db.query('SELECT * FROM scm_shipment_lines WHERE shipment_id=ANY($1::text[]) ORDER BY sku', [ships.map((x: any) => x.id)])).rows : [];
    const shipments = ships.map((x: any) => { const ls = lines.filter((l: any) => l.shipment_id === x.id).map((l: any) => ({ sku: l.sku, qty: Number(l.qty), ...(l.received != null ? { received: Number(l.received) } : {}) }));
      return { id: x.id, number: x.number, mode: x.mode, carrier: x.carrier, tracking: x.tracking, source: x.source, shippedOn: ymd(x.shipped_on), eta: ymd(x.eta), status: x.status,
        arrivedOn: ymd(x.arrived_on), note: x.note, lines: ls, units: ls.reduce((a: number, l: any) => a + l.qty, 0),
        notifiedOn: ymd(x.notified_on), orderId: x.order_id || null, position: x.position || '', positionOn: ymd(x.position_on),
        daysTotal: Math.max(1, Math.round((Date.parse(ymd(x.eta)!) - Date.parse(ymd(x.shipped_on)!)) / 86400000)), daysGone: Math.max(0, Math.round((Date.parse(t) - Date.parse(ymd(x.shipped_on)!)) / 86400000)), daysLeft: x.status === 'in_transit' ? Math.round((Date.parse(ymd(x.eta)!) - Date.parse(t)) / 86400000) : null }; });
    const ords = (await db.query(`SELECT * FROM scm_orders WHERE org_id=$1 AND (status='open' OR closed_on >= $2) ORDER BY ordered_on DESC, number`, [u.org_id, addDays(t, -120)])).rows;
    const olines = ords.length ? (await db.query('SELECT * FROM scm_order_lines WHERE order_id=ANY($1::text[]) ORDER BY sku', [ords.map((x: any) => x.id)])).rows : [];
    const orders = ords.map((x: any) => { const ls = olines.filter((l: any) => l.order_id === x.id).map((l: any) => ({ sku: l.sku, qty: Number(l.qty), done: Number(l.shipped) }));
      return { id: x.id, number: x.number, factory: x.factory, orderedOn: ymd(x.ordered_on), readyOn: ymd(x.ready_on), status: x.status, closedOn: ymd(x.closed_on), note: x.note, lines: ls,
        units: ls.reduce((a: number, l: any) => a + l.qty, 0), left: ls.reduce((a: number, l: any) => a + Math.max(0, l.qty - l.done), 0),
        daysToReady: x.ready_on && x.status === 'open' ? Math.round((Date.parse(ymd(x.ready_on)!) - Date.parse(t)) / 86400000) : null }; });
    return { settings: s, items, shipments, orders, canManage: levelOf(u) === 'manage', shopify: { configured: shopifyConfigured(), lastAt: sync?.last_at || null, status: sync?.status || '',
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
    number: z.string().trim().min(1).max(60), mode: z.enum(['sea', 'air', 'express', 'truck']), carrier: z.string().trim().max(80).optional(), tracking: z.string().trim().max(120).optional(),
    source: z.enum(['dg', 'jn', 'new']), shippedOn: day, etaDays: z.number().int().min(0).max(180).optional(), eta: day.optional(), note: z.string().trim().max(1000).optional(),
    lines: z.array(z.object({ sku, qty: z.number().int().positive().max(1_000_000) }).strict()).min(1).max(300), orderId: z.string().uuid().optional(),
  }).strict();
  app.post('/scm/shipments', async (req, reply) => {
    const u = actorOf(req); requireManage(u);
    const v = shipInput.parse(req.body);
    const eta = v.eta || (v.etaDays != null ? addDays(v.shippedOn, v.etaDays) : null);
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
        for (const l of moved) await tx.query('UPDATE scm_order_lines SET shipped=LEAST(qty, shipped+$3) WHERE order_id=$1 AND lower(sku)=lower($2)', [po.id, l.sku, l.qty]);
        // All shipped: the order is done
        if (!(await tx.query('SELECT 1 FROM scm_order_lines WHERE order_id=$1 AND shipped < qty', [po.id])).rows.length)
          await tx.query("UPDATE scm_orders SET status='closed',closed_on=$2 WHERE id=$1", [po.id, v.shippedOn]);
      }
      if (v.orderId && v.source !== 'new' && !(await tx.query('SELECT 1 FROM scm_orders WHERE id=$1 AND org_id=$2', [v.orderId, u.org_id])).rows.length) deny(404, 'SCM_ORDER_NOT_FOUND', 'Purchase order not found', '找不到这张采购单。');
      await tx.query(`INSERT INTO scm_shipments(id,org_id,number,mode,carrier,tracking,source,shipped_on,eta,note,created_by,order_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
        [sid, u.org_id, v.number, v.mode, v.carrier || '', v.tracking || '', v.source, v.shippedOn, eta, v.note || '', u.id, v.orderId || null]);
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

  /* 采购下单 (owner, 2026-11-12): which SKUs were ordered from which factory, how many, when, and when they should be ready.
     Shipments can point at an order; what was shipped counts against it, and a fully shipped order is done. */
  const orderInput = z.object({
    number: z.string().trim().max(60).optional(), factory: z.enum(['dg', 'jn', 'other']), orderedOn: day, readyOn: day.optional(), note: z.string().trim().max(1000).optional(),
    lines: z.array(z.object({ sku, qty: z.number().int().min(0).max(1_000_000) }).strict()).min(1).max(300),
  }).strict();
  app.post('/scm/orders', async (req, reply) => {
    const u = actorOf(req); requireManage(u);
    const v = orderInput.parse(req.body);
    if (v.orderedOn < '2000-01-01' || (v.readyOn && v.readyOn < v.orderedOn)) deny(400, 'SCM_DATES', 'Check the order and ready dates', '请检查下单日期和预计完工日期。');
    const out = await db.transaction(async tx => {
      const cat = new Map((await tx.query(`SELECT sku,lead FROM product_catalog WHERE org_id=$1 AND lower(sku) = ANY($2::text[])`, [u.org_id, v.lines.map(l => l.sku.toLowerCase())])).rows.map((r: any) => [String(r.sku).toLowerCase(), r]));
      const missing = v.lines.filter(l => !cat.has(l.sku.toLowerCase())).map(l => l.sku);
      if (missing.length) deny(400, 'SCM_UNKNOWN_SKUS', `These SKUs are not in the product library: ${missing.join(', ')}`, `这些 SKU 不在产品资料里：${missing.join('、')}`);
      const seq = Number((await tx.query("SELECT count(*)::int n FROM scm_orders WHERE org_id=$1 AND ordered_on=$2", [u.org_id, v.orderedOn])).rows[0].n) + 1;
      const number = v.number || `PO-${v.orderedOn.replace(/-/g, '')}-${String(seq).padStart(2, '0')}`;
      if ((await tx.query('SELECT 1 FROM scm_orders WHERE org_id=$1 AND lower(number)=lower($2)', [u.org_id, number])).rows.length)
        deny(409, 'SCM_ORDER_EXISTS', 'A purchase order with this number already exists', '这个采购单号已经有了。');
      // Ready date: given, or order date + the longest production lead time of its SKUs (product library, else the default).
      const s = await settingsOf(u.org_id, tx);
      const readyOn = v.readyOn || addDays(v.orderedOn, Math.max(...v.lines.map(l => daysIn(cat.get(l.sku.toLowerCase())?.lead) ?? s.productionDays)));
      const id = randomUUID(), merged = new Map<string, { sku: string; qty: number }>();
      for (const l of v.lines) { const k = l.sku.toLowerCase(), c = cat.get(k); merged.set(k, { sku: c.sku, qty: (merged.get(k)?.qty || 0) + l.qty }); }
      await tx.query('INSERT INTO scm_orders(id,org_id,number,factory,ordered_on,ready_on,note,created_by) VALUES($1,$2,$3,$4,$5,$6,$7,$8)', [id, u.org_id, number, v.factory, v.orderedOn, readyOn, v.note || '', u.id]);
      for (const l of merged.values()) await tx.query('INSERT INTO scm_order_lines(order_id,sku,qty) VALUES($1,$2,$3)', [id, l.sku, l.qty]);
      await audit(tx, u, 'scm.order_created', id, { number, factory: v.factory, lines: [...merged.values()] });
      return { id, number, readyOn };
    });
    reply.code(201);
    return out;
  });
  /* 完工入库: finished units of an order go into the factory warehouse (WMS goods in); work in progress drops by as much. */
  app.post<{ Params: { id: string } }>('/scm/orders/:id/finish', async req => {
    const u = actorOf(req); requireManage(u);
    const v = z.object({ opDate: day, lines: z.array(z.object({ sku, qty: z.number().int().positive().max(1_000_000) }).strict()).min(1).max(300) }).strict().parse(req.body);
    return db.transaction(async tx => {
      const po = (await tx.query('SELECT * FROM scm_orders WHERE id=$1 AND org_id=$2 FOR UPDATE', [String(req.params.id), u.org_id])).rows[0];
      if (!po) deny(404, 'SCM_ORDER_NOT_FOUND', 'Purchase order not found', '找不到这张采购单。');
      if (po.status !== 'open') deny(409, 'SCM_ORDER_CLOSED', 'This purchase order is already closed', '这张采购单已经关闭了。');
      if (!['dg', 'jn'].includes(po.factory)) deny(400, 'SCM_FINISH_FACTORY', 'Only orders from our factories go into a factory warehouse', '只有东莞、济南工厂的采购单可以完工入工厂仓；其他供应商的货请在新建货柜时直接关联采购单。');
      const lines = new Map((await tx.query('SELECT sku,qty,shipped FROM scm_order_lines WHERE order_id=$1 FOR UPDATE', [po.id])).rows.map((l: any) => [String(l.sku).toLowerCase(), l]));
      const bad = v.lines.filter(l => { const x = lines.get(l.sku.toLowerCase()); return !x || l.qty > Number(x.qty) - Number(x.shipped); });
      if (bad.length) deny(400, 'SCM_FINISH_TOO_MANY', 'More than is still in production', `完工数量不能超过还在生产的数量：${bad.map(l => l.sku).join('、')}`);
      const moves = v.lines.map(l => ({ sku: lines.get(l.sku.toLowerCase())!.sku, qty: l.qty }));
      await wmsMoveLines(tx, u, { type: 'in', from: po.factory, to: po.factory, lines: moves, reason: `完工入库 ${po.number}`, reference: String(po.number).slice(0, 80), opDate: v.opDate });
      for (const l of moves) await tx.query('UPDATE scm_order_lines SET shipped=shipped+$3 WHERE order_id=$1 AND sku=$2', [po.id, l.sku, l.qty]);
      if (!(await tx.query('SELECT 1 FROM scm_order_lines WHERE order_id=$1 AND shipped < qty', [po.id])).rows.length)
        await tx.query("UPDATE scm_orders SET status='closed',closed_on=$2 WHERE id=$1", [po.id, v.opDate]);
      await audit(tx, u, 'scm.order_finished', po.id, { number: po.number, lines: moves });
      return { ok: true, units: moves.reduce((a, l) => a + l.qty, 0) };
    });
  });
  app.post<{ Params: { id: string } }>('/scm/orders/:id/close', async req => {
    const u = actorOf(req); requireManage(u);
    return db.transaction(async tx => {
      const po = (await tx.query('SELECT * FROM scm_orders WHERE id=$1 AND org_id=$2 FOR UPDATE', [String(req.params.id), u.org_id])).rows[0];
      if (!po) deny(404, 'SCM_ORDER_NOT_FOUND', 'Purchase order not found', '找不到这张采购单。');
      if (po.status !== 'open') deny(409, 'SCM_ORDER_CLOSED', 'This purchase order is already closed', '这张采购单已经关闭了。');
      await tx.query("UPDATE scm_orders SET status='closed',closed_on=$2 WHERE id=$1", [po.id, today()]);
      await audit(tx, u, 'scm.order_closed', po.id, { number: po.number });
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
