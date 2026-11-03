/* Local end-to-end run of the dealer portal: npm run dealer:local
 *
 * One process on http://localhost:4173 serves the frontend (../onelaser-workos-dealer/dist or FRONTEND_DIST)
 * and the API under /api, on an in-memory database with demo products, dealer prices and US stock.
 *
 * Payments: with DEALER_STRIPE_SECRET_KEY=sk_test_… and DEALER_STRIPE_WEBHOOK_SECRET set, real Stripe test mode
 * is used (forward webhooks with: stripe listen --forward-to localhost:4173/api/dealer/stripe/webhook).
 * Without them, a local stand-in for Stripe's hosted page sends correctly signed webhooks instead.
 * Google: with DEALER_GOOGLE_CLIENT_ID/SECRET the real Google flow is used; otherwise a local stand-in.
 * Live Stripe keys are refused here. None of the stand-ins exist outside this development script. */
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { buildApp } from '../src/app.js';
import { createDatabase, schema, seedDemo } from '../src/db.js';
import { hashPassword } from '../src/members.js';
import { dealerOptionsFromEnv } from '../src/dealer.js';
import { signStripePayload, type CaldockStripe } from '../src/caldock-stripe.js';
import type { CaldockGateway } from '../src/caldock-oidc.js';

const PORT = Number(process.env.PORT || 4173), ORIGIN = `http://localhost:${PORT}`;
const DIST = resolve(process.env.FRONTEND_DIST || resolve(import.meta.dirname, '..', '..', 'onelaser-workos-dealer', 'dist'));
if (/sk_live_/.test(process.env.DEALER_STRIPE_SECRET_KEY || '')) throw new Error('dealer-local runs with Stripe test keys only');

const db = await createDatabase();
await db.exec(schema);
await seedDemo(db);
// Staff sign-in: admin@onelaser.test (company admin) and warehouse@onelaser.test (dealer manager), password "onelaser-local".
const pw = await hashPassword('onelaser-local');
await db.query("UPDATE users SET login_email='admin@onelaser.test',email='admin@onelaser.test',name_en='Lin Nan',name_zh='林楠',password_hash=$1 WHERE id='m1'", [pw]);
await db.query(`UPDATE users SET login_email='warehouse@onelaser.test',email='warehouse@onelaser.test',name_en='Zhou Ming',name_zh='周明',password_hash=$1,grants='["dealers","dealers_manage","warehouse","warehouse_manage","products"]' WHERE id='m4'`, [pw]);
const products: [string, string, string, string, number, number, number][] = [
  ['OL-F2-60W', 'OneLaser F2 60W CO2 Laser', 'Machine', 'live', 4999, 3499, 14],
  ['OL-F2-100W', 'OneLaser F2 100W CO2 Laser', 'Machine', 'live', 6999, 4899, 4],
  ['OL-RA-1', 'Rotary Attachment', 'Accessory', 'live', 399, 259, 40],
  ['OL-AF-200', 'Air Filter 200', 'Accessory', 'clearance', 899, 499, 0],
  ['OL-LENS-2', 'Focus Lens 2"', 'Part', 'live', 49, 29.5, 120],
];
for (const [sku, name, type, status, msrp, dealer, qty] of products) {
  await db.query('INSERT INTO product_catalog(org_id,sku,name_en,type,status,msrp) VALUES($1,$2,$3,$4,$5,$6)', ['demo', sku, name, type, status, msrp]);
  await db.query("INSERT INTO product_channel_prices(org_id,sku,channel,price,listed) VALUES('demo',$1,'dealer',$2,true)", [sku, dealer]);
  await db.query('INSERT INTO wms_items(org_id,sku,name,type) VALUES($1,$2,$3,$4)', ['demo', sku, name, type]);
  if (qty) await db.query("INSERT INTO wms_stock(org_id,sku,location,qty) VALUES('demo',$1,'us',$2)", [sku, qty]);
}

/* ---------- stand-ins (development only) ---------- */
const env = dealerOptionsFromEnv(process.env);
const fakeSecret = 'whsec_dealerlocalsecret0000';
const fakeSessions = new Map<string, any>();
const fakeStripe: CaldockStripe = {
  mode: 'test', webhookSecret: fakeSecret,
  async request(method, path, params = {}) {
    if (path === '/v1/customers') return { id: 'cus_local_' + randomUUID().slice(0, 8) };
    if (path === '/v1/checkout/sessions' && method === 'POST') {
      const id = 'cs_test_local_' + randomUUID().replaceAll('-', '');
      let amount = 0;
      for (let i = 0; params[`line_items[${i}][quantity]`]; i++) amount += Number(params[`line_items[${i}][quantity]`]) * Number(params[`line_items[${i}][price_data][unit_amount]`]);
      fakeSessions.set(id, { id, status: 'open', url: `${ORIGIN}/__stripe/checkout?session=${id}`, amount_total: amount, params });
      return fakeSessions.get(id);
    }
    const m = /^\/v1\/checkout\/sessions\/([^/]+)(\/expire)?$/.exec(path);
    if (m) { const s = fakeSessions.get(decodeURIComponent(m[1])); if (!s) throw new Error('no such session'); if (m[2]) s.status = 'expired'; return s; }
    throw new Error('Local Stripe stand-in does not handle ' + path);
  },
};
const fakeGoogle: CaldockGateway = {
  authorizationUrl: ({ state }) => `${ORIGIN}/__google?state=${state}`,
  async authenticate({ code }) { const email = decodeURIComponent(code); return { provider: 'google', subject: 'local-' + email, email, name: email.split('@')[0] }; },
};
const stripe = env.stripe || fakeStripe, google = env.google || fakeGoogle;

const app = await buildApp({
  db, environment: 'development', mailer: async m => { console.log(`\n[email to ${m.to}] ${m.subject}\n${m.text}\n`); },
  integrations: { appPublicUrl: ORIGIN, executiveUserIds: ['m1'] }, completionModel: null, translationModel: null, nudgeIntervalMs: 0,
  dealer: { orgId: 'demo', publicUrl: ORIGIN, stripe, google, notifyEmail: 'sales@onelaser.test' },
});
const sendEvent = async (type: string, session: any, extra: Record<string, unknown> = {}) => {
  const body = JSON.stringify({ id: 'evt_local_' + randomUUID(), type, livemode: false, data: { object: { id: session.id, mode: 'payment', metadata: { dealer_order_id: session.params['metadata[dealer_order_id]'] }, amount_total: session.amount_total, currency: 'usd', payment_intent: 'pi_local_' + session.id.slice(-12), payment_status: 'unpaid', ...extra } } });
  const res = await app.inject({ method: 'POST', url: '/dealer/stripe/webhook', payload: body, headers: { 'content-type': 'application/json', 'stripe-signature': signStripePayload(body, fakeSecret) } });
  if (res.statusCode !== 200) throw new Error('webhook ' + res.statusCode + ' ' + res.body);
};
const page = (title: string, body: string) => `<!doctype html><meta charset="utf-8"><title>${title}</title><style>body{font:15px system-ui;max-width:520px;margin:48px auto;padding:0 16px}.box{border:1px solid #ccc;border-radius:12px;padding:20px}button{font:inherit;padding:8px 16px;margin:4px 4px 0 0;border-radius:8px;border:1px solid #888;cursor:pointer}.tag{background:#ffe9a8;padding:2px 8px;border-radius:6px;font-size:12px}</style>${body}`;
const esc = (s: string) => s.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));

async function standIn(url: URL, method: string, res: any) {
  if (url.pathname === '/__google' && method === 'GET') {
    const state = url.searchParams.get('state') || '';
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    return res.end(page('Google (local stand-in)', `<p class="tag">LOCAL STAND-IN — not Google</p><div class="box"><h2>Choose an account</h2><form method="get" action="/api/dealer/auth/google/callback"><input type="hidden" name="state" value="${esc(state)}"><p><input name="code" type="email" required placeholder="dealer@gmail.com" style="width:100%;padding:8px"></p><button>Continue</button></form></div>`));
  }
  if (url.pathname === '/__stripe/checkout') {
    const s = fakeSessions.get(url.searchParams.get('session') || '');
    if (!s) { res.writeHead(404); return res.end('No such checkout session'); }
    const step = url.searchParams.get('step');
    if (method === 'POST' && step === 'authorize') { await sendEvent('checkout.session.completed', s); s.status = 'complete'; res.writeHead(303, { location: `${url.pathname}?session=${s.id}&step=authorized` }); return res.end(); }
    if (method === 'POST' && step === 'clear') { await sendEvent('checkout.session.async_payment_succeeded', s); res.writeHead(303, { location: s.params.success_url }); return res.end(); }
    if (method === 'POST' && step === 'fail') { await sendEvent('checkout.session.async_payment_failed', s); res.writeHead(303, { location: s.params.success_url }); return res.end(); }
    if (method === 'POST' && step === 'later') { res.writeHead(303, { location: s.params.success_url }); return res.end(); }
    if (method === 'POST' && step === 'cancel') { res.writeHead(303, { location: s.params.cancel_url }); return res.end(); }
    const amount = (s.amount_total / 100).toLocaleString('en-US', { style: 'currency', currency: 'USD' });
    const form = (st: string, label: string) => `<form method="post" action="?session=${s.id}&step=${st}" style="display:inline"><button>${label}</button></form>`;
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    return res.end(page('Stripe Checkout (local stand-in)', `<p class="tag">LOCAL STAND-IN for Stripe Checkout · test mode</p><div class="box"><h2>Pay ${amount}</h2><p>${esc(s.params['payment_intent_data[description]'] || '')}</p>
      ${step === 'authorized' ? `<p>✅ Bank account connected (Test Institution ••6789). ACH debit authorized; the order is now <b>processing</b>.</p><p>In real life the money clears in about 4 business days. Simulate the outcome:</p>${form('clear', 'ACH clears (payment succeeded)')}${form('fail', 'ACH fails (insufficient funds)')}${form('later', 'Back to portal (decide later)')}`
        : s.status !== 'open' ? `<p>This payment page is ${esc(s.status)}.</p>` : `<p>Payment method: <b>US bank account (ACH)</b></p><p>Financial Connections would verify the bank here.</p>${form('authorize', 'Connect test bank and authorize ACH debit')}${form('cancel', 'Back (cancel)')}`}</div>`));
  }
  return false;
}

const TYPES: Record<string, string> = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.otf': 'font/otf', '.woff2': 'font/woff2', '.png': 'image/png', '.json': 'application/json' };
createServer(async (req, res) => {
  try {
    const url = new URL(req.url || '/', ORIGIN), method = req.method || 'GET';
    if (url.pathname.startsWith('/__')) { if ((await standIn(url, method, res)) !== false) return; }
    if (url.pathname.startsWith('/api/')) {
      const chunks: Buffer[] = []; for await (const c of req) chunks.push(c as Buffer);
      const headers = { ...req.headers }; delete headers['content-length']; delete headers.host;
      const r = await app.inject({ method: method as any, url: url.pathname.slice(4) + url.search, payload: chunks.length ? Buffer.concat(chunks) : undefined, headers: headers as any });
      const out: Record<string, any> = {}; for (const [k, v] of Object.entries(r.headers)) if (k !== 'content-length' && k !== 'transfer-encoding' && v !== undefined) out[k] = v;
      res.writeHead(r.statusCode, out); return res.end(r.rawPayload);
    }
    if (url.pathname === '/runtime-config.js') { res.writeHead(200, { 'content-type': 'text/javascript', 'cache-control': 'no-store' }); return res.end("'use strict';window.WORKOS_CONFIG=Object.freeze({mode:'live',apiBase:'/api'});"); }
    let file = normalize(join(DIST, decodeURIComponent(url.pathname)));
    if (!file.startsWith(DIST)) { res.writeHead(403); return res.end(); }
    if ((await stat(file).catch(() => null))?.isDirectory()) file = join(file, 'index.html');
    if (url.pathname === '/dealer') { res.writeHead(308, { location: '/dealer/' }); return res.end(); }
    const body = await readFile(file).catch(() => null);
    if (!body) { res.writeHead(404); return res.end('Not found'); }
    res.writeHead(200, { 'content-type': TYPES[extname(file)] || 'application/octet-stream', 'cache-control': 'no-store' }); res.end(body);
  } catch (error) { console.error(error); res.writeHead(500); res.end('Local server error'); }
}).listen(PORT, '127.0.0.1', () => {
  console.log(`Dealer portal:   ${ORIGIN}/dealer/`);
  console.log(`CraftOS (staff): ${ORIGIN}/  → admin@onelaser.test / onelaser-local  → 产品与库存 → 经销商订单`);
  console.log(`Payments: ${env.stripe ? 'Stripe test mode (real API)' : 'local Stripe stand-in'} · Google: ${env.google ? 'real Google' : 'local stand-in'}`);
});
