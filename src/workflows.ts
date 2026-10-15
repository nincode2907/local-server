import { createHash } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { z } from 'zod';
import { ApiError } from './errors.js';
import { redact } from './inspector.js';

const state = z.enum(['running','completed','failed','cancelled']);
const safeText = z.string().max(240).regex(/^[^\r\n\u0000-\u001f]*$/);
export const workflowEvent = z.object({
  event_id:z.uuid(),
  type:z.enum(['workflow.started','workflow.completed','workflow.failed','workflow.cancelled','stage.started','stage.progress','stage.completed','stage.failed','stage.cancelled']),
  stage_id:z.string().regex(/^[a-zA-Z][a-zA-Z0-9_.-]{0,63}$/).optional(),
  label:safeText.max(80).optional(),message:safeText.optional(),
  progress:z.object({completed:z.number().int().min(0).max(1_000_000_000),total:z.number().int().min(1).max(1_000_000_000)}).strict().refine(v=>v.completed<=v.total).optional(),
}).strict().superRefine((e,ctx)=>{
  if (e.type.startsWith('stage.') !== Boolean(e.stage_id)) ctx.addIssue({code:'custom',message:'stage_id is required only for stage events.'});
  if(e.type==='stage.progress' && !e.progress)ctx.addIssue({code:'custom',message:'Progress counters are required.'});
  if (e.progress && !e.stage_id) ctx.addIssue({code:'custom',message:'Only stages accept work-unit progress.'});
});
export type WorkflowEvent = z.infer<typeof workflowEvent>;
export interface WorkflowStage {id:string;status:z.infer<typeof state>;started_at:number;finished_at:number|null;progress:{completed:number;total:number}|null}
export interface WorkflowSnapshot {status:'idle'|z.infer<typeof state>;version:number;source:'client_reported';started_at:number|null;finished_at:number|null;stages:WorkflowStage[]}
const idle = ():WorkflowSnapshot => ({status:'idle',version:0,source:'client_reported',started_at:null,finished_at:null,stages:[]});
const hash = (text:string) => createHash('sha256').update(text).digest('hex');
export class Workflows {
  // Free text never enters SQLite; clear/evict it with the associated RAM run.
  private text = new Map<string,{updated:number;values:Map<string,{label?:string;message?:string}>}>();
  constructor(private db:DatabaseSync,private secrets:string[]) {
    db.exec(`CREATE TABLE IF NOT EXISTS gateway_workflows (
      run_id TEXT PRIMARY KEY,status TEXT NOT NULL,metadata TEXT NOT NULL
    ) STRICT;
    CREATE TABLE IF NOT EXISTS gateway_workflow_events (
      run_id TEXT NOT NULL,event_hash TEXT NOT NULL,payload_hash TEXT NOT NULL,accepted_at INTEGER NOT NULL,
      PRIMARY KEY(run_id,event_hash)
    ) STRICT;
    CREATE INDEX IF NOT EXISTS workflow_event_time ON gateway_workflow_events(run_id,accepted_at);`);
  }
  snapshot(id:string):WorkflowSnapshot {
    const row=this.db.prepare('SELECT metadata FROM gateway_workflows WHERE run_id=?').get(id);
    return row ? JSON.parse(String(row.metadata)) : idle();
  }
  display(id:string) {const value=this.snapshot(id),text=this.text.get(id)?.values;return {...value,stages:value.stages.map(s=>({...s,...text?.get(s.id)})),...text?.get('$workflow')};}
  purge() {for(const[id,text]of this.text)if(Date.now()-text.updated>600_000)this.text.delete(id);}
  forget(id:string) {this.text.delete(id);}
  apply(id:string,input:unknown) {
    const event=workflowEvent.parse(input), eventHash=hash(event.event_id),payloadHash=hash(JSON.stringify(event)),now=Date.now();
    const duplicate=this.db.prepare('SELECT payload_hash FROM gateway_workflow_events WHERE run_id=? AND event_hash=?').get(id,eventHash);
    if(duplicate) {if(duplicate.payload_hash!==payloadHash)throw new ApiError(409,'workflow_event_conflict','Event ID already belongs to another payload.');return {duplicate:true,event,snapshot:this.snapshot(id)};}
    const counts=this.db.prepare('SELECT COUNT(*) AS total,SUM(accepted_at>=?) AS recent FROM gateway_workflow_events WHERE run_id=?').get(now-60_000,id)!;
    if(Number(counts.total)>=512 || Number(counts.recent)>=60)throw new ApiError(429,'workflow_rate_limit','Workflow event limit reached (60/minute, 512/run).');
    const current=this.snapshot(id);
    const invalid=()=>{throw new ApiError(409,'workflow_transition','Invalid workflow/stage transition.');};
    if(current.status!=='idle' && current.status!=='running')invalid();
    if(event.type==='workflow.started') {if(current.status!=='idle')invalid();current.status='running';current.started_at=now;}
    else {
      if(current.status!=='running')invalid();
      if(event.stage_id) {
        let stage=current.stages.find(s=>s.id===event.stage_id);
        if(event.type==='stage.started') {
          if(stage || current.stages.length>=32)invalid();
          stage={id:event.stage_id,status:'running',started_at:now,finished_at:null,progress:null};current.stages.push(stage);
        } else if(!stage || stage.status!=='running')invalid();
        if(!stage) return invalid();
        if(event.progress) {
          if(stage.progress && (event.progress.completed<stage.progress.completed || event.progress.total<stage.progress.total))invalid();
          stage.progress=event.progress;
        }
        if(event.type!=='stage.started' && event.type!=='stage.progress') {
          stage.status=event.type.slice(6) as WorkflowStage['status'];stage.finished_at=now;
          if(stage.status==='completed' && stage.progress && stage.progress.completed!==stage.progress.total)invalid();
        }
      } else {
        const next=event.type.slice(9) as WorkflowSnapshot['status'];
        if(next==='completed' && current.stages.some(s=>s.status!=='completed'))invalid();
        current.status=next;current.finished_at=now;
        if(next!=='completed')for(const stage of current.stages)if(stage.status==='running'){stage.status=next as WorkflowStage['status'];stage.finished_at=now;}
      }
    }
    current.version++;
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.db.prepare('INSERT INTO gateway_workflow_events(run_id,event_hash,payload_hash,accepted_at) VALUES(?,?,?,?)').run(id,eventHash,payloadHash,now);
      this.db.prepare('INSERT INTO gateway_workflows(run_id,status,metadata) VALUES(?,?,?) ON CONFLICT(run_id) DO UPDATE SET status=excluded.status,metadata=excluded.metadata').run(id,current.status,JSON.stringify(current));
      this.db.exec('COMMIT');
    } catch(error) {this.db.exec('ROLLBACK');throw error;}
    if(!this.text.has(id)) {if(this.text.size>=128)this.text.delete(this.text.keys().next().value!);this.text.set(id,{updated:now,values:new Map()});}
    const key=event.stage_id??'$workflow',safe=redact({label:event.label,message:event.message},this.secrets) as {label?:string;message?:string};
    this.text.get(id)!.updated=now;
    this.text.get(id)!.values.set(key,{...this.text.get(id)!.values.get(key),...Object.fromEntries(Object.entries(safe).filter(([,v])=>v!==undefined))});
    return {duplicate:false,event:{...event,label:safe.label,message:safe.message},snapshot:current};
  }
}
