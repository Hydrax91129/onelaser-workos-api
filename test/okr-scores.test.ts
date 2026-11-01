import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createDatabase,schema,seedDemo} from '../src/db.js';
import {buildApp} from '../src/app.js';
import {issueSession} from '../src/auth.js';

test('owner self-scores, the leader gives the final score; others cannot',async()=>{
 const db=await createDatabase();await db.exec(schema);await seedDemo(db);
 const app=await buildApp({db,integrations:{executiveUserIds:['m4']},completionModel:null,translationModel:null,mailer:null,nudgeIntervalMs:0});
 const tokens:Record<string,string>={};
 const call=async(who:string,method:'GET'|'POST'|'PATCH',url:string,payload?:any)=>{tokens[who]??=(await issueSession(db,who)).accessToken;return app.inject({method,url,payload,headers:{authorization:'Bearer '+tokens[who]}});};
 try{
  const period=new Date().toISOString().slice(0,7),due=new Date(Date.now()+20*864e5).toISOString().slice(0,10);
  const o=await call('m2','POST','/objectives',{title:'把 Hydra 产品页转化率提升到 3%',level:'personal',planning:{period,weight:100,scoringDueDate:due}});assert.equal(o.statusCode,201,o.body);
  const id=o.json().id;
  assert.equal((await call('m3','POST',`/objectives/${id}/scores`,{kind:'self',score:80})).statusCode,404,'colleague cannot see a personal objective');
  assert.equal((await call('m1','POST',`/objectives/${id}/scores`,{kind:'self',score:80})).statusCode,403,'only the owner self-scores');
  const s=await call('m2','POST',`/objectives/${id}/scores`,{kind:'self',score:85,comment:'转化率做到 3.2%'});assert.equal(s.statusCode,201,s.body);assert.equal(s.json().scores.self.score,85);
  assert.equal((await call('m2','POST',`/objectives/${id}/scores`,{kind:'manager',score:100})).statusCode,403,'cannot give your own final score');
  const m=await call('m1','POST',`/objectives/${id}/scores`,{kind:'manager',score:80,comment:'达成，但移动端还要优化'});assert.equal(m.statusCode,201,m.body);
  const row=(await call('m2','GET','/objectives')).json().items.find((x:any)=>x.id===id);
  assert.equal(row.scores.self.score,85);assert.equal(row.scores.manager.score,80);assert.equal(row.scores.manager.authorName,'林楠');assert.equal(row.canLeadScore,false);
  assert.equal((await call('m1','GET','/objectives')).json().items.find((x:any)=>x.id===id).canLeadScore,true);
  assert.equal((await call('m2','POST',`/objectives/${id}/scores`,{kind:'self',score:120})).statusCode,400);
 }finally{await app.close();}
});
