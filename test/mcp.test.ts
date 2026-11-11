import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createDatabase, schema, seedDemo } from '../src/db.js';
import { buildApp } from '../src/app.js';
import { issueSession } from '../src/auth.js';

const ORIGIN = 'https://workos.test';
const setup = async (mcpUserIds = ['m1'], closeDatabase = true) => {
  const db = await createDatabase(); await db.exec(schema); await seedDemo(db);
  const app = await buildApp({ db, integrations: { executiveUserIds: ['m1'], mcpUserIds, appPublicUrl: ORIGIN }, closeDatabase, completionModel: null, translationModel: null, mailer: null, nudgeIntervalMs: 0 });
  const tokens: Record<string, string> = {};
  const as = async (who: string, method: 'GET' | 'POST', url: string, payload?: any) => { tokens[who] ??= (await issueSession(db, who)).accessToken; return app.inject({ method, url, payload, headers: { authorization: 'Bearer ' + tokens[who] } }); };
  const mcp = (token: string, body: any) => app.inject({ method: 'POST', url: '/mcp', payload: body, headers: { authorization: 'Bearer ' + token, accept: 'application/json, text/event-stream' } });
  const call = async (token: string, name: string, args: any = {}) => { const r = await mcp(token, { jsonrpc: '2.0', id: 7, method: 'tools/call', params: { name, arguments: args } }); assert.equal(r.statusCode, 200, r.body); return r.json().result; };
  return { db, app, as, mcp, call };
};

test('WorkOS MCP: only the configured main admin, read only, and only the listed fields', async () => {
  const { db, app, as, mcp, call } = await setup();
  try {
    // Discovery and the 401 challenge that sends Claude to the OAuth sign-in.
    const prm = (await app.inject({ method: 'GET', url: '/.well-known/oauth-protected-resource/api/mcp' })).json();
    assert.equal(prm.resource, ORIGIN + '/api/mcp'); assert.deepEqual(prm.authorization_servers, [ORIGIN + '/api/mcp/oauth']);
    const asm = (await app.inject({ method: 'GET', url: '/.well-known/oauth-authorization-server/api/mcp/oauth' })).json();
    assert.equal(asm.issuer, ORIGIN + '/api/mcp/oauth'); assert.deepEqual(asm.code_challenge_methods_supported, ['S256']);
    const none = await app.inject({ method: 'POST', url: '/mcp', payload: { jsonrpc: '2.0', id: 1, method: 'initialize', params: {} } });
    assert.equal(none.statusCode, 401); assert.match(String(none.headers['www-authenticate']), /resource_metadata="https:\/\/workos\.test\/\.well-known\/oauth-protected-resource\/api\/mcp"/);
    assert.equal((await mcp('wos_pat_' + 'x'.repeat(43), { jsonrpc: '2.0', id: 1, method: 'ping' })).statusCode, 401, 'unknown token');

    // Personal tokens: main admins only; everyone else is refused.
    assert.equal((await as('m2', 'GET', '/mcp/connections')).statusCode, 403);
    assert.equal((await as('m2', 'POST', '/mcp/tokens', { name: 'x' })).statusCode, 403);
    assert.equal((await as('m2', 'GET', '/me')).json().mcpAccess, false);
    assert.equal((await as('m1', 'GET', '/me')).json().mcpAccess, true);
    const made = await as('m1', 'POST', '/mcp/tokens', { name: 'Composio', days: 30 });
    assert.equal(made.statusCode, 201, made.body); const token = made.json().token; assert.match(token, /^wos_pat_[A-Za-z0-9_-]{43}$/);
    const conn = (await as('m1', 'GET', '/mcp/connections')).json();
    assert.equal(conn.enabled, true); assert.equal(conn.url, ORIGIN + '/api/mcp'); assert.equal(conn.tokens.length, 1); assert.equal(conn.tokens[0].name, 'Composio');
    assert.ok(!JSON.stringify(conn).includes(token), 'the token is shown once, never listed');

    // Protocol.
    const init = (await mcp(token, { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '1' } } })).json();
    assert.equal(init.result.protocolVersion, '2025-06-18'); assert.ok(init.result.capabilities.tools);
    assert.equal((await mcp(token, { jsonrpc: '2.0', method: 'notifications/initialized' })).statusCode, 202);
    const list = (await mcp(token, { jsonrpc: '2.0', id: 2, method: 'tools/list' })).json().result.tools;
    assert.ok(list.length >= 9); assert.ok(list.every((t: any) => t.annotations.readOnlyHint === true), 'every tool is read only');
    assert.ok(!list.some((t: any) => /create|update|delete|complete|write/i.test(t.name)), 'no write tools');
    assert.equal((await mcp(token, { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'nope' } })).json().error.code, -32602);

    // Tools run as the person; temporary sessions do not pile up.
    const sessions = Number((await db.query('SELECT count(*)::int AS n FROM sessions')).rows[0].n);
    assert.equal((await call(token, 'workos_whoami')).structuredContent.id, 'm1');
    const tasks = (await call(token, 'workos_list_tasks', { scope: 'all', status: 'any' })).structuredContent;
    assert.ok(tasks.items.length > 0); assert.ok(tasks.items.filter((t: any) => t.due).every((t: any) => /^\d{4}-\d{2}-\d{2}$/.test(t.due)), 'dates are YYYY-MM-DD');
    const gone = tasks.items[0].id; await db.query('UPDATE tasks SET archived_at=now() WHERE id=$1', [gone]);
    assert.ok(!(await call(token, 'workos_list_tasks', { scope: 'all', status: 'any' })).structuredContent.items.some((t: any) => t.id === gone), 'deleted tasks are not listed');
    const other = tasks.items[1].id;
    const detail = (await call(token, 'workos_get_task', { taskId: other })).structuredContent; assert.equal(detail.id, other); assert.ok(Array.isArray(detail.criteria));
    assert.equal((await call(token, 'workos_get_task', { taskId: gone })).isError, true, 'a deleted task is not found');
    assert.equal((await call(token, 'workos_list_tasks', { status: 'bogus' })).isError, true, 'bad arguments are an error result');
    for (const name of ['workos_okrs', 'workos_projects', 'workos_inbox', 'workos_people', 'workos_stock']) assert.equal((await call(token, name)).isError, false, name);
    assert.equal(Number((await db.query('SELECT count(*)::int AS n FROM sessions')).rows[0].n), sessions, 'each call removes its session');

    // Products: company-wide fields only, even though this person may see costs.
    await db.query(`INSERT INTO product_catalog(org_id,sku,msrp) SELECT org_id,'DEMO-MCP-1',1999 FROM users WHERE id='m1' ON CONFLICT DO NOTHING`);
    const lib = await as('m1', 'GET', '/products/library'); assert.equal(lib.statusCode, 200);
    const p = (await call(token, 'workos_search_products', { query: 'DEMO-MCP-1' })).structuredContent;
    assert.equal(p.items[0].sku, 'DEMO-MCP-1'); assert.equal(p.items[0].msrp, 1999);
    for (const k of ['landed', 'lastMile', 'supplier', 'supplierAlt1', 'hsCode', 'customsName', 'moqUnit', 'safetyStock', 'map', 'promoFloor']) assert.ok(!(k in p.fields), k + ' is never sent');
    // Returns: no customer details.
    const made1 = await as('m1', 'POST', '/rma', { sku: 'REF-DEMO-MCP-1', serial: 'SN-MCP', productClass: 'machine', condition: '外观完好', reason: '示例', receivedAt: '2026-11-01', customer: '示例客户', orderRef: '#9' });
    assert.equal(made1.statusCode, 201, made1.body);
    assert.equal((await call(token, 'workos_returns', { query: 'SN-MCP' })).structuredContent.items[0].serial, 'SN-MCP');
    const rma = await call(token, 'workos_returns');
    assert.equal(rma.isError, false); assert.ok(!JSON.stringify(rma).includes('示例客户') && !JSON.stringify(rma).includes('#9'), 'no customer or order reference');
    const calls = (await as('m1', 'GET', '/mcp/connections')).json().calls; assert.ok(calls.length > 5);

    // Revoked tokens stop working at once.
    await as('m1', 'POST', `/mcp/tokens/${made.json().id}/revoke`);
    assert.equal((await mcp(token, { jsonrpc: '2.0', id: 1, method: 'ping' })).statusCode, 401);
  } finally { await app.close(); }
});

test('WorkOS MCP: removing the person from WORKOS_MCP_USER_IDS cuts their token off', async () => {
  const { db, app, as } = await setup(['m1'], false);
  const token = (await as('m1', 'POST', '/mcp/tokens', { name: 'x' })).json().token; await app.close();
  const app2 = await buildApp({ db, integrations: { executiveUserIds: ['m1'], mcpUserIds: [], appPublicUrl: ORIGIN }, completionModel: null, translationModel: null, mailer: null, nudgeIntervalMs: 0 });
  try {
    assert.equal((await app2.inject({ method: 'POST', url: '/mcp', payload: { jsonrpc: '2.0', id: 1, method: 'ping' }, headers: { authorization: 'Bearer ' + token } })).statusCode, 403);
    const s = (await issueSession(db, 'm1')).accessToken;
    const r = await app2.inject({ method: 'POST', url: '/mcp/tokens', payload: { name: 'y' }, headers: { authorization: 'Bearer ' + s } });
    assert.equal(r.statusCode, 403); assert.equal(r.json().error.code, 'MCP_NOT_ENABLED');
  } finally { await app2.close(); }
});

test('WorkOS MCP OAuth: Claude registers, the owner approves in the browser, PKCE code for tokens, refresh rotates', async () => {
  const { db, app, mcp } = await setup();
  try {
    assert.equal((await app.inject({ method: 'POST', url: '/mcp/oauth/register', payload: { redirect_uris: ['https://evil.example/cb'], client_name: 'Evil' } })).statusCode, 400, 'unknown callbacks are refused');
    const reg = await app.inject({ method: 'POST', url: '/mcp/oauth/register', payload: { redirect_uris: ['https://claude.ai/api/mcp/auth_callback'], client_name: 'Claude' } });
    assert.equal(reg.statusCode, 201, reg.body); const clientId = reg.json().client_id;
    const verifier = 'v'.repeat(64), challenge = createHash('sha256').update(verifier).digest('base64url');
    const q = new URLSearchParams({ response_type: 'code', client_id: clientId, redirect_uri: 'https://claude.ai/api/mcp/auth_callback', state: 's1', code_challenge: challenge, code_challenge_method: 'S256', resource: ORIGIN + '/api/mcp' });
    const url = '/mcp/oauth/authorize?' + q;
    assert.match((await app.inject({ method: 'GET', url })).body, /先登录 WorkOS/, 'not signed in: asks to sign in first');
    const cookieFor = async (who: string) => 'workos_session=' + (await issueSession(db, who)).accessToken;
    assert.equal((await app.inject({ method: 'GET', url, headers: { cookie: await cookieFor('m2') } })).statusCode, 403, 'other people cannot connect');
    const ownerCookie = await cookieFor('m1');
    const consent = await app.inject({ method: 'GET', url, headers: { cookie: ownerCookie } });
    assert.equal(consent.statusCode, 200); assert.match(consent.body, /只读/); assert.match(consent.body, /不会给它：成本/);
    const csrf = /name="csrf" value="([^"]+)"/.exec(consent.body)![1];
    const form = (extra: Record<string, string>) => new URLSearchParams({ client_id: clientId, redirect_uri: 'https://claude.ai/api/mcp/auth_callback', state: 's1', code_challenge: challenge, csrf, decision: 'allow', ...extra }).toString();
    const post = (body: string, origin = ORIGIN) => app.inject({ method: 'POST', url: '/mcp/oauth/authorize', payload: body, headers: { cookie: ownerCookie, origin, 'content-type': 'application/x-www-form-urlencoded' } });
    assert.equal((await post(form({}), 'https://evil.example')).statusCode, 403, 'cross-site form posts are refused');
    assert.equal((await post(form({ csrf: 'x'.repeat(43) }))).statusCode, 403, 'wrong security token');
    const ok = await post(form({})); assert.equal(ok.statusCode, 200, ok.body);
    const back = new URL(/http-equiv="refresh" content="0;url=([^"]+)"/.exec(ok.body)![1].replace(/&amp;/g, '&'));
    assert.equal(back.origin + back.pathname, 'https://claude.ai/api/mcp/auth_callback'); assert.equal(back.searchParams.get('state'), 's1');
    const code = back.searchParams.get('code')!;
    const token = (body: Record<string, string>) => app.inject({ method: 'POST', url: '/mcp/oauth/token', payload: new URLSearchParams(body).toString(), headers: { 'content-type': 'application/x-www-form-urlencoded' } });
    assert.equal((await token({ grant_type: 'authorization_code', code, client_id: clientId, redirect_uri: 'https://claude.ai/api/mcp/auth_callback', code_verifier: 'w'.repeat(64) })).json().error, 'invalid_grant', 'PKCE must match');
    const ok2 = await post(form({})); const code2 = new URL(/content="0;url=([^"]+)"/.exec(ok2.body)![1].replace(/&amp;/g, '&')).searchParams.get('code')!;
    const t = await token({ grant_type: 'authorization_code', code: code2, client_id: clientId, redirect_uri: 'https://claude.ai/api/mcp/auth_callback', code_verifier: verifier });
    assert.equal(t.statusCode, 200, t.body); const { access_token, refresh_token } = t.json();
    assert.equal((await token({ grant_type: 'authorization_code', code: code2, client_id: clientId, redirect_uri: 'https://claude.ai/api/mcp/auth_callback', code_verifier: verifier })).json().error, 'invalid_grant', 'a code works once');
    assert.equal((await mcp(access_token, { jsonrpc: '2.0', id: 1, method: 'ping' })).statusCode, 200);
    const r = await token({ grant_type: 'refresh_token', refresh_token, client_id: clientId }); assert.equal(r.statusCode, 200, r.body);
    assert.equal((await mcp(access_token, { jsonrpc: '2.0', id: 1, method: 'ping' })).statusCode, 401, 'the old access token is replaced');
    assert.equal((await token({ grant_type: 'refresh_token', refresh_token, client_id: clientId })).json().error, 'invalid_grant', 'refresh tokens rotate');
    assert.equal((await mcp(r.json().access_token, { jsonrpc: '2.0', id: 1, method: 'ping' })).statusCode, 200);
    await app.inject({ method: 'POST', url: '/mcp/oauth/revoke', payload: new URLSearchParams({ token: r.json().access_token }).toString(), headers: { 'content-type': 'application/x-www-form-urlencoded' } });
    assert.equal((await mcp(r.json().access_token, { jsonrpc: '2.0', id: 1, method: 'ping' })).statusCode, 401, 'revoked');
  } finally { await app.close(); }
});
