import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Metrics } from '../src/metrics.js';
import { buildServer } from '../src/server.js';
import { readConfig } from '../src/config.js';
import type { Provider } from '../src/provider.js';

test('SQLite aggregates real usage, latency, tools, unknown usage and restores after restart', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'codex-stats-'));
  let metrics = new Metrics(join(directory, 'metrics.sqlite'));
  try {
    const success = metrics.begin('/chat', 'model-a', 'high', null);
    metrics.running(success);
    metrics.usage(success, { input_tokens: 100, output_tokens: 20, cached_input_tokens: 30, reasoning_output_tokens: 8, cache_write_input_tokens: 0 });
    metrics.result(success, 2, 'tool_calls'); metrics.finish(success, 2000, 200);
    const failed = metrics.begin('/chat', 'model-a', 'low', null);
    metrics.running(failed); metrics.error(failed, 'codex_timeout'); metrics.finish(failed, 4000, 504);
    const rejected = metrics.begin('/chat', 'model-b', 'medium', null);
    metrics.error(rejected, 'invalid_request'); metrics.finish(rejected, 1, 400);
    const cancelled = metrics.begin('/chat', 'model-b', 'medium', null);
    metrics.running(cancelled); metrics.finish(cancelled, 100, 499, true);
    metrics.finish(cancelled, 300, 502); // late response must not overwrite cancellation
    let summary = metrics.overview('24h').summary;
    assert.equal(summary.total_calls, 4); assert.equal(summary.successful_calls, 1);
    assert.equal(summary.failed_calls, 2); assert.equal(summary.rejected_calls, 1);
    assert.equal(summary.input_tokens, 100); assert.equal(summary.output_tokens, 20);
    assert.equal(summary.cached_tokens, 30); assert.equal(summary.reasoning_tokens, 8);
    assert.equal(summary.usage_unknown_calls, 2); assert.equal(summary.tool_calls, 2);
    assert.equal(summary.p95_duration_ms, 4000);
    assert.equal(metrics.overview('24h', 'model-a').summary.total_calls, 2);
    assert.equal(metrics.list('24h', 1, 'cancelled').data[0]!.http_status, 499);
    const interrupted = metrics.begin('/chat', 'model-a', 'high', null);
    metrics.running(interrupted);
    metrics.close(); metrics = new Metrics(join(directory, 'metrics.sqlite'));
    summary = metrics.overview('24h').summary;
    assert.equal(summary.total_calls, 5); assert.equal(summary.active_calls, 0);
    assert.equal(metrics.list('24h', 1, 'interrupted').data[0]!.duration_ms, null);
    assert.equal(metrics.overview('24h').timeline.reduce((n, row) => n + Number(row.calls), 0), 5);
  } finally { metrics.close(); await rm(directory, { recursive: true, force: true }); }
});

test('dashboard routes preserve auth and record successful, invalid, tool and failed calls only', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'codex-dashboard-'));
  const config = readConfig({ NATIVE_CODEX_HOME: join(directory, "no-codex"), DATA_DIR: directory, LOCAL_API_KEY: 'test-key' });
  let fail = false;
  const provider = {
    start: () => ({ id: 'thread-id', run: async () => {
      if (fail) throw new Error('upstream secret must not be logged');
      return { items: [], usage: { input_tokens: 10, output_tokens: 4, cached_input_tokens: 3 }, finalResponse: '{"content":"ok","tool_calls":[]}' };
    } }), resume: () => { throw new Error('unused'); }, close: async () => {},
  } as unknown as Provider;
  let app = await buildServer(config, provider);
  const headers = { authorization: 'Bearer test-key' };
  try {
    assert.equal((await app.inject({ url: '/dashboard' })).statusCode, 200);
    assert.equal((await app.inject({ url: '/dashboard/assets/app.js' })).statusCode, 200);
    assert.equal((await app.inject({ url: '/api/stats/overview' })).statusCode, 401);
    assert.equal((await app.inject({url:'/api/native/overview'})).statusCode,401);
    assert.equal((await app.inject({url:'/api/native/overview',headers:{...headers,origin:'https://evil.test'}})).statusCode,403);
    assert.equal((await app.inject({url:'/api/native/overview',headers:{...headers,origin:'http://localhost:80'}})).statusCode,200);
    assert.equal((await app.inject({url:'/api/native/overview?range=bad',headers})).statusCode,400);
    assert.equal((await app.inject({ url: '/api/stats/overview', headers: { ...headers, origin: 'https://evil.test' } })).statusCode, 403);
    assert.equal((await app.inject({ url: '/api/stats/overview', headers: { ...headers, origin: 'http://localhost:80' } })).statusCode, 200);
    assert.equal((await app.inject({ method: 'POST', url: '/chat', headers, payload: { prompt: 'hi', model: 'custom-model', reasoning: 'high' } })).statusCode, 200);
    assert.equal((await app.inject({ method: 'POST', url: '/chat', headers, payload: { model: 'custom-model' } })).statusCode, 400);
    fail = true;
    assert.equal((await app.inject({ method: 'POST', url: '/v1/chat/completions', headers, payload: { messages: [{ role: 'user', content: 'hi' }] } })).statusCode, 502);
    const summary = (await app.inject({ url: '/api/stats/overview', headers })).json().summary;
    assert.equal(summary.total_calls, 3); assert.equal(summary.successful_calls, 1);
    assert.equal(summary.failed_calls, 1); assert.equal(summary.rejected_calls, 1);
    assert.equal(summary.input_tokens, 10); assert.equal(summary.output_tokens, 4);
    const calls = (await app.inject({ url: '/api/stats/calls?model=custom-model', headers })).json();
    assert.equal(calls.total, 2); assert.equal(calls.data.find((r: any) => r.status === 'success').reasoning, 'high');
    assert.ok(!('prompt' in calls.data[0]));
    assert.equal((await app.inject({ url: '/api/stats/calls?page=0', headers })).statusCode, 400);
    await app.close(); app = await buildServer(config, provider);
    assert.equal((await app.inject({ url: '/api/stats/overview', headers })).json().summary.total_calls, 3);
  } finally { await app.close(); await rm(directory, { recursive: true, force: true }); }
});
