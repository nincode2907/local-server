import { mkdir, readFile, writeFile, rename, readdir, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import type { Config } from './config.js';

export type Provenance = 'Client supplied' | 'Gateway generated' | 'SDK observable' | 'Internal / unavailable';
export interface Segment { key: string; provenance: Provenance; captured_at: number; data?: unknown; unavailable?: string }
interface Snapshot { version: 1; id: string; created_at: number; expires_at: number; segments: Segment[] }
const secretKey = /authorization|cookie|password|passwd|secret|token|api[_-]?key|credential|private[_-]?key/i;

// Redaction affects inspector copies only, never the request sent to Codex.
export function redact(value: unknown, secrets: string[] = []): unknown {
  if (typeof value === 'string') {
    try {
      const parsed: unknown = JSON.parse(value);
      if (parsed && typeof parsed === 'object') { const safe = redact(parsed, secrets); if (JSON.stringify(safe) !== JSON.stringify(parsed)) return JSON.stringify(safe); }
    } catch { /* preserve original plain text / JSON formatting */ }
    let text = value;
    for (const secret of [...secrets].filter(Boolean).sort((a,b) => b.length-a.length)) text = text.split(secret).join('[REDACTED]');
    text = text.replace(/-----BEGIN [^-]*PRIVATE KEY-----[\s\S]*?-----END [^-]*PRIVATE KEY-----/g, '[REDACTED PRIVATE KEY]')
      .replace(/\b(?:Bearer|Basic)\s+[A-Za-z0-9._~+/=-]+/gi, '[REDACTED AUTHORIZATION]')
      .replace(/\b(?:sk|pk|ghp|github_pat|gho|AKIA)[-_][A-Za-z0-9_-]{10,}/g, '[REDACTED KEY]')
      .replace(/\bAKIA[A-Z0-9]{16}\b/g, '[REDACTED KEY]')
      .replace(/(https?:\/\/)[^\s/@]+:[^\s/@]+@/gi, '$1[REDACTED]@')
      .replace(/((?:authorization|cookie|password|passwd|secret(?:[_-]?key)?|(?:access[_-]?|refresh[_-]?)?token|api[_-]?key|private[_-]?key|credential)[\\"']*\s*[=:]\s*)(?:\\?"[^"\n]*\\?"|'[^'\n]*'|[^\s,;&}\n]+)/gi, '$1[REDACTED]');
    return text;
  }
  if (Array.isArray(value)) return value.map(item => redact(item, secrets));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key,item]) => [key, secretKey.test(key) && !/^(?:input_tokens|output_tokens|cached_input_tokens|reasoning_output_tokens|cache_write_input_tokens|total_tokens|prompt_tokens|completion_tokens|prompt_tokens_details|completion_tokens_details|cached_tokens|reasoning_tokens)$/.test(key) ? '[REDACTED]' : redact(item, secrets)]));
  return value;
}

export class Inspector {
  private directory: string;
  private queue: Promise<unknown> = Promise.resolve();
  private deleted = new Map<string, number>();
  private cutoff = 0;
  private timer: ReturnType<typeof setInterval>;
  constructor(private config: Config, private warn: () => void) {
    this.directory = join(config.dataDir, 'request-inspector');
    this.timer = setInterval(() => { void this.serial(() => this.purge()); }, Math.min(60_000, config.inspectorRetention));
    this.timer.unref();
  }
  private serial<T>(action: () => Promise<T>): Promise<T | undefined> {
    const next = this.queue.then(action).catch(() => { this.warn(); return undefined; });
    this.queue = next;
    return next;
  }
  private path(id: string) { if (!/^[a-f0-9-]{36}$/.test(id)) throw new Error('Invalid inspector ID'); return join(this.directory, `${id}.json`); }
  private async load(id: string): Promise<Snapshot | null> {
    try {
      const record = JSON.parse(await readFile(this.path(id), 'utf8')) as Snapshot;
      if (!record || record.version !== 1 || record.id !== id || !Number.isFinite(record.created_at) || !Number.isFinite(record.expires_at) || !Array.isArray(record.segments)) throw new Error('Invalid inspector snapshot');
      return record;
    }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; }
  }
  async init() { await this.serial(() => this.purge()); }
  private async purge() {
    for (const [id,expires] of this.deleted) if (expires <= Date.now()) this.deleted.delete(id);
    let files: string[];
    try { files = await readdir(this.directory); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw error; }
    for (const file of files) {
      if (/^[a-f0-9-]{36}\.json\.tmp$/.test(file)) {
        if ((await stat(join(this.directory,file))).mtimeMs + this.config.inspectorRetention <= Date.now()) await rm(join(this.directory,file), {force:true});
        continue;
      }
      if (!/^[a-f0-9-]{36}\.json$/.test(file)) continue;
      let record: Snapshot | null;
      try { record = await this.load(file.slice(0,-5)); } catch { await rm(join(this.directory,file), {force:true}); continue; }
      if (record && Math.min(record.expires_at, record.created_at + this.config.inspectorRetention) <= Date.now()) await rm(join(this.directory,file), { force: true });
    }
  }
  async capture(id: string, createdAt: number, key: string, provenance: Provenance, data: unknown, ephemeral = false) {
    if (!this.config.inspectorEnabled || ephemeral) return;
    await this.serial(async () => {
      if (this.deleted.has(id) || createdAt <= this.cutoff || createdAt + this.config.inspectorRetention <= Date.now()) return;
      const record = await this.load(id) ?? { version: 1 as const, id, created_at: createdAt, expires_at: createdAt + this.config.inspectorRetention, segments: [] };
      const segment: Segment = { key, provenance, captured_at: Date.now(), data: redact(data, this.config.inspectorSecrets) };
      record.segments = record.segments.filter(s => s.key !== key);
      if (Buffer.byteLength(JSON.stringify({...record,segments:[...record.segments,segment]})) > this.config.inspectorMaxBytes) {
        delete segment.data; segment.unavailable = 'Segment exceeds configured snapshot byte limit; no partial content retained.';
      }
      record.segments.push(segment);
      await mkdir(this.directory, { recursive: true, mode: 0o700 });
      await writeFile(`${this.path(id)}.tmp`, JSON.stringify(record), { mode: 0o600 });
      await rename(`${this.path(id)}.tmp`, this.path(id));
    });
  }
  async detail(id: string, ephemeral = false) {
    return await this.serial(async () => {
      await this.purge();
      const snapshot = !ephemeral && this.config.inspectorEnabled ? await this.load(id) : null;
      return { enabled: this.config.inspectorEnabled, retention_ms: this.config.inspectorRetention, max_bytes: this.config.inspectorMaxBytes,
        status: ephemeral ? 'ephemeral' : snapshot ? 'captured' : !this.config.inspectorEnabled ? 'disabled' : 'unavailable', snapshot,
        limitation: 'Gateway/CLI observable context only. Provider-internal instructions, resumed CLI history, compaction and private reasoning are unavailable. No per-segment token accounting.' };
    }) ?? { enabled: this.config.inspectorEnabled, status: 'unavailable', snapshot: null };
  }
  async delete(id?: string) {
    const result = await this.serial(async () => {
      if (id) { this.deleted.set(id, Date.now() + this.config.inspectorRetention); await rm(this.path(id), { force: true }); await rm(`${this.path(id)}.tmp`, {force:true}); }
      else {
        this.cutoff = Date.now();
        let files: string[]; try { files = await readdir(this.directory); } catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') return true; throw e; }
        for (const file of files) if (/^[a-f0-9-]{36}\.json(?:\.tmp)?$/.test(file)) await rm(join(this.directory,file), {force:true});
      }
      return true;
    });
    return result === true;
  }
  async close() { clearInterval(this.timer); await this.queue; }
}
