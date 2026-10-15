import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {initialActivityState,reduceActivity,readEventStream,createActivityClient,outputChart,type RunSnapshot} from '../clients/activity-client/index.js';
import {Scheduler} from '../src/scheduler.js';

const id=randomUUID();
const snapshot=()=>({run_id:id,call_id:id,seq:8,status:'completed',model:'fixture',provider:'codex',created_at:0,ephemeral:false,error_code:null,metrics:{},timeline:{},capabilities:{},workflow:{status:'completed',version:2,source:'client_reported',stages:[]},history:{available:true,samples:[],sample_count:0,truncated:false}} as RunSnapshot);
const packet=(seq:number,type:string,payload:unknown)=>({id:`${id}:${seq}`,data:{version:1,run_id:id,seq,type,payload}});
test('shared reducer replays output older than snapshot once and handles replacements and workflow labels',()=>{
  let state=reduceActivity(initialActivityState(),{type:'snapshot',data:snapshot()});
  const first=packet(3,'output.delta',{delta:'Xin'});state=reduceActivity(state,first);state=reduceActivity(state,first);
  state=reduceActivity(state,packet(4,'output.delta',{delta:' chào'}));assert.equal(state.output,'Xin chào');assert.equal(state.run!.seq,8);
  state=reduceActivity(state,packet(5,'output.replaced',{text:'Thay'}));assert.equal(state.output,'Thay');
  state=reduceActivity(state,packet(9,'stage.started',{workflow:{status:'running',version:3,stages:[{id:'parse',label:'Label',status:'running'}]}}));
  state=reduceActivity(state,{type:'snapshot',data:{...snapshot(),seq:10,workflow:{status:'running',version:3,stages:[{id:'parse',status:'running'}]}}});
  assert.equal(state.run!.workflow!.stages![0]!.label,'Label');
  assert.equal(reduceActivity(state,packet(8,'workflow.started',{workflow:{status:'running',version:1}})),state);
});
test('SSE decoder supports split UTF-8, CRLF, multiline JSON, comments and cursor',async()=>{
  const bytes=new TextEncoder().encode(': heartbeat\r\n\r\nid: one:2\r\nevent: snapshot\r\ndata: {"text":\r\ndata: "Tiếng Việt"}\r\n\r\n');
  const seen:unknown[]=[];
  await readEventStream(new Response(new ReadableStream({start(c){for(const byte of bytes)c.enqueue(new Uint8Array([byte]));c.close();}})),p=>seen.push(p));
  assert.deepEqual(seen,[{id:'one:2',type:'snapshot',data:{text:'Tiếng Việt'}}]);
});
test('shared chart uses observed samples, splits retained gaps and never generates token estimates',()=>{
  const history={available:true,truncated:true,sample_count:400,samples:[1,399,400].map((index,i)=>({index,seq:index,elapsed_ms:index,bytes:index,characters:index,tokens:i===2?12:null,kind:i===2?'usage':'output'}))} as RunSnapshot['history'];
  assert.equal(outputChart(history).paths.length,2);assert.equal(outputChart(history,'tokens').points.length,1);assert.equal(outputChart(history,'tokens').points[0]!.value,12);
  assert.equal(outputChart(undefined).points.length,0);
});
test('shared transport resumes with Last-Event-ID, deduplicates replay, resets stale cursors and aborts',async()=>{
  let calls=0;const headers:Headers[]=[];const controller=new AbortController();let final='';
  const encode=(value:unknown,event='snapshot',cursor='')=>`${cursor?'id: '+cursor+'\n':''}event: ${event}\ndata: ${JSON.stringify(value)}\n\n`;
  const client=createActivityClient({headers:()=>({Authorization:'Bearer fixture'}),fetch:async(input,init)=>{
    headers.push(new Headers(init?.headers));
    if(!String(input).includes('/events'))return Response.json({...snapshot(),status:'running'});
    calls++;
    if(calls===1)return new Response(encode({...snapshot(),status:'running'})+encode(packet(3,'output.delta',{delta:'partial'}).data,'activity',`${id}:3`));
    if(calls===2)return Response.json({error:{code:'cursor_reset'}},{status:409});
    return new Response(encode({...snapshot(),replay:{available:false}}));
  }});
  await client.watchRun(id,{signal:controller.signal,onState:s=>{final=s.output;if(s.replayUnavailable)controller.abort();}});
  assert.equal(calls,2);assert.equal(final,'');assert.equal(headers.find(h=>h.has('last-event-id'))!.get('last-event-id'),`${id}:3`);
  assert.ok(headers.every(h=>h.get('authorization')==='Bearer fixture'));
});
test('scheduler drains FIFO once and rejects remaining queued tickets on shutdown',async()=>{
  const scheduler=new Scheduler(1,2,1000),signal=new AbortController().signal,release=await scheduler.acquire(signal),order:number[]=[];
  const second=scheduler.acquire(signal).then(done=>{order.push(2);return done;});
  const third=scheduler.acquire(signal).then(done=>{order.push(3);return done;});
  release();release();const release2=await second;assert.deepEqual(order,[2]);release2();(await third)();assert.deepEqual(order,[2,3]);assert.equal(scheduler.active,0);
  const hold=await scheduler.acquire(signal),queued=scheduler.acquire(signal);scheduler.close();await assert.rejects(queued,/shutting down/);hold();assert.equal(scheduler.active,0);assert.throws(()=>scheduler.assertAvailable(),/shutting down/);
});
