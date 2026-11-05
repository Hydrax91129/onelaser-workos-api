import {test,before,after} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {buildApp} from '../src/app.js';
import {createDatabase,schema,type Database} from '../src/db.js';
import {issueCaldockSession} from '../src/caldock.js';
import {studioSeed} from '../src/caldock-studio-seed.js';
let db:Database,admin:Database|undefined,app:Awaited<ReturnType<typeof buildApp>>,other:typeof app;
let namespace:string|undefined,connectionString:string|undefined;
const origin='https://craftos.example.test';
const users:Record<string,{id:string;cookie:string;csrf:string}>={};
before(async()=>{
 if(process.env.TEST_DATABASE_URL){admin=await createDatabase({connectionString:process.env.TEST_DATABASE_URL});namespace='studio_'+randomUUID().replaceAll('-','');await admin.exec(`CREATE SCHEMA ${namespace}`);const u=new URL(process.env.TEST_DATABASE_URL);u.searchParams.set('options','-c search_path='+namespace);connectionString=u.toString();db=await createDatabase({connectionString});}else db=await createDatabase();
 await db.exec(schema);
 for(const role of ['owner','editor','viewer','outsider']){const id=randomUUID();await db.query('INSERT INTO caldock_users(id,display_name,email) VALUES($1,$2,$3)',[id,role,role+'@example.test']);if(role!=='outsider')await db.query('INSERT INTO caldock_studio_members(user_id,role) VALUES($1,$2)',[id,role]);const s=await issueCaldockSession(db,id);users[role]={id,cookie:'__Host-caldock_session='+s.token,csrf:s.csrf};}
 app=await buildApp({db,environment:'production',closeDatabase:false,caldock:{publicUrl:origin},studio:{connectionString,heartbeatMs:200}});
 // A separate DB pool in PostgreSQL CI proves NOTIFY crosses process/adapter boundaries.
 const otherDb=connectionString?await createDatabase({connectionString}):db;
 other=await buildApp({db:otherDb,environment:'production',closeDatabase:!!connectionString,caldock:{publicUrl:origin},studio:{connectionString,heartbeatMs:10000}});
});
after(async()=>{await other?.close();await app?.close();await db?.close();if(admin&&namespace){await admin.exec(`DROP SCHEMA ${namespace} CASCADE`);await admin.close();}});
const send=(role:string,method:any,path:string,payload?:any,headers:Record<string,string>={})=>app.inject({method,url:'/caldock/studio'+path,payload,headers:{cookie:users[role].cookie,origin,'x-csrf-token':users[role].csrf,...headers}});
const state=async()=>(await app.inject('/caldock/studio/state')).json();
const change=(s:any,path:string[],value:any)=>({path,before:path.reduce((o,k)=>o?.[k],s.state)??null,value,revision:s.revision,requestId:randomUUID()});
const annual=['scenarios','pilot','values','annual'];
test('public view contains defaults; members and writes remain protected and commerce is unchanged',async()=>{
 assert.equal((await app.inject('/caldock/studio/health')).json().publicView,true);
 const s=await state();assert.deepEqual(s.state,studioSeed);assert.equal(s.revision,0);
 assert.equal((await app.inject('/caldock/studio/members')).statusCode,403);
 const caps=(await app.inject('/caldock/capabilities')).json();assert.equal(caps.prices.year,172380);
 assert.equal((await app.inject({method:'PATCH',url:'/caldock/studio/state',payload:change(s,annual,130)})).statusCode,403);
 for(const role of ['viewer','outsider'])assert.equal((await send(role,'PATCH','/state',change(s,annual,130))).statusCode,403);
 assert.equal((await send('editor','PATCH','/state',change(s,annual,130),{'x-csrf-token':'wrong'})).statusCode,403);
 assert.equal((await send('editor','PATCH','/state',change(s,annual,130),{origin:'https://evil.example'})).statusCode,403);
 const me=(await send('editor','GET','/me')).json();assert.equal(me.user.role,'editor');assert.equal(me.user.sessionHash,undefined);
});
test('independent fields merge, same-field stale and ABA edits conflict; retries are idempotent',async()=>{
 const s=await state(),first=change(s,annual,130);
 const a=await send('editor','PATCH','/state',first);assert.equal(a.statusCode,200,a.body);
 const independent=await send('owner','PATCH','/state',change(s,['scenarios','pilot','values','monthly'],201));assert.equal(independent.statusCode,200,independent.body);
 const conflict=await send('owner','PATCH','/state',change(s,annual,140));assert.equal(conflict.statusCode,409);assert.equal(conflict.json().current.state.scenarios.pilot.values.annual,130);
 const replay=await send('editor','PATCH','/state',first);assert.equal(replay.statusCode,200);assert.equal(replay.json().revision,2);
 const current=await state();assert.equal((await send('owner','PATCH','/state',change(current,annual,129))).statusCode,200);
 const aba=await send('editor','PATCH','/state',change(s,annual,150));assert.equal(aba.statusCode,409);
});
test('malformed paths, out-of-range values and incomplete models cannot corrupt persisted state',async()=>{
 const s=await state();for(const [path,value]of [[['scenarios','pilot','values','annual'],-1],[['scenarios','pilot','values','monthly'],'123'],[['scenarios','pilot','values','monthlyCommissionMonths'],-1],[['scenarios','pilot','values','monthlyCommissionMonths'],121],[['scenarios','pilot','values','monthlyCommissionMonths'],'invalid'],[['scenarios','pilot','values','monthlyCommissionMonths'],null],[['scenarios','pilot','values','monthlyCommissionMonths'],1.5],[['scenarios','__proto__','polluted'],true],[['marketing','tasks','t1','due'],'not-a-date'],[['scenarios','pilot'],{}]] as [string[],unknown][]){const r=await send('editor','PATCH','/state',change(s,path,value));assert.equal(r.statusCode,400,r.body);}
 assert.deepEqual(await state(),s);
});
test('shared history and field restore append a new revision without erasing later independent changes',async()=>{
 const history=(await app.inject('/caldock/studio/history')).json().history;assert.equal(history.length,3);
 const s=await state(),target=history[0];
 const restored=await send('editor','POST','/history/'+target.id+'/restore',{revision:s.revision,requestId:randomUUID()});assert.equal(restored.statusCode,200,restored.body);assert.equal(restored.json().state.scenarios.pilot.values.annual,130);assert.equal(restored.json().state.scenarios.pilot.values.monthly,201);
 const h=(await app.inject('/caldock/studio/history')).json().history;assert.equal(h.length,4);assert.equal(h[0].restored_from,target.id);assert.equal(h[0].operation,'restore');
 const stale=await send('editor','POST','/history/'+target.id+'/restore',{revision:s.revision,requestId:randomUUID()});assert.equal(stale.statusCode,409);
});
test('legacy imports preserve old commissions and the missing term; owner and revision checks remain enforced',async()=>{
 const s=await state(),legacy=structuredClone(s.state);
 for(const {values} of Object.values(legacy.scenarios) as {values:Record<string,number>}[]){
  Object.assign(values,{monthlyFirst:20,monthlyRepeat:10,quarterCommission:8,annualCommission:8});
  delete values.monthlyCommissionMonths;
 }
 const payload={state:legacy,revision:s.revision,requestId:randomUUID()};
 assert.equal((await send('editor','POST','/import',payload)).statusCode,403);
 const imported=await send('owner','POST','/import',payload);assert.equal(imported.statusCode,200,imported.body);
 assert.deepEqual(imported.json().state,legacy);
 assert.deepEqual((await state()).state,legacy);
 assert.equal((await send('owner','POST','/import',{...payload,requestId:randomUUID()})).statusCode,409);
 assert.equal((await send('owner','PUT','/members/'+users.owner.id,{role:null,expectedRole:'owner'})).statusCode,409);
 assert.equal((await send('owner','PUT','/members/'+users.editor.id,{role:'viewer',expectedRole:'editor'})).statusCode,200);
 assert.equal((await send('editor','PATCH','/state',change(await state(),annual,160))).statusCode,403);
 assert.equal((await send('owner','PUT','/members/'+users.editor.id,{role:'editor',expectedRole:'viewer'})).statusCode,200);
});
test('queued legacy term edits survive unrelated writes while real term changes still conflict',async()=>{
 const term=['scenarios','pilot','values','monthlyCommissionMonths'],repeat=['scenarios','pilot','values','monthlyRepeat'];
 const raw=structuredClone((await state()).state);
 delete raw.scenarios.pilot.values.monthlyCommissionMonths;
 raw.scenarios.pilot.values.monthlyRepeat=10;
 await db.query('UPDATE caldock_studio_state SET state=$1 WHERE id=1',[JSON.stringify(raw)]);
 const initial=await state();assert.deepEqual(initial.state,raw);
 const queuedTerm=change(initial,term,0);assert.equal(queuedTerm.before,null);
 const rate=await send('editor','PATCH','/state',change(initial,repeat,20));assert.equal(rate.statusCode,200,rate.body);
 assert.equal(Object.hasOwn(rate.json().state.scenarios.pilot.values,'monthlyCommissionMonths'),false);
 const unrelated=await send('editor','PATCH','/state',change(initial,annual,141));assert.equal(unrelated.statusCode,200,unrelated.body);
 assert.equal(Object.hasOwn(unrelated.json().state.scenarios.pilot.values,'monthlyCommissionMonths'),false);
 const applied=await send('editor','PATCH','/state',queuedTerm);assert.equal(applied.statusCode,200,applied.body);
 assert.equal(applied.json().state.scenarios.pilot.values.monthlyCommissionMonths,0);
 const prior=await state(),staleTerm=change(prior,term,3);
 const concurrent=await send('owner','PATCH','/state',change(prior,term,12));assert.equal(concurrent.statusCode,200,concurrent.body);
 assert.equal((await send('editor','PATCH','/state',staleTerm)).statusCode,409);
 const latest=await state(),restored=await send('editor','POST','/history/'+queuedTerm.requestId+'/restore',{revision:latest.revision,requestId:randomUUID()});
 assert.equal(restored.statusCode,200,restored.body);
 assert.equal(Object.hasOwn(restored.json().state.scenarios.pilot.values,'monthlyCommissionMonths'),false);
 assert.equal(restored.json().state.scenarios.pilot.values.monthlyRepeat,20);
 assert.equal(restored.json().state.scenarios.pilot.values.annual,141);
});
test('real SSE sends initial state and a committed edit from another instance',async()=>{
 await other.listen({host:'127.0.0.1',port:0});const address=other.server.address() as {port:number};
 const abort=new AbortController();const response=await fetch(`http://127.0.0.1:${address.port}/caldock/studio/live`,{signal:abort.signal});assert.equal(response.status,200);assert.match(response.headers.get('content-type')!,/text\/event-stream/);
 const reader=response.body!.getReader();const first=await reader.read();assert.match(new TextDecoder().decode(first.value),/"type":"state"/);
 const current=await state();const written=await send('editor','PATCH','/state',change(current,annual,135));assert.equal(written.statusCode,200,written.body);
 const next=await Promise.race([reader.read(),new Promise<never>((_,reject)=>setTimeout(()=>reject(new Error('SSE notification timeout')),5000).unref())]);assert.match(new TextDecoder().decode(next.value),/"annual":135/);abort.abort();
 assert.equal((await state()).state.scenarios.pilot.values.annual,135);
});
