/* File storage: where uploaded file bytes live (RMA photos, task attachments, feedback screenshots).
 *
 * FILE_STORAGE=db (default) keeps bytes in PostgreSQL, as before. FILE_STORAGE=s3 writes new files to a
 * private S3-compatible bucket (Alibaba Cloud OSS, Cloudflare R2, AWS S3) and keeps only the object key
 * in the database. Downloads always go through the API (never a public or redirected bucket URL), so the
 * existing permission checks and security headers apply unchanged.
 *
 * Reads follow each row: a row with a storage key is read from the bucket, a row with bytes is read from
 * the database. Old rows keep working after the switch, and switching back to db only stops new writes to
 * the bucket (the bucket settings must stay configured while rows still point at it).
 *
 * Requests are signed with AWS Signature Version 4 using node:crypto; no SDK is needed. */
import { createHash, createHmac } from 'node:crypto';
import { deny } from './errors.js';

export interface ObjectStore {
  put(key: string, data: Buffer, contentType: string): Promise<void>;
  get(key: string): Promise<Buffer>;
  delete(key: string): Promise<void>;
}
export type FileStorage = { mode: 'db' | 's3'; store: ObjectStore | null };
export type S3Config = { endpoint: string; bucket: string; region: string; accessKeyId: string; secretAccessKey: string; pathStyle?: boolean; prefix?: string; fetch?: typeof fetch; timeoutMs?: number };

export const dbOnlyStorage: FileStorage = { mode: 'db', store: null };

const sha256 = (v: string | Buffer) => createHash('sha256').update(v).digest('hex');
const hmac = (key: string | Buffer, v: string) => createHmac('sha256', key).update(v).digest();
/** RFC 3986 encoding used by SigV4 (encodeURIComponent leaves !'()* unescaped). */
const rfc3986 = (v: string) => encodeURIComponent(v).replace(/[!'()*]/g, c => '%' + c.charCodeAt(0).toString(16).toUpperCase());

/** Signs a request in place (adds x-amz-date, x-amz-content-sha256 and authorization). Exported for the AWS test vector. */
export function signV4(req: { method: string; url: URL; headers: Record<string, string>; payloadHash: string },
  cred: { accessKeyId: string; secretAccessKey: string; region: string }, now: Date) {
  const amzDate = now.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, ''), day = amzDate.slice(0, 8);
  req.headers['x-amz-date'] = amzDate; req.headers['x-amz-content-sha256'] = req.payloadHash;
  const headers = { ...Object.fromEntries(Object.entries(req.headers).map(([k, v]) => [k.toLowerCase(), String(v).trim().replace(/\s+/g, ' ')])), host: req.url.host };
  const names = Object.keys(headers).sort(), signed = names.join(';');
  const query = [...req.url.searchParams].map(([k, v]) => [rfc3986(k), rfc3986(v)]).sort((a, b) => a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : a[1] < b[1] ? -1 : 1).map(p => p.join('=')).join('&');
  const canonical = [req.method, req.url.pathname || '/', query, names.map(n => `${n}:${(headers as any)[n]}\n`).join(''), signed, req.payloadHash].join('\n');
  const scope = `${day}/${cred.region}/s3/aws4_request`;
  const toSign = ['AWS4-HMAC-SHA256', amzDate, scope, sha256(canonical)].join('\n');
  const key = hmac(hmac(hmac(hmac('AWS4' + cred.secretAccessKey, day), cred.region), 's3'), 'aws4_request');
  const signature = createHmac('sha256', key).update(toSign).digest('hex');
  req.headers.authorization = `AWS4-HMAC-SHA256 Credential=${cred.accessKeyId}/${scope}, SignedHeaders=${signed}, Signature=${signature}`;
  return signature;
}

export class StorageError extends Error { constructor(message: string, public status?: number) { super(message); } }

export function s3Store(c: S3Config): ObjectStore & { urlFor(key: string): URL } {
  const doFetch = c.fetch || fetch, base = new URL(c.endpoint.replace(/\/+$/, ''));
  const prefix = (c.prefix || '').replace(/^\/+|\/+$/g, '');
  const urlFor = (key: string) => {
    const path = [prefix, key].filter(Boolean).join('/').split('/').map(rfc3986).join('/');
    const u = new URL(base.href);
    if (c.pathStyle) u.pathname = `${base.pathname.replace(/\/$/, '')}/${rfc3986(c.bucket)}/${path}`;
    else { u.hostname = `${c.bucket}.${base.hostname}`; u.pathname = `${base.pathname.replace(/\/$/, '')}/${path}`; }
    return u;
  };
  async function send(method: 'PUT' | 'GET' | 'DELETE', key: string, body?: Buffer, contentType?: string) {
    const url = urlFor(key), headers: Record<string, string> = {};
    if (body) headers['content-type'] = contentType || 'application/octet-stream';
    signV4({ method, url, headers, payloadHash: sha256(body || '') }, c, new Date());
    let res: Response;
    try { res = await doFetch(url, { method, headers, body: body ? new Uint8Array(body) : undefined, signal: AbortSignal.timeout(c.timeoutMs || 20000), redirect: 'error' }); }
    catch (e: any) { throw new StorageError(`Object storage request failed: ${e?.name || 'network error'}`); }
    if (!res.ok && !(method === 'DELETE' && res.status === 404)) {
      const text = await res.text().catch(() => ''), code = /<Code>([^<]{1,80})<\/Code>/.exec(text)?.[1];
      throw new StorageError(`Object storage answered ${res.status}${code ? ' ' + code : ''}`, res.status);
    }
    return res;
  }
  return {
    urlFor,
    async put(key, data, contentType) { await send('PUT', key, data, contentType); },
    async get(key) { return Buffer.from(await (await send('GET', key)).arrayBuffer()); },
    async delete(key) { await send('DELETE', key); },
  };
}

const S3_KEYS = ['S3_ENDPOINT', 'S3_BUCKET', 'S3_REGION', 'S3_ACCESS_KEY_ID', 'S3_SECRET_ACCESS_KEY'] as const;
/** Bucket settings when all are present; null when none are; an error when only some are (a typo must not go unnoticed). */
export function s3ConfigFromEnv(env: NodeJS.ProcessEnv): S3Config | null {
  const present = S3_KEYS.filter(k => env[k]?.trim());
  if (!present.length) return null;
  if (present.length < S3_KEYS.length) throw new Error(`Object storage is partly configured; missing ${S3_KEYS.filter(k => !present.includes(k)).join(', ')}`);
  const endpoint = env.S3_ENDPOINT!.trim();
  if (!/^https:\/\//.test(endpoint) && !/^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?/.test(endpoint)) throw new Error('S3_ENDPOINT must be an https:// URL');
  return { endpoint, bucket: env.S3_BUCKET!.trim(), region: env.S3_REGION!.trim(), accessKeyId: env.S3_ACCESS_KEY_ID!.trim(), secretAccessKey: env.S3_SECRET_ACCESS_KEY!.trim(),
    pathStyle: env.S3_FORCE_PATH_STYLE === 'true', prefix: env.S3_PREFIX?.trim() || '' };
}
export function fileStorageFromEnv(env: NodeJS.ProcessEnv): FileStorage {
  const mode = (env.FILE_STORAGE || 'db').trim().toLowerCase();
  if (mode !== 'db' && mode !== 's3') throw new Error('FILE_STORAGE must be db or s3');
  const config = s3ConfigFromEnv(env);
  if (mode === 's3' && !config) throw new Error('FILE_STORAGE=s3 needs S3_ENDPOINT, S3_BUCKET, S3_REGION, S3_ACCESS_KEY_ID and S3_SECRET_ACCESS_KEY');
  return { mode, store: config ? s3Store(config) : null };
}

/** Object key: org/<org>/<area>/<parent>/<file id>. Ids are server-generated; anything else is replaced. */
export const objectKey = (orgId: string, area: 'rma' | 'tasks' | 'feedback', parentId: string, fileId: string) =>
  ['org', orgId, area, parentId, fileId].map(s => String(s).replace(/[^A-Za-z0-9_-]/g, '_')).join('/');

const unavailable = (): never => deny(503, 'FILE_STORAGE_UNAVAILABLE', 'File storage is temporarily unavailable. Please try again.', '文件存储暂时不可用，请稍后再试。');

/** Stores bytes for a new file. Returns the columns to save: bytes (db mode) or a key (s3 mode). */
export async function storeFile(fs: FileStorage, key: string, data: Buffer, contentType: string): Promise<{ data: Buffer | null; storageKey: string | null }> {
  if (fs.mode === 'db' || !fs.store) return { data, storageKey: null };
  try { await fs.store.put(key, data, contentType); } catch { unavailable(); }
  return { data: null, storageKey: key };
}
/** Reads a file's bytes from where its row says they are. */
export async function readFile(fs: FileStorage, row: { data?: Buffer | Uint8Array | string | null; storage_key?: string | null }, encoding?: 'base64'): Promise<Buffer> {
  if (row.storage_key) {
    if (!fs.store) unavailable();
    try { return await fs.store!.get(row.storage_key); } catch (e) { if (e instanceof StorageError && e.status === 404) deny(404, 'NOT_FOUND', 'File not found', '找不到这个文件。'); unavailable(); }
  }
  if (row.data == null) deny(404, 'NOT_FOUND', 'File not found', '找不到这个文件。');
  return typeof row.data === 'string' ? Buffer.from(row.data, encoding || 'base64') : Buffer.from(row.data as Uint8Array);
}
/** Best-effort removal of objects whose database row was never written. A leftover object is harmless (never referenced). */
export async function discardFiles(fs: FileStorage, keys: (string | null | undefined)[]) {
  if (!fs.store) return;
  await Promise.all(keys.filter((k): k is string => !!k).map(k => fs.store!.delete(k).catch(() => undefined)));
}
