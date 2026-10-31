import net from 'node:net';
import { lookup } from 'node:dns/promises';

// Gateway-owned loopback CONNECT forwarder for Codex egress. It never terminates TLS:
// bytes are piped opaquely, so content is neither read nor logged. Only metadata
// (host, timing, byte counts, error codes) is kept, bounded, in memory.
//
// Why: on hosts with a socket content filter (observed: macOS ESET network extension),
// closing a socket that never exchanged data blocks synchronously for ~1 s. Codex's
// HTTP/WebSocket stack (happy-eyeballs, IPv6 attempts) creates such sockets on every new
// connection. Through this forwarder Codex only dials 127.0.0.1, and the forwarder dials
// one IPv4 address once, without racing address families.

/** Hostnames Codex needs with ChatGPT login under the gateway policy (evidence: proxy path logs). */
export const egressAllowlist: readonly string[] = ['chatgpt.com'];
const allowedPort = 443;

export interface EgressOptions {
  allowlist?: readonly string[];
  /** IPv4 resolver; injectable for tests. Must return IPv4 literals. */
  resolve4?: (host:string) => Promise<string[]>;
  maxConnections?: number;
  connectTimeoutMs?: number;
  idleTimeoutMs?: number;
  headerTimeoutMs?: number;
  /** Dial each allowed host once at start so a slow first connection of this process is not paid by a request. */
  warm?: boolean;
  /** Test hook only (never set from configuration): dial this local endpoint instead of the resolved address. */
  testUpstream?: { address:string; port:number };
}

export interface EgressTunnel { host:string; connect_ms:number|null; duration_ms:number; bytes_up:number; bytes_down:number; result:string; at:number }
export interface EgressStats {
  port:number|null; active:number; accepted:Record<string,number>; denied:Record<string,number>; errors:Record<string,number>;
  recent:EgressTunnel[]; warm_connect_ms:number[];
}

const defaultResolve4 = async (host:string) => (await lookup(host, { all:true, family:4 })).map(entry => entry.address);

/** Reject loopback, private, link-local, CGNAT, multicast, reserved and unspecified IPv4 targets (SSRF guard). */
export function publicIPv4(address:string) {
  if (net.isIP(address) !== 4) return false;
  const [a, b] = address.split('.').map(Number) as [number, number];
  if (a === 0 || a === 10 || a === 127 || a >= 224) return false;
  if (a === 169 && b === 254) return false;
  if (a === 172 && b >= 16 && b <= 31) return false;
  if (a === 192 && b === 168) return false;
  if (a === 100 && b >= 64 && b <= 127) return false;
  if (a === 198 && (b === 18 || b === 19)) return false;
  if (a === 192 && b === 0) return false;
  return true;
}

/** Parse `CONNECT host:443 HTTP/1.x`; return a stable rejection reason instead of throwing. */
export function parseConnect(head:string, allowlist:readonly string[]): {host:string;port:number}|{status:number;reason:string} {
  const line = head.split('\r\n', 1)[0] ?? '';
  const match = /^([A-Z]+) (\S+) HTTP\/1\.[01]$/.exec(line);
  if (!match) return { status:400, reason:'bad_request' };
  if (match[1] !== 'CONNECT') return { status:405, reason:'method_not_allowed' };
  const target = match[2]!;
  const colon = target.lastIndexOf(':');
  if (colon <= 0 || target.startsWith('[')) return { status:403, reason:'target_not_allowed' };
  const host = target.slice(0, colon).toLowerCase(), portText = target.slice(colon + 1);
  if (!/^\d{1,5}$/.test(portText)) return { status:400, reason:'bad_port' };
  const port = Number(portText);
  if (net.isIP(host) !== 0) return { status:403, reason:'ip_literal' };
  if (!allowlist.includes(host)) return { status:403, reason:'host_not_allowed' };
  if (port !== allowedPort) return { status:403, reason:'port_not_allowed' };
  return { host, port };
}

export class EgressForwarder {
  private server?:net.Server;
  private sockets = new Set<net.Socket>();
  private active = 0;
  private closed = false;
  private readonly allowlist:readonly string[];
  private readonly resolve4:(host:string)=>Promise<string[]>;
  private readonly maxConnections:number;
  private readonly connectTimeoutMs:number;
  private readonly idleTimeoutMs:number;
  private readonly headerTimeoutMs:number;
  private stats:EgressStats = { port:null, active:0, accepted:{}, denied:{}, errors:{}, recent:[], warm_connect_ms:[] };

  constructor(private options:EgressOptions = {}) {
    this.allowlist = (options.allowlist ?? egressAllowlist).map(host => host.toLowerCase());
    this.resolve4 = options.resolve4 ?? defaultResolve4;
    this.maxConnections = options.maxConnections ?? 64;
    this.connectTimeoutMs = options.connectTimeoutMs ?? 10_000;
    this.idleTimeoutMs = options.idleTimeoutMs ?? 900_000;
    this.headerTimeoutMs = options.headerTimeoutMs ?? 5_000;
  }

  get port() { return this.stats.port; }
  get url() { return this.stats.port ? `http://127.0.0.1:${this.stats.port}` : null; }
  snapshot():EgressStats { return structuredClone({ ...this.stats, active:this.active }); }

  async start() {
    if (this.server) return this;
    const server = net.createServer({ allowHalfOpen:true }, client => this.accept(client));
    server.on('error', () => {});
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen({ host:'127.0.0.1', port:0, exclusive:true }, () => { server.off('error', reject); resolve(); });
    });
    // The forwarder never keeps the gateway alive on its own; its owner closes it.
    server.unref();
    this.server = server;
    this.stats.port = (server.address() as net.AddressInfo).port;
    if (this.options.warm) void this.warmUp();
    return this;
  }

  private count(bucket:Record<string,number>, key:string) {
    if (bucket[key] === undefined && Object.keys(bucket).length >= 32) key = 'other';
    bucket[key] = (bucket[key] ?? 0) + 1;
  }
  private remember(tunnel:EgressTunnel) {
    this.stats.recent.push(tunnel);
    if (this.stats.recent.length > 50) this.stats.recent.shift();
  }

  private async address(host:string) {
    if (this.options.testUpstream) return this.options.testUpstream;
    const addresses = (await this.resolve4(host)).filter(publicIPv4);
    if (!addresses.length) throw Object.assign(new Error('no public IPv4 address'), { code:'ENOPUBLICV4' });
    return { address:addresses[0]!, port:allowedPort };
  }

  /** A single IPv4 connection attempt: no family racing, so no abandoned half-open sockets. */
  private dial(host:string):Promise<{socket:net.Socket; ms:number}> {
    const started = performance.now();
    return this.address(host).then(target => new Promise((resolve, reject) => {
      const socket = net.connect({ host:target.address, port:target.port, family:4, autoSelectFamily:false, allowHalfOpen:true });
      this.sockets.add(socket);
      socket.once('close', () => this.sockets.delete(socket));
      const timer = setTimeout(() => { socket.destroy(); reject(Object.assign(new Error('connect timeout'), { code:'ETIMEDOUT' })); }, this.connectTimeoutMs);
      timer.unref();
      socket.once('connect', () => { clearTimeout(timer); socket.setNoDelay(true); resolve({ socket, ms:performance.now() - started }); });
      socket.once('error', error => { clearTimeout(timer); socket.destroy(); reject(error); });
    }));
  }

  private async warmUp() {
    for (const host of this.allowlist) {
      try {
        const { socket, ms } = await this.dial(host);
        socket.unref();
        this.stats.warm_connect_ms.push(Math.round(ms));
        // A connected socket closes without the content-filter penalty; end it gracefully.
        socket.end();
      } catch (error) { this.count(this.stats.errors, 'warm_' + String((error as NodeJS.ErrnoException).code ?? 'error')); }
    }
  }

  private reject(client:net.Socket, status:number, reason:string, key:string) {
    this.count(this.stats.denied, `${key.slice(0, 100)} ${reason}`);
    const text = status === 403 ? 'Forbidden' : status === 405 ? 'Method Not Allowed' : status === 503 ? 'Service Unavailable' : status === 504 ? 'Gateway Timeout' : status === 502 ? 'Bad Gateway' : 'Bad Request';
    client.end(`HTTP/1.1 ${status} ${text}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
    // Let the client read the status before the loopback socket is torn down.
    setTimeout(() => client.destroy(), 2_000).unref();
  }

  private accept(client:net.Socket) {
    this.sockets.add(client);
    client.once('close', () => this.sockets.delete(client));
    client.on('error', () => client.destroy());
    if (this.closed) { client.destroy(); return; }
    if (this.active >= this.maxConnections) { this.reject(client, 503, 'too_many_connections', 'limit'); return; }
    this.active++;
    let released = false;
    const release = () => { if (!released) { released = true; this.active--; } };
    client.once('close', release);
    let head = Buffer.alloc(0);
    const headerTimer = setTimeout(() => { client.off('data', onData); this.reject(client, 400, 'header_timeout', 'header'); }, this.headerTimeoutMs);
    const onData = (chunk:Buffer) => {
      head = Buffer.concat([head, chunk]);
      const end = head.indexOf('\r\n\r\n');
      if (end < 0) {
        if (head.length > 8192) { clearTimeout(headerTimer); client.off('data', onData); this.reject(client, 400, 'header_too_large', 'header'); }
        return;
      }
      clearTimeout(headerTimer); client.off('data', onData); client.pause();
      const parsed = parseConnect(head.subarray(0, end).toString('latin1'), this.allowlist);
      if ('status' in parsed) { this.reject(client, parsed.status, parsed.reason, (/^\S+ (\S+)/.exec(head.toString('latin1', 0, 200))?.[1]) ?? 'unknown'); return; }
      void this.tunnel(client, parsed.host, head.subarray(end + 4));
    };
    client.on('data', onData);
  }

  private async tunnel(client:net.Socket, host:string, rest:Buffer) {
    const started = performance.now(), at = Date.now();
    let upstream:net.Socket;
    let connectMs:number;
    try { ({ socket:upstream, ms:connectMs } = await this.dial(host)); }
    catch (error) {
      const code = String((error as NodeJS.ErrnoException).code ?? 'error');
      this.count(this.stats.errors, code);
      this.remember({ host, connect_ms:null, duration_ms:Math.round(performance.now() - started), bytes_up:0, bytes_down:0, result:code, at });
      if (!client.destroyed) this.reject(client, code === 'ETIMEDOUT' ? 504 : 502, 'upstream_' + code, host);
      return;
    }
    if (client.destroyed || this.closed) { upstream.end(); return; }
    this.count(this.stats.accepted, host);
    let result = 'closed';
    const finish = () => {
      if (!client.destroyed) client.destroy();
      if (!upstream.destroyed) upstream.destroy();
    };
    upstream.once('close', () => {
      this.remember({ host, connect_ms:Math.round(connectMs), duration_ms:Math.round(performance.now() - started), bytes_up:upstream.bytesWritten, bytes_down:upstream.bytesRead, result, at });
      finish();
    });
    client.once('close', finish);
    upstream.on('error', error => { result = String((error as NodeJS.ErrnoException).code ?? 'error'); finish(); });
    client.on('error', () => { result = 'client_error'; finish(); });
    for (const socket of [client, upstream]) socket.setTimeout(this.idleTimeoutMs, () => { result = 'idle_timeout'; finish(); });
    // Half-close is forwarded by pipe (end:true) because both sides allow half-open; the
    // tunnel is torn down once both directions have ended.
    let ended = 0;
    const halfClosed = () => { if (++ended === 2) finish(); };
    client.once('end', halfClosed); upstream.once('end', halfClosed);
    client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
    if (rest.length) upstream.write(rest);
    client.pipe(upstream); upstream.pipe(client);
    client.resume();
  }

  async close() {
    this.closed = true;
    const server = this.server;
    this.server = undefined;
    for (const socket of this.sockets) socket.destroy();
    this.sockets.clear();
    if (server) await new Promise<void>(resolve => server.close(() => resolve()));
  }
}

export async function startEgressForwarder(options:EgressOptions = {}) {
  return new EgressForwarder(options).start();
}

export type EgressFactory = () => Promise<EgressForwarder>;
export const defaultEgressFactory:EgressFactory = () => startEgressForwarder({ warm:true });

/** Start the forwarder when enabled; on failure Codex is spawned without a proxy (previous behavior). */
export async function openEgress(enabled:boolean, factory:EgressFactory = defaultEgressFactory):Promise<EgressForwarder|null> {
  if (!enabled) return null;
  try { return await factory(); }
  catch (error) {
    // Safe, bounded diagnostic: a stable code and errno only.
    process.stderr.write(JSON.stringify({ level:40, code:'codex_egress_forwarder_unavailable', errno:String((error as NodeJS.ErrnoException).code ?? 'error').slice(0, 40) }) + '\n');
    return null;
  }
}

/** Proxy variables for a Codex child. They only ever point at the gateway-owned loopback forwarder. */
export function egressEnv(forwarder:EgressForwarder|null):Record<string,string> {
  const url = forwarder?.url;
  return url ? { HTTPS_PROXY:url, NO_PROXY:'localhost,127.0.0.1' } : {};
}
