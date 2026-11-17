/* 订单履约 Order-to-Success (owner, 2026-11-16): one timeline per order, from paid in full to a customer who can use the
 * machine and leaves a review. Stages and their owners:
 *   pay       paid in full (payment owner, e.g. finance); KOL orders are approved instead of paid
 *   ship      picked up by the carrier with a tracking number, within 48 h (LTL machines) / 24 h (parcel) of payment
 *   transit   on the way; overdue when past the ETA + 2 days, or no update for 3 days
 *   delivery  at the destination terminal: a delivery appointment is booked (phone calls in US hours)
 *   running   the customer makes a first piece (training owner reaches out after 5 days)
 *   review    retail: review invitation sent (Trustpilot → BBB → Google → Facebook); KOL: their content link instead
 * Nothing ships before full payment unless a main admin releases the order with a reason and a promised payment date.
 * Dealer orders end at delivery. Retail, dealer and KOL orders are told apart by Shopify tags (dealer / kol / offline);
 * a $0 order without a tag is treated as KOL and flagged for checking.
 * Customer names and addresses live only here and are shown only to people with order access. */
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { Database, Queryable } from './db.js';
import type { User } from './auth.js';
import { deny } from './errors.js';
import type { ShopifyOptions } from './shopify.js';
import { SHOPIFY_API_VERSION } from './shopify.js';
import { wmsMoveLines, isReturnSku } from './wms.js';

/** Where an order ships from: a WMS warehouse (wms.ts LOCATIONS, without "in transit"). */
export const SHIP_FROM = ['us', 'dg', 'jn'] as const;

export const fulfillmentSchema = `
CREATE TABLE IF NOT EXISTS ful_orders(
  id text PRIMARY KEY, org_id text NOT NULL, source text NOT NULL DEFAULT 'manual', shopify_id text, number text NOT NULL,
  kind text NOT NULL DEFAULT 'retail', kind_note text NOT NULL DEFAULT '', channel text NOT NULL DEFAULT 'online',
  placed_at timestamptz NOT NULL DEFAULT now(), customer_name text NOT NULL DEFAULT '', customer_email text NOT NULL DEFAULT '',
  customer_phone text NOT NULL DEFAULT '', ship_city text NOT NULL DEFAULT '', ship_state text NOT NULL DEFAULT '', ship_zip text NOT NULL DEFAULT '',
  ship_country text NOT NULL DEFAULT 'US', total_cents bigint NOT NULL DEFAULT 0, paid_cents bigint NOT NULL DEFAULT 0, lines jsonb NOT NULL DEFAULT '[]',
  tags jsonb NOT NULL DEFAULT '[]', shipment text NOT NULL DEFAULT 'ltl', liftgate boolean NOT NULL DEFAULT false, residential boolean NOT NULL DEFAULT false,
  paid_at timestamptz, release jsonb, shipped_at timestamptz, carrier text NOT NULL DEFAULT '', tracking text NOT NULL DEFAULT '', eta date,
  track_at timestamptz, terminal_at timestamptz, appointment_on date, delivered_at timestamptz, damage text NOT NULL DEFAULT '',
  first_piece_at timestamptz, review_invited_at timestamptz, review_platform text NOT NULL DEFAULT '', reviewed_at timestamptz, review_rating integer,
  content_url text NOT NULL DEFAULT '', cancelled_at timestamptz, updated_at timestamptz NOT NULL DEFAULT now(), created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(org_id, shopify_id));
CREATE INDEX IF NOT EXISTS ful_orders_org ON ful_orders(org_id, placed_at DESC);
ALTER TABLE ful_orders ADD COLUMN IF NOT EXISTS ship_from text NOT NULL DEFAULT '';
ALTER TABLE ful_orders ADD COLUMN IF NOT EXISTS cancel_reason text NOT NULL DEFAULT '';
ALTER TABLE ful_orders ADD COLUMN IF NOT EXISTS refunded_cents bigint NOT NULL DEFAULT 0;
ALTER TABLE ful_orders ADD COLUMN IF NOT EXISTS refund_note text NOT NULL DEFAULT '';
ALTER TABLE ful_orders ADD COLUMN IF NOT EXISTS exchange jsonb;
ALTER TABLE ful_orders ADD COLUMN IF NOT EXISTS note jsonb;
ALTER TABLE ful_orders ADD COLUMN IF NOT EXISTS wms_out_at timestamptz;
ALTER TABLE ful_orders ADD COLUMN IF NOT EXISTS wms_out jsonb;
CREATE TABLE IF NOT EXISTS ful_events(id text PRIMARY KEY, org_id text NOT NULL, order_id text NOT NULL REFERENCES ful_orders(id) ON DELETE CASCADE,
  actor_id text, kind text NOT NULL, details jsonb NOT NULL DEFAULT '{}', created_at timestamptz NOT NULL DEFAULT now());
CREATE INDEX IF NOT EXISTS ful_events_order ON ful_events(order_id, created_at);
CREATE TABLE IF NOT EXISTS ful_settings(org_id text PRIMARY KEY, pay_owner text, ship_owner text, call_owner text, train_owner text,
  ship_hours_ltl integer NOT NULL DEFAULT 48, ship_hours_parcel integer NOT NULL DEFAULT 24, pay_days integer NOT NULL DEFAULT 3,
  terminal_days integer NOT NULL DEFAULT 3, stall_days integer NOT NULL DEFAULT 3, train_days integer NOT NULL DEFAULT 5,
  review_platforms jsonb NOT NULL DEFAULT '["trustpilot","bbb","google","facebook"]', updated_by text, updated_at timestamptz NOT NULL DEFAULT now());
`;

export const KINDS = ['retail', 'dealer', 'kol'] as const;
export const REVIEW_PLATFORMS = ['trustpilot', 'bbb', 'google', 'facebook'] as const;
export type Settings = { payOwner: string | null; shipOwner: string | null; callOwner: string | null; trainOwner: string | null;
  shipHoursLtl: number; shipHoursParcel: number; payDays: number; terminalDays: number; stallDays: number; trainDays: number; reviewPlatforms: string[] };
export const DEFAULT_SETTINGS: Settings = { payOwner: null, shipOwner: null, callOwner: null, trainOwner: null,
  shipHoursLtl: 48, shipHoursParcel: 24, payDays: 3, terminalDays: 3, stallDays: 3, trainDays: 5, reviewPlatforms: [...REVIEW_PLATFORMS] };

/** Retail, dealer or KOL from Shopify tags; an untagged $0 order is KOL but marked for checking. */
export function kindOf(tags: string[], totalCents: number): { kind: typeof KINDS[number]; note: string; channel: string } {
  const t = tags.map(x => x.trim().toLowerCase());
  const channel = t.includes('offline') ? 'offline' : 'online';
  if (t.includes('kol')) return { kind: 'kol', note: '', channel };
  if (t.includes('dealer') || t.includes('wholesale')) return { kind: 'dealer', note: '', channel };
  if (totalCents === 0) return { kind: 'kol', note: 'zero_untagged', channel };
  return { kind: 'retail', note: '', channel };
}

const H = 3600_000, D = 86400_000;
const ms = (v: any) => v ? new Date(v).getTime() : null;
/** Where an order is, when the current step is due, who owns it, and whether it is late. Pure, for the board and the tests. */
export function stageOf(o: any, s: Settings, now: number) {
  const paid = Number(o.total_cents) > 0 && Number(o.paid_cents) >= Number(o.total_cents);
  const released = !!o.release, cleared = paid || released;
  const due = (stage: string, owner: string | null, at: number | null) => ({ stage, owner, due: at == null ? null : new Date(at).toISOString(), late: at != null && now > at });
  if (o.cancelled_at) return due('cancelled', null, null);
  if (!cleared) return o.kind === 'kol' ? due('approve', null, null) : due('pay', s.payOwner, ms(o.placed_at)! + s.payDays * D);
  const clearedAt = paid ? ms(o.paid_at) ?? ms(o.placed_at)! : ms(o.release.at)!;
  if (!o.shipped_at) return due('ship', s.shipOwner, clearedAt + (o.shipment === 'parcel' ? s.shipHoursParcel : s.shipHoursLtl) * H);
  if (!o.delivered_at) {
    if (o.terminal_at && !o.appointment_on) return due('delivery', s.callOwner || s.shipOwner, ms(o.terminal_at)! + s.terminalDays * D);
    const last = Math.max(ms(o.shipped_at)!, ms(o.track_at) || 0, ms(o.terminal_at) || 0);
    // eta comes back from the database as a Date and from callers as 'YYYY-MM-DD'.
    const etaDay = o.eta ? (o.eta instanceof Date ? o.eta.toISOString().slice(0, 10) : String(o.eta).slice(0, 10)) : null;
    const byEta = etaDay ? ms(etaDay + 'T23:59:59Z')! + 2 * D : null;
    return due('transit', s.shipOwner, byEta != null ? Math.min(byEta, last + s.stallDays * D) : last + s.stallDays * D);
  }
  if (o.kind === 'dealer') return due('done', null, null);
  if (!o.first_piece_at) return due('running', s.trainOwner, ms(o.delivered_at)! + s.trainDays * D);
  if (o.kind === 'kol') return o.content_url ? due('done', null, null) : due('content', null, null);
  if (!o.review_invited_at) return due('review', s.shipOwner, ms(o.first_piece_at)! + 2 * D);
  return due('done', null, null);
}

/** SKU quantities an open order still holds in each warehouse: not cancelled and not yet out of WMS stock. The warehouse
 *  defaults to the US LA warehouse until someone picks another. Read by WMS for available stock. */
export async function reservedStock(db: Queryable, org: string) {
  const out = new Map<string, Record<string, number>>();
  const rows = (await db.query("SELECT ship_from, lines FROM ful_orders WHERE org_id=$1 AND cancelled_at IS NULL AND wms_out_at IS NULL", [org])).rows;
  for (const r of rows as any[]) for (const l of (r.lines || [])) {
    const k = String(l.sku || '').trim().toLowerCase(), q = Math.max(0, Math.trunc(Number(l.qty) || 0)); if (!k || !q || isReturnSku(k)) continue;
    const loc = r.ship_from || 'us'; if (!out.has(k)) out.set(k, {}); out.get(k)![loc] = (out.get(k)![loc] || 0) + q;
  }
  return out;
}
/** The order lines WMS can move: SKUs in the product library that are stocked (not dropship, not returns). */
async function stockedLines(tx: Queryable, org: string, lines: any[]) {
  const want = new Map<string, number>();
  for (const l of lines) { const k = String(l.sku || '').trim(), q = Math.max(0, Math.trunc(Number(l.qty) || 0)); if (k && q && !isReturnSku(k)) want.set(k, (want.get(k) || 0) + q); }
  if (!want.size) return [];
  const ok = new Set(((await tx.query("SELECT lower(sku) k FROM product_catalog WHERE org_id=$1 AND lower(sku) = ANY($2::text[]) AND COALESCE(attrs->>'supplyMode','')<>'dropship'", [org, [...want.keys()].map(k => k.toLowerCase())])).rows as any[]).map(r => r.k));
  return [...want].filter(([k]) => ok.has(k.toLowerCase())).map(([sku, qty]) => ({ sku, qty }));
}
const centsOf = (v: any) => { const n = Number(v); return Number.isFinite(n) ? Math.round(n * 100) : 0; };
const iso = (v: any) => v ? new Date(v).toISOString() : null;
const ymd = (v: any) => v ? (v instanceof Date ? v.toISOString().slice(0, 10) : String(v).slice(0, 10)) : null;

export async function registerFulfillmentRoutes(app: FastifyInstance, db: Database, o: { isAdmin: (u: User) => boolean; shopify?: ShopifyOptions; now?: () => number; syncIntervalMs?: number }) {
  const now = o.now || Date.now;
  const actorOf = (req: FastifyRequest): User => req.actor || deny(401, 'UNAUTHENTICATED', 'Authentication is required');
  const grantsOf = (u: any): string[] => Array.isArray(u.grants) ? u.grants : [];
  const levelOf = (u: User) => o.isAdmin(u) || grantsOf(u).includes('orders_manage') ? 'manage' : grantsOf(u).includes('orders') ? 'view' : 'none';
  const requireView = (u: User) => { if (levelOf(u) === 'none') deny(403, 'ORDERS_FORBIDDEN', 'You do not have access to order fulfillment', '你没有订单履约的权限。'); };
  const requireManage = (u: User) => { if (levelOf(u) !== 'manage') deny(403, 'ORDERS_MANAGE_FORBIDDEN', 'You can view orders but not change them', '你只能查看订单，不能修改。'); };
  const event = (tx: Queryable, u: User | null, order: string, org: string, kind: string, details: unknown = {}) =>
    tx.query('INSERT INTO ful_events(id,org_id,order_id,actor_id,kind,details) VALUES($1,$2,$3,$4,$5,$6)', [randomUUID(), org, order, u?.id || null, kind, JSON.stringify(details)]);

  async function settingsOf(org: string, q: Queryable = db): Promise<Settings> {
    const r = (await q.query('SELECT * FROM ful_settings WHERE org_id=$1', [org])).rows[0];
    if (!r) return { ...DEFAULT_SETTINGS };
    return { payOwner: r.pay_owner, shipOwner: r.ship_owner, callOwner: r.call_owner, trainOwner: r.train_owner, shipHoursLtl: r.ship_hours_ltl,
      shipHoursParcel: r.ship_hours_parcel, payDays: r.pay_days, terminalDays: r.terminal_days, stallDays: r.stall_days, trainDays: r.train_days,
      reviewPlatforms: Array.isArray(r.review_platforms) ? r.review_platforms : [...REVIEW_PLATFORMS] };
  }
  const names = async (org: string) => new Map((await db.query('SELECT id, COALESCE(NULLIF(display_name,\'\'), name_zh, name_en, id) n FROM users WHERE org_id=$1', [org])).rows.map((r: any) => [r.id, r.n]));
  function view(r: any, s: Settings, people: Map<string, string>) {
    const st = stageOf(r, s, now());
    return { id: r.id, source: r.source, number: r.number, kind: r.kind, kindNote: r.kind_note, channel: r.channel, placedAt: iso(r.placed_at),
      customer: { name: r.customer_name, email: r.customer_email, phone: r.customer_phone, city: r.ship_city, state: r.ship_state, zip: r.ship_zip, country: r.ship_country },
      totalCents: Number(r.total_cents), paidCents: Number(r.paid_cents), owedCents: Math.max(0, Number(r.total_cents) - Number(r.paid_cents)),
      lines: r.lines || [], tags: r.tags || [], shipment: r.shipment, liftgate: r.liftgate, residential: r.residential,
      paidAt: iso(r.paid_at), release: r.release ? { ...r.release, byName: people.get(r.release.by) || '' } : null,
      shippedAt: iso(r.shipped_at), carrier: r.carrier, tracking: r.tracking, eta: ymd(r.eta), trackAt: iso(r.track_at), terminalAt: iso(r.terminal_at),
      appointmentOn: ymd(r.appointment_on), deliveredAt: iso(r.delivered_at), damage: r.damage, firstPieceAt: iso(r.first_piece_at),
      reviewInvitedAt: iso(r.review_invited_at), reviewPlatform: r.review_platform, reviewedAt: iso(r.reviewed_at), reviewRating: r.review_rating,
      shipFrom: r.ship_from || '', wmsOutAt: iso(r.wms_out_at), wmsOut: r.wms_out || null, cancelReason: r.cancel_reason || '',
      // Refunds (Shopify's refunded total, or recorded here for manual orders) and exchanges (the "exchange" tag in Shopify, or marked here).
      refundedCents: Number(r.refunded_cents || 0), refund: Number(r.refunded_cents || 0) <= 0 ? '' : Number(r.refunded_cents) >= Number(r.total_cents) ? 'full' : 'partial', refundNote: r.refund_note || '',
      exchange: r.exchange ? { ...r.exchange, byName: r.exchange.by ? people.get(r.exchange.by) || '' : '' } : (Array.isArray(r.tags) && r.tags.some((t: string) => /^exchange$/i.test(String(t).trim())) ? { reason: '', fromTag: true } : null),
      note: r.note ? { ...r.note, byName: r.note.by ? people.get(r.note.by) || '' : '' } : null,
      contentUrl: r.content_url, cancelledAt: iso(r.cancelled_at), updatedAt: iso(r.updated_at),
      stage: st.stage, due: st.due, late: st.late, owner: st.owner, ownerName: st.owner ? people.get(st.owner) || '' : '' };
  }

  /* ---------- the board ---------- */
  app.get('/orders', async req => {
    const u = actorOf(req); requireView(u);
    const s = await settingsOf(u.org_id), people = await names(u.org_id);
    const rows = (await db.query(`SELECT * FROM ful_orders WHERE org_id=$1 AND (cancelled_at IS NULL OR cancelled_at > now() - interval '90 days')
      AND (delivered_at IS NULL OR delivered_at > now() - interval '120 days') ORDER BY placed_at DESC LIMIT 2000`, [u.org_id])).rows;
    const items = rows.map((r: any) => view(r, s, people));
    const open = items.filter(i => !['done', 'cancelled'].includes(i.stage));
    const recent = items.filter(i => i.placedAt && Date.parse(i.placedAt) > now() - 90 * D);
    const avg = (xs: number[]) => xs.length ? Math.round(xs.reduce((a, b) => a + b, 0) / xs.length * 10) / 10 : null;
    const hours = (a: any, b: any) => (Date.parse(b) - Date.parse(a)) / H;
    const retailDone = recent.filter(i => i.kind === 'retail' && i.firstPieceAt);
    const summary = {
      lateShip: open.filter(i => i.stage === 'ship' && i.late).length,
      owedCents: open.filter(i => i.stage === 'pay').reduce((a, i) => a + i.owedCents, 0), owedOrders: open.filter(i => i.stage === 'pay').length,
      terminalNoAppt: open.filter(i => i.stage === 'delivery').length,
      damaged: items.filter(i => i.damage === 'damaged' && i.deliveredAt && Date.parse(i.deliveredAt) > now() - 30 * D).length,
      noFirstPiece: open.filter(i => i.stage === 'running' && i.late).length,
      notOut: items.filter(i => i.shippedAt && !i.wmsOutAt && i.stage !== 'cancelled').length,
      lateTotal: open.filter(i => i.late).length, zeroUntagged: open.filter(i => i.kindNote === 'zero_untagged').length,
      // Weekly review, last 90 days: hours from paid to pickup, days from pickup to delivery and from delivery to first piece; review rate.
      payToShipHours: avg(recent.filter(i => i.shippedAt && (i.paidAt || i.release)).map(i => hours(i.paidAt || i.release.at, i.shippedAt))),
      shipToDeliverDays: avg(recent.filter(i => i.shippedAt && i.deliveredAt).map(i => hours(i.shippedAt, i.deliveredAt) / 24)),
      deliverToFirstDays: avg(recent.filter(i => i.deliveredAt && i.firstPieceAt).map(i => hours(i.deliveredAt, i.firstPieceAt) / 24)),
      reviewRate: retailDone.length ? Math.round(retailDone.filter(i => i.reviewedAt).length / retailDone.length * 100) : null,
      avgRating: avg(recent.filter(i => i.reviewRating != null).map(i => Number(i.reviewRating))),
    };
    return { items, summary, settings: s, canManage: levelOf(u) === 'manage', canRelease: o.isAdmin(u), shopify: shopifyConfigured() };
  });

  app.get<{ Params: { id: string } }>('/orders/:id', async req => {
    const u = actorOf(req); requireView(u);
    const r = (await db.query('SELECT * FROM ful_orders WHERE id=$1 AND org_id=$2', [req.params.id, u.org_id])).rows[0];
    if (!r) deny(404, 'ORDER_NOT_FOUND', 'Order not found', '找不到这张订单。');
    const people = await names(u.org_id);
    const events = (await db.query('SELECT * FROM ful_events WHERE order_id=$1 ORDER BY created_at DESC, id LIMIT 200', [r.id])).rows
      .map((e: any) => ({ id: e.id, kind: e.kind, details: e.details, at: iso(e.created_at), by: e.actor_id ? people.get(e.actor_id) || '' : 'Shopify' }));
    // WMS stock of this order's SKUs in each warehouse, so whoever ships picks a warehouse that has it (read only: WMS owns stock).
    const skus: string[] = [...new Set<string>((r.lines || []).map((l: any) => String(l.sku || '')).filter(Boolean))];
    const stockRows = skus.length ? (await db.query('SELECT sku, location, qty FROM wms_stock WHERE org_id=$1 AND lower(sku) = ANY($2::text[])', [u.org_id, skus.map(x => x.toLowerCase())])).rows : [];
    const held = await reservedStock(db, u.org_id);
    const stock = skus.map(sku => ({ sku, ...Object.fromEntries(SHIP_FROM.map(l => [l, Number((stockRows as any[]).find((x: any) => x.sku.toLowerCase() === sku.toLowerCase() && x.location === l)?.qty || 0)])),
      reserved: Object.fromEntries(SHIP_FROM.map(l => [l, held.get(sku.toLowerCase())?.[l] || 0])) }));
    return { ...view(r, await settingsOf(u.org_id), people), events, stock };
  });

  /* ---------- manual orders (phone, email, dealers before their own module exists) ---------- */
  const line = z.object({ sku: z.string().trim().min(1).max(80), name: z.string().trim().max(200).default(''), qty: z.number().int().min(1).max(10000) }).strict();
  const customer = z.object({ name: z.string().trim().max(200).default(''), email: z.string().trim().max(254).default(''), phone: z.string().trim().max(40).default(''),
    city: z.string().trim().max(100).default(''), state: z.string().trim().max(40).default(''), zip: z.string().trim().max(20).default(''), country: z.string().trim().max(2).default('US') }).strict();
  const newOrder = z.object({ number: z.string().trim().min(1).max(60), kind: z.enum(KINDS), channel: z.enum(['online', 'offline']).default('offline'),
    customer, lines: z.array(line).min(1).max(100), total: z.number().min(0).max(10_000_000), paid: z.number().min(0).max(10_000_000).default(0),
    shipment: z.enum(['ltl', 'parcel']).default('ltl'), liftgate: z.boolean().default(false), residential: z.boolean().default(false) }).strict();
  app.post('/orders', async (req, reply) => {
    const u = actorOf(req); requireManage(u);
    const v = newOrder.parse(req.body), id = randomUUID(), total = centsOf(v.total), paid = Math.min(centsOf(v.paid), total);
    if ((await db.query('SELECT 1 FROM ful_orders WHERE org_id=$1 AND lower(number)=lower($2)', [u.org_id, v.number])).rows.length)
      deny(409, 'ORDER_NUMBER_EXISTS', 'An order with this number already exists', '已经有这个订单号了。');
    await db.transaction(async tx => {
      await tx.query(`INSERT INTO ful_orders(id,org_id,source,number,kind,channel,customer_name,customer_email,customer_phone,ship_city,ship_state,ship_zip,ship_country,
        total_cents,paid_cents,lines,shipment,liftgate,residential,paid_at) VALUES($1,$2,'manual',$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19)`,
        [id, u.org_id, v.number, v.kind, v.channel, v.customer.name, v.customer.email, v.customer.phone, v.customer.city, v.customer.state.toUpperCase(), v.customer.zip,
          v.customer.country.toUpperCase(), total, paid, JSON.stringify(v.lines), v.shipment, v.liftgate, v.residential, total > 0 && paid >= total ? new Date(now()).toISOString() : null]);
      await event(tx, u, id, u.org_id, 'created', { kind: v.kind });
    });
    reply.code(201); return { id };
  });

  /* ---------- one step at a time ---------- */
  const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use a date like 2026-11-16');
  /* On-hand vs available (owner, 2026-11-17): an open order holds its stock (available = on hand − held) until the carrier picks
   * it up; only then does it leave WMS stock, as an outbound movement "订单出货 <number>". Lines whose SKU is not stocked in WMS
   * (not in the product library, dropship, returns) are skipped. wmsOut=false: the warehouse already recorded it by hand. */
  async function takeOut(tx: Queryable, u: User, r: any, loc: string, wmsOut: boolean, at: string) {
    if (!wmsOut) return { wms_out_at: at, wms_out: JSON.stringify({ mode: 'manual', by: u.id, at, loc }) };
    const lines = await stockedLines(tx, u.org_id, r.lines || []);
    if (lines.length) await wmsMoveLines(tx, u, { type: 'out', from: loc, to: loc, lines, reason: `订单出货 ${r.number}`, reference: String(r.number).slice(0, 80), opDate: at.slice(0, 10) });
    return { wms_out_at: at, wms_out: JSON.stringify({ mode: 'auto', by: u.id, at, loc, lines }) };
  }
  const stepInput = z.discriminatedUnion('step', [
    z.object({ step: z.literal('payment'), paid: z.number().min(0).max(10_000_000) }).strict(),
    z.object({ step: z.literal('release'), reason: z.string().trim().min(3).max(500), payBy: day.optional() }).strict(),
    z.object({ step: z.literal('kind'), kind: z.enum(KINDS) }).strict(),
    z.object({ step: z.literal('delivery_needs'), shipment: z.enum(['ltl', 'parcel']), liftgate: z.boolean(), residential: z.boolean(), shipFrom: z.enum(SHIP_FROM).optional() }).strict(),
    z.object({ step: z.literal('ship'), shipFrom: z.enum(SHIP_FROM), wmsOut: z.boolean().default(true), carrier: z.string().trim().min(1).max(80), tracking: z.string().trim().min(1).max(80), eta: day.optional() }).strict(),
    z.object({ step: z.literal('track'), eta: day.optional(), note: z.string().trim().max(500).default('') }).strict(),
    z.object({ step: z.literal('terminal') }).strict(),
    z.object({ step: z.literal('appointment'), on: day }).strict(),
    z.object({ step: z.literal('delivered'), damage: z.enum(['none', 'damaged']) }).strict(),
    z.object({ step: z.literal('first_piece') }).strict(),
    z.object({ step: z.literal('review_invited'), platform: z.enum(REVIEW_PLATFORMS) }).strict(),
    z.object({ step: z.literal('reviewed'), platform: z.enum(REVIEW_PLATFORMS), rating: z.number().int().min(1).max(5) }).strict(),
    z.object({ step: z.literal('content'), url: z.string().trim().url().max(500) }).strict(),
    z.object({ step: z.literal('wms_out'), shipFrom: z.enum(SHIP_FROM), wmsOut: z.boolean().default(true) }).strict(),
    z.object({ step: z.literal('note'), text: z.string().trim().min(1).max(2000) }).strict(),
    z.object({ step: z.literal('cancel'), reason: z.string().trim().min(3).max(500) }).strict(),
    z.object({ step: z.literal('refund'), amount: z.number().positive().max(10_000_000), reason: z.string().trim().min(3).max(500) }).strict(),
    z.object({ step: z.literal('exchange'), reason: z.string().trim().min(3).max(500), newOrder: z.string().trim().max(60).optional() }).strict(),
  ]);
  app.post<{ Params: { id: string } }>('/orders/:id/step', async req => {
    const u = actorOf(req), v = stepInput.parse(req.body);
    if (v.step === 'release') { if (!o.isAdmin(u)) deny(403, 'ORDER_RELEASE_ADMIN_ONLY', 'Only a main admin can release an order before full payment', '只有主管理员能特批未收全款的订单发货。'); }
    else requireManage(u);
    return db.transaction(async tx => {
      const r = (await tx.query('SELECT * FROM ful_orders WHERE id=$1 AND org_id=$2 FOR UPDATE', [req.params.id, u.org_id])).rows[0];
      if (!r) deny(404, 'ORDER_NOT_FOUND', 'Order not found', '找不到这张订单。');
      if (r.cancelled_at && !['note', 'refund'].includes(v.step)) deny(409, 'ORDER_CANCELLED', 'This order is cancelled', '这张订单已取消。');
      const at = new Date(now()).toISOString(), set: Record<string, unknown> = {};
      const paidInFull = Number(r.total_cents) > 0 && Number(r.paid_cents) >= Number(r.total_cents);
      const need = (ok: boolean, code: string, en: string, zh: string) => { if (!ok) deny(409, code, en, zh); };
      switch (v.step) {
        case 'payment': {
          need(r.source === 'manual', 'ORDER_PAYMENT_FROM_SHOPIFY', 'Payment for Shopify orders comes from Shopify; record it there', 'Shopify 订单的收款以 Shopify 为准，请在 Shopify 里记录。');
          const paid = Math.min(centsOf(v.paid), Number(r.total_cents)); set.paid_cents = paid;
          if (paid >= Number(r.total_cents) && Number(r.total_cents) > 0 && !r.paid_at) set.paid_at = at; break;
        }
        case 'release':
          need(!paidInFull && !r.release, 'ORDER_RELEASE_NOT_NEEDED', 'This order is already paid in full or released', '这张订单已经收全款或已经特批。');
          set.release = JSON.stringify({ by: u.id, at, reason: v.reason, payBy: v.payBy || null }); break;
        case 'kind': set.kind = v.kind; set.kind_note = ''; break;
        case 'delivery_needs': Object.assign(set, { shipment: v.shipment, liftgate: v.liftgate, residential: v.residential }); if (v.shipFrom) set.ship_from = v.shipFrom; break;
        case 'ship':
          need(paidInFull || !!r.release, 'ORDER_NOT_PAID', 'Nothing ships before full payment: record the payment, or ask a main admin to release the order',
            r.kind === 'kol' ? 'KOL 订单要先由主管理员批准才能发货。' : '订单还没收全款，不能发货。请先记录收款，或请主管理员特批。');
          need(!r.shipped_at, 'ORDER_ALREADY_SHIPPED', 'This order has already shipped', '这张订单已经发货了。');
          Object.assign(set, { shipped_at: at, ship_from: v.shipFrom, carrier: v.carrier, tracking: v.tracking, eta: v.eta || null, track_at: at });
          Object.assign(set, await takeOut(tx, u, r, v.shipFrom, v.wmsOut, at)); break;
        case 'wms_out':
          need(!!r.shipped_at, 'ORDER_NOT_SHIPPED', 'This order has not shipped yet', '这张订单还没发货。');
          need(!r.wms_out_at, 'ORDER_WMS_ALREADY_OUT', 'This order is already out of WMS stock', '这张订单已经从 WMS 出库了。');
          set.ship_from = v.shipFrom; Object.assign(set, await takeOut(tx, u, r, v.shipFrom, v.wmsOut, at)); break;
        case 'track': need(!!r.shipped_at, 'ORDER_NOT_SHIPPED', 'This order has not shipped yet', '这张订单还没发货。'); set.track_at = at; if (v.eta) set.eta = v.eta; break;
        case 'terminal': need(!!r.shipped_at, 'ORDER_NOT_SHIPPED', 'This order has not shipped yet', '这张订单还没发货。'); set.terminal_at = at; set.track_at = at; break;
        case 'appointment': need(!!r.shipped_at, 'ORDER_NOT_SHIPPED', 'This order has not shipped yet', '这张订单还没发货。'); set.appointment_on = v.on; if (!r.terminal_at) set.terminal_at = at; break;
        case 'delivered': need(!!r.shipped_at, 'ORDER_NOT_SHIPPED', 'This order has not shipped yet', '这张订单还没发货。'); set.delivered_at = at; set.damage = v.damage; break;
        case 'first_piece': need(!!r.delivered_at, 'ORDER_NOT_DELIVERED', 'This order has not been delivered yet', '这张订单还没签收。'); set.first_piece_at = at; break;
        case 'review_invited': need(!!r.first_piece_at, 'ORDER_NO_FIRST_PIECE', 'Invite a review after the customer has made a first piece', '客户做出第一件作品之后再邀请评价。');
          set.review_invited_at = r.review_invited_at || at; set.review_platform = v.platform; break;
        case 'reviewed': set.reviewed_at = at; set.review_platform = v.platform; set.review_rating = v.rating; if (!r.review_invited_at) set.review_invited_at = at; break;
        case 'content': need(r.kind === 'kol', 'ORDER_NOT_KOL', 'Content links are for KOL orders', '只有 KOL 订单需要填内容链接。'); set.content_url = v.url; break;
        case 'cancel': set.cancelled_at = at; set.cancel_reason = v.reason; break;
        case 'refund': {
          need(r.source === 'manual', 'ORDER_REFUND_FROM_SHOPIFY', 'Refunds for Shopify orders come from Shopify; refund there and sync', 'Shopify 订单的退款以 Shopify 为准：请在 Shopify 里退款，再同步。');
          const add = centsOf(v.amount), was = Number(r.refunded_cents || 0);
          need(was + add <= Number(r.paid_cents), 'ORDER_REFUND_TOO_MUCH', 'The refund is more than was paid', '退款金额超过了已收金额。');
          set.refunded_cents = was + add; set.refund_note = v.reason; break;
        }
        case 'exchange': set.exchange = JSON.stringify({ by: u.id, at, reason: v.reason, newOrder: v.newOrder || '' }); break;
        case 'note': set.note = JSON.stringify({ text: v.text, by: u.id, at }); break;
      }
      const keys = Object.keys(set);
      if (keys.length) await tx.query(`UPDATE ful_orders SET ${keys.map((k, i) => `${k}=$${i + 3}`).join(',')}, updated_at=now() WHERE id=$1 AND org_id=$2`, [r.id, u.org_id, ...keys.map(k => set[k])]);
      const { step, ...details } = v as any;
      await event(tx, u, r.id, u.org_id, step, details);
      return { ok: true };
    });
  });

  /* ---------- settings: owners and deadlines (main admins) ---------- */
  app.get('/orders/settings', async req => {
    const u = actorOf(req); requireView(u);
    const people = (await db.query("SELECT id, COALESCE(NULLIF(display_name,''), name_zh, name_en, id) n FROM users WHERE org_id=$1 AND active=true ORDER BY 2", [u.org_id])).rows.map((r: any) => ({ id: r.id, name: r.n }));
    return { settings: await settingsOf(u.org_id), people, canEdit: o.isAdmin(u) };
  });
  const owner = z.string().trim().max(100).nullable();
  const settingsInput = z.object({ payOwner: owner, shipOwner: owner, callOwner: owner, trainOwner: owner, shipHoursLtl: z.number().int().min(1).max(720),
    shipHoursParcel: z.number().int().min(1).max(720), payDays: z.number().int().min(1).max(60), terminalDays: z.number().int().min(1).max(30),
    stallDays: z.number().int().min(1).max(30), trainDays: z.number().int().min(1).max(60), reviewPlatforms: z.array(z.enum(REVIEW_PLATFORMS)).min(1).max(4) }).strict();
  app.put('/orders/settings', async req => {
    const u = actorOf(req);
    if (!o.isAdmin(u)) deny(403, 'ORDERS_SETTINGS_ADMIN_ONLY', 'Only a main admin can change fulfillment settings', '只有主管理员能修改订单履约的设置。');
    const v = settingsInput.parse(req.body);
    for (const id of [v.payOwner, v.shipOwner, v.callOwner, v.trainOwner].filter(Boolean))
      if (!(await db.query('SELECT 1 FROM users WHERE id=$1 AND org_id=$2 AND active=true', [id, u.org_id])).rows.length) deny(400, 'ORDERS_OWNER_INVALID', 'Choose an active member as owner', '负责人必须是在职的成员。');
    await db.query(`INSERT INTO ful_settings(org_id,pay_owner,ship_owner,call_owner,train_owner,ship_hours_ltl,ship_hours_parcel,pay_days,terminal_days,stall_days,train_days,review_platforms,updated_by,updated_at)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,now()) ON CONFLICT(org_id) DO UPDATE SET pay_owner=$2,ship_owner=$3,call_owner=$4,train_owner=$5,ship_hours_ltl=$6,
      ship_hours_parcel=$7,pay_days=$8,terminal_days=$9,stall_days=$10,train_days=$11,review_platforms=$12,updated_by=$13,updated_at=now()`,
      [u.org_id, v.payOwner, v.shipOwner, v.callOwner, v.trainOwner, v.shipHoursLtl, v.shipHoursParcel, v.payDays, v.terminalDays, v.stallDays, v.trainDays, JSON.stringify(v.reviewPlatforms), u.id]);
    return { settings: await settingsOf(u.org_id) };
  });

  /* ---------- Shopify: pull open orders, and check what the app may read ---------- */
  const shop = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.myshopify\.com$/.test(o.shopify?.shopDomain || '') ? o.shopify!.shopDomain! : null;
  const fetcher = o.shopify?.fetcher || fetch;
  function shopifyConfigured() { return !!shop && (!!o.shopify?.accessToken || (!!o.shopify?.clientId && !!o.shopify?.clientSecret)); }
  let token: { value: string; until: number } | null = null;
  const accessToken = async () => {
    if (o.shopify?.accessToken) return o.shopify.accessToken;
    if (token && now() < token.until - 60_000) return token.value;
    const r = await fetcher(`https://${shop}/admin/oauth/access_token`, { method: 'POST', redirect: 'error', headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
      body: new URLSearchParams({ grant_type: 'client_credentials', client_id: o.shopify!.clientId!, client_secret: o.shopify!.clientSecret! }) });
    const j: any = r.ok ? await r.json() : null;
    if (!j?.access_token) throw new Error('shopify_unavailable');
    token = { value: j.access_token, until: now() + Number(j.expires_in || 3600) * 1000 };
    return token.value;
  };
  const gql = async (query: string, variables: Record<string, unknown> = {}) => {
    const r = await fetcher(`https://${shop}/admin/api/${SHOPIFY_API_VERSION}/graphql.json`, { method: 'POST', redirect: 'error',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json', 'X-Shopify-Access-Token': await accessToken() }, body: JSON.stringify({ query, variables }) });
    if (!r.ok) throw new Error('shopify_http_' + r.status);
    return await r.json() as any;
  };
  const ORDER_FIELDS = (withCustomer: boolean) => `id name createdAt cancelledAt test tags sourceName
    cancelReason totalPriceSet { shopMoney { amount } } totalOutstandingSet { shopMoney { amount } } totalRefundedSet { shopMoney { amount } }
    lineItems(first: 50) { nodes { sku name quantity } }
    fulfillments(first: 5) { createdAt trackingInfo(first: 1) { company number } }
    ${withCustomer ? 'customer { displayName email phone } shippingAddress { name phone city provinceCode zip countryCodeV2 }' : ''}`;
  const protectedData = (j: any) => (j?.errors || []).some((e: any) => /access|protected|customer|denied/i.test(String(e?.message || '')));

  async function syncOrders(org: string) {
    const since = new Date(now() - 60 * D).toISOString().slice(0, 10);
    let withCustomer = true, after: string | null = null, pages = 0, seen = 0, created = 0, updated = 0;
    for (;;) {
      const q = `query WorkOSOrders($q: String!, $after: String) { orders(first: 50, after: $after, query: $q, sortKey: CREATED_AT) { nodes { ${ORDER_FIELDS(withCustomer)} } pageInfo { hasNextPage endCursor } } }`;
      let j: any;
      try { j = await gql(q, { q: `created_at:>=${since}`, after }); } catch { return deny(502, 'SHOPIFY_FAILED', 'Could not read orders from Shopify; check the app’s read_orders access', '读取 Shopify 订单失败，请检查 Shopify 应用是否开了 read_orders 权限。'); }
      if (!j?.data?.orders && withCustomer && protectedData(j)) { withCustomer = false; continue; } // retry without customer details
      const page = j?.data?.orders; if (!page) return deny(502, 'SHOPIFY_FAILED', 'Could not read orders from Shopify; check the app’s read_orders access', '读取 Shopify 订单失败，请检查 Shopify 应用是否开了 read_orders 权限。');
      for (const n of page.nodes || []) {
        if (n.test) continue; seen++;
        const total = centsOf(n.totalPriceSet?.shopMoney?.amount), owed = centsOf(n.totalOutstandingSet?.shopMoney?.amount), paid = Math.max(0, total - owed), refunded = centsOf(n.totalRefundedSet?.shopMoney?.amount);
        const cancelReason = n.cancelledAt ? String(n.cancelReason || 'other').toLowerCase() : '';
        const tags: string[] = Array.isArray(n.tags) ? n.tags : [], k = kindOf(tags, total);
        const lines = (n.lineItems?.nodes || []).map((l: any) => ({ sku: String(l.sku || ''), name: String(l.name || '').slice(0, 200), qty: Number(l.quantity) || 0 }));
        const f = (n.fulfillments || []).find((x: any) => x?.trackingInfo?.[0]?.number);
        const old = (await db.query('SELECT * FROM ful_orders WHERE org_id=$1 AND shopify_id=$2', [org, n.id])).rows[0];
        const c = n.customer || {}, a = n.shippingAddress || {};
        if (!old) {
          const id = randomUUID(); created++;
          await db.query(`INSERT INTO ful_orders(id,org_id,source,shopify_id,number,kind,kind_note,channel,placed_at,customer_name,customer_email,customer_phone,ship_city,ship_state,
            ship_zip,ship_country,total_cents,paid_cents,lines,tags,paid_at,cancelled_at,shipped_at,carrier,tracking,track_at,refunded_cents,cancel_reason,wms_out_at,wms_out)
            VALUES($1,$2,'shopify',$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$22,$25,$26,$22,CASE WHEN $22::timestamptz IS NULL THEN NULL ELSE '{"mode":"before"}'::jsonb END)`,
            [id, org, n.id, n.name, k.kind, k.note, ['shopify_draft_order', 'pos'].includes(n.sourceName) ? 'offline' : k.channel, n.createdAt, c.displayName || a.name || '', c.email || '',
              c.phone || a.phone || '', a.city || '', a.provinceCode || '', a.zip || '', a.countryCodeV2 || 'US', total, paid, JSON.stringify(lines), JSON.stringify(tags),
              total > 0 && paid >= total ? n.createdAt : null, n.cancelledAt || null, f?.createdAt || null, f?.trackingInfo?.[0]?.company || '', f?.trackingInfo?.[0]?.number || '', refunded, cancelReason]);
          await event(db, null, id, org, 'imported', { number: n.name });
        } else {
          updated++;
          // Shopify owns totals, payment, tags, lines and cancellation; people own the fulfillment steps. Tracking fills in only when empty.
          await db.query(`UPDATE ful_orders SET total_cents=$3::bigint, paid_cents=$4::bigint, tags=$5::jsonb, lines=$6::jsonb, cancelled_at=COALESCE(cancelled_at,$7::timestamptz),
            paid_at=CASE WHEN paid_at IS NULL AND $3::bigint>0 AND $4::bigint>=$3::bigint THEN now() ELSE paid_at END,
            customer_name=CASE WHEN $8::text<>'' THEN $8::text ELSE customer_name END, customer_email=CASE WHEN $9::text<>'' THEN $9::text ELSE customer_email END,
            shipped_at=COALESCE(shipped_at,$10::timestamptz), carrier=CASE WHEN carrier='' THEN $11::text ELSE carrier END, tracking=CASE WHEN tracking='' THEN $12::text ELSE tracking END, refunded_cents=$13::bigint, cancel_reason=CASE WHEN cancel_reason='' THEN $14::text ELSE cancel_reason END, updated_at=now()
            WHERE id=$1 AND org_id=$2`, [old.id, org, total, paid, JSON.stringify(tags), JSON.stringify(lines), n.cancelledAt || null, c.displayName || a.name || '', c.email || '',
            f?.createdAt || null, f?.trackingInfo?.[0]?.company || '', f?.trackingInfo?.[0]?.number || '', refunded, cancelReason]);
        }
      }
      after = page.pageInfo?.hasNextPage ? page.pageInfo.endCursor : null;
      if (!after || ++pages >= 40) break;
    }
    return { since, seen, created, updated, customerDetails: withCustomer };
  }
  app.post('/orders/sync', async req => {
    const u = actorOf(req); requireManage(u);
    if (!shopifyConfigured()) deny(503, 'SHOPIFY_NOT_CONFIGURED', 'Shopify is not connected here', '这里还没连接 Shopify。');
    return syncOrders(u.org_id);
  });
  // New Shopify orders come in on their own (owner, 2026-11-17), so they hold stock right away. Runs for organizations that
  // have synced once by hand.
  if (o.syncIntervalMs && shopifyConfigured()) {
    let running = false;
    const tick = async () => { if (running) return; running = true;
      try { for (const r of (await db.query('SELECT DISTINCT org_id FROM ful_orders WHERE shopify_id IS NOT NULL')).rows) await syncOrders(r.org_id).catch(() => undefined); }
      finally { running = false; } };
    const timer = setInterval(() => { tick().catch(() => undefined); }, o.syncIntervalMs); timer.unref?.();
    app.addHook('onClose', async () => clearInterval(timer));
  }

  app.get('/orders/shopify-check', async req => {
    const u = actorOf(req);
    if (!o.isAdmin(u)) deny(403, 'ORDERS_SETTINGS_ADMIN_ONLY', 'Only a main admin can change fulfillment settings', '只有主管理员能修改订单履约的设置。');
    if (!shopifyConfigured()) return { configured: false };
    const out: any = { configured: true, scopes: [], oldestOrder: null, customerReadable: null, errors: [] as string[] };
    try { const j = await gql('{ currentAppInstallation { accessScopes { handle } } }'); out.scopes = (j?.data?.currentAppInstallation?.accessScopes || []).map((s: any) => s.handle); }
    catch (e: any) { out.errors.push('scopes: ' + String(e?.message || e)); }
    try { const j = await gql('{ orders(first: 1, sortKey: CREATED_AT) { nodes { createdAt } } }'); out.oldestOrder = j?.data?.orders?.nodes?.[0]?.createdAt || null; }
    catch (e: any) { out.errors.push('orders: ' + String(e?.message || e)); }
    try { const j = await gql('{ orders(first: 1, reverse: true) { nodes { customer { displayName } shippingAddress { city } } } }'); out.customerReadable = !!j?.data?.orders && !protectedData(j); }
    catch (e: any) { out.errors.push('customer: ' + String(e?.message || e)); }
    out.hasReadOrders = out.scopes.includes('read_orders'); out.hasReadAllOrders = out.scopes.includes('read_all_orders');
    return out;
  });
}
