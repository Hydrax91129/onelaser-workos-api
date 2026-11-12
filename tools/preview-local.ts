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
import { randomBytes, randomUUID } from 'node:crypto';
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
// Only in the product library (as after a bulk import): Inventory lists it at zero and can receive it.
await db.query("INSERT INTO product_catalog(org_id,sku,name_zh,name_en,type,status,msrp) VALUES($1,'DEMO-H7-PRO','示例 H7 Pro 主机','Demo H7 Pro','主机','live',11999) ON CONFLICT DO NOTHING", [ORG]);

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
  integrations: { appPublicUrl: ORIGIN, executiveUserIds: ['m1'], mcpUserIds: ['m1'] }, // the owner may try the WorkOS MCP server here
  hr: { dataKey: randomBytes(32).toString('base64') }, // a throwaway key: sensitive HR fields work, and vanish with the process
});

// A sample project with stages, tasks, a file and a status update, made through the same API the page uses.
{
  const token = (await issueSession(db, 'm1')).accessToken, call = (method: string, url: string, payload?: unknown) => app.inject({ method: method as any, url, payload: payload as any, headers: { authorization: `Bearer ${token}` } });
  const day = (n: number) => new Date(Date.now() + n * 864e5).toISOString();
  const proj = (await call('POST', '/projects', { name: '示例：黑五促销活动', description: '黑五 + 网络星期一全渠道促销（虚构示例）。', startDate: day(-5).slice(0, 10), endDate: day(25).slice(0, 10), template: 'campaign', members: ['m2', 'm4', 'm5'] })).json();
  const [g1, g2, g3] = proj.groups;
  const made: any[] = [];
  for (const [title, owner, g, d] of [['确定折扣方案', 'm1', g1, 3], ['落地页改版', 'm5', g2, 8], ['三组广告素材', 'm2', g2, 10], ['邮件与短信排期', 'm4', g3, 15]] as const)
    made.push((await call('POST', `/projects/${proj.id}/tasks`, { title, ownerId: owner, groupId: g.id, dueAt: day(d) })).json());
  // Sample attachments on the first task, to try the preview window (PDF, text, image).
  const first = made[0]?.id || made[0]?.task?.id;
  if (first) for (const f of [
    { name: '折扣方案（示例）.pdf', mime: 'application/pdf', dataBase64: Buffer.from('%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj 2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj 3 0 obj<</Type/Page/MediaBox[0 0 300 200]/Parent 2 0 R>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF\n').toString('base64') },
    { name: '会议纪要（示例）.txt', mime: 'text/plain', dataBase64: Buffer.from('示例会议纪要（虚构）\n1. 折扣力度待定\n2. 下周一前给出方案\n').toString('base64') },
    { name: '素材草图（示例）.png', mime: 'image/png', dataBase64: 'iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAAFklEQVR42mP8z8DwnwEJMDEgAUYGBgAU2gH/0ZcVlQAAAABJRU5ErkJggg==' },
  ]) await call('POST', `/tasks/${first}/attachments`, f);
  await call('POST', `/projects/${proj.id}/files`, { name: '活动方案（示例）.pdf', category: 'brief', dataBase64: Buffer.from('%PDF-1.4\n% fictional sample\n').toString('base64') });
  await call('POST', `/projects/${proj.id}/updates`, { health: 'on_track', body: '方案在评审，素材开始制作（示例）。' });
  // Inbox samples for the main admin: one result to review and one new task (need you), progress updates (for information).
  const as = async (who: string) => { const t = (await issueSession(db, who)).accessToken; return (method: string, url: string, payload?: unknown) => app.inject({ method: method as any, url, payload: payload as any, headers: { authorization: `Bearer ${t}` } }); };
  const m2 = await as('m2'), m4 = await as('m4');
  const t1 = (await call('POST', '/tasks', { title: '整理示例经销商价目表', description: '虚构示例任务，用来演示通知。', ownerId: 'm2', criteria: ['提交价目表文件'], dueAt: day(4) })).json();
  await m2('POST', `/tasks/${t1.id}/updates`, { requestId: randomUUID(), body: '价目表初稿已完成，正在核对（示例）。' });
  const v1 = (await m2('GET', `/tasks/${t1.id}`)).json().version;
  await m2('POST', `/tasks/${t1.id}/submissions`, { expectedVersion: v1, description: '价目表已上传，请验收（示例）。' });
  await m4('POST', '/tasks/assign', { assigneeId: 'm1', title: '确认示例新员工入职资料', description: '虚构示例任务，用来演示“去领取”。', criteria: ['资料确认完毕'], dueAt: day(6) });
}

// Sample returns, one at each stage: 等待维修, 等待配件, 完成维修, 完成上架, 售出 (fictional, made through the API).
{
  const token = (await issueSession(db, 'm1')).accessToken, call = (method: string, url: string, payload?: unknown) => app.inject({ method: method as any, url, payload: payload as any, headers: { authorization: `Bearer ${token}` } });
  const item = (await db.query("SELECT sku FROM wms_items WHERE org_id=$1 ORDER BY sku LIMIT 1", [ORG])).rows[0];
  if (item) {
    const ago = (n: number) => new Date(Date.now() - n * 864e5).toISOString().slice(0, 10), png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]).toString('base64');
    const make = async (serial: string, days: number, reason: string) => (await call('POST', '/rma', { sku: 'REF-' + item.sku, serial, productClass: 'machine', reason, condition: '外箱有压痕，配件齐全（示例）', receivedAt: ago(days), channel: 'website' })).json().id;
    const repair = async (id: string) => {
      await call('POST', `/rma/${id}/update`, { technicianId: 'm1', repairable: 'yes', diagnosis: '示例诊断：电源板接触不良' });
      await call('POST', `/rma/${id}/photos`, { kind: 'diagnosis', name: 'diagnosis.png', mime: 'image/png', dataBase64: png });
      await call('POST', `/rma/${id}/repaired`, {});
    };
    await make('DEMO-SN-001', 2, '示例：开机不出光；已全额退款');
    const parts = await make('DEMO-SN-002', 6, '示例：雕刻偏移；已部分退款');
    await call('POST', `/rma/${parts}/update`, { technicianId: 'm1', status: 'waiting_parts', waitingFor: '示例同步带 ×1' });
    const fixed = await make('DEMO-SN-003', 9, '示例：风扇异响；已全额退款'); await repair(fixed);
    for (const [serial, listing, grade] of [['DEMO-SN-004', 'listed', 'B'], ['DEMO-SN-005', 'sold', 'D']] as const) {
      const id = await make(serial, 14, '示例：客户七天无理由退货'); await repair(id);
      await call('POST', `/rma/${id}/close`, { outcome: 'restock', grade });
      await call('POST', `/rma/${id}/price`, { listing });
    }
  }
}

// Sample accounts receivable (fictional customers and amounts): paid, partly paid, a deposited check, shipped but unpaid and overdue.
{
  const token = (await issueSession(db, 'm1')).accessToken, call = (method: string, url: string, payload?: unknown) => app.inject({ method: method as any, url, payload: payload as any, headers: { authorization: `Bearer ${token}` } });
  const ago = (n: number) => new Date(Date.now() - n * 864e5).toISOString().slice(0, 10);
  const rows: [string, string, number, string, string, number, boolean, string, [number, string, number][]][] = [
    ['m2', '示例激光工作室', 120, 'PO', '2901', 5014.45, true, 'check', [[100, 'cleared', 5014.45]]],
    ['m2', 'Demo Sign Co.', 75, 'PO', '2955', 9077.02, true, 'check', [[40, 'cleared', 4000]]],
    ['m4', '示例 KOL 合作', 45, 'KOL', '2977', 3685.5, true, 'quickbooks', []],
    ['m5', 'Demo Makerspace', 20, 'PO', '3010', 13219.26, true, 'check', [[3, 'deposited', 13219.26]]],
    ['m4', '示例镜片供应', 10, 'Lens', 'LD#34', 397.85, false, 'ach', []],
    ['m2', 'Demo Woodshop', 2, 'PO', '3115', 4577.49, false, 'check', []],
  ];
  for (const [owner, customer, days, kind, order, amount, shipped, method, pays] of rows) {
    const r = (await call('POST', '/finance/receivables', { responsibleId: owner, invoiceDate: ago(days), paymentTerm: 'net30', termDays: 30, customer, contact: '示例联系人', contactEmail: 'ap@example.com', contactPhone: '(626) 555-0' + String(100 + rows.findIndex(x => x[1] === customer)),
      shipStreet: '100 Example Ave', shipCity: 'Pasadena', shipState: 'CA', shipZip: '91101', kind, orderRef: order, amount, dispatched: shipped, dispatchedOn: shipped ? ago(days - 1) : null, payMethod: method })).json();
    for (const [d, state, amt] of pays) await call('POST', `/finance/receivables/${r.id}/payments`, { receivedOn: ago(d), amount: amt, method, state });
  }
}

// Example shelf bins in the US LA warehouse (fictional).
{
  const token = (await issueSession(db, 'm1')).accessToken;
  for (const [sku, bins] of [['DEMO-F2-60W', ['A-01-01', 'A-01-02', '']], ['DEMO-F2-100W', ['A-02-01', '', '']], ['DEMO-LENS-2', ['C-10-03', 'C-10-04', 'D-01-01']]] as const)
    await app.inject({ method: 'POST', url: '/wms/bins', payload: { sku, location: 'us', bins: [...bins] }, headers: { authorization: `Bearer ${token}` } });
  // Put most of the US stock away: the first bin gets all but 3, the second bin the rest (fictional).
  const items = (await app.inject({ method: 'GET', url: '/wms/summary', headers: { authorization: `Bearer ${token}` } })).json().items;
  for (const it of items.filter((x: any) => x.bins?.us?.[0] && Number(x.qty?.us || 0) > 0)) {
    const total = Number(it.qty.us), second = it.bins.us[1] ? Math.min(3, total) : 0;
    if (total - second > 0) await app.inject({ method: 'POST', url: '/wms/bins/move', payload: { sku: it.sku, location: 'us', from: 0, to: 1, qty: total - second }, headers: { authorization: `Bearer ${token}` } });
    if (second) await app.inject({ method: 'POST', url: '/wms/bins/move', payload: { sku: it.sku, location: 'us', from: 0, to: 2, qty: second }, headers: { authorization: `Bearer ${token}` } });
  }
}

// Product facts the supply chain needs (fictional): family, production lead time, first leg and MOQ.
{
  const org = (await db.query("SELECT org_id FROM users WHERE id='m1'")).rows[0].org_id;
  for (const [sku, family, lead, firstLeg, moq] of [['DEMO-H7-PRO', 'main', '25 天', '海运 35 天', '5 台'], ['DEMO-F2-100W', 'main', '20 天', '海运 35 天', '10 台'], ['DEMO-F2-60W', 'main', '20 天', '海运 35 天', '10 台'],
    ['DEMO-AF-200', 'acc', '15 天', '海运 30 天', '20 件'], ['DEMO-RA-1', 'acc', '15 天', '', '20 件'], ['DEMO-LENS-2', 'cons', '', '空运 7 天', '50 片']] as const)
    await db.query(`UPDATE product_catalog SET family=$3, lead=$4::text, attrs=COALESCE(attrs,'{}'::jsonb) || jsonb_strip_nulls(jsonb_build_object('firstLeg', NULLIF($5::text,''), 'moqUnit', $6::text)) WHERE org_id=$1 AND sku=$2`, [org, sku, family, lead, firstLeg, moq]);
}

// SCM: a year of fictional daily sales per SKU (as if synced from Shopify) and two shipments on the water.
{
  const token = (await issueSession(db, 'm1')).accessToken, call = (method: string, url: string, payload?: unknown) => app.inject({ method: method as any, url, payload: payload as any, headers: { authorization: `Bearer ${token}` } });
  const org = (await db.query("SELECT org_id FROM users WHERE id='m1'")).rows[0].org_id;
  const skus = (await db.query("SELECT sku FROM product_catalog WHERE org_id=$1 AND sku NOT LIKE 'REF-%' ORDER BY sku", [org])).rows.map((r: any) => r.sku);
  // Each SKU gets its own fictional base rate and a gentle seasonal wave; the most recent month runs a little hotter for some.
  for (const [i, sku] of skus.entries()) {
    const base = [3.2, 1.4, 0.6, 5.5, 0.25, 2.1, 0.9][i % 7], hot = i % 3 === 0 ? 1.35 : i % 3 === 1 ? 0.8 : 1;
    await db.query(`INSERT INTO scm_sales_daily(org_id,sku,day,qty)
      SELECT $1,$2,d::date, GREATEST(0, round($3::float8 * (1 + 0.35*sin(n/29.0 + $5::int)) * (CASE WHEN n < 30 THEN $4::float8 ELSE 1 END) + (((n*7919 + $5::int*104729) % 5) - 2) * 0.3))::int
      FROM generate_series(0,364) AS n, LATERAL (SELECT current_date - n AS d) x ON CONFLICT DO NOTHING`, [org, sku, base, hot, i]);
  }
  const units = Number((await db.query('SELECT coalesce(sum(qty),0) AS u FROM scm_sales_daily WHERE org_id=$1', [org])).rows[0].u);
  await db.query(`INSERT INTO scm_sync(org_id,last_at,status,orders,units,since,note) VALUES($1,now(),'ok',$2,$3,current_date-364,'示例数据，测试站不连 Shopify') ON CONFLICT(org_id) DO NOTHING`, [org, Math.round(units * 0.8), units]);
  const ago = (n: number) => new Date(Date.now() - n * 864e5).toISOString().slice(0, 10);
  // Some finished goods waiting at the Dongguan factory (fictional), so the board can suggest shipping them first.
  const atFactory = skus.slice(0, 4).map((sku: string, i: number) => ({ sku, qty: [80, 30, 45, 20][i] }));
  if (atFactory.length) await call('POST', '/wms/movements/batch', { type: 'in', location: 'dg', opDate: ago(5), reason: '示例：工厂成品入库', lines: atFactory });
  if (skus[0]) await call('POST', '/scm/shipments', { number: 'DEMO-MSKU-0001', mode: 'sea', firstLeg: 'oa', lastLeg: 'port', carrier: '示例船公司', tracking: 'https://track.example.com/DEMO-MSKU-0001', source: 'new', shippedOn: ago(18), etaDays: 35, lines: skus.slice(0, 3).map((sku: string, i: number) => ({ sku, qty: [40, 25, 60][i] })) });
  if (skus[1]) await call('POST', '/scm/shipments', { number: 'DEMO-AIR-0002', mode: 'air', firstLeg: 'air', lastLeg: 'express', carrier: '示例快递', tracking: 'DEMO1234567890', source: 'new', shippedOn: ago(2), etaDays: 7, lines: [{ sku: skus[skus.length - 1], qty: 12 }] });
  // Ship position, an arrival notice waiting for the warehouse, shelf bins and a purchase order partly finished (all fictional).
  const board = (await call('GET', '/scm/board')).json();
  const sea = board.shipments?.find((x: any) => x.number === 'DEMO-MSKU-0001'), air = board.shipments?.find((x: any) => x.number === 'DEMO-AIR-0002');
  if (sea) await call('POST', `/scm/shipments/${sea.id}/position`, { position: '示例：已过夏威夷，按计划航行' });
  if (air) await call('POST', `/scm/shipments/${air.id}/notify`, {});
  await call('POST', '/wms/bin-codes', { location: 'us', codes: ['A-01-01', 'A-01-02', 'A-01-03', 'A-02-01', 'A-02-02', 'C-10-03', 'C-10-04', 'D-01-01', 'D-01-02'], note: '示例货架' });
  // Fictional suppliers in the product library, then a purchase order in production (partly finished) and a draft.
  const orgId = (await db.query("SELECT org_id FROM users WHERE id='m1'")).rows[0].org_id;
  for (const [i, sku] of skus.entries())
    await db.query(`INSERT INTO product_pricing(org_id,sku,attrs) VALUES($1,$2,$3::jsonb) ON CONFLICT(org_id,sku) DO UPDATE SET attrs=COALESCE(product_pricing.attrs,'{}'::jsonb) || $3::jsonb`,
      [orgId, sku, JSON.stringify(i % 2 ? { supplier: '示例济南工厂', supplierAlt1: '示例东莞工厂' } : { supplier: '示例东莞工厂', supplierAlt1: '示例济南工厂' })]);
  const ahead = (n: number) => new Date(Date.now() + n * 864e5).toISOString().slice(0, 10);
  const po = (await call('POST', '/scm/orders', { supplier: '示例东莞工厂', orderedOn: ago(10), readyOn: ahead(15), note: '示例采购单', lines: skus.slice(0, 2).map((sku: string, i: number) => ({ sku, qty: [120, 60][i] })) })).json();
  if (po?.id && skus[0]) { await call('POST', `/scm/orders/${po.id}/issue`, {}); await call('POST', `/scm/orders/${po.id}/finish`, { opDate: ago(1), location: 'dg', lines: [{ sku: skus[0], qty: 40 }] }); }
  if (skus[2]) await call('POST', '/scm/orders', { supplier: '示例东莞工厂', orderedOn: ago(0), readyOn: ahead(25), note: '示例草稿：等工厂确认', lines: [{ sku: skus[2], qty: 50 }] });
}

// Example pricing parameters (fictional rates, tiers and NPCR steps) and landed / last-mile costs, so 定价 shows the NPCR calculation.
{
  const token = (await issueSession(db, 'm1')).accessToken, call = (method: string, url: string, payload?: unknown) => app.inject({ method: method as any, url, payload: payload as any, headers: { authorization: `Bearer ${token}` } });
  await call('PUT', '/products/worksheet-settings', { dtcItems: [{ name: '示例 · 广告', pct: 8 }, { name: '示例 · 平台与支付', pct: 5 }], whItems: [{ name: '示例 · 销售支持', pct: 4 }], mktExtra: 10,
    retailTiers: [{ name: 'MSRP', cm: 40, use: '标价' }, { name: '日常', cm: 30, use: '日常调整' }, { name: '小促', cm: 22, use: '常规活动' }, { name: '大促', cm: 15, use: '每年最多 2 次' }],
    whTiers: [{ name: '普通经销商', discount: 25, floor: false }, { name: '大经销商', discount: 30, floor: false }, { name: '底线档', discount: 35, floor: true }],
    npcr: [10, 15, 20, 25, 30, 35, 40], dtcTarget: '30', dtcFloor: 12, whTarget: '15', whFloor: 8, dtcRateOverride: null, whRateOverride: null });
  for (const [sku, landed, lastMile] of [['DEMO-AF-200', 210, 25], ['DEMO-F2-100W', 2400, 180], ['DEMO-F2-60W', 1650, 160], ['DEMO-H7-PRO', 4200, 260], ['DEMO-LENS-2', 9, 6], ['DEMO-RA-1', 120, 18]] as const)
    await call('PATCH', `/products/library/${sku}`, { values: { landed, lastMile } });
}

const TYPES: Record<string, string> = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.otf': 'font/otf', '.woff2': 'font/woff2', '.png': 'image/png', '.json': 'application/json', '.webp': 'image/webp', '.ico': 'image/x-icon' };
createServer(async (req, res) => {
  try {
    const url = new URL(req.url || '/', 'http://preview.local'), method = req.method || 'GET';
    res.setHeader('x-robots-tag', 'noindex, nofollow');
    if (url.pathname === '/healthz') { res.writeHead(200, { 'content-type': 'text/plain' }); return res.end('ok'); }
    if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/.well-known/')) {
      const chunks: Buffer[] = []; for await (const c of req) chunks.push(c as Buffer);
      const headers = { ...req.headers }; delete headers['content-length']; delete headers.host;
      const r = await app.inject({ method: method as any, url: (url.pathname.startsWith('/api/') ? url.pathname.slice(4) : url.pathname) + url.search, payload: chunks.length ? Buffer.concat(chunks) : undefined, headers: headers as any });
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
