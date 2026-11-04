/* 产品资料 bulk update: standard template → upload → preview with analysis → confirm → undo.
 *
 * Template: one column per field in spec order (only the fields the downloader may see), row 1 Chinese headers,
 * row 2 stable field keys, dropdowns for list fields, a 填写说明 sheet, and the current data filled in.
 * Upload (.xlsx or UTF-8 .csv): rows match by SKU (case-insensitive); a new SKU creates a product; a blank cell
 * means no change; [清空] clears a value. Upload never deletes products.
 * Preview saves nothing. Confirm applies every valid row in one transaction (or nothing); rows with errors are
 * skipped only when the admin chooses so. Each import keeps who/when/file/counts and the before values, so it can
 * be undone as long as nobody changed those values since. Who may import: products_manage or an executive. */
import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { Database, Queryable } from './db.js';
import type { User } from './auth.js';
import { deny, denyWith } from './errors.js';
import { priceOps } from './products.js';
import { FIELDS, FIELD, FAMILIES, GROUPS, VIS_NAMES, CORE_REQUIRED, CLEAR, levelsOf, canEditField, completeness, needOf, type FieldDef, type Issue, type Values, type Viewer } from './product-fields.js';
import { loadRecords, prepareChanges, writeChanges, viewerOf, priceInputs, type Rec } from './product-pim.js';
import { worksheetOf, configured, marginSummary, type Worksheet } from './pricing-sheet.js';
import { writeXlsx, readXlsx, writeCsv, readCsv, colName, FileFormatError, type Cell } from './xlsx.js';

export const importSchema = `
ALTER TABLE product_imports ADD COLUMN IF NOT EXISTS file_name text;
ALTER TABLE product_imports ADD COLUMN IF NOT EXISTS status text;
ALTER TABLE product_imports ADD COLUMN IF NOT EXISTS payload jsonb;
ALTER TABLE product_imports ADD COLUMN IF NOT EXISTS summary jsonb;
ALTER TABLE product_imports ADD COLUMN IF NOT EXISTS undo jsonb;
ALTER TABLE product_imports ADD COLUMN IF NOT EXISTS applied_at timestamptz;
ALTER TABLE product_imports ADD COLUMN IF NOT EXISTS undone_at timestamptz;
ALTER TABLE product_imports ADD COLUMN IF NOT EXISTS undone_by text;
`;
const SHEET = '产品资料', NOTES = '填写说明', MAX_ROWS = 5000, MAX_UPLOAD = 10 * 1024 * 1024, PREVIEW_HOURS = 24;
const SKU_REFS = ['dealer_order_lines', 'rma_cases', 'wms_items', 'wms_movements', 'wms_stock', 'product_files'];

/* ---------- columns ---------- */
type Col = { def: FieldDef; header: string };
const isTier = (k: string) => /^wh\d$/.test(k);
export function columnsFor(v: Viewer, w: Worksheet): Col[] {
  const lv = levelsOf(v);
  return FIELDS.filter(d => lv.has(d.vis) && d.type !== 'image' && (!isTier(d.key) || Number(d.key.slice(2)) <= w.whTiers.length)).map(d => ({
    def: d,
    header: (isTier(d.key) ? `批发价手动调整 · ${w.whTiers[Number(d.key.slice(2)) - 1].name}` : d.zh) + (d.unit ? ` (${d.unit})` : '') + (CORE_REQUIRED.has(d.key) ? ' *' : ''),
  }));
}
const display = (d: FieldDef, val: unknown): Cell => val == null ? null : d.options && d.type === 'enum' ? (d.options.find(o => o.value === val)?.zh ?? String(val)) : (val as Cell);
const NEED_ZH = { req: '必填', opt: '选填', na: '不适用' } as const;
const TYPE_ZH: Record<string, string> = { text: '文字', enum: '下拉选择', suggest: '文字（可选下拉建议）', date: '日期 YYYY-MM-DD', number: '数字', price: '金额（美元）', sku: 'SKU 格式', refb: '以 REFB- 开头', gtin: 'UPC 12 位 / EAN 13 位数字', hs: '6–10 位数字，可带点' };

export function templateSheets(v: Viewer, w: Worksheet, recs: Rec[]) {
  const cols = columnsFor(v, w);
  const rows: Cell[][] = [cols.map(c => c.header), cols.map(c => c.def.key)];
  for (const r of recs.sort((a, b) => a.sku.localeCompare(b.sku))) rows.push(cols.map(c => display(c.def, r.values[c.def.key])));
  const notes: Cell[][] = [
    ['OneLaser 产品资料 · 标准模板'], [],
    ['怎么填'],
    ['1. 第 1 行是中文表头，第 2 行是字段键（系统按它识别列），请不要改这两行；可以删掉不需要的列。'],
    ['2. 按 SKU 匹配：已有 SKU 更新，新 SKU 新建产品。SKU 不区分大小写。上传不会删除任何产品。'],
    [`3. 单元格留空 = 不修改。要清空一个值，请填 ${CLEAR}。`],
    ['4. 带 * 的列每个产品族都必填；其他列是否必填看下表（主机最全，其他产品族只有核心字段必填）。'],
    ['5. 下拉列只能填下拉里的值；数字列只填数字（单位见表头）；日期写成 2026-11-04。'],
    ['6. 上传后会先显示修改前后对比和分析，确认后才会写入；之后可在导入记录里撤销。'],
    ['7. 这份文件里只有你有权限看到的列，请勿外传。'], [],
    ['分组', '字段', '字段键', '格式 / 单位', '可选值', '可见级别', ...FAMILIES.map(f => f.zh)],
    ...cols.map(c => [GROUPS.find(g => g.key === c.def.group)?.zh ?? '', c.header.replace(/ \*$/, ''), c.def.key,
      TYPE_ZH[c.def.type] + (c.def.unit ? `（${c.def.unit}）` : ''), c.def.options ? c.def.options.map(o => o.zh).join(' / ') : '', VIS_NAMES[c.def.vis].zh,
      ...FAMILIES.map(f => NEED_ZH[needOf(c.def.req, f.key)!])]),
  ];
  return { cols, rows, notes };
}

/* ---------- reading an upload ---------- */
const blank = (c: Cell) => c == null || (typeof c === 'string' && c.trim() === '');
const normCell = (c: Cell): string | number | null => c == null ? null : typeof c === 'number' ? c : (/^'[=+@]/.test(c.trim()) ? c.trim().slice(1) : c.trim());
const headerKey = (s: string) => s.replace(/\s*\*\s*$/, '').replace(/\s*\([^()]*\)\s*$/, '').trim();
export function parseUpload(fileName: string, data: Buffer): Cell[][] {
  const ext = (fileName.split('.').pop() || '').toLowerCase();
  try {
    if (ext === 'xlsx') return readXlsx(data, [SHEET]);
    if (ext === 'csv') return readCsv(data);
  } catch (e) {
    if (e instanceof FileFormatError || (e as any)?.code?.startsWith?.('Z_') || e instanceof RangeError) deny(400, 'IMPORT_FILE_UNREADABLE', 'The file could not be read; upload the standard template as .xlsx or UTF-8 .csv');
    throw e;
  }
  deny(400, 'IMPORT_FILE_TYPE', 'Upload an .xlsx or .csv file');
}
type Mapped = { cols: Map<number, FieldDef>; headers: Map<number, string>; start: number; ignored: { column: string; header: string; reason: string }[] };
export function mapColumns(rows: Cell[][], v: Viewer, w: Worksheet): Mapped {
  const known = columnsFor({ executive: true, grants: [] }, { ...w, whTiers: Array.from({ length: 6 }, (_, i) => w.whTiers[i] || { name: `档位 ${i + 1}`, discount: 0 }) });
  let keyRow = -1;
  for (let r = 0; r < Math.min(rows.length, 6) && keyRow < 0; r++) if ((rows[r] || []).filter(c => typeof c === 'string' && FIELD.has(c.trim())).length >= 2) keyRow = r;
  const out: Mapped = { cols: new Map(), headers: new Map(), start: 0, ignored: [] };
  const byHeader = new Map(known.map(c => [headerKey(c.header), c.def]));
  const headerRow = keyRow >= 0 ? keyRow - 1 : 0;
  const width = Math.max(0, ...rows.slice(0, Math.max(keyRow, 0) + 1).map(r => (r || []).length));
  for (let ci = 0; ci < width; ci++) {
    const head = String(rows[headerRow]?.[ci] ?? '').trim(), key = keyRow >= 0 ? String(rows[keyRow]?.[ci] ?? '').trim() : '';
    const def = keyRow >= 0 ? FIELD.get(key) : byHeader.get(headerKey(head));
    const label = head || key;
    if (!label) continue;
    out.headers.set(ci, label);
    if (!def || def.type === 'image') { out.ignored.push({ column: colName(ci), header: label, reason: '不认识这一列，已忽略' }); continue; }
    if (isTier(def.key) && Number(def.key.slice(2)) > w.whTiers.length) { out.ignored.push({ column: colName(ci), header: label, reason: '价格参数里没有这个批发档位，已忽略' }); continue; }
    if (def.key !== 'sku' && !canEditField(v, def)) { out.ignored.push({ column: colName(ci), header: label, reason: '你没有修改这一列的权限，已忽略' }); continue; }
    if ([...out.cols.values()].includes(def)) { out.ignored.push({ column: colName(ci), header: label, reason: '重复的列，已忽略' }); continue; }
    out.cols.set(ci, def);
  }
  out.start = keyRow >= 0 ? keyRow + 1 : 1;
  if (![...out.cols.values()].some(d => d.key === 'sku')) deny(400, 'IMPORT_NO_SKU_COLUMN', 'The file has no SKU column; use the standard template');
  return out;
}

/* ---------- preview ---------- */
type RowIn = { row: number; input: Record<string, string | number | null> };
type RowOut = { row: number; sku: string; status: 'new' | 'update' | 'same' | 'error'; changes: { field: string; label: string; from: Cell; to: Cell }[]; errors: (Issue & { column: string; header: string })[]; warnings: Issue[] };
export function readRows(rows: Cell[][], m: Mapped): RowIn[] {
  const out: RowIn[] = [];
  for (let r = m.start; r < rows.length; r++) {
    const cells = rows[r] || [];
    if ([...m.cols.keys()].every(ci => blank(cells[ci]))) continue;
    const input: Record<string, string | number | null> = {};
    for (const [ci, d] of m.cols) if (!blank(cells[ci])) input[d.key] = normCell(cells[ci]);
    out.push({ row: r + 1, input });
  }
  if (out.length > MAX_ROWS) deny(400, 'IMPORT_TOO_MANY_ROWS', `A file may hold at most ${MAX_ROWS} products`, `一次最多导入 ${MAX_ROWS} 个产品，请拆成几个文件。`);
  return out;
}
const fingerprint = (recs: Map<string, Rec>, skus: string[]) =>
  createHash('sha256').update(JSON.stringify(skus.map(s => [s, recs.get(s)?.values ?? null]))).digest('hex');

export function evaluate(v: Viewer, w: Worksheet, recs: Map<string, Rec>, input: RowIn[], m: Mapped) {
  const colOf = new Map([...m.cols].map(([ci, d]) => [d.key, { column: colName(ci), header: m.headers.get(ci) || d.zh }]));
  const where = (field: string) => colOf.get(field) || { column: '', header: FIELD.get(field)?.zh || field };
  const fileSkus = new Map<string, number>(), refbs = new Map<string, string>();
  for (const r of recs.values()) if (r.values.refbSku) refbs.set(String(r.values.refbSku).toLowerCase(), r.sku.toLowerCase());
  const known = new Set([...recs.keys(), ...input.map(r => String(r.input.sku ?? '').trim().toLowerCase()).filter(Boolean)]);
  const rows: RowOut[] = [];
  for (const r of input) {
    const sku = String(r.input.sku ?? '').trim(), low = sku.toLowerCase(), before = recs.get(low);
    const out: RowOut = { row: r.row, sku: before?.sku || sku, status: 'same', changes: [], errors: [], warnings: [] };
    const err = (i: Issue) => out.errors.push({ ...i, ...where(i.field) });
    if (!sku) err({ field: 'sku', code: 'FIELD_REQUIRED', zh: '缺少 SKU', en: 'The SKU is missing' });
    else if (fileSkus.has(low)) err({ field: 'sku', code: 'SKU_DUPLICATE_FILE', zh: `SKU 在文件里重复（第 ${fileSkus.get(low)} 行已有）`, en: `This SKU is already on row ${fileSkus.get(low)}` });
    else fileSkus.set(low, r.row);
    if (sku && !out.errors.length) {
      const p = prepareChanges(v, before?.values ?? null, r.input, { knownSkus: known });
      p.issues.forEach(err);
      out.warnings = p.warnings;
      const refb = p.changes.refbSku ? String(p.changes.refbSku).toLowerCase() : null;
      if (refb && refbs.has(refb) && refbs.get(refb) !== low) err({ field: 'refbSku', code: 'REFB_DUPLICATE', zh: '这个退货 SKU 已被其他产品使用', en: 'Another product already uses this refurbished SKU' });
      else if (refb) refbs.set(refb, low);
      out.changes = Object.entries(p.changes).filter(([k]) => before || k !== 'sku').map(([k, to]) => {
        const d = FIELD.get(k)!;
        return { field: k, label: (colOf.get(k)?.header || d.zh).replace(/\s*\*$/, ''), from: display(d, before?.values[k] ?? null), to: display(d, to) };
      });
      (out as any)._changes = p.changes;
    }
    out.status = out.errors.length ? 'error' : !before ? 'new' : out.changes.length ? 'update' : 'same';
    rows.push(out);
  }
  return rows;
}

const pctChange = (a: number, b: number) => a ? (b - a) / a : null;
const round4 = (x: number | null) => x == null ? null : Math.round(x * 10000) / 10000;
export function analyze(v: Viewer, w: Worksheet, recs: Map<string, Rec>, rows: RowOut[], canCost: boolean) {
  const lv = levelsOf(v), ok = rows.filter(r => r.status !== 'error');
  const afterOf = new Map(ok.map(r => [r.sku.toLowerCase(), { ...(recs.get(r.sku.toLowerCase())?.values || {}), ...((r as any)._changes || {}) } as Values]));
  const comp = (vals: Values, files: Record<string, number>) => completeness(vals, { visible: lv, files });
  let needB = 0, gotB = 0, needA = 0, gotA = 0, doneB = 0, doneA = 0;
  for (const [k, r] of recs) {
    const b = comp(r.values, r.files), a = afterOf.has(k) ? comp(afterOf.get(k)!, r.files) : b;
    needB += b.need; gotB += b.got; doneB += b.got >= b.need ? 1 : 0; needA += a.need; gotA += a.got; doneA += a.got >= a.need ? 1 : 0;
  }
  for (const r of ok.filter(r => r.status === 'new')) { const a = comp(afterOf.get(r.sku.toLowerCase())!, {}); needA += a.need; gotA += a.got; doneA += a.got >= a.need ? 1 : 0; }
  const statusChanges: Record<string, number> = {};
  for (const r of ok) { const c = r.changes.find(x => x.field === 'status'); if (c && r.status === 'update') { const k = `${c.from ?? '未标注'} → ${c.to ?? '未标注'}`; statusChanges[k] = (statusChanges[k] || 0) + 1; } }
  const priceKeys = ['msrp', 'map', ...FIELDS.filter(d => isTier(d.key) && Number(d.key.slice(2)) <= w.whTiers.length).map(d => d.key)].filter(k => lv.has(FIELD.get(k)!.vis));
  const prices = priceKeys.map(k => {
    let changed = 0, set = 0, cleared = 0, sum = 0, n = 0, max: { sku: string; pct: number } | null = null;
    for (const r of ok) {
      const from = recs.get(r.sku.toLowerCase())?.values[k], ch = (r as any)._changes || {};
      if (!(k in ch)) continue;
      const to = ch[k];
      changed++;
      if (from == null) { set++; continue; }
      if (to == null) { cleared++; continue; }
      const p = pctChange(Number(from), Number(to));
      if (p == null) continue;
      sum += p; n++;
      if (!max || Math.abs(p) > Math.abs(max.pct)) max = { sku: r.sku, pct: round4(p)! };
    }
    const label = isTier(k) ? `批发 · ${w.whTiers[Number(k.slice(2)) - 1].name}` : FIELD.get(k)!.zh;
    return { field: k, label, changed, newlySet: set, cleared, averagePct: n ? round4(sum / n) : null, largest: max };
  }).filter(p => p.changed);
  const byFamily: Record<string, number> = {};
  for (const r of ok.filter(r => r.status === 'new')) { const f = FAMILIES.find(x => x.key === afterOf.get(r.sku.toLowerCase())!.family)?.zh || '未选择'; byFamily[f] = (byFamily[f] || 0) + 1; }
  let margins: any = null;
  if (canCost && configured(w)) {
    const touched = ok.filter(r => r.status !== 'same').map(r => r.sku.toLowerCase());
    const stats = (get: (k: string) => Values | undefined) => {
      let s = 0, n = 0, dtc = 0, wh = 0;
      for (const k of touched) { const vals = get(k); if (!vals) continue; const m = marginSummary(w, priceInputs(vals)); if (m.msrpCmPct != null) { s += m.msrpCmPct; n++; } if (m.belowDtcFloor) dtc++; if (m.belowWholesaleFloor) wh++; }
      return { averageMsrpCmPct: n ? round4(s / n) : null, belowDtcFloor: dtc, belowWholesaleFloor: wh };
    };
    margins = { products: touched.length, before: stats(k => recs.get(k)?.values), after: stats(k => afterOf.get(k)), dtcFloorPct: w.dtcFloor, wholesaleFloorPct: w.whFloor };
  } else if (canCost) margins = { notConfigured: true };
  return {
    totals: { rows: rows.length, new: rows.filter(r => r.status === 'new').length, updated: rows.filter(r => r.status === 'update').length,
      unchanged: rows.filter(r => r.status === 'same').length, errors: rows.filter(r => r.status === 'error').length,
      fieldsChanged: ok.reduce((s, r) => s + r.changes.length, 0), warnings: ok.reduce((s, r) => s + r.warnings.length, 0) },
    completeness: { before: { need: needB, got: gotB, pct: needB ? round4(gotB / needB) : null, completeProducts: doneB, products: recs.size },
      after: { need: needA, got: gotA, pct: needA ? round4(gotA / needA) : null, completeProducts: doneA, products: recs.size + ok.filter(r => r.status === 'new').length } },
    statusChanges, prices, margins, newByFamily: byFamily,
  };
}
const publicRow = (r: RowOut) => { const { _changes, ...rest } = r as any; return rest as RowOut; };

/* ---------- routes ---------- */
export async function registerImportRoutes(app: FastifyInstance, db: Database, o: { isAdmin: (u: User) => boolean; now?: () => number }) {
  const now = o.now || Date.now;
  const actorOf = (req: FastifyRequest): User => req.actor || deny(401, 'UNAUTHENTICATED', 'Authentication is required');
  const canPricing = (u: User) => o.isAdmin(u) || viewerOf(u, o.isAdmin).grants.includes('product_cost_detail');
  const ops = priceOps(db, { isAdmin: o.isAdmin, canPricing });
  const importer = (u: User) => {
    const v = viewerOf(u, o.isAdmin);
    if (!levelsOf(v).has('all')) deny(403, 'PRODUCTS_FORBIDDEN', 'You do not have access to the product area');
    if (!v.executive && !v.grants.includes('products_manage')) deny(403, 'CATALOG_IMPORT_FORBIDDEN', 'Only product managers or administrators can import the catalog');
    return v;
  };
  const audit = (tx: Queryable, u: User, action: string, objectId: string, details: unknown) =>
    tx.query('INSERT INTO audit_events(id,org_id,department_id,owner_id,actor_id,action,object_id,details) VALUES($1,$2,$3,$4,$5,$6,$7,$8)',
      [randomUUID(), u.org_id, u.department_id, u.id, u.id, action, objectId, JSON.stringify(details)]);
  const stamp = () => new Date(now()).toISOString().slice(0, 10);

  app.get('/products/template', async (req, reply) => {
    const u = actorOf(req), v = importer(u);
    const format = z.enum(['xlsx', 'csv']).default('xlsx').parse((req.query as any)?.format);
    const w = worksheetOf(await ops.rulesFor(u.org_id)), recs = [...(await loadRecords(db, u.org_id)).values()];
    const t = templateSheets(v, w, recs);
    await db.transaction(tx => audit(tx, u, 'products.template_download', u.org_id, { format, columns: t.cols.length, rows: recs.length }));
    const file = format === 'csv' ? writeCsv(t.rows) : writeXlsx([
      { name: SHEET, rows: t.rows, headerRows: 2, freeze: { rows: 2, cols: 1 }, widths: t.cols.map(c => Math.min(40, Math.max(12, c.header.length * 2 + 2))),
        textCols: t.cols.map((c, i) => ['text', 'sku', 'refb', 'gtin', 'hs', 'suggest', 'date'].includes(c.def.type) ? i : -1).filter(i => i >= 0),
        lists: t.cols.map((c, i) => c.def.options ? { col: i, values: c.def.options.map(x => x.zh), strict: c.def.type === 'enum' } : null).filter(Boolean) as any },
      { name: NOTES, rows: t.notes, widths: [16, 30, 16, 24, 40, 16, 10, 10, 10, 10, 10] },
    ]);
    const name = `OneLaser_产品资料_${stamp()}.${format}`;
    return reply.header('Content-Type', format === 'csv' ? 'text/csv; charset=utf-8' : 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
      .header('Content-Disposition', `attachment; filename="products.${format}"; filename*=UTF-8''${encodeURIComponent(name)}`).send(file);
  });

  /* Upload → preview. Nothing is written to the products; the parsed rows are kept for the confirm step. */
  const uploadBody = z.object({ fileName: z.string().trim().min(1).max(200), dataBase64: z.string().min(4) }).strict();
  const build = async (q: Queryable, u: User, v: Viewer, input: RowIn[], m: Mapped) => {
    const recs = await loadRecords(q, u.org_id), w = worksheetOf(await ops.rulesFor(u.org_id, q));
    const rows = evaluate(v, w, recs, input, m);
    const skus = [...new Set(rows.map(r => r.sku.toLowerCase()))].sort();
    return { recs, w, rows, fp: fingerprint(recs, skus), analysis: analyze(v, w, recs, rows, canPricing(u)) };
  };
  app.post('/products/imports/preview', { bodyLimit: Math.ceil(MAX_UPLOAD * 4 / 3) + 4096 }, async (req, reply) => {
    const u = actorOf(req), v = importer(u), body = uploadBody.parse(req.body);
    const data = Buffer.from(body.dataBase64, 'base64');
    if (!data.length || data.length > MAX_UPLOAD) deny(400, 'IMPORT_FILE_TOO_LARGE', 'The file may be at most 10 MB');
    const w = worksheetOf(await ops.rulesFor(u.org_id));
    const cells = parseUpload(body.fileName, data), m = mapColumns(cells, v, w), input = readRows(cells, m);
    if (!input.length) deny(400, 'IMPORT_EMPTY', 'The file has no product rows');
    const b = await build(db, u, v, input, m), id = randomUUID();
    const mapping = { cols: [...m.cols].map(([ci, d]) => [ci, d.key]), headers: [...m.headers], start: m.start, ignored: m.ignored };
    await db.query(`INSERT INTO product_imports(id,org_id,kind,rows,created_by,file_name,status,payload,summary) VALUES($1,$2,'pim',$3,$4,$5,'preview',$6,$7)`,
      [id, u.org_id, input.length, u.id, body.fileName, JSON.stringify({ input, mapping, fingerprint: b.fp, rows: b.rows.map(publicRow) }), JSON.stringify(b.analysis)]);
    return reply.code(201).send({ id, fileName: body.fileName, ignoredColumns: m.ignored, analysis: b.analysis, rows: b.rows.map(publicRow),
      expiresAt: new Date(now() + PREVIEW_HOURS * 3600_000).toISOString(), canConfirm: b.analysis.totals.errors === 0, canSkipErrors: b.analysis.totals.errors > 0 && b.rows.some(r => r.status !== 'error' && r.status !== 'same') });
  });

  const importOf = async (q: Queryable, u: User, id: string, lock = false) => {
    const r = (await q.query(`SELECT * FROM product_imports WHERE org_id=$1 AND id=$2 AND kind='pim'${lock ? ' FOR UPDATE' : ''}`, [u.org_id, id])).rows[0];
    if (!r || (r.created_by !== u.id && !o.isAdmin(u))) deny(404, 'IMPORT_NOT_FOUND', 'This import does not exist');
    return r;
  };
  const restoreMapping = (p: any): Mapped => ({ cols: new Map(p.cols.map(([ci, k]: [number, string]) => [ci, FIELD.get(k)!])), headers: new Map(p.headers), start: p.start, ignored: p.ignored });

  app.post('/products/imports/:id/confirm', async req => {
    const u = actorOf(req), v = importer(u);
    const body = z.object({ skipErrors: z.boolean().default(false) }).strict().parse(req.body ?? {});
    return db.transaction(async tx => {
      const imp = await importOf(tx, u, String((req.params as any).id), true);
      if (imp.status !== 'preview') deny(409, 'IMPORT_NOT_PREVIEW', 'This import has already been confirmed or undone');
      if (imp.created_by !== u.id) deny(403, 'IMPORT_CONFIRM_FORBIDDEN', 'Only the person who uploaded the file can confirm it');
      if (now() - new Date(imp.created_at).getTime() > PREVIEW_HOURS * 3600_000) deny(409, 'IMPORT_EXPIRED', 'This preview has expired; upload the file again');
      await tx.query(`SELECT pg_advisory_xact_lock(hashtext('product_import:' || $1))`, [u.org_id]);
      const b = await build(tx, u, v, imp.payload.input, restoreMapping(imp.payload.mapping));
      if (b.fp !== imp.payload.fingerprint) deny(409, 'IMPORT_STALE', 'Products changed since the preview; upload the file again to see the current differences');
      const bad = b.rows.filter(r => r.status === 'error');
      if (bad.length && !body.skipErrors) denyWith(409, 'IMPORT_HAS_ERRORS', 'Some rows have errors', `有 ${bad.length} 行有错误。请修改后重新上传，或选择“跳过错误行，更新其余”。`, { rows: bad.map(r => r.row) });
      const undo: any[] = [], priceMode = v.executive ? 'apply' as const : 'request' as const;
      for (const r of b.rows) {
        if (r.status === 'error' || r.status === 'same') continue;
        const ch = (r as any)._changes as Values, before = b.recs.get(r.sku.toLowerCase())?.values ?? null;
        const sku = before ? b.recs.get(r.sku.toLowerCase())!.sku : String(ch.sku);
        const w = await writeChanges(tx, u, ops, sku, before, ch, { source: 'import', importId: imp.id, note: imp.file_name, priceMode });
        const pending = Object.entries(w.prices).filter(([, p]: any) => p?.status === 'pending').map(([k, p]: any) => ({ field: k, id: p.id }));
        const keys = Object.keys(ch).filter(k => k !== 'sku');
        undo.push({ sku, created: !before, before: Object.fromEntries(keys.map(k => [k, before ? before[k] ?? null : null])),
          after: Object.fromEntries(keys.filter(k => !pending.some(p => p.field === k)).map(k => [k, ch[k] ?? null])), pending });
      }
      const counts = { created: undo.filter(x => x.created).length, updated: undo.filter(x => !x.created).length, skipped: bad.length, unchanged: b.rows.filter(r => r.status === 'same').length,
        pendingPrices: undo.reduce((s, x) => s + x.pending.length, 0) };
      await tx.query(`UPDATE product_imports SET status='applied',applied_at=now(),undo=$3,summary=$4 WHERE org_id=$1 AND id=$2`,
        [u.org_id, imp.id, JSON.stringify(undo), JSON.stringify({ ...b.analysis, applied: counts })]);
      await audit(tx, u, 'products.pim_import', imp.id, { file: imp.file_name, ...counts });
      return { id: imp.id, status: 'applied', ...counts };
    });
  });

  app.get('/products/imports', async req => {
    const u = actorOf(req), v = importer(u);
    const rows = (await db.query(`SELECT i.id,i.file_name,i.status,i.rows,i.summary,i.created_by,i.created_at,i.applied_at,i.undone_at,i.undone_by,
      (SELECT COALESCE(NULLIF(display_name,''),NULLIF(name_zh,''),NULLIF(name_en,''),id) FROM users WHERE id=i.created_by) AS who
      FROM product_imports i WHERE i.org_id=$1 AND i.kind='pim' AND i.status IN ('applied','undone') AND ($2::boolean OR i.created_by=$3) ORDER BY i.created_at DESC LIMIT 100`, [u.org_id, v.executive, u.id])).rows;
    return { items: rows.map((r: any) => ({ id: r.id, fileName: r.file_name, status: r.status, rows: r.rows, counts: r.summary?.applied || null, by: { id: r.created_by, name: r.who },
      at: r.applied_at || r.created_at, undoneAt: r.undone_at, canUndo: r.status === 'applied' })) };
  });

  /* The preview as a CSV report (row, SKU, result, field, before, after, problem). */
  app.get('/products/imports/:id/report', async (req, reply) => {
    const u = actorOf(req); importer(u);
    const imp = await importOf(db, u, String((req.params as any).id));
    const label = { new: '新增', update: '更新', same: '无变化', error: '有错误' } as const;
    const out: Cell[][] = [['行号', 'SKU', '结果', '字段', '修改前', '修改后', '问题']];
    for (const r of imp.payload.rows as RowOut[]) {
      if (r.status === 'error') for (const e of r.errors) out.push([r.row, r.sku, label.error, e.header, null, null, `${e.column ? e.column + ' 列：' : ''}${e.zh}`]);
      else if (!r.changes.length) out.push([r.row, r.sku, label[r.status], null, null, null, null]);
      else for (const c of r.changes) out.push([r.row, r.sku, label[r.status], c.label, c.from, c.to, null]);
      for (const wn of r.warnings || []) out.push([r.row, r.sku, '提醒', FIELD.get(wn.field)?.zh || wn.field, null, null, wn.zh]);
    }
    return reply.header('Content-Type', 'text/csv; charset=utf-8').header('Content-Disposition', `attachment; filename="import-report.csv"; filename*=UTF-8''${encodeURIComponent('导入预览_' + (imp.file_name || '') + '.csv')}`).send(writeCsv(out));
  });

  /* Undo: restores the before values, provided nobody changed those fields since. Products the import created are
   * removed again only while nothing else (stock, orders, RMA, files) refers to them. All or nothing. */
  app.post('/products/imports/:id/undo', async req => {
    const u = actorOf(req), v = importer(u);
    return db.transaction(async tx => {
      const imp = await importOf(tx, u, String((req.params as any).id), true);
      if (imp.status !== 'applied') deny(409, 'IMPORT_NOT_APPLIED', 'Only a confirmed import can be undone');
      await tx.query(`SELECT pg_advisory_xact_lock(hashtext('product_import:' || $1))`, [u.org_id]);
      const undo: any[] = imp.undo || [], recs = await loadRecords(tx, u.org_id, undo.map(x => x.sku)), conflicts: { sku: string; field: string; zh: string }[] = [];
      for (const x of undo) {
        const cur = recs.get(x.sku.toLowerCase());
        if (!cur) { conflicts.push({ sku: x.sku, field: 'sku', zh: '产品已不存在' }); continue; }
        for (const [k, val] of Object.entries(x.after)) if (JSON.stringify(cur.values[k] ?? null) !== JSON.stringify(val ?? null)) conflicts.push({ sku: x.sku, field: k, zh: `「${FIELD.get(k)?.zh || k}」在导入后又被修改过` });
        if (x.created) for (const t of SKU_REFS) if ((await tx.query(t === 'dealer_order_lines'
          ? `SELECT 1 FROM dealer_order_lines l JOIN dealer_orders d ON d.id=l.order_id WHERE d.org_id=$1 AND lower(l.sku)=lower($2) LIMIT 1`
          : `SELECT 1 FROM ${t} WHERE org_id=$1 AND lower(sku)=lower($2) LIMIT 1`, [u.org_id, x.sku])).rows.length) conflicts.push({ sku: x.sku, field: 'sku', zh: '这个新建的产品已经有库存、订单、维修或文件记录' });
      }
      if (conflicts.length) denyWith(409, 'IMPORT_UNDO_CONFLICT', 'Some values changed after the import; undo would overwrite them', `有 ${conflicts.length} 处在导入后又被修改，不能整体撤销：${conflicts.slice(0, 3).map(c => c.sku + ' ' + c.zh).join('；')}`, { conflicts });
      for (const x of undo) {
        for (const p of x.pending) await tx.query(`UPDATE product_price_changes SET status='withdrawn',decided_at=now(),decision_note='import undone' WHERE org_id=$1 AND id=$2 AND status='pending'`, [u.org_id, p.id]);
        if (x.created) {
          for (const t of ['product_channel_prices', 'product_pricing', 'product_catalog']) await tx.query(`DELETE FROM ${t} WHERE org_id=$1 AND sku=$2`, [u.org_id, x.sku]);
          await tx.query(`UPDATE product_price_changes SET status='withdrawn',decided_at=now(),decision_note='import undone' WHERE org_id=$1 AND sku=$2 AND status='pending'`, [u.org_id, x.sku]);
          continue;
        }
        const cur = recs.get(x.sku.toLowerCase())!, back = Object.fromEntries(Object.keys(x.after).map(k => [k, x.before[k] ?? null]));
        await writeChanges(tx, u, ops, cur.sku, cur.values, back, { source: 'undo', importId: imp.id, note: imp.file_name, priceMode: 'apply' });
      }
      await tx.query(`UPDATE product_imports SET status='undone',undone_at=now(),undone_by=$3 WHERE org_id=$1 AND id=$2`, [u.org_id, imp.id, u.id]);
      await audit(tx, u, 'products.pim_import_undone', imp.id, { products: undo.length, by: v.executive ? 'executive' : 'importer' });
      return { id: imp.id, status: 'undone', products: undo.length };
    });
  });
}
