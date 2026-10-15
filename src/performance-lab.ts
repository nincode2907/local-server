import {DatabaseSync} from 'node:sqlite';
import {createHash,randomUUID} from 'node:crypto';
import {z} from 'zod';
import type {Config} from './config.js';
import {ApiError} from './errors.js';
import type {ActivityRun,BenchmarkTag} from './activity.js';
import {percentile} from './activity.js';
import type {ChatRequest} from './schema.js';
import {chatRequest} from './schema.js';
import {redact} from './inspector.js';
import type {Resources,ResourcePoint} from './resources.js';

export const scenarios=[
  {id:'short-answer',name:'Trả lời ngắn',prompt:'In one sentence, explain why leaves are green.'},
  {id:'structured-list',name:'Danh sách có cấu trúc',prompt:'Give exactly five numbered steps for preparing a cup of tea. Keep each step short.'},
  {id:'reasoning-math',name:'Bài toán ngắn',prompt:'A shop has 24 apples, sells one third, then receives 7 more. How many apples remain? Explain briefly.'},
] as const;
export const batchInput=z.object({
  targets:z.array(z.object({provider:z.enum(['codex','ollama','lmstudio']),model:z.string().min(1).max(128).regex(/^[^\u0000-\u001f]+$/)}).strict()).min(1).max(3),
  scenarios:z.array(z.enum(['short-answer','structured-list','reasoning-math'])).min(1).max(3),
  iterations:z.number().int().min(1).max(20).default(5),warmup:z.number().int().min(0).max(3).default(1),
  concurrency:z.number().int().min(1).max(8).default(1),max_output_tokens:z.number().int().min(8).max(2048).default(128),
  seed:z.number().int().min(0).max(2147483647).default(42),max_duration_ms:z.number().int().min(1000).max(600000).default(120000),
  allow_codex:z.boolean().default(false),
}).strict().superRefine((v,ctx)=>{
  if(new Set(v.scenarios).size!==v.scenarios.length||new Set(v.targets.map(t=>JSON.stringify(t))).size!==v.targets.length)ctx.addIssue({code:'custom',message:'Duplicate target/scenario.'});
  const total=v.targets.length*v.scenarios.length*(v.iterations+v.warmup);
  if(total>120||total*v.max_output_tokens>131072)ctx.addIssue({code:'custom',message:'Batch exceeds request/output-token allowance.'});
});
type Spec=z.infer<typeof batchInput>;
type Status='running'|'cancelling'|'completed'|'cancelled'|'interrupted'|'failed';
const metricKeys=['duration','ttfo','ttft','queue_wait','output_tokens','output_tokens_per_second','output_tokens_per_e2e_second'] as const;
interface Trial {provider:string;model:string;scenario:string;phase:'warmup'|'measured';iteration:number;status:string;run_id:string|null;error_code:string|null;http_status:number|null;started_at:number;finished_at:number;started_elapsed_ms:number;finished_elapsed_ms:number|null;metrics:Record<string,{value:number|null;source:string;unit:string}>;finish_reason:string|null}
export interface Batch {
  id:string;seq:number;created_at:number;finished_at:number|null;elapsed_ms:number;status:Status;spec:Spec;planned_requests:number;
  trials:Trial[];resources:{samples:ResourcePoint[];sample_count:number;truncated:boolean};reason:string|null;
  configuration:{local_temperature:0;codex_sampling:'provider_default_unreported';cache_state:'uncontrolled';load_state:'uncontrolled';sampling_scope:string;codex_output_limit_supported:false};
}
interface Job {started:number;batch:Batch;controller:AbortController;runs:Set<ActivityRun>;done?:Promise<void>}
const hash=(text:string)=>createHash('sha256').update(text).digest('hex');
export class PerformanceLab {
  private db:DatabaseSync;private active?:Job;private lastStart=Number.NEGATIVE_INFINITY;private closed=false;
  readonly listeners=new Map<string,Set<(batch:ReturnType<PerformanceLab['detail']>)=>void>>();
  constructor(private config:Config,private resources:Resources,
    private execute:(request:ChatRequest,tag:BenchmarkTag)=>{run:ActivityRun;result:Promise<unknown>},private validate:(request:ChatRequest)=>unknown) {
    this.db=new DatabaseSync(config.statsDbPath);
    this.db.exec(`PRAGMA busy_timeout=3000;
      CREATE TABLE IF NOT EXISTS lab_batches(id TEXT PRIMARY KEY,created_at INTEGER NOT NULL,status TEXT NOT NULL,metadata TEXT NOT NULL,idempotency TEXT UNIQUE,request_hash TEXT) STRICT;
      CREATE INDEX IF NOT EXISTS lab_created ON lab_batches(created_at DESC);
      CREATE TABLE IF NOT EXISTS lab_daily(day TEXT PRIMARY KEY,reserved INTEGER NOT NULL CHECK(reserved>=0)) STRICT;`);
    for(const row of this.db.prepare("SELECT id,metadata FROM lab_batches WHERE status IN ('running','cancelling')").all()){
      const batch=JSON.parse(String(row.metadata)) as Batch;batch.status='interrupted';batch.reason='server_restarted';batch.finished_at=Date.now();batch.seq++;for(const trial of batch.trials)if(!trial.finished_at){trial.status='interrupted';trial.error_code='server_restarted';trial.finished_at=Date.now();}
      this.db.prepare('UPDATE lab_batches SET status=?,metadata=? WHERE id=?').run(batch.status,JSON.stringify(batch),String(row.id));
    }
    this.db.exec("CREATE UNIQUE INDEX IF NOT EXISTS lab_one_active ON lab_batches((1)) WHERE status IN ('running','cancelling')");
    this.purge();
  }
  private purge() {
    this.db.prepare("DELETE FROM lab_batches WHERE status NOT IN ('running','cancelling') AND (created_at<? OR id IN (SELECT id FROM lab_batches ORDER BY created_at DESC LIMIT -1 OFFSET 100))").run(Date.now()-this.config.labRetentionDays*86400000);
    this.db.prepare('DELETE FROM lab_daily WHERE day<?').run(new Date(Date.now()-31*86400000).toISOString().slice(0,10));
  }
  catalog() {return {scenarios:scenarios.map(({id,name})=>({id,name})),limits:{max_requests:120,max_output_token_allowance:131072,max_concurrency:8,max_duration_ms:600000,daily_requests:this.config.labDailyLimit,retention_days:this.config.labRetentionDays},codex_enabled:this.config.labAllowCodex,active_batch:this.active?.batch.id??null};}
  request(spec:Spec,target:Spec['targets'][number],scenario:string):ChatRequest {
    return chatRequest.parse({provider:target.provider,model:target.model,messages:[{role:'user',content:scenarios.find(s=>s.id===scenario)!.prompt}],stream:true,...(target.provider==='codex'?{}:{temperature:0,max_tokens:spec.max_output_tokens,seed:spec.seed})});
  }
  start(input:unknown,key?:string) {
    this.purge();const spec=batchInput.parse(input),requestHash=hash(JSON.stringify(spec));
    if(spec.targets.some(t=>redact(t.model,this.config.inspectorSecrets)!==t.model))throw new ApiError(400,'sensitive_lab_metadata','Do not put credentials in benchmark metadata.');
    if(key){const row=this.db.prepare('SELECT id,request_hash FROM lab_batches WHERE idempotency=?').get(hash(key));if(row){if(row.request_hash!==requestHash)throw new ApiError(409,'idempotency_conflict','Batch key belongs to different settings.');return {batch:this.detail(String(row.id)),reused:true};}}
    if(this.closed)throw new ApiError(503,'server_shutdown','Server is shutting down.');
    if(this.active)throw new ApiError(409,'lab_busy','Another benchmark batch is active.');
    if(performance.now()-this.lastStart<this.config.labMinInterval)throw new ApiError(429,'lab_rate_limit','Wait before starting another batch.');
    if(spec.targets.some(t=>t.provider==='codex')&&(!this.config.labAllowCodex||!spec.allow_codex))throw new ApiError(403,'codex_benchmark_disabled','Codex benchmarks require server opt-in and explicit batch acknowledgement.');
    if(spec.targets.some(t=>t.provider==='codex')&&(spec.targets.length*spec.scenarios.length*(spec.iterations+spec.warmup)>10||spec.max_duration_ms>60000))throw new ApiError(400,'codex_benchmark_limit','Codex batch limit: 10 requests, 60 seconds; token limit is unavailable.');
    for(const target of spec.targets)this.validate(this.request(spec,target,spec.scenarios[0]!));
    this.purge();
    const batch:Batch={id:randomUUID(),seq:0,created_at:Date.now(),finished_at:null,elapsed_ms:0,status:'running',spec,planned_requests:spec.targets.length*spec.scenarios.length*(spec.iterations+spec.warmup),trials:[],resources:{samples:[],sample_count:0,truncated:false},reason:null,configuration:{local_temperature:0,codex_sampling:'provider_default_unreported',cache_state:'uncontrolled',load_state:'uncontrolled',sampling_scope:'Same fixed fixtures; providers differ in prompt templates, reasoning and supported options.',codex_output_limit_supported:false}};
    const day=new Date().toISOString().slice(0,10);this.db.exec('BEGIN IMMEDIATE');
    try {
      const reserved=Number(this.db.prepare('SELECT reserved FROM lab_daily WHERE day=?').get(day)?.reserved??0);
      if(reserved+batch.planned_requests>this.config.labDailyLimit)throw new ApiError(429,'lab_daily_budget','Daily benchmark request allowance exceeded.');
      this.db.prepare('INSERT INTO lab_batches VALUES(?,?,?,?,?,?)').run(batch.id,batch.created_at,batch.status,JSON.stringify(batch),key?hash(key):null,requestHash);
      this.db.prepare('INSERT INTO lab_daily VALUES(?,?) ON CONFLICT(day) DO UPDATE SET reserved=excluded.reserved').run(day,reserved+batch.planned_requests);this.db.exec('COMMIT');
    }catch(error){this.db.exec('ROLLBACK');throw error;}
    const job:Job={started:performance.now(),batch,controller:new AbortController(),runs:new Set()};this.active=job;this.lastStart=performance.now();
    job.done=this.run(job);void job.done.catch(()=>{});return {batch:this.detail(batch.id),reused:false};
  }
  private save(batch:Batch) {if(this.active?.batch===batch)batch.elapsed_ms=performance.now()-this.active.started;batch.seq++;this.db.prepare('UPDATE lab_batches SET status=?,metadata=? WHERE id=?').run(batch.status,JSON.stringify(batch),batch.id);const data=this.detail(batch.id,false);for(const listener of this.listeners.get(batch.id)??[])listener(data);}
  private collect(batch:Batch) {const point=this.resources.snapshot().latest;if(!point||batch.resources.samples.at(-1)?.timestamp===point.timestamp)return;batch.resources.sample_count++;batch.resources.samples.push({...point,processes:point.processes.slice(0,16)});if(batch.resources.samples.length>120){batch.resources.samples.splice(1,1);batch.resources.truncated=true;}}
  private async run(job:Job) {
    const {batch,controller}=job;const deadline=setTimeout(()=>this.stop(batch.id,'time_budget'),batch.spec.max_duration_ms);
    const resourceTimer=setInterval(()=>{this.collect(batch);this.save(batch);},1000);resourceTimer.unref();
    const trial=async(target:Spec['targets'][number],scenario:string,phase:'warmup'|'measured',iteration:number)=>{
      if(controller.signal.aborted)return;
      const entry:Trial={...target,scenario,phase,iteration,status:'running',run_id:null,error_code:null,http_status:null,started_at:Date.now(),finished_at:0,started_elapsed_ms:performance.now()-job.started,finished_elapsed_ms:null,metrics:{},finish_reason:null};batch.trials.push(entry);
      let run:ActivityRun|undefined;
      try {
        const execution=this.execute(this.request(batch.spec,target,scenario),{batch_id:batch.id,scenario,phase,iteration});run=execution.run;entry.run_id=run.id;job.runs.add(run);this.save(batch);
        const result=await execution.result as {choices?:{finish_reason?:string}[]};entry.http_status=200;entry.finish_reason=result.choices?.[0]?.finish_reason??null;
      }catch(error){entry.http_status=error instanceof ApiError?error.status:502;entry.error_code=error instanceof ApiError?error.code:'benchmark_error';if(!run)entry.status=error instanceof ApiError&&error.status===429?'rejected':'failed';}
      finally {
        if(run){job.runs.delete(run);entry.status=run.status;entry.error_code=run.error;const snapshot=run.snapshot();for(const key of metricKeys){const m=snapshot.metrics[key];entry.metrics[key]={value:m.value,source:m.source,unit:m.unit};}}
        entry.finished_at=Date.now();entry.finished_elapsed_ms=performance.now()-job.started;
        if(target.provider!=='codex'&&run?.usage&&run.usage.output_tokens>batch.spec.max_output_tokens)this.stop(batch.id,'provider_output_budget_exceeded');
        this.collect(batch);this.save(batch);
      }
    };
    try {
      this.collect(batch);
      for(const target of batch.spec.targets)for(const scenario of batch.spec.scenarios){
        for(let i=0;i<batch.spec.warmup&&!controller.signal.aborted;i++)await trial(target,scenario,'warmup',i);
        let next=0;await Promise.all(Array.from({length:batch.spec.concurrency},async()=>{while(!controller.signal.aborted){const i=next++;if(i>=batch.spec.iterations)return;await trial(target,scenario,'measured',i);}}));
        if(controller.signal.aborted)break;
      }
      batch.status=controller.signal.aborted?'cancelled':'completed';
    }catch {batch.status='failed';batch.reason='benchmark_error';for(const run of job.runs)run.cancel('explicit');}
    finally {clearTimeout(deadline);clearInterval(resourceTimer);batch.finished_at=Date.now();this.collect(batch);this.save(batch);this.active=undefined;}
  }
  stop(id:string,reason='explicit') {
    const batch=this.detail(id);if(this.active?.batch.id===id&&!this.active.controller.signal.aborted){this.active.batch.status='cancelling';this.active.batch.reason=reason;this.active.controller.abort();for(const run of this.active.runs)run.cancel(reason==='shutdown'?'shutdown':'explicit');this.save(this.active.batch);}return this.detail(batch.id);
  }
  detail(id:string,prune=true) {if(prune)this.purge();const row=this.db.prepare('SELECT metadata FROM lab_batches WHERE id=?').get(id);if(!row)throw new ApiError(404,'batch_not_found','Benchmark batch not found.');const batch=JSON.parse(String(row.metadata)) as Batch;return {...batch,summary:this.summary(batch)};}
  list() {this.purge();return this.db.prepare('SELECT id FROM lab_batches ORDER BY created_at DESC LIMIT 100').all().map(row=>{const b=this.detail(String(row.id),false);return {id:b.id,status:b.status,created_at:b.created_at,finished_at:b.finished_at,planned_requests:b.planned_requests,trial_count:b.trials.length,summary:b.summary};});}
  private summary(batch:Batch) {
    const measured=batch.trials.filter(t=>t.phase==='measured'),groups=new Map<string,Trial[]>();
    for(const target of batch.spec.targets)for(const scenario of batch.spec.scenarios)groups.set(JSON.stringify([target.provider,target.model,scenario]),[]);
    for(const trial of measured)groups.get(JSON.stringify([trial.provider,trial.model,trial.scenario]))!.push(trial);
    return {known_output_tokens:batch.trials.reduce((n,t)=>n+(t.metrics.output_tokens?.value??0),0),unknown_output_usage_trials:batch.trials.filter(t=>t.metrics.output_tokens?.value===undefined||t.metrics.output_tokens.value===null).length,warmup_count:batch.trials.length-measured.length,attempted:batch.trials.length,unstarted:batch.planned_requests-batch.trials.length,groups:[...groups.entries()].map(([key,trials])=>{
      const [provider,model,scenario]=JSON.parse(key);const complete=trials.filter(t=>t.finished_at>0),wall=trials.length&&batch.status!=='interrupted'?Math.max(0,(trials.some(t=>!t.finished_at)?batch.elapsed_ms:Math.max(...complete.map(t=>t.finished_elapsed_ms??0)))-Math.min(...trials.map(t=>t.started_elapsed_ms))):null;
      const counts={completed:0,failed:0,cancelled:0,rejected:0,running:0,interrupted:0,timeouts:0,provider_rate_limited:0,length_limited:0};for(const t of trials){if(t.status in counts)counts[t.status as keyof typeof counts]++;if(t.finish_reason==='length')counts.length_limited++;if(t.error_code==='local_provider_rate_limit')counts.provider_rate_limited++;if(t.error_code?.includes('timeout'))counts.timeouts++;}
      const metrics=Object.fromEntries(metricKeys.map(key=>{const values=complete.map(t=>t.metrics[key]?.value).filter((v):v is number=>typeof v==='number'&&Number.isFinite(v));return [key,{p50:percentile(values,.5),p95:percentile(values,.95),sample_count:values.length,unknown_count:complete.length-values.length,cohort:'all_terminal_attempts',method:'nearest_rank'}];}));
      return {provider,model,scenario,counts,metrics,window_ms:wall,attempt_count:trials.length,success_requests_per_second:wall&&wall>0?counts.completed/(wall/1000):null,terminal_runs_per_second:wall&&wall>0?complete.filter(t=>t.run_id).length/(wall/1000):null,source:'derived',warmup_excluded:true,cache_state:'uncontrolled',load_state:batch.spec.warmup?'after_warmup_not_verified_warm':'initial_uncontrolled'};
    })};
  }
  subscribe(id:string,listener:(batch:ReturnType<PerformanceLab['detail']>)=>void) {if(!this.listeners.has(id))this.listeners.set(id,new Set());this.listeners.get(id)!.add(listener);return ()=>{const set=this.listeners.get(id);set?.delete(listener);if(!set?.size)this.listeners.delete(id);};}
  csv(id:string) {const batch=this.detail(id),cell=(value:unknown)=>{const text=value===null||value===undefined?'':String(value);return '"'+(/^[=+\-@\t\r]/.test(text)?"'":'')+text.replaceAll('"','""')+'"';};const columns=['provider','model','scenario','phase','iteration','status','run_id','error_code','http_status','started_at','finished_at',...metricKeys];return [columns.map(cell).join(','),...batch.trials.map(t=>columns.map(k=>cell(k in t?t[k as keyof Trial]:t.metrics[k]?.value)).join(','))].join('\r\n');}
  async close() {this.closed=true;if(this.active){this.stop(this.active.batch.id,'shutdown');await this.active?.done;}this.db.close();}
}
