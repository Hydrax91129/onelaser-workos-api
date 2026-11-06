import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createDatabase,schema,seedDemo} from '../src/db.js';
import {buildApp} from '../src/app.js';
import {issueSession} from '../src/auth.js';

// Fictional SKU and numbers only.
test('pricing page: MSRP shipping, major / minor promotion and clearance prices save and load; WMS stock per warehouse',async()=>{
 const db=await createDatabase();await db.exec(schema);await seedDemo(db);
 await db.query(`UPDATE users SET grants='["products","products_manage","product_cost_detail","warehouse"]' WHERE id='m5'`);
 await db.query(`UPDATE users SET grants='[]' WHERE id='m6'`);
 const app=await buildApp({db,integrations:{executiveUserIds:['m1']},completionModel:null,translationModel:null,mailer:null,nudgeIntervalMs:0});
 const tokens:Record<string,string>={};
 const call=async(who:string,method:'GET'|'POST'|'PATCH',url:string,payload?:any)=>{tokens[who]??=(await issueSession(db,who)).accessToken;return app.inject({method,url,payload,headers:{authorization:'Bearer '+tokens[who]}});};
 try{
  const made=await call('m1','POST','/products/library',{sku:'DEMO-PX-1',values:{family:'acc',nameZh:'示例配件',nameEn:'Demo part'}});assert.equal(made.statusCode,201,made.body);
  const saved=await call('m1','PATCH','/products/library/DEMO-PX-1',{values:{msrp:'199',shipFee:'15',priceMajor:'149',priceMinor:'179',priceClear:'99'}});assert.equal(saved.statusCode,200,saved.body);
  const it=(await call('m6','GET','/products/library')).json().items.find((x:any)=>x.sku==='DEMO-PX-1');
  assert.deepEqual([it.values.msrp,it.values.shipFee,it.values.priceMajor,it.values.priceMinor,it.values.priceClear],[199,15,149,179,99],'everyone sees the prices');
  const cleared=await call('m1','PATCH','/products/library/DEMO-PX-1',{values:{shipFee:null}});assert.equal(cleared.statusCode,200,cleared.body);
  assert.equal((await call('m1','GET','/products/library')).json().items.find((x:any)=>x.sku==='DEMO-PX-1').values.shipFee,null);
  const hist=(await call('m1','GET','/products/library/DEMO-PX-1/history')).json().items.map((x:any)=>x.field);
  for(const k of ['priceMajor','priceMinor','priceClear'])assert.ok(hist.includes(k),k);
  const org=(await db.query(`SELECT org_id FROM users WHERE id='m1'`)).rows[0].org_id;
  await db.query(`INSERT INTO wms_stock(org_id,sku,location,qty) VALUES($1,'DEMO-PX-1','us',12),($1,'DEMO-PX-1','dg',30),($1,'DEMO-PX-1','transit',5)`,[org]);
  const st=await call('m5','GET','/wms/stock/demo-px-1');assert.equal(st.statusCode,200,st.body);
  const s=st.json();assert.equal(s.total,42);assert.equal(s.inTransit,5);assert.equal(s.locations.find((l:any)=>l.id==='us').qty,12);
  assert.equal((await call('m6','GET','/wms/stock/DEMO-PX-1')).statusCode,403,'no warehouse access, no stock');
 }finally{await app.close();}
});
