import { randomUUID, createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import type { ProviderUsage as Usage } from './provider-types.js';
import { ApiError } from './errors.js';
import type { Config } from './config.js';
import { Workflows } from './workflows.js';

import {codexCapabilities,providerCapabilities,type ProviderId,type ProviderTiming,type CliLifecycleTiming} from './provider-types.js';
export const capabilities=codexCapabilities;
export interface BenchmarkTag {batch_id:string;phase:'warmup'|'measured';iteration:number;scenario:string}
export interface ActivityEvent {
  version: 1; run_id: string; call_id: string; seq: number; type: string;
  timestamp: number; elapsed_ms: number; source: 'gateway_observed' | 'provider_reported' | 'client_reported'; payload: Record<string, unknown>;
}
type Listener = (event: ActivityEvent) => void;
export type RunStatus = 'queued' | 'running' | 'completed' | 'failed' | 'cancelled' | 'interrupted';
export class ActivityRun {
  readonly started = performance.now();
  readonly createdAt = Date.now();
  readonly controller = new AbortController();
  status: RunStatus = 'running';
  seq = 0;
  events: ActivityEvent[] = [];
  bytes = 0;
  output = '';
  listeners = new Set<Listener>();
  providerStarted: number | null = null;
  providerFinished: number | null = null;
  firstOutput: number | null = null;
  lastOutput: number | null = null;
  firstSent: number | null = null;
  responseFinished: number | null = null;
  duration: number | null = null;
  outputUpdates = 0;
  queuedAt:number|null=null;
  dequeuedAt:number|null=null;
  samples:{index:number;seq:number;elapsed_ms:number;bytes:number;characters:number;tokens:number|null;kind:'output'|'usage'}[]=[];
  sampleCount=0;
  gaps:number[]=[];
  gapCount=0;
  outputBytes = 0;
  outputChars = 0;
  usage: Usage | null = null;
  timing:ProviderTiming={};
  cliLifecycle:CliLifecycleTiming|null=null;
  error: string | null = null;
  cancelReason: 'explicit' | 'disconnect' | 'timeout' | 'shutdown' | null = null;
  constructor(readonly id: string, readonly owner: string, readonly model: string,
    readonly ephemeral: boolean, readonly store: Activities, readonly acceptedAt: number, queued=false,readonly provider:ProviderId='codex',readonly benchmark?:BenchmarkTag) { if(queued){this.status='queued';this.queuedAt=this.elapsed();} }
  get active() {return this.status==='running'||this.status==='queued';}
  dequeue() {if(this.status==='queued'){this.status='running';this.dequeuedAt=this.elapsed();this.emit('run.dequeued');}}
  private sample(kind:'output'|'usage') {
    this.samples.push({index:++this.sampleCount,seq:this.seq+1,elapsed_ms:this.elapsed(),bytes:this.outputBytes,characters:this.outputChars,tokens:this.usage?.output_tokens??null,kind});
    if(this.samples.length>256)this.samples.splice(1,1);
  }
  reportUsage(usage:Usage) {if(JSON.stringify(this.usage)===JSON.stringify(usage))return;this.usage=usage;this.sample('usage');this.emit('usage.updated',{usage,sample:this.samples.at(-1)},'provider_reported');}
  reportTiming(timing:ProviderTiming) {if(JSON.stringify({...this.timing,...timing})===JSON.stringify(this.timing))return;this.timing={...this.timing,...timing};this.emit('provider.timing',{timing:this.timing},'provider_reported');}
  elapsed() { return performance.now() - this.acceptedAt; }
  snapshot() {
    const metric = (input: number | null, unit: string, source: string, reason: string | null = null) => {const value=input!==null&&Number.isFinite(input)?input:null;return {value,unit,source,reason:value===null?reason??'Metric unavailable.':null};};
    return { run_id: this.id, call_id: this.id, model: this.model, provider: this.provider, status: this.status,...(this.benchmark?{benchmark:this.benchmark}:{}),
      workflow:this.store.workflows.snapshot(this.id),history:{samples:[...this.samples],sample_count:this.sampleCount,truncated:this.sampleCount>this.samples.length,available:true},
      created_at: this.createdAt, seq: this.seq, ephemeral: this.ephemeral, error_code: this.error, capabilities:providerCapabilities(this.provider),
      timeline: { received: 0, enqueued:this.queuedAt,dequeued:this.dequeuedAt, provider_started: this.providerStarted, first_output: this.firstOutput,
        last_output: this.lastOutput, provider_finished: this.providerFinished, first_content_sent: this.firstSent, finished: this.duration, response_finished: this.responseFinished },
      metrics: {
        queue_wait:metric(this.queuedAt!==null&&this.dequeuedAt!==null?this.dequeuedAt-this.queuedAt:null,'ms','gateway_observed',this.queuedAt===null?'Request did not enter a queue.':'Request has not been dequeued.'),
        inter_chunk_latency:metric(this.gaps.length?this.gaps.reduce((a,b)=>a+b,0)/this.gaps.length:null,'ms','gateway_observed','Requires at least two non-empty public content updates.'),
        inter_chunk_p50:metric(percentile(this.gaps,.5),'ms','derived','Requires at least two non-empty public content updates.'),
        inter_chunk_p95:metric(percentile(this.gaps,.95),'ms','derived','Requires at least two non-empty public content updates.'),
        inter_chunk_samples:{value:this.gaps.length,total_observed:this.gapCount,window:'last_512_gaps',unit:'gaps',source:'gateway_observed'},
        ttfo: metric(this.firstOutput, 'ms', 'gateway_observed', 'No public content observed.'),
        first_content_sent: metric(this.firstSent, 'ms', 'gateway_observed', 'No streaming content written.'),
        ttft: metric(this.timing.ttft_ms??null, 'ms', 'provider_reported', 'Provider does not report first-token timing.'),
        generation_duration:metric(this.timing.generation_duration_ms??null,'ms','provider_reported','No provider generation duration.'),
        provider_load_duration:metric(this.timing.load_duration_ms??null,'ms','provider_reported','Provider did not report load duration.'),
        provider_prompt_duration:metric(this.timing.prompt_duration_ms??null,'ms','provider_reported','Provider did not report prompt duration.'),
        output_tokens_per_second:{...metric(this.timing.tokens_per_second??(this.usage&&this.timing.generation_duration_ms&&this.timing.generation_duration_ms>0?this.usage.output_tokens/(this.timing.generation_duration_ms/1000):null),'tokens/s',this.timing.tokens_per_second!==undefined?'provider_reported':'derived','No actual generation duration/rate reported.'),scope:'provider_generated_may_include_reasoning',basis:'provider_reported_count_and_duration'},
        output_tokens_per_e2e_second: metric(this.usage && this.duration && this.duration > 0 ? this.usage.output_tokens / (this.duration / 1000) : null,
          'tokens/s', 'derived', 'Requires final usage and elapsed duration; includes reasoning.'),
        output_tokens: metric(this.usage?.output_tokens ?? null, 'tokens', 'provider_reported', 'Final usage not reported yet.'),
        cli_lifecycle:this.cliLifecycle?{...this.cliLifecycle,unit:'ms',origin:'provider.run start',source:'gateway_observed'}:null,
        output_bytes: metric(this.outputBytes, 'bytes', 'gateway_observed'),
        output_characters: metric(this.outputChars, 'characters', 'gateway_observed'),
        output_updates: metric(this.outputUpdates, 'updates', 'gateway_observed'),
        duration: metric(this.duration, 'ms', 'gateway_observed', 'Run is still active.'),
      } };
  }
  emit(type: string, payload: Record<string, unknown> = {}, source: ActivityEvent['source'] = 'gateway_observed') {
    if (!this.active && !type.startsWith('run.') && !type.startsWith('workflow.') && !type.startsWith('stage.')) return;
    const event: ActivityEvent = {version: 1, run_id: this.id, call_id: this.id, seq: ++this.seq,
      type, timestamp: Date.now(), elapsed_ms: this.elapsed(), source, payload};
    if(type.startsWith('run.')||type.startsWith('provider.'))event.payload={...payload,metadata:this.snapshot()};
    this.events.push(event); this.bytes += Buffer.byteLength(JSON.stringify(event));
    while (this.events.length > 512 || this.bytes > 1_048_576) {
      this.bytes -= Buffer.byteLength(JSON.stringify(this.events.shift()!));
    }
    this.store.save(this);
    for (const listener of this.listeners) listener(event);
    this.store.notify(this.id,event);this.store.broadcast(this, event);
  }
  content(text: string) {
    if (this.status !== 'running' || text === this.output) return;
    if (Buffer.byteLength(text) > 1_048_576) throw new ApiError(502, 'output_limit', 'Public output exceeds the live output limit.');
    const append = text.startsWith(this.output), delta = text.slice(this.output.length);
    this.output = text;
    this.outputBytes = Buffer.byteLength(text); this.outputChars = [...text].length;
    if (text) {const now=this.elapsed();if(this.lastOutput!==null){this.gaps.push(now-this.lastOutput);this.gapCount++;if(this.gaps.length>512)this.gaps.shift();} this.firstOutput ??= now; this.lastOutput = now; }
    this.outputUpdates++;this.sample('output');
    this.emit(append ? 'output.delta' : 'output.replaced', {...(append ? {delta} : {text}),sample:this.samples.at(-1),metrics:this.snapshot().metrics,timeline:this.snapshot().timeline});
  }
  sent() { this.firstSent ??= this.elapsed(); this.store.save(this); }
  cancel(reason: NonNullable<ActivityRun['cancelReason']>) {
    if (!this.active) return;
    this.cancelReason ??= reason; this.controller.abort();
  }
  finish(status: Exclude<RunStatus, 'queued' | 'running' | 'interrupted'>, code: string | null = null, result?: unknown, validated = true) {
    if (!this.active) return;
    this.status = status; this.duration = this.elapsed(); this.error = code;
    this.emit(`run.${status}`, { status, error_code: code, partial: status !== 'completed' && this.outputUpdates > 0, ...(result === undefined ? {} : {result,validated}) });
    if (this.ephemeral) { this.output = ''; this.events = []; this.bytes = 0; }
  }
}

export class Activities {
  private db: DatabaseSync;
  private runs = new Map<string, ActivityRun>();
  private feed: { cursor: number; event: ActivityEvent }[] = [];
  private feedSeq = 0;
  private feedBytes=0;
  readonly epoch = randomUUID();
  readonly listeners = new Set<(cursor: string, event: ActivityEvent) => void>();
  private timer: ReturnType<typeof setInterval>;
  readonly workflows:Workflows;
  private subscribers=new Map<string,Set<Listener>>();
  private workflowLogs=new Map<string,{events:ActivityEvent[];bytes:number;updated:number}>();
  constructor(config: Config) {
    this.db = new DatabaseSync(config.statsDbPath);
    this.db.exec(`PRAGMA busy_timeout=3000;
      CREATE TABLE IF NOT EXISTS gateway_runs (
        id TEXT PRIMARY KEY, owner TEXT NOT NULL, created_at INTEGER NOT NULL,
        status TEXT NOT NULL, metadata TEXT NOT NULL, idempotency TEXT, request_hash TEXT,
        UNIQUE(owner,idempotency)
      ) STRICT;
      CREATE INDEX IF NOT EXISTS gateway_runs_created ON gateway_runs(created_at DESC);
      CREATE INDEX IF NOT EXISTS gateway_runs_status_created ON gateway_runs(status,created_at DESC);`);
    this.workflows=new Workflows(this.db,config.inspectorSecrets);
    for (const row of this.db.prepare("SELECT id,metadata FROM gateway_runs WHERE status IN ('running','queued')").all()) {
      const meta = JSON.parse(String(row.metadata)); meta.status = 'interrupted'; meta.error_code = 'server_restarted';
      this.db.prepare('UPDATE gateway_runs SET status=?,metadata=? WHERE id=?').run('interrupted', JSON.stringify(meta), String(row.id));
    }
    this.timer = setInterval(() => this.purge(), 30_000); this.timer.unref();
  }
  purge() {
    this.workflows.purge();
    for(const [id,log] of this.workflowLogs)if(Date.now()-log.updated>600_000)this.workflowLogs.delete(id);
    for (const [id, run] of this.runs) if (!run.active && Date.now() - run.createdAt > 600_000) {
      this.runs.delete(id);this.workflows.forget(id); run.events = []; run.output = ''; run.bytes = 0;
    }
  }
  create(id: string, owner: string, model: string, ephemeral: boolean, acceptedAt: number, key?: string, hash?: string, queued=false,provider:ProviderId='codex',benchmark?:BenchmarkTag) {
    this.purge();
    while (this.runs.size >= 128) {
      const old = [...this.runs.values()].find(r => !r.active);
      if (!old) throw new ApiError(429, 'run_limit', 'Too many active runs.');
      this.runs.delete(old.id);this.workflows.forget(old.id); old.events = []; old.output = '';
    }
    const run = new ActivityRun(id, owner, model, ephemeral, this, acceptedAt,queued,provider,benchmark);
    this.db.prepare('INSERT INTO gateway_runs(id,owner,created_at,status,metadata,idempotency,request_hash) VALUES(?,?,?,?,?,?,?)')
      .run(id, owner, run.createdAt, run.status, JSON.stringify(run.snapshot()), key ? digest(key) : null, hash ?? null);
    this.runs.set(id, run); run.emit('run.accepted', {model, capabilities});if(queued)run.emit('run.queued'); return run;
  }
  duplicate(owner: string, key: string, hash: string) {
    const row = this.db.prepare('SELECT id,request_hash FROM gateway_runs WHERE owner=? AND idempotency=?').get(owner, digest(key));
    if (!row) return null;
    if (row.request_hash !== hash) throw new ApiError(409, 'idempotency_conflict', 'Idempotency key already belongs to a different request.');
    return this.snapshot(String(row.id), owner, false);
  }
  authorize(id: string, owner: string, admin: boolean) {
    const row = this.db.prepare('SELECT owner,metadata FROM gateway_runs WHERE id=?').get(id);
    if (!row || !admin && row.owner !== owner) throw new ApiError(404, 'run_not_found', 'Run not found.');
    return row;
  }
  snapshot(id: string, owner: string, admin: boolean) {
    this.purge();
    const row = this.authorize(id, owner, admin), run = this.runs.get(id);
    return {...(run?.snapshot() ?? JSON.parse(String(row.metadata))),workflow:this.workflows.display(id)};
  }
  live(id: string, owner: string, admin: boolean) { this.purge(); this.authorize(id, owner, admin); return this.runs.get(id); }
  list() {
    this.purge();
    const active = this.db.prepare("SELECT metadata FROM gateway_runs WHERE status IN ('running','queued') ORDER BY created_at DESC LIMIT 128").all();
    const recent = this.db.prepare("SELECT metadata FROM gateway_runs WHERE status NOT IN ('running','queued') ORDER BY created_at DESC LIMIT 128").all();
    return [...active,...recent].slice(0,128).map(r => this.summary(JSON.parse(String(r.metadata))));
  }
  save(run: ActivityRun) { this.db.prepare('UPDATE gateway_runs SET status=?,metadata=? WHERE id=?').run(run.status, JSON.stringify(run.snapshot()), run.id); }
  broadcast(run: ActivityRun, event: ActivityEvent) {
    this.broadcastSnapshot(run.snapshot(),event);
  }
  private broadcastSnapshot(snapshot:Record<string,unknown>,event:ActivityEvent) {
    // Cross-run dashboard subscriptions contain metadata only, never output bodies.
    const safe = {...event, type: 'run.updated', payload: this.summary(snapshot)};
    this.feed.push({cursor: ++this.feedSeq, event: safe});this.feedBytes+=Buffer.byteLength(JSON.stringify(safe));
    while (this.feed.length>512 || this.feedBytes>1_048_576)this.feedBytes-=Buffer.byteLength(JSON.stringify(this.feed.shift()!.event));
    for (const listener of this.listeners) listener(`${this.epoch}:${this.feedSeq}`, safe);
  }
  summary<T extends Record<string,unknown>>(snapshot:T) {
    const {history,workflow,...meta}=snapshot;
    const w=workflow as {status?:string;version?:number;stages?:unknown[]}|undefined;
    return {...meta,...(w?{workflow:{status:w.status,version:w.version,source:'client_reported',stage_count:w.stages?.length??0}}:{})};
  }
  subscribe(id:string,listener:Listener) {if(!this.subscribers.has(id))this.subscribers.set(id,new Set());this.subscribers.get(id)!.add(listener);return ()=>{const set=this.subscribers.get(id);set?.delete(listener);if(!set?.size)this.subscribers.delete(id);};}
  notify(id:string,event:ActivityEvent) {for(const listener of this.subscribers.get(id)??[])listener(event);}
  workflow(id:string,owner:string,admin:boolean,input:unknown) {
    const row=this.authorize(id,owner,admin),meta=JSON.parse(String(row.metadata));
    if(meta.ephemeral)throw new ApiError(400,'ephemeral_workflow','Workflow updates require a non-playground run.');
    const result=this.workflows.apply(id,input);
    if(!result.duplicate) {
      const run=this.runs.get(id);
      const payload={...result.event,workflow:this.workflows.display(id)};
      if(run)run.emit(result.event.type,payload,'client_reported');
      else {
        meta.seq=(meta.seq??0)+1;meta.workflow=result.snapshot;
        this.db.prepare('UPDATE gateway_runs SET metadata=? WHERE id=?').run(JSON.stringify(meta),id);
        const event:ActivityEvent={version:1,run_id:id,call_id:id,seq:meta.seq,type:result.event.type,timestamp:Date.now(),elapsed_ms:Math.max(0,Date.now()-meta.created_at),source:'client_reported',payload};
        let log=this.workflowLogs.get(id);
        if(!log){if(this.workflowLogs.size>=128)this.workflowLogs.delete(this.workflowLogs.keys().next().value!);log={events:[],bytes:0,updated:Date.now()};this.workflowLogs.set(id,log);}
        log.updated=Date.now();log.events.push(event);log.bytes+=Buffer.byteLength(JSON.stringify(event));
        while(log.events.length>512||log.bytes>1_048_576)log.bytes-=Buffer.byteLength(JSON.stringify(log.events.shift()!));
        this.notify(id,event);this.broadcastSnapshot(meta,event);
      }
    }
    return {duplicate:result.duplicate,workflow:this.workflows.display(id)};
  }
  workflowReplay(id:string,cursor?:string):ActivityEvent[] {
    if(!cursor)return [];
    const [scope,seq,...extra]=cursor.split(':'),n=Number(seq),log=this.workflowLogs.get(id);
    if(scope!==id||extra.length||!Number.isSafeInteger(n)||!log||n<(log.events[0]?.seq??1)-1||n>(log.events.at(-1)?.seq??0))throw new ApiError(409,'cursor_reset','Workflow cursor expired; reload metadata.');
    return log.events.filter(e=>e.seq>n);
  }
  latency(input:{range:'1h'|'24h'|'7d'|'30d';model?:string;provider?:string;status:string}) {
    const since=Date.now()-({'1h':3_600_000,'24h':86_400_000,'7d':604_800_000,'30d':2_592_000_000}[input.range]);
    const params:(string|number)[]=[since];let where='created_at>=?';
    if(input.model){where+=" AND json_extract(metadata,'$.model')=?";params.push(input.model);}
    if(input.provider){where+=" AND json_extract(metadata,'$.provider')=?";params.push(input.provider);}
    if(input.status!=='all'){where+=' AND status=?';params.push(input.status);}
    const total=Number(this.db.prepare(`SELECT COUNT(*) AS n FROM gateway_runs WHERE ${where}`).get(...params)!.n);
    const rows=this.db.prepare(`SELECT json_extract(metadata,'$.model') AS model,json_extract(metadata,'$.provider') AS provider,
      json_extract(metadata,'$.metrics.duration.value') AS duration,json_extract(metadata,'$.metrics.ttfo.value') AS ttfo,
      json_extract(metadata,'$.metrics.queue_wait.value') AS queue_wait FROM gateway_runs WHERE ${where} ORDER BY created_at DESC LIMIT 100000`).all(...params);
    const summarize=(items:typeof rows)=>{
      const read=(key:string)=>items.map(r=>r[key]).filter((v):v is number=>typeof v==='number'&&Number.isFinite(v));
      const metric=(key:string)=>{const values=read(key);return {p50:percentile(values,.5),p95:percentile(values,.95),sample_count:values.length,unknown_count:items.length-values.length,unit:'ms',source:'gateway_observed',method:'nearest_rank'};};
      return {run_count:items.length,duration:metric('duration'),ttfo:metric('ttfo'),queue_wait:metric('queue_wait')};
    };
    const groups=new Map<string,typeof rows>();for(const row of rows){const key=JSON.stringify([row.provider,row.model]);if(!groups.has(key))groups.set(key,[]);groups.get(key)!.push(row);}
    return {range:input.range,status:input.status,since,until:Date.now(),total_runs:total,truncated:total>rows.length,summary:summarize(rows),groups:[...groups.entries()].map(([key,list])=>{const[provider,model]=JSON.parse(key);return {provider,model,...summarize(list)};})};
  }
  feedReplay(cursor?: string) {
    if (!cursor) return [];
    const [epoch, seq,...extra] = cursor.split(':'), n = Number(seq);
    if (extra.length || epoch !== this.epoch || !Number.isSafeInteger(n) || n < (this.feed[0]?.cursor ?? 1) - 1 || n > this.feedSeq)
      throw new ApiError(409, 'cursor_reset', 'Dashboard cursor expired; reload the run list.');
    return this.feed.filter(e => e.cursor > n).map(e => ({cursor: `${this.epoch}:${e.cursor}`, event: e.event}));
  }
  replay(run: ActivityRun, cursor?: string) {
    if (!cursor) {
      if ((run.events[0]?.seq ?? 1) > 1 || !run.ephemeral && run.seq > 0 && !run.events.length) throw new ApiError(409,'cursor_reset','Initial output has expired; use the run metadata endpoint.');
      return run.events;
    }
    const [id, seq,...extra] = cursor.split(':'), n = Number(seq);
    if (extra.length || id !== run.id || !Number.isSafeInteger(n) || n < (run.events[0]?.seq ?? run.seq + 1) - 1 || n > run.seq)
      throw new ApiError(409, 'cursor_reset', 'Run cursor expired; reload the run snapshot.');
    return run.events.filter(e => e.seq > n);
  }
  close() { clearInterval(this.timer); this.db.close(); }
}
export const digest = (text: string) => createHash('sha256').update(text).digest('hex');

export function percentile(values:number[],fraction:number):number|null {
  if(!values.length)return null;const sorted=[...values].sort((a,b)=>a-b);return sorted[Math.max(0,Math.ceil(sorted.length*fraction)-1)]!;
}
