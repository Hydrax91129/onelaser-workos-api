import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createDatabase, schema, seedDemo } from '../src/db.js';
import { buildApp } from '../src/app.js';
import { issueSession } from '../src/auth.js';
import { viewerOf, canBulkImport } from '../src/product-spec.js';
import { worksheet, normalizeWorksheet } from '../src/product-worksheet.js';

// Fictional people (seed demo), SKUs and bins only.
const start = async (before?: (db: any) => Promise<void>) => {
  const db = await createDatabase(); await db.exec(schema); await seedDemo(db);
  if (before) await before(db);
  const app = await buildApp({ db, integrations: { executiveUserIds: ['m1'] }, completionModel: null, translationModel: null, mailer: null, nudgeIntervalMs: 0 } as any);
  const tokens: Record<string, string> = {};
  const call = async (who: string, method: 'GET' | 'POST' | 'PATCH', url: string, payload?: any) => { tokens[who] ??= (await issueSession(db, who)).accessToken; return app.inject({ method, url, payload, headers: { authorization: 'Bearer ' + tokens[who], 'accept-language': 'zh-CN' } }); };
  const grants = async (id: string) => (await db.query('SELECT grants FROM users WHERE id=$1', [id])).rows[0].grants as string[];
  return { db, app, call, grants };
};

test('product data and pricing have four levels each; the rules behind them', () => {
  const v = (g: string[]) => viewerOf(g, false);
  assert.equal(v(['products']).levels.has('sens'), false, '查看普通信息: no confidential fields');
  assert.equal(v(['products', 'products_secret']).levels.has('sens'), true, '查看保密信息');
  assert.equal(v(['products', 'products_secret']).editCatalog, false, 'view only');
  const mg = v(['products', 'products_secret', 'products_manage']); assert.deepEqual([mg.editCatalog, mg.editCost, mg.editPrices], [true, true, true], '管理信息 edits everything');
  const pv = v(['products', 'product_cost_detail']); assert.deepEqual([pv.levels.has('cost'), pv.editCost, pv.editPrices], [true, false, false], '价格·查看 is read-only');
  const pe = v(['products', 'product_cost_detail', 'pricing_edit']); assert.deepEqual([pe.editCost, pe.editPrices, pe.editCatalog], [true, true, false], '价格·单项修改');
  assert.equal(canBulkImport(['products', 'product_cost_detail', 'pricing_edit'], false), false, 'single edits only');
  assert.equal(canBulkImport(['products', 'product_cost_detail', 'pricing_edit', 'products_import'], false), true, '价格·管理 bulk-updates');
  assert.equal(canBulkImport(['products', 'products_secret', 'products_manage'], false), true, '产品资料·管理信息 bulk-updates');
});

test('the one-time move to four levels gives nobody more than they could see; the access page sets the new levels', async () => {
  const { app, call, grants } = await start(async db => {
    await db.query(`UPDATE users SET grants='["products","products_manage"]' WHERE id='m2'`);           // manage without cost
    await db.query(`UPDATE users SET grants='["products","product_cost_detail"]' WHERE id='m3'`);       // old full build-up
    await db.query(`UPDATE users SET grants='["products","pricing_msrp","products_import"]' WHERE id='m5'`); // old MSRP-only + bulk
    await db.query(`UPDATE users SET grants='["products","products_manage","product_cost_detail","products_import"]' WHERE id='m6'`);
  });
  try {
    assert.deepEqual((await grants('m2')).sort(), ['products'], 'manage without the confidential view drops to 查看普通信息');
    assert.deepEqual((await grants('m3')).sort(), ['pricing_edit', 'product_cost_detail', 'products', 'products_secret'], 'full build-up keeps seeing and editing');
    assert.deepEqual((await grants('m5')).sort(), ['products'], 'MSRP-only and bulk without cost end');
    const all = (await call('m1', 'GET', '/erp/access')).json().people;
    assert.deepEqual(all.find((p: any) => p.id === 'm6').access, { ...all.find((p: any) => p.id === 'm6').access, products: 'manage', pricing: 'manage' });
    assert.equal(all.find((p: any) => p.id === 'm3').access.pricing, 'edit');
    const s = await call('m1', 'POST', '/erp/access', { userId: 'm2', area: 'products', level: 'secret' }); assert.equal(s.json().access.products, 'secret');
    assert.deepEqual((await grants('m2')).sort(), ['products', 'products_secret']);
    const p = await call('m1', 'POST', '/erp/access', { userId: 'm2', area: 'pricing', level: 'edit' }); assert.equal(p.json().access.pricing, 'edit');
    assert.equal((await call('m1', 'POST', '/erp/access', { userId: 'm2', area: 'pricing', level: 'full' })).statusCode, 400, 'old level names are gone');
    assert.equal((await call('m1', 'POST', '/erp/access', { userId: 'm2', area: 'import', level: 'allow' })).statusCode, 400, 'bulk update is part of 管理 now');
    // Removing product access removes price access with it
    assert.equal((await call('m1', 'POST', '/erp/access', { userId: 'm2', area: 'products', level: 'none' })).json().access.pricing, 'none');
  } finally { await app.close(); }
});

test('leaving the company ends every permission: grants and the admin tick are cleared and stay cleared when the account comes back', async () => {
  const { db, app, call, grants } = await start(async db => {
    await db.query(`UPDATE users SET grants='["products","products_secret","finance_view"]',is_admin=true WHERE id='m3'`);
  });
  try {
    assert.equal((await call('m1', 'POST', '/org/members/m3/status', { active: false })).statusCode, 200);
    assert.deepEqual(await grants('m3'), []);
    assert.equal((await db.query("SELECT is_admin FROM users WHERE id='m3'")).rows[0].is_admin, false);
    const a = (await db.query("SELECT details FROM audit_events WHERE action='org.member_access_cleared' AND object_id='m3'")).rows[0];
    assert.deepEqual(a.details.grants, ['products', 'products_secret', 'finance_view'], 'what was cleared is in the audit log');
    assert.equal((await call('m1', 'POST', '/org/members/m3/status', { active: true })).statusCode, 200);
    assert.deepEqual(await grants('m3'), [], 'nothing comes back by itself');
  } finally { await app.close(); }
});

test('a SKU may have its own retail and wholesale selling-cost rates; blank uses the company rate', () => {
  const w = normalizeWorksheet({ dtcItems: [{ name: '示例', pct: 17 }], whItems: [{ name: '示例', pct: 7 }], retailTiers: [], whTiers: [], npcr: [] });
  const base = worksheet({ landed: 100, lastMile: 10, msrp: 200 }, w), own = worksheet({ landed: 100, lastMile: 10, msrp: 200, dtcRate: 13, whRate: 4 }, w);
  assert.equal(base.dtcRate, 0.17); assert.equal(own.dtcRate, 0.13); assert.equal(own.whRate, 0.04);
  assert.equal(Math.round(own.fixed[0].cm!), Math.round(200 * 0.87 - 110));
  assert.equal(worksheet({ landed: 100, msrp: 200, dtcRate: 150 }, w).dtcRate, 0.17, 'an impossible rate is ignored');
});

test('库位管理: add, rename (SKUs follow), delete only when empty; bins in use are listed', async () => {
  const { db, app, call } = await start(async db => {
    const org = (await db.query("SELECT org_id FROM users WHERE id='m1'")).rows[0].org_id;
    await db.query(`INSERT INTO product_catalog(org_id,sku,name_zh) VALUES($1,'BIN-A','示例 A'),($1,'BIN-B','示例 B')`, [org]);
  });
  try {
    assert.equal((await call('m2', 'POST', '/wms/bin-codes', { location: 'us', codes: ['A-01'] })).statusCode, 403, 'warehouse managers only');
    const add = await call('m1', 'POST', '/wms/bin-codes', { location: 'us', codes: ['A-01', 'A-02', 'A-01'], note: '示例货架' });
    assert.equal(add.statusCode, 201, add.body); assert.deepEqual(add.json().added, ['A-01', 'A-02']);
    assert.deepEqual((await call('m1', 'POST', '/wms/bin-codes', { location: 'us', codes: ['A-02', 'A-03'] })).json(), { added: ['A-03'], existing: ['A-02'] });
    // A SKU uses A-01 (and an unlisted code, which is adopted into the list)
    await call('m1', 'POST', '/wms/bins', { sku: 'BIN-A', location: 'us', bins: ['A-01', 'Z-99'] });
    await call('m1', 'POST', '/wms/movements/batch', { type: 'in', location: 'us', opDate: '2026-11-10', reason: '采购到货', lines: [{ sku: 'BIN-A', qty: 5 }] });
    let list = (await call('m1', 'GET', '/wms/bin-codes')).json().codes;
    assert.deepEqual(list.filter((c: any) => c.location === 'us').map((c: any) => c.code), ['A-01', 'A-02', 'A-03', 'Z-99']);
    assert.deepEqual(list.find((c: any) => c.code === 'A-01').skus, [{ sku: 'BIN-A', slot: 1, qty: 5 }]);
    // Rename: the SKU follows
    assert.equal((await call('m1', 'POST', '/wms/bin-codes/rename', { location: 'us', code: 'A-01', to: 'A-02' })).json().error.code, 'WMS_BIN_CODE_EXISTS');
    assert.equal((await call('m1', 'POST', '/wms/bin-codes/rename', { location: 'us', code: 'A-01', to: 'B-01', note: '新货架' })).statusCode, 200);
    const it = (await call('m1', 'GET', '/wms/summary')).json().items.find((x: any) => x.sku === 'BIN-A');
    assert.equal(it.bins.us[0], 'B-01');
    // Delete: refused while it holds stock; an empty bin is removed and its assignment cleared
    const busy = await call('m1', 'POST', '/wms/bin-codes/delete', { location: 'us', code: 'B-01' });
    assert.equal(busy.statusCode, 409); assert.match(busy.json().error.message, /还有货/);
    assert.equal((await call('m1', 'POST', '/wms/bin-codes/delete', { location: 'us', code: 'Z-99' })).statusCode, 200);
    assert.deepEqual((await db.query("SELECT bin1,bin2 FROM wms_bins WHERE sku='BIN-A'")).rows[0], { bin1: 'B-01', bin2: '' });
    assert.equal((await call('m1', 'POST', '/wms/bin-codes/delete', { location: 'us', code: 'NOPE' })).statusCode, 404);
    list = (await call('m1', 'GET', '/wms/bin-codes')).json().codes;
    assert.equal(list.find((c: any) => c.code === 'B-01').note, '新货架');
  } finally { await app.close(); }
});
