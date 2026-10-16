import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildServer } from '../src/server.js';
import { readConfig } from '../src/config.js';
import { createProvider } from '../src/provider.js';
import { outputSchema, promptFor } from '../src/protocol.js';
import { publicContent } from '../src/stream-content.js';
import type { CliLifecycleTiming, ProviderUsage } from '../src/provider-types.js';

const count = Number(process.argv.find(value => value.startsWith('--runs='))?.split('=')[1] ?? 5);
if (!Number.isInteger(count) || count < 3 || count > 10) throw new Error('--runs must be an integer from 3 to 10.');
const model = process.argv.find(value => value.startsWith('--model='))?.split('=')[1] ?? 'gpt-6-luna';
const effort = process.argv.find(value => value.startsWith('--effort='))?.split('=')[1] ?? 'low';
if (!/^[a-zA-Z0-9._:-]{1,128}$/.test(model) || !['minimal','low','medium','high','xhigh','max','ultra','persistent'].includes(effort))
  throw new Error('Invalid model or reasoning effort.');

const directory = await mkdtemp(join(tmpdir(), 'codex-latency-benchmark-'));
const config = {...readConfig({...process.env,DATA_DIR:directory,STATS_DB_PATH:join(directory,'stats.sqlite'),NATIVE_CODEX_HOME:join(directory,'native-codex')}),host:'127.0.0.1',port:0};
const provider = await createProvider(config);
const app = await buildServer(config,provider);
app.log.level='silent';
const auth = config.apiKey ? {authorization:`Bearer ${config.apiKey}`} : {};
let baseUrl = '';
const request = (message:string) => ({model,reasoning_effort:effort,messages:[{role:'user' as const,content:message}],stream:true as const,stream_options:{include_usage:true as const}});
const basePrompt='Trả lời đúng một từ: OK';

function median(values:number[]) {
  if (!values.length) return null;
  const ordered=[...values].sort((a,b)=>a-b);
  return ordered[(ordered.length-1)>>1]!;
}
function percentile(values:number[],p:number) {
  if (!values.length) return null;
  const ordered=[...values].sort((a,b)=>a-b);
  return ordered[Math.max(0,Math.ceil(p*ordered.length)-1)]!;
}
function stats(values:number[]) {return {sample_count:values.length,p50:median(values),p95_nearest_rank:percentile(values,.95)};}

async function direct(iteration:number) {
  const body=request(basePrompt), start=performance.now(), chunks:number[]=[];
  let firstText:number|null=null, output='', lifecycle:CliLifecycleTiming|undefined, usage:ProviderUsage|null=null;
  const thread=provider.start(model,effort);
  const turn=await thread.run(promptFor(body.messages,body),{outputSchema,request:body,
    observe:async()=>{},observeResponse:async()=>{},onLifecycle:timing=>{lifecycle=timing;},
    onEvent:event=>{
      if(event.type==='usage'){usage=event.usage;return;}
      if(event.type!=='output')return;
      const next=publicContent(event.text);if(next===null||next===output)return;
      const delta=next.startsWith(output)?next.slice(output.length):next;output=next;
      if(delta){firstText??=performance.now()-start;chunks.push(Buffer.byteLength(delta));}
    }});
  return {kind:'direct',iteration,total_ms:performance.now()-start,ttfo_ms:firstText,delta_count:chunks.length,delta_bytes:chunks,usage:turn.usage??usage,cli_lifecycle:turn.cliLifecycle??lifecycle??null};
}

async function minimalDirect() {
  const start=performance.now();let lifecycle:CliLifecycleTiming|undefined;
  const turn=await provider.start(model,effort).run(basePrompt,{onLifecycle:timing=>{lifecycle=timing;}});
  const usage=turn.usage;
  return {kind:'minimal_direct_cli',total_ms:performance.now()-start,usage:usage?{input_tokens:usage.input_tokens,output_tokens:usage.output_tokens,cached_input_tokens:usage.cached_input_tokens}:null,cli_lifecycle:turn.cliLifecycle??lifecycle??null};
}

async function gateway(iteration:number,message=basePrompt,kind='gateway') {
  const body=request(message),start=performance.now();
  const response=await fetch(`${baseUrl}/v1/chat/completions`,{method:'POST',headers:{...auth,'content-type':'application/json'},body:JSON.stringify(body)});
  const headersMs=performance.now()-start,callId=response.headers.get('x-codex-run-id');
  if(!response.ok||!response.body)throw new Error(`Gateway returned HTTP ${response.status}.`);
  const reader=response.body.getReader(),decoder=new TextDecoder();let buffer='',firstByte:number|null=null,firstText:number|null=null;
  const deltaBytes:number[]=[];let usage:ProviderUsage|null=null,errorCode:string|null=null;
  const consume=(line:string)=>{
    if(!line.startsWith('data: '))return;
    const data=line.slice(6).trim();if(!data||data==='[DONE]')return;
    const chunk=JSON.parse(data) as {choices?:{delta?:{content?:string};finish_reason?:string|null}[];usage?:{prompt_tokens:number;completion_tokens:number;total_tokens:number;prompt_tokens_details?:{cached_tokens?:number|null}};error?:{code?:string}};
    if(chunk.error){errorCode=chunk.error.code??'stream_error';return;}
    const text=chunk.choices?.[0]?.delta?.content;if(text){firstText??=performance.now()-start;deltaBytes.push(Buffer.byteLength(text));}
    if(chunk.usage)usage={input_tokens:chunk.usage.prompt_tokens,output_tokens:chunk.usage.completion_tokens,cached_input_tokens:chunk.usage.prompt_tokens_details?.cached_tokens??null};
  };
  try {
    while(true){const part=await reader.read();const now=performance.now();if(part.done)break;firstByte??=now-start;buffer+=decoder.decode(part.value,{stream:true});let pos;while((pos=buffer.indexOf('\n'))>=0){consume(buffer.slice(0,pos).replace(/\r$/,''));buffer=buffer.slice(pos+1);}}
    buffer+=decoder.decode();if(buffer)consume(buffer.replace(/\r$/,''));
  }finally{reader.releaseLock();}
  const total=performance.now()-start;
  if(!callId)throw new Error('Gateway did not return X-Codex-Run-Id.');
  const snapshotResponse=await fetch(`${baseUrl}/v1/runs/${callId}`,{headers:auth});
  const snapshot=await snapshotResponse.json() as {status:string;metrics?:{cli_lifecycle?:CliLifecycleTiming|null;ttfo?:{value:number|null};output_updates?:{value:number|null};output_bytes?:{value:number|null}}};
  if(errorCode||snapshot.status!=='completed')throw new Error(`Gateway run ended with ${errorCode??snapshot.status}.`);
  return {kind,iteration,total_ms:total,headers_ms:headersMs,first_byte_ms:firstByte,ttfo_ms:firstText,
    delta_count:deltaBytes.length,delta_bytes:deltaBytes,usage,server_ttfo_ms:snapshot.metrics?.ttfo?.value??null,
    server_delta_count:snapshot.metrics?.output_updates?.value??null,server_output_bytes:snapshot.metrics?.output_bytes?.value??null,
    cli_lifecycle:snapshot.metrics?.cli_lifecycle??null};
}

try {
  if(process.argv.includes('--minimal-direct-only')) {
    console.log(JSON.stringify({schema_version:1,model,reasoning_effort:effort,comparison:'same CLI security flags, model instructions, model, effort and user text; omits gateway prompt envelope and output schema',sample:await minimalDirect()},null,2));
  } else {
  await app.listen({host:'127.0.0.1',port:0});
  const address=app.server.address();if(!address||typeof address==='string')throw new Error('Could not read ephemeral server address.');
  baseUrl=`http://127.0.0.1:${address.port}`;
  const samples:{kind:string;iteration:number;total_ms:number;ttfo_ms:number|null;delta_count:number;delta_bytes:number[];usage:ProviderUsage|null;cli_lifecycle:CliLifecycleTiming|null}[]=[];
  for(let iteration=1;iteration<=count;iteration++){
    const pair=iteration%2===1?[()=>direct(iteration),()=>gateway(iteration)]:[()=>gateway(iteration),()=>direct(iteration)];
    for(const run of pair)samples.push(await run());
  }
  const longMessage='Write a detailed Vietnamese technical explanation of how a local chat gateway processes a request. Cover request validation, authentication, queue admission, prompt construction, launching the isolated Codex CLI, structured output validation, streaming delivery, usage accounting, session persistence, cancellation and cleanup. Use 8 clearly labeled sections and approximately 500 words. Do not use tools or claim access to internal reasoning.';
  const longRun=await gateway(1,longMessage,'gateway_long_stream');
  const summarize=(kind:string)=>{
    const group=samples.filter(sample=>sample.kind===kind);
    const metric=(field:'total_ms'|'ttfo_ms')=>stats(group.map(sample=>sample[field]).filter((value):value is number=>typeof value==='number'));
    const token=(field:'input_tokens'|'output_tokens'|'cached_input_tokens')=>stats(group.map(sample=>sample.usage?.[field]??NaN).filter(Number.isFinite));
    const deltas=stats(group.map(sample=>sample.delta_count));
    return {runs:group.length,total_ms:metric('total_ms'),ttfo_ms:metric('ttfo_ms'),delta_count:deltas,input_tokens:token('input_tokens'),output_tokens:token('output_tokens'),cached_input_tokens:token('cached_input_tokens')};
  };
  console.log(JSON.stringify({schema_version:1,model,reasoning_effort:effort,cache_state:'uncontrolled',run_order:'paired; direct-first on odd pairs, gateway-first on even pairs',samples:samples.map(sample=>({...sample,usage:sample.usage?{input_tokens:sample.usage.input_tokens,output_tokens:sample.usage.output_tokens,cached_input_tokens:sample.usage.cached_input_tokens}:null})),summary:{direct:summarize('direct'),gateway:summarize('gateway')},long_stream:longRun},null,2));
  }
} finally {
  await app.close().catch(()=>{});
  await provider.close().catch(()=>{});
  await rm(directory,{recursive:true,force:true});
}
