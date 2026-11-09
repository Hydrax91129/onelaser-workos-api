import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createDatabase,schema,seedDemo} from '../src/db.js';
import {buildApp} from '../src/app.js';
import {issueSession} from '../src/auth.js';

test('returns & repairs: register, diagnose, photos, repaired, restock into refurbished stock, price for the website',async()=>{
 const db=await createDatabase();await db.exec(schema);await seedDemo(db);
 const clock=()=>new Date('2026-11-10T18:00:00Z').getTime();
 const app=await buildApp({db,integrations:{executiveUserIds:['m1']},completionModel:null,translationModel:null,mailer:null,nudgeIntervalMs:0,clock});
 const tokens:Record<string,string>={};
 const call=async(who:string,method:'GET'|'POST',url:string,payload?:any)=>{tokens[who]??=(await issueSession(db,who)).accessToken;return app.inject({method,url,payload,headers:{authorization:'Bearer '+tokens[who]}});};
 const png=Buffer.from('89504e470d0a1a0a0000000d49484452','hex').toString('base64');
 try{
  assert.equal((await call('m1','GET','/capabilities')).json().rma,true);
  await call('m1','POST','/wms/import',{asOf:'2026-10-31',rows:[{sku:'DEMO-A',name:'Demo machine A',type:'整机',qty:{us:5}}]});
  await db.query("INSERT INTO product_catalog(org_id,sku,msrp) SELECT org_id,'DEMO-A',4000 FROM users WHERE id='m1'");
  assert.equal((await call('m2','GET','/rma')).statusCode,403,'no warehouse access');
  assert.equal((await call('m1','POST','/rma',{sku:'NOPE',serial:'S1',productClass:'machine',repairable:'yes',condition:'外观完好',reason:'坏了',receivedAt:'2026-11-01'})).statusCode,400,'unknown SKUs that are not RE- are refused');
  assert.equal((await call('m1','POST','/rma',{sku:'DEMO-A',serial:'S1',productClass:'machine',repairable:'yes',condition:'外观完好',reason:'坏了',receivedAt:'2026-12-30'})).statusCode,400,'no future dates');
  const c=await call('m1','POST','/rma',{sku:'demo-a',serial:'SN123',kind:'warranty',productClass:'machine',repairable:'yes',condition:'外观完好',channel:'website',customer:'John',orderRef:'#1001',reason:'开机不出光',receivedAt:'2026-11-01'});
  assert.equal(c.statusCode,201,c.body);assert.equal(c.json().number,'RMA-2026-0001');const id=c.json().id;
  // technicians need warehouse access; m3 gets view, then can work on this case only
  assert.equal((await call('m1','POST',`/rma/${id}/update`,{technicianId:'m2'})).statusCode,400,'m2 has no warehouse access');
  await db.query(`UPDATE users SET grants='["warehouse"]' WHERE id='m3'`);
  assert.equal((await call('m3','POST',`/rma/${id}/update`,{diagnosis:'x'})).statusCode,403);
  assert.equal((await call('m1','POST',`/rma/${id}/update`,{technicianId:'m3'})).statusCode,200);
  assert.equal((await call('m1','GET',`/rma/${id}`)).json().status,'diagnosing');
  assert.equal((await call('m1','GET',`/rma/${id}`)).json().stage,'waiting_repair');
  assert.equal((await call('m1','POST',`/rma/${id}/price`,{discountPct:20})).statusCode,409,'no refurbished discount before the repair is done');
  // waiting for parts needs the parts named
  const wp=await call('m3','POST',`/rma/${id}/update`,{status:'waiting_parts'});assert.equal(wp.statusCode,400);assert.equal(wp.json().error.code,'RMA_PARTS_NEEDED');
  assert.equal((await call('m3','POST',`/rma/${id}/update`,{status:'waiting_parts',waitingFor:'示例激光管 ×1'})).statusCode,200);
  const wpc=(await call('m1','GET',`/rma/${id}`)).json();assert.equal(wpc.stage,'waiting_parts');assert.equal(wpc.waitingFor,'示例激光管 ×1');
  assert.equal((await call('m3','POST',`/rma/${id}/repaired`,{})).statusCode,400,'needs a diagnosis');
  assert.equal((await call('m3','POST',`/rma/${id}/update`,{diagnosis:'激光管老化，更换激光管',partsUsed:'激光管 ×1',status:'repairing'})).statusCode,200);
  assert.equal((await call('m3','POST',`/rma/${id}/update`,{technicianId:'m1'})).statusCode,403,'technician cannot reassign');
  const r1=await call('m3','POST',`/rma/${id}/repaired`,{});assert.equal(r1.statusCode,400);assert.equal(r1.json().error.code,'RMA_NEEDS_PHOTO');
  assert.equal((await call('m3','POST',`/rma/${id}/photos`,{kind:'repaired',name:'after.png',mime:'image/png',dataBase64:png})).statusCode,201);
  assert.equal((await call('m3','POST',`/rma/${id}/photos`,{kind:'repaired',name:'x.svg',mime:'image/svg+xml',dataBase64:png})).statusCode,400);
  const done=await call('m3','POST',`/rma/${id}/repaired`,{repairedAt:'2026-11-06'});assert.equal(done.statusCode,200,done.body);assert.equal(done.json().repairDays,5);
  assert.equal((await call('m1','GET',`/rma/${id}`)).json().stage,'repaired');
  assert.equal((await call('m1','POST',`/rma/${id}/price`,{discountPct:20})).statusCode,200,'the discount can be chosen once repaired');
  assert.equal((await call('m1','POST',`/rma/${id}/price`,{listing:'listed'})).statusCode,409,'listing only after restock');
  assert.equal((await call('m3','POST',`/rma/${id}/close`,{outcome:'restock'})).statusCode,403,'only warehouse managers close');
  assert.equal((await call('m1','POST',`/rma/${id}/close`,{outcome:'restock',grade:'B'})).statusCode,200);
  assert.equal((await call('m1','GET',`/rma/${id}`)).json().discountPct,10,'B 品 = 10% off');
  const sum=(await call('m1','GET','/wms/summary')).json();
  assert.equal(sum.items.find((i:any)=>i.sku==='DEMO-A').qty.refurb,1,'refurbished stock +1');
  assert.ok(sum.movements.some((m:any)=>m.reference==='RMA-2026-0001'&&m.location==='refurb'&&m.qty===1),'WMS movement explains it');
  assert.equal((await call('m3','POST',`/rma/${id}/price`,{discountPct:20})).statusCode,403,'pricing is restricted');
  assert.equal((await call('m1','POST',`/rma/${id}/price`,{discountPct:20,listing:'pending'})).statusCode,200);
  const d=(await call('m1','GET',`/rma/${id}`)).json();
  assert.equal(d.salePrice,3200);assert.equal(d.listing,'pending');assert.equal(d.stage,'restocked');
  assert.equal((await call('m1','POST',`/rma/${id}/price`,{listing:'listed'})).statusCode,200);assert.equal((await call('m1','GET',`/rma/${id}`)).json().stage,'listed');
  assert.equal((await call('m1','POST',`/rma/${id}/price`,{listing:'sold'})).statusCode,200);assert.equal((await call('m1','GET',`/rma/${id}`)).json().stage,'sold');
  let wms=(await call('m1','GET','/wms/summary')).json();
  assert.equal(wms.items.find((i:any)=>i.sku==='DEMO-A').qty.refurb,0,'售出 takes it out of refurbished stock');
  assert.ok(wms.movements.some((m:any)=>m.reference==='RMA-2026-0001'&&m.type==='out'&&m.qty===-1),'goods-out with the RMA number');
  assert.equal((await call('m1','POST',`/rma/${id}/price`,{listing:'sold'})).statusCode,200,'marking sold again changes nothing');
  assert.equal((await call('m1','GET','/wms/summary')).json().items.find((i:any)=>i.sku==='DEMO-A').qty.refurb,0);
  await call('m1','POST',`/rma/${id}/price`,{listing:'pending'});
  wms=(await call('m1','GET','/wms/summary')).json();
  assert.equal(wms.items.find((i:any)=>i.sku==='DEMO-A').qty.refurb,1,'undoing 售出 puts it back');assert.equal(d.repairDays,5);assert.equal(d.photos.length,1);assert.equal(d.grade,'B');
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

async function setupRma(){
 const db=await createDatabase();await db.exec(schema);await seedDemo(db);
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
  const base={qty:1,reason:'客户退货，已退款 $3,499（示例）',condition:'外观轻微划痕，配件齐全',receivedAt:'2026-11-01',repairable:'yes'};
  const noSn=await call('m1','POST','/rma',{...base,sku:'DEMO-A',productClass:'machine'});assert.equal(noSn.statusCode,400);assert.match(noSn.body,/serial/i);
  assert.equal((await call('m1','POST','/rma',{...base,sku:'DEMO-A',productClass:'accessory'})).statusCode,201,'accessories need no serial');
  assert.equal((await call('m1','POST','/rma',{...base,sku:'DEMO-A',productClass:'machine',serial:'SN9',discountPct:20})).statusCode,400,'no discount at registration');
  const r=await call('m1','POST','/rma',{...base,sku:'ref-demo-a',productClass:'machine',serial:'SN9',repairable:'no'});assert.equal(r.statusCode,201,r.body);
  const c=(await call('m1','GET',`/rma/${r.json().id}`)).json();
  assert.equal(c.sku,'REF-demo-a');assert.equal(c.productClass,'machine');assert.equal(c.repairable,'no');assert.equal(c.discountPct,null);assert.equal(c.stage,'waiting_repair');
  const org=(await db.query(`SELECT org_id FROM users WHERE id='m1'`)).rows[0].org_id;
  const it=(await db.query(`SELECT name,type FROM wms_items WHERE org_id=$1 AND sku='REF-demo-a'`,[org])).rows[0];assert.equal(it.type,'return');assert.match(it.name,/退货/);
  assert.equal((await call('m1','POST','/rma',{...base,sku:'REF-demo-a',productClass:'accessory'})).statusCode,201,'the second return reuses the REF- SKU');
  assert.equal((await db.query(`SELECT count(*)::int n FROM wms_items WHERE org_id=$1 AND lower(sku)='ref-demo-a'`,[org])).rows[0].n,1);
  const ph=await call('m1','POST',`/rma/${r.json().id}/photos`,{kind:'listing',name:'front.png',mime:'image/png',dataBase64:Buffer.from([0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a,1,2,3]).toString('base64')});
  assert.ok([200,201].includes(ph.statusCode),ph.body);
 }finally{await app.close();}
});

test('grade sets the discount: A untouched goes back as new stock, B 10% off, C 20% off',async()=>{
 const {app,call}=await setupRma();
 try{
  const base={sku:'DEMO-A',qty:1,productClass:'accessory',repairable:'yes',reason:'示例退货',condition:'示例外观',receivedAt:'2026-11-01'};
  const a=(await call('m1','POST','/rma',base)).json().id;
  assert.equal((await call('m1','POST',`/rma/${a}/close`,{outcome:'restock',grade:'A'})).statusCode,200,'A needs no repair');
  const ca=(await call('m1','GET',`/rma/${a}`)).json();assert.equal(ca.discountPct,0);assert.equal(ca.restockLocation,'us');
  const c=(await call('m1','POST','/rma',base)).json().id;
  assert.equal((await call('m1','POST',`/rma/${c}/close`,{outcome:'restock',grade:'C'})).statusCode,400,'B and C must be repaired first');
 }finally{await app.close();}
});
