import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createDatabase, schema, seedDemo } from '../src/db.js';
import { buildApp } from '../src/app.js';
import { issueSession } from '../src/auth.js';

// 撤销 (owner, 2026-11-28): a warehouse manager undoes a wrong goods in / out / transfer with an opposite movement. Fictional SKUs.
test('WMS undo: opposite movement, original marked undone, only once, only by warehouse managers, stock must allow it', async () => {
  const db = await createDatabase(); await db.exec(schema); await seedDemo(db);
  await db.query(`UPDATE users SET grants='["warehouse"]'::jsonb WHERE id='m5'`);
  await db.query(`UPDATE users SET grants='["warehouse","warehouse_manage"]'::jsonb WHERE id='m6'`);
  const app = await buildApp({ db, integrations: { executiveUserIds: ['m1'] }, completionModel: null, translationModel: null, mailer: null, nudgeIntervalMs: 0 } as any);
  const tokens: Record<string, string> = {};
  const call = async (who: string, method: 'GET' | 'POST', url: string, payload?: any) => { tokens[who] ??= (await issueSession(db, who)).accessToken;
    return app.inject({ method, url, payload, headers: { authorization: 'Bearer ' + tokens[who], 'accept-language': 'zh-CN' } }); };
  const sum = async () => (await call('m1', 'GET', '/wms/summary')).json();
  const qty = async (sku: string, loc: string) => Number((await sum()).items.find((i: any) => i.sku === sku)?.qty[loc] || 0);
  const move = (body: any) => call('m6', 'POST', '/wms/movements/batch', { opDate: '2026-11-20', ...body });
  const last = async () => (await sum()).movements[0];

  assert.equal((await call('m1', 'POST', '/wms/import', { asOf: '2026-11-01', rows: [{ sku: 'DEMO-U1', name: 'Demo U1', qty: { us: 5, dg: 4 } }] })).statusCode, 200);
  assert.equal((await move({ type: 'out', location: 'us', reason: '销售发货', reference: '#9001', lines: [{ sku: 'DEMO-U1', qty: 2 }] })).statusCode, 201);
  const out = await last();
  assert.equal(out.canUndo, true);
  assert.equal(await qty('DEMO-U1', 'us'), 3);

  assert.equal((await call('m5', 'POST', `/wms/movements/${out.id}/undo`, { reason: '录错了' })).statusCode, 403, 'view-only cannot undo');
  assert.equal((await call('m6', 'POST', `/wms/movements/${out.id}/undo`, {})).json().error.code, 'WMS_UNDO_REASON');
  const r = await call('m6', 'POST', `/wms/movements/${out.id}/undo`, { reason: '发错了单号' });
  assert.equal(r.statusCode, 200, r.body);
  assert.equal(await qty('DEMO-U1', 'us'), 5, 'goods out undone: stock back');
  const list = (await sum()).movements;
  const undo = list.find((m: any) => m.reverses === out.id), orig = list.find((m: any) => m.id === out.id);
  assert.equal(undo.type, 'in'); assert.equal(undo.qty, 2); assert.equal(undo.reference, '#9001'); assert.match(undo.reason, /^撤销：发错了单号/);
  assert.equal(undo.canUndo, false, 'an undo cannot be undone');
  assert.equal(orig.reversed.reason, '发错了单号'); assert.equal(orig.canUndo, false);
  assert.equal((await call('m6', 'POST', `/wms/movements/${out.id}/undo`, { reason: '再来一次' })).json().error.code, 'WMS_UNDO_NOT_ALLOWED', 'only once');

  // Transfer undone: back where it came from.
  await move({ type: 'transfer', location: 'dg', toLocation: 'transit', reason: '工厂发美国（海运）', lines: [{ sku: 'DEMO-U1', qty: 3 }] });
  const tr = await last();
  assert.equal((await call('m1', 'POST', `/wms/movements/${tr.id}/undo`, { reason: '还没发出' })).statusCode, 200, 'main admins too');
  assert.equal(await qty('DEMO-U1', 'dg'), 4); assert.equal(await qty('DEMO-U1', 'transit'), 0);

  // Goods in undone only while the units are still there.
  await move({ type: 'in', location: 'us', reason: '采购到货', lines: [{ sku: 'DEMO-U1', qty: 10 }] });
  const inn = await last();
  await move({ type: 'out', location: 'us', reason: '销售发货', reference: '#9002', lines: [{ sku: 'DEMO-U1', qty: 14 }] });
  assert.equal((await call('m6', 'POST', `/wms/movements/${inn.id}/undo`, { reason: '多录了' })).json().error.code, 'WMS_NEGATIVE_STOCK');

  // Only within 7 days of being entered.
  await move({ type: 'out', location: 'dg', reason: '样机 / 展会', reference: 'DEMO-SHOW', lines: [{ sku: 'DEMO-U1', qty: 1 }] });
  const old = await last();
  await db.query("UPDATE wms_movements SET created_at=now()-interval '8 days' WHERE id=$1", [old.id]);
  assert.equal((await sum()).movements.find((m: any) => m.id === old.id).canUndo, false);
  const late = (await call('m6', 'POST', `/wms/movements/${old.id}/undo`, { reason: '太晚了' })).json();
  assert.equal(late.error.code, 'WMS_UNDO_NOT_ALLOWED'); assert.match(late.error.message, /7 天/);

  // Opening stock and counts are not undone here.
  const imp = (await sum()).movements.find((m: any) => m.method === 'import');
  assert.equal(imp.canUndo, false);
  assert.equal((await call('m6', 'POST', `/wms/movements/${imp.id}/undo`, { reason: '测试' })).json().error.code, 'WMS_UNDO_NOT_ALLOWED');
  await app.close();
});
