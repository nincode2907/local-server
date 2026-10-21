import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { NativeNotifications, safeTaskTitle, type NotificationSettings } from '../src/native-notifications.js';
import { NativeUsage, parseRollout } from '../src/native-usage.js';
import { mkdtemp, mkdir, writeFile, appendFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const startAt=Date.parse('2026-10-21T00:00:00Z');
const settings=(patch:Partial<NotificationSettings>={}):NotificationSettings=>({enabled:true,notify_completed:true,notify_errors:true,play_sound:true,sound:'Ping',privacy_mode:'private',excluded_projects:[],...patch});
const line=(type:string,payload:any,timestamp='2026-10-21T00:00:01Z')=>JSON.stringify({type,payload,timestamp});
async function* rows(values:string[]){yield* values;}

test('notification settings default off; private payloads hide task text; preview titles are sanitized',async()=>{
  const db=new DatabaseSync(':memory:'),sent:Array<{title:string;body:string;sound?:string}>=[];
  const service=new NativeNotifications(db,startAt,async(title,body,sound)=>{sent.push({title,body,sound});return {ok:true};});
  try{
    assert.equal(service.settings().enabled,false);
    service.saveSettings(settings());
    assert.equal(service.record({id:'t1',session_id:'s',project:'/work/client-a',model:'m',status:'completed',terminal_at:startAt+1000,duration_ms:2000,task_title:'Fix dashboard. sk-abcdefghijklmnop'}),true);
    await service.dispatchPending();
    assert.equal(sent.length,1);assert.equal(sent[0]!.title,'Thưa sếp, Codex ở client-a đã phản hồi!');
    assert.equal(sent[0]!.body,'Một lượt xử lý vừa hoàn tất.');assert.equal(sent[0]!.sound,'Ping');
    assert.equal(service.recent()[0]!.task_title,null);assert.equal(service.recent()[0]!.delivery_state,'delivered');
    service.saveSettings(settings({privacy_mode:'preview',play_sound:false}));
    service.record({id:'t2',session_id:'s',project:'/work/client-a',model:'m',status:'completed',terminal_at:startAt+2000,duration_ms:null,task_title:'Fix dashboard. sk-abcdefghijklmnop'});
    await service.dispatchPending();
    assert.equal(sent.length,2);assert.match(sent[1]!.body,/Yêu cầu: Fix dashboard\./);assert.ok(!sent[1]!.body.includes('sk-abcdefghijklmnop'));assert.equal(sent[1]!.sound,undefined);
    assert.ok(service.recent()[0]!.task_title?.startsWith('Fix dashboard.'));
  }finally{await service.close();db.close();}
});

test('completion notifications deduplicate rollout replay, ignore historical events and respect exclusion/preferences',async()=>{
  const db=new DatabaseSync(':memory:'),sent:string[]=[];
  const service=new NativeNotifications(db,startAt,async(title)=>{sent.push(title);return {ok:true};});
  try{
    service.saveSettings(settings({excluded_projects:['private-project']}));
    const terminal={id:'same',session_id:'s',project:'/repo/project',model:'m',status:'completed' as const,terminal_at:startAt+1,duration_ms:1};
    assert.equal(service.record({...terminal,terminal_at:startAt}),false);
    assert.equal(service.record(terminal),true);assert.equal(service.record(terminal),false);
    assert.equal(service.record({...terminal,id:'excluded',project:'/repo/private-project'}),true);
    assert.equal(service.record({...terminal,id:'failure',status:'failed',terminal_at:startAt+2}),true);
    await service.dispatchPending();
    assert.equal(sent.length,2);assert.equal(service.recent().find((e:any)=>e.id==='s:excluded')!.delivery_state,'filtered');
    assert.equal(service.recent().find((e:any)=>e.id==='s:same')!.delivery_state,'delivered');
    assert.equal(service.recent().find((e:any)=>e.id==='s:failure')!.delivery_state,'delivered');
    service.saveSettings(settings({notify_errors:false}));
    service.record({...terminal,id:'later-failure',status:'cancelled',terminal_at:startAt+3});await service.dispatchPending();
    assert.equal(service.recent()[0]!.delivery_state,'disabled');
  }finally{await service.close();db.close();}
});

test('rollout parser emits only terminal lifecycle states and keeps a sanitized title candidate',async()=>{
  const values=[
    line('session_meta',{id:'s',cwd:'/repo/demo',source:'cli',timestamp:'2026-10-21T00:00:00Z',title:'Old session title'}),
    line('event_msg',{type:'user_message',message:'Fix the mobile layout. /Users/private/project/secret.ts'}),
    line('event_msg',{type:'task_started',turn_id:'done'}),
    line('event_msg',{type:'task_complete',turn_id:'done'},'2026-10-21T00:00:03Z'),
    line('event_msg',{type:'task_started',turn_id:'cancel'}),
    line('event_msg',{type:'turn_aborted',turn_id:'cancel'},'2026-10-21T00:00:04Z'),
    line('event_msg',{type:'task_started',turn_id:'failed'}),
    line('event_msg',{type:'error',turn_id:'failed',codex_error_info:{affects_turn_status:true}}),
    line('event_msg',{type:'task_complete',turn_id:'failed'},'2026-10-21T00:00:05Z'),
  ];
  const parsed=await parseRollout(rows(values));
  assert.deepEqual(parsed.turns.map(t=>t.status),['completed','cancelled','failed']);
  assert.equal(parsed.turns[0]!.task_title,'Fix the mobile layout.');
  assert.ok(!JSON.stringify(parsed).includes('/Users/private'));
  assert.ok(!safeTaskTitle('API_KEY=supersecret')?.includes('supersecret'));
});

test('collector notifies only newly observed terminal turns and deduplicates file replay',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'native-notification-collector-')),home=join(dir,'codex'),db=join(dir,'stats.sqlite');
  await mkdir(join(home,'sessions','2026'),{recursive:true});
  const rollout=join(home,'sessions','2026','rollout-session-a.jsonl'),sent:string[]=[];
  const startedAt=Date.now();
  await writeFile(rollout,[
    line('session_meta',{id:'session-a',cwd:'/repo/demo',source:'cli',timestamp:'2026-10-20T00:00:00Z'}),
    line('event_msg',{type:'task_started',turn_id:'old'},'2026-10-20T00:00:01Z'),
    line('event_msg',{type:'task_complete',turn_id:'old'},'2026-10-20T00:00:02Z'),
  ].join('\n')+'\n');
  const collector=new NativeUsage(db,home,30_000,startedAt,async(title)=>{sent.push(title);return {ok:true};});
  try{
    collector.saveNotificationSettings(settings());await collector.sync();await collector.notifications.dispatchPending();
    assert.equal(sent.length,0,'startup replay must not notify old completed turns');
    const completedAt=new Date(Math.max(Date.now(),startedAt+10)+1000).toISOString();
    await appendFile(rollout,[
      line('event_msg',{type:'user_message',message:'A private user request'},completedAt),
      line('event_msg',{type:'task_started',turn_id:'new'},completedAt),
      line('event_msg',{type:'task_complete',turn_id:'new'},new Date(Date.parse(completedAt)+1000).toISOString()),
    ].join('\n')+'\n');
    await collector.sync();await collector.notifications.dispatchPending();
    assert.equal(sent.length,1);assert.match(sent[0]!,/Codex ở demo đã phản hồi/);
    await appendFile(rollout,line('response_item',{type:'message',content:'not a terminal event'},new Date(Date.now()+5000).toISOString())+'\n');
    await collector.sync();await collector.notifications.dispatchPending();
    assert.equal(sent.length,1,'replaying the expanded rollout must not send twice');
    assert.equal(collector.recentNotifications()[0]!.delivery_state,'delivered');
  }finally{await collector.close();await rm(dir,{recursive:true,force:true});}
});
