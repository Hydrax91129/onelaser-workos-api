/* OKR final publish ("最终发布").
 * After writing a monthly OKR the owner presses Publish. Publishing requires the
 * objectives to total exactly 100 points and the key results under each objective
 * to total exactly 100%. Once published, the owner can no longer change the OKR's
 * definition (objectives, key results, points, weights, target values); only the
 * owner's leader (direct manager, a manager of the department, or an admin) can,
 * during the month. Progress updates, KR status, measurements and scores stay open.
 * Key results become tasks in the owner's task center when the OKR is published;
 * key results a leader adds afterwards become tasks immediately. */
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { Database, Queryable } from './db.js';
import type { User } from './auth.js';
import { deny } from './errors.js';
import { createAssignedTask } from './assign.js';
import { canLeadScore } from './okr-scores.js';

export const okrPublishSchema = `
CREATE TABLE IF NOT EXISTS okr_publications(
  org_id text NOT NULL, owner_id text NOT NULL, period text NOT NULL, published_at timestamptz NOT NULL DEFAULT now(), published_by text NOT NULL,
  PRIMARY KEY(org_id, owner_id, period));
`;

const EPS = 0.001;
const num = (v: unknown) => { const n = Number(v); return Number.isFinite(n) && n > 0 ? n : 0; };
const periodOf = (o: any) => (o?.planning && /^\d{4}-\d{2}$/.test(o.planning.period || '')) ? o.planning.period : '';

export async function isPublished(db: Queryable, orgId: string, ownerId: string | null, period: string) {
  if (!ownerId || !period) return false;
  return !!(await db.query('SELECT 1 FROM okr_publications WHERE org_id=$1 AND owner_id=$2 AND period=$3', [orgId, ownerId, period])).rows[0];
}

/** Due date of a KR task: the 25th of the OKR's month. Published after the 25th, it is due on the last day of
 * that month instead; past that day the task is simply overdue (延期). It never rolls into the next month. */
export function krTaskDue(period: string, now = Date.now()) {
  const m = /^(\d{4})-(\d{2})$/.exec(period || '');
  if (!m) return new Date(now + 30 * 864e5);
  const on25 = new Date(Date.UTC(+m[1], +m[2] - 1, 25, 23, 0));
  return on25.getTime() >= now ? on25 : new Date(Date.UTC(+m[1], +m[2], 0, 23, 0));
}
/** Name, description and completion standard of a KR task, all taken from the KR itself. */
export function krTaskFields(objective: any, kr: any) {
  const target = kr.planning?.targetText || `${kr.target ?? ''} ${kr.unit ?? ''}`.trim();
  const detail = String(kr.planning?.description || '').trim();
  return {
    title: ('推进 KR：' + kr.title).slice(0, 200),
    description: `目标：${objective.title}\n关键结果：${kr.title}（目标值 ${target}）${detail && detail !== String(kr.title).trim() ? `\n说明：${detail}` : ''}\n请在周期内推进这条关键结果，并定期更新进展。`,
    criteria: [`${kr.title} 达到目标值（${target}）`.slice(0, 500)],
  };
}
/** A KR's name, target or description changed: its OKR task follows (no new task, no duplicate). */
export async function syncKrTasks(tx: Queryable, actor: User, krIds: string[]) {
  if (!krIds.length) return 0;
  const krs = (await tx.query('SELECT k.*,o.title AS objective_title FROM key_results k JOIN objectives o ON o.id=k.objective_id WHERE k.id=ANY($1::text[]) AND k.archived_at IS NULL', [krIds])).rows;
  let changed = 0;
  for (const kr of krs) {
    const f = krTaskFields({ title: kr.objective_title }, kr);
    const r = await tx.query(`UPDATE tasks SET title=$2,description=$3,criteria=$4,version=version+1,updated_at=now(),updated_by=$5
      WHERE kr_id=$1 AND source='okr' AND (title<>$2 OR description<>$3 OR criteria<>$4::jsonb) RETURNING id`, [kr.id, f.title, f.description, JSON.stringify(f.criteria), actor.id]);
    changed += r.rows.length;
  }
  return changed;
}
/** A KR (or its objective) was deleted: its OKR task goes too. A task that already has work on it (progress
 * updates, deliverables, scores, files or sub-tasks) is kept for the record and marked abandoned instead. */
export async function retireKrTasks(tx: Queryable, actor: User, krIds: string[]) {
  if (!krIds.length) return { deleted: 0, abandoned: 0 };
  const tasks = (await tx.query("SELECT id FROM tasks WHERE kr_id=ANY($1::text[]) AND source='okr'", [krIds])).rows;
  let deleted = 0, abandoned = 0;
  for (const t of tasks) {
    const used = (await tx.query(`SELECT EXISTS(SELECT 1 FROM submissions WHERE task_id=$1) OR EXISTS(SELECT 1 FROM task_updates WHERE task_id=$1)
      OR EXISTS(SELECT 1 FROM task_completions WHERE task_id=$1) OR EXISTS(SELECT 1 FROM task_attachments WHERE task_id=$1)
      OR EXISTS(SELECT 1 FROM tasks WHERE parent_task_id=$1) AS used`, [t.id])).rows[0]?.used;
    if (!used) {
      await tx.query('DELETE FROM task_nudges WHERE task_id=$1', [t.id]);
      await tx.query('DELETE FROM inbox_items WHERE task_id=$1', [t.id]);
      await tx.query('DELETE FROM tasks WHERE id=$1', [t.id]);
      deleted++;
    } else {
      await tx.query("UPDATE tasks SET board_status='abandoned',version=version+1,updated_at=now(),updated_by=$2 WHERE id=$1 AND board_status<>'done'", [t.id, actor.id]);
      abandoned++;
    }
  }
  return { deleted, abandoned };
}

/** Turns a key result into a task for the objective owner (source: OKR), unless it already has one. */
export async function createKrTask(tx: Queryable, creator: User, objective: any, kr: any) {
  if (!objective.owner_id) return null;
  if ((await tx.query('SELECT 1 FROM tasks WHERE kr_id=$1 AND owner_id=$2 LIMIT 1', [kr.id, objective.owner_id])).rows[0]) return null;
  const owner = (await tx.query('SELECT * FROM users WHERE id=$1 AND active=true', [objective.owner_id])).rows[0];
  if (!owner) return null;
  const deptManager = (await tx.query("SELECT id FROM users WHERE org_id=$1 AND department_id=$2 AND role='manager' AND active=true AND id<>$3 ORDER BY id LIMIT 1", [owner.org_id, owner.department_id, owner.id])).rows[0]?.id;
  const reviewerId = [creator.id !== owner.id ? creator.id : null, owner.manager_id, deptManager].find(x => x && x !== owner.id) || owner.id;
  const by = reviewerId === creator.id ? creator : (await tx.query('SELECT * FROM users WHERE id=$1', [reviewerId])).rows[0];
  const due = krTaskDue(periodOf(objective));
  const created = await createAssignedTask(tx, by, owner, { ...krTaskFields(objective, kr), dueAt: due.toISOString(), krId: kr.id, source: 'okr' });
  await tx.query('UPDATE tasks SET created_by=$2,updated_by=$2 WHERE id=$1', [created.id, creator.id]);
  return created;
}

/** Problems that keep an owner's OKR for a period from being published. */
async function readiness(db: Queryable, orgId: string, ownerId: string, period: string, withCompany = false) {
  // For the top leader (an administrator without a manager) the company objectives are their own OKR.
  const objectives = (await db.query(`SELECT * FROM objectives WHERE org_id=$1 AND archived_at IS NULL AND planning->>'period'=$3 AND ${withCompany ? "(level='company' OR (owner_id=$2 AND level<>'company'))" : "owner_id=$2 AND level<>'company'"}`, [orgId, ownerId, period])).rows;
  const problems: { zh: string; en: string }[] = [];
  if (!objectives.length) problems.push({ zh: '还没有目标', en: 'No objectives yet' });
  const points = objectives.reduce((s: number, o: any) => s + num(o.planning?.weight), 0);
  if (objectives.length && Math.abs(points - 100) > EPS) problems.push({ zh: `目标分值合计 ${Math.round(points * 100) / 100} 分，必须正好 100 分`, en: `Objectives total ${Math.round(points * 100) / 100} points; they must total exactly 100` });
  const krs = objectives.length ? (await db.query('SELECT * FROM key_results WHERE objective_id=ANY($1::text[]) AND archived_at IS NULL', [objectives.map((o: any) => o.id)])).rows : [];
  objectives.forEach((o: any, i: number) => {
    const ks = krs.filter((k: any) => k.objective_id === o.id); if (!ks.length) return;
    const sum = ks.reduce((s: number, k: any) => s + num(k.planning?.weight), 0), unset = ks.filter((k: any) => !num(k.planning?.weight)).length;
    if (unset || Math.abs(sum - 100) > EPS) problems.push({ zh: `“${o.title}”的 KR 权重合计 ${Math.round(sum * 100) / 100}%${unset ? `（${unset} 条未填）` : ''}，必须正好 100%`, en: `KR weights under “${o.title}” total ${Math.round(sum * 100) / 100}%${unset ? ` (${unset} without a weight)` : ''}; they must total exactly 100%` });
  });
  return { objectives, krs, problems };
}

export async function registerOkrPublish(app: FastifyInstance, db: Database, o: { isAdmin: (u: User) => boolean }) {
  const actorOf = (req: FastifyRequest): User => req.actor || deny(401, 'UNAUTHENTICATED', 'Authentication is required');
  const periodInput = z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/);

  app.get<{ Querystring: { period?: string } }>('/okr/publications', async req => {
    const user = actorOf(req), period = periodInput.optional().parse(req.query.period);
    const rows = (await db.query(`SELECT p.owner_id,p.period,p.published_at,p.published_by,u.display_name AS published_by_name FROM okr_publications p LEFT JOIN users u ON u.id=p.published_by
      WHERE p.org_id=$1 ${period ? 'AND p.period=$2' : ''} ORDER BY p.published_at DESC LIMIT 2000`, period ? [user.org_id, period] : [user.org_id])).rows;
    return { items: rows.map((r: any) => ({ ownerId: r.owner_id, period: r.period, publishedAt: r.published_at, publishedBy: r.published_by, publishedByName: r.published_by_name })) };
  });

  app.post('/okr/publish', async (req, reply) => {
    const user = actorOf(req), v = z.object({ period: periodInput }).strict().parse(req.body);
    return db.transaction(async tx => {
      if (await isPublished(tx, user.org_id, user.id, v.period)) deny(409, 'OKR_ALREADY_PUBLISHED', 'This OKR is already published', '这个月的 OKR 已经发布过了。');
      const top = o.isAdmin(user) && !(await tx.query('SELECT manager_id FROM users WHERE id=$1', [user.id])).rows[0]?.manager_id;
      const r = await readiness(tx, user.org_id, user.id, v.period, top && !!(await tx.query("SELECT 1 FROM objectives WHERE org_id=$1 AND level='company' AND archived_at IS NULL AND planning->>'period'=$2 LIMIT 1", [user.org_id, v.period])).rows[0]);
      if (r.problems.length) deny(400, 'OKR_NOT_READY', 'Fix these before publishing: ' + r.problems.map(p => p.en).join('; '), '发布前请先完成：' + r.problems.map(p => p.zh).join('；') + '。');
      await tx.query('INSERT INTO okr_publications(org_id,owner_id,period,published_by) VALUES($1,$2,$3,$4)', [user.org_id, user.id, v.period, user.id]);
      let tasks = 0;
      for (const k of r.krs) if (await createKrTask(tx, user, r.objectives.find((x: any) => x.id === k.objective_id), k)) tasks++;
      await tx.query('INSERT INTO audit_events(id,org_id,department_id,owner_id,actor_id,action,object_id,details) VALUES($1,$2,$3,$4,$5,$6,$7,$8)',
        [randomUUID(), user.org_id, user.department_id, user.id, user.id, 'okr.published', `${user.id}:${v.period}`, JSON.stringify({ period: v.period, objectives: r.objectives.length, krs: r.krs.length, tasks })]);
      reply.code(201);
      return { ownerId: user.id, period: v.period, published: true, tasksCreated: tasks };
    });
  });

  /* Lock: after publishing, only the owner's leader may change the OKR's definition. */
  const lockedTarget = async (req: FastifyRequest): Promise<any | null> => {
    const route = `${req.method} ${req.routeOptions?.url || ''}`, body: any = req.body || {}, params: any = req.params || {};
    if (route === 'POST /objectives') {
      const user = req.actor!; return { org_id: user.org_id, owner_id: body.ownerId || user.id, level: body.level, department_id: user.department_id, planning: body.planning || {} };
    }
    if (['PATCH /objectives/:id', 'POST /objectives/:id/archive', 'POST /objectives/:id/key-results'].includes(route))
      return (await db.query('SELECT * FROM objectives WHERE id=$1', [String(params.id || '')])).rows[0] || null;
    const definition = ['title', 'weight', 'description', 'targetText', 'metric'].some(k => body[k] !== undefined);
    if ((route === 'PATCH /key-results/:id' && definition) || route === 'POST /key-results/:id/archive')
      return (await db.query('SELECT o.* FROM key_results k JOIN objectives o ON o.id=k.objective_id WHERE k.id=$1', [String(params.id || '')])).rows[0] || null;
    return null;
  };
  app.addHook('preHandler', async req => {
    if (!req.actor || !['POST', 'PATCH'].includes(req.method)) return;
    const target = await lockedTarget(req);
    if (!target || target.level === 'company' || target.org_id !== req.actor.org_id) return;
    if (!(await isPublished(db, target.org_id, target.owner_id, periodOf(target)))) return;
    if (await canLeadScore(db, req.actor, target, o.isAdmin)) { (req as any).okrLeaderEdit = target; return; }
    deny(403, 'OKR_PUBLISHED_LOCKED', 'This OKR has been published; only your leader can change it now', '这个月的 OKR 已经最终发布，不能再修改；如需调整，请联系你的领导修改。');
  });
  /* A leader's change to a published OKR is recorded and the owner is told. */
  app.addHook('onResponse', async (req, reply) => {
    const t = (req as any).okrLeaderEdit;
    if (!t || reply.statusCode >= 300 || !t.owner_id || t.owner_id === req.actor?.id) return;
    const p = periodOf(t), label = `${Number(p.slice(5))}月`, day = new Date().toISOString().slice(0, 10);
    try {
      await db.query(`INSERT INTO task_nudges(id,org_id,task_id,user_id,kind,day,message,channels) VALUES($1,$2,$3,$4,'okr_changed',$5,$6,'["app"]') ON CONFLICT(task_id,kind,day) DO NOTHING`,
        [randomUUID(), t.org_id, `okr:${p}:changed:${t.owner_id}`, t.owner_id, day, `${req.actor!.display_name} 调整了你已发布的${label} OKR，请打开 OKR 查看最新内容。`]);
      await db.query('INSERT INTO audit_events(id,org_id,department_id,owner_id,actor_id,action,object_id,details) VALUES($1,$2,$3,$4,$5,$6,$7,$8)',
        [randomUUID(), t.org_id, t.department_id || req.actor!.department_id, t.owner_id, req.actor!.id, 'okr.leader_changed', t.id || `${t.owner_id}:${p}`, JSON.stringify({ route: req.routeOptions?.url, method: req.method })]);
    } catch { /* the change itself already succeeded */ }
  });
}
