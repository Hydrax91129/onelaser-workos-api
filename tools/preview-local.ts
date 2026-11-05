/* Preview WorkOS with fictional test data before a release: npm run preview
 *
 * One process on http://localhost:4174 serves the WorkOS frontend (../onelaser-workos/dist, or FRONTEND_DIST) and the
 * API under /api, on an in-memory database that starts fresh every run. Every name, number and record below is made up;
 * nothing here touches the live database, DingTalk, e-mail or any external service.
 *
 * Sign in with password:
 *   owner@workos.test    company owner: sees everything, including the US HR region and costs
 *   hr@workos.test       HR for China and other countries
 *   staff@workos.test    a regular employee
 * Password for all three: workos-preview
 *
 * To preview a pull request: check out its branch in ../onelaser-workos (and here, for backend changes), then run this. */
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize, resolve } from 'node:path';
import { randomBytes } from 'node:crypto';
import { buildApp } from '../src/app.js';
import { createDatabase, schema, seedDemo } from '../src/db.js';
import { hashPassword } from '../src/members.js';

const PORT = Number(process.env.PORT || 4174), ORIGIN = `http://localhost:${PORT}`;
const DIST = resolve(process.env.FRONTEND_DIST || resolve(import.meta.dirname, '..', '..', 'onelaser-workos', 'dist'));
const PASSWORD = 'workos-preview', ORG = 'demo';

const db = await createDatabase();
await db.exec(schema);
await seedDemo(db);
const pw = await hashPassword(PASSWORD);

/* ---------- people: bilingual names, titles, sign-in accounts ---------- */
const people: [string, string, string, string, string][] = [
  // id, Chinese name, English name, title, sign-in e-mail ('' = no sign-in)
  ['m1', '林楠', 'Lin Nan', 'General Manager', 'owner@workos.test'],
  ['m2', '陈一', 'Chen Yi', 'Marketing Specialist', 'staff@workos.test'],
  ['m3', '许夏', 'Xu Xia', 'Content Designer', ''],
  ['m4', '周明', 'Zhou Ming', 'HR & Operations Manager', 'hr@workos.test'],
  ['m5', '赵然', 'Zhao Ran', 'Product Engineer', ''],
  ['m6', '顾安', 'Gu An', 'Warehouse Lead', ''],
];
for (const [id, zh, en, title, email] of people)
  await db.query("UPDATE users SET name_zh=$2,name_en=$3,display_name=$3,title=$4,email=$5,login_email=$6,password_hash=CASE WHEN $6='' THEN password_hash ELSE $7 END WHERE id=$1",
    [id, zh, en, title, email || `${id}@workos.test`, email, pw]);
await db.query(`UPDATE users SET grants='["hr_cn_manage","hr_intl_manage","warehouse","products"]' WHERE id='m4'`);
await db.query(`UPDATE users SET grants='["warehouse","products"]' WHERE id='m6'`);
await db.query("UPDATE users SET manager_id='m1' WHERE id IN ('m4','m5') ");
// A person who has left: their account is disabled, so their HR record shows as left.
await db.query("UPDATE users SET active=false,disabled_at='2026-10-31T17:00:00Z',disabled_by='m1' WHERE id='m3'");

/* ---------- HR records in three regions ---------- */
const hr: [string, string, string, string, string, string][] = [
  // user, region, hire date, type, level, location
  ['m1', 'us', '2021-03-01', 'full_time', 'M3', 'Los Angeles, CA'],
  ['m2', 'cn', '2024-07-15', 'full_time', 'P2', '武汉'],
  ['m3', 'cn', '2023-02-20', 'full_time', 'P2', '武汉'],
  ['m4', 'cn', '2022-05-09', 'full_time', 'M1', '武汉'],
  ['m5', 'us', '2025-09-02', 'full_time', 'P3', 'Ontario, CA'],
  ['m6', 'intl', '2026-01-12', 'contractor', 'P1', 'Toronto, Canada'],
];
for (const [user, region, hire, type, level, place] of hr)
  await db.query(`INSERT INTO hr_profiles(user_id,org_id,region,hire_date,employment_type,job_level,work_location,probation_end,status,last_day)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,CASE WHEN $1='m3' THEN 'left' ELSE 'active' END,CASE WHEN $1='m3' THEN DATE '2026-10-31' END)
    ON CONFLICT (user_id) DO UPDATE SET region=EXCLUDED.region,hire_date=EXCLUDED.hire_date,employment_type=EXCLUDED.employment_type,job_level=EXCLUDED.job_level,
      work_location=EXCLUDED.work_location,probation_end=EXCLUDED.probation_end,status=EXCLUDED.status,last_day=EXCLUDED.last_day`,
    [user, ORG, region, hire, type, level, place, user === 'm6' ? '2026-12-12' : null]);

/* ---------- products, dealer prices and stock (fictional SKUs and prices) ---------- */
const products: [string, string, string, string, number, number, number][] = [
  ['DEMO-F2-60W', 'Demo F2 60W CO2 Laser', 'Machine', 'live', 4999, 3499, 14],
  ['DEMO-F2-100W', 'Demo F2 100W CO2 Laser', 'Machine', 'live', 6999, 4899, 4],
  ['DEMO-RA-1', 'Demo Rotary Attachment', 'Accessory', 'live', 399, 259, 40],
  ['DEMO-AF-200', 'Demo Air Filter 200', 'Accessory', 'clearance', 899, 499, 0],
  ['DEMO-LENS-2', 'Demo Focus Lens 2"', 'Part', 'live', 49, 29.5, 120],
];
for (const [sku, name, type, status, msrp, dealer, qty] of products) {
  await db.query('INSERT INTO product_catalog(org_id,sku,name_en,type,status,msrp) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT DO NOTHING', [ORG, sku, name, type, status, msrp]);
  await db.query("INSERT INTO product_channel_prices(org_id,sku,channel,price,listed) VALUES($1,$2,'dealer',$3,true) ON CONFLICT DO NOTHING", [ORG, sku, dealer]);
  await db.query('INSERT INTO wms_items(org_id,sku,name,type) VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING', [ORG, sku, name, type]);
  if (qty) await db.query("INSERT INTO wms_stock(org_id,sku,location,qty) VALUES($1,$2,'us',$3) ON CONFLICT DO NOTHING", [ORG, sku, qty]);
}

const app = await buildApp({
  db, environment: 'development', mailer: null, completionModel: null, translationModel: null, okrDraftModel: null, nudgeIntervalMs: 0,
  integrations: { appPublicUrl: ORIGIN, executiveUserIds: ['m1'] },
  hr: { dataKey: randomBytes(32).toString('base64') }, // a throwaway key: sensitive HR fields work, and vanish with the process
});

const TYPES: Record<string, string> = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.otf': 'font/otf', '.woff2': 'font/woff2', '.png': 'image/png', '.json': 'application/json', '.webp': 'image/webp', '.ico': 'image/x-icon' };
createServer(async (req, res) => {
  try {
    const url = new URL(req.url || '/', ORIGIN), method = req.method || 'GET';
    if (url.pathname.startsWith('/api/')) {
      const chunks: Buffer[] = []; for await (const c of req) chunks.push(c as Buffer);
      const headers = { ...req.headers }; delete headers['content-length']; delete headers.host;
      const r = await app.inject({ method: method as any, url: url.pathname.slice(4) + url.search, payload: chunks.length ? Buffer.concat(chunks) : undefined, headers: headers as any });
      const out: Record<string, any> = {}; for (const [k, v] of Object.entries(r.headers)) if (k !== 'content-length' && k !== 'transfer-encoding' && v !== undefined) out[k] = v;
      res.writeHead(r.statusCode, out); return res.end(r.rawPayload);
    }
    if (url.pathname === '/runtime-config.js') { res.writeHead(200, { 'content-type': 'text/javascript', 'cache-control': 'no-store' }); return res.end("'use strict';window.WORKOS_CONFIG=Object.freeze({mode:'live',apiBase:'/api'});"); }
    if (url.pathname === '/build-info.json') { res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' }); return res.end(JSON.stringify({ frontendCommit: 'preview', preview: true })); }
    let file = normalize(join(DIST, decodeURIComponent(url.pathname)));
    if (!file.startsWith(DIST)) { res.writeHead(403); return res.end(); }
    if ((await stat(file).catch(() => null))?.isDirectory()) file = join(file, 'index.html');
    const body = await readFile(file).catch(() => null);
    if (!body) { res.writeHead(404); return res.end('Not found'); }
    res.writeHead(200, { 'content-type': TYPES[extname(file)] || 'application/octet-stream', 'cache-control': 'no-store' }); res.end(body);
  } catch (error) { console.error(error); res.writeHead(500); res.end('Preview server error'); }
}).listen(PORT, '127.0.0.1', () => {
  console.log(`WorkOS preview (fictional test data, resets on every start): ${ORIGIN}/`);
  console.log(`Frontend from ${DIST}`);
  console.log(`Sign in: owner@workos.test · hr@workos.test · staff@workos.test — password ${PASSWORD}`);
});
