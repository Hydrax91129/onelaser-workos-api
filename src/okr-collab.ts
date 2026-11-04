/* OKR collaboration: edit / archive objectives and key results, align an
 * objective to a parent objective, KR status (confidence) and a progress
 * update timeline. Scoring rules (self + manager, 0-100) are unchanged.
 *
 * Versioning:
 * - objectives.version guards objective edits.
 * - key_results.version stays the *metric* version that appraisals bind to;
 *   only metric changes (baseline/target/direction/unit) bump it, which
 *   intentionally invalidates the current manager confirmation.
 * - key_results.meta_version guards text, weight and status edits so those
 *   never invalidate an existing appraisal.
 */
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { Database, Queryable } from './db.js';
import type { User } from './auth.js';
import { assertKrWeight, assertObjectivePoints, rebalanceKrs, rebalanceObjectives } from './okr-weights.js';
import { deny } from './errors.js';
import { visibleObjective, krProgress, hasKrMetric } from './domain.js';

export const okrCollabSchema = `
ALTER TABLE objectives ADD COLUMN IF NOT EXISTS version integer NOT NULL DEFAULT 1;
ALTER TABLE objectives ADD COLUMN IF NOT EXISTS parent_objective_id text REFERENCES objectives(id);
ALTER TABLE objectives ADD COLUMN IF NOT EXISTS archived_at timestamptz;
ALTER TABLE objectives ADD COLUMN IF NOT EXISTS updated_at timestamptz;
ALTER TABLE key_results ADD COLUMN IF NOT EXISTS meta_version integer NOT NULL DEFAULT 1;
ALTER TABLE key_results ADD COLUMN IF NOT EXISTS confidence text;
ALTER TABLE key_results ADD COLUMN IF NOT EXISTS archived_at timestamptz;
ALTER TABLE key_results ADD COLUMN IF NOT EXISTS updated_at timestamptz;
CREATE INDEX IF NOT EXISTS objectives_parent ON objectives(parent_objective_id);
-- Creation time keeps objectives and key results in the order they were written (ids are random).
ALTER TABLE objectives ADD COLUMN IF NOT EXISTS created_at timestamptz;
ALTER TABLE key_results ADD COLUMN IF NOT EXISTS created_at timestamptz;
UPDATE objectives SET created_at=COALESCE((SELECT min(a.created_at) FROM audit_events a WHERE a.object_id=objectives.id AND a.action='objective.created'),updated_at,now()) WHERE created_at IS NULL;
UPDATE key_results SET created_at=COALESCE((SELECT min(a.created_at) FROM audit_events a WHERE a.object_id=key_results.id AND a.action='kr.created'),updated_at,now()) WHERE created_at IS NULL;
ALTER TABLE objectives ALTER COLUMN created_at SET DEFAULT now();
ALTER TABLE key_results ALTER COLUMN created_at SET DEFAULT now();
CREATE TABLE IF NOT EXISTS okr_updates(
 id text PRIMARY KEY, org_id text NOT NULL, objective_id text NOT NULL REFERENCES objectives(id),
 kr_id text REFERENCES key_results(id), author_id text NOT NULL REFERENCES users(id),
 body text NOT NULL, confidence text, progress double precision, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS okr_updates_objective ON okr_updates(objective_id,created_at,id);
`;

export const CONFIDENCE = ['on_track','at_risk','off_track'] as const;
const id = z.string().min(1).max(100).regex(/^[A-Za-z0-9_-]+$/);
const weight = z.number().finite().positive().max(100);
const confidence = z.enum(CONFIDENCE);
const objectivePatch = z.object({
  expectedVersion: z.number().int().positive(),
  title: z.string().trim().min(1).max(300).optional(),
  weight: weight.optional(),
  description: z.string().trim().max(4000).optional(),
  parentObjectiveId: id.nullable().optional(),
  rebalance: z.boolean().optional()
}).strict().refine(v => Object.keys(v).length > 1, 'Nothing to change');
const krPatch = z.object({
  expectedMetaVersion: z.number().int().positive(),
  title: z.string().trim().min(1).max(300).optional(),
  weight: weight.optional(),
  description: z.string().trim().max(4000).optional(),
  targetText: z.string().trim().max(120).optional(),
  rebalance: z.boolean().optional(),
  confidence: confidence.nullable().optional(),
  metric: z.object({
    expectedVersion: z.number().int().positive(),
    baseline: z.number().finite(), target: z.number().finite(),
    direction: z.enum(['increase','decrease']), unit: z.string().trim().min(1).max(30)
  }).strict().optional()
}).strict().refine(v => Object.keys(v).length > 1, 'Nothing to change');
const archiveInput = z.object({ expectedVersion: z.number().int().positive() }).strict();
const updateInput = z.object({
  body: z.string().trim().min(2).max(4000),
  krId: id.optional(),
  confidence: confidence.optional()
}).strict();

const actor = (req: FastifyRequest): User => req.actor || deny(401,'UNAUTHENTICATED','Authentication is required');

/** Same rule as creating a KR: managers edit their department's objectives; employees edit their own personal ones. */
let isAdminCheck: (u: User) => boolean = u => (u as any).is_admin === true;
export function canEditObjective(user: User, o: any) {
  if (!o || o.org_id !== user.org_id) return false;
  // The company OKR is the top leader's own OKR: its owner and company administrators edit it.
  if (o.level === 'company') return o.owner_id === user.id || isAdminCheck(user);
  if (o.department_id !== user.department_id) return false;
  return user.role === 'manager' || (o.level === 'personal' && o.owner_id === user.id);
}

async function loadObjective(tx: Queryable, user: User, objectiveId: string, lock = false) {
  const o = (await tx.query(`SELECT * FROM objectives WHERE id=$1${lock ? ' FOR UPDATE' : ''}`, [objectiveId])).rows[0];
  if (!o || o.archived_at || !visibleObjective(user, o)) deny(404,'NOT_FOUND','Objective not found');
  return o;
}
async function loadKr(tx: Queryable, user: User, krId: string, lock = false) {
  const kr = (await tx.query(`SELECT k.*,o.org_id,o.department_id,o.owner_id,o.level,o.archived_at AS objective_archived_at FROM key_results k JOIN objectives o ON o.id=k.objective_id WHERE k.id=$1${lock ? ' FOR UPDATE OF k' : ''}`, [krId])).rows[0];
  if (!kr || kr.archived_at || kr.objective_archived_at || !visibleObjective(user, kr)) deny(404,'NOT_FOUND','Key result not found');
  return kr;
}
async function audit(tx: Queryable, user: User, action: string, objectId: string, details: unknown, ownerId: string | null, departmentId: string | null) {
  await tx.query('INSERT INTO audit_events(id,org_id,department_id,owner_id,actor_id,action,object_id,details) VALUES($1,$2,$3,$4,$5,$6,$7,$8)',
    [randomUUID(), user.org_id, departmentId ?? user.department_id, ownerId ?? user.id, user.id, action, objectId, JSON.stringify(details)]);
}
/** Walk up the parent chain; reject if the candidate parent leads back to the objective. */
async function assertNoCycle(tx: Queryable, objectiveId: string, parentId: string) {
  let current: string | null = parentId;
  for (let depth = 0; current && depth < 50; depth++) {
    if (current === objectiveId) deny(400,'ALIGNMENT_CYCLE','An objective cannot align to itself or its own children');
    current = (await tx.query('SELECT parent_objective_id FROM objectives WHERE id=$1', [current])).rows[0]?.parent_objective_id ?? null;
  }
}

export async function registerOkrCollabRoutes(app: FastifyInstance, db: Database, opts: { isAdmin?: (u: User) => boolean } = {}) {
  if (opts.isAdmin) isAdminCheck = opts.isAdmin;
  app.patch<{ Params: { id: string } }>('/objectives/:id', async req => {
    const user = actor(req), input = objectivePatch.parse(req.body), objectiveId = id.parse(req.params.id);
    return db.transaction(async tx => {
      const o = await loadObjective(tx, user, objectiveId, true);
      if (!canEditObjective(user, o)) deny(403,'FORBIDDEN','Only the owner or a department manager can edit this objective');
      if (o.version !== input.expectedVersion) deny(409,'VERSION_CONFLICT','Objective changed; reload before saving');
      let parent: string | null = o.parent_objective_id;
      if (input.parentObjectiveId !== undefined) {
        parent = input.parentObjectiveId;
        if (parent) {
          const p = (await tx.query('SELECT * FROM objectives WHERE id=$1', [parent])).rows[0];
          if (!p || p.archived_at || !visibleObjective(user, p)) deny(400,'INVALID_PARENT','Select a visible objective to align with');
          await assertNoCycle(tx, o.id, parent);
        }
      }
      if (input.rebalance && input.weight !== undefined) await rebalanceObjectives(tx, { id: o.id, org_id: o.org_id, owner_id: o.owner_id, level: o.level, period: o.planning?.period }, input.weight);
      else await assertObjectivePoints(tx, { id: o.id, org_id: o.org_id, owner_id: o.owner_id, level: o.level, period: o.planning?.period }, input.weight, o.planning?.weight);
      const planning = { ...(o.planning || {}) };
      if (input.weight !== undefined) planning.weight = input.weight;
      if (input.description !== undefined) planning.description = input.description;
      const next = (await tx.query('UPDATE objectives SET title=$2,planning=$3,parent_objective_id=$4,version=version+1,updated_at=now() WHERE id=$1 RETURNING *',
        [o.id, input.title ?? o.title, JSON.stringify(planning), parent])).rows[0];
      await audit(tx, user, 'objective.updated', o.id, { fields: Object.keys(input).filter(k => k !== 'expectedVersion') }, o.owner_id, o.department_id);
      return next;
    });
  });

  app.post<{ Params: { id: string } }>('/objectives/:id/archive', async req => {
    const user = actor(req), input = archiveInput.parse(req.body), objectiveId = id.parse(req.params.id);
    return db.transaction(async tx => {
      const o = await loadObjective(tx, user, objectiveId, true);
      if (!canEditObjective(user, o)) deny(403,'FORBIDDEN','Only the owner or a department manager can edit this objective');
      if (o.version !== input.expectedVersion) deny(409,'VERSION_CONFLICT','Objective changed; reload before saving');
      // History, appraisals and linked tasks are retained; children lose their alignment instead of disappearing.
      await tx.query('UPDATE objectives SET archived_at=now(),version=version+1,updated_at=now() WHERE id=$1', [o.id]);
      await tx.query('UPDATE key_results SET archived_at=now() WHERE objective_id=$1 AND archived_at IS NULL', [o.id]);
      await tx.query('UPDATE objectives SET parent_objective_id=NULL WHERE parent_objective_id=$1', [o.id]);
      await audit(tx, user, 'objective.archived', o.id, {}, o.owner_id, o.department_id);
      return { id: o.id, archived: true };
    });
  });

  // Set every KR weight of one objective at once. People type their own percentages; the only rule is
  // that all key results of the objective are included and add up to exactly 100%.
  app.post<{ Params: { id: string } }>('/objectives/:id/kr-weights', async req => {
    const user = actor(req), objectiveId = id.parse(req.params.id);
    const input = z.object({ weights: z.array(z.object({ id, weight }).strict()).min(1).max(50) }).strict().parse(req.body);
    return db.transaction(async tx => {
      const o = await loadObjective(tx, user, objectiveId, true);
      if (!canEditObjective(user, o)) deny(403,'FORBIDDEN','Only the owner or a department manager can edit this objective');
      const krs = (await tx.query('SELECT * FROM key_results WHERE objective_id=$1 AND archived_at IS NULL FOR UPDATE', [o.id])).rows;
      const given = new Map(input.weights.map(w => [w.id, w.weight]));
      if (given.size !== input.weights.length || krs.length !== given.size || krs.some((k: any) => !given.has(k.id)))
        deny(400,'KR_WEIGHTS_MISMATCH','Include every key result of this objective exactly once','请为这个目标下的每一条 KR 都填写权重。');
      const total = Math.round(input.weights.reduce((s, w) => s + w.weight, 0) * 100) / 100;
      if (Math.abs(total - 100) > 0.01) deny(400,'KR_WEIGHTS_NOT_100',`KR weights must add up to exactly 100% (now ${total}%)`,`同一个目标下所有 KR 的权重加起来必须正好是 100%（现在是 ${total}%）。`);
      for (const k of krs) {
        const w = given.get(k.id)!;
        if (Math.abs(Number(k.planning?.weight || 0) - w) < 0.001) continue;
        await tx.query('UPDATE key_results SET planning=$2,meta_version=meta_version+1,updated_at=now() WHERE id=$1', [k.id, JSON.stringify({ ...(k.planning || {}), weight: w })]);
      }
      await audit(tx, user, 'objective.kr_weights_set', o.id, { weights: input.weights }, o.owner_id, o.department_id);
      return { id: o.id, weights: input.weights };
    });
  });

  app.patch<{ Params: { id: string } }>('/key-results/:id', async req => {
    const user = actor(req), input = krPatch.parse(req.body), krId = id.parse(req.params.id);
    return db.transaction(async tx => {
      const kr = await loadKr(tx, user, krId, true);
      if (!canEditObjective(user, kr)) deny(403,'FORBIDDEN','Only the owner or a department manager can edit this key result');
      if (kr.meta_version !== input.expectedMetaVersion) deny(409,'VERSION_CONFLICT','Key result changed; reload before saving');
      if (input.rebalance && input.weight !== undefined) await rebalanceKrs(tx, kr.objective_id, input.weight, kr.id);
      else await assertKrWeight(tx, kr.objective_id, input.weight, { id: kr.id, weight: kr.planning?.weight });
      const planning = { ...(kr.planning || {}) };
      if (input.weight !== undefined) planning.weight = input.weight;
      if (input.description !== undefined) planning.description = input.description;
      if (input.targetText !== undefined) planning.targetText = input.targetText;
      let metric = { baseline: kr.baseline, target: kr.target, direction: kr.direction, unit: kr.unit, version: kr.version };
      if (input.metric) {
        if (kr.version !== input.metric.expectedVersion) deny(409,'VERSION_CONFLICT','Key result changed; reload before saving');
        const candidate = { ...input.metric, actual: kr.actual ?? input.metric.baseline };
        if (!hasKrMetric(candidate)) deny(400,'METRIC_INVALID','Metric target must differ from baseline in the declared direction');
        metric = { ...input.metric, version: kr.version + 1 };
      }
      const next = (await tx.query(`UPDATE key_results SET title=$2,planning=$3,confidence=$4,baseline=$5,target=$6,direction=$7,unit=$8,version=$9,
        meta_version=meta_version+1,updated_at=now() WHERE id=$1 RETURNING *`,
        [kr.id, input.title ?? kr.title, JSON.stringify(planning), input.confidence === undefined ? kr.confidence : input.confidence,
         metric.baseline, metric.target, metric.direction, metric.unit, metric.version])).rows[0];
      await audit(tx, user, 'kr.updated', kr.id, { fields: Object.keys(input).filter(k => k !== 'expectedMetaVersion'), metricChanged: !!input.metric }, kr.owner_id, kr.department_id);
      return { ...next, progress: krProgress(next) };
    });
  });

  app.post<{ Params: { id: string } }>('/key-results/:id/archive', async req => {
    const user = actor(req), krId = id.parse(req.params.id);
    const input = z.object({ expectedMetaVersion: z.number().int().positive() }).strict().parse(req.body);
    return db.transaction(async tx => {
      const kr = await loadKr(tx, user, krId, true);
      if (!canEditObjective(user, kr)) deny(403,'FORBIDDEN','Only the owner or a department manager can edit this key result');
      if (kr.meta_version !== input.expectedMetaVersion) deny(409,'VERSION_CONFLICT','Key result changed; reload before saving');
      await tx.query('UPDATE key_results SET archived_at=now(),meta_version=meta_version+1,updated_at=now() WHERE id=$1', [kr.id]);
      await audit(tx, user, 'kr.archived', kr.id, {}, kr.owner_id, kr.department_id);
      return { id: kr.id, archived: true };
    });
  });

  app.get<{ Params: { id: string } }>('/objectives/:id/updates', async req => {
    const user = actor(req), objectiveId = id.parse(req.params.id);
    // A leader (first or second line) reads progress updates on their reports' OKRs, even across departments.
    const lead = (await db.query('SELECT * FROM objectives WHERE id=$1 AND org_id=$2 AND archived_at IS NULL AND owner_id=ANY($3::text[]) AND owner_id<>$4', [objectiveId, user.org_id, user.visibleOwnerIds || [], user.id])).rows[0];
    const o = lead || await loadObjective(db, user, objectiveId);
    const rows = (await db.query('SELECT u.*,usr.display_name AS author_name FROM okr_updates u JOIN users usr ON usr.id=u.author_id WHERE u.objective_id=$1 AND u.org_id=$2 ORDER BY u.created_at DESC,u.id DESC LIMIT 200', [o.id, user.org_id])).rows;
    return { items: rows, limit: 200 };
  });

  app.post<{ Params: { id: string } }>('/objectives/:id/updates', async (req, reply) => {
    const user = actor(req), input = updateInput.parse(req.body), objectiveId = id.parse(req.params.id);
    const result = await db.transaction(async tx => {
      const o = await loadObjective(tx, user, objectiveId, true);
      // Anyone who can contribute to the objective may post progress; company objectives: managers only.
      const canPost = o.level === 'company' ? user.role === 'manager' : (o.department_id === user.department_id && (user.role === 'manager' || o.owner_id === user.id));
      if (!canPost) deny(403,'FORBIDDEN','Only the owner or a department manager can post progress');
      let kr: any = null;
      if (input.krId) {
        kr = (await tx.query('SELECT * FROM key_results WHERE id=$1 FOR UPDATE', [input.krId])).rows[0];
        if (!kr || kr.archived_at || kr.objective_id !== o.id) deny(400,'INVALID_KR','Select a key result of this objective');
      }
      if (input.confidence && !kr) deny(400,'INVALID_KR','Status applies to a key result');
      if (kr && input.confidence) await tx.query('UPDATE key_results SET confidence=$2,meta_version=meta_version+1,updated_at=now() WHERE id=$1', [kr.id, input.confidence]);
      const progress = kr ? krProgress(kr) : null;
      const row = (await tx.query('INSERT INTO okr_updates(id,org_id,objective_id,kr_id,author_id,body,confidence,progress) VALUES($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *',
        [randomUUID(), user.org_id, o.id, kr?.id ?? null, user.id, input.body, input.confidence ?? null, progress])).rows[0];
      await tx.query('UPDATE objectives SET updated_at=now() WHERE id=$1', [o.id]);
      await audit(tx, user, 'okr.update_posted', o.id, { updateId: row.id, krId: kr?.id ?? null, confidence: input.confidence ?? null }, o.owner_id, o.department_id);
      return { ...row, author_name: user.display_name };
    });
    return reply.code(201).send(result);
  });
}
