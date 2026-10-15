import {ApiError} from './errors.js';
import type {Config} from './config.js';
import type {Provider,ObservedTurnOptions,ProviderTurn} from './provider.js';
import type {ProviderId,ProviderUsage,ProviderTiming} from './provider-types.js';
import {readEventStream} from '../clients/activity-client/index.js';

const count=(v:unknown):v is number=>typeof v==='number'&&Number.isSafeInteger(v)&&v>=0;
const positive=(v:unknown):v is number=>typeof v==='number'&&Number.isFinite(v)&&v>=0;
const fail=(code='local_provider_protocol'):never=>{throw new ApiError(502,code,'Local provider returned an invalid or incomplete response.');};
export class LocalProvider implements Provider {
  constructor(readonly id:Exclude<ProviderId,'codex'>,private settings:{url:string;key?:string;api?:'openai'|'v0'},private timeout:number) {}
  private path(operation:'models'|'chat'|'resources') {
    if(this.id==='ollama')return {models:'/api/tags',chat:'/api/chat',resources:'/api/ps'}[operation];
    return `${this.settings.api==='v0'?'/api/v0':'/v1'}/${operation==='chat'?'chat/completions':'models'}`;
  }
  async request(operation:'models'|'chat'|'resources',signal?:AbortSignal,payload?:unknown) {
    const controller=AbortSignal.any([...(signal?[signal]:[]),AbortSignal.timeout(this.timeout)]);
    try {
      const response=await fetch(this.settings.url+this.path(operation),{method:payload?'POST':'GET',headers:{'Content-Type':'application/json',...(this.settings.key?{Authorization:`Bearer ${this.settings.key}`}:{})},body:payload?JSON.stringify(payload):undefined,signal:controller,redirect:'error'});
      if(!response.ok){await response.body?.cancel();throw new ApiError(response.status===429?429:502,response.status===429?'local_provider_rate_limit':'local_provider_http','Local provider rejected the request. Check endpoint, auth and loaded model.');}
      return response;
    }catch(error){if(error instanceof ApiError)throw error;if(signal?.aborted)throw new ApiError(499,'request_cancelled','Local inference cancelled.');throw new ApiError(controller.aborted?504:502,controller.aborted?'local_provider_timeout':'local_provider_unavailable','Local provider unavailable or timed out.');}
  }
  async json(operation:'models'|'resources') {
    const response=await this.request(operation,AbortSignal.timeout(5000));
    const decoder=new TextDecoder();let text='';try{for await(const bytes of response.body??[]){text+=decoder.decode(bytes,{stream:true});if(text.length>2_097_152)fail('provider_event_limit');}return JSON.parse(text+decoder.decode());}finally{await response.body?.cancel().catch(()=>{});}
  }
  async models():Promise<{id:string;provider:ProviderId;state:string;quantization:string|null;context_length:number|null}[]> {
    const data=await this.json('models'),list=this.id==='ollama'?data.models:data.data;
    if(!Array.isArray(list)||list.length>2048)fail();
    if(list.some((m:any)=>!m||typeof (this.id==='ollama'?m.name:m.id)!=='string'||!(this.id==='ollama'?m.name:m.id)||String(this.id==='ollama'?m.name:m.id).length>128))fail();
    return list.filter((m:any)=>this.id==='ollama'||!m.type||['llm','vlm'].includes(m.type)).map((m:any)=>({id:String(this.id==='ollama'?m.name:m.id).slice(0,128),provider:this.id,state:typeof m.state==='string'?m.state:'unknown',quantization:typeof (m.quantization??m.details?.quantization_level)==='string'?(m.quantization??m.details.quantization_level):null,context_length:count(m.max_context_length)?m.max_context_length:null}));
  }
  async resources() {
    if(this.id!=='ollama')return {available:false,reason:'Backend does not expose process CPU/RAM/GPU via this API.'};
    const data=await this.json('resources');if(!Array.isArray(data.models))fail();
    return {available:true,source:'provider_reported',scope:'shared_loaded_models_not_per_request',models:data.models.slice(0,64).map((m:any)=>({model:String(m.name).slice(0,128),model_bytes:count(m.size)?m.size:null,vram_allocation_bytes:count(m.size_vram)?m.size_vram:null,context_length:count(m.context_length)?m.context_length:null})),gpu_utilization:null};
  }
  start(model:string) {return {id:null,run:(_input:string,options:ObservedTurnOptions={})=>this.run(model,options)};}
  resume():never {throw new ApiError(400,'local_sessions_unsupported','Legacy sessions use Codex only.');}
  async close() {}
  private async run(model:string,options:ObservedTurnOptions):Promise<ProviderTurn> {
    const request=options.request;if(!request)throw new Error('Missing local request.');
    const ollama=this.id==='ollama',stream=request.stream!==false;
    const toolNames=new Map(request.messages.flatMap(m=>(m.tool_calls??[]).map(t=>[t.id,t.function.name] as const)));
    const messages=request.messages.map(m=>ollama?{role:m.role==='developer'?'system':m.role,content:m.content??'',...(m.role==='tool'?{tool_name:toolNames.get(m.tool_call_id!)}:{}),...(m.tool_calls?{tool_calls:m.tool_calls.map((t,index)=>({type:'function',function:{index,name:t.function.name,arguments:JSON.parse(t.function.arguments)}}))}:{})}:{...m});
    const params={temperature:request.temperature??0,...(request.seed===undefined?{}:{seed:request.seed})};
    const payload={model,messages,stream,...(request.tools?.length?{tools:request.tools}:{}),...(ollama?{options:{...params,...(request.max_tokens?{num_predict:request.max_tokens}:{})}}:{...params,...(request.max_tokens?{max_tokens:request.max_tokens}:{}),...(stream?{stream_options:{include_usage:true}}:{}),...(request.tool_choice?{tool_choice:request.tool_choice}:{}),parallel_tool_calls:request.parallel_tool_calls})};
    const response=await this.request('chat',options.signal,payload);
    let content='',usage:ProviderUsage|null=null,timing:ProviderTiming={},finished=false,doneMarker=false,finishReason:'stop'|'length'|'tool_calls'='stop';
    const tools=new Map<number,{name:string;arguments:string}>();
    const emit=()=>{if(Buffer.byteLength(content)>1_048_576)fail('output_limit');options.onEvent?.({type:'output',item_id:'local-answer',text:JSON.stringify({content,tool_calls:[]})});};
    const consume=(data:any)=>{
      if(!data||typeof data!=='object'||data.error)fail('local_provider_error');
      if(ollama) {
        if(finished)fail();
        const message=data.message;
        if(message?.content!==undefined){if(typeof message.content!=='string')fail();content+=message.content;if(message.content)emit();}
        if(message?.tool_calls){if(!Array.isArray(message.tool_calls)||message.tool_calls.length>64)fail();for(const t of message.tool_calls){const index=t.function?.index??tools.size;if(!count(index)||index>=64||typeof t.function?.name!=='string'||t.function.name.length>64||typeof t.function?.arguments!=='object'||t.function.arguments===null)fail();tools.set(index,{name:t.function.name,arguments:JSON.stringify(t.function.arguments)});}}
        if(data.done===true){finished=true;if(data.done_reason==='length')finishReason='length';else if(data.done_reason&&data.done_reason!=='stop')fail();
          if(count(data.prompt_eval_count)&&count(data.eval_count))usage={input_tokens:data.prompt_eval_count,output_tokens:data.eval_count,cached_input_tokens:count(data.prompt_eval_cached_count)?data.prompt_eval_cached_count:null,reasoning_output_tokens:null};
          for(const [field,key]of [['eval_duration','generation_duration_ms'],['load_duration','load_duration_ms'],['prompt_eval_duration','prompt_duration_ms']] as const)if(count(data[field]))timing[key]=data[field]/1e6;
        }
      }else {
        if(data.usage&&count(data.usage.prompt_tokens)&&count(data.usage.completion_tokens))usage={input_tokens:data.usage.prompt_tokens,output_tokens:data.usage.completion_tokens,cached_input_tokens:count(data.usage.prompt_tokens_details?.cached_tokens)?data.usage.prompt_tokens_details.cached_tokens:null,reasoning_output_tokens:count(data.usage.completion_tokens_details?.reasoning_tokens)?data.usage.completion_tokens_details.reasoning_tokens:null};
        if(data.choices!==undefined&&(!Array.isArray(data.choices)||data.choices.length>1))fail();
        const choice=data.choices?.[0];
        if(choice){if(choice.index!==undefined&&choice.index!==0)fail();const delta=stream?choice.delta:choice.message;
          if(delta?.content!==undefined&&delta.content!==null){if(typeof delta.content!=='string'||finished)fail();content+=delta.content;if(delta.content)emit();}
          if(delta?.tool_calls){if(!Array.isArray(delta.tool_calls))fail();for(const [position,t]of delta.tool_calls.entries()){const index=stream?t.index:position;if(!count(index)||index>=64||finished)fail();const old=tools.get(index)??{name:'',arguments:''};if(t.function?.name!==undefined){if(typeof t.function.name!=='string')fail();old.name+=t.function.name;}if(t.function?.arguments!==undefined){if(typeof t.function.arguments!=='string')fail();old.arguments+=t.function.arguments;}if(old.name.length>128||old.arguments.length>1_048_576)fail('output_limit');tools.set(index,old);}}
          if(choice.finish_reason!==undefined&&choice.finish_reason!==null){if(finished||!['stop','length','tool_calls'].includes(choice.finish_reason))fail();finishReason=choice.finish_reason;finished=true;}
        }
        if(data.stats){for(const[field,key,scale]of [['time_to_first_token','ttft_ms',1000],['generation_time','generation_duration_ms',1000],['tokens_per_second','tokens_per_second',1]] as const)if(positive(data.stats[field])&&Number.isFinite(data.stats[field]*scale))timing[key]=data.stats[field]*scale;}
      }
      if(Buffer.byteLength(JSON.stringify({content,tool_calls:[...tools.values()]}))>1_048_576)fail('output_limit');
    };
    try {
      if(!stream) {const decoder=new TextDecoder();let raw='';for await(const bytes of response.body??[]){raw+=decoder.decode(bytes,{stream:true});if(raw.length>2_097_152)fail('provider_event_limit');}consume(JSON.parse(raw+decoder.decode()));}
      else if(ollama){const reader=response.body!.getReader(),decoder=new TextDecoder();let buffer='';try{while(true){const part=await reader.read();if(part.done)break;buffer+=decoder.decode(part.value,{stream:true});if(buffer.length>2_097_152)fail('provider_event_limit');let next;while((next=buffer.indexOf('\n'))>=0){const line=buffer.slice(0,next).trim();buffer=buffer.slice(next+1);if(line)consume(JSON.parse(line));}}buffer+=decoder.decode();if(buffer.trim())consume(JSON.parse(buffer));}finally{await reader.cancel().catch(()=>{});}}
      else await readEventStream(response,packet=>{if(doneMarker)fail();if(packet.data==='[DONE]'){doneMarker=true;return;}consume(packet.data);},options.signal);
      // OpenAI SSE has a non-JSON [DONE] marker; handled by the adapter decoder below.
      if(!finished||stream&&!ollama&&!doneMarker)fail();
      if(tools.size&&(finishReason as string)==='length')fail('incomplete_tool_proposal');
      const finalUsage=usage as ProviderUsage|null;
      if(finalUsage){if(finalUsage.cached_input_tokens!==null&&finalUsage.cached_input_tokens>finalUsage.input_tokens)fail();options.onEvent?.({type:'usage',usage:finalUsage});}
      options.onEvent?.({type:'timing',timing});
      return {items:[],finalResponse:JSON.stringify({content:content||(!tools.size?'':null),tool_calls:[...tools.values()]}),usage,timing,finishReason:tools.size?'tool_calls':finishReason};
    }catch(error){if(options.signal?.aborted)throw new ApiError(499,'request_cancelled','Local inference cancelled.');if(error instanceof ApiError)throw error;if(error instanceof Error&&['AbortError','TimeoutError'].includes(error.name))throw new ApiError(504,'local_provider_timeout','Local provider timed out.');throw new ApiError(502,'local_provider_protocol','Local provider stream was incomplete or malformed.');}
    finally{await response.body?.cancel().catch(()=>{});}
  }
}
