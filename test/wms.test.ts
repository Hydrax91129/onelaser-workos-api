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
  const bad=await call('m1','POST','/wms/movements/batch',{opDate:'2026-11-05',type:'in',location:'us',reason:'柜子到货',lines:[{sku:'A-1',qty:2},{sku:'NOPE',qty:1}]});assert.equal(bad.statusCode,400);
  const q=async(s:string,l:string)=>Number((await call('m1','GET','/wms/summary')).json().items.find((i:any)=>i.sku===s).qty[l]||0);
  assert.equal(await q('A-1','us'),0,'nothing applied when one line is wrong');
  const ok=await call('m1','POST','/wms/movements/batch',{opDate:'2026-11-05',type:'in',location:'us',reason:'柜子到货',reference:'MSKU-1',lines:[{sku:'a-1',qty:2},{sku:'B-2',qty:3},{sku:'A-1',qty:1}]});assert.equal(ok.statusCode,201,ok.body);assert.equal(ok.json().lines,2);assert.equal(ok.json().units,6);
  assert.equal(await q('A-1','us'),3);assert.equal(await q('B-2','us'),4);
  assert.equal((await call('m1','POST','/wms/movements/batch',{opDate:'2026-11-05',type:'transfer',location:'transit',toLocation:'us',reason:'到港入仓',lines:[{sku:'A-1',qty:9}]})).statusCode,409,'cannot move more than is there');
  assert.equal((await call('m1','POST','/wms/movements/batch',{opDate:'2026-11-05',type:'transfer',location:'transit',toLocation:'us',reason:'到港入仓',lines:[{sku:'A-1',qty:5}]})).statusCode,201);
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
  const batch=await call('POST','/wms/movements/batch',{opDate:'2026-11-05',type:'in',location:'us',reason:'采购到货',lines:[{sku:'lib-part-02',qty:4},{sku:'LIB-HOST-01',qty:2}]});
  assert.equal(batch.statusCode,201,batch.body);
  assert.equal((await item('LIB-PART-02')).qty.us,4);assert.equal((await item('LIB-HOST-01')).qty.us,3);
  assert.equal((await call('GET','/wms/summary')).json().items.filter((i:any)=>i.sku.startsWith('LIB-')).length,2,'listed once after the first movement');
  assert.equal((await call('POST','/wms/movements/batch',{opDate:'2026-11-05',type:'in',location:'us',reason:'采购到货',lines:[{sku:'NOT-IN-LIBRARY',qty:1}]})).statusCode,400);
  assert.equal((await call('POST','/wms/movements',{type:'in',sku:'NOT-IN-LIBRARY',location:'us',qty:1,reason:'采购到货'})).statusCode,404);
 }finally{await app.close();}
});

test('WMS: one order with many SKUs (out), a count of many SKUs, operation dates, how each movement was made, shelf bins, product filters',async()=>{
 const db=await createDatabase();await db.exec(schema);await seedDemo(db);
 const app=await buildApp({db,integrations:{executiveUserIds:['m1']},completionModel:null,translationModel:null,mailer:null,nudgeIntervalMs:0});
 const tokens:Record<string,string>={};
 const call=async(who:string,method:'GET'|'POST',url:string,payload?:any,lang='en')=>{tokens[who]??=(await issueSession(db,who)).accessToken;return app.inject({method,url,payload,headers:{authorization:'Bearer '+tokens[who],'accept-language':lang}});};
 const sum=async()=>(await call('m1','GET','/wms/summary')).json();
 const q=async(s:string,l:string)=>Number((await sum()).items.find((i:any)=>i.sku===s).qty[l]||0);
 try{
  await call('m1','POST','/wms/import',{asOf:'2026-10-31',rows:[{sku:'X-1',qty:{us:10}},{sku:'X-2',qty:{us:4}},{sku:'X-3',qty:{us:7}}]});
  const base={type:'out',location:'us',reason:'销售发货',opDate:'2026-11-06'};
  // Goods out: the order number is required, every line must have enough stock, all or nothing
  assert.equal((await call('m1','POST','/wms/movements/batch',{...base,lines:[{sku:'X-1',qty:1}]})).json().error.code,'WMS_REFERENCE_REQUIRED');
  const short=await call('m1','POST','/wms/movements/batch',{...base,reference:'SO-9001',lines:[{sku:'X-1',qty:2},{sku:'X-2',qty:5}]},'zh-CN');
  assert.equal(short.statusCode,409);assert.match(short.json().error.message,/X-2 库存不足/);assert.equal(await q('X-1','us'),10,'nothing applied');
  const out=await call('m1','POST','/wms/movements/batch',{...base,reference:'SO-9001',lines:[{sku:'X-1',qty:2},{sku:'X-2',qty:1}]});
  assert.equal(out.statusCode,201,out.body);assert.equal(await q('X-1','us'),8);assert.equal(await q('X-2','us'),3);
  // Operation date: required for a batch, not in the future, not before 2000
  const {opDate:_d,...noDate}=base;
  assert.equal((await call('m1','POST','/wms/movements/batch',{...noDate,reference:'SO-1',lines:[{sku:'X-1',qty:1}]})).statusCode,400);
  for(const d of ['1999-12-31','2099-01-01']){const r=await call('m1','POST','/wms/movements/batch',{...base,opDate:d,reference:'SO-1',lines:[{sku:'X-1',qty:1}]},'zh-CN');assert.equal(r.json().error.code,'WMS_OP_DATE');assert.match(r.json().error.message,/操作日期/);}
  // A count of several SKUs: lines that match the system are skipped; the rest wait for the manager
  const cnt=await call('m1','POST','/wms/movements/batch',{type:'adjust',location:'us',reason:'月底盘点',opDate:'2026-11-07',lines:[{sku:'X-1',counted:8},{sku:'X-2',counted:2},{sku:'X-3',counted:9}]});
  assert.equal(cnt.statusCode,201,cnt.body);assert.deepEqual([cnt.json().lines,cnt.json().unchanged,cnt.json().status],[2,1,'pending']);
  assert.equal(await q('X-3','us'),7,'a count changes nothing until it is confirmed');
  assert.equal((await call('m1','POST','/wms/movements/batch',{type:'adjust',location:'us',reason:'月底盘点',opDate:'2026-11-07',lines:[{sku:'X-1',counted:1},{sku:'x-1',counted:2}]})).json().error.code,'WMS_DUPLICATE_LINE');
  // The log says how each movement was made and when
  const s1=await sum(), mv=(sku:string,type:string)=>s1.movements.find((m:any)=>m.sku===sku&&m.type===type);
  assert.deepEqual([mv('X-1','out').method,mv('X-1','out').batchSkus,mv('X-1','out').batchUnits,mv('X-1','out').opDate],['batch',2,3,'2026-11-06']);
  assert.equal(mv('X-3','adjust').status,'pending');assert.equal(mv('X-3','adjust').opDate,'2026-11-07');
  const imp=s1.movements.find((m:any)=>m.reference==='IMPORT');assert.equal(imp.method,'import');assert.equal(imp.opDate,'2026-10-31','the import is dated as of the stock sheet');
  await call('m1','POST','/wms/movements',{type:'in',sku:'X-3',location:'us',qty:1,reason:'采购到货',opDate:'2026-11-08'});
  const one=(await sum()).movements.find((m:any)=>m.sku==='X-3'&&m.type==='in');assert.deepEqual([one.method,one.opDate],['manual','2026-11-08']);
  // Shelf bins: a preferred bin and two alternates per warehouse
  assert.equal((await call('m1','POST','/wms/bins',{sku:'X-1',location:'us',bins:['','B-02']})).json().error.code,'WMS_BIN_PRIMARY');
  assert.equal((await call('m1','POST','/wms/bins',{sku:'X-1',location:'us',bins:['A-01-03','B-02','C-07']})).statusCode,200);
  assert.deepEqual((await sum()).items.find((i:any)=>i.sku==='X-1').bins,{us:['A-01-03','B-02','C-07']});
  assert.equal((await call('m4','POST','/wms/bins',{sku:'X-1',location:'us',bins:['Z-1']})).statusCode,403,'view access cannot change bins');
  // Product facts for the filters come from the product library
  await db.query(`INSERT INTO product_catalog(org_id,sku,name_zh,msrp,family,attrs) SELECT org_id,'X-2','示例配件',59,'acc','{"series":"XRF"}' FROM users WHERE id='m1'`);
  const s2=await sum(), x2=s2.items.find((i:any)=>i.sku==='X-2');
  assert.deepEqual([x2.family,x2.series,x2.msrp],['acc','XRF',59]);assert.ok(s2.families.some((f:any)=>f.key==='acc'));
 }finally{await app.close();}
});
