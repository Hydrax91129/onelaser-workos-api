/* "Bug 与建议": anyone signed in can send a short note with screenshots. Every note is stored
 * (admins read them on the Feedback page) and, when email is configured, sent to the feedback
 * inbox (FEEDBACK_EMAIL, default admin@1laser.com) with the screenshots attached. */
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { Database } from './db.js';
import type { User } from './auth.js';
import type { Mailer } from './members.js';
import { deny } from './errors.js';
import { dbOnlyStorage, discardFiles, objectKey, readFile, storeFile, type FileStorage } from './files.js';

export const feedbackSchema = `
CREATE TABLE IF NOT EXISTS feedback(id text PRIMARY KEY, org_id text NOT NULL, user_id text NOT NULL, body text NOT NULL DEFAULT '', page text NOT NULL DEFAULT '',
  images jsonb NOT NULL DEFAULT '[]', status text NOT NULL DEFAULT 'new', emailed boolean NOT NULL DEFAULT false, created_at timestamptz NOT NULL DEFAULT now());
CREATE INDEX IF NOT EXISTS feedback_org ON feedback(org_id,created_at);
`;
const MAX_IMAGES = 6, MAX_IMAGE_BYTES = 3 * 1024 * 1024;
const TYPES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'] as const;
const esc = (v: string) => v.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));

export async function registerFeedbackRoutes(app: FastifyInstance, db: Database, o: { isAdmin: (u: User) => boolean; mailer: Mailer | null; to?: string; appUrl?: string; files?: FileStorage }) {
  const files = o.files || dbOnlyStorage;
  const actorOf = (req: FastifyRequest): User => req.actor || deny(401, 'UNAUTHENTICATED', 'Authentication is required');
  const to = o.to || 'admin@1laser.com';
  const input = z.object({
    body: z.string().trim().max(5000).default(''), page: z.string().trim().max(100).default(''),
    images: z.array(z.object({ name: z.string().trim().max(120).default('image'), type: z.enum(TYPES), data: z.string().max(Math.ceil(MAX_IMAGE_BYTES * 4 / 3) + 8).regex(/^[A-Za-z0-9+/=]+$/) }).strict()).max(MAX_IMAGES).default([]),
  }).strict();

  app.post('/feedback', { bodyLimit: MAX_IMAGES * Math.ceil(MAX_IMAGE_BYTES * 4 / 3) + 64 * 1024 }, async (req, reply) => {
    const u = actorOf(req), v = input.parse(req.body);
    if (!v.body && !v.images.length) deny(400, 'FEEDBACK_EMPTY', 'Write a few words or add a screenshot');
    for (const im of v.images) if (Buffer.from(im.data, 'base64').length > MAX_IMAGE_BYTES) deny(400, 'FEEDBACK_IMAGE_TOO_LARGE', 'Each screenshot must be 3 MB or smaller');
    const id = randomUUID(), images: { name: string; type: string; data?: string; key?: string; size?: number }[] = [];
    try {
      for (const [i, im] of v.images.entries()) {
        const bytes = Buffer.from(im.data, 'base64'), stored = await storeFile(files, objectKey(u.org_id, 'feedback', id, String(i)), bytes, im.type);
        images.push(stored.storageKey ? { name: im.name, type: im.type, key: stored.storageKey, size: bytes.length } : { name: im.name, type: im.type, data: im.data });
      }
      await db.query('INSERT INTO feedback(id,org_id,user_id,body,page,images) VALUES($1,$2,$3,$4,$5,$6)', [id, u.org_id, u.id, v.body, v.page, JSON.stringify(images)]);
    } catch (e) { await discardFiles(files, images.map(im => im.key)); throw e; }
    let emailed = false;
    if (o.mailer) {
      const who = (u as any).display_name || u.id, when = new Date().toISOString().replace('T', ' ').slice(0, 16) + ' UTC';
      const subject = `[craftos 反馈] ${who}：${(v.body || '截图').replace(/\s+/g, ' ').slice(0, 60)}`;
      const text = `提交人：${who}\n页面：${v.page || '—'}\n时间：${when}\n\n${v.body || '（只有截图）'}\n\n截图 ${v.images.length} 张（见附件）`;
      const html = `<p><b>提交人：</b>${esc(who)}<br><b>页面：</b>${esc(v.page || '—')}<br><b>时间：</b>${when}</p><p style="white-space:pre-wrap">${esc(v.body || '（只有截图）')}</p><p>截图 ${v.images.length} 张（见附件）${o.appUrl ? ` · <a href="${esc(o.appUrl)}/#feedback">在 craftos 里查看</a>` : ''}</p>`;
      try {
        await o.mailer({ to, subject, text, html, attachments: v.images.map((im, i) => ({ filename: `${i + 1}-${im.name.replace(/[^\w.\-]+/g, '_') || 'image'}${/\.\w+$/.test(im.name) ? '' : '.' + im.type.split('/')[1]}`, content: im.data })) });
        emailed = true; await db.query('UPDATE feedback SET emailed=true WHERE id=$1', [id]);
      } catch { /* stored anyway; admins still see it on the Feedback page */ }
    }
    reply.code(201);
    return { id, stored: true, emailed };
  });

  app.get('/feedback', async req => {
    const u = actorOf(req); if (!o.isAdmin(u)) deny(403, 'FORBIDDEN', 'Administrator access is required');
    const rows = (await db.query(`SELECT f.id,f.user_id,f.body,f.page,f.status,f.emailed,f.created_at,jsonb_array_length(f.images) AS image_count,p.display_name
      FROM feedback f LEFT JOIN users p ON p.id=f.user_id WHERE f.org_id=$1 ORDER BY f.created_at DESC LIMIT 300`, [u.org_id])).rows;
    return { items: rows, emailConfigured: !!o.mailer, to };
  });
  app.get<{ Params: { id: string; n: string } }>('/feedback/:id/images/:n', async (req, reply) => {
    const u = actorOf(req); if (!o.isAdmin(u)) deny(403, 'FORBIDDEN', 'Administrator access is required');
    const row = (await db.query('SELECT images FROM feedback WHERE id=$1 AND org_id=$2', [String(req.params.id).slice(0, 100), u.org_id])).rows[0];
    const im = row?.images?.[Number(req.params.n)];
    if (!im) deny(404, 'NOT_FOUND', 'Image not found');
    const bytes = await readFile(files, { data: im.data ?? null, storage_key: im.key ?? null }, 'base64');
    return reply.header('Content-Type', im.type).header('Cache-Control', 'private, max-age=86400').header('X-Content-Type-Options', 'nosniff').header('Content-Security-Policy', "default-src 'none'").send(bytes);
  });
  app.post<{ Params: { id: string } }>('/feedback/:id/status', async req => {
    const u = actorOf(req); if (!o.isAdmin(u)) deny(403, 'FORBIDDEN', 'Administrator access is required');
    const v = z.object({ status: z.enum(['new', 'done']) }).strict().parse(req.body);
    const r = await db.query('UPDATE feedback SET status=$3 WHERE id=$1 AND org_id=$2 RETURNING id,status', [String(req.params.id).slice(0, 100), u.org_id, v.status]);
    if (!r.rows[0]) deny(404, 'NOT_FOUND', 'Feedback not found');
    return r.rows[0];
  });
}
