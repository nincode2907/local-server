import { DatabaseSync } from 'node:sqlite';
import { z } from 'zod';
import { ApiError } from './errors.js';

const identifier = z.string().trim().min(1).max(128).regex(/^[a-zA-Z0-9_.:-]+$/);
const score = z.number().min(0).max(10).nullable().optional();
export const qualitySchema = z.object({ clarity:score, visual:score, motion:score, originality:score, wow:score, technical:score, overall:score }).strict();
export const videoManifest = z.object({
  version:z.literal(1),
  build:z.object({
    id:identifier, title:z.string().trim().min(1).max(240), type:z.string().trim().min(1).max(80),
    engine:z.enum(['remotion','manim','ffmpeg','hybrid']), duration:z.number().min(0).max(86400),
    aspect_ratio:z.string().regex(/^[1-9]\d{0,3}:[1-9]\d{0,3}$/), status:z.enum(['planned','preview','approved','final']),
    revisions:z.number().int().min(0).max(10000), preview_path:z.string().max(4096).nullable().default(null),
    final_path:z.string().max(4096).nullable().default(null), created_at:z.number().int().nonnegative().optional(),
    quality:qualitySchema.default({})
  }).strict(),
  stages:z.array(z.object({
    id:identifier.optional(), stage:z.enum(['PLAN','BUILD','REVISE','FINISH']), session_id:identifier.nullable().default(null),
    model:z.string().trim().max(128).default(''), notes:z.string().max(4000).default(''), approved:z.boolean().default(false),
    approved_at:z.number().int().nonnegative().nullable().optional(),
    turn_ids:z.array(z.string().min(1).max(300).regex(/^[a-zA-Z0-9_.:-]+$/)).min(1).max(500).optional()
  }).strict()).max(200)
}).strict();
type Manifest = z.infer<typeof videoManifest>;
type Stage = Manifest['stages'][number];
type Row = Record<string, any>;
const average = (values:(number|null|undefined)[]) => { const known=values.filter((v):v is number=>typeof v==='number'); return known.length ? known.reduce((a,b)=>a+b,0)/known.length : null; };

export class VideoBuilds {
  private db:DatabaseSync;
  constructor(path:string) {
    this.db=new DatabaseSync(path);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=3000; PRAGMA foreign_keys=ON;
      CREATE TABLE IF NOT EXISTS video_builds (
        id TEXT PRIMARY KEY,title TEXT NOT NULL,type TEXT NOT NULL,
        engine TEXT NOT NULL CHECK(engine IN ('remotion','manim','ffmpeg','hybrid')),
        duration REAL NOT NULL CHECK(duration>=0),aspect_ratio TEXT NOT NULL,
        status TEXT NOT NULL CHECK(status IN ('planned','preview','approved','final')),
        revisions INTEGER NOT NULL CHECK(revisions>=0),preview_path TEXT,final_path TEXT,
        created_at INTEGER NOT NULL,quality_json TEXT NOT NULL,manifest_json TEXT NOT NULL
      ) STRICT;
      CREATE TABLE IF NOT EXISTS video_stages (
        id TEXT NOT NULL,video_build_id TEXT NOT NULL REFERENCES video_builds(id) ON DELETE CASCADE,
        position INTEGER NOT NULL,stage TEXT NOT NULL CHECK(stage IN ('PLAN','BUILD','REVISE','FINISH')),
        session_id TEXT,model TEXT NOT NULL,notes TEXT NOT NULL,approved INTEGER NOT NULL CHECK(approved IN (0,1)),
        approved_at INTEGER,turn_ids_json TEXT,
        PRIMARY KEY(video_build_id,id),UNIQUE(video_build_id,position)
      ) STRICT;
      CREATE INDEX IF NOT EXISTS video_stages_session ON video_stages(session_id);
      CREATE INDEX IF NOT EXISTS video_builds_created ON video_builds(created_at DESC);
    `);
  }
  save(input:unknown, replace=false) {
    const m=videoManifest.parse(input), previous=this.manifest(m.build.id);
    if(previous&&!replace) throw new ApiError(409,'video_exists','Build đã tồn tại. Dùng cập nhật để thay thế manifest.');
    if(replace&&!previous) throw new ApiError(404,'video_not_found','Không tìm thấy video build.');
    const now=Date.now();
    m.build.created_at=previous?.build.created_at ?? m.build.created_at ?? now;
    const ids=new Set<string>(); let phase=0;
    m.stages=m.stages.map((s,i)=>{
      s.id ??= `stage-${i+1}`;
      if(ids.has(s.id)) throw new ApiError(400,'duplicate_stage','ID stage không được trùng.'); ids.add(s.id);
      const next={PLAN:0,BUILD:1,REVISE:2,FINISH:3}[s.stage];
      if(next<phase) throw new ApiError(400,'invalid_pipeline','Thứ tự stage phải là PLAN → BUILD → REVISE → FINISH. Có thể lặp REVISE.'); phase=next;
      if(s.turn_ids&&!s.session_id) throw new ApiError(400,'missing_session','turn_ids cần session_id.');
      if(s.turn_ids&&new Set(s.turn_ids).size!==s.turn_ids.length) throw new ApiError(400,'duplicate_turn','turn_ids không được trùng.');
      if(s.turn_ids) {
        s.turn_ids=s.turn_ids.map(t=>t.startsWith(`${s.session_id}:`)?t:`${s.session_id}:${t}`);
        if(new Set(s.turn_ids).size!==s.turn_ids.length) throw new ApiError(400,'duplicate_turn','turn_ids cùng trỏ đến một turn.');
      }
      const old=previous?.stages.find(p=>p.id===s.id);
      if(s.approved) s.approved_at ??= old?.approved ? old.approved_at : now;
      else s.approved_at=null;
      if(s.approved_at&&s.approved_at>now) throw new ApiError(400,'future_approval','Thời điểm duyệt không được nằm trong tương lai.');
      return s;
    });
    if(['approved','final'].includes(m.build.status)&&!m.stages.some(s=>s.approved&&['BUILD','REVISE'].includes(s.stage)))
      throw new ApiError(400,'missing_preview_approval','Build approved/final cần một stage BUILD hoặc REVISE đã duyệt.');
    if(m.build.status==='final'&&!m.build.final_path) throw new ApiError(400,'missing_final_path','Build final cần final_path.');
    // No usage/pricing/time columns: metadata joins the collector's source of truth.
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const linked=this.db.prepare('SELECT session_id,turn_ids_json FROM video_stages WHERE video_build_id<>? AND session_id IS NOT NULL').all(m.build.id) as Row[];
      const scopes: {session_id:string;turn_ids?:string[]}[]=linked.map(s=>({session_id:s.session_id,turn_ids:s.turn_ids_json?JSON.parse(s.turn_ids_json):undefined}));
      for(const s of m.stages) if(s.session_id) {
        for(const old of scopes.filter(p=>p.session_id===s.session_id)) if(!old.turn_ids||!s.turn_ids||old.turn_ids.some(t=>s.turn_ids!.includes(t)))
          throw new ApiError(409,'session_scope_overlap','Session đã được gắn cho stage khác. Chọn turn_ids riêng, không chồng nhau.');
        scopes.push({session_id:s.session_id,turn_ids:s.turn_ids});
      }
      const b=m.build;
      this.db.prepare(`INSERT INTO video_builds VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET
        title=excluded.title,type=excluded.type,engine=excluded.engine,duration=excluded.duration,aspect_ratio=excluded.aspect_ratio,
        status=excluded.status,revisions=excluded.revisions,preview_path=excluded.preview_path,final_path=excluded.final_path,
        quality_json=excluded.quality_json,manifest_json=excluded.manifest_json`).run(b.id,b.title,b.type,b.engine,b.duration,b.aspect_ratio,b.status,b.revisions,b.preview_path,b.final_path,b.created_at!,JSON.stringify(b.quality),JSON.stringify(m));
      this.db.prepare('DELETE FROM video_stages WHERE video_build_id=?').run(b.id);
      const insert=this.db.prepare('INSERT INTO video_stages VALUES(?,?,?,?,?,?,?,?,?,?)');
      m.stages.forEach((s,i)=>insert.run(s.id!,b.id,i,s.stage,s.session_id,s.model,s.notes,s.approved?1:0,s.approved_at??null,s.turn_ids?JSON.stringify(s.turn_ids):null));
      this.db.exec('COMMIT');
    } catch(error) { this.db.exec('ROLLBACK'); throw error; }
    return this.detail(m.build.id)!;
  }
  manifest(id:string):Manifest|null {
    const row=this.db.prepare('SELECT manifest_json FROM video_builds WHERE id=?').get(id);
    return row?JSON.parse(String(row.manifest_json)):null;
  }
  private usage(s:Stage,events:Row[],turns:Row[],sessions:Set<string>,cutoff=Infinity,model?:string) {
    const scoped=(t:string)=>!s.turn_ids||s.turn_ids.includes(t)||s.turn_ids.includes(t.replace(`${s.session_id}:`,''));
    const es=events.filter(e=>e.session_id===s.session_id&&scoped(e.turn_id)&&e.timestamp<=cutoff&&(!model||e.model===model));
    const ts=turns.filter(t=>t.session_id===s.session_id&&scoped(t.id)&&t.started_at<=cutoff&&(!model||t.model===model));
    const missingTurns=ts.filter(t=>!es.some(e=>e.turn_id===t.id)).length;
    const completeCost=es.length>0&&!missingTurns&&es.every(e=>e.cost_usd!==null);
    const completeTime=ts.length>0&&ts.every(t=>t.finished_at!==null&&t.finished_at<=cutoff);
    const input=es.reduce((n,e)=>n+Number(e.input_tokens),0),output=es.reduce((n,e)=>n+Number(e.output_tokens),0);
    const knownCost=es.reduce((n,e)=>n+Number(e.cost_usd??0),0);
    const knownTime=ts.filter(t=>t.finished_at!==null&&t.finished_at<=cutoff).reduce((n,t)=>n+Math.max(0,t.finished_at-t.started_at),0);
    const actualModels=[...new Set(es.map(e=>String(e.model)))];
    return {input_tokens:es.length?input:null,output_tokens:es.length?output:null,tokens:es.length&&!missingTurns?input+output:null,known_tokens:input+output,missing_usage_turns:missingTurns,
      cost_usd:completeCost?knownCost:null,known_cost_usd:knownCost,unpriced_records:es.filter(e=>e.cost_usd===null).length,
      elapsed_ms:completeTime?knownTime:null,known_elapsed_ms:knownTime,records:es.length,turns:ts.length,
      linked:!!s.session_id,session_found:!!s.session_id&&sessions.has(s.session_id),models:actualModels};
  }
  private combine(us:ReturnType<VideoBuilds['usage']>[]) {
    const total=(key:'tokens'|'cost_usd'|'elapsed_ms')=>us.length&&us.every(u=>u[key]!==null)?us.reduce((n,u)=>n+Number(u[key]),0):null;
    return {tokens:total('tokens'),cost_usd:total('cost_usd'),elapsed_ms:total('elapsed_ms'),
      known_cost_usd:us.reduce((n,u)=>n+u.known_cost_usd,0),known_elapsed_ms:us.reduce((n,u)=>n+u.known_elapsed_ms,0),
      unpriced_records:us.reduce((n,u)=>n+u.unpriced_records,0)};
  }
  private data() {
    // Read one consistent collector snapshot. Collector replay transactions remain independent.
    this.db.exec('BEGIN');
    try {
      const manifests=(this.db.prepare('SELECT manifest_json FROM video_builds ORDER BY created_at DESC,id').all()).map(r=>JSON.parse(String(r.manifest_json)) as Manifest);
      const linked=this.db.prepare('SELECT DISTINCT session_id FROM video_stages WHERE session_id IS NOT NULL').all().map(r=>String(r.session_id));
      const events=this.db.prepare('SELECT e.* FROM native_events e JOIN (SELECT DISTINCT session_id FROM video_stages WHERE session_id IS NOT NULL) s ON s.session_id=e.session_id').all() as Row[];
      const turns=this.db.prepare('SELECT t.* FROM native_turns t JOIN (SELECT DISTINCT session_id FROM video_stages WHERE session_id IS NOT NULL) s ON s.session_id=t.session_id').all() as Row[];
      const sessions=new Set((this.db.prepare('SELECT id FROM native_sessions').all()).map(r=>String(r.id)));
      const builds=manifests.map(m=>{
        const stages=m.stages.map(s=>({...s,usage:this.usage(s,events,turns,sessions)}));
        const approvedIndex=stages.findIndex(s=>s.approved&&['BUILD','REVISE'].includes(s.stage));
        const approved=approvedIndex<0?null:stages[approvedIndex]!;
        const preview=approved?this.combine(stages.slice(0,approvedIndex+1).map(s=>this.usage(s,events,turns,sessions,approved.approved_at??Infinity))):null;
        const models=[...new Set(stages.flatMap(s=>s.usage.models.length?s.usage.models:s.model?[s.model]:[]))];
        const pipeline=stages.map(s=>`${s.usage.models.join('+')||s.model||'?'} ${s.stage}`).join(' → ');
        return {...m.build,stages,models,pipeline,usage:this.combine(stages.map(s=>s.usage)),approved_preview:preview,
          first_pass:approved?approved.stage==='BUILD'&&stages.slice(0,approvedIndex).every(s=>s.stage==='PLAN'):null};
      });
      this.db.exec('COMMIT'); return {builds,events,turns,sessions,linked};
    } catch(error) {this.db.exec('ROLLBACK');throw error;}
  }
  detail(id:string) {return this.data().builds.find(b=>b.id===id)??null;}
  overview() {
    const {builds,events,turns,sessions}=this.data();
    const summarize=(rows:typeof builds)=>{
      const approved=rows.filter(b=>b.approved_preview);
      const costs=approved.map(b=>b.approved_preview!.cost_usd),times=approved.map(b=>b.approved_preview!.elapsed_ms);
      return {builds:rows.length,approved_previews:approved.length,approved_first_pass:approved.filter(b=>b.first_pass).length,
        first_pass_rate:approved.length?approved.filter(b=>b.first_pass).length/approved.length:null,
        avg_revisions:average(rows.map(b=>b.revisions)),avg_overall:average(rows.map(b=>b.quality.overall)),avg_wow:average(rows.map(b=>b.quality.wow)),
        avg_cost_to_approved:average(costs),cost_samples:costs.filter(v=>v!==null).length,
        avg_time_to_approved_ms:average(times),time_samples:times.filter(v=>v!==null).length};
    };
    const comparisons=(field:'engine'|'pipeline'|'model')=>{
      const keys=field==='model'?[...new Set(builds.flatMap(b=>b.models))]:[...new Set(builds.map(b=>b[field]))];
      return keys.map(key=>{
        const rows=builds.filter(b=>field==='model'?b.models.includes(key):b[field]===key);
        const usage=rows.map(b=>field==='model'?this.combine(b.stages.filter(s=>s.usage.models.includes(key)||!s.usage.models.length&&s.model===key).map(s=>this.usage(s,events,turns,sessions,Infinity,key))):b.usage);
        const costPairs=rows.map((b,i)=>({q:b.quality.overall,c:usage[i]!.cost_usd})).filter(p=>p.q!=null&&p.c!=null&&p.c>0);
        const timePairs=rows.map((b,i)=>({q:b.quality.overall,t:usage[i]!.elapsed_ms})).filter(p=>p.q!=null&&p.t!=null&&p.t>0);
        return {key,...summarize(rows),cost_usd:usage.every(u=>u.cost_usd!==null)?usage.reduce((n,u)=>n+u.cost_usd!,0):null,
          quality_per_dollar:costPairs.length?costPairs.reduce((n,p)=>n+p.q!,0)/costPairs.reduce((n,p)=>n+p.c!,0):null,
          quality_per_minute:timePairs.length?timePairs.reduce((n,p)=>n+p.q!,0)/(timePairs.reduce((n,p)=>n+p.t!,0)/60000):null,
          quality_cost_samples:costPairs.length,quality_time_samples:timePairs.length};
      });
    };
    return {summary:summarize(builds),builds,comparisons:{models:comparisons('model'),engines:comparisons('engine'),pipelines:comparisons('pipeline')}};
  }
  links(session:string) {return this.db.prepare('SELECT s.video_build_id,s.stage,b.title FROM video_stages s JOIN video_builds b ON b.id=s.video_build_id WHERE s.session_id=? ORDER BY b.created_at,s.position').all(session);}
  sessionOptions(search:string) {
    const term=`%${search.replace(/[\\%_]/g,'\\$&')}%`;
    return this.db.prepare("SELECT id,cwd,model,updated_at FROM native_sessions WHERE id LIKE ? ESCAPE '\\' OR cwd LIKE ? ESCAPE '\\' ORDER BY updated_at DESC LIMIT 100").all(term,term);
  }
  close() {this.db.close();}
}
