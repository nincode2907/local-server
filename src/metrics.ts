import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, chmodSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { Usage } from '@openai/codex-sdk';

export const ranges = { '1h': 3_600_000, '24h': 86_400_000, '7d': 604_800_000, '30d': 2_592_000_000 };
export type Range = keyof typeof ranges;
export type CallStatus = 'pending' | 'running' | 'success' | 'error' | 'rejected' | 'cancelled' | 'interrupted';
export class Metrics {
  private db: DatabaseSync;
  constructor(path: string) {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(path);
    chmodSync(path, 0o600);
    this.db.exec(`
      PRAGMA journal_mode=WAL;
      PRAGMA busy_timeout=3000;
      CREATE TABLE IF NOT EXISTS calls (
        id TEXT PRIMARY KEY, endpoint TEXT NOT NULL, model TEXT NOT NULL, reasoning TEXT NOT NULL,
        session_id TEXT, started_at INTEGER NOT NULL, finished_at INTEGER, duration_ms REAL,
        status TEXT NOT NULL DEFAULT 'pending', http_status INTEGER, codex_started INTEGER NOT NULL DEFAULT 0,
        input_tokens INTEGER, output_tokens INTEGER, cached_tokens INTEGER, reasoning_tokens INTEGER,
        tool_calls INTEGER NOT NULL DEFAULT 0, finish_reason TEXT, error_code TEXT
      ) STRICT;
      CREATE INDEX IF NOT EXISTS calls_time ON calls(started_at DESC);
      CREATE INDEX IF NOT EXISTS calls_model_time ON calls(model, started_at DESC);
      PRAGMA user_version=1;
    `);
    // A crashed server cannot know when these turns actually finished.
    this.db.prepare(`UPDATE calls SET status='interrupted', error_code='server_restarted', finished_at=?, duration_ms=NULL WHERE status IN ('pending','running')`).run(Date.now());
  }
  begin(endpoint: string, model: string, reasoning: string, sessionId: string | null) {
    const id = randomUUID();
    this.db.prepare('INSERT INTO calls(id, endpoint, model, reasoning, session_id, started_at) VALUES(?,?,?,?,?,?)').run(id, endpoint, model, reasoning, sessionId, Date.now());
    return id;
  }
  context(id: string, model: string, reasoning: string) {
    this.db.prepare('UPDATE calls SET model=?, reasoning=? WHERE id=?').run(model, reasoning, id);
  }
  running(id: string) {
    this.db.prepare("UPDATE calls SET codex_started=1, status='running' WHERE id=?").run(id);
  }
  usage(id: string, usage: Usage | null) {
    if (!usage) return;
    this.db.prepare('UPDATE calls SET input_tokens=?, output_tokens=?, cached_tokens=?, reasoning_tokens=? WHERE id=?').run(usage.input_tokens, usage.output_tokens, usage.cached_input_tokens, usage.reasoning_output_tokens ?? null, id);
  }
  result(id: string, toolCalls: number, finishReason: string) {
    this.db.prepare('UPDATE calls SET tool_calls=?, finish_reason=? WHERE id=?').run(toolCalls, finishReason, id);
  }
  error(id: string, code: string) {
    this.db.prepare('UPDATE calls SET error_code=? WHERE id=?').run(code, id);
  }
  finish(id: string, duration: number, httpStatus: number, cancelled = false) {
    this.db.prepare(`UPDATE calls SET finished_at=?, duration_ms=?, http_status=?,
      status=CASE WHEN ? THEN 'cancelled' WHEN ? < 400 THEN 'success' WHEN codex_started=0 THEN 'rejected' ELSE 'error' END
      WHERE id=? AND status IN ('pending','running')`).run(Date.now(), duration, httpStatus, cancelled ? 1 : 0, httpStatus, id);
  }
  overview(range: Range, model?: string) {
    const now = Date.now();
    const since = now - ranges[range];
    const where = 'started_at >= ? AND started_at <= ?' + (model ? ' AND model=?' : '');
    const params = model ? [since, now, model] : [since, now];
    const summary = this.db.prepare(`SELECT COUNT(*) AS total_calls,
      COALESCE(SUM(status='success'),0) AS successful_calls,
      COALESCE(SUM(status IN ('error','cancelled','interrupted')),0) AS failed_calls,
      COALESCE(SUM(status='rejected'),0) AS rejected_calls,
      COALESCE(SUM(status IN ('pending','running')),0) AS active_calls,
      COALESCE(SUM(codex_started),0) AS codex_calls,
      COALESCE(SUM(input_tokens),0) AS input_tokens, COALESCE(SUM(output_tokens),0) AS output_tokens,
      COALESCE(SUM(cached_tokens),0) AS cached_tokens, COALESCE(SUM(reasoning_tokens),0) AS reasoning_tokens,
      COALESCE(SUM(input_tokens IS NOT NULL),0) AS usage_known_calls,
      COALESCE(SUM(codex_started=1 AND input_tokens IS NULL AND status NOT IN ('running','pending')),0) AS usage_unknown_calls,
      COALESCE(SUM(tool_calls),0) AS tool_calls,
      AVG(CASE WHEN codex_started=1 THEN duration_ms END) AS avg_duration_ms
      FROM calls WHERE ${where}`).get(...params)!;
    const count = Number(this.db.prepare(`SELECT COUNT(*) AS n FROM calls WHERE ${where} AND codex_started=1 AND duration_ms IS NOT NULL`).get(...params)!.n);
    const p95 = count ? this.db.prepare(`SELECT duration_ms FROM calls WHERE ${where} AND codex_started=1 AND duration_ms IS NOT NULL ORDER BY duration_ms LIMIT 1 OFFSET ?`).get(...params, Math.max(0, Math.ceil(count * 0.95) - 1))!.duration_ms : null;
    const bucket = range === '1h' ? 300_000 : range === '24h' ? 3_600_000 : 86_400_000;
    const start = Math.floor(since / bucket) * bucket;
    const buckets = this.db.prepare(`SELECT CAST(started_at / ? AS INTEGER)*? AS time,
      COUNT(*) AS calls, SUM(status='success') AS success, SUM(status IN ('error','cancelled','interrupted')) AS errors,
      SUM(status='rejected') AS rejected, SUM(status IN ('pending','running')) AS active,
      COALESCE(SUM(input_tokens+output_tokens),0) AS tokens,
      AVG(CASE WHEN codex_started=1 THEN duration_ms END) AS avg_duration_ms
      FROM calls WHERE ${where} GROUP BY time ORDER BY time`).all(bucket, bucket, ...params);
    const byTime = new Map(buckets.map(row => [Number(row.time), row]));
    const timeline = [];
    for (let time = start; time <= now; time += bucket) timeline.push(byTime.get(time) ?? { time, calls: 0, success: 0, errors: 0, rejected: 0, active: 0, tokens: 0, avg_duration_ms: null });
    const models = this.db.prepare(`SELECT model, COUNT(*) AS calls,
      SUM(status='success') AS success, COALESCE(SUM(input_tokens),0) AS input_tokens,
      COALESCE(SUM(output_tokens),0) AS output_tokens,
      AVG(CASE WHEN codex_started=1 THEN duration_ms END) AS avg_duration_ms
      FROM calls WHERE ${where} GROUP BY model ORDER BY calls DESC`).all(...params);
    const availableModels = this.db.prepare('SELECT DISTINCT model FROM calls ORDER BY model').all().map(r => String(r.model));
    return { range, since, until: now, summary: { ...summary, p95_duration_ms: p95 }, timeline, models, available_models: availableModels,
      recorded_since: this.db.prepare('SELECT MIN(started_at) AS time FROM calls').get()!.time };
  }
  list(range: Range, page: number, status?: CallStatus, model?: string) {
    const params: (string | number)[] = [Date.now() - ranges[range]];
    let where = 'started_at >= ?';
    if (status) { where += ' AND status=?'; params.push(status); }
    if (model) { where += ' AND model=?'; params.push(model); }
    const total = Number(this.db.prepare(`SELECT COUNT(*) AS n FROM calls WHERE ${where}`).get(...params)!.n);
    const pageSize = 20;
    const data = this.db.prepare(`SELECT * FROM calls WHERE ${where} ORDER BY started_at DESC, id DESC LIMIT ? OFFSET ?`).all(...params, pageSize, (page - 1) * pageSize);
    return { data, total, page, page_size: pageSize };
  }
  close() { this.db.close(); }
}
