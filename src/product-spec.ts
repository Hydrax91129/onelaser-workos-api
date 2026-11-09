/* Product library field model (产品资料库), shared by the editor, the bulk template and the import preview.
 *
 * Source: the owner's spec 「OneLaser 产品资料库」 (PIM 字段勾选表 2026-11-03, regrouped 2026-11-04).
 * Every field carries a five-letter family code, one letter per family in FAMILIES order
 * (主机 main, 配件/备件 acc, 耗材 cons, 软件/服务 soft, 内部物料 mat): r 必填, o 选填, n 不适用.
 * For every family except 主机 only the core fields stay required (minReq below).
 *
 * Visibility levels map onto the existing grants (CLAUDE.md rule 4, no new permission system):
 *   all    全员            every signed-in employee (factory contacts are blocked by the server anyway)
 *   ops    产品与供应链     grant `products` (product area access)
 *   cost   仅成本权限       grant `product_cost_detail`
 *   admin  仅管理员         deployment-configured main admins (WORKOS_EXECUTIVE_USER_IDS)
 *   sens   敏感 · 仅编辑者  grant `product_cost_detail` (suppliers, landed cost, last mile, file slots, margins)
 * Main admins see every level. Editing: `products_manage` for product fields, `product_cost_detail` for
 * cost/sensitive fields and files; retail prices follow the existing MSRP rule (products.ts canEditMsrp).
 * No product data lives here: names, placeholders and allowed values only. */

export const FAMILIES = [['main', '主机', 'Machine'], ['acc', '配件/备件', 'Accessory / spare part'], ['cons', '耗材', 'Consumable'],
  ['soft', '软件/服务', 'Software / service'], ['mat', '内部物料', 'Internal material']] as const;
export type Family = typeof FAMILIES[number][0];
export const FAMILY_KEYS = FAMILIES.map(f => f[0]) as Family[];
export const STATUSES = [['dev', '开发中', 'In development'], ['launch', '上新中', 'Launching'], ['live', '在售', 'Selling'],
  ['clearance', '清库存', 'Clearance'], ['eolPlanned', '计划停售', 'Phasing out'], ['eol', '停售', 'Discontinued']] as const;
export const GOODS = [['bulk', '大货', 'New'], ['refb', '退货', 'Returned / refurbished']] as const;
export const FREIGHT = [['dealer', '经销商付运费', 'Dealer pays freight'], ['us', '我们付运费', 'We pay freight']] as const;
export type Vis = 'all' | 'ops' | 'cost' | 'admin' | 'sens';
export const VIS_NAMES: Record<Vis, [string, string]> = {
  all: ['全员', 'Everyone'], ops: ['产品与供应链', 'Product & supply chain'], cost: ['仅成本权限', 'Cost access only'],
  admin: ['仅管理员', 'Admins only'], sens: ['敏感 · 仅编辑者', 'Sensitive · editors only'],
};
/* Field types: text; list (free text with suggestions); enum (one of opts, stored as key); date (YYYY-MM-DD);
 * number (with unit); price (USD); image (main image file). */
export type FieldType = 'text' | 'list' | 'enum' | 'date' | 'number' | 'price' | 'image' | 'sku';
/** Where a value is stored. col: a product_catalog column; dim: one entry of product_catalog.dims; attr: product_catalog.attrs;
 *  sattr: product_pricing.attrs (sensitive); pcol: a product_pricing column; chan: a product_channel_prices row. */
export type Store = { t: 'col'; col: string } | { t: 'dim'; i: number } | { t: 'attr' } | { t: 'sattr' } | { t: 'pcol'; col: string } | { t: 'chan'; channel: string } | { t: 'file' };
export type Field = {
  key: string; zh: string; en: string; ph: string; code: string; vis: Vis; type: FieldType; group: string;
  opts?: readonly (readonly [string, string, string])[] | readonly string[]; unit?: string; store: Store; max?: number;
};
export type Group = { no: string; zh: string; en: string };
export const GROUPS: Group[] = [
  { no: '1', zh: '产品基本参数', en: 'Basic parameters' }, { no: '2', zh: '生命周期', en: 'Lifecycle' },
  { no: '3', zh: '产品详细信息与文件', en: 'Details & files' }, { no: '4', zh: '定价（零售）', en: 'Pricing (retail)' },
  { no: '5', zh: '定价（批发）', en: 'Pricing (wholesale)' }, { no: '6', zh: '包装与物流', en: 'Packaging & logistics' },
  { no: '7', zh: '采购与供应商', en: 'Purchasing & suppliers' }, { no: '8', zh: '售后与库存控制', en: 'After-sales & stock control' },
];
/** Core fields stay required for every family; for families other than 主机 every other 必填 becomes 选填. */
export const CORE_REQUIRED = new Set(['sku', 'goodsType', 'family', 'nameZh', 'nameEn', 'status']);
export const minReq = (key: string, code: string) => CORE_REQUIRED.has(key) ? code : code[0] + code.slice(1).replace(/r/g, 'o');

const F = (group: string, key: string, zh: string, en: string, ph: string, code: string, vis: Vis, type: FieldType, store: Store, extra: Partial<Field> = {}): Field =>
  ({ group, key, zh, en, ph, code: minReq(key, code), vis, type, store, ...extra });
const attr: Store = { t: 'attr' }, sattr: Store = { t: 'sattr' };

export const FIELDS: Field[] = [
  F('1', 'sku', 'SKU', 'SKU', 'ODL-XRF-38-US01', 'rrrrr', 'all', 'sku', { t: 'col', col: 'sku' }),
  F('1', 'goodsType', '大货 / 退货', 'New / returned', '', 'rrrrr', 'all', 'enum', { t: 'col', col: 'goods_type' }, { opts: GOODS }),
  F('1', 'refbSku', '退货 SKU', 'Returned-goods SKU', 'REF-…', 'ooooo', 'all', 'sku', { t: 'col', col: 'refb_sku' }),
  F('1', 'family', '产品族', 'Product family', '', 'rrrrr', 'all', 'enum', { t: 'col', col: 'family' }, { opts: FAMILIES }),
  F('1', 'series', '产品线 / 系列', 'Product line / series', 'XRF', 'rrron', 'all', 'list', attr, { opts: ['XRF', 'Hydra', 'Cobra', 'VertiGo', 'Galvo Flex'] }),
  F('1', 'nameZh', '中文名', 'Chinese name', 'XRF 38W 桌面激光机', 'rrrrr', 'all', 'text', { t: 'col', col: 'name_zh' }, { max: 200 }),
  F('1', 'nameEn', '英文名', 'English name', 'XRF 38W Desktop Laser', 'rrrrr', 'all', 'text', { t: 'col', col: 'name_en' }, { max: 200 }),
  F('1', 'brand', '品牌', 'Brand', 'OneLaser', 'rrron', 'all', 'list', attr, { opts: ['OneLaser'] }),
  F('1', 'model', '型号', 'Model', 'XRF-38', 'ronnn', 'all', 'text', attr),
  F('1', 'gtin', 'UPC / EAN / GTIN', 'UPC / EAN / GTIN', 'UPC 12 位 / EAN 13 位', 'ooonn', 'all', 'text', attr),
  F('1', 'mainImage', '产品主图', 'Main image', '', 'oooon', 'all', 'image', { t: 'file' }),
  F('2', 'status', '状态', 'Status', '', 'rrrro', 'all', 'enum', { t: 'col', col: 'status' }, { opts: STATUSES }),
  F('2', 'launchDate', '上市日期', 'Launch date', '', 'roooo', 'all', 'date', attr),
  F('2', 'eolDate', '停售日期', 'End-of-sale date', '', 'oooon', 'all', 'date', attr),
  F('2', 'replacementSku', '替代 SKU', 'Replacement SKU', '停售后替代的 SKU', 'ooonn', 'all', 'text', attr),
  F('3', 'hsCode', 'HS 编码（美国 HTS 10 位）', 'HS code (US HTS, 10 digits)', '8456.11.…', 'rrrno', 'cost', 'text', attr),
  F('3', 'customsName', '报关品名（中 / 英）', 'Customs description (zh / en)', '激光加工机 / Laser engraving machine', 'rrrno', 'cost', 'text', attr),
  F('3', 'origin', '原产国', 'Country of origin', '中国', 'rrrno', 'all', 'text', attr),
  F('3', 'laserClass', '激光安全等级', 'Laser safety class', 'Class 1', 'rnnnn', 'all', 'list', attr, { opts: ['Class 1', 'Class 2', 'Class 3R', 'Class 4'] }),
  F('3', 'fdaAccession', 'FDA 激光产品报告号', 'FDA laser product accession no.', 'Accession No.', 'rnnnn', 'ops', 'text', attr),
  F('3', 'otherCerts', '其他认证要求', 'Other certification requirements', '如 Prop 65、各州特殊要求', 'roonn', 'ops', 'text', attr),
  F('4', 'landed', '到岸价', 'Landed cost', 'USD', 'rrrnr', 'sens', 'price', { t: 'pcol', col: 'landed_usd' }),
  F('4', 'lastMile', '尾程运费 / 台', 'Last-mile freight / unit', 'USD', 'rrrnn', 'sens', 'price', { t: 'pcol', col: 'last_mile_usd' }),
  F('4', 'msrp', '零售价 MSRP', 'Retail price (MSRP)', '定稿零售价', 'rrrrn', 'all', 'price', { t: 'col', col: 'msrp' }),
  F('4', 'map', '最低公开售价 MAP', 'Minimum advertised price (MAP)', '默认同 MSRP', 'roorn', 'all', 'price', { t: 'chan', channel: 'map' }),
  F('4', 'promoFloor', '官网促销底价', 'Website promotion floor', '仅限固定促销节点', 'roorn', 'all', 'price', { t: 'chan', channel: 'promo_floor' }),
  F('4', 'shipFee', 'MSRP 运费', 'Shipping charged with MSRP', '顾客另付运费，包邮填 0', 'oooon', 'all', 'price', { t: 'col', col: 'ship_fee' }),
  F('4', 'priceMajor', '大促价', 'Major promotion price', '黑五、网一等大促', 'oooon', 'all', 'price', { t: 'chan', channel: 'promo_major' }),
  F('4', 'priceMinor', '小促价', 'Minor promotion price', '日常小促', 'oooon', 'all', 'price', { t: 'chan', channel: 'promo_minor' }),
  F('4', 'priceClear', '清货价', 'Clearance price', '清库存时的价格', 'oooon', 'all', 'price', { t: 'chan', channel: 'clearance' }),
  F('5', 'whFreight', '批发运费承担方', 'Wholesale freight paid by', '', 'oooon', 'all', 'enum', attr, { opts: FREIGHT }),
  F('6', 'netWeight', '净重', 'Net weight', '38', 'rrrnr', 'all', 'number', attr, { unit: 'kg' }),
  F('6', 'grossWeight', '毛重', 'Gross weight', '52', 'rrrnr', 'all', 'number', { t: 'col', col: 'gross' }, { unit: 'kg' }),
  F('6', 'pkgL', '包装长', 'Package length', '110', 'rrrnr', 'all', 'number', { t: 'dim', i: 0 }, { unit: 'cm' }),
  F('6', 'pkgW', '包装宽', 'Package width', '75', 'rrrnr', 'all', 'number', { t: 'dim', i: 1 }, { unit: 'cm' }),
  F('6', 'pkgH', '包装高', 'Package height', '50', 'rrrnr', 'all', 'number', { t: 'dim', i: 2 }, { unit: 'cm' }),
  F('6', 'pkgCount', '包装件数', 'Packages per unit', '2 箱', 'roono', 'all', 'text', attr),
  F('6', 'cartonSpec', '箱规 / 每托数量', 'Carton / units per pallet', '1 台/箱，8 台/托', 'roono', 'all', 'text', attr),
  F('6', 'bestShipping', '最优发货方式', 'Best shipping method', '卡车零担 LTL', 'rrrnn', 'all', 'list', { t: 'col', col: 'best' }, { opts: ['卡车零担 LTL', '快递', '专线'] }),
  F('6', 'dangerous', '危险品 / 电池', 'Dangerous goods / battery', '含锂电池：否', 'rrrnr', 'all', 'text', attr),
  F('6', 'cartonLabel', '商品条码 / 箱标', 'Item barcode / carton label', '条码编号', 'ooono', 'all', 'text', attr),
  F('7', 'supplier', '主供应商', 'Main supplier', '东莞工厂', 'rrrno', 'sens', 'text', sattr),
  F('7', 'supplierAlt1', '备选供应商1', 'Alternative supplier 1', '', 'ooonn', 'sens', 'text', sattr),
  F('7', 'supplierAlt2', '备选供应商2', 'Alternative supplier 2', '', 'ooonn', 'sens', 'text', sattr),
  F('7', 'moqUnit', '最小起订量 / 采购单位', 'MOQ / purchase unit', '10 台 / 件', 'rrrnr', 'ops', 'text', attr),
  F('7', 'productionLead', '生产交期', 'Production lead time', '25 天', 'rrrno', 'ops', 'text', { t: 'col', col: 'lead' }, { max: 60 }),
  F('7', 'firstLeg', '头程时间', 'First-leg transit time', '海运 35 天', 'rrrno', 'ops', 'text', attr),
  F('8', 'warranty', '保修期', 'Warranty', '整机 2 年，激光管 1 年', 'rroon', 'all', 'text', attr),
  F('8', 'safetyStock', '安全库存 / 补货点', 'Safety stock / reorder point', '20 台', 'rrrno', 'ops', 'text', attr),
];
export const FIELD = new Map(FIELDS.map(f => [f.key, f]));

/** File slots (group 3). mode any: PDF/PNG/JPG/WebP/CSV/TXT; pdf: PDF only. All are sensitive. */
export const SLOTS = [
  ['manual', '说明书', 'Manual', 'ronon', 'PDF，带版本号', 'any'], ['spec', '产品参数表', 'Specification sheet', 'rooon', 'PDF 或 CSV', 'any'],
  ['bom', 'BOM 表格', 'BOM', 'ronnn', 'PDF 或 CSV', 'any'], ['cert', '认证（UL / FCC / CE / RoHS）', 'Certificates (UL / FCC / CE / RoHS)', 'ronnn', '证书 PDF 或图片', 'any'],
  ['compliance', '其他合规文件', 'Other compliance documents', 'roonn', 'PDF 或图片', 'any'], ['spareParts', '常用备件清单', 'Common spare parts list', 'ronnn', '仅 PDF', 'pdf'],
  ['warrantyCert', '保修证书', 'Warranty certificate', 'rroon', '仅 PDF', 'pdf'],
].map(([key, zh, en, code, hint, mode]) => ({ key, zh, en, code: minReq(key, code), hint, mode: mode as 'any' | 'pdf', vis: 'sens' as Vis }));
export const SLOT = new Map(SLOTS.map(s => [s.key, s]));
export const FILE_TYPES: Record<string, string> = { pdf: 'application/pdf', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp', csv: 'text/csv', txt: 'text/plain' };
export const IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp']);
export const MAX_FILE = 20 * 1024 * 1024;

export type Req = 'req' | 'opt' | 'na';
export const famCode = (code: string, family: string | null | undefined): Req | null => {
  const i = FAMILY_KEYS.indexOf(family as Family);
  if (i < 0) return null;
  const c = code[i];
  return c === 'r' ? 'req' : c === 'o' ? 'opt' : 'na';
};

/* ---------- who sees what ---------- */
export type Viewer = { levels: Set<Vis>; editCatalog: boolean; editCost: boolean; editPrices: boolean; admin: boolean };
export function viewerOf(grants: string[], admin: boolean): Viewer {
  const g = new Set(grants), cost = admin || g.has('product_cost_detail');
  const levels = new Set<Vis>(['all']);
  if (admin || g.has('products')) levels.add('ops');
  if (cost) { levels.add('cost'); levels.add('sens'); }
  if (admin) levels.add('admin');
  const editCatalog = admin || g.has('products_manage');
  return { levels, editCatalog, editCost: cost, editPrices: editCatalog || cost || g.has('pricing_msrp'), admin };
}
export const canSee = (v: Viewer, vis: Vis) => v.levels.has(vis);
/** Whether this viewer may change a field. Fields they cannot see are never writable. */
export function canWrite(v: Viewer, f: Pick<Field, 'vis' | 'store' | 'key' | 'type'>) {
  if (!canSee(v, f.vis)) return false;
  if (f.key === 'sku') return false;
  if (f.key === 'msrp' || f.key === 'map' || f.key === 'promoFloor') return v.editPrices;
  if (f.key.startsWith('whOv')) return v.editCost;
  if (f.vis === 'sens' || f.vis === 'cost') return v.editCost || (f.vis === 'cost' && v.editCatalog);
  return v.editCatalog;
}

/* ---------- wholesale tier overrides: one price field per tier of the 价格参数 settings ---------- */
export const whOvField = (i: number, tierName: string, floor: boolean): Field => ({
  key: 'whOv' + i, zh: `批发价手动调整 · ${tierName}`, en: `Wholesale price override · ${tierName}`, ph: '自动', code: 'oooon', vis: floor ? 'sens' : 'all',
  type: 'price', group: '5', store: { t: 'chan', channel: 'wh' + i },
});
/** All editable fields in spec order, with the wholesale overrides for the configured tiers. */
export function allFields(whTiers: { name: string; floor?: boolean }[] = []): Field[] {
  const out: Field[] = [];
  for (const f of FIELDS) { out.push(f); if (f.key === 'whFreight') whTiers.forEach((t, i) => out.push(whOvField(i, t.name, !!t.floor))); }
  return out;
}
export const fieldOf = (key: string, whTiers: { name: string; floor?: boolean }[] = []) =>
  FIELD.get(key) || (/^whOv\d+$/.test(key) && Number(key.slice(4)) < whTiers.length ? whOvField(Number(key.slice(4)), whTiers[Number(key.slice(4))].name, !!whTiers[Number(key.slice(4))].floor) : undefined);

/* ---------- value validation (editor and import use the same rules) ---------- */
export const CLEAR = '[清空]';
const SKU_RE = /^[A-Za-z0-9][A-Za-z0-9._\-/ ]*$/;
export type Parsed = { ok: true; value: any } | { ok: false; zh: string; en: string };
const bad = (zh: string, en: string): Parsed => ({ ok: false, zh, en });
const optsOf = (f: Field) => (f.opts || []) as readonly any[];
/** Label (zh/en) or key of an enum value → key. */
export function enumKey(f: Field, raw: string) {
  const s = raw.trim().toLowerCase();
  const hit = optsOf(f).find((o: any) => Array.isArray(o) && (o[0].toLowerCase() === s || o[1].toLowerCase() === s || o[2].toLowerCase() === s));
  return hit ? hit[0] as string : null;
}
export const enumLabel = (f: Field, key: any, lang: 'zh' | 'en' = 'zh') => {
  const hit = optsOf(f).find((o: any) => Array.isArray(o) && o[0] === key);
  return hit ? hit[lang === 'en' ? 2 : 1] : key ?? '';
};
/** Excel stores dates as days since 1899-12-30. */
const excelDate = (n: number) => new Date(Date.UTC(1899, 11, 30) + Math.round(n) * 86400000).toISOString().slice(0, 10);
/** Parses one value. null clears the field; undefined is never returned (callers skip blank cells). */
export function parseValue(f: Field, raw: unknown): Parsed {
  if (raw === null) return { ok: true, value: null };
  if (typeof raw === 'string' && (raw.trim() === '' || raw.trim() === CLEAR)) return { ok: true, value: null };
  if (f.type === 'image') return bad('产品主图请在编辑页上传', 'Upload the main image on the product page');
  const s = typeof raw === 'number' ? String(raw) : typeof raw === 'string' ? raw.trim() : null;
  if (s == null) return bad('格式不对', 'Invalid value');
  switch (f.type) {
    case 'sku':
      if (s.length > 80 || !SKU_RE.test(s)) return bad('SKU 只能用字母、数字、点、横线、斜杠或下划线，且以字母或数字开头', 'Use letters, digits, dot, dash, slash or underscore in the SKU');
      if (f.key === 'refbSku' && !/^REF-./.test(s)) return bad('退货 SKU 必须以 REF- 开头', 'A returned-goods SKU must start with REF-');
      return { ok: true, value: s };
    case 'enum': {
      const k = enumKey(f, s);
      return k ? { ok: true, value: k } : bad(`只能填：${optsOf(f).map((o: any) => o[1]).join(' / ')}`, `Use one of: ${optsOf(f).map((o: any) => o[2]).join(' / ')}`);
    }
    case 'date': {
      if (typeof raw === 'number' || /^\d{5}(\.\d+)?$/.test(s)) { const n = Number(s); if (n > 20000 && n < 80000) return { ok: true, value: excelDate(n) }; }
      const m = s.replace(/[./]/g, '-').match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
      if (!m) return bad('日期格式应为 YYYY-MM-DD', 'Use the date format YYYY-MM-DD');
      const iso = `${m[1]}-${m[2].padStart(2, '0')}-${m[3].padStart(2, '0')}`, d = new Date(iso + 'T00:00:00Z');
      if (isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== iso) return bad('日期不存在', 'This date does not exist');
      return { ok: true, value: iso };
    }
    case 'number': case 'price': {
      const unit = f.unit ? new RegExp(`\\s*${f.unit}$`, 'i') : null;
      const t = (unit ? s.replace(unit, '') : s).replace(/[$,，\s]|USD$/gi, '');
      if (!/^\d+(\.\d+)?$/.test(t)) return bad(f.type === 'price' ? '价格应为不小于 0 的数字（美元）' : `应为不小于 0 的数字${f.unit ? `（单位 ${f.unit}）` : ''}`,
        f.type === 'price' ? 'Use a number of US dollars, 0 or more' : `Use a number, 0 or more${f.unit ? ` (in ${f.unit})` : ''}`);
      const n = Number(t);
      if (n > 10_000_000) return bad('数值太大', 'The number is too large');
      return { ok: true, value: n };
    }
    case 'list': case 'text': {
      if (s.length > (f.max || 500)) return bad(`不能超过 ${f.max || 500} 个字`, `Use at most ${f.max || 500} characters`);
      if (f.key === 'gtin' && !/^(\d{8}|\d{12,14})$/.test(s.replace(/\s/g, ''))) return bad('UPC / EAN / GTIN 应为 8、12、13 或 14 位数字', 'A UPC / EAN / GTIN has 8, 12, 13 or 14 digits');
      if (f.key === 'gtin' && !gs1Ok(s.replace(/\s/g, ''))) return bad('UPC / EAN / GTIN 的校验位不对，请核对条码', 'The UPC / EAN / GTIN check digit is wrong');
      return { ok: true, value: f.key === 'gtin' ? s.replace(/\s/g, '') : s };
    }
  }
  return bad('格式不对', 'Invalid value');
}

/** GS1 check digit (UPC-A, EAN-8/13, GTIN-14): weights 3,1,3,… from the right, excluding the check digit. */
export function gs1Ok(code: string) {
  const d = code.split('').map(Number), check = d.pop()!;
  const sum = d.reverse().reduce((t, x, i) => t + x * (i % 2 === 0 ? 3 : 1), 0);
  return (10 - sum % 10) % 10 === check;
}

/** Rules between products: a return SKU belongs to one product, a replacement SKU must exist, end of sale is not before launch.
 *  index: every SKU (lower case) and every return SKU (lower case → its product's SKU), after the change. */
export function relationIssues(sku: string, after: Record<string, any>, keys: string[], index: { skus: Set<string>; refb: Map<string, string[]> }) {
  const out: { key: string; zh: string; en: string }[] = [], has = (k: string) => keys.includes(k);
  if (after.refbSku && (has('refbSku') || has('goodsType'))) {
    const owners = (index.refb.get(String(after.refbSku).toLowerCase()) || []).filter(s => s.toLowerCase() !== sku.toLowerCase());
    if (owners.length) out.push({ key: 'refbSku', zh: `退货 SKU 已经用在 ${owners[0]}`, en: `This returned-goods SKU is already used by ${owners[0]}` });
  }
  if (after.replacementSku && has('replacementSku')) {
    const r = String(after.replacementSku).trim().toLowerCase();
    if (r === sku.toLowerCase()) out.push({ key: 'replacementSku', zh: '替代 SKU 不能是它自己', en: 'A product cannot replace itself' });
    else if (!index.skus.has(r)) out.push({ key: 'replacementSku', zh: '替代 SKU 不在系统里', en: 'The replacement SKU is not in the catalog' });
  }
  if (after.launchDate && after.eolDate && (has('launchDate') || has('eolDate')) && after.eolDate < after.launchDate)
    out.push({ key: 'eolDate', zh: '停售日期不能早于上市日期', en: 'The end-of-sale date cannot be before the launch date' });
  return out;
}

/* ---------- required-field completeness ---------- */
const filled = (v: any) => v != null && v !== '' && !(Array.isArray(v) && !v.length);
/** Required fields of a record, limited to what this viewer can see. values: field key → value; files: slot → count. */
export function completeness(rec: { values: Record<string, any>; files?: Record<string, number> }, v: Viewer, fields: Field[] = FIELDS) {
  const family = rec.values.family, missing: string[] = [];
  let need = 0, got = 0;
  if (!family) return { need: 1, got: 0, missing: ['family'], done: false };
  for (const f of fields) {
    if (!canSee(v, f.vis)) continue;
    const req = f.key === 'refbSku' ? rec.values.goodsType === 'refb' : famCode(f.code, family) === 'req';
    if (!req) continue;
    need++;
    if (filled(rec.values[f.key])) got++; else missing.push(f.key);
  }
  if (rec.files && canSee(v, 'sens')) for (const s of SLOTS) {
    if (famCode(s.code, family) !== 'req') continue;
    need++;
    if ((rec.files[s.key] || 0) > 0) got++; else missing.push('file:' + s.key);
  }
  return { need, got, missing, done: got >= need };
}

/** The field model as the client renders it, limited to the viewer's levels. */
export function specFor(v: Viewer, whTiers: { name: string; floor?: boolean }[] = []) {
  return {
    families: FAMILIES.map(([key, zh, en]) => ({ key, zh, en })), statuses: STATUSES.map(([key, zh, en]) => ({ key, zh, en })),
    groups: GROUPS, visNames: VIS_NAMES, clearMarker: CLEAR, coreRequired: [...CORE_REQUIRED],
    fields: allFields(whTiers).filter(f => canSee(v, f.vis)).map(f => ({
      key: f.key, zh: f.zh, en: f.en, ph: f.ph, code: f.code, vis: f.vis, type: f.type, group: f.group, unit: f.unit || null,
      opts: f.opts ? optsOf(f).map((o: any) => Array.isArray(o) ? { key: o[0], zh: o[1], en: o[2] } : { key: o, zh: o, en: o }) : null,
      writable: canWrite(v, f),
    })),
    slots: canSee(v, 'sens') ? SLOTS.map(s => ({ ...s, writable: v.editCost })) : [],
  };
}
