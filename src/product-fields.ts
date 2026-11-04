/* Product information model (PIM): the field list of the 产品资料 page.
 *
 * Source: KC's spec 「OneLaser 产品资料库」 (2026-11-04). Every field has
 *   - a stable key (used in the API, the bulk template's key row and the change history),
 *   - a five-letter requirement code, one letter per product family in FAMILIES order
 *     (主机 main, 配件/备件 acc, 耗材 cons, 软件/服务 soft, 内部物料 mat): r 必填, o 选填, n 不适用,
 *   - a visibility level (who may see it) and a type (how a value is checked).
 * For every family except 主机 only the core fields stay required; their other r become o (minReq).
 *
 * Visibility levels map onto the existing grants (no new permission system, CLAUDE.md rule 4):
 *   all   全员             anyone with product area access (grant products)
 *   ops   产品与供应链      + products_manage, supply, supply_manage, warehouse, warehouse_manage or product_cost_detail
 *   cost  仅成本权限        product_cost_detail
 *   admin 仅管理员          deployment-configured executives (WORKOS_EXECUTIVE_USER_IDS)
 *   sens  敏感 · 仅编辑者   product_cost_detail to see; editing also needs products_manage
 * Executives see and edit everything. Editing any field needs products_manage (prices: also pricing_msrp).
 *
 * No product data lives here: placeholders are examples of the format only. */

export const FAMILIES = [
  { key: 'main', zh: '主机', en: 'Main unit' },
  { key: 'acc', zh: '配件/备件', en: 'Accessory / spare part' },
  { key: 'cons', zh: '耗材', en: 'Consumable' },
  { key: 'soft', zh: '软件/服务', en: 'Software / service' },
  { key: 'mat', zh: '内部物料', en: 'Internal material' },
] as const;
export type Family = typeof FAMILIES[number]['key'];
export const FAMILY_KEYS = FAMILIES.map(f => f.key) as Family[];

export const VIS_LEVELS = ['all', 'ops', 'cost', 'admin', 'sens'] as const;
export type Vis = typeof VIS_LEVELS[number];
export const VIS_NAMES: Record<Vis, { zh: string; en: string }> = {
  all: { zh: '全员', en: 'Everyone' }, ops: { zh: '产品与供应链', en: 'Product & supply chain' },
  cost: { zh: '仅成本权限', en: 'Cost access only' }, admin: { zh: '仅管理员', en: 'Administrators only' },
  sens: { zh: '敏感 · 仅编辑者', en: 'Sensitive · editors only' },
};

/* Lifecycle statuses keep the codes the rest of the system already uses (products.ts PRODUCT_STATUSES). */
export const STATUS_OPTIONS = [
  { value: 'dev', zh: '开发中', en: 'In development' }, { value: 'launch', zh: '上新中', en: 'Launching' },
  { value: 'live', zh: '在售', en: 'On sale' }, { value: 'clearance', zh: '清库存', en: 'Clearance' },
  { value: 'eolPlanned', zh: '计划停售', en: 'End of sale planned' }, { value: 'eol', zh: '停售', en: 'Discontinued' },
];
export const GOODS_OPTIONS = [{ value: 'bulk', zh: '大货', en: 'New stock' }, { value: 'refurb', zh: '退货', en: 'Returned / refurbished' }];
const opts = (...labels: string[]) => labels.map(l => ({ value: l, zh: l, en: l }));

export type FieldType = 'text' | 'enum' | 'suggest' | 'date' | 'number' | 'price' | 'sku' | 'refb' | 'gtin' | 'hs' | 'image';
/* Where a value is stored. Everything is keyed by product_catalog.sku (CLAUDE.md rule 3.1).
 *   col     a product_catalog column        attrs   product_catalog.attrs (all / ops fields)
 *   dims    product_catalog.dims[i]          secure  product_pricing.attrs (cost / sens fields)
 *   cost    a product_pricing column        price   a selling price (product_catalog.msrp or product_channel_prices)
 *   file    product_files (uploads)                                                                     */
export type Store = { t: 'col'; col: string } | { t: 'dims'; i: number } | { t: 'attrs' } | { t: 'secure' } | { t: 'cost'; col: string } | { t: 'price'; target: string } | { t: 'file' };
export interface FieldDef {
  key: string; group: string; zh: string; en: string; ph: string; req: string; vis: Vis; type: FieldType;
  options?: { value: string; zh: string; en: string }[]; unit?: string; max?: number; store: Store;
}
export interface SlotDef { key: string; zh: string; en: string; hint: string; req: string; pdfOnly: boolean }

export const GROUPS = [
  { key: '1', zh: '产品基本参数', en: 'Basic information' },
  { key: '2', zh: '生命周期', en: 'Lifecycle' },
  { key: '3', zh: '产品详细信息与文件', en: 'Details and files' },
  { key: '4', zh: '定价（零售）', en: 'Pricing (retail)' },
  { key: '5', zh: '定价（批发）', en: 'Pricing (wholesale)' },
  { key: '6', zh: '包装与物流', en: 'Packaging and logistics' },
  { key: '7', zh: '采购与供应商', en: 'Purchasing and suppliers' },
  { key: '8', zh: '售后与库存控制', en: 'After-sales and stock control' },
];

/* Core fields stay required for every family. */
export const CORE_REQUIRED = new Set(['sku', 'goodsType', 'family', 'nameZh', 'nameEn', 'status']);
export const minReq = (key: string, code: string) => CORE_REQUIRED.has(key) ? code : code[0] + code.slice(1).replace(/r/g, 'o');

type Raw = Omit<FieldDef, 'group' | 'store' | 'req'> & { code: string; store?: Store };
const f = (key: string, zh: string, en: string, ph: string, code: string, vis: Vis, type: FieldType, extra: Partial<Raw> = {}): Raw => ({ key, zh, en, ph, code, vis, type, ...extra });
const RAW: [string, Raw[]][] = [
  ['1', [
    f('sku', 'SKU', 'SKU', 'ODL-XRF-38-US01', 'rrrrr', 'all', 'sku', { store: { t: 'col', col: 'sku' } }),
    f('goodsType', '大货 / 退货', 'New / returned', '', 'rrrrr', 'all', 'enum', { options: GOODS_OPTIONS, store: { t: 'col', col: 'goods_type' } }),
    f('refbSku', '退货 SKU', 'Refurbished SKU', 'REFB-…', 'ooooo', 'all', 'refb', { store: { t: 'col', col: 'refb_sku' } }),
    f('family', '产品族', 'Product family', '', 'rrrrr', 'all', 'enum', { options: FAMILIES.map(x => ({ value: x.key, zh: x.zh, en: x.en })), store: { t: 'col', col: 'family' } }),
    f('line', '产品线 / 系列', 'Product line / series', 'XRF', 'rrron', 'all', 'suggest', { options: opts('XRF', 'Hydra', 'Cobra', 'VertiGo', 'Galvo Flex') }),
    f('nameZh', '中文名', 'Chinese name', 'XRF 38W 桌面激光机', 'rrrrr', 'all', 'text', { max: 200, store: { t: 'col', col: 'name_zh' } }),
    f('nameEn', '英文名', 'English name', 'XRF 38W Desktop Laser', 'rrrrr', 'all', 'text', { max: 200, store: { t: 'col', col: 'name_en' } }),
    f('brand', '品牌', 'Brand', 'OneLaser', 'rrron', 'all', 'suggest', { options: opts('OneLaser') }),
    f('model', '型号', 'Model', 'XRF-38', 'ronnn', 'all', 'text', { max: 80 }),
    f('gtin', 'UPC / EAN / GTIN', 'UPC / EAN / GTIN', 'UPC 12 位 / EAN 13 位', 'ooonn', 'all', 'gtin'),
    f('mainImage', '产品主图', 'Main image', '', 'oooon', 'all', 'image', { store: { t: 'file' } }),
  ]],
  ['2', [
    f('status', '状态', 'Status', '', 'rrrro', 'all', 'enum', { options: STATUS_OPTIONS, store: { t: 'col', col: 'status' } }),
    f('launchDate', '上市日期', 'Launch date', '', 'roooo', 'all', 'date'),
    f('eolDate', '停售日期', 'End-of-sale date', '', 'oooon', 'all', 'date'),
    f('replacementSku', '替代 SKU', 'Replacement SKU', '停售后替代的 SKU', 'ooonn', 'all', 'sku'),
  ]],
  ['3', [
    f('hsCode', 'HS 编码（美国 HTS 10 位）', 'HS code (US HTS, 10 digits)', '8456.11.…', 'rrrno', 'cost', 'hs', { store: { t: 'secure' } }),
    f('customsName', '报关品名（中 / 英）', 'Customs description (zh / en)', '激光加工机 / Laser engraving machine', 'rrrno', 'cost', 'text', { max: 300, store: { t: 'secure' } }),
    f('origin', '原产国', 'Country of origin', '中国', 'rrrno', 'all', 'text', { max: 80 }),
    f('laserClass', '激光安全等级', 'Laser safety class', 'Class 1', 'rnnnn', 'all', 'enum', { options: opts('Class 1', 'Class 2', 'Class 3R', 'Class 4') }),
    f('fdaAccession', 'FDA 激光产品报告号', 'FDA accession number', 'Accession No.', 'rnnnn', 'ops', 'text', { max: 80 }),
    f('otherCerts', '其他认证要求', 'Other certification requirements', '如 Prop 65、各州特殊要求', 'roonn', 'ops', 'text', { max: 500 }),
  ]],
  ['4', [
    f('landed', '到岸价', 'Landed cost', '例：2800', 'rrrnr', 'sens', 'price', { unit: 'USD', store: { t: 'cost', col: 'landed_usd' } }),
    f('lastMile', '尾程运费 / 台', 'Last-mile freight per unit', '例：399', 'rrrnn', 'sens', 'price', { unit: 'USD', store: { t: 'cost', col: 'last_mile_usd' } }),
    f('msrp', '零售价 MSRP', 'Retail price (MSRP)', '定稿零售价', 'rrrrn', 'all', 'price', { unit: 'USD', store: { t: 'price', target: 'msrp' } }),
    f('map', '最低公开售价 MAP', 'Minimum advertised price (MAP)', '默认同 MSRP', 'roorn', 'all', 'price', { unit: 'USD', store: { t: 'price', target: 'map' } }),
    f('promoFloor', '官网促销底价', 'Website promotion floor', '仅限固定促销节点', 'roorn', 'all', 'price', { unit: 'USD', store: { t: 'price', target: 'promo_floor' } }),
  ]],
  ['5', [
    f('whFreight', '批发运费承担方', 'Wholesale freight paid by', '', 'ooonn', 'ops', 'enum', { options: [{ value: 'dealer', zh: '经销商付运费', en: 'Dealer pays freight' }, { value: 'us', zh: '我们付运费', en: 'We pay freight' }] }),
  ]],
  ['6', [
    f('netWeight', '净重', 'Net weight', '38', 'rrrnr', 'all', 'number', { unit: 'kg' }),
    f('grossWeight', '毛重', 'Gross weight', '52', 'rrrnr', 'all', 'number', { unit: 'kg', store: { t: 'col', col: 'gross' } }),
    f('pkgL', '包装长', 'Package length', '110', 'rrrnr', 'all', 'number', { unit: 'cm', store: { t: 'dims', i: 0 } }),
    f('pkgW', '包装宽', 'Package width', '75', 'rrrnr', 'all', 'number', { unit: 'cm', store: { t: 'dims', i: 1 } }),
    f('pkgH', '包装高', 'Package height', '50', 'rrrnr', 'all', 'number', { unit: 'cm', store: { t: 'dims', i: 2 } }),
    f('pkgCount', '包装件数', 'Number of packages', '2 箱', 'roono', 'all', 'text', { max: 80 }),
    f('cartonSpec', '箱规 / 每托数量', 'Carton / units per pallet', '1 台/箱，8 台/托', 'roono', 'all', 'text', { max: 120 }),
    f('shipMethod', '最优发货方式', 'Best shipping method', '卡车零担 LTL', 'rrrnn', 'all', 'enum', { options: opts('卡车零担 LTL', '快递', '专线'), store: { t: 'col', col: 'best' } }),
    f('dangerous', '危险品 / 电池', 'Dangerous goods / batteries', '含锂电池：否', 'rrrnr', 'all', 'text', { max: 200 }),
    f('cartonLabel', '商品条码 / 箱标', 'Item barcode / carton label', '条码编号', 'ooono', 'all', 'text', { max: 120 }),
  ]],
  ['7', [
    f('supplierMain', '主供应商', 'Main supplier', '东莞工厂', 'rrrno', 'sens', 'text', { max: 200, store: { t: 'secure' } }),
    f('supplierAlt1', '备选供应商1', 'Alternative supplier 1', '', 'ooonn', 'sens', 'text', { max: 200, store: { t: 'secure' } }),
    f('supplierAlt2', '备选供应商2', 'Alternative supplier 2', '', 'ooonn', 'sens', 'text', { max: 200, store: { t: 'secure' } }),
    f('moq', '最小起订量 / 采购单位', 'Minimum order / purchase unit', '10 台 / 件', 'rrrnr', 'ops', 'text', { max: 80 }),
    f('productionLead', '生产交期', 'Production lead time', '25 天', 'rrrno', 'ops', 'text', { max: 80 }),
    f('firstLeg', '头程时间', 'First-leg transit time', '海运 35 天', 'rrrno', 'ops', 'text', { max: 80 }),
  ]],
  ['8', [
    f('warranty', '保修期', 'Warranty', '整机 2 年，激光管 1 年', 'rroon', 'all', 'text', { max: 200 }),
    f('safetyStock', '安全库存 / 补货点', 'Safety stock / reorder point', '20 台', 'rrrno', 'ops', 'text', { max: 80 }),
  ]],
];
export const FIELDS: FieldDef[] = RAW.flatMap(([group, list]) => list.map(({ code, store, ...r }) => ({ ...r, group, req: minReq(r.key, code), store: store || { t: 'attrs' } })));
export const FIELD = new Map(FIELDS.map(x => [x.key, x]));

/* Upload slots of group 3 (all 敏感 · 仅编辑者). */
const slot = (key: string, zh: string, en: string, code: string, hint: string, pdfOnly = false): SlotDef => ({ key, zh, en, req: minReq(key, code), hint, pdfOnly });
export const SLOTS: SlotDef[] = [
  slot('manual', '说明书', 'Manual', 'ronon', 'PDF，带版本号'),
  slot('spec', '产品参数表', 'Specification sheet', 'rooon', 'PDF 或 CSV'),
  slot('bom', 'BOM 表格', 'BOM', 'ronnn', 'PDF 或 CSV'),
  slot('cert', '认证（UL / FCC / CE / RoHS）', 'Certificates (UL / FCC / CE / RoHS)', 'ronnn', '证书 PDF 或图片'),
  slot('compliance', '其他合规文件', 'Other compliance documents', 'roonn', 'PDF 或图片'),
  slot('spareParts', '常用备件清单', 'Common spare parts list', 'ronnn', '仅 PDF', true),
  slot('warrantyCert', '保修证书', 'Warranty certificate', 'rroon', '仅 PDF', true),
];
export const SLOT = new Map(SLOTS.map(s => [s.key, s]));
export const SLOT_VIS: Vis = 'sens';
export const FILE_MIME: Record<string, string> = { pdf: 'application/pdf', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp', csv: 'text/csv', txt: 'text/plain' };
export const IMAGE_MIME = new Set(['image/png', 'image/jpeg', 'image/webp']);
export const MAX_FILE_BYTES = 20 * 1024 * 1024;

export type Need = 'req' | 'opt' | 'na';
export const needOf = (code: string, family: string | null | undefined): Need | null => {
  const i = FAMILY_KEYS.indexOf(family as Family);
  if (i < 0) return null;
  const c = (code[i] || 'n').toLowerCase();
  return c === 'r' ? 'req' : c === 'o' ? 'opt' : 'na';
};

/* ---------- who sees what ---------- */
export interface Viewer { executive: boolean; grants: string[] }
const OPS_GRANTS = ['products_manage', 'supply', 'supply_manage', 'warehouse', 'warehouse_manage', 'product_cost_detail'];
export const levelsOf = (v: Viewer): Set<Vis> => {
  if (v.executive) return new Set(VIS_LEVELS);
  const g = v.grants, out = new Set<Vis>();
  if (!g.includes('products')) return out;
  out.add('all');
  if (OPS_GRANTS.some(x => g.includes(x))) out.add('ops');
  if (g.includes('product_cost_detail')) { out.add('cost'); out.add('sens'); }
  return out;
};
export const canEditField = (v: Viewer, def: { vis: Vis; type?: FieldType }) => {
  if (v.executive) return true;
  if (!levelsOf(v).has(def.vis)) return false;
  if (def.type === 'price') return v.grants.includes('products_manage') || v.grants.includes('pricing_msrp') || v.grants.includes('product_cost_detail');
  return v.grants.includes('products_manage');
};

/* ---------- values ---------- */
export const CLEAR = '[清空]';
export type Issue = { field: string; code: string; zh: string; en: string };
const issue = (field: string, code: string, zh: string, en: string): Issue => ({ field, code, zh, en });
export const SKU_RE = /^[A-Za-z0-9][A-Za-z0-9._\-/ ]*$/;
const gs1Ok = (d: string) => {
  const digits = d.split('').map(Number), check = digits.pop()!;
  const sum = digits.reverse().reduce((s, n, i) => s + n * (i % 2 === 0 ? 3 : 1), 0);
  return (10 - (sum % 10)) % 10 === check;
};
const excelDate = (n: number) => { const ms = Math.round((n - 25569) * 86400000); const d = new Date(ms); return isNaN(d.getTime()) ? null : d.toISOString().slice(0, 10); };
const realDate = (y: number, m: number, d: number) => { const t = new Date(Date.UTC(y, m - 1, d)); return t.getUTCFullYear() === y && t.getUTCMonth() === m - 1 && t.getUTCDate() === d ? t.toISOString().slice(0, 10) : null; };

/** Turns one input (JSON value or spreadsheet cell) into the stored value. null clears the field. */
export function parseValue(def: FieldDef, raw: unknown): { ok: true; value: string | number | null } | { ok: false; issue: Issue } {
  const bad = (code: string, zh: string, en: string) => ({ ok: false as const, issue: issue(def.key, code, zh, en) });
  if (raw === null || raw === undefined) return { ok: true, value: null };
  if (typeof raw !== 'string' && typeof raw !== 'number') return bad('FIELD_TYPE', `「${def.zh}」的值格式不对`, `${def.en} has the wrong format`);
  let s = typeof raw === 'number' ? String(raw) : raw.trim();
  if (s === '' || s === CLEAR) return { ok: true, value: null };
  switch (def.type) {
    case 'image': return bad('FIELD_FILE', `「${def.zh}」请在产品页上传文件`, `Upload ${def.en} on the product page`);
    case 'enum': {
      const low = s.toLowerCase(), hit = def.options!.find(o => [o.value, o.zh, o.en].some(x => x.toLowerCase() === low));
      return hit ? { ok: true, value: hit.value } : bad('FIELD_NOT_ALLOWED', `「${def.zh}」只能填：${def.options!.map(o => o.zh).join(' / ')}`, `${def.en} must be one of: ${def.options!.map(o => o.en).join(' / ')}`);
    }
    case 'date': {
      if (typeof raw === 'number' || /^\d{5}(\.\d+)?$/.test(s)) { const d = excelDate(Number(s)); if (d) return { ok: true, value: d }; }
      const m = s.match(/^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})$/), d = m && realDate(+m[1], +m[2], +m[3]);
      return d ? { ok: true, value: d } : bad('FIELD_DATE', `「${def.zh}」请填日期，例如 2026-11-04`, `${def.en} must be a date such as 2026-11-04`);
    }
    case 'number': case 'price': {
      const unit = def.unit ? def.unit.toLowerCase() : '';
      let t = s.replace(/[,\s，]/g, '').replace(/^\$|^US\$|^USD/i, '');
      if (unit && t.toLowerCase().endsWith(unit)) t = t.slice(0, -unit.length);
      const n = /^\d+(\.\d+)?$/.test(t) ? Number(t) : NaN, max = def.type === 'price' ? 10_000_000 : 1_000_000;
      if (!isFinite(n) || n < 0 || n > max) return bad('FIELD_NUMBER', `「${def.zh}」请填数字${def.unit ? `（单位 ${def.unit}）` : ''}`, `${def.en} must be a number${def.unit ? ` in ${def.unit}` : ''}`);
      return { ok: true, value: Math.round(n * 100) / 100 };
    }
    case 'sku':
      if (s.length > 80 || !SKU_RE.test(s)) return bad('FIELD_SKU', `「${def.zh}」只能用字母、数字和 . _ - / 空格，且以字母或数字开头`, `${def.en} may only use letters, digits, dot, dash, slash, underscore or space`);
      return { ok: true, value: s };
    case 'refb': {
      const v = /^refb-?/i.test(s) ? s.replace(/^refb-?/i, 'REFB-') : s;
      if (!v.startsWith('REFB-') || v.length <= 5) return bad('REFB_PREFIX', '退货 SKU 必须以 REFB- 开头', 'A refurbished SKU must start with REFB-');
      if (v.length > 80 || !SKU_RE.test(v)) return bad('FIELD_SKU', '退货 SKU 只能用字母、数字和 . _ - / 空格', 'The refurbished SKU may only use letters, digits, dot, dash, slash, underscore or space');
      return { ok: true, value: v };
    }
    case 'gtin': {
      const d = s.replace(/[\s-]/g, '');
      if (!/^(\d{8}|\d{12}|\d{13}|\d{14})$/.test(d)) return bad('FIELD_GTIN', '条码请填 8、12、13 或 14 位数字（UPC 12 位 / EAN 13 位）', 'Use 8, 12, 13 or 14 digits (UPC 12, EAN 13)');
      if (!gs1Ok(d)) return bad('FIELD_GTIN_CHECK', '条码校验位不对，请核对', 'The barcode check digit is wrong');
      return { ok: true, value: d };
    }
    case 'hs': {
      const digits = s.replace(/[.\s]/g, '');
      if (!/^\d{6,10}$/.test(digits)) return bad('FIELD_HS', 'HS 编码请填 6 到 10 位数字，可带点，例如 8456.11.0000', 'Use 6 to 10 digits for the HS code, dots allowed, e.g. 8456.11.0000');
      return { ok: true, value: s.replace(/\s/g, '') };
    }
    default: {
      const max = def.max || 200;
      if (s.length > max) return bad('FIELD_TOO_LONG', `「${def.zh}」最多 ${max} 个字`, `${def.en} is longer than ${max} characters`);
      return { ok: true, value: s };
    }
  }
}

export type Values = Record<string, string | number | null | undefined>;
const filled = (v: unknown) => v !== null && v !== undefined && v !== '';
/** Rules across fields. Hard errors block a save; core fields missing are errors, other required fields missing are warnings. */
export function checkRecord(v: Values, opts: { visible: Set<Vis>; files?: Record<string, number> } = { visible: new Set(VIS_LEVELS) }) {
  const errors: Issue[] = [], warnings: Issue[] = [];
  for (const k of CORE_REQUIRED) if (!filled(v[k]) && (needOf(FIELD.get(k)!.req, v.family as string) ?? 'req') === 'req') { const d = FIELD.get(k)!; errors.push(issue(k, 'FIELD_REQUIRED', `「${d.zh}」必填`, `${d.en} is required`)); }
  if (v.goodsType === 'refurb' && !filled(v.refbSku)) errors.push(issue('refbSku', 'REFB_REQUIRED', '退货产品必须填退货 SKU（以 REFB- 开头）', 'A returned product needs a refurbished SKU starting with REFB-'));
  if (v.goodsType === 'bulk' && filled(v.refbSku)) errors.push(issue('refbSku', 'REFB_ONLY_RETURNS', '只有退货产品才填退货 SKU', 'Only returned products have a refurbished SKU'));
  if (filled(v.launchDate) && filled(v.eolDate) && String(v.eolDate) < String(v.launchDate)) errors.push(issue('eolDate', 'EOL_BEFORE_LAUNCH', '停售日期不能早于上市日期', 'The end-of-sale date cannot be before the launch date'));
  if (filled(v.replacementSku) && filled(v.sku) && String(v.replacementSku).toLowerCase() === String(v.sku).toLowerCase()) errors.push(issue('replacementSku', 'REPLACEMENT_SELF', '替代 SKU 不能是它自己', 'A product cannot replace itself'));
  const c = completeness(v, opts);
  for (const k of c.missing) if (!CORE_REQUIRED.has(k) && !errors.some(e => e.field === k)) {
    const d = FIELD.get(k), s = SLOT.get(k), name = d ? d.zh : s!.zh, en = d ? d.en : s!.en;
    warnings.push(issue(k, 'FIELD_REQUIRED_FAMILY', `「${name}」对这个产品族是必填，还没填`, `${en} is required for this product family and still empty`));
  }
  return { errors, warnings, ...c };
}
/** Required fields filled, counting only what the viewer can see (files only when the viewer can see uploads). */
export function completeness(v: Values, opts: { visible: Set<Vis>; files?: Record<string, number> }) {
  const fam = v.family as string, missing: string[] = [];
  let need = 0, got = 0;
  if (!FAMILY_KEYS.includes(fam as Family)) return { need: 1, got: 0, missing: ['family'] };
  for (const d of FIELDS) {
    if (!opts.visible.has(d.vis) || needOf(d.req, fam) !== 'req') continue;
    if (d.type === 'image' && !opts.files) continue;
    need++;
    const ok = d.type === 'image' ? (opts.files?.[d.key] || 0) > 0 : filled(v[d.key]);
    if (ok) got++; else missing.push(d.key);
  }
  if (v.goodsType === 'refurb') { need++; if (filled(v.refbSku)) got++; else if (!missing.includes('refbSku')) missing.push('refbSku'); }
  if (opts.files && opts.visible.has(SLOT_VIS)) for (const s of SLOTS) {
    if (needOf(s.req, fam) !== 'req') continue;
    need++; if ((opts.files[s.key] || 0) > 0) got++; else missing.push(s.key);
  }
  return { need, got, missing };
}

/** The field model as the editor and the template see it, limited to what the viewer may see. */
export function modelFor(v: Viewer) {
  const lv = levelsOf(v);
  return {
    families: FAMILIES, groups: GROUPS, visNames: VIS_NAMES, statusOptions: STATUS_OPTIONS, clearMarker: CLEAR,
    fields: FIELDS.filter(d => lv.has(d.vis)).map(({ store, ...d }) => ({ ...d, editable: canEditField(v, d) })),
    slots: lv.has(SLOT_VIS) ? SLOTS.map(s => ({ ...s, vis: SLOT_VIS, editable: canEditField(v, { vis: SLOT_VIS }) })) : [],
    levels: [...lv],
  };
}
