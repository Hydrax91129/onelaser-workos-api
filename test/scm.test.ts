import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createDatabase, schema, seedDemo } from '../src/db.js';
import { buildApp } from '../src/app.js';
import { issueSession } from '../src/auth.js';
import { reorderOf, leadDaysOf } from '../src/scm.js';

// Fictional SKUs, orders and shipments only.
const NOW = Date.parse('2026-11-12T18:00:00Z');
const daysAgo = (n: number) => new Date(NOW - n * 86400000).toISOString();

test('reorder: DS × (lead + target + safety) against US + in transit; factory stock first, production for the rest', () => {
  assert.equal(leadDaysOf('25 天', '海运 35 天'), 60); assert.equal(leadDaysOf('', ''), null);
  const r = reorderOf({ ds: 2, us: 50, transit: 30, factory: 40, leadDays: 60, targetDays: 30, safetyDays: 14 });
  assert.deepEqual([r.need, r.gap, r.ship, r.make, r.cover, r.monthly, r.status], [208, 128, 40, 88, 40, 60, 'risk']);
  assert.equal(reorderOf({ ds: 1, us: 400, transit: 0, factory: 0, leadDays: 30, targetDays: 30, safetyDays: 14 }).status, 'overstock');
  assert.equal(reorderOf({ ds: 0, us: 3, transit: 0, factory: 0, leadDays: 30, targetDays: 30, safetyDays: 14 }).status, 'no_sales');
});

test('SCM: Shopify sales sync (365 days, per SKU and day), board with DS and suggestions, shipments move stock to in transit and into the US warehouse', async () => {
  const db = await createDatabase(); await db.exec(schema); await seedDemo(db);
  const org = (await db.query("SELECT org_id FROM users WHERE id='m1'")).rows[0].org_id;
  await db.query(`INSERT INTO product_catalog(org_id,sku,name_zh,lead,attrs) VALUES($1,'S-1','示例主机','20 天','{"firstLeg":"海运 30 天"}'),($1,'S-2','示例配件','','{}')`, [org]);
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
    assert.equal(s1.sold365, 363); assert.equal(s1.ds365, 1.8, '363 units over the 200 days of history'); assert.equal(s1.sold30, 2); assert.equal(s1.leadDays, 50, '20 + 30 from the product library');
    assert.equal(s1.status, 'risk'); assert.equal(s1.ship, 50, 'ship all factory stock first'); assert.ok(s1.make > 0, 'and order production for the rest');
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
    assert.equal((await call('m1', 'POST', `/scm/shipments/${ship.id}/arrive`, {})).statusCode, 200);
    assert.equal((await call('m1', 'POST', `/scm/shipments/${ship.id}/arrive`, {})).json().error.code, 'SCM_ARRIVED');
    const stock = (await call('m1', 'GET', '/wms/summary')).json().items.find((x: any) => x.sku === 'S-1').qty;
    assert.deepEqual([stock.us, stock.transit, stock.dg], [40, 0, 20]);
    const log = (await call('m1', 'GET', '/wms/summary')).json().movements.filter((m: any) => m.sku === 'S-1' && m.type === 'transfer');
    assert.ok(log.some((m: any) => /发柜 MSKU-DEMO-1/.test(m.reason)) && log.some((m: any) => /到港入仓 MSKU-DEMO-1/.test(m.reason)), 'both moves are in the stock log');
    // Settings: managers only
    assert.equal((await call('m1', 'PUT', '/scm/settings', { targetDays: 45, safetyDays: 10, leadDays: 70 })).statusCode, 200);
    await db.query(`UPDATE users SET grants='["supply"]' WHERE id='m2'`);
    assert.equal((await call('m2', 'GET', '/scm/board')).json().settings.targetDays, 45);
    assert.equal((await call('m2', 'PUT', '/scm/settings', { targetDays: 1, safetyDays: 1, leadDays: 1 })).statusCode, 403);
  } finally { await app.close(); }
});
