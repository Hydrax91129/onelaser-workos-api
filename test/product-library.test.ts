import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createDatabase,schema,seedDemo} from '../src/db.js';
import {buildApp} from '../src/app.js';
import {issueSession} from '../src/auth.js';
import {FIELDS,FIELD,SLOTS,famCode,minReq,parseValue,viewerOf,completeness,CORE_REQUIRED} from '../src/product-spec.js';
import {worksheet,r99,EMPTY_WORKSHEET} from '../src/product-worksheet.js';

// Every number below is fictional. The settings ship empty; tests enter their own made-up rates.
const SETTINGS={dtcItems:[{name:'示例费用 A',pct:10},{name:'示例费用 B',pct:5}],whItems:[{name:'示例批发费用',pct:5}],mktExtra:10,
 retailTiers:[{name:'示例标价',cm:20,use:'示例'}],whTiers:[{name:'示例档 1',discount:20,floor:false},{name:'示例底线',discount:30,floor:true}],
 npcr:[20],dtcTarget:'',dtcFloor:10,whTarget:'',whFloor:10,dtcRateOverride:null,whRateOverride:null};

async function setup(){
 const db=await createDatabase();await db.exec(schema);await seedDemo(db);
 // m1 main admin; m2 product area (ops); m3 products + products_manage; m5 products + cost; m6 no grants (全员 only)
 await db.query(`UPDATE users SET grants='["products"]' WHERE id='m2'`);
 await db.query(`UPDATE users SET grants='["products","products_manage"]' WHERE id='m3'`);
 await db.query(`UPDATE users SET grants='["products","product_cost_detail"]' WHERE id='m5'`);
 await db.query(`UPDATE users SET grants='[]' WHERE id='m6'`);
 const app=await buildApp({db,integrations:{executiveUserIds:['m1']},completionModel:null,translationModel:null,mailer:null,nudgeIntervalMs:0});
 const tokens:Record<string,string>={};
 const call=async(who:string,method:'GET'|'POST'|'PATCH'|'PUT'|'DELETE',url:string,payload?:any)=>{tokens[who]??=(await issueSession(db,who)).accessToken;return app.inject({method,url,payload,headers:{authorization:'Bearer '+tokens[who]}});};
 return {db,app,call};
}

test('requirement matrix: five families, core fields stay required, everything else is optional outside 主机',()=>{
 assert.equal(minReq('nameZh','rrrrr'),'rrrrr');assert.equal(minReq('hsCode','rrrno'),'roono');
 const code=(k:string)=>FIELD.get(k)!.code;
 for(const k of CORE_REQUIRED){const f=FIELD.get(k)!;for(const fam of ['main','acc','cons','soft'])assert.equal(famCode(f.code,fam),'req',`${k} is required for ${fam}`);}
 assert.equal(famCode(code('status'),'mat'),'opt','状态 is optional for 内部物料 (rrrro)');
 assert.equal(famCode(code('series'),'main'),'req');assert.equal(famCode(code('series'),'acc'),'opt');assert.equal(famCode(code('series'),'mat'),'na');
 assert.equal(famCode(code('model'),'main'),'req');assert.equal(famCode(code('model'),'acc'),'opt');assert.equal(famCode(code('model'),'cons'),'na');
 assert.equal(famCode(code('laserClass'),'main'),'req');assert.equal(famCode(code('laserClass'),'cons'),'na');
 assert.equal(famCode(code('msrp'),'soft'),'opt');assert.equal(famCode(code('msrp'),'mat'),'na');
 assert.equal(famCode(code('landed'),'mat'),'opt');assert.equal(famCode(code('netWeight'),'soft'),'na');
 for(const f of FIELDS)for(const fam of ['acc','cons','soft','mat'])if(!CORE_REQUIRED.has(f.key))assert.notEqual(famCode(f.code,fam),'req',`${f.key} must not be required for ${fam}`);
 assert.equal(famCode(SLOTS.find(s=>s.key==='warrantyCert')!.code,'main'),'req');assert.equal(famCode(SLOTS.find(s=>s.key==='warrantyCert')!.code,'acc'),'opt');
 // completeness counts only what the viewer can see
 const vAll=viewerOf([],false),vCost=viewerOf(['products','product_cost_detail'],false);
 const rec={values:{family:'main',goodsType:'bulk',nameZh:'示例',nameEn:'Sample',status:'dev',sku:'X'},files:{}};
 const a=completeness(rec,vAll),b=completeness(rec,vCost);
 assert.ok(b.need>a.need,'cost access adds HS code, suppliers, landed cost and file slots');assert.ok(!a.missing.includes('supplier'));assert.ok(b.missing.includes('supplier'));
 assert.ok(b.missing.includes('file:manual'));
 const refb=completeness({values:{...rec.values,goodsType:'refb'}},vAll);assert.ok(refb.missing.includes('refbSku'),'REFB SKU is required for 退货');
});

test('value rules: SKU, REFB, enums by label, dates, numbers with units, clear marker',()=>{
 const p=(k:string,v:unknown)=>parseValue(FIELD.get(k)!,v);
 assert.equal(p('sku','ODL-TEST-1').ok,true);assert.equal(p('sku','-bad').ok,false);assert.equal(p('sku','bad sku!').ok,false);
 assert.equal(p('refbSku','REFB-ODL-1').ok,true);assert.equal(p('refbSku','ODL-1').ok,false);assert.equal(p('refbSku','refb-x').ok,false);
 assert.deepEqual(p('family','配件/备件'),{ok:true,value:'acc'});assert.deepEqual(p('family','main'),{ok:true,value:'main'});assert.equal(p('family','整机').ok,false);
 assert.deepEqual(p('status','在售'),{ok:true,value:'live'});assert.deepEqual(p('goodsType','退货'),{ok:true,value:'refb'});
 assert.deepEqual(p('launchDate','2026/3/5'),{ok:true,value:'2026-03-05'});assert.equal(p('launchDate','2026-02-30').ok,false);
 assert.deepEqual(p('launchDate',46000),{ok:true,value:'2025-12-09'},'Excel date serial');
 assert.deepEqual(p('netWeight','12.5 kg'),{ok:true,value:12.5});assert.equal(p('netWeight','-3').ok,false);assert.deepEqual(p('msrp','$1,299'),{ok:true,value:1299});
 assert.deepEqual(p('series','[清空]'),{ok:true,value:null});assert.equal(p('gtin','12345').ok,false);assert.deepEqual(p('gtin','0123 4567 8905'),{ok:true,value:'012345678905'});
});

test('price worksheet follows the spec formulas (fictional numbers)',()=>{
 assert.equal(r99(1692.3),1699);assert.equal(r99(6036),5999);assert.equal(r99(40),99);assert.equal(r99(null),null);
 const ws=worksheet({landed:1000,lastMile:100,msrp:2000},SETTINGS as any);
 assert.equal(ws.delivered,1100);assert.ok(Math.abs(ws.dtcRate!-0.15)<1e-9);assert.ok(Math.abs(ws.whRate!-0.05)<1e-9);
 const t=ws.retail[0];assert.ok(Math.abs(t.theory!-1100/0.65)<1e-6);assert.equal(t.list,1699);assert.ok(Math.abs(t.cm!-(1699*0.85-1100))<1e-6);
 assert.ok(Math.abs(ws.fixed[0].cm!-600)<1e-6);assert.ok(Math.abs(ws.fixed[0].cmPct!-0.3)<1e-9);assert.equal(ws.fixed[1].price,2000,'MAP defaults to MSRP');
 const w=ws.wholesale[0];assert.equal(w.price,1600);assert.ok(Math.abs(w.cmDealerFreight!-(1600*0.95-1000))<1e-6);assert.ok(Math.abs(w.cmOurFreight!-(1600*0.95-1100))<1e-6);
 assert.equal(w.dealerMargin,400);assert.equal(ws.wholesale[1].price,1400);
 const n=ws.npcr[0];assert.ok(Math.abs(n.whDealerFreight!-1000/0.75)<1e-6);assert.ok(Math.abs(n.whOurFreight!-1100/0.75)<1e-6);assert.ok(Math.abs(n.marketplace!-2000)<1e-6);
 const ov=worksheet({landed:1000,lastMile:100,msrp:2000,whOv0:1500,whFreight:'us'},SETTINGS as any).wholesale[0];
 assert.equal(ov.price,1500);assert.equal(ov.override,true);assert.ok(Math.abs(ov.discount-25)<1e-9);assert.ok(Math.abs(ov.cm!-(1500*0.95-1100))<1e-6,'we pay freight: delivered cost');
 const low=worksheet({landed:1000,lastMile:100,msrp:1200},SETTINGS as any);assert.equal(low.fixed[0].belowFloor,true);
 const empty=worksheet({landed:1000,msrp:2000},EMPTY_WORKSHEET);assert.equal(empty.dtcRate,null);assert.equal(empty.fixed[0].cm,null);assert.deepEqual(empty.retail,[]);
});

test('product library: visibility on every response, editing rights, SKU and REFB rules, files, history',async()=>{
 const {db,app,call}=await setup();
 try{
  // Settings start empty; only main admins change them; cost viewers can read them.
  assert.equal((await call('m5','GET','/products/worksheet-settings')).json().configured,false);
  assert.equal((await call('m5','PUT','/products/worksheet-settings',SETTINGS)).statusCode,403);
  assert.equal((await call('m1','PUT','/products/worksheet-settings',SETTINGS)).statusCode,200);
  assert.equal((await call('m2','GET','/products/worksheet-settings')).statusCode,403);
  // Create: product managers only; duplicate SKUs are refused case-insensitively.
  assert.equal((await call('m2','POST','/products/library',{sku:'ODL-DEMO-1'})).statusCode,403);
  const c=await call('m3','POST','/products/library',{sku:'ODL-DEMO-1',values:{family:'main',nameZh:'示例主机',nameEn:'Sample machine',series:'XRF',fdaAccession:'ACC-TEST',grossWeight:'52 kg'}});
  assert.equal(c.statusCode,201,c.body);
  assert.equal((await call('m3','POST','/products/library',{sku:'odl-demo-1'})).statusCode,409);
  assert.equal((await call('m3','POST','/products/library',{sku:'bad sku!'})).statusCode,400);
  // Product managers cannot write cost or sensitive fields; cost holders can.
  assert.equal((await call('m3','PATCH','/products/library/ODL-DEMO-1',{values:{supplier:'示例工厂'}})).statusCode,400);
  const s=await call('m5','PATCH','/products/library/odl-demo-1',{values:{supplier:'示例工厂',landed:1000,lastMile:100,hsCode:'0000.00.0000'}});assert.equal(s.statusCode,200,s.body);
  assert.equal((await call('m1','PATCH','/products/library/ODL-DEMO-1',{values:{msrp:2000,map:1900}})).statusCode,200);
  // Core fields cannot be cleared; REFB rules
  assert.equal((await call('m3','PATCH','/products/library/ODL-DEMO-1',{values:{nameZh:null}})).statusCode,400);
  assert.equal((await call('m3','PATCH','/products/library/ODL-DEMO-1',{values:{refbSku:'REFB-ODL-DEMO-1'}})).statusCode,400,'only 退货 products carry a REFB SKU');
  assert.equal((await call('m3','PATCH','/products/library/ODL-DEMO-1',{values:{goodsType:'退货',refbSku:'ODL-1'}})).statusCode,400,'REFB- prefix');
  // Status changes follow the lifecycle and need a reason into clearance
  assert.equal((await call('m3','PATCH','/products/library/ODL-DEMO-1',{values:{status:'在售'}})).statusCode,409,'dev cannot jump to live');
  assert.equal((await call('m3','PATCH','/products/library/ODL-DEMO-1',{values:{status:'上新中'}})).statusCode,200);

  const lib=async(who:string)=>{const r=await call(who,'GET','/products/library');assert.equal(r.statusCode,200,r.body);return r.json();};
  const everyone=await lib('m6'),ops=await lib('m2'),cost=await lib('m5'),admin=await lib('m1');
  const item=(d:any)=>d.items.find((x:any)=>x.sku==='ODL-DEMO-1');
  // 全员: basic fields and public prices only
  assert.equal(item(everyone).values.nameZh,'示例主机');assert.equal(item(everyone).values.grossWeight,52);
  for(const k of ['fdaAccession','hsCode','supplier','landed','lastMile','moqUnit'])assert.equal(k in item(everyone).values,false,`全员 must not receive ${k}`);
  assert.equal(item(everyone).files,undefined);assert.equal(item(everyone).pricing.msrp,2000);assert.equal(item(everyone).pricing.delivered,undefined);
  assert.deepEqual(item(everyone).pricing.wholesale.map((w:any)=>w.price),[1600],'the floor tier is hidden');
  assert.equal(everyone.settings.dtcItems,undefined,'rates stay hidden');assert.equal(JSON.stringify(everyone).includes('示例工厂'),false);
  assert.equal(everyone.spec.fields.some((f:any)=>f.key==='supplier'),false);assert.equal(everyone.spec.slots.length,0);
  // 产品与供应链: + FDA number, MOQ; still no cost
  assert.equal(item(ops).values.fdaAccession,'ACC-TEST');assert.equal('hsCode' in item(ops).values,false);assert.equal('supplier' in item(ops).values,false);
  // cost holders see cost, suppliers and the worksheet
  assert.equal(item(cost).values.supplier,'示例工厂');assert.equal(item(cost).values.hsCode,'0000.00.0000');assert.equal(item(cost).pricing.delivered,1100);
  assert.ok(Math.abs(item(cost).pricing.fixed[0].cmPct-0.3)<1e-9);assert.equal(item(admin).pricing.wholesale.length,2);
  assert.equal(admin.viewer.canImport,true);assert.equal(cost.viewer.canImport,false);
  // Files: sensitive slots for cost holders only; PDF-only slots; main image for product managers
  const pdf=Buffer.from('%PDF-1.4 fictional').toString('base64');
  assert.equal((await call('m3','POST','/products/library/ODL-DEMO-1/files/manual',{name:'manual.pdf',dataBase64:pdf})).statusCode,403);
  assert.equal((await call('m5','POST','/products/library/ODL-DEMO-1/files/spareParts',{name:'parts.csv',dataBase64:pdf})).statusCode,400,'PDF only');
  assert.equal((await call('m5','POST','/products/library/ODL-DEMO-1/files/manual',{name:'manual.docx',dataBase64:pdf})).statusCode,400,'Word not accepted');
  const up=await call('m5','POST','/products/library/ODL-DEMO-1/files/manual',{name:'manual-v1.pdf',dataBase64:pdf});assert.equal(up.statusCode,201,up.body);
  assert.equal((await call('m6','GET','/products/library/files/'+up.json().id)).statusCode,404,'全员 cannot download sensitive files');
  assert.equal((await call('m2','GET','/products/library/files/'+up.json().id)).statusCode,404);
  const dl=await call('m5','GET','/products/library/files/'+up.json().id);assert.equal(dl.statusCode,200);assert.equal(dl.headers['content-type'],'application/pdf');
  const png=Buffer.from([0x89,0x50,0x4e,0x47]).toString('base64');
  const img=await call('m3','POST','/products/library/ODL-DEMO-1/files/mainImage',{name:'main.png',dataBase64:png});assert.equal(img.statusCode,201,img.body);
  assert.equal((await call('m6','GET','/products/library/files/'+img.json().id)).statusCode,200,'everyone sees the main image');
  assert.equal(item(await lib('m5')).files.manual.length,1);
  // History is filtered too
  const hist=async(who:string)=>(await call(who,'GET','/products/library/ODL-DEMO-1/history')).json().items.map((x:any)=>x.field);
  const hAll=await hist('m6'),hCost=await hist('m5');
  assert.ok(hAll.includes('nameZh'));assert.ok(hAll.includes('msrp'));
  for(const k of ['supplier','landed','hsCode','fdaAccession','file:manual'])assert.equal(hAll.includes(k),false,`history leaks ${k}`);
  assert.ok(hCost.includes('supplier'));assert.ok(hCost.includes('landed'));
  // The old endpoint keeps its own rules and reads the same SKU row (one SKU table)
  assert.equal((await call('m2','GET','/products')).json().items.find((x:any)=>x.sku==='ODL-DEMO-1').msrp,2000);
  assert.equal((await db.query(`SELECT count(*)::int n FROM product_catalog WHERE lower(sku)='odl-demo-1'`)).rows[0].n,1);
 }finally{await app.close();}
});
