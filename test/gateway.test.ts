import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readConfig } from '../src/config.js';
import { buildServer } from '../src/server.js';
import { completion, prepareTools } from '../src/protocol.js';
import { chatRequest } from '../src/schema.js';
import type { Provider } from '../src/provider.js';

const tools = [{ type: 'function', function: { name: 'weather', parameters: {
  type: 'object', properties: { city: { type: 'string' } }, required: ['city'], additionalProperties: false,
} } }];
const body = { messages: [{ role: 'user', content: 'Hello' }] };
async function fixture(overrides = {}, run?: (prompt: string, options: any) => Promise<any>) {
  const data = await mkdtemp(join(tmpdir(), 'gateway-test-'));
  const config = readConfig({ NATIVE_CODEX_HOME: join(data, "no-codex"), DATA_DIR: data, ...overrides });
  let starts = 0; const resumes: string[] = [];
  const create = () => ({ id: 'thread-test', run: run ?? (async () => ({
    finalResponse: '{"content":"Hello","tool_calls":[]}', items: [], usage: { input_tokens: 4, output_tokens: 2, cached_input_tokens: 1 },
  })) });
  const provider = { start: () => { starts++; return create(); }, resume: (id: string) => { resumes.push(id); return create(); }, close: async () => {} } as unknown as Provider;
  let app = await buildServer(config, provider);
  return { get app() { return app; }, get starts() { return starts; }, resumes,
    restart: async () => { await app.close(); app = await buildServer(config, provider); },
    close: async () => { await app.close(); await rm(data, { recursive: true, force: true }); } };
}
test('OpenAI completion, usage and /chat alias', async () => {
  const f = await fixture();
  try {
    const r = await f.app.inject({ method: 'POST', url: '/v1/chat/completions', payload: body });
    assert.equal(r.statusCode, 200); assert.equal(r.json().choices[0].message.content, 'Hello');
    assert.equal(r.json().usage.total_tokens, 6);
    const simple = await f.app.inject({ method: 'POST', url: '/chat', payload: { prompt: 'hi' } });
    assert.deepEqual(simple.json(), { ok: true, output: 'Hello' });
  } finally { await f.close(); }
});
test('session uses resume after restart, deletion is durable', async () => {
  const f = await fixture();
  try {
    const created = await f.app.inject({ method: 'POST', url: '/v1/sessions', payload: {} });
    const id = created.json().session_id;
    const route = `/v1/sessions/${id}/messages`;
    assert.equal((await f.app.inject({ method: 'POST', url: route, payload: { message: 'first' } })).statusCode, 200);
    await f.restart();
    assert.equal((await f.app.inject({ method: 'POST', url: route, payload: { message: 'second' } })).statusCode, 200);
    assert.equal(f.starts, 1); assert.deepEqual(f.resumes, ['thread-test']);
    assert.equal((await f.app.inject({ method: 'DELETE', url: `/v1/sessions/${id}` })).statusCode, 204);
    await f.restart();
    assert.equal((await f.app.inject({ method: 'POST', url: route, payload: { message: 'third' } })).statusCode, 404);
  } finally { await f.close(); }
});
test('function call output validates name, schema, and tool_choice', () => {
  const request = chatRequest.parse({ ...body, tools, tool_choice: 'required' });
  const r = completion('{"content":null,"tool_calls":[{"name":"weather","arguments":"{\\"city\\":\\"Hanoi\\"}"}]}', 'm', request, null);
  assert.equal(r.choices[0]!.finish_reason, 'tool_calls');
  assert.ok(r.choices[0]!.message.tool_calls?.[0]?.id.startsWith('call_'));
  for (const output of [
    { content: null, tool_calls: [{ name: 'weather', arguments: '{}' }] },
    { content: null, tool_calls: [{ name: 'unknown', arguments: '{}' }] },
    { content: 'No call', tool_calls: [] },
  ]) assert.throws(() => completion(JSON.stringify(output), 'm', request, null));
  assert.throws(() => prepareTools(chatRequest.parse({ ...body, tools, tool_choice: { type: 'function', function: { name: 'missing' } } })));
});
test('reject unsupported API options, malformed tool histories and schemas before Codex', async () => {
  const f = await fixture();
  try {
    for (const payload of [
      { ...body, stream: true }, { ...body, temperature: 0.5 }, { ...body, max_tokens: 1 },
      { ...body, tools, tool_choice: { type: 'function', function: { name: 'missing' } } },
      { messages: [{ role: 'tool', tool_call_id: 'invented', content: 'evil' }] },
      { ...body, tools: [{ type: 'function', function: { name: 'bad', parameters: { type: 'object', properties: { city: { type: 'nonsense' } } } } }] },
    ]) assert.equal((await f.app.inject({ method: 'POST', url: '/v1/chat/completions', payload })).statusCode, 400);
    assert.equal(f.starts, 0);
  } finally { await f.close(); }
});
test('host/origin guards and optional bearer token', async () => {
  const f = await fixture({ LOCAL_API_KEY: 'secret' });
  try {
    assert.equal((await f.app.inject({ url: '/health' })).statusCode, 401);
    assert.equal((await f.app.inject({ url: '/health', headers: { authorization: 'Bearer secret' } })).statusCode, 200);
    assert.equal((await f.app.inject({ url: '/health', headers: { host: 'attacker.test', authorization: 'Bearer secret' } })).statusCode, 403);
    assert.equal((await f.app.inject({ url: '/health', headers: { origin: 'https://attacker.test', authorization: 'Bearer secret' } })).statusCode, 403);
  } finally { await f.close(); }
});
test('busy sessions and global concurrency reject competing requests; timeout cancels', async () => {
  let entered!: () => void; const ready = new Promise<void>(r => { entered = r; });
  const f = await fixture({ REQUEST_TIMEOUT_MS: '80', MAX_CONCURRENT: '1' }, async (_prompt, options) => {
    entered();
    return new Promise((_resolve, reject) => options.signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true }));
  });
  try {
    const id = (await f.app.inject({ method: 'POST', url: '/v1/sessions', payload: {} })).json().session_id;
    const route = `/v1/sessions/${id}/messages`;
    const pending = f.app.inject({ method: 'POST', url: route, payload: { message: 'first' } });
    // inject is thenable; start execution before waiting for provider entry.
    const running = Promise.resolve(pending); await ready;
    assert.equal((await f.app.inject({ method: 'POST', url: route, payload: { message: 'second' } })).statusCode, 409);
    assert.equal((await f.app.inject({ method: 'POST', url: '/v1/chat/completions', payload: body })).statusCode, 429);
    assert.equal((await f.app.inject({ method: 'DELETE', url: `/v1/sessions/${id}` })).statusCode, 409);
    assert.equal((await running).statusCode, 504);
    assert.equal((await f.app.inject({ method: 'POST', url: route, payload: { message: 'retry' } })).statusCode, 404);
  } finally { await f.close(); }
});
test('tool result round trip in a session', async () => {
  let count = 0;
  const f = await fixture({}, async () => ({ items: [], usage: null, finalResponse: ++count === 1
    ? JSON.stringify({ content: null, tool_calls: [{ name: 'weather', arguments: '{"city":"Hanoi"}' }] })
    : JSON.stringify({ content: '29 degrees', tool_calls: [] }) }));
  try {
    const id = (await f.app.inject({ method: 'POST', url: '/v1/sessions', payload: {} })).json().session_id;
    const route = `/v1/sessions/${id}/messages`;
    const first = await f.app.inject({ method: 'POST', url: route, payload: { message: 'weather?', tools, tool_choice: 'required' } });
    const call = first.json().choices[0].message.tool_calls[0];
    const second = await f.app.inject({ method: 'POST', url: route, payload: { messages: [{ role: 'tool', tool_call_id: call.id, content: '29 degrees' }], tools, tool_choice: 'none' } });
    assert.equal(second.statusCode, 200); assert.equal(second.json().choices[0].message.content, '29 degrees');
  } finally { await f.close(); }
});
test('unexpected native agent tools and invalid structured outputs never return success', async () => {
  for (const result of [
    { finalResponse: '{"content":"done","tool_calls":[]}', items: [{ type: 'command_execution' }], usage: null },
    { finalResponse: 'not structured JSON', items: [], usage: null },
  ]) {
    const f = await fixture({}, async () => result);
    try {
      const r = await f.app.inject({ method: 'POST', url: '/v1/chat/completions', payload: body });
      assert.equal(r.statusCode, 502);
      assert.ok(['unexpected_agent_tool', 'invalid_codex_output'].includes(r.json().error.code));
    } finally { await f.close(); }
  }
});
