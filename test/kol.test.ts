import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createDatabase,schema,seedDemo} from '../src/db.js';
import {buildApp} from '../src/app.js';
import {issueSession} from '../src/auth.js';
import {fetchUpPromote} from '../src/kol.js';

const clock=()=>new Date('2026-11-02T10:00:00Z').getTime();
const affiliate=(id:number,extra:any={})=>({id,email:`kol${id}@example.com`,first_name:'K',last_name:String(id),status:'active',company:null,country:'US',state:'IA',city:'Waukee',address:'1 Main St',zipcode:'50263',phone:'555',
 youtube:'https://youtube.com/@k'+id,instagram:'k'+id,tiktok:null,facebook:null,twitter:null,website:null,program_name:'Partner 5%',default_affiliate_link:'https://www.1laser.com?sca_ref='+id,custom_affiliate_link:null,
 coupons:['K'+id],paid_amount:100.5,approved_amount:20,pending_amount:0,created_at:'2025-01-01T00:00:00Z',...extra});
const referral=(id:number,aff:number,sales:string,status:string,created:string)=>({id,order_id:id*10,order_number:1000+id,customer_id:'c',quantity:1,total_sales:sales,commission_rule:{},commission_adjustment:'0.00',
 status,commission:(Number(sales)*0.05).toFixed(2),refund_id:null,tracking_type:'Tracked by coupon',affiliate:{id:aff,email:'x',first_name:'K',last_name:'L'},coupon_applied:null,customer_email:'buyer@example.com',created_at:created});

/** A fake UpPromote: pages of 100, the raw key as Authorization, and one rate-limited answer to exercise the retry. */
function fakeUpPromote(state:{affiliates:any[];referrals:any[];key?:string},rateLimitOnce=false){
 const calls:string[]=[];let limited=!rateLimitOnce;
 const fetcher=(async(url:string,init:any)=>{
  calls.push(url);
  if(init.headers.Authorization!==(state.key||'pk_test'))return new Response(JSON.stringify({status:401,message:'Unauthorized'}),{status:401});
  if(!limited){limited=true;return new Response('{"message":"Too Many Attempts."}',{status:400});}
  const u=new URL(url),kind=u.pathname.split('/').pop() as 'affiliates'|'referrals',page=Number(u.searchParams.get('page')),per=Number(u.searchParams.get('per_page'));
  return new Response(JSON.stringify({status:200,message:'success',data:state[kind].slice((page-1)*per,page*per)}),{status:200});
 }) as unknown as typeof fetch;
 return {fetcher,calls};
}

async function setup(up:{affiliates:any[];referrals:any[];key?:string},apiKey:string|null='pk_test'){
 const db=await createDatabase();await db.exec(schema);await seedDemo(db);
 const fake=fakeUpPromote(up);
 const app=await buildApp({db,integrations:{executiveUserIds:['m1']},kol:{uppromoteApiKey:apiKey??undefined},kolFetcher:fake.fetcher,completionModel:null,translationModel:null,mailer:null,nudgeIntervalMs:0,clock,closeDatabase:false});
 const tokens:Record<string,string>={};
 const call=async(who:string,method:'GET'|'POST'|'PUT'|'DELETE',url:string,payload?:any,lang='zh')=>{tokens[who]??=(await issueSession(db,who)).accessToken;return app.inject({method,url,payload,headers:{authorization:'Bearer '+tokens[who],'accept-language':lang}});};
 return {db,app,call,fake};
}

test('UpPromote client pages through results, retries a rate limit and rejects a bad key',async()=>{
 const up={affiliates:Array.from({length:230},(_,i)=>affiliate(i+1)),referrals:[]};
 const {fetcher,calls}=fakeUpPromote(up,true);
 const waits:number[]=[];
 const got=await fetchUpPromote({apiKey:'pk_test',fetcher,wait:async ms=>{waits.push(ms);}},'affiliates');
 assert.equal(got.length,230);assert.equal(calls.length,4,'one rate-limited try, then three pages');assert.deepEqual(waits,[2000]);
 assert.match(calls[1],/\/api\/v2\/affiliates\?per_page=100&page=1$/);
 await assert.rejects(fetchUpPromote({apiKey:'wrong',fetcher,wait:async()=>{}},'affiliates'),(e:any)=>e.code==='UPPROMOTE_UNAUTHORIZED');
});

test('KOL access follows admin and ERP grants; sync imports UpPromote and keeps our own fields',async()=>{
 const up={affiliates:[affiliate(11),affiliate(12,{email:'Hand@Example.com',status:'inactive'})],
  referrals:[referral(1,11,'1000.00','paid','2026-10-20T00:00:00Z'),referral(2,11,'500.00','pending','2026-06-01T00:00:00Z'),referral(3,11,'900.00','denied','2026-10-25T00:00:00Z'),referral(4,12,'200.00','approved','2026-10-30T00:00:00Z')]};
 const {db,app,call}=await setup(up);
 try{
  assert.equal((await call('m3','GET','/capabilities')).json().kol,true);
  assert.deepEqual((await call('m3','GET','/kol/access')).json(),{canView:false,canManage:false});
  assert.equal((await call('m3','GET','/kol/kols')).statusCode,403);
  assert.match((await call('m3','GET','/kol/kols')).json().error.message,/ERP 权限/);

  // Grants come from ERP permissions; managers of other areas cannot hand out KOL access.
  assert.equal((await call('m1','POST','/erp/access',{userId:'m3',area:'kol',level:'view'})).json().access.kol,'view');
  assert.equal((await call('m3','GET','/kol/kols')).statusCode,200);
  assert.equal((await call('m3','POST','/kol/sync')).statusCode,403,'view-only cannot sync');

  // A KOL added by hand before joining UpPromote is linked by email on the next sync.
  const hand=await call('m1','POST','/kol/kols',{name:'Hand Added',email:'hand@example.com',platform:'youtube',followers:52000,tier:'A',stage:'negotiating',notes:'Prefers laser welders',ownerId:'m2'});
  assert.equal(hand.statusCode,201,hand.body);const handId=hand.json().kol.id;

  const s=await call('m1','POST','/kol/sync');assert.equal(s.statusCode,200,s.body);
  assert.deepEqual(s.json().counts,{affiliates:2,referrals:4,added:1,updated:0,linked:1,removed:0});
  assert.equal(s.json().lastSync.ok,true);

  const list=(await call('m3','GET','/kol/kols')).json();
  assert.equal(list.items.length,2);assert.equal(list.canManage,false);
  const k11=list.items.find((k:any)=>k.upId===11);
  assert.equal(k11.stage,'partner','UpPromote affiliates start as partners');
  assert.deepEqual([k11.orders,k11.sales,k11.orders30,k11.sales30],[2,1500,1,1000],'denied referrals do not count');
  assert.equal(k11.paid,100.5);assert.deepEqual(k11.coupons,['K11']);assert.equal(k11.socials.instagram,'k11');
  const linked=list.items.find((k:any)=>k.id===handId);
  assert.equal(linked.upId,12);assert.equal(linked.upStatus,'inactive');assert.equal(linked.name,'K 12','name now comes from UpPromote');
  assert.deepEqual([linked.tier,linked.stage,linked.followers,linked.ownerName],['A','negotiating',52000,'陈一'],'our own fields survive the sync');
  assert.deepEqual([list.totals.orders,list.totals.sales,list.totals.unpaidCommission],[3,1700,35]);
  assert.ok(list.months.some((m:any)=>m.month==='2026-10'&&m.sales===1200));
  assert.ok(!JSON.stringify(await db.query('SELECT * FROM kol_referrals')).includes('buyer@example.com'),'customer emails are not stored');

  // Contact details of UpPromote KOLs stay read-only; our fields are versioned.
  assert.equal((await call('m1','PUT','/kol/kols/up-11',{expectedVersion:1,email:'x@example.com'})).statusCode,400);
  const ed=await call('m1','PUT','/kol/kols/up-11',{expectedVersion:1,tier:'S',niche:'Woodworking',fee:'$500 / video'});
  assert.equal(ed.statusCode,200,ed.body);assert.equal(ed.json().kol.version,2);
  assert.equal((await call('m1','PUT','/kol/kols/up-11',{expectedVersion:1,tier:'B'})).statusCode,409);
  assert.equal((await call('m1','PUT','/kol/kols/up-11',{expectedVersion:2,ownerId:'nobody'})).statusCode,400);
  assert.equal((await call('m1','DELETE','/kol/kols/up-11')).statusCode,400,'UpPromote KOLs are not deleted here');

  // Logging a sample moves the stage forward; the detail shows referrals and the log.
  const c=await call('m1','POST','/kol/kols/up-11/collabs',{kind:'sample',happenedOn:'2026-10-01',product:'LF-60',cost:1899,note:'Shipped via UPS'});
  assert.equal(c.statusCode,201,c.body);assert.equal(c.json().kol.stage,'sample_sent');
  assert.equal((await call('m1','POST','/kol/kols/up-11/collabs',{kind:'content',happenedOn:'2026-10-15',url:'ftp://nope'})).statusCode,400);
  await call('m1','POST','/kol/kols/up-11/collabs',{kind:'content',happenedOn:'2026-10-15',url:'https://youtu.be/abc'});
  const d=(await call('m3','GET','/kol/kols/up-11')).json();
  assert.equal(d.kol.stage,'content_live');assert.equal(d.kol.fee,'$500 / video');assert.equal(d.referrals.length,3);assert.equal(d.collabs.length,2);
  assert.equal(d.collabs[0].url,'https://youtu.be/abc');
  const del=await call('m1','DELETE',`/kol/kols/up-11/collabs/${d.collabs[1].id}`);assert.equal(del.statusCode,200);assert.equal(del.json().collabs.length,1);

  // A second sync updates, marks a deleted affiliate and drops a deleted referral.
  up.affiliates=[affiliate(11,{paid_amount:250})];up.referrals=up.referrals.filter(r=>r.id!==2);
  assert.deepEqual((await call('m1','POST','/kol/sync')).json().counts,{affiliates:1,referrals:3,added:0,updated:1,linked:0,removed:1});
  const after=(await call('m1','GET','/kol/kols')).json();
  assert.equal(after.items.find((k:any)=>k.upId===11).paid,250);assert.equal(after.items.find((k:any)=>k.upId===11).tier,'S');
  assert.equal(after.items.find((k:any)=>k.upId===12).upStatus,'removed');

  const audit=(await db.query("SELECT action,details FROM audit_events WHERE action LIKE 'kol.%'")).rows;
  assert.ok(audit.some((a:any)=>a.action==='kol.sync'));assert.ok(!JSON.stringify(audit).includes('$500'),'audit holds field names, not values');
 }finally{await app.close();await db.close();}
});

test('KOL sync explains a missing or rejected UpPromote key',async()=>{
 const missing=await setup({affiliates:[],referrals:[]},null);
 try{
  assert.equal((await missing.call('m1','GET','/kol/access')).json().uppromote,'not_configured');
  const r=await missing.call('m1','POST','/kol/sync');assert.equal(r.statusCode,501);assert.match(r.json().error.message,/UPPROMOTE_API_KEY/);
 }finally{await missing.app.close();await missing.db.close();}
 const bad=await setup({affiliates:[],referrals:[],key:'pk_other'});
 try{
  const r=await bad.call('m1','POST','/kol/sync',undefined,'en');
  assert.equal(r.statusCode,502);assert.equal(r.json().error.message,'UpPromote rejected the API key');
  const a=(await bad.call('m1','GET','/kol/access')).json();assert.equal(a.lastSync.ok,false);assert.equal(a.lastSync.error,'UPPROMOTE_UNAUTHORIZED');
 }finally{await bad.app.close();await bad.db.close();}
});
