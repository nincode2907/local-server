import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createProvider, type Provider } from '../src/provider.js';
import { readConfig } from '../src/config.js';

const usage={input_tokens:31,output_tokens:7,cached_input_tokens:2,reasoning_output_tokens:3};
async function runFake(script:string, options:{execute:(provider:Provider)=>Promise<void>}) {
  const directory=await mkdtemp(join(tmpdir(),'codex-provider-lifecycle-'));
  const original=process.cwd();
  await writeFile(join(directory,'exec'),script);
  process.chdir(directory);
  const provider=await createProvider(readConfig({CODEX_BIN:process.execPath,CODEX_TRANSPORT:'exec'}));
  try {return await options.execute(provider);}
  finally {process.chdir(original);await provider.close();await rm(directory,{recursive:true,force:true});}
}
const emit=(events:unknown[])=>`process.stdout.write(${JSON.stringify(events.map(event=>JSON.stringify(event)+'\n').join(''))});`;
const event=(type:string,extra:Record<string,unknown>={})=>({type,...extra});
const item={id:'public-answer',type:'agent_message',text:'Answer'};

test('normal terminal event, final usage, and immediate zero exit produce a complete result',async()=>{
  await runFake(`${emit([event('thread.started',{thread_id:'fixture'}),event('item.completed',{item}),event('turn.completed',{usage})])}process.exit(0);`,{
    execute:async provider=>{let lifecycle:any;const result=await provider.start('fixture').run('synthetic',{onLifecycle:value=>lifecycle=value});
      assert.equal(result.finalResponse,'Answer');assert.deepEqual(result.usage,{...usage,cache_write_input_tokens:0});
      assert.ok(lifecycle.turn_completed_event_received_ms<=lifecycle.child_process_exited_ms);assert.equal(lifecycle.child_process_exit_code,0);assert.equal(lifecycle.child_process_signal,null);}
  });
});

test('delayed child exit keeps the response pending until clean exit and preserves final output and usage',async()=>{
  await runFake(`${emit([event('thread.started',{thread_id:'fixture'}),event('item.completed',{item}),event('turn.completed',{usage})])}setTimeout(()=>process.exit(0),90);`,{
    execute:async provider=>{let lifecycle:any;const result=await provider.start('fixture').run('synthetic',{onLifecycle:value=>lifecycle=value});
      assert.equal(result.finalResponse,'Answer');assert.equal(result.usage?.output_tokens,7);
      assert.ok(lifecycle.turn_completed_event_received_ms<lifecycle.child_process_exited_ms);assert.ok(lifecycle.child_process_exited_ms<=lifecycle.child_process_closed_ms);}
  });
});

test('late final usage after public output is retained without early success',async()=>{
  const output=event('item.updated',{item:{...item,text:'Partial'}});
  const completed=event('item.completed',{item});
  const terminal=event('turn.completed',{usage});
  await runFake(`${emit([output,completed])}setTimeout(()=>{${emit([terminal])}process.exit(0);},35);`,{
    execute:async provider=>{const observed:unknown[]=[];const result=await provider.start('fixture').run('synthetic',{onEvent:value=>observed.push(value)});
      assert.equal(result.finalResponse,'Answer');assert.equal(result.usage?.input_tokens,31);
      assert.equal(observed.filter((value:any)=>value.type==='usage').length,1);assert.equal((observed[0] as any).text,'Partial');}
  });
});

test('a child that hangs after terminal is cancelled, closed, and never reported complete',async()=>{
  await runFake(`${emit([event('item.completed',{item}),event('turn.completed',{usage})])}setInterval(()=>{},1000);`,{
    execute:async provider=>{const controller=new AbortController();let lifecycle:any,observed:any;
      await assert.rejects(provider.start('fixture').run('synthetic',{signal:controller.signal,onLifecycle:value=>{lifecycle=value;if(value.turn_completed_event_received_ms!==null)controller.abort();},observeResponse:value=>{observed=value;}}));
      assert.equal(observed.complete,false);assert.ok(lifecycle.child_process_closed_ms!==null);assert.equal(lifecycle.child_process_exit_code,null);assert.ok(lifecycle.child_process_signal);
      assert.ok(!JSON.stringify(observed).includes('PRIVATE'));}
  });
});

test('a cancelled child that ignores SIGTERM is force-killed after the bounded cleanup grace',async()=>{
  await runFake(`${emit([event('turn.completed',{usage})])}process.on('SIGTERM',()=>{});setInterval(()=>{},1000);`,{
    execute:async provider=>{const controller=new AbortController();let lifecycle:any;
      await assert.rejects(provider.start('fixture').run('synthetic',{signal:controller.signal,onLifecycle:value=>{lifecycle=value;if(value.turn_completed_event_received_ms!==null)controller.abort();}}));
      assert.equal(lifecycle.child_process_signal,'SIGKILL');assert.ok(lifecycle.child_process_closed_ms!==null);}
  });
});

test('nonzero and signal exits remain errors with their actual process termination metadata',async()=>{
  await runFake(`${emit([event('turn.completed',{usage})])}process.exit(7);`,{
    execute:async provider=>{let lifecycle:any,observed:any;
      await assert.rejects(provider.start('fixture').run('synthetic',{onLifecycle:value=>lifecycle=value,observeResponse:value=>{observed=value;}}),/code 7/);
      assert.equal(lifecycle.child_process_exit_code,7);assert.equal(lifecycle.child_process_signal,null);assert.equal(observed.complete,false);}
  });
  await runFake(`${emit([event('turn.completed',{usage})])}setTimeout(()=>process.kill(process.pid,'SIGTERM'),20);`,{
    execute:async provider=>{let lifecycle:any;
      await assert.rejects(provider.start('fixture').run('synthetic',{onLifecycle:value=>lifecycle=value}),/signal SIGTERM/);
      assert.equal(lifecycle.child_process_exit_code,null);assert.equal(lifecycle.child_process_signal,'SIGTERM');}
  });
});

test('missing terminal event and partial JSONL cannot be returned as successful completions',async()=>{
  await runFake(`${emit([event('item.completed',{item})])}process.exit(0);`,{
    execute:async provider=>{let observed:any;await assert.rejects(provider.start('fixture').run('synthetic',{observeResponse:value=>{observed=value;}}),/without a terminal turn event/);
      assert.equal(observed.complete,false);assert.equal(observed.error_code,'cli_missing_terminal');}
  });
  await runFake(`${emit([event('turn.completed',{usage})])}process.stdout.write('{"type":');process.exit(0);`,{
    execute:async provider=>{let observed:any;await assert.rejects(provider.start('fixture').run('synthetic',{observeResponse:value=>{observed=value;}}));assert.equal(observed.complete,false);}
  });
});

test('CLI reconnect notices are counted in the lifecycle without failing a completed turn',async()=>{
  await runFake(`${emit([event('thread.started',{thread_id:'fixture'}),event('error',{message:'Reconnecting... 1/5 (request timed out)'}),event('error',{message:'Reconnecting... 2/5 (workspace routing discovery timed out)'}),event('item.completed',{item}),event('turn.completed',{usage})])}process.exit(0);`,{
    execute:async provider=>{let lifecycle:any;const result=await provider.start('fixture').run('synthetic',{onLifecycle:value=>lifecycle=value});
      assert.equal(result.finalResponse,'Answer');assert.equal(lifecycle.reconnect_count,2);
      assert.ok(lifecycle.first_reconnect_ms>=0&&lifecycle.first_reconnect_ms<=lifecycle.turn_completed_event_received_ms);
      assert.equal(lifecycle.last_reconnect_message,'Reconnecting... 2/5 (workspace routing discovery timed out)');}
  });
});

test('returnOnTurnCompleted answers before the CLI exits and reports a later non-zero exit',async()=>{
  await runFake(`${emit([event('thread.started',{thread_id:'fixture'}),event('item.completed',{item}),event('turn.completed',{usage})])}setTimeout(()=>process.exit(3),400);`,{
    execute:async provider=>{let lifecycle:any;const late:unknown[]=[];const started=performance.now();
      const result=await provider.start('fixture').run('synthetic',{returnOnTurnCompleted:true,onLifecycle:value=>lifecycle=value,onLateExit:exit=>late.push(exit)});
      const elapsed=performance.now()-started;
      assert.equal(result.finalResponse,'Answer');assert.equal(result.usage?.output_tokens,7);
      assert.ok(elapsed<350,`returned after ${elapsed} ms`);assert.equal(result.cliLifecycle?.returned_before_exit,true);assert.deepEqual(late,[]);
      await new Promise(resolve=>setTimeout(resolve,700));
      assert.deepEqual(late,[{code:3,signal:null}]);assert.equal(lifecycle.child_process_exit_code,3);}
  });
});

test('returnOnTurnCompleted still waits for the exit when usage never arrived',async()=>{
  await runFake(`${emit([event('thread.started',{thread_id:'fixture'}),event('item.completed',{item}),event('turn.completed')])}setTimeout(()=>process.exit(0),150);`,{
    execute:async provider=>{const started=performance.now();const result=await provider.start('fixture').run('synthetic',{returnOnTurnCompleted:true});
      assert.ok(performance.now()-started>=140);assert.equal(result.cliLifecycle?.returned_before_exit,false);}
  });
});
