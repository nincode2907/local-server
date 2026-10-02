import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { message, reasoning } from './schema.js';
import { ApiError } from './errors.js';

const recordSchema = z.object({ id: z.string().uuid(), threadId: z.string().nullable(), model: z.string(),
  effort: reasoning.optional(), messages: z.array(message), updatedAt: z.number() });
export type Session = z.infer<typeof recordSchema>;
export class Sessions {
  readonly records = new Map<string, Session>();
  readonly busy = new Set<string>();
  private writes: Promise<void> = Promise.resolve();
  constructor(private directory: string, private ttl: number, private max: number) {}
  private get file() { return join(this.directory, 'sessions.json'); }
  async init() {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    try {
      const data = z.array(recordSchema).parse(JSON.parse(await readFile(this.file, 'utf8')));
      for (const session of data) if (Date.now() - session.updatedAt < this.ttl) this.records.set(session.id, session);
    } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e; }
  }
  get(id: string) {
    const session = this.records.get(id);
    if (!session || (!this.busy.has(id) && Date.now() - session.updatedAt >= this.ttl)) {
      this.records.delete(id);
      throw new ApiError(404, 'session_not_found', 'Session not found or expired.');
    }
    return session;
  }
  async create(input: Omit<Session, 'id' | 'threadId' | 'updatedAt'>) {
    for (const s of this.records.values()) if (!this.busy.has(s.id) && Date.now() - s.updatedAt >= this.ttl) this.records.delete(s.id);
    if (this.records.size >= this.max) throw new ApiError(429, 'session_limit', 'Session limit reached. Delete unused sessions.');
    const session = { ...input, id: randomUUID(), threadId: null, updatedAt: Date.now() };
    this.records.set(session.id, session);
    await this.save(); return session;
  }
  async remove(id: string) { this.records.delete(id); await this.save(); }
  async save() {
    const data = JSON.stringify([...this.records.values()]);
    const write = this.writes.catch(() => {}).then(async () => {
      const tmp = `${this.file}.tmp`;
      await writeFile(tmp, data, { mode: 0o600 }); await rename(tmp, this.file);
    });
    this.writes = write; await write;
  }
}
