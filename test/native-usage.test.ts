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
  assert.equal(parsed.events[0]!.cache_known,true);
  assert.equal(parsed.malformed,1);assert.ok(!JSON.stringify(parsed).includes('SECRET PROMPT'));
  const absent=await parseRollout(lines([meta,start,context,event('token_usage_record',{thread_id:'session-a',turn_id:'turn-a',response_id:'without-cache',usage:{input_tokens:10,output_tokens:2}})]));
  assert.equal(absent.events[0]!.cache_known,false);
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

test('parser migration marks unrecoverable historical cache and cost as unknown while retaining frozen rates for safe replay',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'native-parser-migration-')),path=join(dir,'stats.sqlite'),now=Date.now(),db=new DatabaseSync(path);
  db.exec('CREATE TABLE native_settings(key TEXT PRIMARY KEY,value TEXT NOT NULL); CREATE TABLE native_sessions(id TEXT PRIMARY KEY,cwd TEXT NOT NULL,source TEXT NOT NULL,model TEXT NOT NULL,created_at INTEGER,updated_at INTEGER,rollout_path TEXT,malformed INTEGER DEFAULT 0,resets INTEGER DEFAULT 0); CREATE TABLE native_events(id TEXT PRIMARY KEY,session_id TEXT NOT NULL,turn_id TEXT NOT NULL,model TEXT NOT NULL,timestamp INTEGER NOT NULL,input_tokens INTEGER,cached_tokens INTEGER,output_tokens INTEGER,reasoning_tokens INTEGER,basis TEXT,cost_usd REAL,price_json TEXT);');
  db.prepare("INSERT INTO native_settings VALUES('parser_version','2')").run();
  db.prepare('INSERT INTO native_sessions(id,cwd,source,model,created_at,updated_at) VALUES(?,?,?,?,?,?)').run('old','/old','cli','sol',now,now);
  db.prepare('INSERT INTO native_events VALUES(?,?,?,?,?,?,?,?,?,?,?,?)').run('old-event','old','old:turn','sol',now,1000,0,100,0,'response_record',42.5,JSON.stringify({input_rate:1,cached_rate:.1,output_rate:2}));
  db.close();const collector=new NativeUsage(path,join(dir,'missing-rollouts'));
  try{const s=collector.overview({range:'all',group:'day',page:1}).summary;assert.equal(s.cached_tokens,null);assert.equal(s.cache_unknown_events,1);assert.equal(s.cost_usd,0);assert.equal(s.unpriced_events,1);}finally{await collector.close();await rm(dir,{recursive:true,force:true});}
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
  const addEvent=(id:string,session:string,turn:string,model:string,input:number,output:number,cached:number,cost:number|null,time=now-10000)=>{db.prepare('INSERT INTO native_events VALUES(?,?,?,?,?,?,?,?,?,?,?,?)').run(id,session,`${session}:${turn}`,model,time,input,cached,output,0,'response_record',cost,null);db.prepare('INSERT INTO native_event_cache VALUES(?,1)').run(id);};
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

test('insights SQL reconciles filtered buckets and breakdowns, UTC+7 boundaries, missing usage, zero usage, cache and price uncertainty',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'native-insights-')),dbpath=join(dir,'stats.sqlite'),now=Date.parse('2026-10-20T05:30:00Z');
  const collector=new NativeUsage(dbpath,join(dir,'no-codex')),db=new DatabaseSync(dbpath),day=Date.parse('2026-10-19T17:00:00Z');
  const addSession=(id:string,cwd:string,model:string)=>db.prepare('INSERT INTO native_sessions(id,cwd,source,model,created_at,updated_at) VALUES(?,?,?,?,?,?)').run(id,cwd,'vscode',model,day,now);
  const addTurn=(session:string,id:string,model:string,started:number)=>db.prepare('INSERT INTO native_turns VALUES(?,?,?,?,?,?,?)').run(session+':'+id,session,model,'high',started,now,'completed');
  const addEvent=(id:string,session:string,turn:string,model:string,at:number,input:number,output:number,cached:number,cacheKnown:boolean,cost:number|null)=>{db.prepare('INSERT INTO native_events VALUES(?,?,?,?,?,?,?,?,?,?,?,?)').run(id,session,session+':'+turn,model,at,input,cached,output,0,'response_record',cost,null);if(cacheKnown)db.prepare('INSERT INTO native_event_cache VALUES(?,1)').run(id);};
  try{
    addSession('s1','/project-a','sol');addSession('s2','/project-a','astra');addSession('s3','/project-b','sol');
    // Turn started yesterday in UTC, but usage event belongs to today in UTC+7.
    addTurn('s1','cross','sol',day-60_000);addEvent('e1','s1','cross','sol',day+30*60_000,1000,100,200,true,0.01);
    addTurn('s2','unknown-cache','astra',day+60*60_000);addEvent('e2','s2','unknown-cache','astra',day+90*60_000,500,50,0,false,null);
    addTurn('s3','zero','sol',day+2*60*60_000);addEvent('e3','s3','zero','sol',day+2*60*60_000,0,0,0,true,0);
    addTurn('s3','missing','sol',day+3*60*60_000); // activity, no usage record
    addSession('no-rollout','/project-b','sol');db.prepare('UPDATE native_sessions SET updated_at=? WHERE id=?').run(day+3.5*60*60_000,'no-rollout');
    const result=collector.insights({range:'today'},now),s=result.summary;
    assert.equal(result.time_zone,'Asia/Ho_Chi_Minh');assert.equal(result.bucket_unit,'hour');
    assert.equal(s.input_tokens,1500);assert.equal(s.output_tokens,150);assert.equal(s.total_tokens,s.input_tokens+s.output_tokens);
    assert.equal(s.cached_input_tokens,null);assert.equal(s.cache_unknown_input_tokens,500);assert.equal(s.uncached_input_tokens,null);
    assert.equal(s.cache_known_events,2);
    assert.equal(s.cache_unknown_events,1);
    assert.equal(s.cost_usd,0.01);
    assert.equal(s.unpriced_events,1);
    assert.equal(s.turns,4);assert.equal(s.usage_known_turns,3);assert.equal(s.usage_unknown_turns,1);assert.equal(s.usage_complete,false);
    assert.equal(s.sessions_without_usage,1);
    assert.equal(result.buckets.reduce((a,b)=>a+b.total_tokens,0),s.total_tokens);
    assert.equal(result.buckets.find(b=>b.key==='2026-10-20T00')!.total_tokens,1100);
    assert.equal(result.buckets.find(b=>b.key==='2026-10-20T02')!.activity_present,true);assert.equal(result.buckets.find(b=>b.key==='2026-10-20T02')!.total_tokens,0);
    assert.equal(result.buckets.find(b=>b.key==='2026-10-20T03')!.activity_present,true);assert.equal(result.buckets.find(b=>b.key==='2026-10-20T03')!.usage_unknown_turns,1);assert.equal(result.buckets.find(b=>b.key==='2026-10-20T03')!.sessions_without_usage,1);
    assert.equal(result.buckets.at(-1)!.complete,false);
    assert.equal(result.projects.reduce((a,b)=>a+b.total_tokens,0),s.total_tokens);assert.equal(result.models.reduce((a,b)=>a+b.total_tokens,0),s.total_tokens);assert.equal(result.sources.reduce((a,b)=>a+b.total_tokens,0),s.total_tokens);
    const seven=collector.insights({range:'7d'},now);
    assert.equal(seven.hourly_activity.filter(b=>b.activity_present).length,4);
    assert.match(seven.hourly_activity[0]!.key,/^\d{4}-\d{2}-\d{2}T\d{2}$/);
    const filtered=collector.insights({range:'today',project:'/project-a',model:'sol',source:'vscode'},now);
    assert.equal(filtered.summary.total_tokens,1100);assert.equal(filtered.projects.length,1);assert.equal(filtered.models.length,1);assert.equal(filtered.sources.length,1);
    const yesterday=collector.insights({range:'yesterday'},now);assert.equal(yesterday.summary.total_tokens,0);
  }finally{db.close();await collector.close();await rm(dir,{recursive:true,force:true});}
});

test('insights counts each used turn once across hourly and daily buckets in the active filters',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'native-insights-turn-buckets-')),dbpath=join(dir,'stats.sqlite');
  const now=Date.parse('2026-10-20T05:30:00Z'),day=Date.parse('2026-10-19T17:00:00Z'),hour=3_600_000;
  const collector=new NativeUsage(dbpath,join(dir,'no-codex')),db=new DatabaseSync(dbpath);
  try{
    db.prepare('INSERT INTO native_sessions(id,cwd,source,model,created_at,updated_at) VALUES(?,?,?,?,?,?)').run('s','/long-turn','cli','sol',day-hour,now);
    for(const [id,started] of [['long',day-hour],['second',day+2.75*hour],['missing',day+3*hour],['zero',day+4*hour]] as const)
      db.prepare('INSERT INTO native_turns VALUES(?,?,?,?,?,?,?)').run('s:'+id,'s','sol','high',started,now,'completed');
    for(const [id,turn,at,input] of [
      ['before','long',day-.5*hour,100],['first','long',day+.5*hour,100],
      ['later','long',day+1.5*hour,100],['same-hour','long',day+1.6*hour,100],
      ['last','long',day+2.5*hour,100],['second','second',day+2.75*hour,100],
      ['zero','zero',day+4*hour,0],['unattributed','unattributed',day+5*hour,100],
    ] as const){
      db.prepare('INSERT INTO native_events VALUES(?,?,?,?,?,?,?,?,?,?,?,?)').run(id,'s','s:'+turn,'sol',at,input,0,0,0,'response_record',0,null);
      db.prepare('INSERT INTO native_event_cache VALUES(?,1)').run(id);
    }
    for(const range of ['today','yesterday','7d','30d'] as const)for(const filters of [{},{project:'/long-turn',model:'sol',source:'cli'},{model:'absent'}]){
      const result=collector.insights({range,...filters},now),s=result.summary;
      assert.equal(s.usage_known_turns,filters.model==='absent'?0:range==='yesterday'?1:3);
      for(const rows of [result.buckets,...(range==='7d'?[result.hourly_activity]:[])]){
        for(const key of ['turns','usage_known_turns','usage_unknown_turns','total_tokens'] as const)
          assert.equal(rows.reduce((sum,row)=>sum+row[key],0),s[key],`${range}: ${key} must reconcile`);
      }
      for(const rows of [result.projects,result.models,result.sources])
        assert.equal(rows.reduce((sum,row)=>sum+row.usage_known_turns,0),s.usage_known_turns);
    }
    const today=collector.insights({range:'today'},now);
    assert.equal(today.buckets.find(b=>b.key.endsWith('T00'))!.usage_known_turns,1);
    assert.equal(today.buckets.find(b=>b.key.endsWith('T01'))!.usage_known_turns,0);
    assert.equal(today.buckets.find(b=>b.key.endsWith('T02'))!.usage_known_turns,1);
    assert.equal(today.buckets.find(b=>b.key.endsWith('T05'))!.usage_known_turns,0);
    const seven=collector.insights({range:'7d'},now);
    assert.equal(seven.buckets.find(b=>b.key==='2026-10-19')!.usage_known_turns,1);
    assert.equal(seven.buckets.find(b=>b.key==='2026-10-20')!.usage_known_turns,2);
  }finally{db.close();await collector.close();await rm(dir,{recursive:true,force:true});}
});

test('insights aggregates a large isolated event history in SQLite without session pagination',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'native-insights-large-')),dbpath=join(dir,'stats.sqlite'),now=Date.parse('2026-10-20T05:30:00Z');
  const collector=new NativeUsage(dbpath,join(dir,'no-codex')),db=new DatabaseSync(dbpath);
  try{
    db.prepare('INSERT INTO native_sessions(id,cwd,source,model,created_at,updated_at) VALUES(?,?,?,?,?,?)').run('large','/large','cli','sol',now-30*86_400_000,now);
    db.exec(`WITH RECURSIVE seq(i) AS (SELECT 1 UNION ALL SELECT i+1 FROM seq WHERE i<40000)
      INSERT INTO native_events SELECT 'event-'||i,'large','large:unattributed','sol',${now}-(i%30)*86400000,(i%1000),0,(i%100),0,'response_record',NULL,NULL FROM seq`);
    db.exec("INSERT INTO native_event_cache SELECT id,1 FROM native_events");
    const began=performance.now(),result=collector.insights({range:'30d'},now),elapsed=performance.now()-began;
    assert.equal(result.summary.usage_records,40000);assert.equal(result.summary.input_tokens,19980000);
    assert.equal(result.buckets.reduce((a,b)=>a+b.usage_records,0),40000);assert.equal(result.projects.length,1);
    assert.ok(elapsed<10000,`40k usage records aggregation took ${Math.round(elapsed)}ms`);
    console.info('Native Insights fixture: 40k events in '+Math.round(elapsed)+'ms');
  }finally{db.close();await collector.close();await rm(dir,{recursive:true,force:true});}
});
