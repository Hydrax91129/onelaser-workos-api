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
import type { Notifier } from './assign.js';
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
    if (o.notify) { try { if (await o.notify(userId, `【WorkOS】${message}`)) channels.push('dingtalk'); } catch { /* in-app copy stands */ } }
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
          FROM users u WHERE u.active=true`, [p])).rows;
        for (const u of users) if (Number(u.pts) < 100) out.setup += await remind(u.org_id, u.id, `okr:${p}:setup:${u.id}`, 'okr_setup', today,
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
  app.post('/okr/cycle/run', async req => { const user = actorOf(req); if (!o.isAdmin(user)) deny(403, 'FORBIDDEN', 'Administrator access is required'); return runCycle(); });

  if (o.intervalMs && o.intervalMs > 0) {
    const timer = setInterval(() => { runCycle().catch(() => undefined); }, o.intervalMs);
    timer.unref?.();
    app.addHook('onClose', async () => clearInterval(timer));
  }
  return { runCycle };
}
