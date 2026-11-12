/* Inventory (WMS) and ERP permissions.
 *
 * Stock is kept per SKU and location. Every change is a movement row (who, when, how many,
 * why, reference); the stock table is only ever changed in the same transaction as the
 * movement that explains it, and can never go negative. Count adjustments wait for the
 * another person with 库存·管理 (or, when there is none, a main admin) to confirm before they touch stock.
 *
 * Access levels come from user grants and are set on the ERP permissions page:
 *   products  none / view (products) / secret (+ products_secret) / manage (+ products_manage)
 *   pricing   none / view (product_cost_detail) / edit (+ pricing_edit) / manage (+ products_import: bulk updates)
 *   supply    none / view (supply) / manage (supply_manage)
 *   warehouse none / view (warehouse) / manage (warehouse_manage)
 *   returns   none / view (returns) / manage (returns_manage)   — returns and repairs (rma.ts), set on its own
 * Company admins can do everything. Managers can view stock and set warehouse access
 * for the people who report to them.
 *
 * No product or stock data lives in this repository: SKUs and opening balances are
 * imported at runtime by an admin. */
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { Database, Queryable } from './db.js';
import type { User } from './auth.js';
import { deny } from './errors.js';
import { reportsOf } from './org.js';
import { FAMILIES, STATUSES } from './product-spec.js';

export const wmsSchema = `
CREATE TABLE IF NOT EXISTS wms_items(org_id text NOT NULL, sku text NOT NULL, name text NOT NULL DEFAULT '', type text NOT NULL DEFAULT '',
  created_by text, created_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(org_id,sku));
CREATE TABLE IF NOT EXISTS wms_stock(org_id text NOT NULL, sku text NOT NULL, location text NOT NULL, qty integer NOT NULL DEFAULT 0 CHECK (qty >= 0),
  PRIMARY KEY(org_id,sku,location));
CREATE TABLE IF NOT EXISTS wms_movements(id text PRIMARY KEY, org_id text NOT NULL, type text NOT NULL, sku text NOT NULL, location text NOT NULL, to_location text,
  qty integer NOT NULL, counted integer, system_qty integer, reason text NOT NULL, reference text, status text NOT NULL DEFAULT 'done',
  created_by text NOT NULL, created_at timestamptz NOT NULL DEFAULT now(), decided_by text, decided_at timestamptz);
CREATE INDEX IF NOT EXISTS wms_movements_org ON wms_movements(org_id,created_at);
CREATE INDEX IF NOT EXISTS wms_movements_sku ON wms_movements(org_id,sku,created_at);
CREATE INDEX IF NOT EXISTS wms_movements_pending ON wms_movements(org_id,created_at) WHERE status='pending';
ALTER TABLE wms_movements ADD COLUMN IF NOT EXISTS op_date date;
CREATE TABLE IF NOT EXISTS wms_bins(org_id text NOT NULL, sku text NOT NULL, location text NOT NULL, bin1 text NOT NULL DEFAULT '', bin2 text NOT NULL DEFAULT '',
  bin3 text NOT NULL DEFAULT '', updated_by text, updated_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(org_id,sku,location));
ALTER TABLE wms_bins ADD COLUMN IF NOT EXISTS qty1 integer NOT NULL DEFAULT 0;
ALTER TABLE wms_bins ADD COLUMN IF NOT EXISTS qty2 integer NOT NULL DEFAULT 0;
ALTER TABLE wms_bins ADD COLUMN IF NOT EXISTS qty3 integer NOT NULL DEFAULT 0;
CREATE TABLE IF NOT EXISTS wms_bin_codes(org_id text NOT NULL, location text NOT NULL, code text NOT NULL, note text NOT NULL DEFAULT '',
  created_by text, created_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(org_id,location,code));
CREATE TABLE IF NOT EXISTS erp_migrations(id text PRIMARY KEY, done_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE IF NOT EXISTS wms_imports(id text PRIMARY KEY, org_id text NOT NULL, as_of date NOT NULL, rows integer NOT NULL, created_by text NOT NULL, created_at timestamptz NOT NULL DEFAULT now());
`;

/** Regular stock locations. Returns and repairs (REF- SKUs) are not regular stock: they live only in the
 * returns module (rma.ts), so there is no returns warehouse here and REF- SKUs never show or move in WMS. */
export const LOCATIONS = [
  { id: 'us', zh: '美国LA仓', en: 'US LA warehouse' },
  { id: 'dg', zh: '东莞工厂仓', en: 'Dongguan factory' },
  { id: 'jn', zh: '济南工厂仓', en: 'Jinan factory' },
  { id: 'transit', zh: '在途运输中', en: 'In transit' },
] as const;
export const isReturnSku = (s: string) => /^REF-/i.test(String(s || '').trim());
const notReturns = (col = 'sku') => `lower(${col}) NOT LIKE 'ref-%'`;
const returnSkuDenied = (skus: string[]) => deny(400, 'WMS_RETURN_SKU', `Returned-goods SKUs (REF-…) are handled in Returns & repairs, not in regular stock: ${skus.slice(0, 10).join(', ')}`,
  `REF- 开头的退货 SKU 在“退货维修”里管理，不进常规库存：${skus.slice(0, 10).join('、')}`);
const LOC_IDS = LOCATIONS.map(l => l.id) as [string, ...string[]];

export const ERP_GRANTS = ['products_secret', 'products_manage', 'product_cost_detail', 'pricing_edit', 'products_import', 'supply', 'supply_manage', 'warehouse', 'warehouse_manage', 'returns', 'returns_manage', 'dealers', 'dealers_manage'] as const;
const AREAS: Record<string, Record<string, string[]>> = {
  /** 产品资料 (owner's levels, 2026-11-12): 无 / 查看普通信息 / 查看保密信息 (suppliers, landed cost, files…) / 管理信息 (edit everything). */
  products: { none: [], view: ['products'], secret: ['products', 'products_secret'], manage: ['products', 'products_secret', 'products_manage'] },
  /** 价格: 无 / 查看 (price build-up, cost and margin) / 单项修改 (one SKU at a time) / 管理 (also bulk updates). Price parameters stay main-admin only. */
  pricing: { none: [], view: ['product_cost_detail'], edit: ['product_cost_detail', 'pricing_edit'], manage: ['product_cost_detail', 'pricing_edit', 'products_import'] },
  supply: { none: [], view: ['supply'], manage: ['supply', 'supply_manage'] },
  warehouse: { none: [], view: ['warehouse'], manage: ['warehouse', 'warehouse_manage'] },
  /** 退货维修 has its own access (set on the returns page); until 2026-11 it followed warehouse access, see migrateReturnsAccess. */
  returns: { none: [], view: ['returns'], manage: ['returns', 'returns_manage'] },
  dealers: { none: [], view: ['dealers'], manage: ['dealers', 'dealers_manage'] },
};
const areaGrants = (area: string) => [...new Set(Object.values(AREAS[area]).flat())];
const levelOf = (grants: string[], area: string) => {
  const levels = Object.entries(AREAS[area]).reverse(); // highest first
  return levels.find(([, need]) => need.length && need.every(g => grants.includes(g)))?.[0] || 'none';
};
/** Warehouse access level of a person: admins manage; otherwise from grants; managers and product people can view. */
export const warehouseLevelFor = (u: any, admin: boolean) => {
  if (admin) return 'manage';
  const g: string[] = Array.isArray(u.grants) ? u.grants : [], lv = levelOf(g, 'warehouse');
  if (lv !== 'none') return lv;
  return u.role === 'manager' || g.includes('products') ? 'view' : 'none';
};
/* Shelf bins hold quantities too. The warehouse total (wms_stock) stays the one number that must be right; the three bins
   of a SKU in a warehouse say how much of it sits where, and whatever is not in a bin is "unassigned" (total − bins ≥ 0).
   Every change to a warehouse total goes through binsAfterChange so the bins follow: goods in go to the chosen bin
   (the preferred one by default), goods out are picked from the chosen bin or from the bins in order and then the
   unassigned stock, and count differences or imports take from the unassigned stock first. */
const sumQ = (q: number[]) => q.reduce((a, b) => a + b, 0);
export async function binsAfterChange(tx: Queryable, org: string, sku: string, loc: string, delta: number, total: number, o: { slot?: number; mode?: 'pick' | 'count' } = {}) {
  const r = (await tx.query('SELECT bin1,bin2,bin3,qty1,qty2,qty3 FROM wms_bins WHERE org_id=$1 AND sku=$2 AND location=$3 FOR UPDATE', [org, sku, loc])).rows[0];
  if (!r) { if (o.slot) deny(400, 'WMS_BIN_NOT_SET', `${sku} has no bins set in this warehouse yet`, `${sku} 在这个仓库还没有设置库位。`); return; }
  const codes = [r.bin1, r.bin2, r.bin3], q = [r.qty1, r.qty2, r.qty3].map(Number);
  if (o.slot && !codes[o.slot - 1]) deny(400, 'WMS_BIN_NOT_SET', `${sku} has no bin ${o.slot} in this warehouse`, `${sku} 在这个仓库没有设置这个库位。`);
  if (delta > 0) { const slot = o.slot || 1; if (codes[slot - 1]) q[slot - 1] += delta; }
  else if (delta < 0) {
    let need = -delta;
    const before = total - delta, unassigned = Math.max(0, before - sumQ(q));
    if (o.slot) {
      if (q[o.slot - 1] < need) deny(409, 'WMS_BIN_SHORT', `${sku}: bin ${codes[o.slot - 1]} has only ${q[o.slot - 1]}`, `${sku}：库位 ${codes[o.slot - 1]} 只有 ${q[o.slot - 1]} 件。`);
      q[o.slot - 1] -= need; need = 0;
    } else {
      const order: (number | 'u')[] = o.mode === 'count' ? ['u', 2, 1, 0] : [0, 1, 2, 'u'];
      let u = unassigned;
      for (const k of order) { if (!need) break; if (k === 'u') { const t = Math.min(u, need); u -= t; need -= t; } else { const t = Math.min(q[k], need); q[k] -= t; need -= t; } }
    }
  }
  for (let i = 2; i >= 0 && sumQ(q) > total; i--) q[i] = Math.max(0, q[i] - (sumQ(q) - total)); // never more in bins than in the warehouse
  await tx.query('UPDATE wms_bins SET qty1=$4,qty2=$5,qty3=$6 WHERE org_id=$1 AND sku=$2 AND location=$3', [org, sku, loc, ...q]);
}
const stockAt = async (tx: Queryable, org: string, s: string, loc: string, lock = false) =>
  Number((await tx.query('SELECT qty FROM wms_stock WHERE org_id=$1 AND sku=$2 AND location=$3' + (lock ? ' FOR UPDATE' : ''), [org, s, loc])).rows[0]?.qty ?? 0);
const changeStock = async (tx: Queryable, org: string, s: string, loc: string, delta: number, bin: { slot?: number; mode?: 'pick' | 'count' } = {}) => {
  const have = await stockAt(tx, org, s, loc, true);
  if (have + delta < 0) deny(409, 'WMS_NEGATIVE_STOCK', `Not enough stock of ${s}: ${have} on hand`, `${s} 库存不足：现有 ${have} 件。`);
  await tx.query('INSERT INTO wms_stock(org_id,sku,location,qty) VALUES($1,$2,$3,$4) ON CONFLICT(org_id,sku,location) DO UPDATE SET qty=$4', [org, s, loc, have + delta]);
  await binsAfterChange(tx, org, s, loc, delta, have + delta, bin);
};
/** Stock movements for other modules (SCM shipments): goods in, or a transfer between warehouses, many SKUs, in the
 *  caller's transaction, logged like the warehouse's own batch. WMS stays the only writer of stock. Returns the lines
 *  with the stored SKU spelling. */
export async function wmsMoveLines(tx: Queryable, u: User, v: { type: 'in' | 'transfer'; from: string; to: string; lines: { sku: string; qty: number; slot?: number }[]; reason: string; reference?: string; opDate: string }) {
  const ref = v.lines.map(l => l.sku).filter(isReturnSku); if (ref.length) returnSkuDenied(ref);
  const merged = new Map<string, number>(), slots = new Map<string, number>();
  for (const l of v.lines) { merged.set(l.sku.toLowerCase(), (merged.get(l.sku.toLowerCase()) || 0) + l.qty); if (l.slot) slots.set(l.sku.toLowerCase(), l.slot); }
  await adoptCatalogItems(tx, u.org_id, u.id, [...merged.keys()]);
  const known = new Map(((await tx.query('SELECT sku FROM wms_items WHERE org_id=$1', [u.org_id])).rows as { sku: string }[]).map(i => [i.sku.toLowerCase(), i.sku]));
  const missing = [...merged.keys()].filter(k => !known.has(k));
  if (missing.length) deny(400, 'WMS_UNKNOWN_SKUS', `These SKUs do not exist yet: ${missing.slice(0, 10).join(', ')}`, `这些 SKU 还不存在，请先在产品资料里新增：${missing.slice(0, 10).join('、')}`);
  const out: { sku: string; qty: number }[] = [];
  for (const [k, qty] of merged) {
    const s = known.get(k)!;
    const into = slots.has(k) ? { slot: slots.get(k) } : {};
    if (v.type === 'in') await changeStock(tx, u.org_id, s, v.to, qty, into);
    else { await changeStock(tx, u.org_id, s, v.from, -qty); await changeStock(tx, u.org_id, s, v.to, qty, into); }
    await tx.query(`INSERT INTO wms_movements(id,org_id,type,sku,location,to_location,qty,reason,reference,status,created_by,op_date) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,'done',$10,$11)`,
      [randomUUID(), u.org_id, v.type, s, v.type === 'in' ? v.to : v.from, v.type === 'transfer' ? v.to : null, qty, v.reason.slice(0, 200), v.reference || null, u.id, v.opDate]);
    out.push({ sku: s, qty });
  }
  return out;
}
/** Returns and repairs access: admins manage; otherwise from the returns grants; managers and product people can view. */
export const returnsLevelFor = (u: any, admin: boolean) => {
  if (admin) return 'manage';
  const g: string[] = Array.isArray(u.grants) ? u.grants : [], lv = levelOf(g, 'returns');
  if (lv !== 'none') return lv;
  return u.role === 'manager' || g.includes('products') ? 'view' : 'none';
};
/** Once: people who had warehouse access keep the same access to returns when returns get their own grants. */
export async function migrateReturnsAccess(db: Database) {
  await db.transaction(async tx => {
    if (!(await tx.query(`INSERT INTO erp_migrations(id) VALUES('returns_grants_v1') ON CONFLICT DO NOTHING RETURNING id`)).rows.length) return;
    for (const [from, add] of [['warehouse', 'returns'], ['warehouse_manage', 'returns_manage']])
      await tx.query(`UPDATE users SET grants = grants || $2::jsonb WHERE grants ? $1 AND NOT grants ? $3`, [from, JSON.stringify([add]), add]);
  });
}
/** Once (2026-11-12): products and pricing move to four levels each. Nobody gains visibility they did not have:
 *  - the old full price build-up (product_cost_detail: see and edit cost) becomes pricing 单项修改, plus 查看保密信息 with product access,
 *    and pricing 管理 when they also had bulk updates;
 *  - product managers without cost access drop to 查看普通信息 (管理 now includes the confidential fields), bulk updates likewise;
 *  - the old MSRP-only level (pricing_msrp) ends. */
export async function migrateProductPricingLevels(db: Database) {
  await db.transaction(async tx => {
    if (!(await tx.query(`INSERT INTO erp_migrations(id) VALUES('product_pricing_levels_v1') ON CONFLICT DO NOTHING RETURNING id`)).rows.length) return;
    for (const r of (await tx.query(`SELECT id,grants FROM users WHERE grants ?| array['product_cost_detail','products_manage','products_import','pricing_msrp']`)).rows) {
      const g = new Set<string>(Array.isArray(r.grants) ? r.grants : []), cost = g.has('product_cost_detail');
      if (cost) { g.add('pricing_edit'); if (g.has('products')) g.add('products_secret'); }
      else if (!g.has('products_secret')) { g.delete('products_manage'); g.delete('products_import'); }
      g.delete('pricing_msrp');
      await tx.query('UPDATE users SET grants=$2 WHERE id=$1', [r.id, JSON.stringify([...g])]);
    }
  });
}
export const accessOf = (grants: string[]) => Object.fromEntries(Object.keys(AREAS).map(a => [a, levelOf(grants, a)]));

/** Operation date (操作日期): defaults to today in the form, the operator may change it; not before 2000 and not after tomorrow. */
const opDay = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use a date like 2026-11-12');
const checkOpDate = (d: string) => {
  const max = new Date(Date.now() + 36 * 3600_000).toISOString().slice(0, 10);
  if (d < '2000-01-01' || d > max || Number.isNaN(Date.parse(d + 'T00:00:00Z'))) deny(400, 'WMS_OP_DATE', 'Check the operation date', '操作日期不对，请检查（不能早于 2000 年，也不能是未来的日期）。');
};
/** How a movement was made, for the log: opening import, dealer shipment, several SKUs in one go, or one by hand. */
const methodOf = (m: any, n: number) => m.reference === 'IMPORT' ? 'import' : /^Dealer order /.test(m.reason || '') ? 'dealer' : n > 1 ? 'batch' : 'manual';
const sku = z.string().trim().min(1).max(80).regex(/^[A-Za-z0-9][A-Za-z0-9._\-/ ]*$/, 'Use letters, digits, dot, dash, slash or underscore in the SKU');
const uid = z.string().min(1).max(100);
const nameOf = (u: any) => u ? (u.display_name || u.name_zh || u.name_en || u.id) : '';

/** A returned-goods SKU (REF-…) that is not in the item list yet: the returns desk adds it when registering the return,
 * only as a name entry (type 'return'); regular stock never lists or moves it. WMS stays the only writer of wms_items;
 * the caller passes its transaction. Returns the stored SKU. */
export async function ensureReturnItem(tx: Queryable, org: string, actorId: string, s: string) {
  const found = (await tx.query('SELECT sku FROM wms_items WHERE org_id=$1 AND lower(sku)=lower($2)', [org, s])).rows[0];
  if (found) return found.sku as string;
  const base = s.replace(/^REF-/i, ''), baseItem = (await tx.query('SELECT name FROM wms_items WHERE org_id=$1 AND lower(sku)=lower($2)', [org, base])).rows[0];
  await tx.query('INSERT INTO wms_items(org_id,sku,name,type,created_by) VALUES($1,$2,$3,$4,$5)', [org, s, `退货 · ${baseItem?.name || base}`, 'return', actorId]);
  return s;
}

/** Products in the product library (product_catalog) count as warehouse SKUs: the first stock movement of a
 * library SKU that is not in wms_items yet adds it here, with the library's name and type. Until then the
 * summary lists it at zero. Returned-goods SKUs (REF-…) are never adopted. */
export async function adoptCatalogItems(tx: Queryable, org: string, actorId: string, skus: string[]) {
  const want = [...new Set(skus.map(s => String(s || '').trim().toLowerCase()).filter(s => s && !isReturnSku(s)))];
  if (!want.length) return;
  await tx.query(`INSERT INTO wms_items(org_id,sku,name,type,created_by)
    SELECT c.org_id, c.sku, COALESCE(NULLIF(c.name_zh,''),NULLIF(c.name_en,''),c.sku), c.type, $3 FROM product_catalog c
    WHERE c.org_id=$1 AND lower(c.sku) = ANY($2::text[])
      AND NOT EXISTS (SELECT 1 FROM wms_items w WHERE w.org_id=c.org_id AND lower(w.sku)=lower(c.sku))
    ON CONFLICT DO NOTHING`, [org, want, actorId]);
}

export async function registerWmsRoutes(app: FastifyInstance, db: Database, o: { isAdmin: (u: User) => boolean }) {
  await migrateReturnsAccess(db);
  await migrateProductPricingLevels(db);
  const actorOf = (req: FastifyRequest): User => req.actor || deny(401, 'UNAUTHENTICATED', 'Authentication is required');
  const grantsOf = (u: any): string[] => Array.isArray(u.grants) ? u.grants : [];
  const warehouseLevel = (u: User) => {
    if (o.isAdmin(u)) return 'manage';
    const g = grantsOf(u), lv = levelOf(g, 'warehouse');
    if (lv !== 'none') return lv;
    return (u as any).role === 'manager' || g.includes('products') ? 'view' : 'none';
  };
  const requireView = (u: User) => { if (warehouseLevel(u) === 'none') deny(403, 'WMS_FORBIDDEN', 'You do not have access to warehouse stock'); };
  const requireManage = (u: User) => { if (warehouseLevel(u) !== 'manage') deny(403, 'WMS_MANAGE_ONLY', 'Only warehouse managers can change stock'); };
  const audit = (tx: Queryable, u: User, action: string, objectId: string, details: unknown) =>
    tx.query('INSERT INTO audit_events(id,org_id,department_id,owner_id,actor_id,action,object_id,details) VALUES($1,$2,$3,$4,$5,$6,$7,$8)',
      [randomUUID(), u.org_id, u.department_id, u.id, u.id, action, objectId, JSON.stringify(details)]);
  const stockOf = stockAt, addStock = changeStock;
  const itemOf = async (tx: Queryable, org: string, s: string, actorId: string) => {
    await adoptCatalogItems(tx, org, actorId, [s]);
    const it = (await tx.query('SELECT * FROM wms_items WHERE org_id=$1 AND lower(sku)=lower($2) ORDER BY sku=$2 DESC LIMIT 1', [org, s])).rows[0];
    if (!it) deny(404, 'WMS_UNKNOWN_SKU', 'This SKU does not exist yet; add it first');
    return it;
  };
  /* A count adjustment takes effect once someone else with 库存·管理 confirms it (owner, 2026-11-12). When nobody else has it,
     the main admins confirm (the submitter too, if they are the only main admin). The page names who can confirm. */
  const peopleOf = async (org: string, q: Queryable = db) => new Map((await q.query('SELECT id,display_name,name_zh,name_en,manager_id,second_manager_id,grants,active,is_admin,quality_factory FROM users WHERE org_id=$1', [org])).rows.map((p: any) => [p.id, p]));
  const confirmersOf = (people: Map<any, any>, submitterId: string) => {
    const live = [...people.values()].filter((p: any) => p.active && !p.quality_factory);
    const wms = live.filter((p: any) => Array.isArray(p.grants) && p.grants.includes('warehouse_manage') && p.id !== submitterId);
    if (wms.length) return wms.map((p: any) => p.id as string);
    const admins = live.filter((p: any) => o.isAdmin(p));
    const others = admins.filter((p: any) => p.id !== submitterId);
    return (others.length ? others : admins).map((p: any) => p.id as string);
  };
  const canDecide = (u: User, m: any, people: Map<any, any>) => m.status === 'pending'
    && (confirmersOf(people, m.created_by).includes(u.id) || (o.isAdmin(u) && u.id !== m.created_by));
  /** Movements written together (one batch, one import, one dealer shipment) share the transaction's timestamp. */
  const batchesOf = async (org: string, rows: any[]) => {
    const at = [...new Set(rows.map(r => new Date(r.created_at).toISOString()))];
    if (!at.length) return new Map<string, { n: number; units: number }>();
    const g = (await db.query(`SELECT created_by, created_at, type, count(*)::int n, sum(abs(qty))::int units FROM wms_movements WHERE org_id=$1 AND created_at = ANY($2::timestamptz[]) GROUP BY 1,2,3`, [org, at])).rows;
    return new Map(g.map((x: any) => [`${x.created_by}|${new Date(x.created_at).toISOString()}|${x.type}`, { n: Number(x.n), units: Number(x.units) }]));
  };
  const ymd = (d: unknown) => d ? (d instanceof Date ? d.toISOString() : String(d)).slice(0, 10) : null;
  const movementOut = (u: User, people: Map<any, any>, batches = new Map<string, { n: number; units: number }>()) => (m: any) => {
    const b = batches.get(`${m.created_by}|${new Date(m.created_at).toISOString()}|${m.type}`) || { n: 1, units: Math.abs(Number(m.qty)) };
    return {
    id: m.id, type: m.type, sku: m.sku, opDate: ymd(m.op_date) || ymd(m.created_at), method: methodOf(m, b.n), batchSkus: b.n, batchUnits: b.units, location: m.location, toLocation: m.to_location || undefined, qty: Number(m.qty), counted: m.counted, systemQty: m.system_qty,
    reason: m.reason, reference: m.reference || '', status: m.status, createdAt: m.created_at, byName: nameOf(people.get(m.created_by)),
    approvedByName: m.status !== 'pending' && m.decided_by ? nameOf(people.get(m.decided_by)) : '',
    canDecide: canDecide(u, m, people),
    ...(m.status === 'pending' ? { confirmers: confirmersOf(people, m.created_by).map(id => nameOf(people.get(id))) } : {}),
  }; };

  app.get('/wms/summary', async req => {
    const u = actorOf(req); requireView(u);
    // Library SKUs not moved yet are listed at zero (see adoptCatalogItems).
    const items = (await db.query(`SELECT sku,name,type FROM wms_items WHERE org_id=$1 AND type<>'return' AND ${notReturns()}
      UNION ALL SELECT c.sku, COALESCE(NULLIF(c.name_zh,''),NULLIF(c.name_en,''),c.sku), c.type FROM product_catalog c WHERE c.org_id=$1 AND ${notReturns('c.sku')}
        AND NOT EXISTS (SELECT 1 FROM wms_items w WHERE w.org_id=c.org_id AND lower(w.sku)=lower(c.sku))
      ORDER BY sku`, [u.org_id])).rows;
    const locIds = LOCATIONS.map(l => l.id);
    const stock = (await db.query('SELECT sku,location,qty FROM wms_stock WHERE org_id=$1', [u.org_id])).rows.filter((r: any) => locIds.includes(r.location));
    const qty = new Map<string, Record<string, number>>();
    for (const r of stock) { if (!qty.has(r.sku)) qty.set(r.sku, {}); qty.get(r.sku)![r.location] = Number(r.qty); }
    const moves = (await db.query(`SELECT * FROM wms_movements WHERE org_id=$1 AND ${notReturns()} AND location<>'refurb' ORDER BY created_at DESC, id DESC LIMIT 500`, [u.org_id])).rows;
    // Pending adjustments older than the latest 500 movements still need a decision, so they are always included.
    const recent = new Set(moves.map((m: any) => m.id));
    const pendingOld = (await db.query(`SELECT * FROM wms_movements WHERE org_id=$1 AND status='pending' AND ${notReturns()} ORDER BY created_at`, [u.org_id])).rows.filter((m: any) => !recent.has(m.id));
    const people = await peopleOf(u.org_id);
    const lastImport = (await db.query('SELECT as_of,created_at FROM wms_imports WHERE org_id=$1 ORDER BY created_at DESC LIMIT 1', [u.org_id])).rows[0];
    const all = [...moves, ...pendingOld];
    const movements = all.map(movementOut(u, people, await batchesOf(u.org_id, all)));
    const level = warehouseLevel(u);
    // Product facts for the filters (family, series, MSRP: all public in the product library) and shelf bins per location.
    const facts = new Map((await db.query(`SELECT lower(c.sku) k, c.family, COALESCE(c.attrs->>'series','') series, COALESCE(c.attrs->>'brand','') brand, c.status, c.msrp, c.name_zh, c.name_en, p.landed_usd
      FROM product_catalog c LEFT JOIN product_pricing p ON p.org_id=c.org_id AND p.sku=c.sku WHERE c.org_id=$1`, [u.org_id])).rows.map((r: any) => [r.k, r]));
    // Stock value per warehouse: MSRP value for everyone who sees stock; landed-cost value only for cost access and main admins.
    const costOk = o.isAdmin(u) || grantsOf(u).includes('product_cost_detail'), r2 = (n: number) => Math.round(n * 100) / 100;
    const value = (k: 'msrp' | 'landed_usd') => Object.fromEntries(LOCATIONS.map(l => [l.id, r2(items.reduce((a: number, it: any) => { const f: any = facts.get(it.sku.toLowerCase()); const unit = f?.[k] == null ? 0 : Number(f[k]); return a + unit * Number(qty.get(it.sku)?.[l.id] || 0); }, 0))]));
    // The product's main image (visible to everyone in the product library), shown small next to the SKU.
    const images = new Map((await db.query(`SELECT DISTINCT ON (lower(sku)) lower(sku) k, id FROM product_files WHERE org_id=$1 AND slot='mainImage' ORDER BY lower(sku), created_at DESC`, [u.org_id])).rows.map((r: any) => [r.k, r.id]));
    const bins = new Map<string, Record<string, string[]>>();
    const binQty = new Map<string, Record<string, number[]>>();
    for (const r of (await db.query('SELECT sku,location,bin1,bin2,bin3,qty1,qty2,qty3 FROM wms_bins WHERE org_id=$1', [u.org_id])).rows) {
      const k = String(r.sku).toLowerCase(); if (!bins.has(k)) { bins.set(k, {}); binQty.set(k, {}); }
      bins.get(k)![r.location] = [r.bin1, r.bin2, r.bin3]; binQty.get(k)![r.location] = [r.qty1, r.qty2, r.qty3].map(Number);
    }
    return {
      values: { msrp: value('msrp'), ...(costOk ? { cost: value('landed_usd') } : {}) },
      locations: LOCATIONS, families: FAMILIES.map(([key, zh, en]) => ({ key, zh, en })), statuses: STATUSES.map(([key, zh, en]) => ({ key, zh, en })),
      items: items.map((it: any) => { const f: any = facts.get(it.sku.toLowerCase()) || {};
        return { ...it, qty: qty.get(it.sku) || {}, family: f.family || '', series: f.series || '', msrp: f.msrp == null ? null : Number(f.msrp),
          nameZh: f.name_zh || '', nameEn: f.name_en || '', brand: f.brand || '', status: f.status || '', imageId: images.get(it.sku.toLowerCase()) || null,
          bins: bins.get(it.sku.toLowerCase()) || {}, binQty: binQty.get(it.sku.toLowerCase()) || {} }; }),
      movements,
      canOperate: level === 'manage', canApprove: movements.some(m => m.canDecide), canAssign: o.isAdmin(u) || (u as any).role === 'manager',
      canImport: o.isAdmin(u), lastImport: lastImport ? { asOf: lastImport.as_of, at: lastImport.created_at } : null,
    };
  });

  // Full history of one SKU (the summary only carries the latest 500 movements across all SKUs).
  const historyQuery = z.object({ sku, limit: z.coerce.number().int().min(1).max(2000).optional() });
  app.get('/wms/movements', async req => {
    const u = actorOf(req); requireView(u);
    const v = historyQuery.parse(req.query);
    if (isReturnSku(v.sku)) returnSkuDenied([v.sku]);
    const rows = (await db.query('SELECT * FROM wms_movements WHERE org_id=$1 AND lower(sku)=lower($2) ORDER BY created_at DESC, id DESC LIMIT $3', [u.org_id, v.sku, v.limit ?? 1000])).rows;
    return { sku: v.sku, movements: rows.map(movementOut(u, await peopleOf(u.org_id), await batchesOf(u.org_id, rows))) };
  });

  const itemInput = z.object({ sku, name: z.string().trim().min(1).max(200), type: z.string().trim().max(60).optional() }).strict();
  app.post('/wms/items', async (req, reply) => {
    const u = actorOf(req), v = itemInput.parse(req.body); requireManage(u);
    if (isReturnSku(v.sku)) returnSkuDenied([v.sku]);
    const row = await db.transaction(async tx => {
      if ((await tx.query('SELECT 1 FROM wms_items WHERE org_id=$1 AND lower(sku)=lower($2)', [u.org_id, v.sku])).rows.length) deny(409, 'WMS_SKU_EXISTS', 'This SKU already exists');
      const it = (await tx.query('INSERT INTO wms_items(org_id,sku,name,type,created_by) VALUES($1,$2,$3,$4,$5) RETURNING sku,name,type', [u.org_id, v.sku, v.name, v.type || '', u.id])).rows[0];
      await audit(tx, u, 'wms.item_created', v.sku, v);
      return it;
    });
    reply.code(201);
    return { ...row, qty: {} };
  });

  const moveInput = z.object({
    type: z.enum(['in', 'out', 'transfer', 'adjust']), sku, location: z.enum(LOC_IDS), toLocation: z.enum(LOC_IDS).optional(),
    qty: z.number().int().positive().max(1_000_000).optional(), counted: z.number().int().min(0).max(1_000_000).optional(),
    reason: z.string().trim().min(2).max(200), reference: z.string().trim().max(80).optional(), opDate: opDay.optional(),
  }).strict();
  const todayIso = () => new Date().toISOString().slice(0, 10);
  app.post('/wms/movements', async (req, reply) => {
    const u = actorOf(req), v = moveInput.parse(req.body); requireManage(u);
    if (v.opDate) checkOpDate(v.opDate);
    if (isReturnSku(v.sku)) returnSkuDenied([v.sku]);
    if (v.type === 'adjust' ? v.counted === undefined : v.qty === undefined) deny(400, 'WMS_QTY_REQUIRED', 'Enter the quantity');
    if (v.type === 'out' && !v.reference) deny(400, 'WMS_REFERENCE_REQUIRED', 'Goods out needs an order or reference number');
    if (v.type === 'transfer' && (!v.toLocation || v.toLocation === v.location)) deny(400, 'WMS_TRANSFER_TARGET', 'Choose a different destination location');
    const m = await db.transaction(async tx => {
      const it = await itemOf(tx, u.org_id, v.sku, u.id);
      const id = randomUUID();
      let qty = v.qty || 0, status = 'done', system: number | null = null;
      if (v.type === 'in') await addStock(tx, u.org_id, it.sku, v.location, qty);
      if (v.type === 'out') { await addStock(tx, u.org_id, it.sku, v.location, -qty); qty = -qty; }
      if (v.type === 'transfer') { await addStock(tx, u.org_id, it.sku, v.location, -qty); await addStock(tx, u.org_id, it.sku, v.toLocation!, qty); }
      if (v.type === 'adjust') {
        system = await stockOf(tx, u.org_id, it.sku, v.location);
        qty = v.counted! - system; status = 'pending';
        if (qty === 0) deny(400, 'WMS_NO_DIFFERENCE', 'The counted quantity matches the system; nothing to adjust');
      }
      await tx.query(`INSERT INTO wms_movements(id,org_id,type,sku,location,to_location,qty,counted,system_qty,reason,reference,status,created_by,op_date) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
        [id, u.org_id, v.type, it.sku, v.location, v.type === 'transfer' ? v.toLocation : null, qty, v.counted ?? null, system, v.reason, v.reference || null, status, u.id, v.opDate || todayIso()]);
      await audit(tx, u, 'wms.movement', id, { ...v, qty, status });
      return { id, status, qty };
    });
    reply.code(201);
    return m;
  });

  // Several SKUs in one go (a container, one order with many products, a count of a shelf): one location, date, reason
  // and reference, many lines; all or nothing. in/out/transfer take a quantity per line; adjust takes the counted
  // quantity and, like a single count, waits for the submitter's manager (each line is confirmed on its own).
  const batchInput = z.object({
    type: z.enum(['in', 'out', 'transfer', 'adjust']), location: z.enum(LOC_IDS), toLocation: z.enum(LOC_IDS).optional(), opDate: opDay,
    reason: z.string().trim().min(2).max(200), reference: z.string().trim().max(80).optional(),
    lines: z.array(z.object({ sku, qty: z.number().int().positive().max(1_000_000).optional(), counted: z.number().int().min(0).max(1_000_000).optional(),
      slot: z.number().int().min(1).max(3).optional() }).strict()).min(1).max(500),
  }).strict();
  app.post('/wms/movements/batch', async (req, reply) => {
    const u = actorOf(req), v = batchInput.parse(req.body); requireManage(u);
    checkOpDate(v.opDate);
    if (v.type === 'transfer' && (!v.toLocation || v.toLocation === v.location)) deny(400, 'WMS_TRANSFER_TARGET', 'Choose a different destination location');
    if (v.type === 'out' && !v.reference) deny(400, 'WMS_REFERENCE_REQUIRED', 'Goods out needs an order or reference number');
    const ref = v.lines.map(l => l.sku).filter(isReturnSku); if (ref.length) returnSkuDenied(ref);
    const adjust = v.type === 'adjust';
    if (v.lines.some(l => adjust ? l.counted === undefined : l.qty === undefined)) deny(400, 'WMS_QTY_REQUIRED', 'Enter the quantity');
    // Same SKU twice: quantities add up; a count lists each SKU once.
    // Same SKU twice (in the same bin): quantities add up; a count lists each SKU once.
    const merged = new Map<string, number>(), slots = new Map<string, number | undefined>();
    for (const l of v.lines) {
      const k = adjust ? l.sku.toLowerCase() : `${l.sku.toLowerCase()}|${l.slot || ''}`;
      if (adjust && merged.has(k)) deny(400, 'WMS_DUPLICATE_LINE', `${l.sku} is listed twice`, `${l.sku} 填了两次，盘点每个 SKU 只填一行。`);
      merged.set(k, adjust ? l.counted! : (merged.get(k) || 0) + l.qty!); slots.set(k, l.slot);
    }
    const skuOf = (k: string) => k.split('|')[0];
    const out = await db.transaction(async tx => {
      await adoptCatalogItems(tx, u.org_id, u.id, [...merged.keys()].map(skuOf));
      const items = (await tx.query('SELECT sku FROM wms_items WHERE org_id=$1', [u.org_id])).rows as { sku: string }[];
      const known = new Map(items.map(i => [i.sku.toLowerCase(), i.sku]));
      const missing = [...new Set([...merged.keys()].map(skuOf))].filter(k => !known.has(k));
      if (missing.length) deny(400, 'WMS_UNKNOWN_SKUS', `These SKUs do not exist yet: ${missing.slice(0, 10).join(', ')}`, `这些 SKU 还不存在，请先新增：${missing.slice(0, 10).join('、')}${missing.length > 10 ? ` 等 ${missing.length} 个` : ''}`);
      const batch = randomUUID(); let units = 0, lines = 0, same = 0;
      for (const [k, n] of merged) {
        const s2 = known.get(skuOf(k))!, id = randomUUID(), slot = slots.get(k);
        let qty = n, system: number | null = null, status = 'done';
        if (v.type === 'in') await addStock(tx, u.org_id, s2, v.location, n, { slot });
        else if (v.type === 'out') {
          const have = await stockOf(tx, u.org_id, s2, v.location, true);
          if (have < n) deny(409, 'WMS_NEGATIVE_STOCK', `Not enough stock of ${s2}: ${have} on hand, ${n} needed`, `${s2} 库存不足：现有 ${have} 件，要出 ${n} 件。`);
          await addStock(tx, u.org_id, s2, v.location, -n, { slot }); qty = -n;
        } else if (v.type === 'transfer') { await addStock(tx, u.org_id, s2, v.location, -n, { slot }); await addStock(tx, u.org_id, s2, v.toLocation!, n); }
        else { system = await stockOf(tx, u.org_id, s2, v.location); qty = n - system; status = 'pending'; if (qty === 0) { same++; continue; } }
        await tx.query(`INSERT INTO wms_movements(id,org_id,type,sku,location,to_location,qty,counted,system_qty,reason,reference,status,created_by,op_date) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
          [id, u.org_id, v.type, s2, v.location, v.type === 'transfer' ? v.toLocation : null, qty, adjust ? n : null, system, v.reason, v.reference || null, status, u.id, v.opDate]);
        units += Math.abs(qty); lines++;
      }
      if (!lines) deny(400, 'WMS_NO_DIFFERENCE', 'The counted quantity matches the system; nothing to adjust');
      await audit(tx, u, 'wms.batch', batch, { type: v.type, location: v.location, toLocation: v.toLocation, opDate: v.opDate, lines, units, unchanged: same, reference: v.reference });
      return { lines, units, unchanged: same, status: adjust ? 'pending' : 'done',
        ...(adjust ? { confirmers: await (async () => { const people = await peopleOf(u.org_id, tx); return confirmersOf(people, u.id).map(id => nameOf(people.get(id))); })() } : {}) };
    });
    reply.code(201);
    return out;
  });

  // Shelf bins (库位) of a SKU in one warehouse: a preferred bin and two alternates. Stock is kept per warehouse;
  // the bins say where on the shelves to find it (goods normally go to the preferred bin).
  const binInput = z.object({ sku, location: z.enum(LOC_IDS), bins: z.array(z.string().trim().max(40).regex(/^[^<>]*$/)).max(3) }).strict();
  app.post('/wms/bins', async req => {
    const u = actorOf(req), v = binInput.parse(req.body); requireManage(u);
    if (isReturnSku(v.sku)) returnSkuDenied([v.sku]);
    const [b1 = '', b2 = '', b3 = ''] = v.bins;
    if (!b1 && (b2 || b3)) deny(400, 'WMS_BIN_PRIMARY', 'Fill in the preferred bin first', '请先填首选库位。');
    return db.transaction(async tx => {
      const it = await itemOf(tx, u.org_id, v.sku, u.id);
      // Renaming a bin keeps its quantity; clearing a bin puts its quantity back to unassigned.
      await tx.query(`INSERT INTO wms_bins(org_id,sku,location,bin1,bin2,bin3,updated_by,updated_at) VALUES($1,$2,$3,$4,$5,$6,$7,now())
        ON CONFLICT(org_id,sku,location) DO UPDATE SET bin1=$4,bin2=$5,bin3=$6,updated_by=$7,updated_at=now(),
          qty1=CASE WHEN $4='' THEN 0 ELSE wms_bins.qty1 END,qty2=CASE WHEN $5='' THEN 0 ELSE wms_bins.qty2 END,qty3=CASE WHEN $6='' THEN 0 ELSE wms_bins.qty3 END`, [u.org_id, it.sku, v.location, b1, b2, b3, u.id]);
      for (const c of [b1, b2, b3].filter(Boolean)) await tx.query('INSERT INTO wms_bin_codes(org_id,location,code,created_by) VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING', [u.org_id, v.location, c, u.id]);
      await audit(tx, u, 'wms.bins', it.sku, { location: v.location, bins: [b1, b2, b3] });
      const q = (await tx.query('SELECT qty1,qty2,qty3 FROM wms_bins WHERE org_id=$1 AND sku=$2 AND location=$3', [u.org_id, it.sku, v.location])).rows[0];
      return { sku: it.sku, location: v.location, bins: [b1, b2, b3], qty: [q.qty1, q.qty2, q.qty3] };
    });
  });

  /* 库位管理 (owner, 2026-11-12): the list of shelf bins per warehouse. Bins a SKU already uses are adopted into the list;
     renaming a bin renames it for every SKU that uses it; a bin that still holds stock cannot be deleted (move the stock first). */
  const binCode = z.string().trim().min(1).max(40).regex(/^[^<>,，\n]*$/);
  const adoptBinCodes = (tx: Queryable, org: string) => tx.query(`INSERT INTO wms_bin_codes(org_id,location,code)
    SELECT DISTINCT org_id,location,c FROM wms_bins, LATERAL unnest(array[bin1,bin2,bin3]) AS c WHERE org_id=$1 AND c<>'' ON CONFLICT DO NOTHING`, [org]);
  app.get('/wms/bin-codes', async req => {
    const u = actorOf(req); if (warehouseLevelFor(u, o.isAdmin(u)) === 'none') deny(403, 'WMS_FORBIDDEN', 'You do not have access to inventory', '你没有库存管理的权限。');
    return db.transaction(async tx => {
      await adoptBinCodes(tx, u.org_id);
      const codes = (await tx.query('SELECT location,code,note FROM wms_bin_codes WHERE org_id=$1 ORDER BY location,code', [u.org_id])).rows;
      const use = new Map<string, { sku: string; slot: number; qty: number }[]>();
      for (const r of (await tx.query('SELECT sku,location,bin1,bin2,bin3,qty1,qty2,qty3 FROM wms_bins WHERE org_id=$1', [u.org_id])).rows)
        [r.bin1, r.bin2, r.bin3].forEach((c: string, i: number) => { if (!c) return; const k = r.location + '\u0000' + c; if (!use.has(k)) use.set(k, []); use.get(k)!.push({ sku: r.sku, slot: i + 1, qty: Number([r.qty1, r.qty2, r.qty3][i]) || 0 }); });
      return { codes: codes.map((c: any) => { const list = use.get(c.location + '\u0000' + c.code) || []; return { location: c.location, code: c.code, note: c.note, skus: list, qty: list.reduce((a, x) => a + x.qty, 0) }; }) };
    });
  });
  app.post('/wms/bin-codes', async (req, reply) => {
    const u = actorOf(req), v = z.object({ location: z.enum(LOC_IDS), codes: z.array(binCode).min(1).max(200), note: z.string().trim().max(120).default('') }).strict().parse(req.body); requireManage(u);
    const out = await db.transaction(async tx => {
      const added: string[] = [], existing: string[] = [];
      for (const code of [...new Set(v.codes)]) {
        const r = await tx.query('INSERT INTO wms_bin_codes(org_id,location,code,note,created_by) VALUES($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING RETURNING code', [u.org_id, v.location, code, v.note, u.id]);
        (r.rows.length ? added : existing).push(code);
      }
      if (added.length) await audit(tx, u, 'wms.bin_codes_added', v.location, { location: v.location, codes: added });
      return { added, existing };
    });
    reply.code(201); return out;
  });
  app.post('/wms/bin-codes/rename', async req => {
    const u = actorOf(req), v = z.object({ location: z.enum(LOC_IDS), code: binCode, to: binCode, note: z.string().trim().max(120).optional() }).strict().parse(req.body); requireManage(u);
    return db.transaction(async tx => {
      await adoptBinCodes(tx, u.org_id);
      const cur = (await tx.query('SELECT code FROM wms_bin_codes WHERE org_id=$1 AND location=$2 AND code=$3 FOR UPDATE', [u.org_id, v.location, v.code])).rows[0];
      if (!cur) deny(404, 'WMS_BIN_CODE_NOT_FOUND', 'This bin does not exist in this warehouse', '这个仓库没有这个库位。');
      if (v.to !== v.code) {
        if ((await tx.query('SELECT 1 FROM wms_bin_codes WHERE org_id=$1 AND location=$2 AND code=$3', [u.org_id, v.location, v.to])).rows.length)
          deny(409, 'WMS_BIN_CODE_EXISTS', `Bin ${v.to} already exists in this warehouse`, `这个仓库已经有库位 ${v.to}。`);
        await tx.query('UPDATE wms_bin_codes SET code=$4 WHERE org_id=$1 AND location=$2 AND code=$3', [u.org_id, v.location, v.code, v.to]);
        for (const c of ['bin1', 'bin2', 'bin3']) await tx.query(`UPDATE wms_bins SET ${c}=$4,updated_by=$5,updated_at=now() WHERE org_id=$1 AND location=$2 AND ${c}=$3`, [u.org_id, v.location, v.code, v.to, u.id]);
      }
      if (v.note !== undefined) await tx.query('UPDATE wms_bin_codes SET note=$4 WHERE org_id=$1 AND location=$2 AND code=$3', [u.org_id, v.location, v.to, v.note]);
      await audit(tx, u, 'wms.bin_code_renamed', v.location, { location: v.location, from: v.code, to: v.to, note: v.note });
      return { location: v.location, code: v.to };
    });
  });
  app.post('/wms/bin-codes/delete', async req => {
    const u = actorOf(req), v = z.object({ location: z.enum(LOC_IDS), code: binCode }).strict().parse(req.body); requireManage(u);
    return db.transaction(async tx => {
      await adoptBinCodes(tx, u.org_id);
      const held = (await tx.query(`SELECT sku FROM wms_bins WHERE org_id=$1 AND location=$2 AND ((bin1=$3 AND qty1>0) OR (bin2=$3 AND qty2>0) OR (bin3=$3 AND qty3>0)) ORDER BY sku`, [u.org_id, v.location, v.code])).rows.map((r: any) => r.sku);
      if (held.length) deny(409, 'WMS_BIN_CODE_HAS_STOCK', `Bin ${v.code} still holds stock (${held.slice(0, 5).join(', ')}); move it first`,
        `库位 ${v.code} 里还有货（${held.slice(0, 5).join('、')}），请先移库再删除。`);
      // Empty assignments are cleared; a cleared preferred bin takes the next bin up so the preferred slot stays filled.
      for (const c of ['bin1', 'bin2', 'bin3']) await tx.query(`UPDATE wms_bins SET ${c}='',updated_by=$4,updated_at=now() WHERE org_id=$1 AND location=$2 AND ${c}=$3`, [u.org_id, v.location, v.code, u.id]);
      await tx.query(`UPDATE wms_bins SET bin1=bin2,qty1=qty2,bin2=bin3,qty2=qty3,bin3='',qty3=0 WHERE org_id=$1 AND location=$2 AND bin1='' AND bin2<>''`, [u.org_id, v.location]);
      const r = await tx.query('DELETE FROM wms_bin_codes WHERE org_id=$1 AND location=$2 AND code=$3 RETURNING code', [u.org_id, v.location, v.code]);
      if (!r.rows.length) deny(404, 'WMS_BIN_CODE_NOT_FOUND', 'This bin does not exist in this warehouse', '这个仓库没有这个库位。');
      await audit(tx, u, 'wms.bin_code_deleted', v.location, { location: v.location, code: v.code });
      return { location: v.location, code: v.code, deleted: true };
    });
  });

  // Move stock between the bins of one warehouse (0 = unassigned). The warehouse total does not change; the move is logged.
  const moveInputB = z.object({ sku, location: z.enum(LOC_IDS), from: z.number().int().min(0).max(3), to: z.number().int().min(0).max(3), qty: z.number().int().positive().max(1_000_000), opDate: opDay.optional() }).strict();
  app.post('/wms/bins/move', async (req, reply) => {
    const u = actorOf(req), v = moveInputB.parse(req.body); requireManage(u);
    if (v.opDate) checkOpDate(v.opDate);
    if (v.from === v.to) deny(400, 'WMS_BIN_SAME', 'Choose two different bins', '请选择两个不同的库位。');
    const out = await db.transaction(async tx => {
      const it = await itemOf(tx, u.org_id, v.sku, u.id), total = await stockOf(tx, u.org_id, it.sku, v.location, true);
      const r = (await tx.query('SELECT bin1,bin2,bin3,qty1,qty2,qty3 FROM wms_bins WHERE org_id=$1 AND sku=$2 AND location=$3 FOR UPDATE', [u.org_id, it.sku, v.location])).rows[0];
      if (!r) deny(400, 'WMS_BIN_NOT_SET', `${it.sku} has no bins set in this warehouse yet`, `${it.sku} 在这个仓库还没有设置库位。`);
      const codes = [r.bin1, r.bin2, r.bin3], q = [r.qty1, r.qty2, r.qty3].map(Number), unassigned = total - sumQ(q);
      for (const sl of [v.from, v.to]) if (sl && !codes[sl - 1]) deny(400, 'WMS_BIN_NOT_SET', `${it.sku} has no bin ${sl} in this warehouse`, `${it.sku} 在这个仓库没有设置这个库位。`);
      const have = v.from ? q[v.from - 1] : unassigned;
      if (have < v.qty) deny(409, 'WMS_BIN_SHORT', `${it.sku}: only ${have} there`, `${it.sku}：这里只有 ${have} 件。`);
      if (v.from) q[v.from - 1] -= v.qty;
      if (v.to) q[v.to - 1] += v.qty;
      await tx.query('UPDATE wms_bins SET qty1=$4,qty2=$5,qty3=$6 WHERE org_id=$1 AND sku=$2 AND location=$3', [u.org_id, it.sku, v.location, ...q]);
      const name = (sl: number) => sl ? codes[sl - 1] : '未分库位', id = randomUUID();
      await tx.query(`INSERT INTO wms_movements(id,org_id,type,sku,location,to_location,qty,reason,status,created_by,op_date) VALUES($1,$2,'move',$3,$4,$4,$5,$6,'done',$7,$8)`,
        [id, u.org_id, it.sku, v.location, v.qty, `移库：${name(v.from)} → ${name(v.to)}`, u.id, v.opDate || todayIso()]);
      await audit(tx, u, 'wms.bin_move', id, v);
      return { sku: it.sku, location: v.location, bins: codes, qty: q };
    });
    reply.code(201);
    return out;
  });

  for (const decision of ['approve', 'reject'] as const) {
    app.post<{ Params: { id: string } }>(`/wms/movements/:id/${decision}`, async req => {
      const u = actorOf(req), mid = uid.parse(req.params.id); requireView(u);
      return db.transaction(async tx => {
        const m = (await tx.query('SELECT * FROM wms_movements WHERE id=$1 AND org_id=$2 FOR UPDATE', [mid, u.org_id])).rows[0];
        if (!m) deny(404, 'NOT_FOUND', 'Movement not found');
        if (m.status !== 'pending') deny(409, 'WMS_ALREADY_DECIDED', 'This adjustment has already been decided');
        const people = await peopleOf(u.org_id, tx);
        if (!canDecide(u, m, people)) deny(403, 'WMS_APPROVER_ONLY', `Only another warehouse manager can confirm this adjustment: ${confirmersOf(people, m.created_by).map(id => nameOf(people.get(id))).join(', ')}`,
          `盘点调整要由另一位有库存管理权限的同事确认：${confirmersOf(people, m.created_by).map(id => nameOf(people.get(id))).join('、')}。`);
        if (decision === 'approve') await addStock(tx, u.org_id, m.sku, m.location, Number(m.qty), { mode: 'count' });
        await tx.query('UPDATE wms_movements SET status=$2,decided_by=$3,decided_at=now() WHERE id=$1', [m.id, decision === 'approve' ? 'done' : 'rejected', u.id]);
        await audit(tx, u, 'wms.adjust_' + decision, m.id, { sku: m.sku, location: m.location, qty: m.qty });
        return { ok: true };
      });
    });
  }

  // Opening balances. Admin only: creates missing SKUs and sets each listed location to the
  // imported quantity, logging the difference as an applied adjustment so the ledger explains it.
  const importInput = z.object({
    asOf: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    rows: z.array(z.object({ sku, name: z.string().trim().max(200).optional(), type: z.string().trim().max(60).optional(),
      qty: z.object(Object.fromEntries(LOC_IDS.map(l => [l, z.number().int().min(0).max(1_000_000).optional()]))).strict() }).strict()).min(1).max(5000),
  }).strict();
  app.post('/wms/import', async req => {
    const u = actorOf(req);
    if (!o.isAdmin(u)) deny(403, 'WMS_IMPORT_ADMIN_ONLY', 'Only administrators can import opening stock');
    const v = importInput.parse(req.body);
    const seen = new Set<string>();
    const refRows = v.rows.map(r => r.sku).filter(isReturnSku); if (refRows.length) returnSkuDenied(refRows);
    for (const r of v.rows) { const k = r.sku.toLowerCase(); if (seen.has(k)) deny(400, 'WMS_DUPLICATE_SKU', `SKU ${r.sku} appears more than once in the file`); seen.add(k); }
    return db.transaction(async tx => {
      let created = 0, changed = 0;
      const reason = `期初导入（截至 ${v.asOf}）`;
      // Read the org's SKUs and stock once (stock locked) instead of once per row and location:
      // a 5000-row file used to cost tens of thousands of round trips inside one transaction.
      const known = new Map((await tx.query('SELECT sku,name,type FROM wms_items WHERE org_id=$1', [u.org_id])).rows.map((i: any) => [i.sku.toLowerCase(), i]));
      const key = (s: string, loc: string) => s + '\u0000' + loc;
      const stock = new Map((await tx.query('SELECT sku,location,qty FROM wms_stock WHERE org_id=$1 FOR UPDATE', [u.org_id])).rows.map((r: any) => [key(r.sku, r.location), Number(r.qty)]));
      for (const r of v.rows) {
        const existing = known.get(r.sku.toLowerCase());
        const s = existing?.sku || r.sku;
        if (!existing) { await tx.query('INSERT INTO wms_items(org_id,sku,name,type,created_by) VALUES($1,$2,$3,$4,$5)', [u.org_id, s, r.name || s, r.type || '', u.id]); created++; }
        else if ((r.name && r.name !== existing.name) || (r.type && r.type !== existing.type)) await tx.query('UPDATE wms_items SET name=COALESCE(NULLIF($3,\'\'),name),type=COALESCE(NULLIF($4,\'\'),type) WHERE org_id=$1 AND sku=$2', [u.org_id, s, r.name || '', r.type || '']);
        for (const [loc, target] of Object.entries(r.qty as Record<string, number | undefined>)) {
          if (target === undefined) continue;
          const have = stock.get(key(s, loc)) ?? 0, delta = target - have;
          if (!delta) continue;
          await tx.query('INSERT INTO wms_stock(org_id,sku,location,qty) VALUES($1,$2,$3,$4) ON CONFLICT(org_id,sku,location) DO UPDATE SET qty=$4', [u.org_id, s, loc, target]);
          stock.set(key(s, loc), target); changed++;
          await binsAfterChange(tx, u.org_id, s, loc, delta, target, { mode: 'count' });
          await tx.query(`INSERT INTO wms_movements(id,org_id,type,sku,location,qty,counted,system_qty,reason,reference,status,created_by,decided_by,decided_at) VALUES($1,$2,'adjust',$3,$4,$5,$6,$7,$8,'IMPORT','done',$9,$9,now())`,
            [randomUUID(), u.org_id, s, loc, delta, target, have, reason, u.id]);
          await tx.query('UPDATE wms_movements SET op_date=$2 WHERE id=(SELECT id FROM wms_movements WHERE org_id=$1 AND sku=$3 AND location=$4 AND reference=\'IMPORT\' ORDER BY created_at DESC LIMIT 1)', [u.org_id, v.asOf, s, loc]);
        }
      }
      const importId = randomUUID();
      await tx.query('INSERT INTO wms_imports(id,org_id,as_of,rows,created_by) VALUES($1,$2,$3,$4,$5)', [importId, u.org_id, v.asOf, v.rows.length, u.id]);
      await audit(tx, u, 'wms.import', importId, { asOf: v.asOf, rows: v.rows.length, created, changed });
      return { rows: v.rows.length, created, changed };
    });
  });

  /* ---------- ERP permissions ---------- */
  app.get('/erp/access', async req => {
    const u = actorOf(req), admin = o.isAdmin(u), manager = (u as any).role === 'manager';
    if (!admin && !manager) deny(403, 'FORBIDDEN', 'Administrator access is required');
    const mine = await reportsOf(db, u.org_id, u.id);
    const rows = (await db.query('SELECT id,display_name,name_zh,name_en,title,location,grants FROM users WHERE org_id=$1 AND active=true ORDER BY display_name,id', [u.org_id])).rows
      .filter((p: any) => admin || mine.has(p.id));
    return {
      canAdmin: admin, canWarehouse: admin || manager, canReturns: admin || manager,
      people: rows.map((p: any) => ({ id: p.id, name: nameOf(p), title: p.title || '', location: p.location || '', reportsToMe: mine.has(p.id), access: accessOf(grantsOf(p)) })),
    };
  });

  const accessInput = z.object({ userId: uid, area: z.enum(['products', 'pricing', 'supply', 'warehouse', 'returns', 'dealers']), level: z.string().min(1).max(20) }).strict();
  app.post('/erp/access', async req => {
    const u = actorOf(req), v = accessInput.parse(req.body), admin = o.isAdmin(u);
    if (!(v.level in AREAS[v.area])) deny(400, 'INVALID_ACCESS_LEVEL', 'Choose a valid access level');
    return db.transaction(async tx => {
      const p = (await tx.query('SELECT id,grants FROM users WHERE id=$1 AND org_id=$2 AND active=true FOR UPDATE', [v.userId, u.org_id])).rows[0];
      if (!p) deny(404, 'NOT_FOUND', 'Member not found');
      if (!admin) {
        if (!['warehouse', 'returns'].includes(v.area) || (u as any).role !== 'manager' || !(await reportsOf(tx, u.org_id, u.id)).has(p.id))
          deny(403, 'ERP_ACCESS_FORBIDDEN', 'Managers can only set warehouse and returns access for their own reports', '主管只能给自己的下属设置仓库库存和退货维修权限。');
      }
      const before = grantsOf(p);
      let next = [...before.filter(g => !areaGrants(v.area).includes(g)), ...AREAS[v.area][v.level]];
      // Pricing lives inside the product library: any price access brings product access, and removing product access removes price access.
      if (v.area === 'pricing' && v.level !== 'none' && !next.includes('products')) next.push('products');
      if (v.area === 'products' && v.level === 'none') next = next.filter(g => !areaGrants('pricing').includes(g));
      next = [...new Set(next)];
      await tx.query('UPDATE users SET grants=$2 WHERE id=$1', [p.id, JSON.stringify(next)]);
      await tx.query('INSERT INTO audit_events(id,org_id,department_id,owner_id,actor_id,action,object_id,details) VALUES($1,$2,$3,$4,$5,$6,$7,$8)',
        [randomUUID(), u.org_id, u.department_id, p.id, u.id, 'erp.access_changed', p.id, JSON.stringify({ area: v.area, from: levelOf(before, v.area), to: v.level })]);
      return { userId: p.id, access: accessOf(next) };
    });
  });
}
