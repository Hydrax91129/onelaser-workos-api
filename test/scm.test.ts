import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createDatabase, schema, seedDemo } from '../src/db.js';
import { buildApp } from '../src/app.js';
import { issueSession } from '../src/auth.js';
import { reorderOf, leadDaysOf, forecastOf } from '../src/scm.js';

// Fictional SKUs, orders and shipments only.
const NOW = Date.parse('2026-11-12T18:00:00Z');
const daysAgo = (n: number) => new Date(NOW - n * 86400000).toISOString();

test('reorder: DS × (lead + target + safety) against US + in transit; factory stock first, production for the rest', () => {
  assert.equal(leadDaysOf('25 天', '海运 35 天'), 60); assert.equal(leadDaysOf('', ''), null);
  const r = reorderOf({ ds: 2, us: 50, transit: 30, factory: 40, leadDays: 60, targetDays: 30, safetyDays: 14 });
  assert.deepEqual([r.need, r.gap, r.ship, r.make, r.cover, r.monthly, r.status], [208, 128, 40, 88, 40, 60, 'risk']);
  assert.equal(reorderOf({ ds: 1, us: 400, transit: 0, factory: 0, leadDays: 30, targetDays: 30, safetyDays: 14 }).status, 'overstock');
  assert.equal(reorderOf({ ds: 0, us: 3, transit: 0, factory: 0, leadDays: 30, targetDays: 30, safetyDays: 14 }).status, 'overstock', 'stock without sales');
  assert.equal(reorderOf({ ds: 1, us: 50, transit: 0, factory: 0, leadDays: 30, targetDays: 30, safetyDays: 14 }).status, 'ok');
  assert.equal(reorderOf({ ds: 2, us: 50, transit: 0, factory: 0, leadDays: 37, targetDays: 30, safetyDays: 14 }).shortDays, 12, 'runs out 12 days before a reorder arrives');
});

test('forecast daily sales: recent weighted, seasonality from last year, bursts counted in only partly, dips fully', () => {
  const steady = forecastOf({ ds30: 2, ds90: 2, ds365: 2, nextLastYear: null, history: 365 });
  assert.equal(steady.ds, 2); assert.equal(steady.signal, 'steady'); assert.equal(steady.season, 1);
  const peak = forecastOf({ ds30: 2, ds90: 2, ds365: 2, nextLastYear: 3, history: 365 });
  assert.equal(peak.season, 1.5); assert.equal(peak.ds, 0.4 * 2 + 0.3 * 2 + 0.3 * 3, 'last year the coming months sold 1.5× the yearly average');
  assert.equal(forecastOf({ ds30: 2, ds90: 2, ds365: 2, nextLastYear: 3, history: 200 }).season, 1, 'no seasonality without a year of history');
  const burst = forecastOf({ ds30: 10, ds90: 2, ds365: 2, nextLastYear: null, history: 365 });
  assert.equal(burst.signal, 'spike'); assert.equal(burst.trendPct, 400); assert.equal(burst.ds, 0.4 * 4 + 0.3 * 2 + 0.3 * 2, 'a burst counts in up to 2× the 90-day rate');
  const dip = forecastOf({ ds30: 1, ds90: 2, ds365: 2, nextLastYear: null, history: 365 });
  assert.equal(dip.signal, 'dip'); assert.equal(dip.ds, 0.4 * 1 + 0.3 * 2 + 0.3 * 2);
});

test('SCM: Shopify sales sync (365 days, per SKU and day), board with DS and suggestions, shipments move stock to in transit and into the US warehouse', async () => {
  const db = await createDatabase(); await db.exec(schema); await seedDemo(db);
  const org = (await db.query("SELECT org_id FROM users WHERE id='m1'")).rows[0].org_id;
  await db.query(`INSERT INTO product_catalog(org_id,sku,name_zh,lead,attrs) VALUES($1,'S-1','示例主机','20 天','{"firstLeg":"海运 30 天","moqUnit":"10 台"}'),($1,'S-2','示例配件','','{}')`, [org]);
  // Fake Shopify: two pages of orders; a cancelled and a test order are ignored
  const pages: any[] = [
    { nodes: [{ createdAt: daysAgo(3), cancelledAt: null, test: false, lineItems: { nodes: [{ sku: 'S-1', quantity: 2 }, { sku: 'S-2', quantity: 5 }] } },
      { createdAt: daysAgo(3), cancelledAt: daysAgo(2), test: false, lineItems: { nodes: [{ sku: 'S-1', quantity: 9 }] } }], pageInfo: { hasNextPage: true, endCursor: 'c1' } },
    { nodes: [{ createdAt: daysAgo(200), cancelledAt: null, test: false, lineItems: { nodes: [{ sku: 'S-1', quantity: 361 }, { sku: 'REF-S-1', quantity: 1 }] } },
      { createdAt: daysAgo(1), cancelledAt: null, test: true, lineItems: { nodes: [{ sku: 'S-2', quantity: 99 }] } }], pageInfo: { hasNextPage: false, endCursor: null } }];
  let calls = 0;
  const fetcher = (async (url: string, init: any) => {
    if (String(url).includes('access_token')) return new Response(JSON.stringify({ access_token: 'fake', expires_in: 3600 }), { status: 200 });
    const body = JSON.parse(init.body); assert.match(body.variables.q, /^created_at:>=\d{4}-\d{2}-\d{2}$/);
    return new Response(JSON.stringify({ data: { orders: pages[calls++] } }), { status: 200 });
  }) as any;
  const app = await buildApp({ db, integrations: { executiveUserIds: ['m1'] }, completionModel: null, translationModel: null, mailer: null, nudgeIntervalMs: 0, clock: () => NOW,
    shopify: { shopDomain: 'demo-shop.myshopify.com', clientId: 'id', clientSecret: 'secret', fetcher } } as any);
  const tokens: Record<string, string> = {};
  const call = async (who: string, method: 'GET' | 'POST' | 'PUT', url: string, payload?: any) => { tokens[who] ??= (await issueSession(db, who)).accessToken; return app.inject({ method, url, payload, headers: { authorization: 'Bearer ' + tokens[who], 'accept-language': 'zh-CN' } }); };
  try {
    assert.equal((await call('m2', 'GET', '/scm/board')).statusCode, 403, 'no supply access');
    assert.equal((await call('m1', 'GET', '/capabilities')).json().scm, true);
    const sync = await call('m1', 'POST', '/scm/sync', {}); assert.equal(sync.statusCode, 200, sync.body); assert.deepEqual([sync.json().orders, sync.json().units], [2, 368]);
    await call('m1', 'POST', '/wms/import', { asOf: '2026-11-01', rows: [{ sku: 'S-1', qty: { us: 10, dg: 50 } }, { sku: 'S-2', qty: { us: 40 } }] });
    let b = (await call('m1', 'GET', '/scm/board')).json();
    const s1 = b.items.find((x: any) => x.sku === 'S-1');
    assert.equal(s1.moq, '10 台'); assert.equal(s1.sold365, 363); assert.equal(s1.ds365, 1.8, '363 units over the 200 days of history'); assert.equal(s1.sold30, 2); assert.equal(s1.supplyDays, 57, 'order 2 + production 20 + first leg 30 + receiving 5 + buffer 0');
    assert.equal(s1.leadDays, 37, 'finished goods at the factory skip production: 2 + 30 + 5');assert.equal(s1.arriveOn, '2026-12-19');
    assert.deepEqual([s1.productionDays, s1.firstLegDays, s1.productionFromLibrary], [20, 30, true]);
    const s2 = b.items.find((x: any) => x.sku === 'S-2'); assert.equal(s2.supplyDays, 2 + 30 + 35 + 5, 'missing production / first leg come from the settings');assert.equal(s2.productionFromLibrary, false);
    assert.equal(s1.ds90, 0); assert.equal(s1.signal, 'spike'); assert.equal(s1.forecast, 0.6, 'mostly the yearly rate; the 30-day burst counts in partly');
    assert.equal(s1.status, 'risk'); assert.deepEqual([s1.ship, s1.make], [37, 0], 'factory stock covers the gap, no production needed');
    assert.equal(b.shopify.orders, 2);
    // A shipment from the Dongguan factory: stock moves to in transit, then into the US warehouse on arrival
    assert.equal((await call('m1', 'POST', '/scm/shipments', { number: 'MSKU-DEMO-1', mode: 'sea', source: 'dg', shippedOn: '2026-11-10', lines: [{ sku: 'S-1', qty: 30 }] })).json().error.code, 'SCM_ETA');
    const sh = await call('m1', 'POST', '/scm/shipments', { number: 'MSKU-DEMO-1', mode: 'sea', carrier: 'Demo Line', tracking: 'https://track.example.com/MSKU-DEMO-1', source: 'dg', shippedOn: '2026-11-10', etaDays: 30, lines: [{ sku: 's-1', qty: 30 }] });
    assert.equal(sh.statusCode, 201, sh.body); assert.equal(sh.json().eta, '2026-12-10');
    assert.equal((await call('m1', 'POST', '/scm/shipments', { number: 'msku-demo-1', mode: 'sea', source: 'new', shippedOn: '2026-11-10', etaDays: 30, lines: [{ sku: 'S-2', qty: 1 }] })).json().error.code, 'SCM_SHIPMENT_EXISTS');
    const tooMuch = await call('m1', 'POST', '/scm/shipments', { number: 'MSKU-DEMO-2', mode: 'air', source: 'dg', shippedOn: '2026-11-10', etaDays: 7, lines: [{ sku: 'S-1', qty: 999 }] });
    assert.equal(tooMuch.statusCode, 409); assert.match(tooMuch.json().error.message, /库存不足/);
    b = (await call('m1', 'GET', '/scm/board')).json();
    assert.deepEqual([b.items.find((x: any) => x.sku === 'S-1').factory, b.items.find((x: any) => x.sku === 'S-1').transit], [20, 30]);
    const ship = b.shipments.find((x: any) => x.number === 'MSKU-DEMO-1'); assert.equal(ship.daysLeft, 28); assert.deepEqual(ship.lines, [{ sku: 'S-1', qty: 30 }]);
    // New goods straight from production go into in transit without touching factory stock
    assert.equal((await call('m1', 'POST', '/scm/shipments', { number: 'DHL-DEMO-3', mode: 'express', source: 'new', shippedOn: '2026-11-11', etaDays: 5, lines: [{ sku: 'S-2', qty: 4 }] })).statusCode, 201);
    // 到港通知: supply chain tells the warehouse; nothing moves yet
    assert.equal((await call('m1', 'POST', `/wms/arrivals/${ship.id}/receive`, { opDate: '2026-12-09', lines: [{ sku: 'S-1', received: 30 }] })).json().error.code, 'SCM_NOT_AT_PORT');
    assert.equal((await call('m1', 'POST', `/scm/shipments/${ship.id}/notify`, {})).statusCode, 200);
    assert.equal((await call('m1', 'POST', `/scm/shipments/${ship.id}/notify`, {})).json().error.code, 'SCM_ARRIVED');
    const arr = (await call('m1', 'GET', '/wms/arrivals')).json(); assert.equal(arr.canReceive, true);
    assert.deepEqual(arr.arrivals.map((x: any) => [x.number, x.lines.map((l: any) => [l.sku, l.qty])]), [['MSKU-DEMO-1', [['S-1', 30]]]]);
    assert.equal((await call('m2', 'GET', '/wms/arrivals')).statusCode, 403);
    // 到港入仓: the warehouse confirms each line — 28 of 30 arrived; the 2 short stay in transit
    assert.equal((await call('m1', 'POST', `/wms/arrivals/${ship.id}/receive`, { opDate: '2026-12-09', lines: [{ sku: 'S-1', received: 31 }] })).json().error.code, 'WMS_ARRIVAL_OVER');
    assert.equal((await call('m1', 'POST', `/wms/arrivals/${ship.id}/receive`, { opDate: '2026-12-09', lines: [{ sku: 'S-2', received: 1 }] })).json().error.code, 'WMS_ARRIVAL_LINES');
    const rec = await call('m1', 'POST', `/wms/arrivals/${ship.id}/receive`, { opDate: '2026-12-09', lines: [{ sku: 's-1', received: 28 }] });
    assert.equal(rec.statusCode, 200, rec.body); assert.deepEqual(rec.json().short, [{ sku: 's-1', short: 2 }]);
    assert.equal((await call('m1', 'POST', `/wms/arrivals/${ship.id}/receive`, { opDate: '2026-12-09', lines: [{ sku: 'S-1', received: 28 }] })).json().error.code, 'SCM_NOT_AT_PORT');
    const stock = (await call('m1', 'GET', '/wms/summary')).json().items.find((x: any) => x.sku === 'S-1').qty;
    assert.deepEqual([stock.us, stock.transit, stock.dg], [38, 2, 20]);
    const done = (await call('m1', 'GET', '/scm/board')).json().shipments.find((x: any) => x.number === 'MSKU-DEMO-1');
    assert.equal(done.status, 'arrived'); assert.deepEqual(done.lines, [{ sku: 'S-1', qty: 30, received: 28 }]);
    const log = (await call('m1', 'GET', '/wms/summary')).json().movements.filter((m: any) => m.sku === 'S-1' && m.type === 'transfer');
    assert.ok(log.some((m: any) => /发柜 MSKU-DEMO-1/.test(m.reason)) && log.some((m: any) => /到港入仓 MSKU-DEMO-1/.test(m.reason)), 'both moves are in the stock log');
    // Settings: managers only
    assert.equal((await call('m1', 'PUT', '/scm/settings', { targetDays: 45, safetyDays: 10, orderDays: 3, receiveDays: 6, bufferDays: 7, productionDays: 30, firstLegDays: 35 })).statusCode, 200);
    await db.query(`UPDATE users SET grants='["supply"]' WHERE id='m2'`);
    const after = (await call('m2', 'GET', '/scm/board')).json(); assert.equal(after.settings.targetDays, 45);
    assert.equal(after.items.find((x: any) => x.sku === 'S-1').supplyDays, 3 + 20 + 30 + 6 + 7, 'the buffer (logistics changes) counts in');
    assert.equal((await call('m2', 'PUT', '/scm/settings', { targetDays: 1, safetyDays: 1, orderDays: 1, receiveDays: 1, bufferDays: 1, productionDays: 1, firstLegDays: 1 })).statusCode, 403);
  } finally { await app.close(); }
});

test('采购下单: order, ready date from production lead time, on-order counts in the suggestion, shipping against the order closes it; ship position and ETA', async () => {
  const db = await createDatabase(); await db.exec(schema); await seedDemo(db);
  const org = (await db.query("SELECT org_id FROM users WHERE id='m1'")).rows[0].org_id;
  await db.query(`INSERT INTO product_catalog(org_id,sku,name_zh,lead,attrs) VALUES($1,'P-1','示例主机','20 天','{"firstLeg":"海运 30 天"}')`, [org]);
  const app = await buildApp({ db, integrations: { executiveUserIds: ['m1'] }, completionModel: null, translationModel: null, mailer: null, nudgeIntervalMs: 0, clock: () => NOW } as any);
  const token = (await issueSession(db, 'm1')).accessToken;
  const call = (method: 'GET' | 'POST', url: string, payload?: any) => app.inject({ method, url, payload, headers: { authorization: 'Bearer ' + token, 'accept-language': 'zh-CN' } });
  try {
    for (let i = 1; i <= 60; i++) await db.query('INSERT INTO scm_sales_daily(org_id,sku,day,qty) VALUES($1,$2,$3,2)', [org, 'P-1', daysAgo(i).slice(0, 10)]);
    const before = (await call('GET', '/scm/board')).json().items.find((x: any) => x.sku === 'P-1');
    assert.ok(before.make > 0, 'no stock: production suggested');
    assert.equal((await call('POST', '/scm/orders', { factory: 'dg', orderedOn: '2026-11-12', lines: [{ sku: 'NOPE', qty: 1 }] })).json().error.code, 'SCM_UNKNOWN_SKUS');
    const po = await call('POST', '/scm/orders', { factory: 'dg', orderedOn: '2026-11-12', lines: [{ sku: 'p-1', qty: 100 }], note: '示例' });
    assert.equal(po.statusCode, 201, po.body); assert.equal(po.json().number, 'PO-20261112-01'); assert.equal(po.json().readyOn, '2026-12-02', 'order date + 20 days production');
    let b = (await call('GET', '/scm/board')).json(); const after = b.items.find((x: any) => x.sku === 'P-1');
    assert.equal(after.wip, 100); assert.equal(after.make, Math.max(0, before.make - 100), 'what is in production is not suggested again');
    assert.deepEqual(b.orders.map((o: any) => [o.number, o.status, o.left, o.daysToReady]), [['PO-20261112-01', 'open', 100, 20]]);
    // Shipping 60 against the order, then 40: the order closes itself
    const id = b.orders[0].id;
    assert.equal((await call('POST', '/scm/shipments', { number: 'DEMO-PO-1', mode: 'sea', source: 'new', shippedOn: '2026-12-03', etaDays: 30, orderId: id, lines: [{ sku: 'P-1', qty: 60 }] })).statusCode, 201);
    b = (await call('GET', '/scm/board')).json();
    assert.deepEqual([b.orders[0].left, b.items.find((x: any) => x.sku === 'P-1').wip], [40, 40]);
    assert.equal((await call('POST', '/scm/shipments', { number: 'DEMO-PO-2', mode: 'air', source: 'new', shippedOn: '2026-12-04', etaDays: 7, orderId: id, lines: [{ sku: 'P-1', qty: 40 }] })).statusCode, 201);
    b = (await call('GET', '/scm/board')).json(); assert.equal(b.orders[0].status, 'closed');
    assert.equal((await call('POST', `/scm/orders/${id}/close`, {})).json().error.code, 'SCM_ORDER_CLOSED');
    // Where the ship is, and a later ETA
    const sh = b.shipments.find((x: any) => x.number === 'DEMO-PO-1');
    assert.equal((await call('POST', `/scm/shipments/${sh.id}/position`, { position: '已过巴拿马运河', eta: '2027-01-10' })).statusCode, 200);
    const sh2 = (await call('GET', '/scm/board')).json().shipments.find((x: any) => x.number === 'DEMO-PO-1');
    assert.deepEqual([sh2.position, sh2.positionOn, sh2.eta, sh2.daysTotal], ['已过巴拿马运河', '2026-11-12', '2027-01-10', 38]);
    // 完工入库: finished units go into the factory warehouse; in production drops; two totals (finished, finished + in production)
    const po2 = (await call('POST', '/scm/orders', { factory: 'jn', orderedOn: '2026-11-12', lines: [{ sku: 'P-1', qty: 50 }] })).json();
    assert.equal((await call('POST', `/scm/orders/${po2.id}/finish`, { opDate: '2026-11-12', lines: [{ sku: 'P-1', qty: 51 }] })).json().error.code, 'SCM_FINISH_TOO_MANY');
    assert.equal((await call('POST', `/scm/orders/${po2.id}/finish`, { opDate: '2026-11-12', lines: [{ sku: 'P-1', qty: 20 }] })).statusCode, 200);
    const p1 = (await call('GET', '/scm/board')).json().items.find((x: any) => x.sku === 'P-1');
    assert.deepEqual([p1.jn, p1.wip], [20, 30]);
    assert.equal(p1.finished, p1.us + p1.transit + p1.dg + p1.jn); assert.equal(p1.pipeline, p1.finished + 30);
    const st = (await call('GET', '/wms/summary')).json().items.find((x: any) => x.sku === 'P-1').qty; assert.equal(st.jn, 20);
  } finally { await app.close(); }
});
