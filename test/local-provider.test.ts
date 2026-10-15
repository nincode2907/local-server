import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {setTimeout as delay} from 'node:timers/promises';
import {localBackend} from './fixtures/local-backend.js';
import {buildServer} from '../src/server.js';
import {readConfig} from '../src/config.js';
import type {Provider} from '../src/provider.js';

const admin='fixture-gateway-key',appKey='fixture-app-key-1234567890',auth=(key=admin)=>({authorization:`Bearer ${key}`}),write={...auth(),'content-type':'application/json','x-codex-lab':'1'};
const request=(provider='ollama',model='fixture-local',stream=false)=>({provider,model,messages:[{role:'user',content:'Synthetic private prompt sentinel'}],stream});
async function fixture(extra:Record<string,string>={}) {
  const backend=await localBackend(),dir=await mkdtemp(join(tmpdir(),'phase3-test-'));
  const config=readConfig({DATA_DIR:dir,NATIVE_CODEX_HOME:join(dir,'no-native'),LOCAL_API_KEY:admin,APP_API_KEYS:JSON.stringify([{id:'fixture',key:appKey}]),OLLAMA_BASE_URL:backend.url,LM_STUDIO_BASE_URL:backend.url,OLLAMA_API_KEY:'ollama-only-secret',LM_STUDIO_API_KEY:'lmstudio-only-secret',MAX_CONCURRENT:'2',MAX_QUEUE:'8',LAB_MIN_INTERVAL_MS:'1',...extra});
  let codexStarts=0;const make=()=>({id:'fake-codex',run:async()=>{codexStarts++;return {items:[],finalResponse:'{"content":"Codex fixture","tool_calls":[]}',usage:null};}});
  const provider:Provider={start:make,resume:make,close:async()=>{}};const server=await buildServer(config,provider);
  return {server,backend,config,get codexStarts(){return codexStarts;},close:async()=>{await server.close();await backend.app.close();await rm(dir,{recursive:true,force:true});}};
}
async function terminal(f:Awaited<ReturnType<typeof fixture>>,id:string){for(let i=0;i<300;i++){const batch=(await f.server.inject({url:`/api/lab/batches/${id}`,headers:auth()})).json();if(!['running','cancelling'].includes(batch.status))return batch;await delay(10);}assert.fail('Batch not terminal.');}
const spec={targets:[{provider:'ollama',model:'fixture-local'},{provider:'lmstudio',model:'fixture-local'}],scenarios:['short-answer'],iterations:2,warmup:1,concurrency:2,max_duration_ms:10000};

test('local model discovery, native JSON/SSE, actual timing and credentials stay provider-scoped',async()=>{
  const f=await fixture();try{
    assert.equal((await f.server.inject({url:'/v1/providers',headers:auth(appKey)})).json().providers.length,3);
    for(const provider of ['ollama','lmstudio']){
      assert.equal((await f.server.inject({url:`/v1/models?provider=${provider}`,headers:auth(appKey)})).json().data[0].id,'fixture-local');
      for(const stream of [false,true]){
        const r=await f.server.inject({method:'POST',url:'/v1/chat/completions',headers:auth(appKey),payload:{...request(provider,'fixture-local',stream),max_tokens:32,seed:42}});assert.equal(r.statusCode,200);if(stream)assert.match(r.body,/\[DONE\]/);else assert.match(r.json().choices[0].message.content,/MÔ PHỎNG/);
        const id=r.headers['x-codex-run-id'],run=(await f.server.inject({url:`/v1/runs/${id}`,headers:auth(appKey)})).json();assert.equal(run.provider,provider);assert.equal(run.metrics.output_tokens.value,10);assert.equal(run.metrics.output_tokens_per_second.value,50);assert.equal(run.metrics.generation_duration.value,200);assert.equal(run.metrics.ttft.value,provider==='ollama'?null:40);
        const call=(await f.server.inject({url:`/api/stats/calls/${id}`,headers:auth()})).json();assert.equal(call.cost_usd,null);assert.equal(call.provider,provider);assert.equal(call.cached_tokens,null);assert.equal(call.reasoning_tokens,null);
      }
    }
    assert.equal(f.codexStarts,0);assert.ok(f.backend.requests.every(r=>r.authorization===(r.url==='/api/chat'?'Bearer ollama-only-secret':'Bearer lmstudio-only-secret')));
    assert.ok(f.backend.requests.every(r=>r.body.messages[0].content==='Synthetic private prompt sentinel'));
  }finally{await f.close();}
});
test('local tools remain validated proposals, malformed/truncated streams fail, and length is explicit',async()=>{
  const f=await fixture();try{
    for(const provider of ['ollama','lmstudio']){
      const tools=[{type:'function',function:{name:'lookup',parameters:{type:'object',properties:{q:{type:'string'}},required:['q']}}}];
      const tool=await f.server.inject({method:'POST',url:'/v1/chat/completions',headers:auth(),payload:{...request(provider,'tools'),tools,tool_choice:'required'}});assert.equal(tool.statusCode,200);assert.equal(tool.json().choices[0].message.tool_calls[0].function.arguments,'{"q":"fixture"}');
      if(provider==='ollama'){const message=tool.json().choices[0].message;const next=await f.server.inject({method:'POST',url:'/v1/chat/completions',headers:auth(),payload:{...request(provider),messages:[...request().messages,message,{role:'tool',tool_call_id:message.tool_calls[0].id,content:'fixture result'}]}});assert.equal(next.statusCode,200);assert.equal(f.backend.requests.at(-1)!.body.messages.at(-1).tool_name,'lookup');}
      for(const model of ['malformed','truncated','http-error','redirect']){const r=await f.server.inject({method:'POST',url:'/v1/chat/completions',headers:auth(),payload:request(provider,model,true)});assert.ok(r.body.includes('error'));assert.ok(!r.body.includes('[DONE]'));}
      const length=await f.server.inject({method:'POST',url:'/v1/chat/completions',headers:auth(),payload:request(provider,'length')});assert.equal(length.json().choices[0].finish_reason,'length');
    }
    const unknown=await f.server.inject({method:'POST',url:'/v1/chat/completions',headers:auth(),payload:request('lmstudio','no-stats')});const run=(await f.server.inject({url:`/v1/runs/${unknown.headers['x-codex-run-id']}`,headers:auth()})).json();assert.equal(run.metrics.ttft.value,null);assert.equal(run.metrics.output_tokens_per_second.value,null);
    assert.equal((await f.server.inject({method:'POST',url:'/v1/chat/completions',headers:auth(),payload:{...request(),provider:'codex',max_tokens:12}})).statusCode,400);
  }finally{await f.close();}
});
test('local cancellation, timeout, model isolation and endpoint validation preserve gateway policy',async()=>{
  assert.throws(()=>readConfig({OLLAMA_BASE_URL:'http://example.com:11434'}),/allowlisted/);
  for(const url of ['http://user:pass@localhost:11434','http://localhost:11434/private','http://localhost:11434?key=a','file:///tmp/no'])assert.throws(()=>readConfig({OLLAMA_BASE_URL:url}));
  const f=await fixture();try{
    const run=(await f.server.inject({method:'POST',url:'/v1/runs',headers:auth(appKey),payload:{...request('ollama','slow'),stream:true}})).json();
    await f.server.inject({method:'POST',url:`/v1/runs/${run.run_id}/cancel`,headers:auth(appKey),payload:{}});await delay(20);assert.equal((await f.server.inject({url:`/v1/runs/${run.run_id}`,headers:auth(appKey)})).json().status,'cancelled');
    assert.equal((await f.server.inject({method:'POST',url:'/v1/chat/completions',headers:auth(),payload:{provider:'ollama',messages:request().messages}})).statusCode,400);
    assert.equal((await f.server.inject({method:'POST',url:'/v1/chat/completions',headers:auth(),payload:{...request(),reasoning:'low'}})).statusCode,400);
    const resource=(await f.server.inject({url:'/api/resources',headers:auth()})).json();assert.equal(resource.latest.gateway.scope,'gateway_process_not_model_inference');assert.equal(resource.latest.gpu.value,null);assert.equal(resource.providers[0].models[0].vram_allocation_bytes,4194304);
    assert.equal((await f.server.inject({url:'/api/resources',headers:auth(appKey)})).statusCode,403);
  }finally{await f.close();}
  const timeout=await fixture({LOCAL_PROVIDER_TIMEOUT_MS:'100'});try{const r=await timeout.server.inject({method:'POST',url:'/v1/chat/completions',headers:auth(),payload:request('ollama','slow')});assert.equal(r.statusCode,504);assert.equal(r.json().error.code,'local_provider_timeout');}finally{await timeout.close();}
});
test('Performance Lab uses the shared execution path, excludes warmup and exports numeric metadata only',async()=>{
  const f=await fixture();try{
    const start=await f.server.inject({method:'POST',url:'/api/lab/batches',headers:{...write,'idempotency-key':'batch-one'},payload:spec});assert.equal(start.statusCode,202);const id=start.json().batch.id;
    const duplicate=await f.server.inject({method:'POST',url:'/api/lab/batches',headers:{...write,'idempotency-key':'batch-one'},payload:spec});assert.equal(duplicate.json().batch.id,id);assert.equal(duplicate.json().reused,true);
    assert.equal((await f.server.inject({method:'POST',url:'/api/lab/batches',headers:write,payload:spec})).statusCode,409);
    const batch=await terminal(f,id);assert.equal(batch.status,'completed');assert.equal(batch.trials.length,6);assert.equal(batch.summary.warmup_count,2);assert.equal(batch.summary.groups.length,2);assert.ok(batch.summary.groups.every((g:any)=>g.counts.completed===2&&g.metrics.duration.sample_count===2&&g.success_requests_per_second>0));
    for(const t of batch.trials){assert.ok(t.run_id);const run=(await f.server.inject({url:`/v1/runs/${t.run_id}`,headers:auth()})).json();assert.equal(run.benchmark.batch_id,id);assert.equal(run.ephemeral,true);}
    assert.equal(f.codexStarts,0);const json=(await f.server.inject({url:`/api/lab/batches/${id}/export`,headers:auth()})).body,csv=(await f.server.inject({url:`/api/lab/batches/${id}/export?format=csv`,headers:auth()})).body;
    assert.ok(!json.includes('MÔ PHỎNG'));assert.ok(!json.includes('preparing a cup'));assert.match(csv,/"measured"/);assert.ok(!csv.includes('secret'));
    const db=new DatabaseSync(f.config.statsDbPath,{readOnly:true});const stored=JSON.stringify(db.prepare('SELECT * FROM lab_batches').all());db.close();assert.ok(!stored.includes('MÔ PHỎNG'));assert.ok(!stored.includes('green'));assert.ok(!stored.includes('secret'));
    const feed=await f.server.inject({url:`/api/lab/batches/${id}/events`,headers:auth()});assert.match(feed.body,/event: snapshot/);
    const cohort=(await f.server.inject({url:'/api/runs/latency?provider=ollama',headers:auth()})).json();assert.equal(cohort.summary.run_count,3);
  }finally{await f.close();}
});
test('Lab auth, bounds, daily reservation, cancellation, retry conflicts and Codex opt-in are server-enforced',async()=>{
  const f=await fixture({LAB_MAX_REQUESTS_PER_DAY:'8'});try{
    for(const path of ['/api/lab','/api/lab/batches'])assert.equal((await f.server.inject({url:path,headers:auth(appKey)})).statusCode,403);
    assert.equal((await f.server.inject({method:'POST',url:'/api/lab/batches',headers:auth(),payload:spec})).statusCode,403);
    assert.equal((await f.server.inject({method:'POST',url:'/api/lab/batches',headers:{...write,host:'localhost',origin:'http://evil.test'},payload:spec})).statusCode,403);
    assert.equal((await f.server.inject({method:'POST',url:'/api/lab/batches',headers:write,payload:{...spec,targets:[{provider:'codex',model:'fixture'}],allow_codex:true}})).statusCode,403);
    assert.equal((await f.server.inject({method:'POST',url:'/api/lab/batches',headers:write,payload:{...spec,scenarios:['short-answer','structured-list','reasoning-math'],iterations:20,warmup:3,max_output_tokens:2048}})).statusCode,400);
    const r=await f.server.inject({method:'POST',url:'/api/lab/batches',headers:{...write,'idempotency-key':'stop'},payload:{...spec,targets:[{provider:'ollama',model:'slow'}],iterations:4,warmup:0}}),id=r.json().batch.id;
    assert.equal((await f.server.inject({method:'POST',url:'/api/lab/batches',headers:{...write,'idempotency-key':'stop'},payload:spec})).statusCode,409);
    await f.server.inject({method:'POST',url:`/api/lab/batches/${id}/cancel`,headers:write,payload:{}});const cancelled=await terminal(f,id);assert.equal(cancelled.status,'cancelled');assert.ok(cancelled.summary.unstarted>0);assert.ok(cancelled.trials.every((t:any)=>['cancelled','completed'].includes(t.status)));
    await delay(3);assert.equal((await f.server.inject({method:'POST',url:'/api/lab/batches',headers:write,payload:spec})).statusCode,429);
  }finally{await f.close();}
});

test('Lab compares Codex fixture without inventing timing and includes failed/rejected cohorts',async()=>{
  const f=await fixture({LAB_ALLOW_CODEX:'true'});try{
    const r=await f.server.inject({method:'POST',url:'/api/lab/batches',headers:write,payload:{...spec,targets:[{provider:'codex',model:'fixture-codex'},{provider:'ollama',model:'http-error'},{provider:'lmstudio',model:'rate-limit'}],warmup:0,iterations:2,allow_codex:true}});
    assert.equal(r.statusCode,202);const batch=await terminal(f,r.json().batch.id);assert.equal(f.codexStarts,2);
    const codex=batch.summary.groups.find((g:any)=>g.provider==='codex'),error=batch.summary.groups.find((g:any)=>g.provider==='ollama'),limited=batch.summary.groups.find((g:any)=>g.provider==='lmstudio');
    assert.equal(codex.metrics.ttft.p50,null);assert.equal(codex.metrics.output_tokens_per_second.sample_count,0);assert.equal(error.counts.failed,2);assert.equal(error.metrics.duration.sample_count,2);assert.equal(limited.counts.failed,2);
    assert.equal(batch.configuration.codex_sampling,'provider_default_unreported');assert.equal(batch.configuration.codex_output_limit_supported,false);
    const raw=(await f.server.inject({url:`/api/lab/batches/${batch.id}/export`,headers:auth()})).body;assert.ok(!raw.includes('Codex fixture'));
  }finally{await f.close();}
});

test('Lab graceful shutdown, restart recovery, durable quotas and retention never resume inference',async()=>{
  const f=await fixture({LAB_MAX_REQUESTS_PER_DAY:'4'});try{
    const payload={...spec,targets:[{provider:'ollama',model:'slow'}],warmup:0,iterations:4};
    const create=await f.server.inject({method:'POST',url:'/api/lab/batches',headers:{...write,'idempotency-key':'restart'},payload}),id=create.json().batch.id;
    await f.server.close();
    const db=new DatabaseSync(f.config.statsDbPath);const row=db.prepare('SELECT metadata FROM lab_batches WHERE id=?').get(id)!;const metadata=JSON.parse(String(row.metadata));metadata.status='running';metadata.trials[0].status='running';metadata.trials[0].finished_at=0;db.prepare('UPDATE lab_batches SET status=?,metadata=? WHERE id=?').run('running',JSON.stringify(metadata),id);db.close();
    const never=()=>{throw Error('Must not resume.');};const app=await buildServer(f.config,{start:never,resume:never,close:async()=>{}});
    try {
      const recovered=(await app.inject({url:`/api/lab/batches/${id}`,headers:auth()})).json();assert.equal(recovered.status,'interrupted');assert.equal(recovered.trials[0].status,'interrupted');assert.equal(recovered.summary.groups[0].success_requests_per_second,null);
      assert.equal((await app.inject({method:'POST',url:'/api/lab/batches',headers:{...write,'idempotency-key':'restart'},payload})).json().reused,true);
      assert.equal((await app.inject({method:'POST',url:'/api/lab/batches',headers:write,payload})).statusCode,429);
      const old=new DatabaseSync(f.config.statsDbPath);old.prepare('UPDATE lab_batches SET created_at=? WHERE id=?').run(Date.now()-8*86400000,id);old.close();assert.equal((await app.inject({url:'/api/lab/batches',headers:auth()})).json().batches.length,0);
    }finally{await app.close();}
  }finally{await f.close();}
});

test('local names matching priced Codex models stay unknown-cost; missing cache/reasoning stays unknown in aggregates',async()=>{
  const f=await fixture();try{
    const r=await f.server.inject({method:'POST',url:'/v1/chat/completions',headers:auth(),payload:request('lmstudio','gpt-6-luna')});assert.equal(r.statusCode,200);
    const call=(await f.server.inject({url:`/api/stats/calls/${r.headers['x-codex-run-id']}`,headers:auth()})).json();assert.equal(call.cost_usd,null);assert.equal(call.price_checked_on,null);
    const overview=(await f.server.inject({url:'/api/stats/overview',headers:auth()})).json();assert.equal(overview.summary.cache_unknown_calls,1);assert.equal(overview.summary.reasoning_unknown_calls,1);assert.equal(overview.models[0].provider,'lmstudio');
  }finally{await f.close();}
});

test('LM Studio v0 stats/discovery is explicit and local output-budget breach stops remaining trials',async()=>{
  const f=await fixture({LM_STUDIO_API:'v0'});try{
    const models=(await f.server.inject({url:'/v1/models?provider=lmstudio',headers:auth()})).json();assert.equal(models.data[0].state,'loaded');assert.equal(models.data[0].quantization,'Q4_FIXTURE');
    const r=await f.server.inject({method:'POST',url:'/v1/chat/completions',headers:auth(),payload:request('lmstudio','fixture-local',true)});assert.match(r.body,/\[DONE\]/);assert.equal(f.backend.requests.at(-1)!.url,'/api/v0/chat/completions');
    const start=await f.server.inject({method:'POST',url:'/api/lab/batches',headers:write,payload:{...spec,targets:[{provider:'ollama',model:'fixture-local'}],warmup:0,iterations:3,concurrency:1,max_output_tokens:8}});const batch=await terminal(f,start.json().batch.id);assert.equal(batch.status,'cancelled');assert.equal(batch.reason,'provider_output_budget_exceeded');assert.equal(batch.trials.length,1);assert.equal(batch.summary.known_output_tokens,10);
  }finally{await f.close();}
});
