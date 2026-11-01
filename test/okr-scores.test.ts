import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createDatabase,schema,seedDemo} from '../src/db.js';
import {buildApp} from '../src/app.js';
import {issueSession} from '../src/auth.js';

async function setup(){
 const db=await createDatabase();await db.exec(schema);await db.exec(schema);await seedDemo(db);
 const app=await buildApp({db,integrations:{executiveUserIds:['m4']},completionModel:null,translationModel:null,mailer:null,nudgeIntervalMs:0});
 const tokens:Record<string,string>={};
 const call=async(who:string,method:'GET'|'POST'|'PATCH',url:string,payload?:any)=>{tokens[who]??=(await issueSession(db,who)).accessToken;return app.inject({method,url,payload,headers:{authorization:'Bearer '+tokens[who]}});};
 return {app,call};
}
const period=new Date().toISOString().slice(0,7),due=new Date(Date.now()+20*864e5).toISOString().slice(0,10);

test('key results: six score levels, final = 50% self + 50% leader, leader can veto an untrue self score',async()=>{
 const {app,call}=await setup();
 try{
  const o=(await call('m2','POST','/objectives',{title:'Hydra 产品页转化率提升',level:'personal',planning:{period,weight:100,scoringDueDate:due}})).json();
  const kr=await call('m2','POST',`/objectives/${o.id}/key-results`,{title:'转化率到 3%',baseline:0,target:1,direction:'increase',unit:'完成',planning:{weight:100,targetText:'完成'}});assert.equal(kr.statusCode,201,kr.body);assert.equal(kr.json().planning.targetText,'完成');
  const id=kr.json().id;
  assert.equal((await call('m2','POST',`/key-results/${id}/scores`,{kind:'self',score:80})).statusCode,400,'only the six levels');
  const bare=await call('m2','POST',`/key-results/${id}/scores`,{kind:'self',score:125,comment:'超额完成'});assert.equal(bare.statusCode,400,'a short note is not enough');assert.equal(bare.json().error.code,'SELF_SCORE_EVIDENCE_REQUIRED');
  assert.equal((await call('m2','POST','/okr/publish',{period})).statusCode,201);
  const taskId=(await call('m2','GET','/key-results')).json().items.find((k:any)=>k.id===id).task_id;assert.ok(taskId,'the KR task is linked');
  const file=await call('m2','POST',`/tasks/${taskId}/attachments`,{name:'转化率截图.png',mime:'image/png',dataBase64:Buffer.from('fake-png').toString('base64')});assert.equal(file.statusCode,201,file.body);
  assert.equal((await call('m2','POST',`/key-results/${id}/scores`,{kind:'self',score:125,attachmentIds:['not-mine']})).statusCode,400,'foreign files are refused');
  assert.equal((await call('m2','POST',`/key-results/${id}/scores`,{kind:'self',score:125,attachmentIds:[file.json().id]})).statusCode,201,'a file alone is enough');
  assert.equal((await call('m2','POST',`/key-results/${id}/scores`,{kind:'self',score:125,comment:'本月转化率达到 3.4%，超过目标'})).statusCode,201,'a written explanation alone is enough');
  assert.equal((await call('m2','POST',`/key-results/${id}/scores`,{kind:'manager',score:100})).statusCode,403,'no self leader score');
  assert.equal((await call('m2','POST',`/key-results/${id}/scores`,{kind:'self',score:0,veto:true})).statusCode,400,'veto is the leader’s');
  await call('m1','POST',`/key-results/${id}/scores`,{kind:'manager',score:75});
  let row=(await call('m2','GET','/key-results')).json().items.find((k:any)=>k.id===id);
  assert.equal(row.scores.self.score,125);assert.equal(row.scores.manager.score,75);assert.equal(row.scores.self.comment,'本月转化率达到 3.4%，超过目标');assert.equal(row.scores.final,100);
  await call('m1','POST',`/key-results/${id}/scores`,{kind:'manager',score:100,veto:true,comment:'自评不实'});
  row=(await call('m2','GET','/key-results')).json().items.find((k:any)=>k.id===id);
  assert.equal(row.scores.manager.veto,true);assert.equal(row.scores.final,0);
 }finally{await app.close();}
});

test('objectives without key results are scored directly, up to 125',async()=>{
 const {app,call}=await setup();
 try{
  const o=(await call('m2','POST','/objectives',{title:'建立新人培训体系',level:'personal',planning:{period,weight:60,scoringDueDate:due}})).json();
  assert.equal((await call('m3','POST',`/objectives/${o.id}/scores`,{kind:'self',score:100,comment:'培训体系已经搭建完成并试运行'})).statusCode,404);
  assert.equal((await call('m2','POST',`/objectives/${o.id}/scores`,{kind:'self',score:100})).statusCode,400,'self scores need an explanation');
  assert.equal((await call('m2','POST',`/objectives/${o.id}/scores`,{kind:'self',score:100,comment:'培训体系已经搭建完成并试运行'})).statusCode,201);
  assert.equal((await call('m1','POST',`/objectives/${o.id}/scores`,{kind:'manager',score:125})).statusCode,201);
  const row=(await call('m2','GET','/objectives')).json().items.find((x:any)=>x.id===o.id);
  assert.equal(row.scores.final,112.5);assert.equal(row.canLeadScore,false);
  assert.equal((await call('m1','GET','/objectives')).json().items.find((x:any)=>x.id===o.id).canLeadScore,true);
 }finally{await app.close();}
});
