import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { readConfig } from '../src/config.js';
import { createProvider, gatewayInstructions } from '../src/provider.js';
import { buildServer } from '../src/server.js';
import { createAppServerProvider, appServerPolicy, trimmedCatalog } from '../src/app-server-provider.js';
import { startEgressForwarder, type EgressFactory } from '../src/egress-forwarder.js';
import net from 'node:net';
import { publicContent } from '../src/stream-content.js';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { dirname } from 'node:path';
import { createInterface } from 'node:readline';
import { randomUUID } from 'node:crypto';

// A real stdio subprocess, no OpenAI connection or real account data.
async function fixture(env:Record<string,string>={},hooks?:{egress?:EgressFactory}) {
  const directory=await mkdtemp(join(tmpdir(),'gateway-app-server-test-'));
  const source=join(directory,'source'),data=join(directory,'data'),script=join(directory,'fixture.cjs'),trace=join(directory,'trace.jsonl');
  await mkdir(source);await mkdir(data);
  const login={auth_mode:'chatgpt',tokens:{access_token:'SYNTHETIC_ACCESS',account_id:'test-account',refresh_token:'NEVER_COPY_REFRESH'}};
  await writeFile(join(source,'auth.json'),JSON.stringify(login));
  await writeFile(join(source,'config.toml'),'invalid personal config MUST NOT LOAD');
  const previousHome=process.env.CODEX_HOME;
  process.env.CODEX_HOME=source;
  await writeFile(script,`
const fs=require('node:fs');const readline=require('node:readline');
const trace=${JSON.stringify(trace)};
fs.appendFileSync(trace,JSON.stringify({spawn:true,pid:process.pid,home:process.env.CODEX_HOME,args:process.argv.slice(2),callerKey:process.env.OPENAI_API_KEY??null,proxy:process.env.HTTPS_PROXY??null,noProxy:process.env.NO_PROXY??null,httpProxy:process.env.HTTP_PROXY??null,allProxy:process.env.ALL_PROXY??null,lowerProxy:process.env.https_proxy??null})+'\\n');
const send=m=>console.log(JSON.stringify(m));
const notify=(method,params)=>send({method,params});
const reply=(id,result)=>send({id,result});
let initialized=false,nextThread=0,nextTurn=0;const turns=new Map(),totals=new Map(),history=new Map();
const revertMode=()=>{try{return fs.readFileSync(trace+'.revert','utf8').trim();}catch{return 'ok';}};
readline.createInterface({input:process.stdin}).on('line',line=>{
const m=JSON.parse(line);fs.appendFileSync(trace,JSON.stringify(m)+'\\n');
const p=m.params??{},tid=p.threadId;
if(m.method==='initialize'){reply(m.id,{userAgent:'fixture'});return;}
if(m.method==='initialized'){initialized=true;return;}
if(!initialized)process.exit(3);
if(m.method==='account/login/start'){reply(m.id,{type:'chatgptAuthTokens'});return;}
if(m.method==='thread/start'||m.method==='thread/resume'){
const id=tid??'thread-'+(++nextThread);
reply(m.id,{thread:{id,ephemeral:p.ephemeral??false},approvalPolicy:'never',sandbox:{type:'readOnly',networkAccess:false},instructionSources:[]});return;
}
if(m.method==='thread/unsubscribe'){reply(m.id,{status:'unsubscribed'});return;}
if(m.method==='thread/revert'){
const mode=revertMode();
if(mode==='error'){send({id:m.id,error:{code:-32600,message:'PRIVATE_REVERT_ERROR'}});return;}
const h=history.get(tid)??[],at=h.findIndex(t=>t.id===p.beforeTurnId);
// 'noop' simulates a revert that silently keeps history: the gateway must detect it.
if(mode!=='noop'&&at>=0){h.splice(at);totals.set(tid,h.length);}
reply(m.id,{thread:{id:tid,turns:[]},turnsBackwardsCursor:null,itemsBackwardsCursor:null});return;
}
if(m.method==='thread/turns/list'){reply(m.id,{data:(history.get(tid)??[]).slice(-(p.limit??50)).map(t=>({id:t.id,status:'completed',items:[]})),nextCursor:null,backwardsCursor:null});return;}
if(m.method==='turn/interrupt'){
clearTimeout(turns.get(tid));reply(m.id,{});
setTimeout(()=>notify('turn/completed',{threadId:tid,turn:{id:p.turnId,status:'interrupted',items:[]}}),45);return;
}
if(m.method==='turn/start'){
const input=p.input[0].text,id='turn-'+(++nextTurn),itemId='item-'+id;
const prior=(history.get(tid)??[]).map(t=>t.input);if(!history.has(tid))history.set(tid,[]);history.get(tid).push({id,input});
// Notifications before the response exercise the actual app-server race.
notify('turn/started',{threadId:tid,turn:{id,status:'inProgress'}});
if(input.includes('start-crash')){process.exit(1);return;}
if(input.includes('start-error')){send({id:m.id,error:{code:-1,message:'PRIVATE_ERROR'}});return;}
setTimeout(()=>reply(m.id,{turn:{id,status:'inProgress'}}),input.includes('late-ack')?75:0);
notify('item/started',{threadId:tid,turnId:id,item:{id:itemId,type:'agentMessage',text:''}});
notify('item/completed',{threadId:tid,turnId:id,item:{id:'reasoning',type:'reasoning',summary:['PRIVATE_REASONING'],content:['PRIVATE_REASONING']}});
notify('item/agentMessage/delta',{threadId:'other-thread',turnId:id,itemId,delta:'CROSS_THREAD'});
notify('item/agentMessage/delta',{threadId:tid,turnId:'stale-turn',itemId,delta:'CROSS_TURN'});
if(input.includes('crash')){process.stderr.write('PRIVATE_STDERR');process.exit(1);return;}
if(input.includes('tool-item')){notify('item/started',{threadId:tid,turnId:id,item:{id:'bad',type:'commandExecution'}});return;}
if(input.includes('tool-request')){send({id:'tool-request',method:'item/commandExecution/requestApproval',params:{threadId:tid,turnId:id}});return;}
if(input.includes('refresh')){send({id:'refresh-request',method:'account/chatgptAuthTokens/refresh',params:{previousAccountId:'test-account'}});return;}
notify('item/agentMessage/delta',{threadId:tid,turnId:id,itemId,delta:'{"content":"Xin'});
if(input.includes('partial-exit')){setTimeout(()=>process.exit(1),15);return;}
turns.set(tid,setTimeout(()=>{
const text=JSON.stringify({content:input.includes('history?')?'history='+prior.length+(prior.some(x=>x.includes('SECRET'))?' leaked':''):input.includes('second')?'Xin second':'Xin chào',tool_calls:[]});
notify('item/agentMessage/delta',{threadId:tid,turnId:id,itemId,delta:text.slice('{"content":"Xin'.length)});
notify('item/completed',{threadId:tid,turnId:id,item:{id:itemId,type:'agentMessage',text}});
const count=(totals.get(tid)??0)+1;totals.set(tid,count);
notify('thread/tokenUsage/updated',{threadId:tid,turnId:id,tokenUsage:{total:{inputTokens:20*count,outputTokens:4*count,cachedInputTokens:3*count,cacheWriteInputTokens:0,reasoningOutputTokens:count},last:{inputTokens:2,outputTokens:1,cachedInputTokens:0,cacheWriteInputTokens:0,reasoningOutputTokens:0}}});
notify('turn/completed',{threadId:tid,turn:{id,status:input.includes('failed')?'failed':'completed',items:[]}});
},input.includes('slow')?2000:100));return;
}
});
`);
  const config=readConfig({DATA_DIR:data,NATIVE_CODEX_HOME:join(directory,'no-native'),CODEX_BIN:script,INSPECTOR_ENABLED:'true',CODEX_EGRESS_FORWARDER:'false',...env});
  const provider=hooks?await createAppServerProvider(config,hooks):await createProvider(config);
  return {directory,source,data,script,config,provider,login,traceFile:trace,
    trace:async()=> (await readFile(trace,'utf8')).trim().split('\n').map(line=>JSON.parse(line)),
    close:async()=>{await provider.close();if(previousHome===undefined)delete process.env.CODEX_HOME;else process.env.CODEX_HOME=previousHome;await rm(directory,{recursive:true,force:true});}};
}

test('persistent app-server streams genuine deltas before completion, reuses one process and maps only per-turn usage',async()=>{
  const f=await fixture(),events:any[]=[],observations:unknown[]=[];let timing:any;
  try {
    await f.provider.warmup?.();
    const thread=f.provider.start('fixture-model','low',true);
    let done=false;
    const run=thread.run('first',{outputSchema:{type:'object'},onEvent:event=>{events.push(event);if(event.type==='output'&&publicContent(event.text)==='Xin')assert.equal(done,false);},onAppServerLifecycle:t=>{timing=t;},observe:async o=>{observations.push(o);},observeResponse:async o=>{observations.push(o);}}).then(value=>{done=true;return value;});
    const result=await run;
    assert.equal(JSON.parse(result.finalResponse).content,'Xin chào');
    assert.deepEqual(result.usage,{input_tokens:20,output_tokens:4,cached_input_tokens:3,reasoning_output_tokens:1,cache_write_input_tokens:0});
    assert.ok(events.some(e=>e.type==='output'&&publicContent(e.text)==='Xin'));
    assert.equal(events.filter(e=>e.type==='usage').length,1);
    assert.ok(timing.first_delta_ms<timing.turn_completed_ms);assert.equal(timing.connection_reused,true);
    assert.ok(!JSON.stringify({events,observations,result}).includes('PRIVATE_'));
    assert.ok(!JSON.stringify(events).includes('CROSS_'));
    await f.provider.start('fixture-model').run('second');
    const trace=await f.trace();assert.equal(trace.filter(e=>e.spawn).length,1);
    const spawn=trace.find(e=>e.spawn);assert.equal(spawn.home,join(f.data,'codex-app-server'));assert.equal(spawn.callerKey,null);
    assert.ok(!spawn.args.includes(f.source));assert.ok(!JSON.stringify(spawn).includes('SYNTHETIC_ACCESS'));
    const start=trace.find(e=>e.method==='thread/start');assert.equal(start.params.ephemeral,true);
    assert.equal(start.params.baseInstructions,gatewayInstructions);assert.deepEqual(start.params.environments,[]);assert.deepEqual(start.params.dynamicTools,[]);
    const turn=trace.find(e=>e.method==='turn/start');assert.deepEqual(turn.params.sandboxPolicy,{type:'readOnly',networkAccess:false});
    assert.equal(turn.params.approvalPolicy,'never');assert.deepEqual(turn.params.outputSchema,{type:'object'});
    assert.ok(!JSON.stringify(trace).includes('NEVER_COPY_REFRESH'));
    assert.equal(await readFile(join(f.source,'auth.json'),'utf8'),JSON.stringify(f.login));
    await assert.rejects(readFile(join(f.data,'codex-app-server','auth.json')),{code:'ENOENT'});
  }finally{await f.close();}
});

test('concurrent threads remain isolated; cancellation waits for terminal event and preserves the other turn',async()=>{
  const f=await fixture(),controller=new AbortController(),events:any[]=[],processes:any[]=[];
  try {
    const first=f.provider.start('fixture'),second=f.provider.start('fixture');
    const one=first.run('slow late-ack',{signal:controller.signal,onProcess:(...args)=>processes.push(args),onEvent:e=>{if(e.type==='output'&&e.text)controller.abort();}});
    const rejected=assert.rejects(one,(error:any)=>error.code==='request_cancelled');
    const two=second.run('second',{onProcess:(...args)=>processes.push(args),onEvent:e=>events.push(e)});
    await rejected;
    assert.equal(JSON.parse((await two).finalResponse).content,'Xin second');
    assert.equal(events.filter(e=>e.type==='usage').length,1);
    assert.ok(!JSON.stringify(events).includes('CROSS_'));
    assert.deepEqual(processes.map(p=>p[1]),[true,false]);
    const trace=await f.trace();assert.equal(trace.filter(e=>e.spawn).length,1);
    assert.equal(trace.filter(e=>e.method==='turn/interrupt').length,1);
    const interrupted=trace.find(e=>e.method==='turn/interrupt');assert.ok(interrupted.params.turnId);
  }finally{await f.close();}
});

test('resume preserves native thread ID, suppresses history hydration, and rejects duplicate turns',async()=>{
  const f=await fixture();
  try {
    const first=f.provider.start('fixture');await first.run('first');
    assert.ok(first.id?.startsWith('app-server:'));
    const resumed=f.provider.resume(first.id!,'fixture');const second=await resumed.run('second');
    assert.equal(second.usage?.input_tokens,20);assert.equal(second.usage?.output_tokens,4);
    assert.equal(resumed.id,first.id);
    const trace=await f.trace(),resume=trace.find(e=>e.method==='thread/resume');
    assert.equal(resume.params.excludeTurns,true);assert.equal(resume.params.threadId,first.id!.slice('app-server:'.length));
    const controller=new AbortController();const pending=resumed.run('slow',{signal:controller.signal});
    const rejected=assert.rejects(pending);
    await assert.rejects(f.provider.resume(first.id!,'fixture').run('duplicate'),(e:any)=>e.code==='codex_thread_busy');
    controller.abort();await rejected;
  }finally{await f.close();}
});

test('resumed usage without a known cumulative baseline stays unknown, then subsequent turns use the observed baseline',async()=>{
  const f=await fixture();
  try {
    const first=await f.provider.resume('app-server:stored-thread','fixture').run('first');
    assert.equal(first.usage,null);
    const second=await f.provider.resume('app-server:stored-thread','fixture').run('second');
    assert.equal(second.usage?.input_tokens,20);assert.equal(second.usage?.output_tokens,4);
  }finally{await f.close();}
});

test('process crash fails the turn without replay and starts a new connection for the next request',async()=>{
  const f=await fixture();
  try {
    await assert.rejects(f.provider.start('fixture').run('crash'),(e:any)=>e.code==='codex_app_server_exited'||e.code==='codex_app_server_io');
    const result=await f.provider.start('fixture').run('second');assert.equal(JSON.parse(result.finalResponse).content,'Xin second');
    const trace=await f.trace();assert.equal(trace.filter(e=>e.spawn).length,2);assert.equal(trace.filter(e=>e.method==='turn/start').length,2);
  }finally{await f.close();}
});

test('partial delta survives a crash in safe observation; admission failure does not leave a turn running',async()=>{
  const f=await fixture();let observation:any;
  try {
    await assert.rejects(f.provider.start('fixture').run('partial-exit',{observeResponse:async o=>{observation=o;}}));
    assert.equal(observation.complete,false);assert.equal(observation.final_response,'{"content":"Xin');
    assert.equal(observation.assistant_messages[0].text,'{"content":"Xin');assert.ok(!JSON.stringify(observation).includes('PRIVATE_'));
    await assert.rejects(f.provider.start('fixture').run('start-error'),(e:any)=>e.code==='codex_app_server_rpc');
    await f.provider.start('fixture').run('second');
    assert.equal((await f.trace()).filter(e=>e.spawn).length,3);
  }finally{await f.close();}
});

test('missing CLI auth is explicit and never submits inference',async()=>{
  const f=await fixture();
  try {
    await writeFile(join(f.source,'auth.json'),'{}');
    await assert.rejects(f.provider.start('fixture').run('first'),(e:any)=>e.code==='codex_auth_required');
    assert.equal((await f.trace()).filter(e=>e.method==='turn/start').length,0);
  }finally{await f.close();}
});

test('unexpected tool items and approval requests terminate the process; expired external auth fails safely',async()=>{
  const f=await fixture();
  try {
    for(const input of ['tool-item','tool-request'])await assert.rejects(f.provider.start('fixture').run(input),(e:any)=>e.code==='unexpected_agent_tool');
    await assert.rejects(f.provider.start('fixture').run('refresh'),(e:any)=>e.code==='codex_auth_refresh_required');
    assert.equal(await readFile(join(f.source,'auth.json'),'utf8'),JSON.stringify(f.login));
    const trace=await f.trace();assert.ok(!JSON.stringify(trace).includes('NEVER_COPY_REFRESH'));
    // The connection is killed immediately; a queued rejection frame need not
    // flush to the child. No approval result may ever grant execution.
    assert.ok(!trace.some(e=>e.id==='tool-request'&&e.result));
  }finally{await f.close();}
});

test('pinned native app-server accepts isolated startup and initialize without inference or source auth',async()=>{
  const directory=await mkdtemp(join(tmpdir(),'gateway-native-initialize-'));
  const provider=await createProvider(readConfig({DATA_DIR:directory}));
  try {
    await provider.warmup!();await provider.close();
    const restarted=await createProvider(readConfig({DATA_DIR:directory}));
    try {await restarted.warmup!();}finally{await restarted.close();}
  }finally{await provider.close();await rm(directory,{recursive:true,force:true});}
});

test('gateway home allows native system skills and rejects custom skills',async()=>{
  const f=await fixture();
  try {
    const skills=join(f.data,'codex-app-server','skills');
    await mkdir(join(skills,'.system'),{recursive:true});
    await f.provider.warmup!();await f.provider.close();
    await mkdir(join(skills,'custom'));
    const other=await createProvider(f.config);
    try {await assert.rejects(other.warmup!(),(e:any)=>e.code==='codex_app_server_config');}finally{await other.close();}
  }finally{await f.close();}
});

test('pinned native thread admission enforces read-only, no network and no loaded instruction files without inference',async()=>{
  const directory=await mkdtemp(join(tmpdir(),'gateway-native-admission-'));
  const require=createRequire(import.meta.url),root=dirname(require.resolve(`@openai/codex-${process.platform}-${process.arch}/package.json`));
  const arch=process.arch==='x64'?'x86_64':'aarch64';
  const target=process.platform==='win32'?'pc-windows-msvc':process.platform==='darwin'?'apple-darwin':'unknown-linux-musl';
  const child=spawn(join(root,'vendor',arch+'-'+target,'bin',process.platform==='win32'?'codex.exe':'codex'),
    ['app-server','--listen','stdio://','-c','cli_auth_credentials_store="ephemeral"'],
    {cwd:directory,env:{...process.env,CODEX_HOME:directory},windowsHide:true});
  const closed=new Promise<void>(done=>child.once('close',()=>done()));
  child.stderr.resume();const lines=createInterface({input:child.stdout});
  const send=(id:number,method:string,params:unknown)=>child.stdin.write(JSON.stringify({id,method,params})+'\n');
  const timer=setTimeout(()=>child.kill(),15000);
  try {
    send(1,'initialize',{clientInfo:{name:'gateway_admission_test',version:'1'},capabilities:{experimentalApi:true}});
    let checked=false;
    for await(const line of lines){
      const message=JSON.parse(line);
      if(message.id===1){assert.ok(message.result);child.stdin.write('{"method":"initialized"}\n');
        const token='test.'+Buffer.from(JSON.stringify({sub:'synthetic',exp:4102444800,'https://api.openai.com/auth':{chatgpt_account_id:'test-account'}})).toString('base64url')+'.synthetic';
        send(2,'account/login/start',{type:'chatgptAuthTokens',accessToken:token,chatgptAccountId:'test-account'});
      } else if(message.id===2){
        assert.equal(message.result?.type,'chatgptAuthTokens','Native external-token login rejected the pinned protocol.');
        send(3,'thread/start',{model:'gpt-6-luna',cwd:directory,approvalPolicy:'never',sandbox:'read-only',ephemeral:true,baseInstructions:gatewayInstructions,developerInstructions:'',environments:[],dynamicTools:[],
          config:{project_doc_max_bytes:0,web_search:'disabled','features.shell_tool':false,'features.unified_exec':false,'features.apps':false,'features.plugins':false,'features.multi_agent':false,'features.multi_agent_v2':false,'features.computer_use':false}});
      } else if(message.id===3){
        assert.ok(message.result,'Native thread admission rejected the pinned protocol.');
        assert.deepEqual(message.result.sandbox,{type:'readOnly',networkAccess:false});
        assert.equal(message.result.approvalPolicy,'never');assert.deepEqual(message.result.instructionSources,[]);
        assert.equal(message.result.thread.ephemeral,true);checked=true;break;
      }
    }
    assert.equal(checked,true);
    await assert.rejects(readFile(join(directory,'auth.json')),{code:'ENOENT'});
  }finally{clearTimeout(timer);lines.close();child.kill();await closed;
    // The native CLI may still be finishing a background plugin-catalog clone in its temp dir.
    await rm(directory,{recursive:true,force:true,maxRetries:10,retryDelay:200});}
});

test('failed turns retain safe partial output; personal configuration is refused in the gateway home',async()=>{
  const f=await fixture();let observation:any;
  try {
    await assert.rejects(f.provider.start('fixture').run('failed',{observeResponse:async o=>{observation=o;}}),(e:any)=>e.code==='codex_turn_failed');
    assert.equal(observation.complete,false);assert.ok(observation.assistant_messages.length);assert.ok(!JSON.stringify(observation).includes('PRIVATE_'));
    await f.provider.close();
    await writeFile(join(f.data,'codex-app-server','config.toml'),'untrusted');
    const other=await createProvider(f.config);
    try{await assert.rejects(other.warmup!(),(e:any)=>e.code==='codex_app_server_config');}finally{await other.close();}
  }finally{await f.close();}
});

test('gateway SSE exposes real content increments and capability provenance with the new adapter',async()=>{
  const f=await fixture();const app=await buildServer(f.config,f.provider);
  try {
    const response=await app.inject({method:'POST',url:'/v1/chat/completions',payload:{model:'fixture',messages:[{role:'user',content:'first'}],stream:true,stream_options:{include_usage:true}}});
    assert.equal(response.statusCode,200);assert.match(response.body,/\[DONE\]/);
    const chunks=response.body.split('\n').filter(l=>l.startsWith('data: {')).map(l=>JSON.parse(l.slice(6)));
    const deltas=chunks.map(c=>c.choices?.[0]?.delta?.content??'').filter(Boolean);
    assert.ok(deltas.length>=2);assert.equal(deltas.join(''),'Xin chào');assert.equal(chunks.find(c=>c.usage)?.usage.prompt_tokens,20);
    const id=response.headers['x-codex-run-id'];
    const run=(await app.inject({url:'/v1/runs/'+id})).json();
    assert.equal(run.capabilities.transport,'app-server-stdio');assert.equal(run.capabilities.public_output,'content_deltas');
    assert.equal(run.metrics.ttft.value,null);assert.ok(run.metrics.app_server_lifecycle.first_delta_ms<run.metrics.app_server_lifecycle.turn_completed_ms);
    assert.ok(!JSON.stringify(run).includes('PRIVATE_'));
  }finally{await app.close();await f.close();}
});

test('legacy session migrates from saved gateway messages, then resumes only new messages',async()=>{
  const f=await fixture(),id=randomUUID();
  await writeFile(join(f.data,'sessions.json'),JSON.stringify([{id,threadId:'legacy-native-thread',model:'fixture',effort:'low',updatedAt:Date.now(),messages:[{role:'user',content:'remember-original'},{role:'assistant',content:'remember-answer'}]}]));
  const app=await buildServer(f.config,f.provider);
  try {
    const route='/v1/sessions/'+id+'/messages';
    assert.equal((await app.inject({method:'POST',url:route,payload:{message:'first'}})).statusCode,200);
    let trace=await f.trace();assert.equal(trace.filter(e=>e.method==='thread/resume').length,0);
    let starts=trace.filter(e=>e.method==='turn/start');assert.match(starts[0].params.input[0].text,/remember-original/);assert.match(starts[0].params.input[0].text,/remember-answer/);
    const persisted=JSON.parse(await readFile(join(f.data,'sessions.json'),'utf8'));assert.ok(persisted[0].threadId.startsWith('app-server:'));
    assert.equal((await app.inject({method:'POST',url:route,payload:{message:'second'}})).statusCode,200);
    trace=await f.trace();starts=trace.filter(e=>e.method==='turn/start');
    assert.equal(trace.filter(e=>e.method==='thread/resume').length,1);assert.ok(!starts[1].params.input[0].text.includes('remember-original'));assert.match(starts[1].params.input[0].text,/second/);
    assert.equal((await readFile(join(f.source,'config.toml'),'utf8')),'invalid personal config MUST NOT LOAD');
  }finally{await app.close();await f.close();}
});

const waitFor=async(check:()=>Promise<boolean>,what:string)=>{for(let i=0;i<200;i++){if(await check())return;await new Promise(r=>setTimeout(r,10));}throw new Error('timeout waiting for '+what);};
const count=(trace:any[],method:string)=>trace.filter(e=>e.method===method).length;
const stateless=(f:any,input:string,options:any={})=>f.provider.start('fixture','low',false,{stateless:true}).run(input,options);

test('warm pool reuses a stateless thread only after reverting it to an empty, verified history',async()=>{
  const f=await fixture();const timings:any[]=[];
  try {
    const first=await stateless(f,'SECRET-word history?',{onAppServerLifecycle:(t:any)=>timings.push(t)});
    assert.equal(JSON.parse(first.finalResponse).content,'history=0');assert.equal(timings.at(-1).thread_reused,false);
    await waitFor(async()=>count(await f.trace(),'thread/turns/list')===1,'recycle');
    const second=await stateless(f,'history?',{onAppServerLifecycle:(t:any)=>timings.push(t)});
    // The reused thread saw no earlier messages, and per-turn usage is not polluted by the reverted turn.
    assert.equal(JSON.parse(second.finalResponse).content,'history=0');
    assert.deepEqual(second.usage,{input_tokens:20,output_tokens:4,cached_input_tokens:3,reasoning_output_tokens:1,cache_write_input_tokens:0});
    assert.equal(timings.at(-1).thread_reused,true);
    await waitFor(async()=>count(await f.trace(),'thread/turns/list')===2,'second recycle');
    const trace=await f.trace();
    assert.equal(count(trace,'thread/start'),1);assert.equal(count(trace,'thread/revert'),2);assert.equal(count(trace,'thread/unsubscribe'),0);
    const turns=trace.filter(e=>e.method==='turn/start');assert.equal(turns[0].params.threadId,turns[1].params.threadId);
    // Policy is re-asserted on every turn of a reused thread.
    for(const turn of turns){assert.equal(turn.params.approvalPolicy,'never');assert.deepEqual(turn.params.sandboxPolicy,{type:'readOnly',networkAccess:false});assert.deepEqual(turn.params.environments,[]);}
    const reverts=trace.filter(e=>e.method==='thread/revert');assert.deepEqual(reverts.map(e=>e.params.beforeTurnId),['turn-1','turn-2']);
  }finally{await f.close();}
});

test('failed or unverifiable revert retires the thread and falls back to a fresh thread',async()=>{
  for(const mode of ['error','noop']){
    const f=await fixture();
    try {
      await writeFile(f.traceFile+'.revert',mode);
      await stateless(f,'SECRET-word');
      await waitFor(async()=>count(await f.trace(),'thread/unsubscribe')===1,'retire '+mode);
      const next=await stateless(f,'history?');
      assert.equal(JSON.parse(next.finalResponse).content,'history=0',mode);
      const trace=await f.trace();assert.equal(count(trace,'thread/start'),2,mode);
      const turns=trace.filter(e=>e.method==='turn/start');assert.notEqual(turns[0].params.threadId,turns[1].params.threadId);
    }finally{await f.close();}
  }
});

test('parallel stateless requests never wait for the pool; idle warm threads stay within the limit',async()=>{
  const f=await fixture({CODEX_WARM_THREADS:'1'});
  try {
    const results=await Promise.all([1,2,3].map(()=>stateless(f,'slow second')));
    for(const result of results)assert.equal(JSON.parse(result.finalResponse).content,'Xin second');
    let trace=await f.trace();
    assert.equal(count(trace,'thread/start'),3);assert.equal(new Set(trace.filter(e=>e.method==='turn/start').map(e=>e.params.threadId)).size,3);
    await waitFor(async()=>{const t=await f.trace();return count(t,'thread/turns/list')===3&&count(t,'thread/unsubscribe')===2;},'pool bound');
    await stateless(f,'second');
    trace=await f.trace();assert.equal(count(trace,'thread/start'),3);
  }finally{await f.close();}
});

test('sessions, playground, cancelled turns and a disabled pool never recycle threads',async()=>{
  const f=await fixture();
  try {
    await f.provider.start('fixture').run('second');
    await f.provider.start('fixture','low',true,{stateless:true}).run('second');
    const controller=new AbortController();
    const cancelled=stateless(f,'slow',{signal:controller.signal,onEvent:(e:any)=>{if(e.type==='output'&&e.text)controller.abort();}});
    await assert.rejects(cancelled,(e:any)=>e.code==='request_cancelled');
    await waitFor(async()=>count(await f.trace(),'thread/unsubscribe')===3,'unsubscribe');
    assert.equal(count(await f.trace(),'thread/revert'),0);
  }finally{await f.close();}
  const disabled=await fixture({CODEX_WARM_THREADS:'0'});
  try {
    await stateless(disabled,'second');await stateless(disabled,'second');
    const trace=await disabled.trace();assert.equal(count(trace,'thread/revert'),0);assert.equal(count(trace,'thread/start'),2);
  }finally{await disabled.close();}
});

test('warm threads die with their process and provider close leaves nothing reusable',async()=>{
  const f=await fixture();
  try {
    await stateless(f,'second');
    await waitFor(async()=>count(await f.trace(),'thread/turns/list')===1,'recycle');
    await assert.rejects(stateless(f,'crash'));
    const next=await stateless(f,'history?');assert.equal(JSON.parse(next.finalResponse).content,'history=0');
    const trace=await f.trace();assert.equal(trace.filter(e=>e.spawn).length,2);assert.equal(count(trace,'thread/start'),2);
    await waitFor(async()=>count(await f.trace(),'thread/turns/list')===2,'recycle after restart');
    await f.provider.close();
    await assert.rejects(stateless(f,'second'),(e:any)=>e.code==='codex_app_server_closed');
  }finally{await f.close();}
});

test('gateway stateless chat reuses a reverted warm thread while sessions keep their own thread',async()=>{
  const f=await fixture();const app=await buildServer(f.config,f.provider);
  try {
    const ask=async(content:string)=>(await app.inject({method:'POST',url:'/v1/chat/completions',payload:{model:'fixture',messages:[{role:'user',content}]}})).json();
    assert.equal((await ask('SECRET-word history?')).choices[0].message.content,'history=0');
    await waitFor(async()=>count(await f.trace(),'thread/turns/list')===1,'recycle');
    assert.equal((await ask('history?')).choices[0].message.content,'history=0');
    let trace=await f.trace();assert.equal(count(trace,'thread/start'),1);
    const session=(await app.inject({method:'POST',url:'/v1/sessions',payload:{model:'fixture'}})).json();
    assert.equal((await app.inject({method:'POST',url:'/v1/sessions/'+session.session_id+'/messages',payload:{message:'history?'}})).statusCode,200);
    trace=await f.trace();assert.equal(count(trace,'thread/start'),2);
    const sessionTurn=trace.filter(e=>e.method==='turn/start').at(-1);
    assert.notEqual(sessionTurn.params.threadId,trace.find(e=>e.method==='turn/start').params.threadId);
  }finally{await app.close();await f.close();}
});

test('app-server egress uses only the gateway-owned loopback forwarder; flag off or forwarder failure spawns direct',async()=>{
  const saved={HTTPS_PROXY:process.env.HTTPS_PROXY,HTTP_PROXY:process.env.HTTP_PROXY,ALL_PROXY:process.env.ALL_PROXY,https_proxy:process.env.https_proxy};
  Object.assign(process.env,{HTTPS_PROXY:'http://caller-proxy.invalid:1',HTTP_PROXY:'http://caller-proxy.invalid:2',ALL_PROXY:'socks5://caller-proxy.invalid:3',https_proxy:'http://caller-proxy.invalid:4'});
  let port=0;
  try {
    const f=await fixture({CODEX_EGRESS_FORWARDER:'true'},{egress:async()=>{const fw=await startEgressForwarder();port=fw.port!;return fw;}});
    try {
      await f.provider.start('fixture').run('second');
      const spawn=(await f.trace()).find(e=>e.spawn);
      assert.equal(spawn.proxy,'http://127.0.0.1:'+port);assert.equal(spawn.noProxy,'localhost,127.0.0.1');
      assert.equal(spawn.httpProxy,null);assert.equal(spawn.allProxy,null);assert.equal(spawn.lowerProxy,null);
      const egress:any=f.provider.egress!();assert.equal(egress.enabled,true);assert.equal(egress.port,port);
    }finally{await f.close();}
    // Provider close stops the forwarder.
    await assert.rejects(new Promise((resolve,reject)=>{const s=net.connect(port,'127.0.0.1',()=>{s.destroy();resolve(null);});s.once('error',reject);}));
    for(const [env,hooks] of [[{CODEX_EGRESS_FORWARDER:'false'},{egress:async()=>{throw new Error('must not start');}}],[{CODEX_EGRESS_FORWARDER:'true'},{egress:async()=>{throw Object.assign(new Error('bind'),{code:'EACCES'});}}]] as const){
      const write=process.stderr.write;process.stderr.write=(()=>true) as typeof process.stderr.write;
      const g=await fixture({...env},hooks as any);
      try {
        const result=await g.provider.start('fixture').run('second');assert.equal(JSON.parse(result.finalResponse).content,'Xin second');
        const spawn=(await g.trace()).find(e=>e.spawn);
        assert.equal(spawn.proxy,null);assert.equal(spawn.noProxy,null);assert.equal(spawn.httpProxy,null);assert.equal(g.provider.egress!(),null);
      }finally{process.stderr.write=write;await g.close();}
    }
  }finally{for(const [key,value] of Object.entries(saved)){if(value===undefined)delete process.env[key];else process.env[key]=value;}}
});

const spawnFlags=(args:string[])=>{const flags=new Map<string,string>();for(let i=0;i<args.length;i++)if(args[i]==='-c'){const [key,...rest]=args[i+1]!.split('=');flags.set(key!,rest.join('='));}return flags;};

test('prompt trimming flags reach the app-server and every new or reused thread; the switch restores the full prompt',async()=>{
  for(const trim of ['true','false']){
    const f=await fixture({CODEX_TRIM_PROMPT:trim});
    try {
      await stateless(f,'second');
      await waitFor(async()=>count(await f.trace(),'thread/turns/list')===1,'recycle');
      await stateless(f,'second');
      const trace=await f.trace(),flags=spawnFlags(trace.find(e=>e.spawn).args);
      for(const ignored of ['features.skills','features.environments','features.multi_agent_v2'])assert.equal(flags.has(ignored),false,ignored+' is not a valid 0.165.0 key');
      assert.equal(flags.get('approval_policy'),'"never"');assert.equal(flags.get('sandbox_mode'),'"read-only"');assert.equal(flags.get('features.shell_tool'),'false');
      assert.equal(flags.get('features.multi_agent_v2.enabled'),'false');
      assert.equal(flags.get('skills.include_instructions'),trim==='true'?'false':undefined);
      assert.equal(flags.get('include_environment_context'),trim==='true'?'false':undefined);
      assert.equal(flags.get('features.multi_agent_v2.disable_native_tools'),trim==='true'?'true':undefined);
      assert.equal(flags.has('model_catalog_json'),false,'No fresh model cache, so no trimmed catalog.');
      // One thread/start served both requests (the second reused the reverted thread) with the same policy.
      const starts=trace.filter(e=>e.method==='thread/start');assert.equal(starts.length,1);
      assert.equal(starts[0].params.config['skills.include_instructions'],trim==='true'?false:undefined);
      assert.equal(starts[0].params.approvalPolicy,'never');
    }finally{await f.close();}
  }
});

test('trimmed model catalog derives from the recent app-server cache only and never copies other data',async()=>{
  const directory=await mkdtemp(join(tmpdir(),'gateway-catalog-'));
  const cache=(extra:object={})=>JSON.stringify({fetched_at:new Date().toISOString(),etag:'W/"x"',identity:'PRIVATE_IDENTITY',models:[
    {slug:'m1',tool_mode:'code_mode_only',multi_agent_version:'v2',experimental_supported_tools:['clock'],apply_patch_tool_type:'freeform',context_window:1},
    {slug:'m2',tool_mode:'code_mode_only',experimental_supported_tools:[]}],...extra});
  try {
    assert.equal(await trimmedCatalog(directory),undefined,'missing cache');
    await writeFile(join(directory,'models_cache.json'),'{not json');
    assert.equal(await trimmedCatalog(directory),undefined,'malformed cache');
    await writeFile(join(directory,'models_cache.json'),cache({fetched_at:new Date(Date.now()-8*86_400_000).toISOString()}));
    assert.equal(await trimmedCatalog(directory),undefined,'stale cache');
    await writeFile(join(directory,'models_cache.json'),cache({fetched_at:new Date(Date.now()+2*3_600_000).toISOString()}));
    assert.equal(await trimmedCatalog(directory),undefined,'cache from the future');
    await writeFile(join(directory,'models_cache.json'),cache({models:[{no_slug:true}]}));
    assert.equal(await trimmedCatalog(directory),undefined,'model without slug');
    await writeFile(join(directory,'models_cache.json'),cache({models:[]}));
    assert.equal(await trimmedCatalog(directory),undefined,'empty catalog');
    await writeFile(join(directory,'models_cache.json'),JSON.stringify({fetched_at:new Date().toISOString(),models:[{slug:'big',pad:'x'.repeat(8_400_000)}]}));
    assert.equal(await trimmedCatalog(directory),undefined,'oversized cache');
    await writeFile(join(directory,'models_cache.json'),cache());
    const path=await trimmedCatalog(directory);assert.equal(path,join(directory,'gateway-model-catalog.json'));
    const text=await readFile(path!,'utf8'),catalog=JSON.parse(text);
    assert.deepEqual(Object.keys(catalog),['models']);assert.ok(!text.includes('PRIVATE_IDENTITY'));
    assert.deepEqual(catalog.models.map((m:any)=>[m.slug,m.tool_mode,m.experimental_supported_tools,m.apply_patch_tool_type,'multi_agent_version' in m]),
      [['m1','direct',[],null,false],['m2','direct',[],null,false]]);
    assert.equal(catalog.models[0].context_window,1);
  }finally{await rm(directory,{recursive:true,force:true});}
});

test('a fresh cache makes the app-server start with the trimmed catalog unless the switch is off',async()=>{
  for(const trim of ['true','false']){
    const f=await fixture({CODEX_TRIM_PROMPT:trim});
    try {
      await mkdir(join(f.data,'codex-app-server'),{recursive:true});
      await writeFile(join(f.data,'codex-app-server','models_cache.json'),JSON.stringify({fetched_at:new Date().toISOString(),models:[{slug:'fixture-model',tool_mode:'code_mode_only'}]}));
      await f.provider.start('fixture-model').run('first');
      const flags=spawnFlags((await f.trace()).find(e=>e.spawn).args);
      assert.equal(flags.get('model_catalog_json'),trim==='true'?JSON.stringify(join(f.data,'codex-app-server','gateway-model-catalog.json')):undefined);
    }finally{await f.close();}
  }
});

test('pinned native app-server accepts every gateway policy key and reports no ignored settings',async()=>{
  for(const trim of [true,false]){
    const directory=await mkdtemp(join(tmpdir(),'gateway-native-policy-'));
    const require=createRequire(import.meta.url),root=dirname(require.resolve(`@openai/codex-${process.platform}-${process.arch}/package.json`));
    const arch=process.arch==='x64'?'x86_64':'aarch64';
    const target=process.platform==='win32'?'pc-windows-msvc':process.platform==='darwin'?'apple-darwin':'unknown-linux-musl';
    const home=join(directory,'home');await mkdir(home);
    const policy=appServerPolicy(trim);
    const child=spawn(join(root,'vendor',arch+'-'+target,'bin',process.platform==='win32'?'codex.exe':'codex'),
      ['app-server','--listen','stdio://',...Object.entries(policy).flatMap(([key,value])=>['-c',key+'='+JSON.stringify(value)])],
      {cwd:directory,env:{PATH:process.env.PATH??'',HOME:home,CODEX_HOME:directory},windowsHide:true});
    const closed=new Promise<void>(done=>child.once('close',()=>done()));
    child.stderr.resume();const lines=createInterface({input:child.stdout});
    const send=(id:number,method:string,params:unknown)=>child.stdin.write(JSON.stringify({id,method,params})+'\n');
    const timer=setTimeout(()=>child.kill(),15000);const warnings:string[]=[];let checked=false;
    try {
      send(1,'initialize',{clientInfo:{name:'gateway_policy_test',version:'1'},capabilities:{experimentalApi:true}});
      for await(const line of lines){
        const message=JSON.parse(line);
        if(message.method==='configWarning'||message.method==='warning')warnings.push(String(message.params?.summary??message.params?.message));
        if(message.id===1){child.stdin.write('{"method":"initialized"}\n');
          const token='test.'+Buffer.from(JSON.stringify({sub:'synthetic',exp:4102444800,'https://api.openai.com/auth':{chatgpt_account_id:'test-account'}})).toString('base64url')+'.synthetic';
          send(2,'account/login/start',{type:'chatgptAuthTokens',accessToken:token,chatgptAccountId:'test-account'});
        } else if(message.id===2){
          send(3,'thread/start',{model:'gpt-6-luna',cwd:directory,approvalPolicy:'never',sandbox:'read-only',ephemeral:true,baseInstructions:gatewayInstructions,developerInstructions:'',environments:[],dynamicTools:[],config:{...policy}});
        } else if(message.id===3){
          assert.ok(message.result,'Native thread admission rejected the gateway policy.');
          assert.equal(message.result.approvalPolicy,'never');assert.deepEqual(message.result.sandbox,{type:'readOnly',networkAccess:false});assert.deepEqual(message.result.instructionSources,[]);
          checked=true;break;
        }
      }
      assert.equal(checked,true);
      assert.deepEqual(warnings.filter(w=>/unrecogni[sz]ed|ignored/i.test(w)),[],'A policy key is unknown to the pinned Codex and has no effect.');
    }finally{clearTimeout(timer);lines.close();child.kill();await closed;await rm(directory,{recursive:true,force:true,maxRetries:10,retryDelay:300});}
  }
});
