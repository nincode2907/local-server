/** Framework-independent event transport/reducer. No credentials, storage or DOM globals. */
const active = status => status === 'queued' || status === 'running';
const workflowTerminal = status => ['completed','failed','cancelled'].includes(status);
export const initialActivityState = () => ({run:null,output:'',outputSeq:0,lastSeq:0,replayUnavailable:false,partial:false});
function mergeWorkflow(old, value) {
  if (!value || (old?.version ?? -1) > value.version) return old;
  return {...old,...value,stages:(value.stages ?? old?.stages ?? []).map(s=>({...old?.stages?.find(p=>p.id===s.id),...s}))};
}
export function reduceActivity(state, packet) {
  const {data,type='activity'}=packet;
  if(type==='snapshot') {
    if(state.run && state.run.run_id!==data.run_id)return state;
    return {...state,run:{...data,workflow:mergeWorkflow(state.run?.workflow,data.workflow)},
      replayUnavailable:state.replayUnavailable||data.replay?.available===false,partial:state.partial||data.replay?.available===false};
  }
  if(!data || data.version!==1 || !Number.isSafeInteger(data.seq) || !state.run || data.run_id!==state.run.run_id || data.seq<=state.lastSeq)return state;
  let next={...state,lastSeq:data.seq},run=state.run;
  const fresh=data.seq>=(run.seq??0);
  if(data.payload.metadata&&fresh) run={...data.payload.metadata,workflow:mergeWorkflow(run.workflow,data.payload.metadata.workflow)};
  if((data.type==='output.delta'||data.type==='output.replaced')&&data.seq>state.outputSeq) {
    next.output=data.type==='output.delta'?state.output+String(data.payload.delta??''):String(data.payload.text??'');
    next.outputSeq=data.seq;
    if(fresh)run={...run,metrics:data.payload.metrics??run.metrics,timeline:data.payload.timeline??run.timeline};
  }
  if(data.type==='usage.updated'&&fresh) {
    const usage=data.payload.usage;
    run={...run,metrics:{...run.metrics,output_tokens:{value:usage.output_tokens,unit:'tokens',source:'provider_reported',reason:null}}};
  }
  if(data.payload.sample&&fresh) {
    const samples=[...(run.history?.samples??[])];
    if(!samples.some(s=>s.seq===data.payload.sample.seq))samples.push(data.payload.sample);
    if(samples.length>256)samples.splice(1,samples.length-256);
    run={...run,history:{available:true,samples,sample_count:Math.max(run.history?.sample_count??0,data.payload.sample.index),truncated:(run.history?.truncated??false)||data.payload.sample.index>256}};
  }
  if(data.payload.workflow)run={...run,workflow:mergeWorkflow(run.workflow,data.payload.workflow)};
  if(data.type==='run.failed'||data.type==='run.cancelled')next.partial=next.partial||Boolean(data.payload.partial);
  next.run={...run,seq:Math.max(run.seq??0,data.seq)};return next;
}

export async function readEventStream(response,onPacket,signal) {
  if(!response.body)throw new Error('Response has no event stream.');
  const reader=response.body.getReader(),decoder=new TextDecoder();let buffer='';
  try {
    while(!signal?.aborted) {
      const {done,value}=await reader.read();if(done)return;
      buffer+=decoder.decode(value,{stream:true});
      if(buffer.length>3_000_000)throw new Error('Event frame exceeds receive limit.');
      let boundary;
      while((boundary=/\r?\n\r?\n/.exec(buffer))) {
        const block=buffer.slice(0,boundary.index);buffer=buffer.slice(boundary.index+boundary[0].length);
        let id,type='activity';const parts=[];
        for(const line of block.split(/\r?\n/)) {
          if(!line||line[0]===':')continue;
          const colon=line.indexOf(':'),key=colon<0?line:line.slice(0,colon),value=colon<0?'':line.slice(colon+1).replace(/^ /,'');
          if(key==='data')parts.push(value);if(key==='event')type=value;if(key==='id'&&!value.includes('\0'))id=value;
        }
        if(parts.length){const raw=parts.join('\n');onPacket({data:raw==='[DONE]'?'[DONE]':JSON.parse(raw),id,type});}
      }
    }
  } finally {await reader.cancel().catch(()=>{});reader.releaseLock();}
}

const wait = (ms,signal) => new Promise(resolve=>{
  if(signal?.aborted){resolve();return;}
  const done=()=>{clearTimeout(timer);signal?.removeEventListener('abort',done);resolve();};
  const timer=setTimeout(done,ms);signal?.addEventListener('abort',done,{once:true});
});
export function createActivityClient({baseUrl='',runPath='/v1/runs',feedPath='/api/runs/events',fetch:fetchImpl=globalThis.fetch,headers=()=>({})}={}) {
  const url=path=>`${baseUrl.replace(/\/$/,'')}${path}`;
  const idPath=id=>{if(!/^[a-f0-9-]{36}$/.test(id))throw new Error('Invalid run ID.');return `${runPath}/${id}`;};
  const request=async(path,options={})=>{
    const response=await fetchImpl(url(path),{...options,headers:{...await headers(),...options.headers},cache:'no-store'});
    if(!response.ok){const body=await response.json().catch(()=>({}));const error=new Error(body.error?.message??`HTTP ${response.status}`);error.status=response.status;error.code=body.error?.code;throw error;}
    return response;
  };
  const client={
    async getRun(id,signal){return (await request(idPath(id),{signal})).json();},
    async cancel(id,signal){return (await request(`${idPath(id)}/cancel`,{method:'POST',signal,headers:{'Content-Type':'application/json','X-Codex-Run':'1'},body:'{}'})).json();},
    async readEvents(path,{signal,cursor,onPacket}) {
      const response=await request(path,{signal,headers:cursor?{'Last-Event-ID':cursor}:{}});await readEventStream(response,onPacket,signal);
    },
    async watchRun(id,{signal,onState,onConnection=()=>{},followWorkflow=true}={}) {
      let state=initialActivityState(),cursor='',retry=0;
      const report=()=>onState?.(state);
      const settled=()=>state.run&&!active(state.run.status)&&(!followWorkflow||state.run.ephemeral||workflowTerminal(state.run.workflow?.status));
      try {state=reduceActivity(state,{type:'snapshot',data:await client.getRun(id,signal)});report();}
      catch(error){if(signal?.aborted)return;onConnection(error.status===401||error.status===403?'unauthorized':'error',error);return;}
      while(!signal?.aborted) {
        onConnection(retry?'reconnecting':'connecting');
        try {
          const response=await request(`${idPath(id)}/events${followWorkflow?'?follow_workflow=1':''}`,{signal,headers:cursor?{'Last-Event-ID':cursor}:{}});
          onConnection('connected');retry=0;
          await readEventStream(response,packet=>{state=reduceActivity(state,packet);if(packet.id)cursor=packet.id;report();},signal);
          if(settled()){onConnection('ended');return;}
        } catch(error) {
          if(signal?.aborted)return;
          if(error.status===409&&error.code==='cursor_reset') {
            const snapshot=await client.getRun(id,signal).catch(()=>null);if(!snapshot)return;
            state={...initialActivityState(),run:snapshot,replayUnavailable:true,partial:true};cursor='';report();onConnection('replay_reset',error);
            if(!followWorkflow&&!active(snapshot.status))return;
            if(!followWorkflow)cursor=`${id}:${snapshot.seq}`;
          } else if(error.status) {onConnection(error.status===401||error.status===403?'unauthorized':'error',error);return;}
          else onConnection('reconnecting',error);
        }
        await wait(Math.min(5000,500*2**Math.min(retry++,4)),signal);
      }
    },
    async watchFeed({signal,onPacket,onConnection=()=>{}}={}) {
      let cursor='',retry=0;
      while(!signal?.aborted) {
        try {
          onConnection(retry?'reconnecting':'connecting');
          const response=await request(feedPath,{signal,headers:cursor?{'Last-Event-ID':cursor}:{}});onConnection('connected');retry=0;
          await readEventStream(response,packet=>{if(packet.id)cursor=packet.id;onPacket(packet);},signal);
        }catch(error){if(signal?.aborted)return;if(error.status===409){cursor='';onConnection('replay_reset',error);}else if(error.status){onConnection(error.status===401||error.status===403?'unauthorized':'error',error);return;}else onConnection('reconnecting',error);}
        await wait(Math.min(5000,500*2**Math.min(retry++,4)),signal);
      }
    },
  };
  return client;
}

/** Step chart; missing retained samples start a new segment instead of interpolating. */
export function outputChart(history,unit='bytes',width=760,height=220,extentMs=0) {
  const all=history?.samples??[],samples=unit==='tokens'?all.filter(s=>s.kind==='usage'&&s.tokens!==null):all;
  const key=unit==='characters'?'characters':unit==='tokens'?'tokens':'bytes';
  const points=samples.filter(s=>typeof s[key]==='number'&&Number.isFinite(s[key])&&Number.isFinite(s.elapsed_ms));
  const maxX=Math.max(1,Number.isFinite(extentMs)?extentMs:0,...points.map(s=>s.elapsed_ms)),maxY=Math.max(1,...points.map(s=>s[key]));
  const x=t=>36+t/maxX*(width-52),y=v=>height-28-v/maxY*(height-44);let paths=[],path='',last;
  for(const p of points) {
    const px=x(p.elapsed_ms),py=y(p[key]);
    const gap=unit!=='tokens'&&last&&p.index>last.index+1;
    if(!last||gap){if(path)paths.push(path);path=`M${px.toFixed(2)},${py.toFixed(2)}`;}
    else path+=` H${px.toFixed(2)} V${py.toFixed(2)}`;
    last=p;
  }
  if(path)paths.push(path);
  return {paths,points:points.map(p=>({x:x(p.elapsed_ms),y:y(p[key]),elapsed_ms:p.elapsed_ms,value:p[key],index:p.index})),maxX,maxY,truncated:Boolean(history?.truncated),width,height};
}
