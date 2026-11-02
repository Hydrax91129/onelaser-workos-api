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
  assert.equal((await call('m1','POST','/rma',{sku:'NOPE',kind:'return',reason:'坏了',receivedAt:'2026-11-01'})).statusCode,400,'SKUs are never created here');
  assert.equal((await call('m1','POST','/rma',{sku:'DEMO-A',kind:'return',reason:'坏了',receivedAt:'2026-12-30'})).statusCode,400,'no future dates');
  const c=await call('m1','POST','/rma',{sku:'demo-a',serial:'SN123',kind:'warranty',channel:'website',customer:'John',orderRef:'#1001',reason:'开机不出光',receivedAt:'2026-11-01'});
  assert.equal(c.statusCode,201,c.body);assert.equal(c.json().number,'RMA-2026-0001');const id=c.json().id;
  // technicians need warehouse access; m3 gets view, then can work on this case only
  assert.equal((await call('m1','POST',`/rma/${id}/update`,{technicianId:'m2'})).statusCode,400,'m2 has no warehouse access');
  await db.query(`UPDATE users SET grants='["warehouse"]' WHERE id='m3'`);
  assert.equal((await call('m3','POST',`/rma/${id}/update`,{diagnosis:'x'})).statusCode,403);
  assert.equal((await call('m1','POST',`/rma/${id}/update`,{technicianId:'m3'})).statusCode,200);
  assert.equal((await call('m1','GET',`/rma/${id}`)).json().status,'diagnosing');
  assert.equal((await call('m3','POST',`/rma/${id}/repaired`,{})).statusCode,400,'needs a diagnosis');
  assert.equal((await call('m3','POST',`/rma/${id}/update`,{diagnosis:'激光管老化，更换激光管',partsUsed:'激光管 ×1',status:'repairing'})).statusCode,200);
  assert.equal((await call('m3','POST',`/rma/${id}/update`,{technicianId:'m1'})).statusCode,403,'technician cannot reassign');
  const r1=await call('m3','POST',`/rma/${id}/repaired`,{});assert.equal(r1.statusCode,400);assert.equal(r1.json().error.code,'RMA_NEEDS_PHOTO');
  assert.equal((await call('m3','POST',`/rma/${id}/photos`,{kind:'repaired',name:'after.png',mime:'image/png',dataBase64:png})).statusCode,201);
  assert.equal((await call('m3','POST',`/rma/${id}/photos`,{kind:'repaired',name:'x.svg',mime:'image/svg+xml',dataBase64:png})).statusCode,400);
  const done=await call('m3','POST',`/rma/${id}/repaired`,{repairedAt:'2026-11-06'});assert.equal(done.statusCode,200,done.body);assert.equal(done.json().repairDays,5);
  assert.equal((await call('m1','POST',`/rma/${id}/price`,{discountPct:20})).statusCode,409,'price only after restock');
  assert.equal((await call('m3','POST',`/rma/${id}/close`,{outcome:'restock'})).statusCode,403,'only warehouse managers close');
  assert.equal((await call('m1','POST',`/rma/${id}/close`,{outcome:'restock',grade:'A'})).statusCode,200);
  const sum=(await call('m1','GET','/wms/summary')).json();
  assert.equal(sum.items.find((i:any)=>i.sku==='DEMO-A').qty.refurb,1,'refurbished stock +1');
  assert.ok(sum.movements.some((m:any)=>m.reference==='RMA-2026-0001'&&m.location==='refurb'&&m.qty===1),'WMS movement explains it');
  assert.equal((await call('m3','POST',`/rma/${id}/price`,{discountPct:20})).statusCode,403,'pricing is restricted');
  assert.equal((await call('m1','POST',`/rma/${id}/price`,{discountPct:20,listing:'pending'})).statusCode,200);
  const d=(await call('m1','GET',`/rma/${id}`)).json();
  assert.equal(d.salePrice,3200);assert.equal(d.listing,'pending');assert.equal(d.repairDays,5);assert.equal(d.photos.length,1);assert.equal(d.grade,'A');
  assert.ok(d.events.length>=5);
  const img=await call('m1','GET',`/rma/${id}/photos/${d.photos[0].id}`);assert.equal(img.headers['content-type'],'image/png');
  assert.equal((await call('m1','POST',`/rma/${id}/update`,{diagnosis:'y'})).statusCode,409,'closed');
  // second case scrapped
  const c2=(await call('m1','POST','/rma',{sku:'DEMO-A',qty:2,kind:'return',reason:'外壳破损',receivedAt:'2026-11-09'})).json();
  assert.equal(c2.number,'RMA-2026-0002');
  assert.equal((await call('m1','POST',`/rma/${c2.id}/close`,{outcome:'scrap'})).statusCode,200);
  const list=(await call('m1','GET','/rma')).json();assert.equal(list.items.length,2);assert.equal(list.items[0].status,'scrapped');
 }finally{await app.close();}
});
