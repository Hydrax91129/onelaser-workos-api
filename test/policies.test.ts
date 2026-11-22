import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createDatabase, schema, seedDemo } from '../src/db.js';
import { buildApp } from '../src/app.js';
import { issueSession } from '../src/auth.js';
import { appliesTo } from '../src/policies.js';

// 公司制度: fictional documents only.
async function setup() {
  const db = await createDatabase(); await db.exec(schema); await seedDemo(db);
  const clock = () => new Date('2026-11-20T18:00:00Z').getTime();
  const app = await buildApp({ db, integrations: { executiveUserIds: ['m1'] }, completionModel: null, translationModel: null, mailer: null, nudgeIntervalMs: 0, clock } as any);
  const tokens: Record<string, string> = {};
  const call = async (who: string, method: 'GET' | 'POST' | 'PATCH' | 'PUT', url: string, payload?: any) => { tokens[who] ??= (await issueSession(db, who)).accessToken;
    return app.inject({ method, url, payload, headers: { authorization: 'Bearer ' + tokens[who], 'accept-language': 'zh-CN' } }); };
  return { db, app, call };
}
const inboxOf = async (db: any, who: string) => (await db.query("SELECT kind,title FROM inbox_items WHERE user_id=$1 ORDER BY created_at", [who])).rows;

test('a document applies by region and department', () => {
  assert.equal(appliesTo({ region: '', department_ids: [] }, { region: '', department_id: 'x' }), true);
  assert.equal(appliesTo({ region: 'cn', department_ids: [] }, { region: 'us', department_id: 'x' }), false);
  assert.equal(appliesTo({ region: 'cn', department_ids: '["product"]' }, { region: 'cn', department_id: 'product' }), true);
  assert.equal(appliesTo({ region: '', department_ids: ['product'] }, { region: 'cn', department_id: 'marketing' }), false);
});

test('policies: editors write drafts, main admins publish, everyone it applies to signs; new versions keep history', async () => {
  const { db, call } = await setup();
  assert.equal((await call('m1', 'POST', '/policies-settings', { open: true })).statusCode, 200);
  // Nobody but main admins and granted editors writes.
  assert.equal((await call('m2', 'POST', '/policies', { category: 'handbook', titleZh: '员工手册' })).statusCode, 403);
  assert.equal((await call('m4', 'GET', '/policies-access')).statusCode, 403, 'a manager cannot set access');
  assert.equal((await call('m1', 'POST', '/policies-access', { userId: 'm4', level: 'manage' })).statusCode, 200);
  assert.equal((await call('m4', 'GET', '/me')).json().policiesManage, true);

  // m4 writes the handbook and sends it for approval; readers do not see the draft.
  const doc = (await call('m4', 'POST', '/policies', { category: 'handbook', titleZh: '示例员工手册', titleEn: 'Sample handbook', requiresAck: true,
    bodyZh: '## 考勤\n每天 9 点上班。', bodyEn: '## Attendance\nWork starts at 9.', effectiveDate: '2026-12-01' })).json();
  assert.equal((await call('m2', 'GET', '/policies')).json().docs.length, 0, 'drafts are not shown to readers');
  assert.equal((await call('m2', 'GET', `/policies/${doc.id}`)).statusCode, 404);
  assert.equal((await call('m4', 'POST', `/policies/${doc.id}/draft/publish`)).statusCode, 403, 'only main admins publish the handbook');
  assert.equal((await call('m4', 'POST', `/policies/${doc.id}/draft/submit`)).statusCode, 200);
  assert.ok((await inboxOf(db, 'm1')).some((i: any) => i.kind === 'policy_approval'), 'the approver is told');
  assert.equal((await call('m4', 'POST', `/policies/${doc.id}/draft`, { bodyZh: 'x' })).statusCode, 409, 'a pending draft is locked for its writer');

  // Send back with a reason, then fix and publish.
  assert.equal((await call('m1', 'POST', `/policies/${doc.id}/draft/reject`, {})).json().error.code, 'POLICY_REASON');
  assert.equal((await call('m1', 'POST', `/policies/${doc.id}/draft/reject`, { reason: '请补充加班规定' })).statusCode, 200);
  assert.equal((await call('m4', 'GET', '/policies')).json().docs[0].draft.state, 'rejected');
  assert.equal((await call('m4', 'POST', `/policies/${doc.id}/draft`, { bodyZh: '## 考勤\n每天 9 点上班。\n\n## 加班\n提前申请。' })).statusCode, 200);
  await call('m4', 'POST', `/policies/${doc.id}/draft/submit`);
  const pub = (await call('m1', 'POST', `/policies/${doc.id}/draft/publish`)).json();
  assert.equal(pub.signAgain, true); assert.equal(pub.asked, 5, 'everyone but the publisher is asked to sign');
  assert.ok((await inboxOf(db, 'm2')).some((i: any) => i.kind === 'policy_ack'));

  // A reader sees it, signs it; the count drops.
  assert.equal((await call('m2', 'GET', '/me')).json().policyTodo, 1);
  const read = (await call('m2', 'GET', `/policies/${doc.id}`)).json();
  assert.equal(read.myAck, 'todo'); assert.match(read.current.bodyZh, /加班/); assert.equal(read.draft, null);
  assert.equal((await call('m2', 'POST', `/policies/${doc.id}/ack`, { versionId: 'nope' })).json().error.code, 'POLICY_NEW_VERSION');
  assert.equal((await call('m2', 'POST', `/policies/${doc.id}/ack`, { versionId: read.ackVersionId })).statusCode, 200);
  assert.equal((await call('m2', 'GET', '/me')).json().policyTodo, 0);
  const acks = (await call('m4', 'GET', `/policies/${doc.id}/acks`)).json();
  assert.equal(acks.done, 1); assert.equal(acks.total, 6);
  assert.equal((await call('m2', 'GET', `/policies/${doc.id}/acks`)).statusCode, 403, 'readers do not see who signed');
  assert.equal((await call('m4', 'POST', `/policies/${doc.id}/remind`)).json().sent, 4, 'reminds the ones still missing (not the sender)');

  // A typo fix without asking to sign again keeps the signatures; a real change asks again.
  await call('m1', 'POST', `/policies/${doc.id}/draft`, { bodyZh: read.current.bodyZh + '\n（修正错字）', changeNote: '修正错字', reack: false });
  assert.equal((await call('m1', 'POST', `/policies/${doc.id}/draft/publish`)).json().signAgain, false);
  assert.equal((await call('m2', 'GET', `/policies/${doc.id}`)).json().myAck, 'done');
  await call('m1', 'POST', `/policies/${doc.id}/draft`, { bodyZh: '## 考勤\n每天 8:30 上班。', changeNote: '上班时间改为 8:30', reack: true });
  assert.equal((await call('m1', 'POST', `/policies/${doc.id}/draft/publish`)).json().signAgain, true);
  const v3 = (await call('m2', 'GET', `/policies/${doc.id}`)).json();
  assert.equal(v3.myAck, 'todo'); assert.deepEqual(v3.history.map((h: any) => [h.no, h.state]), [[3, 'published'], [2, 'superseded'], [1, 'superseded']]);
  assert.match((await call('m2', 'GET', `/policies/${doc.id}/versions/${v3.history[2].id}`)).json().bodyZh, /9 点/, 'older versions stay readable');

  // Search covers the text.
  assert.equal((await call('m2', 'GET', '/policies?q=' + encodeURIComponent('8:30'))).json().docs.length, 1);
  assert.equal((await call('m2', 'GET', '/policies?q=' + encodeURIComponent('不存在的内容'))).json().docs.length, 0);
});

test('policies: an SOP for one department reaches only that department, and that department\'s manager may publish it', async () => {
  const { db, call } = await setup();
  await call('m1', 'POST', '/policies-settings', { open: true });
  await call('m1', 'POST', '/policies-access', { userId: 'm4', level: 'manage' });
  await call('m1', 'POST', '/policies-access', { userId: 'm2', level: 'manage' });
  const sop = (await call('m4', 'POST', '/policies', { category: 'sop', titleZh: '示例盘点 SOP', departmentIds: ['product'], requiresAck: true, bodyZh: '1. 清点\n2. 复核' })).json();
  assert.equal((await call('m4', 'POST', `/policies/${sop.id}/draft/publish`)).json().asked, 2, 'm4 manages product; m5 and m6 are asked');
  assert.equal((await call('m3', 'GET', '/policies')).json().docs.length, 0, 'marketing does not see a product SOP');
  assert.equal((await call('m5', 'GET', '/policies')).json().counts.todo, 1);
  const other = (await call('m2', 'POST', '/policies', { category: 'sop', titleZh: '示例 SOP', departmentIds: ['marketing'], bodyZh: '步骤' })).json();
  assert.equal((await call('m2', 'POST', `/policies/${other.id}/draft/publish`)).statusCode, 403, 'an editor who is not the department manager sends it for approval');
  // Region: a China-only handbook is not shown to someone with a US record.
  await db.query("INSERT INTO hr_profiles(user_id,org_id,region) VALUES('m5','demo','us'),('m6','demo','cn') ON CONFLICT (user_id) DO UPDATE SET region=EXCLUDED.region");
  const cn = (await call('m1', 'POST', '/policies', { category: 'handbook', titleZh: '中国员工手册', region: 'cn', requiresAck: true, bodyZh: '内容' })).json();
  await call('m1', 'POST', `/policies/${cn.id}/draft/publish`);
  assert.equal((await call('m5', 'GET', `/policies/${cn.id}`)).statusCode, 404);
  assert.equal((await call('m6', 'GET', `/policies/${cn.id}`)).json().myAck, 'todo');
  // Archive hides it from readers; only main admins archive.
  assert.equal((await call('m4', 'POST', `/policies/${cn.id}/archive`, { archived: true })).statusCode, 403);
  await call('m1', 'POST', `/policies/${cn.id}/archive`, { archived: true });
  assert.equal((await call('m6', 'GET', `/policies/${cn.id}`)).statusCode, 404);
  // Discarding the only draft of a never-published document removes it.
  const tmp = (await call('m4', 'POST', '/policies', { category: 'culture', titleZh: '草稿' })).json();
  assert.equal((await call('m4', 'POST', `/policies/${tmp.id}/draft/discard`)).json().docDeleted, true);
  // Attachments: editors upload, readers who can see the document open them.
  const pdf = Buffer.from('%PDF-1.4 sample').toString('base64');
  const f = (await call('m4', 'POST', `/policies/${sop.id}/files`, { name: 'sop.pdf', mime: 'application/pdf', dataBase64: pdf })).json();
  assert.equal((await call('m5', 'GET', `/policies/${sop.id}/files/${f.id}`)).headers['content-type'], 'application/pdf');
  assert.equal((await call('m3', 'GET', `/policies/${sop.id}/files/${f.id}`)).statusCode, 404);
});

test('policies start closed: only main admins and editors see them until a main admin opens them; opening asks for signatures', async () => {
  const { db, call } = await setup();
  assert.equal((await call('m1', 'GET', '/me')).json().policiesAccess, true);
  assert.equal((await call('m2', 'GET', '/me')).json().policiesAccess, false);
  assert.equal((await call('m2', 'GET', '/policies')).statusCode, 404, 'closed: a plain 404 for everyone else');
  const doc = (await call('m1', 'POST', '/policies', { category: 'handbook', titleZh: '示例手册', requiresAck: true, bodyZh: '内容' })).json();
  assert.equal((await call('m1', 'POST', `/policies/${doc.id}/draft/publish`)).json().asked, 0, 'nobody else is notified while closed');
  assert.equal((await inboxOf(db, 'm2')).length, 0);
  assert.equal((await call('m1', 'GET', '/policies')).json().open, false);
  assert.equal((await call('m4', 'POST', '/policies-settings', { open: true })).statusCode, 403, 'only main admins open it');
  const opened = (await call('m1', 'POST', '/policies-settings', { open: true })).json();
  assert.equal(opened.asked, 5, 'opening asks everyone who has not signed');
  assert.equal((await call('m2', 'GET', '/me')).json().policyTodo, 1);
  assert.equal((await call('m2', 'GET', `/policies/${doc.id}`)).json().myAck, 'todo');
  await call('m1', 'POST', '/policies-settings', { open: false });
  assert.equal((await call('m2', 'GET', `/policies/${doc.id}`)).statusCode, 404, 'closing hides it again');
});
