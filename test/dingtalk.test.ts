import test from 'node:test';
import assert from 'node:assert/strict';
import { DingTalkClient, DingTalkError, type DingTalkConfig } from '../src/integrations/dingtalk.js';
const config:DingTalkConfig={clientId:'test-client',clientSecret:'test-placeholder-secret',corpId:'ding-corp-test',agentId:'123',allowedDepartmentIds:['42'],managerUserIds:['employee-1'],redirectUri:'https://work.example/auth/dingtalk/callback'};
const response=(body:unknown,status=200)=>new Response(JSON.stringify(body),{status,headers:{'Content-Type':'application/json'}});
function fixture(options:{corpId?:string;external?:boolean;inactive?:boolean;department?:number;contactType?:unknown;memberResponse?:Record<string,unknown>}={},configOverride:Partial<DingTalkConfig>={}){
 const calls:{url:URL;body:any;headers:Headers}[]=[];
 const fetcher:typeof fetch=async(input,init)=>{
  const url=new URL(String(input)),body=init?.body?JSON.parse(String(init.body)):undefined,headers=new Headers(init?.headers);calls.push({url,body,headers});
  if(url.pathname==='/v1.0/oauth2/userAccessToken')return response({accessToken:'user-token',corpId:options.corpId||config.corpId});
  if(url.pathname==='/v1.0/contact/users/me')return response({unionId:'union-1',nick:'Not an authorization role'});
  if(url.pathname==='/v1.0/oauth2/accessToken')return response({accessToken:'enterprise-token',expireIn:7200});
  if(url.pathname==='/topapi/user/getbyunionid')return response({errcode:0,result:{contact_type:'contactType' in options?options.contactType:options.external?1:0,userid:'employee-1'}});
  if(url.pathname==='/topapi/v2/user/get')return response({errcode:0,result:{userid:body.userid,unionid:body.userid==='employee-1'?'union-1':'union-2',active:!options.inactive,name:body.userid==='employee-1'?'Test Lead':'Test Employee',dept_id_list:[options.department||42],...options.memberResponse}});
  if(url.pathname==='/topapi/v2/department/get')return response({errcode:0,result:{dept_id:body.dept_id,name:'Pilot department'}});
  if(url.pathname==='/topapi/v2/user/list')return response({errcode:0,result:{list:[{userid:body.cursor===0?'employee-1':'employee-2'}],has_more:body.cursor===0,next_cursor:100}});
  if(url.pathname==='/topapi/message/corpconversation/asyncsend_v2')return response({errcode:0,task_id:456});
  throw new Error('Unexpected fixture path');
 };
 return {client:new DingTalkClient({...config,...configOverride},fetcher),calls};
}
test('DingTalk OAuth authorization URL contains state but no secret',()=>{
 const {client}=fixture();const url=new URL(client.authorizationUrl('a'.repeat(43)));
 assert.equal(url.origin,'https://login.dingtalk.com');assert.equal(url.searchParams.get('state'),'a'.repeat(43));assert.equal(url.searchParams.get('redirect_uri'),config.redirectUri);assert(!url.toString().includes(config.clientSecret));
 assert.equal(url.searchParams.get('corpId'),config.corpId);assert.equal(url.searchParams.get('scope'),'openid corpid');
 assert.throws(()=>client.authorizationUrl('short'),DingTalkError);
});
test('OAuth identity must map to an active enterprise member in an allowed department',async()=>{
 const {client,calls}=fixture();
 assert.deepEqual(await client.authenticate('test-code'),{externalUserId:'employee-1',unionId:'union-1',name:'Test Lead',departmentId:'42',departmentName:'Pilot department',role:'manager'});
 assert.deepEqual(calls[0].body,{clientId:config.clientId,clientSecret:config.clientSecret,code:'test-code',grantType:'authorization_code'});
 assert.equal(calls.find(x=>x.url.pathname==='/v1.0/contact/users/me')?.headers.get('x-acs-dingtalk-access-token'),'user-token');
 assert.equal(calls.find(x=>x.url.pathname==='/topapi/user/getbyunionid')?.url.searchParams.get('access_token'),'enterprise-token');
});
test('Different corporation, external contacts, inactive members and unapproved departments fail closed',async()=>{
 for(const [option,code] of [[{corpId:'different-corp'},'DINGTALK_CORPORATION_FORBIDDEN'],[{external:true},'DINGTALK_MEMBERSHIP_REJECTED'],[{inactive:true},'DINGTALK_MEMBERSHIP_REJECTED'],[{department:99},'DINGTALK_DEPARTMENT_FORBIDDEN']] as const){
  await assert.rejects(fixture(option).client.authenticate('code'),(error:unknown)=>error instanceof DingTalkError&&error.code===code&&error.status===403);
 }
});
test('Internal contact type accepts only the official numeric and string zero representations',async()=>{
 for(const contactType of [0,'0']){
  const {client,calls}=fixture({contactType});
  assert.equal((await client.authenticate('code')).externalUserId,'employee-1');
  assert(calls.some(x=>x.url.pathname==='/topapi/v2/user/get'));
 }
});
test('Missing, external and ambiguous contact types fail before enterprise member lookup',async()=>{
 for(const contactType of [undefined,null,true,false,1,'1','00','0.0',' 0','0 ','','false',[],{},-1,0.1]){
  const {client,calls}=fixture({contactType});
  await assert.rejects(client.authenticate('code'),(error:unknown)=>error instanceof DingTalkError&&error.code==='DINGTALK_MEMBERSHIP_REJECTED'&&error.status===403);
  assert(!calls.some(x=>x.url.pathname==='/topapi/v2/user/get'),`Unexpected member lookup for ${JSON.stringify(contactType)}`);
 }
});
test('Directory pagination is bounded to approved departments and reuses the enterprise token',async()=>{
 const {client,calls}=fixture();await assert.rejects(client.listDepartmentUsers('99'),(error:unknown)=>error instanceof DingTalkError&&error.status===403);
 const users=await client.listDepartmentUsers('42');assert.equal(users.length,2);assert.equal(users[1].role,'employee');
 assert.equal(calls.filter(x=>x.url.pathname==='/v1.0/oauth2/accessToken').length,1);
 assert.deepEqual(calls.filter(x=>x.url.pathname==='/topapi/v2/user/list').map(x=>x.body.cursor),[0,100]);
});
test('Repeated pagination cursors abort instead of looping',async()=>{
 const client=new DingTalkClient(config,async input=>new URL(String(input)).pathname==='/v1.0/oauth2/accessToken'?response({accessToken:'token',expireIn:7200}):response({errcode:0,result:{list:[],has_more:true,next_cursor:0}}));
 await assert.rejects(client.listDepartmentUsers('42'),(error:unknown)=>error instanceof DingTalkError&&error.code==='DINGTALK_PAGINATION_INVALID');
});
test('Work notification only targets explicit user IDs, never all users',async()=>{
 const {client,calls}=fixture();assert.deepEqual(await client.sendWorkNotification(['employee-1','employee-1'],'A test reminder'),{taskId:'456'});
 const body=calls.at(-1)?.body;assert.equal(body.userid_list,'employee-1');assert.equal(body.to_all_user,false);assert.equal(body.msg.msgtype,'text');assert.equal(body.agent_id,'123');
 await assert.rejects(client.sendWorkNotification([], 'bad'),(error:unknown)=>error instanceof DingTalkError&&error.status===400);
});
test('Upstream bodies and network errors never leak tokens or secrets',async()=>{
 const secret='DO_NOT_EXPOSE_UPSTREAM_TOKEN';
 for(const fetcher of [async()=>response({errcode:88,errmsg:secret},400),async()=>{throw new Error(secret);}] as typeof fetch[]){
  const client=new DingTalkClient(config,fetcher);await assert.rejects(client.authenticate('code'),(error:unknown)=>error instanceof DingTalkError&&!error.message.includes(secret)&&error.status===502);
 }
});

test('OAuth corp scope must return the configured corporation explicitly',async()=>{
 const client=new DingTalkClient(config,async()=>response({accessToken:'personal-token-with-no-corp'}));
 await assert.rejects(client.authenticate('code'),(error:unknown)=>error instanceof DingTalkError&&error.code==='DINGTALK_CORPORATION_FORBIDDEN');
});

test('Exact additional members can log in outside approved departments without broadening directory access or role',async()=>{
 const {client,calls}=fixture({department:99},{additionalUserIds:['employee-1'],managerUserIds:[]});
 const member=await client.authenticate('code');assert.equal(member.departmentId,'99');assert.equal(member.role,'employee');
 assert.deepEqual(await client.getAdditionalUser('employee-1'),member);
 const count=calls.length;
 await assert.rejects(client.getAdditionalUser('employee-2'),(error:unknown)=>error instanceof DingTalkError&&error.status===403);
 await assert.rejects(client.listDepartmentUsers('99'),(error:unknown)=>error instanceof DingTalkError&&error.status===403);
 assert.equal(calls.length,count);assert(!calls.some(x=>x.url.pathname==='/topapi/v2/user/list'));
 assert.equal((await fixture({department:99},{additionalUserIds:['employee-1'],managerUserIds:['employee-1']}).client.authenticate('code')).role,'manager');
});
test('Additional membership still requires matching corporation, internal contact, active identity and verified department',async()=>{
 for(const options of [{corpId:'different-corp'},{external:true},{inactive:true},{memberResponse:{userid:'another-person'}},{memberResponse:{unionid:'another-union'}},{memberResponse:{dept_id_list:[]}},{memberResponse:{dept_id_list:['invalid',0,-1,'9007199254740992']}}]){
  await assert.rejects(fixture({...options,department:99},{additionalUserIds:['employee-1'],managerUserIds:[]}).client.authenticate('code'),DingTalkError);
 }
 for(const memberResponse of [{active:false},{userid:'another-person'},{unionid:''}]){
  await assert.rejects(fixture({memberResponse},{additionalUserIds:['employee-1']}).client.getAdditionalUser('employee-1'),DingTalkError);
 }
 assert.throws(()=>fixture({}, {additionalUserIds:['not a valid ID']}),DingTalkError);
});

function treeFixture(){
 // 42 (allowed) -> 43 -> 44; 99 is not under 42.
 const children:Record<number,number[]>={42:[43],43:[44],44:[],99:[]};
 const members:Record<string,number>={'lead':42,'sales-1':43,'deep-1':44,'outsider':99};
 const parents:Record<number,number[]>={42:[42,1],43:[43,42,1],44:[44,43,42,1],99:[99,1]};
 const calls:string[]=[];
 const fetcher:typeof fetch=async(input,init)=>{
  const url=new URL(String(input)),body=init?.body?JSON.parse(String(init.body)):undefined;calls.push(url.pathname);
  if(url.pathname==='/v1.0/oauth2/accessToken')return response({accessToken:'enterprise-token',expireIn:7200});
  if(url.pathname==='/topapi/v2/department/listsubid')return response({errcode:0,result:{dept_id_list:children[body.dept_id]}});
  if(url.pathname==='/topapi/v2/user/list')return response({errcode:0,result:{list:Object.entries(members).filter(([,d])=>d===body.dept_id).map(([userid])=>({userid})),has_more:false}});
  if(url.pathname==='/topapi/v2/user/get')return response({errcode:0,result:{userid:body.userid,unionid:'u-'+body.userid,active:true,name:body.userid,dept_id_list:[members[body.userid]]}});
  if(url.pathname==='/topapi/v2/department/listparentbyuser')return response({errcode:0,result:{parent_list:[{parent_dept_id_list:parents[members[body.userid]]}]}});
  if(url.pathname==='/topapi/v2/department/get')return response({errcode:0,result:{dept_id:body.dept_id,name:'Dept '+body.dept_id}});
  throw new Error('Unexpected fixture path '+url.pathname);
 };
 return {fetcher,calls};
}
test('With sub-departments enabled, sync includes members at any depth under the allowed department',async()=>{
 const {fetcher}=treeFixture();const client=new DingTalkClient({...config,includeSubdepartments:true},fetcher);
 const users=await client.listDepartmentUsers('42');
 assert.deepEqual(users.map(u=>u.externalUserId).sort(),['deep-1','lead','sales-1']);
 assert(users.every(u=>u.departmentId==='42'),'members are filed under the allowed ancestor department');
 assert(!users.some(u=>u.externalUserId==='outsider'));
});
test('With sub-departments disabled, only direct members are synced',async()=>{
 const {fetcher,calls}=treeFixture();const client=new DingTalkClient(config,fetcher);
 assert.deepEqual((await client.listDepartmentUsers('42')).map(u=>u.externalUserId),['lead']);
 assert(!calls.includes('/topapi/v2/department/listsubid'));
});
test('Sub-department membership never admits people outside the allowed tree',async()=>{
 const {fetcher}=treeFixture();const client=new DingTalkClient({...config,includeSubdepartments:true},fetcher);
 await assert.rejects((client as any).member('outsider'),(error:unknown)=>error instanceof DingTalkError&&error.code==='DINGTALK_DEPARTMENT_FORBIDDEN');
 assert.equal((await (client as any).member('deep-1')).departmentId,'42');
});
test('Cyclic or oversized sub-department trees stop instead of looping',async()=>{
 const fetcher:typeof fetch=async(input,init)=>{const url=new URL(String(input));const body=init?.body?JSON.parse(String(init.body)):{};
  if(url.pathname==='/v1.0/oauth2/accessToken')return response({accessToken:'t',expireIn:7200});
  if(url.pathname==='/topapi/v2/department/listsubid')return response({errcode:0,result:{dept_id_list:body.dept_id===42?[43]:[42]}});
  if(url.pathname==='/topapi/v2/user/list')return response({errcode:0,result:{list:[],has_more:false}});
  throw new Error('unexpected');};
 assert.deepEqual(await new DingTalkClient({...config,includeSubdepartments:true},fetcher).listDepartmentUsers('42'),[]);
 const wide:typeof fetch=async(input,init)=>{const url=new URL(String(input));const body=init?.body?JSON.parse(String(init.body)):{};
  if(url.pathname==='/v1.0/oauth2/accessToken')return response({accessToken:'t',expireIn:7200});
  if(url.pathname==='/topapi/v2/department/listsubid')return response({errcode:0,result:{dept_id_list:body.dept_id===42?Array.from({length:600},(_,i)=>1000+i):[]}});
  throw new Error('unexpected');};
 await assert.rejects(new DingTalkClient({...config,includeSubdepartments:true},wide).listDepartmentUsers('42'),(e:unknown)=>e instanceof DingTalkError&&e.code==='DINGTALK_DIRECTORY_LIMIT');
});
