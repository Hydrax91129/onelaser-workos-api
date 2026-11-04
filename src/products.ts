/* Product catalog and price build-up data.
 *
 * Two tables, imported from CSV files on the Product catalog and Cost calculator pages:
 *   product_catalog  what everyone with product access may see (name, line, status, weight,
 *                    package size, lead time, retail prices, best shipping method)
 *   product_pricing  factory price and freight inputs, only for people with the full price
 *                    build-up (grant product_cost_detail) and company admins
 * No product or cost data lives in this repository; it is imported at runtime. */
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { Database, Queryable } from './db.js';
import type { User } from './auth.js';
import { deny } from './errors.js';

export const productSchema = `
CREATE TABLE IF NOT EXISTS product_catalog(org_id text NOT NULL, sku text NOT NULL, name_zh text NOT NULL DEFAULT '', name_en text NOT NULL DEFAULT '',
  type text NOT NULL DEFAULT '', status text NOT NULL DEFAULT '', gross numeric, dims jsonb, lead text NOT NULL DEFAULT '', msrp numeric, low numeric,
  ship_fee numeric, best text NOT NULL DEFAULT '', note text NOT NULL DEFAULT '', updated_by text, updated_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(org_id,sku));
CREATE TABLE IF NOT EXISTS product_pricing(org_id text NOT NULL, sku text NOT NULL, factory_rmb numeric, factory_usd numeric, extra_rmb numeric,
  ddp_rate numeric, last_mile_rmb numeric, updated_by text, updated_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(org_id,sku));
ALTER TABLE product_pricing ADD COLUMN IF NOT EXISTS price_class text;
ALTER TABLE product_pricing ADD COLUMN IF NOT EXISTS landed_usd numeric;
ALTER TABLE product_pricing ADD COLUMN IF NOT EXISTS last_mile_usd numeric;
ALTER TABLE product_pricing ADD COLUMN IF NOT EXISTS actual_price numeric;
CREATE TABLE IF NOT EXISTS pricing_rules(org_id text PRIMARY KEY, rules jsonb NOT NULL, updated_by text, updated_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE IF NOT EXISTS product_imports(id text PRIMARY KEY, org_id text NOT NULL, kind text NOT NULL, rows integer NOT NULL, created_by text NOT NULL, created_at timestamptz NOT NULL DEFAULT now());
ALTER TABLE product_catalog ADD COLUMN IF NOT EXISTS moq integer;
CREATE TABLE IF NOT EXISTS product_changes(id text PRIMARY KEY, org_id text NOT NULL, sku text NOT NULL, field text NOT NULL, old_value jsonb, new_value jsonb,
  note text NOT NULL DEFAULT '', source text NOT NULL DEFAULT 'edit', actor_id text NOT NULL, created_at timestamptz NOT NULL DEFAULT now());
CREATE INDEX IF NOT EXISTS product_changes_sku ON product_changes(org_id,sku,created_at);
CREATE TABLE IF NOT EXISTS product_channel_prices(org_id text NOT NULL, sku text NOT NULL, channel text NOT NULL, price numeric, listed boolean NOT NULL DEFAULT true,
  updated_by text, updated_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(org_id,sku,channel));
CREATE TABLE IF NOT EXISTS product_price_changes(id text PRIMARY KEY, org_id text NOT NULL, sku text NOT NULL, target text NOT NULL, old_price numeric, new_price numeric,
  cm_pct numeric, needs text, status text NOT NULL, reason text NOT NULL DEFAULT '', requested_by text NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
  decided_by text, decided_at timestamptz, decision_note text NOT NULL DEFAULT '');
CREATE INDEX IF NOT EXISTS product_price_changes_sku ON product_price_changes(org_id,sku,created_at);
`;

/* Company pricing rules (KC, Nov 2026). Every price is backed out from cost:
 *   price = (delivered cost − shipping the customer pays separately) ÷ (1 − selling rate − target contribution margin)
 * Retail selling rate 17%, wholesale 7%, Amazon/eBay +10%. MSRP targets by product class, promotion tiers,
 * and wholesale discounts off MSRP with the dealer paying freight (Option 2). */
export const PRICE_CLASSES = ['standard', 'rd', 'accessory'] as const;
export const DEFAULT_PRICING_RULES = {
  retail: [
    { key: 'ads', zh: '广告', en: 'Advertising', pct: 5 }, { key: 'txn', zh: '交易费', en: 'Transaction fees', pct: 3 },
    { key: 'kol', zh: 'KOL', en: 'KOL', pct: 1.5 }, { key: 'brand', zh: '品牌', en: 'Brand & PR', pct: 1.5 },
    { key: 'commission', zh: '线下提成', en: 'Sales commission', pct: 1 }, { key: 'rma', zh: '退换货及保修售后', en: 'Returns & warranty', pct: 2.5 },
    { key: 'mgmt', zh: '管理费', en: 'Management fee', pct: 2.5 },
  ],
  wholesalePct: 7,
  platformExtraPct: 10,
  classes: { standard: 30, rd: 40, accessory: 50 },
  tiers: { everyday: [25, 30], small: [20, 25], major: [15, 20], clearance: [10, 15] },
  floorPct: 15,
  majorPerYear: 2,
  wholesale: { base: 25, large: 30, over50k: 2, over100k: 5 },
};
const pctN = z.number().min(0).max(100);
const range = z.tuple([pctN, pctN]).refine(([a, b]) => a <= b, 'The low end of a range must not exceed the high end');
export const pricingRulesSchema = z.object({
  retail: z.array(z.object({ key: z.string().trim().min(1).max(40), zh: z.string().trim().min(1).max(40), en: z.string().trim().min(1).max(60), pct: pctN }).strict()).min(1).max(20),
  wholesalePct: pctN, platformExtraPct: pctN,
  classes: z.object({ standard: pctN, rd: pctN, accessory: pctN }).strict(),
  tiers: z.object({ everyday: range, small: range, major: range, clearance: range }).strict(),
  floorPct: pctN, majorPerYear: z.number().int().min(0).max(12),
  wholesale: z.object({ base: pctN, large: pctN, over50k: pctN, over100k: pctN }).strict(),
}).strict();

export const PRODUCT_STATUSES = ['dev', 'launch', 'live', 'clearance', 'eolPlanned', 'eol'] as const;
/* Lifecycle: which status may follow which. An unlabeled product (imported without a status) may take any.
 * Company admins may move a product anywhere; moving into clearance or out of sale always needs a reason. */
export const STATUS_NEXT: Record<string, readonly string[]> = {
  '': PRODUCT_STATUSES, dev: ['launch', 'eol'], launch: ['live', 'dev', 'eol'], live: ['clearance', 'eolPlanned'],
  clearance: ['live', 'eolPlanned', 'eol'], eolPlanned: ['live', 'clearance', 'eol'], eol: [],
};
const STATUS_NEEDS_NOTE = new Set(['clearance', 'eolPlanned', 'eol']);

/* Price changes. Every change to MSRP, the actual selling price or a channel price is kept with who, when, why and
 * the contribution margin it leaves. A price whose margin falls below the rules' floor (or below cost, or a dealer
 * price deeper than the largest wholesale discount) waits for a company admin to approve before it takes effect.
 * Without a landed cost the margin is unknown, so the change applies and is recorded as unchecked. */
export const CHANNELS = ['shopify', 'amazon', 'ebay', 'dealer'] as const;
export const PRICE_TARGETS = ['msrp', 'actual', ...CHANNELS] as const;
/** Besides PRICE_TARGETS the product library records MAP ('map'), the promotion floor ('promo_floor') and per-tier
 *  wholesale overrides ('wh0', 'wh1', …) as channel prices of the same SKU. */
export type PriceTarget = typeof PRICE_TARGETS[number] | 'map' | 'promo_floor' | `wh${number}`;
const isWholesale = (t: string) => t === 'dealer' || /^wh\d+$/.test(t);
export function priceCheck(rules: typeof DEFAULT_PRICING_RULES, cat: any, pr: any, target: PriceTarget, price: number | null) {
  const landed = pr?.landed_usd == null ? null : Number(pr.landed_usd);
  if (price == null || price <= 0) return { cmPct: null as number | null, needs: null as string | null };
  const round = (n: number) => Math.round(n * 10) / 10;
  if (isWholesale(target)) {
    const cm = landed == null ? null : round((price * (1 - rules.wholesalePct / 100) - landed) / price * 100);
    const msrp = cat?.msrp == null ? null : Number(cat.msrp), deepest = rules.wholesale.large + rules.wholesale.over100k;
    return { cmPct: cm, needs: cm != null && cm < 0 ? 'loss' : msrp && price < msrp * (1 - deepest / 100) - 0.005 ? 'dealer_discount' : null };
  }
  if (landed == null) return { cmPct: null, needs: null };
  const rate = rules.retail.reduce((n, r) => n + (Number(r.pct) || 0), 0) / 100 + (target === 'amazon' || target === 'ebay' ? rules.platformExtraPct / 100 : 0);
  const delivered = landed + (pr?.last_mile_usd == null ? 0 : Number(pr.last_mile_usd)), ship = cat?.ship_fee == null ? 0 : Number(cat.ship_fee);
  const cm = round((price * (1 - rate) + ship - delivered) / price * 100);
  return { cmPct: cm, needs: cm < 0 ? 'loss' : cm < rules.floorPct ? 'floor' : null };
}
const sku = z.string().trim().min(1).max(80).regex(/^[A-Za-z0-9][A-Za-z0-9._\-/ ]*$/, 'Use letters, digits, dot, dash, slash or underscore in the SKU');
const num = z.number().min(0).max(10_000_000).nullable().optional();
const text = (max: number) => z.string().trim().max(max).optional();
const num_ = (v: any) => v == null ? null : Number(v);

export async function registerProductRoutes(app: FastifyInstance, db: Database, o: { isAdmin: (u: User) => boolean }) {
  const actorOf = (req: FastifyRequest): User => req.actor || deny(401, 'UNAUTHENTICATED', 'Authentication is required');
  const grants = (u: User): string[] => Array.isArray((u as any).grants) ? (u as any).grants : [];
  const canView = (u: User) => o.isAdmin(u) || grants(u).includes('products');
  const canEditCatalog = (u: User) => o.isAdmin(u) || grants(u).includes('products_manage');
  const canPricing = (u: User) => o.isAdmin(u) || grants(u).includes('product_cost_detail');
  const audit = (tx: Queryable, u: User, action: string, objectId: string, details: unknown) =>
    tx.query('INSERT INTO audit_events(id,org_id,department_id,owner_id,actor_id,action,object_id,details) VALUES($1,$2,$3,$4,$5,$6,$7,$8)',
      [randomUUID(), u.org_id, u.department_id, u.id, u.id, action, objectId, JSON.stringify(details)]);
  const lastImport = async (org: string, kind: string) => {
    const r = (await db.query('SELECT created_at,rows FROM product_imports WHERE org_id=$1 AND kind=$2 ORDER BY created_at DESC LIMIT 1', [org, kind])).rows[0];
    return r ? { at: r.created_at, rows: r.rows } : null;
  };

  // MSRP, low price and checkout shipping: catalog managers and anyone with a pricing grant. Channel prices: seen with any pricing grant, set with the full build-up.
  const canEditMsrp = (u: User) => canEditCatalog(u) || grants(u).includes('pricing_msrp') || canPricing(u);
  const canSeeChannels = (u: User) => canPricing(u) || grants(u).includes('pricing_msrp');
  const canSeeTarget = (u: User, target: string) => target === 'msrp' || canSeeChannels(u);
  const rulesFor = async (org: string, q: Queryable = db) => {
    const r = (await q.query('SELECT rules,updated_at,updated_by FROM pricing_rules WHERE org_id=$1', [org])).rows[0];
    return r?.rules ? { ...r.rules, updatedAt: r.updated_at, updatedBy: r.updated_by } : { ...DEFAULT_PRICING_RULES, updatedAt: null, updatedBy: null };
  };
  const catalogOf = async (q: Queryable, org: string, raw: string, lock = false) => {
    const r = (await q.query('SELECT * FROM product_catalog WHERE org_id=$1 AND lower(sku)=lower($2)' + (lock ? ' FOR UPDATE' : ''), [org, raw])).rows[0];
    return r || deny(404, 'PRODUCT_NOT_FOUND', 'This SKU is not in the product catalog');
  };
  const skuParam = (req: FastifyRequest) => String((req.params as any).sku || '');

  /* Field-level change log. Values are normalised so a numeric string from the database equals the number sent. */
  const NUM_COLS = new Set(['gross', 'msrp', 'low', 'ship_fee', 'moq']);
  const norm = (col: string, v: any) => col === 'dims' ? (Array.isArray(v) ? v.map(Number) : null) : NUM_COLS.has(col) ? (v == null ? null : Number(v)) : String(v ?? '');
  const same = (a: any, b: any) => JSON.stringify(a) === JSON.stringify(b);
  const logChanges = async (tx: Queryable, u: User, s: string, before: any, after: Record<string, any>, source: string, note = '') => {
    const changed: string[] = [];
    for (const [col, val] of Object.entries(after)) {
      const from = before ? norm(col, before[col]) : null, to = norm(col, val);
      if (before && same(from, to)) continue;
      if (!before && (to == null || to === '')) continue;
      await tx.query('INSERT INTO product_changes(id,org_id,sku,field,old_value,new_value,note,source,actor_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)',
        [randomUUID(), u.org_id, s, col, JSON.stringify(from), JSON.stringify(to), note, source, u.id]);
      changed.push(col);
    }
    return changed;
  };

  const currentPrice = async (tx: Queryable, org: string, s: string, target: PriceTarget) => {
    const q = target === 'msrp' ? ['SELECT msrp AS p FROM product_catalog WHERE org_id=$1 AND sku=$2', [org, s]]
      : target === 'actual' ? ['SELECT actual_price AS p FROM product_pricing WHERE org_id=$1 AND sku=$2', [org, s]]
      : ['SELECT price AS p FROM product_channel_prices WHERE org_id=$1 AND sku=$2 AND channel=$3', [org, s, target]];
    return num_((await tx.query(q[0] as string, q[1] as any[])).rows[0]?.p);
  };
  const applyPrice = async (tx: Queryable, u: User, s: string, target: PriceTarget, price: number | null) => {
    if (target === 'msrp') await tx.query('UPDATE product_catalog SET msrp=$3,updated_by=$4,updated_at=now() WHERE org_id=$1 AND sku=$2', [u.org_id, s, price, u.id]);
    else if (target === 'actual') await tx.query(`INSERT INTO product_pricing(org_id,sku,actual_price,updated_by,updated_at) VALUES($1,$2,$3,$4,now())
      ON CONFLICT(org_id,sku) DO UPDATE SET actual_price=$3,updated_by=$4,updated_at=now()`, [u.org_id, s, price, u.id]);
    else await tx.query(`INSERT INTO product_channel_prices(org_id,sku,channel,price,updated_by,updated_at) VALUES($1,$2,$3,$4,$5,now())
      ON CONFLICT(org_id,sku,channel) DO UPDATE SET price=$4,updated_by=$5,updated_at=now()`, [u.org_id, s, target, price, u.id]);
  };
  /** Records a price change and applies it, or holds it for an admin when it breaks the rules. Runs inside the caller's transaction. */
  const requestPrice = async (tx: Queryable, u: User, s: string, target: PriceTarget, price: number | null, reason = '') => {
    const old = await currentPrice(tx, u.org_id, s, target);
    if (old === price) return { status: 'unchanged' as const };
    const cat = (await tx.query('SELECT * FROM product_catalog WHERE org_id=$1 AND sku=$2', [u.org_id, s])).rows[0];
    const pr = (await tx.query('SELECT * FROM product_pricing WHERE org_id=$1 AND sku=$2', [u.org_id, s])).rows[0];
    const chk = priceCheck(await rulesFor(u.org_id, tx), cat, pr, target, price);
    const hold = !!chk.needs && !o.isAdmin(u), id = randomUUID();
    // A newer request replaces an older one still waiting for the same price.
    await tx.query(`UPDATE product_price_changes SET status='superseded',decided_at=now() WHERE org_id=$1 AND sku=$2 AND target=$3 AND status='pending'`, [u.org_id, s, target]);
    await tx.query(`INSERT INTO product_price_changes(id,org_id,sku,target,old_price,new_price,cm_pct,needs,status,reason,requested_by,decided_by,decided_at)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
      [id, u.org_id, s, target, old, price, chk.cmPct, chk.needs, hold ? 'pending' : 'applied', reason, u.id, hold ? null : (chk.needs ? u.id : null), hold ? null : (chk.needs ? new Date().toISOString() : null)]);
    if (!hold) await applyPrice(tx, u, s, target, price);
    await audit(tx, u, hold ? 'products.price_requested' : 'products.price_changed', s, { target, from: old, to: price, cmPct: chk.cmPct, needs: chk.needs });
    return { status: hold ? 'pending' as const : 'applied' as const, id, needs: chk.needs, ...(canPricing(u) ? { cmPct: chk.cmPct } : {}) };
  };

  app.get('/products', async req => {
    const u = actorOf(req);
    if (!canView(u)) deny(403, 'PRODUCTS_FORBIDDEN', 'You do not have access to the product area');
    const rows = (await db.query('SELECT * FROM product_catalog WHERE org_id=$1 ORDER BY type,sku', [u.org_id])).rows;
    const pricing = canPricing(u) ? new Map((await db.query('SELECT * FROM product_pricing WHERE org_id=$1', [u.org_id])).rows.map((r: any) => [r.sku, r])) : new Map();
    const channels = new Map<string, Record<string, any>>();
    if (canSeeChannels(u)) for (const r of (await db.query('SELECT * FROM product_channel_prices WHERE org_id=$1', [u.org_id])).rows) (channels.get(r.sku) || channels.set(r.sku, {}).get(r.sku)!)[r.channel] = { price: num_(r.price), listed: r.listed };
    const pending = new Map<string, any[]>();
    for (const r of (await db.query(`SELECT id,sku,target,new_price FROM product_price_changes WHERE org_id=$1 AND status='pending' ORDER BY created_at`, [u.org_id])).rows)
      if (canSeeTarget(u, r.target)) (pending.get(r.sku) || pending.set(r.sku, []).get(r.sku)!).push({ id: r.id, target: r.target, price: num_(r.new_price) });
    return {
      items: rows.map((r: any) => {
        const p: any = pricing.get(r.sku);
        return {
          sku: r.sku, name: { zh: r.name_zh || r.name_en || r.sku, en: r.name_en || r.name_zh || r.sku }, nameZh: r.name_zh, nameEn: r.name_en, type: r.type, status: r.status,
          gross: num_(r.gross), dims: Array.isArray(r.dims) ? r.dims.map(num_) : null, lead: r.lead, moq: num_(r.moq), msrp: num_(r.msrp), low: num_(r.low), shipFee: num_(r.ship_fee),
          best: r.best, note: r.note, updatedAt: r.updated_at,
          ...(p ? { factoryRmb: num_(p.factory_rmb), factoryUsd: num_(p.factory_usd), extraRmb: num_(p.extra_rmb), ddpRate: num_(p.ddp_rate), lastMileRmb: num_(p.last_mile_rmb),
            priceClass: p.price_class || null, landedUsd: num_(p.landed_usd), lastMileUsd: num_(p.last_mile_usd), actualPrice: num_(p.actual_price) } : {}),
          ...(canSeeChannels(u) ? { channels: channels.get(r.sku) || {} } : {}),
          ...(pending.get(r.sku) ? { pendingPrices: pending.get(r.sku) } : {}),
        };
      }),
      canImportCatalog: canEditCatalog(u), canImportPricing: canPricing(u), canSeePricing: canPricing(u),
      canEditCatalog: canEditCatalog(u), canEditMsrp: canEditMsrp(u), canSeeChannels: canSeeChannels(u), canEditChannels: canPricing(u), canApprovePrices: o.isAdmin(u),
      statusNext: STATUS_NEXT, channelKeys: CHANNELS,
      ...(canPricing(u) ? { pricingRules: await rulesFor(u.org_id), canEditRules: o.isAdmin(u) } : {}),
      lastCatalogImport: await lastImport(u.org_id, 'catalog'), lastPricingImport: canPricing(u) ? await lastImport(u.org_id, 'pricing') : null,
    };
  });

  const editable = {
    nameZh: z.string().trim().max(200), nameEn: z.string().trim().max(200), type: z.string().trim().max(60),
    gross: num, dims: z.array(z.number().min(0).max(10_000)).length(3).nullable(), lead: z.string().trim().max(60), moq: z.number().int().min(0).max(1_000_000).nullable(),
    low: num, shipFee: num, best: z.string().trim().max(80), note: z.string().trim().max(500),
  };
  const COLS: Record<string, string> = { nameZh: 'name_zh', nameEn: 'name_en', type: 'type', gross: 'gross', dims: 'dims', lead: 'lead', moq: 'moq', low: 'low', shipFee: 'ship_fee', best: 'best', note: 'note' };
  const PRICE_FIELDS = new Set(['low', 'shipFee']);
  const writeCatalog = (tx: Queryable, org: string, s: string, next: any, actor: string) => tx.query(`INSERT INTO product_catalog(org_id,sku,name_zh,name_en,type,status,gross,dims,lead,moq,low,ship_fee,best,note,updated_by,updated_at)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,now())
    ON CONFLICT(org_id,sku) DO UPDATE SET name_zh=$3,name_en=$4,type=$5,status=$6,gross=$7,dims=$8,lead=$9,moq=$10,low=$11,ship_fee=$12,best=$13,note=$14,updated_by=$15,updated_at=now()`,
    [org, s, next.name_zh ?? '', next.name_en ?? '', next.type ?? '', next.status ?? '', next.gross ?? null, next.dims == null ? null : JSON.stringify(next.dims.map(Number)), next.lead ?? '', next.moq ?? null,
      next.low ?? null, next.ship_fee ?? null, next.best ?? '', next.note ?? '', actor]);
  const checkFields = (u: User, body: Record<string, unknown>) => {
    const keys = Object.keys(body).filter(k => k !== 'sku' && k !== 'reason');
    if (keys.some(k => (k === 'msrp' || PRICE_FIELDS.has(k)) && body[k] !== undefined) && !canEditMsrp(u)) deny(403, 'MSRP_EDIT_FORBIDDEN', 'You cannot change retail prices');
    if (keys.some(k => k !== 'msrp' && !PRICE_FIELDS.has(k) && body[k] !== undefined) && !canEditCatalog(u)) deny(403, 'CATALOG_EDIT_FORBIDDEN', 'Only product managers or administrators can edit product details');
  };

  // A new product starts in development; its first MSRP is recorded in the price history.
  app.post('/products', async (req, reply) => {
    const u = actorOf(req);
    const v = z.object({ sku, ...Object.fromEntries(Object.entries(editable).map(([k, s]) => [k, s.optional()])), msrp: num }).strict().parse(req.body) as any;
    if (!canEditCatalog(u)) deny(403, 'CATALOG_EDIT_FORBIDDEN', 'Only product managers or administrators can add products');
    if (v.msrp != null && !canEditMsrp(u)) deny(403, 'MSRP_EDIT_FORBIDDEN', 'You cannot change retail prices');
    const out = await db.transaction(async tx => {
      if ((await tx.query('SELECT 1 FROM product_catalog WHERE org_id=$1 AND lower(sku)=lower($2)', [u.org_id, v.sku])).rows.length) deny(409, 'PRODUCT_EXISTS', 'A product with this SKU already exists');
      const next: any = { status: 'dev' };
      for (const [k, col] of Object.entries(COLS)) if (v[k] !== undefined) next[col] = v[k];
      await writeCatalog(tx, u.org_id, v.sku, next, u.id);
      await logChanges(tx, u, v.sku, null, { ...next }, 'create');
      const price = v.msrp != null ? await requestPrice(tx, u, v.sku, 'msrp', v.msrp, '') : null;
      await audit(tx, u, 'products.created', v.sku, v);
      return { sku: v.sku, status: 'dev', ...(price ? { msrpChange: price } : {}) };
    });
    return reply.code(201).send(out);
  });

  app.patch('/products/:sku', async req => {
    const u = actorOf(req);
    const v = z.object({ ...Object.fromEntries(Object.entries(editable).map(([k, s]) => [k, s.optional()])), msrp: num, reason: z.string().trim().max(300).optional() }).strict().parse(req.body) as any;
    checkFields(u, v);
    return db.transaction(async tx => {
      const cur = await catalogOf(tx, u.org_id, skuParam(req), true);
      const next: any = { ...cur }, after: Record<string, any> = {};
      for (const [k, col] of Object.entries(COLS)) if (v[k] !== undefined) { next[col] = v[k]; after[col] = v[k]; }
      const changed = await logChanges(tx, u, cur.sku, cur, after, 'edit', v.reason || '');
      if (changed.length) await writeCatalog(tx, u.org_id, cur.sku, next, u.id);
      const msrpChange = v.msrp !== undefined ? await requestPrice(tx, u, cur.sku, 'msrp', v.msrp, v.reason || '') : null;
      if (changed.length) await audit(tx, u, 'products.edited', cur.sku, { fields: changed });
      return { sku: cur.sku, changed, ...(msrpChange ? { msrpChange } : {}) };
    });
  });

  app.post('/products/:sku/status', async req => {
    const u = actorOf(req);
    if (!canEditCatalog(u)) deny(403, 'CATALOG_EDIT_FORBIDDEN', 'Only product managers or administrators can change the product status');
    const v = z.object({ status: z.enum(PRODUCT_STATUSES), note: z.string().trim().max(300).default('') }).strict().parse(req.body);
    return db.transaction(async tx => {
      const cur = await catalogOf(tx, u.org_id, skuParam(req), true), from = cur.status || '';
      if (from === v.status) return { sku: cur.sku, status: from, changed: false };
      if (!o.isAdmin(u) && !(STATUS_NEXT[from] || PRODUCT_STATUSES).includes(v.status)) deny(409, 'STATUS_TRANSITION', `A product cannot move from ${from || 'unlabeled'} to ${v.status}`, `产品状态不能从 ${from || '未标注'} 直接改为 ${v.status}`);
      if (STATUS_NEEDS_NOTE.has(v.status) && !v.note) deny(400, 'STATUS_NOTE_REQUIRED', 'Give a reason for moving the product into clearance or out of sale');
      await tx.query('UPDATE product_catalog SET status=$3,updated_by=$4,updated_at=now() WHERE org_id=$1 AND sku=$2', [u.org_id, cur.sku, v.status, u.id]);
      await logChanges(tx, u, cur.sku, cur, { status: v.status }, 'status', v.note);
      await audit(tx, u, 'products.status', cur.sku, { from, to: v.status, note: v.note });
      return { sku: cur.sku, status: v.status, changed: true };
    });
  });

  const nameSql = `(SELECT COALESCE(NULLIF(display_name,''),NULLIF(name_zh,''),NULLIF(name_en,''),id) FROM users WHERE id=%s)`;
  const priceOut = (u: User, r: any) => ({
    id: r.id, sku: r.sku, target: r.target, from: num_(r.old_price), to: num_(r.new_price), needs: r.needs, status: r.status, reason: r.reason,
    ...(canPricing(u) ? { cmPct: num_(r.cm_pct) } : {}), requestedBy: { id: r.requested_by, name: r.requested_name }, at: r.created_at,
    decidedBy: r.decided_by ? { id: r.decided_by, name: r.decided_name } : null, decidedAt: r.decided_at, decisionNote: r.decision_note,
    ...(r.name_zh !== undefined ? { name: { zh: r.name_zh || r.sku, en: r.name_en || r.name_zh || r.sku } } : {}),
  });
  app.get('/products/:sku/history', async req => {
    const u = actorOf(req);
    if (!canView(u)) deny(403, 'PRODUCTS_FORBIDDEN', 'You do not have access to the product area');
    const cur = await catalogOf(db, u.org_id, skuParam(req));
    const changes = (await db.query(`SELECT c.*, ${nameSql.replace('%s', 'c.actor_id')} AS actor_name FROM product_changes c WHERE c.org_id=$1 AND c.sku=$2 ORDER BY c.created_at DESC LIMIT 200`, [u.org_id, cur.sku])).rows;
    const prices = (await db.query(`SELECT p.*, ${nameSql.replace('%s', 'p.requested_by')} AS requested_name, ${nameSql.replace('%s', 'p.decided_by')} AS decided_name
      FROM product_price_changes p WHERE p.org_id=$1 AND p.sku=$2 ORDER BY p.created_at DESC LIMIT 200`, [u.org_id, cur.sku])).rows;
    return {
      sku: cur.sku,
      changes: changes.map((c: any) => ({ id: c.id, field: c.field, from: c.old_value, to: c.new_value, note: c.note, source: c.source, actor: { id: c.actor_id, name: c.actor_name }, at: c.created_at })),
      prices: prices.filter((p: any) => canSeeTarget(u, p.target)).map((p: any) => priceOut(u, p)),
    };
  });

  // Admins see every pending request; everyone else sees their own.
  app.get('/products/price-changes', async req => {
    const u = actorOf(req);
    if (!canView(u)) deny(403, 'PRODUCTS_FORBIDDEN', 'You do not have access to the product area');
    const status = z.enum(['pending', 'applied', 'rejected', 'withdrawn', 'superseded']).default('pending').parse((req.query as any)?.status);
    const rows = (await db.query(`SELECT p.*, c.name_zh, c.name_en, ${nameSql.replace('%s', 'p.requested_by')} AS requested_name, ${nameSql.replace('%s', 'p.decided_by')} AS decided_name
      FROM product_price_changes p LEFT JOIN product_catalog c ON c.org_id=p.org_id AND c.sku=p.sku
      WHERE p.org_id=$1 AND p.status=$2 AND ($3::boolean OR p.requested_by=$4) ORDER BY p.created_at DESC LIMIT 200`, [u.org_id, status, o.isAdmin(u), u.id])).rows;
    return { items: rows.filter((p: any) => canSeeTarget(u, p.target)).map((p: any) => priceOut(u, p)), canDecide: o.isAdmin(u) };
  });
  const pendingOf = async (tx: Queryable, u: User, id: string) => {
    const r = (await tx.query('SELECT * FROM product_price_changes WHERE org_id=$1 AND id=$2 FOR UPDATE', [u.org_id, id])).rows[0];
    if (!r) deny(404, 'PRICE_CHANGE_NOT_FOUND', 'This price change does not exist');
    if (r.status !== 'pending') deny(409, 'PRICE_CHANGE_DECIDED', 'This price change has already been decided');
    return r;
  };
  app.post('/products/price-changes/:id/decide', async req => {
    const u = actorOf(req);
    if (!o.isAdmin(u)) deny(403, 'PRICE_APPROVE_FORBIDDEN', 'Only company administrators can approve price changes');
    const v = z.object({ approve: z.boolean(), note: z.string().trim().max(300).default('') }).strict().parse(req.body);
    return db.transaction(async tx => {
      const r = await pendingOf(tx, u, String((req.params as any).id));
      await tx.query('UPDATE product_price_changes SET status=$3,decided_by=$4,decided_at=now(),decision_note=$5 WHERE org_id=$1 AND id=$2', [u.org_id, r.id, v.approve ? 'applied' : 'rejected', u.id, v.note]);
      if (v.approve) await applyPrice(tx, u, r.sku, r.target, num_(r.new_price));
      await audit(tx, u, v.approve ? 'products.price_approved' : 'products.price_rejected', r.sku, { id: r.id, target: r.target, to: num_(r.new_price), note: v.note });
      return { id: r.id, status: v.approve ? 'applied' : 'rejected' };
    });
  });
  app.post('/products/price-changes/:id/withdraw', async req => {
    const u = actorOf(req);
    return db.transaction(async tx => {
      const r = await pendingOf(tx, u, String((req.params as any).id));
      if (r.requested_by !== u.id) deny(403, 'PRICE_WITHDRAW_FORBIDDEN', 'Only the person who asked for this price change can withdraw it');
      await tx.query(`UPDATE product_price_changes SET status='withdrawn',decided_at=now() WHERE org_id=$1 AND id=$2`, [u.org_id, r.id]);
      return { id: r.id, status: 'withdrawn' };
    });
  });

  app.put('/products/:sku/channel-prices/:channel', async req => {
    const u = actorOf(req);
    if (!canPricing(u)) deny(403, 'CHANNEL_PRICE_FORBIDDEN', 'Only people with the full price build-up can set channel prices');
    const channel = z.enum(CHANNELS).parse((req.params as any).channel);
    const v = z.object({ price: num, listed: z.boolean().optional(), reason: z.string().trim().max(300).optional() }).strict().parse(req.body);
    return db.transaction(async tx => {
      const cur = await catalogOf(tx, u.org_id, skuParam(req));
      if (v.listed !== undefined) await tx.query(`INSERT INTO product_channel_prices(org_id,sku,channel,listed,updated_by,updated_at) VALUES($1,$2,$3,$4,$5,now())
        ON CONFLICT(org_id,sku,channel) DO UPDATE SET listed=$4,updated_by=$5,updated_at=now()`, [u.org_id, cur.sku, channel, v.listed, u.id]);
      const change = v.price !== undefined ? await requestPrice(tx, u, cur.sku, channel, v.price, v.reason || '') : null;
      const row = (await tx.query('SELECT * FROM product_channel_prices WHERE org_id=$1 AND sku=$2 AND channel=$3', [u.org_id, cur.sku, channel])).rows[0];
      return { sku: cur.sku, channel, price: num_(row?.price), listed: row ? row.listed : true, ...(change ? { change } : {}) };
    });
  });

  const catalogRow = z.object({
    sku, nameZh: text(200), nameEn: text(200), type: text(60), status: z.enum(PRODUCT_STATUSES).optional(),
    gross: num, dims: z.array(z.number().min(0).max(10_000)).length(3).nullable().optional(), lead: text(60), moq: z.number().int().min(0).max(1_000_000).nullable().optional(),
    msrp: num, low: num, shipFee: num, best: text(80), note: text(500),
  }).strict();
  const unique = (rows: { sku: string }[]) => {
    const seen = new Set<string>();
    for (const r of rows) { const k = r.sku.toLowerCase(); if (seen.has(k)) deny(400, 'DUPLICATE_SKU', 'The same SKU appears more than once in the file'); seen.add(k); }
  };
  // Upsert: columns present in the file overwrite; columns left out keep their current value.
  app.post('/products/import', async req => {
    const u = actorOf(req);
    if (!canEditCatalog(u)) deny(403, 'CATALOG_IMPORT_FORBIDDEN', 'Only product managers or administrators can import the catalog');
    const v = z.object({ rows: z.array(catalogRow).min(1).max(5000) }).strict().parse(req.body);
    unique(v.rows);
    return db.transaction(async tx => {
      let created = 0, updated = 0;
      for (const r of v.rows) {
        const cur = (await tx.query('SELECT * FROM product_catalog WHERE org_id=$1 AND lower(sku)=lower($2) FOR UPDATE', [u.org_id, r.sku])).rows[0];
        const pick = <T>(val: T | undefined, old: T) => val === undefined ? old : val;
        const next = {
          name_zh: pick(r.nameZh, cur?.name_zh ?? ''), name_en: pick(r.nameEn, cur?.name_en ?? ''), type: pick(r.type, cur?.type ?? ''), status: pick(r.status, cur?.status ?? ''),
          gross: pick(r.gross, cur?.gross ?? null), dims: pick(r.dims, cur?.dims ?? null), lead: pick(r.lead, cur?.lead ?? ''), moq: pick(r.moq, cur?.moq ?? null),
          low: pick(r.low, cur?.low ?? null), ship_fee: pick(r.shipFee, cur?.ship_fee ?? null), best: pick(r.best, cur?.best ?? ''), note: pick(r.note, cur?.note ?? ''),
        };
        const s = cur?.sku || r.sku;
        await writeCatalog(tx, u.org_id, s, next, u.id);
        await logChanges(tx, u, s, cur || null, next, 'import');
        // The master sheet is the source of truth on import: a new MSRP is recorded in the price history but never held for approval.
        const msrp = r.msrp === undefined ? num_(cur?.msrp) : r.msrp;
        if (msrp !== num_(cur?.msrp)) {
          await tx.query('UPDATE product_catalog SET msrp=$3 WHERE org_id=$1 AND sku=$2', [u.org_id, s, msrp]);
          await tx.query(`INSERT INTO product_price_changes(id,org_id,sku,target,old_price,new_price,status,reason,requested_by) VALUES($1,$2,$3,'msrp',$4,$5,'applied','import',$6)`,
            [randomUUID(), u.org_id, s, num_(cur?.msrp), msrp, u.id]);
        }
        if (cur) updated++; else created++;
      }
      const importId = randomUUID();
      await tx.query('INSERT INTO product_imports(id,org_id,kind,rows,created_by) VALUES($1,$2,$3,$4,$5)', [importId, u.org_id, 'catalog', v.rows.length, u.id]);
      await audit(tx, u, 'products.catalog_import', importId, { rows: v.rows.length, created, updated });
      return { rows: v.rows.length, created, updated };
    });
  });

  const pricingRow = z.object({ sku, factoryRmb: num, factoryUsd: num, extraRmb: num, ddpRate: num, lastMileRmb: num }).strict();
  app.post('/products/pricing/import', async req => {
    const u = actorOf(req);
    if (!canPricing(u)) deny(403, 'PRICING_IMPORT_FORBIDDEN', 'Only people with the full price build-up can import cost data');
    const v = z.object({ rows: z.array(pricingRow).min(1).max(5000) }).strict().parse(req.body);
    unique(v.rows);
    return db.transaction(async tx => {
      const known = new Map((await tx.query('SELECT sku FROM product_catalog WHERE org_id=$1', [u.org_id])).rows.map((r: any) => [r.sku.toLowerCase(), r.sku]));
      const missing = v.rows.filter(r => !known.has(r.sku.toLowerCase())).map(r => r.sku);
      if (missing.length) deny(400, 'PRICING_UNKNOWN_SKU', `These SKUs are not in the product catalog yet: ${missing.slice(0, 10).join(', ')}${missing.length > 10 ? ` (+${missing.length - 10})` : ''}`);
      for (const r of v.rows) {
        const s = known.get(r.sku.toLowerCase())!;
        const cur = (await tx.query('SELECT * FROM product_pricing WHERE org_id=$1 AND sku=$2 FOR UPDATE', [u.org_id, s])).rows[0];
        const pick = (val: number | null | undefined, old: any) => val === undefined ? (old ?? null) : val;
        await tx.query(`INSERT INTO product_pricing(org_id,sku,factory_rmb,factory_usd,extra_rmb,ddp_rate,last_mile_rmb,updated_by,updated_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,now())
          ON CONFLICT(org_id,sku) DO UPDATE SET factory_rmb=$3,factory_usd=$4,extra_rmb=$5,ddp_rate=$6,last_mile_rmb=$7,updated_by=$8,updated_at=now()`,
          [u.org_id, s, pick(r.factoryRmb, cur?.factory_rmb), pick(r.factoryUsd, cur?.factory_usd), pick(r.extraRmb, cur?.extra_rmb), pick(r.ddpRate, cur?.ddp_rate), pick(r.lastMileRmb, cur?.last_mile_rmb), u.id]);
      }
      const importId = randomUUID();
      await tx.query('INSERT INTO product_imports(id,org_id,kind,rows,created_by) VALUES($1,$2,$3,$4,$5)', [importId, u.org_id, 'pricing', v.rows.length, u.id]);
      await audit(tx, u, 'products.pricing_import', importId, { rows: v.rows.length });
      return { rows: v.rows.length };
    });
  });

  app.get('/products/pricing-rules', async req => {
    const u = actorOf(req);
    if (!canPricing(u)) deny(403, 'PRICING_RULES_FORBIDDEN', 'Only people with the full price build-up can see the pricing rules');
    return { rules: await rulesFor(u.org_id), canEdit: o.isAdmin(u) };
  });
  app.put('/products/pricing-rules', async req => {
    const u = actorOf(req);
    if (!o.isAdmin(u)) deny(403, 'PRICING_RULES_EDIT_FORBIDDEN', 'Only company administrators can change the pricing rules');
    const v = pricingRulesSchema.parse(req.body);
    return db.transaction(async tx => {
      await tx.query(`INSERT INTO pricing_rules(org_id,rules,updated_by,updated_at) VALUES($1,$2,$3,now())
        ON CONFLICT(org_id) DO UPDATE SET rules=$2,updated_by=$3,updated_at=now()`, [u.org_id, JSON.stringify(v), u.id]);
      await audit(tx, u, 'products.pricing_rules', u.org_id, v);
      return { rules: { ...v, updatedAt: new Date().toISOString(), updatedBy: u.id }, canEdit: true };
    });
  });

  // One SKU's pricing inputs: product class (decides the MSRP target), landed-cost override, last mile and the actual selling price.
  // The actual selling price goes through the price history (and approval below the floor), after the cost inputs it is checked against.
  const planBody = z.object({ priceClass: z.enum(PRICE_CLASSES).nullable().optional(), landedUsd: num, lastMileUsd: num, actualPrice: num, reason: z.string().trim().max(300).optional() }).strict();
  app.patch('/products/:sku/pricing-plan', async req => {
    const u = actorOf(req);
    if (!canPricing(u)) deny(403, 'PRICING_PLAN_FORBIDDEN', 'Only people with the full price build-up can change pricing inputs');
    const v = planBody.parse(req.body);
    return db.transaction(async tx => {
      const cat = await catalogOf(tx, u.org_id, skuParam(req));
      const cur = (await tx.query('SELECT * FROM product_pricing WHERE org_id=$1 AND sku=$2 FOR UPDATE', [u.org_id, cat.sku])).rows[0];
      const pick = (val: any, old: any) => val === undefined ? (old ?? null) : val;
      const next = { price_class: pick(v.priceClass, cur?.price_class), landed_usd: pick(v.landedUsd, cur?.landed_usd), last_mile_usd: pick(v.lastMileUsd, cur?.last_mile_usd) };
      await tx.query(`INSERT INTO product_pricing(org_id,sku,price_class,landed_usd,last_mile_usd,updated_by,updated_at) VALUES($1,$2,$3,$4,$5,$6,now())
        ON CONFLICT(org_id,sku) DO UPDATE SET price_class=$3,landed_usd=$4,last_mile_usd=$5,updated_by=$6,updated_at=now()`,
        [u.org_id, cat.sku, next.price_class, next.landed_usd, next.last_mile_usd, u.id]);
      const actualChange = v.actualPrice !== undefined ? await requestPrice(tx, u, cat.sku, 'actual', v.actualPrice, v.reason || '') : null;
      await audit(tx, u, 'products.pricing_plan', cat.sku, v);
      return { sku: cat.sku, priceClass: next.price_class, landedUsd: num_(next.landed_usd), lastMileUsd: num_(next.last_mile_usd),
        actualPrice: await currentPrice(tx, u.org_id, cat.sku, 'actual'), ...(actualChange ? { actualChange } : {}) };
    });
  });

  return { requestPrice, currentPrice, audit, rulesFor, canEditMsrp, canPricing };
}
