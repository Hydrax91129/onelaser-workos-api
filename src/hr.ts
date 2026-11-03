/* HR: employee records (phase 1 of docs/plans/2026-11-02-hrm.md).
 *
 *   hr_profiles   employment facts: hire date, type, probation, contract, level, status, last day, consent
 *   hr_secrets    ID number, bank account and emergency phone, encrypted; `hint` keeps only the last 4 characters
 *   hr_salary     salary history, each amount encrypted
 *   hr_documents  contract scans and certificates, encrypted, with an optional expiry date
 *   hr_events     append-only employment history
 *
 * Access: HR = WORKOS_HR_USER_IDS (deployment config only; company admins are not HR by default) sees and edits everyone.
 * Managers see the non-sensitive profile and history of their direct and indirect reports. Everyone sees their own
 * record, including their own sensitive values. Sensitive values are masked in every read; revealing one is a separate,
 * audited request (HR must give a reason). Values never go into audit details, errors, the inbox or logs.
 *
 * Encryption: AES-256-GCM with HR_DATA_KEY (32 random bytes, base64). Each value records the key id, so a new key can be
 * introduced with the old one kept in HR_DATA_KEY_PREVIOUS. The person and field are bound as associated data, so a
 * ciphertext copied onto another person or field fails to decrypt. Without a valid key the sensitive endpoints answer 501
 * and the rest of HR still works. */
import { createCipheriv, createDecipheriv, createHash, randomBytes, randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { Database, Queryable } from './db.js';
import type { User } from './auth.js';
import { deny } from './errors.js';
import { pushInbox } from './inbox.js';

export const hrSchema = `
CREATE TABLE IF NOT EXISTS hr_profiles(user_id text PRIMARY KEY REFERENCES users(id), org_id text NOT NULL, hire_date date, employment_type text NOT NULL DEFAULT 'full_time',
  probation_end date, contract_start date, contract_end date, job_level text NOT NULL DEFAULT '', work_location text NOT NULL DEFAULT '', status text NOT NULL DEFAULT 'active',
  last_day date, bank_name text NOT NULL DEFAULT '', emergency_name text NOT NULL DEFAULT '', emergency_relation text NOT NULL DEFAULT '', consent_date date, consent_version text NOT NULL DEFAULT '',
  notes text NOT NULL DEFAULT '', version integer NOT NULL DEFAULT 1, updated_by text, updated_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE IF NOT EXISTS hr_secrets(org_id text NOT NULL, user_id text NOT NULL REFERENCES users(id), field text NOT NULL, ciphertext text NOT NULL, key_id text NOT NULL,
  hint text NOT NULL DEFAULT '', updated_by text NOT NULL, updated_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(user_id, field));
CREATE TABLE IF NOT EXISTS hr_salary(id text PRIMARY KEY, org_id text NOT NULL, user_id text NOT NULL REFERENCES users(id), effective_date date NOT NULL, ciphertext text NOT NULL,
  key_id text NOT NULL, reason text NOT NULL DEFAULT '', created_by text NOT NULL, created_at timestamptz NOT NULL DEFAULT now());
CREATE INDEX IF NOT EXISTS hr_salary_user ON hr_salary(user_id, effective_date);
CREATE TABLE IF NOT EXISTS hr_documents(id text PRIMARY KEY, org_id text NOT NULL, user_id text NOT NULL REFERENCES users(id), kind text NOT NULL, name text NOT NULL, mime text NOT NULL,
  size integer NOT NULL, data bytea NOT NULL, key_id text NOT NULL, expires_on date, uploader_id text NOT NULL, created_at timestamptz NOT NULL DEFAULT now());
CREATE INDEX IF NOT EXISTS hr_documents_user ON hr_documents(user_id);
CREATE TABLE IF NOT EXISTS hr_events(id text PRIMARY KEY, org_id text NOT NULL, user_id text NOT NULL REFERENCES users(id), kind text NOT NULL, happened_on date NOT NULL,
  note text NOT NULL DEFAULT '', actor_id text NOT NULL, created_at timestamptz NOT NULL DEFAULT now());
CREATE INDEX IF NOT EXISTS hr_events_user ON hr_events(user_id, happened_on);
CREATE TABLE IF NOT EXISTS hr_reminder_log(key text PRIMARY KEY, created_at timestamptz NOT NULL DEFAULT now());
`;

export type HrOptions = { userIds?: string[]; dataKey?: string; previousKeys?: string[] };
export function hrOptionsFromEnv(env: NodeJS.ProcessEnv): HrOptions {
  const list = (v?: string) => (v || '').split(',').map(x => x.trim()).filter(Boolean);
  return { userIds: list(env.WORKOS_HR_USER_IDS), dataKey: env.HR_DATA_KEY, previousKeys: list(env.HR_DATA_KEY_PREVIOUS) };
}

/* ---------- encryption ---------- */
type Keyring = { status: 'configured' | 'not_configured' | 'invalid_key'; currentId: string | null; keys: Map<string, Buffer> };
const keyId = (key: Buffer) => createHash('sha256').update(key).digest('hex').slice(0, 12);
const decodeKey = (v: string) => { const b = /^[A-Za-z0-9+/]+={0,2}$/.test(v.trim()) ? Buffer.from(v.trim(), 'base64') : Buffer.alloc(0); return b.length === 32 ? b : null; };
export function keyringFrom(o: HrOptions): Keyring {
  if (!o.dataKey) return { status: 'not_configured', currentId: null, keys: new Map() };
  const current = decodeKey(o.dataKey);
  if (!current) return { status: 'invalid_key', currentId: null, keys: new Map() };
  const keys = new Map([[keyId(current), current]]);
  for (const v of o.previousKeys || []) { const k = decodeKey(v); if (k) keys.set(keyId(k), k); }
  return { status: 'configured', currentId: keyId(current), keys };
}
function seal(ring: Keyring, plain: Buffer, aad: string) {
  const key = ring.keys.get(ring.currentId!)!, iv = randomBytes(12), c = createCipheriv('aes-256-gcm', key, iv);
  c.setAAD(Buffer.from(aad));
  const body = Buffer.concat([c.update(plain), c.final()]);
  return { data: Buffer.concat([iv, c.getAuthTag(), body]), keyId: ring.currentId! };
}
function open(ring: Keyring, data: Buffer, kid: string, aad: string) {
  const key = ring.keys.get(kid);
  if (!key) deny(409, 'HR_KEY_UNAVAILABLE', 'This value was saved with a data key that is no longer configured');
  try {
    const d = createDecipheriv('aes-256-gcm', key, data.subarray(0, 12));
    d.setAAD(Buffer.from(aad)); d.setAuthTag(data.subarray(12, 28));
    return Buffer.concat([d.update(data.subarray(28)), d.final()]);
  } catch { return deny(409, 'HR_DECRYPT_FAILED', 'This value could not be decrypted'); }
}
const sealText = (ring: Keyring, text: string, aad: string) => { const s = seal(ring, Buffer.from(text, 'utf8'), aad); return { ciphertext: s.data.toString('base64'), keyId: s.keyId }; };
const openText = (ring: Keyring, ciphertext: string, kid: string, aad: string) => open(ring, Buffer.from(ciphertext, 'base64'), kid, aad).toString('utf8');

/* ---------- constants and inputs ---------- */
export const SECRET_FIELDS = ['idNumber', 'bankAccount', 'emergencyPhone'] as const;
type SecretField = typeof SECRET_FIELDS[number];
const EMPLOYMENT = ['full_time', 'part_time', 'intern', 'contractor', 'other'] as const;
const STATUSES = ['active', 'leaving', 'left'] as const;
const EVENT_KINDS = ['joined', 'probation_passed', 'contract_renewed', 'title_change', 'transfer', 'promotion', 'warning', 'leaving', 'left', 'other'] as const;
const DOC_KINDS = ['contract', 'id', 'certificate', 'education', 'other'] as const;
const DOC_MIME = new Set(['application/pdf', 'image/png', 'image/jpeg', 'image/webp']);
const MAX_DOC = 10 * 1024 * 1024, MAX_DOCS = 50, DAY = 86_400_000;
const id = z.string().min(1).max(100).regex(/^[A-Za-z0-9_-]+$/);
const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use a date like 2026-11-02')
  .refine(v => { const d = new Date(v + 'T00:00:00Z'); return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === v; }, 'Use a real calendar date');
const text = (max: number) => z.string().trim().max(max);
const ymd = (v: any) => v ? (v instanceof Date ? v.toISOString().slice(0, 10) : String(v).slice(0, 10)) : null;
const nameOf = (u: any) => u ? (u.display_name || u.name_zh || u.name_en || u.id) : '';
const hintOf = (v: string) => { const c = v.replace(/\s+/g, ''); return c.length > 4 ? '****' + c.slice(-4) : '****'; };

const profileInput = z.object({
  expectedVersion: z.number().int().min(0),
  hireDate: day.nullable().optional(), employmentType: z.enum(EMPLOYMENT).optional(), probationEnd: day.nullable().optional(),
  contractStart: day.nullable().optional(), contractEnd: day.nullable().optional(), jobLevel: text(60).optional(), workLocation: text(80).optional(),
  status: z.enum(STATUSES).optional(), lastDay: day.nullable().optional(), bankName: text(80).optional(), emergencyName: text(60).optional(),
  emergencyRelation: text(40).optional(), consentDate: day.nullable().optional(), consentVersion: text(40).optional(), notes: text(4000).optional(),
}).strict();
const secretsInput = z.object({
  idNumber: z.union([z.literal(''), z.string().trim().regex(/^[A-Za-z0-9-]{4,40}$/, 'Invalid ID number')]).optional(),
  bankAccount: z.union([z.literal(''), z.string().trim().regex(/^[0-9 ]{6,40}$/, 'Invalid bank account')]).optional(),
  emergencyPhone: z.union([z.literal(''), z.string().trim().regex(/^[0-9+()\-.\s]{4,40}$/, 'Invalid phone')]).optional(),
}).strict().refine(v => Object.keys(v).length > 0, 'Nothing to change');
const salaryInput = z.object({
  effectiveDate: day, base: z.number().finite().min(0).max(100_000_000), allowance: z.number().finite().min(0).max(100_000_000).default(0),
  currency: z.string().trim().regex(/^[A-Z]{3}$/).default('CNY'), period: z.enum(['month', 'year', 'hour']).default('month'), reason: text(500).default(''),
}).strict();
const revealInput = z.object({ field: z.enum([...SECRET_FIELDS, 'salary']), reason: text(300).default('') }).strict();
const eventInput = z.object({ kind: z.enum(EVENT_KINDS), happenedOn: day, note: text(2000).default('') }).strict();
const docInput = z.object({ kind: z.enum(DOC_KINDS), name: z.string().trim().min(1).max(200), mime: z.string().max(100), dataBase64: z.string().min(4), expiresOn: day.nullable().optional() }).strict();

const PROFILE_COLUMNS: [keyof z.infer<typeof profileInput>, string][] = [
  ['hireDate', 'hire_date'], ['employmentType', 'employment_type'], ['probationEnd', 'probation_end'], ['contractStart', 'contract_start'], ['contractEnd', 'contract_end'],
  ['jobLevel', 'job_level'], ['workLocation', 'work_location'], ['status', 'status'], ['lastDay', 'last_day'], ['bankName', 'bank_name'], ['emergencyName', 'emergency_name'],
  ['emergencyRelation', 'emergency_relation'], ['consentDate', 'consent_date'], ['consentVersion', 'consent_version'], ['notes', 'notes'],
];
const DATE_COLUMNS = new Set(['hire_date', 'probation_end', 'contract_start', 'contract_end', 'last_day', 'consent_date']);
const SECRET_COLUMN: Record<SecretField, string> = { idNumber: 'id_number', bankAccount: 'bank_account', emergencyPhone: 'emergency_phone' };

export async function registerHrRoutes(app: FastifyInstance, db: Database, o: HrOptions & { now?: () => number; intervalMs?: number }) {
  const now = o.now || Date.now;
  const ring = keyringFrom(o);
  const hrIds = new Set(o.userIds || []);
  const isHr = (u: User) => hrIds.has(u.id);
  const actorOf = (req: FastifyRequest): User => req.actor || deny(401, 'UNAUTHENTICATED', 'Authentication is required');
  const requireHr = (u: User) => { if (!isHr(u)) deny(403, 'HR_ONLY', 'Only HR can do this'); };
  const requireKey = () => { if (ring.status !== 'configured') deny(501, 'HR_KEY_NOT_CONFIGURED', 'Sensitive HR data is not set up: HR_DATA_KEY is missing or invalid'); };
  const today = () => new Date(now()).toISOString().slice(0, 10);
  /** What the actor may see about someone: 'hr' everything, 'self' own record, 'manager' the non-sensitive profile of a report. */
  const accessTo = (u: User, subjectId: string): 'hr' | 'self' | 'manager' | null =>
    isHr(u) ? 'hr' : subjectId === u.id ? 'self' : (u.visibleOwnerIds || []).includes(subjectId) ? 'manager' : null;
  const subjectOf = async (tx: Queryable, u: User, subjectId: string) => {
    const s = (await tx.query('SELECT id,org_id,department_id,display_name,name_zh,name_en,title,email,manager_id,active,disabled_at FROM users WHERE id=$1 AND org_id=$2', [subjectId, u.org_id])).rows[0];
    if (!s || !accessTo(u, s.id)) deny(404, 'NOT_FOUND', 'Person not found');
    return s;
  };
  const audit = (tx: Queryable, u: User, s: any, action: string, details: unknown) =>
    tx.query('INSERT INTO audit_events(id,org_id,department_id,owner_id,actor_id,action,object_id,details) VALUES($1,$2,$3,$4,$5,$6,$7,$8)',
      [randomUUID(), u.org_id, s.department_id, s.id, u.id, action, s.id, JSON.stringify(details)]);
  const event = (tx: Queryable, u: User, subjectId: string, kind: string, on: string, note = '') =>
    tx.query('INSERT INTO hr_events(id,org_id,user_id,kind,happened_on,note,actor_id) VALUES($1,$2,$3,$4,$5,$6,$7)', [randomUUID(), u.org_id, subjectId, kind, on, note.slice(0, 2000), u.id]);
  const aad = (userId: string, field: string) => `hr:${userId}:${field}`;

  const shapeProfile = (p: any) => p ? {
    hireDate: ymd(p.hire_date), employmentType: p.employment_type, probationEnd: ymd(p.probation_end), contractStart: ymd(p.contract_start), contractEnd: ymd(p.contract_end),
    jobLevel: p.job_level, workLocation: p.work_location, status: p.status, lastDay: ymd(p.last_day), bankName: p.bank_name, emergencyName: p.emergency_name,
    emergencyRelation: p.emergency_relation, consentDate: ymd(p.consent_date), consentVersion: p.consent_version, notes: p.notes, version: Number(p.version), updatedAt: p.updated_at,
  } : { status: 'active', employmentType: 'full_time', version: 0 };
  /** Days until a date (negative = already passed), or null. */
  const daysTo = (v: any) => { const d = ymd(v); return d ? Math.round((new Date(d + 'T00:00:00Z').getTime() - new Date(today() + 'T00:00:00Z').getTime()) / DAY) : null; };
  const tenureDays = (p: any) => { const d = daysTo(p?.hire_date); return d === null ? null : Math.max(0, -d); };

  app.get('/hr/access', async req => {
    const u = actorOf(req);
    return { isHr: isHr(u), hasReports: (u.visibleOwnerIds || []).some(x => x !== u.id), sensitive: ring.status };
  });

  app.get('/hr/people', async req => {
    const u = actorOf(req), hr = isHr(u);
    const visible = hr ? null : [...new Set([u.id, ...(u.visibleOwnerIds || [])])];
    const rows = (await db.query(`SELECT u.id,u.display_name,u.name_zh,u.name_en,u.title,u.department_id,u.manager_id,u.active,u.disabled_at,d.name AS department_name,p.*
      FROM users u LEFT JOIN hr_profiles p ON p.user_id=u.id LEFT JOIN departments d ON d.org_id=u.org_id AND d.id=u.department_id
      WHERE u.org_id=$1 ${visible ? 'AND u.id=ANY($2::text[])' : ''} ORDER BY u.active DESC, u.display_name, u.id`, visible ? [u.org_id, visible] : [u.org_id])).rows;
    const names = new Map(rows.map((r: any) => [r.id, nameOf(r)]));
    return {
      items: rows.map((r: any) => ({
        id: r.id, name: nameOf(r), nameZh: r.name_zh, nameEn: r.name_en, title: r.title, departmentId: r.department_id, departmentName: r.department_name || '',
        managerId: r.manager_id, managerName: names.get(r.manager_id) || '', accountActive: r.active && !r.disabled_at, hasProfile: !!r.user_id,
        status: r.status || 'active', employmentType: r.employment_type || 'full_time', hireDate: ymd(r.hire_date), tenureDays: tenureDays(r),
        probationEnd: ymd(r.probation_end), contractEnd: ymd(r.contract_end), lastDay: ymd(r.last_day), jobLevel: r.job_level || '',
        access: accessTo(u, r.id),
      })),
      isHr: hr, sensitive: ring.status,
    };
  });

  app.get<{ Params: { id: string } }>('/hr/people/:id', async req => {
    const u = actorOf(req), s = await subjectOf(db, u, id.parse(req.params.id)), access = accessTo(u, s.id)!;
    const p = (await db.query('SELECT * FROM hr_profiles WHERE user_id=$1', [s.id])).rows[0];
    const profile: any = shapeProfile(p);
    if (access === 'manager') for (const k of ['bankName', 'emergencyName', 'emergencyRelation', 'consentDate', 'consentVersion', 'notes']) delete profile[k];
    if (access === 'self') delete profile.notes;
    const people = new Map((await db.query('SELECT id,display_name,name_zh,name_en FROM users WHERE org_id=$1', [u.org_id])).rows.map((r: any) => [r.id, r]));
    const events = (await db.query('SELECT * FROM hr_events WHERE user_id=$1 ORDER BY happened_on DESC, created_at DESC', [s.id])).rows
      .filter((e: any) => access !== 'manager' || e.kind !== 'warning')
      .map((e: any) => ({ id: e.id, kind: e.kind, happenedOn: ymd(e.happened_on), note: e.note, byName: nameOf(people.get(e.actor_id)), createdAt: e.created_at }));
    const out: any = {
      person: { id: s.id, name: nameOf(s), nameZh: s.name_zh, nameEn: s.name_en, title: s.title, email: s.email, departmentId: s.department_id, managerId: s.manager_id,
        managerName: nameOf(people.get(s.manager_id)), accountActive: s.active && !s.disabled_at },
      profile, events, access, sensitive: ring.status, tenureDays: tenureDays(p),
    };
    if (access !== 'manager') {
      const secrets = (await db.query('SELECT field,hint,updated_at FROM hr_secrets WHERE user_id=$1', [s.id])).rows;
      out.secrets = Object.fromEntries(SECRET_FIELDS.map(f => { const r = secrets.find((x: any) => x.field === SECRET_COLUMN[f]); return [f, r ? { set: true, hint: r.hint, updatedAt: r.updated_at } : { set: false }]; }));
      const sal = (await db.query('SELECT effective_date FROM hr_salary WHERE user_id=$1 ORDER BY effective_date DESC, created_at DESC', [s.id])).rows;
      out.salary = { set: sal.length > 0, records: sal.length, latestEffective: ymd(sal[0]?.effective_date) };
      out.documents = (await db.query('SELECT id,kind,name,mime,size,expires_on,uploader_id,created_at FROM hr_documents WHERE user_id=$1 ORDER BY created_at DESC', [s.id])).rows
        .map((d: any) => ({ id: d.id, kind: d.kind, name: d.name, mime: d.mime, size: Number(d.size), expiresOn: ymd(d.expires_on), daysToExpiry: daysTo(d.expires_on), byName: nameOf(people.get(d.uploader_id)), createdAt: d.created_at }));
    }
    return out;
  });

  app.put<{ Params: { id: string } }>('/hr/people/:id/profile', async req => {
    const u = actorOf(req); requireHr(u);
    const v = profileInput.parse(req.body), subjectId = id.parse(req.params.id);
    return db.transaction(async tx => {
      const s = await subjectOf(tx, u, subjectId);
      const cur = (await tx.query('SELECT * FROM hr_profiles WHERE user_id=$1 FOR UPDATE', [s.id])).rows[0];
      if (Number(cur?.version || 0) !== v.expectedVersion) deny(409, 'VERSION_CONFLICT', 'This record changed since you opened it; reload and try again');
      const changed = PROFILE_COLUMNS.filter(([k, col]) => v[k] !== undefined && String(v[k] ?? '') !== String((DATE_COLUMNS.has(col) ? ymd(cur?.[col]) : cur?.[col]) ?? ''));
      if (!changed.length) return { profile: shapeProfile(cur), changed: [] };
      if (!cur) await tx.query('INSERT INTO hr_profiles(user_id,org_id,version,updated_by) VALUES($1,$2,0,$3)', [s.id, u.org_id, u.id]);
      const sets = changed.map(([, col], i) => `${col}=$${i + 2}`).join(',');
      const row = (await tx.query(`UPDATE hr_profiles SET ${sets},version=version+1,updated_by=$${changed.length + 2},updated_at=now() WHERE user_id=$1 RETURNING *`,
        [s.id, ...changed.map(([k]) => v[k] === '' ? '' : v[k] ?? null), u.id])).rows[0];
      const has = (k: string) => changed.some(([key]) => key === k);
      if (has('hireDate') && row.hire_date && !cur?.hire_date) await event(tx, u, s.id, 'joined', ymd(row.hire_date)!);
      if (has('status') && row.status === 'leaving') await event(tx, u, s.id, 'leaving', ymd(row.last_day) || today());
      if (has('status') && row.status === 'left') await event(tx, u, s.id, 'left', ymd(row.last_day) || today());
      if (has('contractEnd') && cur?.contract_end && row.contract_end) await event(tx, u, s.id, 'contract_renewed', today(), `→ ${ymd(row.contract_end)}`);
      // Field names only: the audit never holds the values.
      await audit(tx, u, s, 'hr.profile.update', { fields: changed.map(([k]) => k) });
      return { profile: shapeProfile(row), changed: changed.map(([k]) => k) };
    });
  });

  app.put<{ Params: { id: string } }>('/hr/people/:id/secrets', async req => {
    const u = actorOf(req); requireHr(u); requireKey();
    const v = secretsInput.parse(req.body), subjectId = id.parse(req.params.id);
    return db.transaction(async tx => {
      const s = await subjectOf(tx, u, subjectId), fields = SECRET_FIELDS.filter(f => v[f] !== undefined);
      for (const f of fields) {
        const col = SECRET_COLUMN[f], value = v[f]!;
        if (!value) { await tx.query('DELETE FROM hr_secrets WHERE user_id=$1 AND field=$2', [s.id, col]); continue; }
        const sealed = sealText(ring, value, aad(s.id, col));
        await tx.query(`INSERT INTO hr_secrets(org_id,user_id,field,ciphertext,key_id,hint,updated_by) VALUES($1,$2,$3,$4,$5,$6,$7)
          ON CONFLICT(user_id,field) DO UPDATE SET ciphertext=EXCLUDED.ciphertext,key_id=EXCLUDED.key_id,hint=EXCLUDED.hint,updated_by=EXCLUDED.updated_by,updated_at=now()`,
          [u.org_id, s.id, col, sealed.ciphertext, sealed.keyId, hintOf(value), u.id]);
      }
      await audit(tx, u, s, 'hr.secrets.update', { fields });
      return { updated: fields };
    });
  });

  app.post<{ Params: { id: string } }>('/hr/people/:id/salary', async (req, reply) => {
    const u = actorOf(req); requireHr(u); requireKey();
    const v = salaryInput.parse(req.body), subjectId = id.parse(req.params.id);
    return db.transaction(async tx => {
      const s = await subjectOf(tx, u, subjectId), rowId = randomUUID();
      const sealed = sealText(ring, JSON.stringify({ base: v.base, allowance: v.allowance, currency: v.currency, period: v.period }), aad(s.id, 'salary:' + rowId));
      await tx.query('INSERT INTO hr_salary(id,org_id,user_id,effective_date,ciphertext,key_id,reason,created_by) VALUES($1,$2,$3,$4,$5,$6,$7,$8)',
        [rowId, u.org_id, s.id, v.effectiveDate, sealed.ciphertext, sealed.keyId, v.reason, u.id]);
      await audit(tx, u, s, 'hr.salary.add', { effectiveDate: v.effectiveDate });
      reply.code(201);
      return { id: rowId, effectiveDate: v.effectiveDate };
    });
  });

  /** Returns one sensitive value in clear. HR must say why; people reading their own record need not. Always audited. */
  app.post<{ Params: { id: string } }>('/hr/people/:id/reveal', async req => {
    const u = actorOf(req), v = revealInput.parse(req.body), subjectId = id.parse(req.params.id);
    return db.transaction(async tx => {
      const s = await subjectOf(tx, u, subjectId), access = accessTo(u, s.id);
      if (access === 'manager') deny(403, 'HR_SENSITIVE_FORBIDDEN', 'Only HR and the person themself can see sensitive details');
      if (access === 'hr' && s.id !== u.id && v.reason.length < 4) deny(400, 'HR_REASON_REQUIRED', 'Give a reason for viewing this detail');
      requireKey();
      let value: unknown;
      if (v.field === 'salary') {
        const rows = (await tx.query('SELECT * FROM hr_salary WHERE user_id=$1 ORDER BY effective_date DESC, created_at DESC', [s.id])).rows;
        const people = new Map((await tx.query('SELECT id,display_name,name_zh,name_en FROM users WHERE org_id=$1', [u.org_id])).rows.map((r: any) => [r.id, r]));
        value = rows.map((r: any) => ({ id: r.id, effectiveDate: ymd(r.effective_date), reason: r.reason, byName: nameOf(people.get(r.created_by)), createdAt: r.created_at, ...JSON.parse(openText(ring, r.ciphertext, r.key_id, aad(s.id, 'salary:' + r.id))) }));
      } else {
        const r = (await tx.query('SELECT ciphertext,key_id FROM hr_secrets WHERE user_id=$1 AND field=$2', [s.id, SECRET_COLUMN[v.field]])).rows[0];
        value = r ? openText(ring, r.ciphertext, r.key_id, aad(s.id, SECRET_COLUMN[v.field])) : null;
      }
      await audit(tx, u, s, 'hr.sensitive.reveal', { field: v.field, reason: v.reason });
      return { field: v.field, value };
    });
  });

  app.post<{ Params: { id: string } }>('/hr/people/:id/events', async (req, reply) => {
    const u = actorOf(req); requireHr(u);
    const v = eventInput.parse(req.body), subjectId = id.parse(req.params.id);
    return db.transaction(async tx => {
      const s = await subjectOf(tx, u, subjectId);
      await event(tx, u, s.id, v.kind, v.happenedOn, v.note);
      await audit(tx, u, s, 'hr.event.add', { kind: v.kind, happenedOn: v.happenedOn });
      reply.code(201);
      return { ok: true };
    });
  });

  app.post<{ Params: { id: string } }>('/hr/people/:id/documents', { bodyLimit: Math.ceil(MAX_DOC * 4 / 3) + 4096 }, async (req, reply) => {
    const u = actorOf(req); requireHr(u); requireKey();
    const v = docInput.parse(req.body), subjectId = id.parse(req.params.id);
    if (!DOC_MIME.has(v.mime)) deny(400, 'HR_DOC_TYPE', 'Documents must be PDF, PNG, JPEG or WebP');
    if (!/^[A-Za-z0-9+/]+={0,2}$/.test(v.dataBase64)) deny(400, 'HR_DOC_INVALID', 'The file could not be read');
    const data = Buffer.from(v.dataBase64, 'base64');
    if (!data.length || data.length > MAX_DOC) deny(400, 'HR_DOC_TOO_LARGE', 'Documents must be 10 MB or smaller');
    return db.transaction(async tx => {
      const s = await subjectOf(tx, u, subjectId);
      if (Number((await tx.query('SELECT count(*)::int n FROM hr_documents WHERE user_id=$1', [s.id])).rows[0].n) >= MAX_DOCS) deny(400, 'HR_DOC_LIMIT', 'A person can have at most 50 documents');
      const docId = randomUUID(), sealed = seal(ring, data, aad(s.id, 'doc:' + docId));
      await tx.query('INSERT INTO hr_documents(id,org_id,user_id,kind,name,mime,size,data,key_id,expires_on,uploader_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)',
        [docId, u.org_id, s.id, v.kind, v.name, v.mime, data.length, sealed.data, sealed.keyId, v.expiresOn || null, u.id]);
      await audit(tx, u, s, 'hr.document.add', { kind: v.kind, documentId: docId });
      reply.code(201);
      return { id: docId };
    });
  });

  app.get<{ Params: { id: string; doc: string } }>('/hr/people/:id/documents/:doc', async (req, reply) => {
    const u = actorOf(req), s = await subjectOf(db, u, id.parse(req.params.id));
    if (accessTo(u, s.id) === 'manager') deny(403, 'HR_SENSITIVE_FORBIDDEN', 'Only HR and the person themself can see sensitive details');
    requireKey();
    const d = (await db.query('SELECT * FROM hr_documents WHERE id=$1 AND user_id=$2', [id.parse(req.params.doc), s.id])).rows[0];
    if (!d) deny(404, 'NOT_FOUND', 'Document not found');
    const data = open(ring, Buffer.from(d.data), d.key_id, aad(s.id, 'doc:' + d.id));
    await audit(db, u, s, 'hr.document.view', { documentId: d.id });
    reply.header('content-type', d.mime).header('cache-control', 'no-store').header('x-content-type-options', 'nosniff')
      .header('content-disposition', `inline; filename*=UTF-8''${encodeURIComponent(d.name)}`);
    return reply.send(data);
  });

  app.delete<{ Params: { id: string; doc: string } }>('/hr/people/:id/documents/:doc', async req => {
    const u = actorOf(req); requireHr(u);
    return db.transaction(async tx => {
      const s = await subjectOf(tx, u, id.parse(req.params.id));
      const d = (await tx.query('DELETE FROM hr_documents WHERE id=$1 AND user_id=$2 RETURNING id,kind', [id.parse(req.params.doc), s.id])).rows[0];
      if (!d) deny(404, 'NOT_FOUND', 'Document not found');
      await audit(tx, u, s, 'hr.document.delete', { kind: d.kind, documentId: d.id });
      return { deleted: true };
    });
  });

  /** Probation endings, contract endings and document expiries in the next 30 days (and anything already overdue that is still open). */
  const dueItems = async (orgId: string) => {
    const horizon = new Date(new Date(today() + 'T00:00:00Z').getTime() + 30 * DAY).toISOString().slice(0, 10);
    const people = (await db.query(`SELECT u.id,u.display_name,u.name_zh,u.name_en,p.probation_end,p.contract_end FROM users u JOIN hr_profiles p ON p.user_id=u.id
      WHERE u.org_id=$1 AND u.active=true AND p.status<>'left'`, [orgId])).rows;
    const out: { key: string; kind: 'probation_end' | 'contract_end' | 'document_expiry'; userId: string; name: string; date: string; days: number; documentName?: string }[] = [];
    for (const p of people) {
      for (const [kind, col] of [['probation_end', 'probation_end'], ['contract_end', 'contract_end']] as const) {
        const d = ymd(p[col]);
        if (d && d <= horizon && daysTo(d)! >= -30) out.push({ key: `${kind}:${p.id}:${d}`, kind, userId: p.id, name: nameOf(p), date: d, days: daysTo(d)! });
      }
    }
    const docs = (await db.query(`SELECT d.id,d.name,d.expires_on,u.id AS user_id,u.display_name,u.name_zh,u.name_en FROM hr_documents d JOIN users u ON u.id=d.user_id
      WHERE d.org_id=$1 AND d.expires_on IS NOT NULL AND d.expires_on<=$2 AND u.active=true`, [orgId, horizon])).rows;
    for (const d of docs) out.push({ key: `document_expiry:${d.id}:${ymd(d.expires_on)}`, kind: 'document_expiry', userId: d.user_id, name: nameOf(d), date: ymd(d.expires_on)!, days: daysTo(d.expires_on)!, documentName: d.name });
    return out.sort((a, b) => a.days - b.days);
  };

  app.get('/hr/reminders', async req => {
    const u = actorOf(req); requireHr(u);
    return { items: await dueItems(u.org_id) };
  });

  /** Inbox reminders to HR at 30 and 7 days before, and on the day. Each threshold is sent once. */
  const REMINDER_TITLES = {
    probation_end: (n: string, d: number) => d > 0 ? `${n} 的试用期还有 ${d} 天结束` : `${n} 的试用期今天结束`,
    contract_end: (n: string, d: number) => d > 0 ? `${n} 的劳动合同还有 ${d} 天到期` : `${n} 的劳动合同今天到期`,
    document_expiry: (n: string, d: number) => d > 0 ? `${n} 的证件或资料还有 ${d} 天到期` : `${n} 的证件或资料今天到期`,
  };
  async function runReminders() {
    if (!hrIds.size) return 0;
    let sent = 0;
    const orgs = (await db.query('SELECT DISTINCT org_id FROM users WHERE id=ANY($1::text[]) AND active=true', [[...hrIds]])).rows.map((r: any) => r.org_id);
    for (const orgId of orgs) {
      const recipients = (await db.query('SELECT id FROM users WHERE org_id=$1 AND id=ANY($2::text[]) AND active=true', [orgId, [...hrIds]])).rows.map((r: any) => r.id);
      for (const item of await dueItems(orgId)) {
        const threshold = [30, 7, 0].find(t => item.days <= t && item.days > (t === 30 ? 7 : t === 7 ? 0 : -1));
        if (threshold === undefined) continue;
        const logged = await db.query('INSERT INTO hr_reminder_log(key) VALUES($1) ON CONFLICT DO NOTHING RETURNING key', [`${item.key}:${threshold}`]);
        if (!logged.rows.length) continue;
        sent += await pushInbox(db, { orgId, recipients, actorId: 'system', kind: 'hr_reminder', title: REMINDER_TITLES[item.kind](item.name, Math.max(0, item.days)), body: item.date });
      }
    }
    return sent;
  }
  if (o.intervalMs && o.intervalMs > 0) {
    const timer = setInterval(() => { runReminders().catch(() => undefined); }, o.intervalMs);
    timer.unref?.();
    app.addHook('onClose', async () => clearInterval(timer));
  }
  return { runReminders };
}
