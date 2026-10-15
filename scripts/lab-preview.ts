import {mkdtemp,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {setTimeout as delay} from 'node:timers/promises';
import {localBackend} from '../test/fixtures/local-backend.js';
import {buildServer} from '../src/server.js';
import {readConfig} from '../src/config.js';
import type {Provider,ObservedTurnOptions} from '../src/provider.js';

// No .env, native history, Codex executable or real-account calls.
const backend=await localBackend(15604),directory=await mkdtemp(join(tmpdir(),'codex-lab-preview-'));
const config=readConfig({DATA_DIR:directory,NATIVE_CODEX_HOME:join(directory,'no-native'),PORT:'15602',LOCAL_API_KEY:'fixture-admin',DEFAULT_MODEL:'fixture-codex',OLLAMA_BASE_URL:backend.url,LM_STUDIO_BASE_URL:backend.url,MAX_CONCURRENT:'2',MAX_QUEUE:'8',LAB_ALLOW_CODEX:'true',LAB_MAX_REQUESTS_PER_DAY:'1000',LAB_MIN_INTERVAL_MS:'1'});
const make=()=>({id:'fixture-codex',run:async(_input:string,options:ObservedTurnOptions={})=>{
  const content='MÔ PHỎNG Codex — không gọi tài khoản thật.';
  await delay(40,undefined,{signal:options.signal});options.onEvent?.({type:'output',item_id:'fixture',text:JSON.stringify({content:content.slice(0,15),tool_calls:[]})});
  await delay(80,undefined,{signal:options.signal});return {items:[],finalResponse:JSON.stringify({content,tool_calls:[]}),usage:{input_tokens:20,output_tokens:10,cached_input_tokens:0,reasoning_output_tokens:0,cache_write_input_tokens:0}};
}});
const provider:Provider={start:make,resume:make,close:async()=>{}};
const app=await buildServer(config,provider);
app.addHook('onSend',async(req,reply,payload)=>{reply.header('X-Codex-Preview','performance-lab');return req.url.startsWith('/dashboard')&&typeof payload==='string'&&payload.includes('<main>')?payload.replace('<main>','<main><p class="notice">MÔ PHỎNG Performance Lab · cả3provider đều là fixture, không gọi tài khoản thật. Token: fixture-admin.</p>'):payload;});
app.addHook('onClose',async()=>{await backend.app.close();await rm(directory,{recursive:true,force:true});});
await app.listen({host:'127.0.0.1',port:15602});console.log('Performance Lab fixture: http://127.0.0.1:15602/dashboard');
await app.inject({method:'POST',url:'/api/lab/batches',headers:{authorization:'Bearer fixture-admin','Content-Type':'application/json','X-Codex-Lab':'1'},payload:{targets:[{provider:'ollama',model:'fixture-local'},{provider:'lmstudio',model:'fixture-local'}],scenarios:['short-answer'],iterations:3,warmup:1,concurrency:2,max_duration_ms:10000}});
process.once('SIGINT',()=>void app.close());process.once('SIGTERM',()=>void app.close());
