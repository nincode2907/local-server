import Fastify from 'fastify';
import {readFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';

// Standalone React browser fixture. The upstream MUST prove it is the synthetic
// activity preview before any POST. Never forward requests to the real account.
const upstream='http://127.0.0.1:15602',key='fixture-application-key-123456789';
const health=await fetch(`${upstream}/health`,{headers:{authorization:`Bearer ${key}`}});
if(!health.ok||health.headers.get('x-codex-preview')!=='activity')throw Error('Start preview:activity on 15602 first; synthetic marker missing.');
const app=Fastify(),owned=new Set<string>();
const files:Record<string,[string,string]>={
  '/react.js':['../clients/react-activity-panel/node_modules/react/umd/react.development.js','text/javascript'],
  '/react-dom.js':['../clients/react-activity-panel/node_modules/react-dom/umd/react-dom.development.js','text/javascript'],
  '/client.js':['../clients/activity-client/index.js','text/javascript'],
  '/panel.css':['../clients/react-activity-panel/styles.css','text/css'],
};
app.addHook('onRequest',async(req,reply)=>{
  if(!['127.0.0.1:15603','localhost:15603'].includes(req.headers.host??''))return reply.code(403).send();
  if(req.headers.origin&&req.headers.origin!==`http://${req.headers.host}`)return reply.code(403).send();
  if(req.method==='POST'&&(req.headers.origin!==`http://${req.headers.host}`||req.headers['content-type']!=='application/json'))return reply.code(403).send();
});
app.get('/react-shim.js',async(_req,reply)=>reply.type('text/javascript').send('export default window.React; export const {useState,useEffect,useRef,useId}=window.React;'));
app.get('/panel.js',async(_req,reply)=>{
  const source=await readFile(new URL('../clients/react-activity-panel/dist/index.js',import.meta.url),'utf8');
  return reply.type('text/javascript').send(source.replaceAll("from 'react'","from '/react-shim.js'").replaceAll("from '@codex-local/activity-client'","from '/client.js'"));
});
for(const[path,[file,type]]of Object.entries(files))app.get(path,async(_req,reply)=>reply.type(type).send(await readFile(fileURLToPath(new URL(file,import.meta.url)))));
app.post('/fixture',async(_req,reply)=>{
  const response=await fetch(`${upstream}/v1/runs`,{method:'POST',headers:{authorization:`Bearer ${key}`,'Content-Type':'application/json'},body:JSON.stringify({messages:[{role:'user',content:'Synthetic React fixture'}]})});
  const data=await response.json();if(response.ok)owned.add(data.run_id);return reply.code(response.status).send(data);
});
app.route({method:['GET','POST'],url:'/api/ai/runs/:id/:action?',handler:async(req,reply)=>{
  const {id,action=''}=req.params as {id:string;action?:string};
  if(!owned.has(id)||!(req.method==='GET'&&['','events'].includes(action)||req.method==='POST'&&action==='cancel'))return reply.code(404).send();
  const target=new URL(`/v1/runs/${id}${action?'/'+action:''}`,upstream);
  if(action==='events')target.searchParams.set('follow_workflow','1');
  const headers:Record<string,string>={authorization:`Bearer ${key}`,'Content-Type':'application/json'};
  if(req.headers['last-event-id'])headers['Last-Event-ID']=String(req.headers['last-event-id']);
  const controller=new AbortController();reply.raw.on('close',()=>controller.abort());
  const response=await fetch(target,{method:req.method,headers,body:req.method==='POST'?'{}':undefined,signal:controller.signal});
  reply.raw.writeHead(response.status,{'Content-Type':response.headers.get('content-type')??'application/json','Cache-Control':'no-store'});reply.hijack();
  try {for await(const chunk of response.body??[])if(!reply.raw.destroyed)reply.raw.write(chunk);}
  catch(error){if(!controller.signal.aborted)throw error;}finally{reply.raw.end();}
}});
app.get('/',async(_req,reply)=>reply.type('text/html').send(`<!doctype html><html lang="vi"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>React Activity · Fixture</title><link rel="icon" href="data:,"><link rel="stylesheet" href="/panel.css"><style>body{font:15px system-ui;margin:24px auto;padding:0 16px;max-width:1040px;background:#eff3f8}button{padding:10px;margin:5px}#status{overflow-wrap:anywhere}</style><h1>React AIActivityPanel · Mô phỏng</h1><p>Cùng run/event stream với dashboard 15602. Không gọi Codex thật.</p><button id="create">Tạo request fixture</button><button id="toggle">Ẩn / hiện panel</button><p id="status" role="status"></p><div id="root"></div><script src="/react.js"></script><script src="/react-dom.js"></script><script type="module" src="/demo.js"></script></html>`));
app.get('/demo.js',async(_req,reply)=>reply.type('text/javascript').send(`import {AIActivityPanel} from '/panel.js';import {createActivityClient} from '/client.js';const transport=createActivityClient({baseUrl:'/api/ai',runPath:'/runs'}),root=ReactDOM.createRoot(document.getElementById('root'));let id='',visible=true;const render=()=>root.render(visible&&id?React.createElement(AIActivityPanel,{runId:id,transport}):null);document.getElementById('create').onclick=async()=>{const r=await fetch('/fixture',{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'}),data=await r.json();id=data.run_id;visible=true;document.getElementById('status').textContent=id;render();};document.getElementById('toggle').onclick=()=>{visible=!visible;render();};`));
await app.listen({host:'127.0.0.1',port:15603});
console.log('React fixture: http://127.0.0.1:15603 (temporary local demo only)');
process.once('SIGINT',()=>void app.close());process.once('SIGTERM',()=>void app.close());
