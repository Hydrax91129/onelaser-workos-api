/* Bulk template, upload preview, confirm and undo for the product library (产品资料库).
 *
 *   GET  /products/library/template?format=xlsx|csv   standard file: every field the downloader may see, in spec order,
 *        Chinese headers, a hidden row of field keys, dropdowns, a 说明 sheet and the current data
 *   POST /products/library/import/preview              admins upload .xlsx or .csv; nothing is written. Returns per-row status
 *        (新增 / 更新 / 无变化 / 有错误), the changed fields old → new, errors with row/column/reason and an analysis
 *   GET  /products/library/import/:id/report           the preview as a CSV report
 *   POST /products/library/import/:id/confirm          applies everything in one transaction, or nothing; error rows are
 *        skipped only with skipErrors. If the data changed after the preview, the admin must preview again.
 *   GET  /products/library/imports                     import history (who / when / file / counts)
 *   POST /products/library/imports/:id/undo            restores the before values (fields changed since are left alone and listed)
 * Matching is by SKU (case-insensitive). A blank cell means no change, [清空] clears. Uploads never delete products. */
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { Database, Queryable } from './db.js';
import type { User } from './auth.js';
import { deny } from './errors.js';
import {
  FAMILIES, FIELD, GROUPS, CLEAR, CORE_REQUIRED, VIS_NAMES, allFields, canSee, canWrite, completeness, enumLabel, famCode, parseValue, viewerOf, relationIssues,
  type Field, type Viewer,
} from './product-spec.js';
import { worksheet, type Worksheet } from './product-worksheet.js';
import { loadRecords, findRec, worksheetOf, writeRecord, validateValues, recordIssues, same, type Rec, type WriteOpts, type Change } from './product-library.js';
import { readCsv, readXlsx, writeCsv, writeXlsx, colName } from './xlsx.js';

export const productImportSchema = `
ALTER TABLE product_imports ADD COLUMN IF NOT EXISTS file_name text;
ALTER TABLE product_imports ADD COLUMN IF NOT EXISTS summary jsonb;
ALTER TABLE product_imports ADD COLUMN IF NOT EXISTS changes jsonb;
ALTER TABLE product_imports ADD COLUMN IF NOT EXISTS undone_at timestamptz;
ALTER TABLE product_imports ADD COLUMN IF NOT EXISTS undone_by text;
ALTER TABLE product_imports ADD COLUMN IF NOT EXISTS undo_result jsonb;
CREATE TABLE IF NOT EXISTS product_import_previews(id text PRIMARY KEY, org_id text NOT NULL, created_by text NOT NULL, file_name text NOT NULL,
  cells jsonb NOT NULL, result jsonb NOT NULL, used_at timestamptz, created_at timestamptz NOT NULL DEFAULT now());
`;

const SHEET = '产品资料';
const MAX_ROWS = 5000;
const REQ_ZH: Record<string, string> = { req: '必填', opt: '选填', na: '不适用' };
const header = (f: Field) => f.zh + (f.unit ? `（${f.unit}）` : f.type === 'price' ? '（USD）' : '');
/** Template columns: everything the viewer may see except the main image (uploaded on the product page). */
// SKU 管理 and 定价管理 each download their own template: pricing groups (4, 5) go only into the pricing one, which keeps
// the identifying columns (SKU, family, names) so each row is easy to recognise. Upload accepts either file.
export type TemplateScope = 'all' | 'sku' | 'pricing';
const PRICING_GROUPS = new Set(['4', '5']), PRICING_ID = new Set(['sku', 'family', 'nameZh', 'nameEn']);
const inScope = (f: Field, scope: TemplateScope) => scope === 'all' || (scope === 'pricing' ? PRICING_GROUPS.has(f.group) || PRICING_ID.has(f.key) : !PRICING_GROUPS.has(f.group));
export const templateFields = (v: Viewer, ws: Worksheet, scope: TemplateScope = 'all') => allFields(ws.whTiers).filter(f => f.type !== 'image' && canSee(v, f.vis) && inScope(f, scope));
const cellOf = (f: Field, val: any) => val == null ? '' : f.type === 'enum' ? enumLabel(f, val) : val;

export function templateRows(v: Viewer, ws: Worksheet, recs: Rec[], scope: TemplateScope = 'all') {
  const fields = templateFields(v, ws, scope);
  return { fields, rows: [fields.map(header), fields.map(f => f.key), ...recs.map(r => fields.map(f => cellOf(f, r.values[f.key])))] };
}
function notesSheet(fields: Field[]) {
  const famHead = FAMILIES.map(f => f[1]);
  return {
    name: '说明', boldRows: [1, 11], widths: [16, 30, 18, 14, 40, 9, 11, 9, 11, 11, 16],
    rows: [
      ['OneLaser 产品资料库 · 批量更新说明'],
      ['1. 第 1 行是中文表头，第 2 行（已隐藏）是字段键，请勿修改或删除这两行；从第 3 行开始每行一个产品。'],
      ['2. 按 SKU 匹配（不区分大小写）：已有的 SKU 会更新，新的 SKU 会新增。上传不会删除任何产品。'],
      [`3. 单元格留空 = 不修改；要清空某个值，请填 ${CLEAR}。核心字段（SKU、大货/退货、产品族、中文名、英文名、状态）不能清空。`],
      ['4. 新增产品必须填 产品族、中文名、英文名；大货/退货 留空按“大货”，状态 留空按“开发中”。退货产品必须填以 REFB- 打头的退货 SKU。'],
      ['5. 下拉框列只能选列表里的值；日期写成 YYYY-MM-DD；重量、尺寸、价格只填数字（单位见表头）。'],
      ['6. 上传后系统先给出“更新前后对比与分析”，管理员点击“确认更新”之前不会写入任何数据；确认后可在导入记录里撤销。'],
      ['7. 产品主图和文件（说明书、认证等）请在产品编辑页上传，不在这个表格里。'],
      ['8. 这个文件只包含你有权限查看的列；请勿转发给没有相应权限的人。'],
      [],
      ['分组', '字段', '字段键', '类型 / 单位', '可选值', ...famHead, '可见范围'],
      ...fields.map(f => [
        GROUPS.find(g => g.no === f.group)?.zh || '', f.zh, f.key,
        f.type === 'number' ? `数字（${f.unit}）` : f.type === 'price' ? '价格（USD）' : f.type === 'date' ? '日期 YYYY-MM-DD' : f.type === 'enum' ? '下拉选择' : f.type === 'list' ? '文字（可选建议值）' : '文字',
        f.opts ? (f.opts as any[]).map(o => Array.isArray(o) ? o[1] : o).join(' / ') : f.key === 'refbSku' ? 'REFB- 打头' : f.ph ? `例：${f.ph}` : '',
        ...FAMILIES.map(([k]) => f.key === 'refbSku' ? '退货时必填' : REQ_ZH[famCode(f.code, k) || 'na']),
        VIS_NAMES[f.vis][0],
      ]),
    ],
  };
}
export function buildTemplate(format: 'xlsx' | 'csv', v: Viewer, ws: Worksheet, recs: Rec[], scope: TemplateScope = 'all') {
  const { fields, rows } = templateRows(v, ws, recs, scope);
  if (format === 'csv') return Buffer.from(writeCsv(rows), 'utf8');
  const last = Math.max(rows.length + 500, 1000);
  return writeXlsx([
    { name: SHEET, rows, boldRows: [1], hiddenRows: [2], freeze: { rows: 2, cols: 1 }, widths: fields.map(f => Math.min(36, Math.max(12, header(f).length * 2 + 2))),
      lists: fields.flatMap((f, col) => f.type === 'enum' || f.type === 'list' ? [{ col, firstRow: 3, lastRow: last, strict: f.type === 'enum',
        values: (f.opts as any[]).map(o => Array.isArray(o) ? o[1] : o) }] : []) },
    notesSheet(fields),
  ]);
}

/* ---------- parsing an upload ---------- */
type Cells = { row: number; cells: Record<string, unknown> };
export function parseUpload(fileName: string, data: Buffer, ws: Worksheet) {
  const lower = fileName.toLowerCase();
  let grid: (string | number | null)[][];
  try {
    if (lower.endsWith('.xlsx')) grid = readXlsx(data, SHEET);
    else if (lower.endsWith('.csv')) grid = readCsv(data.toString('utf8'));
    else return deny(400, 'IMPORT_FILE_TYPE', 'Upload the template as .xlsx or .csv (UTF-8)');
  } catch { return deny(400, 'IMPORT_FILE_UNREADABLE', 'This file cannot be read; download the standard template and fill it in'); }
  const fields = allFields(ws.whTiers), byKey = new Map(fields.map(f => [f.key, f]));
  const byHeader = new Map<string, string>([...fields.map(f => [header(f), f.key] as [string, string]), ...fields.map(f => [f.zh, f.key] as [string, string])]);
  const str = (c: any) => c == null ? '' : String(c).trim();
  // The key row is the hidden second row of the template; without it, columns are matched by their Chinese header.
  let keyRow = -1, map: (string | null)[] = [];
  for (let i = 0; i < Math.min(5, grid.length); i++) {
    const keys = (grid[i] || []).map(str);
    if (keys.includes('sku') && keys.filter(k => byKey.has(k)).length >= 2) { keyRow = i; map = keys.map(k => byKey.has(k) ? k : null); break; }
  }
  let headerRow = keyRow > 0 ? keyRow - 1 : -1;
  if (keyRow < 0) {
    for (let i = 0; i < Math.min(5, grid.length); i++) {
      const h = (grid[i] || []).map(str);
      if (h.some(x => byHeader.get(x) === 'sku')) { headerRow = i; map = h.map(x => byHeader.get(x) || null); break; }
    }
    if (headerRow < 0) deny(400, 'IMPORT_NO_HEADER', 'The SKU column was not found; keep the first two rows of the standard template');
  }
  const headers = (grid[headerRow] || []).map(str);
  const seen = new Set<string>(), ignored: string[] = [];
  map = map.map((k, i) => { if (!k) { if (str((grid[keyRow >= 0 ? keyRow : headerRow] || [])[i])) ignored.push(headers[i] || str((grid[keyRow] || [])[i])); return null; }
    if (seen.has(k)) deny(400, 'IMPORT_DUPLICATE_COLUMN', `The column ${k} appears twice`, `「${byKey.get(k)!.zh}」这一列出现了两次`); seen.add(k); return k; });
  const start = Math.max(keyRow, headerRow) + 1, rows: Cells[] = [];
  for (let r = start; r < grid.length; r++) {
    const line = grid[r] || [], cells: Record<string, unknown> = {};
    let any = false;
    map.forEach((k, i) => { if (!k) return; const c = line[i]; if (c == null || (typeof c === 'string' && c.trim() === '')) return; cells[k] = typeof c === 'string' ? c.trim() : c; any = true; });
    if (any) rows.push({ row: r + 1, cells });
  }
  if (!rows.length) deny(400, 'IMPORT_EMPTY', 'The file has no product rows');
  if (rows.length > MAX_ROWS) deny(400, 'IMPORT_TOO_MANY_ROWS', `Import at most ${MAX_ROWS} products at a time`, `一次最多导入 ${MAX_ROWS} 个产品`);
  const columns = map.map((k, i) => k ? { key: k, col: colName(i), header: headers[i] || header(byKey.get(k)!) } : null).filter(Boolean) as { key: string; col: string; header: string }[];
  return { rows, columns, ignored: ignored.filter(Boolean) };
}

/* ---------- the diff and its analysis ---------- */
type RowError = { col: string; header: string; key: string; zh: string; en: string };
export type RowResult = { row: number; sku: string; status: 'new' | 'update' | 'same' | 'error'; family?: string | null; changes: Change[]; errors: RowError[]; warnings: { key: string; zh: string; en: string }[]; values?: Record<string, any> };
const pctChange = (a: number | null, b: number | null) => a == null || b == null || !a ? null : (b - a) / a * 100;
function priceStats(pairs: { sku: string; from: number | null; to: number | null }[]) {
  const ch = pairs.filter(p => !same(p.from, p.to));
  const pcts = ch.map(p => ({ sku: p.sku, pct: pctChange(p.from, p.to) })).filter(p => p.pct != null) as { sku: string; pct: number }[];
  const max = pcts.reduce<{ sku: string; pct: number } | null>((m, p) => !m || Math.abs(p.pct) > Math.abs(m.pct) ? p : m, null);
  return { changed: ch.length, avgPct: pcts.length ? pcts.reduce((s, p) => s + p.pct, 0) / pcts.length : null, max };
}

export function diffUpload(v: Viewer, ws: Worksheet, recs: Map<string, Rec>, parsed: { rows: Cells[]; columns: { key: string; col: string; header: string }[] }) {
  const colOf = new Map(parsed.columns.map(c => [c.key, c]));
  const fields = allFields(ws.whTiers);
  const sysCount = new Map<string, number>();
  for (const r of recs.values()) sysCount.set(r.sku.toLowerCase(), (sysCount.get(r.sku.toLowerCase()) || 0) + 1);
  const fileSeen = new Map<string, number>();
  const results: RowResult[] = [];
  // SKUs and REFB SKUs as they will be after this file: products in the system plus the rows of the file.
  const index = { skus: new Set<string>([...recs.values()].map(r => r.sku.toLowerCase())), refb: new Map<string, string[]>() };
  const refbOf = new Map<string, string>();
  for (const r of recs.values()) if (r.values.refbSku) refbOf.set(r.sku.toLowerCase(), String(r.values.refbSku));
  for (const { cells } of parsed.rows) {
    const k = cells.sku == null ? '' : String(cells.sku).trim(); if (!k) continue;
    index.skus.add(k.toLowerCase());
    if (cells.refbSku !== undefined) { const v = String(cells.refbSku).trim(); if (v && v !== CLEAR) refbOf.set(k.toLowerCase(), v); else refbOf.delete(k.toLowerCase()); }
  }
  for (const [k, v] of refbOf) { const key = v.toLowerCase(), sku = findRec(recs, k)?.sku || k; index.refb.set(key, [...(index.refb.get(key) || []), sku]); }
  for (const { row, cells } of parsed.rows) {
    const errs: RowError[] = [], err = (key: string, zh: string, en: string) => { const c = colOf.get(key); errs.push({ col: c?.col || '', header: c?.header || FIELD.get(key)?.zh || key, key, zh, en }); };
    const rawSku = cells.sku == null ? '' : String(cells.sku).trim();
    const res: RowResult = { row, sku: rawSku, status: 'error', changes: [], errors: errs, warnings: [] };
    results.push(res);
    if (!rawSku) { err('sku', 'SKU 为空', 'The SKU is empty'); continue; }
    const skuP = parseValue(FIELD.get('sku')!, rawSku);
    if (!skuP.ok) { err('sku', skuP.zh, skuP.en); continue; }
    const k = rawSku.toLowerCase();
    if (fileSeen.has(k)) { err('sku', `与第 ${fileSeen.get(k)} 行的 SKU 重复`, `Same SKU as row ${fileSeen.get(k)}`); continue; }
    fileSeen.set(k, row);
    if ((sysCount.get(k) || 0) > 1) { err('sku', '系统里有多个只差大小写的同名 SKU，请先在系统里合并', 'Several products in the system differ only in letter case; merge them first'); continue; }
    const rec = findRec(recs, rawSku) || null;
    if (rec) res.sku = rec.sku;
    const raw = { ...cells }; delete raw.sku;
    const { values, errors } = validateValues(v, raw, ws);
    for (const e of errors) err(e.key, e.zh, e.en);
    const before = rec ? rec.values : {};
    if (!rec) { values.goodsType ??= 'bulk'; values.status ??= 'dev'; for (const key of ['family', 'nameZh', 'nameEn']) if (values[key] == null && !errors.some(e => e.key === key)) err(key, '新增产品必须填这一项', 'Required for a new product'); }
    if (rec && values.goodsType && values.goodsType !== 'refb' && rec.values.refbSku && values.refbSku === undefined) values.refbSku = null;
    const after = { ...before, ...values };
    for (const i of recordIssues(after)) if (!errs.some(e => e.key === i.key)) err(i.key, i.zh, i.en);
    for (const i of relationIssues(rec ? rec.sku : rawSku, after, Object.keys(values), index)) if (!errs.some(e => e.key === i.key)) err(i.key, i.zh, i.en);
    res.family = after.family || null;
    if (errs.length) continue;
    for (const f of fields) {
      if (!canSee(v, f.vis) || f.type === 'image' || f.key === 'refbSku' || CORE_REQUIRED.has(f.key)) continue;
      if (famCode(f.code, after.family) === 'req' && (after[f.key] == null || after[f.key] === '')) res.warnings.push({ key: f.key, zh: `${f.zh}：必填未完成`, en: `${f.en}: required, still empty` });
    }
    res.changes = Object.entries(values).filter(([key, to]) => !same(before[key] ?? null, to)).map(([key, to]) => ({ key, from: before[key] ?? null, to }));
    res.values = values;
    res.status = !rec ? 'new' : res.changes.length ? 'update' : 'same';
  }
  return { results, analysis: analysis(v, ws, recs, results) };
}

function analysis(v: Viewer, ws: Worksheet, recs: Map<string, Rec>, results: RowResult[]) {
  const fields = allFields(ws.whTiers), sens = canSee(v, 'sens');
  const ok = results.filter(r => r.status === 'new' || r.status === 'update');
  const afterOf = new Map<string, Record<string, any>>();
  for (const r of recs.values()) afterOf.set(r.sku.toLowerCase(), r.values);
  const beforeOf = new Map(afterOf);
  for (const r of ok) afterOf.set(r.sku.toLowerCase(), { ...(beforeOf.get(r.sku.toLowerCase()) || {}), ...r.values });
  const fileCounts = new Map([...recs.values()].map(r => [r.sku.toLowerCase(), Object.fromEntries(Object.entries(r.files).map(([k, a]) => [k, a.length]))]));
  const comp = (m: Map<string, Record<string, any>>) => {
    let need = 0, got = 0, done = 0;
    for (const [k, values] of m) { const c = completeness({ values: { ...values }, files: fileCounts.get(k) || {} }, v, fields); need += c.need; got += c.got; if (c.done) done++; }
    return { need, got, pct: need ? got / need * 100 : null, complete: done, products: m.size };
  };
  const statusChanges: Record<string, number> = {};
  for (const r of ok.filter(r => r.status === 'update')) { const c = r.changes.find(c => c.key === 'status'); if (c) { const k = `${c.from || ''}→${c.to}`; statusChanges[k] = (statusChanges[k] || 0) + 1; } }
  const calcPair = (r: RowResult) => {
    const b = beforeOf.get(r.sku.toLowerCase()) || {}, a = afterOf.get(r.sku.toLowerCase())!;
    return { sku: r.sku, b: worksheet(b, ws), a: worksheet(a, ws) };
  };
  const pairs = ok.filter(r => r.status === 'update').map(calcPair);
  const prices: any = {
    msrp: priceStats(pairs.map(p => ({ sku: p.sku, from: p.b.fixed[0].price, to: p.a.fixed[0].price }))),
    map: priceStats(pairs.map(p => ({ sku: p.sku, from: p.b.fixed[1].price, to: p.a.fixed[1].price }))),
    wholesale: ws.whTiers.map((t, i) => ({ name: t.name, ...priceStats(pairs.filter(() => sens || !t.floor).map(p => ({ sku: p.sku, from: p.b.wholesale[i].price, to: p.a.wholesale[i].price }))) }))
      .filter(t => sens || !ws.whTiers.find(x => x.name === t.name)?.floor),
  };
  let margins: any = undefined;
  if (sens) {
    const all = (m: Map<string, Record<string, any>>) => [...m.values()].map(x => worksheet(x, ws));
    const below = (list: ReturnType<typeof worksheet>[]) => ({
      dtc: ws.dtcFloor == null ? null : list.filter(c => c.fixed[0].cmPct != null && c.fixed[0].cmPct < ws.dtcFloor! / 100).length,
      wholesale: ws.whFloor == null ? null : list.filter(c => c.wholesale.some(t => t.belowFloor)).length,
    });
    const avg = (xs: (number | null)[]) => { const f = xs.filter(x => x != null) as number[]; return f.length ? f.reduce((s, x) => s + x, 0) / f.length * 100 : null; };
    margins = {
      msrpCmPct: { before: avg(pairs.map(p => p.b.fixed[0].cmPct)), after: avg(pairs.map(p => p.a.fixed[0].cmPct)) },
      belowFloor: { before: below(all(beforeOf)), after: below(all(afterOf)) },
      floors: { dtc: ws.dtcFloor, wholesale: ws.whFloor },
    };
  }
  const newByFamily: Record<string, number> = {};
  for (const r of results.filter(r => r.status === 'new')) newByFamily[r.family || ''] = (newByFamily[r.family || ''] || 0) + 1;
  return {
    totals: { rows: results.length, new: results.filter(r => r.status === 'new').length, update: results.filter(r => r.status === 'update').length,
      same: results.filter(r => r.status === 'same').length, error: results.filter(r => r.status === 'error').length,
      fieldChanges: ok.reduce((s, r) => s + r.changes.length, 0), warnings: ok.reduce((s, r) => s + r.warnings.length, 0) },
    completeness: { before: comp(beforeOf), after: comp(afterOf) },
    statusChanges, prices, ...(margins ? { margins } : {}), newByFamily,
  };
}

// jsonb does not keep object key order, so the comparison sorts what it looks at.
const signature = (results: RowResult[]) => JSON.stringify(results.map(r => [r.row, r.sku, r.status,
  [...r.changes].sort((a, b) => a.key.localeCompare(b.key)).map(c => [c.key, c.from, c.to]), r.errors.map(e => e.key).sort()]));

export async function registerProductImportRoutes(app: FastifyInstance, db: Database, o: {
  isAdmin: (u: User) => boolean; requestPrice: WriteOpts['requestPrice'];
  audit: (tx: Queryable, u: User, action: string, objectId: string, details: unknown) => Promise<unknown>;
}) {
  const actorOf = (req: FastifyRequest): User => req.actor || deny(401, 'UNAUTHENTICATED', 'Authentication is required');
  const viewer = (u: User) => viewerOf(Array.isArray((u as any).grants) ? (u as any).grants : [], o.isAdmin(u));
  const adminOnly = (u: User) => { if (!o.isAdmin(u)) deny(403, 'PRODUCT_IMPORT_FORBIDDEN', 'Only the main administrators can bulk-update products'); };
  const stamp = () => new Date().toISOString().slice(0, 10);

  // Anyone who can open the product library may download what they can see; the columns follow their level.
  app.get('/products/library/template', async (req, reply) => {
    const u = actorOf(req), v = viewer(u), format = z.enum(['xlsx', 'csv']).default('xlsx').parse((req.query as any)?.format);
    const scope = z.enum(['all', 'sku', 'pricing']).default('all').parse((req.query as any)?.scope);
    if (scope === 'pricing' && !templateFields(v, (await worksheetOf(db, u.org_id)).settings, 'pricing').some(f => PRICING_GROUPS.has(f.group))) deny(403, 'PRICING_TEMPLATE_FORBIDDEN', 'You cannot see any price columns', '你没有可以查看的价格列。');
    const ws = (await worksheetOf(db, u.org_id)).settings, recs = [...(await loadRecords(db, u.org_id)).values()];
    const file = buildTemplate(format, v, ws, recs, scope), name = `OneLaser_${scope === 'pricing' ? '定价' : scope === 'sku' ? 'SKU资料' : '产品资料'}_${stamp()}.${format}`;
    await db.query('INSERT INTO audit_events(id,org_id,department_id,owner_id,actor_id,action,object_id,details) VALUES($1,$2,$3,$4,$5,$6,$7,$8)',
      [randomUUID(), u.org_id, u.department_id, u.id, u.id, 'products.template_downloaded', format, JSON.stringify({ rows: recs.length, scope, levels: [...v.levels] })]);
    return reply.header('content-type', format === 'xlsx' ? 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' : 'text/csv; charset=utf-8')
      .header('cache-control', 'private, no-store').header('content-disposition', `attachment; filename*=UTF-8''${encodeURIComponent(name)}`).send(file);
  });

  const MAX_UPLOAD = 10 * 1024 * 1024;
  app.post('/products/library/import/preview', { bodyLimit: Math.ceil(MAX_UPLOAD * 4 / 3) + 4096 }, async req => {
    const u = actorOf(req); adminOnly(u);
    const b = z.object({ fileName: z.string().trim().min(1).max(200), dataBase64: z.string().min(4).max(Math.ceil(MAX_UPLOAD * 4 / 3) + 8) }).strict().parse(req.body);
    const data = Buffer.from(b.dataBase64, 'base64');
    const v = viewer(u), ws = (await worksheetOf(db, u.org_id)).settings;
    const parsed = parseUpload(b.fileName, data, ws);
    const { results, analysis } = diffUpload(v, ws, await loadRecords(db, u.org_id), parsed);
    const id = randomUUID();
    const result = { results: results.map(({ values, ...r }) => r), analysis, columns: parsed.columns, ignoredColumns: parsed.ignored, signature: signature(results) };
    await db.query('INSERT INTO product_import_previews(id,org_id,created_by,file_name,cells,result) VALUES($1,$2,$3,$4,$5,$6)',
      [id, u.org_id, u.id, b.fileName, JSON.stringify({ rows: parsed.rows, columns: parsed.columns }), JSON.stringify(result)]);
    const { signature: _s, ...out } = result;
    return { id, fileName: b.fileName, ...out };
  });
  const previewOf = async (u: User, id: string) => {
    const p = (await db.query('SELECT * FROM product_import_previews WHERE org_id=$1 AND id=$2 AND created_by=$3', [u.org_id, id, u.id])).rows[0];
    return p || deny(404, 'IMPORT_PREVIEW_NOT_FOUND', 'This preview does not exist; upload the file again');
  };
  app.get('/products/library/import/:id/report', async (req, reply) => {
    const u = actorOf(req); adminOnly(u);
    const p = await previewOf(u, String((req.params as any).id)), r = p.result, ws = (await worksheetOf(db, u.org_id)).settings;
    const label = { new: '新增', update: '更新', same: '无变化', error: '有错误' } as Record<string, string>;
    const name = (k: string) => (allFields(ws.whTiers).find(f => f.key === k)?.zh) || k;
    const show = (k: string, x: any) => { const f = FIELD.get(k); return x == null ? '' : f?.type === 'enum' ? enumLabel(f, x) : x; };
    const a = r.analysis.totals;
    const rows: any[][] = [[`导入预览报告 · ${p.file_name} · ${new Date(p.created_at).toISOString().slice(0, 16).replace('T', ' ')} UTC`],
      [`共 ${a.rows} 行：新增 ${a.new}，更新 ${a.update}，无变化 ${a.same}，有错误 ${a.error}；字段变化 ${a.fieldChanges} 处`], [],
      ['行号', 'SKU', '结果', '列', '字段', '原值', '新值', '错误 / 提醒']];
    for (const x of r.results as RowResult[]) {
      if (x.status === 'error') for (const e of x.errors) rows.push([x.row, x.sku, label.error, e.col, e.header, '', '', e.zh]);
      else if (!x.changes.length) rows.push([x.row, x.sku, label[x.status], '', '', '', '', x.warnings.map(w => w.zh).join('；')]);
      else x.changes.forEach((c, i) => rows.push([x.row, x.sku, label[x.status], '', name(c.key), show(c.key, c.from), show(c.key, c.to), i === 0 ? x.warnings.map(w => w.zh).join('；') : '']));
    }
    return reply.header('content-type', 'text/csv; charset=utf-8').header('cache-control', 'private, no-store')
      .header('content-disposition', `attachment; filename*=UTF-8''${encodeURIComponent('导入预览报告_' + p.file_name.replace(/\.(xlsx|csv)$/i, '') + '.csv')}`).send(writeCsv(rows));
  });

  app.post('/products/library/import/:id/confirm', async req => {
    const u = actorOf(req); adminOnly(u);
    const b = z.object({ skipErrors: z.boolean().default(false) }).strict().parse(req.body || {});
    const v = viewer(u);
    return db.transaction(async tx => {
      const p = (await tx.query('SELECT * FROM product_import_previews WHERE org_id=$1 AND id=$2 AND created_by=$3 FOR UPDATE', [u.org_id, String((req.params as any).id), u.id])).rows[0]
        || deny(404, 'IMPORT_PREVIEW_NOT_FOUND', 'This preview does not exist; upload the file again');
      if (p.used_at) deny(409, 'IMPORT_PREVIEW_USED', 'This preview has already been applied');
      const ws = (await worksheetOf(tx, u.org_id)).settings;
      const recs = await loadRecords(tx, u.org_id, undefined, true);
      const { results, analysis } = diffUpload(v, ws, recs, p.cells);
      if (signature(results) !== p.result.signature) deny(409, 'IMPORT_PREVIEW_STALE', 'The products changed after this preview; upload the file again to see the current differences');
      const errors = results.filter(r => r.status === 'error');
      if (errors.length && !b.skipErrors) deny(409, 'IMPORT_HAS_ERRORS', 'Some rows have errors; fix them or choose to skip the rows with errors');
      const importId = randomUUID(), log: { sku: string; created: boolean; changes: Change[] }[] = [];
      for (const r of results) {
        if (r.status !== 'new' && r.status !== 'update') continue;
        const rec = r.status === 'new' ? null : findRec(recs, r.sku)!;
        const w = await writeRecord(tx, u, r.sku, rec, r.values!, { source: 'import', note: importId, ws, prices: 'direct', requestPrice: o.requestPrice });
        log.push({ sku: r.sku, created: !rec, changes: w.changes });
      }
      const summary = { ...analysis.totals, skipped: errors.length, skipErrors: b.skipErrors };
      await tx.query('INSERT INTO product_imports(id,org_id,kind,rows,created_by,file_name,summary,changes) VALUES($1,$2,$3,$4,$5,$6,$7,$8)',
        [importId, u.org_id, 'library', results.length, u.id, p.file_name, JSON.stringify(summary), JSON.stringify(log)]);
      await tx.query('UPDATE product_import_previews SET used_at=now() WHERE id=$1', [p.id]);
      await o.audit(tx, u, 'products.library_import', importId, { file: p.file_name, ...summary });
      return { importId, ...summary };
    });
  });

  app.get('/products/library/imports', async req => {
    const u = actorOf(req); adminOnly(u);
    const rows = (await db.query(`SELECT i.id,i.file_name,i.summary,i.created_at,i.undone_at,i.undo_result,
      (SELECT COALESCE(NULLIF(display_name,''),NULLIF(name_zh,''),id) FROM users WHERE id=i.created_by) AS by_name,
      (SELECT COALESCE(NULLIF(display_name,''),NULLIF(name_zh,''),id) FROM users WHERE id=i.undone_by) AS undone_name
      FROM product_imports i WHERE i.org_id=$1 AND i.kind='library' ORDER BY i.created_at DESC LIMIT 50`, [u.org_id])).rows;
    return { items: rows.map((r: any) => ({ id: r.id, fileName: r.file_name, summary: r.summary, by: r.by_name, at: r.created_at, undoneAt: r.undone_at, undoneBy: r.undone_name, undo: r.undo_result })) };
  });

  // SKUs referenced elsewhere are never deleted by an undo, even if this import created them.
  const usedElsewhere = async (tx: Queryable, org: string, sku: string) => {
    for (const q of ['SELECT 1 FROM wms_items WHERE org_id=$1 AND sku=$2', 'SELECT 1 FROM wms_movements WHERE org_id=$1 AND sku=$2', 'SELECT 1 FROM rma_cases WHERE org_id=$1 AND sku=$2',
      `SELECT 1 FROM product_channel_prices WHERE org_id=$1 AND sku=$2 AND channel IN ('shopify','amazon','ebay','dealer')`, 'SELECT 1 FROM product_files WHERE org_id=$1 AND sku=$2',
      'SELECT 1 FROM dealer_order_lines l JOIN dealer_orders d ON d.id=l.order_id WHERE d.org_id=$1 AND l.sku=$2'])
      if ((await tx.query(q + ' LIMIT 1', [org, sku])).rows.length) return true;
    return false;
  };
  app.post('/products/library/imports/:id/undo', async req => {
    const u = actorOf(req); adminOnly(u);
    return db.transaction(async tx => {
      const imp = (await tx.query(`SELECT * FROM product_imports WHERE org_id=$1 AND id=$2 AND kind='library' FOR UPDATE`, [u.org_id, String((req.params as any).id)])).rows[0]
        || deny(404, 'IMPORT_NOT_FOUND', 'This import does not exist');
      if (imp.undone_at) deny(409, 'IMPORT_ALREADY_UNDONE', 'This import has already been undone');
      const ws = (await worksheetOf(tx, u.org_id)).settings;
      const log = (imp.changes || []) as { sku: string; created: boolean; changes: Change[] }[];
      const recs = await loadRecords(tx, u.org_id, log.map(l => l.sku), true);
      const kept: { sku: string; key: string; reason: string }[] = [];
      let restored = 0, removed = 0;
      for (const l of log) {
        const rec = findRec(recs, l.sku);
        if (!rec) continue;
        const changedSince = l.changes.filter(c => !same(rec.values[c.key] ?? null, c.to));
        if (l.created) {
          if (changedSince.length || await usedElsewhere(tx, u.org_id, rec.sku)) { kept.push({ sku: rec.sku, key: '', reason: changedSince.length ? 'edited_since' : 'in_use' }); continue; }
          for (const t of ['product_channel_prices', 'product_pricing', 'product_catalog']) await tx.query(`DELETE FROM ${t} WHERE org_id=$1 AND sku=$2`, [u.org_id, rec.sku]);
          await tx.query('INSERT INTO product_changes(id,org_id,sku,field,old_value,new_value,note,source,actor_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)',
            [randomUUID(), u.org_id, rec.sku, 'sku', JSON.stringify(rec.sku), JSON.stringify(null), imp.id, 'undo', u.id]);
          removed++; continue;
        }
        for (const c of changedSince) kept.push({ sku: rec.sku, key: c.key, reason: 'edited_since' });
        const back = Object.fromEntries(l.changes.filter(c => !changedSince.includes(c)).map(c => [c.key, c.from]));
        const w = await writeRecord(tx, u, rec.sku, rec, back, { source: 'undo', note: imp.id, ws, prices: 'direct', requestPrice: o.requestPrice });
        restored += w.changes.length;
      }
      const result = { restored, removed, kept };
      await tx.query('UPDATE product_imports SET undone_at=now(),undone_by=$3,undo_result=$4 WHERE org_id=$1 AND id=$2', [u.org_id, imp.id, u.id, JSON.stringify(result)]);
      await o.audit(tx, u, 'products.library_import_undone', imp.id, result);
      return { importId: imp.id, ...result };
    });
  });
}
