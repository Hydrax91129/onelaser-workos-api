import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createDatabase,schema,seedDemo} from '../src/db.js';
import {buildApp} from '../src/app.js';
import {issueSession} from '../src/auth.js';
import {splitWhole,normaliseDraft} from '../src/okr-ai.js';

test('relative numbers become whole numbers that add up exactly',()=>{
 assert.deepEqual(splitWhole([40,30,30],100),[40,30,30]);
 assert.equal(splitWhole([1,1,1],100).reduce((a,b)=>a+b,0),100);
 assert.deepEqual(splitWhole([0,0],100),[50,50]);
 assert.equal(splitWhole([5,90,5],60).reduce((a,b)=>a+b,0),60);
 assert.ok(splitWhole([1000,1,1],100).every(n=>n>=1),'every item keeps at least 1');
});

test('drafts are cleaned, aligned only to offered company objectives, and weighted to totals',()=>{
 const d=normaliseDraft({objectives:[
  {title:'Grow dealer sales',description:'',points:3,alignTo:2,keyResults:[{title:'Sign two dealers',target:'2 dealers',weight:1},{title:'Dealer revenue',target:'$80,000',weight:3}]},
  {title:'x',description:'',points:1,alignTo:0,keyResults:[]},
  {title:'Launch the new desktop model',description:'',points:1,alignTo:9,keyResults:[{title:'Launch page live',target:'',weight:0}]}]},['c1','c2'],100);
 assert.equal(d.objectives.length,2,'too-short titles are dropped');
 assert.equal(d.objectives.reduce((s,o)=>s+o.points,0),100);
 assert.equal(d.objectives[0].alignTo,'c2');assert.equal(d.objectives[1].alignTo,null,'unknown company objective is ignored');
 assert.deepEqual(d.objectives[0].keyResults.map(k=>k.weight),[25,75]);
 assert.equal(d.objectives[1].keyResults[0].weight,100);assert.equal(d.objectives[1].keyResults[0].target,'完成');
 assert.throws(()=>normaliseDraft({objectives:[]},[],100));
});

test('the draft endpoint returns a draft without writing anything',async()=>{
 const db=await createDatabase();await db.exec(schema);await seedDemo(db);
 let seen:any=null;
 const model={model:'mock',async json(_s:string,user:string){seen=JSON.parse(user);return {objectives:[{title:'Grow dealer sales 20%',description:'',points:60,alignTo:0,keyResults:[{title:'New dealers signed',target:'3',weight:50},{title:'Dealer revenue',target:'$90,000',weight:50}]},{title:'Ship the onboarding course',description:'',points:40,alignTo:0,keyResults:[{title:'Lessons recorded',target:'5',weight:100}]}]};}};
 const app=await buildApp({db,okrDraftModel:model,translationModel:null,completionModel:null,mailer:null});
 const token=(await issueSession(db,'m1')).accessToken,headers={authorization:'Bearer '+token};
 try{
  const before=(await db.query('SELECT count(*)::int AS n FROM objectives')).rows[0].n;
  const r=await app.inject({method:'POST',url:'/okr/ai-draft',payload:{text:'Grow dealer sales and record the onboarding course',period:'2026-11'},headers});
  assert.equal(r.statusCode,200,r.body);
  const d=r.json();assert.equal(d.objectives.length,2);assert.equal(d.objectives.reduce((s:number,o:any)=>s+o.points,0),d.pointsBudget);
  assert.equal(seen.plan,'Grow dealer sales and record the onboarding course');
  assert.equal((await db.query('SELECT count(*)::int AS n FROM objectives')).rows[0].n,before,'nothing written');
  assert.equal((await app.inject({method:'POST',url:'/okr/ai-draft',payload:{text:'plan',period:'2026-11'}})).statusCode,401);
  assert.equal((await app.inject({method:'POST',url:'/okr/ai-draft',payload:{text:'Grow sales',period:'Nov'},headers})).statusCode,400);
 }finally{await app.close();}
});

test('without a model the draft endpoint says it is not configured',async()=>{
 const db=await createDatabase();await db.exec(schema);await seedDemo(db);
 const app=await buildApp({db,okrDraftModel:null,translationModel:null,completionModel:null,mailer:null});
 const token=(await issueSession(db,'m1')).accessToken;
 try{
  const r=await app.inject({method:'POST',url:'/okr/ai-draft',payload:{text:'Grow dealer sales',period:'2026-11'},headers:{authorization:'Bearer '+token}});
  assert.equal(r.statusCode,503);assert.equal(r.json().code||r.json().error?.code||'AI_NOT_CONFIGURED','AI_NOT_CONFIGURED');
  assert.equal((await app.inject({method:'GET',url:'/capabilities'})).json().okrAiDraft,false);
 }finally{await app.close();}
});
