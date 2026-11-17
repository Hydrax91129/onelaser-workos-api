import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createDatabase, schema, seedDemo } from '../src/db.js';
import { buildApp } from '../src/app.js';
import { issueSession } from '../src/auth.js';
import { stageOf, kindOf, DEFAULT_SETTINGS } from '../src/fulfillment.js';

// 订单履约 (owner, 2026-11-16). Fictional orders, customers and tracking numbers only.
const NOW = Date.parse('2026-11-16T18:00:00Z'), H = 3600_000, D = 86400_000;
const ago = (ms: number) => new Date(NOW - ms).toISOString();
const S = { ...DEFAULT_SETTINGS, payOwner: 'pay', shipOwner: 'ship', callOwner: 'call', trainOwner: 'train' };
const base = { kind: 'retail', total_cents: 100000, paid_cents: 100000, placed_at: ago(3 * D), paid_at: ago(30 * H), shipment: 'ltl' };

test('stages: paid in full → ship in 48 h (LTL) / 24 h (parcel) → transit → appointment → first piece in 5 days → review', () => {
  assert.deepEqual([stageOf({ ...base, paid_cents: 50000 }, S, NOW).stage, stageOf({ ...base, paid_cents: 50000 }, S, NOW).owner], ['pay', 'pay']);
  assert.equal(stageOf({ ...base, paid_cents: 50000, placed_at: ago(4 * D) }, S, NOW).late, true, 'unpaid after 3 days is late');
  let s = stageOf(base, S, NOW);
  assert.deepEqual([s.stage, s.owner, s.late], ['ship', 'ship', false], 'paid 30 h ago, LTL has 48 h');
  assert.equal(stageOf({ ...base, shipment: 'parcel' }, S, NOW).late, true, 'parcel has 24 h');
  assert.equal(stageOf({ ...base, paid_at: ago(49 * H) }, S, NOW).late, true);
  const shipped = { ...base, shipped_at: ago(2 * D), track_at: ago(2 * D) };
  assert.deepEqual([stageOf(shipped, S, NOW).stage, stageOf(shipped, S, NOW).late], ['transit', false]);
  assert.equal(stageOf({ ...shipped, shipped_at: ago(4 * D), track_at: ago(4 * D) }, S, NOW).late, true, 'no update for 3 days');
  assert.equal(stageOf({ ...shipped, eta: '2026-11-13' }, S, NOW).late, true, 'two days past the ETA');
  assert.equal(stageOf({ ...shipped, eta: new Date('2026-11-13T00:00:00Z') }, S, NOW).late, true, 'the ETA as a Date from the database');
  s = stageOf({ ...shipped, terminal_at: ago(4 * D) }, S, NOW);
  assert.deepEqual([s.stage, s.owner, s.late], ['delivery', 'call', true], 'at the terminal 4 days without an appointment');
  assert.equal(stageOf({ ...shipped, terminal_at: ago(D), appointment_on: '2026-11-18' }, S, NOW).stage, 'transit', 'appointment booked: waiting for delivery');
  const delivered = { ...shipped, delivered_at: ago(6 * D) };
  s = stageOf(delivered, S, NOW);
  assert.deepEqual([s.stage, s.owner, s.late], ['running', 'train', true], 'no first piece 6 days after delivery');
  assert.equal(stageOf({ ...delivered, first_piece_at: ago(D) }, S, NOW).stage, 'review');
  assert.equal(stageOf({ ...delivered, first_piece_at: ago(D), review_invited_at: ago(1) }, S, NOW).stage, 'done');
  assert.equal(stageOf({ ...delivered, kind: 'dealer' }, S, NOW).stage, 'done', 'dealer orders end at delivery');
  assert.equal(stageOf({ ...base, kind: 'kol', total_cents: 0, paid_cents: 0 }, S, NOW).stage, 'approve', 'KOL orders are approved, not paid');
  assert.equal(stageOf({ ...base, kind: 'kol', total_cents: 0, paid_cents: 0, release: { at: ago(H) } }, S, NOW).stage, 'ship');
  assert.equal(stageOf({ ...delivered, kind: 'kol', first_piece_at: ago(D) }, S, NOW).stage, 'content');
  assert.equal(stageOf({ ...base, paid_cents: 0, release: { at: ago(50 * H) } }, S, NOW).late, true, 'a released order is timed from the release');
  assert.equal(stageOf({ ...base, cancelled_at: ago(1) }, S, NOW).stage, 'cancelled');
});

test('order kind from Shopify tags; an untagged $0 order is KOL and flagged', () => {
  assert.deepEqual(kindOf(['Dealer'], 500000), { kind: 'dealer', note: '', channel: 'online' });
  assert.deepEqual(kindOf(['kol', 'offline'], 0), { kind: 'kol', note: '', channel: 'offline' });
  assert.deepEqual(kindOf([], 0), { kind: 'kol', note: 'zero_untagged', channel: 'online' });
  assert.deepEqual(kindOf(['offline'], 399900), { kind: 'retail', note: '', channel: 'offline' });
});

async function setup(shopify?: any) {
  const db = await createDatabase(); await db.exec(schema); await seedDemo(db);
  await db.query(`UPDATE users SET grants='["orders"]' WHERE id='m3'`);
  await db.query(`UPDATE users SET grants='["orders","orders_manage"]' WHERE id='m4'`);
  const app = await buildApp({ db, integrations: { executiveUserIds: ['m1'] }, completionModel: null, translationModel: null, mailer: null, nudgeIntervalMs: 0, clock: () => NOW, shopify } as any);
  const tokens: Record<string, string> = {};
  const call = async (who: string, method: 'GET' | 'POST' | 'PUT', url: string, payload?: any) => { tokens[who] ??= (await issueSession(db, who)).accessToken;
    return app.inject({ method, url, payload, headers: { authorization: 'Bearer ' + tokens[who], 'accept-language': 'zh-CN' } }); };
  return { db, app, call };
}
const order = (extra: any = {}) => ({ number: 'DEMO-1001', kind: 'retail', customer: { name: 'Sample Buyer', email: 'buyer@example.test', city: 'Austin', state: 'tx', zip: '78701' },
  lines: [{ sku: 'DEMO-H9', name: 'Demo Hydra 9', qty: 1 }], total: 5999, paid: 2000, ...extra });

test('orders: access levels, nothing ships before full payment, main-admin release, steps to a review, the board', async () => {
  const { app, call } = await setup();
  try {
    assert.equal((await call('m2', 'GET', '/orders')).statusCode, 403, 'no order access');
    assert.equal((await call('m3', 'POST', '/orders', order())).statusCode, 403, 'view only');
    const made = await call('m4', 'POST', '/orders', order()); assert.equal(made.statusCode, 201, made.body); const id = made.json().id;
    assert.equal((await call('m4', 'POST', '/orders', order())).json().error.code, 'ORDER_NUMBER_EXISTS');
    const step = (who: string, body: any) => call(who, 'POST', `/orders/${id}/step`, body);
    const blocked = await step('m4', { step: 'ship', shipFrom: 'us', carrier: 'Demo Freight', tracking: 'PRO-000123' });
    assert.equal(blocked.statusCode, 409); assert.match(blocked.json().error.message, /还没收全款/);
    let b = (await call('m3', 'GET', '/orders')).json();
    assert.deepEqual([b.items[0].stage, b.items[0].owedCents, b.summary.owedCents, b.canManage], ['pay', 399900, 399900, false]);
    assert.equal(b.items[0].customer.state, 'TX');
    assert.equal((await step('m4', { step: 'release', reason: 'Trusted repeat buyer' })).json().error.code, 'ORDER_RELEASE_ADMIN_ONLY');
    assert.equal((await step('m4', { step: 'payment', paid: 5999 })).statusCode, 200);
    assert.equal((await step('m4', { step: 'ship', shipFrom: 'us', carrier: 'Demo Freight', tracking: 'PRO-000123', eta: '2026-11-25' })).statusCode, 200);
    { const d = (await call('m3', 'GET', `/orders/${id}`)).json(); assert.equal(d.shipFrom, 'us', 'ships from a WMS warehouse');
      assert.ok(Array.isArray(d.stock) && d.stock.every((x: any) => 'us' in x && 'dg' in x && 'jn' in x), 'the detail shows WMS stock per warehouse'); }
    assert.equal((await step('m4', { step: 'delivery_needs', shipment: 'ltl', liftgate: true, residential: true, shipFrom: 'transit' })).statusCode, 400, 'in transit is not a warehouse to ship from');
    assert.deepEqual([(await call('m3', 'GET', `/orders/${id}`)).json().stage, (await call('m3', 'GET', '/orders')).statusCode], ['transit', 200], 'an ETA read back from the database works');
    assert.equal((await step('m4', { step: 'first_piece' })).json().error.code, 'ORDER_NOT_DELIVERED');
    for (const s of [{ step: 'terminal' }, { step: 'appointment', on: '2026-11-20' }, { step: 'delivered', damage: 'none' }, { step: 'first_piece' }]) assert.equal((await step('m4', s)).statusCode, 200, JSON.stringify(s));
    assert.equal((await call('m4', 'GET', `/orders/${id}`)).json().stage, 'review');
    assert.equal((await step('m4', { step: 'review_invited', platform: 'trustpilot' })).statusCode, 200);
    const d = (await call('m3', 'GET', `/orders/${id}`)).json();
    assert.equal(d.stage, 'done'); assert.equal(d.reviewPlatform, 'trustpilot'); assert.ok(d.events.length >= 8, 'every step is in the history');
    // KOL: approved by a main admin instead of paid
    const kol = (await call('m4', 'POST', '/orders', order({ number: 'DEMO-KOL-1', kind: 'kol', total: 0, paid: 0 }))).json().id;
    assert.equal((await call('m4', 'GET', `/orders/${kol}`)).json().stage, 'approve');
    assert.equal((await call('m4', 'POST', `/orders/${kol}/step`, { step: 'ship', shipFrom: 'us', carrier: 'Demo Freight', tracking: 'PRO-9' })).json().error.message, 'KOL 订单要先由主管理员批准才能发货。');
    assert.equal((await call('m1', 'POST', `/orders/${kol}/step`, { step: 'release', reason: 'KOL agreement signed' })).statusCode, 200);
    const k = (await call('m1', 'GET', `/orders/${kol}`)).json(); assert.equal(k.stage, 'ship'); assert.equal(k.release.reason, 'KOL agreement signed');
    assert.equal((await call('m4', 'POST', `/orders/${id}/step`, { step: 'content', url: 'https://example.test/v' })).json().error.code, 'ORDER_NOT_KOL');
    // settings: owners and deadlines, main admin only
    const set = { payOwner: 'm2', shipOwner: 'm4', callOwner: 'm2', trainOwner: 'm5', shipHoursLtl: 48, shipHoursParcel: 24, payDays: 3, terminalDays: 3, stallDays: 3, trainDays: 5, reviewPlatforms: ['trustpilot', 'bbb', 'google', 'facebook'] };
    assert.equal((await call('m4', 'PUT', '/orders/settings', set)).statusCode, 403);
    assert.equal((await call('m1', 'PUT', '/orders/settings', { ...set, payOwner: 'nobody' })).json().error.code, 'ORDERS_OWNER_INVALID');
    assert.equal((await call('m1', 'PUT', '/orders/settings', set)).statusCode, 200);
    b = (await call('m1', 'GET', '/orders')).json();
    assert.equal(b.items.find((i: any) => i.id === kol).owner, 'm4'); assert.equal(b.canRelease, true);
    assert.equal((await call('m1', 'GET', '/orders/shopify-check')).json().configured, false);
  } finally { await app.close(); }
});

test('Shopify sync: open orders of the last 60 days, kinds from tags, payment from Shopify, retried without customer details when they are protected', async () => {
  const queries: string[] = [];
  const nodes = [
    { id: 'gid://shopify/Order/1', name: '#1001', createdAt: ago(2 * D), cancelledAt: null, test: false, tags: [], sourceName: 'web',
      totalPriceSet: { shopMoney: { amount: '5999.00' } }, totalOutstandingSet: { shopMoney: { amount: '0.00' } }, lineItems: { nodes: [{ sku: 'DEMO-H9', name: 'Demo Hydra 9', quantity: 1 }] }, fulfillments: [] },
    { id: 'gid://shopify/Order/2', name: '#1002', createdAt: ago(D), cancelledAt: null, test: false, tags: ['dealer'], sourceName: 'shopify_draft_order',
      totalPriceSet: { shopMoney: { amount: '20000.00' } }, totalOutstandingSet: { shopMoney: { amount: '5000.00' } }, lineItems: { nodes: [] }, fulfillments: [] },
    { id: 'gid://shopify/Order/3', name: '#1003', createdAt: ago(D), cancelledAt: null, test: false, tags: [], sourceName: 'shopify_draft_order',
      totalPriceSet: { shopMoney: { amount: '0.00' } }, totalOutstandingSet: { shopMoney: { amount: '0.00' } }, lineItems: { nodes: [] },
      fulfillments: [{ createdAt: ago(H), trackingInfo: [{ company: 'Demo Freight', number: 'PRO-42' }] }] },
    { id: 'gid://shopify/Order/4', name: '#1004', createdAt: ago(D), cancelledAt: null, test: true, tags: [], totalPriceSet: { shopMoney: { amount: '1.00' } }, totalOutstandingSet: { shopMoney: { amount: '0' } }, lineItems: { nodes: [] }, fulfillments: [] }];
  const fetcher = (async (url: string, init: any) => {
    if (String(url).includes('access_token')) return new Response(JSON.stringify({ access_token: 'fake', expires_in: 3600 }), { status: 200 });
    const q = JSON.parse(init.body).query as string; queries.push(q);
    if (q.includes('customer {')) return new Response(JSON.stringify({ errors: [{ message: 'This app is not approved to access the Customer object.' }] }), { status: 200 });
    return new Response(JSON.stringify({ data: { orders: { nodes, pageInfo: { hasNextPage: false, endCursor: null } } } }), { status: 200 });
  }) as any;
  const { app, call, db } = await setup({ shopDomain: 'demo-shop.myshopify.com', clientId: 'id', clientSecret: 'secret', fetcher });
  try {
    const r = await call('m4', 'POST', '/orders/sync', {}); assert.equal(r.statusCode, 200, r.body);
    assert.deepEqual([r.json().created, r.json().seen, r.json().customerDetails], [3, 3, false], 'test orders skipped; customer details were protected');
    assert.ok(queries.some(q => q.includes('customer {')) && queries.some(q => !q.includes('customer {')));
    const b = (await call('m4', 'GET', '/orders')).json(), by = (n: string) => b.items.find((i: any) => i.number === n);
    assert.deepEqual([by('#1001').kind, by('#1001').stage], ['retail', 'ship']);
    assert.deepEqual([by('#1002').kind, by('#1002').channel, by('#1002').stage, by('#1002').owedCents], ['dealer', 'offline', 'pay', 500000]);
    assert.deepEqual([by('#1003').kind, by('#1003').kindNote, by('#1003').tracking], ['kol', 'zero_untagged', 'PRO-42']);
    assert.equal(b.summary.zeroUntagged, 1);
    // A second sync updates payment from Shopify and keeps the steps people recorded.
    await call('m4', 'POST', `/orders/${by('#1001').id}/step`, { step: 'ship', shipFrom: 'us', carrier: 'Demo LTL', tracking: 'PRO-7' });
    nodes[1].totalOutstandingSet.shopMoney.amount = '0.00';
    const r2 = await call('m4', 'POST', '/orders/sync', {}); assert.equal(r2.json().updated, 3, r2.body);
    const b2 = (await call('m4', 'GET', '/orders')).json(), by2 = (n: string) => b2.items.find((i: any) => i.number === n);
    assert.equal(by2('#1002').stage, 'ship', 'paid in Shopify → ready to ship');
    assert.deepEqual([by2('#1001').carrier, by2('#1001').tracking], ['Demo LTL', 'PRO-7']);
    assert.equal((await db.query('SELECT count(*)::int n FROM ful_orders')).rows[0].n, 3);
  } finally { await app.close(); }
});

test('orders: cancel with a reason, refunds (manual orders here, Shopify orders from Shopify), exchanges, the latest note on the board', async () => {
  const { call } = await setup();
  try {
    const id = (await call('m4', 'POST', '/orders', order({ number: 'DEMO-2001', paid: 5999 }))).json().id;
    const step = (body: any) => call('m4', 'POST', `/orders/${id}/step`, body);
    assert.equal((await step({ step: 'note', text: 'Customer asked to deliver after 3 pm' })).statusCode, 200);
    let o = (await call('m3', 'GET', '/orders')).json().items.find((x: any) => x.id === id);
    assert.equal(o.note.text, 'Customer asked to deliver after 3 pm'); assert.ok(o.note.byName, 'who wrote it');
    assert.equal((await step({ step: 'refund', amount: 9000, reason: 'Too much' })).json().error.code, 'ORDER_REFUND_TOO_MUCH');
    assert.equal((await step({ step: 'refund', amount: 500, reason: 'Missing accessory' })).statusCode, 200);
    assert.equal((await step({ step: 'exchange', reason: 'Wrong lens size', newOrder: 'DEMO-2002' })).statusCode, 200);
    o = (await call('m3', 'GET', `/orders/${id}`)).json();
    assert.deepEqual([o.refundedCents, o.refund, o.exchange.newOrder], [50000, 'partial', 'DEMO-2002']);
    assert.equal((await step({ step: 'cancel', reason: 'Customer changed their mind' })).statusCode, 200);
    assert.equal((await step({ step: 'refund', amount: 5499, reason: 'Order cancelled' })).statusCode, 200, 'a cancelled order can still be refunded');
    o = (await call('m3', 'GET', `/orders/${id}`)).json();
    assert.deepEqual([o.stage, o.cancelReason, o.refund], ['cancelled', 'Customer changed their mind', 'full']);
    assert.equal((await step({ step: 'ship', shipFrom: 'us', carrier: 'X', tracking: 'Y' })).json().error.code, 'ORDER_CANCELLED');
  } finally { /* in-memory database */ }
});
