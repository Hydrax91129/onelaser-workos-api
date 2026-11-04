/* 产品资料 (PIM): one record per product_catalog.sku, edited field by field.
 *
 * The field list, requirement matrix and visibility levels are in product-fields.ts. Values live in the
 * tables products.ts already owns (CLAUDE.md section 3): product_catalog (columns + attrs for all/ops
 * fields), product_pricing (landed/last-mile + attrs for cost/sens fields), product_catalog.msrp and
 * product_channel_prices (MAP, promotion floor) for selling prices, product_files for uploads.
 * Visibility is enforced here, on the server, for reads, writes, history and files. */
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { Database, Queryable } from './db.js';
import type { User } from './auth.js';
import { deny, denyWith } from './errors.js';
import { priceOps, PRODUCT_STATUSES, STATUS_NEXT } from './products.js';
import {
  FIELDS, FIELD, SLOT, SLOT_VIS, FILE_MIME, IMAGE_MIME, MAX_FILE_BYTES,
  levelsOf, canEditField, checkRecord, modelFor, parseValue, type Issue, type Values, type Viewer, type Vis,
} from './product-fields.js';

export const pimSchema = `
ALTER TABLE product_catalog ADD COLUMN IF NOT EXISTS family text;
ALTER TABLE product_catalog ADD COLUMN IF NOT EXISTS goods_type text;
ALTER TABLE product_catalog ADD COLUMN IF NOT EXISTS refb_sku text;
ALTER TABLE product_catalog ADD COLUMN IF NOT EXISTS attrs jsonb NOT NULL DEFAULT '{}';
ALTER TABLE product_pricing ADD COLUMN IF NOT EXISTS attrs jsonb NOT NULL DEFAULT '{}';
CREATE TABLE IF NOT EXISTS product_files(id text PRIMARY KEY, org_id text NOT NULL, sku text NOT NULL, slot text NOT NULL, name text NOT NULL, mime text NOT NULL,
  size integer NOT NULL, data bytea NOT NULL, created_by text NOT NULL, created_at timestamptz NOT NULL DEFAULT now());
CREATE INDEX IF NOT EXISTS product_files_sku ON product_files(org_id,sku,slot);
`;

const num = (v: any) => v == null ? null : Number(v);
const STATUS_NEEDS_NOTE = new Set(['clearance', 'eolPlanned', 'eol']);
export type Rec = { sku: string; values: Values; files: Record<string, number>; updatedAt: string | null };

/** Reads products with every stored value (unfiltered; callers filter by viewer). */
export async function loadRecords(q: Queryable, org: string, skus?: string[]): Promise<Map<string, Rec>> {
  const filter = skus ? ' AND lower(sku)=ANY($2::text[])' : '', args: unknown[] = skus ? [org, skus.map(s => s.toLowerCase())] : [org];
  const cat = (await q.query(`SELECT * FROM product_catalog WHERE org_id=$1${filter} ORDER BY sku`, args)).rows;
  const pr = new Map((await q.query(`SELECT * FROM product_pricing WHERE org_id=$1${filter}`, args)).rows.map((r: any) => [r.sku, r]));
  const ch = new Map<string, Record<string, number | null>>();
  for (const r of (await q.query(`SELECT sku,channel,price FROM product_channel_prices WHERE org_id=$1${filter}`, args)).rows)
    (ch.get(r.sku) || ch.set(r.sku, {}).get(r.sku)!)[r.channel] = num(r.price);
  const files = new Map<string, Record<string, number>>();
  for (const r of (await q.query(`SELECT sku,slot,count(*)::int AS n FROM product_files WHERE org_id=$1${filter} GROUP BY sku,slot`, args)).rows)
    (files.get(r.sku) || files.set(r.sku, {}).get(r.sku)!)[r.slot] = r.n;
  const out = new Map<string, Rec>();
  for (const c of cat) {
    const p: any = pr.get(c.sku) || {}, prices = ch.get(c.sku) || {}, dims = Array.isArray(c.dims) ? c.dims : [];
    const v: Values = {};
    for (const d of FIELDS) {
      const s = d.store;
      v[d.key] = s.t === 'col' ? (s.col === 'gross' ? num(c.gross) : (c[s.col] ?? null) || null)
        : s.t === 'dims' ? num(dims[s.i]) : s.t === 'attrs' ? (c.attrs || {})[d.key] ?? null : s.t === 'secure' ? (p.attrs || {})[d.key] ?? null
        : s.t === 'cost' ? num(p[s.col]) : s.t === 'price' ? (s.target === 'msrp' ? num(c.msrp) : prices[s.target] ?? null) : null;
    }
    out.set(c.sku.toLowerCase(), { sku: c.sku, values: v, files: files.get(c.sku) || {}, updatedAt: c.updated_at });
  }
  return out;
}

export const viewerOf = (u: User, isExecutive: (u: User) => boolean): Viewer => ({ executive: isExecutive(u), grants: Array.isArray((u as any).grants) ? (u as any).grants : [] });

/** What one viewer may see of a record. */
export function viewRecord(v: Viewer, rec: Rec) {
  const lv = levelsOf(v), chk = checkRecord(rec.values, { visible: lv, files: rec.files });
  const values: Values = {};
  for (const d of FIELDS) if (lv.has(d.vis) && d.type !== 'image') values[d.key] = rec.values[d.key] ?? null;
  return {
    sku: rec.sku, values, need: chk.need, got: chk.got, complete: chk.got >= chk.need, missing: chk.missing,
    fileCounts: Object.fromEntries(Object.entries(rec.files).filter(([k]) => k === 'mainImage' || lv.has(SLOT_VIS))), updatedAt: rec.updatedAt,
  };
}

export const statusIssue = (from: string, to: string, executive: boolean): Issue | null =>
  !executive && from !== to && !(STATUS_NEXT[from] || PRODUCT_STATUSES).includes(to)
    ? { field: 'status', code: 'STATUS_TRANSITION', zh: `状态不能从「${from || '未标注'}」直接改为「${to}」`, en: `A product cannot move from ${from || 'unlabeled'} to ${to}` } : null;

/** Checks an input against the field model and the viewer's rights. Used by the editor and the bulk import alike.
 *  before: current values (null for a new product). Returns the changed values only, plus blocking issues and warnings. */
export function prepareChanges(v: Viewer, before: Values | null, input: Record<string, unknown>, ctx: { knownSkus?: Set<string> } = {}) {
  const issues: Issue[] = [], changes: Values = {};
  for (const [key, raw] of Object.entries(input)) {
    const d = FIELD.get(key);
    if (!d) { issues.push({ field: key, code: 'FIELD_UNKNOWN', zh: `没有「${key}」这个字段`, en: `There is no field ${key}` }); continue; }
    if (!canEditField(v, d)) { issues.push({ field: key, code: 'FIELD_FORBIDDEN', zh: `你不能修改「${d.zh}」`, en: `You cannot change ${d.en}` }); continue; }
    if (before && key === 'sku') { if (String(raw ?? '').trim().toLowerCase() !== String(before.sku).toLowerCase()) issues.push({ field: 'sku', code: 'SKU_RENAME', zh: 'SKU 不能修改', en: 'The SKU cannot be changed' }); continue; }
    const p = parseValue(d, raw);
    if (!p.ok) { issues.push(p.issue); continue; }
    const old = before ? before[key] ?? null : null;
    if (JSON.stringify(old) !== JSON.stringify(p.value)) changes[key] = p.value;
  }
  const after: Values = { ...(before || {}), ...changes };
  if (!before) { after.status ??= 'dev'; after.goodsType ??= 'bulk'; for (const k of ['status', 'goodsType']) if (changes[k] === undefined && after[k]) changes[k] = after[k]; }
  const lv = levelsOf(v), opts = { visible: lv };
  const now = checkRecord(after, opts), was = before ? checkRecord(before, opts) : { errors: [] as Issue[] };
  const seen = new Set(was.errors.map(e => e.field + e.code));
  for (const e of now.errors) if (!seen.has(e.field + e.code) && !issues.some(i => i.field === e.field)) issues.push(e);
  if (changes.replacementSku && ctx.knownSkus && !ctx.knownSkus.has(String(changes.replacementSku).toLowerCase()))
    issues.push({ field: 'replacementSku', code: 'REPLACEMENT_UNKNOWN', zh: '替代 SKU 不在产品资料里', en: 'The replacement SKU is not in the product list' });
  if (before && changes.status !== undefined) { const s = statusIssue(String(before.status || ''), String(changes.status || ''), v.executive); if (s) issues.push(s); }
  return { changes, issues, warnings: now.warnings, after };
}

type WriteCtx = { source: 'edit' | 'create' | 'import' | 'undo'; note?: string; importId?: string; priceMode: 'request' | 'apply' };
/** Writes changed values for one product inside the caller's transaction; logs each field in product_changes.
 *  Prices go through the price history: 'request' may hold a change for approval, 'apply' (import/undo) applies it. */
export async function writeChanges(tx: Queryable, u: User, ops: ReturnType<typeof priceOps>, sku: string, before: Values | null, changes: Values, ctx: WriteCtx) {
  const org = u.org_id;
  if (!before) await tx.query(`INSERT INTO product_catalog(org_id,sku,status,updated_by,updated_at) VALUES($1,$2,'dev',$3,now())`, [org, sku, u.id]);
  const keys = Object.keys(changes).filter(k => FIELD.has(k) && k !== 'sku');
  const by = (t: string) => keys.map(k => FIELD.get(k)!).filter(d => d.store.t === t);
  const cols = by('col'), attrs = by('attrs'), dims = by('dims'), secure = by('secure'), costs = by('cost'), prices = by('price');
  const cur = (await tx.query('SELECT attrs,dims FROM product_catalog WHERE org_id=$1 AND sku=$2 FOR UPDATE', [org, sku])).rows[0];
  if (cols.length || attrs.length || dims.length) {
    const sets: string[] = [], args: unknown[] = [org, sku, u.id];
    for (const d of cols) { args.push(changes[d.key] ?? (d.store.t === 'col' && ['name_zh', 'name_en', 'status', 'best'].includes(d.store.col) ? '' : null)); sets.push(`${(d.store as any).col}=$${args.length}`); }
    if (attrs.length) {
      const next = { ...(cur?.attrs || {}) };
      for (const d of attrs) { if (changes[d.key] == null) delete next[d.key]; else next[d.key] = changes[d.key]; }
      args.push(JSON.stringify(next)); sets.push(`attrs=$${args.length}`);
    }
    if (dims.length) {
      const next = [0, 1, 2].map(i => num((Array.isArray(cur?.dims) ? cur.dims : [])[i]));
      for (const d of dims) next[(d.store as any).i] = changes[d.key] == null ? null : Number(changes[d.key]);
      args.push(next.every(x => x == null) ? null : JSON.stringify(next)); sets.push(`dims=$${args.length}`);
    }
    await tx.query(`UPDATE product_catalog SET ${sets.join(',')},updated_by=$3,updated_at=now() WHERE org_id=$1 AND sku=$2`, args);
  }
  if (secure.length || costs.length) {
    const p = (await tx.query('SELECT attrs,landed_usd,last_mile_usd FROM product_pricing WHERE org_id=$1 AND sku=$2 FOR UPDATE', [org, sku])).rows[0];
    const next = { ...(p?.attrs || {}) };
    for (const d of secure) { if (changes[d.key] == null) delete next[d.key]; else next[d.key] = changes[d.key]; }
    const landed = changes.landed !== undefined ? changes.landed : num(p?.landed_usd), last = changes.lastMile !== undefined ? changes.lastMile : num(p?.last_mile_usd);
    await tx.query(`INSERT INTO product_pricing(org_id,sku,attrs,landed_usd,last_mile_usd,updated_by,updated_at) VALUES($1,$2,$3,$4,$5,$6,now())
      ON CONFLICT(org_id,sku) DO UPDATE SET attrs=$3,landed_usd=$4,last_mile_usd=$5,updated_by=$6,updated_at=now()`, [org, sku, JSON.stringify(next), landed, last, u.id]);
  }
  for (const d of [...cols, ...attrs, ...dims, ...secure, ...costs])
    await tx.query('INSERT INTO product_changes(id,org_id,sku,field,old_value,new_value,note,source,actor_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)',
      [randomUUID(), org, sku, d.key, JSON.stringify(before ? before[d.key] ?? null : null), JSON.stringify(changes[d.key] ?? null), ctx.note || '', ctx.source, u.id]);
  const priceResults: Record<string, unknown> = {};
  for (const d of prices) {
    const target = (d.store as any).target, price = changes[d.key] == null ? null : Number(changes[d.key]);
    if (ctx.priceMode === 'request') priceResults[d.key] = await ops.requestPrice(tx, u, sku, target, price, ctx.note || '');
    else {
      const old = await ops.currentPrice(tx, org, sku, target);
      if (old === price) continue;
      await tx.query(`INSERT INTO product_price_changes(id,org_id,sku,target,old_price,new_price,status,reason,requested_by) VALUES($1,$2,$3,$4,$5,$6,'applied',$7,$8)`,
        [randomUUID(), org, sku, target, old, price, ctx.source + (ctx.importId ? ':' + ctx.importId : ''), u.id]);
      await ops.applyPrice(tx, u, sku, target, price);
    }
  }
  return { changed: keys, prices: priceResults };
}

/* ---------- files ---------- */
const sniff = (b: Buffer) => b.subarray(0, 5).toString('latin1') === '%PDF-' ? 'application/pdf'
  : b[0] === 0x89 && b.subarray(1, 4).toString('latin1') === 'PNG' ? 'image/png'
  : b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff ? 'image/jpeg'
  : b.subarray(0, 4).toString('latin1') === 'RIFF' && b.subarray(8, 12).toString('latin1') === 'WEBP' ? 'image/webp' : null;
/** The file type from its extension, confirmed by its first bytes (text files must be valid UTF-8 without NUL bytes). */
export function fileType(name: string, data: Buffer): string | null {
  const t = FILE_MIME[(name.split('.').pop() || '').toLowerCase()];
  if (!t) return null;
  if (t.startsWith('text/')) { if (data.includes(0)) return null; try { new TextDecoder('utf-8', { fatal: true }).decode(data); return t; } catch { return null; } }
  return sniff(data) === t ? t : null;
}

export async function registerPimRoutes(app: FastifyInstance, db: Database, o: { isAdmin: (u: User) => boolean }) {
  const actorOf = (req: FastifyRequest): User => req.actor || deny(401, 'UNAUTHENTICATED', 'Authentication is required');
  const viewer = (u: User) => viewerOf(u, o.isAdmin);
  const canPricing = (u: User) => o.isAdmin(u) || viewer(u).grants.includes('product_cost_detail');
  const ops = priceOps(db, { isAdmin: o.isAdmin, canPricing });
  const access = (u: User) => { const v = viewer(u); if (!levelsOf(v).has('all')) deny(403, 'PRODUCTS_FORBIDDEN', 'You do not have access to the product area'); return v; };
  const canCreate = (v: Viewer) => v.executive || v.grants.includes('products_manage');
  const skuParam = (req: FastifyRequest) => String((req.params as any).sku || '');
  const audit = (tx: Queryable, u: User, action: string, objectId: string, details: unknown) =>
    tx.query('INSERT INTO audit_events(id,org_id,department_id,owner_id,actor_id,action,object_id,details) VALUES($1,$2,$3,$4,$5,$6,$7,$8)',
      [randomUUID(), u.org_id, u.department_id, u.id, u.id, action, objectId, JSON.stringify(details)]);
  const one = async (q: Queryable, org: string, sku: string) => (await loadRecords(q, org, [sku])).get(sku.toLowerCase())
    || deny(404, 'PRODUCT_NOT_FOUND', 'This SKU is not in the product catalog');
  const knownSkus = async (q: Queryable, org: string) => new Set((await q.query('SELECT lower(sku) AS s FROM product_catalog WHERE org_id=$1', [org])).rows.map((r: any) => r.s));
  const refbTaken = async (q: Queryable, org: string, refb: unknown, sku: string) =>
    refb != null && (await q.query('SELECT 1 FROM product_catalog WHERE org_id=$1 AND lower(refb_sku)=lower($2) AND lower(sku)<>lower($3)', [org, refb, sku])).rows.length > 0;
  const fileList = async (q: Queryable, v: Viewer, org: string, sku: string) => {
    const lv = levelsOf(v);
    const rows = (await q.query('SELECT id,slot,name,mime,size,created_at FROM product_files WHERE org_id=$1 AND sku=$2 ORDER BY created_at', [org, sku])).rows;
    const out: Record<string, any[]> = {};
    for (const r of rows) if (r.slot === 'mainImage' || lv.has(SLOT_VIS)) (out[r.slot] ||= []).push({ id: r.id, name: r.name, mime: r.mime, size: r.size, at: r.created_at });
    return out;
  };
  const invalid = (issues: Issue[]): never => denyWith(400, 'PRODUCT_INVALID', 'Some values are not valid', `有 ${issues.length} 处填写不符合要求：${issues.slice(0, 3).map(i => i.zh).join('；')}`, { issues });

  app.get('/products/model', async req => {
    const u = actorOf(req), v = access(u);
    return { ...modelFor(v), canCreate: canCreate(v), canImport: canCreate(v), canSeeCost: canPricing(u), canEditSettings: v.executive };
  });

  app.get('/products/records', async req => {
    const u = actorOf(req), v = access(u);
    const recs = [...(await loadRecords(db, u.org_id)).values()];
    return { items: recs.map(r => viewRecord(v, r)) };
  });

  app.get('/products/records/:sku', async req => {
    const u = actorOf(req), v = access(u), rec = await one(db, u.org_id, skuParam(req));
    const pending = (await db.query(`SELECT id,target,new_price FROM product_price_changes WHERE org_id=$1 AND sku=$2 AND status='pending' ORDER BY created_at`, [u.org_id, rec.sku])).rows
      .filter((r: any) => { const d = FIELDS.find(f => f.store.t === 'price' && (f.store as any).target === r.target); return d ? levelsOf(v).has(d.vis) : canPricing(u); })
      .map((r: any) => ({ id: r.id, target: r.target, price: num(r.new_price) }));
    const chk = checkRecord(rec.values, { visible: levelsOf(v), files: rec.files });
    return { ...viewRecord(v, rec), warnings: chk.warnings, files: await fileList(db, v, u.org_id, rec.sku), pendingPrices: pending,
      editable: FIELDS.filter(d => d.type !== 'image' && canEditField(v, d)).map(d => d.key) };
  });

  const valuesBody = z.record(z.string().max(40), z.union([z.string().max(2000), z.number(), z.null()]));
  app.post('/products/records', async (req, reply) => {
    const u = actorOf(req), v = access(u);
    if (!canCreate(v)) deny(403, 'CATALOG_EDIT_FORBIDDEN', 'Only product managers or administrators can add products');
    const body = z.object({ values: valuesBody, note: z.string().trim().max(300).optional() }).strict().parse(req.body);
    const out = await db.transaction(async tx => {
      const known = await knownSkus(tx, u.org_id);
      const { changes, issues, warnings } = prepareChanges(v, null, body.values, { knownSkus: known });
      if (issues.length) invalid(issues);
      const sku = String(changes.sku);
      if (known.has(sku.toLowerCase())) denyWith(409, 'PRODUCT_EXISTS', 'A product with this SKU already exists', '已经有这个 SKU 的产品了（SKU 不区分大小写）。', { issues: [{ field: 'sku', code: 'SKU_DUPLICATE', zh: 'SKU 与已有产品重复', en: 'This SKU already exists' }] });
      if (await refbTaken(tx, u.org_id, changes.refbSku, sku)) invalid([{ field: 'refbSku', code: 'REFB_DUPLICATE', zh: '这个退货 SKU 已被其他产品使用', en: 'Another product already uses this refurbished SKU' }]);
      const w = await writeChanges(tx, u, ops, sku, null, changes, { source: 'create', note: body.note, priceMode: 'request' });
      await audit(tx, u, 'products.created', sku, { fields: w.changed });
      return { sku, prices: w.prices, warnings };
    });
    const rec = await one(db, u.org_id, out.sku);
    return reply.code(201).send({ ...viewRecord(v, rec), prices: out.prices, warnings: out.warnings });
  });

  app.patch('/products/records/:sku', async req => {
    const u = actorOf(req), v = access(u);
    const body = z.object({ values: valuesBody, note: z.string().trim().max(300).optional() }).strict().parse(req.body);
    const out = await db.transaction(async tx => {
      const rec = await one(tx, u.org_id, skuParam(req));
      await tx.query('SELECT 1 FROM product_catalog WHERE org_id=$1 AND sku=$2 FOR UPDATE', [u.org_id, rec.sku]);
      const { changes, issues, warnings } = prepareChanges(v, rec.values, body.values, { knownSkus: await knownSkus(tx, u.org_id) });
      if (issues.length) invalid(issues);
      if (changes.status !== undefined && STATUS_NEEDS_NOTE.has(String(changes.status)) && !body.note) deny(400, 'STATUS_NOTE_REQUIRED', 'Give a reason for moving the product into clearance or out of sale');
      if (changes.refbSku !== undefined && await refbTaken(tx, u.org_id, changes.refbSku, rec.sku)) invalid([{ field: 'refbSku', code: 'REFB_DUPLICATE', zh: '这个退货 SKU 已被其他产品使用', en: 'Another product already uses this refurbished SKU' }]);
      const w = await writeChanges(tx, u, ops, rec.sku, rec.values, changes, { source: 'edit', note: body.note, priceMode: 'request' });
      if (w.changed.length) await audit(tx, u, 'products.edited', rec.sku, { fields: w.changed });
      return { sku: rec.sku, changed: w.changed, prices: w.prices, warnings };
    });
    const rec = await one(db, u.org_id, out.sku);
    return { ...viewRecord(v, rec), changed: out.changed, prices: out.prices, warnings: out.warnings };
  });

  /* Edit history: field changes and price changes the viewer is allowed to see. */
  app.get('/products/records/:sku/history', async req => {
    const u = actorOf(req), v = access(u), lv = levelsOf(v), rec = await one(db, u.org_id, skuParam(req));
    const name = (col: string) => `(SELECT COALESCE(NULLIF(display_name,''),NULLIF(name_zh,''),NULLIF(name_en,''),id) FROM users WHERE id=${col})`;
    const changes = (await db.query(`SELECT c.*, ${name('c.actor_id')} AS actor_name FROM product_changes c WHERE c.org_id=$1 AND c.sku=$2 ORDER BY c.created_at DESC LIMIT 500`, [u.org_id, rec.sku])).rows;
    const prices = (await db.query(`SELECT p.*, ${name('p.requested_by')} AS actor_name FROM product_price_changes p WHERE p.org_id=$1 AND p.sku=$2 ORDER BY p.created_at DESC LIMIT 500`, [u.org_id, rec.sku])).rows;
    const visField = (k: string): Vis | null => FIELD.get(k)?.vis || (SLOT.has(k) ? SLOT_VIS : null);
    const priceVis = (t: string) => FIELDS.find(f => f.store.t === 'price' && (f.store as any).target === t)?.vis || 'cost';
    return {
      sku: rec.sku,
      changes: changes.filter((c: any) => { const vis = visField(c.field); return vis ? lv.has(vis) : true; })
        .map((c: any) => ({ id: c.id, field: c.field, from: c.old_value, to: c.new_value, note: c.note, source: c.source, actor: { id: c.actor_id, name: c.actor_name }, at: c.created_at })),
      prices: prices.filter((p: any) => lv.has(priceVis(p.target) as Vis))
        .map((p: any) => ({ id: p.id, target: p.target, from: num(p.old_price), to: num(p.new_price), status: p.status, reason: p.reason, actor: { id: p.requested_by, name: p.actor_name }, at: p.created_at })),
    };
  });

  /* Uploads: the main image (everyone sees it) and the group-3 file slots (敏感 · 仅编辑者). PDF/PNG/JPG/WebP/CSV/TXT, 20 MB. */
  const slotVis = (slot: string): Vis | null => slot === 'mainImage' ? 'all' : SLOT.has(slot) ? SLOT_VIS : null;
  app.post('/products/records/:sku/files/:slot', { bodyLimit: Math.ceil(MAX_FILE_BYTES * 4 / 3) + 4096 }, async (req, reply) => {
    const u = actorOf(req), v = access(u), slot = String((req.params as any).slot || ''), vis = slotVis(slot);
    if (!vis) deny(404, 'FILE_SLOT_UNKNOWN', 'There is no such file slot');
    if (!canEditField(v, { vis: vis! })) deny(403, 'FILE_UPLOAD_FORBIDDEN', 'You cannot upload files here');
    const body = z.object({ name: z.string().trim().min(1).max(200), dataBase64: z.string().min(4) }).strict().parse(req.body);
    const data = Buffer.from(body.dataBase64, 'base64');
    if (!data.length || data.length > MAX_FILE_BYTES) deny(400, 'FILE_TOO_LARGE', 'A file may be at most 20 MB');
    const mime = fileType(body.name, data);
    if (!mime) deny(400, 'FILE_TYPE', 'Upload a PDF, PNG, JPG, WebP, CSV or TXT file; save Excel or Word files as PDF or CSV first');
    if (slot === 'mainImage' && !IMAGE_MIME.has(mime!)) deny(400, 'FILE_IMAGE_ONLY', 'The main image must be a PNG, JPG or WebP picture');
    if (SLOT.get(slot)?.pdfOnly && mime !== 'application/pdf') deny(400, 'FILE_PDF_ONLY', 'This slot only takes PDF files');
    const out = await db.transaction(async tx => {
      const rec = await one(tx, u.org_id, skuParam(req)), id = randomUUID();
      if (slot === 'mainImage') await tx.query(`DELETE FROM product_files WHERE org_id=$1 AND sku=$2 AND slot='mainImage'`, [u.org_id, rec.sku]);
      await tx.query('INSERT INTO product_files(id,org_id,sku,slot,name,mime,size,data,created_by) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)', [id, u.org_id, rec.sku, slot, body.name, mime, data.length, data, u.id]);
      await tx.query('INSERT INTO product_changes(id,org_id,sku,field,old_value,new_value,note,source,actor_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)',
        [randomUUID(), u.org_id, rec.sku, slot, 'null', JSON.stringify(body.name), '', 'file', u.id]);
      await audit(tx, u, 'products.file_added', rec.sku, { slot, name: body.name, size: data.length });
      return { id, slot, name: body.name, mime, size: data.length };
    });
    return reply.code(201).send(out);
  });
  const fileOf = async (u: User, v: Viewer, id: string) => {
    const r = (await db.query('SELECT * FROM product_files WHERE org_id=$1 AND id=$2', [u.org_id, id])).rows[0];
    const vis = r && slotVis(r.slot);
    if (!r || !vis || !levelsOf(v).has(vis)) deny(404, 'FILE_NOT_FOUND', 'File not found');
    return r;
  };
  app.get('/products/files/:id', async (req, reply) => {
    const u = actorOf(req), v = access(u), r = await fileOf(u, v, String((req.params as any).id || ''));
    const inline = IMAGE_MIME.has(r.mime) || r.mime === 'application/pdf';
    return reply.header('Content-Type', r.mime).header('Content-Security-Policy', "default-src 'none'; sandbox")
      .header('Content-Disposition', `${inline ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(r.name)}`).send(Buffer.from(r.data));
  });
  app.delete('/products/files/:id', async req => {
    const u = actorOf(req), v = access(u), r = await fileOf(u, v, String((req.params as any).id || ''));
    if (!canEditField(v, { vis: slotVis(r.slot)! })) deny(403, 'FILE_UPLOAD_FORBIDDEN', 'You cannot upload files here');
    await db.transaction(async tx => {
      await tx.query('DELETE FROM product_files WHERE org_id=$1 AND id=$2', [u.org_id, r.id]);
      await tx.query('INSERT INTO product_changes(id,org_id,sku,field,old_value,new_value,note,source,actor_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)',
        [randomUUID(), u.org_id, r.sku, r.slot, JSON.stringify(r.name), 'null', '', 'file', u.id]);
      await audit(tx, u, 'products.file_removed', r.sku, { slot: r.slot, name: r.name });
    });
    return { id: r.id, deleted: true };
  });
}

