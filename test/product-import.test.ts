import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createDatabase,schema,seedDemo} from '../src/db.js';
import {buildApp} from '../src/app.js';
import {issueSession} from '../src/auth.js';
import {readXlsx,writeXlsx,readCsv,writeCsv,unzip} from '../src/xlsx.js';

// Fictional settings and products only.
const SETTINGS={dtcItems:[{name:'示例费用',pct:15}],whItems:[{name:'示例批发费用',pct:5}],mktExtra:10,retailTiers:[{name:'示例标价',cm:20,use:''}],
 whTiers:[{name:'示例档 1',discount:20,floor:false},{name:'示例底线',discount:30,floor:true}],npcr:[20],dtcTarget:'',dtcFloor:10,whTarget:'',whFloor:10,dtcRateOverride:null,whRateOverride:null};

async function setup(){
 const db=await createDatabase();await db.exec(schema);await seedDemo(db);
 await db.query(`UPDATE users SET grants='["products"]' WHERE id='m2'`);
 await db.query(`UPDATE users SET grants='["products","products_manage","product_cost_detail"]' WHERE id='m5'`);
 await db.query(`UPDATE users SET grants='[]' WHERE id='m6'`);
 const app=await buildApp({db,integrations:{executiveUserIds:['m1']},completionModel:null,translationModel:null,mailer:null,nudgeIntervalMs:0});
 const tokens:Record<string,string>={};
 const call=async(who:string,method:'GET'|'POST'|'PATCH'|'PUT',url:string,payload?:any)=>{tokens[who]??=(await issueSession(db,who)).accessToken;return app.inject({method,url,payload,headers:{authorization:'Bearer '+tokens[who]}});};
 assert.equal((await call('m1','PUT','/products/worksheet-settings',SETTINGS)).statusCode,200);
 for(const [sku,values] of [['ODL-A1',{family:'main',nameZh:'示例主机 A',nameEn:'Sample A',msrp:2000,landed:1000,lastMile:100,series:'XRF'}],
   ['ODL-B1',{family:'acc',nameZh:'示例配件 B',nameEn:'Sample B',msrp:100,landed:30}]] as const){
  const r=await call('m1','POST','/products/library',{sku,values});assert.equal(r.statusCode,201,r.body);
 }
 return {db,app,call};
}
const b64=(b:Buffer|string)=>Buffer.from(b).toString('base64');
const grid=(rows:any[][])=>rows.map(r=>[...r]);
const preview=async(call:any,fileName:string,data:Buffer|string,who='m1')=>{const r=await call(who,'POST','/products/library/import/preview',{fileName,dataBase64:b64(data)});return r;};

test('xlsx writer and reader round-trip text, numbers, Chinese and hidden rows',()=>{
 const buf=writeXlsx([{name:'产品资料',rows:[['SKU','中文名','净重（kg）'],['sku','nameZh','netWeight'],['A&B<1>','示例 “引号”',12.5]],hiddenRows:[2],
  lists:[{col:1,values:['甲','乙'],strict:true,firstRow:3,lastRow:10}]},{name:'说明',rows:[['x']]}]);
 const files=unzip(buf);assert.ok(files.get('xl/worksheets/sheet1.xml')!.toString().includes('hidden="1"'));assert.ok(files.get('xl/worksheets/sheet1.xml')!.toString().includes('dataValidation'));
 assert.deepEqual(readXlsx(buf,'产品资料'),[['SKU','中文名','净重（kg）'],['sku','nameZh','netWeight'],['A&B<1>','示例 “引号”',12.5]]);
 assert.deepEqual(readCsv(writeCsv([['a,b','=SUM(1)','x"y'],['1','','中文']])),[['a,b','=SUM(1)','x"y'],['1','','中文']]);
});

test('template: every visible column in spec order, hidden key row, dropdowns, notes, current data; columns follow the downloader',async()=>{
 const {app,call}=await setup();
 try{
  const t=await call('m1','GET','/products/library/template?format=xlsx');assert.equal(t.statusCode,200);
  const rows=readXlsx(t.rawPayload,'产品资料');
  assert.equal(rows[0][0],'SKU');assert.equal(rows[1][0],'sku');
  const keys=rows[1] as string[];
  for(const k of ['goodsType','family','nameZh','status','hsCode','landed','supplier','msrp','map','whOv0','whOv1','safetyStock'])assert.ok(keys.includes(k),k);
  assert.ok(keys.indexOf('nameZh')<keys.indexOf('status')&&keys.indexOf('status')<keys.indexOf('hsCode')&&keys.indexOf('hsCode')<keys.indexOf('landed')&&keys.indexOf('netWeight')<keys.indexOf('supplier'),'spec order');
  const a=rows.find(r=>r[0]==='ODL-A1')!;assert.equal(a[keys.indexOf('family')],'主机');assert.equal(a[keys.indexOf('msrp')],2000);assert.equal(a[keys.indexOf('landed')],1000);
  const files=unzip(t.rawPayload);const sheet=files.get('xl/worksheets/sheet1.xml')!.toString();
  assert.ok(sheet.includes('<row r="2" hidden="1">'));assert.ok(sheet.includes('errorStyle="stop"'));
  assert.ok(files.get('xl/workbook.xml')!.toString().includes('name="说明"'));
  // Columns follow the downloader's level: 全员 never gets cost, supplier, FDA or floor columns, in xlsx or csv.
  for(const who of ['m6','m2']){
   const csv=readCsv((await call(who,'GET','/products/library/template?format=csv')).body);
   for(const k of ['landed','lastMile','supplier','hsCode','customsName','whOv1'])assert.equal(csv[1].includes(k),false,`${who} template leaks ${k}`);
   assert.ok(csv[1].includes('whOv0'));assert.equal(JSON.stringify(csv).includes('1000'),false,'no landed cost value');
   assert.equal(csv[1].includes('fdaAccession'),who==='m2','FDA number is 产品与供应链');
  }
  // Only main admins upload
  assert.equal((await preview(call,'x.csv',writeCsv([['SKU'],['sku'],['ODL-A1']]),'m5')).statusCode,403);
 }finally{await app.close();}
});

test('upload preview: statuses, old → new, errors with row/column/reason, analysis; nothing saved until confirm; undo',async()=>{
 const {db,app,call}=await setup();
 try{
  const t=readXlsx((await call('m1','GET','/products/library/template?format=xlsx')).rawPayload,'产品资料');
  const keys=t[1] as string[],col=(k:string)=>keys.indexOf(k);
  // Unchanged template uploads as all 无变化
  const same=await preview(call,'same.xlsx',writeXlsx([{name:'产品资料',rows:t}]));assert.equal(same.statusCode,200,same.body);
  assert.deepEqual(same.json().analysis.totals,{rows:2,new:0,update:0,same:2,error:0,fieldChanges:0,warnings:same.json().analysis.totals.warnings});
  const g=grid(t);
  const a=g.find(r=>r[0]==='ODL-A1')!;a[col('msrp')]=2200;a[col('status')]='上新中';a[col('series')]='';a[col('model')]='XRF-T';
  const bRow=g.find(r=>r[0]==='ODL-B1')!;bRow[col('landed')]=95;bRow[col('series')]='[清空]';
  const row=(vals:Record<string,any>)=>keys.map(k=>vals[k]??'');
  g.push(row({sku:'odl-a1',nameZh:'重复'}));                                   // duplicate SKU in the file (case-insensitive)
  g.push(row({sku:'ODL-NEW-1',family:'耗材',nameZh:'示例耗材',nameEn:'Sample consumable',msrp:50}));
  g.push(row({sku:'ODL-NEW-2',family:'整机'}));                                  // bad family label, missing names
  g.push(row({sku:'ODL-NEW-3',family:'主机',nameZh:'示例退货',nameEn:'Sample returned',goodsType:'退货',refbSku:'ODL-NEW-3'})); // REFB rule
  g.push(row({sku:'ODL-NEW-4',family:'配件/备件',nameZh:'示例',nameEn:'Sample',launchDate:'2026-13-01',netWeight:'heavy'}));
  const file=writeXlsx([{name:'产品资料',rows:g}]);
  const before=(await db.query('SELECT count(*)::int n FROM product_changes')).rows[0].n;
  const p=await preview(call,'update.xlsx',file);assert.equal(p.statusCode,200,p.body);
  const pv=p.json(),R=(sku:string)=>pv.results.find((r:any)=>r.sku===sku);
  assert.equal(R('ODL-A1').status,'update');
  assert.deepEqual(R('ODL-A1').changes.map((c:any)=>c.key).sort(),['model','msrp','status']);
  assert.deepEqual(R('ODL-A1').changes.find((c:any)=>c.key==='msrp'),{key:'msrp',from:2000,to:2200});
  assert.equal(R('ODL-B1').changes.find((c:any)=>c.key==='series'),undefined,'series was empty already');
  assert.deepEqual(R('ODL-B1').changes.find((c:any)=>c.key==='landed'),{key:'landed',from:30,to:95});
  const dup=pv.results.find((r:any)=>r.sku==='odl-a1');assert.equal(dup.status,'error');assert.match(dup.errors[0].zh,/重复/);
  assert.equal(R('ODL-NEW-1').status,'new');
  const e2=R('ODL-NEW-2');assert.equal(e2.status,'error');assert.ok(e2.errors.some((e:any)=>e.key==='family'&&e.col&&e.header==='产品族'));
  assert.ok(R('ODL-NEW-3').errors.some((e:any)=>e.key==='refbSku'&&/REFB-/.test(e.zh)));
  const e4=R('ODL-NEW-4');assert.ok(e4.errors.some((e:any)=>e.key==='launchDate'));assert.ok(e4.errors.some((e:any)=>e.key==='netWeight'));
  assert.equal(e4.row,g.length,'row numbers are sheet rows');
  const an=pv.analysis;
  assert.equal(an.totals.new,1);assert.equal(an.totals.update,2);assert.equal(an.totals.error,4);
  assert.deepEqual(an.statusChanges,{'dev→launch':1},'new products are not status changes');assert.equal(an.prices.msrp.changed,1);assert.ok(Math.abs(an.prices.msrp.avgPct-10)<1e-9);assert.equal(an.prices.msrp.max.sku,'ODL-A1');
  assert.equal(an.prices.wholesale[0].changed,1,'wholesale follows MSRP');
  assert.ok(an.margins.msrpCmPct.after!=null);assert.equal(an.newByFamily.cons,1);
  assert.ok(an.completeness.after.got>=an.completeness.before.got);
  assert.equal((await db.query('SELECT count(*)::int n FROM product_changes')).rows[0].n,before,'preview writes nothing');
  // Report download
  const rep=await call('m1','GET',`/products/library/import/${pv.id}/report`);assert.equal(rep.statusCode,200);assert.match(rep.body,/有错误/);assert.match(rep.body,/零售价 MSRP/);
  // Errors block confirm unless the admin chooses to skip them
  const no=await call('m1','POST',`/products/library/import/${pv.id}/confirm`,{});assert.equal(no.statusCode,409);assert.equal(no.json().error.code,'IMPORT_HAS_ERRORS');
  assert.equal((await db.query(`SELECT msrp FROM product_catalog WHERE sku='ODL-A1'`)).rows[0].msrp,'2000');
  const ok=await call('m1','POST',`/products/library/import/${pv.id}/confirm`,{skipErrors:true});assert.equal(ok.statusCode,200,ok.body);
  assert.equal(ok.json().skipped,4);
  assert.equal(Number((await db.query(`SELECT msrp FROM product_catalog WHERE sku='ODL-A1'`)).rows[0].msrp),2200);
  assert.equal((await db.query(`SELECT status FROM product_catalog WHERE sku='ODL-A1'`)).rows[0].status,'launch');
  assert.equal((await db.query(`SELECT count(*)::int n FROM product_catalog WHERE sku='ODL-NEW-1'`)).rows[0].n,1);
  assert.equal((await db.query(`SELECT count(*)::int n FROM product_catalog WHERE sku IN ('ODL-NEW-2','ODL-NEW-3','ODL-NEW-4')`)).rows[0].n,0);
  assert.equal((await db.query(`SELECT count(*)::int n FROM product_price_changes WHERE sku='ODL-A1' AND target='msrp' AND status='applied' AND reason LIKE 'import:%'`)).rows[0].n,1,'price history');
  assert.equal((await call('m1','POST',`/products/library/import/${pv.id}/confirm`,{skipErrors:true})).statusCode,409,'a preview applies once');
  // History lists who / when / file / counts
  const hist=(await call('m1','GET','/products/library/imports')).json().items;assert.equal(hist[0].fileName,'update.xlsx');assert.equal(hist[0].summary.update,2);
  // Undo restores the before values; a field edited after the import is kept and listed
  assert.equal((await call('m1','PATCH','/products/library/ODL-B1',{values:{landed:99}})).statusCode,200);
  const u=await call('m1','POST',`/products/library/imports/${hist[0].id}/undo`,{});assert.equal(u.statusCode,200,u.body);
  assert.deepEqual(u.json().kept,[{sku:'ODL-B1',key:'landed',reason:'edited_since'}]);assert.equal(u.json().removed,1);
  assert.equal(Number((await db.query(`SELECT msrp FROM product_catalog WHERE sku='ODL-A1'`)).rows[0].msrp),2000);
  assert.equal((await db.query(`SELECT status FROM product_catalog WHERE sku='ODL-A1'`)).rows[0].status,'dev');
  assert.equal((await db.query(`SELECT attrs FROM product_catalog WHERE sku='ODL-A1'`)).rows[0].attrs.model,undefined);
  assert.equal(Number((await db.query(`SELECT landed_usd FROM product_pricing WHERE sku='ODL-B1'`)).rows[0].landed_usd),99);
  assert.equal((await db.query(`SELECT count(*)::int n FROM product_catalog WHERE sku='ODL-NEW-1'`)).rows[0].n,0,'the product the import created is removed');
  assert.equal((await call('m1','POST',`/products/library/imports/${hist[0].id}/undo`,{})).statusCode,409,'undo once');
 }finally{await app.close();}
});

test('confirm is all or nothing, and refuses a preview the data has moved past',async()=>{
 const {db,app,call}=await setup();
 try{
  const csv=(rows:any[][])=>writeCsv([['SKU','中文名','零售价 MSRP（USD）'],['sku','nameZh','msrp'],...rows]);
  // A failure in the middle of the write rolls back everything (the trigger stands in for any database error).
  await db.exec(`CREATE FUNCTION fail_b1() RETURNS trigger AS $$ BEGIN IF NEW.sku='ODL-B1' AND NEW.name_zh='触发失败' THEN RAISE EXCEPTION 'boom'; END IF; RETURN NEW; END $$ LANGUAGE plpgsql;
   CREATE TRIGGER fail_b1 BEFORE UPDATE ON product_catalog FOR EACH ROW EXECUTE FUNCTION fail_b1();`);
  const p=(await preview(call,'fail.csv',csv([['ODL-A1','改名 A',2100],['ODL-B1','触发失败','']]))).json();
  assert.equal(p.analysis.totals.update,2);
  const r=await call('m1','POST',`/products/library/import/${p.id}/confirm`,{});assert.equal(r.statusCode,500);
  const a=(await db.query(`SELECT name_zh,msrp FROM product_catalog WHERE sku='ODL-A1'`)).rows[0];assert.equal(a.name_zh,'示例主机 A');assert.equal(Number(a.msrp),2000,'nothing applied');
  assert.equal((await db.query(`SELECT count(*)::int n FROM product_imports WHERE kind='library'`)).rows[0].n,0);
  await db.exec('DROP TRIGGER fail_b1 ON product_catalog');
  // Stale preview
  const s=(await preview(call,'stale.csv',csv([['ODL-A1','改名 A','']]))).json();
  assert.equal((await call('m1','PATCH','/products/library/ODL-A1',{values:{nameZh:'别人先改了'}})).statusCode,200);
  const st=await call('m1','POST',`/products/library/import/${s.id}/confirm`,{});assert.equal(st.statusCode,409);assert.equal(st.json().error.code,'IMPORT_PREVIEW_STALE');
  // Headers without the key row still map by the Chinese header; unknown columns are reported and ignored
  const h=await preview(call,'headers.csv',writeCsv([['SKU','中文名','备注栏'],['ODL-A1','新名字','随便']]));assert.equal(h.statusCode,200,h.body);
  assert.deepEqual(h.json().ignoredColumns,['备注栏']);assert.equal(h.json().results[0].changes[0].to,'新名字');
  assert.equal((await preview(call,'x.txt','hello')).statusCode,400);
  assert.equal((await preview(call,'x.csv',writeCsv([['名称'],['a']]))).statusCode,400);
 }finally{await app.close();}
});
