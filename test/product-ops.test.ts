import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createDatabase,schema,seedDemo} from '../src/db.js';
import {buildApp} from '../src/app.js';
import {issueSession} from '../src/auth.js';
import {DEFAULT_PRICING_RULES,priceCheck} from '../src/products.js';

const setup=async()=>{
 const db=await createDatabase();await db.exec(schema);await seedDemo(db);
 await db.query(`UPDATE users SET grants='["products"]' WHERE id='m2'`);
 await db.query(`UPDATE users SET grants='["products","products_manage"]' WHERE id='m3'`);
 await db.query(`UPDATE users SET grants='["products","product_cost_detail"]' WHERE id='m5'`);
 await db.query(`UPDATE users SET grants='["products","pricing_msrp"]' WHERE id='m6'`);
 const app=await buildApp({db,integrations:{executiveUserIds:['m1']},completionModel:null,translationModel:null,mailer:null,nudgeIntervalMs:0});
 const tokens:Record<string,string>={};
 const call=async(who:string,method:'GET'|'POST'|'PUT'|'PATCH',url:string,payload?:any)=>{tokens[who]??=(await issueSession(db,who)).accessToken;return app.inject({method,url,payload,headers:{authorization:'Bearer '+tokens[who]}});};
 return {db,app,call};
};

test('price check: margin floor, platform fees, dealer discount, unknown cost',()=>{
 const R=DEFAULT_PRICING_RULES,cat={msrp:5999,ship_fee:399},pr={landed_usd:2800,last_mile_usd:399};
 assert.deepEqual(priceCheck(R,cat,pr,'actual',4999),{cmPct:27,needs:null});
 assert.equal(priceCheck(R,cat,pr,'actual',3999).needs,'floor');
 assert.equal(priceCheck(R,cat,pr,'amazon',4999).needs,null);
 assert.equal(priceCheck(R,cat,pr,'amazon',4299).needs,'floor','Amazon pays 10 points more in fees');
 assert.equal(priceCheck(R,cat,pr,'actual',2000).needs,'loss');
 assert.equal(priceCheck(R,cat,pr,'dealer',4199).needs,null);
 assert.equal(priceCheck(R,cat,pr,'dealer',3500).needs,'dealer_discount','deeper than large dealer + $100k discount');
 assert.deepEqual(priceCheck(R,cat,{},'actual',100),{cmPct:null,needs:null},'no landed cost: unchecked');
});

test('product editing: create, edit with change log, lifecycle transitions',async()=>{
 const {app,call}=await setup();
 try{
  const body={sku:'DEMO-A',nameZh:'示例机',type:'整机',gross:50,dims:[90,60,40],moq:5,msrp:5999,shipFee:399};
  assert.equal((await call('m2','POST','/products',body)).statusCode,403,'view-only cannot add');
  assert.equal((await call('m6','POST','/products',body)).statusCode,403,'MSRP-only cannot add');
  const c=await call('m3','POST','/products',body);assert.equal(c.statusCode,201,c.body);assert.equal(c.json().status,'dev');assert.equal(c.json().msrpChange.status,'applied');
  assert.equal((await call('m3','POST','/products',{sku:'demo-a'})).statusCode,409);
  const it=(await call('m2','GET','/products')).json().items.find((x:any)=>x.sku==='DEMO-A');
  assert.equal(it.moq,5);assert.equal(it.msrp,5999);assert.equal(it.status,'dev');assert.equal(it.channels,undefined,'basic access gets no channel prices');

  assert.equal((await call('m6','PATCH','/products/DEMO-A',{lead:'30天'})).statusCode,403,'MSRP-only cannot edit details');
  assert.equal((await call('m6','PATCH','/products/DEMO-A',{low:4999})).statusCode,200,'MSRP-only may edit low price');
  const e=await call('m3','PATCH','/products/demo-a',{lead:'30天',gross:50,dims:[90,60,45],reason:'新包装'});
  assert.equal(e.statusCode,200,e.body);assert.deepEqual(e.json().changed.sort(),['dims','lead'],'unchanged gross is not logged');
  assert.equal((await call('m3','PATCH','/products/NOPE',{lead:'x'})).statusCode,404);

  assert.equal((await call('m3','POST','/products/DEMO-A/status',{status:'live'})).statusCode,409,'dev cannot jump to live');
  assert.equal((await call('m3','POST','/products/DEMO-A/status',{status:'launch'})).statusCode,200);
  assert.equal((await call('m3','POST','/products/DEMO-A/status',{status:'live'})).statusCode,200);
  assert.equal((await call('m3','POST','/products/DEMO-A/status',{status:'clearance'})).statusCode,400,'clearance needs a reason');
  assert.equal((await call('m3','POST','/products/DEMO-A/status',{status:'clearance',note:'新款上市'})).statusCode,200);
  assert.equal((await call('m3','POST','/products/DEMO-A/status',{status:'eol',note:'清完'})).statusCode,200);
  assert.equal((await call('m3','POST','/products/DEMO-A/status',{status:'live'})).statusCode,409,'discontinued is final for managers');
  assert.equal((await call('m1','POST','/products/DEMO-A/status',{status:'live'})).statusCode,200,'admins may reopen');
  assert.equal((await call('m2','POST','/products/DEMO-A/status',{status:'eol',note:'x'})).statusCode,403);

  const h=(await call('m2','GET','/products/DEMO-A/history')).json();
  const st=h.changes.filter((x:any)=>x.field==='status').map((x:any)=>x.to);assert.deepEqual(st,['live','eol','clearance','live','launch','dev']);
  assert.equal(h.changes.find((x:any)=>x.field==='status'&&x.to==='clearance').note,'新款上市');
  const dims=h.changes.find((x:any)=>x.field==='dims'&&x.source==='edit');assert.deepEqual(dims.from,[90,60,40]);assert.deepEqual(dims.to,[90,60,45]);assert.equal(dims.note,'新包装');
  assert.ok(h.changes[0].actor.name,'changes name the person');
  assert.equal(h.prices.length,1);assert.equal(h.prices[0].to,5999);assert.equal(h.prices[0].cmPct,undefined,'basic access never sees margins');

  // Import keeps a change log too, and records a new MSRP as applied.
  assert.equal((await call('m3','POST','/products/import',{rows:[{sku:'DEMO-A',lead:'45天',msrp:6199}]})).statusCode,200);
  const h2=(await call('m3','GET','/products/DEMO-A/history')).json();
  assert.equal(h2.changes.find((x:any)=>x.field==='lead').source,'import');assert.equal(h2.prices[0].to,6199);assert.equal(h2.prices[0].reason,'import');
 }finally{await app.close();}
});

test('price changes: below the floor waits for an admin; channel prices',async()=>{
 const {app,call}=await setup();
 try{
  await call('m3','POST','/products',{sku:'DEMO-B',nameZh:'示例机',type:'整机',msrp:5999,shipFee:399});
  assert.equal((await call('m5','PATCH','/products/DEMO-B/pricing-plan',{landedUsd:2800,lastMileUsd:399})).statusCode,200);
  const ok=(await call('m5','PATCH','/products/DEMO-B/pricing-plan',{actualPrice:4999})).json();
  assert.equal(ok.actualPrice,4999);assert.equal(ok.actualChange.status,'applied');assert.equal(ok.actualChange.cmPct,27);
  const low=(await call('m5','PATCH','/products/DEMO-B/pricing-plan',{actualPrice:3999,reason:'黑五'})).json();
  assert.equal(low.actualChange.status,'pending');assert.equal(low.actualChange.needs,'floor');assert.equal(low.actualPrice,4999,'held price does not apply yet');
  // A newer request replaces the waiting one.
  const lower=(await call('m5','PATCH','/products/DEMO-B/pricing-plan',{actualPrice:3899,reason:'黑五最低'})).json();assert.equal(lower.actualChange.status,'pending');
  assert.equal((await call('m5','GET','/products/price-changes')).json().items.length,1,'requester sees own pending request');
  const queue=(await call('m1','GET','/products/price-changes')).json();assert.equal(queue.canDecide,true);assert.equal(queue.items.length,1);assert.equal(queue.items[0].to,3899);assert.equal(queue.items[0].name.zh,'示例机');
  assert.equal((await call('m1','GET','/products/price-changes?status=superseded')).json().items[0].to,3999);
  const id=queue.items[0].id;
  assert.equal((await call('m5','POST',`/products/price-changes/${id}/decide`,{approve:true})).statusCode,403,'only admins approve');
  assert.equal((await call('m1','POST',`/products/price-changes/${id}/decide`,{approve:true,note:'同意黑五'})).statusCode,200);
  assert.equal((await call('m1','POST',`/products/price-changes/${id}/decide`,{approve:false})).statusCode,409,'decided once');
  assert.equal((await call('m5','GET','/products')).json().items.find((x:any)=>x.sku==='DEMO-B').actualPrice,3899);

  // MSRP below the floor from a catalog manager: held, and the manager never sees the margin.
  const m=(await call('m3','PATCH','/products/DEMO-B',{msrp:3999})).json();assert.equal(m.msrpChange.status,'pending');assert.equal(m.msrpChange.cmPct,undefined);
  assert.equal((await call('m2','GET','/products')).json().items.find((x:any)=>x.sku==='DEMO-B').pendingPrices[0].target,'msrp');
  assert.equal((await call('m5','POST',`/products/price-changes/${m.msrpChange.id}/withdraw`)).statusCode,403,'only the requester withdraws');
  assert.equal((await call('m3','POST',`/products/price-changes/${m.msrpChange.id}/withdraw`)).statusCode,200);
  assert.equal((await call('m2','GET','/products')).json().items.find((x:any)=>x.sku==='DEMO-B').msrp,5999);
  assert.equal((await call('m1','PATCH','/products/DEMO-B',{msrp:3999})).json().msrpChange.status,'applied','admins set any price; recorded with its warning');

  // Channel prices.
  assert.equal((await call('m6','PUT','/products/DEMO-B/channel-prices/amazon',{price:4999})).statusCode,403,'MSRP-only cannot set channel prices');
  assert.equal((await call('m5','PUT','/products/DEMO-B/channel-prices/walmart',{price:4999})).statusCode,400);
  const a=(await call('m5','PUT','/products/DEMO-B/channel-prices/amazon',{price:4999})).json();assert.equal(a.price,4999);assert.equal(a.change.status,'applied');
  assert.equal((await call('m5','PUT','/products/DEMO-B/channel-prices/amazon',{price:4299})).json().change.needs,'floor');
  const d=(await call('m5','PUT','/products/DEMO-B/channel-prices/dealer',{price:2500,listed:false})).json();assert.equal(d.listed,false);assert.equal(d.change.status,'pending');
  const view=(await call('m6','GET','/products')).json(),b=view.items.find((x:any)=>x.sku==='DEMO-B');
  assert.equal(b.channels.amazon.price,4999);assert.equal(b.channels.dealer.listed,false);assert.equal(b.landedUsd,undefined,'MSRP-only sees channel prices, not costs');
  assert.equal(view.canEditChannels,false);assert.equal(view.canEditMsrp,true);
  const h=(await call('m6','GET','/products/DEMO-B/history')).json();assert.ok(h.prices.some((x:any)=>x.target==='amazon'));assert.equal(h.prices[0].cmPct,undefined);
  assert.ok(!(await call('m2','GET','/products/DEMO-B/history')).json().prices.some((x:any)=>x.target!=='msrp'),'basic access sees only MSRP history');
 }finally{await app.close();}
});
