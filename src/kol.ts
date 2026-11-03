/* KOL (influencer) management, phase 1.
 *
 *   kol_profiles   one row per KOL. Columns prefixed `up_` and the contact/social columns mirror UpPromote and are
 *                  overwritten by every sync; stage, tier, platform, followers, niche, owner, products, fee and notes
 *                  are ours and a sync never touches them. KOLs not (yet) in UpPromote are added by hand and are
 *                  linked to their UpPromote affiliate by email on the next sync.
 *   kol_referrals  UpPromote referrals (attributed orders): order number, sales, commission and status. No customer data.
 *   kol_collabs    our cooperation log per KOL: samples sent, content published, payments and notes.
 *   kol_sync_state one row per org: when UpPromote was last synced and what came back.
 *
 * Access: company admins, plus people granted `kol` (view) or `kol_manage` (edit, sync) in ERP permissions.
 *
 * UpPromote: REST API v2 at aff-api.uppromote.com with the store API key (UPPROMOTE_API_KEY) as the raw Authorization
 * header. The store is small (hundreds of affiliates, about a thousand referrals), so every sync reads everything:
 * referral statuses and commission totals change after the fact and the API filters only on creation time. A sync runs
 * on demand and every KOL_SYNC_INTERVAL_MS (30 minutes in production) for each org that has synced before. */
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { Database, Queryable } from './db.js';
import type { User } from './auth.js';
import { deny } from './errors.js';

export const kolSchema = `
CREATE TABLE IF NOT EXISTS kol_profiles(id text PRIMARY KEY, org_id text NOT NULL, up_id bigint, name text NOT NULL, email text NOT NULL DEFAULT '', phone text NOT NULL DEFAULT '',
  company text NOT NULL DEFAULT '', country text NOT NULL DEFAULT '', region text NOT NULL DEFAULT '', city text NOT NULL DEFAULT '', address text NOT NULL DEFAULT '',
  socials jsonb NOT NULL DEFAULT '{}', up_status text NOT NULL DEFAULT '', up_program text NOT NULL DEFAULT '', up_link text NOT NULL DEFAULT '', up_custom_link text NOT NULL DEFAULT '',
  up_coupons jsonb NOT NULL DEFAULT '[]', up_paid numeric(14,2) NOT NULL DEFAULT 0, up_approved numeric(14,2) NOT NULL DEFAULT 0, up_pending numeric(14,2) NOT NULL DEFAULT 0,
  up_created_at timestamptz, up_synced_at timestamptz,
  stage text NOT NULL DEFAULT 'prospect', tier text NOT NULL DEFAULT '', platform text NOT NULL DEFAULT '', followers integer, niche text NOT NULL DEFAULT '', owner_id text,
  products text NOT NULL DEFAULT '', fee text NOT NULL DEFAULT '', notes text NOT NULL DEFAULT '',
  version integer NOT NULL DEFAULT 1, created_by text, created_at timestamptz NOT NULL DEFAULT now(), updated_by text, updated_at timestamptz NOT NULL DEFAULT now());
CREATE UNIQUE INDEX IF NOT EXISTS kol_profiles_up ON kol_profiles(org_id, up_id);
CREATE TABLE IF NOT EXISTS kol_referrals(org_id text NOT NULL, id bigint NOT NULL, up_affiliate_id bigint NOT NULL, order_number text NOT NULL DEFAULT '', quantity integer NOT NULL DEFAULT 0,
  sales numeric(14,2) NOT NULL DEFAULT 0, commission numeric(14,2) NOT NULL DEFAULT 0, status text NOT NULL, tracking text NOT NULL DEFAULT '', coupon text NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL, PRIMARY KEY(org_id, id));
CREATE INDEX IF NOT EXISTS kol_referrals_affiliate ON kol_referrals(org_id, up_affiliate_id, created_at);
CREATE TABLE IF NOT EXISTS kol_collabs(id text PRIMARY KEY, org_id text NOT NULL, kol_id text NOT NULL REFERENCES kol_profiles(id) ON DELETE CASCADE, kind text NOT NULL, happened_on date NOT NULL,
  product text NOT NULL DEFAULT '', cost numeric(14,2), url text NOT NULL DEFAULT '', note text NOT NULL DEFAULT '', actor_id text NOT NULL, created_at timestamptz NOT NULL DEFAULT now());
CREATE INDEX IF NOT EXISTS kol_collabs_kol ON kol_collabs(kol_id, happened_on);
CREATE TABLE IF NOT EXISTS kol_sync_state(org_id text PRIMARY KEY, started_at timestamptz, finished_at timestamptz, ok boolean, error text NOT NULL DEFAULT '', counts jsonb NOT NULL DEFAULT '{}');
`;

export type KolOptions = { uppromoteApiKey?: string; uppromoteBaseUrl?: string; syncIntervalMs?: number };
export function kolOptionsFromEnv(env: NodeJS.ProcessEnv): KolOptions {
  return { uppromoteApiKey: env.UPPROMOTE_API_KEY || undefined, uppromoteBaseUrl: env.UPPROMOTE_BASE_URL || undefined, syncIntervalMs: Number(env.KOL_SYNC_INTERVAL_MS) || undefined };
}

/* ---------- UpPromote client ---------- */
const PER_PAGE = 100, MAX_PAGES = 200;
export async function fetchUpPromote(o: { apiKey: string; baseUrl?: string; fetcher?: typeof fetch; wait?: (ms: number) => Promise<void> }, resource: 'affiliates' | 'referrals') {
  const base = (o.baseUrl || 'https://aff-api.uppromote.com').replace(/\/+$/, ''), fetcher = o.fetcher || fetch, wait = o.wait || (ms => new Promise(r => setTimeout(r, ms)));
  const out: any[] = [];
  for (let page = 1; page <= MAX_PAGES; page++) {
    let res: Response | null = null;
    for (let attempt = 0; ; attempt++) {
      try { res = await fetcher(`${base}/api/v2/${resource}?per_page=${PER_PAGE}&page=${page}`, { headers: { Authorization: o.apiKey, Accept: 'application/json' }, signal: AbortSignal.timeout(30_000) }); }
      catch { res = null; }
      // UpPromote answers rate limits with 429 or with 400 "Too Many Attempts"; back off and retry a few times.
      const limited = res && (res.status === 429 || (res.status === 400 && /too many/i.test(await res.clone().text().catch(() => ''))));
      if ((!res || limited || res.status >= 500) && attempt < 3) { await wait(2000 * (attempt + 1)); continue; }
      break;
    }
    if (!res) deny(502, 'UPPROMOTE_UNREACHABLE', 'UpPromote could not be reached');
    if (res.status === 401 || res.status === 403) deny(502, 'UPPROMOTE_UNAUTHORIZED', 'UpPromote rejected the API key');
    if (!res.ok) deny(502, 'UPPROMOTE_ERROR', 'UpPromote returned an error');
    const body: any = await res.json().catch(() => null);
    if (!body || !Array.isArray(body.data)) deny(502, 'UPPROMOTE_ERROR', 'UpPromote returned an error');
    out.push(...body.data);
    if (body.data.length < PER_PAGE) return out;
  }
  return out;
}

/* ---------- constants and inputs ---------- */
export const STAGES = ['prospect', 'contacted', 'negotiating', 'partner', 'sample_sent', 'content_live', 'long_term', 'paused'] as const;
const TIERS = ['', 'S', 'A', 'B', 'C'] as const;
const PLATFORMS = ['', 'youtube', 'instagram', 'tiktok', 'facebook', 'blog', 'other'] as const;
const COLLAB_KINDS = ['sample', 'content', 'payment', 'contact', 'note'] as const;
const SOCIALS = ['website', 'youtube', 'instagram', 'tiktok', 'facebook', 'twitter'] as const;
const id = z.string().min(1).max(100).regex(/^[A-Za-z0-9_-]+$/);
const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use a date like 2026-11-02')
  .refine(v => { const d = new Date(v + 'T00:00:00Z'); return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === v; }, 'Use a real calendar date');
const text = (max: number) => z.string().trim().max(max);
const url = z.union([z.literal(''), z.string().trim().max(500).regex(/^https?:\/\/\S+$/i, 'Use a link starting with http:// or https://')]);
const ymd = (v: any) => v ? (v instanceof Date ? v.toISOString().slice(0, 10) : String(v).slice(0, 10)) : null;
const iso = (v: any) => v ? new Date(v).toISOString() : null;
const num = (v: any) => { const n = Number(v); return Number.isFinite(n) ? n : 0; };
const str = (v: any, max = 500) => v == null ? '' : String(v).trim().slice(0, max);
const nameOf = (u: any) => u ? (u.display_name || u.name_zh || u.name_en || u.id) : '';

const ownFields = {
  stage: z.enum(STAGES).optional(), tier: z.enum(TIERS).optional(), platform: z.enum(PLATFORMS).optional(),
  followers: z.number().int().min(0).max(2_000_000_000).nullable().optional(), niche: text(120).optional(), ownerId: id.nullable().optional(),
  products: text(500).optional(), fee: text(500).optional(), notes: text(4000).optional(),
};
// Contact details of hand-added KOLs; for UpPromote KOLs they come from UpPromote and are read-only here.
const contactFields = {
  name: z.string().trim().min(1).max(120).optional(), email: z.union([z.literal(''), z.string().trim().max(200).email()]).optional(), phone: text(60).optional(),
  company: text(120).optional(), country: text(60).optional(), region: text(80).optional(), city: text(80).optional(),
  socials: z.object(Object.fromEntries(SOCIALS.map(s => [s, text(300).optional()])) as Record<typeof SOCIALS[number], z.ZodOptional<z.ZodString>>).strict().optional(),
};
const createInput = z.object({ ...contactFields, name: z.string().trim().min(1).max(120), ...ownFields }).strict();
const updateInput = z.object({ expectedVersion: z.number().int().min(1), ...contactFields, ...ownFields }).strict();
const collabInput = z.object({ kind: z.enum(COLLAB_KINDS), happenedOn: day, product: text(200).default(''), cost: z.number().finite().min(0).max(100_000_000).nullable().default(null), url: url.default(''), note: text(2000).default('') }).strict();

const OWN_COLUMNS: [string, string][] = [['stage', 'stage'], ['tier', 'tier'], ['platform', 'platform'], ['followers', 'followers'], ['niche', 'niche'], ['ownerId', 'owner_id'], ['products', 'products'], ['fee', 'fee'], ['notes', 'notes']];
const CONTACT_COLUMNS: [string, string][] = [['name', 'name'], ['email', 'email'], ['phone', 'phone'], ['company', 'company'], ['country', 'country'], ['region', 'region'], ['city', 'city']];

export async function registerKolRoutes(app: FastifyInstance, db: Database, o: KolOptions & { isAdmin: (u: User) => boolean; now?: () => number; fetcher?: typeof fetch; wait?: (ms: number) => Promise<void>; intervalMs?: number }) {
  const now = o.now || Date.now;
  const grants = (u: User): string[] => Array.isArray((u as any).grants) ? (u as any).grants : [];
  const canView = (u: User) => o.isAdmin(u) || grants(u).includes('kol');
  const canManage = (u: User) => o.isAdmin(u) || grants(u).includes('kol_manage');
  const actorOf = (req: FastifyRequest): User => req.actor || deny(401, 'UNAUTHENTICATED', 'Authentication is required');
  const viewer = (req: FastifyRequest) => { const u = actorOf(req); if (!canView(u)) deny(403, 'KOL_ACCESS_REQUIRED', 'KOL access is required'); return u; };
  const manager = (req: FastifyRequest) => { const u = actorOf(req); if (!canManage(u)) deny(403, 'KOL_MANAGE_REQUIRED', 'Only KOL managers can do this'); return u; };
  const audit = (tx: Queryable, u: User, action: string, objectId: string, details: unknown) =>
    tx.query('INSERT INTO audit_events(id,org_id,department_id,owner_id,actor_id,action,object_id,details) VALUES($1,$2,$3,$4,$5,$6,$7,$8)',
      [randomUUID(), u.org_id, u.department_id, u.id, u.id, action, objectId, JSON.stringify(details)]);
  const running = new Set<string>();

  async function sync(orgId: string) {
    if (!o.uppromoteApiKey) deny(501, 'UPPROMOTE_NOT_CONFIGURED', 'UpPromote is not connected: UPPROMOTE_API_KEY is missing');
    if (running.has(orgId)) deny(409, 'KOL_SYNC_RUNNING', 'A sync is already running');
    running.add(orgId);
    const started = new Date(now()).toISOString();
    await db.query(`INSERT INTO kol_sync_state(org_id,started_at) VALUES($1,$2) ON CONFLICT(org_id) DO UPDATE SET started_at=$2`, [orgId, started]);
    try {
      const client = { apiKey: o.uppromoteApiKey, baseUrl: o.uppromoteBaseUrl, fetcher: o.fetcher, wait: o.wait };
      const affiliates = await fetchUpPromote(client, 'affiliates');
      const referrals = await fetchUpPromote(client, 'referrals');
      const counts = await db.transaction(async tx => {
        let added = 0, updated = 0, linked = 0;
        const existing = (await tx.query('SELECT id,up_id,lower(email) AS email FROM kol_profiles WHERE org_id=$1', [orgId])).rows;
        const byUp = new Map(existing.filter((r: any) => r.up_id != null).map((r: any) => [String(r.up_id), r.id]));
        const byEmail = new Map(existing.filter((r: any) => r.up_id == null && r.email).map((r: any) => [r.email, r.id]));
        for (const a of affiliates) {
          if (a?.id == null) continue;
          const name = [str(a.first_name, 60), str(a.last_name, 60)].filter(Boolean).join(' ') || str(a.company, 120) || str(a.email, 120) || String(a.id);
          const socials = Object.fromEntries(SOCIALS.map(s => [s, str(a[s], 300)]).filter(([, v]) => v));
          const vals = [str(a.email, 200), str(a.phone, 60), str(a.company, 120), str(a.country, 60), str(a.state, 80), str(a.city, 80), [a.address, a.zipcode].map(x => str(x, 200)).filter(Boolean).join(', '),
            JSON.stringify(socials), str(a.status, 30), str(a.program_name, 120), str(a.default_affiliate_link), str(a.custom_affiliate_link),
            JSON.stringify(Array.isArray(a.coupons) ? a.coupons.map((c: any) => str(c, 60)).filter(Boolean) : []), num(a.paid_amount), num(a.approved_amount), num(a.pending_amount), iso(a.created_at), started, name];
          const set = `email=$3,phone=$4,company=$5,country=$6,region=$7,city=$8,address=$9,socials=$10,up_status=$11,up_program=$12,up_link=$13,up_custom_link=$14,up_coupons=$15,up_paid=$16,up_approved=$17,up_pending=$18,up_created_at=$19,up_synced_at=$20,name=$21`;
          const known = byUp.get(String(a.id)), manual = !known && byEmail.get(str(a.email, 200).toLowerCase());
          if (known) { await tx.query(`UPDATE kol_profiles SET ${set} WHERE id=$1 AND org_id=$2`, [known, orgId, ...vals]); updated++; }
          else if (manual) { await tx.query(`UPDATE kol_profiles SET ${set},up_id=$22 WHERE id=$1 AND org_id=$2`, [manual, orgId, ...vals, a.id]); byEmail.delete(str(a.email, 200).toLowerCase()); linked++; }
          else {
            await tx.query(`INSERT INTO kol_profiles(id,org_id,email,phone,company,country,region,city,address,socials,up_status,up_program,up_link,up_custom_link,up_coupons,up_paid,up_approved,up_pending,up_created_at,up_synced_at,name,up_id,stage)
              VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,'partner')`, ['up-' + a.id, orgId, ...vals, a.id]);
            added++;
          }
        }
        // An affiliate deleted in UpPromote keeps its profile and our notes, marked as removed.
        const seen = affiliates.map(a => String(a?.id));
        const removed = (await tx.query(`UPDATE kol_profiles SET up_status='removed' WHERE org_id=$1 AND up_id IS NOT NULL AND up_status<>'removed' AND NOT (up_id::text = ANY($2::text[])) RETURNING id`, [orgId, seen])).rows.length;
        for (const r of referrals) {
          if (r?.id == null || r.affiliate?.id == null) continue;
          await tx.query(`INSERT INTO kol_referrals(org_id,id,up_affiliate_id,order_number,quantity,sales,commission,status,tracking,coupon,created_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
            ON CONFLICT(org_id,id) DO UPDATE SET up_affiliate_id=$3,order_number=$4,quantity=$5,sales=$6,commission=$7,status=$8,tracking=$9,coupon=$10,created_at=$11`,
            [orgId, r.id, r.affiliate.id, str(r.order_number, 40), Math.trunc(num(r.quantity)), num(r.total_sales), num(r.commission) + num(r.commission_adjustment), str(r.status, 20) || 'pending', str(r.tracking_type, 60), str(r.coupon_applied, 60), iso(r.created_at) || started]);
        }
        await tx.query('DELETE FROM kol_referrals WHERE org_id=$1 AND NOT (id::text = ANY($2::text[]))', [orgId, referrals.map(r => String(r?.id))]);
        return { affiliates: affiliates.length, referrals: referrals.length, added, updated, linked, removed };
      });
      await db.query(`UPDATE kol_sync_state SET finished_at=$2,ok=true,error='',counts=$3 WHERE org_id=$1`, [orgId, new Date(now()).toISOString(), JSON.stringify(counts)]);
      return counts;
    } catch (e: any) {
      await db.query(`UPDATE kol_sync_state SET finished_at=$2,ok=false,error=$3 WHERE org_id=$1`, [orgId, new Date(now()).toISOString(), String(e?.code || 'SYNC_FAILED').slice(0, 60)]).catch(() => undefined);
      throw e;
    } finally { running.delete(orgId); }
  }

  const syncInfo = async (orgId: string) => {
    const s = (await db.query('SELECT * FROM kol_sync_state WHERE org_id=$1', [orgId])).rows[0];
    return { uppromote: o.uppromoteApiKey ? 'configured' : 'not_configured', lastSync: s ? { startedAt: iso(s.started_at), finishedAt: iso(s.finished_at), ok: s.ok, error: s.error || null, counts: s.counts, running: running.has(orgId) } : null };
  };

  /** Per-KOL order metrics from the synced referrals; denied referrals do not count. */
  const METRICS = `SELECT up_affiliate_id, count(*)::int AS orders, coalesce(sum(sales),0) AS sales, coalesce(sum(commission),0) AS commission,
      coalesce(sum(sales) FILTER (WHERE created_at >= $2),0) AS sales30, count(*) FILTER (WHERE created_at >= $2)::int AS orders30,
      coalesce(sum(sales) FILTER (WHERE created_at >= $3),0) AS sales90, max(created_at) AS last_order
    FROM kol_referrals WHERE org_id=$1 AND status<>'denied' GROUP BY up_affiliate_id`;
  const since = (days: number) => new Date(now() - days * 86_400_000).toISOString();
  const metricsOf = (m: any) => ({ orders: m?.orders || 0, sales: num(m?.sales), commission: num(m?.commission), orders30: m?.orders30 || 0, sales30: num(m?.sales30), sales90: num(m?.sales90), lastOrderAt: iso(m?.last_order) });

  const owners = async (tx: Queryable, orgId: string) => new Map((await tx.query('SELECT id,display_name,name_zh,name_en FROM users WHERE org_id=$1', [orgId])).rows.map((r: any) => [r.id, r]));
  const summary = (r: any, m: any, people: Map<string, any>) => ({
    id: r.id, upId: r.up_id == null ? null : Number(r.up_id), name: r.name, email: r.email, company: r.company, country: r.country,
    socials: r.socials || {}, upStatus: r.up_status || null, program: r.up_program, coupons: r.up_coupons || [],
    paid: num(r.up_paid), approved: num(r.up_approved), pending: num(r.up_pending),
    stage: r.stage, tier: r.tier, platform: r.platform, followers: r.followers, niche: r.niche, ownerId: r.owner_id, ownerName: r.owner_id ? nameOf(people.get(r.owner_id)) : '',
    joinedAt: iso(r.up_created_at) || iso(r.created_at), version: r.version, ...metricsOf(m),
  });

  app.get('/kol/access', async req => {
    const u = actorOf(req);
    return { canView: canView(u), canManage: canManage(u), ...(canView(u) ? await syncInfo(u.org_id) : {}) };
  });

  app.get('/kol/kols', async req => {
    const u = viewer(req);
    const rows = (await db.query('SELECT * FROM kol_profiles WHERE org_id=$1 ORDER BY name,id', [u.org_id])).rows;
    const metrics = new Map((await db.query(METRICS, [u.org_id, since(30), since(90)])).rows.map((m: any) => [String(m.up_affiliate_id), m]));
    const people = await owners(db, u.org_id);
    const totals = (await db.query(`SELECT count(*)::int AS orders, coalesce(sum(sales),0) AS sales, coalesce(sum(commission),0) AS commission,
        coalesce(sum(sales) FILTER (WHERE created_at >= $2),0) AS sales30, count(*) FILTER (WHERE created_at >= $2)::int AS orders30,
        coalesce(sum(commission) FILTER (WHERE status IN ('pending','approved')),0) AS unpaid
      FROM kol_referrals WHERE org_id=$1 AND status<>'denied'`, [u.org_id, since(30)])).rows[0];
    const months = (await db.query(`SELECT to_char(date_trunc('month', created_at),'YYYY-MM') AS month, count(*)::int AS orders, coalesce(sum(sales),0) AS sales, coalesce(sum(commission),0) AS commission
      FROM kol_referrals WHERE org_id=$1 AND status<>'denied' AND created_at >= $2 GROUP BY 1 ORDER BY 1`, [u.org_id, since(366)])).rows;
    return {
      canManage: canManage(u), ...await syncInfo(u.org_id),
      totals: { orders: totals.orders, sales: num(totals.sales), commission: num(totals.commission), orders30: totals.orders30, sales30: num(totals.sales30), unpaidCommission: num(totals.unpaid) },
      months: months.map((m: any) => ({ month: m.month, orders: m.orders, sales: num(m.sales), commission: num(m.commission) })),
      owners: [...people.values()].map((p: any) => ({ id: p.id, name: nameOf(p) })),
      items: rows.map((r: any) => summary(r, r.up_id == null ? null : metrics.get(String(r.up_id)), people)),
    };
  });

  const profileOf = async (tx: Queryable, u: User, kolId: string, lock = false) => {
    const r = (await tx.query(`SELECT * FROM kol_profiles WHERE id=$1 AND org_id=$2${lock ? ' FOR UPDATE' : ''}`, [kolId, u.org_id])).rows[0];
    return r || deny(404, 'NOT_FOUND', 'KOL not found');
  };
  const detail = async (tx: Queryable, u: User, r: any) => {
    const people = await owners(tx, u.org_id);
    const m = r.up_id == null ? null : (await tx.query(METRICS.replace('GROUP BY', 'AND up_affiliate_id=$4 GROUP BY'), [u.org_id, since(30), since(90), r.up_id])).rows[0];
    const referrals = r.up_id == null ? [] : (await tx.query('SELECT * FROM kol_referrals WHERE org_id=$1 AND up_affiliate_id=$2 ORDER BY created_at DESC LIMIT 200', [u.org_id, r.up_id])).rows;
    const collabs = (await tx.query('SELECT * FROM kol_collabs WHERE kol_id=$1 AND org_id=$2 ORDER BY happened_on DESC, created_at DESC', [r.id, u.org_id])).rows;
    return {
      canManage: canManage(u),
      kol: { ...summary(r, m, people), phone: r.phone, region: r.region, city: r.city, address: r.address, link: r.up_link, customLink: r.up_custom_link,
        products: r.products, fee: r.fee, notes: r.notes, syncedAt: iso(r.up_synced_at), updatedAt: iso(r.updated_at), updatedByName: r.updated_by ? nameOf(people.get(r.updated_by)) : '' },
      referrals: referrals.map((x: any) => ({ id: Number(x.id), orderNumber: x.order_number, quantity: x.quantity, sales: num(x.sales), commission: num(x.commission), status: x.status, tracking: x.tracking, coupon: x.coupon, createdAt: iso(x.created_at) })),
      collabs: collabs.map((c: any) => ({ id: c.id, kind: c.kind, happenedOn: ymd(c.happened_on), product: c.product, cost: c.cost == null ? null : num(c.cost), url: c.url, note: c.note, byName: nameOf(people.get(c.actor_id)), createdAt: iso(c.created_at) })),
    };
  };

  app.get<{ Params: { id: string } }>('/kol/kols/:id', async req => {
    const u = viewer(req);
    return detail(db, u, await profileOf(db, u, id.parse(req.params.id)));
  });

  const checkOwner = async (tx: Queryable, u: User, ownerId: string | null | undefined) => {
    if (ownerId && !(await tx.query('SELECT 1 FROM users WHERE id=$1 AND org_id=$2', [ownerId, u.org_id])).rows.length) deny(400, 'INVALID_OWNER', 'Choose a person in your company as the owner');
  };

  app.post('/kol/kols', async (req, reply) => {
    const u = manager(req), v = createInput.parse(req.body);
    return db.transaction(async tx => {
      await checkOwner(tx, u, v.ownerId);
      const kolId = randomUUID();
      const cols = [...CONTACT_COLUMNS, ...OWN_COLUMNS].filter(([k]) => (v as any)[k] !== undefined);
      await tx.query(`INSERT INTO kol_profiles(id,org_id,created_by,updated_by,socials${cols.map(([, c]) => ',' + c).join('')}) VALUES($1,$2,$3,$3,$4${cols.map((_, i) => ',$' + (i + 5)).join('')})`,
        [kolId, u.org_id, u.id, JSON.stringify(v.socials || {}), ...cols.map(([k]) => (v as any)[k])]);
      await audit(tx, u, 'kol.create', kolId, { name: v.name });
      reply.code(201);
      return detail(tx, u, await profileOf(tx, u, kolId));
    });
  });

  app.put<{ Params: { id: string } }>('/kol/kols/:id', async req => {
    const u = manager(req), v = updateInput.parse(req.body), kolId = id.parse(req.params.id);
    return db.transaction(async tx => {
      const r = await profileOf(tx, u, kolId, true);
      if (r.version !== v.expectedVersion) deny(409, 'VERSION_CONFLICT', 'This KOL changed since you opened it; reload and try again');
      const fromUp = r.up_id != null;
      if (fromUp && (CONTACT_COLUMNS.some(([k]) => (v as any)[k] !== undefined) || v.socials !== undefined)) deny(400, 'KOL_SYNCED_FIELD', 'Contact details of UpPromote KOLs are edited in UpPromote');
      await checkOwner(tx, u, v.ownerId);
      const cols = [...CONTACT_COLUMNS, ...OWN_COLUMNS].filter(([k]) => (v as any)[k] !== undefined);
      const params: unknown[] = [r.id, u.id, ...cols.map(([k]) => (v as any)[k])];
      let set = cols.map(([, c], i) => `${c}=$${i + 3}`).join(',');
      if (v.socials !== undefined) { params.push(JSON.stringify(v.socials)); set += (set ? ',' : '') + `socials=$${params.length}`; }
      if (!set) deny(400, 'NOTHING_TO_CHANGE', 'Nothing to change');
      await tx.query(`UPDATE kol_profiles SET ${set},version=version+1,updated_by=$2,updated_at=now() WHERE id=$1`, params);
      // Field names only, like the HR audit: notes and fees stay out of the audit log.
      await audit(tx, u, 'kol.update', r.id, { fields: [...cols.map(([k]) => k), ...(v.socials !== undefined ? ['socials'] : [])] });
      return detail(tx, u, await profileOf(tx, u, r.id));
    });
  });

  app.delete<{ Params: { id: string } }>('/kol/kols/:id', async req => {
    const u = manager(req), kolId = id.parse(req.params.id);
    return db.transaction(async tx => {
      const r = await profileOf(tx, u, kolId, true);
      if (r.up_id != null) deny(400, 'KOL_SYNCED', 'UpPromote KOLs are removed in UpPromote');
      await tx.query('DELETE FROM kol_profiles WHERE id=$1', [r.id]);
      await audit(tx, u, 'kol.delete', r.id, { name: r.name });
      return { deleted: r.id };
    });
  });

  app.post<{ Params: { id: string } }>('/kol/kols/:id/collabs', async (req, reply) => {
    const u = manager(req), v = collabInput.parse(req.body), kolId = id.parse(req.params.id);
    return db.transaction(async tx => {
      const r = await profileOf(tx, u, kolId, true);
      const cid = randomUUID();
      await tx.query('INSERT INTO kol_collabs(id,org_id,kol_id,kind,happened_on,product,cost,url,note,actor_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)',
        [cid, u.org_id, r.id, v.kind, v.happenedOn, v.product, v.cost, v.url, v.note, u.id]);
      // Logging a sample or published content moves an early-stage KOL forward; later stages are left alone.
      const next = v.kind === 'sample' ? 'sample_sent' : v.kind === 'content' ? 'content_live' : null;
      const order = (s: string) => STAGES.indexOf(s as any);
      if (next && r.stage !== 'paused' && r.stage !== 'long_term' && order(r.stage) < order(next)) await tx.query('UPDATE kol_profiles SET stage=$2,version=version+1,updated_by=$3,updated_at=now() WHERE id=$1', [r.id, next, u.id]);
      await audit(tx, u, 'kol.collab.add', r.id, { kind: v.kind, collabId: cid });
      reply.code(201);
      return detail(tx, u, await profileOf(tx, u, r.id));
    });
  });

  app.delete<{ Params: { id: string; cid: string } }>('/kol/kols/:id/collabs/:cid', async req => {
    const u = manager(req), kolId = id.parse(req.params.id), cid = id.parse(req.params.cid);
    return db.transaction(async tx => {
      const r = await profileOf(tx, u, kolId, true);
      const c = (await tx.query('DELETE FROM kol_collabs WHERE id=$1 AND kol_id=$2 AND org_id=$3 RETURNING kind', [cid, r.id, u.org_id])).rows[0];
      if (!c) deny(404, 'NOT_FOUND', 'Entry not found');
      await audit(tx, u, 'kol.collab.delete', r.id, { kind: c.kind, collabId: cid });
      return detail(tx, u, r);
    });
  });

  app.post('/kol/sync', async req => {
    const u = manager(req);
    const counts = await sync(u.org_id);
    await audit(db, u, 'kol.sync', u.org_id, counts);
    return { counts, ...await syncInfo(u.org_id) };
  });

  // Scheduled sync for every org that has synced by hand at least once.
  if (o.intervalMs && o.uppromoteApiKey) {
    const timer = setInterval(async () => {
      const orgs = (await db.query('SELECT org_id FROM kol_sync_state').catch(() => ({ rows: [] as any[] }))).rows;
      for (const r of orgs) await sync(r.org_id).catch(() => undefined);
    }, o.intervalMs);
    timer.unref?.();
    app.addHook('onClose', async () => clearInterval(timer));
  }
}
