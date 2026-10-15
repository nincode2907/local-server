import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import { buildServer } from '../src/server.js';
import { readConfig } from '../src/config.js';
import type { Provider, ObservedTurnOptions } from '../src/provider.js';

// Isolated synthetic fixture. Does not load .env, start Codex or read native history.
const directory = await mkdtemp(join(tmpdir(),'codex-activity-preview-'));
const config = readConfig({PORT:process.env.ACTIVITY_PREVIEW_PORT ?? '15602',HOST:process.env.ACTIVITY_PREVIEW_HOST ?? '127.0.0.1',
  MAX_CONCURRENT:'1',MAX_QUEUE:'4',QUEUE_TIMEOUT_MS:'30000',DATA_DIR:directory,NATIVE_CODEX_HOME:join(directory,'no-native'),TRUSTED_HOSTS:'host.docker.internal',
  LOCAL_API_KEY:'fixture-admin',APP_API_KEYS:JSON.stringify([{id:'demo',key:'fixture-application-key-123456789'}])});
const make = () => ({id:'preview-thread',run:async(input:string,options:ObservedTurnOptions = {}) => {
  await options.observe?.({fixture:true});
  const content = 'MÔ PHỎNG — Request đang được xử lý. Output cập nhật từ event của provider fixture; không gọi tài khoản Codex thật.';
  if(input.includes('PREVIEW_BATCH')) await delay(800,undefined,{signal:options.signal});
  for (let i=8;!input.includes('PREVIEW_BATCH') && i<content.length;i+=8) {
    await delay(input.includes('PREVIEW_SLOW') ? 900 : 180,undefined,{signal:options.signal});
    options.onEvent?.({type:'output',item_id:'preview',text:JSON.stringify({content:content.slice(0,i),tool_calls:[]})});
  }
  return {finalResponse:input.includes('DEMO_FAILURE') ? 'invalid fixture output' : JSON.stringify({content,tool_calls:[]}),usage:null,items:[]};
}});
const provider:Provider={start:make,resume:make,close:async()=>{}};
const app = await buildServer(config,provider);
app.addHook('onClose',async()=>rm(directory,{recursive:true,force:true}));
app.addHook('onSend',async(req,reply,payload)=>{
  reply.header('X-Codex-Preview','activity');
  return req.url.startsWith('/dashboard') && typeof payload === 'string'
    ? payload.replace('<main>','<main><p class="notice">MÔ PHỎNG · dữ liệu riêng, không gọi Codex thật. Token demo: fixture-admin. Metric token chưa có dữ liệu.</p>') : payload;
});
await app.listen({host:config.host,port:config.port});
console.log(`Activity preview fixture: http://127.0.0.1:${config.port}/dashboard`);
await app.inject({method:'POST',url:'/v1/runs',headers:{authorization:'Bearer fixture-admin'},payload:{messages:[{role:'user',content:'synthetic preview'}]}});
const shutdown = () => { void app.close(); }; process.once('SIGINT',shutdown);process.once('SIGTERM',shutdown);
