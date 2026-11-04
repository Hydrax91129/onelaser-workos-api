import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createDatabase,schema,seedDemo} from '../src/db.js';
import {buildApp} from '../src/app.js';
import {issueSession} from '../src/auth.js';
import {FIELDS,FIELD,SLOTS,needOf,levelsOf,parseValue,checkRecord,CORE_REQUIRED} from '../src/product-fields.js';

// Fictional data only (CLAUDE.md): SKUs, names and prices below are made up.
const PNG=Buffer.from('89504e470d0a1a0a0000000d49484452','hex');
const PDF=Buffer.from('%PDF-1.4\n%fake\n','latin1');

test('requirement matrix: 主机 keeps every 必填, other families keep only the core fields',()=>{
 assert.equal(FIELD.get('model')!.req,'ronnn');
 assert.equal(needOf(FIELD.get('netWeight')!.req,'main'),'req');
 for(const fam of ['acc','cons','soft','mat'])for(const d of FIELDS){
  const n=needOf(d.req,fam);
  if(CORE_REQUIRED.has(d.key)&&!(d.key==='status'&&fam==='mat'))assert.equal(n,'req',`${d.key} stays required for ${fam}`);else assert.notEqual(n,'req',`${d.key} is not required for ${fam}`);
 }
 assert.equal(needOf(FIELD.get('laserClass')!.req,'acc'),'na');
 assert.equal(needOf(FIELD.get('line')!.req,'mat'),'na');
 assert.equal(needOf(FIELD.get('status')!.req,'mat'),'opt','状态 is 选填 for 内部物料 in the spec (rrrro)');
 assert.equal(SLOTS.find(s=>s.key==='spareParts')!.pdfOnly,true);
 assert.equal(needOf(SLOTS.find(s=>s.key==='warrantyCert')!.req,'acc'),'opt');
 assert.equal(needOf(FIELD.get('status')!.req,null),null);
});

test('value rules: SKU, REFB, lists, numbers with units, dates, barcodes',()=>{
 const p=(k:string,v:unknown)=>parseValue(FIELD.get(k)!,v);
 assert.equal((p('sku','-bad') as any).issue.code,'FIELD_SKU');
 assert.deepEqual(p('refbSku','refb-x1'),{ok:true,value:'REFB-x1'});
 assert.equal((p('refbSku','X1') as any).issue.code,'REFB_PREFIX');
 assert.deepEqual(p('family','配件/备件'),{ok:true,value:'acc'});
 assert.deepEqual(p('status','在售'),{ok:true,value:'live'});
 assert.equal((p('shipMethod','空运') as any).issue.code,'FIELD_NOT_ALLOWED');
 assert.deepEqual(p('netWeight','38 kg'),{ok:true,value:38});
 assert.equal((p('netWeight','约38') as any).issue.code,'FIELD_NUMBER');
 assert.deepEqual(p('msrp','$1,234.5'),{ok:true,value:1234.5});
 assert.deepEqual(p('launchDate','2026/1/5'),{ok:true,value:'2026-01-05'});
 assert.deepEqual(p('launchDate',46000),{ok:true,value:'2025-12-09'},'Excel date serial');
 assert.equal((p('launchDate','2026-02-30') as any).issue.code,'FIELD_DATE');
 assert.deepEqual(p('gtin','036000291452'),{ok:true,value:'036000291452'});
 assert.equal((p('gtin','036000291453') as any).issue.code,'FIELD_GTIN_CHECK');
 assert.deepEqual(p('nameZh','[清空]'),{ok:true,value:null});
 const all=new Set(['all','ops','cost','admin','sens'] as const);
 const r=checkRecord({sku:'X',goodsType:'refurb',family:'acc',nameZh:'甲',nameEn:'A',status:'dev'},{visible:all as any});
 assert.ok(r.errors.some(e=>e.code==='REFB_REQUIRED'));
 assert.ok(checkRecord({sku:'X',goodsType:'bulk',refbSku:'REFB-X',family:'acc',nameZh:'甲',nameEn:'A',status:'dev'},{visible:all as any}).errors.some(e=>e.code==='REFB_ONLY_RETURNS'));
 assert.ok(checkRecord({sku:'X',goodsType:'bulk',family:'main',nameZh:'甲',nameEn:'A',status:'dev',launchDate:'2026-05-01',eolDate:'2026-01-01'},{visible:all as any}).errors.some(e=>e.code==='EOL_BEFORE_LAUNCH'));
});

test('visibility levels follow existing grants',()=>{
 assert.deepEqual([...levelsOf({executive:false,grants:[]})],[]);
 assert.deepEqual([...levelsOf({executive:false,grants:['products']})],['all']);
 assert.deepEqual([...levelsOf({executive:false,grants:['products','supply']})],['all','ops']);
 assert.deepEqual([...levelsOf({executive:false,grants:['products','product_cost_detail']})].sort(),['all','cost','ops','sens']);
 assert.equal(levelsOf({executive:true,grants:[]}).has('admin'),true);
});

test('产品资料 records: server-side visibility, validation, duplicates, history and files',async()=>{
 const db=await createDatabase();await db.exec(schema);await seedDemo(db);
 await db.query(`UPDATE users SET grants='["products"]' WHERE id='m2'`);
 await db.query(`UPDATE users SET grants='["products","products_manage"]' WHERE id='m3'`);
 await db.query(`UPDATE users SET grants='["products","product_cost_detail"]' WHERE id='m5'`);
 await db.query(`UPDATE users SET is_admin=true,grants='[]' WHERE id='m4'`);
 const app=await buildApp({db,integrations:{executiveUserIds:['m1']},completionModel:null,translationModel:null,mailer:null,nudgeIntervalMs:0});
 const tokens:Record<string,string>={};
 const call=async(who:string,method:'GET'|'POST'|'PATCH'|'DELETE',url:string,payload?:any)=>{tokens[who]??=(await issueSession(db,who)).accessToken;return app.inject({method,url,payload,headers:{authorization:'Bearer '+tokens[who]}});};
 try{
  assert.equal((await call('m4','GET','/products/model')).statusCode,403,'in-app admin without grants has no product access');
  const m2=(await call('m2','GET','/products/model')).json();
  assert.ok(m2.fields.some((f:any)=>f.key==='msrp'));
  assert.ok(!m2.fields.some((f:any)=>['landed','supplierMain','hsCode','moq'].includes(f.key)),'basic access sees only 全员 fields');
  assert.deepEqual(m2.slots,[]);assert.equal(m2.canCreate,false);
  const m3=(await call('m3','GET','/products/model')).json();
  assert.ok(m3.fields.some((f:any)=>f.key==='moq'));assert.ok(!m3.fields.some((f:any)=>f.key==='landed'));

  // Validation reports every issue with field and reason
  const bad=await call('m3','POST','/products/records',{values:{sku:'FX-1',goodsType:'退货',family:'主机',nameZh:'虚构机',nameEn:'Fictional',shipMethod:'空运',netWeight:'heavy'}});
  assert.equal(bad.statusCode,400,bad.body);
  const codes=bad.json().error.details.issues.map((i:any)=>i.code).sort();
  assert.deepEqual(codes,['FIELD_NOT_ALLOWED','FIELD_NUMBER','REFB_REQUIRED']);
  assert.equal((await call('m2','POST','/products/records',{values:{sku:'FX-1'}})).statusCode,403,'view-only cannot create');
  assert.equal((await call('m3','POST','/products/records',{values:{sku:'FX-1',family:'main',nameZh:'虚构机',nameEn:'Fictional',landed:100}})).json().error.details.issues[0].code,'FIELD_FORBIDDEN','cannot write a field it cannot see');
  const ok=await call('m3','POST','/products/records',{values:{sku:'FX-1',family:'main',nameZh:'虚构机',nameEn:'Fictional',line:'XRF',netWeight:'12 kg',pkgL:10,pkgW:20,pkgH:30,shipMethod:'快递',moq:'5 台'}});
  assert.equal(ok.statusCode,201,ok.body);
  assert.equal(ok.json().values.status,'dev');assert.equal(ok.json().values.goodsType,'bulk');assert.equal(ok.json().complete,false);
  assert.equal((await call('m3','POST','/products/records',{values:{sku:'fx-1',family:'acc',nameZh:'重复',nameEn:'Dup'}})).statusCode,409,'SKU is unique regardless of case');
  // Same SKU in the legacy catalog view, and WMS/dealers keep using product_catalog.sku
  const legacy=(await call('m2','GET','/products')).json().items.find((x:any)=>x.sku==='FX-1');
  assert.equal(legacy.nameZh,'虚构机');assert.deepEqual(legacy.dims,[10,20,30]);assert.equal(legacy.best,'快递');

  // Cost-access user fills cost fields; basic users never receive them
  const cost=await call('m5','PATCH','/products/records/fx-1',{values:{landed:100,lastMile:20,hsCode:'8456.11.0000'}});
  assert.equal(cost.statusCode,400);assert.deepEqual(cost.json().error.details.issues.map((i:any)=>i.field+':'+i.code),['hsCode:FIELD_FORBIDDEN'],'non-price cost fields need products_manage to edit');
  const c2=await call('m5','PATCH','/products/records/FX-1',{values:{landed:100,lastMile:20}});assert.equal(c2.statusCode,200,c2.body);
  assert.equal((await call('m1','PATCH','/products/records/FX-1',{values:{hsCode:'8456.11.0000',supplierMain:'虚构工厂',msrp:999}})).statusCode,200);
  const asM2=(await call('m2','GET','/products/records/FX-1')).json();
  assert.equal(asM2.values.msrp,999);assert.equal(asM2.values.landed,undefined);assert.equal(asM2.values.supplierMain,undefined);assert.equal(asM2.values.moq,undefined);
  assert.equal((await call('m3','GET','/products/records/FX-1')).json().values.moq,'5 台');
  const asM5=(await call('m5','GET','/products/records/FX-1')).json();
  assert.equal(asM5.values.landed,100);assert.equal(asM5.values.supplierMain,'虚构工厂');assert.equal(asM5.values.hsCode,'8456.11.0000');
  const listM2=JSON.stringify((await call('m2','GET','/products/records')).json());
  assert.ok(!listM2.includes('虚构工厂')&&!listM2.includes('8456'),'list never carries hidden values');
  // History hides fields the viewer cannot see (legacy history route too)
  const h3=(await call('m3','GET','/products/records/FX-1/history')).json();
  assert.ok(h3.changes.some((c:any)=>c.field==='nameZh'));assert.ok(!h3.changes.some((c:any)=>['landed','supplierMain','hsCode'].includes(c.field)));
  assert.ok(!(await call('m3','GET','/products/FX-1/history')).json().changes.some((c:any)=>c.field==='supplierMain'));
  assert.ok((await call('m5','GET','/products/records/FX-1/history')).json().changes.some((c:any)=>c.field==='landed'));

  // Status follows the lifecycle; clearance needs a reason
  assert.equal((await call('m3','PATCH','/products/records/FX-1',{values:{status:'在售'}})).json().error.details.issues[0].code,'STATUS_TRANSITION');
  assert.equal((await call('m3','PATCH','/products/records/FX-1',{values:{status:'停售'}})).json().error.code,'STATUS_NOTE_REQUIRED');
  assert.equal((await call('m3','PATCH','/products/records/FX-1',{values:{status:'上新中'}})).statusCode,200);
  assert.equal((await call('m3','PATCH','/products/records/FX-1',{values:{sku:'FX-2'}})).statusCode,400,'SKU cannot be renamed');
  assert.equal((await call('m3','PATCH','/products/records/FX-1',{values:{replacementSku:'NOPE-9'}})).json().error.details.issues[0].code,'REPLACEMENT_UNKNOWN');
  // Blank / clear marker clears
  assert.equal((await call('m3','PATCH','/products/records/FX-1',{values:{line:'[清空]'}})).json().values.line,null);

  // Files: main image for everyone, 敏感 slots only for cost viewers; PDF-only slots; sniffed types
  const b64=(b:Buffer)=>b.toString('base64');
  assert.equal((await call('m3','POST','/products/records/FX-1/files/mainImage',{name:'a.png',dataBase64:b64(PNG)})).statusCode,201);
  assert.equal((await call('m3','POST','/products/records/FX-1/files/mainImage',{name:'a.png',dataBase64:b64(PDF)})).statusCode,400,'content must match the extension');
  assert.equal((await call('m3','POST','/products/records/FX-1/files/manual',{name:'m.pdf',dataBase64:b64(PDF)})).statusCode,403,'sensitive slots need cost access');
  assert.equal((await call('m1','POST','/products/records/FX-1/files/spareParts',{name:'s.png',dataBase64:b64(PNG)})).statusCode,400,'PDF-only slot');
  const up=await call('m1','POST','/products/records/FX-1/files/spareParts',{name:'备件.pdf',dataBase64:b64(PDF)});assert.equal(up.statusCode,201,up.body);
  const d2=(await call('m2','GET','/products/records/FX-1')).json();
  assert.equal(d2.files.mainImage.length,1);assert.equal(d2.files.spareParts,undefined);
  assert.equal((await call('m2','GET','/products/files/'+up.json().id)).statusCode,404,'hidden file is not found for basic access');
  const got=await call('m5','GET','/products/files/'+up.json().id);assert.equal(got.statusCode,200);assert.equal(got.headers['content-type'],'application/pdf');
  assert.equal((await call('m5','DELETE','/products/files/'+up.json().id)).statusCode,403,'deleting needs products_manage');
  assert.equal((await call('m1','DELETE','/products/files/'+up.json().id)).statusCode,200);
 }finally{await app.close();}
});
