/* People & organization: personal profile (contact info, avatar), reporting
 * lines (manager_id), in-app role / admin settings, and the team task report
 * that follows reporting lines.
 *
 * Admins = WORKOS_EXECUTIVE_USER_IDS (deployment config, always admin) plus
 * users granted is_admin in the app. A role set here (role_override) survives
 * the next DingTalk login; without an override the DingTalk/env role applies.
 */
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { Database, Queryable } from './db.js';
import type { User } from './auth.js';
import { deny } from './errors.js';
import { QUALITY_FACTORY_IDS } from './quality.js';
import { HR_GRANTS } from './hr.js';

export const orgSchema = `
ALTER TABLE users ADD COLUMN IF NOT EXISTS title text NOT NULL DEFAULT '';
ALTER TABLE users ADD COLUMN IF NOT EXISTS phone text NOT NULL DEFAULT '';
ALTER TABLE users ADD COLUMN IF NOT EXISTS email text NOT NULL DEFAULT '';
ALTER TABLE users ADD COLUMN IF NOT EXISTS email_locked boolean NOT NULL DEFAULT false;
ALTER TABLE users ADD COLUMN IF NOT EXISTS wechat text NOT NULL DEFAULT '';
ALTER TABLE users ADD COLUMN IF NOT EXISTS location text NOT NULL DEFAULT '';
ALTER TABLE users ADD COLUMN IF NOT EXISTS timezone text NOT NULL DEFAULT '';
ALTER TABLE users ADD COLUMN IF NOT EXISTS manager_id text REFERENCES users(id);
ALTER TABLE users ADD COLUMN IF NOT EXISTS second_manager_id text REFERENCES users(id);
ALTER TABLE users ADD COLUMN IF NOT EXISTS is_admin boolean NOT NULL DEFAULT false;
ALTER TABLE users ADD COLUMN IF NOT EXISTS role_override text;
ALTER TABLE users ADD COLUMN IF NOT EXISTS avatar_version integer NOT NULL DEFAULT 0;
ALTER TABLE users ADD COLUMN IF NOT EXISTS grants jsonb NOT NULL DEFAULT '[]';
ALTER TABLE users ADD COLUMN IF NOT EXISTS dingtalk_title text NOT NULL DEFAULT '';
ALTER TABLE users ADD COLUMN IF NOT EXISTS dingtalk_location text NOT NULL DEFAULT '';
ALTER TABLE users ADD COLUMN IF NOT EXISTS name_zh text NOT NULL DEFAULT '';
ALTER TABLE users ADD COLUMN IF NOT EXISTS name_en text NOT NULL DEFAULT '';
CREATE INDEX IF NOT EXISTS users_manager ON users(manager_id);
CREATE INDEX IF NOT EXISTS users_second_manager ON users(second_manager_id);
CREATE TABLE IF NOT EXISTS user_avatars(user_id text PRIMARY KEY REFERENCES users(id), content_type text NOT NULL, data text NOT NULL, updated_at timestamptz NOT NULL DEFAULT now());
`;

/** Columns safe to show colleagues (contact directory). */
export const PUBLIC_USER_COLUMNS = 'id,display_name,name_zh,name_en,department_id,role,title,phone,email,wechat,location,timezone,manager_id,second_manager_id,avatar_version,quality_factory';

/** Feature grants an admin can give in the app. `products` opens the product test area; `product_cost_detail` shows how prices are calculated. */
export const GRANTS = ['products', 'product_cost_detail', 'products_manage', 'pricing_msrp', 'supply', 'supply_manage', 'warehouse', 'warehouse_manage', 'dealers', 'dealers_manage',
  /* HR records per region (hr.ts): view = read-only, manage = edit */ ...HR_GRANTS] as const;
const id = z.string().min(1).max(100).regex(/^[A-Za-z0-9_-]+$/);
const text = (max: number) => z.string().trim().max(max);
const profileInput = z.object({
  nameZh: text(40).optional(),
  nameEn: text(60).regex(/^[A-Za-z0-9 .'\-]*$/, 'Use Latin letters').optional(),
  title: text(80).optional(),
  phone: text(40).regex(/^[0-9+()\-.\s]*$/, 'Invalid phone').optional(),
  email: z.union([z.literal(''), z.string().trim().max(200).email()]).optional(),
  wechat: text(60).optional(),
  location: text(80).optional(),
  timezone: text(60).refine(value => { if (!value) return true; if (!/^[A-Za-z_]+(\/[A-Za-z0-9_+\-]+)*$/.test(value)) return false; try { new Intl.DateTimeFormat('en', {timeZone:value}); return true; } catch { return false; } }, 'Invalid time zone').optional(),
}).strict().refine(v => Object.keys(v).length > 0, 'Nothing to change');
const avatarInput = z.object({ dataUrl: z.string().max(400_000) }).strict();
const memberPatch = z.object({
  factory: z.enum(['', ...QUALITY_FACTORY_IDS]).optional(),
  managerId: id.nullable().optional(),
  /** Second leader (dotted line): the same rights over the person as the first leader. */
  secondManagerId: id.nullable().optional(),
  title: text(80).optional(),
  location: text(80).optional(),
  nameZh: text(40).optional(),
  nameEn: text(60).optional(),
  role: z.enum(['employee', 'manager']).optional(),
  isAdmin: z.boolean().optional(),
  grants: z.array(z.enum(GRANTS)).max(GRANTS.length).optional(),
  email: z.string().trim().toLowerCase().max(200).email().optional(),
}).strict().refine(v => Object.keys(v).length > 0, 'Nothing to change');

const AVATAR = /^data:(image\/(?:jpeg|png|webp));base64,([A-Za-z0-9+/]+={0,2})$/;
const actorOf = (req: FastifyRequest): User => req.actor || deny(401, 'UNAUTHENTICATED', 'Authentication is required');

export type OrgOptions = { executiveUserIds: string[] };
export const isAdmin = (user: User & { is_admin?: boolean }, o: OrgOptions) => o.executiveUserIds.includes(user.id) || user.is_admin === true;

async function audit(tx: Queryable, user: User, action: string, objectId: string, details: unknown, ownerId = user.id) {
  await tx.query('INSERT INTO audit_events(id,org_id,department_id,owner_id,actor_id,action,object_id,details) VALUES($1,$2,$3,$4,$5,$6,$7,$8)',
    [randomUUID(), user.org_id, user.department_id, ownerId, user.id, action, objectId, JSON.stringify(details)]);
}

/** All direct and indirect reports of a user along both lines, first and second leader (cycle-safe). */
export async function reportsOf(db: Queryable, orgId: string, userId: string) {
  const rows = (await db.query('SELECT id,manager_id,second_manager_id FROM users WHERE org_id=$1 AND active=true', [orgId])).rows as { id: string; manager_id: string | null; second_manager_id: string | null }[];
  const children = new Map<string, string[]>();
  const add = (m: string | null, c: string) => { if (!m || m === c) return; if (!children.has(m)) children.set(m, []); children.get(m)!.push(c); };
  for (const r of rows) { add(r.manager_id, r.id); add(r.second_manager_id, r.id); }
  const out = new Map<string, number>(), queue: [string, number][] = (children.get(userId) || []).map(x => [x, 1]);
  while (queue.length) { const [cur, depth] = queue.shift()!; if (out.has(cur) || cur === userId) continue; out.set(cur, depth); for (const c of children.get(cur) || []) queue.push([c, depth + 1]); }
  return out;
}

export async function registerOrgRoutes(app: FastifyInstance, db: Database, o: OrgOptions) {
  app.patch('/me/profile', async req => {
    const user = actorOf(req), input = profileInput.parse(req.body);
    // Work location is part of the org record: only administrators set it (Organization & permissions).
    if (input.location !== undefined && !isAdmin(user as any, o)) deny(403, 'LOCATION_ADMIN_ONLY', 'Your work location is set by an administrator');
    // Work email is required for notifications; once an administrator has set it, only an administrator can change it.
    if (input.email !== undefined) {
      if (!input.email) deny(400, 'EMAIL_REQUIRED', 'A work email is required');
      input.email = input.email.toLowerCase();
      const locked = (await db.query('SELECT email_locked FROM users WHERE id=$1', [user.id])).rows[0]?.email_locked === true;
      if (locked && !isAdmin(user as any, o)) deny(403, 'EMAIL_LOCKED', 'Your work email was set by an administrator and cannot be changed');
    }
    const sets: string[] = [], values: unknown[] = [user.id];
    const column: Record<string, string> = { nameZh: 'name_zh', nameEn: 'name_en' };
    for (const [key, value] of Object.entries(input)) { values.push(value); sets.push(`${column[key] || key}=$${values.length}`); }
    const row = (await db.query(`UPDATE users SET ${sets.join(',')} WHERE id=$1 RETURNING ${PUBLIC_USER_COLUMNS}`, values)).rows[0];
    await audit(db, user, 'profile.updated', user.id, { fields: Object.keys(input) });
    return row;
  });

  app.put('/me/avatar', { bodyLimit: 512 * 1024 }, async req => {
    const user = actorOf(req), { dataUrl } = avatarInput.parse(req.body), m = AVATAR.exec(dataUrl);
    if (!m) deny(400, 'AVATAR_INVALID', 'Upload a JPEG, PNG or WebP image');
    if (Buffer.from(m![2], 'base64').length > 300 * 1024) deny(400, 'AVATAR_TOO_LARGE', 'The image is too large');
    return db.transaction(async tx => {
      await tx.query('INSERT INTO user_avatars(user_id,content_type,data) VALUES($1,$2,$3) ON CONFLICT(user_id) DO UPDATE SET content_type=excluded.content_type,data=excluded.data,updated_at=now()', [user.id, m![1], m![2]]);
      const row = (await tx.query('UPDATE users SET avatar_version=avatar_version+1 WHERE id=$1 RETURNING avatar_version', [user.id])).rows[0];
      await audit(tx, user, 'profile.avatar_updated', user.id, {});
      return { avatarVersion: row.avatar_version };
    });
  });

  app.delete('/me/avatar', async req => {
    const user = actorOf(req);
    await db.query('DELETE FROM user_avatars WHERE user_id=$1', [user.id]);
    const row = (await db.query('UPDATE users SET avatar_version=0 WHERE id=$1 RETURNING avatar_version', [user.id])).rows[0];
    return { avatarVersion: row.avatar_version };
  });

  app.get<{ Params: { id: string } }>('/users/:id/avatar', async (req, reply) => {
    const user = actorOf(req), target = id.parse(req.params.id);
    const row = (await db.query('SELECT a.content_type,a.data FROM user_avatars a JOIN users u ON u.id=a.user_id WHERE a.user_id=$1 AND u.org_id=$2', [target, user.org_id])).rows[0];
    if (!row) deny(404, 'NOT_FOUND', 'Avatar not found');
    return reply.header('Content-Type', row.content_type).header('Cache-Control', 'private, max-age=86400').header('X-Content-Type-Options', 'nosniff').send(Buffer.from(row.data, 'base64'));
  });

  app.get('/org/members', async req => {
    const user = actorOf(req);
    if (!isAdmin(user, o)) deny(403, 'FORBIDDEN', 'Administrator access is required');
    const rows = (await db.query(`SELECT ${PUBLIC_USER_COLUMNS},active,is_admin,role_override,grants,disabled_at,login_email,(password_hash IS NOT NULL) AS has_password,invited_by,email_locked,(SELECT e.user_id IS NOT NULL FROM external_identities e WHERE e.user_id=users.id LIMIT 1) AS dingtalk FROM users WHERE org_id=$1 ORDER BY active DESC,display_name,id`, [user.org_id])).rows;
    return { items: rows.map(r => ({ ...r, executive: o.executiveUserIds.includes(r.id), admin: o.executiveUserIds.includes(r.id) || r.is_admin === true, adminSource: o.executiveUserIds.includes(r.id) ? 'deployment' : r.is_admin ? 'app' : null })) };
  });

  // Company-wide org chart: every signed-in member can see who reports to whom, titles and locations.
  // Contact details stay in the department directory and the admin member list.
  app.get('/org/chart', async req => {
    const user = actorOf(req);
    const rows = (await db.query(`SELECT id,display_name,name_zh,name_en,department_id,title,location,timezone,manager_id,second_manager_id,avatar_version,role FROM users WHERE org_id=$1 AND active=true ORDER BY display_name,id`, [user.org_id])).rows;
    return { items: rows };
  });

  app.patch<{ Params: { id: string } }>('/org/members/:id', async req => {
    const user = actorOf(req), input = memberPatch.parse(req.body), target = id.parse(req.params.id);
    if (!isAdmin(user, o)) deny(403, 'FORBIDDEN', 'Administrator access is required');
    return db.transaction(async tx => {
      const member = (await tx.query('SELECT * FROM users WHERE id=$1 AND org_id=$2 FOR UPDATE', [target, user.org_id])).rows[0];
      if (!member) deny(404, 'NOT_FOUND', 'Member not found');
      let manager = member.manager_id;
      if (input.managerId !== undefined) {
        manager = input.managerId;
        if (manager) {
          if (manager === member.id) deny(400, 'REPORTING_CYCLE', 'A person cannot report to themselves or their own reports');
          const m = (await tx.query('SELECT id FROM users WHERE id=$1 AND org_id=$2 AND active=true', [manager, user.org_id])).rows[0];
          if (!m) deny(400, 'INVALID_MANAGER', 'Select an active member as manager');
          if ((await reportsOf(tx, user.org_id, member.id)).has(manager)) deny(400, 'REPORTING_CYCLE', 'A person cannot report to themselves or their own reports');
        }
      }
      let second = member.second_manager_id || null;
      if (input.secondManagerId !== undefined) {
        second = input.secondManagerId;
        if (second) {
          if (second === member.id) deny(400, 'SECOND_MANAGER_SELF', 'A person cannot be their own second leader');
          const m = (await tx.query('SELECT id FROM users WHERE id=$1 AND org_id=$2 AND active=true', [second, user.org_id])).rows[0];
          if (!m) deny(400, 'INVALID_SECOND_MANAGER', 'Select an active member as second leader');
          if ((await reportsOf(tx, user.org_id, member.id)).has(second)) deny(400, 'SECOND_MANAGER_CYCLE', 'The second leader cannot be someone who reports to this person');
        }
      }
      if (second && second === manager) deny(400, 'SECOND_MANAGER_SAME', 'The second leader must be different from the first leader');
      if (input.isAdmin === false && member.id === user.id && !o.executiveUserIds.includes(user.id)) deny(400, 'ADMIN_SELF_REMOVAL', 'You cannot remove your own administrator access');
      // Feature grants open sensitive ERP data (costs, prices, stock, dealers). Only deployment-configured
      // executives may change them, so an in-app admin cannot widen anyone's access, including their own.
      if (input.grants !== undefined && !o.executiveUserIds.includes(user.id)) deny(403, 'GRANTS_EXECUTIVE_ONLY', 'Only the company owner can change feature access');
      const role = input.role ?? member.role, override = input.role ?? member.role_override;
      let grants = input.grants ? [...new Set(input.grants)] : member.grants;
      // Factory contacts only use quality tracking: never HR access.
      if (input.factory ?? member.quality_factory) grants = (grants || []).filter((g: string) => !g.startsWith('hr_'));
      if (input.grants?.includes('product_cost_detail') && !input.grants.includes('products')) deny(400, 'GRANT_DEPENDENCY', 'Cost details require product area access');
      const row = (await tx.query(`UPDATE users SET manager_id=$2,title=$3,role=$4,role_override=$5,is_admin=$6,grants=$7,location=$8,name_zh=$9,name_en=$10,email=$11,email_locked=$12,quality_factory=$13,second_manager_id=$14 WHERE id=$1 RETURNING ${PUBLIC_USER_COLUMNS},active,is_admin,role_override,grants,email_locked`,
        [member.id, manager, input.title ?? member.title, role, override, input.isAdmin ?? member.is_admin, JSON.stringify(grants), input.location ?? member.location, input.nameZh ?? member.name_zh, input.nameEn ?? member.name_en, input.email ?? member.email, input.email !== undefined ? true : member.email_locked === true, input.factory ?? member.quality_factory ?? '', second])).rows[0];
      await audit(tx, user, 'org.member_updated', member.id, input, member.id);
      if (input.secondManagerId !== undefined && (input.secondManagerId || null) !== (member.second_manager_id || null))
        await audit(tx, user, 'org.second_manager_changed', member.id, { from: member.second_manager_id || null, to: second }, member.id);
      return { ...row, executive: o.executiveUserIds.includes(row.id), admin: o.executiveUserIds.includes(row.id) || row.is_admin === true };
    });
  });

  /** Task outcomes for everyone who reports to the caller (directly or indirectly); admins see the whole organization. */
  app.get('/reports/team', async req => {
    const user = actorOf(req);
    const admin = isAdmin(user, o), scope = admin && (req.query as any)?.scope === 'all' ? 'all' : 'reports';
    const depthMap = scope === 'all'
      ? new Map((await db.query('SELECT id FROM users WHERE org_id=$1 AND active=true AND id<>$2', [user.org_id, user.id])).rows.map((r: any) => [r.id, 0]))
      : await reportsOf(db, user.org_id, user.id);
    const ids = [...depthMap.keys()];
    if (!ids.length) return { scope, canViewAll: admin, members: [], totals: null };
    const members = (await db.query(`SELECT ${PUBLIC_USER_COLUMNS} FROM users WHERE id=ANY($1::text[]) ORDER BY display_name,id`, [ids])).rows;
    const tasks = (await db.query(`SELECT t.id,t.title,t.owner_id,t.status,t.due_at,t.board_status,
        (SELECT r.created_at FROM reviews r WHERE r.task_id=t.id AND r.submission_version=t.submission_version AND r.decision='accept' ORDER BY r.created_at DESC,r.id DESC LIMIT 1) AS accepted_at,
        (SELECT r.quality FROM reviews r WHERE r.task_id=t.id AND r.submission_version=t.submission_version AND r.decision='accept' ORDER BY r.created_at DESC,r.id DESC LIMIT 1) AS quality
      FROM tasks t WHERE t.org_id=$1 AND t.owner_id=ANY($2::text[]) AND t.archived_at IS NULL`, [user.org_id, ids])).rows;
    const now = Date.now();
    const statsFor = (list: any[]) => {
      const accepted = list.filter(t => t.status === 'accepted'), open = list.filter(t => t.status !== 'accepted');
      const timed = accepted.filter(t => t.accepted_at && Number.isFinite(new Date(t.accepted_at).getTime()) && Number.isFinite(new Date(t.due_at).getTime()));
      const onTime = timed.filter(t => new Date(t.accepted_at).getTime() <= new Date(t.due_at).getTime()).length;
      const qualities = accepted.map(t => t.quality).filter((q: any) => typeof q === 'number');
      return {
        total: list.length, accepted: accepted.length, open: open.length,
        waiting: list.filter(t => t.status === 'submitted').length,
        revision: list.filter(t => t.status === 'revision').length,
        overdue: open.filter(t => new Date(t.due_at).getTime() < now).length,
        dueSoon: open.filter(t => { const d = new Date(t.due_at).getTime(); return d >= now && d < now + 7 * 864e5; }).length,
        completionRate: list.length ? Math.round(accepted.length / list.length * 100) : null,
        onTimeRate: timed.length ? Math.round(onTime / timed.length * 100) : null,
        onTimeKnown: timed.length, onTimeUnknown: accepted.length - timed.length,
        avgQuality: qualities.length ? Math.round(qualities.reduce((s: number, q: number) => s + q, 0) / qualities.length * 10) / 10 : null,
      };
    };
    const out = members.map((m: any) => {
      const own = tasks.filter((t: any) => t.owner_id === m.id);
      const attention = own.filter((t: any) => t.status !== 'accepted' && (new Date(t.due_at).getTime() < now || t.status === 'revision'))
        .sort((a: any, b: any) => new Date(a.due_at).getTime() - new Date(b.due_at).getTime()).slice(0, 5)
        .map((t: any) => ({ id: t.id, title: t.title, dueAt: t.due_at, status: t.status, overdue: new Date(t.due_at).getTime() < now }));
      // line 'second': this person's second leader (dotted line) is the caller.
      return { ...m, depth: depthMap.get(m.id) ?? 0, line: scope !== 'all' && m.second_manager_id === user.id && m.manager_id !== user.id ? 'second' : 'first', stats: statsFor(own), attention };
    });
    return { scope, canViewAll: admin, members: out, totals: statsFor(tasks), generatedAt: new Date(now).toISOString() };
  });
}
