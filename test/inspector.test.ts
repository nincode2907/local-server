import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readdir, writeFile, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { readConfig } from '../src/config.js';
import { Inspector, redact } from '../src/inspector.js';
import { buildServer } from '../src/server.js';
import { createProvider, gatewayInstructions, type Provider } from '../src/provider.js';
import { promptFor } from '../src/protocol.js';
import { chatRequest } from '../src/schema.js';

const usage = {input_tokens:20, output_tokens:4, cached_input_tokens:3, reasoning_output_tokens:1};
async function fixture(env: Record<string,string> = {}, finalResponse = '{"content":"Observable answer","tool_calls":[]}') {
  const directory = await mkdtemp(join(tmpdir(),'inspector-test-'));
  const config = readConfig({DATA_DIR:directory, NATIVE_CODEX_HOME:join(directory,'empty-native'), ...env});
  const prompts: string[] = [];
  const make = () => ({id:'observable-thread',run:async (prompt:string, options:any) => {
    prompts.push(prompt);
    await options.observe?.({stdin:prompt,instructions:gatewayInstructions,output_schema:options.outputSchema});
    return {finalResponse, usage, items:[{type:'reasoning', text:'PRIVATE_REASONING_SENTINEL'},{type:'agent_message',id:'a',text:finalResponse}]};
  }});
  const provider = {start:make,resume:make,close:async()=>{}} as Provider;
  const app = await buildServer(config,provider);
  return {app,directory,prompts,config,close:async()=>{await app.close();await rm(directory,{recursive:true,force:true});}};
}
const payload = {messages:[{role:'system',content:'Keep original ordering.'},{role:'user',content:'Hello\n  keep whitespace'}]};
const inspectorUrl = (response: any) => `/api/stats/calls/${response.headers['x-codex-call-id']}/inspector`;
const deletionHeaders = {'x-codex-inspector':'1','content-type':'application/json'};

test('disabled by default; no body files and playground stays ephemeral even with opt-in',async()=>{
  for(const enabled of ['false','true']) {
    const f=await fixture({INSPECTOR_ENABLED:enabled});
    try {
      const path=enabled==='true'?'/api/playground/chat':'/v1/chat/completions';
      const response=await f.app.inject({method:'POST',url:path,payload,headers:path.includes('playground')?{host:'localhost',origin:'http://localhost','x-codex-playground':'1'}:{}});
      assert.equal(response.statusCode,200);
      const detail=(await f.app.inject({url:inspectorUrl(response)})).json();
      assert.equal(detail.status,enabled==='true'?'ephemeral':'disabled');assert.equal(detail.snapshot,null);
      await assert.rejects(readdir(join(f.directory,'request-inspector')), {code:'ENOENT'});
    } finally {await f.close();}
  }
});
test('separate incoming and transformed captures preserve messages, response, actual usage, /chat compatibility',async()=>{
  const f=await fixture({INSPECTOR_ENABLED:'true'});
  try {
    const r=await f.app.inject({method:'POST',url:'/v1/chat/completions',payload});
    assert.equal(r.statusCode,200);assert.equal(r.json().usage.total_tokens,24);
    const d=(await f.app.inject({url:inspectorUrl(r)})).json();
    const s=(key:string)=>d.snapshot.segments.find((s:any)=>s.key===key);
    assert.deepEqual(s('incoming').data.payload,payload);assert.deepEqual(s('incoming').data.messages,payload.messages);
    assert.equal(s('incoming').data.payload.parallel_tool_calls,undefined);
    assert.equal(s('gateway').data.validated_request.parallel_tool_calls,true);
    assert.equal(s('gateway').data.prompt,f.prompts[0]);assert.equal(s('cli_boundary').data.stdin,f.prompts[0]);
    assert.deepEqual(s('http_response').data.body,r.json());assert.deepEqual(s('codex_response').data.usage,usage);
    const file=await readFile(join(f.directory,'request-inspector',`${r.headers['x-codex-call-id']}.json`),'utf8');
    assert.ok(!file.includes('PRIVATE_REASONING_SENTINEL'));
    const simple=await f.app.inject({method:'POST',url:'/chat',payload:{prompt:'Alias text'}});
    assert.deepEqual(simple.json(),{ok:true,output:'Observable answer'});
    const simpleData=(await f.app.inject({url:inspectorUrl(simple)})).json().snapshot.segments;
    assert.equal(simpleData.find((s:any)=>s.key==='incoming').data.payload.prompt,'Alias text');
    assert.deepEqual(simpleData.find((s:any)=>s.key==='incoming').data.messages,[{role:'user',content:'Alias text'}]);
  } finally {await f.close();}
});
test('stateful initial context and resumed history are distinguished; function calls and failures observable',async()=>{
  const f=await fixture({INSPECTOR_ENABLED:'true'});
  try {
    const session=(await f.app.inject({method:'POST',url:'/v1/sessions',payload:{messages:[{role:'system',content:'Initial session context'}]}})).json().session_id;
    const route=`/v1/sessions/${session}/messages`;
    await f.app.inject({method:'POST',url:route,payload:{message:'First turn'}});
    const second=await f.app.inject({method:'POST',url:route,payload:{message:'Second turn'}});
    const d=(await f.app.inject({url:inspectorUrl(second)})).json();
    const g=d.snapshot.segments.find((s:any)=>s.key==='gateway').data;
    assert.ok(f.prompts[0]!.includes('Initial session context'));assert.ok(!f.prompts[1]!.includes('Initial session context'));
    assert.equal(g.context.provenance,'Internal / unavailable');assert.equal(g.thread_id_before,'observable-thread');assert.equal(g.session_id,session);
    assert.equal(g.forwarded_messages.length,1);
  } finally {await f.close();}
  for(const raw of ['{"content":null,"tool_calls":[{"name":"act","arguments":"{}"}]}','Invalid structured output']) {
    const f=await fixture({INSPECTOR_ENABLED:'true'},raw);
    try {
      const r=await f.app.inject({method:'POST',url:'/v1/chat/completions',payload:{...payload,tools:[{type:'function',function:{name:'act'}}],tool_choice:'auto'}});
      const d=(await f.app.inject({url:inspectorUrl(r)})).json();
      const response=d.snapshot.segments.find((s:any)=>s.key==='http_response').data.body;
      if(r.statusCode===200) assert.equal(response.choices[0].message.tool_calls[0].function.name,'act');else assert.equal(response.error.code,'invalid_codex_output');
      assert.equal(d.snapshot.segments.find((s:any)=>s.key==='codex_response').data.final_response,raw);
    } finally {await f.close();}
  }
});
test('redacts known credentials in content and nested tool JSON without changing forwarded request',async()=>{
  assert.equal(redact(' { "ordinary": 42 } '),' { "ordinary": 42 } ');
  const secrets=['plain-private-value','header-private-value'];
  const content='api_key=plain-private-value Authorization: Bearer header-private-value';
  const nested=JSON.stringify({password:'nested-private-value',public:'keep'});
  const result=JSON.stringify(redact({content,arguments:nested},secrets));
  for(const secret of [...secrets,'nested-private-value']) assert.ok(!result.includes(secret));
  const prompt=promptFor([{role:'user',content:nested}],chatRequest.parse(payload));
  assert.ok(!String(redact(prompt)).includes('nested-private-value'));
  const f=await fixture({INSPECTOR_ENABLED:'true',LOCAL_API_KEY:'header-private-value'});
  try {
    const r=await f.app.inject({method:'POST',url:'/chat',payload:{prompt:content},headers:{authorization:'Bearer header-private-value'}});
    const data=await f.app.inject({url:inspectorUrl(r),headers:{authorization:'Bearer header-private-value'}});
    assert.equal(r.statusCode,200);assert.ok(f.prompts[0]!.includes('plain-private-value'));
    assert.ok(!data.body.includes('plain-private-value'));assert.ok(!data.body.includes('header-private-value'));
  } finally {await f.close();}
});
test('authenticated same-origin deletion and reads preserve call metrics; delete all does not recreate in-flight snapshots',async()=>{
  const f=await fixture({INSPECTOR_ENABLED:'true',LOCAL_API_KEY:'fixture-key'});
  try {
    const auth={authorization:'Bearer fixture-key'};
    const r=await f.app.inject({method:'POST',url:'/chat',payload:{prompt:'Hello'},headers:auth});const url=inspectorUrl(r);
    assert.equal((await f.app.inject({url})).statusCode,401);
    assert.equal((await f.app.inject({method:'DELETE',url,headers:auth})).statusCode,403);
    assert.equal((await f.app.inject({method:'DELETE',url,headers:{...auth,...deletionHeaders,origin:'http://attacker.test'}})).statusCode,403);
    assert.equal((await f.app.inject({method:'DELETE',url,payload:{},headers:{...auth,...deletionHeaders,host:'localhost',origin:'http://localhost'}})).statusCode,204);
    assert.equal((await f.app.inject({url,headers:auth})).json().status,'unavailable');
    assert.equal((await f.app.inject({url:url.replace('/inspector',''),headers:auth})).json().status,'success');
  } finally {await f.close();}
});
test('expiry, deletion races, cap and I/O failure are fail-safe',async()=>{
  const data=await mkdtemp(join(tmpdir(),'inspector-store-'));const config=readConfig({DATA_DIR:data,INSPECTOR_ENABLED:'true',INSPECTOR_MAX_BYTES:'4096'});
  const store=new Inspector(config,()=>{});const id=randomUUID(),created=Date.now()-10;
  try {
    await store.capture(id,created,'incoming','Client supplied',{content:'x'.repeat(5000)});
    assert.ok((await store.detail(id) as any).snapshot.segments[0].unavailable);
    await store.delete(id);await store.capture(id,created,'response','SDK observable','late result');assert.equal((await store.detail(id) as any).snapshot,null);
    const other=randomUUID();await store.capture(other,created,'incoming','Client supplied','first');
    await store.delete();await store.capture(other,created,'response','SDK observable','late result');assert.equal((await store.detail(other) as any).snapshot,null);
    const expired=randomUUID(),file=join(data,'request-inspector',`${expired}.json`);
    await writeFile(file,JSON.stringify({version:1,id:expired,created_at:created,expires_at:0,segments:[]}));
    assert.equal((await store.detail(expired) as any).snapshot,null);await assert.rejects(readFile(file),{code:'ENOENT'});
  } finally {await store.close();await rm(data,{recursive:true,force:true});}
  const f=await fixture({INSPECTOR_ENABLED:'true'});
  try {await writeFile(join(f.directory,'request-inspector'),'not-a-directory');const r=await f.app.inject({method:'POST',url:'/chat',payload:{prompt:'Still works'}});assert.equal(r.statusCode,200);assert.equal((await f.app.inject({url:inspectorUrl(r)})).json().status,'unavailable');}
  finally {await f.close();}
});
test('real CLI boundary exposes only safe gateway settings before spawn; no account call',async()=>{
  const provider=await createProvider(readConfig({}));let observed:any;
  try {
    await assert.rejects(provider.start('model-test','low').run('exact stdin',{outputSchema:{type:'object'},observe:async context=>{observed=context;throw new Error('stop-before-spawn');}}),/stop-before-spawn/);
    assert.equal(observed.stdin,'exact stdin');assert.equal(observed.instructions,gatewayInstructions);assert.equal(observed.model,'model-test');
    assert.deepEqual(observed.policy,{sandbox:'read-only',approval:'never',network:false,agent_tools:false,ignore_user_config:true,ignore_rules:true});
    assert.equal(observed.internal_context.available,false);
  } finally {await provider.close();}
});
test('CLI public partial output and turn.failed are observable; reasoning and stderr never enter observation',async()=>{
  const directory=await mkdtemp(join(tmpdir(),'inspector-fake-cli-'));
  const originalCwd=process.cwd();let observed:any;
  const events=[{type:'thread.started',thread_id:'fake-thread'},
    {type:'item.completed',item:{id:'private',type:'reasoning',text:'PRIVATE_SENTINEL'}},
    {type:'item.completed',item:{id:'public',type:'agent_message',text:'Public partial answer'}},
    {type:'error',message:'Observable public error'}, {type:'turn.failed',error:{message:'Observable failure'}}];
  await writeFile(join(directory,'exec'),`process.stdout.write(${JSON.stringify(events.map(e=>JSON.stringify(e)).join('\n')+'\n')});process.stderr.write('STDERR_PRIVATE_SENTINEL');setTimeout(()=>process.exit(1),30);`);
  const provider=await createProvider(readConfig({CODEX_BIN:process.execPath}));
  try {
    process.chdir(directory);
    await assert.rejects(provider.start('fake-model').run('fixture',{observeResponse:async response=>{observed=response;}}));
    assert.equal(observed.complete,false);assert.equal(observed.turn_error,'Observable failure');assert.equal(observed.thread_id,'fake-thread');
    assert.equal(observed.assistant_messages[0].text,'Public partial answer');
    assert.deepEqual(observed.errors,[{type:'error',message:'Observable public error'}]);
    assert.ok(!JSON.stringify(observed).includes('PRIVATE_SENTINEL'));assert.ok(!JSON.stringify(observed).includes('STDERR_PRIVATE_SENTINEL'));
  } finally {process.chdir(originalCwd);await provider.close();await rm(directory,{recursive:true,force:true});}
});
