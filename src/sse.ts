import type { FastifyReply } from 'fastify';

/** Bounded transport: disconnect slow subscribers rather than blocking inference. */
export class Sse {
  private timer: ReturnType<typeof setInterval>;
  private cleanup = new Set<() => void>();
  constructor(readonly reply: FastifyReply) {
    reply.hijack();
    for (const [name,value] of Object.entries(reply.getHeaders())) if (value !== undefined) reply.raw.setHeader(name,value);
    reply.raw.writeHead(200, {'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-store', 'X-Accel-Buffering': 'no', 'X-Content-Type-Options': 'nosniff'});
    reply.raw.flushHeaders();
    this.timer = setInterval(() => this.write(': heartbeat\n\n'), 15_000); this.timer.unref();
    reply.raw.once('close', () => { clearInterval(this.timer); for (const fn of this.cleanup) fn(); this.cleanup.clear(); });
  }
  onClose(fn: () => void) { this.cleanup.add(fn); }
  write(frame: string) {
    if (this.reply.raw.destroyed || this.reply.raw.writableEnded) return false;
    if (this.reply.raw.writableLength + Buffer.byteLength(frame) > 2_097_152) { this.reply.raw.destroy(); return false; }
    this.reply.raw.write(frame); return true;
  }
  send(data: unknown, id?: string, event?: string) {
    return this.write(`${id ? `id: ${id}\n` : ''}${event ? `event: ${event}\n` : ''}data: ${JSON.stringify(data)}\n\n`);
  }
  end() { clearInterval(this.timer); this.reply.raw.end(); }
}
