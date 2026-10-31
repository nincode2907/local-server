import { test } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { EgressForwarder, parseConnect, publicIPv4, egressAllowlist, egressEnv, openEgress, startEgressForwarder } from '../src/egress-forwarder.js';

// Raw client: send bytes to the forwarder and collect everything it returns until close.
function raw(port:number, payload:string, { keepOpen = false } = {}) {
  return new Promise<{socket:net.Socket; text:()=>string; closed:Promise<void>}>((resolve, reject) => {
    const socket = net.connect({ host:'127.0.0.1', port }, () => { socket.write(payload); resolve({ socket, text:() => Buffer.concat(chunks).toString('latin1'), closed }); });
    const chunks:Buffer[] = [];
    socket.on('data', chunk => chunks.push(chunk));
    socket.on('error', () => {});
    const closed = new Promise<void>(done => socket.once('close', () => done()));
    socket.once('error', reject);
    if (!keepOpen) socket.setTimeout(5000, () => socket.destroy());
  });
}
const status = async (port:number, payload:string) => { const c = await raw(port, payload); await c.closed; return c.text().split('\r\n')[0]; };
const waitFor = async (check:()=>boolean) => { for (let i = 0; i < 1000 && !check(); i++) await new Promise(r => setTimeout(r, 10)); assert.ok(check()); };

test('CONNECT parser accepts only allowlisted hostnames on 443', () => {
  assert.deepEqual(parseConnect('CONNECT chatgpt.com:443 HTTP/1.1\r\nHost: chatgpt.com:443', egressAllowlist), { host:'chatgpt.com', port:443 });
  assert.deepEqual(parseConnect('CONNECT ChatGPT.COM:443 HTTP/1.1', egressAllowlist), { host:'chatgpt.com', port:443 });
  const reason = (head:string) => { const r = parseConnect(head, egressAllowlist); return 'status' in r ? `${r.status} ${r.reason}` : 'allowed'; };
  assert.equal(reason('CONNECT example.com:443 HTTP/1.1'), '403 host_not_allowed');
  assert.equal(reason('CONNECT evil.chatgpt.com.attacker.net:443 HTTP/1.1'), '403 host_not_allowed');
  assert.equal(reason('CONNECT localhost:443 HTTP/1.1'), '403 host_not_allowed');
  assert.equal(reason('CONNECT 104.18.32.47:443 HTTP/1.1'), '403 ip_literal');
  assert.equal(reason('CONNECT 127.0.0.1:443 HTTP/1.1'), '403 ip_literal');
  assert.equal(reason('CONNECT [::1]:443 HTTP/1.1'), '403 target_not_allowed');
  assert.equal(reason('CONNECT chatgpt.com:80 HTTP/1.1'), '403 port_not_allowed');
  assert.equal(reason('CONNECT chatgpt.com:8443 HTTP/1.1'), '403 port_not_allowed');
  assert.equal(reason('GET http://chatgpt.com/ HTTP/1.1'), '405 method_not_allowed');
  assert.equal(reason('POST chatgpt.com:443 HTTP/1.1'), '405 method_not_allowed');
  assert.equal(reason('garbage'), '400 bad_request');
});

test('only public IPv4 upstream addresses are dialable', () => {
  for (const address of ['127.0.0.1', '10.1.2.3', '172.16.0.1', '172.31.255.1', '192.168.20.254', '169.254.1.1', '100.64.0.1', '0.0.0.0', '224.0.0.1', '255.255.255.255', '198.18.0.1', '::1', '2606:4700::1', 'chatgpt.com'])
    assert.equal(publicIPv4(address), false, address);
  for (const address of ['104.18.32.47', '172.64.155.209', '8.8.8.8']) assert.equal(publicIPv4(address), true, address);
});

test('forwarder rejects disallowed requests over the wire and resolves IPv4 only', async () => {
  const asked:string[] = [];
  const forwarder = await new EgressForwarder({ resolve4:async host => { asked.push(host); return ['127.0.0.1', '10.0.0.8']; } }).start();
  try {
    assert.match(forwarder.url!, /^http:\/\/127\.0\.0\.1:\d+$/);
    assert.equal(await status(forwarder.port!, 'CONNECT example.com:443 HTTP/1.1\r\n\r\n'), 'HTTP/1.1 403 Forbidden');
    assert.equal(await status(forwarder.port!, 'CONNECT 127.0.0.1:443 HTTP/1.1\r\n\r\n'), 'HTTP/1.1 403 Forbidden');
    assert.equal(await status(forwarder.port!, 'CONNECT chatgpt.com:22 HTTP/1.1\r\n\r\n'), 'HTTP/1.1 403 Forbidden');
    assert.equal(await status(forwarder.port!, 'GET / HTTP/1.1\r\nHost: chatgpt.com\r\n\r\n'), 'HTTP/1.1 405 Method Not Allowed');
    // An allowlisted name that resolves only to private/loopback addresses is never dialed (DNS rebinding/SSRF).
    assert.equal(await status(forwarder.port!, 'CONNECT chatgpt.com:443 HTTP/1.1\r\n\r\n'), 'HTTP/1.1 502 Bad Gateway');
    assert.deepEqual(asked, ['chatgpt.com']);
    const stats = forwarder.snapshot();
    assert.equal(Object.keys(stats.accepted).length, 0);
    assert.ok(Object.keys(stats.denied).some(key => key.startsWith('example.com:443 host_not_allowed')));
    assert.equal(stats.errors.ENOPUBLICV4, 1);
  } finally { await forwarder.close(); }
});

test('tunnel pipes bytes both ways, forwards half-close and records metadata only', async () => {
  let serverSaw = '';
  const upstream = net.createServer({ allowHalfOpen:true }, socket => {
    socket.on('data', chunk => { serverSaw += chunk.toString(); socket.write('pong:' + chunk.toString()); });
    socket.on('end', () => socket.end('bye'));
  });
  await new Promise<void>(r => upstream.listen(0, '127.0.0.1', () => r()));
  const forwarder = await new EgressForwarder({ testUpstream:{ address:'127.0.0.1', port:(upstream.address() as net.AddressInfo).port } }).start();
  try {
    // Bytes sent right after the CONNECT header (pipelined) are not lost.
    const client = await raw(forwarder.port!, 'CONNECT chatgpt.com:443 HTTP/1.1\r\nHost: chatgpt.com:443\r\n\r\nPRIVATE-ping', { keepOpen:true });
    await waitFor(() => client.text().includes('pong:PRIVATE-ping'));
    assert.ok(client.text().startsWith('HTTP/1.1 200 Connection Established\r\n\r\n'));
    client.socket.end();
    await client.closed;
    assert.ok(client.text().endsWith('bye'));
    assert.equal(serverSaw, 'PRIVATE-ping');
    await waitFor(() => forwarder.snapshot().recent.length === 1);
    const stats = forwarder.snapshot();
    assert.deepEqual(stats.accepted, { 'chatgpt.com':1 });
    assert.equal(stats.recent[0]!.bytes_up, 'PRIVATE-ping'.length);
    assert.ok(stats.recent[0]!.bytes_down > 0);
    assert.ok(!JSON.stringify(stats).includes('PRIVATE'));
    assert.equal(stats.active, 0);
  } finally { await forwarder.close(); await new Promise(r => upstream.close(r)); }
});

test('header timeout, connection limit, refused upstream and close are bounded', async () => {
  const holder = net.createServer(socket => socket.on('error', () => {}));
  await new Promise<void>(r => holder.listen(0, '127.0.0.1', () => r()));
  const slow = await new EgressForwarder({ headerTimeoutMs:100 }).start();
  try { assert.equal(await status(slow.port!, 'CONNECT chatgpt.com:443'), 'HTTP/1.1 400 Bad Request'); }
  finally { await slow.close(); }
  const forwarder = await new EgressForwarder({ maxConnections:1, testUpstream:{ address:'127.0.0.1', port:(holder.address() as net.AddressInfo).port } }).start();
  try {
    const open = await raw(forwarder.port!, 'CONNECT chatgpt.com:443 HTTP/1.1\r\n\r\n', { keepOpen:true });
    await waitFor(() => open.text().startsWith('HTTP/1.1 200'));
    assert.equal(await status(forwarder.port!, 'CONNECT chatgpt.com:443 HTTP/1.1\r\n\r\n'), 'HTTP/1.1 503 Service Unavailable');
    await forwarder.close();
    await open.closed;
    await assert.rejects(new Promise((resolve, reject) => { const s = net.connect(forwarder.port!, '127.0.0.1', () => { s.destroy(); resolve(null); }); s.once('error', reject); }));
  } finally { await forwarder.close(); await new Promise(r => holder.close(r)); }
  const refused = net.createServer(); await new Promise<void>(r => refused.listen(0, '127.0.0.1', () => r()));
  const port = (refused.address() as net.AddressInfo).port; await new Promise(r => refused.close(r));
  const failing = await new EgressForwarder({ testUpstream:{ address:'127.0.0.1', port } }).start();
  try {
    assert.equal(await status(failing.port!, 'CONNECT chatgpt.com:443 HTTP/1.1\r\n\r\n'), 'HTTP/1.1 502 Bad Gateway');
    assert.equal(failing.snapshot().errors.ECONNREFUSED, 1);
  } finally { await failing.close(); }
});

test('proxy env points only at the forwarder; disabled or failed forwarders mean direct egress', async () => {
  assert.deepEqual(egressEnv(null), {});
  assert.equal(await openEgress(false), null);
  const writes:string[] = [], write = process.stderr.write;
  process.stderr.write = ((chunk:string) => { writes.push(String(chunk)); return true; }) as typeof process.stderr.write;
  try { assert.equal(await openEgress(true, async () => { throw Object.assign(new Error('PRIVATE detail'), { code:'EADDRINUSE' }); }), null); }
  finally { process.stderr.write = write; }
  assert.match(writes.join(''), /codex_egress_forwarder_unavailable/);assert.ok(!writes.join('').includes('PRIVATE'));
  const forwarder = await startEgressForwarder();
  try { assert.deepEqual(egressEnv(forwarder), { HTTPS_PROXY:forwarder.url!, NO_PROXY:'localhost,127.0.0.1' }); }
  finally { await forwarder.close(); }
});
