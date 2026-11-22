/* Preview WorkOS with fictional test data before a release: npm run preview
 *
 * One process on http://localhost:4174 serves the WorkOS frontend (../onelaser-workos/dist, or FRONTEND_DIST) and the
 * API under /api, on an in-memory database that starts fresh every run. Every name, number and record below is made up;
 * nothing here touches the live database, DingTalk, e-mail or any external service.
 *
 * No sign-in needed: opening the site signs you in as the owner; /as/owner, /as/hr, /as/staff (links in the bottom strip)
 * switch accounts. Password sign-in still works:
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
import { cookie, issueSession, readCookie, resolveSession, sessionCookieName } from '../src/auth.js';
import { hashPassword } from '../src/members.js';

const PORT = Number(process.env.PORT || 4174), HOST = process.env.HOST || '127.0.0.1';
const ORIGIN = (process.env.RENDER_EXTERNAL_URL || process.env.PREVIEW_PUBLIC_URL || `http://localhost:${PORT}`).replace(/\/$/, '');
const DIST = resolve(process.env.FRONTEND_DIST || resolve(import.meta.dirname, '..', '..', 'onelaser-workos', 'dist'));
const FRONTEND_COMMIT = (await readFile(process.env.PREVIEW_FRONTEND_COMMIT_FILE || '/nonexistent', 'utf8').catch(() => 'local')).trim();
// A strip on every page so nobody mistakes the test site for craftos.app.
const BANNER = `<div style="position:fixed;left:50%;bottom:10px;transform:translateX(-50%);z-index:9999;background:#a15c00;color:#fff;font:600 12px system-ui;padding:5px 12px;border-radius:999px;box-shadow:0 4px 14px #0003;">测试站 · 虚构数据，每次部署都会重置 · Test site, fictional data · ${FRONTEND_COMMIT.slice(0, 7)} · 切换身份 Switch: <a href="/as/owner" style="color:#fff">老板 Owner</a> · <a href="/as/hr" style="color:#fff">HR</a> · <a href="/as/staff" style="color:#fff">员工 Staff</a></div>`;
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

// AI超算 on the test site: no AI key here, so a canned sample answer streams in, with a drawing and a 3D model / web page to preview.
const AI_LAB_DEMO: Record<string, string> = {
  mech: '## 方案概述（测试站示例回答）\n\n这是测试站的固定示例，正式站会按你的需求实时计算。\n\n| 项目 | 参数 |\n| --- | --- |\n| 工作幅面 | 1300 × 900 mm |\n| 导轨 | HGR20 直线导轨 ×4 |\n| 传动 | 同步带 HTD-3M，宽 15 mm |\n\n```svg\n<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 420 240"><rect width="420" height="240" fill="#fff"/><rect x="40" y="60" width="300" height="120" fill="none" stroke="#1f2433" stroke-width="2"/><rect x="170" y="40" width="40" height="160" fill="#dfe6ff" stroke="#3c64f4" stroke-width="2"/><line x1="40" y1="210" x2="340" y2="210" stroke="#d92d20"/><text x="160" y="228" font-size="12" fill="#d92d20">1300 mm</text><text x="40" y="30" font-size="13" fill="#1f2433">龙门结构示意（俯视）</text></svg>\n```\n\n```html\n<!doctype html><html><body style="margin:0;background:#f6f7fb"><script src="https://cdnjs.cloudflare.com/ajax/libs/three.js/r128/three.min.js"></script><script>const s=new THREE.Scene(),c=new THREE.PerspectiveCamera(50,innerWidth/innerHeight,.1,100),r=new THREE.WebGLRenderer({antialias:true});r.setSize(innerWidth,innerHeight);r.setClearColor(0xf6f7fb);document.body.appendChild(r.domElement);const m=new THREE.Mesh(new THREE.BoxGeometry(3,.3,2),new THREE.MeshStandardMaterial({color:0x3c64f4}));s.add(m,new THREE.AmbientLight(0xffffff,.6));const l=new THREE.DirectionalLight(0xffffff,.8);l.position.set(3,5,4);s.add(l);c.position.set(3,3,4);c.lookAt(0,0,0);(function a(){m.rotation.y+=.01;r.render(s,c);requestAnimationFrame(a)})();</script></body></html>\n```\n',
  elec: '## 电气架构（测试站示例回答）\n\n1. 220V AC 进线 → 断路器 16A → 漏电保护 30mA\n2. 24V 开关电源 350W 供步进驱动和控制板\n3. 门盖、急停、水流开关串联进激光使能\n\n```svg\n<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 420 160"><rect width="420" height="160" fill="#fff"/><rect x="20" y="60" width="80" height="40" fill="#fff4e0" stroke="#9a5b00"/><text x="32" y="85" font-size="12">220V 进线</text><line x1="100" y1="80" x2="160" y2="80" stroke="#1f2433" stroke-width="2"/><rect x="160" y="60" width="90" height="40" fill="#eef3ff" stroke="#245bdb"/><text x="170" y="85" font-size="12">24V 电源</text><line x1="250" y1="80" x2="310" y2="80" stroke="#1f2433" stroke-width="2"/><rect x="310" y="60" width="90" height="40" fill="#e8f6ee" stroke="#17803d"/><text x="322" y="85" font-size="12">步进驱动</text></svg>\n```\n',
  soft: '## 落地页（测试站示例回答）\n\n下面是一个可以直接预览的示例页面。\n\n```html\n<!doctype html><html lang="zh"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>body{margin:0;font-family:system-ui;background:#0b0d17;color:#fff}.hero{padding:80px 24px;text-align:center;background:radial-gradient(circle at top,#3c64f4,#0b0d17 70%)}h1{font-size:44px;margin:0 0 12px}p{color:#c9ccd6}.btn{display:inline-block;margin-top:20px;padding:12px 28px;border-radius:999px;background:#fff;color:#0b0d17;font-weight:700}</style></head><body><section class="hero"><h1>Demo Laser X1</h1><p>示例产品落地页（测试站）</p><span class="btn">立即购买</span></section></body></html>\n```\n',
};
const previewLabClient = { messages: { stream(body: any, opts: any) {
  const text = body.system.includes('“机械 / 工业设计”工位') ? AI_LAB_DEMO.mech : body.system.includes('“电气设计”工位') ? AI_LAB_DEMO.elec : AI_LAB_DEMO.soft;
  return (async function* () { for (let i = 0; i < text.length; i += 40) { if (opts?.signal?.aborted) throw new Error('aborted'); await new Promise(r => setTimeout(r, 40)); yield { type: 'content_block_delta', delta: { type: 'text_delta', text: text.slice(i, i + 40) } }; } })();
} } };

const app = await buildApp({
  db, environment: 'development', mailer: null, completionModel: null, translationModel: null, okrDraftModel: previewAi, nudgeIntervalMs: 0,
  integrations: { appPublicUrl: ORIGIN, executiveUserIds: ['m1'], mcpUserIds: ['m1'] }, // the owner may try the WorkOS MCP server here
  hr: { dataKey: randomBytes(32).toString('base64') }, // a throwaway key: sensitive HR fields work, and vanish with the process
  aiLab: { userIds: ['m1'], client: previewLabClient },
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
  // A task given to m2 and completed with "完成": the owner opens it from the task list and sees the result and can score it.
  const t2 = (await call('POST', '/tasks', { title: '示例：运往英国的运费报价', description: '虚构示例任务：把运费报价发给我。', ownerId: 'm2', criteria: ['报价已发出'], dueAt: day(2) })).json();
  const v2 = (await m2('GET', `/tasks/${t2.id}`)).json().version;
  await m2('POST', `/tasks/${t2.id}/complete`, { expectedVersion: v2, result: '400 USD，50–60 天（示例）', attachmentIds: [] });
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

// Sample orders for 订单履约 (fictional customers, addresses and tracking numbers), one or more in every stage.
{
  await db.query(`UPDATE users SET grants=grants || '["orders","orders_manage"]'::jsonb WHERE id IN ('m4','m6')`);
  await db.query(`UPDATE users SET grants=grants || '["orders"]'::jsonb WHERE id IN ('m5')`);
  await db.query(`INSERT INTO ful_settings(org_id,pay_owner,ship_owner,call_owner,train_owner) VALUES($1,'m4','m6','m4','m5') ON CONFLICT DO NOTHING`, [ORG]);
  const t = (h: number) => h == null ? null : new Date(Date.now() - h * 3600_000).toISOString(), d = (days: number) => new Date(Date.now() + days * 864e5).toISOString().slice(0, 10);
  type Row = { n: string; kind?: string; ch?: string; who: string; city: string; st: string; sku: string; name: string; qty?: number; total: number; paid?: number; ship?: string;
    placed: number; paidAt?: number | null; shipped?: number; carrier?: string; pro?: string; eta?: string; terminal?: number; appt?: string; delivered?: number; damage?: string;
    first?: number; invited?: number; platform?: string; reviewed?: number; rating?: number; note?: string; release?: string; content?: string; tags?: string[] };
  const H9 = ['DEMO-H7-PRO', 'Demo H7 Pro'], F2 = ['DEMO-F2-100W', 'Demo F2 100W CO2 Laser'], F60 = ['DEMO-F2-60W', 'Demo F2 60W CO2 Laser'], LENS = ['DEMO-LENS-2', 'Demo Focus Lens 2"'];
  const rows: Row[] = [
    { n: '#5101', who: 'Sample Buyer A', city: 'Austin', st: 'TX', sku: H9[0], name: H9[1], total: 11999, paid: 4000, placed: 30 },
    { n: '#5102', ch: 'offline', who: 'Demo Sign Shop', city: 'Reno', st: 'NV', sku: F2[0], name: F2[1], total: 6999, paid: 0, placed: 100 },
    { n: '#5103', who: 'Sample Buyer B', city: 'Denver', st: 'CO', sku: F60[0], name: F60[1], total: 4999, placed: 70, paidAt: 66 },
    { n: '#5104', who: 'Sample Buyer C', city: 'Tampa', st: 'FL', sku: F2[0], name: F2[1], total: 6999, placed: 30, paidAt: 20 },
    { n: '#5105', who: 'Sample Buyer D', city: 'Portland', st: 'OR', sku: LENS[0], name: LENS[1], qty: 2, total: 98, ship: 'parcel', placed: 30, paidAt: 29 },
    { n: '#5106', who: 'Sample Buyer E', city: 'Columbus', st: 'OH', sku: H9[0], name: H9[1], total: 11999, placed: 150, paidAt: 148, shipped: 120, carrier: 'Demo Freight', pro: 'PRO-DEMO-1106', eta: d(3) },
    { n: '#5107', who: 'Sample Buyer F', city: 'Raleigh', st: 'NC', sku: F2[0], name: F2[1], total: 6999, placed: 300, paidAt: 298, shipped: 260, carrier: 'Demo LTL Lines', pro: 'PRO-DEMO-1107', eta: d(-3) },
    { n: '#5108', who: 'Sample Buyer G', city: 'Phoenix', st: 'AZ', sku: F60[0], name: F60[1], total: 4999, placed: 280, paidAt: 278, shipped: 240, carrier: 'Demo Freight', pro: 'PRO-DEMO-1108', terminal: 100 },
    { n: '#5109', who: 'Sample Buyer H', city: 'Boise', st: 'ID', sku: F2[0], name: F2[1], total: 6999, placed: 320, paidAt: 318, shipped: 280, carrier: 'Demo Freight', pro: 'PRO-DEMO-1109', terminal: 30, appt: d(1) },
    { n: '#5110', who: 'Sample Buyer I', city: 'Omaha', st: 'NE', sku: H9[0], name: H9[1], total: 11999, placed: 500, paidAt: 498, shipped: 450, carrier: 'Demo LTL Lines', pro: 'PRO-DEMO-1110', terminal: 220, appt: d(-6), delivered: 170 },
    { n: '#5111', who: 'Sample Buyer J', city: 'Fresno', st: 'CA', sku: F60[0], name: F60[1], total: 4999, placed: 400, paidAt: 398, shipped: 350, carrier: 'Demo Freight', pro: 'PRO-DEMO-1111', terminal: 150, appt: d(-4), delivered: 80, damage: 'damaged' },
    { n: '#5112', who: 'Sample Buyer K', city: 'Madison', st: 'WI', sku: F2[0], name: F2[1], total: 6999, placed: 420, paidAt: 418, shipped: 380, carrier: 'Demo Freight', pro: 'PRO-DEMO-1112', terminal: 200, appt: d(-6), delivered: 140, first: 30 },
    { n: '#5113', who: 'Sample Buyer L', city: 'Tulsa', st: 'OK', sku: H9[0], name: H9[1], total: 11999, placed: 900, paidAt: 898, shipped: 850, carrier: 'Demo LTL Lines', pro: 'PRO-DEMO-1113', terminal: 700, appt: d(-27), delivered: 640, first: 500, invited: 470, platform: 'trustpilot', reviewed: 440, rating: 5 },
    { n: '#D-2201', kind: 'dealer', ch: 'offline', who: 'Demo Laser Supply LLC', city: 'Dallas', st: 'TX', sku: F2[0], name: F2[1], qty: 4, total: 23996, paid: 12000, placed: 50, tags: ['dealer'] },
    { n: '#D-2202', kind: 'dealer', ch: 'offline', who: 'Example Engraving Distributors', city: 'Atlanta', st: 'GA', sku: F60[0], name: F60[1], qty: 3, total: 13497, placed: 200, paidAt: 190, shipped: 150, carrier: 'Demo Freight', pro: 'PRO-DEMO-2202', eta: d(2), tags: ['dealer'] },
    { n: '#K-301', kind: 'kol', ch: 'offline', who: 'Demo Maker Channel', city: 'Nashville', st: 'TN', sku: H9[0], name: H9[1], total: 0, placed: 20, tags: ['kol'] },
    { n: '#K-302', kind: 'kol', ch: 'offline', who: 'Sample Woodcraft Creator', city: 'Seattle', st: 'WA', sku: F2[0], name: F2[1], total: 0, placed: 400, release: 'KOL agreement signed (sample)', shipped: 350, carrier: 'Demo Freight', pro: 'PRO-DEMO-K302', terminal: 200, appt: d(-6), delivered: 150, first: 60, tags: ['kol'] },
    { n: '#5114', who: 'Sample Buyer M', city: 'Albany', st: 'NY', sku: LENS[0], name: LENS[1], total: 0, ship: 'parcel', placed: 10 },
    { n: '#5115', who: 'Sample Buyer N', city: 'Toronto', st: 'ON', sku: F2[0], name: F2[1], total: 6999, placed: 200, paidAt: 198 },
    { n: '#5116', who: 'Sample Buyer O', city: 'Reno', st: 'NV', sku: F60[0], name: F60[1], total: 4999, placed: 600, paidAt: 598, shipped: 560, carrier: 'Demo Freight', pro: 'PRO-DEMO-1116', terminal: 420, appt: d(-14), delivered: 380, first: 300 },
    { n: '#5117', who: 'Sample Buyer P', city: 'Austin', st: 'TX', sku: LENS[0], name: LENS[1], total: 49, ship: 'parcel', placed: 90, paidAt: 89, tags: ['exchange'] },
  ];
  for (const r of rows) {
    const total = Math.round(r.total * 100), paid = r.paid != null ? Math.round(r.paid * 100) : total, id = randomUUID();
    const note = r.kind ? '' : (total === 0 ? 'zero_untagged' : '');
    await db.query(`INSERT INTO ful_orders(id,org_id,source,shopify_id,number,kind,kind_note,channel,placed_at,customer_name,customer_email,customer_phone,ship_city,ship_state,ship_zip,
      total_cents,paid_cents,lines,tags,shipment,liftgate,residential,paid_at,release,shipped_at,carrier,tracking,eta,track_at,terminal_at,appointment_on,delivered_at,damage,
      first_piece_at,review_invited_at,review_platform,reviewed_at,review_rating,content_url)
      VALUES($1,$2,'shopify',$3,$4,$5,$6,$7,$8,$9,$10,'+1 555 010 0000',$11,$12,'00000',$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$22,$26,$27,$28,$29,$30,$31,$32,$33,$34,'')`,
      [id, ORG, 'gid://demo/Order/' + r.n, r.n, r.kind || (total === 0 ? 'kol' : 'retail'), note, r.ch || 'online', t(r.placed), r.who, 'buyer@example.test', r.city, r.st, total, paid,
        JSON.stringify([{ sku: r.sku, name: r.name, qty: r.qty || 1 }]), JSON.stringify(r.tags || []), r.ship || 'ltl', !r.ship, r.kind !== 'dealer' && !r.ship,
        r.paidAt != null ? t(r.paidAt) : (total > 0 && paid >= total ? t(r.placed) : null), r.release ? JSON.stringify({ by: 'm1', at: t(r.placed - 2), reason: r.release, payBy: null }) : null,
        r.shipped != null ? t(r.shipped) : null, r.carrier || '', r.pro || '', r.eta || null, r.terminal != null ? t(r.terminal) : null, r.appt || null,
        r.delivered != null ? t(r.delivered) : null, r.damage || (r.delivered != null ? 'none' : ''), r.first != null ? t(r.first) : null, r.invited != null ? t(r.invited) : null,
        r.platform || '', r.reviewed != null ? t(r.reviewed) : null, r.rating ?? null]);
    await db.query("INSERT INTO ful_events(id,org_id,order_id,actor_id,kind,details,created_at) VALUES($1,$2,$3,NULL,'imported',$4,$5)", [randomUUID(), ORG, id, JSON.stringify({ number: r.n }), t(r.placed)]);
  }
  // Shipped orders went out of the US LA warehouse; one dealer order straight from the Dongguan factory.
  await db.query("UPDATE ful_orders SET ship_from='us' WHERE org_id=$1 AND shipped_at IS NOT NULL", [ORG]);
  // Shipped sample orders already left WMS stock; the open ones hold stock (on hand vs available).
  await db.query(`UPDATE ful_orders SET wms_out_at=shipped_at, wms_out='{"mode":"before"}'::jsonb WHERE org_id=$1 AND shipped_at IS NOT NULL`, [ORG]);
  await db.query("UPDATE ful_orders SET ship_from='dg' WHERE org_id=$1 AND number='#D-2202'", [ORG]);
  // Cancelled + refunded, partly refunded, an exchange, a Canadian address and a few notes (all fictional).
  await db.query("UPDATE ful_orders SET ship_country='CA' WHERE org_id=$1 AND number='#5115'", [ORG]);
  await db.query("UPDATE ful_orders SET cancelled_at=now()-interval '2 days', cancel_reason='customer', refunded_cents=total_cents, refund_note='Cancelled before shipping (sample)' WHERE org_id=$1 AND number='#5115'", [ORG]);
  await db.query("UPDATE ful_orders SET refunded_cents=30000, refund_note='Partial refund: missing air assist hose (sample)' WHERE org_id=$1 AND number='#5116'", [ORG]);
  await db.query(`UPDATE ful_orders SET exchange=$2::jsonb WHERE org_id=$1 AND number='#5111'`, [ORG, JSON.stringify({ by: 'm6', at: new Date(Date.now() - 20 * 3600_000).toISOString(), reason: 'Damaged on delivery, replacement unit sent (sample)', newOrder: '#5118' })]);
  for (const [n, by, text] of [['#5107', 'm6', 'Carrier says the truck is delayed in Memphis; customer informed (sample)'], ['#5101', 'm4', 'Customer will wire the balance on Friday (sample)'], ['#5108', 'm4', 'Left two voicemails, try again tomorrow morning (sample)']])
    await db.query(`UPDATE ful_orders SET note=$3::jsonb WHERE org_id=$1 AND number=$2`, [ORG, n, JSON.stringify({ text, by, at: new Date(Date.now() - 5 * 3600_000).toISOString() })]);
}

// 公司制度: sample handbook, policies, SOPs and culture (fictional example text, not real company rules).
{
  const tok: Record<string, string> = {};
  const as = async (who: string, method: string, url: string, payload?: unknown) => { tok[who] ??= (await issueSession(db, who)).accessToken;
    const r = await app.inject({ method: method as any, url, payload: payload as any, headers: { authorization: `Bearer ${tok[who]}` } }); return r.json(); };
  await as('m1', 'POST', '/policies-access', { userId: 'm4', level: 'manage' });
  await as('m1', 'POST', '/policies-settings', { open: true }); // the test site shows the employee view too
  const ago = (n: number) => new Date(Date.now() - n * 864e5).toISOString().slice(0, 10);
  const make = async (who: string, doc: any, publish: boolean) => { const d = await as(who, 'POST', '/policies', doc); if (publish) await as('m1', 'POST', `/policies/${d.id}/draft/publish`); return d.id as string; };
  const handbookZh = `> 示例内容，仅用于测试站展示。\n\n## 1. 总则\n本手册适用于公司在中国的全体员工，与劳动合同一起构成双方的权利义务。\n\n## 2. 工作时间与考勤\n- 标准工作时间：周一至周五 9:00–18:00，午休 1 小时。\n- 迟到、早退超过 30 分钟按事假半天处理。\n- 加班需提前在钉钉提交申请，经直属领导批准。\n\n## 3. 休假\n| 假别 | 天数 | 说明 |\n| --- | --- | --- |\n| 年假 | 5–15 天 | 按累计工龄 |\n| 病假 | 按实际 | 需医院证明 |\n| 婚假 | 3 天 | 入职后登记结婚 |\n\n## 4. 行为准则\n1. 诚信：不得收受供应商礼品礼金。\n2. 保密：产品成本、客户资料不得外传。\n3. 安全：进入车间必须佩戴护目镜。\n\n## 5. 离职\n试用期提前 3 天、转正后提前 30 天书面通知。`;
  const handbookEn = handbookZh.replace('> 示例内容，仅用于测试站展示。', '> Sample text for the test site only.').replace(/## 1\. 总则[\s\S]*/, '## 1. General\nThis handbook applies to all employees in China and, with the employment contract, sets out the rights and duties of both sides.\n\n## 2. Working hours\n- Monday to Friday 9:00–18:00 with a one-hour lunch break.\n- Overtime is requested in DingTalk in advance and approved by your manager.\n\n## 3. Leave\nAnnual leave 5–15 days by years of service; sick leave with a doctor\'s note; marriage leave 3 days.\n\n## 4. Conduct\n1. Integrity: no gifts or cash from suppliers.\n2. Confidentiality: product costs and customer data stay inside.\n3. Safety: wear eye protection in the workshop.\n\n## 5. Leaving\n3 days\' written notice during probation, 30 days after.');
  const cn = await make('m4', { category: 'handbook', titleZh: '员工手册（中国）', titleEn: 'Employee handbook (China)', region: 'cn', requiresAck: true, reviewMonths: 12,
    bodyZh: handbookZh.replace('9:00–18:00', '8:30–17:30'), bodyEn: handbookEn, officialLang: 'zh', changeNote: '首次发布', effectiveDate: ago(200) }, true);
  await as('m4', 'POST', `/policies/${cn}/draft`, { bodyZh: handbookZh, bodyEn: handbookEn, changeNote: '上班时间调整为 9:00–18:00', reack: true, effectiveDate: ago(20) });
  await as('m1', 'POST', `/policies/${cn}/draft/publish`);
  const usBody = `> Sample text for the test site only.\n\n## Welcome\nThis handbook describes how we work in the United States. It is not a contract of employment; employment is at will.\n\n## Work hours and pay\n- Regular hours are 8:00 am–5:00 pm, Monday to Friday.\n- Non-exempt employees record all time worked and are paid overtime as required by law.\n\n## Time off\n| Type | Days |\n| --- | --- |\n| Paid time off | 10 a year |\n| Sick leave | As required by state law |\n| Holidays | 9 a year |\n\n## Safety\nReport any injury to your manager the same day.\n\n## Acknowledgement\nBy signing, you confirm you received and read this handbook.`;
  const us = await make('m1', { category: 'handbook', titleZh: '员工手册（美国）', titleEn: 'Employee handbook (US)', region: 'us', requiresAck: true, bodyEn: usBody, bodyZh: '> 示例内容。\n\n美国员工手册以英文版为准。中文仅供参考：说明在美国的工作时间、薪酬、休假和安全规定；手册不构成劳动合同，雇佣关系为 at-will。', officialLang: 'en', changeNote: 'First version', effectiveDate: ago(90) }, true);
  void us;
  await make('m4', { category: 'policy', titleZh: '退货与退款政策', titleEn: 'Return & refund policy', public: true, reviewMonths: 6, bodyZh: '> 示例内容。\n\n## 退货期限\n收货后 30 天内可申请退货，机器需保留原包装。\n\n## 退款\n- 收到退货并检验后 5 个工作日内退款。\n- 定制产品、已使用的耗材不退。\n\n## 运费\n质量问题由我们承担运费；非质量问题由客户承担。', bodyEn: '> Sample text.\n\n## Return window\nReturns are accepted within 30 days of delivery; machines must be in the original packaging.\n\n## Refunds\n- Refunded within 5 business days after the return is inspected.\n- Custom items and used consumables are not refundable.\n\n## Shipping\nWe pay return shipping for defects; otherwise the customer does.', officialLang: 'en', changeNote: '首次发布', effectiveDate: ago(100) }, true);
  const warranty = await make('m4', { category: 'policy', titleZh: '保修政策', titleEn: 'Warranty policy', public: true, reviewMonths: 12, bodyZh: '> 示例内容。\n\n- 整机保修 2 年，激光管 1 年。\n- 人为损坏、未按说明书操作不在保修范围内。\n- 保修期内免费更换配件，客户承担寄回运费。', bodyEn: '> Sample text.\n\n- 2 years on the machine, 1 year on the laser tube.\n- Damage from misuse is not covered.\n- Parts are replaced free during the warranty; the customer pays shipping back to us.', officialLang: 'en', changeNote: 'First version', effectiveDate: ago(400) }, true);
  await db.query('UPDATE policy_docs SET next_review=$2 WHERE id=$1', [warranty, ago(5)]);
  const expense = await make('m4', { category: 'policy', titleZh: '报销制度', titleEn: 'Expense policy', requiresAck: true, bodyZh: '> 示例内容。\n\n## 范围\n差旅、招待、办公用品。\n\n## 流程\n1. 消费后 30 天内在钉钉提交报销单并上传发票。\n2. 直属领导审批，财务复核。\n3. 每月 10 日、25 日统一打款。\n\n## 标准\n| 项目 | 上限 |\n| --- | --- |\n| 住宿（一线城市） | 500 元/晚 |\n| 餐补 | 100 元/天 |', bodyEn: '', officialLang: 'zh', changeNote: '新制度，请审批', effectiveDate: ago(-10) }, false);
  await as('m4', 'POST', `/policies/${expense}/draft/submit`);
  await make('m4', { category: 'sop', titleZh: '仓库盘点 SOP', titleEn: 'Warehouse stock count SOP', departmentIds: ['product'], requiresAck: true, bodyZh: '> 示例内容。\n\n1. 盘点前一天在 WMS 冻结出入库。\n2. 两人一组按库位清点，一人数一人记。\n3. 差异超过 2 件的 SKU 复盘一次。\n4. 在 WMS 提交“盘点调整”，由审批人确认。\n5. 盘点表签字后上传到本页附件。', bodyEn: '> Sample text.\n\n1. Freeze movements in WMS the day before.\n2. Count in pairs by bin: one counts, one records.\n3. Recount any SKU that is off by more than 2.\n4. Submit the stock count in WMS for the approver to confirm.\n5. Upload the signed count sheet to this page.', officialLang: 'zh', changeNote: '首次发布', effectiveDate: ago(60) }, true);
  await make('m4', { category: 'sop', titleZh: '经销商发货 SOP', titleEn: 'Dealer shipping SOP', bodyZh: '> 示例内容。\n\n1. 确认订单已全额付款。\n2. 在 WMS 选择发货仓库并出库。\n3. 拍照记录外箱和唛头。\n4. 上传运单号并通知经销商。', bodyEn: '> Sample text.\n\n1. Confirm the order is fully paid.\n2. Pick the ship-from warehouse in WMS and record the outbound.\n3. Photograph the cartons and marks.\n4. Add the tracking number and tell the dealer.', officialLang: 'zh', changeNote: '首次发布', effectiveDate: ago(30) }, true);
  await make('m1', { category: 'culture', titleZh: '使命、愿景与价值观', titleEn: 'Mission, vision and values', bodyZh: '> 示例内容。\n\n## 使命\n让每个创作者都用得起专业的激光设备。\n\n## 愿景\n成为创作者最信任的激光品牌。\n\n## 价值观\n- **客户第一**：先解决客户的问题，再谈其他。\n- **说到做到**：承诺的交期和质量必须兑现。\n- **坦诚**：有问题当面说，对事不对人。\n- **持续改进**：每次复盘都要有一条改进。', bodyEn: '> Sample text.\n\n## Mission\nPut professional lasers within reach of every maker.\n\n## Vision\nThe laser brand makers trust most.\n\n## Values\n- **Customer first**: solve the customer\'s problem first.\n- **Do what we say**: keep the dates and quality we promise.\n- **Candor**: raise problems openly; focus on the issue, not the person.\n- **Keep improving**: every review ends with one improvement.', officialLang: 'zh', changeNote: '首次发布', effectiveDate: ago(200) }, true);
  // m4 (HR) has signed the China handbook; m2 (staff) has not yet.
  const cur = await as('m4', 'GET', `/policies/${cn}`);
  await as('m4', 'POST', `/policies/${cn}/ack`, { versionId: cur.ackVersionId });
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

const AUTO_USERS: Record<string, string> = { owner: 'm1', hr: 'm4', staff: 'm2' }, SESSION_COOKIE = sessionCookieName(false);
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
    // No password on the test site (owner, 2026-11-17: the data is fictional): opening a page signs the visitor in as the owner,
    // and /as/owner, /as/hr, /as/staff switch to that account. Signing out just lands back on the owner.
    const as = /^\/as\/(owner|hr|staff)\/?$/.exec(url.pathname)?.[1];
    if (as) {
      const s = await issueSession(db, AUTO_USERS[as]);
      res.writeHead(302, { location: '/', 'set-cookie': cookie(SESSION_COOKIE, s.accessToken, false), 'cache-control': 'no-store' }); return res.end();
    }
    let file = normalize(join(DIST, decodeURIComponent(url.pathname)));
    if (!file.startsWith(DIST)) { res.writeHead(403); return res.end(); }
    if ((await stat(file).catch(() => null))?.isDirectory()) file = join(file, 'index.html');
    let body = await readFile(file).catch(() => null);
    if (!body) { res.writeHead(404); return res.end('Not found'); }
    if (file.endsWith('index.html')) {
      body = Buffer.from(body.toString('utf8').replace('</body>', BANNER + '</body>'));
      const token = readCookie(req.headers.cookie, SESSION_COOKIE);
      if (!token || !(await resolveSession(db, `Bearer ${token}`))) res.setHeader('set-cookie', cookie(SESSION_COOKIE, (await issueSession(db, AUTO_USERS.owner)).accessToken, false));
    }
    res.writeHead(200, { 'content-type': TYPES[extname(file)] || 'application/octet-stream', 'cache-control': 'no-store' }); res.end(body);
  } catch (error) { console.error(error); res.writeHead(500); res.end('Preview server error'); }
}).listen(PORT, HOST, () => {
  console.log(`WorkOS preview (fictional test data, resets on every start): ${ORIGIN}/`);
  console.log(`Frontend from ${DIST}`);
  console.log(`No sign-in needed: visitors are the owner; /as/hr and /as/staff switch accounts. Password sign-in still works: owner@workos.test · hr@workos.test · staff@workos.test — password ${process.env.PREVIEW_PASSWORD ? '(PREVIEW_PASSWORD)' : PASSWORD}`);
});
