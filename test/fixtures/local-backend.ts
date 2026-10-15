import Fastify,{type FastifyRequest,type FastifyReply} from 'fastify';
import {setTimeout as delay} from 'node:timers/promises';

/** Synthetic local protocol backend shared by tests and the browser preview. */
export async function localBackend(port=0) {
  const app=Fastify(),requests:{url:string;authorization:string|undefined;body:any}[]=[];
  app.get('/api/tags',async()=>({models:[{name:'fixture-local',details:{quantization_level:'Q4_FIXTURE'}}]}));
  app.get('/v1/models',async()=>({data:[{id:'fixture-local'}]}));
  app.get('/api/v0/models',async()=>({data:[{id:'fixture-local',type:'llm',state:'loaded',quantization:'Q4_FIXTURE',max_context_length:4096}]}));
  app.get('/api/ps',async()=>({models:[{name:'fixture-local',size:1024*1024*8,size_vram:1024*1024*4,context_length:4096}]}));
  const chat=async(req:FastifyRequest,reply:FastifyReply)=>{
    const body=req.body as any,model=body.model,ollama=req.url==='/api/chat';requests.push({url:req.url,authorization:req.headers.authorization,body});
    if(model==='http-error')return reply.code(503).send({error:'synthetic backend failure'});
    if(model==='rate-limit')return reply.code(429).send({error:'synthetic rate limit'});
    if(model==='redirect')return reply.redirect('/private-never-follow');
    const tool=model==='tools',content=tool?'':'MÔ PHỎNG local — không gọi tài khoản thật. Xin chào!',parts=tool?['']:['MÔ PHỎNG local — ','không gọi tài khoản thật. ','Xin chào!'];
    const usage=model==='no-usage'?undefined:{prompt_tokens:20,completion_tokens:10,total_tokens:30};
    const stats=model==='no-stats'?undefined:{tokens_per_second:50,time_to_first_token:.04,generation_time:.2};
    const native={prompt_eval_count:20,eval_count:10,eval_duration:200_000_000,load_duration:10_000_000,prompt_eval_duration:30_000_000};
    const tools=tool?[{function:{name:'lookup',arguments:{q:'fixture'}}}]:undefined;
    if(body.stream===false&&model==='slow')await delay(500);
    if(body.stream===false)return ollama?{message:{content,tool_calls:tools},done:true,done_reason:model==='length'?'length':'stop',...(model==='no-usage'?{}:native)}:{choices:[{index:0,message:{content,tool_calls:tool?[{id:'fixture-call',type:'function',function:{name:'lookup',arguments:'{"q":"fixture"}'}}]:undefined},finish_reason:tool?'tool_calls':model==='length'?'length':'stop'}],usage,stats};
    reply.hijack();reply.raw.writeHead(200,{'Content-Type':ollama?'application/x-ndjson':'text/event-stream','X-Codex-Preview':'local-backend'});
    try {
      for(const [index,part]of parts.entries()){
        await delay(model==='slow'?150:20);if(reply.raw.destroyed)return;
        if(model==='malformed'){reply.raw.end(ollama?'not-json\n':'data: not-json\n\n');return;}
        if(ollama)reply.raw.write(JSON.stringify({message:{content:part,...(tool?{tool_calls:tools}:{})},done:false})+'\n');
        else reply.raw.write(`data: ${JSON.stringify({choices:[{index:0,delta:{content:part,...(tool?{tool_calls:[{index:0,function:{name:'lookup',arguments:'{"q":"fixture"}'}}]}:{})},finish_reason:null}]})}\n\n`);
        if(model==='truncated'&&index===0){reply.raw.end();return;}
      }
      if(ollama)reply.raw.write(JSON.stringify({message:{content:''},done:true,done_reason:model==='length'?'length':'stop',...(model==='no-usage'?{}:native)})+'\n');
      else{reply.raw.write(`data: ${JSON.stringify({choices:[{index:0,delta:{},finish_reason:tool?'tool_calls':model==='length'?'length':'stop'}],stats})}\n\n`);reply.raw.write(`data: ${JSON.stringify({choices:[],usage})}\n\ndata: [DONE]\n\n`);}
    }finally{reply.raw.end();}
  };
  for(const path of ['/api/chat','/v1/chat/completions','/api/v0/chat/completions'])app.post(path,chat);
  app.get('/private-never-follow',async()=>{throw Error('Redirect must never be followed.');});
  const url=await app.listen({host:'127.0.0.1',port});return {app,url,requests};
}
