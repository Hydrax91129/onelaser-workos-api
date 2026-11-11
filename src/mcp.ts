/**
 * WorkOS MCP server (https://craftos.app/api/mcp) for the company owner's own AI: Claude (custom connector,
 * OAuth) or Composio and other clients (personal access token).
 *
 * Who may use it: only the people listed in WORKOS_MCP_USER_IDS who are also main admins
 * (WORKOS_EXECUTIVE_USER_IDS). It is checked on every call, so removing someone from the setting cuts them off
 * at once. Everyone else gets 403, even with a token.
 *
 * What it can do: read only. Each tool runs as that person through the existing WorkOS endpoints (same grants,
 * reporting lines, deleted-task rules) and then returns only the fields listed in this file. Costs, landed and
 * channel prices, suppliers, HR records, salaries and customer details are never returned, whatever the
 * person's own rights are: whatever a tool returns leaves WorkOS for the AI provider.
 */
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { hash, issueSession, readCookie, sameSecret, sessionCookieName, type User } from './auth.js';
import type { Database } from './db.js';
import { deny } from './errors.js';
import { attachReportingScope } from './domain.js';

export const mcpSchema = `
CREATE TABLE IF NOT EXISTS mcp_clients(id text PRIMARY KEY, name text NOT NULL, redirect_uris jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE IF NOT EXISTS mcp_auth_codes(code_hash text PRIMARY KEY, client_id text NOT NULL, user_id text NOT NULL, redirect_uri text NOT NULL, code_challenge text NOT NULL, expires_at timestamptz NOT NULL, used_at timestamptz);
CREATE TABLE IF NOT EXISTS mcp_tokens(id text PRIMARY KEY, org_id text NOT NULL, user_id text NOT NULL, kind text NOT NULL CHECK(kind IN ('personal','oauth')), name text NOT NULL, client_id text,
  token_hash text NOT NULL UNIQUE, refresh_hash text UNIQUE, expires_at timestamptz NOT NULL, refresh_expires_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(), last_used_at timestamptz, revoked_at timestamptz);
CREATE INDEX IF NOT EXISTS mcp_tokens_user ON mcp_tokens(user_id, created_at DESC);
CREATE TABLE IF NOT EXISTS mcp_calls(id text PRIMARY KEY, token_id text NOT NULL, user_id text NOT NULL, tool text NOT NULL, ok boolean NOT NULL, created_at timestamptz NOT NULL DEFAULT now());
CREATE INDEX IF NOT EXISTS mcp_calls_user ON mcp_calls(user_id, created_at DESC);
`;

export type McpOptions = { userIds: string[]; executiveUserIds: string[]; publicUrl?: string; secureCookies?: boolean; extraRedirectUris?: string[]; taskScope: (user: User) => readonly [string, readonly unknown[]] };

const PROTOCOLS = ['2025-11-25', '2025-06-18', '2025-03-26'];
const SERVER_INFO = { name: 'workos', title: 'WorkOS', version: '1.0.0' };
const SCOPE = 'workos.read';
const ACCESS_TTL = 3600, REFRESH_TTL = 30 * 864e2;
/** Callback addresses the OAuth login may send a code to: Claude (web, desktop, mobile), local apps such as
 * Claude Code on this computer, and any exact https address set in WORKOS_MCP_REDIRECT_URIS. */
const CLAUDE_CALLBACKS = ['https://claude.ai/api/mcp/auth_callback', 'https://claude.com/api/mcp/auth_callback'];
const opaque = (prefix: string) => prefix + randomBytes(32).toString('base64url');
const pkce = (verifier: string) => createHash('sha256').update(verifier).digest('base64url');
const esc = (v: unknown) => String(v ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

export function validMcpRedirects(raw: string | undefined) {
  const list = (raw || '').split(',').map(x => x.trim()).filter(Boolean);
  for (const v of list) { const u = new URL(v); if (u.protocol !== 'https:' || u.username || u.password || u.hash || u.toString() !== v) throw new Error('Invalid WORKOS_MCP_REDIRECT_URIS entry'); }
  return list;
}
function loopback(value: string) {
  const m = /^http:\/\/(localhost|127\.0\.0\.1|\[::1\]):([1-9][0-9]{0,4})(\/[^?#\s]*)$/.exec(value);
  return !!m && Number(m[2]) <= 65535;
}

/* ---------------- Tools: each picks the listed fields only ---------------- */
type Ctx = { user: User; get: (url: string) => Promise<any>; db: Database; options: McpOptions };
const str = (v: unknown) => (v === null || v === undefined || v === '' ? null : v instanceof Date ? v.toISOString() : String(v));
const day = (v: unknown) => (v ? str(v)!.slice(0, 10) : null);
const nameOf = (u: any) => u ? (u.name_zh || u.display_name || u.name_en || null) : null;
const like = (q: string | undefined, ...values: unknown[]) => !q || values.some(v => String(v ?? '').toLowerCase().includes(q.toLowerCase()));
const props = (p: Record<string, object>, required: string[] = []) => ({ type: 'object', additionalProperties: false, properties: p, ...(required.length ? { required } : {}) });
const limitProp = { type: 'integer', minimum: 1, maximum: 100, description: 'Max rows (default 50)' };

const tools: { name: string; title: string; description: string; inputSchema: object; args: z.ZodType<any>; run: (ctx: Ctx, a: any) => Promise<unknown> }[] = [
  {
    name: 'workos_whoami', title: '我是谁', description: 'Who this WorkOS connection signs in as (name, title, department). 当前连接的 WorkOS 账号。',
    inputSchema: props({}), args: z.object({}).strict(),
    run: async ({ user, get }) => { const me = await get('/me'); return { id: me.id, name: nameOf(me), nameEn: me.name_en || me.display_name, title: me.title || null, department: me.department_id, timezone: me.timezone || null }; }
  },
  {
    name: 'workos_list_tasks', title: '任务列表',
    description: 'List WorkOS tasks the signed-in person may see. scope: mine (I own), team (people who report to me, both reporting lines), all (everything visible). status: open, overdue, done, any. Deleted tasks are never listed. 列出任务。',
    inputSchema: props({ scope: { type: 'string', enum: ['mine', 'team', 'all'] }, status: { type: 'string', enum: ['open', 'overdue', 'done', 'any'] }, owner: { type: 'string', description: 'Part of the owner name' }, query: { type: 'string', description: 'Words in the title' }, limit: limitProp }),
    args: z.object({ scope: z.enum(['mine', 'team', 'all']).default('mine'), status: z.enum(['open', 'overdue', 'done', 'any']).default('open'), owner: z.string().max(60).optional(), query: z.string().max(100).optional(), limit: z.number().int().min(1).max(100).default(50) }).strict(),
    run: async ({ user, db, options }, a) => {
      // The same visibility rule as GET /tasks (both reporting lines), then the filters. Deleted tasks are never listed.
      const [where, params] = options.taskScope(user); const p: unknown[] = [...params]; const cond = ['t.archived_at IS NULL'];
      const arg = (v: unknown) => { p.push(v); return '$' + p.length; };
      if (a.scope === 'mine') cond.push('t.owner_id=' + arg(user.id));
      if (a.scope === 'team') cond.push(Array.isArray(user.visibleOwnerIds) ? `t.owner_id=ANY(${arg(user.visibleOwnerIds.filter(id => id !== user.id))}::text[])` : 't.owner_id<>' + arg(user.id));
      if (a.status === 'open') cond.push("t.status<>'accepted'");
      if (a.status === 'done') cond.push("t.status='accepted'");
      if (a.status === 'overdue') cond.push("t.status<>'accepted' AND t.due_at<now()");
      if (a.query) cond.push(`t.title ILIKE '%'||${arg(a.query)}||'%'`);
      if (a.owner) { const o = arg(a.owner); cond.push(`(o.name_zh ILIKE '%'||${o}||'%' OR o.display_name ILIKE '%'||${o}||'%' OR o.name_en ILIKE '%'||${o}||'%')`); }
      const lim = arg(a.limit);
      const rows = (await db.query(`SELECT t.id,t.title,t.status,t.due_at,t.created_at,t.board_priority,o.name_zh,o.display_name,r.name_zh AS r_zh,r.display_name AS r_name,pr.name AS project,kr.title AS kr
        FROM (SELECT * FROM tasks WHERE ${where}) t LEFT JOIN users o ON o.id=t.owner_id LEFT JOIN users r ON r.id=t.reviewer_id LEFT JOIN projects pr ON pr.id=t.project_id LEFT JOIN key_results kr ON kr.id=t.kr_id
        WHERE ${cond.join(' AND ')} ORDER BY (t.status='accepted'), t.due_at NULLS LAST, t.created_at DESC LIMIT ${lim}`, p)).rows;
      const now = Date.now();
      return { count: rows.length, items: rows.map((t: any) => ({ id: t.id, title: t.title, status: t.status === 'accepted' ? 'done' : t.status === 'revision' ? 'sent_back' : 'open',
        overdue: t.status !== 'accepted' && !!t.due_at && new Date(t.due_at).getTime() < now, due: day(t.due_at), owner: t.name_zh || t.display_name, reviewer: t.r_zh || t.r_name,
        priority: str(t.board_priority), project: t.project || null, keyResult: t.kr || null, created: day(t.created_at) })) };
    }
  },
  {
    name: 'workos_get_task', title: '任务详情', description: 'One task: description, acceptance criteria, owner, due date and progress updates. 任务详情。',
    inputSchema: props({ taskId: { type: 'string' } }, ['taskId']), args: z.object({ taskId: z.string().regex(/^[A-Za-z0-9_-]{1,100}$/) }).strict(),
    run: async ({ get, db }, a) => {
      const t = await get('/tasks/' + a.taskId);
      const people = (await db.query('SELECT id,name_zh,display_name FROM users WHERE id=ANY($1::text[])', [[t.owner_id, t.reviewer_id, t.created_by].filter(Boolean)])).rows;
      const who = (id: string) => nameOf(people.find((p: any) => p.id === id));
      const updates = await get(`/tasks/${a.taskId}/updates`).catch(() => null);
      return { id: t.id, title: t.title, description: t.description || '', criteria: t.criteria || [], status: t.status === 'accepted' ? 'done' : t.status === 'revision' ? 'sent_back' : 'open',
        due: day(t.due_at), created: day(t.created_at), owner: who(t.owner_id), reviewer: who(t.reviewer_id), createdBy: who(t.created_by),
        updates: (updates?.items || []).slice(-20).map((u: any) => ({ at: str(u.created_at), by: u.display_name || null, text: u.body || '' })) };
    }
  },
  {
    name: 'workos_okrs', title: 'OKR', description: 'Objectives and key results with baseline, target, actual and progress (0-1). OKR 进度。',
    inputSchema: props({ query: { type: 'string' } }), args: z.object({ query: z.string().max(100).optional() }).strict(),
    run: async ({ get }, a) => {
      const [o, k] = [await get('/objectives'), await get('/key-results')];
      return { items: (o.items || []).filter((x: any) => like(a.query, x.title)).map((x: any) => ({ id: x.id, level: x.level, title: x.title, owner: x.owner_name_zh || x.owner_name || null,
        keyResults: (k.items || []).filter((r: any) => r.objective_id === x.id).map((r: any) => ({ id: r.id, title: r.title, baseline: r.baseline, target: r.target, actual: r.actual, unit: r.unit || '', progress: r.progress ?? null })) })) };
    }
  },
  {
    name: 'workos_projects', title: '项目', description: 'Projects with health, dates, stages, their tasks and the latest status updates. 项目与进展。',
    inputSchema: props({ query: { type: 'string' } }), args: z.object({ query: z.string().max(100).optional() }).strict(),
    run: async ({ get, db }, a) => {
      const list = (await get('/projects')).items || [];
      const ids = [...new Set(list.flatMap((p: any) => [p.owner_id, ...(p.updates || []).map((u: any) => u.author_id)]).filter(Boolean))];
      const people = (await db.query('SELECT id,name_zh,display_name FROM users WHERE id=ANY($1::text[])', [ids])).rows;
      const who = (id: string) => nameOf(people.find((x: any) => x.id === id));
      return { items: list.filter((p: any) => like(a.query, p.name, p.description)).map((p: any) => ({ id: p.id, name: p.name, description: p.description || '', health: p.health, owner: who(p.owner_id), start: day(p.start_date), end: day(p.end_date),
        stages: (p.groups || []).map((g: any) => ({ name: g.name, tasks: (p.tasks || []).filter((t: any) => t.project_group_id === g.id).map((t: any) => ({ id: t.id, title: t.title, owner: t.task_owner_names?.zh || t.task_owner_names?.display || null, due: day(t.due_at), done: t.status === 'accepted' })) })),
        updates: (p.updates || []).slice(0, 5).map((u: any) => ({ at: day(u.created_at), by: who(u.author_id), health: u.health, text: u.body })) })) };
    }
  },
  {
    name: 'workos_search_products', title: '产品资料',
    description: 'Search the product library (SKU master data). Returns company-wide fields only: names, family, status, specs, packaging, MSRP. Never costs, suppliers or channel prices. 产品资料查询（仅全员可见字段）。',
    inputSchema: props({ query: { type: 'string', description: 'SKU or name' }, status: { type: 'string' }, limit: limitProp }),
    args: z.object({ query: z.string().max(100).optional(), status: z.string().max(20).optional(), limit: z.number().int().min(1).max(100).default(50) }).strict(),
    run: async ({ get }, a) => {
      const lib = await get('/products/library');
      // Company-wide fields only; MAP and the website promotion floor stay inside WorkOS.
      const keys = (lib.spec?.fields || []).filter((f: any) => f.vis === 'all' && !['mainImage', 'map', 'promoFloor'].includes(f.key)).map((f: any) => [f.key, f.zh] as const);
      const items = (lib.items || []).filter((i: any) => like(a.query, i.sku, i.values?.nameZh, i.values?.nameEn) && (!a.status || i.values?.status === a.status)).slice(0, a.limit);
      return { fields: Object.fromEntries(keys), count: items.length, items: items.map((i: any) => Object.fromEntries(keys.map(([k]: readonly [string, string]) => [k, i.values?.[k] ?? null]).filter(([, v]: [string, unknown]) => v !== null && v !== ''))) };
    }
  },
  {
    name: 'workos_stock', title: '库存', description: 'Warehouse stock on hand by SKU and location (WMS). 库存数量（按仓库）。',
    inputSchema: props({ query: { type: 'string', description: 'SKU or name' }, limit: limitProp }), args: z.object({ query: z.string().max(100).optional(), limit: z.number().int().min(1).max(100).default(50) }).strict(),
    run: async ({ get }, a) => {
      const w = await get('/wms/summary'); const loc = Object.fromEntries((w.locations || []).map((l: any) => [l.id, l.zh]));
      const items = (w.items || []).filter((i: any) => like(a.query, i.sku, i.name)).slice(0, a.limit);
      return { locations: loc, items: items.map((i: any) => { const qty = i.qty || {}; return { sku: i.sku, name: i.name, type: i.type, total: Object.values(qty).reduce((s: number, n: any) => s + Number(n || 0), 0), byLocation: Object.fromEntries(Object.entries(qty).map(([k, v]) => [loc[k] || k, v])) }; }) };
    }
  },
  {
    name: 'workos_returns', title: '退货维修', description: 'Returns and repairs (RMA): stage, reason, parts waited for, grade and refurbished discount. No customer details. 退货维修进度（不含客户资料）。',
    inputSchema: props({ stage: { type: 'string', description: 'waiting_repair, waiting_parts, repaired, restocked, listed or sold' }, query: { type: 'string', description: 'RMA number, SKU, name or serial' }, limit: limitProp }),
    args: z.object({ stage: z.string().max(30).optional(), query: z.string().max(100).optional(), limit: z.number().int().min(1).max(100).default(50) }).strict(),
    run: async ({ get }, a) => {
      const r = await get('/rma'); const items = (r.items || []).filter((c: any) => (!a.stage || c.stage === a.stage) && like(a.query, c.number, c.sku, c.name, c.serial)).slice(0, a.limit);
      const byStage: Record<string, number> = {}; for (const c of r.items || []) byStage[c.stage] = (byStage[c.stage] || 0) + 1;
      return { byStage, items: items.map((c: any) => ({ number: c.number, sku: c.sku, name: c.name, serial: c.serial, kind: c.kind, stage: c.stage, waitingFor: str(c.waitingFor), reason: c.reason, diagnosis: str(c.diagnosis),
        technician: str(c.technicianName), received: day(c.receivedAt), openDays: c.openDays ?? null, grade: str(c.grade), discountPct: c.discountPct ?? null, listing: c.listing })) };
    }
  },
  {
    name: 'workos_inbox', title: '消息', description: 'My WorkOS inbox: what needs me and recent updates. 我的消息红点。',
    inputSchema: props({ unreadOnly: { type: 'boolean' } }), args: z.object({ unreadOnly: z.boolean().default(false) }).strict(),
    run: async ({ get }, a) => {
      const i = await get('/inbox');
      return { unread: i.unread ?? 0, needsMe: i.actionOpen ?? 0, items: (i.items || []).filter((x: any) => !a.unreadOnly || !x.read).slice(0, 50).map((x: any) => ({ at: str(x.createdAt), kind: x.kind, title: x.title, text: x.body, read: !!x.read, needsAction: !!x.action && !x.done, taskId: x.taskId || null })) };
    }
  },
  {
    name: 'workos_people', title: '人员', description: 'Company members: name, title, department and leaders. No contact details. 公司成员与汇报线。',
    inputSchema: props({ query: { type: 'string' } }), args: z.object({ query: z.string().max(60).optional() }).strict(),
    run: async ({ get }, a) => {
      const all = (await get('/org/members')).items || []; const by = (id: string) => nameOf(all.find((m: any) => m.id === id));
      return { items: all.filter((m: any) => m.active && !m.quality_factory && like(a.query, m.name_zh, m.name_en, m.display_name, m.title, m.department_id)).map((m: any) => ({ id: m.id, name: nameOf(m), nameEn: m.name_en || m.display_name, title: m.title || null, department: m.department_id, leader: by(m.manager_id), secondLeader: by(m.second_manager_id) })) };
    }
  }
];

/* ---------------- Pages for the OAuth sign-in (no script; inline style only) ---------------- */
function page(title: string, body: string, refresh?: string) {
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">${refresh ? `<meta http-equiv="refresh" content="0;url=${esc(refresh)}">` : ''}<title>${esc(title)} · WorkOS</title>
<style>body{margin:0;font:15px/1.6 -apple-system,BlinkMacSystemFont,"PingFang SC","Microsoft YaHei",sans-serif;background:#f6f7f9;color:#1f2329}main{max-width:520px;margin:48px auto;background:#fff;border:1px solid #e4e6ea;border-radius:14px;padding:28px 26px}
h1{font-size:20px;margin:0 0 12px}p{margin:8px 0;color:#4e5359}dl{margin:16px 0;padding:12px 14px;background:#f6f7f9;border-radius:10px}dt{font-size:12px;color:#8f959e}dd{margin:0 0 8px;word-break:break-all}ul{padding-left:20px;color:#4e5359}
.row{display:flex;gap:10px;margin-top:20px;flex-wrap:wrap}button,a.btn{font:inherit;padding:9px 18px;border-radius:8px;border:1px solid #d0d3d6;background:#fff;color:#1f2329;cursor:pointer;text-decoration:none}button.primary,a.primary{background:#3370ff;border-color:#3370ff;color:#fff}
.warn{color:#b54708;font-size:13px}@media (prefers-color-scheme:dark){body{background:#151517;color:#eee}main{background:#1f1f22;border-color:#333}dl{background:#2a2a2e}p,ul{color:#bbb}button,a.btn{background:#2a2a2e;color:#eee;border-color:#444}}</style></head>
<body><main><h1>${esc(title)}</h1>${body}</main></body></html>`;
}

export async function registerMcpRoutes(app: FastifyInstance, db: Database, options: McpOptions) {
  const origin = options.publicUrl ? new URL(options.publicUrl).origin : '';
  const resource = origin + '/api/mcp', issuer = origin + '/api/mcp/oauth';
  const resourceMetadataUrl = origin + '/.well-known/oauth-protected-resource/api/mcp';
  const allowed = (user: User | null | undefined): user is User => !!user && user.active && options.userIds.includes(user.id) && options.executiveUserIds.includes(user.id);
  const redirectOk = (uri: string) => CLAUDE_CALLBACKS.includes(uri) || loopback(uri) || (options.extraRedirectUris || []).includes(uri);
  const limits = new Map<string, { n: number; until: number }>();
  const limited = (key: string, max: number) => {
    const now = Date.now(); if (limits.size > 2000) for (const [k, v] of limits) if (v.until <= now) limits.delete(k);
    const v = limits.get(key); if (!v || v.until <= now) { limits.set(key, { n: 1, until: now + 60000 }); return false; } return ++v.n > max;
  };
  const html = (reply: FastifyReply, status: number, body: string) => reply.code(status).header('Referrer-Policy', 'same-origin').type('text/html; charset=utf-8').send(body);
  const oauthError = (reply: FastifyReply, status: number, error: string, description?: string) => reply.code(status).header('Pragma', 'no-cache').send({ error, ...(description ? { error_description: description } : {}) });

  /* Discovery (RFC 9728 / RFC 8414). The root /.well-known paths belong to the Grok Bot; these are path-specific. */
  const asMetadata = () => ({ issuer, authorization_endpoint: issuer + '/authorize', token_endpoint: issuer + '/token', registration_endpoint: issuer + '/register', revocation_endpoint: issuer + '/revoke',
    response_types_supported: ['code'], grant_types_supported: ['authorization_code', 'refresh_token'], token_endpoint_auth_methods_supported: ['none'], code_challenge_methods_supported: ['S256'], scopes_supported: [SCOPE] });
  const notConfigured = (reply: FastifyReply) => oauthError(reply, 503, 'temporarily_unavailable', 'The WorkOS MCP server is not configured');
  app.get('/.well-known/oauth-protected-resource/api/mcp', async (_req, reply) => origin ? { resource, authorization_servers: [issuer], scopes_supported: [SCOPE], bearer_methods_supported: ['header'], resource_name: 'WorkOS' } : notConfigured(reply));
  for (const path of ['/.well-known/oauth-authorization-server/api/mcp/oauth', '/.well-known/openid-configuration/api/mcp/oauth', '/mcp/oauth/.well-known/oauth-authorization-server'])
    app.get(path, async (_req, reply) => origin ? asMetadata() : notConfigured(reply));

  /* Dynamic client registration: only for the callback addresses above. */
  app.post('/mcp/oauth/register', { bodyLimit: 16384 }, async (req, reply) => {
    if (!origin) return notConfigured(reply);
    if (limited('reg:' + req.ip, 20)) return oauthError(reply, 429, 'temporarily_unavailable');
    const input = z.object({ redirect_uris: z.array(z.string().max(2000)).min(1).max(10), client_name: z.string().max(200).optional() }).passthrough().safeParse(req.body);
    if (!input.success) return oauthError(reply, 400, 'invalid_client_metadata');
    if (!input.data.redirect_uris.every(redirectOk)) return oauthError(reply, 400, 'invalid_redirect_uri', 'Only Claude and local app callback addresses are allowed');
    const id = 'mcp_' + randomBytes(18).toString('base64url'), name = (input.data.client_name || 'AI app').replace(/[\u0000-\u001f]/g, '').slice(0, 100);
    await db.query('INSERT INTO mcp_clients(id,name,redirect_uris) VALUES($1,$2,$3)', [id, name, JSON.stringify(input.data.redirect_uris)]);
    return reply.code(201).send({ client_id: id, client_id_issued_at: Math.floor(Date.now() / 1000), client_name: name, redirect_uris: input.data.redirect_uris, grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'], token_endpoint_auth_method: 'none' });
  });

  /* Sign-in page: the person must already be signed in to WorkOS in this browser, and must be the MCP user. */
  const authParams = z.object({ response_type: z.literal('code'), client_id: z.string().max(200), redirect_uri: z.string().max(2000), state: z.string().max(1000).optional(),
    code_challenge: z.string().regex(/^[A-Za-z0-9_-]{43,128}$/), code_challenge_method: z.literal('S256'), scope: z.string().max(200).optional(), resource: z.string().max(2000).optional() }).passthrough();
  const checkRequest = async (raw: unknown) => {
    const p = authParams.safeParse(raw); if (!p.success) return { error: '授权请求不完整（缺少 PKCE 或回调地址）。' } as const;
    const client = (await db.query('SELECT * FROM mcp_clients WHERE id=$1', [p.data.client_id])).rows[0];
    if (!client || !(client.redirect_uris as string[]).includes(p.data.redirect_uri) || !redirectOk(p.data.redirect_uri)) return { error: '这个应用或回调地址没有登记，请在 Claude 里重新添加连接。' } as const;
    if (p.data.resource && p.data.resource.replace(/\/$/, '') !== resource) return { error: '授权请求指向的不是 WorkOS MCP。' } as const;
    return { p: p.data, client } as const;
  };
  const sessionUser = async (req: FastifyRequest) => {
    const token = readCookie(req.headers.cookie, sessionCookieName(options.secureCookies === true));
    if (!token) return null;
    const row = (await db.query('SELECT u.*,s.csrf_token FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token_hash=$1 AND s.expires_at>now() AND u.active=true', [hash(token)])).rows[0];
    if (!row) return null;
    if (!row.csrf_token) { row.csrf_token = randomBytes(32).toString('base64url'); await db.query('UPDATE sessions SET csrf_token=$2 WHERE token_hash=$1 AND csrf_token IS NULL', [hash(token), row.csrf_token]); row.csrf_token = (await db.query('SELECT csrf_token FROM sessions WHERE token_hash=$1', [hash(token)])).rows[0].csrf_token; }
    return row as User & { csrf_token: string };
  };
  app.get('/mcp/oauth/authorize', async (req, reply) => {
    if (!origin) return notConfigured(reply);
    if (limited('auth:' + req.ip, 30)) return html(reply, 429, page('请稍后再试', '<p>请求太频繁，请一分钟后再试。</p>'));
    const r = await checkRequest(req.query);
    if ('error' in r) return html(reply, 400, page('无法连接', `<p>${esc(r.error)}</p>`));
    const user = await sessionUser(req);
    if (!user) return html(reply, 200, page('先登录 WorkOS', `<p>请先在这个浏览器里登录 WorkOS，再回到这个页面点“我已登录，继续”。</p><div class="row"><a class="btn primary" href="/" target="_blank" rel="noopener">打开 WorkOS 登录</a><a class="btn" href="${esc(req.url.startsWith('/api') ? req.url : '/api' + req.url)}">我已登录，继续</a></div>`));
    if (!allowed(user)) return html(reply, 403, page('不能连接', '<p>WorkOS MCP 只给指定的主管理员账号使用，当前登录的账号不能连接。</p>'));
    const hidden = Object.entries({ client_id: r.p.client_id, redirect_uri: r.p.redirect_uri, state: r.p.state || '', code_challenge: r.p.code_challenge, csrf: user.csrf_token })
      .map(([k, v]) => `<input type="hidden" name="${k}" value="${esc(v)}">`).join('');
    return html(reply, 200, page('允许这个 AI 连接 WorkOS？', `<dl><dt>应用（名称由应用自己提供）</dt><dd>${esc(r.client.name)}</dd><dt>回调地址</dt><dd>${esc(r.p.redirect_uri)}</dd><dt>以谁的身份</dt><dd>${esc(nameOf(user))}</dd></dl>
<p>允许后，这个应用可以<strong>只读</strong>查看：任务、OKR、项目、产品资料（全员字段）、库存、退货维修进度、消息和人员名单。</p>
<p class="warn">不会给它：成本、到岸价、渠道价、供应商、人事和薪资、客户资料，也不能修改任何数据。可以随时在 WorkOS 的“AI 连接”里断开。</p>
<form method="post" action="/api/mcp/oauth/authorize">${hidden}<div class="row"><button class="primary" name="decision" value="allow">允许</button><button name="decision" value="deny">拒绝</button></div></form>`));
  });
  app.post('/mcp/oauth/authorize', { bodyLimit: 16384 }, async (req, reply) => {
    if (!origin) return notConfigured(reply);
    if (req.headers.origin !== origin) return html(reply, 403, page('无法连接', '<p>请求来源无法核实，请回到 Claude 重新连接。</p>'));
    const body = z.object({ client_id: z.string().max(200), redirect_uri: z.string().max(2000), state: z.string().max(1000), code_challenge: z.string().max(200), csrf: z.string().max(200), decision: z.enum(['allow', 'deny']) }).safeParse(req.body);
    if (!body.success) return html(reply, 400, page('无法连接', '<p>表单不完整，请回到 Claude 重新连接。</p>'));
    const r = await checkRequest({ ...body.data, response_type: 'code', code_challenge_method: 'S256' });
    if ('error' in r) return html(reply, 400, page('无法连接', `<p>${esc(r.error)}</p>`));
    const user = await sessionUser(req);
    if (!user || !sameSecret(body.data.csrf, user.csrf_token)) return html(reply, 403, page('无法连接', '<p>登录状态已变化，请回到 Claude 重新连接。</p>'));
    if (!allowed(user)) return html(reply, 403, page('不能连接', '<p>WorkOS MCP 只给指定的主管理员账号使用。</p>'));
    const back = new URL(body.data.redirect_uri);
    if (body.data.state) back.searchParams.set('state', body.data.state);
    back.searchParams.set('iss', issuer);
    if (body.data.decision === 'deny') { back.searchParams.set('error', 'access_denied'); return html(reply, 200, page('已拒绝', `<p>没有授权。</p><div class="row"><a class="btn" href="${esc(back)}">返回应用</a></div>`, back.toString())); }
    const code = randomBytes(32).toString('base64url');
    await db.query("INSERT INTO mcp_auth_codes(code_hash,client_id,user_id,redirect_uri,code_challenge,expires_at) VALUES($1,$2,$3,$4,$5,now()+interval '5 minutes')", [hash(code), r.p.client_id, user.id, r.p.redirect_uri, r.p.code_challenge]);
    back.searchParams.set('code', code);
    // A page that moves on by itself (and a link) keeps the strict form-action policy: no cross-site form redirect.
    return html(reply, 200, page('已授权，正在返回', `<p>正在返回 ${esc(r.client.name)}……没有自动跳转的话点下面的按钮。</p><div class="row"><a class="btn primary" href="${esc(back)}">返回应用</a></div>`, back.toString()));
  });

  /* Tokens: access 1 hour, refresh 30 days (rotated on every use). */
  const issue = async (userId: string, clientId: string, name: string) => {
    const user = (await db.query('SELECT org_id FROM users WHERE id=$1', [userId])).rows[0];
    const access = opaque('wos_at_'), refresh = opaque('wos_rt_');
    await db.query(`INSERT INTO mcp_tokens(id,org_id,user_id,kind,name,client_id,token_hash,refresh_hash,expires_at,refresh_expires_at) VALUES($1,$2,$3,'oauth',$4,$5,$6,$7,now()+make_interval(secs=>$8),now()+make_interval(secs=>$9))`,
      [randomUUID(), user.org_id, userId, name, clientId, hash(access), hash(refresh), ACCESS_TTL, REFRESH_TTL]);
    return { access_token: access, token_type: 'Bearer', expires_in: ACCESS_TTL, refresh_token: refresh, scope: SCOPE };
  };
  app.post('/mcp/oauth/token', { bodyLimit: 16384 }, async (req, reply) => {
    if (!origin) return notConfigured(reply);
    reply.header('Cache-Control', 'no-store');
    if (limited('tok:' + req.ip, 60)) return oauthError(reply, 429, 'temporarily_unavailable');
    const b = (req.body || {}) as Record<string, string>;
    if (b.grant_type === 'authorization_code') {
      if (!b.code || !b.code_verifier || !b.client_id || !b.redirect_uri) return oauthError(reply, 400, 'invalid_request');
      const row = (await db.query('UPDATE mcp_auth_codes SET used_at=now() WHERE code_hash=$1 AND used_at IS NULL AND expires_at>now() RETURNING *', [hash(String(b.code))])).rows[0];
      if (!row || row.client_id !== b.client_id || row.redirect_uri !== b.redirect_uri || pkce(String(b.code_verifier)) !== row.code_challenge) return oauthError(reply, 400, 'invalid_grant');
      const user = (await db.query('SELECT * FROM users WHERE id=$1', [row.user_id])).rows[0];
      if (!allowed(user)) return oauthError(reply, 400, 'invalid_grant', 'This account may not use the WorkOS MCP server');
      const client = (await db.query('SELECT name FROM mcp_clients WHERE id=$1', [row.client_id])).rows[0];
      return issue(row.user_id, row.client_id, client?.name || 'AI app');
    }
    if (b.grant_type === 'refresh_token') {
      if (!b.refresh_token || !b.client_id) return oauthError(reply, 400, 'invalid_request');
      const access = opaque('wos_at_'), refresh = opaque('wos_rt_');
      const row = (await db.query(`UPDATE mcp_tokens SET token_hash=$3,refresh_hash=$4,expires_at=now()+make_interval(secs=>$5),refresh_expires_at=now()+make_interval(secs=>$6)
        WHERE refresh_hash=$1 AND client_id=$2 AND kind='oauth' AND revoked_at IS NULL AND refresh_expires_at>now() RETURNING user_id`, [hash(String(b.refresh_token)), String(b.client_id), hash(access), hash(refresh), ACCESS_TTL, REFRESH_TTL])).rows[0];
      if (!row) return oauthError(reply, 400, 'invalid_grant');
      const user = (await db.query('SELECT * FROM users WHERE id=$1', [row.user_id])).rows[0];
      if (!allowed(user)) return oauthError(reply, 400, 'invalid_grant', 'This account may not use the WorkOS MCP server');
      return { access_token: access, token_type: 'Bearer', expires_in: ACCESS_TTL, refresh_token: refresh, scope: SCOPE };
    }
    return oauthError(reply, 400, 'unsupported_grant_type');
  });
  app.post('/mcp/oauth/revoke', { bodyLimit: 16384 }, async (req, reply) => {
    const t = String(((req.body || {}) as any).token || '');
    if (t) await db.query('UPDATE mcp_tokens SET revoked_at=COALESCE(revoked_at,now()) WHERE token_hash=$1 OR refresh_hash=$1', [hash(t)]);
    return reply.code(200).send({});
  });

  /* The MCP endpoint (Streamable HTTP, JSON responses, no server-sent stream). */
  const unauthorized = (reply: FastifyReply, error = 'invalid_token') => reply.code(401).header('WWW-Authenticate', `Bearer resource_metadata="${resourceMetadataUrl}", scope="${SCOPE}"${error ? `, error="${error}"` : ''}`)
    .send({ jsonrpc: '2.0', error: { code: -32001, message: 'Authentication is required' } });
  const rpc = (id: unknown, result: object) => ({ jsonrpc: '2.0', id, result });
  const rpcErr = (id: unknown, code: number, message: string) => ({ jsonrpc: '2.0', id: id ?? null, error: { code, message } });
  app.get('/mcp', async (_req, reply) => reply.code(405).header('Allow', 'POST').send({ error: 'Use POST' }));
  app.delete('/mcp', async (_req, reply) => reply.code(405).header('Allow', 'POST').send({ error: 'Use POST' }));
  app.post('/mcp', { bodyLimit: 256 * 1024 }, async (req, reply) => {
    if (req.headers.origin && req.headers.origin !== origin) return reply.code(403).send(rpcErr(null, -32600, 'Origin not allowed'));
    const bearer = /^Bearer (wos_(?:pat|at)_[A-Za-z0-9_-]{43})$/.exec(req.headers.authorization || '')?.[1];
    if (!bearer) return unauthorized(reply, '');
    const tok = (await db.query('SELECT * FROM mcp_tokens WHERE token_hash=$1 AND revoked_at IS NULL AND expires_at>now()', [hash(bearer)])).rows[0];
    if (!tok) return unauthorized(reply);
    const user = (await db.query<User>('SELECT * FROM users WHERE id=$1 AND active=true', [tok.user_id])).rows[0];
    if (!allowed(user)) return reply.code(403).send(rpcErr(null, -32003, 'This account may not use the WorkOS MCP server'));
    if (limited('mcp:' + tok.id, 120)) return reply.code(429).send(rpcErr(null, -32000, 'Too many requests; try again in a minute'));
    await db.query('UPDATE mcp_tokens SET last_used_at=now() WHERE id=$1', [tok.id]);
    const msg = req.body as any;
    if (Array.isArray(msg) || !msg || typeof msg !== 'object' || msg.jsonrpc !== '2.0' || typeof msg.method !== 'string') return reply.code(400).send(rpcErr(null, -32600, 'Invalid request'));
    if (msg.id === undefined) return reply.code(202).send(); // notifications (e.g. notifications/initialized)
    const params = msg.params && typeof msg.params === 'object' ? msg.params : {};
    if (msg.method === 'initialize') {
      const asked = String(params.protocolVersion || ''), version = PROTOCOLS.includes(asked) ? asked : PROTOCOLS[0];
      return rpc(msg.id, { protocolVersion: version, capabilities: { tools: { listChanged: false } }, serverInfo: SERVER_INFO,
        instructions: 'WorkOS (OneLaser company workspace), read only. Data is company-internal: do not publish it. Costs, channel prices, HR and customer details are not available through this connection.' });
    }
    if (msg.method === 'ping') return rpc(msg.id, {});
    if (msg.method === 'tools/list') return rpc(msg.id, { tools: tools.map(t => ({ name: t.name, title: t.title, description: t.description, inputSchema: t.inputSchema, annotations: { readOnlyHint: true, openWorldHint: false } })) });
    if (msg.method !== 'tools/call') return reply.send(rpcErr(msg.id, -32601, 'Method not found'));
    const tool = tools.find(t => t.name === params.name);
    if (!tool) return reply.send(rpcErr(msg.id, -32602, 'Unknown tool'));
    const args = tool.args.safeParse(params.arguments ?? {});
    const done = async (ok: boolean, value: unknown) => {
      await db.query('INSERT INTO mcp_calls(id,token_id,user_id,tool,ok) VALUES($1,$2,$3,$4,$5)', [randomUUID(), tok.id, user.id, tool.name, ok]);
      return rpc(msg.id, { content: [{ type: 'text', text: JSON.stringify(value) }], ...(ok && value && typeof value === 'object' && !Array.isArray(value) ? { structuredContent: value } : {}), isError: !ok });
    };
    if (!args.success) return done(false, { error: 'Invalid arguments', issues: args.error.issues.map(i => `${i.path.join('.')}: ${i.message}`) });
    // Run as this person through the normal endpoints (GET only), with a session that lives for this call only.
    const session = (await issueSession(db, user.id)).accessToken;
    const get = async (url: string) => {
      const res = await app.inject({ method: 'GET', url, headers: { authorization: 'Bearer ' + session, 'accept-language': 'zh-CN' } });
      if (res.statusCode >= 400) { let m = ''; try { m = res.json().error?.message || ''; } catch { /* not JSON */ } throw new McpToolError(res.statusCode, m); }
      return res.json();
    };
    try {
      const scoped = { ...user }; await attachReportingScope(db, scoped);
      return await done(true, await tool.run({ user: scoped, get, db, options }, args.data));
    } catch (error) {
      if (error instanceof McpToolError) return done(false, { error: error.status === 404 ? 'Not found' : error.status === 403 ? 'Not allowed for this account' : 'The request could not be completed', detail: error.detail || undefined });
      req.log.error(error); return done(false, { error: 'The request could not be completed' });
    } finally { await db.query('DELETE FROM sessions WHERE token_hash=$1', [hash(session)]); }
  });

  /* "AI 连接" page in WorkOS (signed-in, normal session and CSRF rules): main admins only. */
  const exec = (req: FastifyRequest) => { const user = (req as any).actor as User; if (!options.executiveUserIds.includes(user.id)) deny(403, 'FORBIDDEN', 'Only the company owner can manage AI connections', '只有主管理员可以管理 AI 连接。'); return user; };
  app.get('/mcp/connections', async req => {
    const user = exec(req);
    const tokens = (await db.query('SELECT id,kind,name,created_at,last_used_at,expires_at,revoked_at FROM mcp_tokens WHERE user_id=$1 AND revoked_at IS NULL AND (expires_at>now() OR refresh_expires_at>now()) ORDER BY created_at DESC LIMIT 50', [user.id])).rows;
    const calls = (await db.query('SELECT tool,ok,created_at FROM mcp_calls WHERE user_id=$1 ORDER BY created_at DESC LIMIT 20', [user.id])).rows;
    return { enabled: allowed(user), configured: !!origin, userId: user.id, url: resource, redirects: [...CLAUDE_CALLBACKS, ...(options.extraRedirectUris || [])],
      tools: tools.map(t => ({ name: t.name, title: t.title })),
      tokens: tokens.map((t: any) => ({ id: t.id, kind: t.kind, name: t.name, createdAt: t.created_at, lastUsedAt: t.last_used_at, expiresAt: t.kind === 'personal' ? t.expires_at : null })),
      calls: calls.map((c: any) => ({ tool: c.tool, ok: c.ok, at: c.created_at })) };
  });
  app.post('/mcp/tokens', async (req, reply) => {
    const user = exec(req);
    if (!allowed(user)) deny(403, 'MCP_NOT_ENABLED', 'This account is not set up to use the WorkOS MCP server', '这个账号还没有开通 WorkOS MCP（需要在 Render 设置 WORKOS_MCP_USER_IDS）。');
    const input = z.object({ name: z.string().trim().min(1).max(60), days: z.union([z.literal(30), z.literal(90), z.literal(365)]).default(90) }).strict().parse(req.body);
    const token = opaque('wos_pat_'), id = randomUUID();
    await db.query("INSERT INTO mcp_tokens(id,org_id,user_id,kind,name,token_hash,expires_at) VALUES($1,$2,$3,'personal',$4,$5,now()+make_interval(days=>$6))", [id, user.org_id, user.id, input.name, hash(token), input.days]);
    return reply.code(201).send({ id, name: input.name, token, expiresInDays: input.days });
  });
  app.post<{ Params: { id: string } }>('/mcp/tokens/:id/revoke', async req => {
    const user = exec(req);
    const row = (await db.query('UPDATE mcp_tokens SET revoked_at=COALESCE(revoked_at,now()) WHERE id=$1 AND user_id=$2 RETURNING id', [z.string().uuid().parse(req.params.id), user.id])).rows[0];
    if (!row) deny(404, 'NOT_FOUND', 'Connection not found', '找不到这个连接。');
    return { revoked: true };
  });
}

class McpToolError extends Error { constructor(public status: number, public detail: string) { super('tool error'); } }

export const MCP_PUBLIC_PATHS = ['/mcp', '/mcp/oauth/register', '/mcp/oauth/authorize', '/mcp/oauth/token', '/mcp/oauth/revoke', '/mcp/oauth/.well-known/oauth-authorization-server',
  '/.well-known/oauth-protected-resource/api/mcp', '/.well-known/oauth-authorization-server/api/mcp/oauth', '/.well-known/openid-configuration/api/mcp/oauth'];
