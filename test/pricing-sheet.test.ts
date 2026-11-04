import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createDatabase,schema,seedDemo} from '../src/db.js';
import {buildApp} from '../src/app.js';
import {issueSession} from '../src/auth.js';
import {calc,r99,publicPrices,EMPTY_WORKSHEET,type Worksheet} from '../src/pricing-sheet.js';

// Fictional rates, tiers and costs, chosen for easy arithmetic. Not company numbers.
const W:Worksheet={...EMPTY_WORKSHEET,
 dtcItems:[{name:'甲',pct:10},{name:'乙',pct:5}],whItems:[{name:'丙',pct:4}],mktExtra:5,
 retailTiers:[{name:'标价',cm:25,use:'示例'},{name:'促销',cm:10,use:'示例'}],
 whTiers:[{name:'小单',discount:20},{name:'大单',discount:25},{name:'底线',discount:40}],
 npcr:[20],dtcTarget:'20–25',dtcFloor:12,whTarget:'15',whFloor:30};

test('x99 rounding',()=>{
 assert.equal(r99(6036),5999);assert.equal(r99(1833.33),1799);assert.equal(r99(40),99);assert.equal(r99(null),null);assert.equal(r99(0),null);
});

test('worksheet math follows the spec formulas',()=>{
 const c=calc(W,{landed:1000,lastMile:100,msrp:1999,map:1899,promoFloor:1299,whOv:[null,1450],whFreight:'dealer'});
 assert.equal(c.delivered,1100);assert.equal(c.dtcRate,0.15);assert.equal(c.whRate,0.04);
 // retail tier: 1100 / (1 - 0.15 - 0.25) = 1833.33 → 1799; CM = 1799 × 0.85 − 1100
 assert.equal(c.retail[0].theoretical,1833.33);assert.equal(c.retail[0].list,1799);assert.equal(c.retail[0].contribution,429.15);
 assert.equal(c.retail[0].offMsrp,Math.round((1-1799/1999)*10000)/10000);
 // MSRP CM = 1999 × 0.85 − 1100 = 599.15 (29.97%); promo floor 1299 → 4.15 (0.32%) is below the 12% floor
 assert.equal(c.fixed[0].contribution,599.15);assert.equal(c.fixed[0].belowFloor,false);
 assert.equal(c.fixed[2].contribution,4.15);assert.equal(c.fixed[2].belowFloor,true);
 // wholesale: floor(1999 × 0.8) = 1599; tier 2 manual override 1450; dealer pays freight → landed cost
 assert.equal(c.wholesale[0].price,1599);assert.equal(c.wholesale[0].cmDealerFreight,535.04);assert.equal(c.wholesale[0].cmOurFreight,435.04);
 assert.equal(c.wholesale[0].dealerMargin,400);assert.equal(c.wholesale[0].belowFloor,false);
 assert.equal(c.wholesale[1].price,1450);assert.equal(c.wholesale[1].override,true);assert.equal(c.wholesale[1].effectiveDiscount,Math.round((1-1450/1999)*10000)/10000);
 assert.equal(c.wholesale[1].belowFloor,true,'1450 × 0.96 − 1000 = 392 → 27% < 30%');
 assert.equal(c.wholesale[2].floorTier,true);
 // NPCR 20%: retail 1100 / 0.65; wholesale (dealer freight) 1000 / 0.76; marketplace 1100 / 0.60
 assert.equal(c.npcr[0].retailTheoretical,1692.31);assert.equal(c.npcr[0].retailList,1699);
 assert.equal(c.npcr[0].wholesaleDealerFreight,1315.79);assert.equal(c.npcr[0].wholesaleOurFreight,1447.37);assert.equal(c.npcr[0].marketplace,1833.33);
 assert.equal(calc(W,{landed:1000,lastMile:100,msrp:1999,whFreight:'us'}).wholesale[0].belowFloor,true,'we pay freight: 435.04 / 1599 = 27% < 30%');
 // Without cost nothing is invented
 const none=calc(W,{msrp:1999});assert.equal(none.retail[0].list,null);assert.equal(none.fixed[0].contribution,null);
 // Public view: MAP defaults to MSRP and the floor tier is hidden
 const pub=publicPrices(W,{msrp:1999,whOv:[]});assert.equal(pub.map,1999);assert.deepEqual(pub.wholesale.map(t=>t.price),[1599,1499]);
 // Empty settings (what the repository ships) give no tiers and no rates
 assert.deepEqual(calc(EMPTY_WORKSHEET,{landed:1,msrp:2}).retail,[]);
});

test('价格参数 endpoints: executives edit, cost access reads, others only see public prices',async()=>{
 const db=await createDatabase();await db.exec(schema);await seedDemo(db);
 await db.query(`UPDATE users SET grants='["products","products_manage"]' WHERE id='m3'`);
 await db.query(`UPDATE users SET grants='["products","product_cost_detail"]' WHERE id='m5'`);
 const app=await buildApp({db,integrations:{executiveUserIds:['m1']},completionModel:null,translationModel:null,mailer:null,nudgeIntervalMs:0});
 const tokens:Record<string,string>={};
 const call=async(who:string,method:'GET'|'POST'|'PATCH'|'PUT',url:string,payload?:any)=>{tokens[who]??=(await issueSession(db,who)).accessToken;return app.inject({method,url,payload,headers:{authorization:'Bearer '+tokens[who]}});};
 try{
  const empty=(await call('m5','GET','/products/pricing-settings')).json();
  assert.deepEqual(empty.settings,EMPTY_WORKSHEET,'ships empty');assert.equal(empty.canEdit,false);
  assert.equal((await call('m3','GET','/products/pricing-settings')).statusCode,403);
  assert.equal((await call('m5','PUT','/products/pricing-settings',W)).statusCode,403);
  assert.equal((await call('m1','PUT','/products/pricing-settings',{...W,npcr:[150]})).statusCode,400);
  assert.equal((await call('m1','PUT','/products/pricing-settings',W)).statusCode,200);
  // Saving the older pricing rules keeps the worksheet
  const legacy=(await call('m1','GET','/products/pricing-rules')).json().rules;delete legacy.updatedAt;delete legacy.updatedBy;delete legacy.worksheet;
  assert.equal((await call('m1','PUT','/products/pricing-rules',legacy)).statusCode,200);
  assert.deepEqual((await call('m5','GET','/products/pricing-settings')).json().settings,W);

  assert.equal((await call('m1','POST','/products/records',{values:{sku:'FX-9',family:'main',nameZh:'虚构',nameEn:'Fictional',landed:1000,lastMile:100,msrp:1999}})).statusCode,201);
  const full=(await call('m5','GET','/products/records/FX-9/pricing')).json();
  assert.equal(full.full,true);assert.equal(full.retail[0].list,1799);assert.equal(full.wholesale[0].price,1599);
  const pub=(await call('m3','GET','/products/records/FX-9/pricing')).json();
  assert.equal(pub.full,false);assert.equal(pub.msrp,1999);assert.equal(pub.retail,undefined);assert.equal(pub.wholesale.length,2);
  assert.ok(!JSON.stringify(pub).includes('1100'),'no cost leaks into the public view');
  // A wholesale override below the wholesale floor waits for an executive (approval flow uses the worksheet floors)
  const ov=await call('m5','PATCH','/products/records/FX-9',{values:{wh1:1300}});assert.equal(ov.statusCode,200,ov.body);
  assert.equal(ov.json().prices.wh1.status,'pending');assert.equal(ov.json().values.wh1,null);
  // A MSRP that keeps the DTC floor applies at once
  assert.equal((await call('m5','PATCH','/products/records/FX-9',{values:{msrp:2099}})).json().prices.msrp.status,'applied');
 }finally{await app.close();}
});
