import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createDatabase,schema,seedDemo} from '../src/db.js';
import {buildApp} from '../src/app.js';
import {issueSession} from '../src/auth.js';
import {DEFAULT_PRICING_RULES} from '../src/products.js';

test('pricing rules: cost-detail people read them, only admins change them; per-SKU pricing plan',async()=>{
 const db=await createDatabase();await db.exec(schema);await seedDemo(db);
 await db.query(`UPDATE users SET grants='["products"]' WHERE id='m2'`);
 await db.query(`UPDATE users SET grants='["products","products_secret","products_manage"]' WHERE id='m3'`);
 await db.query(`UPDATE users SET grants='["products","product_cost_detail"]' WHERE id='m5'`);
 const app=await buildApp({db,integrations:{executiveUserIds:['m1']},completionModel:null,translationModel:null,mailer:null,nudgeIntervalMs:0});
 const tokens:Record<string,string>={};
 const call=async(who:string,method:'GET'|'POST'|'PUT'|'PATCH',url:string,payload?:any)=>{tokens[who]??=(await issueSession(db,who)).accessToken;return app.inject({method,url,payload,headers:{authorization:'Bearer '+tokens[who]}});};
 try{
  assert.equal((await call('m2','GET','/products/pricing-rules')).statusCode,403,'basic product access cannot read the rules');
  const r=(await call('m5','GET','/products/pricing-rules')).json();
  assert.equal(r.canEdit,false);assert.equal(r.rules.retail.reduce((n:number,x:any)=>n+x.pct,0),17);assert.equal(r.rules.wholesalePct,7);assert.equal(r.rules.wholesale.base,25);
  const next={...DEFAULT_PRICING_RULES,wholesalePct:10,classes:{standard:30,rd:40,accessory:50}};
  assert.equal((await call('m5','PUT','/products/pricing-rules',next)).statusCode,403,'cost detail holders cannot change rules');
  assert.equal((await call('m1','PUT','/products/pricing-rules',{...next,tiers:{...next.tiers,small:[25,20]}})).statusCode,400,'inverted range refused');
  const saved=await call('m1','PUT','/products/pricing-rules',next);assert.equal(saved.statusCode,200,saved.body);
  assert.equal((await call('m5','GET','/products/pricing-rules')).json().rules.wholesalePct,10);

  await call('m3','POST','/products/import',{rows:[{sku:'DEMO-XRF',nameZh:'示例 XRF',type:'整机',msrp:5999,shipFee:399}]});
  assert.equal((await call('m2','PATCH','/products/DEMO-XRF/pricing-plan',{actualPrice:4999})).statusCode,403);
  assert.equal((await call('m5','PATCH','/products/NOPE/pricing-plan',{actualPrice:1})).statusCode,404);
  assert.equal((await call('m5','PATCH','/products/demo-xrf/pricing-plan',{priceClass:'luxury'})).statusCode,400);
  const pl=await call('m5','PATCH','/products/demo-xrf/pricing-plan',{priceClass:'standard',landedUsd:2800,lastMileUsd:399,actualPrice:4999});
  assert.equal(pl.statusCode,200,pl.body);assert.equal(pl.json().sku,'DEMO-XRF');
  // Partial update keeps the other inputs.
  assert.equal((await call('m5','PATCH','/products/DEMO-XRF/pricing-plan',{actualPrice:5299})).json().landedUsd,2800);
  const it=(await call('m5','GET','/products')).json();const x=it.items.find((i:any)=>i.sku==='DEMO-XRF');
  assert.equal(x.actualPrice,5299);assert.equal(x.priceClass,'standard');assert.equal(it.pricingRules.wholesalePct,10);assert.equal(it.canEditRules,false);
  const basic=(await call('m2','GET','/products')).json();
  assert.equal(basic.pricingRules,undefined);assert.equal(basic.items.find((i:any)=>i.sku==='DEMO-XRF').actualPrice,undefined,'basic access never receives pricing inputs');
  assert.equal((await call('m1','GET','/products')).json().canEditRules,true);
 }finally{await app.close();}
});
