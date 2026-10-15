// No keys or response bodies are printed. Streaming is opt-in because a real gateway consumes usage.
const base = process.env.GATEWAY_BASE_URL ?? 'http://host.docker.internal:15600';
const key = process.env.GATEWAY_API_KEY;
if (!key) throw new Error('Set GATEWAY_API_KEY to an application key.');
const headers = {Authorization:`Bearer ${key}`};
const health = await fetch(`${base}/health`,{headers,signal:AbortSignal.timeout(10000)});
if (health.status !== 200) throw new Error(`Health HTTP ${health.status}`);
console.log('Container → gateway: health HTTP 200');
const denied = await fetch(`${base}/health`,{signal:AbortSignal.timeout(10000)});
if (denied.status !== 401) throw new Error(`Expected unauthenticated HTTP 401; got ${denied.status}`);
console.log('Unauthenticated request: HTTP 401');
if (process.env.RUN_STREAMING_SMOKE === '1') {
  const response = await fetch(`${base}/v1/chat/completions`,{method:'POST',headers:{...headers,'Content-Type':'application/json'},
    body:JSON.stringify({messages:[{role:'user',content:'Reply with a short greeting.'}],stream:true}),signal:AbortSignal.timeout(180000)});
  if (!response.ok || !response.headers.get('content-type')?.includes('text/event-stream')) throw new Error(`Streaming HTTP ${response.status}`);
  let buffer='',count=0,finished=false;const decoder=new TextDecoder();
  for await (const bytes of response.body) {
    buffer+=decoder.decode(bytes,{stream:true});let boundary;
    while ((boundary=buffer.indexOf('\n\n'))>=0) {
      const block=buffer.slice(0,boundary);buffer=buffer.slice(boundary+2);
      for (const line of block.split('\n')) if (line.startsWith('data: ')) {
        if (line.slice(6)==='[DONE]') finished=true;
        else {const data=JSON.parse(line.slice(6));if(data.error)throw new Error(`Stream error: ${data.error.code}`);count++;}
      }
    }
  }
  if (!finished || count<2) throw new Error('Stream incomplete.');
  console.log(`Streaming HTTP 200: ${count} chunks, [DONE] received`);
}
