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

  const rulesFor = async (org: string) => {
    const r = (await db.query('SELECT rules,updated_at,updated_by FROM pricing_rules WHERE org_id=$1', [org])).rows[0];
    return r ? { ...r.rules, updatedAt: r.updated_at, updatedBy: r.updated_by } : { ...DEFAULT_PRICING_RULES, updatedAt: null, updatedBy: null };
  };

  app.get('/products', async req => {
    const u = actorOf(req);
    if (!canView(u)) deny(403, 'PRODUCTS_FORBIDDEN', 'You do not have access to the product area');
    const rows = (await db.query('SELECT * FROM product_catalog WHERE org_id=$1 ORDER BY type,sku', [u.org_id])).rows;
    const pricing = canPricing(u) ? new Map((await db.query('SELECT * FROM product_pricing WHERE org_id=$1', [u.org_id])).rows.map((r: any) => [r.sku, r])) : new Map();
    return {
      items: rows.map((r: any) => {
        const p: any = pricing.get(r.sku);
        return {
          sku: r.sku, name: { zh: r.name_zh || r.name_en || r.sku, en: r.name_en || r.name_zh || r.sku }, type: r.type, status: r.status,
          gross: num_(r.gross), dims: Array.isArray(r.dims) ? r.dims.map(Number) : null, lead: r.lead, msrp: num_(r.msrp), low: num_(r.low), shipFee: num_(r.ship_fee),
          best: r.best, note: r.note,
          ...(p ? { factoryRmb: num_(p.factory_rmb), factoryUsd: num_(p.factory_usd), extraRmb: num_(p.extra_rmb), ddpRate: num_(p.ddp_rate), lastMileRmb: num_(p.last_mile_rmb),
            priceClass: p.price_class || null, landedUsd: num_(p.landed_usd), lastMileUsd: num_(p.last_mile_usd), actualPrice: num_(p.actual_price) } : {}),
        };
      }),
      canImportCatalog: canEditCatalog(u), canImportPricing: canPricing(u), canSeePricing: canPricing(u),
      ...(canPricing(u) ? { pricingRules: await rulesFor(u.org_id), canEditRules: o.isAdmin(u) } : {}),
      lastCatalogImport: await lastImport(u.org_id, 'catalog'), lastPricingImport: canPricing(u) ? await lastImport(u.org_id, 'pricing') : null,
    };
  });

  const catalogRow = z.object({
    sku, nameZh: text(200), nameEn: text(200), type: text(60), status: z.enum(PRODUCT_STATUSES).optional(),
    gross: num, dims: z.array(z.number().min(0).max(10_000)).length(3).nullable().optional(), lead: text(60),
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
          sku: cur?.sku || r.sku, name_zh: pick(r.nameZh, cur?.name_zh ?? ''), name_en: pick(r.nameEn, cur?.name_en ?? ''), type: pick(r.type, cur?.type ?? ''),
          status: pick(r.status, cur?.status ?? ''), gross: pick(r.gross, cur?.gross ?? null), dims: pick(r.dims, cur?.dims ?? null), lead: pick(r.lead, cur?.lead ?? ''),
          msrp: pick(r.msrp, cur?.msrp ?? null), low: pick(r.low, cur?.low ?? null), ship_fee: pick(r.shipFee, cur?.ship_fee ?? null), best: pick(r.best, cur?.best ?? ''), note: pick(r.note, cur?.note ?? ''),
        };
        await tx.query(`INSERT INTO product_catalog(org_id,sku,name_zh,name_en,type,status,gross,dims,lead,msrp,low,ship_fee,best,note,updated_by,updated_at)
          VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,now())
          ON CONFLICT(org_id,sku) DO UPDATE SET name_zh=$3,name_en=$4,type=$5,status=$6,gross=$7,dims=$8,lead=$9,msrp=$10,low=$11,ship_fee=$12,best=$13,note=$14,updated_by=$15,updated_at=now()`,
          [u.org_id, next.sku, next.name_zh, next.name_en, next.type, next.status, next.gross, next.dims == null ? null : JSON.stringify(next.dims), next.lead, next.msrp, next.low, next.ship_fee, next.best, next.note, u.id]);
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
  const planBody = z.object({ priceClass: z.enum(PRICE_CLASSES).nullable().optional(), landedUsd: num, lastMileUsd: num, actualPrice: num }).strict();
  app.patch('/products/:sku/pricing-plan', async req => {
    const u = actorOf(req);
    if (!canPricing(u)) deny(403, 'PRICING_PLAN_FORBIDDEN', 'Only people with the full price build-up can change pricing inputs');
    const v = planBody.parse(req.body);
    const raw = String((req.params as any).sku || '');
    return db.transaction(async tx => {
      const cat = (await tx.query('SELECT sku FROM product_catalog WHERE org_id=$1 AND lower(sku)=lower($2)', [u.org_id, raw])).rows[0];
      if (!cat) deny(404, 'PRODUCT_NOT_FOUND', 'This SKU is not in the product catalog');
      const cur = (await tx.query('SELECT * FROM product_pricing WHERE org_id=$1 AND sku=$2 FOR UPDATE', [u.org_id, cat.sku])).rows[0];
      const pick = (val: any, old: any) => val === undefined ? (old ?? null) : val;
      const next = { price_class: pick(v.priceClass, cur?.price_class), landed_usd: pick(v.landedUsd, cur?.landed_usd), last_mile_usd: pick(v.lastMileUsd, cur?.last_mile_usd), actual_price: pick(v.actualPrice, cur?.actual_price) };
      await tx.query(`INSERT INTO product_pricing(org_id,sku,price_class,landed_usd,last_mile_usd,actual_price,updated_by,updated_at) VALUES($1,$2,$3,$4,$5,$6,$7,now())
        ON CONFLICT(org_id,sku) DO UPDATE SET price_class=$3,landed_usd=$4,last_mile_usd=$5,actual_price=$6,updated_by=$7,updated_at=now()`,
        [u.org_id, cat.sku, next.price_class, next.landed_usd, next.last_mile_usd, next.actual_price, u.id]);
      await audit(tx, u, 'products.pricing_plan', cat.sku, v);
      return { sku: cat.sku, priceClass: next.price_class, landedUsd: num_(next.landed_usd), lastMileUsd: num_(next.last_mile_usd), actualPrice: num_(next.actual_price) };
    });
  });
}
