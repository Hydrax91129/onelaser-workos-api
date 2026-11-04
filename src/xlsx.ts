/* Minimal .xlsx writer and reader for the product template (no dependency).
 * Writer: string / number cells, bold header rows, hidden rows, frozen panes, column widths, list dropdowns
 * (data validation against a hidden "lists" sheet) and several sheets. Reader: the first worksheet (or one by name),
 * shared and inline strings, numbers and booleans. Anything else in a workbook is ignored. */
import { crc32, deflateRawSync, inflateRawSync } from 'node:zlib';

/* ---------- zip ---------- */
type Entry = { name: string; data: Buffer };
function zip(entries: Entry[]) {
  const chunks: Buffer[] = [], central: Buffer[] = [];
  let offset = 0;
  for (const e of entries) {
    const name = Buffer.from(e.name, 'utf8'), body = deflateRawSync(e.data), crc = crc32(e.data) >>> 0;
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(0x0800, 6); local.writeUInt16LE(8, 8);
    local.writeUInt32LE(0, 10); local.writeUInt32LE(crc, 14); local.writeUInt32LE(body.length, 18); local.writeUInt32LE(e.data.length, 22);
    local.writeUInt16LE(name.length, 26); local.writeUInt16LE(0, 28);
    chunks.push(local, name, body);
    const c = Buffer.alloc(46);
    c.writeUInt32LE(0x02014b50, 0); c.writeUInt16LE(20, 4); c.writeUInt16LE(20, 6); c.writeUInt16LE(0x0800, 8); c.writeUInt16LE(8, 10);
    c.writeUInt32LE(0, 12); c.writeUInt32LE(crc, 16); c.writeUInt32LE(body.length, 20); c.writeUInt32LE(e.data.length, 24);
    c.writeUInt16LE(name.length, 28); c.writeUInt32LE(offset, 42);
    central.push(c, name);
    offset += 30 + name.length + body.length;
  }
  const cd = Buffer.concat(central), end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...chunks, cd, end]);
}
const MAX_ENTRY = 50 * 1024 * 1024, MAX_TOTAL = 100 * 1024 * 1024;
export function unzip(buf: Buffer): Map<string, Buffer> {
  const out = new Map<string, Buffer>();
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65557); i--) if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  if (eocd < 0) throw new Error('NOT_ZIP');
  const count = buf.readUInt16LE(eocd + 10);
  // A workbook is a few dozen parts; limits on parts and on unpacked size (counted from the real output) stop zip bombs.
  if (count > 2000) throw new Error('ZIP_TOO_MANY_ENTRIES');
  let p = buf.readUInt32LE(eocd + 16), total = 0;
  for (let n = 0; n < count; n++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) throw new Error('NOT_ZIP');
    const method = buf.readUInt16LE(p + 10), csize = buf.readUInt32LE(p + 20), usize = buf.readUInt32LE(p + 24);
    const nlen = buf.readUInt16LE(p + 28), xlen = buf.readUInt16LE(p + 30), clen = buf.readUInt16LE(p + 32), loc = buf.readUInt32LE(p + 42);
    const name = buf.subarray(p + 46, p + 46 + nlen).toString('utf8');
    p += 46 + nlen + xlen + clen;
    if (!/^(xl\/|\[Content_Types\])/.test(name)) continue;
    const left = MAX_TOTAL - total;
    if (left <= 0 || usize > left) throw new Error('ZIP_TOO_LARGE');
    const start = loc + 30 + buf.readUInt16LE(loc + 26) + buf.readUInt16LE(loc + 28), raw = buf.subarray(start, start + csize);
    const body = method === 0 ? Buffer.from(raw) : method === 8 ? inflateRawSync(raw, { maxOutputLength: Math.min(MAX_ENTRY, left) }) : Buffer.alloc(0);
    total += body.length;
    out.set(name, body);
  }
  return out;
}

/* ---------- writer ---------- */
const xml = (s: string) => s.replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]!)).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '');
export const colName = (i: number) => { let s = ''; i++; while (i) { const m = (i - 1) % 26; s = String.fromCharCode(65 + m) + s; i = Math.floor((i - 1) / 26); } return s; };
export type Sheet = {
  name: string; rows: (string | number | null | undefined)[][]; boldRows?: number[]; hiddenRows?: number[]; hidden?: boolean;
  freeze?: { rows: number; cols: number }; widths?: number[];
  /** dropdowns: column index → list of allowed values, applied from firstRow (1-based) to lastRow; strict = reject other values. */
  lists?: { col: number; values: string[]; strict: boolean; firstRow: number; lastRow: number }[];
};
export function writeXlsx(sheets: Sheet[]) {
  const listSheet: Sheet = { name: 'lists', rows: [], hidden: true };
  const all = [...sheets];
  const listRefs: string[][] = sheets.map(() => []);
  let lc = 0;
  sheets.forEach((s, si) => (s.lists || []).forEach(l => {
    const c = lc++;
    l.values.forEach((v, r) => { (listSheet.rows[r] ||= [])[c] = v; });
    listRefs[si].push(`<dataValidation type="list" allowBlank="1" showErrorMessage="1" errorStyle="${l.strict ? 'stop' : 'warning'}" errorTitle="不在可选范围" error="请从下拉列表中选择" sqref="${colName(l.col)}${l.firstRow}:${colName(l.col)}${l.lastRow}"><formula1>lists!$${colName(c)}$1:$${colName(c)}$${Math.max(1, l.values.length)}</formula1></dataValidation>`);
  }));
  if (lc) all.push(listSheet);
  const sheetXml = (s: Sheet, si: number) => {
    const bold = new Set(s.boldRows || []), hidden = new Set(s.hiddenRows || []);
    const rows = s.rows.map((r, ri) => `<row r="${ri + 1}"${hidden.has(ri + 1) ? ' hidden="1"' : ''}>${(r || []).map((v, ci) => {
      if (v == null || v === '') return '';
      const ref = colName(ci) + (ri + 1), st = bold.has(ri + 1) ? ' s="1"' : ' s="2"';
      return typeof v === 'number' && isFinite(v) ? `<c r="${ref}"${st}><v>${v}</v></c>` : `<c r="${ref}"${st} t="inlineStr"><is><t xml:space="preserve">${xml(String(v))}</t></is></c>`;
    }).join('')}</row>`).join('');
    const f = s.freeze, pane = f && (f.rows || f.cols) ? `<sheetViews><sheetView workbookViewId="0"><pane${f.cols ? ` xSplit="${f.cols}"` : ''}${f.rows ? ` ySplit="${f.rows}"` : ''} topLeftCell="${colName(f.cols)}${f.rows + 1}" activePane="bottomRight" state="frozen"/></sheetView></sheetViews>` : '';
    const cols = s.widths?.length ? `<cols>${s.widths.map((w, i) => `<col min="${i + 1}" max="${i + 1}" width="${w}" customWidth="1"/>`).join('')}</cols>` : '';
    const dv = listRefs[si]?.length ? `<dataValidations count="${listRefs[si].length}">${listRefs[si].join('')}</dataValidations>` : '';
    return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">${pane}${cols}<sheetData>${rows}</sheetData>${dv}</worksheet>`;
  };
  const enc = (s: string) => Buffer.from(s, 'utf8');
  return zip([
    { name: '[Content_Types].xml', data: enc(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>${all.map((_, i) => `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join('')}</Types>`) },
    { name: '_rels/.rels', data: enc(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`) },
    { name: 'xl/workbook.xml', data: enc(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>${all.map((s, i) => `<sheet name="${xml(s.name)}" sheetId="${i + 1}"${s.hidden ? ' state="hidden"' : ''} r:id="rId${i + 1}"/>`).join('')}</sheets></workbook>`) },
    { name: 'xl/_rels/workbook.xml.rels', data: enc(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${all.map((_, i) => `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`).join('')}<Relationship Id="rId${all.length + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>`) },
    { name: 'xl/styles.xml', data: enc(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><numFmts count="0"/><fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><name val="Calibri"/></font></fonts><fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills><borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="3"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="49" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1" applyNumberFormat="1"/><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/></cellXfs></styleSheet>`) },
    ...all.map((s, i) => ({ name: `xl/worksheets/sheet${i + 1}.xml`, data: enc(sheetXml(s, i)) })),
  ]);
}

/* ---------- reader ---------- */
const unxml = (s: string) => s.replace(/&(lt|gt|quot|apos|amp|#(\d+)|#x([0-9a-f]+));/gi, (_, n, d, h) => d ? String.fromCodePoint(Number(d)) : h ? String.fromCodePoint(parseInt(h, 16)) : ({ lt: '<', gt: '>', quot: '"', apos: "'", amp: '&' } as any)[n]);
const texts = (s: string) => [...s.matchAll(/<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/g)].map(m => unxml(m[1])).join('');
const colIndex = (ref: string) => { let n = 0; for (const ch of ref.replace(/\d+$/, '')) n = n * 26 + ch.charCodeAt(0) - 64; return n - 1; };
/** Rows of one sheet as arrays (index = column). Strings stay strings, numbers become numbers. */
export function readXlsx(buf: Buffer, prefer?: string): (string | number | null)[][] {
  const files = unzip(buf);
  const wb = files.get('xl/workbook.xml')?.toString('utf8');
  if (!wb) throw new Error('NOT_XLSX');
  const rels = files.get('xl/_rels/workbook.xml.rels')?.toString('utf8') || '';
  const sheets = [...wb.matchAll(/<sheet\b[^>]*?name="([^"]*)"[^>]*?r:id="([^"]+)"[^>]*\/?>/g)].map(m => ({ name: unxml(m[1]), rid: m[2] }));
  const pick = sheets.find(s => s.name === prefer) || sheets[0];
  if (!pick) throw new Error('NOT_XLSX');
  const target = (rels.match(new RegExp(`<Relationship\\b[^>]*Id="${pick.rid}"[^>]*Target="([^"]+)"`)) || rels.match(new RegExp(`<Relationship\\b[^>]*Target="([^"]+)"[^>]*Id="${pick.rid}"`)))?.[1];
  const path = target ? (target.startsWith('/') ? target.slice(1) : 'xl/' + target.replace(/^\.\//, '')) : 'xl/worksheets/sheet1.xml';
  const sheet = files.get(path)?.toString('utf8');
  if (!sheet) throw new Error('NOT_XLSX');
  const shared = [...(files.get('xl/sharedStrings.xml')?.toString('utf8') || '').matchAll(/<si>([\s\S]*?)<\/si>/g)].map(m => texts(m[1]));
  const rows: (string | number | null)[][] = [];
  for (const rm of sheet.matchAll(/<row\b([^>]*)>([\s\S]*?)<\/row>|<row\b([^>]*)\/>/g)) {
    const attrs = rm[1] || rm[3] || '', rn = Number((attrs.match(/\br="(\d+)"/) || [])[1]) || rows.length + 1, row: (string | number | null)[] = [];
    for (const cm of (rm[2] || '').matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
      const a = cm[1], body = cm[2] || '', ref = (a.match(/\br="([A-Z]+\d+)"/) || [])[1], t = (a.match(/\bt="([^"]+)"/) || [])[1];
      const ci = ref ? colIndex(ref) : row.length;
      const v = (body.match(/<v>([\s\S]*?)<\/v>/) || [])[1];
      row[ci] = t === 's' ? shared[Number(v)] ?? '' : t === 'inlineStr' ? texts(body) : t === 'str' || t === 'e' ? unxml(v || '') : t === 'b' ? (v === '1' ? 'TRUE' : 'FALSE') : v == null ? null : Number(v);
    }
    rows[rn - 1] = row;
  }
  for (let i = 0; i < rows.length; i++) rows[i] ||= [];
  return rows;
}

/* ---------- CSV ---------- */
export function writeCsv(rows: (string | number | null | undefined)[][]) {
  // A text cell that starts like a formula gets a leading apostrophe so spreadsheet programs keep it as text; readCsv strips it again.
  return '﻿' + rows.map(r => r.map(v => {
    let s = v == null ? '' : String(v);
    if (typeof v === 'string' && /^[=+\-@\t\r]/.test(s) && isNaN(Number(s))) s = "'" + s;
    return /[",\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  }).join(',')).join('\r\n') + '\r\n';
}
export function readCsv(text: string): string[][] {
  const s = text.replace(/^﻿/, ''), rows: string[][] = [];
  let row: string[] = [], cell = '', q = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (q) { if (c === '"') { if (s[i + 1] === '"') { cell += '"'; i++; } else q = false; } else cell += c; continue; }
    if (c === '"') q = true; else if (c === ',') { row.push(cell); cell = ''; }
    else if (c === '\n' || c === '\r') { if (c === '\r' && s[i + 1] === '\n') i++; row.push(cell); rows.push(row); row = []; cell = ''; }
    else cell += c;
  }
  if (cell !== '' || row.length) { row.push(cell); rows.push(row); }
  return rows.map(r => r.map(c => c.replace(/^'(?=[=+\-@\t\r])/, '')));
}
