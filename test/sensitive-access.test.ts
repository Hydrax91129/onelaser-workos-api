import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createDatabase,schema,seedDemo} from '../src/db.js';
import {buildApp} from '../src/app.js';
import {issueSession} from '../src/auth.js';

// Sensitive ERP data (costs, prices, stock, dealers) follows grants only. The deployment-configured
// executive (m1) sees everything; an admin ticked inside the app (m2) gets no automatic access and
// cannot hand out grants, not even to themselves.
test('in-app admins do not bypass grants on sensitive ERP data and cannot change grants',async()=>{
 const db=await createDatabase();await db.exec(schema);await seedDemo(db);
 await db.query(`UPDATE users SET is_admin=true,grants='[]' WHERE id='m2'`);
 await db.query(`UPDATE users SET grants='["products","product_cost_detail"]' WHERE id='m5'`);
 const app=await buildApp({db,integrations:{executiveUserIds:['m1']},completionModel:null,translationModel:null,mailer:null,nudgeIntervalMs:0});
 const tokens:Record<string,string>={};
 const call=async(who:string,method:'GET'|'POST'|'PATCH',url:string,payload?:any)=>{tokens[who]??=(await issueSession(db,who)).accessToken;return app.inject({method,url,payload,headers:{authorization:'Bearer '+tokens[who]}});};
 try{
  assert.equal((await call('m2','GET','/me')).json().isAdmin,true,'m2 is an in-app admin');
  // Products and costs
  assert.equal((await call('m2','GET','/products')).statusCode,403,'in-app admin without grants cannot open products');
  assert.equal((await call('m1','GET','/products')).statusCode,200,'executive opens products');
  assert.equal((await call('m5','GET','/products')).json().canSeePricing,true,'a granted person still sees costs');
  // Warehouse
  assert.equal((await call('m2','POST','/wms/import',{rows:[]})).statusCode,403,'in-app admin cannot import opening stock');
  // ERP permission page and grant changes
  assert.equal((await call('m2','POST','/erp/access',{userId:'m2',area:'pricing',level:'view'})).statusCode,403,'cannot grant itself cost access');
  assert.equal((await call('m2','POST','/erp/access',{userId:'m6',area:'pricing',level:'view'})).statusCode,403,'cannot grant others cost access');
  const self=await call('m2','PATCH','/org/members/m2',{grants:['products','product_cost_detail']});
  assert.equal(self.statusCode,403,self.body);assert.equal(self.json().error.code,'GRANTS_EXECUTIVE_ONLY');
  assert.equal((await call('m2','PATCH','/org/members/m6',{grants:['products']})).statusCode,403,'cannot grant others');
  assert.equal((await call('m2','POST','/org/invites',{email:'new.person@example.com',displayName:'New Person',grants:['products']})).statusCode,403,'cannot invite with grants');
  assert.equal((await call('m2','PATCH','/org/members/m6',{title:'Designer'})).statusCode,200,'in-app admins still manage ordinary member details');
  // The executive keeps full control
  assert.equal((await call('m1','POST','/erp/access',{userId:'m6',area:'products',level:'view'})).statusCode,200);
  assert.equal((await call('m1','PATCH','/org/members/m6',{grants:['products','product_cost_detail']})).statusCode,200);
  const row=(await db.query(`SELECT grants FROM users WHERE id='m2'`)).rows[0];assert.deepEqual(row.grants,[],'m2 grants unchanged');
 }finally{await app.close();}
});
