import {before,after,test} from 'node:test';
import assert from 'node:assert/strict';
import {randomBytes} from 'node:crypto';
import {buildApp} from '../src/app.js';
import {createDatabase,schema,seedDemo,type Database} from '../src/db.js';
import {COMPLETION_LOCK_MS} from '../src/completions.js';
let db:Database,app:Awaited<ReturnType<typeof buildApp>>;const tokens:Record<string,string>={},secret=randomBytes(32).toString('hex');
const seen:any[]=[];
const model={model:'fake-scorer',json:async(system:string,user:string,_s:object,name:string)=>{seen.push({system,user,name});if(name==='report_insights')return {sentences:['One.','Two.','Three.']};const u=JSON.parse(user);return {score:u.result.includes('link')?9.5:3.5,summary:'synthetic summary'};}};
before(async()=>{db=await createDatabase();await db.exec(schema);await seedDemo(db);
  app=await buildApp({db,allowDevLogin:true,devLoginSecret:secret,completionModel:model,integrations:{executiveUserIds:['m4']},fxFetcher:(async()=>new Response(JSON.stringify({date:'2026-10-30',rates:{CNY:7.13}}),{status:200})) as any});
  for(const userId of ['m1','m2','m3','m4'])tokens[userId]=(await app.inject({method:'POST',url:'/auth/dev-login',payload:{userId,secret}})).json().accessToken;});
after(async()=>{await app.close();});
const call=(who:string,method:'GET'|'POST',url:string,payload?:any)=>app.inject({method,url,payload,headers:{authorization:'Bearer '+tokens[who]}});
async function create(owner='m2'){const r=await call(owner,'POST','/tasks',{title:'Completion fixture task',description:'Internal fictional fixture',ownerId:owner,criteria:['Provide evidence'],dueAt:'2026-11-10T12:00:00Z'});assert.equal(r.statusCode,201,r.body);return r.json();}
// Pretend the completion happened `hours` ago (the 24-hour human scoring window is measured from created_at).
const age=async(taskId:string,hours=25)=>{await db.query(`UPDATE task_completions SET created_at=now()-($2::int*interval '1 hour') WHERE task_id=$1 AND superseded_at IS NULL`,[taskId,hours]);};
const runJob=async()=>{const r=await call('m4','POST','/completions/auto-score/run',{});assert.equal(r.statusCode,200,r.body);return r.json().started;};
const scoreCalls=()=>seen.filter(x=>x.name==='task_completion_score').length;

test('completing does not score right away; after 24 h with no human score the job scores with AI; the score shows on the board',async()=>{
  const t=await create(),before=scoreCalls();
  const good=await call('m2','POST',`/tasks/${t.id}/complete`,{expectedVersion:t.version,result:'Shipped the fictional page; here is the link and the before/after numbers.',selfReview:'Met the goal; one follow-up left.'});
  assert.equal(good.statusCode,201,good.body);assert.equal(good.json().completion.final_score,null);assert.ok(good.json().completion.score_due_at);
  await runJob();assert.equal(scoreCalls(),before,'no AI call inside the 24-hour window');
  const early=(await call('m2','GET',`/tasks/${t.id}/completion`)).json();assert.equal(early.completion.final_score,null);assert.equal(early.canRetryScore,false,'no AI retry inside the window');
  const r=await call('m2','POST',`/tasks/${t.id}/completion/rescore`,{});assert.equal(r.statusCode,409);assert.equal(r.json().error.code,'SCORE_WINDOW_OPEN');
  await age(t.id);assert.ok(await runJob()>=1);
  const c=(await call('m2','GET',`/tasks/${t.id}/completion`)).json();assert.equal(c.completion.ai_status,'scored');assert.equal(Number(c.completion.ai_score),9.5);assert.equal(Number(c.completion.final_score),9.5);assert.equal(c.completion.score_source,'ai');assert.equal(c.locked,false);
  assert.ok(seen.at(-1).system.includes('untrusted data'),'task text is treated as data');
  const board=(await call('m2','GET','/task-board')).json(),row=board.items.find((x:any)=>x.id===t.id);assert.equal(Number(row.completion.final_score),9.5);assert.equal(row.completion.score_source,'ai');
  const t2=await create(),weak=await call('m2','POST',`/tasks/${t2.id}/complete`,{expectedVersion:t2.version,result:'Finished the thing that was assigned to me last week.',selfReview:'It is done now.'});assert.equal(weak.statusCode,201);await age(t2.id);await runJob();
  assert.equal(Number((await call('m2','GET',`/tasks/${t2.id}/completion`)).json().completion.ai_score),3.5);
});

test('a human score within 24 h is final and the AI never runs; the owner cannot score; scores are immutable',async()=>{
  const t=await create(),before=scoreCalls();
  const done=(await call('m2','POST',`/tasks/${t.id}/complete`,{expectedVersion:t.version,result:'Delivered the fictional brochure with a link to the shared folder.',selfReview:'Done.'})).json();
  const own=await call('m2','POST',`/tasks/${t.id}/completion/score`,{completionId:done.completion.id,score:10});assert.equal(own.statusCode,403);assert.equal(own.json().error.code,'SELF_SCORE_FORBIDDEN');
  assert.equal((await call('m3','POST',`/tasks/${t.id}/completion/score`,{completionId:done.completion.id,score:9})).statusCode,404,'an unrelated colleague cannot see or score it');
  assert.equal((await call('m1','POST',`/tasks/${t.id}/completion/score`,{completionId:done.completion.id,score:11})).statusCode,400);
  assert.equal((await call('m1','POST',`/tasks/${t.id}/completion/score`,{completionId:done.completion.id,score:7.25})).statusCode,400,'one decimal at most');
  assert.equal((await call('m1','GET',`/tasks/${t.id}/completion`)).json().canHumanScore,true);
  const s=await call('m1','POST',`/tasks/${t.id}/completion/score`,{completionId:done.completion.id,score:7.5,note:'Clear and verified.'});assert.equal(s.statusCode,200,s.body);
  assert.equal(Number(s.json().completion.final_score),7.5);assert.equal(s.json().completion.score_source,'human');assert.equal(s.json().completion.human_scored_by,'m1');
  const again=await call('m1','POST',`/tasks/${t.id}/completion/score`,{completionId:done.completion.id,score:9});assert.equal(again.statusCode,409);assert.equal(again.json().error.code,'SCORE_FINAL');
  const inbox=(await db.query("SELECT user_id FROM inbox_items WHERE task_id=$1 AND kind='completion_scored'",[t.id])).rows;assert.deepEqual(inbox.map((r:any)=>r.user_id),['m2']);
  await age(t.id,48);await runJob();assert.equal(scoreCalls(),before,'the AI never scores a human-scored completion');
  const c=(await call('m2','GET',`/tasks/${t.id}/completion`)).json().completion;assert.equal(c.ai_status,'pending');assert.equal(Number(c.final_score),7.5);
  assert.equal((await call('m2','POST',`/tasks/${t.id}/completion/rescore`,{})).json().completion.score_source,'human','retry returns the final score without calling the AI');assert.equal(scoreCalls(),before);
});

test('the job never scores a completion twice, even when run concurrently or repeatedly',async()=>{
  const t=await create();
  await call('m2','POST',`/tasks/${t.id}/complete`,{expectedVersion:t.version,result:'Wrote the fictional FAQ and linked it from the help page.',selfReview:'Done.'});
  await age(t.id);const before=scoreCalls();
  await Promise.all([runJob(),runJob(),runJob()]);await runJob();
  assert.equal(scoreCalls(),before+1);
  const rows=(await db.query("SELECT count(*)::int n FROM audit_events WHERE action='task.completion_scored' AND object_id=$1",[t.id])).rows[0].n;assert.equal(rows,1);
});

test('backfill: old unavailable or failed completions without a human score are scored by the job once a model is configured',async()=>{
  const a=await create(),b=await create(),fresh=await create();
  for(const t of [a,b,fresh])await call('m2','POST',`/tasks/${t.id}/complete`,{expectedVersion:t.version,result:'Published the fictional changelog with a link to the release.',selfReview:'Done.'});
  await db.query("UPDATE task_completions SET ai_status='unavailable' WHERE task_id=$1",[a.id]);
  await db.query("UPDATE task_completions SET ai_status='failed',ai_attempts=1,ai_attempted_at=now()-interval '3 days' WHERE task_id=$1",[b.id]);
  await db.query("UPDATE task_completions SET ai_status='unavailable' WHERE task_id=$1",[fresh.id]);
  await age(a.id,72);await age(b.id,72);
  await runJob();
  for(const t of [a,b]){const c=(await call('m2','GET',`/tasks/${t.id}/completion`)).json().completion;assert.equal(c.score_source,'ai',t.id);assert.equal(Number(c.final_score),9.5);}
  assert.equal((await call('m2','GET',`/tasks/${fresh.id}/completion`)).json().completion.final_score,null,'still inside its 24-hour window');
});

test('after 3 days the completion and score are locked: no reopen, no resubmit',async()=>{
  const t=await create();
  const r=await call('m2','POST',`/tasks/${t.id}/complete`,{expectedVersion:t.version,result:'Delivered the fictional report with a link to the shared folder.',selfReview:'Complete and verified.'});assert.equal(r.statusCode,201);
  await db.query('UPDATE tasks SET board_done_at=$2 WHERE id=$1',[t.id,new Date(Date.now()-COMPLETION_LOCK_MS-1000).toISOString()]);
  const v=(await call('m2','GET',`/tasks/${t.id}`)).json().version;
  const reopen=await call('m2','POST',`/tasks/${t.id}/board`,{expectedVersion:v,status:'working'});assert.equal(reopen.statusCode,409);assert.equal(reopen.json().error.code,'COMPLETION_LOCKED');
  const again=await call('m2','POST',`/tasks/${t.id}/complete`,{expectedVersion:v,result:'Trying to change the locked result after the window closed.',selfReview:'Changed my mind.'});assert.equal(again.json().error.code,'COMPLETION_LOCKED');
  assert.equal((await call('m2','GET',`/tasks/${t.id}/completion`)).json().locked,true);
  const board=(await call('m2','GET','/task-board')).json();assert.equal(board.items.find((x:any)=>x.id===t.id).effective_group_id,'completed');
});

test('attachments: allowed types only, size-checked, scoped to visible tasks, downloaded with nosniff',async()=>{
  const t=await create();
  const ok=await call('m2','POST',`/tasks/${t.id}/attachments`,{name:'result.png',mime:'image/png',dataBase64:Buffer.from('fake-png-bytes').toString('base64')});assert.equal(ok.statusCode,201,ok.body);
  assert.equal((await call('m2','POST',`/tasks/${t.id}/attachments`,{name:'x.html',mime:'text/html',dataBase64:Buffer.from('<script>').toString('base64')})).statusCode,400);
  assert.equal((await call('m4','POST',`/tasks/${t.id}/attachments`,{name:'a.png',mime:'image/png',dataBase64:'AAAA'})).statusCode,404);
  const dl=await call('m2','GET',`/tasks/${t.id}/attachments/${ok.json().id}`);assert.equal(dl.statusCode,200);assert.equal(dl.headers['x-content-type-options'],'nosniff');assert.equal(dl.body,'fake-png-bytes');
  assert.match(dl.headers['content-security-policy'] as string,/sandbox/,'non-PDF files stay sandboxed');
  const pdf=await call('m2','POST',`/tasks/${t.id}/attachments`,{name:'示例.pdf',mime:'application/pdf',dataBase64:Buffer.from('%PDF-1.4 fictional').toString('base64')});assert.equal(pdf.statusCode,201,pdf.body);
  const pdfDl=await call('m2','GET',`/tasks/${t.id}/attachments/${pdf.json().id}`);const csp=String(pdfDl.headers['content-security-policy']);
  assert.doesNotMatch(csp,/sandbox/,'Chrome refuses to show a sandboxed PDF');assert.doesNotMatch(csp,/script-src/);assert.match(csp,/frame-ancestors 'self'/);assert.match(String(pdfDl.headers['content-disposition']),/^inline/);
  const done=await call('m2','POST',`/tasks/${t.id}/complete`,{expectedVersion:t.version,result:'Uploaded the screenshot of the fictional result as evidence.',selfReview:'Evidence attached.',attachmentIds:[ok.json().id]});assert.equal(done.statusCode,201,done.body);
  assert.equal((await call('m2','POST',`/tasks/${(await create()).id}/complete`,{expectedVersion:1,result:'Referencing an attachment from a different task is not allowed.',selfReview:'Should fail.',attachmentIds:[ok.json().id]})).statusCode,400);
});

test('reporting lines: superiors see reports’ tasks, reports never see superiors’ tasks',async()=>{
  await db.query("UPDATE users SET manager_id='m1' WHERE id='m2'");await db.query("UPDATE users SET manager_id=NULL WHERE id='m1'");
  const mine=(await call('m1','POST','/tasks',{title:'Superior own task',description:'Internal fictional fixture',ownerId:'m1',reviewerId:'m4',criteria:['x'],dueAt:'2026-11-10T12:00:00Z'}));
  const own=mine.statusCode===201?mine.json():null;
  const sub=await create('m2');
  const m1list=(await call('m1','GET','/tasks')).json().items.map((x:any)=>x.id);assert.ok(m1list.includes(sub.id),'superior sees report');
  const m2list=(await call('m2','GET','/tasks')).json().items;assert.ok(m2list.every((x:any)=>x.owner_id==='m2'||x.reviewer_id==='m2'),'report sees only own work');
  if(own){assert.equal((await call('m2','GET',`/tasks/${own.id}`)).statusCode,404);}
  await db.query("UPDATE users SET manager_id=NULL");
});

test('AI insights take aggregated facts, return 3–4 sentences, and live FX is cached with a sane range',async()=>{
  const r=await call('m2','POST','/insights',{board:'supply',lang:'zh',facts:{usValue:217664,agedOver90Pct:97,reorder:['XRF (US 14)']}});assert.equal(r.statusCode,200,r.body);assert.equal(r.json().sentences.length,3);
  assert.equal((await call('m2','POST','/insights',{board:'nope',facts:{}})).statusCode,400);
  const fx=(await call('m2','GET','/fx')).json();assert.equal(fx.rate,7.13);assert.equal(fx.asOf,'2026-10-30');
  const lb=(await call('m3','GET','/reports/leaderboard')).json();assert.ok(lb.items.length>0);assert.ok(lb.items.every((x:any)=>!('title_of_task' in x)&&typeof x.total==='number'));const m2=lb.items.find((x:any)=>x.id==='m2');assert.ok(m2.done>=m2.scored_done&&m2.scored_done>=1&&m2.avg_score>0);assert.equal(m2.scored_done,m2.human_scored+m2.ai_scored);
  const caps=(await app.inject('/capabilities')).json();assert.equal(caps.taskCompletion,true);assert.equal(caps.aiInsights,true);
});

test('leaderboard: a completion counts as done immediately, scored or not; the quality average uses final scores',async()=>{
  const lbFor=async()=>(await call('m2','GET','/reports/leaderboard')).json().items.find((x:any)=>x.id==='m3');
  const start=await lbFor();
  const t=await create('m3');const done=(await call('m3','POST',`/tasks/${t.id}/complete`,{expectedVersion:t.version,result:'Finished the fictional survey summary and shared the link.',selfReview:'Done.'})).json();
  const after=await lbFor();assert.equal(after.done,start.done+1,'counted right after completion');assert.equal(after.scored_done,start.scored_done,'not scored yet');
  await call('m1','POST',`/tasks/${t.id}/completion/score`,{completionId:done.completion.id,score:6});
  const t2=await create('m3');await call('m3','POST',`/tasks/${t2.id}/complete`,{expectedVersion:t2.version,result:'Shipped the fictional banner and attached the link.',selfReview:'Done.'});await age(t2.id);await runJob();
  const scored=await lbFor();assert.equal(scored.done,start.done+2);assert.equal(scored.human_scored,start.human_scored+1);assert.equal(scored.ai_scored,start.ai_scored+1);
  assert.equal(start.scored_done,0,'fixture: m3 starts the month without scored completions');assert.equal(scored.avg_score,7.8,'(6 human + 9.5 AI) / 2 rounded to one decimal');
});
