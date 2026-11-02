import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createDatabase,schema,seedDemo} from '../src/db.js';
import {buildApp} from '../src/app.js';
import {issueSession} from '../src/auth.js';

test('product catalog and pricing imports: who can import, who sees cost inputs',async()=>{
 const db=await createDatabase();await db.exec(schema);await seedDemo(db);
 await db.query(`UPDATE users SET grants='["products"]' WHERE id='m2'`);
 await db.query(`UPDATE users SET grants='["products","products_manage"]' WHERE id='m3'`);
 await db.query(`UPDATE users SET grants='["products","product_cost_detail"]' WHERE id='m5'`);
 const app=await buildApp({db,integrations:{executiveUserIds:['m1']},completionModel:null,translationModel:null,mailer:null,nudgeIntervalMs:0});
 const tokens:Record<string,string>={};
 const call=async(who:string,method:'GET'|'POST',url:string,payload?:any)=>{tokens[who]??=(await issueSession(db,who)).accessToken;return app.inject({method,url,payload,headers:{authorization:'Bearer '+tokens[who]}});};
 try{
  assert.equal((await call('m6','GET','/products')).statusCode,403);
  const rows=[{sku:'DEMO-1',nameZh:'示例机',nameEn:'Demo',type:'整机',status:'live',gross:50,dims:[90,60,40],lead:'30天',msrp:2999,low:2499,shipFee:199},{sku:'DEMO-2',nameZh:'示例配件',type:'配件',msrp:99}];
  assert.equal((await call('m2','POST','/products/import',{rows})).statusCode,403,'view-only cannot import');
  const imp=await call('m3','POST','/products/import',{rows});assert.equal(imp.statusCode,200,imp.body);assert.equal(imp.json().created,2);
  assert.equal((await call('m3','POST','/products/import',{rows:[rows[0],rows[0]]})).statusCode,400);
  // Partial re-import keeps columns that are not in the file.
  assert.equal((await call('m1','POST','/products/import',{rows:[{sku:'demo-1',msrp:3199}]})).json().updated,1);
  const view=(await call('m2','GET','/products')).json();const d1=view.items.find((x:any)=>x.sku==='DEMO-1');assert.equal(d1.msrp,3199);assert.equal(d1.gross,50);assert.deepEqual(d1.dims,[90,60,40]);
  assert.equal(view.canImportCatalog,false);assert.equal(view.canSeePricing,false);
  assert.equal((await call('m3','POST','/products/pricing/import',{rows:[{sku:'DEMO-1',factoryRmb:12000}]})).statusCode,403,'catalog managers do not see costs');
  assert.equal((await call('m5','POST','/products/pricing/import',{rows:[{sku:'NOPE',factoryRmb:1}]})).statusCode,400,'unknown SKU');
  const pr=await call('m5','POST','/products/pricing/import',{rows:[{sku:'DEMO-1',factoryRmb:12000,ddpRate:12,lastMileRmb:2800}]});assert.equal(pr.statusCode,200,pr.body);
  assert.equal((await call('m5','GET','/products')).json().items.find((x:any)=>x.sku==='DEMO-1').factoryRmb,12000);
  assert.equal((await call('m2','GET','/products')).json().items.find((x:any)=>x.sku==='DEMO-1').factoryRmb,undefined,'basic access never receives cost inputs');
  assert.equal((await call('m1','GET','/products')).json().items.find((x:any)=>x.sku==='DEMO-1').ddpRate,12,'admins see cost inputs');
 }finally{await app.close();}
});
