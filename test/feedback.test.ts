import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createDatabase,schema,seedDemo} from '../src/db.js';
import {buildApp} from '../src/app.js';
import {issueSession} from '../src/auth.js';

test('bug & suggestion notes are stored for admins and emailed with screenshots',async()=>{
 const db=await createDatabase();await db.exec(schema);await seedDemo(db);
 const sent:any[]=[];
 const app=await buildApp({db,integrations:{executiveUserIds:['m1']},completionModel:null,translationModel:null,mailer:async m=>{sent.push(m);},nudgeIntervalMs:0});
 const tokens:Record<string,string>={};
 const call=async(who:string,method:'GET'|'POST',url:string,payload?:any)=>{tokens[who]??=(await issueSession(db,who)).accessToken;return app.inject({method,url,payload,headers:{authorization:'Bearer '+tokens[who]}});};
 try{
  const png=Buffer.from('89504e470d0a1a0a0000000d49484452','hex').toString('base64');
  assert.equal((await call('m3','POST','/feedback',{body:''})).statusCode,400,'empty note');
  const r=await call('m3','POST','/feedback',{body:'导入库存时按钮没反应',page:'wms',images:[{name:'shot.png',type:'image/png',data:png}]});assert.equal(r.statusCode,201,r.body);assert.equal(r.json().emailed,true);
  assert.equal(sent[0].to,'admin@1laser.com');assert.equal(sent[0].attachments.length,1);assert.match(sent[0].subject,/导入库存/);
  assert.equal((await call('m3','GET','/feedback')).statusCode,403);
  const list=(await call('m1','GET','/feedback')).json();assert.equal(list.items[0].image_count,1);assert.equal(list.items[0].body,'导入库存时按钮没反应');
  const img=await call('m1','GET',`/feedback/${r.json().id}/images/0`);assert.equal(img.headers['content-type'],'image/png');
  assert.equal((await call('m1','POST',`/feedback/${r.json().id}/status`,{status:'done'})).json().status,'done');
  assert.equal((await call('m3','POST','/feedback',{body:'x',images:[{name:'a.svg',type:'image/svg+xml',data:png}]})).statusCode,400,'only bitmap images');
 }finally{await app.close();}
});
