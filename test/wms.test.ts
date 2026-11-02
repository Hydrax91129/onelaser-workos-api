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
