import {test} from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {setTimeout as delay} from 'node:timers/promises';
import {Resources} from '../src/resources.js';

test('resources separate gateway/CLI scopes, publish complete process samples and keep GPU unknown',async()=>{
  const sampler=new Resources(),child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});
  try {
    sampler.track(child.pid!,'codex',true);await delay(120);await sampler.sample();
    const snapshot=sampler.snapshot(),point=snapshot.latest!;assert.equal(point.gateway.pid,process.pid);assert.ok(point.gateway.rss_bytes>0);assert.notEqual(point.gateway.cpu_percent,null);assert.equal(point.gpu.value,null);
    if(['darwin','linux'].includes(process.platform)){const cli=point.processes.find(p=>p.pid===child.pid)!;assert.ok(cli.available);assert.ok(cli.rss_bytes!>0);assert.equal(cli.scope,'codex_cli_process');assert.equal(cli.source,'os_ps');}
    sampler.track(child.pid!,'codex',false);await sampler.sample();assert.equal(sampler.snapshot().latest!.processes.length,0);
  }finally{sampler.close();child.kill();}
});
