/* Product library (产品资料库): the 产品资料 page under 产品与库存, built on the owner's field model (product-spec.ts).
 *
 * It owns no parallel product table. Values live where the rest of the system already reads them
 * (CLAUDE.md rule 1–3): product_catalog (SKU master, names, status, MSRP, weight, package, shipping, plus the
 * spec's other product fields in product_catalog.attrs), product_pricing (landed cost, last mile, suppliers in
 * product_pricing.attrs), product_channel_prices (MAP 'map', promotion floor 'promo_floor', per-tier wholesale
 * overrides 'wh0'…), product_files (file slots and the main image) and pricing_rules.worksheet (价格参数).
 * Visibility is enforced here, on the server, for every response, file download and history entry. */
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { Database, Queryable } from './db.js';
import type { User } from './auth.js';
import { deny, ApiError } from './errors.js';
import { message } from './i18n.js';
import { STATUS_NEXT, type PriceTarget } from './products.js';
import {
  FIELD, SLOT, FILE_TYPES, IMAGE_TYPES, MAX_FILE, CORE_REQUIRED, allFields, fieldOf, canSee, canWrite, completeness, parseValue, specFor, viewerOf, relationIssues,
  type Field, type Viewer,
  canBulkImport,
} from './product-spec.js';
import { EMPTY_WORKSHEET, normalizeWorksheet, worksheet, publicPrices, worksheetSchema, type Worksheet } from './product-worksheet.js';

export const productLibrarySchema = `
ALTER TABLE product_catalog ADD COLUMN IF NOT EXISTS family text NOT NULL DEFAULT '';
ALTER TABLE product_catalog ADD COLUMN IF NOT EXISTS goods_type text NOT NULL DEFAULT 'bulk';
ALTER TABLE product_catalog ADD COLUMN IF NOT EXISTS refb_sku text NOT NULL DEFAULT '';
-- Return SKUs start with REF- (they used to start with REFB-).
UPDATE product_catalog SET refb_sku = 'REF-' || substr(refb_sku, 6) WHERE refb_sku LIKE 'REFB-%';
ALTER TABLE product_catalog ADD COLUMN IF NOT EXISTS attrs jsonb NOT NULL DEFAULT '{}';
ALTER TABLE product_pricing ADD COLUMN IF NOT EXISTS attrs jsonb NOT NULL DEFAULT '{}';
ALTER TABLE pricing_rules ALTER COLUMN rules DROP NOT NULL;
ALTER TABLE pricing_rules ADD COLUMN IF NOT EXISTS worksheet jsonb;
ALTER TABLE pricing_rules ADD COLUMN IF NOT EXISTS worksheet_by text;
ALTER TABLE pricing_rules ADD COLUMN IF NOT EXISTS worksheet_at timestamptz;
UPDATE product_catalog SET family = CASE WHEN type ~ '整机|主机' THEN 'main' WHEN type ~ '配件|备件' THEN 'acc' WHEN type ~ '耗材|材料' THEN 'cons'
  WHEN type ~ '软件|服务|课程' THEN 'soft' ELSE '' END WHERE family = '' AND type <> '';
CREATE TABLE IF NOT EXISTS product_files(id text PRIMARY KEY, org_id text NOT NULL, sku text NOT NULL, slot text NOT NULL, name text NOT NULL,
  mime text NOT NULL, size integer NOT NULL, data bytea NOT NULL, uploaded_by text NOT NULL, created_at timestamptz NOT NULL DEFAULT now());
CREATE INDEX IF NOT EXISTS product_files_sku ON product_files(org_id,sku,slot);
`;

const num = (v: any) => v == null || v === '' ? null : Number(v);
const blank = (v: any) => v == null || v === '' ? null : v;
export const same = (a: any, b: any) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

export type Rec = { sku: string; values: Record<string, any>; files: Record<string, any[]>; mainImage: any; updatedAt: any; cat: any; pr: any };
/** Every product of the org (or the given SKUs, case-insensitive), with all values — callers filter by visibility. */
export async function loadRecords(q: Queryable, org: string, skus?: string[], lock = false): Promise<Map<string, Rec>> {
  const filter = skus ? ' AND lower(sku) = ANY($2::text[])' : '', args: any[] = skus ? [org, skus.map(s => s.toLowerCase())] : [org];
  const cats = (await q.query(`SELECT * FROM product_catalog WHERE org_id=$1${filter} ORDER BY sku${lock ? ' FOR UPDATE' : ''}`, args)).rows;
  const prs = new Map((await q.query(`SELECT * FROM product_pricing WHERE org_id=$1${filter}`, args)).rows.map((r: any) => [r.sku, r]));
  const chans = new Map<string, Record<string, number | null>>();
  for (const r of (await q.query(`SELECT sku,channel,price FROM product_channel_prices WHERE org_id=$1${filter} AND (channel IN ('map','promo_floor') OR channel ~ '^wh[0-9]+$')`, args)).rows)
    (chans.get(r.sku) || chans.set(r.sku, {}).get(r.sku)!)[r.channel] = num(r.price);
  const files = new Map<string, any[]>();
  for (const r of (await q.query(`SELECT id,sku,slot,name,mime,size,created_at FROM product_files WHERE org_id=$1${filter} ORDER BY created_at,id`, args)).rows)
    (files.get(r.sku) || files.set(r.sku, []).get(r.sku)!).push({ id: r.id, slot: r.slot, name: r.name, mime: r.mime, size: Number(r.size), at: r.created_at });
  const out = new Map<string, Rec>();
  for (const c of cats) {
    const pr = prs.get(c.sku) || null, ch = chans.get(c.sku) || {}, attrs = c.attrs || {}, sattrs = pr?.attrs || {};
    const dims = Array.isArray(c.dims) ? c.dims : [];
    const values: Record<string, any> = {};
    for (const f of FIELD.values()) {
      const s = f.store;
      values[f.key] = s.t === 'col' ? (f.type === 'number' || f.type === 'price' ? num(c[s.col]) : blank(c[s.col]))
        : s.t === 'dim' ? num(dims[s.i]) : s.t === 'attr' ? blank(attrs[f.key]) : s.t === 'sattr' ? blank(sattrs[f.key])
        : s.t === 'pcol' ? num(pr?.[s.col]) : s.t === 'chan' ? (ch[s.channel] ?? null) : null;
    }
    for (const [k, p] of Object.entries(ch)) if (/^wh\d+$/.test(k)) values['whOv' + k.slice(2)] = p;
    const fl = files.get(c.sku) || [], bySlot: Record<string, any[]> = {};
    for (const f of fl) if (f.slot !== 'mainImage') (bySlot[f.slot] ||= []).push(f);
    const mainImage = [...fl].reverse().find(f => f.slot === 'mainImage') || null;
    values.mainImage = mainImage ? mainImage.id : null;
    out.set(c.sku, { sku: c.sku, values, files: bySlot, mainImage, updatedAt: c.updated_at, cat: c, pr });
  }
  return out;
}
export const findRec = (recs: Map<string, Rec>, sku: string) => recs.get(sku) || [...recs.values()].find(r => r.sku.toLowerCase() === sku.toLowerCase());

export async function worksheetOf(q: Queryable, org: string): Promise<{ settings: Worksheet; updatedAt: any; updatedBy: any; configured: boolean }> {
  const r = (await q.query('SELECT worksheet,worksheet_at,worksheet_by FROM pricing_rules WHERE org_id=$1', [org])).rows[0];
  return { settings: r?.worksheet ? normalizeWorksheet(r.worksheet) : EMPTY_WORKSHEET, updatedAt: r?.worksheet_at || null, updatedBy: r?.worksheet_by || null, configured: !!r?.worksheet };
}

/** The record as this viewer may see it. */
export function recordFor(v: Viewer, rec: Rec, ws: Worksheet, dupes: Set<string>) {
  const fields = allFields(ws.whTiers), values: Record<string, any> = {};
  for (const f of fields) if (canSee(v, f.vis)) values[f.key] = f.key === 'mainImage' ? undefined : rec.values[f.key] ?? null;
  delete values.mainImage;
  const sens = canSee(v, 'sens'), counts = Object.fromEntries(Object.entries(rec.files).map(([k, a]) => [k, a.length]));
  const calc = worksheet(rec.values, ws);
  return {
    sku: rec.sku, values, updatedAt: rec.updatedAt, duplicate: dupes.has(rec.sku.toLowerCase()),
    mainImage: rec.mainImage ? { id: rec.mainImage.id, name: rec.mainImage.name, size: rec.mainImage.size } : null,
    ...(sens ? { files: rec.files } : {}),
    completeness: completeness({ values: { ...rec.values, mainImage: rec.mainImage?.id || null }, files: counts }, v, fields),
    pricing: sens ? calc : publicPrices(calc),
  };
}
export const duplicatesOf = (recs: Iterable<{ sku: string }>) => {
  const seen = new Set<string>(), dup = new Set<string>();
  for (const r of recs) { const k = r.sku.toLowerCase(); if (seen.has(k)) dup.add(k); seen.add(k); }
  return dup;
};

/* ---------- writing ---------- */
export type Change = { key: string; from: any; to: any };
export type WriteOpts = {
  source: 'create' | 'edit' | 'import' | 'undo'; note?: string; ws: Worksheet;
  /** request: prices go through the existing price history and approval (editor). direct: applied and recorded (admin import/undo). */
  prices: 'request' | 'direct';
  requestPrice: (tx: Queryable, u: User, sku: string, target: PriceTarget, price: number | null, reason?: string) => Promise<any>;
};
const priceTarget = (f: Field): PriceTarget | null => f.key === 'msrp' ? 'msrp' : f.store.t === 'chan' ? f.store.channel as PriceTarget : null;
/** Applies validated values to one product inside the caller's transaction and logs each changed field. */
export async function writeRecord(tx: Queryable, u: User, sku: string, rec: Rec | null, changes: Record<string, any>, o: WriteOpts) {
  const out: Change[] = [], priceResults: Record<string, any> = {};
  if (!rec) {
    await tx.query(`INSERT INTO product_catalog(org_id,sku,status,goods_type,updated_by,updated_at) VALUES($1,$2,$3,$4,$5,now())`,
      [u.org_id, sku, changes.status || 'dev', changes.goodsType || 'bulk', u.id]);
    rec = (await loadRecords(tx, u.org_id, [sku], true)).get(sku)!;
    for (const k of ['status', 'goodsType']) if (changes[k] === undefined || same(changes[k], rec.values[k])) out.push({ key: k, from: null, to: rec.values[k] });
  }
  const cat = { ...rec.cat, attrs: { ...(rec.cat.attrs || {}) }, dims: Array.isArray(rec.cat.dims) ? [...rec.cat.dims] : [null, null, null] };
  const pr = { attrs: { ...(rec.pr?.attrs || {}) }, landed_usd: rec.pr?.landed_usd ?? null, last_mile_usd: rec.pr?.last_mile_usd ?? null };
  let catTouched = false, prTouched = false;
  for (const [key, to] of Object.entries(changes)) {
    const f = fieldOf(key, o.ws.whTiers);
    if (!f || f.type === 'image' || key === 'sku') continue;
    const from = rec.values[key] ?? null;
    if (same(from, to)) continue;
    const s = f.store, target = priceTarget(f);
    if (target) {
      if (o.prices === 'request') priceResults[key] = await o.requestPrice(tx, u, rec.sku, target, to, o.note || '');
      else {
        if (target === 'msrp') await tx.query('UPDATE product_catalog SET msrp=$3,updated_by=$4,updated_at=now() WHERE org_id=$1 AND sku=$2', [u.org_id, rec.sku, to, u.id]);
        else await tx.query(`INSERT INTO product_channel_prices(org_id,sku,channel,price,updated_by,updated_at) VALUES($1,$2,$3,$4,$5,now())
          ON CONFLICT(org_id,sku,channel) DO UPDATE SET price=$4,updated_by=$5,updated_at=now()`, [u.org_id, rec.sku, target, to, u.id]);
        await tx.query(`INSERT INTO product_price_changes(id,org_id,sku,target,old_price,new_price,status,reason,requested_by,decided_by,decided_at) VALUES($1,$2,$3,$4,$5,$6,'applied',$7,$8,$8,now())`,
          [randomUUID(), u.org_id, rec.sku, target, from, to, o.source + (o.note ? ':' + o.note : ''), u.id]);
        priceResults[key] = { status: 'applied' };
      }
      if (priceResults[key]?.status === 'pending') continue; // held for approval: the value has not changed yet
    } else if (s.t === 'col') { cat[s.col] = to ?? (['gross', 'msrp'].includes(s.col) ? null : ''); catTouched = true; }
    else if (s.t === 'dim') { cat.dims[s.i] = to; catTouched = true; }
    else if (s.t === 'attr') { if (to == null) delete cat.attrs[key]; else cat.attrs[key] = to; catTouched = true; }
    else if (s.t === 'sattr') { if (to == null) delete pr.attrs[key]; else pr.attrs[key] = to; prTouched = true; }
    else if (s.t === 'pcol') { (pr as any)[s.col] = to; prTouched = true; }
    if (!target) await tx.query('INSERT INTO product_changes(id,org_id,sku,field,old_value,new_value,note,source,actor_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)',
      [randomUUID(), u.org_id, rec.sku, key, JSON.stringify(from), JSON.stringify(to), o.note || '', o.source, u.id]);
    out.push({ key, from, to });
  }
  if (catTouched) {
    const dims = cat.dims.every((x: any) => x == null) ? null : JSON.stringify(cat.dims.map((x: any) => x == null ? null : Number(x)));
    await tx.query(`UPDATE product_catalog SET name_zh=$3,name_en=$4,status=$5,gross=$6,dims=$7,lead=$8,best=$9,family=$10,goods_type=$11,refb_sku=$12,attrs=$13,updated_by=$14,updated_at=now()
      WHERE org_id=$1 AND sku=$2`, [u.org_id, rec.sku, cat.name_zh ?? '', cat.name_en ?? '', cat.status ?? '', cat.gross ?? null, dims, cat.lead ?? '', cat.best ?? '',
      cat.family ?? '', cat.goods_type || 'bulk', cat.refb_sku ?? '', JSON.stringify(cat.attrs), u.id]);
  }
  if (prTouched) await tx.query(`INSERT INTO product_pricing(org_id,sku,landed_usd,last_mile_usd,attrs,updated_by,updated_at) VALUES($1,$2,$3,$4,$5,$6,now())
    ON CONFLICT(org_id,sku) DO UPDATE SET landed_usd=$3,last_mile_usd=$4,attrs=$5,updated_by=$6,updated_at=now()`,
    [u.org_id, rec.sku, pr.landed_usd, pr.last_mile_usd, JSON.stringify(pr.attrs), u.id]);
  return { changes: out, prices: priceResults };
}

/* ---------- validation shared by the editor and the import ---------- */
export type Issue = { key: string; zh: string; en: string };
/** Parses raw values for one product. Blank (undefined) means no change; null or [清空] clears. */
export function validateValues(v: Viewer, raw: Record<string, unknown>, ws: Worksheet) {
  const values: Record<string, any> = {}, errors: Issue[] = [];
  for (const [key, val] of Object.entries(raw)) {
    if (val === undefined) continue;
    const f = fieldOf(key, ws.whTiers);
    if (!f) { errors.push({ key, zh: '没有这个字段', en: 'Unknown field' }); continue; }
    if (!canWrite(v, f)) { errors.push({ key, zh: '你没有修改这个字段的权限', en: 'You cannot change this field' }); continue; }
    const p = parseValue(f, val);
    if (!p.ok) { errors.push({ key, zh: p.zh, en: p.en }); continue; }
    if (p.value == null && CORE_REQUIRED.has(key)) { errors.push({ key, zh: '这是核心必填字段，不能清空', en: 'This core field cannot be cleared' }); continue; }
    values[key] = p.value;
  }
  return { values, errors };
}
/** Rules that look at the whole record after the change (return SKU). */
export function recordIssues(after: Record<string, any>): Issue[] {
  const out: Issue[] = [];
  if (after.goodsType !== 'refb' && after.refbSku) out.push({ key: 'refbSku', zh: '只有退货产品才填退货 SKU', en: 'Only returned products have a returned-goods SKU' });
  if (after.goodsType === 'refb' && !after.refbSku) out.push({ key: 'refbSku', zh: '退货产品必须填退货 SKU（REF- 开头）', en: 'A returned product needs a returned-goods SKU starting with REF-' });
  return out;
}

/** SKUs and return SKUs of the org, for relationIssues. */
export async function relationIndex(q: Queryable, org: string) {
  const rows = (await q.query('SELECT sku,refb_sku FROM product_catalog WHERE org_id=$1', [org])).rows;
  const refb = new Map<string, string[]>();
  for (const r of rows) if (r.refb_sku) { const k = String(r.refb_sku).toLowerCase(); refb.set(k, [...(refb.get(k) || []), r.sku]); }
  return { skus: new Set<string>(rows.map((r: any) => String(r.sku).toLowerCase())), refb };
}
/** The file's first bytes must match its type, so a renamed file cannot pass as a PDF or image. */
export function signatureOk(mime: string, data: Buffer) {
  const at = (s: string, o = 0) => data.subarray(o, o + s.length).toString('latin1') === s;
  if (mime === 'application/pdf') return at('%PDF-');
  if (mime === 'image/png') return data.subarray(0, 4).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  if (mime === 'image/jpeg') return data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff;
  if (mime === 'image/webp') return at('RIFF') && at('WEBP', 8);
  return !data.subarray(0, 8192).includes(0); // CSV / TXT: text, no NUL bytes
}

export async function registerProductLibraryRoutes(app: FastifyInstance, db: Database, o: {
  isAdmin: (u: User) => boolean; requestPrice: WriteOpts['requestPrice'];
  audit: (tx: Queryable, u: User, action: string, objectId: string, details: unknown) => Promise<unknown>;
}) {
  const actorOf = (req: FastifyRequest): User => req.actor || deny(401, 'UNAUTHENTICATED', 'Authentication is required');
  const viewer = (u: User) => viewerOf(Array.isArray((u as any).grants) ? (u as any).grants : [], o.isAdmin(u));
  const skuParam = (req: FastifyRequest) => String((req.params as any).sku || '');
  const fail = (errors: Issue[], _lang?: string) => deny(400, 'PRODUCT_VALUE_INVALID',
    'Some values are not valid: ' + errors.map(e => `${fieldOf(e.key)?.en || e.key}: ${e.en}`).join('; '),
    '有些值不符合规则：' + errors.map(e => `${fieldOf(e.key)?.zh || e.key}：${e.zh}`).join('；'));

  app.get('/products/library', async req => {
    const u = actorOf(req), v = viewer(u);
    const ws = await worksheetOf(db, u.org_id), recs = await loadRecords(db, u.org_id), dupes = duplicatesOf(recs.values());
    const pending = new Map<string, any[]>();
    for (const r of (await db.query(`SELECT id,sku,target,new_price FROM product_price_changes WHERE org_id=$1 AND status='pending' ORDER BY created_at`, [u.org_id])).rows)
      if (r.target === 'msrp' || r.target === 'map' || r.target === 'promo_floor' || /^wh\d+$/.test(r.target) && (v.editCost || !ws.settings.whTiers[Number(r.target.slice(2))]?.floor))
        (pending.get(r.sku) || pending.set(r.sku, []).get(r.sku)!).push({ id: r.id, target: r.target, price: num(r.new_price) });
    const sens = canSee(v, 'sens');
    return {
      spec: specFor(v, ws.settings.whTiers),
      viewer: { levels: [...v.levels], editCatalog: v.editCatalog, editCost: v.editCost, editPrices: v.editPrices, admin: v.admin, canImport: canBulkImport(Array.isArray((u as any).grants) ? (u as any).grants : [], v.admin), canEditSettings: v.admin },
      settings: sens ? { ...ws.settings, updatedAt: ws.updatedAt, configured: ws.configured }
        : { whTiers: ws.settings.whTiers.filter(t => !t.floor).map(t => ({ name: t.name, discount: t.discount })), configured: ws.configured },
      items: [...recs.values()].map(r => ({ ...recordFor(v, r, ws.settings, dupes), ...(pending.get(r.sku) ? { pendingPrices: pending.get(r.sku) } : {}) })),
    };
  });

  const body = z.object({ values: z.record(z.string(), z.any()).default({}), note: z.string().trim().max(300).optional() }).strict();
  const statusRule = (v: Viewer, from: string, to: string, note?: string) => {
    if (from === to) return;
    if (!v.admin && !(STATUS_NEXT[from || ''] || []).includes(to)) deny(409, 'STATUS_TRANSITION', `A product cannot move from ${from || 'unlabeled'} to ${to}`, `产品状态不能从 ${from || '未标注'} 直接改为 ${to}`);
    if (['clearance', 'eol'].includes(to) && !note) deny(400, 'STATUS_NOTE_REQUIRED', 'Give a reason for moving the product into clearance or out of sale');
  };

  app.post('/products/library', async (req, reply) => {
    const u = actorOf(req), v = viewer(u);
    if (!v.editCatalog) deny(403, 'CATALOG_EDIT_FORBIDDEN', 'Only product managers or administrators can add products');
    const b = z.object({ sku: z.string(), values: z.record(z.string(), z.any()).default({}), note: z.string().trim().max(300).optional() }).strict().parse(req.body);
    const skuP = parseValue(FIELD.get('sku')!, b.sku);
    if (!skuP.ok || !skuP.value) return fail([{ key: 'sku', zh: skuP.ok ? '请填写 SKU' : skuP.zh, en: skuP.ok ? 'Enter a SKU' : skuP.en }], req.language);
    const sku = skuP.value as string;
    const ws = (await worksheetOf(db, u.org_id)).settings;
    const { values, errors } = validateValues(v, { status: 'dev', goodsType: 'bulk', ...b.values }, ws);
    errors.push(...recordIssues(values).filter(i => i.zh.startsWith('只有')));
    if (errors.length) fail(errors, req.language);
    if (values.status && values.status !== 'dev' && !v.admin) statusRule(v, '', values.status, b.note);
    const out = await db.transaction(async tx => {
      if ((await tx.query('SELECT 1 FROM product_catalog WHERE org_id=$1 AND lower(sku)=lower($2)', [u.org_id, sku])).rows.length) deny(409, 'PRODUCT_EXISTS', 'A product with this SKU already exists');
      const rel = relationIssues(sku, values, Object.keys(values), await relationIndex(tx, u.org_id));
      if (rel.length) fail(rel);
      const w = await writeRecord(tx, u, sku, null, values, { source: 'create', note: b.note, ws, prices: 'request', requestPrice: o.requestPrice });
      await o.audit(tx, u, 'products.created', sku, { fields: w.changes.map(c => c.key) });
      return { sku, changed: w.changes.map(c => c.key), prices: w.prices };
    });
    return reply.code(201).send(out);
  });

  app.patch('/products/library/:sku', async req => {
    const u = actorOf(req), v = viewer(u);
    const b = body.parse(req.body);
    const ws = (await worksheetOf(db, u.org_id)).settings;
    const { values, errors } = validateValues(v, b.values, ws);
    if (errors.length) fail(errors, req.language);
    return db.transaction(async tx => {
      const rec = findRec(await loadRecords(tx, u.org_id, [skuParam(req)], true), skuParam(req)) || deny(404, 'PRODUCT_NOT_FOUND', 'This SKU is not in the product catalog');
      // Leaving 退货 clears the return SKU. A product switched to 退货 without its return SKU yet only shows it as missing (autosave).
      if (values.goodsType && values.goodsType !== 'refb' && rec.values.refbSku && !('refbSku' in values)) values.refbSku = null;
      const issues = recordIssues({ ...rec.values, ...values }).filter(i => i.zh.startsWith('只有'));
      if (issues.length) fail(issues, req.language);
      const rel = relationIssues(rec.sku, { ...rec.values, ...values }, Object.keys(values), await relationIndex(tx, u.org_id));
      if (rel.length) fail(rel);
      if (values.status !== undefined) statusRule(v, rec.values.status || '', values.status, b.note);
      const w = await writeRecord(tx, u, rec.sku, rec, values, { source: 'edit', note: b.note, ws, prices: 'request', requestPrice: o.requestPrice });
      if (w.changes.length) await o.audit(tx, u, 'products.edited', rec.sku, { fields: w.changes.map(c => c.key) });
      const fresh = (await loadRecords(tx, u.org_id, [rec.sku])).get(rec.sku)!;
      return { sku: rec.sku, changed: w.changes.map(c => c.key), prices: w.prices, item: recordFor(v, fresh, ws, new Set()) };
    });
  });

  /* Bulk edit (owner, 2026-11-13): tick several SKUs in the list, pick one field, give it one value. Same rules as editing
     each SKU by hand (field permissions, status steps and reason, return-SKU rules), in one transaction: if any SKU is
     refused nothing changes and the message names that SKU. Fields that must differ per SKU cannot be bulk-set. */
  const NOT_BULK = new Set(['sku', 'refbSku', 'upc', 'nameZh', 'nameEn', 'mainImage']);
  const bulkBody = z.object({ skus: z.array(z.string().trim().min(1).max(80)).min(1).max(500), values: z.record(z.string(), z.any()), note: z.string().trim().max(300).optional() }).strict();
  app.post('/products/library/bulk-edit', async req => {
    const u = actorOf(req), v = viewer(u);
    const b = bulkBody.parse(req.body), keys = Object.keys(b.values);
    if (!keys.length) deny(400, 'BULK_EDIT_EMPTY', 'Choose a field to change');
    if (keys.some(k => NOT_BULK.has(k))) deny(400, 'BULK_EDIT_FIELD', 'This field is different for every product and cannot be bulk-edited');
    const ws = (await worksheetOf(db, u.org_id)).settings;
    const { values, errors } = validateValues(v, b.values, ws);
    if (errors.length) fail(errors, req.language);
    const skus = [...new Map(b.skus.map(s => [s.toLowerCase(), s])).values()];
    return db.transaction(async tx => {
      const recs = await loadRecords(tx, u.org_id, skus, true), rel = await relationIndex(tx, u.org_id);
      let changed = 0;
      for (const s of skus) {
        try {
          const rec = findRec(recs, s) || deny(404, 'PRODUCT_NOT_FOUND', 'This SKU is not in the product catalog');
          const vals = { ...values };
          if (vals.goodsType && vals.goodsType !== 'refb' && rec.values.refbSku) vals.refbSku = null;
          const issues = recordIssues({ ...rec.values, ...vals }).filter(i => i.zh.startsWith('只有'));
          if (issues.length) fail(issues, req.language);
          const ri = relationIssues(rec.sku, { ...rec.values, ...vals }, Object.keys(vals), rel);
          if (ri.length) fail(ri);
          if (vals.status !== undefined) statusRule(v, rec.values.status || '', vals.status, b.note);
          const w = await writeRecord(tx, u, rec.sku, rec, vals, { source: 'edit', note: b.note, ws, prices: 'request', requestPrice: o.requestPrice });
          if (w.changes.length) { changed++; await o.audit(tx, u, 'products.bulk_edited', rec.sku, { fields: w.changes.map(c => c.key) }); }
        } catch (e) {
          if (e instanceof ApiError) throw new ApiError(e.status, e.code, `${s}: ${e.message}`, `${s}：${e.zh || message(e.message, 'zh')}`);
          throw e;
        }
      }
      return { ok: true, skus: skus.length, changed };
    });
  });

  /* history, limited to the fields this viewer can see */
  const LEGACY: Record<string, string> = { name_zh: 'nameZh', name_en: 'nameEn', status: 'status', gross: 'grossWeight', lead: 'productionLead', best: 'bestShipping', msrp: 'msrp', type: 'family', dims: 'pkgL', note: 'series', low: 'promoFloor', ship_fee: 'promoFloor', moq: 'moqUnit' };
  app.get('/products/library/:sku/history', async req => {
    const u = actorOf(req), v = viewer(u), ws = (await worksheetOf(db, u.org_id)).settings;
    const rec = findRec(await loadRecords(db, u.org_id, [skuParam(req)]), skuParam(req)) || deny(404, 'PRODUCT_NOT_FOUND', 'This SKU is not in the product catalog');
    const nameSql = (c: string) => `(SELECT COALESCE(NULLIF(display_name,''),NULLIF(name_zh,''),NULLIF(name_en,''),id) FROM users WHERE id=${c})`;
    const changes = (await db.query(`SELECT c.*, ${nameSql('c.actor_id')} AS actor_name FROM product_changes c WHERE c.org_id=$1 AND c.sku=$2 ORDER BY c.created_at DESC LIMIT 300`, [u.org_id, rec.sku])).rows;
    const prices = (await db.query(`SELECT p.*, ${nameSql('p.requested_by')} AS actor_name FROM product_price_changes p WHERE p.org_id=$1 AND p.sku=$2 ORDER BY p.created_at DESC LIMIT 200`, [u.org_id, rec.sku])).rows;
    const visible = (key: string) => { const f = fieldOf(LEGACY[key] || key, ws.whTiers); return !!f && canSee(v, f.vis); };
    const priceKey = (t: string) => t === 'msrp' ? 'msrp' : t === 'map' ? 'map' : t === 'promo_floor' ? 'promoFloor' : /^wh\d+$/.test(t) ? 'whOv' + t.slice(2) : null;
    return {
      sku: rec.sku,
      items: [
        ...changes.filter((c: any) => visible(c.field)).map((c: any) => ({ id: c.id, field: LEGACY[c.field] || c.field, from: c.old_value, to: c.new_value, note: c.note, source: c.source, actor: c.actor_name, at: c.created_at })),
        ...prices.filter((p: any) => priceKey(p.target) && visible(priceKey(p.target)!)).map((p: any) => ({ id: p.id, field: priceKey(p.target), from: num(p.old_price), to: num(p.new_price), note: p.reason, source: 'price', status: p.status, actor: p.actor_name, at: p.created_at })),
      ].sort((a, b) => +new Date(b.at) - +new Date(a.at)),
    };
  });

  /* ---------- files: the main image (everyone) and the sensitive slots ---------- */
  const fileBody = z.object({ name: z.string().trim().min(1).max(200), mime: z.string().trim().max(120).optional(), dataBase64: z.string().min(4).max(Math.ceil(MAX_FILE * 4 / 3) + 8) }).strict();
  /* Delete a product (owner, 2026-11-13): product managers and main admins. Only a SKU nothing else points at can go:
     stock, stock movements, dealer orders, purchase orders, shipments, returns and quality issues keep their history,
     so a SKU they use is refused with where it is used (set it to 下架封存 instead). The product's own rows go with it:
     pricing, channel prices, files and empty stock / bin rows; its change history stays for the audit trail. */
  app.delete<{ Params: { sku: string } }>('/products/library/:sku', async req => {
    const u = actorOf(req), v = viewer(u);
    if (!v.editCatalog) deny(403, 'CATALOG_DELETE_FORBIDDEN', 'Only product managers or administrators can delete products', '只有产品资料“管理信息”权限的人或主管理员可以删除产品。');
    const sku = z.string().trim().min(1).max(80).parse(req.params.sku);
    return db.transaction(async tx => {
      const row = (await tx.query('SELECT sku,name_zh,name_en FROM product_catalog WHERE org_id=$1 AND lower(sku)=lower($2) FOR UPDATE', [u.org_id, sku])).rows[0];
      if (!row) deny(404, 'PRODUCT_NOT_FOUND', 'This product was not found', '找不到这个产品，可能已经被删除。');
      const k = String(row.sku).toLowerCase(), org = u.org_id;
      const count = async (sql: string) => Number((await tx.query(sql, [org, k])).rows[0]?.n || 0);
      const used: [string, string, number][] = [
        ['库存', 'stock', await count(`SELECT COALESCE(sum(qty),0)::int n FROM wms_stock WHERE org_id=$1 AND lower(sku)=$2`)],
        ['出入库记录', 'stock movements', await count(`SELECT count(*)::int n FROM wms_movements WHERE org_id=$1 AND lower(sku)=$2`)],
        ['经销商订单', 'dealer orders', await count(`SELECT count(*)::int n FROM dealer_order_lines l JOIN dealer_orders o ON o.id=l.order_id WHERE o.org_id=$1 AND lower(l.sku)=$2`)],
        ['采购单', 'purchase orders', await count(`SELECT count(*)::int n FROM scm_order_lines l JOIN scm_orders o ON o.id=l.order_id WHERE o.org_id=$1 AND lower(l.sku)=$2`)],
        ['货柜', 'shipments', await count(`SELECT count(*)::int n FROM scm_shipment_lines l JOIN scm_shipments s ON s.id=l.shipment_id WHERE s.org_id=$1 AND lower(l.sku)=$2`)],
        ['退货维修', 'returns', await count(`SELECT count(*)::int n FROM rma_cases WHERE org_id=$1 AND (lower(sku)=$2 OR lower(main_sku)=$2)`)],
        ['质量问题', 'quality issues', await count(`SELECT count(*)::int n FROM quality_issues WHERE org_id=$1 AND lower(sku)=$2`)],
      ];
      const hits = used.filter(x => x[2] > 0);
      if (hits.length) deny(409, 'PRODUCT_IN_USE', `This SKU is used in ${hits.map(x => `${x[1]} (${x[2]})`).join(', ')}; set its status to Delisted instead`,
        `这个 SKU 已经用在${hits.map(x => `${x[0]}（${x[2]}）`).join('、')}里，删除会弄乱这些记录。请把状态改为“下架封存”。`);
      for (const t of ['product_pricing', 'product_channel_prices', 'product_files', 'wms_stock', 'wms_bins', 'wms_items'])
        await tx.query(`DELETE FROM ${t} WHERE org_id=$1 AND lower(sku)=$2`, [org, k]);
      await tx.query('DELETE FROM product_catalog WHERE org_id=$1 AND lower(sku)=$2', [org, k]);
      await o.audit(tx, u, 'products.deleted', row.sku, { nameZh: row.name_zh, nameEn: row.name_en });
      return { ok: true, sku: row.sku };
    });
  });

  app.post('/products/library/:sku/files/:slot', { bodyLimit: Math.ceil(MAX_FILE * 4 / 3) + 4096 }, async (req, reply) => {
    const u = actorOf(req), v = viewer(u), slot = String((req.params as any).slot || '');
    const isImage = slot === 'mainImage', s = SLOT.get(slot);
    if (!isImage && !s) deny(404, 'FILE_SLOT_NOT_FOUND', 'This file slot does not exist');
    if (isImage ? !v.editCatalog : !v.editCost) deny(403, 'PRODUCT_FILE_FORBIDDEN', 'You cannot change files in this slot');
    const b = fileBody.parse(req.body);
    const ext = (b.name.split('.').pop() || '').toLowerCase(), mime = FILE_TYPES[ext];
    if (!mime) deny(400, 'FILE_TYPE', 'Upload a PDF, PNG, JPG, WebP, CSV or TXT file; save Excel or Word files as PDF or CSV first');
    if (isImage && !IMAGE_TYPES.has(mime)) deny(400, 'FILE_TYPE_IMAGE', 'The main image must be PNG, JPG or WebP');
    if (s?.mode === 'pdf' && mime !== 'application/pdf') deny(400, 'FILE_TYPE_PDF', 'This slot only takes PDF files');
    const data = Buffer.from(b.dataBase64, 'base64');
    if (!data.length) deny(400, 'FILE_EMPTY', 'The file is empty');
    if (data.length > MAX_FILE) deny(400, 'FILE_TOO_LARGE', 'Each file must be 20 MB or smaller');
    if (!signatureOk(mime, data)) deny(400, 'FILE_CONTENT', 'The file content does not match its type; export it again as a real PDF, image, CSV or TXT');
    const out = await db.transaction(async tx => {
      const rec = findRec(await loadRecords(tx, u.org_id, [skuParam(req)]), skuParam(req)) || deny(404, 'PRODUCT_NOT_FOUND', 'This SKU is not in the product catalog');
      if ((await tx.query('SELECT count(*)::int n FROM product_files WHERE org_id=$1 AND sku=$2', [u.org_id, rec.sku])).rows[0].n >= 100) deny(400, 'FILE_LIMIT', 'A product can have at most 100 files');
      const old = isImage ? (await tx.query(`SELECT id FROM product_files WHERE org_id=$1 AND sku=$2 AND slot='mainImage'`, [u.org_id, rec.sku])).rows : [];
      if (old.length) await tx.query(`DELETE FROM product_files WHERE org_id=$1 AND sku=$2 AND slot='mainImage'`, [u.org_id, rec.sku]);
      const id = randomUUID();
      const row = (await tx.query('INSERT INTO product_files(id,org_id,sku,slot,name,mime,size,data,uploaded_by) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id,slot,name,mime,size,created_at',
        [id, u.org_id, rec.sku, slot, b.name, mime, data.length, data, u.id])).rows[0];
      await tx.query('INSERT INTO product_changes(id,org_id,sku,field,old_value,new_value,note,source,actor_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)',
        [randomUUID(), u.org_id, rec.sku, isImage ? 'mainImage' : 'file:' + slot, JSON.stringify(old[0]?.id || null), JSON.stringify(b.name), '', 'edit', u.id]);
      await o.audit(tx, u, 'products.file_uploaded', rec.sku, { slot, name: b.name, size: data.length });
      return { id: row.id, slot: row.slot, name: row.name, mime: row.mime, size: Number(row.size), at: row.created_at };
    });
    return reply.code(201).send(out);
  });
  const fileOf = async (u: User, id: string) => {
    const f = (await db.query('SELECT id,sku,slot,name,mime,size FROM product_files WHERE org_id=$1 AND id=$2', [u.org_id, id])).rows[0];
    if (!f || (f.slot !== 'mainImage' && !canSee(viewer(u), 'sens'))) deny(404, 'PRODUCT_FILE_NOT_FOUND', 'File not found');
    return f;
  };
  app.get('/products/library/files/:id', async (req, reply) => {
    const u = actorOf(req), f = await fileOf(u, String((req.params as any).id));
    const data = (await db.query('SELECT data FROM product_files WHERE id=$1', [f.id])).rows[0].data;
    // A stored file never changes under its id, so the browser may keep images (product thumbnails in lists); other files are not kept.
    return reply.header('content-type', f.mime).header('cache-control', f.mime.startsWith('image/') ? 'private, max-age=86400, immutable' : 'private, no-store').header('x-content-type-options', 'nosniff')
      .header('content-disposition', `${f.mime.startsWith('image/') || f.mime === 'application/pdf' ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(f.name)}`).send(Buffer.from(data));
  });
  app.delete('/products/library/files/:id', async req => {
    const u = actorOf(req), v = viewer(u), f = await fileOf(u, String((req.params as any).id));
    if (f.slot === 'mainImage' ? !v.editCatalog : !v.editCost) deny(403, 'PRODUCT_FILE_FORBIDDEN', 'You cannot change files in this slot');
    return db.transaction(async tx => {
      await tx.query('DELETE FROM product_files WHERE id=$1', [f.id]);
      await tx.query('INSERT INTO product_changes(id,org_id,sku,field,old_value,new_value,note,source,actor_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)',
        [randomUUID(), u.org_id, f.sku, f.slot === 'mainImage' ? 'mainImage' : 'file:' + f.slot, JSON.stringify(f.name), JSON.stringify(null), '', 'edit', u.id]);
      await o.audit(tx, u, 'products.file_deleted', f.sku, { slot: f.slot, name: f.name });
      return { id: f.id, deleted: true };
    });
  });

  /* ---------- 价格参数 ---------- */
  app.get('/products/worksheet-settings', async req => {
    const u = actorOf(req), v = viewer(u);
    if (!canSee(v, 'sens')) deny(403, 'PRICING_RULES_FORBIDDEN', 'Only people with the full price build-up can see the pricing rules');
    const ws = await worksheetOf(db, u.org_id);
    return { settings: ws.settings, configured: ws.configured, updatedAt: ws.updatedAt, canEdit: v.admin };
  });
  app.put('/products/worksheet-settings', async req => {
    const u = actorOf(req);
    if (!o.isAdmin(u)) deny(403, 'PRICING_RULES_EDIT_FORBIDDEN', 'Only company administrators can change the pricing rules');
    const s = worksheetSchema.parse(req.body);
    return db.transaction(async tx => {
      await tx.query(`INSERT INTO pricing_rules(org_id,rules,worksheet,worksheet_by,worksheet_at) VALUES($1,NULL,$2,$3,now())
        ON CONFLICT(org_id) DO UPDATE SET worksheet=$2,worksheet_by=$3,worksheet_at=now()`, [u.org_id, JSON.stringify(s), u.id]);
      await o.audit(tx, u, 'products.worksheet_settings', u.org_id, { dtcItems: s.dtcItems.length, whItems: s.whItems.length, retailTiers: s.retailTiers.length, whTiers: s.whTiers.length });
      return { settings: s, configured: true, updatedAt: new Date().toISOString(), canEdit: true };
    });
  });
}
