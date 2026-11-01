/* Simple OKR scoring: the owner scores each objective (self score), the leader
 * scores it too, and the leader's score is the final score. Scores are 0-100;
 * history is kept, the latest of each kind counts. */
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { Database, Queryable } from './db.js';
import type { User } from './auth.js';
import { deny } from './errors.js';

export const okrScoreSchema = `
CREATE TABLE IF NOT EXISTS objective_scores(
  id text PRIMARY KEY, objective_id text NOT NULL, kind text NOT NULL CHECK(kind IN ('self','manager')),
  score integer NOT NULL CHECK(score BETWEEN 0 AND 100), comment text NOT NULL DEFAULT '', author_id text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now());
CREATE INDEX IF NOT EXISTS objective_scores_obj ON objective_scores(objective_id,kind,created_at);
`;

/** Latest self and manager score per objective. */
export async function scoresFor(db: Queryable, ids: string[]) {
  if (!ids.length) return new Map<string, any>();
  const rows = (await db.query(`SELECT DISTINCT ON (objective_id,kind) s.objective_id,s.kind,s.score,s.comment,s.author_id,s.created_at,u.display_name AS author_name
    FROM objective_scores s LEFT JOIN users u ON u.id=s.author_id WHERE s.objective_id=ANY($1::text[]) ORDER BY objective_id,kind,created_at DESC`, [ids])).rows;
  const out = new Map<string, any>();
  for (const r of rows) { const cur = out.get(r.objective_id) || {}; cur[r.kind] = { score: r.score, comment: r.comment, authorId: r.author_id, authorName: r.author_name, at: r.created_at }; out.set(r.objective_id, cur); }
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
  const input = z.object({ kind: z.enum(['self', 'manager']), score: z.number().int().min(0).max(100), comment: z.string().trim().max(2000).optional() }).strict();
  app.post<{ Params: { id: string } }>('/objectives/:id/scores', async (req, reply) => {
    const user = actorOf(req), v = input.parse(req.body), id = z.string().min(1).max(100).parse(req.params.id);
    const objective = (await db.query('SELECT * FROM objectives WHERE id=$1 AND archived_at IS NULL', [id])).rows[0];
    if (!objective || !o.visible(user, objective)) deny(404, 'NOT_FOUND', 'Objective not found');
    if (v.kind === 'self' && objective.owner_id !== user.id) deny(403, 'FORBIDDEN', 'Only the owner gives the self score');
    if (v.kind === 'manager' && !(await canLeadScore(db, user, objective, o.isAdmin))) deny(403, 'FORBIDDEN', 'Only the owner’s leader gives the final score');
    await db.query('INSERT INTO objective_scores(id,objective_id,kind,score,comment,author_id) VALUES($1,$2,$3,$4,$5,$6)', [randomUUID(), id, v.kind, v.score, v.comment || '', user.id]);
    await db.query('INSERT INTO audit_events(id,org_id,department_id,owner_id,actor_id,action,object_id,details) VALUES($1,$2,$3,$4,$5,$6,$7,$8)',
      [randomUUID(), user.org_id, objective.department_id || user.department_id, objective.owner_id || user.id, user.id, 'objective.scored', id, JSON.stringify({ kind: v.kind, score: v.score })]);
    reply.code(201);
    return { objectiveId: id, scores: (await scoresFor(db, [id])).get(id) || {} };
  });
}
