import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {runInNewContext} from 'node:vm';

const source=await readFile(new URL('../public/dashboard.js',import.meta.url),'utf8');
const chartSource=source.slice(source.indexOf('function chart('),source.indexOf('function renderOverview('));
function render(timeline:any[],range='24h',rendered=false){
  const host={innerHTML:'',dataset:rendered?{chartRendered:'true'}:{}} as {innerHTML:string;dataset:Record<string,string>};
  const empty={hidden:true};
  const dollar=(id:string)=>id==='activity-chart'?host:empty;
  const escape=(value:unknown)=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]!));
  const execute=new Function('$','number','date','time','escape',chartSource+';return chart;') as (...args:any[])=>((data:any[],period:string)=>void);
  const chart=execute(dollar,(v:unknown)=>String(v??'—'),(v:number)=>`D${v}`,(v:number)=>`T${v}`,escape);
  chart(timeline,range);return {html:host.innerHTML,host,empty};
}
test('CSS chart stacks real call states with semantic classes and accessible hover details',()=>{
  const {html,empty}=render([{time:1,calls:9,success:5,errors:2,rejected:1,active:1,tokens:100}], '24h');
  assert.match(html,/activity-css-chart/);assert.doesNotMatch(html,/<svg/);
  assert.match(html,/activity-segment success activity-height-42/);
  assert.match(html,/activity-segment errors activity-height-17/);
  assert.match(html,/từ chối/);assert.match(html,/100 token/);assert.match(html,/aria-label=/);assert.match(html,/data-tooltip=/);
  assert.match(html,/chart-grow/);assert.equal(empty.hidden,true);
});
test('bucket labels follow range and tooltips escape untrusted labels',()=>{
  const normal=render([{time:1,calls:1,success:1,errors:0,rejected:0,active:0,tokens:2},{time:2,calls:0,success:0,errors:0,rejected:0,active:0,tokens:0}], '7d');
  assert.match(normal.html,/D1/);
  const escaped=render([{time:1,calls:1,success:1,errors:0,rejected:0,active:0,tokens:2}], '24h');
  assert.match(escaped.html,/D1 T1/);
});
test('empty timeline remains valid and repeat refreshes do not replay grow animation',()=>{
  const empty=render([]);assert.match(empty.html,/activity-columns/);assert.equal(empty.empty.hidden,false);
  const refresh=render([{time:1,calls:2,success:2,errors:0,rejected:0,active:0,tokens:9}],'24h',true);
  assert.doesNotMatch(refresh.html,/chart-grow/);assert.equal(refresh.empty.hidden,true);
});
test('chart presentation keeps reduced-motion and responsive rules in CSS',async()=>{
  const css=await readFile(new URL('../public/dashboard.css',import.meta.url),'utf8');
  const js=await readFile(new URL('../public/dashboard.js',import.meta.url),'utf8');
  assert.ok(css.includes('@media(prefers-reduced-motion:reduce){.activity-column.chart-grow'));
  assert.ok(css.includes('@media(max-width:760px){.cost-title{gap:8px}.cost-benchmark{font-size:10px}.chart{padding-inline:12px}.activity-css-chart'));
  assert.ok(css.includes('.activity-columns{position:absolute;inset:0;display:flex;align-items:stretch}.activity-column{position:relative;z-index:0;display:flex;flex:1 1 0;width:0;min-width:0;'));
  assert.ok(css.includes('.activity-segment.activity-height-42{height:42%}'));
  assert.ok(css.includes('.activity-column.activity-delay-18 .activity-segment{animation-delay:432ms}'));
  assert.ok(css.includes('.token-bar .token-segment.token-input{background:var(--cyan)}'));
  assert.ok(css.includes('.token-bar .token-segment.token-output{background:var(--purple)}'));
  assert.match(js,/token-segment \$\{kind\} token-width-\$\{width\}/);
  assert.match(css,/\.activity-column:hover::after/);
});
