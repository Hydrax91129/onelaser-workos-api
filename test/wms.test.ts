import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createDatabase,schema,seedDemo} from '../src/db.js';
import {buildApp} from '../src/app.js';
import {issueSession} from '../src/auth.js';

// Demo org: m1 is the executive admin (marketing manager), m2/m3 report to m1; m4 manages product, m5/m6 report to m4.
test('WMS: import, goods in/out/transfer, count adjustments confirmed by the manager, ERP access levels',async()=>{
 const db=await createDatabase();await db.exec(schema);await seedDemo(db);
 await db.query(`UPDATE users SET manager_id='m1' WHERE id IN ('m2','m3')`);await db.query(`UPDATE users SET manager_id='m4' WHERE id IN ('m5','m6')`);
 const app=await buildApp({db,integrations:{executiveUserIds:['m1']},completionModel:null,translationModel:null,mailer:null,nudgeIntervalMs:0});
 const tokens:Record<string,string>={};
 const call=async(who:string,method:'GET'|'POST',url:string,payload?:any)=>{tokens[who]??=(await issueSession(db,who)).accessToken;return app.inject({method,url,payload,headers:{authorization:'Bearer '+tokens[who]}});};
 const summary=async(who:string)=>(await call(who,'GET','/wms/summary')).json();
 const qty=async(sku:string,loc:string)=>Number((await summary('m1')).items.find((i:any)=>i.sku===sku)?.qty[loc]||0);
 try{
  assert.equal((await call('m1','GET','/capabilities')).json().wms,true);
  assert.equal((await call('m2','GET','/wms/summary')).statusCode,403,'no grant, not a manager: no access');
  assert.equal((await call('m4','GET','/wms/summary')).statusCode,200,'managers can view');
  assert.equal((await summary('m4')).canOperate,false);

  // Opening balance import (admin only).
  const rows=[{sku:'DEMO-A',name:'Demo machine A',type:'整机',qty:{us:5,dg:10,jn:0,transit:2}},{sku:'DEMO-B',name:'Demo part B',type:'配件',qty:{us:0}}];
  assert.equal((await call('m4','POST','/wms/import',{asOf:'2026-10-31',rows})).statusCode,403);
  const imp=await call('m1','POST','/wms/import',{asOf:'2026-10-31',rows});assert.equal(imp.statusCode,200,imp.body);assert.equal(imp.json().created,2);
  assert.equal(await qty('DEMO-A','dg'),10);
  assert.equal((await call('m1','POST','/wms/import',{asOf:'2026-10-31',rows:[rows[0],rows[0]]})).statusCode,400,'duplicate SKU in the file');

  // ERP access: the admin gives m5 warehouse manage; m4 (manager) can set warehouse for reports only.
  assert.equal((await call('m4','POST','/erp/access',{userId:'m2',area:'warehouse',level:'view'})).statusCode,403,'not m4’s report');
  assert.equal((await call('m4','POST','/erp/access',{userId:'m5',area:'products',level:'view'})).statusCode,403,'managers set warehouse only');
  const set=await call('m4','POST','/erp/access',{userId:'m5',area:'warehouse',level:'manage'});assert.equal(set.statusCode,200,set.body);assert.equal(set.json().access.warehouse,'manage');
  const full=await call('m1','POST','/erp/access',{userId:'m6',area:'pricing',level:'full'});assert.equal(full.json().access.products,'view','full price build-up brings product access');
  const list=(await call('m4','GET','/erp/access')).json();assert.deepEqual(list.people.map((p:any)=>p.id).sort(),['m5','m6'],'managers only see their reports');

  // Movements by the warehouse manager m5.
  assert.equal((await call('m4','POST','/wms/movements',{type:'in',sku:'DEMO-A',location:'us',qty:1,reason:'采购到货'})).statusCode,403,'view-only cannot change stock');
  assert.equal((await call('m5','POST','/wms/movements',{type:'in',sku:'DEMO-A',location:'us',qty:3,reason:'采购到货',reference:'PO-1'})).statusCode,201);
  assert.equal(await qty('DEMO-A','us'),8);
  assert.equal((await call('m5','POST','/wms/movements',{type:'out',sku:'DEMO-A',location:'us',qty:2,reason:'销售发货'})).statusCode,400,'goods out needs a reference');
  assert.equal((await call('m5','POST','/wms/movements',{type:'out',sku:'DEMO-A',location:'us',qty:9,reason:'销售发货',reference:'SO-9'})).statusCode,409,'cannot go negative');
  assert.equal((await call('m5','POST','/wms/movements',{type:'out',sku:'DEMO-A',location:'us',qty:2,reason:'销售发货',reference:'SO-1'})).statusCode,201);
  assert.equal((await call('m5','POST','/wms/movements',{type:'transfer',sku:'DEMO-A',location:'dg',toLocation:'transit',qty:4,reason:'工厂发美国（海运）'})).statusCode,201);
  assert.equal(await qty('DEMO-A','dg'),6);assert.equal(await qty('DEMO-A','transit'),6);
  assert.equal((await call('m5','POST','/wms/movements',{type:'in',sku:'NOPE',location:'us',qty:1,reason:'采购到货'})).statusCode,404);

  // Count adjustment: pending until m5's manager (m4) or an admin confirms; m6 cannot.
  const adj=await call('m5','POST','/wms/movements',{type:'adjust',sku:'DEMO-A',location:'us',counted:4,reason:'盘点差异'});assert.equal(adj.statusCode,201,adj.body);assert.equal(adj.json().status,'pending');
  assert.equal(await qty('DEMO-A','us'),6,'pending adjustments do not change stock');
  assert.equal((await call('m5','POST',`/wms/movements/${adj.json().id}/approve`,{})).statusCode,403,'cannot confirm your own');
  assert.equal((await summary('m4')).movements.find((m:any)=>m.id===adj.json().id).canDecide,true);
  assert.equal((await call('m4','POST',`/wms/movements/${adj.json().id}/approve`,{})).statusCode,200);
  assert.equal(await qty('DEMO-A','us'),4);
  assert.equal((await call('m1','POST',`/wms/movements/${adj.json().id}/reject`,{})).statusCode,409,'already decided');

  // New SKU by a warehouse manager.
  assert.equal((await call('m5','POST','/wms/items',{sku:'DEMO-C',name:'Demo C',type:'配件'})).statusCode,201);
  assert.equal((await call('m5','POST','/wms/items',{sku:'demo-c',name:'dup'})).statusCode,409);
  assert.equal((await summary('m5')).items.length,3);
 }finally{await app.close();}
});

test('WMS batch goods in and batch transfer: all lines or none',async()=>{
 const db=await createDatabase();await db.exec(schema);await seedDemo(db);
 const app=await buildApp({db,integrations:{executiveUserIds:['m1']},completionModel:null,translationModel:null,mailer:null,nudgeIntervalMs:0});
 const tokens:Record<string,string>={};
 const call=async(who:string,method:'GET'|'POST',url:string,payload?:any)=>{tokens[who]??=(await issueSession(db,who)).accessToken;return app.inject({method,url,payload,headers:{authorization:'Bearer '+tokens[who]}});};
 try{
  await call('m1','POST','/wms/import',{asOf:'2026-10-31',rows:[{sku:'A-1',qty:{us:0,transit:5}},{sku:'B-2',qty:{us:1}}]});
  const bad=await call('m1','POST','/wms/movements/batch',{type:'in',location:'us',reason:'柜子到货',lines:[{sku:'A-1',qty:2},{sku:'NOPE',qty:1}]});assert.equal(bad.statusCode,400);
  const q=async(s:string,l:string)=>Number((await call('m1','GET','/wms/summary')).json().items.find((i:any)=>i.sku===s).qty[l]||0);
  assert.equal(await q('A-1','us'),0,'nothing applied when one line is wrong');
  const ok=await call('m1','POST','/wms/movements/batch',{type:'in',location:'us',reason:'柜子到货',reference:'MSKU-1',lines:[{sku:'a-1',qty:2},{sku:'B-2',qty:3},{sku:'A-1',qty:1}]});assert.equal(ok.statusCode,201,ok.body);assert.deepEqual(ok.json(),{lines:2,units:6});
  assert.equal(await q('A-1','us'),3);assert.equal(await q('B-2','us'),4);
  assert.equal((await call('m1','POST','/wms/movements/batch',{type:'transfer',location:'transit',toLocation:'us',reason:'到港入仓',lines:[{sku:'A-1',qty:9}]})).statusCode,409,'cannot move more than is there');
  assert.equal((await call('m1','POST','/wms/movements/batch',{type:'transfer',location:'transit',toLocation:'us',reason:'到港入仓',lines:[{sku:'A-1',qty:5}]})).statusCode,201);
  assert.equal(await q('A-1','us'),8);assert.equal(await q('A-1','transit'),0);
 }finally{await app.close();}
});

test('WMS re-import sets quantities and logs the difference; SKU history goes past the summary window',async()=>{
 const db=await createDatabase();await db.exec(schema);await seedDemo(db);
 const app=await buildApp({db,integrations:{executiveUserIds:['m1']},completionModel:null,translationModel:null,mailer:null,nudgeIntervalMs:0});
 const tokens:Record<string,string>={};
 const call=async(who:string,method:'GET'|'POST',url:string,payload?:any)=>{tokens[who]??=(await issueSession(db,who)).accessToken;return app.inject({method,url,payload,headers:{authorization:'Bearer '+tokens[who]}});};
 try{
  assert.equal((await call('m1','POST','/wms/import',{asOf:'2026-10-01',rows:[{sku:'R-1',name:'Refurb unit',qty:{us:4,transit:2}}]})).json().changed,2);
  const again=await call('m1','POST','/wms/import',{asOf:'2026-10-31',rows:[{sku:'r-1',qty:{us:1,transit:2,dg:3}}]});assert.equal(again.statusCode,200,again.body);
  assert.deepEqual(again.json(),{rows:1,created:0,changed:2},'case-insensitive SKU match; unchanged transit is skipped');
  const it=(await call('m1','GET','/wms/summary')).json().items.find((i:any)=>i.sku==='R-1');
  assert.deepEqual(it.qty,{us:1,transit:2,dg:3});assert.equal(it.name,'Refurb unit','an empty name keeps the old one');
  await db.query(`INSERT INTO wms_movements(id,org_id,type,sku,location,qty,reason,created_by,created_at) SELECT 'f'||g,(SELECT org_id FROM users WHERE id='m1'),'in','OTHER','us',1,'filler','m1',now()+interval '1 minute' FROM generate_series(1,501) g`);
  assert.equal((await call('m1','GET','/wms/summary')).json().movements.filter((m:any)=>m.sku==='R-1').length,0,'R-1 is outside the latest 500');
  const hist=await call('m1','GET','/wms/movements?sku=r-1');assert.equal(hist.statusCode,200,hist.body);
  assert.equal(hist.json().movements.length,4);assert.equal(hist.json().movements[0].byName!=='',true);
  assert.equal((await call('m2','GET','/wms/movements?sku=R-1')).statusCode,403);
  assert.equal((await call('m1','GET','/wms/movements')).statusCode,400,'sku is required');
 }finally{await app.close();}
});

test('WMS: SKUs in the product library are warehouse SKUs without adding them again',async()=>{
 const db=await createDatabase();await db.exec(schema);await seedDemo(db);
 const app=await buildApp({db,integrations:{executiveUserIds:['m1']},completionModel:null,translationModel:null,mailer:null,nudgeIntervalMs:0});
 const token=(await issueSession(db,'m1')).accessToken;
 const call=(method:'GET'|'POST',url:string,payload?:any)=>app.inject({method,url,payload,headers:{authorization:'Bearer '+token}});
 const item=async(s:string)=>(await call('GET','/wms/summary')).json().items.find((i:any)=>i.sku===s);
 try{
  const org=(await db.query(`SELECT org_id FROM users WHERE id='m1'`)).rows[0].org_id;
  for(const [s,zh,en,type] of [['LIB-HOST-01','示例主机','Demo host','主机'],['LIB-PART-02','','Demo part','配件'],['REF-LIB-HOST-01','退货主机','','主机']])
   await db.query('INSERT INTO product_catalog(org_id,sku,name_zh,name_en,type) VALUES($1,$2,$3,$4,$5)',[org,s,zh,en,type]);
  const host=await item('LIB-HOST-01');assert.equal(host.name,'示例主机');assert.equal(host.type,'主机');assert.deepEqual(host.qty,{});
  assert.equal((await item('LIB-PART-02')).name,'Demo part','English name when there is no Chinese name');
  assert.equal(await item('REF-LIB-HOST-01'),undefined,'returned-goods SKUs stay out of regular stock');
  assert.equal((await db.query(`SELECT 1 FROM wms_items WHERE sku LIKE 'LIB-%'`)).rows.length,0,'listing does not write');

  const one=await call('POST','/wms/movements',{type:'in',sku:'LIB-HOST-01',location:'us',qty:1,reason:'采购到货'});assert.equal(one.statusCode,201,one.body);
  assert.equal((await item('LIB-HOST-01')).qty.us,1);
  const batch=await call('POST','/wms/movements/batch',{type:'in',location:'us',reason:'采购到货',lines:[{sku:'lib-part-02',qty:4},{sku:'LIB-HOST-01',qty:2}]});
  assert.equal(batch.statusCode,201,batch.body);
  assert.equal((await item('LIB-PART-02')).qty.us,4);assert.equal((await item('LIB-HOST-01')).qty.us,3);
  assert.equal((await call('GET','/wms/summary')).json().items.filter((i:any)=>i.sku.startsWith('LIB-')).length,2,'listed once after the first movement');
  assert.equal((await call('POST','/wms/movements/batch',{type:'in',location:'us',reason:'采购到货',lines:[{sku:'NOT-IN-LIBRARY',qty:1}]})).statusCode,400);
  assert.equal((await call('POST','/wms/movements',{type:'in',sku:'NOT-IN-LIBRARY',location:'us',qty:1,reason:'采购到货'})).statusCode,404);
 }finally{await app.close();}
});
