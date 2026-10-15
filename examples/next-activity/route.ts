import 'server-only';
import {canAccessRun} from './authorization';

export const runtime='nodejs';
export const dynamic='force-dynamic';
type Context={params:Promise<{id:string;action?:string[]}>};

// Install at app/api/ai/runs/[id]/[[...action]]/route.ts; adjust authorization import.
async function proxy(request:Request,context:Context) {
  const {id,action=[]}=await context.params,operation=action.join('/'),method=request.method;
  if(!/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/.test(id)||action.length>1||
    !(method==='GET'&&['','events'].includes(operation)||method==='POST'&&operation==='cancel'))return new Response(null,{status:404});
  const requestUrl=new URL(request.url),origin=request.headers.get('origin'),site=request.headers.get('sec-fetch-site');
  if(origin&&origin!==requestUrl.origin||site&& !['same-origin','none'].includes(site)||method==='POST'&&origin!==requestUrl.origin)return new Response(null,{status:403});
  if(!await canAccessRun(request,id))return new Response(null,{status:404});
  const key=process.env.CODEX_APP_API_KEY;
  const upstream=new URL(process.env.CODEX_GATEWAY_URL??'http://127.0.0.1:15600');
  if(!key||upstream.protocol!=='http:'||!['127.0.0.1','localhost','host.docker.internal'].includes(upstream.hostname)||upstream.username||upstream.password||upstream.search||upstream.hash||upstream.pathname!=='/')return new Response(null,{status:503});
  upstream.pathname=`/v1/runs/${id}${operation?'/'+operation:''}`;
  const headers:Record<string,string>={Authorization:`Bearer ${key}`};
  if(operation==='events') {
    if([...requestUrl.searchParams.keys()].some(k=>!['cursor','follow_workflow'].includes(k)))return new Response(null,{status:400});
    const cursor=request.headers.get('last-event-id')??requestUrl.searchParams.get('cursor');
    if(cursor){if(cursor.length>128)return new Response(null,{status:400});headers['Last-Event-ID']=cursor;}
    if(requestUrl.searchParams.get('follow_workflow')==='1')upstream.searchParams.set('follow_workflow','1');
  }
  if(method==='POST')headers['Content-Type']='application/json';
  try {
    const response=await fetch(upstream,{method,headers,body:method==='POST'?'{}':undefined,signal:request.signal,cache:'no-store',redirect:'error'});
    return new Response(response.body,{status:response.status,headers:{'Content-Type':response.headers.get('content-type')??'application/json','Cache-Control':'no-store','X-Accel-Buffering':'no','X-Content-Type-Options':'nosniff'}});
  }catch {return Response.json({error:{code:'gateway_unavailable',message:'Gateway unavailable.'}},{status:502});}
}
export const GET=proxy;
export const POST=proxy;
