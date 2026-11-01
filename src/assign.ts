/* "Assign Task": anyone can give a task to anyone in the organization. The
 * assigner becomes the reviewer, the task lands in the assignee's task center,
 * and an AI follow-up loop nudges the assignee (in the app, plus DingTalk work
 * notifications when enabled) and copies the assigner when things slip.
 * OKR key results added to someone else's objective become tasks the same way. */
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { Database, Queryable } from './db.js';
import type { User } from './auth.js';
import type { JsonModel } from './completions.js';
import { deny } from './errors.js';
import { applyAutoStatus } from './task-board.js';

export const assignSchema = `
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS source text;
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS assigned_by text;
CREATE TABLE IF NOT EXISTS task_nudges(
  id text PRIMARY KEY, org_id text NOT NULL, task_id text NOT NULL, user_id text NOT NULL, cc_user_id text,
  kind text NOT NULL, day text NOT NULL, message text NOT NULL, channels jsonb NOT NULL DEFAULT '[]',
  created_at timestamptz NOT NULL DEFAULT now(), read_at timestamptz, UNIQUE(task_id,kind,day));
CREATE INDEX IF NOT EXISTS task_nudges_user ON task_nudges(user_id,created_at);
CREATE INDEX IF NOT EXISTS task_nudges_cc ON task_nudges(cc_user_id,created_at);
`;

/** SQL fragment: where a task came from, who assigned it and the linked KR title. */
export const TASK_SOURCE_COLUMNS = `COALESCE(tasks.source, CASE WHEN tasks.kr_id IS NOT NULL THEN 'okr' WHEN tasks.created_by<>tasks.owner_id THEN 'direct' ELSE 'self' END) AS source_kind,
  COALESCE(tasks.assigned_by, CASE WHEN tasks.created_by<>tasks.owner_id THEN tasks.created_by END) AS assigned_by_id,
  (SELECT u.display_name FROM users u WHERE u.id=COALESCE(tasks.assigned_by, CASE WHEN tasks.created_by<>tasks.owner_id THEN tasks.created_by END)) AS assigned_by_name,
  (SELECT json_build_object('zh',u.name_zh,'en',u.name_en) FROM users u WHERE u.id=COALESCE(tasks.assigned_by, CASE WHEN tasks.created_by<>tasks.owner_id THEN tasks.created_by END)) AS assigned_by_names,
  (SELECT k.title FROM key_results k WHERE k.id=tasks.kr_id) AS kr_title,
  (SELECT p.name FROM projects p WHERE p.id=tasks.project_id) AS project_name,
  (SELECT json_build_object('objectiveTitle', o.title,
     'o', (SELECT count(*) FROM objectives o2 WHERE o2.org_id=o.org_id AND o2.archived_at IS NULL AND (o2.level='company')=(o.level='company') AND (o.level='company' OR o2.owner_id IS NOT DISTINCT FROM o.owner_id) AND COALESCE(o2.planning->>'period','')=COALESCE(o.planning->>'period','') AND (o2.created_at,o2.id)<=(o.created_at,o.id)),
     'kr', (SELECT count(*) FROM key_results k2 WHERE k2.objective_id=k.objective_id AND k2.archived_at IS NULL AND (k2.created_at,k2.id)<=(k.created_at,k.id)))
   FROM key_results k JOIN objectives o ON o.id=k.objective_id WHERE k.id=tasks.kr_id) AS okr_ref`;

export type Notifier = (userId: string, content: string) => Promise<boolean>;
export type AssignOptions = { model?: JsonModel | null; notify?: Notifier | null; intervalMs?: number; now?: () => number };

const DAY = 864e5;
const dayKey = (t: number) => new Date(t).toISOString().slice(0, 10);
const actorOf = (req: FastifyRequest): User => req.actor || deny(401, 'UNAUTHENTICATED', 'Authentication is required');

async function audit(tx: Queryable, user: Pick<User, 'id' | 'org_id' | 'department_id'>, action: string, objectId: string, details: unknown, ownerId = user.id) {
  await tx.query('INSERT INTO audit_events(id,org_id,department_id,owner_id,actor_id,action,object_id,details) VALUES($1,$2,$3,$4,$5,$6,$7,$8)',
    [randomUUID(), user.org_id, user.department_id, ownerId, user.id, action, objectId, JSON.stringify(details)]);
}

/** Creates a task for `owner` assigned by `by` (reviewer = assigner). */
export async function createAssignedTask(tx: Queryable, by: User, owner: any, t: { title: string; description: string; criteria: string[]; dueAt: string; priority?: string; krId?: string | null; source: 'direct' | 'okr' | 'project' }) {
  const id = randomUUID();
  const row = (await tx.query(`INSERT INTO tasks(id,org_id,department_id,owner_id,reviewer_id,created_by,title,description,criteria,baseline_due_at,due_at,kr_id,board_group_id,board_priority,board_category,parent_task_id,updated_by,source,assigned_by)
    VALUES($1,$2,$3,$4,$5,$5,$6,$7,$8,$9,$9,$10,'todo',$11,'',NULL,$5,$12,$5) RETURNING *`,
    [id, by.org_id, owner.department_id, owner.id, by.id, t.title, t.description, JSON.stringify(t.criteria), t.dueAt, t.krId || null, t.priority || '', t.source])).rows[0];
  await audit(tx, { id: by.id, org_id: by.org_id, department_id: owner.department_id }, 'task.assigned', id, { source: t.source, owner: owner.id }, owner.id);
  return row;
}

/** Templates used when no AI model is configured (and as the AI's fallback). */
function template(kind: string, t: any, lang: 'zh' | 'en') {
  const due = new Date(t.due_at), d = `${due.getMonth() + 1}/${due.getDate()}`;
  const by = t.assigner_name || '';
  const zh: Record<string, string> = {
    assigned: `${by} 给你下达了任务「${t.title}」，截止 ${d}。请打开任务确认要求，有疑问直接在任务里留言。`,
    no_start: `任务「${t.title}」下达已超过 24 小时还没有任何更新。请先写一条进展或计划，让 ${by} 知道你已经开始。`,
    due_3d: `任务「${t.title}」${d} 到期，还剩 3 天。目前进展如何？有阻碍请尽早在任务里说明。`,
    due_1d: `任务「${t.title}」明天（${d}）到期。请确认能否按时完成；完成时记得写清楚成果和自评。`,
    overdue: `任务「${t.title}」已逾期（截止 ${d}）。请今天更新进展或和 ${by} 商量新的完成时间。`,
    stale: `任务「${t.title}」已经 3 天没有更新了。请写一条进展：做了什么、还差什么、需要谁帮忙。`,
  };
  const en: Record<string, string> = {
    assigned: `${by} assigned you "${t.title}", due ${d}. Open it to confirm the requirements and ask questions in the task.`,
    no_start: `"${t.title}" was assigned over 24 hours ago with no update. Post a first update or plan so ${by} knows you have started.`,
    due_3d: `"${t.title}" is due ${d}, 3 days from now. How is it going? Flag blockers early.`,
    due_1d: `"${t.title}" is due tomorrow (${d}). Confirm you can finish on time and write up the result when done.`,
    overdue: `"${t.title}" is overdue (due ${d}). Please update today or agree a new date with ${by}.`,
    stale: `"${t.title}" has had no update for 3 days. Post progress: what is done, what is left, what help you need.`,
  };
  return (lang === 'en' ? en : zh)[kind] || '';
}

const NUDGE_SCHEMA = { type: 'object', additionalProperties: false, required: ['message'], properties: { message: { type: 'string' } } };

export async function registerAssignRoutes(app: FastifyInstance, db: Database, o: AssignOptions & { isAdmin: (u: User) => boolean }) {
  const now = o.now || Date.now;
  const assignInput = z.object({
    assigneeId: z.string().min(1).max(100).regex(/^[A-Za-z0-9_-]+$/), title: z.string().trim().min(3).max(200),
    dueAt: z.string().datetime({ offset: true }), description: z.string().trim().min(10).max(10000),
    criteria: z.array(z.string().trim().min(1).max(500)).min(1).max(20), priority: z.enum(['', 'urgent', 'high', 'medium', 'low']).optional(),
  }).strict();

  async function deliver(task: any, kind: string, recipient: string, cc: string | null, message: string) {
    const day = dayKey(now());
    const inserted = (await db.query(`INSERT INTO task_nudges(id,org_id,task_id,user_id,cc_user_id,kind,day,message) VALUES($1,$2,$3,$4,$5,$6,$7,$8)
      ON CONFLICT(task_id,kind,day) DO NOTHING RETURNING id`, [randomUUID(), task.org_id, task.id, recipient, cc, kind, day, message])).rows[0];
    if (!inserted) return false;
    const channels = ['app'];
    if (o.notify) { try { if (await o.notify(recipient, `【WorkOS】${message}`)) channels.push('dingtalk'); } catch { /* in-app copy still stands */ } }
    await db.query('UPDATE task_nudges SET channels=$2 WHERE id=$1', [inserted.id, JSON.stringify(channels)]);
    return true;
  }

  async function compose(kind: string, task: any) {
    const base = template(kind, task, 'zh');
    if (!o.model || kind === 'assigned') return base;
    try {
      const out = await o.model.json(
        'You are a friendly, firm project coordinator at OneLaser. Write ONE short follow-up message (max 2 sentences, Simplified Chinese) to the person who owns this task. Be specific to the task, mention the deadline, ask about blockers, never threaten, never invent facts. If the assigner should be involved, name them.',
        JSON.stringify({ kind, title: task.title, expected: String(task.description || '').slice(0, 600), dueAt: task.due_at, lastUpdate: task.last_update_at, assignedBy: task.assigner_name, ownerName: task.owner_name }),
        NUDGE_SCHEMA, 'task_nudge', 300);
      const m = typeof out?.message === 'string' ? out.message.trim().slice(0, 400) : '';
      return m || base;
    } catch { return base; }
  }

  /** One pass of the follow-up loop. Idempotent per task, kind and day. */
  async function runFollowUps() {
    const t = now();
    await applyAutoStatus(db);
    const rows = (await db.query(`SELECT t.*, o.display_name AS owner_name, a.display_name AS assigner_name,
        (SELECT max(u.created_at) FROM task_updates u WHERE u.task_id=t.id) AS last_update_at
      FROM tasks t JOIN users o ON o.id=t.owner_id AND o.active=true
      LEFT JOIN users a ON a.id=COALESCE(t.assigned_by,t.created_by)
      WHERE COALESCE(t.source, CASE WHEN t.kr_id IS NOT NULL THEN 'okr' WHEN t.created_by<>t.owner_id THEN 'direct' ELSE 'self' END) IN ('direct','okr','project')
        AND t.status<>'accepted' AND COALESCE(t.board_status,'')<>'done' LIMIT 2000`)).rows;
    let sent = 0;
    for (const task of rows) {
      const due = new Date(task.due_at).getTime(), created = new Date(task.created_at).getTime();
      const last = task.last_update_at ? new Date(task.last_update_at).getTime() : null;
      const assigner = task.assigned_by || (task.created_by !== task.owner_id ? task.created_by : null);
      const kinds: string[] = [];
      if (due < t) kinds.push('overdue');
      else if (due - t <= DAY) kinds.push('due_1d');
      else if (due - t <= 3 * DAY) kinds.push('due_3d');
      if (!last && t - created > DAY) kinds.push('no_start');
      else if (last && t - last > 3 * DAY) kinds.push('stale');
      for (const kind of kinds.slice(0, 1)) {
        if (kind === 'due_3d' && (await db.query("SELECT 1 FROM task_nudges WHERE task_id=$1 AND kind='due_3d'", [task.id])).rows.length) continue;
        if (kind === 'due_1d' && (await db.query("SELECT 1 FROM task_nudges WHERE task_id=$1 AND kind='due_1d'", [task.id])).rows.length) continue;
        if (kind === 'no_start' && (await db.query("SELECT 1 FROM task_nudges WHERE task_id=$1 AND kind='no_start'", [task.id])).rows.length) continue;
        if (kind === 'stale' && (await db.query("SELECT 1 FROM task_nudges WHERE task_id=$1 AND kind='stale' AND created_at>$2", [task.id, new Date(t - 3 * DAY).toISOString()])).rows.length) continue;
        const message = await compose(kind, task);
        // The assigner is copied when work slips (overdue or never started).
        if (await deliver(task, kind, task.owner_id, ['overdue', 'no_start'].includes(kind) ? assigner : null, message)) sent++;
      }
    }
    return { checked: rows.length, sent };
  }

  app.post('/tasks/assign', async (req, reply) => {
    const user = actorOf(req), v = assignInput.parse(req.body);
    if (v.assigneeId === user.id) deny(400, 'ASSIGN_SELF', 'Use New task for your own work');
    if (new Date(v.dueAt).getTime() < now() - 60_000) deny(400, 'DUE_IN_PAST', 'Choose a due date in the future');
    const task = await db.transaction(async tx => {
      const owner = (await tx.query('SELECT * FROM users WHERE id=$1 AND org_id=$2 AND active=true', [v.assigneeId, user.org_id])).rows[0];
      if (!owner) deny(400, 'INVALID_ASSIGNEE', 'Choose an active colleague');
      return createAssignedTask(tx, user, owner, { title: v.title, description: v.description, criteria: v.criteria, dueAt: v.dueAt, priority: v.priority, source: 'direct' });
    });
    const row = (await db.query(`SELECT tasks.*, ${TASK_SOURCE_COLUMNS} FROM tasks WHERE id=$1`, [task.id])).rows[0];
    await deliver({ ...row, assigner_name: user.display_name }, 'assigned', row.owner_id, null, template('assigned', { ...row, assigner_name: user.display_name }, 'zh')).catch(() => false);
    reply.code(201);
    return row;
  });

  /** Tasks others assigned to me, and tasks I assigned to others (with live status). */
  app.get('/tasks/assignments', async req => {
    const user = actorOf(req);
    const cols = `tasks.id,tasks.title,tasks.owner_id,tasks.reviewer_id,tasks.due_at,tasks.status,tasks.board_status,tasks.created_at,tasks.kr_id,${TASK_SOURCE_COLUMNS},
      (SELECT u.display_name FROM users u WHERE u.id=tasks.owner_id) AS owner_name,(SELECT json_build_object('zh',u.name_zh,'en',u.name_en) FROM users u WHERE u.id=tasks.owner_id) AS owner_names,(SELECT max(x.created_at) FROM task_updates x WHERE x.task_id=tasks.id) AS last_update_at,
      (SELECT json_build_object('ai_status',c.ai_status,'ai_score',c.ai_score) FROM task_completions c WHERE c.task_id=tasks.id AND c.superseded_at IS NULL ORDER BY c.created_at DESC LIMIT 1) AS completion`;
    const toMe = (await db.query(`SELECT ${cols} FROM tasks WHERE org_id=$1 AND owner_id=$2 AND COALESCE(tasks.source, CASE WHEN tasks.kr_id IS NOT NULL THEN 'okr' WHEN tasks.created_by<>tasks.owner_id THEN 'direct' ELSE 'self' END)<>'self' ORDER BY (tasks.status='accepted' OR tasks.board_status='done'),tasks.due_at LIMIT 100`, [user.org_id, user.id])).rows;
    const byMe = (await db.query(`SELECT ${cols} FROM tasks WHERE org_id=$1 AND COALESCE(tasks.assigned_by, CASE WHEN tasks.created_by<>tasks.owner_id THEN tasks.created_by END)=$2 ORDER BY (tasks.status='accepted' OR tasks.board_status='done'),tasks.due_at LIMIT 100`, [user.org_id, user.id])).rows;
    return { toMe, byMe };
  });

  app.get('/nudges', async req => {
    const user = actorOf(req);
    const rows = (await db.query(`SELECT n.*, t.title AS task_title, t.due_at, t.owner_id, (SELECT display_name FROM users WHERE id=t.owner_id) AS owner_name, (SELECT json_build_object('zh',name_zh,'en',name_en) FROM users WHERE id=t.owner_id) AS owner_names
      FROM task_nudges n LEFT JOIN tasks t ON t.id=n.task_id WHERE n.org_id=$1 AND (n.user_id=$2 OR n.cc_user_id=$2) AND n.created_at>$3 ORDER BY n.created_at DESC LIMIT 50`,
      [user.org_id, user.id, new Date(now() - 30 * DAY).toISOString()])).rows;
    return { items: rows.map((r: any) => ({ id: r.id, taskId: String(r.task_id).startsWith('okr:') ? null : r.task_id, okr: String(r.kind).startsWith('okr_'), taskTitle: r.task_title, kind: r.kind, message: r.message, createdAt: r.created_at, read: !!r.read_at || r.user_id !== user.id, role: r.user_id === user.id ? 'owner' : 'assigner', ownerId: r.owner_id, ownerName: r.owner_name, ownerNames: r.owner_names, dueAt: r.due_at, channels: r.channels })), unread: rows.filter((r: any) => r.user_id === user.id && !r.read_at).length };
  });

  app.post('/nudges/read', async req => {
    const user = actorOf(req), v = z.object({ ids: z.array(z.string().uuid()).max(100) }).strict().parse(req.body);
    await db.query('UPDATE task_nudges SET read_at=now() WHERE user_id=$1 AND id=ANY($2::text[]) AND read_at IS NULL', [user.id, v.ids]);
    return { read: v.ids.length };
  });

  app.post('/nudges/run', async req => {
    const user = actorOf(req);
    if (!o.isAdmin(user)) deny(403, 'FORBIDDEN', 'Administrator access is required');
    return runFollowUps();
  });

  if (o.intervalMs && o.intervalMs > 0) {
    const timer = setInterval(() => { runFollowUps().catch(() => undefined); }, o.intervalMs);
    timer.unref?.();
    app.addHook('onClose', async () => clearInterval(timer));
  }
  return { runFollowUps };
}
