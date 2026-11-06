import {test} from 'node:test';
import assert from 'node:assert/strict';
import {claudeModel} from '../src/completions.js';

const fake=(reply:any)=>{const calls:any[]=[];return {calls,client:{messages:{create:async(p:any)=>{calls.push(p);return reply;}}} as any};};

test('Claude model: Haiku 5.5 by default, structured JSON output, low effort, thinking off',async()=>{
 const {calls,client}=fake({stop_reason:'end_turn',content:[{type:'text',text:'{"items":[{"id":"t1","zh":"你好","en":"Hello"}]}'}]});
 const m=claudeModel({apiKey:'test-key'},client)!;
 assert.equal(m.model,'claude-haiku-5-5');
 const schema={type:'object',additionalProperties:false,required:['items'],properties:{items:{type:'array'}}};
 const out=await m.json('Translate.','{"text":"Hello"}',schema,'translation',300);
 assert.deepEqual(out,{items:[{id:'t1',zh:'你好',en:'Hello'}]});
 const p=calls[0];
 assert.equal(p.model,'claude-haiku-5-5');assert.equal(p.system,'Translate.');assert.equal(p.max_tokens,300);
 assert.deepEqual(p.output_config,{effort:'low',format:{type:'json_schema',schema}});
 assert.deepEqual(p.thinking,{type:'disabled'});
 assert.deepEqual(p.messages,[{role:'user',content:'{"text":"Hello"}'}]);
 assert.equal('temperature' in p,false);
});

test('Claude model: ANTHROPIC_MODEL overrides; refusals and cut-off answers are rejected; no key means no model',async()=>{
 assert.equal(claudeModel({apiKey:'k',model:'claude-sonnet-5-5'},fake({}).client)!.model,'claude-sonnet-5-5');
 assert.equal(claudeModel({apiKey:''}),undefined);
 for(const stop of ['refusal','max_tokens']){
  const m=claudeModel({apiKey:'k'},fake({stop_reason:stop,content:[{type:'text',text:'{"a":1'}]}).client)!;
  await assert.rejects(m.json('s','u',{type:'object'},'n'),/AI_INVALID_OUTPUT/);
 }
 const failing=claudeModel({apiKey:'k'},{messages:{create:async()=>{const e:any=new Error('overloaded');e.status=529;throw e;}}} as any)!;
 await assert.rejects(failing.json('s','u',{type:'object'},'n'),(e:any)=>e.message==='AI_UPSTREAM_FAILED'&&e.status===529);
});
