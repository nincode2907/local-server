import { DatabaseSync } from 'node:sqlite';
import { createReadStream } from 'node:fs';
import { readdir, stat } from 'node:fs/promises';
import { createInterface } from 'node:readline';
import { join, basename } from 'node:path';
import { estimateCost, periodKey } from './catalog.js';

type Usage = { input_tokens: number; cached_input_tokens: number; output_tokens: number; reasoning_output_tokens: number };
type Turn = { id: string; model: string; reasoning: string; started_at: number; finished_at: number | null; status: string };
type Event = Usage & { id: string; turn_id: string; model: string; timestamp: number; basis: string };
type Metadata = { id: string; cwd: string; source: string; model: string; created_at: number; updated_at: number };
const keys = ['input_tokens','cached_input_tokens','output_tokens','reasoning_output_tokens'] as const;
function usage(value: any): Usage | null {
  if (!value || !['input_tokens','output_tokens'].every(k => Number.isSafeInteger(value[k]) && value[k] >= 0)) return null;
  const result = Object.fromEntries(keys.map(k => [k, value[k] ?? 0])) as Usage;
  return keys.every(k => Number.isSafeInteger(result[k]) && result[k] >= 0) ? result : null;
}
function sourceName(source: unknown, cwd: string) {
  if (basename(cwd).startsWith('codex-gateway-')) return 'gateway-log';
  if (typeof source === 'object' || typeof source === 'string' && source.includes('subagent')) return 'subagent';
  return typeof source === 'string' ? source : 'unknown';
}
/** Only metadata/usage is retained; transcript text is never returned or persisted. */
export async function parseRollout(lines: AsyncIterable<string>, fallback?: Metadata) {
  let meta: Metadata | undefined = fallback && { ...fallback }, active: Turn | undefined, previous: Usage | null = null;
  let lineNumber = 0, malformed = 0, resets = 0, fork = false, historyStart = 0;
  const turns = new Map<string,Turn>(), events: Event[] = [], seen = new Set<string>(), canonical = new Set<string>();
  const ensureTurn = (id: string, timestamp: number) => {
    let t = turns.get(id);
    if (!t) { t = { id, model: active?.model ?? meta?.model ?? 'unknown', reasoning: active?.reasoning ?? 'unknown', started_at: timestamp, finished_at: null, status: 'observed' }; turns.set(id,t); }
    return t;
  };
  for await (const line of lines) {
    lineNumber++;
    let r: any; try { r = JSON.parse(line); } catch { if (line.trim()) malformed++; continue; }
    if (!r || typeof r !== 'object' || !r.payload || typeof r.payload !== 'object') continue;
    const p = r.payload, timestamp = Date.parse(r.timestamp);
    if (r.type === 'session_meta' && typeof p.id === 'string') {
      if (meta && meta.id !== p.id) { turns.clear(); events.length=0; seen.clear(); canonical.clear(); active=undefined; previous=null; }
      const cwd = typeof p.cwd === 'string' ? p.cwd : meta?.cwd ?? 'unknown';
      meta = { id: p.id, cwd, source: sourceName(p.source ?? meta?.source,cwd), model: meta?.model ?? 'unknown', created_at: Date.parse(p.timestamp ?? r.timestamp), updated_at: meta?.updated_at ?? timestamp };
      fork = Boolean(p.forked_from_id || p.parent_thread_id || typeof p.source === 'object' && p.source?.subagent);
      historyStart = Number.isSafeInteger(p.subagent_history_start_ordinal) ? p.subagent_history_start_ordinal : 0; continue;
    }
    if (!meta || !Number.isFinite(timestamp) || fork && timestamp < meta.created_at || historyStart && Number.isSafeInteger(r.ordinal) && r.ordinal < historyStart) continue;
    meta.updated_at = Math.max(meta.updated_at || 0,timestamp);
    if (r.type === 'event_msg' && p.type === 'task_started') {
      active = ensureTurn(typeof p.turn_id === 'string' ? p.turn_id : `turn-${lineNumber}`,timestamp);
      active.started_at = timestamp; active.status = 'started';
    } else if (r.type === 'turn_context') {
      active = ensureTurn(typeof p.turn_id === 'string' ? p.turn_id : active?.id ?? `turn-${lineNumber}`,timestamp);
      if (typeof p.model === 'string') active.model = meta.model = p.model;
      if (typeof p.effort === 'string') active.reasoning = p.effort;
    } else if (r.type === 'event_msg' && ['task_complete','turn_aborted'].includes(p.type)) {
      const t = typeof p.turn_id === 'string' ? turns.get(p.turn_id) : active;
      if (t) { t.finished_at = timestamp; t.status = p.type === 'task_complete' ? 'completed' : 'aborted'; }
    } else if (r.type === 'token_usage_record') {
      if (p.thread_id && p.thread_id !== meta.id) continue;
      const u = usage(p.usage); if (!u) continue;
      const t = ensureTurn(p.turn_id ?? active?.id ?? 'unattributed',timestamp);
      const id = `response:${p.response_id ?? r.ordinal ?? lineNumber}`;
      if (seen.has(id)) continue; seen.add(id); canonical.add(t.id);
      events.push({ ...u,id,turn_id:t.id,model:typeof p.model === 'string' ? p.model : t.model,timestamp,basis:'response_record' });
    } else if (r.type === 'event_msg' && p.type === 'token_count') {
      const total = usage(p.info?.total_token_usage), last = usage(p.info?.last_token_usage);
      if (!total) continue;
      if (previous && keys.every(k => total[k] === previous![k])) continue;
      let delta: Usage | null;
      if (previous && keys.every(k => total[k] >= previous![k])) delta = Object.fromEntries(keys.map(k => [k,total[k]-previous![k]])) as Usage;
      else { delta = last; if (previous) resets++; }
      previous = total;
      if (!delta || keys.every(k => !delta![k])) continue;
      const t = active ?? ensureTurn('unattributed',timestamp);
      events.push({ ...delta,id:`legacy:${lineNumber}`,turn_id:t.id,model:t.model,timestamp,basis:'cumulative_delta' });
    }
  }
  return { meta, turns:[...turns.values()], events:events.filter(e => e.basis === 'response_record' || !canonical.has(e.turn_id)), malformed,resets };
}

export interface SpikeSample { id: string; session_id: string; turn_id: string; model: string; timestamp: number; input_tokens: number }
export function contextSpikes(samples: SpikeSample[]) {
  const histories = new Map<string, SpikeSample[]>();
  const spikes: (SpikeSample & { previous_input: number; growth_ratio: number; sequence: number[] })[] = [];
  for (const sample of samples) {
    const key = JSON.stringify([sample.session_id, sample.model]);
    const history = histories.get(key) ?? [];
    const previous = history.at(-1);
    if (previous && previous.input_tokens > 0 && sample.input_tokens >= 50_000 && sample.input_tokens > previous.input_tokens * 2) {
      spikes.push({ ...sample, previous_input: previous.input_tokens, growth_ratio: sample.input_tokens / previous.input_tokens,
        sequence: [...history.slice(-2).map(e => e.input_tokens), sample.input_tokens] });
    }
    history.push(sample); if (history.length > 2) history.shift(); histories.set(key, history);
  }
  return spikes;
}

export type NativeRange = 'today' | 'yesterday' | '7d' | '30d' | 'all' | '24h';
export type NativeFilter = { range: NativeRange; group: 'day' | 'week' | 'month'; model?: string; source?: string; project?: string; page: number };
const DAY = 86_400_000;
const VIETNAM_OFFSET = 7 * 3_600_000;
function dayStart(timestamp: number) {
  return Math.floor((timestamp + VIETNAM_OFFSET) / DAY) * DAY - VIETNAM_OFFSET;
}
function nativeWindow(range: NativeRange, now = Date.now()) {
  const today = dayStart(now);
  if (range === 'yesterday') return { key: range, label: 'Hôm qua', since: today-DAY, until: today, average_unit: null, average_divisor: null } as const;
  if (range === '7d') return { key: range, label: '7 ngày gần nhất', since: today-6*DAY, until: now+1, average_unit: 'day', average_divisor: 7 } as const;
  if (range === '30d') return { key: range, label: '30 ngày qua', since: today-29*DAY, until: now+1, average_unit: 'day', average_divisor: 30 } as const;
  if (range === 'all') return { key: range, label: 'Toàn bộ lịch sử', since: 0, until: now+1, average_unit: 'month', average_divisor: null } as const;
  // Keep 24h as a compatibility alias for clients created before calendar ranges.
  return { key: 'today', label: 'Hôm nay', since: today, until: now+1, average_unit: null, average_divisor: null } as const;
}
export class NativeUsage {
  private db: DatabaseSync;
  private timer?: NodeJS.Timeout;
  private syncing?: Promise<void>;
  private stopped = false;
  private lastSync: number | null = null;
  private issues: string[] = [];
  constructor(path: string, private home: string, private interval = 30_000) {
    this.db = new DatabaseSync(path);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=3000;
      CREATE TABLE IF NOT EXISTS native_sessions(id TEXT PRIMARY KEY,cwd TEXT NOT NULL,source TEXT NOT NULL,model TEXT NOT NULL,created_at INTEGER,updated_at INTEGER,rollout_path TEXT,malformed INTEGER DEFAULT 0,resets INTEGER DEFAULT 0);
      CREATE TABLE IF NOT EXISTS native_turns(id TEXT PRIMARY KEY,session_id TEXT NOT NULL,model TEXT,reasoning TEXT,started_at INTEGER,finished_at INTEGER,status TEXT);
      CREATE TABLE IF NOT EXISTS native_events(id TEXT PRIMARY KEY,session_id TEXT NOT NULL,turn_id TEXT NOT NULL,model TEXT NOT NULL,timestamp INTEGER NOT NULL,input_tokens INTEGER,cached_tokens INTEGER,output_tokens INTEGER,reasoning_tokens INTEGER,basis TEXT,cost_usd REAL,price_json TEXT);
      CREATE INDEX IF NOT EXISTS native_events_time ON native_events(timestamp);
      CREATE INDEX IF NOT EXISTS native_events_session ON native_events(session_id);
      CREATE INDEX IF NOT EXISTS native_turns_session ON native_turns(session_id);
      CREATE TABLE IF NOT EXISTS native_files(path TEXT PRIMARY KEY,size INTEGER,mtime REAL);
      CREATE TABLE IF NOT EXISTS native_settings(key TEXT PRIMARY KEY,value TEXT);

    `);
    const parserVersion = '2';
    if (this.db.prepare("SELECT value FROM native_settings WHERE key='parser_version'").get()?.value !== parserVersion) {
      this.db.exec('DELETE FROM native_files');
      this.db.prepare("INSERT OR REPLACE INTO native_settings VALUES('parser_version',?)").run(parserVersion);
    }
  }
  start() {
    void this.sync(); this.timer = setInterval(() => void this.sync(),this.interval); this.timer.unref();
  }
  sync() {
    if (this.stopped) return Promise.resolve();
    if (!this.syncing) this.syncing = this.collect().catch(() => { this.issues.push('Không đồng bộ được dữ liệu Codex. Dữ liệu cũ vẫn được giữ.'); }).finally(() => { this.syncing = undefined; });
    return this.syncing;
  }
  private async collect() {
    this.issues = [];
    const metadata = new Map<string,Metadata>();
    // Open only an existing state DB in read-only mode. Never create/upgrade Codex's DB.
    const statePath = join(this.home,'state_5.sqlite');
    try {
      await stat(statePath);
      const state = new DatabaseSync(statePath,{readOnly:true});
      try {
        const columns = new Set(state.prepare('PRAGMA table_info(threads)').all().map(r => r.name));
        const selected = ['id','cwd','source','model','created_at','updated_at'].filter(k => columns.has(k));
        if (!selected.includes('id')) throw new Error('unsupported schema');
        for (const r of state.prepare(`SELECT ${selected.join(',')} FROM threads`).all()) {
          const cwd = String(r.cwd ?? 'unknown');
          metadata.set(String(r.id),{id:String(r.id),cwd,source:sourceName(r.source,cwd),model:String(r.model ?? 'unknown'),created_at:Number(r.created_at ?? 0)*1000,updated_at:Number(r.updated_at ?? 0)*1000});
        }
      } finally { state.close(); }
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') this.issues.push('Không đọc được state_5.sqlite; tiếp tục đọc rollout JSONL.'); }
    const upsert = this.db.prepare(`INSERT INTO native_sessions(id,cwd,source,model,created_at,updated_at) VALUES(?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET cwd=excluded.cwd,source=excluded.source,model=excluded.model,updated_at=MAX(updated_at,excluded.updated_at)`);
    for (const m of metadata.values()) upsert.run(m.id,m.cwd,m.source,m.model,m.created_at,m.updated_at);
    let found = 0;
    const walk = async (directory: string) => {
      let entries; try { entries = await readdir(directory,{withFileTypes:true}); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') this.issues.push('Không đọc được thư mục session.'); return; }
      for (const entry of entries) {
        if (this.stopped) return;
        const path = join(directory,entry.name);
        if (entry.isDirectory()) await walk(path);
        else if (entry.isFile() && entry.name.startsWith('rollout-') && entry.name.endsWith('.jsonl')) {
          found++;
          try {
            const before = await stat(path), known = this.db.prepare('SELECT size,mtime FROM native_files WHERE path=?').get(path);
            if (known?.size === before.size && known?.mtime === before.mtimeMs) continue;
            const stream = createReadStream(path,{encoding:'utf8'}), lines = createInterface({input:stream,crlfDelay:Infinity});
            const hint = /([a-f0-9]{8}-[a-f0-9-]{27,})\.jsonl$/.exec(entry.name)?.[1];
            let parsed; try { parsed = await parseRollout(lines,hint ? metadata.get(hint) : undefined); } finally { lines.close(); stream.destroy(); }
            const m = parsed.meta; if (!m || !Number.isFinite(m.created_at)) continue;
            const after = await stat(path);
            this.db.exec('BEGIN');
            try {
              upsert.run(m.id,m.cwd,m.source,m.model,m.created_at,m.updated_at);
              this.db.prepare('UPDATE native_sessions SET rollout_path=?,malformed=?,resets=? WHERE id=?').run(path,parsed.malformed,parsed.resets,m.id);
              // Keep frozen rates for existing event IDs even when the growing file is replayed.
              const prices = new Map(this.db.prepare('SELECT id,model,price_json FROM native_events WHERE session_id=?').all(m.id).map(r => [String(r.id),r]));
              this.db.prepare('DELETE FROM native_events WHERE session_id=?').run(m.id);
              this.db.prepare('DELETE FROM native_turns WHERE session_id=?').run(m.id);
              for (const t of parsed.turns) this.db.prepare('INSERT INTO native_turns VALUES(?,?,?,?,?,?,?)').run(`${m.id}:${t.id}`,m.id,t.model,t.reasoning,t.started_at,t.finished_at,t.status);
              for (const e of parsed.events) {
                const id = `${m.id}:${e.id}`, existing = prices.get(id);
                let cost = estimateCost(e.model,e.input_tokens,e.output_tokens,e.cached_input_tokens);
                if (existing?.price_json && existing.model === e.model) {
                  const frozen = JSON.parse(String(existing.price_json)) as NonNullable<typeof cost>;
                  const cache = Math.min(e.input_tokens,e.cached_input_tokens);
                  frozen.input_cost_usd = (e.input_tokens-cache)*frozen.input_rate/1e6;
                  frozen.cached_cost_usd = cache*frozen.cached_rate/1e6;
                  frozen.output_cost_usd = e.output_tokens*frozen.output_rate/1e6;
                  frozen.cost_usd = frozen.input_cost_usd+frozen.cached_cost_usd+frozen.output_cost_usd;
                  cost = frozen;
                }
                this.db.prepare('INSERT INTO native_events VALUES(?,?,?,?,?,?,?,?,?,?,?,?)').run(id,m.id,`${m.id}:${e.turn_id}`,e.model,e.timestamp,e.input_tokens,e.cached_input_tokens,e.output_tokens,e.reasoning_output_tokens,e.basis,cost?.cost_usd ?? null,cost ? JSON.stringify(cost) : null);
              }
              if (before.size === after.size && before.mtimeMs === after.mtimeMs && !parsed.malformed) this.db.prepare('INSERT OR REPLACE INTO native_files VALUES(?,?,?)').run(path,after.size,after.mtimeMs);
              this.db.exec('COMMIT');
            } catch (error) { this.db.exec('ROLLBACK'); throw error; }
          } catch { this.issues.push('Một rollout không đọc được; giữ thống kê lần trước.'); }
        }
      }
    };
    await walk(join(this.home,'sessions')); await walk(join(this.home,'archived_sessions'));
    if (!found && !metadata.size) this.issues.push('Chưa tìm thấy session Codex trong thư mục đã cấu hình.');
    this.lastSync = Date.now();
  }
  status() { return { syncing:Boolean(this.syncing),last_sync:this.lastSync,interval_ms:this.interval,home:this.home,issues:[...new Set(this.issues)] }; }
  overview(filter: NativeFilter) {
    const window = nativeWindow(filter.range);
    const since = window.since;
    const params: (string|number)[] = [since,window.until];
    let where = 'e.timestamp >= ? AND e.timestamp < ?';
    for (const [field,value] of [['e.model',filter.model],['s.source',filter.source],['s.cwd',filter.project]]) if (value) { where += ` AND ${field}=?`; params.push(value); }
    const events = this.db.prepare(`SELECT e.*,s.cwd,s.source FROM native_events e JOIN native_sessions s ON s.id=e.session_id WHERE ${where} ORDER BY e.timestamp,e.rowid`).all(...params);
    const sessions = this.db.prepare('SELECT * FROM native_sessions ORDER BY updated_at DESC').all().filter(s => (!filter.source || s.source === filter.source) && (!filter.project || s.cwd === filter.project));
    const relevant = new Set(events.map(e => String(e.session_id)));
    const selected = sessions.filter(s => relevant.has(String(s.id)) || Number(s.updated_at) >= since && Number(s.updated_at) < window.until && (!filter.model || s.model === filter.model));
    const selectedIds = new Set(selected.map(s => s.id));
    const allTurns = this.db.prepare('SELECT * FROM native_turns ORDER BY started_at').all();
    const eventTurns = new Set(events.map(e => e.turn_id));
    const turns = allTurns.filter(t => selectedIds.has(t.session_id) && (eventTurns.has(t.id) || Number(t.started_at)>=since && Number(t.started_at)<window.until && (!filter.model || t.model===filter.model)));
    const sum = (rows: typeof events) => ({ input_tokens:rows.reduce((n,e)=>n+Number(e.input_tokens),0),cached_tokens:rows.reduce((n,e)=>n+Number(e.cached_tokens),0),output_tokens:rows.reduce((n,e)=>n+Number(e.output_tokens),0),reasoning_tokens:rows.reduce((n,e)=>n+Number(e.reasoning_tokens),0),cost_usd:rows.reduce((n,e)=>n+Number(e.cost_usd ?? 0),0),unpriced_events:rows.filter(e=>e.cost_usd===null).length,calls:rows.length });
    const efficiency = (rows: typeof events) => {
      const sessionIds = [...new Set(rows.map(e => String(e.session_id)))];
      const attributed = rows.filter(e => !String(e.turn_id).endsWith(':unattributed'));
      const knownTurns = new Set(attributed.map(e => e.turn_id)).size;
      const pricedSessions = sessionIds.map(id => rows.filter(e => e.session_id === id)).filter(es => es.every(e => e.cost_usd !== null));
      return { sessions: sessionIds.length, usage_turns: knownTurns,
        tokens_per_turn: knownTurns ? attributed.reduce((n,e) => n+Number(e.input_tokens)+Number(e.output_tokens),0)/knownTurns : null,
        cost_per_session: pricedSessions.length ? pricedSessions.reduce((n,es) => n+sum(es).cost_usd,0)/pricedSessions.length : null,
        priced_sessions: pricedSessions.length, unpriced_sessions: sessionIds.length-pricedSessions.length,
        unattributed_events: rows.length-attributed.length };
    };
    const aggregate = (field:string) => [...new Set(events.map(e=>String(e[field])))].map(key => {
      const rows = events.filter(e=>String(e[field])===key);
      return {key,...sum(rows),...efficiency(rows)};
    }).sort((a,b)=>b.input_tokens+b.output_tokens-a.input_tokens-a.output_tokens);
    const scopedSummary = (start:number,end:number) => {
      const scopedParams: (string|number)[] = [start,end];
      let scopedWhere = 'e.timestamp >= ? AND e.timestamp < ?';
      for (const [field,value] of [['e.model',filter.model],['s.source',filter.source],['s.cwd',filter.project]]) if (value) { scopedWhere += ` AND ${field}=?`; scopedParams.push(value); }
      const scopedEvents = this.db.prepare(`SELECT e.*,s.cwd,s.source FROM native_events e JOIN native_sessions s ON s.id=e.session_id WHERE ${scopedWhere} ORDER BY e.timestamp,e.rowid`).all(...scopedParams);
      const scopedRelevant = new Set(scopedEvents.map(e=>String(e.session_id)));
      const scopedSessions = sessions.filter(s => scopedRelevant.has(String(s.id)) || Number(s.updated_at)>=start && Number(s.updated_at)<end && (!filter.model || s.model===filter.model));
      const scopedIds = new Set(scopedSessions.map(s=>s.id));
      const scopedEventTurns = new Set(scopedEvents.map(e=>e.turn_id));
      const scopedTurns = allTurns.filter(t => scopedIds.has(t.session_id) && (scopedEventTurns.has(t.id) || Number(t.started_at)>=start && Number(t.started_at)<end && (!filter.model || t.model===filter.model)));
      const totals = sum(scopedEvents);
      return {...totals,...efficiency(scopedEvents),cache_hit_rate:totals.input_tokens ? totals.cached_tokens/totals.input_tokens : null,sessions:scopedSessions.length,turns:scopedTurns.length};
    };
    // Compare against the prior record even when it falls outside the selected time window.
    const history = this.db.prepare(`SELECT e.id,e.session_id,e.turn_id,e.model,e.timestamp,e.input_tokens,s.cwd,s.source
      FROM native_events e JOIN native_sessions s ON s.id=e.session_id ORDER BY e.timestamp,e.rowid`).all();
    const spikes = contextSpikes(history.map(e => ({id:String(e.id),session_id:String(e.session_id),turn_id:String(e.turn_id),model:String(e.model),timestamp:Number(e.timestamp),input_tokens:Number(e.input_tokens)})))
      .filter(e => e.timestamp>=since && e.timestamp<window.until && (!filter.model || e.model===filter.model))
      .filter(e => { const s = sessions.find(s => s.id===e.session_id); return Boolean(s); })
      .map(e => ({...e,cwd:String(sessions.find(s => s.id===e.session_id)!.cwd)})).reverse();

    const periods = [...new Set(events.map(e=>periodKey(Number(e.timestamp),filter.group)))].sort().map(period=>({period,...sum(events.filter(e=>periodKey(Number(e.timestamp),filter.group)===period))}));
    const data = selected.map(s => {
      const rows = events.filter(e=>e.session_id===s.id), ts = turns.filter(t=>t.session_id===s.id), u = sum(rows);
      const duration = ts.reduce((n,t)=>n+(t.finished_at===null ? 0 : Math.max(0,Number(t.finished_at)-Number(t.started_at))),0);
      return {...s,...u,turns:ts.length,usage_available:rows.length>0,duration_ms:ts.some(t=>t.finished_at!==null)?duration:null,tokens_per_turn:ts.length&&rows.length?(u.input_tokens+u.output_tokens)/ts.length:null,cache_ratio:u.input_tokens?u.cached_tokens/u.input_tokens:null,context_spikes:spikes.filter(e=>e.session_id===s.id).length};
    });
    const totals = sum(events);
    const summary = {...totals,...efficiency(events),cache_hit_rate:totals.input_tokens ? totals.cached_tokens/totals.input_tokens : null,context_spikes:spikes.length,sessions:selected.length,turns:turns.length,usage_unavailable_sessions:data.filter(s=>!s.usage_available).length};
    const comparison = window.key === 'today' ? { label:'Hôm qua', summary:scopedSummary(window.since-DAY,window.since) } : null;
    let averageDivisor: number | null = window.average_divisor;
    if (window.key === 'all' && events.length) {
      const first = new Date(Number(events[0]!.timestamp)+VIETNAM_OFFSET), last = new Date((window.until-1)+VIETNAM_OFFSET);
      averageDivisor = (last.getUTCFullYear()-first.getUTCFullYear())*12+last.getUTCMonth()-first.getUTCMonth()+1;
    }
    const average = averageDivisor && window.average_unit ? {
      unit:window.average_unit, divisor:averageDivisor,
      summary:Object.fromEntries(['sessions','turns','calls','input_tokens','cached_tokens','output_tokens','reasoning_tokens','cost_usd'].map(key=>[key,Number(summary[key as keyof typeof summary] ?? 0)/averageDivisor]))
    } : null;
    return {collector:this.status(),range:{key:window.key,label:window.label,since:window.since,until:window.until-1},summary,comparison,average,projects:aggregate('cwd'),models:aggregate('model'),sources:aggregate('source'),periods,spikes:spikes.slice(0,20),
      data:data.slice((filter.page-1)*20,filter.page*20),total:data.length,page:filter.page,page_size:20,
      filters:{models:this.db.prepare('SELECT DISTINCT model FROM native_events ORDER BY model').all().map(r=>r.model),projects:this.db.prepare('SELECT DISTINCT cwd FROM native_sessions ORDER BY cwd').all().map(r=>r.cwd),sources:this.db.prepare('SELECT DISTINCT source FROM native_sessions ORDER BY source').all().map(r=>r.source)} };
  }
  detail(id: string) {
    const session = this.db.prepare('SELECT * FROM native_sessions WHERE id=?').get(id); if (!session) return null;
    const samples = this.db.prepare('SELECT * FROM native_events WHERE session_id=? ORDER BY timestamp,rowid').all(id);
    const spikes = contextSpikes(samples.map(e => ({id:String(e.id),session_id:id,turn_id:String(e.turn_id),model:String(e.model),timestamp:Number(e.timestamp),input_tokens:Number(e.input_tokens)})));
    return {session,spikes,turns:this.db.prepare(`SELECT t.*,COUNT(e.id) AS calls,SUM(e.input_tokens) AS input_tokens,SUM(e.cached_tokens) AS cached_tokens,SUM(e.output_tokens) AS output_tokens,SUM(e.reasoning_tokens) AS reasoning_tokens,SUM(e.cost_usd) AS cost_usd FROM native_turns t LEFT JOIN native_events e ON e.turn_id=t.id WHERE t.session_id=? GROUP BY t.id ORDER BY t.started_at`).all(id),events:this.db.prepare('SELECT * FROM native_events WHERE session_id=? ORDER BY timestamp DESC LIMIT 200').all(id)};
  }
  async close() { this.stopped=true; clearInterval(this.timer); await this.syncing; this.db.close(); }
}
