import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { NativeUsage } from '../src/native-usage.js';
import { VideoBuilds } from '../src/video-builds.js';
import { buildServer } from '../src/server.js';
import { readConfig } from '../src/config.js';
import type { Provider } from '../src/provider.js';

const manifest=(id='queue-protects-server'):any=>({version:1,build:{id,title:'Queue protects server',type:'explainer',engine:'remotion',duration:30,aspect_ratio:'16:9',status:'approved',revisions:0,preview_path:'preview.mp4',final_path:null,quality:{overall:9,wow:8}},stages:[
  {id:'plan',stage:'PLAN',session_id:'plan',model:'declared-model',notes:'Storyboard',approved:false},
  {id:'build',stage:'BUILD',session_id:'build',model:'declared-model',notes:'Preview',approved:true,approved_at:120}
]});
function session(db:DatabaseSync,id:string,model:string) {db.prepare('INSERT INTO native_sessions(id,cwd,source,model,created_at,updated_at) VALUES(?,?,?,?,?,?)').run(id,'/video','vscode',model,1,220);}
function usage(db:DatabaseSync,session:string,turn:string,model:string,time:number,start:number,end:number|null,cost:number|null,tokens=100) {
  db.prepare('INSERT INTO native_turns(id,session_id,model,reasoning,started_at,finished_at,status) VALUES(?,?,?,?,?,?,?)').run(`${session}:${turn}`,session,model,'low',start,end,'completed');
  db.prepare('INSERT INTO native_events(id,session_id,turn_id,model,timestamp,input_tokens,cached_tokens,output_tokens,reasoning_tokens,basis,cost_usd) VALUES(?,?,?,?,?,?,?,?,?,?,?)').run(`${session}:${turn}:event`,session,`${session}:${turn}`,model,time,tokens,20,10,0,'response_record',cost);
}

test('video migration is additive, joins live usage, preserves manifest and cuts approval before later generations',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'video-build-')),path=join(dir,'stats.sqlite');const native=new NativeUsage(path,join(dir,'none'));const db=new DatabaseSync(path);let videos=new VideoBuilds(path);
  try {
    session(db,'plan','sol');session(db,'build','luna');usage(db,'plan','p','sol',50,10,60,1);usage(db,'build','b','luna',100,70,110,2);usage(db,'build','later','luna',200,150,220,7);
    const before=db.prepare('SELECT * FROM native_events ORDER BY id').all();
    const build=videos.save(manifest());assert.equal(build.usage.tokens,330);assert.equal(build.usage.cost_usd,10);assert.equal(build.approved_preview!.cost_usd,3);assert.equal(build.approved_preview!.elapsed_ms,90);assert.equal(build.first_pass,true);
    const stats=videos.overview();assert.equal(stats.summary.approved_first_pass,1);assert.equal(stats.summary.avg_cost_to_approved,3);assert.equal(stats.comparisons.models.length,2);assert.ok(stats.comparisons.pipelines[0]!.key.includes('sol PLAN → luna BUILD'));assert.ok(!stats.comparisons.models.some(m=>m.key==='declared-model'));
    assert.equal(videos.links('build')[0]!.stage,'BUILD');assert.deepEqual(db.prepare('SELECT * FROM native_events ORDER BY id').all(),before);
    const columns=db.prepare('PRAGMA table_info(video_builds)').all().map(c=>c.name);assert.ok(!columns.includes('tokens'));assert.ok(!columns.includes('cost_usd'));assert.ok(!columns.includes('elapsed_ms'));
    db.prepare('UPDATE native_events SET cost_usd=4 WHERE session_id=? AND timestamp=100').run('build');assert.equal(videos.overview().summary.avg_cost_to_approved,5);
    videos.close();videos=new VideoBuilds(path);assert.equal(videos.manifest('queue-protects-server')!.stages[1]!.approved_at,120);assert.equal(videos.detail('queue-protects-server')!.usage.cost_usd,12);
  } finally {videos.close();db.close();await native.close();await rm(dir,{recursive:true,force:true});}
});

test('overlapping session scopes fail atomically; disjoint turns work; missing usage/prices/time never become zero averages',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'video-scope-')),path=join(dir,'stats.sqlite');const native=new NativeUsage(path,join(dir,'none'));const db=new DatabaseSync(path);const videos=new VideoBuilds(path);
  try {
    session(db,'shared','sol');usage(db,'shared','a','sol',50,1,60,1);usage(db,'shared','b','luna',90,61,100,null);
    const m=manifest('scoped');m.stages[0].session_id='shared';m.stages[0].turn_ids=['a'];m.stages[1].session_id='shared';m.stages[1].turn_ids=['b'];
    const b=videos.save(m);assert.equal(b.usage.tokens,220);assert.equal(b.usage.cost_usd,null);assert.equal(videos.overview().summary.avg_cost_to_approved,null);assert.equal(videos.overview().summary.cost_samples,0);
    const saved=videos.manifest('scoped')!;const bad=structuredClone(saved);delete bad.stages[1]!.turn_ids;assert.throws(()=>videos.save(bad,true),/turn_ids/);assert.deepEqual(videos.manifest('scoped'),saved);
    const other=manifest('other');other.stages=[{stage:'BUILD',session_id:'shared',turn_ids:['shared:a'],model:'sol',approved:true}];assert.throws(()=>videos.save(other),/turn_ids/);assert.equal(videos.detail('other'),null);
    const unknown=manifest('unknown');unknown.stages=[{stage:'BUILD',session_id:'missing',model:'sol',approved:true}];videos.save(unknown);assert.equal(videos.detail('unknown')!.usage.tokens,null);assert.equal(videos.detail('unknown')!.usage.elapsed_ms,null);
    const privateFields=manifest('private');privateFields.build.prompt='PRIVATE';assert.throws(()=>videos.save(privateFields));
    const noApproval=manifest('invalid');noApproval.stages=[];assert.throws(()=>videos.save(noApproval),/đã duyệt/);
    const missingTurn=manifest('missing-turn');session(db,'partial','sol');usage(db,'partial','known','sol',50,1,60,1);
    db.prepare('INSERT INTO native_turns VALUES(?,?,?,?,?,?,?)').run('partial:unknown','partial','sol','low',70,null,'started');
    missingTurn.stages=[{stage:'BUILD',session_id:'partial',model:'sol',approved:true}];videos.save(missingTurn);assert.equal(videos.detail('missing-turn')!.usage.tokens,null);assert.equal(videos.detail('missing-turn')!.usage.elapsed_ms,null);
  }finally{videos.close();db.close();await native.close();await rm(dir,{recursive:true,force:true});}
});

test('video metadata endpoints enforce existing local boundaries, native detail tags and existing pages remain intact',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'video-api-'));const provider={close:async()=>{}} as Provider;
  const app=await buildServer(readConfig({DATA_DIR:dir,NATIVE_CODEX_HOME:join(dir,'none'),LOCAL_API_KEY:'secret'}),provider);
  const headers={origin:'http://localhost:80','x-codex-video':'1',authorization:'Bearer secret'};
  const m=manifest();m.build.status='planned';m.stages=[{stage:'BUILD',session_id:'local',model:'sol',notes:'Metadata only',approved:false}];
  const db=new DatabaseSync(join(dir,'stats.sqlite'));session(db,'local','sol');db.close();
  try {
    assert.equal((await app.inject({method:'POST',url:'/api/videos',payload:m})).statusCode,403);
    assert.equal((await app.inject({method:'POST',url:'/api/videos',payload:m,headers:{...headers,origin:'https://evil.test'}})).statusCode,403);
    assert.equal((await app.inject({method:'POST',url:'/api/videos',payload:m,headers:{...headers,authorization:''}})).statusCode,401);
    assert.equal((await app.inject({method:'POST',url:'/api/videos/import',payload:m,headers})).statusCode,201);
    assert.equal((await app.inject({method:'POST',url:'/api/videos/import',payload:m,headers})).statusCode,409);
    const native=(await app.inject({url:'/api/native/sessions/local',headers})).json();assert.equal(native.video_tags[0].video_build_id,m.build.id);assert.equal(native.video_tags[0].stage,'BUILD');
    assert.equal((await app.inject({url:'/api/videos/sessions?search=local',headers})).json().sessions.length,1);
    assert.equal((await app.inject({url:'/api/native/overview?range=all',headers})).statusCode,200);
    assert.equal((await app.inject({url:'/api/stats/overview',headers})).statusCode,200);
    const shell=await app.inject({url:'/dashboard'});assert.equal(shell.statusCode,200);assert.ok(shell.body.includes('Video builds'));
    m.build.title='Updated';assert.equal((await app.inject({method:'PUT',url:`/api/videos/${m.build.id}`,payload:m,headers})).statusCode,200);
    assert.equal((await app.inject({url:`/api/videos/${m.build.id}`,headers})).json().manifest.build.title,'Updated');
  }finally{await app.close();await rm(dir,{recursive:true,force:true});}
});
