/* 公司制度 (Policies): the employee handbook, company policies (service and internal), SOPs and company culture.
 *
 * Each document has versions. A version is written as a draft, sent for approval, then published; older versions stay
 * readable. Every version records its effective date, what changed, who wrote it and who published it.
 *
 * Sign-off (签收): a document can require "I have read and agree". When a version is published with "everyone signs
 * again" (or it is the first published version), the people it applies to get an inbox item and sign that version.
 * A small change (typo) can be published without asking anyone to sign again; earlier signatures still count.
 * The record (who, which version, when) is the proof that the rule was made known to the employee
 * (China: Labor Contract Law art. 4 asks that rules be publicized or notified; US: handbook acknowledgement).
 *
 * Who it applies to: everyone, or one region (us / cn / intl, the region of the person's HR record) and / or chosen
 * departments. Factory contact accounts are left out (CLAUDE.md rule 7).
 *
 * Opening (2026-11-21, owner): the area starts closed. Until a main admin switches on “open to everyone”, only main admins and
 * policy editors see it (others get 404, the menu is hidden, nobody else is notified). Opening it sends the sign-off
 * requests that are due.
 *
 * Access (grants set only by main admins, in the module's 权限 tab):
 *   main admins (WORKOS_EXECUTIVE_USER_IDS)  write, publish, archive, see sign-off for everything
 *   policies_manage                          write drafts and send them for approval; see sign-off; remind
 *                                             an SOP may also be published by a policies_manage holder who is a manager of
 *                                             the (only) department it applies to
 *   everyone else                            reads the published documents that apply to them and signs them
 */
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { Database, Queryable } from './db.js';
import type { User } from './auth.js';
import { deny } from './errors.js';
import { pushInbox } from './inbox.js';
import { factoryUserIds, type QualityOptions } from './quality.js';

export const policiesSchema = `
CREATE TABLE IF NOT EXISTS policy_docs(id text PRIMARY KEY, org_id text NOT NULL, category text NOT NULL CHECK (category IN ('handbook','policy','sop','culture')),
  title_zh text NOT NULL DEFAULT '', title_en text NOT NULL DEFAULT '', region text NOT NULL DEFAULT '', department_ids jsonb NOT NULL DEFAULT '[]',
  requires_ack boolean NOT NULL DEFAULT false, public boolean NOT NULL DEFAULT false, owner_id text, review_months integer NOT NULL DEFAULT 12,
  next_review date, status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','published','archived')), current_version_id text, ack_version_id text,
  created_by text NOT NULL, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now());
CREATE INDEX IF NOT EXISTS policy_docs_org ON policy_docs(org_id, category);
CREATE TABLE IF NOT EXISTS policy_versions(id text PRIMARY KEY, org_id text NOT NULL, doc_id text NOT NULL, no integer NOT NULL,
  body_zh text NOT NULL DEFAULT '', body_en text NOT NULL DEFAULT '', official_lang text NOT NULL DEFAULT 'zh' CHECK (official_lang IN ('zh','en')),
  change_note text NOT NULL DEFAULT '', effective_date date, reack boolean NOT NULL DEFAULT true,
  state text NOT NULL DEFAULT 'draft' CHECK (state IN ('draft','pending','rejected','published','superseded')),
  author_id text NOT NULL, submitted_at timestamptz, decided_by text, decided_at timestamptz, reject_reason text NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(), UNIQUE(doc_id, no));
CREATE INDEX IF NOT EXISTS policy_versions_doc ON policy_versions(doc_id, no);
CREATE TABLE IF NOT EXISTS policy_acks(id text PRIMARY KEY, org_id text NOT NULL, doc_id text NOT NULL, version_id text NOT NULL, user_id text NOT NULL,
  acked_at timestamptz NOT NULL DEFAULT now(), UNIQUE(version_id, user_id));
CREATE INDEX IF NOT EXISTS policy_acks_user ON policy_acks(user_id);
CREATE TABLE IF NOT EXISTS policy_files(id text PRIMARY KEY, org_id text NOT NULL, doc_id text NOT NULL, name text NOT NULL, mime text NOT NULL, size integer NOT NULL,
  data bytea NOT NULL, uploader_id text NOT NULL, created_at timestamptz NOT NULL DEFAULT now());
CREATE INDEX IF NOT EXISTS policy_files_doc ON policy_files(doc_id);
CREATE TABLE IF NOT EXISTS policy_settings(org_id text PRIMARY KEY, open boolean NOT NULL DEFAULT false, updated_by text, updated_at timestamptz NOT NULL DEFAULT now());
`;

export const POLICY_CATEGORIES = ['handbook', 'policy', 'sop', 'culture'] as const;
export const POLICY_REGIONS = ['', 'us', 'cn', 'intl'] as const;
const OPEN = ['draft', 'pending', 'rejected'];
const MAX_BODY = 200_000, MAX_FILE = 20 * 1024 * 1024, MAX_FILES = 30;
const FILE_TYPES: Record<string, true> = {
  'application/pdf': true, 'image/png': true, 'image/jpeg': true, 'image/webp': true, 'text/plain': true, 'text/csv': true, 'video/mp4': true,
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': true, 'application/vnd.ms-excel': true,
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': true, 'application/msword': true,
  'application/vnd.openxmlformats-officedocument.presentationml.presentation': true, 'application/vnd.ms-powerpoint': true,
};
const id = z.string().regex(/^[A-Za-z0-9_-]{1,100}$/);
const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use a date like 2026-11-02');
const ymd = (d: unknown) => d ? (d instanceof Date ? d.toISOString() : String(d)).slice(0, 10) : null;
const addMonths = (date: string, n: number) => { const d = new Date(date + 'T00:00:00Z'); d.setUTCMonth(d.getUTCMonth() + n); return d.toISOString().slice(0, 10); };
const grantsOf = (u: any): string[] => Array.isArray(u?.grants) ? u.grants : [];
const listOf = (v: unknown): string[] => Array.isArray(v) ? v.map(String) : typeof v === 'string' ? (() => { try { const x = JSON.parse(v); return Array.isArray(x) ? x.map(String) : []; } catch { return []; } })() : [];

export type PoliciesOptions = { isAdmin: (u: User) => boolean; executiveUserIds?: string[]; quality?: QualityOptions; now?: () => number };

/** Does a published document apply to this person? (region of their HR record, their department) */
export const appliesTo = (doc: { region: string; department_ids: unknown }, person: { region?: string | null; department_id?: string | null }) =>
  (!doc.region || doc.region === (person.region || '')) && (!listOf(doc.department_ids).length || listOf(doc.department_ids).includes(String(person.department_id || '')));

export async function registerPoliciesRoutes(app: FastifyInstance, db: Database, o: PoliciesOptions) {
  const now = o.now || Date.now, today = () => new Date(now()).toISOString().slice(0, 10);
  const actorOf = (req: FastifyRequest): User => req.actor || deny(401, 'UNAUTHENTICATED', 'Authentication is required');
  const levelOf = (u: User): 'admin' | 'manage' | 'read' => o.isAdmin(u) ? 'admin' : grantsOf(u).includes('policies_manage') ? 'manage' : 'read';
  const editor = (u: User) => levelOf(u) !== 'read';
  const isOpen = (tx: Queryable, orgId: string) => policiesOpen(tx, orgId);
  /* Closed area: everyone but main admins and editors gets a plain 404 on every policies route. */
  app.addHook('preHandler', async req => {
    const url = req.routeOptions?.url || '';
    if (!/^\/policies(\/|$|\?)/.test(url) || !req.actor) return;
    if (editor(req.actor) || await isOpen(db, req.actor.org_id)) return;
    deny(404, 'NOT_FOUND', 'Not found', '找不到这个页面。');
  });
  const requireEditor = (u: User) => { if (!editor(u)) deny(403, 'POLICY_MANAGE_ONLY', 'Only people allowed to manage company policies can do this', '只有公司制度管理权限的人可以操作。'); };
  /** Main admins publish everything; an SOP for one department may also be published by a policy editor who manages that department. */
  const canPublish = (u: User, d: any) => levelOf(u) === 'admin' || (levelOf(u) === 'manage' && d.category === 'sop' && (u as any).role === 'manager'
    && listOf(d.department_ids).length > 0 && listOf(d.department_ids).every(x => x === u.department_id));
  const audit = (tx: Queryable, u: User, action: string, objectId: string, details: unknown) =>
    tx.query('INSERT INTO audit_events(id,org_id,department_id,owner_id,actor_id,action,object_id,details) VALUES($1,$2,$3,$4,$5,$6,$7,$8)',
      [randomUUID(), u.org_id, u.department_id, u.id, u.id, action, objectId, JSON.stringify(details)]);
  const peopleOf = async (org: string) => new Map((await db.query('SELECT id,display_name,name_zh,name_en,active FROM users WHERE org_id=$1', [org])).rows.map((p: any) => [p.id, p]));
  const nameOf = (p: any) => p ? (p.name_zh || p.display_name || p.name_en || p.id) : '';
  /** Departments people belong to (the departments table, plus any department id a member has without a row there). */
  const departmentsOf = async (tx: Queryable, org: string) => (await tx.query(`SELECT id, name FROM departments WHERE org_id=$1
    UNION SELECT DISTINCT u.department_id, u.department_id FROM users u WHERE u.org_id=$1 AND u.active=true AND NOT EXISTS (SELECT 1 FROM departments d WHERE d.org_id=u.org_id AND d.id=u.department_id)
    ORDER BY 2`, [org])).rows.map((r: any) => ({ id: String(r.id), name: String(r.name) }));
  const regionOf = async (tx: Queryable, userId: string) => String((await tx.query('SELECT region FROM hr_profiles WHERE user_id=$1', [userId])).rows[0]?.region || '');

  /** Everyone a document applies to: active staff (factory contacts left out), by region and department. */
  async function audienceOf(tx: Queryable, orgId: string, d: any) {
    const factory = await factoryUserIds(tx, o.quality || {}, orgId);
    const rows = (await tx.query(`SELECT u.id,u.display_name,u.name_zh,u.name_en,u.department_id,COALESCE(h.region,'') region,dp.name department FROM users u
      LEFT JOIN hr_profiles h ON h.user_id=u.id LEFT JOIN departments dp ON dp.org_id=u.org_id AND dp.id=u.department_id
      WHERE u.org_id=$1 AND u.active=true AND u.disabled_at IS NULL`, [orgId])).rows;
    const open = await isOpen(tx, orgId), canSee = new Set(open ? [] : (await tx.query("SELECT id FROM users WHERE org_id=$1 AND grants ? 'policies_manage'", [orgId])).rows.map((r: any) => r.id));
    return rows.filter((p: any) => !factory.has(p.id) && appliesTo(d, p) && (open || canSee.has(p.id) || o.isAdmin(p)));
  }
  /** A document this person may open: editors see all of them (drafts too); readers only published ones that apply to them. */
  async function docOf(tx: Queryable, u: User, docId: string, lock = false) {
    const d = (await tx.query(`SELECT * FROM policy_docs WHERE id=$1 AND org_id=$2${lock ? ' FOR UPDATE' : ''}`, [docId, u.org_id])).rows[0];
    if (!d || (!editor(u) && (d.status !== 'published' || !appliesTo(d, { region: await regionOf(tx, u.id), department_id: u.department_id }))))
      deny(404, 'POLICY_NOT_FOUND', 'Document not found', '找不到这份文件。');
    return d;
  }
  const openDraftOf = async (tx: Queryable, docId: string) => (await tx.query(`SELECT * FROM policy_versions WHERE doc_id=$1 AND state=ANY($2::text[]) ORDER BY no DESC LIMIT 1`, [docId, OPEN])).rows[0];
  const versionShape = (v: any, ppl: Map<string, any>, withBody = true) => v ? ({ id: v.id, no: v.no, state: v.state, officialLang: v.official_lang, changeNote: v.change_note,
    effectiveDate: ymd(v.effective_date), reack: v.reack, author: nameOf(ppl.get(v.author_id)), authorId: v.author_id, submittedAt: v.submitted_at,
    decidedBy: nameOf(ppl.get(v.decided_by)), decidedAt: v.decided_at, rejectReason: v.reject_reason, updatedAt: v.updated_at,
    ...(withBody ? { bodyZh: v.body_zh, bodyEn: v.body_en } : {}) }) : null;
  const docShape = (d: any, ppl: Map<string, any>) => ({ id: d.id, category: d.category, titleZh: d.title_zh, titleEn: d.title_en, region: d.region,
    departmentIds: listOf(d.department_ids), requiresAck: d.requires_ack, public: d.public, ownerId: d.owner_id, owner: nameOf(ppl.get(d.owner_id)),
    reviewMonths: d.review_months, nextReview: ymd(d.next_review), reviewDue: d.status === 'published' && !!d.next_review && ymd(d.next_review)! <= today(),
    status: d.status, currentVersionId: d.current_version_id, ackVersionId: d.ack_version_id, updatedAt: d.updated_at });

  async function signedBy(tx: Queryable, userId: string) {
    return new Set((await tx.query('SELECT version_id FROM policy_acks WHERE user_id=$1', [userId])).rows.map((r: any) => r.version_id as string));
  }

  app.get<{ Querystring: { q?: string } }>('/policies', async req => {
    const u = actorOf(req), level = levelOf(u), q = String(req.query?.q || '').trim().slice(0, 100);
    const me = { region: await regionOf(db, u.id), department_id: u.department_id };
    const rows = (await db.query(`SELECT d.*, v.no current_no, v.effective_date current_effective, v.official_lang current_lang
      FROM policy_docs d LEFT JOIN policy_versions v ON v.id=d.current_version_id WHERE d.org_id=$1
      ${q ? `AND (d.title_zh ILIKE $2 OR d.title_en ILIKE $2 OR v.body_zh ILIKE $2 OR v.body_en ILIKE $2${editor(u) ? ` OR EXISTS (SELECT 1 FROM policy_versions o WHERE o.doc_id=d.id AND o.state=ANY('{draft,pending,rejected}') AND (o.body_zh ILIKE $2 OR o.body_en ILIKE $2))` : ''})` : ''}
      ORDER BY d.category, d.title_zh`, q ? [u.org_id, '%' + q.replace(/[\\%_]/g, m => '\\' + m) + '%'] : [u.org_id])).rows
      .filter((d: any) => editor(u) ? true : d.status === 'published' && appliesTo(d, me));
    const ppl = await peopleOf(u.org_id), signed = await signedBy(db, u.id);
    const drafts = editor(u) && rows.length ? new Map((await db.query(`SELECT DISTINCT ON (doc_id) * FROM policy_versions WHERE doc_id=ANY($1::text[]) AND state=ANY($2::text[]) ORDER BY doc_id, no DESC`,
      [rows.map((d: any) => d.id), OPEN])).rows.map((v: any) => [v.doc_id, v])) : new Map();
    // Sign-off counts for editors: people the document applies to, and how many signed the version that counts.
    let stats = new Map<string, { done: number; total: number }>();
    if (editor(u)) {
      const ackDocs = rows.filter((d: any) => d.status === 'published' && d.requires_ack && d.ack_version_id);
      if (ackDocs.length) {
        const acks = (await db.query('SELECT version_id,user_id FROM policy_acks WHERE version_id=ANY($1::text[])', [ackDocs.map((d: any) => d.ack_version_id)])).rows;
        for (const d of ackDocs) {
          const aud = await audienceOf(db, u.org_id, d), ids = new Set(aud.map((p: any) => p.id));
          stats.set(d.id, { done: acks.filter((a: any) => a.version_id === d.ack_version_id && ids.has(a.user_id)).length, total: aud.length });
        }
      }
    }
    const docs = rows.map((d: any) => {
      const applies = d.status === 'published' && appliesTo(d, me), mustSign = applies && d.requires_ack && !!d.ack_version_id;
      const dr = drafts.get(d.id);
      return { ...docShape(d, ppl), version: d.current_no || null, effectiveDate: ymd(d.current_effective), officialLang: d.current_lang || null,
        appliesToMe: applies, myAck: mustSign ? (signed.has(d.ack_version_id) ? 'done' : 'todo') : null,
        draft: dr ? { id: dr.id, no: dr.no, state: dr.state, author: nameOf(ppl.get(dr.author_id)), updatedAt: dr.updated_at, rejectReason: dr.reject_reason } : null,
        canPublish: editor(u) ? canPublish(u, d) : false, ackStats: stats.get(d.id) || null };
    });
    const depts = await departmentsOf(db, u.org_id);
    const people = editor(u) ? [...ppl.values()].filter((p: any) => p.active).map((p: any) => ({ id: p.id, name: nameOf(p) })).sort((a, b) => a.name.localeCompare(b.name)) : [];
    return { level, open: await isOpen(db, u.org_id), today: today(), docs, departments: depts, people,
      counts: { todo: docs.filter((d: any) => d.myAck === 'todo').length, pending: docs.filter((d: any) => d.draft?.state === 'pending' && d.canPublish).length,
        reviewDue: editor(u) ? docs.filter((d: any) => d.reviewDue).length : 0 } };
  });

  app.get<{ Params: { id: string } }>('/policies/:id', async req => {
    const u = actorOf(req), d = await docOf(db, u, id.parse(req.params.id)), ppl = await peopleOf(u.org_id);
    const versions = (await db.query('SELECT * FROM policy_versions WHERE doc_id=$1 ORDER BY no DESC', [d.id])).rows;
    const current = versions.find((v: any) => v.id === d.current_version_id), draft = editor(u) ? versions.find((v: any) => OPEN.includes(v.state)) : null;
    const files = (await db.query('SELECT id,name,mime,size,uploader_id,created_at FROM policy_files WHERE doc_id=$1 ORDER BY created_at', [d.id])).rows;
    const signed = await signedBy(db, u.id), applies = d.status === 'published' && appliesTo(d, { region: await regionOf(db, u.id), department_id: u.department_id });
    const myAckRow = d.ack_version_id ? (await db.query('SELECT acked_at FROM policy_acks WHERE version_id=$1 AND user_id=$2', [d.ack_version_id, u.id])).rows[0] : null;
    return { ...docShape(d, ppl), current: versionShape(current, ppl), draft: versionShape(draft, ppl),
      history: versions.filter((v: any) => editor(u) || ['published', 'superseded'].includes(v.state)).map((v: any) => versionShape(v, ppl, false)),
      files: files.map((f: any) => ({ id: f.id, name: f.name, mime: f.mime, size: f.size, by: nameOf(ppl.get(f.uploader_id)), at: f.created_at })),
      appliesToMe: applies, myAck: applies && d.requires_ack && d.ack_version_id ? (signed.has(d.ack_version_id) ? 'done' : 'todo') : null, myAckAt: myAckRow?.acked_at || null,
      canEdit: editor(u), canPublish: canPublish(u, d), canArchive: levelOf(u) === 'admin' };
  });

  app.get<{ Params: { id: string; v: string } }>('/policies/:id/versions/:v', async req => {
    const u = actorOf(req), d = await docOf(db, u, id.parse(req.params.id));
    const v = (await db.query('SELECT * FROM policy_versions WHERE id=$1 AND doc_id=$2', [id.parse(req.params.v), d.id])).rows[0];
    if (!v || (!editor(u) && !['published', 'superseded'].includes(v.state))) deny(404, 'POLICY_NOT_FOUND', 'Version not found', '找不到这个版本。');
    return versionShape(v, await peopleOf(u.org_id));
  });

  const meta = {
    category: z.enum(POLICY_CATEGORIES), titleZh: z.string().trim().max(200), titleEn: z.string().trim().max(200), region: z.enum(POLICY_REGIONS),
    departmentIds: z.array(id).max(100), requiresAck: z.boolean(), public: z.boolean(), ownerId: id.nullable(), reviewMonths: z.number().int().min(0).max(60),
  };
  const body = { bodyZh: z.string().max(MAX_BODY), bodyEn: z.string().max(MAX_BODY), officialLang: z.enum(['zh', 'en']), changeNote: z.string().trim().max(2000),
    effectiveDate: day.nullable(), reack: z.boolean() };
  const checkTitle = (zh: string, en: string) => { if (!zh && !en) deny(400, 'POLICY_TITLE', 'Enter a title', '请填写标题。'); };
  const checkDepts = async (tx: Queryable, org: string, ids: string[]) => {
    if (!ids.length) return;
    const found = new Set((await departmentsOf(tx, org)).map(x => x.id));
    if (ids.some(x => !found.has(x))) deny(400, 'POLICY_DEPARTMENT', 'Choose departments from the list', '请从列表中选择部门。');
  };
  const checkOwner = async (tx: Queryable, org: string, ownerId: string | null) => {
    if (ownerId && !(await tx.query('SELECT 1 FROM users WHERE id=$1 AND org_id=$2 AND active=true', [ownerId, org])).rows.length) deny(400, 'POLICY_OWNER', 'Choose an owner from the list', '请从列表中选择负责人。');
  };

  const createInput = z.object({ ...meta, departmentIds: meta.departmentIds.default([]), requiresAck: meta.requiresAck.default(false), public: meta.public.default(false),
    ownerId: meta.ownerId.default(null), reviewMonths: meta.reviewMonths.default(12), titleZh: meta.titleZh.default(''), titleEn: meta.titleEn.default(''), region: meta.region.default(''),
    bodyZh: body.bodyZh.default(''), bodyEn: body.bodyEn.default(''), officialLang: body.officialLang.default('zh'), changeNote: body.changeNote.default(''),
    effectiveDate: body.effectiveDate.default(null) }).strict();
  app.post('/policies', async (req, reply) => {
    const u = actorOf(req); requireEditor(u); const v = createInput.parse(req.body);
    checkTitle(v.titleZh, v.titleEn);
    return db.transaction(async tx => {
      await checkDepts(tx, u.org_id, v.departmentIds); await checkOwner(tx, u.org_id, v.ownerId);
      const docId = randomUUID(), verId = randomUUID();
      await tx.query(`INSERT INTO policy_docs(id,org_id,category,title_zh,title_en,region,department_ids,requires_ack,public,owner_id,review_months,created_by)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`, [docId, u.org_id, v.category, v.titleZh, v.titleEn, v.region, JSON.stringify(v.departmentIds), v.requiresAck, v.public, v.ownerId || u.id, v.reviewMonths, u.id]);
      await tx.query(`INSERT INTO policy_versions(id,org_id,doc_id,no,body_zh,body_en,official_lang,change_note,effective_date,reack,author_id) VALUES($1,$2,$3,1,$4,$5,$6,$7,$8,true,$9)`,
        [verId, u.org_id, docId, v.bodyZh, v.bodyEn, v.officialLang, v.changeNote || '首次发布', v.effectiveDate, u.id]);
      await audit(tx, u, 'policies.created', docId, { category: v.category, title: v.titleZh || v.titleEn });
      return reply.code(201).send({ id: docId, draftId: verId });
    });
  });

  const metaInput = z.object(meta).partial().strict();
  app.patch<{ Params: { id: string } }>('/policies/:id', async req => {
    const u = actorOf(req); requireEditor(u); const v = metaInput.parse(req.body);
    return db.transaction(async tx => {
      const d = await docOf(tx, u, id.parse(req.params.id), true);
      if (d.status === 'archived') deny(400, 'POLICY_ARCHIVED', 'This document is archived', '这份文件已停用。');
      const next = { titleZh: v.titleZh ?? d.title_zh, titleEn: v.titleEn ?? d.title_en };
      checkTitle(next.titleZh, next.titleEn);
      if (v.departmentIds) await checkDepts(tx, u.org_id, v.departmentIds);
      if (v.ownerId !== undefined) await checkOwner(tx, u.org_id, v.ownerId);
      // Changing who it applies to or the category of a published document is a publishing decision.
      const scopeChange = (v.region !== undefined && v.region !== d.region) || (v.departmentIds && JSON.stringify(v.departmentIds) !== JSON.stringify(listOf(d.department_ids)))
        || (v.category !== undefined && v.category !== d.category) || (v.requiresAck !== undefined && v.requiresAck !== d.requires_ack);
      if (scopeChange && d.status === 'published' && !canPublish(u, { ...d, category: v.category ?? d.category, department_ids: v.departmentIds ?? d.department_ids }))
        deny(403, 'POLICY_PUBLISH_ONLY', 'Only the people who can publish this document may change who it applies to', '只有能发布这份文件的人可以改适用范围、分类和签收要求。');
      const review = v.reviewMonths ?? d.review_months, effective = d.current_version_id ? ymd((await tx.query('SELECT effective_date FROM policy_versions WHERE id=$1', [d.current_version_id])).rows[0]?.effective_date) : null;
      await tx.query(`UPDATE policy_docs SET category=$2,title_zh=$3,title_en=$4,region=$5,department_ids=$6,requires_ack=$7,public=$8,owner_id=$9,review_months=$10,
        next_review=$11,ack_version_id=CASE WHEN $7 AND ack_version_id IS NULL THEN current_version_id ELSE ack_version_id END,updated_at=now() WHERE id=$1`,
        [d.id, v.category ?? d.category, next.titleZh, next.titleEn, v.region ?? d.region, JSON.stringify(v.departmentIds ?? listOf(d.department_ids)), v.requiresAck ?? d.requires_ack,
          v.public ?? d.public, v.ownerId !== undefined ? v.ownerId : d.owner_id, review, effective && review ? addMonths(effective, review) : (review ? d.next_review : null)]);
      // Turning sign-off on for a published document asks the people it applies to now.
      if (v.requiresAck && !d.requires_ack && d.status === 'published') {
        const nd = (await tx.query('SELECT * FROM policy_docs WHERE id=$1', [d.id])).rows[0];
        await pushInbox(tx, { orgId: u.org_id, recipients: (await audienceOf(tx, u.org_id, nd)).map((p: any) => p.id), actorId: u.id, kind: 'policy_ack',
          title: `请阅读并签收：${nd.title_zh || nd.title_en}`, body: '需要签收' });
      }
      await audit(tx, u, 'policies.updated', d.id, v);
      return { ok: true };
    });
  });

  /* The open draft of a document: written by editors; a new one starts from the published text. */
  const draftInput = z.object(body).partial().strict();
  app.post<{ Params: { id: string } }>('/policies/:id/draft', async req => {
    const u = actorOf(req); requireEditor(u); const v = draftInput.parse(req.body);
    return db.transaction(async tx => {
      const d = await docOf(tx, u, id.parse(req.params.id), true);
      if (d.status === 'archived') deny(400, 'POLICY_ARCHIVED', 'This document is archived', '这份文件已停用。');
      let dr = await openDraftOf(tx, d.id);
      if (!dr) {
        const cur = d.current_version_id ? (await tx.query('SELECT * FROM policy_versions WHERE id=$1', [d.current_version_id])).rows[0] : null;
        const no = Number((await tx.query('SELECT COALESCE(max(no),0)::int n FROM policy_versions WHERE doc_id=$1', [d.id])).rows[0].n) + 1;
        dr = (await tx.query(`INSERT INTO policy_versions(id,org_id,doc_id,no,body_zh,body_en,official_lang,reack,author_id) VALUES($1,$2,$3,$4,$5,$6,$7,false,$8) RETURNING *`,
          [randomUUID(), u.org_id, d.id, no, cur?.body_zh || '', cur?.body_en || '', cur?.official_lang || 'zh', u.id])).rows[0];
      }
      if (dr.state === 'pending' && !canPublish(u, d)) deny(409, 'POLICY_PENDING', 'This draft is waiting for approval; ask the approver to send it back first', '这个草稿正在等待审批，请先请审批人退回再修改。');
      await tx.query(`UPDATE policy_versions SET body_zh=$2,body_en=$3,official_lang=$4,change_note=$5,effective_date=$6,reack=$7,
        state=CASE WHEN state='rejected' THEN 'draft' ELSE state END,author_id=$8,updated_at=now() WHERE id=$1`,
        [dr.id, v.bodyZh ?? dr.body_zh, v.bodyEn ?? dr.body_en, v.officialLang ?? dr.official_lang, v.changeNote ?? dr.change_note,
          v.effectiveDate !== undefined ? v.effectiveDate : ymd(dr.effective_date), v.reack ?? dr.reack, u.id]);
      return { id: dr.id, no: dr.no };
    });
  });

  app.post<{ Params: { id: string } }>('/policies/:id/draft/discard', async req => {
    const u = actorOf(req); requireEditor(u);
    return db.transaction(async tx => {
      const d = await docOf(tx, u, id.parse(req.params.id), true), dr = await openDraftOf(tx, d.id) || deny(404, 'POLICY_NO_DRAFT', 'There is no draft', '没有草稿。');
      if (dr.state === 'pending' && !canPublish(u, d)) deny(409, 'POLICY_PENDING', 'This draft is waiting for approval; ask the approver to send it back first', '这个草稿正在等待审批，请先请审批人退回再修改。');
      await tx.query('DELETE FROM policy_versions WHERE id=$1', [dr.id]);
      // A document that was never published goes with its only draft.
      if (!d.current_version_id) { await tx.query('DELETE FROM policy_files WHERE doc_id=$1', [d.id]); await tx.query('DELETE FROM policy_docs WHERE id=$1', [d.id]); }
      await audit(tx, u, 'policies.draft_discarded', d.id, { no: dr.no });
      return { ok: true, docDeleted: !d.current_version_id };
    });
  });

  const needBody = (dr: any) => { if (!String(dr.body_zh || '').trim() && !String(dr.body_en || '').trim()) deny(400, 'POLICY_EMPTY', 'Write the document before sending it', '请先填写正文。'); };
  app.post<{ Params: { id: string } }>('/policies/:id/draft/submit', async req => {
    const u = actorOf(req); requireEditor(u);
    return db.transaction(async tx => {
      const d = await docOf(tx, u, id.parse(req.params.id), true), dr = await openDraftOf(tx, d.id) || deny(404, 'POLICY_NO_DRAFT', 'There is no draft', '没有草稿。');
      needBody(dr);
      if (dr.state === 'pending') return { ok: true };
      await tx.query("UPDATE policy_versions SET state='pending',submitted_at=now(),reject_reason='',updated_at=now() WHERE id=$1", [dr.id]);
      // Approvers: main admins, and for a one-department SOP the managers of that department who edit policies.
      const exec = o.executiveUserIds || [];
      const deptLeads = d.category === 'sop' && listOf(d.department_ids).length === 1
        ? (await tx.query("SELECT id FROM users WHERE org_id=$1 AND department_id=$2 AND role='manager' AND active=true AND grants ? 'policies_manage'", [u.org_id, listOf(d.department_ids)[0]])).rows.map((r: any) => r.id) : [];
      await pushInbox(tx, { orgId: u.org_id, recipients: [...exec, ...deptLeads], actorId: u.id, kind: 'policy_approval', title: `制度待发布：${d.title_zh || d.title_en}`, body: dr.change_note });
      await audit(tx, u, 'policies.submitted', d.id, { no: dr.no });
      return { ok: true };
    });
  });

  app.post<{ Params: { id: string } }>('/policies/:id/draft/reject', async req => {
    const u = actorOf(req), v = z.object({ reason: z.string().trim().min(1).max(1000) }).strict().safeParse(req.body);
    if (!v.success) deny(400, 'POLICY_REASON', 'Say why it is sent back', '请写明退回原因。');
    return db.transaction(async tx => {
      const d = await docOf(tx, u, id.parse(req.params.id), true);
      if (!canPublish(u, d)) deny(403, 'POLICY_PUBLISH_ONLY', 'Only the people who can publish this document may approve it', '只有能发布这份文件的人可以审批。');
      const dr = await openDraftOf(tx, d.id);
      if (!dr || dr.state !== 'pending') deny(409, 'POLICY_NOT_PENDING', 'This draft is not waiting for approval', '这个草稿没有在等待审批。');
      await tx.query("UPDATE policy_versions SET state='rejected',decided_by=$2,decided_at=now(),reject_reason=$3,updated_at=now() WHERE id=$1", [dr.id, u.id, v.data.reason]);
      await pushInbox(tx, { orgId: u.org_id, recipients: [dr.author_id], actorId: u.id, kind: 'policy_approval', title: `制度被退回：${d.title_zh || d.title_en}`, body: v.data.reason });
      await audit(tx, u, 'policies.rejected', d.id, { no: dr.no, reason: v.data.reason });
      return { ok: true };
    });
  });

  app.post<{ Params: { id: string } }>('/policies/:id/draft/publish', async req => {
    const u = actorOf(req);
    return db.transaction(async tx => {
      const d = await docOf(tx, u, id.parse(req.params.id), true);
      if (!canPublish(u, d)) deny(403, 'POLICY_PUBLISH_ONLY', 'Only the people who can publish this document may publish it', '只有能发布这份文件的人可以发布。');
      if (d.status === 'archived') deny(400, 'POLICY_ARCHIVED', 'This document is archived', '这份文件已停用。');
      const dr = await openDraftOf(tx, d.id) || deny(404, 'POLICY_NO_DRAFT', 'There is no draft', '没有草稿。');
      needBody(dr);
      const effective = ymd(dr.effective_date) || today();
      const first = !d.current_version_id, signAgain = d.requires_ack && (first || dr.reack || !d.ack_version_id);
      await tx.query("UPDATE policy_versions SET state='superseded' WHERE doc_id=$1 AND state='published'", [d.id]);
      await tx.query("UPDATE policy_versions SET state='published',effective_date=$2,reack=$3,decided_by=$4,decided_at=now(),updated_at=now() WHERE id=$1", [dr.id, effective, signAgain, u.id]);
      await tx.query(`UPDATE policy_docs SET status='published',current_version_id=$2,ack_version_id=CASE WHEN $3 THEN $2 ELSE ack_version_id END,next_review=$4,updated_at=now() WHERE id=$1`,
        [d.id, dr.id, signAgain, d.review_months ? addMonths(effective, d.review_months) : null]);
      let asked = 0;
      if (signAgain) {
        const aud = await audienceOf(tx, u.org_id, d);
        asked = await pushInbox(tx, { orgId: u.org_id, recipients: aud.map((p: any) => p.id), actorId: u.id, kind: 'policy_ack',
          title: `请阅读并签收：${d.title_zh || d.title_en}`, body: dr.change_note || (first ? '新发布' : `第 ${dr.no} 版`) });
      }
      if (dr.author_id !== u.id) await pushInbox(tx, { orgId: u.org_id, recipients: [dr.author_id], actorId: u.id, kind: 'policy_approval', title: `制度已发布：${d.title_zh || d.title_en}`, body: `第 ${dr.no} 版` });
      await audit(tx, u, 'policies.published', d.id, { no: dr.no, signAgain, asked });
      return { ok: true, no: dr.no, signAgain, asked };
    });
  });

  app.post<{ Params: { id: string } }>('/policies/:id/archive', async req => {
    const u = actorOf(req); if (levelOf(u) !== 'admin') deny(403, 'POLICY_ADMIN_ONLY', 'Only main administrators can archive a document', '只有主管理员可以停用文件。');
    const v = z.object({ archived: z.boolean() }).strict().parse(req.body);
    return db.transaction(async tx => {
      const d = await docOf(tx, u, id.parse(req.params.id), true);
      const status = v.archived ? 'archived' : d.current_version_id ? 'published' : 'draft';
      await tx.query('UPDATE policy_docs SET status=$2,updated_at=now() WHERE id=$1', [d.id, status]);
      await audit(tx, u, v.archived ? 'policies.archived' : 'policies.restored', d.id, {});
      return { ok: true, status };
    });
  });

  /* 签收: the person confirms they read the version that counts. */
  app.post<{ Params: { id: string } }>('/policies/:id/ack', async req => {
    const u = actorOf(req), v = z.object({ versionId: id }).strict().parse(req.body);
    return db.transaction(async tx => {
      const d = await docOf(tx, u, id.parse(req.params.id));
      const applies = d.status === 'published' && appliesTo(d, { region: await regionOf(tx, u.id), department_id: u.department_id });
      if (!applies || !d.requires_ack || !d.ack_version_id) deny(400, 'POLICY_NO_ACK', 'This document does not need your signature', '这份文件不需要你签收。');
      if (v.versionId !== d.ack_version_id) deny(409, 'POLICY_NEW_VERSION', 'A newer version was published; please read it again', '已经发布了新版本，请重新阅读后再签收。');
      await tx.query('INSERT INTO policy_acks(id,org_id,doc_id,version_id,user_id) VALUES($1,$2,$3,$4,$5) ON CONFLICT (version_id,user_id) DO NOTHING', [randomUUID(), u.org_id, d.id, d.ack_version_id, u.id]);
      await tx.query("UPDATE inbox_items SET read_at=COALESCE(read_at,now()) WHERE user_id=$1 AND kind='policy_ack' AND title LIKE $2", [u.id, '%' + (d.title_zh || d.title_en)]);
      const at = (await tx.query('SELECT acked_at FROM policy_acks WHERE version_id=$1 AND user_id=$2', [d.ack_version_id, u.id])).rows[0].acked_at;
      return { ok: true, ackedAt: at };
    });
  });

  /* Sign-off list for editors: everyone the document applies to, signed or not. */
  async function ackList(tx: Queryable, u: User, d: any) {
    const aud = await audienceOf(tx, u.org_id, d);
    const acks = d.ack_version_id ? new Map((await tx.query('SELECT user_id,acked_at FROM policy_acks WHERE version_id=$1', [d.ack_version_id])).rows.map((r: any) => [r.user_id, r.acked_at])) : new Map();
    return aud.map((p: any) => ({ id: p.id, name: nameOf(p), department: p.department || p.department_id || '', region: p.region, ackedAt: acks.get(p.id) || null }))
      .sort((a: any, b: any) => (a.ackedAt ? 1 : 0) - (b.ackedAt ? 1 : 0) || a.name.localeCompare(b.name));
  }
  app.get<{ Params: { id: string } }>('/policies/:id/acks', async req => {
    const u = actorOf(req); requireEditor(u);
    const d = await docOf(db, u, id.parse(req.params.id));
    const no = d.ack_version_id ? (await db.query('SELECT no FROM policy_versions WHERE id=$1', [d.ack_version_id])).rows[0]?.no : null;
    const people = await ackList(db, u, d);
    return { versionNo: no, requiresAck: d.requires_ack, people, done: people.filter((p: any) => p.ackedAt).length, total: people.length };
  });
  app.post<{ Params: { id: string } }>('/policies/:id/remind', async req => {
    const u = actorOf(req); requireEditor(u);
    return db.transaction(async tx => {
      const d = await docOf(tx, u, id.parse(req.params.id));
      if (!d.requires_ack || !d.ack_version_id || d.status !== 'published') deny(400, 'POLICY_NO_ACK', 'This document does not need signatures', '这份文件不需要签收。');
      const missing = (await ackList(tx, u, d)).filter((p: any) => !p.ackedAt).map((p: any) => p.id);
      const sent = await pushInbox(tx, { orgId: u.org_id, recipients: missing, actorId: u.id, kind: 'policy_ack', title: `请阅读并签收：${d.title_zh || d.title_en}`, body: '提醒' });
      await audit(tx, u, 'policies.reminded', d.id, { sent });
      return { sent };
    });
  });

  /* Attachments (the original PDF or Word file, forms, training videos). */
  const fileInput = z.object({ name: z.string().trim().min(1).max(200), mime: z.string().max(120), dataBase64: z.string().min(4) }).strict();
  app.post<{ Params: { id: string } }>('/policies/:id/files', { bodyLimit: Math.ceil(MAX_FILE * 4 / 3) + 4096 }, async (req, reply) => {
    const u = actorOf(req); requireEditor(u); const v = fileInput.parse(req.body);
    const mime = v.mime.split(';')[0].trim().toLowerCase();
    if (!FILE_TYPES[mime]) deny(400, 'POLICY_FILE_TYPE', 'Upload a PDF, image, Word, Excel, PowerPoint, text or MP4 file', '请上传 PDF、图片、Word、Excel、PPT、文本或 MP4 文件。');
    if (!/^[A-Za-z0-9+/]+={0,2}$/.test(v.dataBase64)) deny(400, 'POLICY_FILE_INVALID', 'The file could not be read', '文件读取失败，请重新上传。');
    const data = Buffer.from(v.dataBase64, 'base64');
    if (!data.length || data.length > MAX_FILE) deny(400, 'POLICY_FILE_TOO_LARGE', 'Files must be 20 MB or smaller', '文件不能超过 20 MB。');
    return db.transaction(async tx => {
      const d = await docOf(tx, u, id.parse(req.params.id), true);
      if (Number((await tx.query('SELECT count(*)::int n FROM policy_files WHERE doc_id=$1', [d.id])).rows[0].n) >= MAX_FILES) deny(400, 'POLICY_FILE_LIMIT', 'A document can have at most 30 files', '一份文件最多 30 个附件。');
      const fid = randomUUID();
      await tx.query('INSERT INTO policy_files(id,org_id,doc_id,name,mime,size,data,uploader_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8)', [fid, u.org_id, d.id, v.name, mime, data.length, data, u.id]);
      await audit(tx, u, 'policies.file_added', d.id, { name: v.name });
      return reply.code(201).send({ id: fid });
    });
  });
  app.get<{ Params: { id: string; file: string } }>('/policies/:id/files/:file', async (req, reply) => {
    const u = actorOf(req), d = await docOf(db, u, id.parse(req.params.id));
    const f = (await db.query('SELECT name,mime,data FROM policy_files WHERE id=$1 AND doc_id=$2', [id.parse(req.params.file), d.id])).rows[0];
    if (!f) deny(404, 'POLICY_NOT_FOUND', 'File not found', '找不到这个附件。');
    const inline = /^(application\/pdf|image\/(png|jpeg|webp)|text\/plain|video\/mp4)$/.test(f.mime);
    reply.header('content-type', f.mime).header('cache-control', 'private, no-store').header('x-content-type-options', 'nosniff')
      .header('content-disposition', `${inline ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(f.name)}`);
    return reply.send(Buffer.from(f.data));
  });
  app.post<{ Params: { id: string; file: string } }>('/policies/:id/files/:file/delete', async req => {
    const u = actorOf(req); requireEditor(u);
    return db.transaction(async tx => {
      const d = await docOf(tx, u, id.parse(req.params.id), true);
      const f = (await tx.query('DELETE FROM policy_files WHERE id=$1 AND doc_id=$2 RETURNING name', [id.parse(req.params.file), d.id])).rows[0] || deny(404, 'POLICY_NOT_FOUND', 'File not found', '找不到这个附件。');
      await audit(tx, u, 'policies.file_deleted', d.id, { name: f.name });
      return { ok: true };
    });
  });

  /* Open the area to everyone (or close it again). Opening asks everyone a published sign-off document applies to. */
  app.get('/policies-settings', async req => { const u = actorOf(req); if (!editor(u)) deny(404, 'NOT_FOUND', 'Not found', '找不到这个页面。'); return { open: await isOpen(db, u.org_id) }; });
  app.post('/policies-settings', async req => {
    const u = actorOf(req); if (levelOf(u) !== 'admin') deny(403, 'POLICY_ADMIN_ONLY', 'Only main administrators can open company policies to everyone', '只有主管理员可以把公司制度开放给全员。');
    const v = z.object({ open: z.boolean() }).strict().parse(req.body);
    return db.transaction(async tx => {
      const was = await isOpen(tx, u.org_id);
      await tx.query(`INSERT INTO policy_settings(org_id,open,updated_by,updated_at) VALUES($1,$2,$3,now()) ON CONFLICT (org_id) DO UPDATE SET open=EXCLUDED.open,updated_by=EXCLUDED.updated_by,updated_at=now()`, [u.org_id, v.open, u.id]);
      let asked = 0;
      if (v.open && !was) {
        const docs = (await tx.query("SELECT * FROM policy_docs WHERE org_id=$1 AND status='published' AND requires_ack AND ack_version_id IS NOT NULL", [u.org_id])).rows;
        for (const d of docs) {
          const signed = new Set((await tx.query('SELECT user_id FROM policy_acks WHERE version_id=$1', [d.ack_version_id])).rows.map((r: any) => r.user_id));
          asked += await pushInbox(tx, { orgId: u.org_id, recipients: (await audienceOf(tx, u.org_id, d)).filter((p: any) => !signed.has(p.id)).map((p: any) => p.id), actorId: u.id,
            kind: 'policy_ack', title: `请阅读并签收：${d.title_zh || d.title_en}`, body: '新发布' });
        }
      }
      await audit(tx, u, v.open ? 'policies.opened' : 'policies.closed', u.org_id, { asked });
      return { open: v.open, asked };
    });
  });

  /* 权限: main admins choose who may write company policies. */
  const execOnly = (u: User) => { if (levelOf(u) !== 'admin') deny(403, 'POLICY_ACCESS_ADMIN_ONLY', 'Only main administrators can set who manages company policies', '只有主管理员可以设置公司制度的管理权限。'); };
  app.get('/policies-access', async req => {
    const u = actorOf(req); execOnly(u);
    const rows = (await db.query('SELECT id,display_name,name_zh,name_en,title,grants,quality_factory,role FROM users WHERE org_id=$1 AND active=true ORDER BY display_name', [u.org_id])).rows;
    return { people: rows.filter((p: any) => !p.quality_factory).map((p: any) => ({ id: p.id, name: nameOf(p), title: p.title || '', admin: o.isAdmin(p), manager: p.role === 'manager',
      level: o.isAdmin(p) || grantsOf(p).includes('policies_manage') ? 'manage' : 'none' })) };
  });
  app.post('/policies-access', async req => {
    const u = actorOf(req); execOnly(u); const v = z.object({ userId: id, level: z.enum(['none', 'manage']) }).strict().parse(req.body);
    if (v.userId === u.id) deny(400, 'POLICY_ACCESS_SELF', 'Nobody changes their own access', '任何人都不能改自己的权限。');
    return db.transaction(async tx => {
      const p = (await tx.query('SELECT id,grants FROM users WHERE id=$1 AND org_id=$2 AND active=true FOR UPDATE', [v.userId, u.org_id])).rows[0] || deny(404, 'NOT_FOUND', 'Member not found', '找不到这个成员。');
      const next = [...grantsOf(p).filter(g => g !== 'policies_manage'), ...(v.level === 'manage' ? ['policies_manage'] : [])];
      await tx.query('UPDATE users SET grants=$2 WHERE id=$1', [p.id, JSON.stringify(next)]);
      await audit(tx, u, 'policies.access_changed', p.id, { to: v.level });
      return { userId: p.id, level: v.level };
    });
  });
}

/** Has a main admin opened company policies to everyone yet? */
export async function policiesOpen(db: Queryable, orgId: string) {
  return (await db.query('SELECT open FROM policy_settings WHERE org_id=$1', [orgId])).rows[0]?.open === true;
}
/** For /me: may this person see the policies area at all (main admins and editors always; others once it is open). */
export async function policiesAccessOf(db: Queryable, u: any, admin: boolean) {
  return admin || grantsOf(u).includes('policies_manage') || (!u.quality_factory && await policiesOpen(db, u.org_id));
}
/** For /me: how many published documents this person still has to sign. */
export async function policyTodoOf(db: Queryable, u: any, admin = false) {
  if (!(await policiesAccessOf(db, u, admin))) return 0;
  const rows = (await db.query(`SELECT d.region,d.department_ids,d.ack_version_id FROM policy_docs d WHERE d.org_id=$1 AND d.status='published' AND d.requires_ack AND d.ack_version_id IS NOT NULL
    AND NOT EXISTS (SELECT 1 FROM policy_acks a WHERE a.version_id=d.ack_version_id AND a.user_id=$2)`, [u.org_id, u.id])).rows;
  if (!rows.length) return 0;
  const region = String((await db.query('SELECT region FROM hr_profiles WHERE user_id=$1', [u.id])).rows[0]?.region || '');
  return rows.filter((d: any) => appliesTo(d, { region, department_id: u.department_id })).length;
}
