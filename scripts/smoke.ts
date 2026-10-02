import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readConfig } from '../src/config.js';
import { createProvider } from '../src/provider.js';
import { buildServer } from '../src/server.js';

const dir = await mkdtemp(join(tmpdir(), 'gateway-smoke-'));
const config = readConfig({ ...process.env, DATA_DIR: dir, REQUEST_TIMEOUT_MS: '120000' });
const provider = await createProvider(config);
// Surface CLI errors here for local debugging, without exposing them in HTTP responses.
for (const method of ['start', 'resume'] as const) {
  const original = provider[method].bind(provider);
  (provider as any)[method] = (...args: any[]) => {
    const thread = (original as any)(...args);
    const run = thread.run.bind(thread);
    thread.run = async (...params: any[]) => { try { return await run(...params); } catch (error) { console.error(error); throw error; } };
    return thread;
  };
}
let app = await buildServer(config, provider);
const headers = { ...(config.apiKey && { authorization: `Bearer ${config.apiKey}` }) };
async function post(url: string, payload: unknown) {
  const r = await app.inject({ method: 'POST', url, headers, payload });
  assert.ok(r.statusCode < 300, `${r.statusCode}: ${r.body}`);
  return r.json();
}
try {
  console.log('Live chat...');
  const chat = await post('/chat', { prompt: 'Reply with exactly GATEWAY_OK', reasoning: 'low' });
  assert.match(chat.output, /GATEWAY_OK/);
  console.log('Live function call...');
  const tools = [{ type: 'function', function: { name: 'get_weather', description: 'Get current weather for a city', parameters: {
    type: 'object', properties: { city: { type: 'string' } }, required: ['city'], additionalProperties: false,
  } } }];
  const messages: any[] = [{ role: 'user', content: 'What is the weather in Hanoi? Call get_weather.' }];
  const call = await post('/v1/chat/completions', { messages, tools, tool_choice: 'required', reasoning_effort: 'low', temperature: 0 });
  assert.equal(call.choices[0].finish_reason, 'tool_calls');
  const assistant = call.choices[0].message;
  assert.equal(assistant.tool_calls[0].function.name, 'get_weather');
  const answer = await post('/v1/chat/completions', { messages: [...messages, assistant, {
    role: 'tool', tool_call_id: assistant.tool_calls[0].id, content: '{"temperature_c":29,"condition":"sunny"}',
  }], tools, tool_choice: 'none', reasoning_effort: 'low' });
  assert.match(answer.choices[0].message.content, /29/);
  console.log('Live session and restart/resume...');
  const session = await post('/v1/sessions', { reasoning: 'low' });
  await post(`/v1/sessions/${session.session_id}/messages`, { message: 'Remember: my name is Nin and my secret word is ORCHID_742. Acknowledge briefly.' });
  await app.close();
  app = await buildServer(config, await createProvider(config));
  const recalled = await post(`/v1/sessions/${session.session_id}/messages`, { message: 'What is my name and secret word?' });
  assert.match(recalled.choices[0].message.content, /Nin/);
  assert.match(recalled.choices[0].message.content, /ORCHID_742/);
  const deleted = await app.inject({ method: 'DELETE', url: `/v1/sessions/${session.session_id}`, headers });
  assert.equal(deleted.statusCode, 204);
  console.log('PASS: real ChatGPT Codex chat, tool round trip, session persistence/resume, deletion.');
} finally { await app.close(); await rm(dir, { recursive: true, force: true }); }
