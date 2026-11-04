import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createDatabase,schema,seedDemo} from '../src/db.js';
import {buildApp} from '../src/app.js';
import {issueSession} from '../src/auth.js';
import {readXlsx,writeXlsx,readCsv,writeCsv} from '../src/xlsx.js';
import {EMPTY_WORKSHEET} from '../src/pricing-sheet.js';

// Fictional products, prices and rates only.
const setup=async()=>{
 const db=await createDatabase();await db.exec(schema);await seedDemo(db);
 await db.query(`UPDATE users SET grants='["products"]' WHERE id='m2'`);
 await db.query(`UPDATE users SET grants='["products","products_manage"]' WHERE id='m3'`);
 await db.query(`UPDATE users SET grants='["products","product_cost_detail"]' WHERE id='m5'`);
 const app=await buildApp({db,integrations:{executiveUserIds:['m1']},completionModel:null,translationModel:null,mailer:null,nudgeIntervalMs:0});
 const tokens:Record<string,string>={};
 const call=async(who:string,method:'GET'|'POST'|'PATCH'|'PUT',url:string,payload?:any)=>{tokens[who]??=(await issueSession(db,who)).accessToken;return app.inject({method,url,payload,headers:{authorization:'Bearer '+tokens[who]}});};
 const mk=async(values:any)=>{const r=await call('m1','POST','/products/records',{values});assert.equal(r.statusCode,201,r.body);};
 await call('m1','PUT','/products/pricing-settings',{...EMPTY_WORKSHEET,dtcItems:[{name:'甲',pct:15}],whItems:[{name:'乙',pct:4}],whTiers:[{name:'小单',discount:20},{name:'底线',discount:40}],dtcFloor:12,whFloor:20});
 await mk({sku:'FX-1',family:'main',nameZh:'虚构机一',nameEn:'Fictional One',status:'在售',msrp:1000,map:950,landed:500,lastMile:50,supplierMain:'虚构工厂'});
 await db.query(`UPDATE product_catalog SET status='live' WHERE sku='FX-1'`);
 await mk({sku:'FX-2',family:'acc',nameZh:'虚构配件',nameEn:'Fictional Part',msrp:100,line:'XRF'});
 return {db,app,call};
};
const b64=(b:Buffer)=>b.toString('base64');

test('template: columns follow the downloader, keys row, dropdowns, notes, current data; xlsx and csv',async()=>{
 const {app,call}=await setup();
 try{
  assert.equal((await call('m2','GET','/products/template')).statusCode,403,'view-only cannot download the bulk template');
  assert.equal((await call('m5','GET','/products/template')).statusCode,403,'cost access alone cannot import');
  const t3=await call('m3','GET','/products/template');assert.equal(t3.statusCode,200);
  assert.match(String(t3.headers['content-type']),/spreadsheetml/);
  const rows=readXlsx(t3.rawPayload,['产品资料']);
  assert.equal(rows[1][0],'sku');assert.equal(rows[0][0],'SKU *');
  assert.ok(rows[1].includes('moq'));
  for(const hidden of ['landed','lastMile','supplierMain','hsCode','wh1','mainImage'])assert.ok(!rows[1].includes(hidden),`${hidden} is not in a products_manage template`);
  const fx1=rows.find(r=>r[0]==='FX-1')!;assert.equal(fx1[rows[1].indexOf('status')],'在售');assert.equal(fx1[rows[1].indexOf('family')],'主机');
  assert.ok(!JSON.stringify(rows).includes('虚构工厂'));
  const notes=readXlsx(t3.rawPayload,['填写说明']);assert.ok(notes.some(r=>r[2]==='netWeight'&&r[6]==='必填'&&r[7]==='选填'));
  const t1=readXlsx((await call('m1','GET','/products/template')).rawPayload,['产品资料']);
  assert.ok(t1[1].includes('landed')&&t1[1].includes('supplierMain')&&t1[1].includes('wh1')&&t1[1].includes('wh2')&&!t1[1].includes('wh3'),'executive template has cost columns and the configured wholesale tiers');
  assert.equal(t1[0][t1[1].indexOf('wh1')],'批发价手动调整 · 小单 (USD)');
  const csv=await call('m3','GET','/products/template?format=csv');assert.equal(csv.rawPayload.subarray(0,3).toString('hex'),'efbbbf','UTF-8 BOM');
  assert.deepEqual(readCsv(csv.rawPayload)[1],rows[1]);
 }finally{await app.close();}
});

test('upload → preview (nothing saved) → confirm with skipped errors → history → undo',async()=>{
 const {db,app,call}=await setup();
 try{
  const tpl=readXlsx((await call('m1','GET','/products/template')).rawPayload,['产品资料']);
  const keys=tpl[1] as string[],col=(k:string)=>keys.indexOf(k);
  const row=(vals:Record<string,any>)=>keys.map(k=>vals[k]??null);
  const fx1=[...tpl.find(r=>r[0]==='FX-1')!];fx1[col('nameZh')]='虚构机一代';fx1[col('msrp')]=1100;fx1[col('status')]='清库存';fx1[col('netWeight')]='12 kg';
  const fx2=tpl.find(r=>r[0]==='FX-2')!.map(():any=>null);fx2[0]='fx-2';fx2[col('line')]='[清空]';
  const rows=[tpl[0],tpl[1],fx1,fx2,
   row({sku:'FX-3',family:'耗材',nameZh:'虚构耗材',nameEn:'Fictional Supply',goodsType:'大货',msrp:20}),
   row({sku:'FX-4',family:'玩具',nameZh:'坏行',nameEn:'Bad'}),
   row({sku:'FX-3',family:'耗材',nameZh:'重复',nameEn:'Dup'}),
   row({sku:'FX-5',family:'配件/备件',nameZh:'退货件',nameEn:'Refurb',goodsType:'退货',refbSku:'X5'}),
  ];
  const file=writeXlsx([{name:'产品资料',rows}]);
  assert.equal((await call('m2','POST','/products/imports/preview',{fileName:'a.xlsx',dataBase64:b64(file)})).statusCode,403);
  const pv=await call('m1','POST','/products/imports/preview',{fileName:'批量.xlsx',dataBase64:b64(file)});
  assert.equal(pv.statusCode,201,pv.body);const p=pv.json();
  assert.deepEqual(p.rows.map((r:any)=>r.status),['update','update','new','error','error','error']);
  const r1=p.rows[0];assert.deepEqual(r1.changes.map((c:any)=>c.field).sort(),['msrp','nameZh','netWeight','status']);
  assert.deepEqual(r1.changes.find((c:any)=>c.field==='status'),{field:'status',label:'状态',from:'在售',to:'清库存'});
  assert.deepEqual(p.rows[1].changes,[{field:'line',label:'产品线 / 系列',from:'XRF',to:null}],'blank = no change, [清空] clears');
  const e4=p.rows[3].errors[0];assert.equal(e4.code,'FIELD_NOT_ALLOWED');assert.equal(p.rows[3].row,6);assert.equal(e4.column,'D');assert.equal(e4.header,'产品族 *');
  assert.equal(p.rows[4].errors[0].code,'SKU_DUPLICATE_FILE');assert.equal(p.rows[5].errors[0].code,'REFB_PREFIX');
  const a=p.analysis;
  assert.deepEqual(a.totals,{rows:6,new:1,updated:2,unchanged:0,errors:3,fieldsChanged:a.totals.fieldsChanged,warnings:a.totals.warnings});
  assert.deepEqual(a.statusChanges,{'在售 → 清库存':1});
  assert.deepEqual(a.newByFamily,{'耗材':1});
  const ms=a.prices.find((x:any)=>x.field==='msrp');assert.equal(ms.changed,2);assert.equal(ms.newlySet,1);assert.equal(ms.averagePct,0.1);assert.deepEqual(ms.largest,{sku:'FX-1',pct:0.1});
  assert.equal(a.margins.products,3);
  assert.equal(a.margins.before.averageMsrpCmPct,0.3,'1000 × 0.85 − 550 = 300 → 30%');
  assert.equal(a.margins.after.averageMsrpCmPct,Math.round((1100*0.85-550)/1100*10000)/10000);
  assert.ok(a.completeness.after.got>a.completeness.before.got);
  assert.equal(p.canConfirm,false);assert.equal(p.canSkipErrors,true);
  // Nothing is saved by the preview
  assert.equal((await call('m1','GET','/products/records/FX-1')).json().values.nameZh,'虚构机一');
  // The preview can be downloaded as a report
  const rep=await call('m1','GET',`/products/imports/${p.id}/report`);assert.equal(rep.statusCode,200);assert.ok(rep.body.includes('虚构机一代')&&rep.body.includes('D 列'));
  // Confirm needs an explicit choice when rows have errors; others cannot confirm someone else's upload
  assert.equal((await call('m1','POST',`/products/imports/${p.id}/confirm`,{})).json().error.code,'IMPORT_HAS_ERRORS');
  assert.equal((await call('m3','POST',`/products/imports/${p.id}/confirm`,{skipErrors:true})).statusCode,404);
  const ok=await call('m1','POST',`/products/imports/${p.id}/confirm`,{skipErrors:true});assert.equal(ok.statusCode,200,ok.body);
  assert.deepEqual({...(ok.json() as any),id:undefined},{id:undefined,status:'applied',created:1,updated:2,skipped:3,unchanged:0,pendingPrices:0});
  assert.equal((await call('m1','POST',`/products/imports/${p.id}/confirm`,{skipErrors:true})).statusCode,409,'a preview applies once');
  const after=(await call('m1','GET','/products/records/FX-1')).json().values;
  assert.equal(after.nameZh,'虚构机一代');assert.equal(after.msrp,1100);assert.equal(after.status,'clearance');assert.equal(after.netWeight,12);
  assert.equal((await call('m1','GET','/products/records/FX-2')).json().values.line,null);
  assert.equal((await call('m1','GET','/products/records/FX-3')).statusCode,200);
  assert.equal((await call('m1','GET','/products/records/FX-4')).statusCode,404,'error rows were skipped');
  const hist=(await call('m1','GET','/products/records/FX-1/history')).json();assert.ok(hist.changes.some((c:any)=>c.field==='nameZh'&&c.source==='import'));
  const list=(await call('m1','GET','/products/imports')).json().items;assert.equal(list[0].fileName,'批量.xlsx');assert.equal(list[0].counts.created,1);assert.equal(list[0].canUndo,true);
  // Undo restores the before values and removes the product it created
  const un=await call('m1','POST',`/products/imports/${p.id}/undo`,{});assert.equal(un.statusCode,200,un.body);
  const back=(await call('m1','GET','/products/records/FX-1')).json().values;
  assert.equal(back.nameZh,'虚构机一');assert.equal(back.msrp,1000);assert.equal(back.status,'live');assert.equal(back.netWeight,null);
  assert.equal((await call('m1','GET','/products/records/FX-2')).json().values.line,'XRF');
  assert.equal((await call('m1','GET','/products/records/FX-3')).statusCode,404);
  assert.equal((await call('m1','POST',`/products/imports/${p.id}/undo`,{})).statusCode,409);
  assert.equal((await db.query(`SELECT status FROM product_imports WHERE id=$1`,[p.id])).rows[0].status,'undone');
 }finally{await app.close();}
});

test('confirm is all-or-nothing; stale previews and later edits block confirm/undo; csv upload',async()=>{
 const {db,app,call}=await setup();
 try{
  const up=async(rows:any[][],name='x.csv')=>(await call('m3','POST','/products/imports/preview',{fileName:name,dataBase64:b64(name.endsWith('.csv')?writeCsv(rows):writeXlsx([{name:'产品资料',rows}]))})).json();
  const head=[['SKU *','中文名 *'],['sku','nameZh']];
  // A database failure on the second row rolls back the first
  await db.exec(`CREATE FUNCTION fx_fail() RETURNS trigger AS $$ BEGIN IF NEW.name_zh='触发失败' THEN RAISE EXCEPTION 'boom'; END IF; RETURN NEW; END $$ LANGUAGE plpgsql;
   CREATE TRIGGER fx_fail BEFORE UPDATE ON product_catalog FOR EACH ROW EXECUTE FUNCTION fx_fail();`);
  const p1=await up([...head,['FX-1','改名一'],['FX-2','触发失败']]);
  assert.equal(p1.analysis.totals.updated,2);
  assert.equal((await call('m3','POST',`/products/imports/${p1.id}/confirm`,{})).statusCode,500);
  assert.equal((await call('m1','GET','/products/records/FX-1')).json().values.nameZh,'虚构机一','first row rolled back');
  assert.equal((await db.query(`SELECT status FROM product_imports WHERE id=$1`,[p1.id])).rows[0].status,'preview');
  await db.exec(`DROP TRIGGER fx_fail ON product_catalog`);
  // Someone edits after the preview → re-upload needed
  const p2=await up([...head,['fx-1','改名二']]);
  await call('m1','PATCH','/products/records/FX-1',{values:{nameEn:'Changed meanwhile'}});
  assert.equal((await call('m3','POST',`/products/imports/${p2.id}/confirm`,{})).json().error.code,'IMPORT_STALE');
  // CSV upload works; the header row alone (no key row) is enough
  const p3=await up([['SKU *','中文名 *','包装长 (cm)'],['FX-1','改名三','40']]);
  assert.deepEqual(p3.rows[0].changes.map((c:any)=>c.field).sort(),['nameZh','pkgL']);
  assert.equal((await call('m3','POST',`/products/imports/${p3.id}/confirm`,{})).statusCode,200);
  // Undo is refused when a field changed after the import
  await call('m3','PATCH','/products/records/FX-1',{values:{nameZh:'后来又改'}});
  const un=await call('m3','POST',`/products/imports/${p3.id}/undo`,{});assert.equal(un.json().error.code,'IMPORT_UNDO_CONFLICT');
  assert.equal(un.json().error.details.conflicts[0].field,'nameZh');
  // Columns the uploader may not edit are ignored with a note, never applied
  const p4=await up([['sku','landed','nameEn'],['FX-1','1','Ok']],'y.xlsx');
  assert.equal(p4.ignoredColumns[0].header,'landed');assert.deepEqual(p4.rows[0].changes.map((c:any)=>c.field),['nameEn']);
  assert.equal(p4.analysis.margins,null,'no margin analysis without cost access');
  // Non-executives' prices below the floor wait for approval instead of applying
  const p5=await up([['sku','msrp'],['FX-1','560']],'z.xlsx');
  const c5=(await call('m3','POST',`/products/imports/${p5.id}/confirm`,{})).json();assert.equal(c5.pendingPrices,1);
  assert.equal((await call('m1','GET','/products/records/FX-1')).json().values.msrp,1000);
  // Garbage files are refused cleanly
  assert.equal((await call('m3','POST','/products/imports/preview',{fileName:'x.xlsx',dataBase64:b64(Buffer.from('not a zip'))})).json().error.code,'IMPORT_FILE_UNREADABLE');
  assert.equal((await call('m3','POST','/products/imports/preview',{fileName:'x.txt',dataBase64:b64(Buffer.from('a'))})).json().error.code,'IMPORT_FILE_TYPE');
  assert.equal((await call('m3','POST','/products/imports/preview',{fileName:'x.csv',dataBase64:b64(writeCsv([['名字'],['甲']]))})).json().error.code,'IMPORT_NO_SKU_COLUMN');
 }finally{await app.close();}
});
