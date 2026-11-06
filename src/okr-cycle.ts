/* Monthly OKR rhythm (cycle = calendar month, e.g. November):
 *  - from the 25th of the previous month: everyone is reminded daily to set next month's OKR
 *    (until their objectives add up to 100 points, at the latest until the 5th);
 *  - from the 25th of the month until the 30th (or month end): owners are reminded daily to self-score;
 *    anything still not self-scored afterwards is self-scored 0 by the system;
 *  - from the 30th (or month end) until the 3rd of the next month: leaders are reminded daily to score.
 * Reminders land in the in-app follow-up feed (task_nudges) and DingTalk when enabled. */
import { randomUUID } from 'node:crypto';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { Database } from './db.js';
import type { User } from './auth.js';
import { sentChannels, type Notifier } from './assign.js';
import { deny } from './errors.js';

export type CycleOptions = { notify?: Notifier | null; intervalMs?: number; now?: () => number; timeZone?: string; isAdmin: (u: User) => boolean };

const pad = (n: number) => String(n).padStart(2, '0');
const lastDay = (y: number, m: number) => new Date(Date.UTC(y, m, 0)).getUTCDate();
export function localDate(t: number, timeZone: string) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date(t)).map(p => [p.type, p.value]));
  return { y: Number(parts.year), m: Number(parts.month), d: Number(parts.day), iso: `${parts.year}-${parts.month}-${parts.day}` };
}
const shift = (y: number, m: number, n: number) => { const d = new Date(Date.UTC(y, m - 1 + n, 1)); return { y: d.getUTCFullYear(), m: d.getUTCMonth() + 1 }; };
const period = (y: number, m: number) => `${y}-${pad(m)}`;

/** Key dates of a cycle, as YYYY-MM-DD. */
export function cycleDates(p: string) {
  const [y, m] = p.split('-').map(Number), prev = shift(y, m, -1), next = shift(y, m, 1), selfEndDay = Math.min(30, lastDay(y, m));
  return {
    period: p,
    setupFrom: `${period(prev.y, prev.m)}-25`, setupUntil: `${period(y, m)}-05`,
    selfFrom: `${period(y, m)}-25`, selfUntil: `${period(y, m)}-${pad(selfEndDay)}`,
    leadFrom: `${period(y, m)}-${pad(selfEndDay)}`, leadUntil: `${period(next.y, next.m)}-03`,
  };
}

export async function registerOkrCycle(app: FastifyInstance, db: Database, o: CycleOptions) {
  const now = o.now || Date.now, tz = o.timeZone || 'America/Los_Angeles';
  const actorOf = (req: FastifyRequest): User => req.actor || deny(401, 'UNAUTHENTICATED', 'Authentication is required');

  async function remind(orgId: string, userId: string, key: string, kind: string, day: string, message: string) {
    const inserted = (await db.query(`INSERT INTO task_nudges(id,org_id,task_id,user_id,kind,day,message) VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT(task_id,kind,day) DO NOTHING RETURNING id`,
      [randomUUID(), orgId, key, userId, kind, day, message])).rows[0];
    if (!inserted) return 0;
    const channels = ['app'];
    if (o.notify) { try { channels.push(...sentChannels(await o.notify(userId, `【WorkOS】${message}`))); } catch { /* in-app copy stands */ } }
    await db.query('UPDATE task_nudges SET channels=$2 WHERE id=$1', [inserted.id, JSON.stringify(channels)]);
    return 1;
  }
  /** Items (key results, or objectives without key results) of a period with their latest self/leader score. */
  async function scorables(p: string) {
    return (await db.query(`SELECT 'kr' AS type,k.id,k.title,o.id AS objective_id,o.org_id,o.owner_id,o.department_id,
        (SELECT count(*)::int FROM kr_scores s WHERE s.kr_id=k.id AND s.kind='self') AS self_n,(SELECT count(*)::int FROM kr_scores s WHERE s.kr_id=k.id AND s.kind='manager') AS lead_n
      FROM key_results k JOIN objectives o ON o.id=k.objective_id WHERE o.planning->>'period'=$1 AND o.archived_at IS NULL AND k.archived_at IS NULL AND o.owner_id IS NOT NULL
      UNION ALL
      SELECT 'o',o.id,o.title,o.id,o.org_id,o.owner_id,o.department_id,
        (SELECT count(*)::int FROM objective_scores s WHERE s.objective_id=o.id AND s.kind='self'),(SELECT count(*)::int FROM objective_scores s WHERE s.objective_id=o.id AND s.kind='manager')
      FROM objectives o WHERE o.planning->>'period'=$1 AND o.archived_at IS NULL AND o.owner_id IS NOT NULL
        AND NOT EXISTS (SELECT 1 FROM key_results k WHERE k.objective_id=o.id AND k.archived_at IS NULL)`, [p])).rows;
  }
  async function leadersOf(ownerId: string) {
    const u = (await db.query('SELECT id,org_id,department_id,manager_id FROM users WHERE id=$1', [ownerId])).rows[0];
    if (!u) return [];
    if (u.manager_id) { const m = (await db.query('SELECT id FROM users WHERE id=$1 AND active=true', [u.manager_id])).rows[0]; if (m) return [m.id]; }
    return (await db.query("SELECT id FROM users WHERE org_id=$1 AND department_id=$2 AND role='manager' AND active=true AND id<>$3", [u.org_id, u.department_id, u.id])).rows.map((r: any) => r.id);
  }

  async function runCycle() {
    const t = localDate(now(), tz), today = t.iso;
    const out = { setup: 0, self: 0, autoZero: 0, lead: 0, today };
    const periods = new Set([period(t.y, t.m), period(shift(t.y, t.m, 1).y, shift(t.y, t.m, 1).m), period(shift(t.y, t.m, -1).y, shift(t.y, t.m, -1).m)]);
    for (const p of periods) {
      const c = cycleDates(p), label = `${Number(p.slice(5))}月`;
      // 1. Setting next month's OKR.
      if (today >= c.setupFrom && today <= c.setupUntil) {
        const users = (await db.query(`SELECT u.id,u.org_id,COALESCE((SELECT sum((o.planning->>'weight')::numeric) FROM objectives o WHERE o.owner_id=u.id AND o.archived_at IS NULL AND o.planning->>'period'=$1 AND o.level<>'company'),0) AS pts
          FROM users u WHERE u.active=true AND NOT EXISTS (SELECT 1 FROM okr_publications p WHERE p.org_id=u.org_id AND p.owner_id=u.id AND p.period=$1)`, [p])).rows;
        // Daily until the OKR is published.
        for (const u of users) if (Number(u.pts) >= 100) out.setup += await remind(u.org_id, u.id, `okr:${p}:setup:${u.id}`, 'okr_setup', today, `${label} OKR 已经填写，但还没有最终发布。请检查目标合计 100 分、每个目标的 KR 权重合计 100%，然后点击“最终发布”。发布后 KR 会变成你的任务。`);
        else if (Number(u.pts) < 100) out.setup += await remind(u.org_id, u.id, `okr:${p}:setup:${u.id}`, 'okr_setup', today,
          Number(u.pts) > 0 ? `${label} OKR 还没设置完：目标分值合计 ${Number(u.pts)} 分，应为 100 分。请在 ${c.setupUntil.slice(5).replace('-', '/')} 前补齐目标和关键结果。` : `请设置你的${label} OKR：写好目标（合计 100 分）和关键结果（目标值写“完成”或明确数字）。设置完成后关键结果会自动进入你的任务中心。`);
      }
      const items = (today >= c.selfFrom && today <= c.leadUntil) || today > c.selfUntil ? await scorables(p) : [];
      // 2. Self scores, then automatic 0 after the deadline.
      if (today >= c.selfFrom && today <= c.selfUntil) {
        const missing = new Map<string, { org: string; n: number }>();
        for (const i of items) if (!i.self_n) { const m = missing.get(i.owner_id) || { org: i.org_id, n: 0 }; m.n++; missing.set(i.owner_id, m); }
        for (const [owner, m] of missing) out.self += await remind(m.org, owner, `okr:${p}:self:${owner}`, 'okr_self', today,
          `请完成${label} OKR 自评：还有 ${m.n} 项没有自评，截止 ${c.selfUntil.slice(5).replace('-', '/')}。逾期未自评的项目，系统会按 0 分自评。`);
      }
      if (today > c.selfUntil && today <= c.leadUntil) {
        for (const i of items) if (!i.self_n) {
          if (i.type === 'kr') await db.query("INSERT INTO kr_scores(id,kr_id,kind,score,comment,author_id) VALUES($1,$2,'self',0,$3,$4)", [randomUUID(), i.id, '逾期未自评，系统按 0 分自评', i.owner_id]);
          else await db.query("INSERT INTO objective_scores(id,objective_id,kind,score,comment,author_id) VALUES($1,$2,'self',0,$3,$4)", [randomUUID(), i.id, '逾期未自评，系统按 0 分自评', i.owner_id]);
          i.self_n = 1; out.autoZero++;
        }
      }
      // 3. Leader scores.
      if (today >= c.leadFrom && today <= c.leadUntil) {
        const byLeader = new Map<string, { org: string; owners: Set<string>; n: number }>();
        for (const i of items) if (!i.lead_n) for (const l of await leadersOf(i.owner_id)) { const e = byLeader.get(l) || { org: i.org_id, owners: new Set(), n: 0 }; e.owners.add(i.owner_id); e.n++; byLeader.set(l, e); }
        for (const [leader, e] of byLeader) out.lead += await remind(e.org, leader, `okr:${p}:lead:${leader}`, 'okr_lead', today,
          `请完成${label} OKR 领导评分：${e.owners.size} 位同事共 ${e.n} 项待评，截止 ${c.leadUntil.slice(5).replace('-', '/')}。最终分 = 自评 50% + 领导 50%。`);
      }
    }
    return out;
  }

  app.get('/okr/cycle', async req => {
    actorOf(req);
    const q = (req.query as any)?.period, t = localDate(now(), tz), p = typeof q === 'string' && /^\d{4}-(0[1-9]|1[0-2])$/.test(q) ? q : period(t.y, t.m);
    const c = cycleDates(p), today = t.iso;
    const phase = today < c.setupFrom ? 'before' : today <= c.setupUntil && today < c.selfFrom ? 'setup' : today < c.selfFrom ? 'running' : today <= c.selfUntil ? 'self' : today <= c.leadUntil ? 'lead' : 'closed';
    return { ...c, today, phase, timeZone: tz };
  });
  /* 一键催办: a leader reminds everyone in their reporting scope who is behind on the current stage of a cycle.
   * Setup: OKR not published once the setup window is open. Self: items not self-scored once self-scoring opened.
   * Lead: a leader in scope (not the sender) with items of their people still to score. One manual reminder per person,
   * stage and day; it goes to the in-app follow-up feed and DingTalk like the daily reminders. */
  async function behind(user: User, p: string) {
    const c = cycleDates(p), today = localDate(now(), tz).iso, admin = o.isAdmin(user);
    const scope = Array.isArray(user.visibleOwnerIds) ? user.visibleOwnerIds
      : admin ? (await db.query('SELECT id FROM users WHERE org_id=$1', [user.org_id])).rows.map((r: any) => r.id)
      : user.role === 'manager' ? (await db.query('SELECT id FROM users WHERE org_id=$1 AND department_id=$2', [user.org_id, user.department_id])).rows.map((r: any) => r.id) : [];
    const ids = scope.filter(id => id !== user.id);
    if (!ids.length) return { period: p, today, items: [] as any[] };
    const people = (await db.query(`SELECT u.id,u.display_name,u.manager_id FROM users u WHERE u.org_id=$1 AND u.id=ANY($2::text[]) AND u.active=true AND COALESCE(u.quality_factory,'')=''`, [user.org_id, ids])).rows;
    const name = new Map(people.map((r: any) => [r.id, r.display_name]));
    const out: { userId: string; name: string; stage: 'setup' | 'self' | 'lead'; overdue: boolean; count: number; detail: string; deadline: string }[] = [];
    const mmdd = (d: string) => d.slice(5).replace('-', '/');
    if (today >= c.setupFrom) {
      const published = new Set((await db.query('SELECT owner_id FROM okr_publications WHERE org_id=$1 AND period=$2', [user.org_id, p])).rows.map((r: any) => r.owner_id));
      for (const r of people) if (!published.has(r.id)) out.push({ userId: r.id, name: r.display_name, stage: 'setup', overdue: today > c.setupUntil, count: 0, detail: '还没有发布 OKR', deadline: c.setupUntil });
    }
    if (today >= c.selfFrom || today >= c.leadFrom) {
      const items = (await scorables(p)).filter((i: any) => i.org_id === user.org_id);
      if (today >= c.selfFrom) {
        const missing = new Map<string, number>();
        for (const i of items) if (!i.self_n && name.has(i.owner_id)) missing.set(i.owner_id, (missing.get(i.owner_id) || 0) + 1);
        for (const [id, n] of missing) out.push({ userId: id, name: name.get(id), stage: 'self', overdue: today > c.selfUntil, count: n, detail: `${n} 项未自评`, deadline: c.selfUntil });
      }
      if (today >= c.leadFrom) {
        const pending = new Map<string, number>();
        for (const i of items) if (!i.lead_n && (name.has(i.owner_id) || i.owner_id === user.id)) for (const l of await leadersOf(i.owner_id)) if (l !== user.id && name.has(l)) pending.set(l, (pending.get(l) || 0) + 1);
        for (const [id, n] of pending) out.push({ userId: id, name: name.get(id), stage: 'lead', overdue: today > c.leadUntil, count: n, detail: `${n} 项待领导评分`, deadline: c.leadUntil });
      }
    }
    return { period: p, today, items: out.map(x => ({ ...x, deadline: mmdd(x.deadline) })) };
  }
  const periodOf = (v: unknown) => { const t = localDate(now(), tz); return typeof v === 'string' && /^\d{4}-(0[1-9]|1[0-2])$/.test(v) ? v : period(t.y, t.m); };
  app.get('/okr/nudge', async req => behind(actorOf(req), periodOf((req.query as any)?.period)));
  app.post('/okr/nudge', async req => {
    const user = actorOf(req), body = (req.body || {}) as any, p = periodOf(body.period);
    const only = Array.isArray(body.userIds) ? new Set(body.userIds.filter((x: unknown) => typeof x === 'string')) : null;
    const list = (await behind(user, p)).items.filter(x => !only || only.has(x.userId));
    if (!list.length) return { period: p, sent: 0, already: 0 };
    const label = `${Number(p.slice(5))}月`, today = localDate(now(), tz).iso, from = user.display_name || '领导';
    const text: Record<string, (x: any) => string> = {
      setup: x => `${from} 催办：请尽快完成并发布你的${label} OKR（截止 ${x.deadline}${x.overdue ? '，已逾期' : ''}）。`,
      self: x => `${from} 催办：你的${label} OKR 还有 ${x.count} 项没有自评（截止 ${x.deadline}${x.overdue ? '，已逾期' : ''}）。`,
      lead: x => `${from} 催办：请尽快给团队的${label} OKR 打领导分，还有 ${x.count} 项待评（截止 ${x.deadline}${x.overdue ? '，已逾期' : ''}）。`,
    };
    let sent = 0, already = 0;
    for (const x of list) {
      const n = await remind(user.org_id, x.userId, `okr:${p}:manual-${x.stage}:${x.userId}`, 'okr_manual', today, text[x.stage](x));
      if (n) sent++; else already++;
    }
    return { period: p, sent, already };
  });
  app.post('/okr/cycle/run', async req => { const user = actorOf(req); if (!o.isAdmin(user)) deny(403, 'FORBIDDEN', 'Administrator access is required'); return runCycle(); });

  if (o.intervalMs && o.intervalMs > 0) {
    const timer = setInterval(() => { runCycle().catch(() => undefined); }, o.intervalMs);
    timer.unref?.();
    app.addHook('onClose', async () => clearInterval(timer));
  }
  return { runCycle };
}
