import nodemailer from 'nodemailer';
/* Membership lifecycle that does not depend on DingTalk:
 *  - admins disable / re-enable members (a disabled member cannot sign in by any
 *    method, DingTalk login and directory sync cannot reactivate them, their
 *    sessions end at once and they leave the org chart and assignee lists);
 *  - admins invite people who are not in DingTalk with a single-use link
 *    (7 days); the invitee sets a password and signs in with email + password,
 *    or with a one-time email code when an email service is configured.
 */
import { randomBytes, randomInt, randomUUID, scrypt as scryptCb, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import { z } from 'zod';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { Database, Queryable } from './db.js';
import { cookie, hash, issueSession, sessionCookieName, type User } from './auth.js';
import { deny } from './errors.js';
import { GRANTS, isAdmin, PUBLIC_USER_COLUMNS, type OrgOptions } from './org.js';
import { QUALITY_FACTORY_IDS } from './quality.js';

const scrypt = promisify(scryptCb) as (password: string, salt: Buffer, keylen: number, options: { N: number; r: number; p: number; maxmem: number }) => Promise<Buffer>;

export const memberSchema = `
ALTER TABLE users ADD COLUMN IF NOT EXISTS disabled_at timestamptz;
ALTER TABLE users ADD COLUMN IF NOT EXISTS disabled_by text;
ALTER TABLE users ADD COLUMN IF NOT EXISTS login_email text NOT NULL DEFAULT '';
ALTER TABLE users ADD COLUMN IF NOT EXISTS password_hash text;
ALTER TABLE users ADD COLUMN IF NOT EXISTS invited_by text;
CREATE UNIQUE INDEX IF NOT EXISTS users_login_email ON users(lower(login_email)) WHERE login_email<>'';
CREATE TABLE IF NOT EXISTS member_invites(
  id text PRIMARY KEY, org_id text NOT NULL, token_hash text NOT NULL UNIQUE, email text NOT NULL, display_name text NOT NULL,
  title text NOT NULL DEFAULT '', location text NOT NULL DEFAULT '', department_id text NOT NULL, manager_id text, role text NOT NULL DEFAULT 'employee',
  grants jsonb NOT NULL DEFAULT '[]', created_by text NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL, accepted_at timestamptz, accepted_user_id text, revoked_at timestamptz, emailed boolean NOT NULL DEFAULT false);
ALTER TABLE member_invites ADD COLUMN IF NOT EXISTS location text NOT NULL DEFAULT '';
-- Factory contact invites (quality tracking only): '' = ordinary member, otherwise a QUALITY_FACTORIES id.
ALTER TABLE member_invites ADD COLUMN IF NOT EXISTS factory text NOT NULL DEFAULT '';
ALTER TABLE users ADD COLUMN IF NOT EXISTS quality_factory text NOT NULL DEFAULT '';
CREATE INDEX IF NOT EXISTS member_invites_org ON member_invites(org_id,created_at);
CREATE TABLE IF NOT EXISTS login_codes(email text PRIMARY KEY, code_hash text NOT NULL, expires_at timestamptz NOT NULL, attempts integer NOT NULL DEFAULT 0, created_at timestamptz NOT NULL DEFAULT now());
`;

export type Mailer = (message: { to: string; subject: string; text: string; html: string; attachments?: { filename: string; content: string }[] }) => Promise<void>;
export type MemberOptions = OrgOptions & { secureCookies: boolean; appPublicUrl?: string; mailer?: Mailer | null; teamName?: string };

/**
 * Outgoing email. Two options, set in the server environment only:
 *  - SMTP (any mailbox provider, e.g. Google Workspace or Zoho Mail): SMTP_HOST, SMTP_PORT (default 465), SMTP_USER, SMTP_PASS, EMAIL_FROM.
 *  - Resend (https://resend.com): RESEND_API_KEY, EMAIL_FROM.
 * SMTP wins when both are set. With neither, no email is sent (email-code login and email notifications stay off).
 */
export function mailerFromEnv(env: NodeJS.ProcessEnv): Mailer | null {
  const key = env.RESEND_API_KEY, from = env.EMAIL_FROM;
  if (env.SMTP_HOST && env.SMTP_USER && env.SMTP_PASS && from) {
    const port = Number(env.SMTP_PORT) || 465;
    const transport = nodemailer.createTransport({ host: env.SMTP_HOST, port, secure: port === 465, auth: { user: env.SMTP_USER, pass: env.SMTP_PASS }, connectionTimeout: 10000, greetingTimeout: 10000, socketTimeout: 30000 });
    return async message => {
      await transport.sendMail({ from, to: message.to, subject: message.subject, text: message.text, html: message.html,
        ...(message.attachments?.length ? { attachments: message.attachments.map(a => ({ filename: a.filename, content: Buffer.from(a.content, 'base64') })) } : {}) });
    };
  }
  if (!key || !from) return null;
  return async message => {
    const response = await fetch('https://api.resend.com/emails', {
      method: 'POST', headers: { authorization: 'Bearer ' + key, 'content-type': 'application/json' },
      body: JSON.stringify({ from, to: [message.to], subject: message.subject, text: message.text, html: message.html, ...(message.attachments?.length ? { attachments: message.attachments } : {}) }),
      signal: AbortSignal.timeout(message.attachments?.length ? 30000 : 10000),
    });
    if (!response.ok) throw new Error('Email delivery failed');
  };
}

const INVITE_DAYS = 7, CODE_MINUTES = 10, PASSWORD_MIN = 10;
const id = z.string().min(1).max(100).regex(/^[A-Za-z0-9_-]+$/);
const email = z.string().trim().toLowerCase().max(200).email();
const tokenPattern = /^[A-Za-z0-9_-]{43}$/;
const password = z.string().min(PASSWORD_MIN).max(200);

export const PUBLIC_MEMBER_PATHS = ['/auth/password', '/auth/email-code', '/auth/email-code/verify'];
export const isPublicMemberPath = (path: string) => PUBLIC_MEMBER_PATHS.includes(path) || /^\/auth\/invite\/[A-Za-z0-9_-]{43}(?:\/accept)?$/.test(path);

export async function hashPassword(value: string) {
  const salt = randomBytes(16), N = 16384, r = 8, p = 1;
  const key = await scrypt(value, salt, 64, { N, r, p, maxmem: 64 * 1024 * 1024 });
  return ['scrypt', N, r, p, salt.toString('base64url'), key.toString('base64url')].join('$');
}
export async function verifyPassword(value: string, stored: string | null | undefined) {
  const parts = (stored || '').split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') { await hashPassword(value); return false; }
  const [, N, r, p, salt, expected] = parts, want = Buffer.from(expected, 'base64url');
  const got = await scrypt(value, Buffer.from(salt, 'base64url'), want.length, { N: Number(N), r: Number(r), p: Number(p), maxmem: 64 * 1024 * 1024 });
  return got.length === want.length && timingSafeEqual(got, want);
}

const actorOf = (req: FastifyRequest): User => req.actor || deny(401, 'UNAUTHENTICATED', 'Authentication is required');
async function audit(tx: Queryable, user: Pick<User, 'id' | 'org_id' | 'department_id'>, action: string, objectId: string, details: unknown, ownerId = user.id) {
  await tx.query('INSERT INTO audit_events(id,org_id,department_id,owner_id,actor_id,action,object_id,details) VALUES($1,$2,$3,$4,$5,$6,$7,$8)',
    [randomUUID(), user.org_id, user.department_id, ownerId, user.id, action, objectId, JSON.stringify(details)]);
}

/** Small in-memory limiter (per process). Keys are hashed emails or a global bucket. */
function limiter() {
  const hits = new Map<string, { count: number; until: number }>();
  return (key: string, max: number, windowMs: number) => {
    const now = Date.now(), cur = hits.get(key);
    if (cur && cur.until > now && cur.count >= max) deny(429, 'RATE_LIMITED', 'Too many attempts, try again later');
    if (!cur || cur.until <= now) hits.set(key, { count: 1, until: now + windowMs }); else cur.count++;
    if (hits.size > 5000) for (const [k, v] of hits) if (v.until <= now) hits.delete(k);
  };
}

const escapeHtml = (s: string) => s.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));

export async function registerMemberRoutes(app: FastifyInstance, db: Database, o: MemberOptions) {
  const limit = limiter();
  const sessionName = sessionCookieName(o.secureCookies);
  const signIn = async (reply: any, userId: string) => {
    const session = await issueSession(db, userId);
    reply.header('Set-Cookie', cookie(sessionName, session.accessToken, o.secureCookies));
    return { signedIn: true, expiresAt: session.expiresAt };
  };
  const requireAdmin = (req: FastifyRequest) => { const user = actorOf(req); if (!isAdmin(user, o)) deny(403, 'FORBIDDEN', 'Administrator access is required'); return user; };
  const inviteUrl = (token: string) => new URL('/#invite/' + token, o.appPublicUrl || 'http://localhost').toString();

  // ---- Disable / re-enable --------------------------------------------------
  app.post<{ Params: { id: string } }>('/org/members/:id/status', async req => {
    const user = requireAdmin(req), target = id.parse(req.params.id);
    const input = z.object({ active: z.boolean(), reassignTo: id.nullable().optional() }).strict().parse(req.body);
    return db.transaction(async tx => {
      const member = (await tx.query('SELECT * FROM users WHERE id=$1 AND org_id=$2 FOR UPDATE', [target, user.org_id])).rows[0];
      if (!member) deny(404, 'NOT_FOUND', 'Member not found');
      if (input.active) {
        await tx.query('UPDATE users SET active=true,disabled_at=NULL,disabled_by=NULL WHERE id=$1', [member.id]);
        await audit(tx, user, 'org.member_enabled', member.id, {}, member.id);
        return { id: member.id, active: true, reassigned: { owned: 0, reviewing: 0, reports: 0 } };
      }
      if (member.id === user.id) deny(400, 'SELF_DISABLE', 'You cannot disable your own account');
      if (o.executiveUserIds.includes(member.id)) deny(400, 'EXECUTIVE_PROTECTED', 'Executive accounts cannot be disabled here');
      let heir: any = null;
      if (input.reassignTo) {
        heir = (await tx.query('SELECT * FROM users WHERE id=$1 AND org_id=$2 AND active=true', [input.reassignTo, user.org_id])).rows[0];
        if (!heir || heir.id === member.id || heir.department_id !== member.department_id) deny(400, 'INVALID_REASSIGNEE', 'Choose an active member of the same department to take over open tasks');
      }
      await tx.query('UPDATE users SET active=false,disabled_at=now(),disabled_by=$2 WHERE id=$1', [member.id, user.id]);
      await tx.query('DELETE FROM sessions WHERE user_id=$1', [member.id]);
      // Direct reports move up one level so their reporting line stays intact.
      const reports = (await tx.query('UPDATE users SET manager_id=$2 WHERE manager_id=$1 AND org_id=$3 RETURNING id', [member.id, member.manager_id && member.manager_id !== member.id ? member.manager_id : null, user.org_id])).rows.length;
      let owned = 0, reviewing = 0;
      if (heir) {
        const open = "status<>'accepted' AND COALESCE(board_status,'')<>'done'";
        const ownedRows = (await tx.query(`SELECT id,reviewer_id FROM tasks WHERE org_id=$1 AND owner_id=$2 AND ${open}`, [user.org_id, member.id])).rows;
        for (const t of ownedRows) {
          let reviewer = t.reviewer_id;
          if (reviewer === heir.id) reviewer = [heir.manager_id, member.manager_id, user.id].find(x => x && x !== heir.id) || reviewer;
          await tx.query('UPDATE tasks SET owner_id=$2,reviewer_id=$3,version=version+1,updated_at=now() WHERE id=$1', [t.id, heir.id, reviewer]);
        }
        owned = ownedRows.length;
        const reviewRows = (await tx.query(`SELECT id,owner_id FROM tasks WHERE org_id=$1 AND reviewer_id=$2 AND ${open}`, [user.org_id, member.id])).rows;
        for (const t of reviewRows) {
          const reviewer = [heir.role === 'manager' ? heir.id : null, member.manager_id, user.id].find(x => x && x !== t.owner_id && x !== member.id);
          if (reviewer) { await tx.query('UPDATE tasks SET reviewer_id=$2,version=version+1,updated_at=now() WHERE id=$1', [t.id, reviewer]); reviewing++; }
        }
      }
      await audit(tx, user, 'org.member_disabled', member.id, { reassignTo: heir?.id || null, owned, reviewing, reports }, member.id);
      return { id: member.id, active: false, reassigned: { owned, reviewing, reports } };
    });
  });

  app.get<{ Params: { id: string } }>('/org/members/:id/open-tasks', async req => {
    const user = requireAdmin(req), target = id.parse(req.params.id);
    const row = (await db.query(`SELECT
        (SELECT count(*)::int FROM tasks WHERE org_id=$1 AND owner_id=$2 AND status<>'accepted' AND COALESCE(board_status,'')<>'done') AS owned,
        (SELECT count(*)::int FROM tasks WHERE org_id=$1 AND reviewer_id=$2 AND status<>'accepted' AND COALESCE(board_status,'')<>'done') AS reviewing,
        (SELECT count(*)::int FROM users WHERE org_id=$1 AND manager_id=$2) AS reports`, [user.org_id, target])).rows[0];
    return row;
  });

  // ---- Invites ----------------------------------------------------------------
  const inviteInput = z.object({
    displayName: z.string().trim().min(1).max(80), email, title: z.string().trim().max(80).optional(), location: z.string().trim().max(80).optional(),
    managerId: id.nullable().optional(), role: z.enum(['employee', 'manager']).optional(),
    grants: z.array(z.enum(GRANTS)).max(GRANTS.length).optional(), sendEmail: z.boolean().optional(),
    factory: z.enum(QUALITY_FACTORY_IDS).nullable().optional(),
  }).strict();
  const publicInvite = (r: any) => ({ id: r.id, email: r.email, displayName: r.display_name, title: r.title, location: r.location, factory: r.factory || null, managerId: r.manager_id, role: r.role, grants: r.grants, createdAt: r.created_at, expiresAt: r.expires_at, acceptedAt: r.accepted_at, revokedAt: r.revoked_at, emailed: r.emailed, status: r.revoked_at ? 'revoked' : r.accepted_at ? 'accepted' : new Date(r.expires_at).getTime() < Date.now() ? 'expired' : 'pending' });

  app.get('/org/invites', async req => {
    const user = requireAdmin(req);
    const rows = (await db.query('SELECT * FROM member_invites WHERE org_id=$1 ORDER BY created_at DESC LIMIT 200', [user.org_id])).rows;
    return { items: rows.map(publicInvite), emailDelivery: !!o.mailer };
  });

  app.post('/org/invites', async (req, reply) => {
    const user = requireAdmin(req), input = inviteInput.parse(req.body);
    limit('invite:' + user.id, 30, 3600_000);
    if (input.grants?.includes('product_cost_detail') && !input.grants.includes('products')) deny(400, 'GRANT_DEPENDENCY', 'Cost details require product area access');
    if (input.grants?.length && !o.executiveUserIds.includes(user.id)) deny(403, 'GRANTS_EXECUTIVE_ONLY', 'Only the company owner can change feature access');
    if (input.factory) { input.role = 'employee'; input.grants = []; }
    const token = randomBytes(32).toString('base64url');
    const created = await db.transaction(async tx => {
      const taken = (await tx.query("SELECT id FROM users WHERE org_id=$1 AND lower(login_email)=$2", [user.org_id, input.email])).rows[0];
      if (taken) deny(409, 'EMAIL_IN_USE', 'This email already belongs to a member');
      let departmentId = user.department_id;
      if (input.managerId) {
        const manager = (await tx.query('SELECT id,department_id FROM users WHERE id=$1 AND org_id=$2 AND active=true', [input.managerId, user.org_id])).rows[0];
        if (!manager) deny(400, 'INVALID_MANAGER', 'Select an active member as manager');
        departmentId = manager.department_id;
      }
      await tx.query("UPDATE member_invites SET revoked_at=now() WHERE org_id=$1 AND email=$2 AND accepted_at IS NULL AND revoked_at IS NULL", [user.org_id, input.email]);
      const row = (await tx.query(`INSERT INTO member_invites(id,org_id,token_hash,email,display_name,title,department_id,manager_id,role,grants,created_by,expires_at,location,factory)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) RETURNING *`,
        [randomUUID(), user.org_id, hash(token), input.email, input.displayName, input.title || '', departmentId, input.managerId || null, input.role || 'employee', JSON.stringify([...new Set(input.grants || [])]), user.id, new Date(Date.now() + INVITE_DAYS * 864e5).toISOString(), input.location || '', input.factory || ''])).rows[0];
      await audit(tx, user, 'org.member_invited', row.id, { email: input.email, role: row.role, grants: row.grants, factory: row.factory || undefined });
      return row;
    });
    const url = inviteUrl(token);
    let emailed = false;
    if (o.mailer && input.sendEmail !== false) {
      try {
        const team = o.teamName || 'OneLaser';
        await o.mailer({ to: input.email, subject: `${user.display_name} 邀请您加入 ${team} WorkOS / You're invited to ${team} WorkOS`,
          text: `${input.displayName}，您好：\n\n${user.display_name} 邀请您加入 ${team} WorkOS。请在 ${INVITE_DAYS} 天内打开以下链接设置密码：\n${url}\n\n${user.display_name} invited you to ${team} WorkOS. Open this link within ${INVITE_DAYS} days to set your password:\n${url}`,
          html: `<p>${escapeHtml(input.displayName)}，您好：</p><p>${escapeHtml(user.display_name)} 邀请您加入 ${escapeHtml(team)} WorkOS。请在 ${INVITE_DAYS} 天内点击下方按钮设置密码。</p><p><a href="${escapeHtml(url)}" style="display:inline-block;padding:10px 18px;background:#0b6bff;color:#fff;border-radius:8px;text-decoration:none">接受邀请 / Accept invite</a></p><p style="color:#666;font-size:12px">${escapeHtml(url)}</p>` });
        emailed = true;
        await db.query('UPDATE member_invites SET emailed=true WHERE id=$1', [created.id]);
      } catch { emailed = false; }
    }
    reply.code(201);
    return { ...publicInvite({ ...created, emailed }), url };
  });

  app.delete<{ Params: { id: string } }>('/org/invites/:id', async req => {
    const user = requireAdmin(req), inviteId = z.string().uuid().parse(req.params.id);
    const row = (await db.query('UPDATE member_invites SET revoked_at=now() WHERE id=$1 AND org_id=$2 AND accepted_at IS NULL AND revoked_at IS NULL RETURNING *', [inviteId, user.org_id])).rows[0];
    if (!row) deny(404, 'NOT_FOUND', 'Invite not found or already used');
    await audit(db, user, 'org.invite_revoked', row.id, { email: row.email });
    return publicInvite(row);
  });

  const loadInvite = async (tx: Queryable, token: string, lock = false) => {
    if (!tokenPattern.test(token)) deny(404, 'INVITE_INVALID', 'This invite link is invalid or has expired');
    const row = (await tx.query('SELECT * FROM member_invites WHERE token_hash=$1' + (lock ? ' FOR UPDATE' : ''), [hash(token)])).rows[0];
    if (!row || row.revoked_at || row.accepted_at || new Date(row.expires_at).getTime() < Date.now()) deny(404, 'INVITE_INVALID', 'This invite link is invalid or has expired');
    return row;
  };

  app.get<{ Params: { token: string } }>('/auth/invite/:token', async req => {
    limit('invite-view', 300, 60_000);
    const row = await loadInvite(db, req.params.token);
    const inviter = (await db.query('SELECT display_name FROM users WHERE id=$1', [row.created_by])).rows[0];
    return { email: row.email, displayName: row.display_name, title: row.title, invitedBy: inviter?.display_name || '', team: o.teamName || 'OneLaser', expiresAt: row.expires_at, passwordMinLength: PASSWORD_MIN };
  });

  app.post<{ Params: { token: string } }>('/auth/invite/:token/accept', async (req, reply) => {
    limit('invite-accept', 60, 60_000);
    const input = z.object({ password, displayName: z.string().trim().min(1).max(80).optional() }).strict().parse(req.body);
    const passwordHash = await hashPassword(input.password);
    const userId = await db.transaction(async tx => {
      const row = await loadInvite(tx, req.params.token, true);
      const taken = (await tx.query('SELECT id FROM users WHERE org_id=$1 AND lower(login_email)=$2', [row.org_id, row.email])).rows[0];
      if (taken) deny(409, 'EMAIL_IN_USE', 'This email already belongs to a member');
      let manager = row.manager_id;
      if (manager && !(await tx.query('SELECT id FROM users WHERE id=$1 AND org_id=$2 AND active=true', [manager, row.org_id])).rows[0]) manager = null;
      const newId = 'inv_' + randomUUID().replace(/-/g, '').slice(0, 20);
      await tx.query('INSERT INTO users(id,org_id,department_id,display_name,role) VALUES($1,$2,$3,$4,$5)', [newId, row.org_id, row.department_id, input.displayName || row.display_name, row.role]);
      await tx.query(`UPDATE users SET title=$2,email=$3,email_locked=true,login_email=$3,password_hash=$4,manager_id=$5,role_override=$6,grants=$7,invited_by=$8,location=$9,quality_factory=$10 WHERE id=$1`,
        [newId, row.title, row.email, passwordHash, manager, row.role, JSON.stringify(row.grants || []), row.created_by, row.location || '', row.factory || '']);
      await tx.query('UPDATE member_invites SET accepted_at=now(),accepted_user_id=$2 WHERE id=$1', [row.id, newId]);
      await audit(tx, { id: newId, org_id: row.org_id, department_id: row.department_id }, 'org.invite_accepted', row.id, { email: row.email });
      return newId;
    });
    return signIn(reply, userId);
  });

  // ---- Email + password -------------------------------------------------------
  app.post('/auth/password', async (req, reply) => {
    const input = z.object({ email, password: z.string().min(1).max(200) }).strict().parse(req.body);
    limit('pw-global', 600, 60_000);
    limit('pw:' + hash(input.email), 10, 15 * 60_000);
    const user = (await db.query("SELECT id,password_hash,active,disabled_at FROM users WHERE lower(login_email)=$1 AND login_email<>''", [input.email])).rows[0];
    const ok = await verifyPassword(input.password, user?.password_hash);
    if (!user || !ok) deny(401, 'INVALID_CREDENTIALS', 'Email or password is incorrect');
    if (!user.active || user.disabled_at) deny(403, 'ACCOUNT_DISABLED', 'This account has been disabled by an administrator');
    return signIn(reply, user.id);
  });

  app.post('/me/password', async req => {
    const user = actorOf(req);
    const input = z.object({ currentPassword: z.string().max(200).optional(), newPassword: password }).strict().parse(req.body);
    const row = (await db.query('SELECT password_hash,login_email FROM users WHERE id=$1', [user.id])).rows[0];
    if (!row?.login_email) deny(400, 'PASSWORD_NOT_AVAILABLE', 'This account signs in with DingTalk');
    if (row.password_hash && !(await verifyPassword(input.currentPassword || '', row.password_hash))) deny(401, 'INVALID_CREDENTIALS', 'Email or password is incorrect');
    await db.query('UPDATE users SET password_hash=$2 WHERE id=$1', [user.id, await hashPassword(input.newPassword)]);
    await db.query('DELETE FROM sessions WHERE user_id=$1 AND token_hash<>$2', [user.id, hash(req.sessionToken || '')]);
    return { changed: true };
  });

  // ---- Email one-time code ------------------------------------------------------
  app.post('/auth/email-code', async (req, reply) => {
    if (!o.mailer) deny(501, 'EMAIL_NOT_CONFIGURED', 'Email sign-in is not configured');
    const input = z.object({ email }).strict().parse(req.body);
    limit('code-global', 120, 60_000);
    limit('code:' + hash(input.email), 5, 15 * 60_000);
    const user = (await db.query("SELECT id FROM users WHERE lower(login_email)=$1 AND login_email<>'' AND active=true AND disabled_at IS NULL", [input.email])).rows[0];
    if (user) {
      const code = String(randomInt(0, 1_000_000)).padStart(6, '0');
      await db.query(`INSERT INTO login_codes(email,code_hash,expires_at,attempts,created_at) VALUES($1,$2,$3,0,now())
        ON CONFLICT(email) DO UPDATE SET code_hash=excluded.code_hash,expires_at=excluded.expires_at,attempts=0,created_at=now()`, [input.email, hash(input.email + ':' + code), new Date(Date.now() + CODE_MINUTES * 60_000).toISOString()]);
      try {
        await o.mailer({ to: input.email, subject: `WorkOS 登录验证码 ${code} / Sign-in code`, text: `您的 WorkOS 登录验证码：${code}（${CODE_MINUTES} 分钟内有效）\nYour WorkOS sign-in code: ${code} (valid ${CODE_MINUTES} minutes)`, html: `<p>您的 WorkOS 登录验证码 / Your sign-in code:</p><p style="font-size:28px;letter-spacing:6px;font-weight:700">${code}</p><p style="color:#666">${CODE_MINUTES} 分钟内有效 · valid ${CODE_MINUTES} minutes</p>` });
      } catch { deny(502, 'EMAIL_DELIVERY_FAILED', 'The email could not be sent, try again later'); }
    }
    reply.code(202);
    return { sent: true };
  });

  app.post('/auth/email-code/verify', async (req, reply) => {
    if (!o.mailer) deny(501, 'EMAIL_NOT_CONFIGURED', 'Email sign-in is not configured');
    const input = z.object({ email, code: z.string().regex(/^\d{6}$/) }).strict().parse(req.body);
    limit('verify-global', 600, 60_000);
    const userId = await db.transaction(async tx => {
      const row = (await tx.query('SELECT * FROM login_codes WHERE email=$1 FOR UPDATE', [input.email])).rows[0];
      if (!row || new Date(row.expires_at).getTime() < Date.now() || row.attempts >= 5) deny(401, 'INVALID_CODE', 'The code is incorrect or has expired');
      if (row.code_hash !== hash(input.email + ':' + input.code)) {
        await tx.query('UPDATE login_codes SET attempts=attempts+1 WHERE email=$1', [input.email]);
        return null;
      }
      await tx.query('DELETE FROM login_codes WHERE email=$1', [input.email]);
      const user = (await tx.query("SELECT id FROM users WHERE lower(login_email)=$1 AND login_email<>'' AND active=true AND disabled_at IS NULL", [input.email])).rows[0];
      return user?.id || null;
    });
    if (!userId) deny(401, 'INVALID_CODE', 'The code is incorrect or has expired');
    return signIn(reply, userId);
  });
}

/** Columns for the admin member list (adds lifecycle fields). */
export const ADMIN_MEMBER_COLUMNS = `${PUBLIC_USER_COLUMNS},active,is_admin,role_override,grants,disabled_at,login_email,(password_hash IS NOT NULL) AS has_password,invited_by,email_locked`;
