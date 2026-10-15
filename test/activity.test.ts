import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { EventEmitter } from 'node:events';
import { Codex } from '@openai/codex-sdk';
import { readConfig } from '../src/config.js';
import { buildServer } from '../src/server.js';
import { createProvider, type Provider, type ObservedTurnOptions } from '../src/provider.js';
import { Activities } from '../src/activity.js';
import { publicContent, withoutSecretPrefix } from '../src/stream-content.js';
import { Sse } from '../src/sse.js';
import type { FastifyReply } from 'fastify';

const admin = 'fixture-admin', a = 'fixture-app-a-key-123456789', b = 'fixture-app-b-key-123456789';
const auth = (key = admin) => ({authorization:`Bearer ${key}`});
const body = (text = 'normal') => ({messages:[{role:'user',content:text}]});
const usage = {input_tokens:20,output_tokens:4,cached_input_tokens:3,reasoning_output_tokens:1,cache_write_input_tokens:0};
async function fixture(extra:Record<string,string> = {}) {
  const dir = await mkdtemp(join(tmpdir(),'codex-activity-'));
  const config = readConfig({DATA_DIR:dir,NATIVE_CODEX_HOME:join(dir,'no-native'),LOCAL_API_KEY:admin,
    APP_API_KEYS:JSON.stringify([{id:'a',key:a},{id:'b',key:b}]),...extra});
  let starts = 0;
  const make = () => ({id:'fixture-thread',run:async(input:string, options:ObservedTurnOptions = {}) => {
    starts++;
    await options.observe?.({fixture:true});
    await delay(15,undefined,{signal:options.signal});
    const prefix = input.includes('credential-case') ? '{"content":"safe fixture-app-a-' : '{"content":"Xin';
    options.onEvent?.({type:'output',item_id:'answer',text:prefix});
    options.onEvent?.({type:'output',item_id:'answer',text:prefix}); // cumulative duplicate
    if(input.includes('stream-gated'))await new Promise((_resolve,reject)=>{options.signal?.addEventListener('abort',()=>reject(new Error('fixture aborted')),{once:true});});
    await delay(input.includes('slow') ? 200 : 20,undefined,{signal:options.signal});
    if (input.includes('failure')) throw new Error('fixture failure');
    const content = input.includes('credential-case') ? `safe ${a}` : input.includes('replacement') ? 'Đổi đáp án' : 'Xin chào';
    options.onEvent?.({type:'output',item_id:'answer',text:JSON.stringify({content,tool_calls:[]})});
    options.onEvent?.({type:'usage',usage});
    const finalResponse = input.includes('invalid') ? 'invalid envelope' : JSON.stringify({content,tool_calls:input.includes('tool-case') ? [{name:'lookup',arguments:JSON.stringify({q:input.includes('secret') ? a : 'ok'})}] : []});
    return {finalResponse,usage,items:[]};
  }});
  const app = await buildServer(config,{start:make,resume:make,close:async()=>{}} as Provider);
  return {app,config,dir,get starts(){return starts;},close:async()=>{await app.close();await rm(dir,{recursive:true,force:true});}};
}
const chunks = (raw:string) => raw.split('\n').filter(l=>l.startsWith('data: ') && l !== 'data: [DONE]').map(l=>JSON.parse(l.slice(6)));
async function terminal(f:Awaited<ReturnType<typeof fixture>>, id:string) {
  for (let i=0;i<100;i++) {
    const value = (await f.app.inject({url:`/v1/runs/${id}`,headers:auth()})).json();
    if (!['queued','running'].includes(value.status)) return value;
    await delay(10);
  }
  assert.fail('Run did not reach terminal state.');
}

test('incremental envelope parsing hides tools/nested content and handles escape/unicode boundaries',()=>{
  assert.equal(publicContent('{"tool_calls":[{"content":"hidden"}],"content":"A\\nB\\uD83D'), 'A\nB');
  assert.equal(publicContent('{"content":"A\\nB\\uD83D\\uDE00"}'), 'A\nB😀');
  assert.equal(publicContent('{"content":"escaped \\"'), 'escaped "');
  assert.equal(publicContent('{"tool_calls":[{"content":"hidden"}]'),null);
  assert.equal(publicContent('{"content":null,"tool_calls":[]}'),null);
  assert.equal(withoutSecretPrefix('answer fixture-app-a-ke',[a]),'answer ');
  assert.equal(withoutSecretPrefix(`answer ${a}`,[a]),`answer ${a}`); // full credential is handled by redaction
});

test('streaming emits deduplicated public content, stable IDs, finish and optional actual usage; JSON remains compatible',async()=>{
  const f = await fixture();
  try {
    const r = await f.app.inject({method:'POST',url:'/v1/chat/completions',headers:auth(a),payload:{...body(),stream:true,stream_options:{include_usage:true}}});
    assert.equal(r.statusCode,200); assert.match(r.headers['content-type']!,/text\/event-stream/);
    const data = chunks(r.body); assert.equal(data.filter(d=>d.choices?.length).map(d=>d.choices[0].delta.content ?? '').join(''),'Xin chào');
    assert.equal(new Set(data.map(d=>d.id)).size,1); assert.equal(data.at(-1).usage.completion_tokens,4);
    assert.equal(data.at(-2).choices[0].finish_reason,'stop'); assert.match(r.body,/data: \[DONE\]/);
    const id = r.headers['x-codex-run-id'];
    const run = (await f.app.inject({url:`/v1/runs/${id}`,headers:auth(a)})).json();
    assert.equal(run.status,'completed'); assert.equal(run.metrics.output_updates.value,2);
    assert.ok(run.metrics.ttfo.value >= 0 && run.metrics.ttfo.value < run.metrics.duration.value);
    assert.ok(run.metrics.first_content_sent.value >= run.metrics.ttfo.value);
    assert.equal(run.metrics.ttft.value,null); assert.equal(run.metrics.output_tokens_per_second.value,null);
    const json = await f.app.inject({method:'POST',url:'/v1/chat/completions',headers:auth(),payload:body()});
    assert.equal(json.json().object,'chat.completion'); assert.equal(json.json().choices[0].message.content,'Xin chào');
  } finally {await f.close();}
});

test('partial failure, invalid final JSON and content replacements never emit successful stream finish',async()=>{
  const f = await fixture();
  try {
    for (const text of ['failure','invalid','replacement']) {
      const r = await f.app.inject({method:'POST',url:'/v1/chat/completions',headers:auth(),payload:{...body(text),stream:true}});
      assert.ok(chunks(r.body).some(d=>d.error)); assert.ok(!r.body.includes('[DONE]'));
      assert.ok(!chunks(r.body).some(d=>d.choices?.[0]?.finish_reason === 'stop'));
      const run = (await f.app.inject({url:`/v1/runs/${r.headers['x-codex-run-id']}`,headers:auth()})).json();
      assert.equal(run.status,'failed');
      const metric = (await f.app.inject({url:`/api/stats/calls/${run.call_id}`,headers:auth()})).json();
      assert.equal(metric.status,'error'); assert.notEqual(metric.http_status,200);
    }
  } finally {await f.close();}
});

test('validated tool proposals use indexed tool chunks and complete run event; arguments are not streamed prematurely',async()=>{
  const f = await fixture();
  try {
    const r = await f.app.inject({method:'POST',url:'/v1/chat/completions',headers:auth(),payload:{...body('tool-case'),stream:true,tools:[{type:'function',function:{name:'lookup'}}]}});
    const data = chunks(r.body), tool = data.find(d=>d.choices?.[0]?.delta.tool_calls)?.choices[0].delta.tool_calls[0];
    assert.equal(tool.index,0); assert.equal(tool.function.name,'lookup'); assert.equal(tool.function.arguments,'{"q":"ok"}');
    assert.equal(data.at(-1).choices[0].finish_reason,'tool_calls');
    const events = await f.app.inject({url:`/v1/runs/${r.headers['x-codex-run-id']}/events`,headers:auth()});
    const completed = chunks(events.body).find(d=>d.type === 'run.completed');
    assert.equal(completed.payload.validated,true); assert.equal(completed.payload.result.choices[0].message.tool_calls[0].function.name,'lookup');
  } finally {await f.close();}
});

test('async runs enforce owners, durable idempotency, admin scope, replay cursor and metadata-only persistence',async()=>{
  const f = await fixture();
  let id:string;
  try {
    const create = () => f.app.inject({method:'POST',url:'/v1/runs',headers:{...auth(a),'idempotency-key':'one'},payload:body()});
    const r = await create(); assert.equal(r.statusCode,202); id = r.json().run_id;
    const duplicate = await create(); assert.equal(duplicate.json().run_id,id); assert.equal(duplicate.json().reused,true);
    assert.equal((await f.app.inject({method:'POST',url:'/v1/runs',headers:{...auth(a),'idempotency-key':'one'},payload:body('different')})).statusCode,409);
    for (const url of [`/v1/runs/${id}`,`/v1/runs/${id}/events`]) assert.equal((await f.app.inject({url,headers:auth(b)})).statusCode,404);
    assert.equal((await f.app.inject({method:'POST',url:`/v1/runs/${id}/cancel`,headers:auth(b),payload:{}})).statusCode,404);
    for (const url of ['/api/runs','/api/runs/events','/api/stats/calls','/v1/sessions']) assert.equal((await f.app.inject({url,headers:auth(a)})).statusCode,403);
    await terminal(f,id);
    const replay = await f.app.inject({url:`/v1/runs/${id}/events`,headers:auth(a)}), all = chunks(replay.body).filter(d=>d.seq);
    const after = all[1].seq;
    const tail = chunks((await f.app.inject({url:`/v1/runs/${id}/events`,headers:{...auth(a),'last-event-id':`${id}:${after}`}})).body).filter(d=>d.seq);
    assert.deepEqual(tail.map(d=>d.seq),all.filter(d=>d.seq>after).map(d=>d.seq));
    assert.equal((await f.app.inject({url:`/v1/runs/${id}/events`,headers:{...auth(a),'last-event-id':`${id}:999`}})).statusCode,409);
    assert.equal(f.starts,1);
    assert.equal((await f.app.inject({url:'/api/stats/calls',headers:auth()})).json().total,1);
    const db = new DatabaseSync(f.config.statsDbPath,{readOnly:true});
    const persisted = JSON.stringify(db.prepare('SELECT * FROM gateway_runs').all()); db.close();
    assert.ok(!persisted.includes('Xin')); assert.ok(!persisted.includes(a)); assert.ok(!persisted.includes('messages'));
    await f.app.close();
    const restarted = await buildServer(f.config,{start:()=>{throw new Error('must not run');},resume:()=>{throw new Error('must not run');},close:async()=>{}});
    try {
      assert.equal((await restarted.inject({url:`/v1/runs/${id}`,headers:auth(a)})).json().status,'completed');
      assert.equal((await restarted.inject({url:`/v1/runs/${id}/events`,headers:auth(a)})).statusCode,409);
      assert.equal((await restarted.inject({method:'POST',url:'/v1/runs',headers:{...auth(a),'idempotency-key':'one'},payload:body()})).json().reused,true);
    } finally {await restarted.close();}
  } finally {await f.close();}
});

test('known credentials are withheld across output boundaries; redacted tool proposals cannot become validated streaming calls',async()=>{
  const f = await fixture();
  try {
    const r = await f.app.inject({method:'POST',url:'/v1/chat/completions',headers:auth(a),payload:{...body('credential-case'),stream:true}});
    assert.equal(chunks(r.body).map(d=>d.choices?.[0]?.delta?.content ?? '').join(''),'safe [REDACTED]');
    assert.ok(!r.body.includes('fixture-app-a-'));
    const request = {...body('tool-case secret'),tools:[{type:'function',function:{name:'lookup'}}]};
    const stream = await f.app.inject({method:'POST',url:'/v1/chat/completions',headers:auth(a),payload:{...request,stream:true}});
    assert.ok(chunks(stream.body).some(d=>d.error?.code === 'sensitive_tool_output'));
    assert.ok(!stream.body.includes(a)); assert.ok(!stream.body.includes('[DONE]'));
    const legacy = await f.app.inject({method:'POST',url:'/v1/chat/completions',headers:auth(a),payload:request});
    assert.equal(legacy.statusCode,200);
    const replay = await f.app.inject({url:`/v1/runs/${legacy.headers['x-codex-run-id']}/events`,headers:auth(a)});
    assert.equal(chunks(replay.body).find(d=>d.type === 'run.completed').payload.validated,false); assert.ok(!replay.body.includes(a));
  } finally {await f.close();}
});

test('explicit cancellation and timeout are terminal and release concurrency; browser writes preserve same-origin',async()=>{
  const f = await fixture({MAX_CONCURRENT:'1'});
  try {
    const r = await f.app.inject({method:'POST',url:'/v1/runs',headers:auth(a),payload:body('slow')}), id=r.json().run_id;
    assert.equal((await f.app.inject({method:'POST',url:'/v1/runs',headers:auth(a),payload:body()})).statusCode,429);
    assert.equal((await f.app.inject({method:'POST',url:`/v1/runs/${id}/cancel`,headers:{...auth(),host:'localhost',origin:'http://evil.test','x-codex-run':'1'},payload:{}})).statusCode,403);
    assert.equal((await f.app.inject({method:'POST',url:`/v1/runs/${id}/cancel`,headers:auth(a),payload:{}})).statusCode,200);
    assert.equal((await terminal(f,id)).status,'cancelled');
    assert.equal((await f.app.inject({method:'POST',url:`/v1/runs/${id}/cancel`,headers:auth(a),payload:{}})).statusCode,200);
    assert.equal((await f.app.inject({method:'POST',url:'/chat',headers:auth(),payload:{prompt:'next'}})).statusCode,200);
  } finally {await f.close();}
  const timeout = await fixture({REQUEST_TIMEOUT_MS:'10'});
  try {
    const r = await timeout.app.inject({method:'POST',url:'/v1/runs',headers:auth(),payload:body('slow')});
    const run = await terminal(timeout,r.json().run_id); assert.equal(run.status,'failed'); assert.equal(run.error_code,'codex_timeout');
  } finally {await timeout.close();}
});

test('real SSE delivers content before completion; viewer disconnect does not cancel detached run; chat disconnect does',async()=>{
  const f = await fixture();
  try {
    const base = await f.app.listen({host:'127.0.0.1',port:0});
    const completionController=new AbortController();
    const r = await fetch(`${base}/v1/chat/completions`,{method:'POST',signal:completionController.signal,headers:{...auth(a),'Content-Type':'application/json'},body:JSON.stringify({...body('stream-gated'),stream:true})});
    const reader = r.body!.getReader(), decoder = new TextDecoder(); let text='';
    while (!text.includes('Xin')) text += decoder.decode((await reader.read()).value);
    assert.equal((await (await fetch(`${base}/v1/runs/${r.headers.get('x-codex-run-id')}`,{headers:auth(a)})).json()).status,'running');
    completionController.abort();await reader.cancel().catch(()=>{});
    assert.equal((await terminal(f,r.headers.get('x-codex-run-id')!)).status,'cancelled');
    const create = (await f.app.inject({method:'POST',url:'/v1/runs',headers:auth(a),payload:body('slow')})).json();
    const controller = new AbortController();
    const view = await fetch(`${base}/v1/runs/${create.run_id}/events`,{headers:auth(a),signal:controller.signal});
    assert.equal(view.status,200); controller.abort();
    assert.equal((await terminal(f,create.run_id)).status,'completed');
    const feed = new AbortController();
    const response = await fetch(`${base}/api/runs/events`,{headers:auth(),signal:feed.signal});
    const first = new TextDecoder().decode((await response.body!.getReader().read()).value);
    assert.ok(!first.includes('Xin chào')); assert.ok(first.includes('snapshot')); feed.abort();
  } finally {await f.close();}
});

test('bounded replay resets expired cursors; restart marks running metadata interrupted; ephemeral body is discarded',async()=>{
  const dir = await mkdtemp(join(tmpdir(),'activity-store-')), config=readConfig({DATA_DIR:dir});
  const first = new Activities({...config,statsDbPath:join(dir,'store.sqlite')});
  try {
    const run = first.create(randomUUID(),'admin','fixture',false,performance.now());
    for(let i=0;i<600;i++) run.content(String(i));
    assert.ok(run.events.length<=512 && run.bytes<=1_048_576);
    assert.throws(()=>first.replay(run,`${run.id}:1`),/expired/); assert.throws(()=>first.replay(run),/expired/);
    const e = first.create(randomUUID(),'admin','fixture',true,performance.now()); e.content('ephemeral sentinel');e.finish('completed');
    assert.equal(e.events.length,0); assert.equal(e.output,'');
    const id = run.id; first.close();
    const second = new Activities({...config,statsDbPath:join(dir,'store.sqlite')});
    try { assert.equal(second.snapshot(id,'admin',true).status,'interrupted'); assert.throws(()=>second.feedReplay('old:4'),/expired/); }
    finally {second.close();}
  } finally {await rm(dir,{recursive:true,force:true});}
});

test('SSE transport drops slow consumers at a fixed buffer bound and releases subscriptions',()=>{
  class Raw extends EventEmitter { destroyed=false; writableEnded=false; writableLength=2_097_150; setHeader(){} writeHead(){} flushHeaders(){} write(){return false;} destroy(){this.destroyed=true;this.emit('close');} end(){this.writableEnded=true;this.emit('close');} }
  const raw = new Raw(), stream = new Sse({raw,hijack(){},getHeaders(){return {};}} as unknown as FastifyReply); let released=false;
  stream.onClose(()=>{released=true;}); assert.equal(stream.send({test:'oversized'}),false);
  assert.ok(raw.destroyed); assert.ok(released);
});

test('Docker config requires admin auth, exact trusted hosts and independent app identities',async()=>{
  assert.throws(()=>readConfig({HOST:'0.0.0.0'}),/LOCAL_API_KEY/);
  assert.throws(()=>readConfig({TRUSTED_HOSTS:'host.docker.internal'}),/LOCAL_API_KEY/);
  assert.throws(()=>readConfig({LOCAL_API_KEY:admin,TRUSTED_HOSTS:'*.internal'}),/exact/);
  const f = await fixture({TRUSTED_HOSTS:'host.docker.internal'});
  try {
    assert.equal((await f.app.inject({url:'/health',headers:{...auth(a),host:'host.docker.internal:15600'}})).statusCode,200);
    assert.equal((await f.app.inject({url:'/health',headers:{...auth(a),host:'host.docker.internal.evil.test'}})).statusCode,403);
    assert.equal((await f.app.inject({url:'/health',headers:{host:'host.docker.internal:15600'}})).statusCode,401);
  } finally {await f.close();}
});

test('SDK runStreamed policy spike uses fake executable only: required isolation flags are absent, so CLI stays',async()=>{
  const dir = await mkdtemp(join(tmpdir(),'codex-sdk-spike-')), exe=join(dir,'fake-codex'), args=join(dir,'args.json');
  try {
    await writeFile(exe,`#!/usr/bin/env node\nrequire('fs').writeFileSync(${JSON.stringify(args)},JSON.stringify(process.argv.slice(2)));console.log(JSON.stringify({type:'turn.completed',usage:${JSON.stringify(usage)}}));`,{mode:0o700});
    const sdk = new Codex({codexPathOverride:exe,env:{PATH:process.env.PATH ?? '',HOME:dir}});
    const streamed = await sdk.startThread({sandboxMode:'read-only',approvalPolicy:'never',networkAccessEnabled:false,webSearchMode:'disabled',skipGitRepoCheck:true,workingDirectory:dir}).runStreamed('synthetic fixture');
    const events=[]; for await (const event of streamed.events) events.push(event);
    assert.equal(events[0]?.type,'turn.completed');
    const observed = JSON.parse(await readFile(args,'utf8'));
    assert.ok(!observed.includes('--ignore-user-config')); assert.ok(!observed.includes('--ignore-rules')); assert.ok(!observed.includes('--ephemeral'));
  } finally {await rm(dir,{recursive:true,force:true});}
});

test('isolated CLI forwards public item updates only and rejects unexpected tools before completion',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'codex-cli-stream-')), exe=join(dir,'fake-codex');
  const run = async(events:unknown[]) => {
    await writeFile(exe,`#!/usr/bin/env node\nfor(const event of ${JSON.stringify(events)}) console.log(JSON.stringify(event));`,{mode:0o700});
    const provider=await createProvider(readConfig({CODEX_BIN:exe})), observed:unknown[]=[];
    try {const result=await provider.start('fixture').run('synthetic',{onEvent:e=>observed.push(e)});return {result,observed};}
    finally {await provider.close();}
  };
  try {
    const events=[{type:'item.updated',item:{type:'reasoning',id:'hidden',text:'PRIVATE_SENTINEL'}},
      {type:'item.updated',item:{type:'agent_message',id:'public',text:'{"content":"Hi'}},
      {type:'item.completed',item:{type:'agent_message',id:'public',text:'{"content":"Hi","tool_calls":[]}'}},{type:'turn.completed',usage}];
    const result=await run(events); assert.equal(result.observed.length,3); assert.ok(!JSON.stringify(result.observed).includes('PRIVATE_SENTINEL'));
    await assert.rejects(run([{type:'item.started',item:{type:'command_execution',id:'bad',command:'never executed'}}]),/agent tool/);
  } finally {await rm(dir,{recursive:true,force:true});}
});


test('FIFO queue reserves capacity once, deduplicates retries, cancels and measures only real waits',async()=>{
  const f=await fixture({MAX_CONCURRENT:'1',MAX_QUEUE:'2',QUEUE_TIMEOUT_MS:'2000'});
  const create=(text:string,key?:string)=>f.app.inject({method:'POST',url:'/v1/runs',headers:{...auth(a),...(key?{'idempotency-key':key}:{})},payload:body(text)});
  try {
    const first=(await create('slow')).json(),second=(await create('normal','queued-key')).json(),third=(await create('normal')).json();
    assert.equal(second.status,'queued');assert.equal(third.status,'queued');
    assert.equal((await create('normal')).statusCode,429);
    assert.equal((await create('normal','queued-key')).json().run_id,second.run_id);
    assert.equal(f.starts,1);
    const health=(await f.app.inject({url:'/health',headers:auth()})).json();assert.equal(health.active_requests,1);assert.equal(health.queued_requests,2);
    await f.app.inject({method:'POST',url:`/v1/runs/${third.run_id}/cancel`,headers:auth(a),payload:{}});
    const cancelled=await terminal(f,third.run_id);assert.equal(cancelled.status,'cancelled');assert.equal(cancelled.metrics.queue_wait.value,null);
    const one=await terminal(f,first.run_id),two=await terminal(f,second.run_id);
    assert.equal(one.metrics.queue_wait.value,null);assert.ok(two.metrics.queue_wait.value>0);assert.ok(two.timeline.dequeued>=two.timeline.enqueued&&two.timeline.provider_started>=two.timeline.dequeued);
    assert.equal(two.status,'completed');assert.equal(f.starts,2);
    assert.equal(two.history.samples.filter((s:{kind:string})=>s.kind==='usage').length,1);
    assert.equal(two.metrics.inter_chunk_samples.value,1);assert.ok(two.metrics.inter_chunk_p95.value>0);
  } finally {await f.close();}
});

test('queue timeout does not invoke provider or invalidate an unstarted session; session busy includes queued turns',async()=>{
  const f=await fixture({MAX_CONCURRENT:'1',MAX_QUEUE:'3',QUEUE_TIMEOUT_MS:'35'});
  try {
    const session=(await f.app.inject({method:'POST',url:'/v1/sessions',headers:auth(),payload:{}})).json();
    await f.app.inject({method:'POST',url:'/v1/runs',headers:auth(),payload:body('slow')});
    const queued=f.app.inject({method:'POST',url:`/v1/sessions/${session.session_id}/messages`,headers:auth(),payload:{message:'queued session'}});
    // inject is lazy until awaited/then'ed.
    const pending=Promise.resolve(queued);await delay(5);
    const conflict=await f.app.inject({method:'POST',url:`/v1/sessions/${session.session_id}/messages`,headers:auth(),payload:{message:'second session'}});
    assert.equal(conflict.statusCode,409);assert.equal(conflict.json().error.code,'session_busy');
    const result=await pending;assert.equal(result.statusCode,504);assert.equal(result.json().error.code,'queue_timeout');assert.equal(f.starts,1);
    assert.equal((await f.app.inject({method:'DELETE',url:`/v1/sessions/${session.session_id}`,headers:auth()})).statusCode,204);
    const timeout=(await f.app.inject({url:'/api/runs',headers:auth()})).json().runs.find((r:{error_code:string})=>r.error_code==='queue_timeout');assert.equal(timeout.metrics.queue_wait.value,null);
  } finally {await f.close();}
});

test('workflow ownership, strict lifecycle, dedup, rate limits and metadata privacy survive restart',async()=>{
  const f=await fixture();
  const post=(id:string,event:unknown,key=a)=>f.app.inject({method:'POST',url:`/v1/runs/${id}/workflow-events`,headers:auth(key),payload:event});
  const event=(type:string,extra={})=>({event_id:randomUUID(),type,...extra});
  try {
    const id=(await f.app.inject({method:'POST',url:'/v1/runs',headers:auth(a),payload:body()})).json().run_id;
    await terminal(f,id);
    assert.equal((await post(id,event('workflow.started'),b)).statusCode,404);
    assert.equal((await post(id,event('stage.started',{stage_id:'parse'}))).statusCode,409);
    assert.equal((await post(id,event('workflow.started',{usage:{output_tokens:999}}))).statusCode,400);
    const start=event('workflow.started',{label:'PRIVATE_WORKFLOW_LABEL',message:`safe ${a}`});
    assert.equal((await post(id,start)).statusCode,200);assert.equal((await post(id,start)).json().duplicate,true);
    assert.equal((await post(id,{...start,label:'changed'})).statusCode,409);
    assert.equal((await post(id,event('stage.started',{stage_id:'parse',label:'PRIVATE_STAGE_LABEL',progress:{completed:0,total:2}}))).statusCode,200);
    assert.equal((await post(id,event('stage.progress',{stage_id:'parse',progress:{completed:1,total:2}}))).statusCode,200);
    assert.equal((await post(id,event('stage.progress',{stage_id:'parse',progress:{completed:0,total:2}}))).statusCode,409);
    assert.equal((await post(id,event('stage.completed',{stage_id:'parse'}))).statusCode,409);
    const snap=(await f.app.inject({url:`/v1/runs/${id}`,headers:auth(a)})).json();
    assert.equal(snap.status,'completed');assert.equal(snap.workflow.status,'running');assert.ok(!JSON.stringify(snap).includes(a));
    const db=new DatabaseSync(f.config.statsDbPath,{readOnly:true});
    const persisted=JSON.stringify(['gateway_runs','gateway_workflows','gateway_workflow_events'].map(t=>db.prepare(`SELECT * FROM ${t}`).all()));db.close();
    assert.ok(!persisted.includes('PRIVATE_'));assert.ok(!persisted.includes(a));assert.ok(!persisted.includes('safe '));
    await f.app.close();
    const app=await buildServer(f.config,{start:()=>{throw Error('never');},resume:()=>{throw Error('never');},close:async()=>{}});
    try {
      const resumed=(await app.inject({url:`/v1/runs/${id}`,headers:auth(a)})).json();assert.equal(resumed.workflow.stages[0].progress.completed,1);assert.equal(resumed.workflow.stages[0].label,undefined);
      const send=(e:unknown)=>app.inject({method:'POST',url:`/v1/runs/${id}/workflow-events`,headers:auth(a),payload:e});
      assert.equal((await send(event('stage.completed',{stage_id:'parse',progress:{completed:2,total:2}}))).statusCode,200);
      assert.equal((await send(event('workflow.completed'))).statusCode,200);
      assert.equal((await send(event('workflow.started'))).statusCode,409);
      const replay=await app.inject({url:`/v1/runs/${id}/events?follow_workflow=1`,headers:auth(a)});
      assert.equal(replay.statusCode,200);assert.equal(chunks(replay.body)[0].replay.available,false);
      assert.equal((await app.inject({url:`/v1/runs/${id}/events?follow_workflow=1`,headers:{...auth(a),'last-event-id':`${id}:0`}})).statusCode,409);
    }finally{await app.close();}
  }finally{await f.close();}
});

test('workflow SSE remains live after inference; event source and sequence stay separate from provider usage',async()=>{
  const f=await fixture();
  try {
    const base=await f.app.listen({host:'127.0.0.1',port:0});
    const id=(await f.app.inject({method:'POST',url:'/v1/runs',headers:auth(a),payload:body()})).json().run_id;await terminal(f,id);
    const controller=new AbortController(),response=await fetch(`${base}/v1/runs/${id}/events?follow_workflow=1`,{headers:auth(a),signal:controller.signal});
    const reader=response.body!.getReader(),decoder=new TextDecoder();let text='';
    while(!text.includes('run.completed'))text+=decoder.decode((await reader.read()).value);
    for(const type of ['workflow.started','workflow.completed'])assert.equal((await f.app.inject({method:'POST',url:`/v1/runs/${id}/workflow-events`,headers:auth(a),payload:{event_id:randomUUID(),type}})).statusCode,200);
    while(true){const part=await reader.read();if(part.done)break;text+=decoder.decode(part.value);}
    const events=chunks(text).filter(e=>e.type?.startsWith('workflow.'));assert.equal(events.length,2);assert.equal(events[0].source,'client_reported');assert.ok(events[1].seq>events[0].seq);
    assert.equal((await f.app.inject({url:`/v1/runs/${id}`,headers:auth(a)})).json().metrics.output_tokens.value,4);
  }finally{await f.close();}
});

test('bounded numeric histories, gap percentiles and latency cohorts never invent unknown metrics',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'activity-metrics-')),config=readConfig({DATA_DIR:dir}),store=new Activities(config);
  try {
    const run=store.create(randomUUID(),'admin','m1',false,performance.now());
    for(let i=1;i<=600;i++)run.content('x'.repeat(i));run.reportUsage(usage);run.reportUsage(usage);run.finish('completed');
    const snap=store.snapshot(run.id,'admin',true);assert.equal(snap.history.samples.length,256);assert.equal(snap.history.samples[0].index,1);assert.equal(snap.history.sample_count,601);assert.ok(snap.history.truncated);
    assert.equal(snap.metrics.inter_chunk_samples.value,512);assert.equal(snap.metrics.inter_chunk_samples.total_observed,599);assert.ok(snap.metrics.inter_chunk_p95.value!>=snap.metrics.inter_chunk_p50.value!);
    const empty=store.create(randomUUID(),'admin','m2',false,performance.now());empty.finish('completed');
    const cohorts=store.latency({range:'24h',status:'completed'});assert.equal(cohorts.summary.run_count,2);assert.equal(cohorts.summary.ttfo.sample_count,1);assert.equal(cohorts.summary.ttfo.unknown_count,1);assert.equal(cohorts.summary.queue_wait.p50,null);
    assert.equal(store.latency({range:'24h',model:'m1',provider:'codex',status:'completed'}).summary.run_count,1);
    assert.equal(store.latency({range:'24h',status:'failed'}).summary.duration.p95,null);
    for(const value of store.list())assert.equal('history' in value,false);
  }finally{store.close();await rm(dir,{recursive:true,force:true});}
});

test('Request Detail deep link and shared client are served without granting app access to admin metrics',async()=>{
  const f=await fixture();try {
    const id=randomUUID(),page=await f.app.inject({url:`/dashboard/requests/${id}`});assert.equal(page.statusCode,200);assert.match(page.body,/request-tab-output/);
    assert.equal((await f.app.inject({url:'/dashboard/assets/activity-client.js'})).statusCode,200);
    assert.equal((await f.app.inject({url:'/api/runs/latency',headers:auth(a)})).statusCode,403);
    assert.equal((await f.app.inject({url:'/api/runs/latency?provider=evil',headers:auth()})).statusCode,400);
    assert.equal((await f.app.inject({url:'/api/runs/latency',headers:auth()})).json().summary.ttfo.p95,null);
  }finally{await f.close();}
});

test('workflow rate budget exempts exact retries and immutable lifecycle snapshots preserve replay accounting',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'workflow-limit-')),config=readConfig({DATA_DIR:dir}),store=new Activities(config);
  try {
    const run=store.create(randomUUID(),'admin','fixture',false,performance.now());
    const accepted=JSON.stringify(run.events[0]);run.content('safe');assert.equal(JSON.stringify(run.events[0]),accepted);
    const start={event_id:randomUUID(),type:'workflow.started'};
    store.workflow(run.id,'admin',true,start);
    store.workflow(run.id,'admin',true,{event_id:randomUUID(),type:'stage.started',stage_id:'work'});
    for(let i=0;i<58;i++)store.workflow(run.id,'admin',true,{event_id:randomUUID(),type:'stage.progress',stage_id:'work',progress:{completed:i,total:100}});
    assert.equal(store.workflow(run.id,'admin',true,start).duplicate,true);
    assert.throws(()=>store.workflow(run.id,'admin',true,{event_id:randomUUID(),type:'stage.progress',stage_id:'work',progress:{completed:58,total:100}}),/limit reached/);
    assert.equal(run.bytes,run.events.reduce((sum,e)=>sum+Buffer.byteLength(JSON.stringify(e)),0));
    assert.throws(()=>store.replay(run,`${run.id}:1:extra`),/expired/);
  }finally{store.close();await rm(dir,{recursive:true,force:true});}
});
