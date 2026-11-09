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
 * Password for all three: workos-preview, or PREVIEW_PASSWORD when set (the hosted test site sets its own).
 *
 * To preview a pull request: check out its branch in ../onelaser-workos (and here, for backend changes), then run this.
 * Hosted test site: Dockerfile.preview builds this with the frontend commit in deploy/preview-frontend-revision.txt;
 * a separate Render service deploys the claude/preview branch. It never shares a database with craftos.app. */
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize, resolve } from 'node:path';
import { randomBytes } from 'node:crypto';
import { buildApp } from '../src/app.js';
import { createDatabase, schema, seedDemo } from '../src/db.js';
import { issueSession } from '../src/auth.js';
import { hashPassword } from '../src/members.js';

const PORT = Number(process.env.PORT || 4174), HOST = process.env.HOST || '127.0.0.1';
const ORIGIN = (process.env.RENDER_EXTERNAL_URL || process.env.PREVIEW_PUBLIC_URL || `http://localhost:${PORT}`).replace(/\/$/, '');
const DIST = resolve(process.env.FRONTEND_DIST || resolve(import.meta.dirname, '..', '..', 'onelaser-workos', 'dist'));
const FRONTEND_COMMIT = (await readFile(process.env.PREVIEW_FRONTEND_COMMIT_FILE || '/nonexistent', 'utf8').catch(() => 'local')).trim();
// A strip on every page so nobody mistakes the test site for craftos.app.
const BANNER = `<div style="position:fixed;left:50%;bottom:10px;transform:translateX(-50%);z-index:9999;background:#a15c00;color:#fff;font:600 12px system-ui;padding:5px 12px;border-radius:999px;box-shadow:0 4px 14px #0003;pointer-events:none">测试站 · 虚构数据，每次部署都会重置 · Test site, fictional data · ${FRONTEND_COMMIT.slice(0, 7)}</div>`;
const PASSWORD = process.env.PREVIEW_PASSWORD || 'workos-preview', ORG = 'demo';
if (process.env.RENDER && !process.env.PREVIEW_PASSWORD) throw new Error('Set PREVIEW_PASSWORD on the hosted test site; the default password is public.');

// In memory by default. The hosted test site sets PREVIEW_DATABASE_URL to its own throwaway Postgres (PGlite needs more
// memory than Render's free instance has); that database is wiped and reseeded on every start, so never point it at real data.
const PREVIEW_DB = process.env.PREVIEW_DATABASE_URL?.trim();
if (PREVIEW_DB && PREVIEW_DB === process.env.DATABASE_URL?.trim()) throw new Error('PREVIEW_DATABASE_URL must be a separate, throwaway database');
const db = await createDatabase(PREVIEW_DB ? { connectionString: PREVIEW_DB } : {});
if (PREVIEW_DB) await db.exec('DROP SCHEMA IF EXISTS public CASCADE; CREATE SCHEMA public;');
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
await db.query("UPDATE users SET manager_id='m4' WHERE id IN ('m2','m6') ");
// OKR: Zhao Ran has published this month's OKR; everyone else is behind, so the owner can try 一键催办.
{ const d = new Date(), p = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
  const o = (await db.query("INSERT INTO objectives(id,org_id,department_id,owner_id,title,level,planning) SELECT 'demo-okr-1',org_id,department_id,id,'Demo: launch the F2 accessory bundle','personal',jsonb_build_object('period',$1::text,'weight',100) FROM users WHERE id='m5' ON CONFLICT DO NOTHING RETURNING id", [p])).rows[0];
  if (o) await db.query("INSERT INTO okr_publications(org_id,owner_id,period,published_by) SELECT org_id,'m5',$1,'m5' FROM users WHERE id='m5' ON CONFLICT DO NOTHING", [p]); }
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

// Sample AI for the test site: "AI 拆任务" splits the text at sentence breaks and hands the pieces round the members,
// so the draft-and-confirm flow can be tried without an AI account. Other AI features stay off here.
const previewAi = { model: 'preview-sample', json: async (_system: string, user: string, _schema: object, name: string) => {
  if (name !== 'project_tasks') throw new Error('AI is not configured on the test site');
  const input = JSON.parse(user), parts = String(input.request).split(/[。；;\n]+|，(?=[^，]{6,})/).map((x: string) => x.trim()).filter((x: string) => x.length >= 2).slice(0, 8);
  const end = new Date(input.project.end + 'T00:00:00Z').getTime(), now = Date.now();
  return { tasks: parts.map((t: string, i: number) => ({ title: t.slice(0, 60), description: '示例 AI 拆分（测试站）', owner: (i % Math.max(1, input.people.length)) + 1,
    stage: Math.min(input.stages.length, 1 + Math.floor(i * input.stages.length / Math.max(1, parts.length))), dueDate: new Date(now + (end - now) * (i + 1) / (parts.length + 1)).toISOString().slice(0, 10), priority: i === 0 ? 'high' : 'medium' })) };
} };

const app = await buildApp({
  db, environment: 'development', mailer: null, completionModel: null, translationModel: null, okrDraftModel: previewAi, nudgeIntervalMs: 0,
  integrations: { appPublicUrl: ORIGIN, executiveUserIds: ['m1'] },
  hr: { dataKey: randomBytes(32).toString('base64') }, // a throwaway key: sensitive HR fields work, and vanish with the process
});

// A sample project with stages, tasks, a file and a status update, made through the same API the page uses.
{
  const token = (await issueSession(db, 'm1')).accessToken, call = (method: string, url: string, payload?: unknown) => app.inject({ method: method as any, url, payload: payload as any, headers: { authorization: `Bearer ${token}` } });
  const day = (n: number) => new Date(Date.now() + n * 864e5).toISOString();
  const proj = (await call('POST', '/projects', { name: '示例：黑五促销活动', description: '黑五 + 网络星期一全渠道促销（虚构示例）。', startDate: day(-5).slice(0, 10), endDate: day(25).slice(0, 10), template: 'campaign', members: ['m2', 'm4', 'm5'] })).json();
  const [g1, g2, g3] = proj.groups;
  for (const [title, owner, g, d] of [['确定折扣方案', 'm1', g1, 3], ['落地页改版', 'm5', g2, 8], ['三组广告素材', 'm2', g2, 10], ['邮件与短信排期', 'm4', g3, 15]] as const)
    await call('POST', `/projects/${proj.id}/tasks`, { title, ownerId: owner, groupId: g.id, dueAt: day(d) });
  await call('POST', `/projects/${proj.id}/files`, { name: '活动方案（示例）.pdf', category: 'brief', dataBase64: Buffer.from('%PDF-1.4\n% fictional sample\n').toString('base64') });
  await call('POST', `/projects/${proj.id}/updates`, { health: 'on_track', body: '方案在评审，素材开始制作（示例）。' });
}

// Sample returns, one at each stage: 等待维修, 等待配件, 完成维修, 完成上架, 售出 (fictional, made through the API).
{
  const token = (await issueSession(db, 'm1')).accessToken, call = (method: string, url: string, payload?: unknown) => app.inject({ method: method as any, url, payload: payload as any, headers: { authorization: `Bearer ${token}` } });
  const item = (await db.query("SELECT sku FROM wms_items WHERE org_id=$1 ORDER BY sku LIMIT 1", [ORG])).rows[0];
  if (item) {
    const ago = (n: number) => new Date(Date.now() - n * 864e5).toISOString().slice(0, 10), png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]).toString('base64');
    const make = async (serial: string, days: number, reason: string) => (await call('POST', '/rma', { sku: 'REF-' + item.sku, serial, productClass: 'machine', repairable: 'yes', reason, condition: '外箱有压痕，配件齐全（示例）', receivedAt: ago(days), channel: 'website' })).json().id;
    const repair = async (id: string) => {
      await call('POST', `/rma/${id}/update`, { technicianId: 'm1', diagnosis: '示例诊断：电源板接触不良' });
      await call('POST', `/rma/${id}/photos`, { kind: 'repaired', name: 'after.png', mime: 'image/png', dataBase64: png });
      await call('POST', `/rma/${id}/repaired`, {});
    };
    await make('DEMO-SN-001', 2, '示例：开机不出光；已全额退款');
    const parts = await make('DEMO-SN-002', 6, '示例：雕刻偏移；已部分退款');
    await call('POST', `/rma/${parts}/update`, { technicianId: 'm1', status: 'waiting_parts', waitingFor: '示例同步带 ×1' });
    const fixed = await make('DEMO-SN-003', 9, '示例：风扇异响；已全额退款'); await repair(fixed); await call('POST', `/rma/${fixed}/price`, { discountPct: 20 });
    for (const [serial, listing] of [['DEMO-SN-004', 'listed'], ['DEMO-SN-005', 'sold']] as const) {
      const id = await make(serial, 14, '示例：客户七天无理由退货'); await repair(id);
      await call('POST', `/rma/${id}/close`, { outcome: 'restock', grade: 'A' });
      await call('POST', `/rma/${id}/price`, { discountPct: 10, listing });
    }
  }
}

const TYPES: Record<string, string> = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.otf': 'font/otf', '.woff2': 'font/woff2', '.png': 'image/png', '.json': 'application/json', '.webp': 'image/webp', '.ico': 'image/x-icon' };
createServer(async (req, res) => {
  try {
    const url = new URL(req.url || '/', 'http://preview.local'), method = req.method || 'GET';
    res.setHeader('x-robots-tag', 'noindex, nofollow');
    if (url.pathname === '/healthz') { res.writeHead(200, { 'content-type': 'text/plain' }); return res.end('ok'); }
    if (url.pathname.startsWith('/api/')) {
      const chunks: Buffer[] = []; for await (const c of req) chunks.push(c as Buffer);
      const headers = { ...req.headers }; delete headers['content-length']; delete headers.host;
      const r = await app.inject({ method: method as any, url: url.pathname.slice(4) + url.search, payload: chunks.length ? Buffer.concat(chunks) : undefined, headers: headers as any });
      const out: Record<string, any> = {}; for (const [k, v] of Object.entries(r.headers)) if (k !== 'content-length' && k !== 'transfer-encoding' && v !== undefined) out[k] = v;
      res.writeHead(r.statusCode, out); return res.end(r.rawPayload);
    }
    if (url.pathname === '/runtime-config.js') { res.writeHead(200, { 'content-type': 'text/javascript', 'cache-control': 'no-store' }); return res.end("'use strict';window.WORKOS_CONFIG=Object.freeze({mode:'live',apiBase:'/api'});"); }
    if (url.pathname === '/build-info.json') { res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' }); return res.end(JSON.stringify({ frontendCommit: FRONTEND_COMMIT, preview: true })); }
    let file = normalize(join(DIST, decodeURIComponent(url.pathname)));
    if (!file.startsWith(DIST)) { res.writeHead(403); return res.end(); }
    if ((await stat(file).catch(() => null))?.isDirectory()) file = join(file, 'index.html');
    let body = await readFile(file).catch(() => null);
    if (!body) { res.writeHead(404); return res.end('Not found'); }
    if (file.endsWith('index.html')) body = Buffer.from(body.toString('utf8').replace('</body>', BANNER + '</body>'));
    res.writeHead(200, { 'content-type': TYPES[extname(file)] || 'application/octet-stream', 'cache-control': 'no-store' }); res.end(body);
  } catch (error) { console.error(error); res.writeHead(500); res.end('Preview server error'); }
}).listen(PORT, HOST, () => {
  console.log(`WorkOS preview (fictional test data, resets on every start): ${ORIGIN}/`);
  console.log(`Frontend from ${DIST}`);
  console.log(`Sign in: owner@workos.test · hr@workos.test · staff@workos.test — password ${process.env.PREVIEW_PASSWORD ? '(PREVIEW_PASSWORD)' : PASSWORD}`);
});
