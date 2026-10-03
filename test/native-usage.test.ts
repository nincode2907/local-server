import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, appendFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { NativeUsage, parseRollout, contextSpikes } from '../src/native-usage.js';

const time='2026-10-03T01:00:00Z';
const event=(type:string,payload:any,timestamp=time)=>JSON.stringify({type,payload,timestamp});
const meta=event('session_meta',{id:'session-a',cwd:'/projects/demo',source:'vscode',timestamp:time});
const start=event('event_msg',{type:'task_started',turn_id:'turn-a'});
const context=event('turn_context',{turn_id:'turn-a',model:'gpt-6.1-sol',effort:'high'});
const u=(input:number,output=10,cached=0)=>({input_tokens:input,output_tokens:output,cached_input_tokens:cached,reasoning_output_tokens:3});
const legacy=(total:any,last=total)=>event('event_msg',{type:'token_count',info:{total_token_usage:total,last_token_usage:last}});
async function* lines(rows:string[]) {yield* rows;}

test('legacy cumulative deltas are deduplicated; canonical response records override duplicate token_count',async()=>{
  const old=await parseRollout(lines([meta,start,context,legacy(u(100)),legacy(u(100)),legacy(u(150,20)),event('event_msg',{type:'task_complete',turn_id:'turn-a'},'2026-10-03T01:00:10Z')]));
  assert.equal(old.events.length,2); assert.equal(old.events.reduce((n,e)=>n+e.input_tokens,0),150);
  assert.equal(old.events.reduce((n,e)=>n+e.output_tokens,0),20);assert.equal(old.turns[0]!.finished_at!-old.turns[0]!.started_at,10000);
  const record=event('token_usage_record',{thread_id:'session-a',turn_id:'turn-a',response_id:'response-a',usage:u(100,10,40)});
  const parsed=await parseRollout(lines([meta,start,context,record,legacy(u(100,10,40)),record,event('response_item',{type:'message',content:'SECRET PROMPT'}),'bad JSON']));
  assert.equal(parsed.events.length,1);assert.equal(parsed.events[0]!.cached_input_tokens,40);
  assert.equal(parsed.malformed,1);assert.ok(!JSON.stringify(parsed).includes('SECRET PROMPT'));
});

test('fork replay excludes inherited records; missing usage remains unknown and counter resets use last usage',async()=>{
  const fork=event('session_meta',{id:'child',cwd:'/p',source:'cli',forked_from_id:'parent',timestamp:time});
  const parsed=await parseRollout(lines([fork,event('token_usage_record',{thread_id:'parent',turn_id:'old',usage:u(900)},'2026-10-02T00:00:00Z'),start,context]));
  assert.equal(parsed.events.length,0);
  const parent=event('session_meta',{id:'parent',cwd:'/p',source:'cli',timestamp:'2026-10-02T00:00:00Z'});
  const copied=await parseRollout(lines([parent,start,context,legacy(u(900)),fork,start,context,legacy(u(910),u(10))]));
  assert.equal(copied.meta!.id,'child');assert.equal(copied.events.reduce((n,e)=>n+e.input_tokens,0),10);

  const reset=await parseRollout(lines([meta,start,context,legacy(u(100)),legacy(u(40))]));
  assert.equal(reset.resets,1);assert.equal(reset.events.reduce((n,e)=>n+e.input_tokens,0),140);
});

test('collector sync is idempotent, persists after restart, imports metadata-only sessions and retains frozen pricing',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'native-usage-')),home=join(dir,'codex'),dbpath=join(dir,'stats.sqlite');
  await mkdir(join(home,'sessions','2026'),{recursive:true});
  const path=join(home,'sessions','2026','rollout-a.jsonl');
  await writeFile(path,[meta,start,context,event('token_usage_record',{thread_id:'session-a',turn_id:'turn-a',response_id:'r1',usage:u(1000000,100000,400000)}),event('event_msg',{type:'task_complete',turn_id:'turn-a'},'2026-10-03T01:00:10Z')].join('\n')+'\n');
  const state=new DatabaseSync(join(home,'state_5.sqlite'));
  state.exec('CREATE TABLE threads(id TEXT,cwd TEXT,source TEXT,model TEXT,created_at INTEGER,updated_at INTEGER)');
  state.prepare('INSERT INTO threads VALUES(?,?,?,?,?,?)').run('missing','/other','exec','unknown',1790989200,1790989200);state.close();
  const originalState = await readFile(join(home,'state_5.sqlite'));
  const originalRollout = await readFile(path);
  let collector=new NativeUsage(dbpath,home);
  const filter={range:'all',group:'day',page:1} as const;
  try {
    await collector.sync();
    assert.deepEqual(await readFile(join(home,'state_5.sqlite')), originalState);
    assert.deepEqual(await readFile(path), originalRollout);
    const first=collector.overview(filter);assert.equal(first.summary.sessions,2);assert.equal(first.summary.usage_unavailable_sessions,1);
    assert.equal(first.summary.input_tokens,1000000);assert.equal(first.summary.cost_usd,2.24);assert.equal(first.summary.turns,1);
    await collector.sync();assert.equal(collector.overview(filter).summary.cost_usd,2.24);
    await collector.close();collector=new NativeUsage(dbpath,home);assert.equal(collector.overview(filter).summary.input_tokens,1000000);
    await appendFile(path,event('response_item',{type:'message',content:'PRIVATE RESPONSE'})+'\n');await collector.sync();
    assert.equal(collector.overview(filter).summary.cost_usd,2.24);assert.ok(!JSON.stringify(collector.detail('session-a')).includes('PRIVATE RESPONSE'));
    assert.equal(collector.overview({...filter,project:'/other'}).summary.input_tokens,0);
    assert.equal(collector.overview({...filter,source:'vscode'}).summary.sessions,1);
    assert.equal(collector.detail('session-a')!.events[0]!.basis,'response_record');
    const prices=new DatabaseSync(dbpath);
    const price=JSON.parse(String(prices.prepare('SELECT price_json FROM native_events').get()!.price_json));
    price.input_rate=100;price.cached_rate=5;price.output_rate=3;
    prices.prepare('UPDATE native_events SET price_json=?').run(JSON.stringify(price));prices.close();
    await appendFile(path,event('response_item',{type:'message',content:'ignored'})+'\n');await collector.sync();
    assert.equal(collector.overview(filter).summary.cost_usd,62.3);
    await appendFile(path,'{"type":"token_usage_record"');await collector.sync();
    assert.equal(collector.detail('session-a')!.session.malformed,1);
    await appendFile(path,',"timestamp":"2026-10-03T01:00:20Z","payload":{"thread_id":"session-a","turn_id":"turn-a","response_id":"r2","usage":{"input_tokens":10,"output_tokens":5}}}\n');
    await collector.sync();assert.equal(collector.detail('session-a')!.session.malformed,0);
    assert.equal(collector.overview(filter).summary.calls,2);
    assert.equal(collector.overview(filter).summary.input_tokens,1000010);
  }finally{await collector.close();await rm(dir,{recursive:true,force:true});}
});


test('context spikes compare generation input within session/model, include 20k → 80k → 300k, and ignore tiny jumps',()=>{
  const sample=(id:string,input:number,model='gpt-6.1-sol',session='s')=>({id,session_id:session,turn_id:'same-turn',model,timestamp:Number(id),input_tokens:input});
  const spikes=contextSpikes([sample('1',20000),sample('2',80000),sample('3',300000),sample('4',300000),sample('5',900000,'other'),sample('6',1000000,'gpt-6.1-sol','new-session')]);
  assert.equal(spikes.length,2);assert.equal(spikes[0]!.growth_ratio,4);
  assert.deepEqual(spikes[1]!.sequence,[20000,80000,300000]);
  assert.equal(contextSpikes([sample('1',100),sample('2',400)]).length,0);
  assert.equal(contextSpikes([sample('1',25000),sample('2',50000)]).length,0); // strict >2×
});

test('project/model efficiency counts distinct used turns and sessions, excludes missing usage/prices, and keeps spike baselines outside the window',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'native-efficiency-')),dbpath=join(dir,'stats.sqlite');
  const collector=new NativeUsage(dbpath,join(dir,'no-codex'));const db=new DatabaseSync(dbpath),now=Date.now();
  const addSession=(id:string,cwd:string,model:string)=>db.prepare('INSERT INTO native_sessions(id,cwd,source,model,created_at,updated_at) VALUES(?,?,?,?,?,?)').run(id,cwd,'vscode',model,now-200000000,now);
  const addTurn=(session:string,id:string,model:string)=>db.prepare('INSERT INTO native_turns VALUES(?,?,?,?,?,?,?)').run(`${session}:${id}`,session,model,'high',now-200000000,now,'completed');
  const addEvent=(id:string,session:string,turn:string,model:string,input:number,output:number,cached:number,cost:number|null,time=now-10000)=>db.prepare('INSERT INTO native_events VALUES(?,?,?,?,?,?,?,?,?,?,?,?)').run(id,session,`${session}:${turn}`,model,time,input,cached,output,0,'response_record',cost,null);
  try {
    addSession('s1','/project-a','sol');addSession('s2','/project-a','astra');addSession('no-usage','/project-a','sol');addSession('s3','/project-b','sol');
    addTurn('s1','t1','sol');addTurn('s1','t2','astra');addTurn('s1','missing','sol');addTurn('s2','t1','astra');addTurn('s3','t1','sol');
    addEvent('a','s1','t1','sol',20000,1000,10000,1,now-100000000); // prior window baseline
    addEvent('b','s1','t1','sol',80000,2000,60000,2);
    addEvent('c','s1','t2','astra',100000,3000,50000,3);
    addEvent('d','s2','t1','astra',300000,4000,150000,null);
    addEvent('e','s3','t1','sol',50000,500,0,4);
    const all=collector.overview({range:'all',group:'day',page:1});
    const project=all.projects.find(p=>p.key==='/project-a')!;
    assert.equal(project.sessions,2);assert.equal(project.usage_turns,3);
    assert.equal(project.tokens_per_turn,510000/3);assert.equal(project.cost_per_session,6);assert.equal(project.unpriced_sessions,1);
    const sol=all.models.find(m=>m.key==='sol')!;assert.equal(sol.sessions,2);assert.equal(sol.usage_turns,2);assert.equal(sol.tokens_per_turn,153500/2);
    assert.equal(all.summary.cache_hit_rate,270000/550000);
    const filtered=collector.overview({range:'24h',group:'day',page:1,project:'/project-a',model:'sol'});
    assert.equal(filtered.summary.tokens_per_turn,82000);assert.equal(filtered.summary.usage_turns,1);
    assert.equal(filtered.spikes.length,1);assert.deepEqual(filtered.spikes[0]!.sequence,[20000,80000]);
    assert.equal(filtered.summary.context_spikes,1);assert.equal(collector.detail('s1')!.spikes.length,1);
    addEvent('unattributed','s3','unattributed','sol',900000,0,0,null);
    const missingTurn=collector.overview({range:'all',group:'day',page:1});
    assert.equal(missingTurn.summary.unattributed_events,1);assert.equal(missingTurn.summary.tokens_per_turn,560500/4);
    const empty=collector.overview({range:'all',group:'day',page:1,project:'/none'});
    assert.equal(empty.summary.cache_hit_rate,null);assert.equal(empty.summary.tokens_per_turn,null);assert.equal(empty.spikes.length,0);
  }finally{db.close();await collector.close();await rm(dir,{recursive:true,force:true});}
});
