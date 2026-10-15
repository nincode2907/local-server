import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildServer } from '../src/server.js';
import { readConfig } from '../src/config.js';
import { gatewayInstructions, type Provider } from '../src/provider.js';

// Deliberately isolated fixtures: no account calls, real sessions, native DB or .env.
const directory = await mkdtemp(join(tmpdir(), 'codex-inspector-preview-'));
const config = readConfig({PORT:process.env.INSPECTOR_PREVIEW_PORT ?? '15601', DATA_DIR:directory,
  NATIVE_CODEX_HOME:join(directory,'no-native'), INSPECTOR_ENABLED:'true'});
const thread = () => ({id:'preview-thread',run:async (input:string, options:any) => {
  await options.observe?.({stdin:input,instructions:gatewayInstructions,output_schema:options.outputSchema,
    preview_mock:true,transport:'Mock provider — no CLI spawn, no account usage',internal_context:{provenance:'Internal / unavailable',available:false}});
  const finalResponse = input.includes('DEMO_INVALID_OUTPUT') ? 'Demo invalid structured response' : JSON.stringify({content:'PREVIEW MOCK — Đây là câu trả lời fixture, không gọi Codex thật.',tool_calls:[]});
  return {finalResponse,items:[{type:'agent_message',id:'demo',text:finalResponse}],usage:null};
}});
const provider={start:thread,resume:thread,close:async()=>{}} as Provider;
let app: Awaited<ReturnType<typeof buildServer>> | undefined;
try {
  app=await buildServer(config,provider);
  app.addHook('onClose',async()=>rm(directory,{recursive:true,force:true}));
  app.addHook('onSend',async(req,_reply,payload)=> req.url==='/dashboard' && typeof payload==='string'
    ? payload.replace('<main>','<main><p class="notice">PREVIEW MOCK · dữ liệu demo riêng, không gọi tài khoản Codex. Usage/token để unknown. Đóng terminal để dừng.</p>') : payload);
  const messages=[{role:'system',content:'PREVIEW MOCK — chỉ dùng dữ liệu tổng hợp.'},{role:'developer',content:'Giữ nguyên thứ tự messages và khoảng trắng.'},
    {role:'assistant',content:null,tool_calls:[{id:'demo-call',type:'function',function:{name:'demo_lookup',arguments:'{"city":"Hanoi"}'}}]},
    {role:'tool',tool_call_id:'demo-call',content:'{"city":"Hanoi","temperature":29,"api_key":"demo-private-value"}'},
    {role:'user',content:'Inspect this long prompt.\n'+Array.from({length:100},(_,i)=>`Line ${i+1}: search marker ${i===60?'needle-inspector':'context'} · giữ whitespace  `).join('\n')}];
  await app.inject({method:'POST',url:'/v1/chat/completions',payload:{messages}});
  await app.inject({method:'POST',url:'/chat',payload:{prompt:'PREVIEW MOCK — /chat alias'}});
  const session=(await app.inject({method:'POST',url:'/v1/sessions',payload:{messages:[{role:'system',content:'PREVIEW MOCK — initial stateful context'}]}})).json().session_id;
  await app.inject({method:'POST',url:`/v1/sessions/${session}/messages`,payload:{message:'Initial session turn'}});
  await app.inject({method:'POST',url:`/v1/sessions/${session}/messages`,payload:{message:'Resumed session turn'}});
  await app.inject({method:'POST',url:'/chat',payload:{prompt:'DEMO_INVALID_OUTPUT'}});
  await app.listen({host:'127.0.0.1',port:config.port});
  console.log(`Inspector mock preview: http://127.0.0.1:${config.port}/dashboard`);
  const shutdown=()=>{void app?.close();};process.once('SIGINT',shutdown);process.once('SIGTERM',shutdown);
} catch(error) {await app?.close();await rm(directory,{recursive:true,force:true});throw error;}
