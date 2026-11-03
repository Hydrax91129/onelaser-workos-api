import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { buildApp } from '../src/app.js';
import { createDatabase, schema, seedDemo, type Database } from '../src/db.js';
import { issueSession } from '../src/auth.js';
import { GrokBotAdapter, isPublicAddress } from '../src/integrations/grok-bot.js';
import { integrationOptionsFromEnv } from '../src/integrations/routes.js';
import { BotReviewJobs } from '../src/integrations/grok-bot-jobs.js';
import { ApiError } from '../src/errors.js';

const config={webhookUrl:'https://hooks.vendor.example/workos',webhookSecret:'synthetic-webhook-secret-only',allowedHost:'hooks.vendor.example',workerToken:'synthetic-worker-token-with-32-characters',orgId:'demo'};
async function harness(t:TestContext,transport?:typeof fetch){
  let admin:Database|undefined,isolatedSchema:string|undefined,db:Database|undefined,app:Awaited<ReturnType<typeof buildApp>>|undefined;
  t.after(async()=>{
    try{if(app)await app.close();else if(db)await db.close();}
    finally{if(admin){try{if(isolatedSchema)await admin.exec(`DROP SCHEMA ${isolatedSchema} CASCADE`);}finally{await admin.close();}}}
  });
  if(process.env.TEST_DATABASE_URL){
    isolatedSchema='workos_bot_'+randomUUID().replaceAll('-','');admin=await createDatabase({connectionString:process.env.TEST_DATABASE_URL});
    await admin.exec(`CREATE SCHEMA ${isolatedSchema}`);
    const url=new URL(process.env.TEST_DATABASE_URL);url.searchParams.set('options',`-c search_path=${isolatedSchema}`);
    db=await createDatabase({connectionString:url.toString()});
  }else db=await createDatabase();
  await db.exec(schema);await seedDemo(db);
  const dispatches:{url:string;init:RequestInit;body:any}[]=[];
  const adapter=new GrokBotAdapter(config,async(input,init)=>{dispatches.push({url:String(input),init:init!,body:JSON.parse(String(init?.body))});return transport?transport(input,init):new Response('{}',{status:200});});
  app=await buildApp({db,environment:'production',integrations:{aiReviewMode:'bot',bot:adapter,appPublicUrl:'https://work.example'}});
  const tokens:Record<string,string>={};for(const id of ['m1','m2','m3','m5'])tokens[id]=(await issueSession(db,id)).accessToken;
  const call=(user:string,method:'GET'|'POST',url:string,payload?:unknown)=>app!.inject({method,url,payload:payload as any,headers:{authorization:'Bearer '+tokens[user],'accept-language':'en'}});
  const rpc=(name:string,args:unknown,token=config.workerToken)=>app!.inject({method:'POST',url:'/integrations/grok-bot/mcp',headers:{authorization:'Bearer '+token,'mcp-protocol-version':'2025-11-25',accept:'application/json, text/event-stream'},payload:{jsonrpc:'2.0',id:1,method:'tools/call',params:{name,arguments:args}}});
  async function createSubmission(){
    const created=await call('m1','POST','/tasks',{title:'Synthetic evidence review',description:'Check the provided text only.',ownerId:'m2',criteria:['Provide source evidence'],dueAt:'2026-12-01T12:00:00Z'});assert.equal(created.statusCode,201,created.body);
    const task=created.json();const submission=await call('m2','POST',`/tasks/${task.id}/submissions`,{expectedVersion:task.version,title:'Synthetic result report',description:'Synthetic evidence text that a human can verify.'});assert.equal(submission.statusCode,201,submission.body);
    return {id:task.id,version:submission.json().taskVersion};
  }
  async function enqueue(id:string){const response=await call('m2','POST',`/tasks/${id}/analyze`,{});assert.equal(response.statusCode,202,response.body);return response.json().job;}
  return {db,app,call,rpc,createSubmission,enqueue,dispatches,tokens};
}
function toolData(response:any){const body=response.json();assert.equal(response.statusCode,200,response.body);assert(!body.result?.isError,response.body);return body.result.structuredContent||JSON.parse(body.result.content[0].text);}
function toolError(response:any,code:string,status?:number){const body=response.json();assert.equal(response.statusCode,200,response.body);assert.equal(body.result?.isError,true,response.body);const data=JSON.parse(body.result.content[0].text);assert.equal(data.error.code,code,response.body);if(status)assert.equal(data.error.status,status);}
function assessment(job:any){return {summary:'Synthetic source supports a human check.',criteria:job.task.criteria.map((c:any)=>({criterionId:c.id,finding:'supported',reason:'Provided text is available.',evidenceRefs:[job.sources[1].id],quotes:[job.sources[1].text]})),missingEvidence:[],uncertainties:['External sources were not inspected.'],humanReviewRequired:true};}

test('Bot configuration selects only its own missing names and never leaks secrets or requires model API credit',async t=>{
  const absent=integrationOptionsFromEnv({AI_REVIEW_MODE:'bot',DINGTALK_CORP_ID:'demo'});assert.equal(absent.aiReviewMode,'bot');assert(!absent.ai);assert(!absent.bot);assert(!absent.setup?.aiMissing.includes('AI_PROVIDER_API_KEY'));assert(!absent.setup?.aiMissing.includes('GROK_BOT_ORG_ID'));
  const options=integrationOptionsFromEnv({AI_REVIEW_MODE:'bot',GROK_BOT_ORG_ID:'demo',GROK_BOT_WEBHOOK_URL:config.webhookUrl,GROK_BOT_WEBHOOK_SECRET:config.webhookSecret,GROK_BOT_WEBHOOK_ALLOWED_HOST:config.allowedHost,GROK_BOT_WORKER_TOKEN:config.workerToken,AI_PROVIDER_API_KEY:'unused',AI_MODEL_ID:'unused'});assert(options.bot);assert(!options.ai);assert.deepEqual(options.setup?.aiMissing,[]);
  const h=await harness(t);const caps=(await h.app.inject('/capabilities')).json();assert.equal(caps.aiReviewMode,'bot');assert.equal(caps.aiReview,'configured');assert(!JSON.stringify(caps).includes(config.workerToken));assert(!JSON.stringify(caps).includes(config.webhookSecret));
  assert.equal(integrationOptionsFromEnv({}).aiReviewMode,'api');assert.throws(()=>integrationOptionsFromEnv({AI_REVIEW_MODE:'other'}));
});
test('Webhook configuration refuses local/private literals, credentials, fragments, query strings and hostname mismatches',()=>{
  for(const webhookUrl of ['http://hooks.vendor.example/path','https://127.0.0.1/path','https://[::1]/path','https://localhost/path','https://user:pass@hooks.vendor.example/path','https://hooks.vendor.example/path?secret=x','https://hooks.vendor.example/path#x','https://other.example/path','https://hooks.vendor.example:8443/path'])assert.throws(()=>new GrokBotAdapter({...config,webhookUrl}));
  assert.throws(()=>new GrokBotAdapter({...config,workerToken:'short'}));assert.throws(()=>new GrokBotAdapter({...config,workerToken:config.webhookSecret}));
  for(const ip of ['0.0.0.0','127.0.0.1','10.0.0.1','100.64.0.1','169.254.169.254','172.16.0.1','192.168.1.1','224.0.0.1','::1','fc00::1','fe80::1','::ffff:127.0.0.1'])assert.equal(isPublicAddress(ip),false,ip);
  assert.equal(isPublicAddress('8.8.8.8'),true);assert.equal(isPublicAddress('2606:4700:4700::1111'),true);
});
test('Persisted jobs deduplicate concurrent analyze requests and send only a job ID; webhook 200 is not completion',async t=>{
  let started!:()=>void,release!:()=>void;const startedPromise=new Promise<void>(r=>started=r),wait=new Promise<void>(r=>release=r);
  const h=await harness(t,async()=>{started();await wait;return new Response('{}',{status:200});});const task=await h.createSubmission();
  const first=Promise.resolve(h.call('m2','POST',`/tasks/${task.id}/analyze`,{}));await startedPromise;
  const second=await h.call('m1','POST',`/tasks/${task.id}/analyze`,{});assert.equal(second.statusCode,202,second.body);assert.equal(second.json().job.status,'dispatching');assert.equal(h.dispatches.length,1);
  release();const accepted=await first;assert.equal(accepted.json().job.id,second.json().job.id);assert.equal(accepted.json().job.status,'pending');
  assert.deepEqual(h.dispatches[0].body,{jobId:accepted.json().job.id});assert.equal(h.dispatches[0].init.redirect,'error');assert.equal(new Headers(h.dispatches[0].init.headers).get('Authorization'),'Bearer '+config.webhookSecret);
  const safe=(await h.call('m2','GET',`/tasks/${task.id}/analysis-jobs`)).json().items[0];assert.deepEqual(Object.keys(safe).sort(),['id','status','submissionVersion','createdAt','expiresAt'].sort());assert.equal((await h.call('m2','GET',`/tasks/${task.id}/evaluations`)).json().items.length,0);
});
test('Atomic lease and valid completion share citation validation, are idempotent, cache results and leave human state unchanged',async t=>{
  const h=await harness(t),task=await h.createSubmission(),job=await h.enqueue(task.id);
  const leased=toolData(await h.rpc('workos_get_review_job',{jobId:job.id}));
  const {leaseToken,...evidencePayload}=leased;
  // The authorized random lease token can coincidentally contain the short fixture ID.
  assert.equal(leaseToken.length,43);assert(!JSON.stringify(evidencePayload).includes('m2'));assert.equal(leased.urlContentsFetched,false);
  toolError(await h.rpc('workos_get_review_job',{jobId:job.id}),'BOT_LEASE_ACTIVE',409);
  const result=assessment(leased),args={jobId:job.id,leaseToken:leased.leaseToken,result};
  const completed=toolData(await h.rpc('workos_submit_review',args));assert.equal(completed.status,'completed');assert.equal(completed.idempotent,false);
  const replay=toolData(await h.rpc('workos_submit_review',args));assert.equal(replay.idempotent,true);assert.equal(replay.evaluationId,completed.evaluationId);
  toolError(await h.rpc('workos_submit_review',{...args,result:{...result,summary:'Conflicting summary'}}),'BOT_COMPLETION_CONFLICT',409);
  const cached=await h.call('m1','POST',`/tasks/${task.id}/analyze`,{});assert.equal(cached.statusCode,200,cached.body);assert.equal(cached.json().cached,true);assert.equal(cached.json().evaluation.model,'grok-bot');assert.equal(h.dispatches.length,1);
  const detail=(await h.call('m1','GET',`/tasks/${task.id}`)).json();assert.equal(detail.status,'submitted');assert.equal(detail.currentReview,null);assert.equal(detail.version,task.version);
});
test('Malformed assessments, fabricated quotes, missing criteria and personnel fields cannot be stored',async t=>{
  const h=await harness(t),task=await h.createSubmission(),job=await h.enqueue(task.id),leased=toolData(await h.rpc('workos_get_review_job',{jobId:job.id})),valid=assessment(leased);
  const fabricated=structuredClone(valid);fabricated.criteria[0].quotes=['Invented result'];
  const unauthorized=structuredClone(valid);unauthorized.criteria[0].evidenceRefs=['submission:other:description'];
  for(const result of [fabricated,unauthorized,{...valid,criteria:[]},{...valid,humanReviewRequired:false},{...valid,quality:100},{...valid,retentionScore:99}])toolError(await h.rpc('workos_submit_review',{jobId:job.id,leaseToken:leased.leaseToken,result}),'AI_INVALID_OUTPUT');
  assert.equal((await h.call('m2','GET',`/tasks/${task.id}/evaluations`)).json().items.length,0);assert.equal((await h.call('m2','GET',`/tasks/${task.id}/analysis-jobs/${job.id}`)).json().job.status,'leased');
});
test('An identical committed completion remains a receipt after a new submission, without attaching the old assessment to it',async t=>{
  const h=await harness(t),task=await h.createSubmission(),job=await h.enqueue(task.id),leased=toolData(await h.rpc('workos_get_review_job',{jobId:job.id})),args={jobId:job.id,leaseToken:leased.leaseToken,result:assessment(leased)};
  const completed=toolData(await h.rpc('workos_submit_review',args));
  const updated=await h.call('m2','POST',`/tasks/${task.id}/submissions`,{expectedVersion:task.version,title:'A newer submission',description:'The new version contains different evidence text.'});assert.equal(updated.statusCode,201);
  const replay=toolData(await h.rpc('workos_submit_review',args));assert.equal(replay.idempotent,true);assert.equal(replay.evaluationId,completed.evaluationId);
  const rows=(await h.call('m2','GET',`/tasks/${task.id}/evaluations`)).json().items;assert.equal(rows.length,1);assert.equal(rows[0].submission_version,1);
  await h.db.query('UPDATE users SET active=false WHERE id=$1',['m2']);toolError(await h.rpc('workos_submit_review',args),'BOT_REQUESTER_UNAVAILABLE',409);
});
test('Business task scope, worker-only auth and explicit tenant reject employees, cookie sessions and other organizations',async t=>{
  const h=await harness(t),task=await h.createSubmission(),job=await h.enqueue(task.id);
  for(const user of ['m3','m5'])for(const suffix of ['analysis-jobs',`analysis-jobs/${job.id}`])assert.equal((await h.call(user,'GET',`/tasks/${task.id}/${suffix}`)).statusCode,404);
  assert.equal((await h.call('m3','POST',`/tasks/${task.id}/analysis-jobs/${job.id}/retry`,{})).statusCode,404);
  assert.equal((await h.rpc('workos_get_review_job',{jobId:job.id},h.tokens.m2)).statusCode,401);
  assert.equal((await h.app.inject({url:'/me',headers:{authorization:'Bearer '+config.workerToken}})).statusCode,401);
  assert.equal((await h.app.inject({method:'POST',url:'/integrations/grok-bot/mcp',headers:{cookie:'__Host-workos_session='+h.tokens.m2},payload:{jsonrpc:'2.0',id:1,method:'ping'}})).statusCode,401);
  await h.db.query('UPDATE ai_review_jobs SET org_id=$2 WHERE id=$1',[job.id,'other-org']);toolError(await h.rpc('workos_get_review_job',{jobId:job.id}),'NOT_FOUND',404);
});
test('Requester deactivation or a changed authorization scope invalidates job access and completion',async t=>{
  const h=await harness(t),task=await h.createSubmission(),job=await h.enqueue(task.id),leased=toolData(await h.rpc('workos_get_review_job',{jobId:job.id}));
  await h.db.query('UPDATE users SET active=false WHERE id=$1',['m2']);toolError(await h.rpc('workos_submit_review',{jobId:job.id,leaseToken:leased.leaseToken,result:assessment(leased)}),'BOT_REQUESTER_UNAVAILABLE',409);
  assert.equal((await h.call('m2','GET',`/tasks/${task.id}/analysis-jobs`)).statusCode,401);
  await h.db.query('UPDATE users SET active=true,department_id=$2 WHERE id=$1',['m2','product']);await h.db.query('UPDATE tasks SET owner_id=$2 WHERE id=$1',[task.id,'m3']);toolError(await h.rpc('workos_get_review_job',{jobId:job.id}),'BOT_REQUESTER_UNAVAILABLE',409);
});
test('New submission invalidates an old lease and retry; no stale evaluation is inserted',async t=>{
  const h=await harness(t),task=await h.createSubmission(),job=await h.enqueue(task.id),leased=toolData(await h.rpc('workos_get_review_job',{jobId:job.id}));
  const next=await h.call('m2','POST',`/tasks/${task.id}/submissions`,{expectedVersion:task.version,title:'Updated evidence version',description:'This current submission replaces the original source.'});assert.equal(next.statusCode,201);
  toolError(await h.rpc('workos_submit_review',{jobId:job.id,leaseToken:leased.leaseToken,result:assessment(leased)}),'BOT_JOB_STALE',409);
  assert.equal((await h.call('m2','POST',`/tasks/${task.id}/analysis-jobs/${job.id}/retry`,{})).statusCode,409);
  assert.equal((await h.call('m2','GET',`/tasks/${task.id}/evaluations`)).json().items.length,0);
  const current=await h.enqueue(task.id);assert.notEqual(current.id,job.id);assert.equal(current.submissionVersion,2);
});
test('Expired jobs and expired leases are visible and reject completion; explicit retry supersedes the old lease exactly once',async t=>{
  const h=await harness(t),task=await h.createSubmission(),job=await h.enqueue(task.id),leased=toolData(await h.rpc('workos_get_review_job',{jobId:job.id}));
  await h.db.query('UPDATE ai_review_jobs SET lease_expires_at=$2 WHERE id=$1',[job.id,'2000-01-01T00:00:00Z']);
  const old=(await h.call('m2','GET',`/tasks/${task.id}/analysis-jobs/${job.id}`)).json().job;assert.equal(old.status,'expired');assert.equal(old.errorCode,'BOT_LEASE_EXPIRED');
  toolError(await h.rpc('workos_submit_review',{jobId:job.id,leaseToken:leased.leaseToken,result:assessment(leased)}),'BOT_LEASE_EXPIRED',410);
  const retry=await h.call('m2','POST',`/tasks/${task.id}/analysis-jobs/${job.id}/retry`,{});assert.equal(retry.statusCode,202,retry.body);const replacement=retry.json().job;
  const repeated=await h.call('m1','POST',`/tasks/${task.id}/analysis-jobs/${job.id}/retry`,{});assert.equal(repeated.json().job.id,replacement.id);assert.equal(h.dispatches.length,2);
  toolError(await h.rpc('workos_submit_review',{jobId:job.id,leaseToken:leased.leaseToken,result:assessment(leased)}),'BOT_JOB_SUPERSEDED',409);
  await h.db.query('UPDATE ai_review_jobs SET expires_at=$2 WHERE id=$1',[replacement.id,'2000-01-01T00:00:00Z']);assert.equal((await h.call('m2','GET',`/tasks/${task.id}/analysis-jobs/${replacement.id}`)).json().job.errorCode,'BOT_JOB_EXPIRED');toolError(await h.rpc('workos_get_review_job',{jobId:replacement.id}),'BOT_JOB_EXPIRED',410);
});
test('A human review changes the task version; only an explicit fresh analyze can replace the now-stale job',async t=>{
  // This scenario covers a reviewer deciding before the bot replies, which needs the documented opt-out of the AI requirement.
  process.env.REQUIRE_AI_ASSESSMENT='false';t.after(()=>{delete process.env.REQUIRE_AI_ASSESSMENT;});
  const h=await harness(t),task=await h.createSubmission(),job=await h.enqueue(task.id),leased=toolData(await h.rpc('workos_get_review_job',{jobId:job.id}));
  const accepted=await h.call('m1','POST',`/tasks/${task.id}/reviews`,{expectedVersion:task.version,submissionVersion:1,decision:'accept',quality:9,note:'Human explicitly inspected this synthetic evidence.',verifiedCurrentSubmission:true});assert.equal(accepted.statusCode,201,accepted.body);
  toolError(await h.rpc('workos_submit_review',{jobId:job.id,leaseToken:leased.leaseToken,result:assessment(leased)}),'BOT_JOB_STALE',409);assert.equal(h.dispatches.length,1);
  const fresh=await h.enqueue(task.id);assert.notEqual(fresh.id,job.id);assert.equal(h.dispatches.length,2);
  assert.equal((await h.call('m2','GET',`/tasks/${task.id}/analysis-jobs/${job.id}`)).json().job.status,'superseded');
  const detail=(await h.call('m1','GET',`/tasks/${task.id}`)).json();assert.equal(detail.status,'accepted');assert.equal(detail.currentReview.quality,9);
});
test('Timeout has an unknown outcome, non-200 is failed, and neither path automatically replays or claims completion',async t=>{
  for(const outcome of ['timeout','non200']as const){
    const h=await harness(t,async()=>{if(outcome==='timeout')throw new DOMException('synthetic secret must not leak','TimeoutError');return new Response('synthetic secret must not leak',{status:429});}),task=await h.createSubmission(),job=await h.enqueue(task.id);
    assert.equal(job.status,outcome==='timeout'?'dispatch_unknown':'failed');assert.equal(job.errorCode,outcome==='timeout'?'BOT_DISPATCH_UNKNOWN':'BOT_DISPATCH_REJECTED');assert(!JSON.stringify(job).includes('synthetic secret'));
    assert.equal((await h.call('m2','POST',`/tasks/${task.id}/analyze`,{})).json().job.id,job.id);assert.equal(h.dispatches.length,1);
    assert.equal((await h.call('m2','POST',`/tasks/${task.id}/analysis-jobs/${job.id}/retry`,{})).statusCode,202);assert.equal(h.dispatches.length,2);
    assert.equal((await h.call('m2','GET',`/tasks/${task.id}/evaluations`)).json().items.length,0);
  }
});
test('The durable organization budget allows ten new dispatches per UTC hour; cached jobs and service restarts cannot spend or reset it',async t=>{
  const h=await harness(t),user=(await h.db.query('SELECT * FROM users WHERE id=$1',['m2'])).rows[0];let dispatches=0;
  const adapter=new GrokBotAdapter(config,async()=>{dispatches++;return new Response('{}',{status:200});});
  const service=new BotReviewJobs(h.db,adapter);
  for(let index=0;index<10;index++){
    const task=await h.createSubmission();const first=await service.analyze(user,task.id,'en');assert.equal(first.statusCode,202);
    await service.analyze(user,task.id,'en');assert.equal(dispatches,index+1);
  }
  const other=await h.createSubmission(),afterRestart=new BotReviewJobs(h.db,adapter);
  await assert.rejects(afterRestart.analyze(user,other.id,'en'),(error:unknown)=>error instanceof ApiError&&error.status===429&&error.code==='RATE_LIMITED');assert.equal(dispatches,10);
  assert.equal((await h.db.query('SELECT attempts FROM bot_dispatch_budgets')).rows[0].attempts,10);
});
