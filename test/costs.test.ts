import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { estimateCost, periodKey } from '../src/catalog.js';
import { Metrics } from '../src/metrics.js';
import { buildServer } from '../src/server.js';
import { readConfig } from '../src/config.js';
import type { Provider } from '../src/provider.js';

test('cost separates cached input, leaves missing prices unknown, and uses Vietnam calendar boundaries', () => {
  const c = estimateCost('gpt-6.1-sol', 1000000, 100000, 400000)!;
  assert.equal(c.input_cost_usd,1.2); assert.equal(c.cached_cost_usd,0.04); assert.equal(c.output_cost_usd,1);
  assert.equal(c.cost_usd,2.24);
  assert.equal(estimateCost('unknown',100,20,0),null);
  assert.equal(estimateCost('deepseek-v4.1-flash',100,20,0),null);
  assert.equal(periodKey(Date.parse('2026-10-04T17:00:00Z'),'week'),'2026-10-05');
  assert.equal(periodKey(Date.parse('2026-10-04T16:59:59Z'),'week'),'2026-09-28');
  assert.equal(periodKey(Date.parse('2026-09-30T17:00:00Z'),'month'),'2026-10');
  assert.equal(periodKey(Date.parse('2026-09-30T16:59:59Z'),'day'),'2026-09-30');
});

test('migration backfills old calls, persists price snapshots, and groups all historical costs', async () => {
  const dir = await mkdtemp(join(tmpdir(),'cost-migration-')); const path = join(dir,'stats.sqlite');
  let m = new Metrics(path);
  const id = m.begin('/chat','gpt-6.1-sol','low',null); m.running(id);
  m.usage(id,{ input_tokens:1000000, output_tokens:100000, cached_input_tokens:400000, cache_write_input_tokens:0 }); m.finish(id,10,200); m.close();
  const db = new DatabaseSync(path);
  db.prepare('UPDATE calls SET started_at=?, cost_usd=NULL,price_checked_on=NULL WHERE id=?').run(Date.parse('2026-09-30T16:59:59Z'),id);
  for (const column of ['cost_usd','input_cost_usd','output_cost_usd','cached_cost_usd','input_rate','output_rate','cached_rate','price_checked_on','price_source']) db.exec(`ALTER TABLE calls DROP COLUMN ${column}`);
  db.close(); m = new Metrics(path);
  try {
    assert.equal(m.detail(id)!.cost_usd,2.24);
    const october = m.costs('month',undefined,Date.parse('2026-10-02T00:00:00Z'));
    assert.equal(october.current.total,2.24); assert.equal(october.current.month,0);
    assert.equal(october.periods[0]!.period,'2026-09');
    m.close();
    const frozen = new DatabaseSync(path); frozen.prepare('UPDATE calls SET cost_usd=7 WHERE id=?').run(id); frozen.close();
    m = new Metrics(path); assert.equal(m.detail(id)!.cost_usd,7);
  } finally { m.close(); await rm(dir,{recursive:true,force:true}); }
});

test('playground requires same origin, uses ephemeral provider and exposes metadata without conversation', async () => {
  const dir = await mkdtemp(join(tmpdir(),'playground-')); let ephemeral = false;
  const provider = { start: (_m: string,_e: string,tmp: boolean) => { ephemeral = tmp; return { id:'tmp', run:async () => ({ items:[], finalResponse:'{"content":"ok","tool_calls":[]}',usage:{input_tokens:100,output_tokens:20,cached_input_tokens:30} }) }; },close:async()=>{} } as unknown as Provider;
  const app = await buildServer(readConfig({ DATA_DIR:dir,LOCAL_API_KEY:'secret' }),provider);
  const payload = { messages:[{role:'user',content:'private prompt'}] };
  const headers = { origin:'http://localhost:80','x-codex-playground':'1',authorization:'Bearer secret' };
  try {
    assert.equal((await app.inject({method:'POST',url:'/api/playground/chat',payload})).statusCode,403);
    assert.equal((await app.inject({method:'POST',url:'/api/playground/chat',payload,headers:{...headers,origin:'https://evil.test'}})).statusCode,403);
    assert.equal((await app.inject({method:'POST',url:'/api/playground/chat',payload,headers:{...headers,authorization:''}})).statusCode,401);
    const response = await app.inject({method:'POST',url:'/api/playground/chat',payload,headers});
    assert.equal(response.statusCode,200); assert.equal(ephemeral,true);
    const id = response.headers['x-codex-call-id'];
    const detail = await app.inject({url:`/api/stats/calls/${id}`,headers});
    assert.equal(detail.statusCode,200); assert.equal(detail.json().status,'success'); assert.ok(detail.json().cost_usd > 0);
    assert.ok(!detail.body.includes('private prompt')); assert.equal(detail.json().session_id,null);
    assert.equal((await app.inject({url:'/api/models',headers})).json().models.length,15);
    assert.equal((await app.inject({url:'/api/stats/costs?group=invalid',headers})).statusCode,400);
    assert.equal((await app.inject({method:'POST',url:'/v1/chat/completions',payload,headers})).statusCode,403);
  } finally { await app.close(); await rm(dir,{recursive:true,force:true}); }
});
