import { before, after, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { buildApp } from '../src/app.js';
import { createDatabase, schema, type Database } from '../src/db.js';
import { DingTalkError, type DingTalkProfile } from '../src/integrations/dingtalk.js';
import { integrationOptionsFromEnv } from '../src/integrations/routes.js';
import type { ReviewInput } from '../src/integrations/grok.js';

let db:Database,admin:Database|undefined,isolatedSchema:string|undefined,app:Awaited<ReturnType<typeof buildApp>>;
const origin='https://work.example';
const managerProfile:DingTalkProfile={externalUserId:'manager',unionId:'union-manager',name:'Manager',departmentId:'123',departmentName:'Company',role:'manager'};
const employeeProfile:DingTalkProfile={externalUserId:'employee',unionId:'union-employee',name:'Employee',departmentId:'123',departmentName:'Company',role:'employee'};
const sent:{users:string[],content:string}[]=[];let assessments=0;let releaseAssessment:(()=>void)|undefined;let blockAssessment=false;
const ding={
  authorizationUrl(state:string){return 'https://login.dingtalk.com/oauth2/auth?state='+state;},
  async authenticate(code:string){return code==='manager'?managerProfile:employeeProfile;},
  async listDepartmentUsers(){return [managerProfile,employeeProfile];},
  async sendWorkNotification(users:string[],content:string){sent.push({users,content});return {taskId:'provider-'+sent.length};}
};
const ai={model:'mock-model',inputHash(input:ReviewInput){return JSON.stringify(input);},async assess(input:ReviewInput){
  assessments++;if(blockAssessment)await new Promise<void>(resolve=>{releaseAssessment=resolve;});
  return {summary:'Human review is required.',criteria:input.criteria.map((_,i)=>({criterionId:`C${i+1}`,finding:'supported' as const,reason:'The submitted text is available to inspect.',evidenceRefs:[`submission:${input.submission.id}:description`],quotes:[input.submission.description]})),missingEvidence:[],uncertainties:['No external URLs were fetched.'],humanReviewRequired:true as const};
}};
let managerCookie:string,employeeCookie:string,managerCsrf:string,employeeCsrf:string,managerId:string,employeeId:string;
before(async()=>{
  if(process.env.TEST_DATABASE_URL){isolatedSchema='workos_integration_'+randomUUID().replaceAll('-','');admin=await createDatabase({connectionString:process.env.TEST_DATABASE_URL});await admin.exec(`CREATE SCHEMA ${isolatedSchema}`);const url=new URL(process.env.TEST_DATABASE_URL);url.searchParams.set('options',`-c search_path=${isolatedSchema}`);db=await createDatabase({connectionString:url.toString()});}else db=await createDatabase();
  await db.exec(schema);
  app=await buildApp({db,environment:'production',integrations:{dingtalk:ding,corpId:'corp-real',appPublicUrl:origin,ai,notificationsEnabled:true,frontendConnected:true}});
});
after(async()=>{if(app)await app.close();else if(db)await db.close();if(admin&&isolatedSchema){await admin.exec(`DROP SCHEMA ${isolatedSchema} CASCADE`);await admin.close();}});
const request=(cookie:string,csrf:string,method:'GET'|'POST'|'DELETE',url:string,payload?:Record<string,unknown>,extra:Record<string,string>={})=>app.inject({method,url,payload,headers:{cookie,'x-csrf-token':csrf,origin,'accept-language':'en',...extra}});
async function login(code:string){
  const start=await app.inject('/auth/dingtalk/start');assert.equal(start.statusCode,302);
  const state=new URL(start.headers.location!).searchParams.get('state')!;
  const nonce=String(start.headers['set-cookie']).split(';')[0];
  const invalid=await app.inject({url:`/auth/dingtalk/callback?state=${state}&authCode=${code}`,headers:{cookie:'__Host-workos_oauth='+randomBytes(32).toString('base64url')}});assert.equal(invalid.statusCode,400);
  const callback=await app.inject({url:`/auth/dingtalk/callback?state=${state}&authCode=${code}`,headers:{cookie:nonce}});assert.equal(callback.statusCode,302,callback.body);assert.equal(callback.headers.location,origin);
  const cookies=[callback.headers['set-cookie']].flat().map(String);const session=cookies.find(v=>v.startsWith('__Host-workos_session='))!;
  assert.match(session,/HttpOnly/);assert.match(session,/Secure/);assert.match(session,/SameSite=Lax/);assert.doesNotMatch(String(callback.headers.location),/accessToken|secret/);
  const replay=await app.inject({url:`/auth/dingtalk/callback?state=${state}&authCode=${code}`,headers:{cookie:nonce}});assert.equal(replay.statusCode,400);
  const cookie=session.split(';')[0];const csrf=(await app.inject({url:'/auth/csrf',headers:{cookie}})).json().csrfToken;
  const me=(await app.inject({url:'/me',headers:{cookie}})).json();return {cookie,csrf,me};
}
test('OAuth binds state to a browser nonce, consumes it once and returns HttpOnly sessions',async()=>{
  const manager=await login('manager');managerCookie=manager.cookie;managerCsrf=manager.csrf;managerId=manager.me.id;
  const employee=await login('employee');employeeCookie=employee.cookie;employeeCsrf=employee.csrf;employeeId=employee.me.id;
  assert.equal(manager.me.role,'manager');assert.equal(employee.me.role,'employee');assert.equal(manager.me.org_id,'corp-real');assert.equal(manager.me.department_id,'ding_123');assert.equal(managerCsrf.length,43);
});
test('cookie writes require CSRF and exact origin; caller cannot choose their own role',async()=>{
  const payload={title:'Personal goal',level:'personal'};
  assert.equal((await app.inject({method:'POST',url:'/objectives',payload,headers:{cookie:employeeCookie}})).statusCode,403);
  assert.equal((await app.inject({method:'POST',url:'/objectives',payload,headers:{cookie:employeeCookie,authorization:'Basic invalid'}})).statusCode,401);
  assert.equal((await request(employeeCookie,employeeCsrf,'POST','/objectives',payload,{origin:'https://evil.example'})).statusCode,403);
  assert.equal((await request(employeeCookie,employeeCsrf,'POST','/objectives',{...payload,role:'manager'})).statusCode,400);
  assert.equal((await request(employeeCookie,employeeCsrf,'POST','/objectives',{title:'Company override',level:'department'})).statusCode,403);
});
test('new authenticated organizations can create real personal and department OKRs without demo seeds',async()=>{
  const objective=await request(employeeCookie,employeeCsrf,'POST','/objectives',{title:'My verified outcomes',level:'personal'});assert.equal(objective.statusCode,201,objective.body);
  const kr=await request(employeeCookie,employeeCsrf,'POST',`/objectives/${objective.json().id}/key-results`,{title:'Accepted articles',baseline:0,target:5,direction:'increase',unit:'articles'});assert.equal(kr.statusCode,201,kr.body);assert.equal(kr.json().progress,0);
  assert.equal((await request(employeeCookie,employeeCsrf,'POST',`/objectives/${objective.json().id}/key-results`,{title:'Invalid metric',baseline:5,target:5,direction:'increase',unit:'articles'})).statusCode,400);
  const department=await request(managerCookie,managerCsrf,'POST','/objectives',{title:'Company department outcomes',level:'department'});assert.equal(department.statusCode,201);
  const directory=(await request(managerCookie,managerCsrf,'GET','/directory')).json().items;assert.equal(directory.length,2);assert.ok(directory.every((u:any)=>u.department_id==='ding_123'));
});
let taskId:string,taskVersion:number;
test('real cookie sessions support task assignment and evidence, while AI remains advisory and cached',async()=>{
  const created=await request(managerCookie,managerCsrf,'POST','/tasks',{title:'Check actual deliverable',description:'Task created in an empty real organization.',ownerId:employeeId,criteria:['Provide evidence'],dueAt:'2026-11-01T18:00:00+08:00'});assert.equal(created.statusCode,201,created.body);taskId=created.json().id;
  const submitted=await request(employeeCookie,employeeCsrf,'POST',`/tasks/${taskId}/submissions`,{expectedVersion:created.json().version,title:'Evidence report',description:'The evidence source contains an actual submitted text report.'});assert.equal(submitted.statusCode,201,submitted.body);taskVersion=submitted.json().taskVersion;
  const first=await request(employeeCookie,employeeCsrf,'POST',`/tasks/${taskId}/analyze`,{});assert.equal(first.statusCode,200,first.body);assert.equal(first.json().evaluation.status,'ready_for_human_review');assert.equal(first.json().evaluation.result.humanReviewRequired,true);
  const again=await request(managerCookie,managerCsrf,'POST',`/tasks/${taskId}/analyze`,{});assert.equal(again.json().cached,true);assert.equal(assessments,1);
  const detail=(await request(managerCookie,managerCsrf,'GET',`/tasks/${taskId}`)).json();assert.equal(detail.status,'submitted');assert.equal(detail.currentReview,null);
  assert.equal((await request(managerCookie,managerCsrf,'GET',`/tasks/${taskId}/evaluations`)).json().items.length,1);
});
test('AI completion cannot attach an old version after a new submission',async()=>{
  const next=await request(employeeCookie,employeeCsrf,'POST',`/tasks/${taskId}/submissions`,{expectedVersion:taskVersion,title:'Revised evidence',description:'A second submitted evidence record.'});taskVersion=next.json().taskVersion;
  blockAssessment=true;const pending=request(employeeCookie,employeeCsrf,'POST',`/tasks/${taskId}/analyze`,{});
  while(!releaseAssessment)await new Promise(resolve=>setTimeout(resolve,1));
  const third=await request(employeeCookie,employeeCsrf,'POST',`/tasks/${taskId}/submissions`,{expectedVersion:taskVersion,title:'Third evidence',description:'This newer version replaces the in-flight assessment input.'});assert.equal(third.statusCode,201);taskVersion=third.json().taskVersion;
  releaseAssessment();blockAssessment=false;assert.equal((await pending).statusCode,409);
});
test('explicit manager notifications are owner-scoped, idempotent and distinguish queued from delivered',async()=>{
  const key=randomUUID(),payload={taskIds:[taskId],idempotencyKey:key};
  assert.equal((await request(employeeCookie,employeeCsrf,'POST','/notifications/send',payload)).statusCode,403);
  const first=await request(managerCookie,managerCsrf,'POST','/notifications/send',payload);assert.equal(first.statusCode,200,first.body);assert.equal(first.json().status,'queued');assert.equal(first.json().sent,false);assert.equal(sent.length,1);assert.deepEqual(sent[0].users,['employee']);
  const second=await request(managerCookie,managerCsrf,'POST','/notifications/send',payload);assert.equal(second.json().status,'queued');assert.equal(sent.length,1);
  const other=await request(managerCookie,managerCsrf,'POST','/tasks',{title:'A second reminder task',description:'Independent task',ownerId:employeeId,criteria:['Check'],dueAt:'2026-11-02T18:00:00+08:00'});
  assert.equal((await request(managerCookie,managerCsrf,'POST','/notifications/send',{taskIds:[other.json().id],idempotencyKey:key})).statusCode,409);assert.equal(sent.length,1);
});
test('capability setup reports missing configuration names without exposing secrets or opening dev login',()=>{
  const config=integrationOptionsFromEnv({NODE_ENV:'production',RENDER_EXTERNAL_URL:origin,DINGTALK_CLIENT_ID:'public-id-only'});
  assert.equal(config.dingtalk,undefined);assert.ok(config.setup?.dingtalkMissing.includes('DINGTALK_CLIENT_SECRET'));assert.equal(config.appPublicUrl,origin);
});
test('health becomes unavailable when the database cannot answer without exposing connection details',async()=>{
  const failing=await buildApp({db:{...db,async query(){throw new Error('private database details');}},closeDatabase:false});
  try { const response=await failing.inject('/health');assert.equal(response.statusCode,503);assert.equal(response.json().status,'unavailable');assert.doesNotMatch(response.body,/private database details/); }
  finally { await failing.close(); }
});
test('cookie logout clears the cookie and revokes the session',async()=>{
  const logout=await request(employeeCookie,employeeCsrf,'DELETE','/auth/session');assert.equal(logout.statusCode,200);assert.match(String(logout.headers['set-cookie']),/Max-Age=0/);
  assert.equal((await request(employeeCookie,employeeCsrf,'GET','/me')).statusCode,401);
});
test('company mode joins only approved enterprise departments while preserving the original mappings',async()=>{
  const calls:string[]=[];
  const second={...employeeProfile,externalUserId:'employee-second',unionId:'union-second',departmentId:'456',departmentName:'Second department'};
  const gateway={...ding,async authenticate(code:string){return code==='manager'?managerProfile:code==='unapproved'?{...second,departmentId:'789'}:second;},async listDepartmentUsers(dept:string){calls.push(dept);return dept==='123'?[managerProfile]:[second];}};
  const company=await buildApp({db,environment:'production',closeDatabase:false,integrations:{dingtalk:gateway,corpId:'corp-small',appPublicUrl:origin,teamMode:'company',allowedDepartmentIds:['123','456'],teamName:'OneLaser'}});
  async function companyLogin(code:string){const start=await company.inject('/auth/dingtalk/start'),state=new URL(start.headers.location!).searchParams.get('state')!,nonce=String(start.headers['set-cookie']).split(';')[0];const result=await company.inject({url:`/auth/dingtalk/callback?state=${state}&authCode=${code}`,headers:{cookie:nonce}});return result;}
  try{
    assert.equal((await companyLogin('unapproved')).statusCode,403);
    const loginManager=await companyLogin('manager'),loginEmployee=await companyLogin('employee');assert.equal(loginManager.statusCode,302);assert.equal(loginEmployee.statusCode,302);
    const session=(result:any)=>[result.headers['set-cookie']].flat().map(String).find(v=>v.startsWith('__Host-workos_session='))!.split(';')[0];
    const manager=session(loginManager),employee=session(loginEmployee),managerCsrf=(await company.inject({url:'/auth/csrf',headers:{cookie:manager}})).json().csrfToken;
    const me=(await company.inject({url:'/me',headers:{cookie:employee}})).json();assert.equal(me.department_id,'company');
    const created=await company.inject({method:'POST',url:'/tasks',headers:{cookie:manager,origin,'x-csrf-token':managerCsrf},payload:{title:'One company shared workspace',description:'The owner belongs to another approved DingTalk department.',ownerId:me.id,criteria:['Inspect the evidence'],dueAt:'2026-11-01T18:00:00+08:00'}});assert.equal(created.statusCode,201,created.body);
    const managerTasks=(await company.inject({url:'/tasks',headers:{cookie:manager}})).json().items;assert.ok(managerTasks.some((t:any)=>t.id===created.json().id));
    const mapping=(await db.query('SELECT external_department_id FROM external_identities WHERE corp_id=$1 AND user_id=$2',['corp-small',me.id])).rows[0];assert.equal(mapping.external_department_id,'456');
    const sync=await company.inject({method:'POST',url:'/integrations/dingtalk/sync',headers:{cookie:manager,origin,'x-csrf-token':managerCsrf},payload:{}});assert.equal(sync.statusCode,200,sync.body);assert.deepEqual(calls,['123','456']);
  }finally{await company.close();}
});

test('Company sync includes only exact additional members, preserves identities, and fails atomically',async()=>{
  const extras:DingTalkProfile[]=['extra-1','extra-2','extra-3'].map((externalUserId,index)=>({...employeeProfile,externalUserId,unionId:'union-'+externalUserId,name:'Extra '+index,departmentId:index?'789':'456',departmentName:index?'Outside B':'Outside A'}));
  const additionalUserIds=extras.map(p=>p.externalUserId),departments:string[]=[],individuals:string[]=[];
  let failExtra=false;
  const gateway={...ding,async authenticate(code:string){return code==='manager'?managerProfile:extras.find(p=>p.externalUserId===code)||{...extras[0],externalUserId:'unapproved-colleague'};},async listDepartmentUsers(id:string){departments.push(id);return [managerProfile];},async getAdditionalUser(id:string){individuals.push(id);if(failExtra&&id==='extra-2')throw new DingTalkError('DINGTALK_MEMBERSHIP_REJECTED',403);return extras.find(p=>p.externalUserId===id)!;}};
  const company=await buildApp({db,environment:'production',closeDatabase:false,integrations:{dingtalk:gateway,corpId:'corp-exact-additional',appPublicUrl:origin,teamMode:'company',allowedDepartmentIds:['123'],additionalUserIds}});
  const logIn=async(code:string)=>{const start=await company.inject('/auth/dingtalk/start'),state=new URL(start.headers.location!).searchParams.get('state')!,nonce=String(start.headers['set-cookie']).split(';')[0];return company.inject({url:`/auth/dingtalk/callback?state=${state}&authCode=${code}`,headers:{cookie:nonce}});};
  const cookieOf=(result:any)=>[result.headers['set-cookie']].flat().map(String).find(v=>v.startsWith('__Host-workos_session='))!.split(';')[0];
  try{
    assert.equal((await logIn('unapproved-colleague')).statusCode,403);
    const manager=cookieOf(await logIn('manager')),extra=cookieOf(await logIn('extra-1'));
    const managerCsrf=(await company.inject({url:'/auth/csrf',headers:{cookie:manager}})).json().csrfToken;
    const extraCsrf=(await company.inject({url:'/auth/csrf',headers:{cookie:extra}})).json().csrfToken;
    const sync=()=>company.inject({method:'POST',url:'/integrations/dingtalk/sync',headers:{cookie:manager,origin,'x-csrf-token':managerCsrf},payload:{}});
    assert.equal((await company.inject({method:'POST',url:'/integrations/dingtalk/sync',headers:{cookie:extra,origin,'x-csrf-token':extraCsrf},payload:{}})).statusCode,403);
    const before=(await company.inject({url:'/me',headers:{cookie:extra}})).json();assert.equal(before.role,'employee');assert.equal(before.executiveAccess,false);
    for(let run=0;run<2;run++){const result=await sync();assert.equal(result.statusCode,200,result.body);assert.equal(result.json().synchronized,4);}
    assert.deepEqual(departments,['123','123']);assert.deepEqual(individuals,[...additionalUserIds,...additionalUserIds]);
    const rows=(await db.query('SELECT u.id,u.role,u.active,e.external_user_id,e.union_id,e.external_department_id FROM users u JOIN external_identities e ON e.user_id=u.id WHERE e.corp_id=$1 ORDER BY e.external_user_id',['corp-exact-additional'])).rows;
    assert.equal(rows.length,4);assert.equal(rows.find(p=>p.external_user_id==='extra-1')!.id,before.id);
    for(const source of extras){const saved=rows.find(p=>p.external_user_id===source.externalUserId)!;assert.equal(saved.role,'employee');assert.equal(saved.active,true);assert.equal(saved.union_id,source.unionId);assert.equal(saved.external_department_id,source.departmentId);}
    const audits=await db.query('SELECT id FROM audit_events WHERE org_id=$1',['corp-exact-additional']);
    failExtra=true;assert.equal((await sync()).statusCode,403);failExtra=false;
    assert.equal((await db.query('SELECT id FROM audit_events WHERE org_id=$1',['corp-exact-additional'])).rows.length,audits.rows.length);
    assert.equal((await db.query('SELECT id FROM users WHERE org_id=$1 AND active=true',['corp-exact-additional'])).rows.length,4);
    // Session permissions come from the current database role; executive access remains separate.
    await db.query('UPDATE users SET role=$2 WHERE id=$1',[before.id,'manager']);
    const refreshed=(await company.inject({url:'/me',headers:{cookie:extra}})).json();assert.equal(refreshed.role,'manager');assert.equal(refreshed.executiveAccess,false);
    additionalUserIds.splice(0);assert.equal((await sync()).statusCode,200);
    assert.equal((await company.inject({url:'/me',headers:{cookie:extra}})).statusCode,401);
    assert.equal((await logIn('extra-1')).statusCode,403);
  }finally{await company.close();}
});

test('Additional member environment configuration is company-only and does not imply manager access',()=>{
  const base={NODE_ENV:'production',APP_PUBLIC_URL:origin,DINGTALK_CLIENT_ID:'fixture',DINGTALK_CLIENT_SECRET:'fixture',DINGTALK_CORP_ID:'corp',DINGTALK_ALLOWED_DEPARTMENT_IDS:'123',DINGTALK_MANAGER_USER_IDS:'manager',DINGTALK_ADDITIONAL_USER_IDS:'extra-1, extra-2,extra-1'};
  assert.throws(()=>integrationOptionsFromEnv(base),DingTalkError);
  const options=integrationOptionsFromEnv({...base,WORKOS_TEAM_MODE:'company'});
  assert.deepEqual(options.additionalUserIds,['extra-1','extra-2']);assert.deepEqual(options.allowedDepartmentIds,['123']);assert.deepEqual(options.executiveUserIds,[]);
});

test('DingTalk title and work place fill the profile by default, follow DingTalk changes, and never overwrite a WorkOS edit',async()=>{
  let title='Engineer',workPlace='东莞';
  const person={...employeeProfile,externalUserId:'employee-title',unionId:'union-title',departmentId:'123',departmentName:'First department'};
  const gateway={...ding,async authenticate(){return {...person,title,workPlace};}};
  const app2=await buildApp({db,environment:'production',closeDatabase:false,integrations:{dingtalk:gateway,corpId:'corp-title',appPublicUrl:origin,teamMode:'company',allowedDepartmentIds:['123'],teamName:'OneLaser'}});
  const login=async()=>{const start=await app2.inject('/auth/dingtalk/start'),state=new URL(start.headers.location!).searchParams.get('state')!,nonce=String(start.headers['set-cookie']).split(';')[0];const r=await app2.inject({url:`/auth/dingtalk/callback?state=${state}&authCode=x`,headers:{cookie:nonce}});assert.equal(r.statusCode,302,r.body);};
  const row=async()=>(await db.query("SELECT u.title,u.location FROM users u JOIN external_identities e ON e.user_id=u.id WHERE e.corp_id='corp-title' AND e.external_user_id='employee-title'")).rows[0];
  try{
    await login();assert.deepEqual(await row(),{title:'Engineer',location:'东莞'},'new member gets the DingTalk title and work place');
    await login();assert.deepEqual(await row(),{title:'Engineer',location:'东莞'},'existing member logs in again without errors');
    title='Senior Engineer';await login();assert.equal((await row()).title,'Senior Engineer','follows DingTalk changes');
    await db.query("UPDATE users SET title='Product Lead' WHERE id=(SELECT user_id FROM external_identities WHERE corp_id='corp-title' AND external_user_id='employee-title')");
    title='Staff Engineer';await login();assert.equal((await row()).title,'Product Lead','a WorkOS edit is kept');
  }finally{await app2.close();}
});
test('an administrator-disabled member cannot return through DingTalk login or directory sync',async()=>{
  await db.query("UPDATE users SET active=false,disabled_at=now() WHERE id=$1",[employeeId]);
  try{
    const start=await app.inject('/auth/dingtalk/start');const state=new URL(start.headers.location!).searchParams.get('state')!;const nonce=String(start.headers['set-cookie']).split(';')[0];
    const callback=await app.inject({url:`/auth/dingtalk/callback?state=${state}&authCode=employee`,headers:{cookie:nonce}});
    assert.equal(callback.statusCode,302,callback.body);assert.match(String(callback.headers.location),/login_error=disabled/);
    assert.ok(![callback.headers['set-cookie']].flat().map(String).some(v=>v.startsWith('__Host-workos_session=')&&!v.includes('Max-Age=0')),'no session issued');
    const sync=await request(managerCookie,managerCsrf,'POST','/integrations/dingtalk/sync');assert.equal(sync.statusCode,200,sync.body);
    assert.equal((await db.query('SELECT active FROM users WHERE id=$1',[employeeId])).rows[0].active,false,'sync keeps the member disabled');
  }finally{await db.query("UPDATE users SET active=true,disabled_at=NULL WHERE id=$1",[employeeId]);}
});
