import test from 'node:test';
import assert from 'node:assert/strict';
import { buildApp } from '../src/app.js';
import { createDatabase, schema, seedDemo } from '../src/db.js';
import { issueSession } from '../src/auth.js';

test('KR weights under one objective add up to exactly 100%; objectives in a cycle to 100 points; scoring waits for 100%',async()=>{
 const db=await createDatabase();await db.exec(schema);await seedDemo(db);
 const app=await buildApp({db,integrations:{executiveUserIds:['m1']},completionModel:null,translationModel:null,mailer:null,nudgeIntervalMs:0});
 const tokens:Record<string,string>={};
 const call=async(who:string,method:'GET'|'POST'|'PATCH',url:string,payload?:any)=>{tokens[who]??=(await issueSession(db,who)).accessToken;return app.inject({method,url,payload,headers:{authorization:'Bearer '+tokens[who]}});};
 const period=new Date().toISOString().slice(0,7),due=new Date(Date.now()+20*864e5).toISOString().slice(0,10);
 try{
  const o1=(await call('m2','POST','/objectives',{title:'建立新人培训体系',level:'personal',planning:{period,weight:60,scoringDueDate:due}})).json();
  const over=await call('m2','POST','/objectives',{title:'第二个目标',level:'personal',planning:{period,weight:50,scoringDueDate:due}});
  assert.equal(over.statusCode,400);assert.equal(over.json().error.code,'OBJECTIVE_POINTS_OVER_100');
  assert.equal((await call('m2','POST','/objectives',{title:'第二个目标',level:'personal',planning:{period,weight:40,scoringDueDate:due}})).statusCode,201,'exactly 100 is fine');
  const kr=(title:string,weight:number)=>call('m2','POST',`/objectives/${o1.id}/key-results`,{title,baseline:0,target:1,direction:'increase',unit:'完成',planning:{weight,targetText:'完成'}});
  const k1=(await kr('完成 5 门入职课程',80)).json();
  const k2bad=await kr('第二条 KR',30);assert.equal(k2bad.statusCode,400);assert.equal(k2bad.json().error.code,'KR_WEIGHT_OVER_100');assert.match(k2bad.json().error.message,/最多只能填 20%/);
  const k2=(await kr('第二条 KR',20)).json();
  const before=await call('m2','POST',`/key-results/${k1.id}/scores`,{kind:'self',score:100,comment:'五门课程全部上线并完成首轮培训'});assert.equal(before.statusCode,201,'100% exactly: scoring opens');
  const raise=await call('m2','PATCH',`/key-results/${k2.id}`,{expectedMetaVersion:k2.meta_version||1,weight:30});assert.equal(raise.statusCode,400,'editing cannot exceed 100% either');
  assert.equal((await call('m2','PATCH',`/key-results/${k2.id}`,{expectedMetaVersion:k2.meta_version||1,weight:10})).statusCode,200,'lowering is allowed');
  const blocked=await call('m2','POST',`/key-results/${k1.id}/scores`,{kind:'self',score:100,comment:'五门课程全部上线并完成首轮培训'});
  assert.equal(blocked.statusCode,409);assert.equal(blocked.json().error.code,'KR_WEIGHTS_INCOMPLETE');assert.match(blocked.json().error.message,/90%/);
  const en=await app.inject({method:'POST',url:`/key-results/${k1.id}/scores`,payload:{kind:'self',score:100,comment:'五门课程全部上线并完成首轮培训'},headers:{authorization:'Bearer '+tokens.m2,'accept-language':'en'}});assert.match(en.json().error.message,/exactly 100%/);
 }finally{await app.close();}
});
