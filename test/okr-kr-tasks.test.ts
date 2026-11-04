import test from 'node:test';
import assert from 'node:assert/strict';
import { buildApp } from '../src/app.js';
import { createDatabase, schema, seedDemo } from '../src/db.js';
import { issueSession } from '../src/auth.js';
import { krTaskDue } from '../src/okr-publish.js';
import { randomUUID } from 'node:crypto';

/* KR tasks: due on the 25th, kept in step with their KR, removed with it; project tasks take their
 * completion standard from the project. Fictional data only. */

test('KR task due date: the 25th of the OKR month; after the 25th the last day of that month; never next month', () => {
  const at = (s: string) => Date.parse(s);
  assert.equal(krTaskDue('2026-11', at('2026-11-04T08:00:00Z')).toISOString(), '2026-11-25T23:00:00.000Z');
  assert.equal(krTaskDue('2026-11', at('2026-10-28T08:00:00Z')).toISOString(), '2026-11-25T23:00:00.000Z', 'published before the month starts');
  assert.equal(krTaskDue('2026-11', at('2026-11-27T08:00:00Z')).toISOString(), '2026-11-30T23:00:00.000Z', 'after the 25th: the last day of the month');
  assert.equal(krTaskDue('2026-02', at('2026-02-26T08:00:00Z')).toISOString(), '2026-02-28T23:00:00.000Z');
  assert.equal(krTaskDue('2026-11', at('2026-12-03T08:00:00Z')).toISOString(), '2026-11-30T23:00:00.000Z', 'after the month it stays in the month and shows as overdue');
});

test('KR tasks follow their KR: one task per KR, renamed with it, gone when the KR or its objective is deleted', async () => {
  const db = await createDatabase(); await db.exec(schema); await seedDemo(db);
  await db.query("UPDATE users SET manager_id='m1' WHERE id='m2'");
  const app = await buildApp({ db, integrations: { executiveUserIds: ['m4'] }, completionModel: null, translationModel: null, mailer: null, nudgeIntervalMs: 0 });
  const tokens: Record<string, string> = {};
  const call = async (who: string, method: 'GET' | 'POST' | 'PATCH', url: string, payload?: any) => { tokens[who] ??= (await issueSession(db, who)).accessToken; return app.inject({ method, url, payload, headers: { authorization: 'Bearer ' + tokens[who] } }); };
  const period = new Date().toISOString().slice(0, 7), due = new Date(Date.now() + 20 * 864e5).toISOString().slice(0, 10);
  const tasksOf = async (krId: string) => (await db.query('SELECT * FROM tasks WHERE kr_id=$1', [krId])).rows;
  try {
    const o = (await call('m2', 'POST', '/objectives', { title: '提升示例产品页转化率', level: 'personal', planning: { period, weight: 60, scoringDueDate: due } })).json();
    const o2 = (await call('m2', 'POST', '/objectives', { title: '整理示例客户案例', level: 'personal', planning: { period, weight: 40, scoringDueDate: due } })).json();
    const kr = async (obj: string, title: string, weight: number, targetText = '完成', who = 'm2') => (await call(who, 'POST', `/objectives/${obj}/key-results`, { title, baseline: 0, target: 1, direction: 'increase', unit: '完成', planning: { weight, targetText } })).json();
    const k1 = await kr(o.id, '转化率达到 3%', 60, '3%'), k2 = await kr(o.id, '产品页视频上线', 40), k3 = await kr(o2.id, '写完 5 个客户案例', 100, '5 个');
    const pub = await call('m2', 'POST', '/okr/publish', { period }); assert.equal(pub.statusCode, 201, pub.body); assert.equal(pub.json().tasksCreated, 3);

    const [t1] = await tasksOf(k1.id);
    assert.equal(t1.source, 'okr'); assert.equal(t1.owner_id, 'm2');
    assert.equal(new Date(t1.due_at).toISOString(), krTaskDue(period).toISOString(), 'due on the 25th (or month end once the 25th has passed)');
    assert.deepEqual(t1.criteria, ['转化率达到 3% 达到目标值（3%）'], 'completion standard comes from the KR');

    // The leader renames the KR and changes its target: the same task follows, no second task.
    const meta = (await db.query('SELECT meta_version,version FROM key_results WHERE id=$1', [k1.id])).rows[0];
    const r = await call('m1', 'PATCH', `/key-results/${k1.id}`, { expectedMetaVersion: meta.meta_version, title: '转化率达到 3.5%', targetText: '3.5%' });
    assert.equal(r.statusCode, 200, r.body);
    const after = await tasksOf(k1.id);
    assert.equal(after.length, 1, 'never a duplicate');
    assert.equal(after[0].id, t1.id); assert.equal(after[0].title, '推进 KR：转化率达到 3.5%');
    assert.deepEqual(after[0].criteria, ['转化率达到 3.5% 达到目标值（3.5%）']);
    assert.ok(after[0].version > t1.version, 'the task version moves so open pages refresh');
    assert.equal(new Date(after[0].due_at).getTime(), new Date(t1.due_at).getTime(), 'the due date is left alone');

    // Renaming the objective updates the description of its KR tasks.
    const ov = (await db.query('SELECT version FROM objectives WHERE id=$1', [o.id])).rows[0].version;
    assert.equal((await call('m1', 'PATCH', `/objectives/${o.id}`, { expectedVersion: ov, title: '提升示例产品页转化率到新高' })).statusCode, 200);
    assert.match((await tasksOf(k2.id))[0].description, /目标：提升示例产品页转化率到新高/);

    // A KR with no work on its task: deleting the KR deletes the task.
    const m2v = (await db.query('SELECT meta_version FROM key_results WHERE id=$1', [k2.id])).rows[0].meta_version;
    assert.equal((await call('m1', 'POST', `/key-results/${k2.id}/archive`, { expectedMetaVersion: m2v })).statusCode, 200);
    assert.equal((await tasksOf(k2.id)).length, 0, 'task removed with its KR');
    assert.ok(!(await call('m2', 'GET', '/task-board')).json().items.some((t: any) => t.kr_id === k2.id));

    // A task the owner already worked on is kept for the record and marked abandoned.
    const [t3] = await tasksOf(k3.id);
    assert.equal((await call('m2', 'POST', `/tasks/${t3.id}/updates`, { requestId: randomUUID(), body: '已完成 2 个示例案例的初稿' })).statusCode, 201);
    const o2v = (await db.query('SELECT version FROM objectives WHERE id=$1', [o2.id])).rows[0].version;
    assert.equal((await call('m1', 'POST', `/objectives/${o2.id}/archive`, { expectedVersion: o2v })).statusCode, 200);
    const kept = await tasksOf(k3.id);
    assert.equal(kept.length, 1); assert.equal(kept[0].board_status, 'abandoned', 'history kept, task closed');

    // A KR the leader adds after publishing gets exactly one task.
    const k4 = await kr(o.id, '领导补充的示例 KR', 10, '完成', 'm1');
    assert.equal((await tasksOf(k4.id)).length, 1);
  } finally { await app.close(); }
});

test('project tasks take their completion standard from the project', async () => {
  const db = await createDatabase(); await db.exec(schema); await seedDemo(db);
  const app = await buildApp({ db, integrations: { executiveUserIds: ['m1'] }, completionModel: null, translationModel: null, mailer: null, nudgeIntervalMs: 0 });
  const tokens: Record<string, string> = {};
  const call = async (who: string, method: 'GET' | 'POST' | 'PATCH', url: string, payload?: any) => { tokens[who] ??= (await issueSession(db, who)).accessToken; return app.inject({ method, url, payload, headers: { authorization: 'Bearer ' + tokens[who] } }); };
  try {
    const proj = (await call('m2', 'POST', '/projects', { name: '示例新机型开发', description: '两周内完成可量产样机并通过跌落测试', startDate: '2026-11-01', endDate: '2026-12-20', template: 'launch', members: ['m3'] })).json();
    const t = await call('m2', 'POST', `/projects/${proj.id}/tasks`, { title: '首台样机组装', ownerId: 'm5', groupId: proj.groups[1].id, dueAt: new Date(Date.now() + 5 * 864e5).toISOString() });
    assert.equal(t.statusCode, 201, t.body);
    const row = (await db.query('SELECT criteria,source,owner_id FROM tasks WHERE id=$1', [t.json().id])).rows[0];
    assert.equal(row.source, 'project'); assert.equal(row.owner_id, 'm5');
    assert.deepEqual(row.criteria, [`完成项目「示例新机型开发」「${proj.groups[1].name}」阶段的任务：首台样机组装`, '达到要求：两周内完成可量产样机并通过跌落测试']);
    const own = await call('m2', 'POST', `/projects/${proj.id}/tasks`, { title: '电源板选型', ownerId: 'm3', groupId: proj.groups[0].id, dueAt: new Date(Date.now() + 5 * 864e5).toISOString(), description: '选出两家供应商并拿到样品' });
    assert.deepEqual((await db.query('SELECT criteria FROM tasks WHERE id=$1', [own.json().id])).rows[0].criteria[1], '达到要求：选出两家供应商并拿到样品', 'the task’s own description wins');
    // Renamed in the project: the standard follows.
    const moved = await call('m2', 'PATCH', `/projects/${proj.id}/tasks/${t.json().id}`, { expectedVersion: t.json().version, title: '首台样机组装与调试' });
    assert.equal(moved.statusCode, 200, moved.body);
    assert.match((await db.query('SELECT criteria FROM tasks WHERE id=$1', [t.json().id])).rows[0].criteria[0], /首台样机组装与调试/);
    // The assignee sees it in their own task center.
    assert.ok((await call('m5', 'GET', '/task-board')).json().items.some((x: any) => x.id === t.json().id));
  } finally { await app.close(); }
});
