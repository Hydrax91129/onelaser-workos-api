/* In-app inbox: a red dot for anything new that concerns me.
 *   inbox_items  task interactions (new task, progress update, submission, review, completion)
 *   task_nudges  reminders and assignments already recorded by the follow-up engine (assign.ts, okr-cycle.ts)
 * GET /inbox merges both, newest first, with an unread count; POST /inbox/read marks items read. */
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { Database, Queryable } from './db.js';
import type { User } from './auth.js';
import { deny } from './errors.js';

export const inboxSchema = `
CREATE TABLE IF NOT EXISTS inbox_items(id text PRIMARY KEY, org_id text NOT NULL, user_id text NOT NULL, actor_id text, kind text NOT NULL,
  task_id text, title text NOT NULL DEFAULT '', body text NOT NULL DEFAULT '', created_at timestamptz NOT NULL DEFAULT now(), read_at timestamptz);
CREATE INDEX IF NOT EXISTS inbox_items_user ON inbox_items(user_id,created_at);
`;

export type InboxKind = 'task_new' | 'task_update' | 'submission' | 'review_accept' | 'review_revise' | 'completion' | 'hr_reminder';

/** Record one in-app item per recipient (the actor never notifies themself). Runs inside the caller's transaction. */
export async function pushInbox(tx: Queryable, item: { orgId: string; recipients: (string | null | undefined)[]; actorId: string; kind: InboxKind; taskId?: string | null; title: string; body?: string }) {
  const to = [...new Set(item.recipients.filter((r): r is string => !!r && r !== item.actorId))];
  for (const userId of to) {
    await tx.query('INSERT INTO inbox_items(id,org_id,user_id,actor_id,kind,task_id,title,body) VALUES($1,$2,$3,$4,$5,$6,$7,$8)',
      [randomUUID(), item.orgId, userId, item.actorId, item.kind, item.taskId || null, item.title.slice(0, 200), String(item.body || '').slice(0, 300)]);
  }
  return to.length;
}
/** Everyone who follows a task: owner, reviewer and whoever assigned or created it. */
export const taskFollowers = (t: any) => [t.owner_id, t.reviewer_id, t.assigned_by, t.created_by];

const DAY = 86_400_000;
export async function registerInboxRoutes(app: FastifyInstance, db: Database) {
  const actorOf = (req: FastifyRequest): User => req.actor || deny(401, 'UNAUTHENTICATED', 'Authentication is required');
  app.get('/inbox', async req => {
    const u = actorOf(req), since = new Date(Date.now() - 30 * DAY).toISOString();
    const own = (await db.query(`SELECT i.*, (SELECT display_name FROM users WHERE id=i.actor_id) AS actor_name, (SELECT json_build_object('zh',name_zh,'en',name_en) FROM users WHERE id=i.actor_id) AS actor_names
      FROM inbox_items i WHERE i.org_id=$1 AND i.user_id=$2 AND i.created_at>$3 ORDER BY i.created_at DESC LIMIT 60`, [u.org_id, u.id, since])).rows;
    const nudges = (await db.query(`SELECT n.*, t.title AS task_title FROM task_nudges n LEFT JOIN tasks t ON t.id=n.task_id
      WHERE n.org_id=$1 AND n.user_id=$2 AND n.created_at>$3 ORDER BY n.created_at DESC LIMIT 60`, [u.org_id, u.id, since])).rows;
    const items = [
      ...own.map((r: any) => ({ id: r.id, source: 'inbox', kind: r.kind, taskId: r.task_id, title: r.title, body: r.body, actorName: r.actor_name, actorNames: r.actor_names, createdAt: r.created_at, read: !!r.read_at })),
      ...nudges.map((r: any) => { const okr = String(r.kind).startsWith('okr_') || String(r.task_id).startsWith('okr:');
        return { id: r.id, source: 'nudge', kind: okr ? 'okr' : r.kind === 'assigned' ? 'assigned' : 'nudge', taskId: okr ? null : r.task_id, title: r.task_title || '', body: r.message, actorName: null, actorNames: null, createdAt: r.created_at, read: !!r.read_at }; }),
    ].sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()).slice(0, 60);
    return { items, unread: items.filter(i => !i.read).length };
  });
  app.post('/inbox/read', async req => {
    const u = actorOf(req), v = z.object({ ids: z.array(z.string().min(1).max(100)).max(200).optional(), all: z.boolean().optional() }).strict().parse(req.body);
    if (v.all) {
      await db.query('UPDATE inbox_items SET read_at=now() WHERE user_id=$1 AND read_at IS NULL', [u.id]);
      await db.query('UPDATE task_nudges SET read_at=now() WHERE user_id=$1 AND read_at IS NULL', [u.id]);
      return { ok: true };
    }
    const ids = v.ids || [];
    if (ids.length) {
      await db.query('UPDATE inbox_items SET read_at=now() WHERE user_id=$1 AND id=ANY($2::text[]) AND read_at IS NULL', [u.id, ids]);
      await db.query('UPDATE task_nudges SET read_at=now() WHERE user_id=$1 AND id=ANY($2::text[]) AND read_at IS NULL', [u.id, ids]);
    }
    return { ok: true };
  });
  /** Opening a task clears its unread items. */
  app.post<{ Params: { id: string } }>('/inbox/read-task/:id', async req => {
    const u = actorOf(req), taskId = z.string().min(1).max(128).parse(req.params.id);
    await db.query('UPDATE inbox_items SET read_at=now() WHERE user_id=$1 AND task_id=$2 AND read_at IS NULL', [u.id, taskId]);
    await db.query('UPDATE task_nudges SET read_at=now() WHERE user_id=$1 AND task_id=$2 AND read_at IS NULL', [u.id, taskId]);
    return { ok: true };
  });
}
