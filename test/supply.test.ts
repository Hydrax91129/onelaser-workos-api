import {test} from 'node:test';
import assert from 'node:assert/strict';
import Fastify from 'fastify';
import {createDatabase,schema,seedDemo} from '../src/db.js';
import {buildApp} from '../src/app.js';
import {issueSession} from '../src/auth.js';
import {assess,fifoAge,registerSupplyRoutes,SUPPLY_DEFAULTS} from '../src/supply.js';

const DAY=86400000;
const ymd=(offsetDays:number)=>new Date(Date.now()+offsetDays*DAY).toISOString().slice(0,10);

test('supply: FIFO stock age counts the newest arrivals as on hand',()=>{
 const now=Date.UTC(2026,10,6);
 const a=fifoAge(30,[{at:now-100*DAY,qty:20},{at:now-10*DAY,qty:20}],now);
 assert.equal(a.oldestAge,100);assert.equal(a.avgAge,Math.round((20*10+10*100)/30));assert.equal(a.known,true);
 const b=fifoAge(50,[{at:now-5*DAY,qty:20}],now);
 assert.equal(b.known,false,'more on hand than the ledger explains');assert.equal(b.oldestAge,5);
 assert.equal(fifoAge(0,[],now).oldestAge,null);
});

test('supply: health states follow the company rules (40 days ocean, 30 days safety, aged > 60, excess > 120 days of cover)',()=>{
 const base={us:0,transit:0,factory:0,onOrder:0,ds7:0,ds30:0,ds90:0,oldestAge:null,nextEtaDays:null,type:'配件',status:''};
 assert.equal(assess({...base,us:20,ds30:1},SUPPLY_DEFAULTS).state,'stockout','20 days of cover, nothing on the water');
 assert.equal(assess({...base,us:20,transit:200,ds30:1,nextEtaDays:10},SUPPLY_DEFAULTS).flags.includes('stockout'),false,'the next ship lands first');
 const r=assess({...base,us:60,ds30:1,nextEtaDays:30,transit:10},SUPPLY_DEFAULTS);
 assert.equal(r.state,'reorder');assert.ok(r.reorderQty>0);
 assert.equal(assess({...base,us:500,ds30:2},SUPPLY_DEFAULTS).state,'excess');
 assert.equal(assess({...base,us:200,ds30:2,oldestAge:61},SUPPLY_DEFAULTS).state,'aged');
 assert.equal(assess({...base,us:5},SUPPLY_DEFAULTS).state,'idle');
 assert.equal(assess({...base,us:5,ds30:1,status:'eol'},SUPPLY_DEFAULTS).flags.includes('stockout'),false,'winding-down SKUs are not reordered');
 const t1=assess({...base,us:40,factory:120,ds30:1.1},SUPPLY_DEFAULTS),t2=assess({...base,us:40,factory:120,booked:100,ds30:1.1},SUPPLY_DEFAULTS);
 assert.equal(t2.transferQty,t1.transferQty-100,'factory units already booked on a ship are not suggested again');
});

// Demo org: m1 is the company owner; m5 gets supply manage, m6 gets warehouse manage, m2 has nothing.
test('supply: overview from the WMS ledger, shipments sail and are received with counted quantities',async()=>{
 const db=await createDatabase();await db.exec(schema);await seedDemo(db);
 const app=await buildApp({db,integrations:{executiveUserIds:['m1']},completionModel:null,translationModel:null,mailer:null,nudgeIntervalMs:0});
 const tokens:Record<string,string>={};
 const call=async(who:string,method:'GET'|'POST'|'PATCH'|'PUT',url:string,payload?:any)=>{tokens[who]??=(await issueSession(db,who)).accessToken;return app.inject({method,url,payload,headers:{authorization:'Bearer '+tokens[who]}});};
 const ov=async(who='m1')=>(await call(who,'GET','/supply/overview')).json();
 const item=async(sku:string)=>(await ov()).items.find((i:any)=>i.sku===sku);
 try{
  assert.equal((await call('m1','GET','/capabilities')).json().supplyChain,true);
  for(const [userId,area] of [['m5','supply'],['m6','warehouse']]) assert.equal((await call('m1','POST','/erp/access',{userId,area,level:'manage'})).statusCode,200);
  const rows=[{sku:'DEMO-A',name:'Demo machine A',type:'整机',qty:{us:10,dg:50}},{sku:'DEMO-B',name:'Demo part B',type:'配件',qty:{us:900}},{sku:'DEMO-C',name:'Demo part C',type:'配件',qty:{us:5}}];
  assert.equal((await call('m1','POST','/wms/import',{asOf:ymd(0),rows})).statusCode,200);
  for(const [sku,qty] of [['DEMO-A',6],['DEMO-B',3]] as const) assert.equal((await call('m1','POST','/wms/movements',{type:'out',sku,location:'us',qty,reason:'销售发货',reference:'SO-'+sku})).statusCode,201);
  assert.equal((await call('m1','POST','/wms/movements',{type:'out',sku:'DEMO-A',location:'dg',qty:1,reason:'样品',reference:'S-1'})).statusCode,201,'factory goods out is not US sales');

  assert.equal((await call('m2','GET','/supply/overview')).statusCode,403);
  const v5=await ov('m5');assert.equal(v5.canManage,true);assert.equal(v5.canReceive,false);assert.equal(v5.canSeeValue,false);assert.equal(v5.items[0].unitUsd,undefined,'no cost without the cost grant');
  let a=await item('DEMO-A');
  assert.equal(a.ds30,0.2);assert.equal(a.qty.us,4);assert.equal(a.state,'stockout');
  assert.equal((await item('DEMO-C')).state,'idle');
  assert.equal((await item('DEMO-B')).state,'excess');

  // Opening stock age: received dates per batch (owners only).
  assert.equal((await call('m5','POST','/supply/lots/import',{asOf:ymd(0),rows:[{sku:'DEMO-B',receivedOn:ymd(-100),qty:900}]})).statusCode,403);
  assert.equal((await call('m1','POST','/supply/lots/import',{asOf:ymd(0),rows:[{sku:'DEMO-B',receivedOn:ymd(5),qty:9}]})).statusCode,400,'future date');
  assert.equal((await call('m1','POST','/supply/lots/import',{asOf:ymd(0),rows:[{sku:'DEMO-B',receivedOn:ymd(-100),qty:900}]})).statusCode,200);
  const b=await item('DEMO-B');assert.ok(b.oldestAge>=99,String(b.oldestAge));assert.ok(b.flags.includes('aged'));assert.ok(b.flags.includes('excess'));

  // Settings.
  assert.equal((await call('m6','PUT','/supply/settings',{agedDays:90})).statusCode,403);
  assert.equal((await ov()).settings.shipDays,40);
  assert.equal((await call('m5','PUT','/supply/settings',{agedDays:120})).json().settings.agedDays,120);
  assert.equal((await item('DEMO-B')).flags.includes('aged'),false);
  await call('m5','PUT','/supply/settings',{agedDays:60});

  // Shipment: booked → sailed (factory → in transit) → received by the warehouse with counted quantities.
  const ship={vessel:'DEMO OCEAN',voyage:'052E',blNo:'BL-DEMO-1',containers:'DMOU1234567',originPort:'Yantian',destPort:'Long Beach',etd:ymd(-20),eta:ymd(2),
   lines:[{sku:'demo-a',qty:20,cartons:20,from:'dg'},{sku:'DEMO-C',qty:10,from:'new'}]};
  assert.equal((await call('m6','POST','/supply/shipments',ship)).statusCode,403,'warehouse operators do not register shipments');
  assert.equal((await call('m5','POST','/supply/shipments',{...ship,lines:[{sku:'NOPE',qty:1}]})).statusCode,400);
  const created=await call('m5','POST','/supply/shipments',ship);assert.equal(created.statusCode,201,created.body);
  const id=created.json().id;
  assert.equal((await ov()).shipments[0].lines[0].sku,'DEMO-A','SKU case follows the WMS');
  assert.equal((await call('m5','PATCH',`/supply/shipments/${id}`,{status:'at_port'})).statusCode,409,'not sailed yet');
  assert.equal((await call('m6','POST',`/supply/shipments/${id}/receive`,{lines:[{lineNo:1,received:20},{lineNo:2,received:10}]})).statusCode,409,'cannot receive before sailing');
  assert.equal((await call('m5','POST',`/supply/shipments/${id}/depart`,{})).statusCode,200);
  a=await item('DEMO-A');assert.equal(a.qty.dg,29);assert.equal(a.qty.transit,20);assert.equal(a.nextEta.qty,20);assert.equal(a.flags.includes('stockout'),false,'the ship lands in 2 days');
  assert.equal((await item('DEMO-C')).qty.transit,10,'new production goes straight into transit');
  assert.equal((await call('m5','PATCH',`/supply/shipments/${id}`,{lines:[{sku:'DEMO-A',qty:1}]})).statusCode,409,'lines are fixed once sailed');
  assert.equal((await call('m5','PATCH',`/supply/shipments/${id}`,{eta:ymd(3),status:'customs'})).statusCode,200);

  assert.equal((await call('m5','POST',`/supply/shipments/${id}/receive`,{lines:[{lineNo:1,received:20},{lineNo:2,received:10}]})).statusCode,403,'only warehouse operators receive');
  assert.equal((await call('m6','POST',`/supply/shipments/${id}/receive`,{lines:[{lineNo:1,received:18}]})).statusCode,400,'every line must be counted');
  const rec=await call('m6','POST',`/supply/shipments/${id}/receive`,{lines:[{lineNo:1,received:18},{lineNo:2,received:12}]});assert.equal(rec.statusCode,200,rec.body);
  assert.deepEqual(rec.json(),{units:28,differences:2});
  a=await item('DEMO-A');assert.equal(a.qty.us,22);assert.equal(a.qty.transit,2,'the shortage waits for the manager to confirm the count');
  const pending=(await call('m1','GET','/wms/summary')).json().movements.filter((m:any)=>m.status==='pending');
  assert.deepEqual(pending.map((m:any)=>[m.sku,m.location,m.qty]).sort(),[['DEMO-A','transit',-2],['DEMO-C','us',2]]);
  assert.ok((await item('DEMO-A')).avgAge<=1,'just-received units are new');
  assert.equal((await call('m6','POST',`/supply/shipments/${id}/receive`,{lines:[{lineNo:1,received:18},{lineNo:2,received:12}]})).statusCode,409,'received once');
  assert.equal((await ov()).shipments.find((s:any)=>s.id===id).status,'received');

  // A shipment already at sea when the opening stock was imported: no second transfer into transit.
  await call('m1','POST','/wms/movements',{type:'in',sku:'DEMO-B',location:'transit',qty:5,reason:'期初在途'});
  const s2=(await call('m5','POST','/supply/shipments',{vessel:'DEMO STAR',eta:ymd(-2),lines:[{sku:'DEMO-B',qty:5}]})).json().id;
  assert.equal((await call('m5','POST',`/supply/shipments/${s2}/depart`,{stockAlreadyInTransit:true})).statusCode,200);
  assert.equal((await item('DEMO-B')).qty.transit,5);
  assert.equal((await ov()).shipments.find((s:any)=>s.id===s2).late,true,'past its ETA and still at sea');
  const s3=(await call('m5','POST','/supply/shipments',{vessel:'DEMO WAVE',lines:[{sku:'DEMO-A',qty:999}]})).json().id;
  assert.equal((await call('m5','POST',`/supply/shipments/${s3}/depart`,{})).statusCode,409,'not enough factory stock');
  assert.equal((await call('m5','POST',`/supply/shipments/${s3}/cancel`,{})).statusCode,200);

  // Alerts: once each, to people with supply access.
  const worker=Fastify();
  const {runAlerts}=await registerSupplyRoutes(worker,db,{isAdmin:(u:any)=>u.id==='m1'});
  assert.ok(await runAlerts()>0);
  assert.equal(await runAlerts(),0,'each alert is sent once');
  const inbox=(await db.query(`SELECT user_id,title FROM inbox_items WHERE kind='supply_alert'`)).rows;
  assert.ok(inbox.some((r:any)=>r.user_id==='m5'&&/DEMO STAR/.test(r.title)),'late ship');
  assert.ok(!inbox.some((r:any)=>r.user_id==='m2'),'no supply access, no alert');
  await worker.close();
 }finally{await app.close();}
});
