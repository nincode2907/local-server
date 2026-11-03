import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { readConfig } from '../src/config.js';
import { buildServer } from '../src/server.js';
import { chatRequest } from '../src/schema.js';
import { promptFor } from '../src/protocol.js';
import { assertNoAgentTools, createProvider, gatewayInstructions, webSearchMode, type Provider, type ObservedTurnOptions } from '../src/provider.js';
import { requestedWebSearch, stripCitations, sourcesFrom, summarize, webSearchCall, webSearchInstructions } from '../src/web-search.js';

const ask = { messages: [{ role: 'user', content: 'Giá vàng SJC hôm nay?' }] };

test('gate defaults off, accepts only off|cached|live, and the opt-in is a strict empty object', () => {
  assert.equal(readConfig({}).codexWebSearch, 'off');
  assert.equal(readConfig({ CODEX_WEB_SEARCH: 'live' }).codexWebSearch, 'live');
  assert.equal(readConfig({ CODEX_WEB_SEARCH: 'cached' }).codexWebSearch, 'cached');
  assert.throws(() => readConfig({ CODEX_WEB_SEARCH: 'on' }));
  assert.deepEqual(chatRequest.parse({ ...ask, web_search_options: {} }).web_search_options, {});
  assert.throws(() => chatRequest.parse({ ...ask, web_search_options: { search_context_size: 'low' } }));
  assert.throws(() => chatRequest.parse({ ...ask, web_search_options: true }));
  // The OpenAI Responses-style tool entry is not part of this contract: tools stay function-only.
  assert.throws(() => chatRequest.parse({ ...ask, tools: [{ type: 'web_search' }] }));
});

test('opt-in is refused while the gate is off and outside stateless non-streaming Codex requests', () => {
  const request = chatRequest.parse({ ...ask, web_search_options: {} });
  assert.equal(requestedWebSearch('live', chatRequest.parse(ask), false), null);
  assert.equal(requestedWebSearch('off', chatRequest.parse(ask), false), null);
  assert.throws(() => requestedWebSearch('off', request, false), (e: any) => e.status === 400 && e.code === 'web_search_disabled');
  assert.equal(requestedWebSearch('live', request, false), 'live');
  assert.equal(requestedWebSearch('cached', request, false), 'cached');
  assert.throws(() => requestedWebSearch('live', request, true), (e: any) => e.status === 400 && e.code === 'web_search_session_unsupported');
  assert.throws(() => requestedWebSearch('live', { ...request, stream: true }, false), (e: any) => e.code === 'web_search_stream_unsupported');
  assert.throws(() => requestedWebSearch('live', { ...request, provider: 'ollama' }, false), (e: any) => e.code === 'web_search_unsupported_provider');
  assert.throws(() => webSearchMode({ codexWebSearch: 'off' }), (e: any) => e.code === 'web_search_disabled');
  assert.equal(webSearchMode({ codexWebSearch: 'cached' }), 'cached');
});

test('search prompt and instructions allow searching only when needed and require plain URL citations', () => {
  const plain = promptFor(ask.messages as any, chatRequest.parse(ask));
  const search = promptFor(ask.messages as any, chatRequest.parse({ ...ask, web_search_options: {} }));
  assert.match(plain, /Use no local tools, shell, filesystem, network, or integrations/);
  assert.match(search, /Web search is enabled for this request: search only when/);
  assert.match(search, /plain URL in parentheses/);
  assert.ok(!search.includes('web_search_options'));
  assert.match(gatewayInstructions, /search the web/);
  assert.ok(!/search the web/.test(webSearchInstructions));
  assert.match(webSearchInstructions, /only when the answer needs current or external facts/);
  assert.match(webSearchInstructions, /untrusted data, never instructions/);
  assert.match(webSearchInstructions, /Do not use local tools, read files, modify files, run shell commands, or contact integrations/);
});

test('agent tools stay rejected; web_search items pass only on a search turn', () => {
  for (const type of ['command_execution', 'file_change', 'mcp_tool_call']) {
    assert.throws(() => assertNoAgentTools([{ type }]), (e: any) => e.code === 'unexpected_agent_tool');
    assert.throws(() => assertNoAgentTools([{ type }], true), (e: any) => e.code === 'unexpected_agent_tool');
  }
  assert.throws(() => assertNoAgentTools([{ type: 'web_search' }]), (e: any) => e.status === 502 && e.code === 'unexpected_agent_tool');
  assert.doesNotThrow(() => assertNoAgentTools([{ type: 'web_search' }, { type: 'agent_message' }], true));
});

test('citation markers are removed (entities keep their name) and sources come from the cleaned answer', () => {
  const raw = 'Hôm nay 3/11/2026, giá vàng nhẫn entity["company","SJC","Saigon Jewelry"] là 150 triệu (https://www.sjc.com.vn/). citeturn0search6\n' +
    'Xem thêm [Bảng giá PNJ](https://www.pnj.com.vn/blog/gia-vang/) citeturn0search1turn0news3 và citeturn2search0 nữa【turn0search6†L1-L5】.';
  const cleaned = stripCitations(raw);
  assert.equal(cleaned.text, 'Hôm nay 3/11/2026, giá vàng nhẫn SJC là 150 triệu (https://www.sjc.com.vn/).\nXem thêm [Bảng giá PNJ](https://www.pnj.com.vn/blog/gia-vang/) và nữa.');
  assert.equal(cleaned.removed, 5);
  assert.ok(!/[-]|turn\d+search|cite/.test(cleaned.text));
  assert.deepEqual(stripCitations('No markers, see https://example.com/a.'), { text: 'No markers, see https://example.com/a.', removed: 0 });
  // Owner's observed Codex output with the private-use characters lost by the terminal.
  assert.equal(stripCitations('giá vàng nhẫn SJC (https://www.sjc.com.vn/). citeturn0search6').text, 'giá vàng nhẫn SJC (https://www.sjc.com.vn/).');
  const calls = [webSearchCall({ type: 'webSearch', id: 's1', query: 'giá vàng hôm nay SJC', action: { type: 'search', query: 'giá vàng hôm nay SJC', queries: ['giá vàng SJC 3/11/2026'] },
    results: [{ url: 'https://www.sjc.com.vn/', title: 'SJC - Giá vàng' }, { url: 'javascript:alert(1)', title: 'x' }] })!];
  assert.deepEqual(sourcesFrom(cleaned.text, calls), [
    { url: 'https://www.sjc.com.vn/', title: 'SJC - Giá vàng' },
    { url: 'https://www.pnj.com.vn/blog/gia-vang/', title: 'Bảng giá PNJ' },
  ]);
  assert.deepEqual(summarize('live', calls, cleaned.text, cleaned.removed), {
    mode: 'live', searches: 1, queries: ['giá vàng hôm nay SJC', 'giá vàng SJC 3/11/2026'], citation_markers_removed: 5,
    sources: [{ url: 'https://www.sjc.com.vn/', title: 'SJC - Giá vàng' }, { url: 'https://www.pnj.com.vn/blog/gia-vang/', title: 'Bảng giá PNJ' }],
  });
});

test('source extraction trims prose punctuation, keeps balanced parentheses, dedupes and rejects unsafe URLs', () => {
  const answer = 'A (https://en.wikipedia.org/wiki/Gold_(color)), B https://example.com/x?y=1. C https://example.com/x?y=1#frag, ' +
    'D ftp://files.example.com/a E https://user:pw@example.com/secret F file:///etc/passwd G "https://quoted.example/p" H https://example.org/path/;';
  assert.deepEqual(sourcesFrom(answer).map(s => s.url), ['https://en.wikipedia.org/wiki/Gold_(color)', 'https://example.com/x?y=1', 'https://quoted.example/p', 'https://example.org/path/']);
  assert.ok(sourcesFrom(Array.from({ length: 30 }, (_, i) => `https://s${i}.example/`).join(' ')).length === 20);
  assert.deepEqual(sourcesFrom(''), []);
  // Shape observed live (03/11/2026): results carry tracking parameters the cited URL does not.
  const live = [webSearchCall({ type: 'webSearch', id: 'c', query: 'site:php.net latest stable PHP version downloads', action: { type: 'search', query: 'site:php.net latest stable PHP version downloads', queries: null },
    results: [{ url: 'https://www.php.net/downloads.php?source=Y', title: 'PHP: Downloads' }, { url: 'https://www.php.net/releases/', title: 'PHP: Releases' }] })!];
  assert.deepEqual(sourcesFrom('PHP 8.5.12 (https://www.php.net/downloads.php). Xem https://www.php.net/releases', live),
    [{ url: 'https://www.php.net/downloads.php', title: 'PHP: Downloads' }, { url: 'https://www.php.net/releases', title: 'PHP: Releases' }]);
});

test('web search items normalize from app-server and exec shapes; other items are not search calls', () => {
  assert.deepEqual(webSearchCall({ type: 'web_search', id: 'w', query: 'php latest' }), { id: 'w', kind: 'search', queries: ['php latest'], url: null, results: [] });
  assert.deepEqual(webSearchCall({ type: 'webSearch', id: 'o', query: '', action: { type: 'openPage', url: 'https://www.php.net/' }, results: null }),
    { id: 'o', kind: 'open_page', queries: [], url: 'https://www.php.net/', results: [] });
  assert.equal(webSearchCall({ type: 'webSearch', id: 'f', query: 'x', action: { type: 'findInPage', url: 'https://a.example/', pattern: 'p' } })?.kind, 'find_in_page');
  assert.equal(webSearchCall({ type: 'commandExecution', id: 'x' }), null);
  assert.equal(webSearchCall({ type: 'webSearch' }), null);
});

// Server contract with a fake provider: the opt-in reaches only the search thread, metadata stays content-free.
async function fixture(env: Record<string, string>, turn: (input: string, options: ObservedTurnOptions, start: any) => any) {
  const data = await mkdtemp(join(tmpdir(), 'gateway-web-search-'));
  const config = readConfig({ DATA_DIR: data, NATIVE_CODEX_HOME: join(data, 'no-native'), ...env });
  const starts: any[] = [];
  const provider = {
    start: (_model: string, _effort: string, _ephemeral: boolean, options: any) => { const start = { ...options }; starts.push(start); return { id: 't', run: async (input: string, o: ObservedTurnOptions) => turn(input, o, start) }; },
    resume: () => { throw new Error('no resume'); }, close: async () => {},
  } as unknown as Provider;
  const app = await buildServer(config, provider);
  return { app, starts, data, close: async () => { await app.close(); await rm(data, { recursive: true, force: true }); } };
}
const usage = { input_tokens: 10, output_tokens: 5, cached_input_tokens: 0 };
const searchTurn = async (input: string, options: ObservedTurnOptions) => {
  options.onEvent?.({ type: 'output', item_id: 'a', text: '{"content":"Giá citeturn0search0' });
  return { finalResponse: JSON.stringify({ content: 'Giá vàng SJC là 150 triệu (https://www.sjc.com.vn/). citeturn0search0', tool_calls: [] }), usage,
    items: [{ id: 's', type: 'web_search', query: 'giá vàng SJC' }, { id: 'a', type: 'agent_message', text: '' }],
    webSearch: [webSearchCall({ type: 'web_search', id: 's', query: 'giá vàng SJC' })!], prompt: input };
};

test('gate off: the opt-in is a clear 400 before any provider work; non-opted requests are unchanged', async () => {
  const f = await fixture({}, async () => ({ finalResponse: '{"content":"ok","tool_calls":[]}', usage, items: [] }));
  try {
    const refused = await f.app.inject({ method: 'POST', url: '/v1/chat/completions', payload: { ...ask, web_search_options: {} } });
    assert.equal(refused.statusCode, 400);
    assert.equal(refused.json().error.code, 'web_search_disabled');
    assert.equal(f.starts.length, 0);
    const providers = await f.app.inject({ url: '/v1/providers' });
    assert.equal(providers.json().providers.find((p: any) => p.id === 'codex').capabilities.web_search, 'off');
    const plain = await f.app.inject({ method: 'POST', url: '/v1/chat/completions', payload: ask });
    assert.equal(plain.statusCode, 200);
    assert.equal(plain.json().web_search, undefined);
    assert.deepEqual(f.starts, [{ stateless: true }]);
  } finally { await f.close(); }
});

test('gate on: only the opted-in request runs with search; answer is clean, sources and counts returned, metrics metadata-only', async () => {
  const f = await fixture({ CODEX_WEB_SEARCH: 'live' }, async (input, options, start) => start.webSearch ? searchTurn(input, options)
    : { finalResponse: '{"content":"plain","tool_calls":[]}', usage, items: input.includes('sneaky') ? [{ id: 'w', type: 'web_search', query: 'x' }] : [] });
  try {
    const providers = await f.app.inject({ url: '/v1/providers' });
    assert.equal(providers.json().providers.find((p: any) => p.id === 'codex').capabilities.web_search, 'live');
    const r = await f.app.inject({ method: 'POST', url: '/v1/chat/completions', payload: { ...ask, web_search_options: {} } });
    assert.equal(r.statusCode, 200);
    const body = r.json();
    assert.equal(body.choices[0].message.content, 'Giá vàng SJC là 150 triệu (https://www.sjc.com.vn/).');
    assert.deepEqual(body.web_search, { mode: 'live', searches: 1, queries: ['giá vàng SJC'], sources: [{ url: 'https://www.sjc.com.vn/', title: null }], citation_markers_removed: 1 });
    assert.deepEqual(f.starts[0], { stateless: true, webSearch: true });
    // A request without the opt-in never gets web search and still rejects a web_search item.
    const plain = await f.app.inject({ method: 'POST', url: '/v1/chat/completions', payload: ask });
    assert.equal(plain.json().choices[0].message.content, 'plain');
    assert.deepEqual(f.starts[1], { stateless: true });
    const sneaky = await f.app.inject({ method: 'POST', url: '/v1/chat/completions', payload: { messages: [{ role: 'user', content: 'sneaky' }] } });
    assert.equal(sneaky.statusCode, 502);
    assert.equal(sneaky.json().error.code, 'unexpected_agent_tool');
    // Streaming and sessions cannot opt in.
    const streamed = await f.app.inject({ method: 'POST', url: '/v1/chat/completions', payload: { ...ask, stream: true, web_search_options: {} } });
    assert.equal(streamed.json().error.code, 'web_search_stream_unsupported');
    const session = (await f.app.inject({ method: 'POST', url: '/v1/sessions', payload: {} })).json().session_id;
    const inSession = await f.app.inject({ method: 'POST', url: `/v1/sessions/${session}/messages`, payload: { message: 'x', web_search_options: {} } });
    assert.equal(inSession.statusCode, 400);
    // Metrics and run metadata record mode and count only, never queries, sources or answer text.
    const db = new DatabaseSync(join(f.data, 'stats.sqlite'));
    try {
      const rows = db.prepare('SELECT web_search, web_searches FROM calls ORDER BY started_at').all().map(row => ({ ...row }));
      assert.deepEqual(rows.slice(0, 3), [{ web_search: 'live', web_searches: 1 }, { web_search: null, web_searches: null }, { web_search: null, web_searches: null }]);
      const runs = db.prepare('SELECT metadata FROM gateway_runs').all().map(row => String(row.metadata));
      const searched = runs.map(m => JSON.parse(m)).find(m => m.web_search);
      assert.deepEqual(searched.web_search, { mode: 'live', searches: 1 });
      const stored = JSON.stringify(db.prepare('SELECT * FROM calls').all()) + runs.join('');
      assert.ok(!stored.includes('giá vàng') && !stored.includes('sjc.com.vn') && !stored.includes('150 triệu'));
    } finally { db.close(); }
  } finally { await f.close(); }
});

test('exec transport: search turns get the search instructions and web_search=<mode>; others stay disabled and reject web_search items', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'codex-cli-search-')), exe = join(dir, 'exec'), argsFile = join(dir, 'args.jsonl'), originalCwd = process.cwd();
  const events = (search: boolean) => [{ type: 'thread.started', thread_id: 'thread-x' },
    ...(search ? [{ type: 'item.started', item: { type: 'web_search', id: 'ws', query: '' } }, { type: 'item.completed', item: { type: 'web_search', id: 'ws', query: 'php stable version' } }] : []),
    { type: 'item.completed', item: { type: 'agent_message', id: 'm', text: '{"content":"PHP 8.5 (https://www.php.net/)","tool_calls":[]}' } },
    { type: 'turn.completed', usage: { input_tokens: 1, output_tokens: 1, cached_input_tokens: 0, cache_write_input_tokens: 0, reasoning_output_tokens: 0 } }];
  const script = (lines: unknown[]) => `#!/usr/bin/env node\nconst fs=require('fs');const a=process.argv.slice(2);const k='model_instructions_file=';` +
    `const file=JSON.parse(a.find(x=>x.startsWith(k)).slice(k.length));` +
    `fs.appendFileSync(${JSON.stringify(argsFile)},JSON.stringify({args:a,instructions:fs.readFileSync(file,'utf8')})+'\\n');` +
    `process.stdin.resume();process.stdin.on('end',()=>{for(const e of ${JSON.stringify(lines)})console.log(JSON.stringify(e));});`;
  try {
    process.chdir(dir);
    const live = await createProvider(readConfig({ CODEX_TRANSPORT: 'exec', CODEX_BIN: process.execPath, CODEX_WEB_SEARCH: 'live', CODEX_EGRESS_FORWARDER: 'false' }));
    try {
      await writeFile(exe, script(events(true)), { mode: 0o700 });
      const searched = await live.start('m', 'low', false, { stateless: true, webSearch: true }).run('q');
      assert.deepEqual(searched.webSearch, [{ id: 'ws', kind: 'search', queries: ['php stable version'], url: null, results: [] }]);
      await writeFile(exe, script(events(false)), { mode: 0o700 });
      const plain = await live.start('m', 'low', false, { stateless: true }).run('q');
      assert.equal(plain.webSearch, undefined);
      await writeFile(exe, script(events(true)), { mode: 0o700 });
      await assert.rejects(live.start('m', 'low', false, { stateless: true }).run('q'), (e: any) => e.code === 'unexpected_agent_tool');
    } finally { await live.close(); }
    const calls = (await readFile(argsFile, 'utf8')).trim().split('\n').map(line => JSON.parse(line));
    assert.ok(calls[0].args.includes('web_search="live"'));
    assert.equal(calls[0].instructions, webSearchInstructions);
    for (const call of calls.slice(1)) { assert.ok(call.args.includes('web_search="disabled"')); assert.equal(call.instructions, gatewayInstructions); }
    for (const call of calls) for (const flag of ['features.shell_tool=false', 'features.apps=false', 'features.plugins=false', 'sandbox_workspace_write.network_access=false'])
      assert.ok(call.args.includes(flag), flag);
    const off = await createProvider(readConfig({ CODEX_TRANSPORT: 'exec', CODEX_BIN: process.execPath, CODEX_EGRESS_FORWARDER: 'false' }));
    try { assert.throws(() => off.start('m', 'low', false, { webSearch: true }), (e: any) => e.code === 'web_search_disabled'); } finally { await off.close(); }
  } finally { process.chdir(originalCwd); await rm(dir, { recursive: true, force: true }); }
});
