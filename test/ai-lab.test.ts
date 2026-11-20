import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createDatabase, schema, seedDemo } from '../src/db.js';
import { buildApp } from '../src/app.js';
import { issueSession } from '../src/auth.js';

// AI超算 (owner, 2026-11-20): owner only, replies stream into the chat in the background, previews run sandboxed.
function fakeClient(chunks: string[], seen: any[] = []) {
  return { messages: { stream(body: any, opts: any) {
    seen.push(body);
    return (async function* () {
      for (const t of chunks) { if (opts?.signal?.aborted) throw new Error('aborted'); await new Promise(r => setTimeout(r, 2)); yield { type: 'content_block_delta', delta: { type: 'text_delta', text: t } }; }
    })();
  } } } as any;
}
async function setup(client?: any) {
  const db = await createDatabase(); await db.exec(schema); await seedDemo(db);
  const app = await buildApp({ db, integrations: { executiveUserIds: ['m1', 'm4'] }, completionModel: null, translationModel: null, mailer: null, nudgeIntervalMs: 0, aiLab: { client, userIds: ['m1'] } } as any);
  const tokens: Record<string, string> = {};
  const call = async (who: string, method: 'GET' | 'POST' | 'DELETE', url: string, payload?: any) => { tokens[who] ??= (await issueSession(db, who)).accessToken;
    return app.inject({ method, url, payload, headers: { authorization: 'Bearer ' + tokens[who], 'accept-language': 'zh-CN' } }); };
  return { app, call };
}
const until = async (f: () => Promise<boolean>) => { for (let i = 0; i < 200; i++) { if (await f()) return; await new Promise(r => setTimeout(r, 10)); } throw new Error('timed out'); };

test('AI超算: only the listed owner (and a main admin) sees it; others get a plain 404', async () => {
  const { call } = await setup(fakeClient(['hi']));
  assert.equal((await call('m1', 'GET', '/me')).json().aiLabAccess, true);
  assert.equal((await call('m4', 'GET', '/me')).json().aiLabAccess, false, 'another main admin, not on the list');
  for (const who of ['m4', 'm2']) assert.equal((await call(who, 'GET', '/ai-lab/chats')).statusCode, 404, who);
});

test('AI超算: a desk conversation streams its reply into the chat; the desk prompt never names the provider', async () => {
  const seen: any[] = [];
  const { call } = await setup(fakeClient(['## 方案\n', '```svg\n<svg viewBox="0 0 10 10"></svg>\n```'], seen));
  const chat = (await call('m1', 'POST', '/ai-lab/chats', { desk: 'mech' })).json();
  const sent = await call('m1', 'POST', `/ai-lab/chats/${chat.id}/messages`, { text: '设计一个 1300×900 激光切割机的龙门结构' });
  assert.equal(sent.statusCode, 202, sent.body);
  await until(async () => !(await call('m1', 'GET', `/ai-lab/chats/${chat.id}`)).json().busy);
  const c = (await call('m1', 'GET', `/ai-lab/chats/${chat.id}`)).json();
  assert.equal(c.title, '设计一个 1300×900 激光切割机的龙门结构');
  assert.deepEqual(c.messages.map((m: any) => [m.role, m.status ?? null]), [['user', null], ['assistant', 'done']]);
  assert.match(c.messages[1].text, /```svg/);
  assert.match(seen[0].system, /机械/); assert.doesNotMatch(seen[0].system, /claude|anthropic/i);
  // the second turn carries the history
  await call('m1', 'POST', `/ai-lab/chats/${chat.id}/messages`, { text: '改成 1600×1000' });
  await until(async () => !(await call('m1', 'GET', `/ai-lab/chats/${chat.id}`)).json().busy);
  assert.equal(seen[1].messages.length, 3);
  assert.equal((await call('m1', 'GET', '/ai-lab/chats')).json().chats.length, 1);
  assert.equal((await call('m1', 'DELETE', `/ai-lab/chats/${chat.id}`)).statusCode, 200);
  assert.equal((await call('m1', 'GET', `/ai-lab/chats/${chat.id}`)).statusCode, 404);
});

test('AI超算: previews open sandboxed; not configured says so', async () => {
  const { call } = await setup(fakeClient(['x']));
  const p = (await call('m1', 'POST', '/ai-lab/previews', { kind: 'html', body: '<!doctype html><h1>Demo</h1>' })).json();
  const r = await call('m1', 'GET', p.url.replace('/api', ''));
  assert.equal(r.statusCode, 200); assert.match(r.headers['content-security-policy'] as string, /^sandbox allow-scripts/);
  assert.doesNotMatch(r.headers['content-security-policy'] as string, /allow-same-origin/);
  assert.match(r.body, /<h1>Demo<\/h1>/);
  assert.equal((await call('m4', 'GET', p.url.replace('/api', ''))).statusCode, 404);
  const off = await setup(undefined);
  const chat = (await off.call('m1', 'POST', '/ai-lab/chats', { desk: 'soft' })).json();
  assert.equal((await off.call('m1', 'POST', `/ai-lab/chats/${chat.id}/messages`, { text: '做一个落地页' })).json().error.code, 'AI_LAB_NOT_CONFIGURED');
});

test('AI超算: with no list set, every main admin sees it and no one else does', async () => {
  const db = await createDatabase(); await db.exec(schema); await seedDemo(db);
  const app = await buildApp({ db, integrations: { executiveUserIds: ['m1'], mcpUserIds: ['m4'] }, completionModel: null, translationModel: null, mailer: null, nudgeIntervalMs: 0 } as any);
  const me = async (who: string) => (await app.inject({ method: 'GET', url: '/me', headers: { authorization: 'Bearer ' + (await issueSession(db, who)).accessToken } })).json().aiLabAccess;
  assert.deepEqual([await me('m1'), await me('m4'), await me('m2')], [true, false, false]);
});

test('AI超算: attach a drawing photo, a PDF and a DXF; they reach the model as image, document and text', async () => {
  const seen: any[] = [];
  const { call } = await setup(fakeClient(['看到了'], seen));
  const up = (name: string, mime: string, body: Buffer) => call('m1', 'POST', '/ai-lab/files', { name, mime, dataBase64: body.toString('base64') });
  const png = (await up('sketch.png', 'image/png', Buffer.from([137, 80, 78, 71, 1, 2, 3]))).json();
  const pdf = (await up('spec.pdf', 'application/pdf', Buffer.from('%PDF-1.4 demo'))).json();
  const dxf = (await up('bracket.dxf', '', Buffer.from('0\nSECTION\n2\nENTITIES'))).json();
  assert.deepEqual([png.kind, pdf.kind, dxf.kind], ['image', 'pdf', 'text']);
  assert.equal((await up('virus.exe', 'application/octet-stream', Buffer.from('MZ'))).json().error.code, 'AI_LAB_FILE_TYPE');
  assert.equal((await call('m4', 'POST', '/ai-lab/files', { name: 'a.png', mime: 'image/png', dataBase64: 'AAAA' })).statusCode, 404, 'not for others');
  const chat = (await call('m1', 'POST', '/ai-lab/chats', { desk: 'mech' })).json();
  assert.equal((await call('m1', 'POST', `/ai-lab/chats/${chat.id}/messages`, { fileIds: [png.id, pdf.id, dxf.id] })).statusCode, 202, 'files alone are enough');
  await until(async () => !(await call('m1', 'GET', `/ai-lab/chats/${chat.id}`)).json().busy);
  const content = seen[0].messages[0].content;
  assert.deepEqual(content.map((b: any) => b.type), ['image', 'document', 'text', 'text']);
  assert.match(content[2].text, /bracket\.dxf[\s\S]*ENTITIES/);
  const c = (await call('m1', 'GET', `/ai-lab/chats/${chat.id}`)).json();
  assert.deepEqual(c.messages[0].files.map((f: any) => f.name), ['sketch.png', 'spec.pdf', 'bracket.dxf']);
  assert.equal(c.title, 'sketch.png, spec.pdf, bracket.dxf');
  const got = await call('m1', 'GET', `/ai-lab/files/${png.id}`);
  assert.equal(got.headers['content-type'], 'image/png');
  assert.equal((await call('m1', 'POST', `/ai-lab/chats/${chat.id}/messages`, { fileIds: ['nope'] })).json().error.code, 'AI_LAB_FILE_NOT_FOUND');
});
