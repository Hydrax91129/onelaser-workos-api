import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import type { Queryable } from './db.js';

export type User = { id: string; org_id: string; department_id: string; display_name: string; role: 'employee' | 'manager'; active: boolean; /** set per request once reporting lines exist: the task owners this user may see (self + direct/indirect reports) */ visibleOwnerIds?: string[] | null; /** set per request: people whose second leader (dotted line) is this user; they are also in visibleOwnerIds (same rights as the first leader). */ dottedOwnerIds?: string[] };
export function hash(value: string) { return createHash('sha256').update(value).digest('hex'); }
export function sameSecret(a: string, b: string) { return timingSafeEqual(Buffer.from(hash(a)), Buffer.from(hash(b))); }
/** Sign-in lifetime (owner, 2026-11-14: people were signed out after a fixed hour while working; 24 idle hours, owner the same day).
 *  A session stays alive while it is used: every request pushes the end out to SESSION_IDLE_HOURS from now,
 *  never past SESSION_MAX_DAYS after sign-in. Leaving the browser alone that long signs the person out. */
export const SESSION_IDLE_HOURS = 24, SESSION_MAX_DAYS = 7;
const IDLE_MS = SESSION_IDLE_HOURS * 3600_000, MAX_MS = SESSION_MAX_DAYS * 86400_000;
/** The cookie lives as long as the longest possible session; the server decides when it actually ends. */
export const SESSION_COOKIE_SECONDS = SESSION_MAX_DAYS * 86400;
export async function issueSession(db: Queryable, userId: string) {
  const token = randomBytes(32).toString('base64url');
  const csrfToken = randomBytes(32).toString('base64url');
  const expiresAt = new Date(Date.now() + IDLE_MS).toISOString();
  await db.query('INSERT INTO sessions(token_hash,user_id,expires_at,csrf_token,created_at) VALUES($1,$2,$3,$4,now())', [hash(token),userId,expiresAt,csrfToken]);
  return { accessToken: token, tokenType: 'Bearer', expiresAt };
}
export async function resolveSession(db: Queryable, header?: string): Promise<User | null> {
  const token = /^Bearer ([A-Za-z0-9_-]{43})$/.exec(header || '')?.[1];
  if (!token) return null;
  const { rows } = await db.query<User & { s_expires: any; s_created: any }>('SELECT u.*, s.expires_at AS s_expires, s.created_at AS s_created FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token_hash=$1 AND s.expires_at>now() AND u.active=true', [hash(token)]);
  const row = rows[0];
  if (!row) return null;
  // Slide the end forward while the session is used, at most once every 5 minutes, capped at the absolute limit.
  const now = Date.now(), end = Math.min(now + IDLE_MS, new Date(row.s_created).getTime() + MAX_MS);
  if (end - new Date(row.s_expires).getTime() > 5 * 60_000) await db.query('UPDATE sessions SET expires_at=$2 WHERE token_hash=$1', [hash(token), new Date(end).toISOString()]);
  const { s_expires: _e, s_created: _c, ...user } = row;
  return user as User;
}

export function sessionCookieName(secure:boolean) {return secure?'__Host-workos_session':'workos_session';}
export function oauthCookieName(secure:boolean) {return secure?'__Host-workos_oauth':'workos_oauth';}
export function readCookie(header:string|undefined,name:string) {
  const values=(header||'').split(';').map(p=>p.trim());
  const match=values.find(value=>value.startsWith(name+'='));
  if(!match)return undefined;
  const value=match.slice(name.length+1);
  return /^[A-Za-z0-9_-]{43}$/.test(value)?value:undefined;
}
export function cookie(name:string,value:string,secure:boolean,maxAge=SESSION_COOKIE_SECONDS) {
  return `${name}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${secure?'; Secure':''}`;
}
