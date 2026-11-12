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
import { wmsMoveLines, isReturnSku } from './wms.js';
import type { ShopifyOptions } from './shopify.js';
import { SHOPIFY_API_VERSION } from './shopify.js';

export const scmSchema = `
CREATE TABLE IF NOT EXISTS scm_sales_daily(org_id text NOT NULL, sku text NOT NULL, day date NOT NULL, qty integer NOT NULL DEFAULT 0, PRIMARY KEY(org_id,sku,day));
CREATE TABLE IF NOT EXISTS scm_sync(org_id text PRIMARY KEY, last_at timestamptz, status text NOT NULL DEFAULT '', orders integer NOT NULL DEFAULT 0, units integer NOT NULL DEFAULT 0,
  since date, note text NOT NULL DEFAULT '');
CREATE TABLE IF NOT EXISTS scm_settings(org_id text PRIMARY KEY, target_days integer NOT NULL DEFAULT 30, safety_days integer NOT NULL DEFAULT 14, lead_days integer NOT NULL DEFAULT 60,
  updated_by text, updated_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE IF NOT EXISTS scm_shipments(id text PRIMARY KEY, org_id text NOT NULL, number text NOT NULL, mode text NOT NULL DEFAULT 'sea', carrier text NOT NULL DEFAULT '',
  tracking text NOT NULL DEFAULT '', source text NOT NULL, shipped_on date NOT NULL, eta date NOT NULL, status text NOT NULL DEFAULT 'in_transit', arrived_on date,
  note text NOT NULL DEFAULT '', created_by text NOT NULL, created_at timestamptz NOT NULL DEFAULT now());
CREATE UNIQUE INDEX IF NOT EXISTS scm_shipments_number ON scm_shipments(org_id, number);
CREATE TABLE IF NOT EXISTS scm_shipment_lines(shipment_id text NOT NULL, sku text NOT NULL, qty integer NOT NULL CHECK (qty > 0), PRIMARY KEY(shipment_id, sku));
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
/** Reorder suggestion for one SKU. ds = daily units sold; stock in units. */
export function reorderOf(o: { ds: number; us: number; transit: number; factory: number; leadDays: number; targetDays: number; safetyDays: number }) {
  const need = Math.ceil(o.ds * (o.leadDays + o.targetDays + o.safetyDays)), have = o.us + o.transit;
  const gap = Math.max(0, need - have), ship = Math.min(gap, o.factory), make = gap - ship;
  const cover = o.ds > 0 ? Math.floor(have / o.ds) : null;
  const status = o.ds <= 0 ? (have > 0 ? 'no_sales' : 'idle') : cover! < o.leadDays ? 'risk' : gap > 0 ? 'reorder' : cover! > 180 ? 'overstock' : 'ok';
  return { need, gap, ship, make, cover, monthly: Math.ceil(o.ds * 30), status };
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
  const settingsOf = async (org: string) => {
    const r = (await db.query('SELECT * FROM scm_settings WHERE org_id=$1', [org])).rows[0];
    return { targetDays: r?.target_days ?? 30, safetyDays: r?.safety_days ?? 14, leadDays: r?.lead_days ?? 60 };
  };

  /* ---------- the board ---------- */
  app.get('/scm/board', async req => {
    const u = actorOf(req); requireView(u);
    const s = await settingsOf(u.org_id), t = today(), since365 = addDays(t, -365), since30 = addDays(t, -30);
    const catalog = (await db.query(`SELECT sku,name_zh,name_en,family,status,lead,COALESCE(attrs->>'firstLeg','') first_leg FROM product_catalog WHERE org_id=$1 AND lower(sku) NOT LIKE 'ref-%'`, [u.org_id])).rows;
    const sales = new Map<string, { d365: number; d30: number }>();
    for (const r of (await db.query(`SELECT lower(sku) k, sum(qty)::int q365, sum(CASE WHEN day >= $3 THEN qty ELSE 0 END)::int q30 FROM scm_sales_daily WHERE org_id=$1 AND day >= $2 AND day < $4 GROUP BY 1`,
      [u.org_id, since365, since30, t])).rows) sales.set(r.k, { d365: Number(r.q365), d30: Number(r.q30) });
    const stock = new Map<string, Record<string, number>>();
    for (const r of (await db.query('SELECT lower(sku) k, location, qty FROM wms_stock WHERE org_id=$1', [u.org_id])).rows) { if (!stock.has(r.k)) stock.set(r.k, {}); stock.get(r.k)![r.location] = Number(r.qty); }
    const sync = (await db.query('SELECT * FROM scm_sync WHERE org_id=$1', [u.org_id])).rows[0];
    // Days of sales in the table: up to 365, fewer when the history is shorter (DS is then over the days we have).
    const first = (await db.query('SELECT min(day) d FROM scm_sales_daily WHERE org_id=$1', [u.org_id])).rows[0]?.d;
    const span365 = first ? Math.max(1, Math.min(365, Math.round((Date.parse(t) - Date.parse(ymd(first)!)) / 86400000))) : 365, span30 = Math.min(30, span365);
    const items = catalog.map((c: any) => {
      const k = String(c.sku).toLowerCase(), sl = sales.get(k) || { d365: 0, d30: 0 }, st = stock.get(k) || {};
      const ds365 = sl.d365 / span365, ds30 = sl.d30 / span30, lead = leadDaysOf(c.lead, c.first_leg) ?? s.leadDays;
      const us = st.us || 0, transit = st.transit || 0, factory = (st.dg || 0) + (st.jn || 0);
      return { sku: c.sku, nameZh: c.name_zh || '', nameEn: c.name_en || '', family: c.family || '', lifecycle: c.status || '', sold365: sl.d365, sold30: sl.d30,
        ds365: r1(ds365), ds30: r1(ds30), us, transit, factory, leadDays: lead, leadFromLibrary: leadDaysOf(c.lead, c.first_leg) != null,
        ...reorderOf({ ds: ds365, us, transit, factory, leadDays: lead, targetDays: s.targetDays, safetyDays: s.safetyDays }) };
    });
    const ships = (await db.query(`SELECT * FROM scm_shipments WHERE org_id=$1 AND (status='in_transit' OR arrived_on >= $2) ORDER BY eta, number`, [u.org_id, addDays(t, -60)])).rows;
    const lines = ships.length ? (await db.query('SELECT * FROM scm_shipment_lines WHERE shipment_id=ANY($1::text[]) ORDER BY sku', [ships.map((x: any) => x.id)])).rows : [];
    const shipments = ships.map((x: any) => { const ls = lines.filter((l: any) => l.shipment_id === x.id).map((l: any) => ({ sku: l.sku, qty: Number(l.qty) }));
      return { id: x.id, number: x.number, mode: x.mode, carrier: x.carrier, tracking: x.tracking, source: x.source, shippedOn: ymd(x.shipped_on), eta: ymd(x.eta), status: x.status,
        arrivedOn: ymd(x.arrived_on), note: x.note, lines: ls, units: ls.reduce((a: number, l: any) => a + l.qty, 0),
        daysLeft: x.status === 'in_transit' ? Math.round((Date.parse(ymd(x.eta)!) - Date.parse(t)) / 86400000) : null }; });
    return { settings: s, items, shipments, canManage: levelOf(u) === 'manage', shopify: { configured: shopifyConfigured(), lastAt: sync?.last_at || null, status: sync?.status || '',
      orders: sync?.orders || 0, units: sync?.units || 0, since: ymd(sync?.since), note: sync?.note || '', daysOfHistory: first ? span365 : 0 } };
  });

  app.put('/scm/settings', async req => {
    const u = actorOf(req); requireManage(u);
    const v = z.object({ targetDays: z.number().int().min(1).max(365), safetyDays: z.number().int().min(0).max(180), leadDays: z.number().int().min(1).max(365) }).strict().parse(req.body);
    await db.query(`INSERT INTO scm_settings(org_id,target_days,safety_days,lead_days,updated_by,updated_at) VALUES($1,$2,$3,$4,$5,now())
      ON CONFLICT(org_id) DO UPDATE SET target_days=$2,safety_days=$3,lead_days=$4,updated_by=$5,updated_at=now()`, [u.org_id, v.targetDays, v.safetyDays, v.leadDays, u.id]);
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
    lines: z.array(z.object({ sku, qty: z.number().int().positive().max(1_000_000) }).strict()).min(1).max(300),
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
      await tx.query(`INSERT INTO scm_shipments(id,org_id,number,mode,carrier,tracking,source,shipped_on,eta,note,created_by) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
        [sid, u.org_id, v.number, v.mode, v.carrier || '', v.tracking || '', v.source, v.shippedOn, eta, v.note || '', u.id]);
      for (const l of moved) await tx.query('INSERT INTO scm_shipment_lines(shipment_id,sku,qty) VALUES($1,$2,$3)', [sid, l.sku, l.qty]);
      await audit(tx, u, 'scm.shipment_created', sid, { number: v.number, lines: moved.length });
      return { id: sid, number: v.number, eta };
    });
    reply.code(201);
    return out;
  });
  app.post<{ Params: { id: string } }>('/scm/shipments/:id/arrive', async req => {
    const u = actorOf(req); requireManage(u);
    const v = z.object({ arrivedOn: day.optional() }).strict().parse(req.body ?? {}), arrived = v.arrivedOn || today();
    return db.transaction(async tx => {
      const sh = (await tx.query('SELECT * FROM scm_shipments WHERE id=$1 AND org_id=$2 FOR UPDATE', [String(req.params.id), u.org_id])).rows[0];
      if (!sh) deny(404, 'NOT_FOUND', 'Shipment not found', '找不到这个货柜。');
      if (sh.status !== 'in_transit') deny(409, 'SCM_ARRIVED', 'This shipment has already arrived', '这个货柜已经到港入仓了。');
      const lines = (await tx.query('SELECT sku,qty FROM scm_shipment_lines WHERE shipment_id=$1', [sh.id])).rows.map((l: any) => ({ sku: l.sku, qty: Number(l.qty) }));
      await wmsMoveLines(tx, u, { type: 'transfer', from: 'transit', to: 'us', lines, reason: `到港入仓 ${sh.number}`, reference: String(sh.number).slice(0, 80), opDate: arrived });
      await tx.query("UPDATE scm_shipments SET status='arrived',arrived_on=$2 WHERE id=$1", [sh.id, arrived]);
      await audit(tx, u, 'scm.shipment_arrived', sh.id, { number: sh.number });
      return { ok: true };
    });
  });
}
