/* Projects. A project task is an ordinary task (tasks table) tagged with
 * project_id / project_group_id and source 'project', so it automatically
 * appears in the assignee's task center, follows the completion rule and is
 * covered by the AI follow-up loop. Everyone in the organization can read
 * projects; the owner, members and admins can change them. */
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { Database, Queryable } from './db.js';
import type { User } from './auth.js';
import { deny } from './errors.js';
import { createAssignedTask, TASK_SOURCE_COLUMNS } from './assign.js';
import { applyAutoStatus } from './task-board.js';

export const projectSchema = `
CREATE TABLE IF NOT EXISTS projects(
  id text PRIMARY KEY, org_id text NOT NULL, name text NOT NULL, description text NOT NULL DEFAULT '', color text NOT NULL DEFAULT '#3370ff',
  icon text NOT NULL DEFAULT 'rocket-launch', owner_id text NOT NULL, members jsonb NOT NULL DEFAULT '[]', start_date date NOT NULL, end_date date NOT NULL,
  health text NOT NULL DEFAULT 'on_track', groups jsonb NOT NULL DEFAULT '[]', milestones jsonb NOT NULL DEFAULT '[]',
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(), archived_at timestamptz);
CREATE INDEX IF NOT EXISTS projects_org ON projects(org_id,created_at);
CREATE TABLE IF NOT EXISTS project_updates(id text PRIMARY KEY, project_id text NOT NULL, author_id text NOT NULL, health text NOT NULL, body text NOT NULL, created_at timestamptz NOT NULL DEFAULT now());
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS project_id text;
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS project_group_id text;
CREATE INDEX IF NOT EXISTS tasks_project ON tasks(project_id);
`;

const TEMPLATES: Record<string, [string, string][]> = {
  blank: [['待办', '#579bfc'], ['进行中', '#fdab3d'], ['已完成', '#00c875']],
  launch: [['设计', '#579bfc'], ['打样与测试', '#a25ddc'], ['上市准备', '#fdab3d']],
  campaign: [['策划', '#579bfc'], ['素材', '#a25ddc'], ['执行', '#00c875']],
  event: [['筹备', '#579bfc'], ['物料与运输', '#fdab3d'], ['现场与跟进', '#00c875']],
};
const STATUS_TO_BOARD: Record<string, string> = { todo: 'not_started', working: 'working', stuck: 'hold', review: 'review', done: 'done', overdue: 'overdue', abandoned: 'abandoned' };
const id = z.string().min(1).max(100).regex(/^[A-Za-z0-9_-]+$/);
const color = z.string().regex(/^#[0-9a-fA-F]{6}$/);
const date = z.string().date();
const health = z.enum(['on_track', 'at_risk', 'off_track']);

export async function registerProjectRoutes(app: FastifyInstance, db: Database, o: { isAdmin: (u: User) => boolean }) {
  const actorOf = (req: FastifyRequest): User => req.actor || deny(401, 'UNAUTHENTICATED', 'Authentication is required');
  // Only the project admin, project members and company admins can see a project. To everyone else it does not exist.
  const canView = (user: User, p: any) => p.owner_id === user.id || (p.members || []).includes(user.id) || o.isAdmin(user);
  const load = async (tx: Queryable, user: User, pid: string, lock = false, viewCheck = true) => {
    const p = (await tx.query('SELECT * FROM projects WHERE id=$1 AND org_id=$2 AND archived_at IS NULL' + (lock ? ' FOR UPDATE' : ''), [pid, user.org_id])).rows[0];
    if (!p || (viewCheck && !canView(user, p))) deny(404, 'NOT_FOUND', 'Project not found');
    return p;
  };
  const canEdit = canView;
  const requireEdit = (user: User, p: any) => { if (!canEdit(user, p)) deny(403, 'FORBIDDEN', 'Only project members can change this project'); };
  const projectTasks = async (pids: string[]) => pids.length ? (await db.query(`SELECT tasks.id,tasks.title,tasks.description,tasks.owner_id,tasks.reviewer_id,tasks.due_at,tasks.created_at,tasks.board_status,tasks.board_priority,tasks.status,tasks.version,tasks.project_id,tasks.project_group_id,
      (SELECT count(*)::int FROM task_updates u WHERE u.task_id=tasks.id) AS update_count,(SELECT max(u.created_at) FROM task_updates u WHERE u.task_id=tasks.id) AS last_update_at,tasks.updated_at,(SELECT json_build_object('ai_status',c.ai_status,'ai_score',c.ai_score,'human_score',c.human_score,'final_score',COALESCE(c.human_score,CASE WHEN c.ai_status='scored' THEN c.ai_score END),'score_source',CASE WHEN c.human_score IS NOT NULL THEN 'human' WHEN c.ai_status='scored' THEN 'ai' END,'score_due_at',c.created_at+interval '24 hours') FROM task_completions c WHERE c.task_id=tasks.id AND c.superseded_at IS NULL ORDER BY c.created_at DESC LIMIT 1) AS completion,${TASK_SOURCE_COLUMNS}
      FROM tasks WHERE project_id=ANY($1::text[]) AND tasks.archived_at IS NULL ORDER BY tasks.due_at,tasks.id`, [pids])).rows : [];
  const updatesOf = async (pids: string[]) => pids.length ? (await db.query('SELECT * FROM project_updates WHERE project_id=ANY($1::text[]) ORDER BY created_at DESC LIMIT 500', [pids])).rows : [];
  // Project admin (owner_id, the creator by default) and company admins manage members and the admin role.
  const canManage = (user: User, p: any) => p.owner_id === user.id || o.isAdmin(user);
  const shape = (p: any, tasks: any[], updates: any[], user: User) => ({ ...p, canEdit: canEdit(user, p), canManage: canManage(user, p), tasks: tasks.filter(t => t.project_id === p.id), updates: updates.filter(u => u.project_id === p.id).slice(0, 30) });

  app.get('/projects', async req => {
    const user = actorOf(req); await applyAutoStatus(db, user.org_id);
    const rows = (await db.query('SELECT * FROM projects WHERE org_id=$1 AND archived_at IS NULL ORDER BY created_at DESC', [user.org_id])).rows.filter((p: any) => canView(user, p)).slice(0, 200);
    const ids = rows.map((p: any) => p.id), tasks = await projectTasks(ids), updates = await updatesOf(ids);
    return { items: rows.map((p: any) => shape(p, tasks, updates, user)) };
  });

  const projectInput = z.object({
    name: z.string().trim().min(2).max(120), description: z.string().trim().max(4000).optional(), color: color.optional(), icon: z.string().regex(/^[a-z-]{2,40}$/).optional(),
    startDate: date, endDate: date, members: z.array(id).max(100).optional(), ownerId: id.optional(), template: z.enum(['blank', 'launch', 'campaign', 'event']).optional(),
  }).strict();
  app.post('/projects', async (req, reply) => {
    const user = actorOf(req), v = projectInput.parse(req.body);
    if (v.endDate < v.startDate) deny(400, 'INVALID_DATES', 'The end date must be after the start date');
    const ownerId = v.ownerId || user.id;
    const members = [...new Set([user.id, ownerId, ...(v.members || [])])];
    const valid = (await db.query('SELECT id FROM users WHERE org_id=$1 AND active=true AND id=ANY($2::text[])', [user.org_id, members])).rows.map((r: any) => r.id);
    if (!valid.includes(ownerId)) deny(400, 'INVALID_PROJECT_ADMIN', 'The project admin must be an active member of the company');
    const groups = (TEMPLATES[v.template || 'blank']).map(([name, c]) => ({ id: randomUUID().slice(0, 8), name, color: c }));
    const p = (await db.query(`INSERT INTO projects(id,org_id,name,description,color,icon,owner_id,members,start_date,end_date,groups) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *`,
      [randomUUID(), user.org_id, v.name, v.description || '', v.color || '#3370ff', v.icon || 'rocket-launch', ownerId, JSON.stringify(valid), v.startDate, v.endDate, JSON.stringify(groups)])).rows[0];
    reply.code(201);
    return shape(p, [], [], user);
  });

  const patchInput = z.object({
    name: z.string().trim().min(2).max(120).optional(), description: z.string().trim().max(4000).optional(), color: color.optional(), startDate: date.optional(), endDate: date.optional(),
    health: health.optional(), members: z.array(id).max(100).optional(), ownerId: id.optional(),
    groups: z.array(z.object({ id: z.string().min(1).max(40), name: z.string().trim().min(1).max(80), color }).strict()).min(1).max(30).optional(),
    milestones: z.array(z.object({ id: z.string().min(1).max(40), name: z.string().trim().min(1).max(120), date, done: z.boolean() }).strict()).max(50).optional(),
  }).strict();
  app.patch<{ Params: { id: string } }>('/projects/:id', async req => {
    const user = actorOf(req), v = patchInput.parse(req.body), pid = id.parse(req.params.id);
    const row = await db.transaction(async tx => {
      const p = await load(tx, user, pid, true); requireEdit(user, p);
      if ((v.members || v.ownerId) && !canManage(user, p)) deny(403, 'PROJECT_ADMIN_ONLY', 'Only the project admin can change members or the project admin');
      const ownerId = v.ownerId || p.owner_id;
      let members = p.members;
      if (v.members || v.ownerId) members = (await tx.query('SELECT id FROM users WHERE org_id=$1 AND active=true AND id=ANY($2::text[])', [user.org_id, [...new Set([ownerId, ...(v.members || p.members)])]])).rows.map((r: any) => r.id);
      if (!members.includes(ownerId)) deny(400, 'INVALID_PROJECT_ADMIN', 'The project admin must be an active member of the company');
      const updated = (await tx.query(`UPDATE projects SET name=$2,description=$3,color=$4,start_date=$5,end_date=$6,health=$7,members=$8,groups=$9,milestones=$10,owner_id=$11,updated_at=now() WHERE id=$1 RETURNING *`,
        [p.id, v.name ?? p.name, v.description ?? p.description, v.color ?? p.color, v.startDate ?? p.start_date, v.endDate ?? p.end_date, v.health ?? p.health, JSON.stringify(members), JSON.stringify(v.groups ?? p.groups), JSON.stringify(v.milestones ?? p.milestones), ownerId])).rows[0];
      return updated;
    });
    return shape(row, await projectTasks([pid]), await updatesOf([pid]), user);
  });

  app.post<{ Params: { id: string } }>('/projects/:id/updates', async (req, reply) => {
    const user = actorOf(req), v = z.object({ health, body: z.string().trim().min(2).max(4000) }).strict().parse(req.body), pid = id.parse(req.params.id);
    const p = await load(db, user, pid); requireEdit(user, p);
    await db.query('INSERT INTO project_updates(id,project_id,author_id,health,body) VALUES($1,$2,$3,$4,$5)', [randomUUID(), p.id, user.id, v.health, v.body]);
    await db.query('UPDATE projects SET health=$2,updated_at=now() WHERE id=$1', [p.id, v.health]);
    reply.code(201);
    return { ok: true };
  });

  const taskInput = z.object({
    title: z.string().trim().min(2).max(200), ownerId: id, groupId: z.string().min(1).max(40), dueAt: z.string().datetime({ offset: true }),
    description: z.string().trim().max(10000).optional(), priority: z.enum(['', 'urgent', 'high', 'medium', 'low']).optional(),
  }).strict();
  app.post<{ Params: { id: string } }>('/projects/:id/tasks', async (req, reply) => {
    const user = actorOf(req), v = taskInput.parse(req.body), pid = id.parse(req.params.id);
    const task = await db.transaction(async tx => {
      const p = await load(tx, user, pid, true); requireEdit(user, p);
      if (!(p.groups || []).some((g: any) => g.id === v.groupId)) deny(400, 'INVALID_GROUP', 'Choose a stage of this project');
      const owner = (await tx.query('SELECT * FROM users WHERE id=$1 AND org_id=$2 AND active=true', [v.ownerId, user.org_id])).rows[0];
      if (!owner) deny(400, 'INVALID_OWNER', 'Choose an active colleague');
      // Reviewer: the project owner, else whoever created the task, else the assignee's manager.
      const reviewerId = [p.owner_id, user.id, owner.manager_id].find(x => x && x !== owner.id) || owner.id;
      const reviewer = reviewerId === user.id ? user : (await tx.query('SELECT * FROM users WHERE id=$1', [reviewerId])).rows[0];
      const row = await createAssignedTask(tx, reviewer, owner, { title: v.title, description: v.description || `项目「${p.name}」的任务`, criteria: ['按项目要求完成'], dueAt: v.dueAt, priority: v.priority, source: 'project' });
      await tx.query('UPDATE tasks SET project_id=$2,project_group_id=$3,created_by=$4,updated_by=$4 WHERE id=$1', [row.id, p.id, v.groupId, user.id]);
      if (!(p.members || []).includes(owner.id)) await tx.query('UPDATE projects SET members=$2,updated_at=now() WHERE id=$1', [p.id, JSON.stringify([...(p.members || []), owner.id])]);
      return row;
    });
    reply.code(201);
    return (await projectTasks([pid])).find((t: any) => t.id === task.id);
  });

  const taskPatch = z.object({
    expectedVersion: z.number().int().positive(), status: z.enum(['todo', 'working', 'stuck', 'review', 'done', 'overdue', 'abandoned']).optional(), priority: z.enum(['', 'urgent', 'high', 'medium', 'low']).optional(),
    ownerId: id.optional(), groupId: z.string().min(1).max(40).optional(), dueAt: z.string().datetime({ offset: true }).optional(), title: z.string().trim().min(2).max(200).optional(),
  }).strict();
  app.patch<{ Params: { id: string; taskId: string } }>('/projects/:id/tasks/:taskId', async req => {
    const user = actorOf(req), v = taskPatch.parse(req.body), pid = id.parse(req.params.id), tid = z.string().min(1).max(100).parse(req.params.taskId);
    await db.transaction(async tx => {
      const p = await load(tx, user, pid, false, false);
      const t = (await tx.query('SELECT * FROM tasks WHERE id=$1 AND project_id=$2 AND archived_at IS NULL FOR UPDATE', [tid, p.id])).rows[0];
      // A task owner who was later removed from the project can still update their own task, nothing else.
      if (!t || (!canView(user, p) && t.owner_id !== user.id)) deny(404, 'NOT_FOUND', 'Task not found');
      if (!canEdit(user, p) && t.owner_id !== user.id) deny(403, 'FORBIDDEN', 'Only project members can change this task');
      if (t.version !== v.expectedVersion) deny(409, 'VERSION_CONFLICT', 'Task changed; reload before saving');
      if (v.status === 'done' && t.board_status !== 'done') deny(409, 'COMPLETION_RESULT_REQUIRED', 'Write the result and self-evaluation in the task center to complete this task');
      if (v.groupId && !(p.groups || []).some((g: any) => g.id === v.groupId)) deny(400, 'INVALID_GROUP', 'Choose a stage of this project');
      let owner = t.owner_id, department = t.department_id;
      if (v.ownerId && v.ownerId !== t.owner_id) {
        if (t.submission_version > 0) deny(409, 'TASK_REASSIGNMENT_LOCKED', 'Tasks with submitted evidence keep their original owner');
        const u = (await tx.query('SELECT * FROM users WHERE id=$1 AND org_id=$2 AND active=true', [v.ownerId, user.org_id])).rows[0];
        if (!u) deny(400, 'INVALID_OWNER', 'Choose an active colleague');
        owner = u.id; department = u.department_id;
      }
      await tx.query(`UPDATE tasks SET board_status=$2,board_priority=$3,owner_id=$4,department_id=$5,project_group_id=$6,due_at=$7,title=$8,reviewer_id=CASE WHEN reviewer_id=$4 THEN $9 ELSE reviewer_id END,version=version+1,updated_at=now(),updated_by=$9 WHERE id=$1`,
        [t.id, v.status ? STATUS_TO_BOARD[v.status] : t.board_status, v.priority ?? t.board_priority, owner, department, v.groupId ?? t.project_group_id, v.dueAt ?? t.due_at, v.title ?? t.title, user.id]);
    });
    return (await projectTasks([pid])).find((t: any) => t.id === tid);
  });

  app.delete<{ Params: { id: string } }>('/projects/:id', async req => {
    const user = actorOf(req), pid = id.parse(req.params.id);
    const p = await load(db, user, pid);
    if (p.owner_id !== user.id && !o.isAdmin(user)) deny(403, 'FORBIDDEN', 'Only the project owner can archive it');
    await db.query('UPDATE projects SET archived_at=now() WHERE id=$1', [p.id]);
    return { archived: true };
  });
}
