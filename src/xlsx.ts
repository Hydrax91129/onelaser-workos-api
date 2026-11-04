/* Minimal .xlsx and CSV reading/writing for the product template (no third-party dependency).
 * Writes: inline-string cells, a bold header style, a text-format column style, frozen header rows,
 * list dropdowns (data validation pointing at a hidden sheet) and hidden sheets.
 * Reads: the first matching worksheet of a workbook saved by Excel, Numbers, WPS or LibreOffice
 * (shared strings, inline strings, numbers, booleans), with size limits against zip bombs. */
import { deflateRawSync, inflateRawSync, crc32 } from 'node:zlib';

export type Cell = string | number | null | undefined;
export interface SheetSpec {
  name: string; rows: Cell[][]; hidden?: boolean; headerRows?: number; freeze?: { rows: number; cols: number };
  widths?: number[]; textCols?: number[]; lists?: { col: number; values: string[]; strict: boolean }[];
}

/* ---------- zip ---------- */
function zip(files: { name: string; data: Buffer }[]): Buffer {
  const locals: Buffer[] = [], centrals: Buffer[] = [];
  let offset = 0;
  for (const f of files) {
    const name = Buffer.from(f.name, 'utf8'), body = deflateRawSync(f.data), crc = crc32(f.data);
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4); lh.writeUInt16LE(0x0800, 6); lh.writeUInt16LE(8, 8);
    lh.writeUInt32LE(0, 10); lh.writeUInt32LE(crc, 14); lh.writeUInt32LE(body.length, 18); lh.writeUInt32LE(f.data.length, 22);
    lh.writeUInt16LE(name.length, 26); lh.writeUInt16LE(0, 28);
    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0); ch.writeUInt16LE(20, 4); ch.writeUInt16LE(20, 6); ch.writeUInt16LE(0x0800, 8); ch.writeUInt16LE(8, 10);
    ch.writeUInt32LE(0, 12); ch.writeUInt32LE(crc, 16); ch.writeUInt32LE(body.length, 20); ch.writeUInt32LE(f.data.length, 24);
    ch.writeUInt16LE(name.length, 28); ch.writeUInt32LE(offset, 42);
    locals.push(lh, name, body); centrals.push(ch, name);
    offset += 30 + name.length + body.length;
  }
  const cd = Buffer.concat(centrals), end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(files.length, 8); end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, end]);
}
export class FileFormatError extends Error {}
function unzip(buf: Buffer, maxTotal = 60 * 1024 * 1024): Map<string, Buffer> {
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65557); i--) if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  if (eocd < 0) throw new FileFormatError('not a zip file');
  const count = buf.readUInt16LE(eocd + 10), out = new Map<string, Buffer>();
  let p = buf.readUInt32LE(eocd + 16), total = 0;
  for (let n = 0; n < count; n++) {
    if (p + 46 > buf.length || buf.readUInt32LE(p) !== 0x02014b50) throw new FileFormatError('broken zip directory');
    const method = buf.readUInt16LE(p + 10), csize = buf.readUInt32LE(p + 20), usize = buf.readUInt32LE(p + 24);
    const nlen = buf.readUInt16LE(p + 28), xlen = buf.readUInt16LE(p + 30), clen = buf.readUInt16LE(p + 32), lho = buf.readUInt32LE(p + 42);
    const name = buf.subarray(p + 46, p + 46 + nlen).toString('utf8');
    p += 46 + nlen + xlen + clen;
    if (!/\.(xml|rels)$/.test(name)) continue;
    if (lho + 30 > buf.length || buf.readUInt32LE(lho) !== 0x04034b50) throw new FileFormatError('broken zip entry');
    const start = lho + 30 + buf.readUInt16LE(lho + 26) + buf.readUInt16LE(lho + 28), raw = buf.subarray(start, start + csize);
    total += usize;
    if (total > maxTotal) throw new FileFormatError('file too large when unpacked');
    const data = method === 0 ? Buffer.from(raw) : method === 8 ? inflateRawSync(raw, { maxOutputLength: Math.max(usize, 1) + 1024 }) : null;
    if (!data) throw new FileFormatError('unsupported compression');
    out.set(name, data);
  }
  return out;
}

/* ---------- xml helpers ---------- */
const esc = (s: string) => s.replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]!)).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '');
const unesc = (s: string) => s.replace(/&(#x[0-9a-f]+|#\d+|lt|gt|amp|quot|apos);/gi, (_, e: string) =>
  e[0] === '#' ? String.fromCodePoint(e[1].toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10)) : ({ lt: '<', gt: '>', amp: '&', quot: '"', apos: "'" } as any)[e.toLowerCase()]);
export const colName = (i: number) => { let s = ''; for (i++; i > 0; i = Math.floor((i - 1) / 26)) s = String.fromCharCode(65 + ((i - 1) % 26)) + s; return s; };
const colIndex = (ref: string) => { let n = 0; for (const ch of ref.replace(/\d+$/, '')) n = n * 26 + ch.charCodeAt(0) - 64; return n - 1; };
const sheetName = (s: string) => s.replace(/[\\/?*[\]:]/g, ' ').slice(0, 31);

/* ---------- write ---------- */
export function writeXlsx(sheets: SheetSpec[]): Buffer {
  const listSheet: string[][] = [], refs: string[] = [];
  const sheetXml = sheets.map(sh => {
    const maxRow = Math.max(sh.rows.length + 2000, 5000), hdr = sh.headerRows || 0, cols = Math.max(0, ...sh.rows.map(r => r.length));
    const colsXml = Array.from({ length: cols }, (_, i) => `<col min="${i + 1}" max="${i + 1}" width="${sh.widths?.[i] || 16}" customWidth="1"${sh.textCols?.includes(i) ? ' style="2"' : ''}/>`).join('');
    const rows = sh.rows.map((r, ri) => `<row r="${ri + 1}">${r.map((v, ci) => {
      if (v == null || v === '') return '';
      const ref = colName(ci) + (ri + 1), s = ri < hdr ? ' s="1"' : sh.textCols?.includes(ci) ? ' s="2"' : '';
      return typeof v === 'number' && isFinite(v) ? `<c r="${ref}"${s}><v>${v}</v></c>` : `<c r="${ref}" t="inlineStr"${s}><is><t xml:space="preserve">${esc(String(v))}</t></is></c>`;
    }).join('')}</row>`).join('');
    const pane = sh.freeze ? `<sheetViews><sheetView workbookViewId="0"><pane xSplit="${sh.freeze.cols}" ySplit="${sh.freeze.rows}" topLeftCell="${colName(sh.freeze.cols)}${sh.freeze.rows + 1}" activePane="bottomRight" state="frozen"/></sheetView></sheetViews>` : '';
    const dv = (sh.lists || []).filter(l => l.values.length).map(l => {
      const at = listSheet.length; listSheet.push(l.values);
      const range = `'_lists'!$${colName(at)}$1:$${colName(at)}$${l.values.length}`;
      return `<dataValidation type="list" allowBlank="1" showErrorMessage="${l.strict ? 1 : 0}" errorStyle="${l.strict ? 'stop' : 'information'}" sqref="${colName(l.col)}${hdr + 1}:${colName(l.col)}${maxRow}"><formula1>${esc(range)}</formula1></dataValidation>`;
    });
    return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">${pane}${colsXml ? `<cols>${colsXml}</cols>` : ''}<sheetData>${rows}</sheetData>${dv.length ? `<dataValidations count="${dv.length}">${dv.join('')}</dataValidations>` : ''}</worksheet>`;
  });
  const all = [...sheets];
  if (listSheet.length) {
    const height = Math.max(...listSheet.map(l => l.length));
    all.push({ name: '_lists', hidden: true, rows: Array.from({ length: height }, (_, r) => listSheet.map(l => l[r] ?? null)) });
    sheetXml.push(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${all[all.length - 1].rows.map((r, ri) => `<row r="${ri + 1}">${r.map((v, ci) => v == null ? '' : `<c r="${colName(ci)}${ri + 1}" t="inlineStr"><is><t xml:space="preserve">${esc(String(v))}</t></is></c>`).join('')}</row>`).join('')}</sheetData></worksheet>`);
  }
  all.forEach((_, i) => refs.push(`xl/worksheets/sheet${i + 1}.xml`));
  const files = [
    { name: '[Content_Types].xml', data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>${refs.map(r => `<Override PartName="/${r}" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join('')}</Types>` },
    { name: '_rels/.rels', data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>` },
    { name: 'xl/workbook.xml', data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>${all.map((s, i) => `<sheet name="${esc(sheetName(s.name))}" sheetId="${i + 1}"${s.hidden ? ' state="hidden"' : ''} r:id="rId${i + 1}"/>`).join('')}</sheets></workbook>` },
    { name: 'xl/_rels/workbook.xml.rels', data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${refs.map((r, i) => `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="${r.slice(3)}"/>`).join('')}<Relationship Id="rId${refs.length + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>` },
    { name: 'xl/styles.xml', data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><name val="Calibri"/></font></fonts><fills count="3"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill><fill><patternFill patternType="solid"><fgColor rgb="FFEEF1F5"/></patternFill></fill></fills><borders count="1"><border/></borders><cellStyleXfs count="1"><xf/></cellStyleXfs><cellXfs count="3"><xf/><xf fontId="1" fillId="2" applyFont="1" applyFill="1"/><xf numFmtId="49" applyNumberFormat="1"/></cellXfs></styleSheet>` },
    ...sheetXml.map((x, i) => ({ name: refs[i], data: x })),
  ];
  return zip(files.map(f => ({ name: f.name, data: Buffer.from(f.data, 'utf8') })));
}

/* ---------- read ---------- */
/** Rows of the first sheet whose name is in `prefer`, else the first visible sheet. Cells are strings or numbers. */
export function readXlsx(buf: Buffer, prefer: string[] = []): Cell[][] {
  const files = unzip(buf), text = (n: string) => files.get(n)?.toString('utf8');
  const wb = text('xl/workbook.xml');
  if (!wb) throw new FileFormatError('no workbook');
  const rels = new Map([...(text('xl/_rels/workbook.xml.rels') || '').matchAll(/<Relationship\b[^>]*>/g)].map(m => [m[0].match(/Id="([^"]+)"/)?.[1], m[0].match(/Target="([^"]+)"/)?.[1]]));
  const sheets = [...wb.matchAll(/<sheet\b[^>]*>/g)].map(m => ({ name: unesc(m[0].match(/name="([^"]*)"/)?.[1] || ''), hidden: /state="(hidden|veryHidden)"/.test(m[0]), rid: m[0].match(/r:id="([^"]+)"/)?.[1] }));
  const pick = sheets.find(s => prefer.includes(s.name)) || sheets.find(s => !s.hidden) || sheets[0];
  if (!pick) throw new FileFormatError('no sheet');
  let target = rels.get(pick.rid) || '';
  target = target.startsWith('/') ? target.slice(1) : 'xl/' + target.replace(/^\.\//, '');
  const xml = text(target);
  if (!xml) throw new FileFormatError('sheet missing');
  const strip = (s: string) => s.replace(/<rPh\b[\s\S]*?<\/rPh>/g, '');
  const tText = (s: string) => [...strip(s).matchAll(/<t\b[^>]*>([\s\S]*?)<\/t>|<t\b[^>]*\/>/g)].map(m => unesc(m[1] || '')).join('');
  const shared = [...(text('xl/sharedStrings.xml') || '').matchAll(/<si\b[^>]*>([\s\S]*?)<\/si>|<si\b[^>]*\/>/g)].map(m => tText(m[1] || ''));
  const rows: Cell[][] = [];
  for (const rm of xml.matchAll(/<row\b([^>]*?)(?:\/>|>([\s\S]*?)<\/row>)/g)) {
    const r = Number(rm[1].match(/\br="(\d+)"/)?.[1] || rows.length + 1) - 1, row: Cell[] = [];
    if (r > 20000) break;
    let next = 0;
    for (const cm of (rm[2] || '').matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
      const attrs = cm[1], ref = attrs.match(/\br="([A-Z]+\d+)"/)?.[1], ci = ref ? colIndex(ref) : next, t = attrs.match(/\bt="([^"]+)"/)?.[1] || 'n', body = cm[2] || '';
      next = ci + 1;
      if (ci > 500) continue;
      const v = body.match(/<v\b[^>]*>([\s\S]*?)<\/v>/)?.[1];
      let val: Cell = null;
      if (t === 's') val = v != null ? shared[Number(v)] ?? null : null;
      else if (t === 'inlineStr') val = tText(body.match(/<is\b[^>]*>([\s\S]*?)<\/is>/)?.[1] || '');
      else if (t === 'str' || t === 'e') val = v != null ? unesc(v) : null;
      else if (t === 'b') val = v === '1' ? 'TRUE' : 'FALSE';
      else if (v != null) { const n = Number(v); val = isFinite(n) ? n : unesc(v); }
      row[ci] = val;
    }
    rows[r] = row;
  }
  return Array.from({ length: rows.length }, (_, i) => rows[i] || []);
}

export function writeCsv(rows: Cell[][]): Buffer {
  // Text that a spreadsheet would run as a formula gets a leading apostrophe (stripped again on import).
  const cell = (v: Cell) => { let s = v == null ? '' : String(v); if (typeof v === 'string' && /^[=+@]/.test(s)) s = "'" + s; return /[",\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; };
  return Buffer.from('﻿' + rows.map(r => r.map(cell).join(',')).join('\r\n') + '\r\n', 'utf8');
}
export function readCsv(buf: Buffer): Cell[][] {
  let s: string;
  try { s = new TextDecoder('utf-8', { fatal: true }).decode(buf); } catch { throw new FileFormatError('CSV must be UTF-8'); }
  s = s.replace(/^﻿/, '');
  const rows: Cell[][] = []; let row: Cell[] = [], cur = '', q = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (q) { if (c === '"') { if (s[i + 1] === '"') { cur += '"'; i++; } else q = false; } else cur += c; continue; }
    if (c === '"' && cur === '') q = true;
    else if (c === ',') { row.push(cur); cur = ''; }
    else if (c === '\n' || c === '\r') { if (c === '\r' && s[i + 1] === '\n') i++; row.push(cur); rows.push(row); row = []; cur = ''; }
    else cur += c;
  }
  if (cur !== '' || row.length) { row.push(cur); rows.push(row); }
  return rows;
}
