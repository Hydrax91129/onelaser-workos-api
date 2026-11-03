/* Product quality issues → factory corrective action.
 *
 * One issue per distinct product defect (many tickets / RMA cases / reviews can point at the same issue).
 * Flow and the date recorded at each step:
 *   new ──send──▶ sent (sent_at, plan_due) ──factory plan──▶ plan_review (plan_at)
 *     ──approve──▶ doing (approved_at, impl_due) ──factory implemented──▶ verify (implemented_at, effective_batch)
 *     ──verify pass──▶ closed (verified_at, closed_at, resolution 'fixed')
 *   A returned plan goes back to sent; a failed verification goes back to doing; a lead can close any open
 *   issue without a fix (duplicate, not a defect…) with a reason (resolution 'cancelled').
 *
 * Access: quality leads (WORKOS_QUALITY_LEAD_IDS, plus org admins) create and drive issues. Factory staff are
 * colleagues in a DingTalk department mapped to a factory (WORKOS_QUALITY_FACTORY_DEPARTMENTS="dg:deptA|deptB,jn:deptC");
 * they only see issues sent to their factory and can write the plan and report implementation. Everyone else
 * in the org can read. Every change is kept in quality_events and audit_events. */
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { Database, Queryable } from './db.js';
import type { User } from './auth.js';
import { deny } from './errors.js';

export const qualitySchema = `
CREATE TABLE IF NOT EXISTS quality_issues(id text PRIMARY KEY, org_id text NOT NULL, number text NOT NULL, title text NOT NULL, description text NOT NULL DEFAULT '',
  category text NOT NULL, defect text NOT NULL, model text NOT NULL, sku text NOT NULL DEFAULT '', batch text NOT NULL DEFAULT '', severity text NOT NULL,
  factory text NOT NULL, status text NOT NULL DEFAULT 'new', resolution text, found_at date NOT NULL, affected integer NOT NULL DEFAULT 1 CHECK (affected > 0), owner_id text,
  sent_at date, plan_due date, plan_at date, approved_at date, impl_due date, implemented_at date, effective_batch text NOT NULL DEFAULT '', verified_at date, closed_at date,
  created_by text NOT NULL, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now());
CREATE UNIQUE INDEX IF NOT EXISTS quality_issues_number ON quality_issues(org_id, number);
CREATE TABLE IF NOT EXISTS quality_plans(id text PRIMARY KEY, org_id text NOT NULL, issue_id text NOT NULL, version integer NOT NULL, root_cause text NOT NULL, corrective text NOT NULL,
  preventive text NOT NULL, impl_due date NOT NULL, author_id text NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
  decision text, decision_note text NOT NULL DEFAULT '', decided_by text, decided_at timestamptz, UNIQUE(issue_id, version));
CREATE TABLE IF NOT EXISTS quality_links(id text PRIMARY KEY, org_id text NOT NULL, issue_id text NOT NULL, kind text NOT NULL, ref text NOT NULL, url text NOT NULL DEFAULT '',
  note text NOT NULL DEFAULT '', created_by text NOT NULL, created_at timestamptz NOT NULL DEFAULT now());
CREATE INDEX IF NOT EXISTS quality_links_issue ON quality_links(issue_id);
CREATE TABLE IF NOT EXISTS quality_events(id text PRIMARY KEY, org_id text NOT NULL, issue_id text NOT NULL, actor_id text NOT NULL, action text NOT NULL, note text NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT now());
CREATE INDEX IF NOT EXISTS quality_events_issue ON quality_events(issue_id, created_at);
`;

/* Two-level defect code: category → defect. Same codes as the original prototype so reports stay comparable. */
export const QUALITY_CATEGORIES: Record<string, { zh: string; en: string; defects: Record<string, [string, string]> }> = {
  OPT: { zh: '光学 / 激光', en: 'Optics / laser', defects: { '01': ['功率衰减', 'Power drop'], '02': ['光斑不均 / 对焦偏', 'Uneven spot / focus'], '03': ['激光管 / 光源损坏', 'Laser source failure'], '04': ['红光指示偏移', 'Red-dot offset'] } },
  ELE: { zh: '电气', en: 'Electrical', defects: { '01': ['电源板故障', 'Power board failure'], '02': ['主板 / 控制卡', 'Mainboard / controller'], '03': ['线束松动', 'Loose wiring'], '04': ['冷水机报警', 'Chiller alarm'] } },
  MEC: { zh: '机械 / 运动', en: 'Mechanics / motion', defects: { '01': ['导轨异响', 'Rail noise'], '02': ['皮带松 / 失步', 'Belt slip / lost steps'], '03': ['升降台卡滞', 'Z-table jam'], '04': ['旋转轴精度', 'Rotary accuracy'] } },
  SFW: { zh: '软件 / 固件', en: 'Software / firmware', defects: { '01': ['LightBurn 连接', 'LightBurn connection'], '02': ['固件升级失败', 'Firmware update failure'], '03': ['WiFi / 网络', 'WiFi / network'] } },
  STR: { zh: '结构 / 外观', en: 'Structure / finish', defects: { '01': ['钣金变形', 'Sheet-metal dent'], '02': ['门盖 / 铰链', 'Lid / hinge'], '03': ['划痕 / 掉漆', 'Scratches / paint'] } },
  PKG: { zh: '包装 / 运输', en: 'Packaging / shipping', defects: { '01': ['运输破损', 'Transit damage'], '02': ['少件 / 错件', 'Missing / wrong parts'] } },
  DOC: { zh: '使用 / 文档', en: 'Usage / documentation', defects: { '01': ['说明书不清楚', 'Unclear manual'], '02': ['操作误解', 'User misunderstanding'] } },
};
export const QUALITY_FACTORIES = [{ id: 'dg', zh: '东莞工厂', en: 'Dongguan factory' }, { id: 'jn', zh: '济南工厂', en: 'Jinan factory' }] as const;
export const QUALITY_STATUSES = ['new', 'sent', 'plan_review', 'doing', 'verify', 'closed'] as const;
const SEVERITIES = ['S1', 'S2', 'S3'] as const;
const LINK_KINDS = ['ticket', 'rma', 'review', 'forum', 'reddit', 'amazon', 'other'] as const;
const FACTORY_IDS = QUALITY_FACTORIES.map(f => f.id) as [string, ...string[]];
const DEFAULT_PLAN_DAYS = 7;

export type QualityOptions = { leadIds?: string[]; factoryDepartments?: Record<string, string[]> };
export function qualityOptionsFromEnv(env: NodeJS.ProcessEnv): QualityOptions {
  const factoryDepartments: Record<string, string[]> = {};
  for (const part of (env.WORKOS_QUALITY_FACTORY_DEPARTMENTS || '').split(',').map(s => s.trim()).filter(Boolean)) {
    const [factory, depts] = part.split(':');
    if (factory && depts && FACTORY_IDS.includes(factory)) factoryDepartments[factory] = depts.split('|').map(s => s.trim()).filter(Boolean);
  }
  return { leadIds: (env.WORKOS_QUALITY_LEAD_IDS || '').split(',').map(s => s.trim()).filter(Boolean), factoryDepartments };
}

const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use a date like 2026-11-02');
const id = z.string().min(1).max(100).regex(/^[A-Za-z0-9_-]+$/);
const longText = (min = 0) => z.string().trim().min(min).max(5000);
const nameOf = (u: any) => u ? (u.display_name || u.name_zh || u.name_en || u.id) : '';
const ymd = (v: any) => v ? (v instanceof Date ? v.toISOString().slice(0, 10) : String(v).slice(0, 10)) : null;
const days = (a: any, b: any) => a && b ? Math.max(0, Math.round((new Date(ymd(b)!).getTime() - new Date(ymd(a)!).getTime()) / 86400000)) : null;
const addDays = (d: string, n: number) => new Date(new Date(d).getTime() + n * 86400000).toISOString().slice(0, 10);

export async function registerQualityRoutes(app: FastifyInstance, db: Database, o: QualityOptions & { isAdmin: (u: User) => boolean; now?: () => number }) {
  const now = o.now || Date.now;
  const today = () => new Date(now()).toISOString().slice(0, 10);
  const actorOf = (req: FastifyRequest): User => req.actor || deny(401, 'UNAUTHENTICATED', 'Authentication is required');
  const isLead = (u: User) => o.isAdmin(u) || (o.leadIds || []).includes(u.id);
  /* Factory membership comes from the person's department (internal id or DingTalk external id). */
  const factoryOf = async (u: User): Promise<string | null> => {
    const map = o.factoryDepartments || {};
    if (!Object.keys(map).length) return null;
    const ext = (await db.query('SELECT external_id FROM departments WHERE org_id=$1 AND id=$2', [u.org_id, u.department_id])).rows[0]?.external_id;
    for (const [factory, depts] of Object.entries(map)) if (depts.includes(u.department_id) || (ext && depts.includes(ext))) return factory;
    return null;
  };
  const roleOf = async (u: User) => {
    if (isLead(u)) return { role: 'lead' as const, factory: null };
    const factory = await factoryOf(u);
    return factory ? { role: 'factory' as const, factory } : { role: 'viewer' as const, factory: null };
  };
  /* Factory staff never see an issue before it is sent to them, nor another factory's issues. */
  const visible = (r: { role: string; factory: string | null }, i: any) => r.role !== 'factory' || (i.factory === r.factory && i.status !== 'new');
  const requireLead = (u: User) => { if (!isLead(u)) deny(403, 'QUALITY_LEAD_ONLY', 'Only quality leads can do this', '只有品质负责人可以执行这个操作。'); };
  const event = (tx: Queryable, u: User, issueId: string, action: string, note = '') =>
    tx.query('INSERT INTO quality_events(id,org_id,issue_id,actor_id,action,note) VALUES($1,$2,$3,$4,$5,$6)', [randomUUID(), u.org_id, issueId, u.id, action, note.slice(0, 2000)]);
  const audit = (tx: Queryable, u: User, action: string, objectId: string, details: unknown) =>
    tx.query('INSERT INTO audit_events(id,org_id,department_id,owner_id,actor_id,action,object_id,details) VALUES($1,$2,$3,$4,$5,$6,$7,$8)',
      [randomUUID(), u.org_id, u.department_id, u.id, u.id, action, objectId, JSON.stringify(details)]);
  const issueOf = async (tx: Queryable, u: User, issueId: string, r: { role: string; factory: string | null }, lock = false) => {
    const i = (await tx.query('SELECT * FROM quality_issues WHERE id=$1 AND org_id=$2' + (lock ? ' FOR UPDATE' : ''), [issueId, u.org_id])).rows[0];
    if (!i || !visible(r, i)) deny(404, 'NOT_FOUND', 'Quality issue not found', '找不到这个品质问题。');
    return i;
  };
  const requireFactoryOrLead = (r: { role: string; factory: string | null }, i: any) => {
    if (r.role === 'lead' || (r.role === 'factory' && r.factory === i.factory)) return;
    deny(403, 'QUALITY_FACTORY_ONLY', 'Only the assigned factory or a quality lead can do this', '只有负责的工厂或品质负责人可以执行这个操作。');
  };
  const requireStatus = (i: any, ...allowed: string[]) => {
    if (!allowed.includes(i.status)) deny(409, 'QUALITY_WRONG_STEP', 'This issue is not at that step', '这个问题当前不在这一步，请刷新后再试。');
  };
  const people = async (org: string) => new Map((await db.query('SELECT id,display_name,name_zh,name_en,active,is_admin FROM users WHERE org_id=$1', [org])).rows.map((p: any) => [p.id, p]));
  const shape = (i: any, ppl: Map<string, any>, links = 0) => {
    const t = today();
    const planOverdue = i.status === 'sent' && !!i.plan_due && ymd(i.plan_due)! < t;
    const implOverdue = i.status === 'doing' && !!i.impl_due && ymd(i.impl_due)! < t;
    const end = i.closed_at || t;
    return {
      id: i.id, number: i.number, title: i.title, description: i.description, category: i.category, defect: i.defect, code: `${i.category}-${i.defect}`,
      model: i.model, sku: i.sku, batch: i.batch, severity: i.severity, factory: i.factory, status: i.status, resolution: i.resolution, affected: Number(i.affected),
      ownerId: i.owner_id, ownerName: nameOf(ppl.get(i.owner_id)), foundAt: ymd(i.found_at),
      dates: { sentAt: ymd(i.sent_at), planDue: ymd(i.plan_due), planAt: ymd(i.plan_at), approvedAt: ymd(i.approved_at), implDue: ymd(i.impl_due),
        implementedAt: ymd(i.implemented_at), verifiedAt: ymd(i.verified_at), closedAt: ymd(i.closed_at) },
      effectiveBatch: i.effective_batch,
      /* Days spent in each stage so far (a stage still running counts up to today). */
      durations: {
        toSend: days(i.found_at, i.sent_at || (i.status === 'new' ? end : null)),
        factoryReply: i.sent_at ? days(i.sent_at, i.plan_at || (i.status === 'sent' ? end : null)) : null,
        implementation: i.approved_at ? days(i.approved_at, i.implemented_at || (i.status === 'doing' ? end : null)) : null,
        verification: i.implemented_at ? days(i.implemented_at, i.verified_at || (i.status === 'verify' ? end : null)) : null,
        total: days(i.found_at, end),
      },
      overdue: planOverdue ? 'plan' : implOverdue ? 'implementation' : null,
      linkCount: links, createdByName: nameOf(ppl.get(i.created_by)), createdAt: i.created_at, updatedAt: i.updated_at,
    };
  };
  const meta = { categories: QUALITY_CATEGORIES, factories: QUALITY_FACTORIES, statuses: QUALITY_STATUSES, severities: SEVERITIES, linkKinds: LINK_KINDS };

  app.get('/quality', async req => {
    const u = actorOf(req), r = await roleOf(u), ppl = await people(u.org_id);
    const counts = new Map((await db.query('SELECT issue_id,count(*)::int n FROM quality_links WHERE org_id=$1 GROUP BY issue_id', [u.org_id])).rows.map((x: any) => [x.issue_id, x.n]));
    const rows = (await db.query('SELECT * FROM quality_issues WHERE org_id=$1 ORDER BY found_at DESC, created_at DESC LIMIT 2000', [u.org_id])).rows.filter((i: any) => visible(r, i));
    const leads = r.role === 'lead' ? [...ppl.values()].filter((p: any) => p.active && isLead(p as User)).map((p: any) => ({ id: p.id, name: nameOf(p) })) : [];
    return { items: rows.map((i: any) => shape(i, ppl, counts.get(i.id) || 0)), role: r.role, factory: r.factory, canCreate: r.role === 'lead', leads, today: today(), ...meta };
  });

  app.get<{ Params: { id: string } }>('/quality/:id', async req => {
    const u = actorOf(req), r = await roleOf(u), issueId = id.parse(req.params.id);
    const i = await issueOf(db, u, issueId, r), ppl = await people(u.org_id);
    const plans = (await db.query('SELECT * FROM quality_plans WHERE issue_id=$1 ORDER BY version DESC', [issueId])).rows.map((p: any) => ({
      id: p.id, version: p.version, rootCause: p.root_cause, corrective: p.corrective, preventive: p.preventive, implDue: ymd(p.impl_due),
      authorName: nameOf(ppl.get(p.author_id)), createdAt: p.created_at, decision: p.decision, decisionNote: p.decision_note, decidedByName: nameOf(ppl.get(p.decided_by)), decidedAt: p.decided_at }));
    const links = (await db.query('SELECT * FROM quality_links WHERE issue_id=$1 ORDER BY created_at', [issueId])).rows.map((l: any) => ({
      id: l.id, kind: l.kind, ref: l.ref, url: l.url, note: l.note, byName: nameOf(ppl.get(l.created_by)), createdAt: l.created_at }));
    const events = (await db.query('SELECT * FROM quality_events WHERE issue_id=$1 ORDER BY created_at, id', [issueId])).rows.map((e: any) => ({
      id: e.id, action: e.action, note: e.note, byName: nameOf(ppl.get(e.actor_id)), at: e.created_at }));
    const mine = r.role === 'lead' || (r.role === 'factory' && r.factory === i.factory);
    return { ...shape(i, ppl, links.length), plans, links, events, role: r.role,
      can: { edit: r.role === 'lead' && i.status !== 'closed', send: r.role === 'lead' && i.status === 'new', plan: mine && i.status === 'sent', decide: r.role === 'lead' && i.status === 'plan_review',
        implement: mine && i.status === 'doing', verify: r.role === 'lead' && i.status === 'verify', cancel: r.role === 'lead' && i.status !== 'closed', link: r.role === 'lead' } };
  });

  const codeOk = (category: string, defect: string) => {
    if (!QUALITY_CATEGORIES[category]?.defects[defect]) deny(400, 'QUALITY_CODE', 'Choose a defect code from the list', '请从列表中选择缺陷分类。');
  };
  const ownerOk = async (tx: Queryable, org: string, ownerId: string) => {
    const p = (await tx.query('SELECT * FROM users WHERE id=$1 AND org_id=$2 AND active=true', [ownerId, org])).rows[0];
    if (!p || !isLead(p)) deny(400, 'QUALITY_OWNER', 'The owner must be an active quality lead', '负责人必须是在职的品质负责人。');
  };
  const createInput = z.object({
    title: z.string().trim().min(4).max(300), description: longText().optional(), category: z.string().max(10), defect: z.string().max(10), model: z.string().trim().min(1).max(120),
    sku: z.string().trim().max(80).optional(), batch: z.string().trim().max(200).optional(), severity: z.enum(SEVERITIES), factory: z.enum(FACTORY_IDS),
    foundAt: day, affected: z.number().int().min(1).max(100000).default(1), ownerId: id.optional(),
  }).strict();
  app.post('/quality', async (req, reply) => {
    const u = actorOf(req), v = createInput.parse(req.body); requireLead(u); codeOk(v.category, v.defect);
    if (v.foundAt > today()) deny(400, 'QUALITY_FUTURE_DATE', 'The date cannot be in the future', '日期不能晚于今天。');
    const row = await db.transaction(async tx => {
      if (v.ownerId) await ownerOk(tx, u.org_id, v.ownerId);
      const year = v.foundAt.slice(0, 4);
      const n = Number((await tx.query('SELECT count(*)::int n FROM quality_issues WHERE org_id=$1 AND number LIKE $2', [u.org_id, `Q-${year}-%`])).rows[0].n) + 1;
      const issueId = randomUUID(), number = `Q-${year}-${String(n).padStart(4, '0')}`;
      const i = (await tx.query(`INSERT INTO quality_issues(id,org_id,number,title,description,category,defect,model,sku,batch,severity,factory,found_at,affected,owner_id,created_by)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16) RETURNING *`,
        [issueId, u.org_id, number, v.title, v.description || '', v.category, v.defect, v.model, v.sku || '', v.batch || '', v.severity, v.factory, v.foundAt, v.affected, v.ownerId || u.id, u.id])).rows[0];
      await event(tx, u, issueId, 'created', v.title);
      await audit(tx, u, 'quality.created', issueId, { number, code: `${v.category}-${v.defect}`, factory: v.factory });
      return i;
    });
    reply.code(201);
    return { id: row.id, number: row.number, status: row.status };
  });

  const updateInput = z.object({
    title: z.string().trim().min(4).max(300).optional(), description: longText().optional(), category: z.string().max(10).optional(), defect: z.string().max(10).optional(),
    model: z.string().trim().min(1).max(120).optional(), sku: z.string().trim().max(80).optional(), batch: z.string().trim().max(200).optional(), severity: z.enum(SEVERITIES).optional(),
    factory: z.enum(FACTORY_IDS).optional(), affected: z.number().int().min(1).max(100000).optional(), ownerId: id.optional(), planDue: day.optional(), implDue: day.optional(),
  }).strict().refine(v => Object.keys(v).length > 0, 'Nothing to change');
  app.post<{ Params: { id: string } }>('/quality/:id/update', async req => {
    const u = actorOf(req), v = updateInput.parse(req.body), issueId = id.parse(req.params.id); requireLead(u);
    return db.transaction(async tx => {
      const i = await issueOf(tx, u, issueId, { role: 'lead', factory: null }, true);
      if (i.status === 'closed') deny(409, 'QUALITY_CLOSED', 'This issue is closed', '这个问题已关闭。');
      if (v.category !== undefined || v.defect !== undefined) codeOk(v.category ?? i.category, v.defect ?? i.defect);
      if (v.factory && v.factory !== i.factory && i.status !== 'new') deny(409, 'QUALITY_FACTORY_LOCKED', 'The factory cannot change after the issue was sent', '问题已提交工厂后不能更换工厂。');
      if (v.planDue && i.status !== 'sent') deny(409, 'QUALITY_WRONG_STEP', 'This issue is not at that step', '这个问题当前不在这一步，请刷新后再试。');
      if (v.implDue && i.status !== 'doing') deny(409, 'QUALITY_WRONG_STEP', 'This issue is not at that step', '这个问题当前不在这一步，请刷新后再试。');
      if (v.ownerId) await ownerOk(tx, u.org_id, v.ownerId);
      const col: Record<string, string> = { title: 'title', description: 'description', category: 'category', defect: 'defect', model: 'model', sku: 'sku', batch: 'batch', severity: 'severity',
        factory: 'factory', affected: 'affected', ownerId: 'owner_id', planDue: 'plan_due', implDue: 'impl_due' };
      const sets: string[] = [], vals: unknown[] = [issueId];
      for (const [k, val] of Object.entries(v)) { vals.push(val); sets.push(`${col[k]}=$${vals.length}`); }
      await tx.query(`UPDATE quality_issues SET ${sets.join(',')},updated_at=now() WHERE id=$1`, vals);
      await event(tx, u, issueId, 'updated', Object.keys(v).join(', '));
      return { ok: true };
    });
  });

  app.post<{ Params: { id: string } }>('/quality/:id/send', async req => {
    const u = actorOf(req), v = z.object({ sentAt: day.optional(), planDue: day.optional(), note: longText().optional() }).strict().parse(req.body ?? {}), issueId = id.parse(req.params.id); requireLead(u);
    return db.transaction(async tx => {
      const i = await issueOf(tx, u, issueId, { role: 'lead', factory: null }, true); requireStatus(i, 'new');
      const sent = v.sentAt || today(), due = v.planDue || addDays(sent, DEFAULT_PLAN_DAYS);
      if (sent > today()) deny(400, 'QUALITY_FUTURE_DATE', 'The date cannot be in the future', '日期不能晚于今天。');
      if (sent < ymd(i.found_at)! || due < sent) deny(400, 'QUALITY_DATE_ORDER', 'Dates must follow the order of the steps', '日期顺序不对：后一步的日期不能早于前一步。');
      await tx.query(`UPDATE quality_issues SET status='sent',sent_at=$2,plan_due=$3,updated_at=now() WHERE id=$1`, [issueId, sent, due]);
      await event(tx, u, issueId, 'sent', v.note || '');
      await audit(tx, u, 'quality.sent', issueId, { factory: i.factory, sentAt: sent, planDue: due });
      return { ok: true, sentAt: sent, planDue: due };
    });
  });

  const planInput = z.object({ rootCause: longText(5), corrective: longText(5), preventive: longText(5), implDue: day, planAt: day.optional() }).strict();
  app.post<{ Params: { id: string } }>('/quality/:id/plan', async (req, reply) => {
    const u = actorOf(req), v = planInput.parse(req.body), issueId = id.parse(req.params.id), r = await roleOf(u);
    const out = await db.transaction(async tx => {
      const i = await issueOf(tx, u, issueId, r, true); requireFactoryOrLead(r, i); requireStatus(i, 'sent');
      const at = v.planAt || today();
      if (at > today()) deny(400, 'QUALITY_FUTURE_DATE', 'The date cannot be in the future', '日期不能晚于今天。');
      if (at < ymd(i.sent_at)! || v.implDue < at) deny(400, 'QUALITY_DATE_ORDER', 'Dates must follow the order of the steps', '日期顺序不对：后一步的日期不能早于前一步。');
      const version = Number((await tx.query('SELECT COALESCE(max(version),0)::int n FROM quality_plans WHERE issue_id=$1', [issueId])).rows[0].n) + 1;
      const planId = randomUUID();
      await tx.query('INSERT INTO quality_plans(id,org_id,issue_id,version,root_cause,corrective,preventive,impl_due,author_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)',
        [planId, u.org_id, issueId, version, v.rootCause, v.corrective, v.preventive, v.implDue, u.id]);
      await tx.query(`UPDATE quality_issues SET status='plan_review',plan_at=$2,impl_due=$3,updated_at=now() WHERE id=$1`, [issueId, at, v.implDue]);
      await event(tx, u, issueId, 'plan', `v${version}`);
      await audit(tx, u, 'quality.plan', issueId, { version, implDue: v.implDue });
      return { id: planId, version };
    });
    reply.code(201);
    return out;
  });

  const decisionInput = z.object({ decision: z.enum(['approve', 'return']), note: z.string().trim().max(4000).default('') }).strict()
    .refine(v => v.decision === 'approve' || v.note.length >= 5, { message: 'Explain what the factory must change', path: ['note'] });
  app.post<{ Params: { id: string } }>('/quality/:id/decision', async req => {
    const u = actorOf(req), v = decisionInput.parse(req.body), issueId = id.parse(req.params.id); requireLead(u);
    return db.transaction(async tx => {
      const i = await issueOf(tx, u, issueId, { role: 'lead', factory: null }, true); requireStatus(i, 'plan_review');
      const p = (await tx.query('SELECT * FROM quality_plans WHERE issue_id=$1 ORDER BY version DESC LIMIT 1', [issueId])).rows[0];
      await tx.query('UPDATE quality_plans SET decision=$2,decision_note=$3,decided_by=$4,decided_at=now() WHERE id=$1', [p.id, v.decision, v.note, u.id]);
      if (v.decision === 'approve') await tx.query(`UPDATE quality_issues SET status='doing',approved_at=$2,impl_due=$3,updated_at=now() WHERE id=$1`, [issueId, today(), p.impl_due]);
      else await tx.query(`UPDATE quality_issues SET status='sent',plan_at=NULL,plan_due=GREATEST(plan_due,$2::date),updated_at=now() WHERE id=$1`, [issueId, addDays(today(), 3)]);
      await event(tx, u, issueId, 'plan_' + v.decision, v.note);
      await audit(tx, u, 'quality.plan_' + v.decision, issueId, { version: p.version });
      return { ok: true, status: v.decision === 'approve' ? 'doing' : 'sent' };
    });
  });

  const implInput = z.object({ implementedAt: day, effectiveBatch: z.string().trim().min(1).max(200), note: longText().optional() }).strict();
  app.post<{ Params: { id: string } }>('/quality/:id/implemented', async req => {
    const u = actorOf(req), v = implInput.parse(req.body), issueId = id.parse(req.params.id), r = await roleOf(u);
    return db.transaction(async tx => {
      const i = await issueOf(tx, u, issueId, r, true); requireFactoryOrLead(r, i); requireStatus(i, 'doing');
      if (v.implementedAt > today()) deny(400, 'QUALITY_FUTURE_DATE', 'The date cannot be in the future', '日期不能晚于今天。');
      if (v.implementedAt < ymd(i.approved_at)!) deny(400, 'QUALITY_DATE_ORDER', 'Dates must follow the order of the steps', '日期顺序不对：后一步的日期不能早于前一步。');
      await tx.query(`UPDATE quality_issues SET status='verify',implemented_at=$2,effective_batch=$3,updated_at=now() WHERE id=$1`, [issueId, v.implementedAt, v.effectiveBatch]);
      await event(tx, u, issueId, 'implemented', [v.effectiveBatch, v.note].filter(Boolean).join(' · '));
      await audit(tx, u, 'quality.implemented', issueId, { implementedAt: v.implementedAt, effectiveBatch: v.effectiveBatch });
      return { ok: true };
    });
  });

  const verifyInput = z.object({ result: z.enum(['pass', 'fail']), verifiedAt: day.optional(), note: z.string().trim().min(5).max(4000) }).strict();
  app.post<{ Params: { id: string } }>('/quality/:id/verify', async req => {
    const u = actorOf(req), v = verifyInput.parse(req.body), issueId = id.parse(req.params.id); requireLead(u);
    return db.transaction(async tx => {
      const i = await issueOf(tx, u, issueId, { role: 'lead', factory: null }, true); requireStatus(i, 'verify');
      const at = v.verifiedAt || today();
      if (at > today()) deny(400, 'QUALITY_FUTURE_DATE', 'The date cannot be in the future', '日期不能晚于今天。');
      if (at < ymd(i.implemented_at)!) deny(400, 'QUALITY_DATE_ORDER', 'Dates must follow the order of the steps', '日期顺序不对：后一步的日期不能早于前一步。');
      if (v.result === 'pass') await tx.query(`UPDATE quality_issues SET status='closed',resolution='fixed',verified_at=$2,closed_at=$2,updated_at=now() WHERE id=$1`, [issueId, at]);
      else await tx.query(`UPDATE quality_issues SET status='doing',implemented_at=NULL,effective_batch='',updated_at=now() WHERE id=$1`, [issueId]);
      await event(tx, u, issueId, 'verify_' + v.result, v.note);
      await audit(tx, u, 'quality.verify_' + v.result, issueId, { verifiedAt: at });
      return { ok: true, status: v.result === 'pass' ? 'closed' : 'doing' };
    });
  });

  app.post<{ Params: { id: string } }>('/quality/:id/cancel', async req => {
    const u = actorOf(req), v = z.object({ reason: z.string().trim().min(5).max(2000) }).strict().parse(req.body), issueId = id.parse(req.params.id); requireLead(u);
    return db.transaction(async tx => {
      const i = await issueOf(tx, u, issueId, { role: 'lead', factory: null }, true);
      if (i.status === 'closed') deny(409, 'QUALITY_CLOSED', 'This issue is closed', '这个问题已关闭。');
      await tx.query(`UPDATE quality_issues SET status='closed',resolution='cancelled',closed_at=$2,updated_at=now() WHERE id=$1`, [issueId, today()]);
      await event(tx, u, issueId, 'cancelled', v.reason);
      await audit(tx, u, 'quality.cancelled', issueId, { from: i.status });
      return { ok: true };
    });
  });

  const linkInput = z.object({ kind: z.enum(LINK_KINDS), ref: z.string().trim().min(1).max(200), url: z.string().trim().max(2000).url().refine(s => /^https?:\/\//.test(s)).optional(),
    note: z.string().trim().max(2000).optional(), bumpAffected: z.boolean().default(true) }).strict();
  app.post<{ Params: { id: string } }>('/quality/:id/links', async (req, reply) => {
    const u = actorOf(req), v = linkInput.parse(req.body), issueId = id.parse(req.params.id); requireLead(u);
    const linkId = randomUUID();
    await db.transaction(async tx => {
      const i = await issueOf(tx, u, issueId, { role: 'lead', factory: null }, true);
      await tx.query('INSERT INTO quality_links(id,org_id,issue_id,kind,ref,url,note,created_by) VALUES($1,$2,$3,$4,$5,$6,$7,$8)', [linkId, u.org_id, issueId, v.kind, v.ref, v.url || '', v.note || '', u.id]);
      /* The first evidence is what created the issue; later reports of the same defect raise the affected count. */
      const n = Number((await tx.query('SELECT count(*)::int n FROM quality_links WHERE issue_id=$1', [issueId])).rows[0].n);
      if (v.bumpAffected && n > Number(i.affected)) await tx.query('UPDATE quality_issues SET affected=$2,updated_at=now() WHERE id=$1', [issueId, n]);
      await event(tx, u, issueId, 'link:' + v.kind, v.ref);
    });
    reply.code(201);
    return { id: linkId };
  });
}
