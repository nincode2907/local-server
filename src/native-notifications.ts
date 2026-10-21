import type { DatabaseSync } from 'node:sqlite';
import { spawn } from 'node:child_process';
import { basename } from 'node:path';

export const notificationSounds = ['Glass','Ping','Pop','Purr','Sosumi','Submarine','Tink','Basso'] as const;
export type NotificationSound = typeof notificationSounds[number];
export type NotificationSettings = {
  enabled:boolean;
  notify_completed:boolean;
  notify_errors:boolean;
  play_sound:boolean;
  sound:NotificationSound;
  privacy_mode:'private'|'preview';
  excluded_projects:string[];
};
export type TerminalTurn = {
  id:string; session_id:string; project:string; model:string; status:'completed'|'failed'|'cancelled';
  terminal_at:number; duration_ms:number|null; task_title?:string|null;
};
type DeliveryResult = {ok:true}|{ok:false;code:string};
export type NotificationRunner = (title:string,body:string,sound?:NotificationSound)=>Promise<DeliveryResult>;
type StoredTurn = TerminalTurn & {task_title:string|null};

const defaults:NotificationSettings={enabled:false,notify_completed:true,notify_errors:false,play_sound:true,sound:'Glass',privacy_mode:'private',excluded_projects:[]};
const appleScript=`on run argv
  set notificationTitle to item 1 of argv
  set notificationBody to item 2 of argv
  if (count of argv) > 2 then
    display notification notificationBody with title notificationTitle sound name (item 3 of argv)
  else
    display notification notificationBody with title notificationTitle
  end if
end run`;

export class NativeNotifications {
  private dispatching?:Promise<void>;
  private lastSoundAt=0;
  private closed=false;
  constructor(private db:DatabaseSync,private startedAt=Date.now(),private runner:NotificationRunner=deliverAppleNotification) {
    db.exec(`CREATE TABLE IF NOT EXISTS native_notification_settings(
      id INTEGER PRIMARY KEY CHECK(id=1),enabled INTEGER NOT NULL,notify_completed INTEGER NOT NULL,
      notify_errors INTEGER NOT NULL,play_sound INTEGER NOT NULL,sound TEXT NOT NULL,
      privacy_mode TEXT NOT NULL,excluded_projects_json TEXT NOT NULL,updated_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS native_notification_events(
      id TEXT PRIMARY KEY,session_id TEXT NOT NULL,turn_id TEXT NOT NULL,project TEXT NOT NULL,
      model TEXT NOT NULL,status TEXT NOT NULL CHECK(status IN ('completed','failed','cancelled')),
      terminal_at INTEGER NOT NULL,duration_ms INTEGER,task_title TEXT,
      delivery_state TEXT NOT NULL CHECK(delivery_state IN ('pending','sending','delivered','failed','filtered','disabled','interrupted')),
      error_code TEXT,created_at INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS native_notification_events_recent ON native_notification_events(terminal_at DESC);`);
    this.insertDefaults();
    // An in-flight delivery can never be safely retried after a crash: macOS may already have shown it.
    db.prepare("UPDATE native_notification_events SET delivery_state='interrupted',error_code='process_restarted' WHERE delivery_state IN ('pending','sending') AND terminal_at<=?").run(startedAt);
  }
  private insertDefaults(){this.db.prepare(`INSERT OR IGNORE INTO native_notification_settings VALUES(1,?,?,?,?,?,?,?,?)`).run(Number(defaults.enabled),Number(defaults.notify_completed),Number(defaults.notify_errors),Number(defaults.play_sound),defaults.sound,defaults.privacy_mode,JSON.stringify(defaults.excluded_projects),Date.now());}
  settings():NotificationSettings {
    this.insertDefaults();const row=this.db.prepare('SELECT * FROM native_notification_settings WHERE id=1').get() as any;
    let excluded:string[]=[];try{const value=JSON.parse(String(row.excluded_projects_json));if(Array.isArray(value))excluded=value.filter(x=>typeof x==='string');}catch{}
    return {enabled:Boolean(row.enabled),notify_completed:Boolean(row.notify_completed),notify_errors:Boolean(row.notify_errors),play_sound:Boolean(row.play_sound),sound:notificationSounds.includes(row.sound)?row.sound:'Glass',privacy_mode:row.privacy_mode==='preview'?'preview':'private',excluded_projects:excluded};
  }
  saveSettings(value:NotificationSettings){
    this.db.prepare(`UPDATE native_notification_settings SET enabled=?,notify_completed=?,notify_errors=?,play_sound=?,sound=?,privacy_mode=?,excluded_projects_json=?,updated_at=? WHERE id=1`).run(Number(value.enabled),Number(value.notify_completed),Number(value.notify_errors),Number(value.play_sound),value.sound,value.privacy_mode,JSON.stringify(value.excluded_projects),Date.now());
    if(value.privacy_mode==='private')this.db.prepare('UPDATE native_notification_events SET task_title=NULL').run();
    void this.dispatchPending().catch(()=>{});return this.settings();
  }
  record(turn:TerminalTurn){
    // Old rollouts are imported for metrics, but only a terminal event observed after process start can notify.
    if(!Number.isFinite(turn.terminal_at)||turn.terminal_at<=this.startedAt)return false;
    const settings=this.settings(),project=basename(turn.project.trim())||'Codex';
    const excluded=settings.excluded_projects.some(v=>v.trim().toLowerCase()===project.toLowerCase());
    const enabled=settings.enabled&&(turn.status==='completed'?settings.notify_completed:settings.notify_errors);
    const state=excluded?'filtered':enabled?'pending':'disabled';
    const taskTitle=settings.privacy_mode==='preview'?safeTaskTitle(turn.task_title):null;
    const id=`${turn.session_id}:${turn.id}`;
    const result=this.db.prepare(`INSERT OR IGNORE INTO native_notification_events
      (id,session_id,turn_id,project,model,status,terminal_at,duration_ms,task_title,delivery_state,error_code,created_at)
      VALUES(?,?,?,?,?,?,?,?,?,?,NULL,?)`).run(id,turn.session_id,turn.id,project,turn.model,turn.status,turn.terminal_at,turn.duration_ms,taskTitle,state,Date.now());
    return Number(result.changes)>0;
  }
  recent(limit=12){
    const privacy=this.settings().privacy_mode;
    return this.db.prepare('SELECT id,project,model,status,terminal_at,duration_ms,task_title,delivery_state,error_code FROM native_notification_events ORDER BY terminal_at DESC,id DESC LIMIT ?').all(Math.max(1,Math.min(50,limit))).map((row:any)=>({...row,task_title:privacy==='preview'?row.task_title:null}));
  }
  async test():Promise<DeliveryResult>{const s=this.settings();try{return await this.runner('Codex Server','Thưa sếp, hệ thống thông báo đã sẵn sàng!',s.play_sound?s.sound:undefined);}catch{return {ok:false,code:'delivery_failed'};}}
  dispatchPending():Promise<void>{
    if(this.closed)return Promise.resolve();
    if(this.dispatching)return this.dispatching.then(async()=>{
      if(this.closed)return;
      const pending=this.db.prepare("SELECT 1 AS pending FROM native_notification_events WHERE delivery_state='pending' LIMIT 1").get();
      if(pending)await this.dispatchPending();
    });
    if(!this.dispatching)this.dispatching=this.drain().finally(()=>{this.dispatching=undefined;});
    return this.dispatching;
  }
  private async drain(){
    while(!this.closed){
      const row=this.db.prepare("SELECT * FROM native_notification_events WHERE delivery_state='pending' ORDER BY terminal_at,id LIMIT 1").get() as StoredTurn|undefined;
      if(!row)return;
      const claim=this.db.prepare("UPDATE native_notification_events SET delivery_state='sending' WHERE id=? AND delivery_state='pending'").run(row.id);
      if(!Number(claim.changes))continue;
      const s=this.settings();
      const excluded=s.excluded_projects.some(v=>v.trim().toLowerCase()===row.project.toLowerCase());
      if(!s.enabled||row.status==='completed'&&!s.notify_completed||row.status!=='completed'&&!s.notify_errors||excluded){
        this.db.prepare("UPDATE native_notification_events SET delivery_state=? WHERE id=?").run(excluded?'filtered':'disabled',row.id);continue;
      }
      const payload=notificationPayload(row,s);
      if(s.play_sound&&this.lastSoundAt){const wait=Math.max(0,1200-(Date.now()-this.lastSoundAt));if(wait)await new Promise(resolve=>setTimeout(resolve,wait));}
      let result:DeliveryResult;try{result=await this.runner(payload.title,payload.body,s.play_sound?s.sound:undefined);}catch{result={ok:false,code:'delivery_failed'};}
      if(s.play_sound)this.lastSoundAt=Date.now();
      this.db.prepare('UPDATE native_notification_events SET delivery_state=?,error_code=? WHERE id=?').run(result.ok?'delivered':'failed',result.ok?null:result.code,row.id);
    }
  }
  async close(){this.closed=true;await this.dispatching;}
}

export function safeTaskTitle(value:unknown):string|null{
  if(typeof value!=='string')return null;
  let title=value.replace(/```[\s\S]*?```/g,' ').replace(/`[^`]*`/g,' ')
    .replace(/https?:\/\/\S+/gi,' ').replace(/(?:[A-Za-z]:\\|\/)[\w .@+~-]+(?:[\\/][\w .@+~-]+)*/g,' ')
    .replace(/\b[\w.@~-]+(?:\/[\w.@~-]+)*\.(?:ts|tsx|js|jsx|py|rb|go|rs|java|kt|swift|json|yaml|yml|md|html|css)\b/gi,'[file] ')
    .replace(/\b(api[_ -]?key|access[_ -]?token|password|secret|credential)\s*[:=]\s*[^\s,;]+/gi,'$1: [đã ẩn]')
    .replace(/\b(?:sk-[A-Za-z0-9_-]{12,}|gh[pousr]_[A-Za-z0-9_]{16,})\b/g,'[đã ẩn]')
    .split(/[\r\n]+/)[0]!.replace(/[\t]+/g,' ').replace(/\s+/g,' ').trim();
  const sentence=title.search(/[.!?](?:\s|$)/);if(sentence>=24)title=title.slice(0,sentence+1);
  if((title.match(/[{}<>;`]/g)?.length??0)>4)return null;
  if(!title||title.length<3||/^(?:new chat|new conversation|codex)$/i.test(title))return null;
  return title.length>90?title.slice(0,87).replace(/\s+\S*$/,'')+'…':title;
}
function notificationPayload(turn:StoredTurn,settings:NotificationSettings){
  if(turn.status==='failed')return {title:`Thưa sếp, Codex ở ${turn.project} gặp lỗi!`,body:'Một lượt xử lý thất bại. Vui lòng kiểm tra.'};
  if(turn.status==='cancelled')return {title:`Thưa sếp, Codex ở ${turn.project} đã dừng lượt.`,body:'Một lượt xử lý đã bị hủy.'};
  if(settings.privacy_mode==='preview'&&turn.task_title)return {title:`Thưa sếp, ${turn.project} vừa xong một lượt!`,body:`Yêu cầu: ${turn.task_title}`};
  return {title:`Thưa sếp, Codex ở ${turn.project} đã phản hồi!`,body:'Một lượt xử lý vừa hoàn tất.'};
}
function deliverAppleNotification(title:string,body:string,sound?:NotificationSound):Promise<DeliveryResult>{
  if(process.platform!=='darwin')return Promise.resolve({ok:false,code:'unsupported_platform'});
  return new Promise(resolve=>{
    let settled=false;const finish=(result:DeliveryResult)=>{if(settled)return;settled=true;clearTimeout(timer);resolve(result);};
    const child=spawn('/usr/bin/osascript',['-e',appleScript,title,body,...(sound?[sound]:[])],{stdio:'ignore',windowsHide:true});
    const timer=setTimeout(()=>{child.kill('SIGTERM');finish({ok:false,code:'osascript_timeout'});},10_000);
    child.once('error',error=>finish({ok:false,code:(error as NodeJS.ErrnoException).code==='ENOENT'?'osascript_unavailable':'spawn_failed'}));
    child.once('exit',code=>finish(code===0?{ok:true}:{ok:false,code:'osascript_failed'}));
  });
}
