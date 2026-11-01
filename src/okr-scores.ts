/* Simple OKR scoring on six levels: 0 not started, 25 badly behind, 50 partly
 * done, 75 nearly done, 100 done, 125 done and excellent. Each key result (or an
 * objective without key results) gets a self score and a leader score; the final
 * score is 50% self + 50% leader, and a leader who finds the self score untrue can
 * set the key result to 0 ("veto"). Objective weight = points, key result weight =
 * share of its objective. History is kept; the latest of each kind counts. */
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { Database, Queryable } from './db.js';
import type { User } from './auth.js';
import { deny } from './errors.js';
import { assertKrWeightsComplete } from './okr-weights.js';

export const okrScoreSchema = `
CREATE TABLE IF NOT EXISTS objective_scores(
  id text PRIMARY KEY, objective_id text NOT NULL, kind text NOT NULL CHECK(kind IN ('self','manager')),
  score integer NOT NULL CHECK(score BETWEEN 0 AND 100), comment text NOT NULL DEFAULT '', author_id text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now());
CREATE INDEX IF NOT EXISTS objective_scores_obj ON objective_scores(objective_id,kind,created_at);
ALTER TABLE objective_scores DROP CONSTRAINT IF EXISTS objective_scores_score_check;
ALTER TABLE objective_scores ADD COLUMN IF NOT EXISTS veto boolean NOT NULL DEFAULT false;
CREATE TABLE IF NOT EXISTS kr_scores(
  id text PRIMARY KEY, kr_id text NOT NULL, kind text NOT NULL CHECK(kind IN ('self','manager')), score integer NOT NULL,
  comment text NOT NULL DEFAULT '', veto boolean NOT NULL DEFAULT false, author_id text NOT NULL, created_at timestamptz NOT NULL DEFAULT now());
CREATE INDEX IF NOT EXISTS kr_scores_kr ON kr_scores(kr_id,kind,created_at);
ALTER TABLE kr_scores ADD COLUMN IF NOT EXISTS evidence jsonb NOT NULL DEFAULT '[]';
ALTER TABLE objective_scores ADD COLUMN IF NOT EXISTS evidence jsonb NOT NULL DEFAULT '[]';
`;
export const LEVELS = [0, 25, 50, 75, 100, 125];

/** Latest self and manager score per objective. */
export async function scoresFor(db: Queryable, ids: string[], table: 'objective_scores' | 'kr_scores' = 'objective_scores') {
  if (!ids.length) return new Map<string, any>();
  const key = table === 'kr_scores' ? 'kr_id' : 'objective_id';
  const rows = (await db.query(`SELECT DISTINCT ON (${key},kind) s.${key} AS target_id,s.kind,s.score,s.comment,s.veto,s.evidence,s.author_id,s.created_at,u.display_name AS author_name,u.name_zh,u.name_en
    FROM ${table} s LEFT JOIN users u ON u.id=s.author_id WHERE s.${key}=ANY($1::text[]) ORDER BY ${key},kind,created_at DESC`, [ids])).rows;
  const out = new Map<string, any>();
  for (const r of rows) { const cur = out.get(r.target_id) || {}; cur[r.kind] = { score: r.score, comment: r.comment, veto: r.veto, evidence: r.evidence || [], authorId: r.author_id, authorName: r.author_name, authorNameZh: r.name_zh, authorNameEn: r.name_en, at: r.created_at }; out.set(r.target_id, cur); }
  for (const v of out.values()) v.final = v.manager?.veto ? 0 : v.self && v.manager ? Math.round((v.self.score + v.manager.score) / 2 * 10) / 10 : null;
  return out;
}

/** Who may give the leader score: the owner's manager, a manager of the objective's department, or an admin. */
export async function canLeadScore(db: Queryable, user: User, objective: any, isAdmin: (u: User) => boolean) {
  if (!objective || objective.org_id !== user.org_id) return false;
  if (isAdmin(user)) return objective.owner_id !== user.id || !objective.owner_id;
  if (objective.owner_id === user.id) return false;
  if (objective.owner_id) {
    const owner = (await db.query('SELECT manager_id FROM users WHERE id=$1', [objective.owner_id])).rows[0];
    if (owner?.manager_id === user.id) return true;
  }
  return user.role === 'manager' && objective.department_id === user.department_id;
}

export async function registerOkrScoreRoutes(app: FastifyInstance, db: Database, o: { isAdmin: (u: User) => boolean; visible: (u: User, obj: any) => boolean }) {
  const actorOf = (req: FastifyRequest): User => req.actor || deny(401, 'UNAUTHENTICATED', 'Authentication is required');
  const input = z.object({ kind: z.enum(['self', 'manager']), score: z.number().int().refine(v => LEVELS.includes(v), 'Use 0, 25, 50, 75, 100 or 125'), comment: z.string().trim().max(2000).optional(), veto: z.boolean().optional(), attachmentIds: z.array(z.string().min(1).max(100)).max(10).optional() }).strict();
  // A self score counts only with a written explanation or an uploaded file (uploaded to the key result's task).
  const MIN_COMMENT = 10;
  const check = async (user: User, objective: any, v: z.infer<typeof input>) => {
    if (!objective || !o.visible(user, objective)) deny(404, 'NOT_FOUND', 'Objective not found');
    if (v.kind === 'self' && objective.owner_id !== user.id) deny(403, 'FORBIDDEN', 'Only the owner gives the self score');
    if (v.kind === 'manager' && !(await canLeadScore(db, user, objective, o.isAdmin))) deny(403, 'FORBIDDEN', 'Only the owner’s leader gives the leader score');
    if (v.veto && v.kind !== 'manager') deny(400, 'VETO_LEADER_ONLY', 'Only the leader can mark a self score as untrue');
    if (v.kind === 'self' && (v.comment || '').length < MIN_COMMENT && !(v.attachmentIds || []).length) deny(400, 'SELF_SCORE_EVIDENCE_REQUIRED', 'Explain your self score in at least 10 characters or upload a file', '自评需要写清楚完成情况（至少 10 个字），或上传证明文件。');
  };
  /* Files must be attachments of this key result's own task, uploaded by the scorer. */
  const evidenceFor = async (user: User, krId: string | null, ids: string[] = []) => {
    if (!ids.length) return [];
    if (!krId) deny(400, 'EVIDENCE_INVALID', 'Files can be attached to key results only');
    const rows = (await db.query('SELECT a.id,a.name,a.mime,a.size,a.task_id FROM task_attachments a JOIN tasks t ON t.id=a.task_id WHERE a.id=ANY($1::text[]) AND t.kr_id=$2 AND a.uploader_id=$3 AND a.org_id=$4', [ids, krId, user.id, user.org_id])).rows;
    if (rows.length !== new Set(ids).size) deny(400, 'EVIDENCE_INVALID', 'Upload files to this key result before scoring', '请先把证明文件上传到这条 KR，再提交自评。');
    return rows.map((r: any) => ({ id: r.id, name: r.name, mime: r.mime, size: r.size, taskId: r.task_id }));
  };
  const audit = (user: User, objective: any, action: string, target: string, details: unknown) => db.query('INSERT INTO audit_events(id,org_id,department_id,owner_id,actor_id,action,object_id,details) VALUES($1,$2,$3,$4,$5,$6,$7,$8)',
    [randomUUID(), user.org_id, objective.department_id || user.department_id, objective.owner_id || user.id, user.id, action, target, JSON.stringify(details)]);
  app.post<{ Params: { id: string } }>('/key-results/:id/scores', async (req, reply) => {
    const user = actorOf(req), v = input.parse(req.body), id = z.string().min(1).max(100).parse(req.params.id);
    const kr = (await db.query('SELECT k.*,o.org_id,o.department_id,o.owner_id,o.level FROM key_results k JOIN objectives o ON o.id=k.objective_id WHERE k.id=$1 AND k.archived_at IS NULL AND o.archived_at IS NULL', [id])).rows[0];
    await check(user, kr, v);
    await assertKrWeightsComplete(db, kr.objective_id);
    const score = v.veto ? 0 : v.score, evidence = await evidenceFor(user, id, v.attachmentIds);
    await db.query('INSERT INTO kr_scores(id,kr_id,kind,score,comment,veto,author_id,evidence) VALUES($1,$2,$3,$4,$5,$6,$7,$8)', [randomUUID(), id, v.kind, score, v.comment || '', !!v.veto, user.id, JSON.stringify(evidence)]);
    await audit(user, kr, 'kr.scored', id, { kind: v.kind, score, veto: !!v.veto });
    reply.code(201);
    return { krId: id, scores: (await scoresFor(db, [id], 'kr_scores')).get(id) || {} };
  });
  app.post<{ Params: { id: string } }>('/objectives/:id/scores', async (req, reply) => {
    const user = actorOf(req), v = input.parse(req.body), id = z.string().min(1).max(100).parse(req.params.id);
    const objective = (await db.query('SELECT * FROM objectives WHERE id=$1 AND archived_at IS NULL', [id])).rows[0];
    await check(user, objective, v);
    const score = v.veto ? 0 : v.score;
    await evidenceFor(user, null, v.attachmentIds);
    await db.query('INSERT INTO objective_scores(id,objective_id,kind,score,comment,author_id,veto) VALUES($1,$2,$3,$4,$5,$6,$7)', [randomUUID(), id, v.kind, score, v.comment || '', user.id, !!v.veto]);
    await audit(user, objective, 'objective.scored', id, { kind: v.kind, score, veto: !!v.veto });
    reply.code(201);
    return { objectiveId: id, scores: (await scoresFor(db, [id])).get(id) || {} };
  });
}
