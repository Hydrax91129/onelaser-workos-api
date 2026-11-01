import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createDatabase,schema,seedDemo} from '../src/db.js';
import {buildApp} from '../src/app.js';
import {issueSession} from '../src/auth.js';
import {mainLanguage} from '../src/translate.js';

test('language detection treats Chinese, English and numbers sensibly',()=>{
 assert.equal(mainLanguage('完成 5 门入职课程'),'zh');
 assert.equal(mainLanguage('Complete Full Automation of AI for Company Operation Side'),'en');
 assert.equal(mainLanguage('Hydra 产品页上线'),'zh');
 assert.equal(mainLanguage('42%'),null);
});

test('translations are produced once per text, cached, and skipped when already in the target language',async()=>{
 const db=await createDatabase();await db.exec(schema);await seedDemo(db);
 let calls=0;const model={model:'mock',async json(_s:string,user:string){calls++;const list=JSON.parse(user) as string[];return {translations:list.map(t=>'[zh] '+t)};}};
 const app=await buildApp({db,translationModel:model,completionModel:null,mailer:null});
 const token=(await issueSession(db,'m1')).accessToken;
 const call=(payload:any)=>app.inject({method:'POST',url:'/translate',payload,headers:{authorization:'Bearer '+token}});
 try{
  const r=await call({target:'zh',texts:['Grow dealer sales 20%','完成 5 门入职课程','30']});assert.equal(r.statusCode,200,r.body);
  const [a,b,c]=r.json().items;assert.equal(a.translated,'[zh] Grow dealer sales 20%');assert.equal(b.translated,null,'already Chinese');assert.equal(c.translated,null,'no words');
  assert.equal(calls,1);
  const again=await call({target:'zh',texts:['Grow dealer sales 20%']});assert.equal(again.json().items[0].translated,'[zh] Grow dealer sales 20%');assert.equal(calls,1,'served from cache');
  assert.equal((await app.inject({method:'POST',url:'/translate',payload:{target:'zh',texts:['x']}})).statusCode,401);
  assert.equal((await call({target:'fr',texts:['x']})).statusCode,400);
 }finally{await app.close();}
});

test('without a model the original text is kept',async()=>{
 const db=await createDatabase();await db.exec(schema);await seedDemo(db);
 const app=await buildApp({db,translationModel:null,completionModel:null,mailer:null});
 const token=(await issueSession(db,'m1')).accessToken;
 try{const r=await app.inject({method:'POST',url:'/translate',payload:{target:'en',texts:['提升有效获客效率']},headers:{authorization:'Bearer '+token}});
  assert.equal(r.statusCode,200);assert.equal(r.json().available,false);assert.equal(r.json().items[0].translated,null);}
 finally{await app.close();}
});
