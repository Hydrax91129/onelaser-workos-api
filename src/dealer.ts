/* Dealer portal: dealer accounts, dealer-price catalog, orders, ACH payment and shipment tracking.
 *
 * Dealers are not employees. Like CalDock they have their own tables, cookie, CSRF token and /dealer/*
 * path, and never touch the Work OS users or sessions. A dealer signs up with email + password or
 * Google, waits for a person at OneLaser to approve the account, then sees dealer prices and orders.
 *
 *   prices    the 'dealer' channel price on the Products page (product_channel_prices), which already
 *             goes through price approval; the order keeps a server-side snapshot of each price
 *   payment   Stripe Checkout with ACH Direct Debit (us_bank_account, Financial Connections). ACH takes
 *             about four business days to clear: the order sits in 'processing' until Stripe confirms
 *   shipping  staff ship from the Dealer orders page (dealer-admin.ts); stock leaves the US warehouse
 *             as a WMS goods-out movement with the order number as reference
 *
 * See docs/plans/2026-11-02-dealer-portal.md. */
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { Database, Queryable } from './db.js';
import { hash, readCookie, sameSecret } from './auth.js';
import { deny } from './errors.js';
import { hashPassword, verifyPassword, type Mailer } from './members.js';
import { createCaldockGateway, type CaldockGateway } from './caldock-oidc.js';
import { createCaldockStripe, verifyStripeEvent, StripeRequestError, type CaldockStripe } from './caldock-stripe.js';

export const dealerSchema = `
CREATE TABLE IF NOT EXISTS dealer_accounts(id text PRIMARY KEY, org_id text NOT NULL, email text NOT NULL, password_hash text,
  company text NOT NULL DEFAULT '', contact_name text NOT NULL DEFAULT '', phone text NOT NULL DEFAULT '', website text NOT NULL DEFAULT '',
  resale_cert text NOT NULL DEFAULT '', address jsonb,
  status text NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','approved','rejected','suspended')),
  ship_before_clear boolean NOT NULL DEFAULT false, stripe_customer_id text, staff_note text NOT NULL DEFAULT '', decision_note text NOT NULL DEFAULT '',
  decided_by text, decided_at timestamptz, created_at timestamptz NOT NULL DEFAULT now(), version integer NOT NULL DEFAULT 1);
CREATE UNIQUE INDEX IF NOT EXISTS dealer_accounts_email ON dealer_accounts(org_id,lower(email));
CREATE TABLE IF NOT EXISTS dealer_identities(provider text NOT NULL CHECK(provider IN ('google')), subject text NOT NULL,
  dealer_id text NOT NULL REFERENCES dealer_accounts(id), PRIMARY KEY(provider,subject));
CREATE TABLE IF NOT EXISTS dealer_sessions(token_hash text PRIMARY KEY, dealer_id text NOT NULL REFERENCES dealer_accounts(id), csrf_token text NOT NULL,
  expires_at timestamptz NOT NULL, created_at timestamptz NOT NULL DEFAULT now());
CREATE INDEX IF NOT EXISTS dealer_sessions_dealer ON dealer_sessions(dealer_id);
CREATE TABLE IF NOT EXISTS dealer_oauth_states(state_hash text PRIMARY KEY, browser_hash text NOT NULL, nonce text NOT NULL, verifier text NOT NULL,
  language text NOT NULL, expires_at timestamptz NOT NULL);
CREATE SEQUENCE IF NOT EXISTS dealer_order_number START 1001;
CREATE TABLE IF NOT EXISTS dealer_orders(id text PRIMARY KEY, org_id text NOT NULL, dealer_id text NOT NULL REFERENCES dealer_accounts(id), number text NOT NULL UNIQUE,
  status text NOT NULL CHECK(status IN ('pending_payment','processing','paid','payment_failed','shipped','cancelled','disputed','refunded')),
  total_cents bigint NOT NULL CHECK(total_cents>0), currency text NOT NULL DEFAULT 'usd', po_number text NOT NULL DEFAULT '', note text NOT NULL DEFAULT '',
  ship_to jsonb NOT NULL, request_key text NOT NULL, stripe_checkout_session_id text, stripe_payment_intent_id text, paid_at timestamptz,
  carrier text, tracking_number text, tracking_url text, shipped_at timestamptz, shipped_by text, stock_location text,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(), version integer NOT NULL DEFAULT 1, UNIQUE(dealer_id,request_key));
CREATE INDEX IF NOT EXISTS dealer_orders_dealer ON dealer_orders(dealer_id,created_at);
CREATE INDEX IF NOT EXISTS dealer_orders_status ON dealer_orders(org_id,status,created_at);
CREATE INDEX IF NOT EXISTS dealer_orders_intent ON dealer_orders(stripe_payment_intent_id);
CREATE TABLE IF NOT EXISTS dealer_order_lines(order_id text NOT NULL REFERENCES dealer_orders(id), sku text NOT NULL, name text NOT NULL,
  qty integer NOT NULL CHECK(qty>0 AND qty<=10000), unit_cents bigint NOT NULL CHECK(unit_cents>0), PRIMARY KEY(order_id,sku));
CREATE TABLE IF NOT EXISTS dealer_order_events(id text PRIMARY KEY, order_id text NOT NULL REFERENCES dealer_orders(id), type text NOT NULL,
  actor_kind text NOT NULL CHECK(actor_kind IN ('dealer','staff','stripe')), actor_id text, details jsonb NOT NULL DEFAULT '{}', created_at timestamptz NOT NULL DEFAULT now());
CREATE INDEX IF NOT EXISTS dealer_order_events_order ON dealer_order_events(order_id,created_at);
CREATE TABLE IF NOT EXISTS dealer_stripe_events(event_id text PRIMARY KEY, event_type text NOT NULL, received_at timestamptz NOT NULL DEFAULT now());
`;

export const ORDER_STATUSES = ['pending_payment', 'processing', 'paid', 'payment_failed', 'shipped', 'cancelled', 'disputed', 'refunded'] as const;
export const CARRIERS = ['ups', 'fedex', 'usps', 'dhl', 'freight', 'other'] as const;
/** Products in development or end of life are never offered, whatever their dealer price. */
const SELLABLE = "c.status NOT IN ('dev','eol')";

export type DealerOptions = {
  orgId?: string; publicUrl?: string; secureCookies?: boolean;
  google?: CaldockGateway; stripe?: CaldockStripe; mailer?: Mailer | null; notifyEmail?: string;
};
export function dealerOptionsFromEnv(env: NodeJS.ProcessEnv): DealerOptions {
  let stripe: CaldockStripe | undefined;
  // A Stripe misconfiguration disables dealer payments only; it must never stop the shared Work OS service.
  try {
    if (env.DEALER_STRIPE_SECRET_KEY && env.DEALER_STRIPE_WEBHOOK_SECRET)
      stripe = createCaldockStripe({ secretKey: env.DEALER_STRIPE_SECRET_KEY.trim(), webhookSecret: env.DEALER_STRIPE_WEBHOOK_SECRET.trim(), allowLive: env.DEALER_STRIPE_ALLOW_LIVE === 'true' });
  } catch (error) { console.error('Dealer payments disabled: ' + ((error as Error).message.startsWith('Live') ? 'live Stripe keys require DEALER_STRIPE_ALLOW_LIVE=true' : (error as Error).message)); }
  return {
    orgId: env.DEALER_ORG_ID?.trim() || undefined, stripe, notifyEmail: env.DEALER_NOTIFY_EMAIL?.trim() || undefined,
    google: env.DEALER_GOOGLE_CLIENT_ID && env.DEALER_GOOGLE_CLIENT_SECRET ? createCaldockGateway('google', { clientId: env.DEALER_GOOGLE_CLIENT_ID, clientSecret: env.DEALER_GOOGLE_CLIENT_SECRET }) : undefined,
  };
}

/* ---------- shared with dealer-admin.ts ---------- */
const cents = (dollars: unknown) => Math.round(Number(dollars) * 100);
export const money = (c: number | string) => '$' + (Number(c) / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
export const availability = (qty: number) => qty >= 10 ? 'in_stock' : qty > 0 ? 'limited' : 'backorder';

export async function orderEvent(tx: Queryable, orderId: string, type: string, actorKind: 'dealer' | 'staff' | 'stripe', actorId: string | null, details: unknown = {}) {
  await tx.query('INSERT INTO dealer_order_events(id,order_id,type,actor_kind,actor_id,details) VALUES($1,$2,$3,$4,$5,$6)', [randomUUID(), orderId, type, actorKind, actorId, JSON.stringify(details)]);
}
/** Moves an order to a new status and records why. Returns the updated row. */
export async function setStatus(tx: Queryable, order: any, status: string, actorKind: 'dealer' | 'staff' | 'stripe', actorId: string | null, details: unknown = {}, extra: Record<string, unknown> = {}) {
  const cols = Object.keys(extra), vals = Object.values(extra);
  const set = cols.map((c, i) => `${c}=$${i + 3}`).join(',');
  const row = (await tx.query(`UPDATE dealer_orders SET status=$2,updated_at=now(),version=version+1${set ? ',' + set : ''} WHERE id=$1 RETURNING *`, [order.id, status, ...vals])).rows[0];
  await orderEvent(tx, order.id, status, actorKind, actorId, details);
  return row;
}
export async function orderLines(q: Queryable, orderIds: string[]) {
  const map = new Map<string, any[]>();
  if (!orderIds.length) return map;
  for (const l of (await q.query('SELECT * FROM dealer_order_lines WHERE order_id=ANY($1::text[]) ORDER BY sku', [orderIds])).rows) {
    if (!map.has(l.order_id)) map.set(l.order_id, []);
    map.get(l.order_id)!.push({ sku: l.sku, name: l.name, qty: Number(l.qty), unitCents: Number(l.unit_cents), lineCents: Number(l.unit_cents) * Number(l.qty) });
  }
  return map;
}
export const orderOut = (o: any, lines: any[] = []) => ({
  id: o.id, number: o.number, status: o.status, totalCents: Number(o.total_cents), currency: o.currency, poNumber: o.po_number, note: o.note, shipTo: o.ship_to,
  paidAt: o.paid_at, carrier: o.carrier, trackingNumber: o.tracking_number, trackingUrl: o.tracking_url, shippedAt: o.shipped_at,
  createdAt: o.created_at, updatedAt: o.updated_at, version: o.version, lines,
});
export const accountOut = (a: any) => ({
  id: a.id, email: a.email, company: a.company, contactName: a.contact_name, phone: a.phone, website: a.website, resaleCert: a.resale_cert,
  address: a.address, status: a.status, profileComplete: profileComplete(a), createdAt: a.created_at, decisionNote: a.status === 'rejected' ? a.decision_note : '',
  signIn: a.password_hash ? 'password' : 'google',
});
export const profileComplete = (a: any) => !!(a.company && a.contact_name && a.phone && a.address?.line1);

/** Plain-text email with a minimal HTML twin. Delivery failures never undo the change that triggered them. */
export async function sendMail(mailer: Mailer | null | undefined, to: string | undefined, subject: string, lines: string[]) {
  if (!mailer || !to) return;
  const esc = (s: string) => s.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
  try { await mailer({ to, subject, text: lines.join('\n'), html: lines.map(l => `<p>${esc(l)}</p>`).join('') }); }
  catch { console.error('Dealer email could not be delivered'); }
}

/* ---------- input ---------- */
const email = z.string().trim().toLowerCase().max(200).email();
const line = (max: number) => z.string().trim().max(max);
export const addressInput = z.object({
  name: line(120).optional(), line1: line(200).min(1), line2: line(200).optional(), city: line(100).min(1),
  state: line(40).min(1), postalCode: z.string().trim().regex(/^[0-9]{5}(-[0-9]{4})?$/, 'Use a US ZIP code'), country: z.literal('US').default('US'),
  phone: line(40).regex(/^[0-9+()\-.\s]*$/).optional(),
}).strict();
const profileInput = z.object({
  company: line(200).min(1), contactName: line(120).min(1), phone: line(40).min(7).regex(/^[0-9+()\-.\s]+$/, 'Use digits for the phone number'),
  website: line(200).optional(), resaleCert: line(80).optional(), address: addressInput,
}).strict();
const registerInput = profileInput.extend({ email, password: z.string().min(10).max(200) }).strict();
const loginInput = z.object({ email, password: z.string().min(1).max(200) }).strict();
const orderInput = z.object({
  requestKey: z.string().uuid(),
  lines: z.array(z.object({ sku: z.string().trim().min(1).max(80), qty: z.number().int().min(1).max(10000) }).strict()).min(1).max(100),
  poNumber: line(60).optional(), note: line(1000).optional(), shipTo: addressInput.optional(),
}).strict();
const uuid = z.string().uuid();

const token = () => randomBytes(32).toString('base64url');
export const dealerCookieName = (secure: boolean, kind = 'session') => (secure ? '__Host-' : '') + 'dealer_' + kind;
const cookieOf = (secure: boolean, value: string, maxAge = 604800, kind = 'session') =>
  `${dealerCookieName(secure, kind)}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${secure ? '; Secure' : ''}`;
function appendCookie(reply: any, value: string) { const old = reply.getHeader('set-cookie'); reply.header('Set-Cookie', [...(old ? [old].flat() : []), value]); }

type Session = { dealer: any; csrf: string; token: string };
const PUBLIC = new Set(['/dealer/capabilities', '/dealer/auth/register', '/dealer/auth/login', '/dealer/auth/google/start', '/dealer/auth/google/callback']);

export async function registerDealerRoutes(app: FastifyInstance, db: Database, o: DealerOptions = {}) {
  const publicUrl = new URL(o.publicUrl || 'http://localhost:4173');
  if (!['http:', 'https:'].includes(publicUrl.protocol) || publicUrl.username || publicUrl.password) throw new Error('Invalid dealer portal public URL');
  const origin = publicUrl.origin, secure = o.secureCookies === true, stripe = o.stripe, orgId = o.orgId;
  const portal = (params: Record<string, string> = {}) => { const u = new URL('/dealer/', origin); for (const [k, v] of Object.entries(params)) u.searchParams.set(k, v); return u.toString(); };
  const sessions = new WeakMap<FastifyRequest, Session>();
  const actor = (req: FastifyRequest) => sessions.get(req) || deny(401, 'DEALER_UNAUTHENTICATED', 'Sign in to continue');
  const approved = (req: FastifyRequest) => {
    const s = actor(req);
    if (s.dealer.status !== 'approved') deny(403, 'DEALER_NOT_APPROVED', 'Your dealer account has not been approved yet');
    return s;
  };
  const checkOrigin = (req: FastifyRequest) => { if (req.headers.origin !== origin) deny(403, 'DEALER_CSRF_INVALID', 'Request origin or security token is invalid'); };
  const viaStripe = async <T>(call: () => Promise<T>): Promise<T> => {
    try { return await call(); }
    catch (error) { if (error instanceof StripeRequestError) deny(502, 'DEALER_PAYMENT_PROVIDER_ERROR', 'The payment provider could not complete the request; try again'); throw error; }
  };
  const hits = new Map<string, { count: number; until: number }>();
  const limit = (key: string, max: number) => {
    const now = Date.now(), k = hash(key), cur = hits.get(k);
    if (cur && cur.until > now && cur.count >= max) deny(429, 'DEALER_RATE_LIMITED', 'Too many attempts; try again shortly');
    if (!cur || cur.until <= now) hits.set(k, { count: 1, until: now + 60000 }); else cur.count++;
    if (hits.size > 5000) for (const [key2, v] of hits) if (v.until <= now) hits.delete(key2);
  };
  const issue = async (reply: any, dealerId: string) => {
    const value = token();
    await db.query("INSERT INTO dealer_sessions(token_hash,dealer_id,csrf_token,expires_at) VALUES($1,$2,$3,now()+interval '7 days')", [hash(value), dealerId, token()]);
    appendCookie(reply, cookieOf(secure, value));
  };

  app.register(async routes => {
    routes.addHook('onRequest', async req => {
      const path = req.url.split('?')[0];
      if (path !== '/dealer/capabilities' && !orgId) deny(503, 'DEALER_PORTAL_DISABLED', 'The dealer portal is not open yet');
      if (PUBLIC.has(path)) return;
      const value = readCookie(req.headers.cookie, dealerCookieName(secure));
      if (!value) deny(401, 'DEALER_UNAUTHENTICATED', 'Sign in to continue');
      const row = (await db.query('SELECT a.*,s.csrf_token FROM dealer_sessions s JOIN dealer_accounts a ON a.id=s.dealer_id WHERE s.token_hash=$1 AND s.expires_at>now() AND a.org_id=$2', [hash(value), orgId])).rows[0];
      if (!row) deny(401, 'DEALER_UNAUTHENTICATED', 'Sign in to continue');
      const { csrf_token, ...dealer } = row;
      sessions.set(req, { dealer, csrf: csrf_token, token: value });
      if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method)) {
        checkOrigin(req);
        const supplied = req.headers['x-csrf-token'];
        if (typeof supplied !== 'string' || !sameSecret(supplied, csrf_token)) deny(403, 'DEALER_CSRF_INVALID', 'Request origin or security token is invalid');
      }
    });

    routes.get('/capabilities', async () => ({
      service: 'dealer', enabled: !!orgId, providers: { google: !!o.google, password: true }, payments: !!stripe, paymentMode: stripe?.mode ?? null,
      paymentMethods: ['us_bank_account'], currency: 'USD', auth: { session: 'httpOnlyCookie', csrfHeader: 'X-CSRF-Token' },
    }));

    /* ---------- sign-up and sign-in ---------- */
    routes.post('/auth/register', async (req, reply) => {
      checkOrigin(req); limit('register:' + req.ip, 10);
      const v = registerInput.parse(req.body), passwordHash = await hashPassword(v.password), id = randomUUID();
      const created = await db.query(`INSERT INTO dealer_accounts(id,org_id,email,password_hash,company,contact_name,phone,website,resale_cert,address)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) ON CONFLICT DO NOTHING RETURNING id`,
        [id, orgId, v.email, passwordHash, v.company, v.contactName, v.phone, v.website || '', v.resaleCert || '', JSON.stringify(v.address)]);
      if (!created.rows.length) deny(409, 'DEALER_EMAIL_IN_USE', 'An account with this email already exists; sign in instead');
      await issue(reply, id);
      await sendMail(o.mailer, o.notifyEmail, `New dealer application: ${v.company}`, [`${v.company} (${v.contactName}, ${v.email}) applied for a dealer account.`, 'Review it on the Dealer orders page in CraftOS.']);
      return reply.code(201).send({ registered: true, status: 'pending' });
    });
    routes.post('/auth/login', async (req, reply) => {
      checkOrigin(req);
      const v = loginInput.parse(req.body);
      limit('login:' + req.ip, 30); limit('login:' + v.email, 10);
      const row = (await db.query('SELECT id,password_hash FROM dealer_accounts WHERE org_id=$1 AND lower(email)=$2', [orgId, v.email])).rows[0];
      // verifyPassword spends the same scrypt time when there is no stored hash, so unknown emails are not faster.
      if (!(await verifyPassword(v.password, row?.password_hash))) deny(401, 'DEALER_LOGIN_FAILED', 'Email or password is incorrect');
      await issue(reply, row.id);
      return { signedIn: true };
    });
    routes.get('/auth/google/start', async (req, reply) => {
      limit('oauth:' + req.ip, 30);
      if (!o.google) deny(503, 'DEALER_PROVIDER_NOT_CONFIGURED', 'Google sign-in is not available yet');
      const input = z.object({ lang: z.enum(['zh', 'en']).default('en') }).strict().parse(req.query);
      const state = token(), browser = token(), nonce = token(), verifier = token();
      await db.query('DELETE FROM dealer_oauth_states WHERE expires_at<now()');
      await db.query("INSERT INTO dealer_oauth_states(state_hash,browser_hash,nonce,verifier,language,expires_at) VALUES($1,$2,$3,$4,$5,now()+interval '10 minutes')", [hash(state), hash(browser), nonce, verifier, input.lang]);
      appendCookie(reply, cookieOf(secure, browser, 600, 'oauth'));
      return reply.redirect(o.google.authorizationUrl({ state, nonce, challenge: createHash('sha256').update(verifier).digest('base64url'), redirectUri: origin + '/api/dealer/auth/google/callback' }));
    });
    routes.get('/auth/google/callback', async (req, reply) => {
      limit('oauth:' + req.ip, 30);
      if (!o.google) deny(503, 'DEALER_PROVIDER_NOT_CONFIGURED', 'Google sign-in is not available yet');
      const input = z.object({ state: z.string().regex(/^[A-Za-z0-9_-]{43}$/), code: z.string().min(1).max(4096).optional(), error: z.string().max(100).optional() }).parse(req.query);
      const browser = readCookie(req.headers.cookie, dealerCookieName(secure, 'oauth'));
      if (!browser) deny(400, 'DEALER_OAUTH_STATE_INVALID', 'Sign-in expired; please start again');
      const state = (await db.query('DELETE FROM dealer_oauth_states WHERE state_hash=$1 AND browser_hash=$2 AND expires_at>now() RETURNING *', [hash(input.state), hash(browser)])).rows[0];
      if (!state) deny(400, 'DEALER_OAUTH_STATE_INVALID', 'Sign-in expired; please start again');
      appendCookie(reply, cookieOf(secure, '', 0, 'oauth'));
      if (input.error || !input.code) return reply.redirect(portal({ lang: state.language, error: 'oauth_cancelled' }));
      let identity;
      try { identity = await o.google.authenticate({ code: input.code, nonce: state.nonce, verifier: state.verifier, redirectUri: origin + '/api/dealer/auth/google/callback' }); }
      catch { return reply.redirect(portal({ lang: state.language, error: 'oauth_failed' })); }
      // The Google subject is the identity. A verified email is required because staff review it and order emails go there.
      if (identity.provider !== 'google' || !identity.subject || identity.subject.length > 255 || !identity.email) return reply.redirect(portal({ lang: state.language, error: 'oauth_failed' }));
      const dealerId = await db.transaction(async tx => {
        const prior = (await tx.query('SELECT d.id FROM dealer_identities i JOIN dealer_accounts d ON d.id=i.dealer_id WHERE i.provider=$1 AND i.subject=$2 AND d.org_id=$3', ['google', identity.subject, orgId])).rows[0];
        if (prior) return prior.id as string;
        // Never attach Google to an existing account by email: a password account's email is unverified,
        // so whoever registered it first could otherwise read the Google user's orders.
        const id = randomUUID();
        const created = await tx.query('INSERT INTO dealer_accounts(id,org_id,email,contact_name) VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING RETURNING id', [id, orgId, identity.email, identity.name.slice(0, 120)]);
        if (!created.rows.length) return null;
        await tx.query('INSERT INTO dealer_identities(provider,subject,dealer_id) VALUES($1,$2,$3)', ['google', identity.subject, id]);
        return id;
      });
      if (!dealerId) return reply.redirect(portal({ lang: state.language, error: 'email_in_use' }));
      await issue(reply, dealerId);
      return reply.redirect(portal({ lang: state.language }));
    });
    routes.get('/me', async req => {
      const s = actor(req);
      return { dealer: accountOut(s.dealer), csrfToken: s.csrf, payments: !!stripe, paymentMode: stripe?.mode ?? null };
    });
    routes.delete('/session', async (req, reply) => {
      await db.query('DELETE FROM dealer_sessions WHERE token_hash=$1', [hash(actor(req).token)]);
      reply.header('Set-Cookie', cookieOf(secure, '', 0));
      return { signedOut: true };
    });
    /* Company details can be completed or corrected while waiting for review; once approved, changes go through OneLaser. */
    routes.patch('/profile', async req => {
      const s = actor(req), v = profileInput.parse(req.body), d = s.dealer;
      if (d.status !== 'pending') deny(409, 'DEALER_PROFILE_LOCKED', 'Contact OneLaser to change the details of a reviewed account');
      const wasComplete = profileComplete(d);
      const row = (await db.query(`UPDATE dealer_accounts SET company=$2,contact_name=$3,phone=$4,website=$5,resale_cert=$6,address=$7,version=version+1 WHERE id=$1 RETURNING *`,
        [d.id, v.company, v.contactName, v.phone, v.website || '', v.resaleCert || '', JSON.stringify(v.address)])).rows[0];
      if (!wasComplete) await sendMail(o.mailer, o.notifyEmail, `New dealer application: ${v.company}`, [`${v.company} (${v.contactName}, ${d.email}) applied for a dealer account.`, 'Review it on the Dealer orders page in CraftOS.']);
      return { dealer: accountOut(row) };
    });

    /* ---------- catalog and orders (approved dealers only) ---------- */
    routes.get('/products', async req => {
      approved(req);
      const rows = (await db.query(`SELECT c.sku,c.name_en,c.name_zh,c.type,c.msrp,c.status,p.price,
          COALESCE((SELECT sum(s.qty) FROM wms_stock s WHERE s.org_id=c.org_id AND lower(s.sku)=lower(c.sku) AND s.location='us'),0) AS us_qty
        FROM product_catalog c JOIN product_channel_prices p ON p.org_id=c.org_id AND p.sku=c.sku AND p.channel='dealer'
        WHERE c.org_id=$1 AND p.listed AND p.price>0 AND ${SELLABLE} ORDER BY c.type,c.sku`, [orgId])).rows;
      return {
        items: rows.map((r: any) => ({
          sku: r.sku, name: r.name_en || r.name_zh || r.sku, type: r.type, msrpCents: r.msrp == null ? null : cents(r.msrp),
          priceCents: cents(r.price), availability: availability(Number(r.us_qty)), clearance: r.status === 'clearance',
        })),
      };
    });
    routes.get('/orders', async req => {
      const s = actor(req);
      const rows = (await db.query('SELECT * FROM dealer_orders WHERE dealer_id=$1 ORDER BY created_at DESC LIMIT 200', [s.dealer.id])).rows;
      const lines = await orderLines(db, rows.map((r: any) => r.id));
      return { items: rows.map((r: any) => orderOut(r, lines.get(r.id))) };
    });
    routes.get<{ Params: { id: string } }>('/orders/:id', async req => {
      const s = actor(req);
      const row = (await db.query('SELECT * FROM dealer_orders WHERE id=$1 AND dealer_id=$2', [uuid.parse(req.params.id), s.dealer.id])).rows[0];
      if (!row) deny(404, 'NOT_FOUND', 'Order not found');
      const events = (await db.query('SELECT type,actor_kind,details,created_at FROM dealer_order_events WHERE order_id=$1 ORDER BY created_at,id', [row.id])).rows;
      // Staff names and internal notes stay internal: the dealer sees what happened and when.
      return { ...orderOut(row, (await orderLines(db, [row.id])).get(row.id)), events: events.map((e: any) => ({ type: e.type, by: e.actor_kind, at: e.created_at })) };
    });
    routes.post('/orders', async (req, reply) => {
      const s = approved(req), v = orderInput.parse(req.body), d = s.dealer;
      const shipTo = v.shipTo || d.address;
      if (!shipTo?.line1) deny(400, 'DEALER_SHIP_TO_REQUIRED', 'Enter a shipping address');
      const qty = new Map<string, number>();
      for (const l of v.lines) qty.set(l.sku.toLowerCase(), (qty.get(l.sku.toLowerCase()) || 0) + l.qty);
      return db.transaction(async tx => {
        const existing = (await tx.query('SELECT * FROM dealer_orders WHERE dealer_id=$1 AND request_key=$2', [d.id, v.requestKey])).rows[0];
        if (existing) return reply.code(200).send(orderOut(existing, (await orderLines(tx, [existing.id])).get(existing.id)));
        // Prices come from the server at the moment of ordering, never from the request.
        const priced = (await tx.query(`SELECT c.sku,c.name_en,c.name_zh,p.price FROM product_catalog c
          JOIN product_channel_prices p ON p.org_id=c.org_id AND p.sku=c.sku AND p.channel='dealer'
          WHERE c.org_id=$1 AND lower(c.sku)=ANY($2::text[]) AND p.listed AND p.price>0 AND ${SELLABLE}`, [orgId, [...qty.keys()]])).rows;
        const found = new Map(priced.map((p: any) => [p.sku.toLowerCase(), p]));
        const missing = [...qty.keys()].filter(k => !found.has(k));
        if (missing.length) deny(400, 'DEALER_SKU_UNAVAILABLE', `These items are not available to order: ${missing.join(', ')}`);
        const lines = [...qty.entries()].map(([k, n]) => { const p: any = found.get(k); return { sku: p.sku, name: p.name_en || p.name_zh || p.sku, qty: n, unit: cents(p.price) }; });
        const total = lines.reduce((sum, l) => sum + l.unit * l.qty, 0);
        const id = randomUUID(), number = 'D-' + (await tx.query("SELECT nextval('dealer_order_number') AS n")).rows[0].n;
        const row = (await tx.query(`INSERT INTO dealer_orders(id,org_id,dealer_id,number,status,total_cents,po_number,note,ship_to,request_key)
          VALUES($1,$2,$3,$4,'pending_payment',$5,$6,$7,$8,$9) RETURNING *`, [id, orgId, d.id, number, total, v.poNumber || '', v.note || '', JSON.stringify(shipTo), v.requestKey])).rows[0];
        for (const l of lines) await tx.query('INSERT INTO dealer_order_lines(order_id,sku,name,qty,unit_cents) VALUES($1,$2,$3,$4,$5)', [id, l.sku, l.name, l.qty, l.unit]);
        await orderEvent(tx, id, 'created', 'dealer', d.id, { totalCents: total, lines: lines.length });
        return reply.code(201).send(orderOut(row, (await orderLines(tx, [id])).get(id)));
      });
    });
    routes.post<{ Params: { id: string } }>('/orders/:id/checkout', async req => {
      const s = approved(req), d = s.dealer;
      if (!stripe) deny(503, 'DEALER_PAYMENTS_UNAVAILABLE', 'Online payment is not available yet');
      return db.transaction(async tx => {
        // Row lock: one hosted payment page per order, so a dealer cannot pay twice from two tabs.
        const order = (await tx.query('SELECT * FROM dealer_orders WHERE id=$1 AND dealer_id=$2 FOR UPDATE', [uuid.parse(req.params.id), d.id])).rows[0];
        if (!order) deny(404, 'NOT_FOUND', 'Order not found');
        if (!['pending_payment', 'payment_failed'].includes(order.status)) deny(409, 'DEALER_ORDER_NOT_PAYABLE', 'This order is not awaiting payment');
        if (order.stripe_checkout_session_id) {
          const existing = await viaStripe(() => stripe.request('GET', '/v1/checkout/sessions/' + encodeURIComponent(order.stripe_checkout_session_id)));
          if (existing.status === 'open' && typeof existing.url === 'string') return { url: existing.url };
          if (existing.status === 'complete' && order.status === 'pending_payment') deny(409, 'DEALER_PAYMENT_IN_PROGRESS', 'Payment for this order is being confirmed; reload in a moment');
        }
        let customer = (await tx.query('SELECT stripe_customer_id FROM dealer_accounts WHERE id=$1 FOR UPDATE', [d.id])).rows[0]?.stripe_customer_id as string | null;
        if (!customer) {
          const c = await viaStripe(() => stripe.request('POST', '/v1/customers', { email: d.email, name: d.company || d.contact_name || d.email, 'metadata[dealer_id]': d.id }, 'dealer-customer-' + d.id));
          if (typeof c.id !== 'string') deny(502, 'DEALER_PAYMENT_PROVIDER_ERROR', 'The payment provider could not complete the request; try again');
          customer = c.id as string;
          await tx.query('UPDATE dealer_accounts SET stripe_customer_id=$2 WHERE id=$1', [d.id, customer]);
        }
        const lines = (await orderLines(tx, [order.id])).get(order.id) || [];
        const params: Record<string, string> = {
          mode: 'payment', customer, client_reference_id: order.id, locale: 'en', currency: 'usd',
          success_url: portal({ order: order.id, checkout: 'success' }), cancel_url: portal({ order: order.id, checkout: 'cancelled' }),
          'payment_method_types[0]': 'us_bank_account',
          // Financial Connections verifies the account instantly; Stripe falls back to microdeposits when a bank is not supported.
          'payment_method_options[us_bank_account][financial_connections][permissions][0]': 'payment_method',
          'payment_method_options[us_bank_account][verification_method]': 'automatic',
          // Keep the authorised bank account on the dealer's Stripe customer for the next order.
          'payment_intent_data[setup_future_usage]': 'off_session',
          'payment_intent_data[description]': `OneLaser dealer order ${order.number}`,
          'payment_intent_data[metadata][dealer_order_id]': order.id, 'metadata[dealer_order_id]': order.id, 'metadata[dealer_order_number]': order.number,
        };
        lines.forEach((l, i) => {
          // Server-owned price snapshot from the order, never a client amount.
          params[`line_items[${i}][quantity]`] = String(l.qty);
          params[`line_items[${i}][price_data][currency]`] = 'usd';
          params[`line_items[${i}][price_data][unit_amount]`] = String(l.unitCents);
          params[`line_items[${i}][price_data][product_data][name]`] = `${l.sku} · ${l.name}`.slice(0, 250);
        });
        const session = await viaStripe(() => stripe.request('POST', '/v1/checkout/sessions', params, 'dealer-checkout-' + order.id + '-' + (order.stripe_checkout_session_id || 'first')));
        if (typeof session.id !== 'string' || typeof session.url !== 'string') deny(502, 'DEALER_PAYMENT_PROVIDER_ERROR', 'The payment provider could not complete the request; try again');
        await tx.query('UPDATE dealer_orders SET stripe_checkout_session_id=$2,updated_at=now() WHERE id=$1', [order.id, session.id]);
        await orderEvent(tx, order.id, 'checkout_started', 'dealer', d.id, { session: session.id, mode: stripe.mode });
        return { url: session.url };
      });
    });
    routes.post<{ Params: { id: string } }>('/orders/:id/cancel', async req => {
      const s = actor(req);
      return db.transaction(async tx => {
        const order = (await tx.query('SELECT * FROM dealer_orders WHERE id=$1 AND dealer_id=$2 FOR UPDATE', [uuid.parse(req.params.id), s.dealer.id])).rows[0];
        if (!order) deny(404, 'NOT_FOUND', 'Order not found');
        await closeUnpaid(tx, order);
        const row = await setStatus(tx, order, 'cancelled', 'dealer', s.dealer.id);
        return orderOut(row, (await orderLines(tx, [row.id])).get(row.id));
      });
    });
  }, { prefix: '/dealer' });

  /** An unpaid order may be cancelled; its hosted payment page is closed first so it cannot be paid afterwards. */
  async function closeUnpaid(tx: Queryable, order: any) {
    if (!['pending_payment', 'payment_failed'].includes(order.status)) deny(409, 'DEALER_ORDER_NOT_CANCELLABLE', 'Only unpaid orders can be cancelled; contact OneLaser about a paid order', '只有未付款的订单可以取消；已付款的订单请在 Stripe 退款');
    if (stripe && order.stripe_checkout_session_id) {
      const session = await viaStripe(() => stripe.request('GET', '/v1/checkout/sessions/' + encodeURIComponent(order.stripe_checkout_session_id)));
      if (session.status === 'complete' && order.status === 'pending_payment') deny(409, 'DEALER_PAYMENT_IN_PROGRESS', 'Payment for this order is being confirmed; reload in a moment', '这笔订单的付款正在确认中，稍后刷新再试');
      if (session.status === 'open') await viaStripe(() => stripe.request('POST', '/v1/checkout/sessions/' + encodeURIComponent(order.stripe_checkout_session_id) + '/expire'));
    }
  }

  /* ---------- Stripe webhook ---------- */
  app.register(async hooks => {
    // Raw bytes are required for signature verification; this parser is scoped to this plugin only.
    hooks.removeContentTypeParser('application/json');
    hooks.addContentTypeParser('application/json', { parseAs: 'buffer' }, (_req, body, done) => done(null, body));
    hooks.post('/dealer/stripe/webhook', async (req, reply) => {
      reply.header('Cache-Control', 'no-store');
      if (!stripe || !orgId) return reply.code(503).send({ error: { code: 'DEALER_PAYMENTS_UNAVAILABLE' } });
      let event: any;
      try { event = verifyStripeEvent(req.body as Buffer, req.headers['stripe-signature'] as string | undefined, stripe.webhookSecret); }
      catch { return reply.code(400).send({ error: { code: 'DEALER_WEBHOOK_INVALID' } }); }
      if (event.livemode !== (stripe.mode === 'live')) return reply.code(400).send({ error: { code: 'DEALER_WEBHOOK_MODE_MISMATCH' } });
      const mail = await db.transaction(tx => handleStripeEvent(tx, event));
      if (mail) await sendMail(o.mailer, mail.to, mail.subject, mail.lines);
      if (mail?.staff) await sendMail(o.mailer, o.notifyEmail, mail.staff.subject, mail.staff.lines);
      return { received: true };
    });
  });

  type Mail = { to: string; subject: string; lines: string[]; staff?: { subject: string; lines: string[] } };
  /* Every event is processed once, in the same transaction that records it, so a failure lets Stripe retry. */
  async function handleStripeEvent(tx: Queryable, event: any): Promise<Mail | null> {
    const fresh = (await tx.query('INSERT INTO dealer_stripe_events(event_id,event_type) VALUES($1,$2) ON CONFLICT DO NOTHING RETURNING event_id', [event.id, event.type])).rows.length > 0;
    if (!fresh) return null;
    const obj = event.data.object;
    const withDealer = async (order: any) => ({ order, dealer: (await tx.query('SELECT * FROM dealer_accounts WHERE id=$1', [order.dealer_id])).rows[0] });
    if (event.type.startsWith('checkout.session.')) {
      const orderId = obj.metadata?.dealer_order_id;
      if (obj.mode !== 'payment' || typeof orderId !== 'string' || !uuid.safeParse(orderId).success) return null;
      const order = (await tx.query('SELECT * FROM dealer_orders WHERE id=$1 AND org_id=$2 FOR UPDATE', [orderId, orgId])).rows[0];
      if (!order) return null;
      if (event.type === 'checkout.session.expired') {
        await tx.query('UPDATE dealer_orders SET stripe_checkout_session_id=NULL WHERE id=$1 AND stripe_checkout_session_id=$2', [order.id, obj.id]);
        return null;
      }
      // The amount must be exactly the order's snapshot; anything else waits for a person.
      if (Number(obj.amount_total) !== Number(order.total_cents) || String(obj.currency).toLowerCase() !== order.currency) {
        await orderEvent(tx, order.id, 'payment_rejected', 'stripe', event.id, { reason: 'amount_mismatch', amountTotal: obj.amount_total, currency: obj.currency });
        return null;
      }
      const intent = typeof obj.payment_intent === 'string' ? obj.payment_intent : null;
      const { dealer } = await withDealer(order);
      const paid = async () => {
        if (!['pending_payment', 'processing', 'payment_failed'].includes(order.status)) return null;
        await setStatus(tx, order, 'paid', 'stripe', event.id, { session: obj.id }, { paid_at: new Date().toISOString(), stripe_payment_intent_id: intent, stripe_checkout_session_id: obj.id });
        return {
          to: dealer.email, subject: `Payment received for order ${order.number}`,
          lines: [`Hi ${dealer.contact_name || dealer.company},`, `Your ACH payment of ${money(order.total_cents)} for OneLaser order ${order.number} has cleared. We will ship it shortly and email you the tracking number.`],
          staff: { subject: `Dealer order ${order.number} paid`, lines: [`${dealer.company} paid ${money(order.total_cents)} for ${order.number}. It is ready to ship.`] },
        };
      };
      if (event.type === 'checkout.session.completed') {
        if (obj.payment_status === 'paid') return paid();
        if (!['pending_payment', 'payment_failed'].includes(order.status)) return null;
        await setStatus(tx, order, 'processing', 'stripe', event.id, { session: obj.id }, { stripe_payment_intent_id: intent, stripe_checkout_session_id: obj.id });
        return {
          to: dealer.email, subject: `Order ${order.number}: ACH payment started`,
          lines: [`Hi ${dealer.contact_name || dealer.company},`, `We received your ACH authorization of ${money(order.total_cents)} for order ${order.number}. Bank transfers usually take about 4 business days to clear; we will let you know when it does.`],
          staff: dealer.ship_before_clear ? { subject: `Dealer order ${order.number} can ship`, lines: [`${dealer.company} started an ACH payment for ${order.number}. This dealer may ship before the payment clears.`] } : undefined,
        };
      }
      if (event.type === 'checkout.session.async_payment_succeeded') return paid();
      if (event.type === 'checkout.session.async_payment_failed') {
        if (order.status !== 'processing') return null;
        await setStatus(tx, order, 'payment_failed', 'stripe', event.id, { session: obj.id });
        return {
          to: dealer.email, subject: `Order ${order.number}: ACH payment failed`,
          lines: [`Hi ${dealer.contact_name || dealer.company},`, `Your bank did not complete the ACH payment for order ${order.number}. Sign in to the dealer portal to pay again or contact us.`],
          staff: { subject: `Dealer order ${order.number}: ACH failed`, lines: [`The ACH payment from ${dealer.company} for ${order.number} failed${order.status === 'processing' && dealer.ship_before_clear ? ' — check whether it already shipped' : ''}.`] },
        };
      }
      return null;
    }
    if (event.type === 'charge.dispute.created' || event.type === 'charge.refunded') {
      const intent = typeof obj.payment_intent === 'string' ? obj.payment_intent : null;
      if (!intent) return null;
      const order = (await tx.query('SELECT * FROM dealer_orders WHERE stripe_payment_intent_id=$1 AND org_id=$2 FOR UPDATE', [intent, orgId])).rows[0];
      if (!order) return null;
      if (event.type === 'charge.refunded') {
        if (obj.refunded !== true) { await orderEvent(tx, order.id, 'partial_refund', 'stripe', event.id, { amountRefunded: obj.amount_refunded }); return null; }
        await setStatus(tx, order, 'refunded', 'stripe', event.id, { amountRefunded: obj.amount_refunded });
        return null;
      }
      // An ACH return or dispute after the money arrived: a person decides what happens to the goods.
      const shipped = order.status === 'shipped';
      await setStatus(tx, order, 'disputed', 'stripe', event.id, { dispute: obj.id, reason: obj.reason, wasShipped: shipped });
      const { dealer } = await withDealer(order);
      return { to: o.notifyEmail || '', subject: `Dealer order ${order.number} disputed`, lines: [`The ACH payment from ${dealer.company} for ${order.number} was disputed or returned (${obj.reason || 'no reason given'}). ${shipped ? 'The order has already shipped.' : 'Do not ship it.'}`] };
    }
    return null;
  }
}
