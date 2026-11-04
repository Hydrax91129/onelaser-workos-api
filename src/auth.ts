import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import type { Queryable } from './db.js';

export type User = { id: string; org_id: string; department_id: string; display_name: string; role: 'employee' | 'manager'; active: boolean; /** set per request once reporting lines exist: the task owners this user may see (self + direct/indirect reports) */ visibleOwnerIds?: string[] | null; /** set per request: people whose second leader (dotted line) is this user; they are also in visibleOwnerIds (same rights as the first leader). */ dottedOwnerIds?: string[] };
export function hash(value: string) { return createHash('sha256').update(value).digest('hex'); }
export function sameSecret(a: string, b: string) { return timingSafeEqual(Buffer.from(hash(a)), Buffer.from(hash(b))); }
export async function issueSession(db: Queryable, userId: string) {
  const token = randomBytes(32).toString('base64url');
  const csrfToken = randomBytes(32).toString('base64url');
  const expiresAt = new Date(Date.now() + 60 * 60 * 1000).toISOString();
  await db.query('INSERT INTO sessions(token_hash,user_id,expires_at,csrf_token) VALUES($1,$2,$3,$4)', [hash(token),userId,expiresAt,csrfToken]);
  return { accessToken: token, tokenType: 'Bearer', expiresAt };
}
export async function resolveSession(db: Queryable, header?: string): Promise<User | null> {
  const token = /^Bearer ([A-Za-z0-9_-]{43})$/.exec(header || '')?.[1];
  if (!token) return null;
  const { rows } = await db.query<User>('SELECT u.* FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token_hash=$1 AND s.expires_at>now() AND u.active=true', [hash(token)]);
  return rows[0] || null;
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
export function cookie(name:string,value:string,secure:boolean,maxAge=3600) {
  return `${name}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${secure?'; Secure':''}`;
}
