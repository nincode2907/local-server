import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {runInNewContext} from 'node:vm';

const source = await readFile(new URL('../public/dashboard.js',import.meta.url),'utf8');
const presenterSource = source.slice(source.indexOf('function createChatPresenter('),source.indexOf('async function readPlaygroundStream('));
function fixture(reduced = false) {
  const frames = new Map<number,(now:number)=>void>(), listeners = new Set<()=>void>();
  let id = 0, now = 0;
  const text = {textContent:''}, phase = {textContent:''};
  const article = {querySelector:(s:string)=>s === '.message-text' ? text : phase,classList:{toggle(){}}};
  const container = {scrollHeight:1000,clientHeight:400,scrollTop:600,querySelector:()=>article};
  const document = {hidden:false,addEventListener:(_e:string,fn:()=>void)=>listeners.add(fn),removeEventListener:(_e:string,fn:()=>void)=>listeners.delete(fn)};
  const create = runInNewContext(presenterSource+'; createChatPresenter',{
    document,activeChat:'one',$:()=>container,matchMedia:()=>({matches:reduced}),
    requestAnimationFrame:(fn:(now:number)=>void)=>{frames.set(++id,fn);return id;},cancelAnimationFrame:(n:number)=>frames.delete(n),
  });
  const entry = {text:'',displayText:'',streaming:true}, chat = {id:'one',entries:[entry]};
  const presenter = create(chat,entry) as {update():void;finish():Promise<void>;stop():void};
  const step = () => {now+=16;const pending=[...frames.values()];frames.clear();for(const fn of pending)fn(now);};
  return {entry,presenter,frames,document,listeners,container,text,step};
}
test('one final content chunk is presented over frames without changing received text',async()=>{
  const f=fixture();f.entry.text='Nội dung tiếng Việt 🙂 '.repeat(40);const received=f.entry.text;
  f.presenter.update();assert.equal(f.text.textContent,'');f.step();
  assert.ok(f.entry.displayText.length>0 && f.entry.displayText.length<received.length);
  const done=f.presenter.finish();let frames=0;
  while(f.frames.size && frames++<150){f.step();assert.doesNotMatch(f.entry.displayText,/[\uD800-\uDBFF]$/);}
  await done;assert.equal(f.text.textContent,received);assert.equal(f.entry.text,received);
  f.presenter.stop();assert.equal(f.listeners.size,0);
});
test('later deltas append once; scrolling up does not pull the reader down',async()=>{
  const f=fixture();f.container.scrollTop=100;f.entry.text='Đoạn đầu';f.presenter.update();f.step();
  f.entry.text+=' và đoạn sau';f.presenter.update();const done=f.presenter.finish();
  for(let i=0;i<150&&f.frames.size;i++)f.step();await done;
  assert.equal(f.text.textContent,'Đoạn đầu và đoạn sau');assert.equal(f.container.scrollTop,100);f.presenter.stop();
});
test('stop flushes received text and cancels pending animation',async()=>{
  const f=fixture();f.entry.text='Đã nhận nhưng chưa hiển thị hết';f.presenter.update();f.step();
  const done=f.presenter.finish();f.presenter.stop();await done;
  assert.equal(f.text.textContent,f.entry.text);assert.equal(f.frames.size,0);assert.equal(f.listeners.size,0);
});
test('hidden tabs and reduced motion complete without waiting for animation frames',async()=>{
  for(const reduced of [false,true]){
    const f=fixture(reduced);f.entry.text='Phản hồi';f.presenter.update();
    const done=f.presenter.finish();f.document.hidden=true;for(const fn of f.listeners)fn();await done;
    assert.equal(f.text.textContent,'Phản hồi');assert.equal(f.frames.size,0);f.presenter.stop();
  }
});
test('SSE parser delivers content before response completion and preserves split UTF-8',{timeout:2000},async()=>{
  const parse=runInNewContext(source.slice(source.indexOf('async function readPlaygroundStream('),source.indexOf('async function copy('))+'; readPlaygroundStream',{TextDecoder,Uint8Array});
  let controller!:ReadableStreamDefaultController<Uint8Array>;
  const response=new Response(new ReadableStream<Uint8Array>({start(c){controller=c;}}));
  const firstDelta=Promise.withResolvers<void>();
  const received:string[]=[];const result=parse(response,(delta:string)=>{received.push(delta);firstDelta.resolve();});
  const bytes=new TextEncoder().encode('data: '+JSON.stringify({choices:[{delta:{content:'Xin chào 🙂'}}]})+'\r\n\r\n');
  for(const byte of bytes)controller.enqueue(new Uint8Array([byte]));
  await firstDelta.promise;
  assert.deepEqual(received,['Xin chào 🙂']);
  controller.enqueue(new TextEncoder().encode('data: [DONE]\n\n'));controller.close();
  assert.equal((await result).choices[0].message.content,'Xin chào 🙂');
});
