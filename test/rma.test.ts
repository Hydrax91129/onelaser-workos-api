import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createDatabase,schema,seedDemo} from '../src/db.js';
import {buildApp} from '../src/app.js';
import {issueSession} from '../src/auth.js';

test('returns & repairs: register, diagnose, photos, repaired, put away for sale inside the returns module (no WMS stock), price for the website',async()=>{
 const db=await createDatabase();await db.exec(schema);await seedDemo(db);
 await db.query(`INSERT INTO product_catalog(org_id,sku,name_zh,msrp) SELECT org_id,'DEMO-A','示例主机 A',1000 FROM users WHERE id='m1' ON CONFLICT DO NOTHING`); // returns link to a product-library SKU
 const clock=()=>new Date('2026-11-10T18:00:00Z').getTime();
 const app=await buildApp({db,integrations:{executiveUserIds:['m1']},completionModel:null,translationModel:null,mailer:null,nudgeIntervalMs:0,clock});
 const tokens:Record<string,string>={};
 const call=async(who:string,method:'GET'|'POST',url:string,payload?:any)=>{tokens[who]??=(await issueSession(db,who)).accessToken;return app.inject({method,url,payload,headers:{authorization:'Bearer '+tokens[who]}});};
 const png=Buffer.from('89504e470d0a1a0a0000000d49484452','hex').toString('base64');
 try{
  assert.equal((await call('m1','GET','/capabilities')).json().rma,true);
  await call('m1','POST','/wms/import',{asOf:'2026-10-31',rows:[{sku:'DEMO-A',name:'Demo machine A',type:'整机',qty:{us:5}}]});
  await db.query("INSERT INTO product_catalog(org_id,sku,msrp) SELECT org_id,'DEMO-A',4000 FROM users WHERE id='m1' ON CONFLICT(org_id,sku) DO UPDATE SET msrp=EXCLUDED.msrp");
  assert.equal((await call('m2','GET','/rma')).statusCode,403,'no returns access');
  assert.equal((await call('m1','POST','/rma',{sku:'NOPE',serial:'S1',productClass:'machine',repairable:'yes',condition:'外观完好',reason:'坏了',receivedAt:'2026-11-01'})).statusCode,400,'unknown SKUs that are not RE- are refused');
  assert.equal((await call('m1','POST','/rma',{sku:'DEMO-A',serial:'S1',productClass:'machine',repairable:'yes',condition:'外观完好',reason:'坏了',receivedAt:'2026-12-30'})).statusCode,400,'no future dates');
  const c=await call('m1','POST','/rma',{sku:'demo-a',serial:'SN123',kind:'warranty',productClass:'machine',repairable:'yes',condition:'外观完好',channel:'website',customer:'John',orderRef:'#1001',reason:'开机不出光',receivedAt:'2026-11-01'});
  assert.equal(c.statusCode,201,c.body);assert.equal(c.json().number,'RMA-2026-0001');const id=c.json().id;
  // technicians need returns access (its own grant, set on the returns page); m3 gets view, then can work on this case only
  assert.equal((await call('m1','POST',`/rma/${id}/update`,{technicianId:'m2'})).statusCode,400,'m2 has no returns access');
  await db.query(`UPDATE users SET grants='["returns"]' WHERE id='m3'`);
  assert.equal((await call('m3','POST',`/rma/${id}/update`,{diagnosis:'x'})).statusCode,403);
  assert.equal((await call('m1','POST',`/rma/${id}/update`,{technicianId:'m3'})).statusCode,200);
  assert.equal((await call('m1','GET',`/rma/${id}`)).json().status,'diagnosing');
  assert.equal((await call('m1','GET',`/rma/${id}`)).json().stage,'waiting_repair');
  assert.equal((await call('m1','POST',`/rma/${id}/price`,{discountPct:20})).statusCode,409,'no refurbished discount before the repair is done');
  // waiting for parts needs the parts named
  const wp=await call('m3','POST',`/rma/${id}/update`,{status:'waiting_parts'});assert.equal(wp.statusCode,400);assert.equal(wp.json().error.code,'RMA_PARTS_NEEDED');
  assert.equal((await call('m3','POST',`/rma/${id}/update`,{status:'waiting_parts',waitingFor:'示例激光管 ×1',repairable:'yes'})).statusCode,200);
  assert.equal((await call('m1','GET',`/rma/${id}`)).json().repairable,'yes','repairable is judged in the repair step');
  const wpc=(await call('m1','GET',`/rma/${id}`)).json();assert.equal(wpc.stage,'waiting_parts');assert.equal(wpc.waitingFor,'示例激光管 ×1');
  assert.equal((await call('m3','POST',`/rma/${id}/repaired`,{})).statusCode,400,'needs a diagnosis');
  assert.equal((await call('m3','POST',`/rma/${id}/update`,{diagnosis:'激光管老化，更换激光管',partsUsed:'激光管 ×1',status:'repairing'})).statusCode,200);
  assert.equal((await call('m3','POST',`/rma/${id}/update`,{technicianId:'m1'})).statusCode,403,'technician cannot reassign');
  const r1=await call('m3','POST',`/rma/${id}/repaired`,{});assert.equal(r1.statusCode,400);assert.equal(r1.json().error.code,'RMA_NEEDS_PHOTO');
  assert.equal((await call('m3','POST',`/rma/${id}/photos`,{kind:'diagnosis',name:'diagnosis.png',mime:'image/png',dataBase64:png})).statusCode,201);
  assert.equal((await call('m3','POST',`/rma/${id}/photos`,{kind:'diagnosis',name:'x.svg',mime:'image/svg+xml',dataBase64:png})).statusCode,400);
  const done=await call('m3','POST',`/rma/${id}/repaired`,{repairedAt:'2026-11-06'});assert.equal(done.statusCode,200,done.body);assert.equal(done.json().repairDays,5);
  assert.equal((await call('m1','GET',`/rma/${id}`)).json().stage,'repaired');
  assert.equal((await call('m1','POST',`/rma/${id}/price`,{discountPct:20})).statusCode,200,'the discount can be chosen once repaired');
  assert.equal((await call('m1','POST',`/rma/${id}/price`,{listing:'listed'})).statusCode,409,'listing only after restock');
  assert.equal((await call('m3','POST',`/rma/${id}/close`,{outcome:'restock'})).statusCode,403,'only warehouse managers close');
  assert.equal((await call('m1','POST',`/rma/${id}/close`,{outcome:'restock',grade:'C'})).statusCode,200);
  assert.equal((await call('m1','GET',`/rma/${id}`)).json().discountPct,10,'B 品 = 10% off');
  // Returns are not regular stock: nothing is written to WMS and WMS has no returns warehouse.
  const sum=(await call('m1','GET','/wms/summary')).json();
  assert.deepEqual(sum.locations.map((l:any)=>l.zh),['美国LA仓','东莞工厂仓','济南工厂仓','在途运输中']);
  assert.equal(Object.values(sum.items.find((i:any)=>i.sku==='DEMO-A').qty).reduce((a:number,b:any)=>a+Number(b),0),5,'regular stock unchanged');
  assert.ok(!sum.movements.some((m:any)=>m.reference==='RMA-2026-0001'),'no WMS movement for the return');
  assert.equal((await call('m3','POST',`/rma/${id}/price`,{discountPct:20})).statusCode,403,'pricing is restricted');
  assert.equal((await call('m1','POST',`/rma/${id}/price`,{discountPct:20,listing:'pending'})).statusCode,200);
  const d=(await call('m1','GET',`/rma/${id}`)).json();
  assert.equal(d.salePrice,3200);assert.equal(d.listing,'pending');assert.equal(d.stage,'restocked');
  assert.equal((await call('m1','POST',`/rma/${id}/price`,{listing:'listed'})).statusCode,200);assert.equal((await call('m1','GET',`/rma/${id}`)).json().stage,'listed');
  assert.equal((await call('m1','POST',`/rma/${id}/price`,{listing:'sold'})).statusCode,200);assert.equal((await call('m1','GET',`/rma/${id}`)).json().stage,'sold');
  let wms=(await call('m1','GET','/wms/summary')).json();
  assert.ok(!wms.movements.some((m:any)=>m.reference==='RMA-2026-0001'),'售出 stays in the returns module');
  assert.equal((await call('m1','POST',`/rma/${id}/price`,{listing:'sold'})).statusCode,200,'marking sold again changes nothing');
  await call('m1','POST',`/rma/${id}/price`,{listing:'pending'});
  wms=(await call('m1','GET','/wms/summary')).json();
  assert.equal((await call('m1','GET',`/rma/${id}`)).json().stage,'restocked','undoing 售出 puts it back in the returns module');assert.ok(!wms.movements.some((m:any)=>m.reference==='RMA-2026-0001'));assert.equal(d.repairDays,5);assert.equal(d.photos.length,1);assert.equal(d.grade,'C');
  assert.ok(d.events.length>=5);
  const img=await call('m1','GET',`/rma/${id}/photos/${d.photos[0].id}`);assert.equal(img.headers['content-type'],'image/png');
  assert.equal((await call('m1','POST',`/rma/${id}/update`,{diagnosis:'y'})).statusCode,409,'closed');
  // second case scrapped
  const c2=(await call('m1','POST','/rma',{sku:'DEMO-A',qty:2,productClass:'accessory',repairable:'no',condition:'外壳破损',reason:'外壳破损',receivedAt:'2026-11-09'})).json();
  assert.equal(c2.number,'RMA-2026-0002');
  assert.equal((await call('m1','POST',`/rma/${c2.id}/close`,{outcome:'scrap'})).statusCode,200);
  const list=(await call('m1','GET','/rma')).json();assert.equal(list.items.length,2);assert.equal(list.items[0].status,'scrapped');
 }finally{await app.close();}
});

test('returns stay out of regular stock: REF- SKUs never show or move in WMS, no returns warehouse; received dates are checked and fixable',async()=>{
 const {app,call}=await setupRma();
 try{
  const ref=await call('m1','POST','/rma',{sku:'REF-DEMO-A',serial:'SN-REF',productClass:'machine',condition:'外观完好',reason:'示例',receivedAt:'2026-11-01'});assert.equal(ref.statusCode,201,ref.body);
  assert.ok(!(await call('m1','GET','/wms/summary')).json().items.some((i:any)=>/^REF-/i.test(i.sku)),'REF- SKUs never show in regular stock');
  const refMove=await call('m1','POST','/wms/movements',{type:'in',sku:'REF-DEMO-A',location:'us',qty:1,reason:'示例入库'});assert.equal(refMove.statusCode,400);assert.equal(refMove.json().error.code,'WMS_RETURN_SKU');
  assert.equal((await call('m1','POST','/wms/movements',{type:'in',sku:'DEMO-A',location:'refurb',qty:1,reason:'示例入库'})).statusCode,400,'no returns warehouse');
  assert.equal((await call('m1','POST','/rma',{sku:'DEMO-A',serial:'SN-OLD',productClass:'machine',condition:'外观完好',reason:'示例',receivedAt:'0001-01-01'})).json().error.code,'RMA_OLD_DATE');
  assert.equal((await call('m1','POST',`/rma/${ref.json().id}/update`,{receivedAt:'2026-10-30'})).statusCode,200,'managers can fix the received date');
 }finally{await app.close();}
});

async function setupRma(){
 const db=await createDatabase();await db.exec(schema);await seedDemo(db);
 await db.query(`INSERT INTO product_catalog(org_id,sku,name_zh,msrp) SELECT org_id,'DEMO-A','示例主机 A',1000 FROM users WHERE id='m1' ON CONFLICT DO NOTHING`); // returns link to a product-library SKU
 const clock=()=>new Date('2026-11-10T18:00:00Z').getTime();
 const app=await buildApp({db,integrations:{executiveUserIds:['m1']},completionModel:null,translationModel:null,mailer:null,nudgeIntervalMs:0,clock});
 const tokens:Record<string,string>={};
 const call=async(who:string,method:'GET'|'POST',url:string,payload?:any)=>{tokens[who]??=(await issueSession(db,who)).accessToken;return app.inject({method,url,payload,headers:{authorization:'Bearer '+tokens[who]}});};
 await call('m1','POST','/wms/import',{asOf:'2026-10-31',rows:[{sku:'DEMO-A',name:'Demo machine A',type:'整机',qty:{us:5}}]});
 return {db,app,call};
}

test('register a return: item class, serial required for machines, repairable, no discount yet, and a new REF- SKU is added to WMS',async()=>{
 const {db,app,call}=await setupRma();
 try{
  const base={qty:1,reason:'客户退货，已退款 $3,499（示例）',condition:'外观轻微划痕，配件齐全',receivedAt:'2026-11-01'};
  const noSn=await call('m1','POST','/rma',{...base,sku:'DEMO-A',productClass:'machine'});assert.equal(noSn.statusCode,400);assert.match(noSn.body,/serial/i);
  assert.equal((await call('m1','POST','/rma',{...base,sku:'DEMO-A',productClass:'accessory'})).statusCode,201,'accessories need no serial');
  assert.equal((await call('m1','POST','/rma',{...base,sku:'DEMO-A',productClass:'machine',serial:'SN9',discountPct:20})).statusCode,400,'no discount at registration');
  const r=await call('m1','POST','/rma',{...base,sku:'ref-demo-a',productClass:'machine',serial:'SN9',repairable:'no'});assert.equal(r.statusCode,201,r.body);
  const c=(await call('m1','GET',`/rma/${r.json().id}`)).json();
  assert.equal(c.sku,'REF-demo-a');assert.equal(c.productClass,'machine');assert.equal(c.repairable,'no','repairable may still be sent');assert.equal(c.discountPct,null);assert.equal(c.stage,'waiting_repair');
  const org=(await db.query(`SELECT org_id FROM users WHERE id='m1'`)).rows[0].org_id;
  await db.query(`INSERT INTO product_catalog(org_id,sku,msrp) VALUES($1,'DEMO-A',4000) ON CONFLICT(org_id,sku) DO UPDATE SET msrp=EXCLUDED.msrp`,[org]);
  assert.equal((await call('m1','GET',`/rma/${r.json().id}`)).json().msrp,4000,'a REF- SKU uses the MSRP of its model');
  const it=(await db.query(`SELECT name,type FROM wms_items WHERE org_id=$1 AND sku='REF-demo-a'`,[org])).rows[0];assert.equal(it.type,'return');assert.match(it.name,/退货/);
  assert.equal((await call('m1','POST','/rma',{...base,sku:'REF-demo-a',productClass:'accessory'})).statusCode,201,'the second return reuses the REF- SKU');
  assert.equal((await db.query(`SELECT count(*)::int n FROM wms_items WHERE org_id=$1 AND lower(sku)='ref-demo-a'`,[org])).rows[0].n,1);
  const ph=await call('m1','POST',`/rma/${r.json().id}/photos`,{kind:'listing',name:'front.png',mime:'image/png',dataBase64:Buffer.from([0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a,1,2,3]).toString('base64')});
  assert.ok([200,201].includes(ph.statusCode),ph.body);
 }finally{await app.close();}
});

test('grade sets the discount: A new, B open box 5%, C open box used 10%, D used 15%, E damaged but working 20%',async()=>{
 const {app,call}=await setupRma();
 try{
  const base={sku:'DEMO-A',qty:1,productClass:'accessory',repairable:'yes',reason:'示例退货',condition:'示例外观',receivedAt:'2026-11-01'};
  const a=(await call('m1','POST','/rma',base)).json().id;
  assert.equal((await call('m1','POST',`/rma/${a}/close`,{outcome:'restock',grade:'A'})).statusCode,200,'A needs no repair');
  const ca=(await call('m1','GET',`/rma/${a}`)).json();assert.equal(ca.discountPct,0);assert.equal(ca.restockLocation,null,'returns are not regular stock');
  const c=(await call('m1','POST','/rma',base)).json().id;
  assert.equal((await call('m1','POST',`/rma/${c}/close`,{outcome:'restock',grade:'C'})).statusCode,400,'B to E must be repaired first');
  const png=Buffer.from('89504e470d0a1a0a0000000d49484452','hex').toString('base64');
  for(const [g,pct] of [['B',5],['C',10],['D',15],['E',20]] as const){
   const id=(await call('m1','POST','/rma',base)).json().id;
   assert.equal((await call('m1','POST',`/rma/${id}/update`,{technicianId:'m1',diagnosis:'示例诊断'})).statusCode,200);
   assert.equal((await call('m1','POST',`/rma/${id}/photos`,{kind:'diagnosis',name:'d.png',mime:'image/png',dataBase64:png})).statusCode,201);
   const rp=await call('m1','POST',`/rma/${id}/repaired`,{repairedAt:'2026-11-02'});assert.equal(rp.statusCode,200,rp.body);
   const r=await call('m1','POST',`/rma/${id}/close`,{outcome:'restock',grade:g});assert.equal(r.statusCode,200,r.body);
   const d=(await call('m1','GET',`/rma/${id}`)).json();assert.equal(d.discountPct,pct,g);assert.equal(d.grade,g);
  }
  assert.equal((await call('m1','POST',`/rma/${a}/close`,{outcome:'restock',grade:'F'})).statusCode,400,'only A–E');
 }finally{await app.close();}
});

test('grades A / B 10% / C 20% become A–E once by the discount each case got',async()=>{
 const db=await createDatabase();await db.exec(schema);await seedDemo(db);
 const org=(await db.query("SELECT org_id FROM users WHERE id='m1'")).rows[0].org_id;
 const add=(n:string,grade:string,pct:number)=>db.query(`INSERT INTO rma_cases(id,org_id,number,sku,qty,kind,reason,received_at,status,grade,discount_pct,created_by) VALUES($1,$2,$1,'REF-DEMO',1,'return','示例','2026-10-01','restocked',$3,$4,'m1')`,[n,org,grade,pct]);
 await add('OLD-B','B',10);await add('OLD-C','C',20);await add('OLD-A','A',0);
 const app=await buildApp({db,integrations:{executiveUserIds:['m1']},completionModel:null,translationModel:null,mailer:null,nudgeIntervalMs:0});
 try{
  const rows=Object.fromEntries((await db.query(`SELECT id,grade,discount_pct FROM rma_cases WHERE id LIKE 'OLD-%'`)).rows.map((r:any)=>[r.id,[r.grade,Number(r.discount_pct)]]));
  assert.deepEqual(rows,{'OLD-B':['C',10],'OLD-C':['E',20],'OLD-A':['A',0]},'letters follow the discount kept');
  await db.query(`UPDATE rma_cases SET grade='B',discount_pct=5 WHERE id='OLD-A'`);
  const {migrateRmaGrades}=await import('../src/rma.js');await migrateRmaGrades(db);
  assert.equal((await db.query(`SELECT grade FROM rma_cases WHERE id='OLD-A'`)).rows[0].grade,'B','runs once: new B 5% stays B');
 }finally{await app.close();}
});

test('returns: handler and technician are two people; the return links to a product-library SKU; values by stage (MSRP for everyone, cost for cost access)',async()=>{
 const db=await createDatabase();await db.exec(schema);await seedDemo(db);
 const org=(await db.query("SELECT org_id FROM users WHERE id='m1'")).rows[0].org_id;
 await db.query(`INSERT INTO product_catalog(org_id,sku,name_zh,msrp) VALUES($1,'DEMO-M',$2,1000)`,[org,'示例主机 M']);
 await db.query(`INSERT INTO product_pricing(org_id,sku,landed_usd) VALUES($1,'DEMO-M',400) ON CONFLICT(org_id,sku) DO UPDATE SET landed_usd=400`,[org]);
 await db.query(`UPDATE users SET grants='["returns","returns_manage"]' WHERE id='m2'`);await db.query(`UPDATE users SET grants='["returns"]' WHERE id='m3'`);
 const app=await buildApp({db,integrations:{executiveUserIds:['m1']},completionModel:null,translationModel:null,mailer:null,nudgeIntervalMs:0});
 const tokens:Record<string,string>={};
 const call=async(who:string,method:'GET'|'POST',url:string,payload?:any)=>{tokens[who]??=(await issueSession(db,who)).accessToken;return app.inject({method,url,payload,headers:{authorization:'Bearer '+tokens[who],'accept-language':'zh-CN'}});};
 try{
  const base={productClass:'machine',serial:'SN-DEMO-1',reason:'示例：开机不出光',condition:'示例：外箱破损',receivedAt:'2026-11-05'};
  const bad=await call('m1','POST','/rma',{...base,sku:'REF-NOTHING-1'});assert.equal(bad.statusCode,400);assert.match(bad.json().error.message,/主 SKU/,'a made-up return SKU needs a main SKU from the product library');
  assert.equal((await call('m1','POST','/rma',{...base,sku:'REF-CUSTOM-9',mainSku:'DEMO-M',handlerId:'m3'})).json().error.code,'RMA_HANDLER','the handler manages returns');
  const r=await call('m1','POST','/rma',{...base,sku:'REF-CUSTOM-9',mainSku:'demo-m',handlerId:'m2',qty:2});assert.equal(r.statusCode,201,r.body);
  await call('m1','POST',`/rma/${r.json().id}/update`,{technicianId:'m3'});
  const all=(await call('m1','GET','/rma')).json(), c=all.items.find((x:any)=>x.id===r.json().id);
  assert.deepEqual([c.mainSku,c.mainName,c.handlerName!=='',c.technicianId],['DEMO-M','示例主机 M',true,'m3'],'handler and technician both shown');
  assert.equal(c.valueMsrp,2000);assert.equal(c.valueCost,800);
  assert.equal(all.values.msrp.total,2000);assert.equal(all.values.msrp.unrepaired,2000);assert.equal(all.values.cost.unrepaired,800);
  const m3=(await call('m3','GET','/rma')).json();assert.equal(m3.values.cost,undefined,'no cost values without cost access');assert.equal(m3.items[0].valueCost,undefined);
 }finally{await app.close();}
});

test('photos can be deleted: managers any photo, the technician only their own; the history says so',async()=>{
 const {db,app,call}=await setupRma();
 try{
  const png=Buffer.from('89504e470d0a1a0a0000000d49484452','hex').toString('base64');
  await db.query(`UPDATE users SET grants='["returns"]' WHERE id='m3'`);
  const id=(await call('m1','POST','/rma',{sku:'DEMO-A',qty:1,productClass:'accessory',repairable:'yes',reason:'示例退货',condition:'示例外观',receivedAt:'2026-11-01'})).json().id;
  assert.equal((await call('m1','POST',`/rma/${id}/update`,{technicianId:'m3'})).statusCode,200);
  const mine=(await call('m1','POST',`/rma/${id}/photos`,{kind:'received',name:'manager.png',mime:'image/png',dataBase64:png})).json().id;
  const tech=(await call('m3','POST',`/rma/${id}/photos`,{kind:'diagnosis',name:'tech.png',mime:'image/png',dataBase64:png})).json().id;
  assert.equal((await call('m3','POST',`/rma/${id}/photos/${mine}/delete`)).statusCode,403,'technician cannot delete the manager’s photo');
  assert.equal((await call('m3','POST',`/rma/${id}/photos/${tech}/delete`)).statusCode,200,'technician deletes their own');
  assert.equal((await call('m1','POST',`/rma/${id}/photos/${mine}/delete`)).statusCode,200,'manager deletes any');
  assert.equal((await call('m1','POST',`/rma/${id}/photos/${mine}/delete`)).statusCode,404,'gone');
  const d=(await call('m1','GET',`/rma/${id}`)).json();assert.equal(d.photos.length,0);
  assert.equal(d.events.filter((e:any)=>String(e.action).startsWith('photo_deleted:')).length,2,'history keeps both deletions');
 }finally{await app.close();}
});
