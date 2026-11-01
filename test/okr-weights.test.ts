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

test('rebalance: adding a KR or objective scales the others so the total stays exactly 100',async()=>{
 const db=await createDatabase();await db.exec(schema);await seedDemo(db);
 const app=await buildApp({db,integrations:{executiveUserIds:['m1']},completionModel:null,translationModel:null,mailer:null,nudgeIntervalMs:0});
 const tokens:Record<string,string>={};
 const call=async(who:string,method:'GET'|'POST'|'PATCH',url:string,payload?:any)=>{tokens[who]??=(await issueSession(db,who)).accessToken;return app.inject({method,url,payload,headers:{authorization:'Bearer '+tokens[who]}});};
 const period=new Date().toISOString().slice(0,7),due=new Date(Date.now()+20*864e5).toISOString().slice(0,10);
 try{
  const o1=(await call('m2','POST','/objectives',{title:'目标一',level:'personal',planning:{period,weight:100,scoringDueDate:due},rebalance:true})).json();
  const o2=await call('m2','POST','/objectives',{title:'目标二',level:'personal',planning:{period,weight:60,scoringDueDate:due},rebalance:true});assert.equal(o2.statusCode,201,o2.body);
  const objs=(await call('m2','GET','/objectives')).json().items.filter((o:any)=>o.owner_id==='m2'&&o.planning?.period===period);
  assert.equal(objs.find((o:any)=>o.id===o1.id).planning.weight,40,'first objective drops to 40');
  const kr=(title:string,weight:number)=>call('m2','POST',`/objectives/${o1.id}/key-results`,{title,baseline:0,target:1,direction:'increase',unit:'完成',planning:{weight},rebalance:true});
  const k1=(await kr('KR 一',100)).json();
  assert.equal((await kr('KR 二',40)).statusCode,201);
  let ks=(await call('m2','GET','/key-results')).json().items.filter((k:any)=>k.objective_id===o1.id);
  assert.equal(ks.find((k:any)=>k.id===k1.id).planning.weight,60,'first KR becomes 60%');
  assert.equal((await kr('KR 三',50)).statusCode,201);
  ks=(await call('m2','GET','/key-results')).json().items.filter((k:any)=>k.objective_id===o1.id);
  assert.equal(Math.round(ks.reduce((s:number,k:any)=>s+k.planning.weight,0)*100)/100,100,'still exactly 100%');
  assert.deepEqual(ks.map((k:any)=>k.planning.weight).sort((a:number,b:number)=>a-b),[20,30,50]);
  const full=await kr('KR 四',99);assert.equal(full.statusCode,400,'others keep at least 1% each');
 }finally{await app.close();}
});
