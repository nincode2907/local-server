'use client';
import React,{useEffect,useRef,useState,useId} from 'react';
import {initialActivityState,outputChart,type ActivityClient,type ActivityState,type Connection} from '@codex-local/activity-client';

export interface AIActivityPanelProps {
  runId:string;
  transport:ActivityClient;
  locale?:'vi'|'en';
  className?:string;
  followWorkflow?:boolean;
  onState?:(state:ActivityState)=>void;
  onCancel?:()=>void;
  onConnection?:(state:Connection)=>void;
}
const copy={
  vi:{title:'Tiến trình AI',loading:'Đang tải tiến trình…',empty:'Chưa có dữ liệu.',retry:'Kết nối lại',cancel:'Hủy inference',output:'Output công khai',metrics:'Số liệu',timeline:'Timeline',workflow:'Workflow · app báo cáo',unknown:'Chưa có dữ liệu',reset:'Replay không còn đầy đủ. Output bên dưới có thể chỉ là một phần.',partial:'Output chưa hoàn chỉnh; không phải completion được xác nhận.',unit:'Đơn vị biểu đồ',noPoints:'Chưa có sample output.',truncated:'Biểu đồ giữ điểm đầu và 255 điểm mới nhất; đoạn thiếu không được nối.',connection:'Kết nối',ttfo:'TTFO · quan sát',queue:'Chờ queue · quan sát',gap:'Inter-chunk p95 · quan sát',token:'Output token · provider',bytes:'Bytes output · quan sát',characters:'Ký tự',tokens:'Token thực',running:'Đang chạy',queued:'Chờ xử lý',completed:'Hoàn tất',failed:'Lỗi',cancelled:'Đã hủy',interrupted:'Gián đoạn',idle:'Chưa bắt đầu',note:'Workflow là tiến trình do app báo cáo. Gateway không xác nhận tác vụ bên ngoài đã chạy.',oneToken:'Chỉ có một sample usage; chưa đủ để vẽ tốc độ token.'},
  en:{title:'AI activity',loading:'Loading activity…',empty:'No data yet.',retry:'Reconnect',cancel:'Cancel inference',output:'Public output',metrics:'Metrics',timeline:'Timeline',workflow:'Workflow · app reported',unknown:'Unavailable',reset:'Complete output replay is unavailable. Output below may be partial.',partial:'Partial output; not a validated completion.',unit:'Chart unit',noPoints:'No output samples yet.',truncated:'Chart retains the first and latest 255 samples; missing intervals are not connected.',connection:'Connection',ttfo:'TTFO · observed',queue:'Queue wait · observed',gap:'Inter-chunk p95 · observed',token:'Output tokens · provider',bytes:'Output bytes · observed',characters:'Characters',tokens:'Actual tokens',running:'Running',queued:'Queued',completed:'Completed',failed:'Failed',cancelled:'Cancelled',interrupted:'Interrupted',idle:'Not started',note:'Workflow progress is reported by the app. The gateway does not verify external execution.',oneToken:'One usage sample; insufficient to chart token speed.'},
};
export function AIActivityPanel({runId,transport,locale='vi',className='',followWorkflow=true,onState,onCancel,onConnection}:AIActivityPanelProps) {
  const [state,setState]=useState<ActivityState>(initialActivityState),[connection,setConnection]=useState<Connection>('connecting'),[error,setError]=useState(''),[generation,setGeneration]=useState(0),[cancelling,setCancelling]=useState(false),[unit,setUnit]=useState<'bytes'|'characters'|'tokens'>('bytes');
  const callbacks=useRef({onState,onCancel,onConnection});const titleId=useId(),unitId=useId();
  useEffect(()=>{callbacks.current={onState,onCancel,onConnection};},[onState,onCancel,onConnection]);
  useEffect(()=>{
    const controller=new AbortController();let mounted=true;setState(initialActivityState());setError('');setCancelling(false);
    void transport.watchRun(runId,{signal:controller.signal,followWorkflow,onState:value=>{if(mounted){setState(value);callbacks.current.onState?.(value);}},onConnection:(value,cause)=>{if(mounted){setConnection(value);if(value==='error'||value==='unauthorized')setError(cause?.message??value);callbacks.current.onConnection?.(value);}}}).catch(cause=>{if(mounted)setError(cause instanceof Error?cause.message:String(cause));});
    return ()=>{mounted=false;controller.abort();};
  },[runId,transport,followWorkflow,generation]);
  const t=copy[locale],r=state.run;
  const markers=[...Object.entries(r?.timeline??{}).filter(([key,value])=>['first_output','last_output','provider_finished','first_content_sent'].includes(key)&&value!==null).map(([key,value])=>({at:value!,title:key})),...(r?.workflow?.stages??[]).flatMap(stage=>[{at:Math.max(0,stage.started_at-r!.created_at),title:stage.label??stage.id},...(stage.finished_at?[{at:Math.max(0,stage.finished_at-r!.created_at),title:stage.id}]:[])])];
  const chart=outputChart(r?.history,unit,760,220,Math.max(0,...markers.map(m=>m.at)));
  const number=(v:number|null|undefined)=>v===null||v===undefined?t.unknown:new Intl.NumberFormat(locale,{maximumFractionDigits:2}).format(v);
  const label=(v:string)=>t[v as keyof typeof t]??v;
  const connections=locale==='vi'?{connecting:'Đang kết nối',connected:'Đã kết nối',reconnecting:'Đang kết nối lại',ended:'Đã kết thúc',unauthorized:'Cần đăng nhập',error:'Lỗi',replay_reset:'Replay hết hạn'}:{connecting:'Connecting',connected:'Connected',reconnecting:'Reconnecting',ended:'Ended',unauthorized:'Unauthorized',error:'Error',replay_reset:'Replay reset'};
  const milestones:Record<string,string>=locale==='vi'?{received:'Nhận request',enqueued:'Vào queue',dequeued:'Rời queue',provider_started:'Bắt đầu provider',first_output:'Output đầu',last_output:'Output cuối',provider_finished:'Provider hoàn tất',first_content_sent:'Ghi content ra HTTP',finished:'Kết thúc inference',response_finished:'Gửi xong HTTP'}:{};
  const cancel=async()=>{setCancelling(true);try{await transport.cancel(runId);callbacks.current.onCancel?.();}catch(cause){setError(cause instanceof Error?cause.message:String(cause));}finally{setCancelling(false);}};
  return <section className={`ai-activity-panel ${className}`} aria-labelledby={titleId}>
    <header><div><h2 id={titleId}>{t.title}</h2><p>{r?.model??runId}</p></div><div className="ai-activity-actions"><button type="button" onClick={()=>setGeneration(v=>v+1)}>{t.retry}</button>{r&&['queued','running'].includes(r.status)&&<button type="button" disabled={cancelling} onClick={()=>void cancel()}>{t.cancel}</button>}</div></header>
    <p role="status">{r?label(r.status):t.loading} · {t.connection}: {connections[connection]}</p>
    {error&&<p role="alert">{error}</p>}
    {state.replayUnavailable&&<p className="ai-activity-notice">{t.reset}</p>}
    {state.partial&&<p className="ai-activity-notice">{t.partial}</p>}
    <dl className="ai-activity-metrics">{[['ttfo',t.ttfo],['queue_wait',t.queue],['inter_chunk_p95',t.gap],['output_tokens',t.token],['output_bytes',t.bytes]].map(([key,title])=><div key={key}><dt>{title}</dt><dd>{number(r?.metrics[key]?.value)} {r?.metrics[key]?.value===null?'':r?.metrics[key]?.unit}</dd></div>)}</dl>
    <label htmlFor={unitId}>{t.unit} <select id={unitId} value={unit} onChange={e=>setUnit(e.target.value as typeof unit)}><option value="bytes">Bytes</option><option value="characters">{t.characters}</option><option value="tokens">{t.tokens}</option></select></label>
    {chart.points.length?<><svg viewBox={`0 0 ${chart.width} ${chart.height}`} role="img" aria-label={`${t.output} / ms · ${unit}`}><line x1="36" y1="192" x2="744" y2="192" stroke="currentColor" opacity=".3"/>{chart.paths.map((d,i)=><path key={i} d={d} fill="none" stroke="currentColor" strokeWidth="2"/>)}{chart.points.map(p=><circle key={p.index} cx={p.x} cy={p.y} r="3" fill="currentColor"><title>{number(p.elapsed_ms)} ms · {number(p.value)} {unit}</title></circle>)}{markers.map((m,i)=><line key={`marker-${i}`} x1={36+m.at/chart.maxX*(chart.width-52)} x2={36+m.at/chart.maxX*(chart.width-52)} y1="16" y2="192" stroke="currentColor" opacity=".4" strokeDasharray="3 4"><title>{milestones[m.title]??m.title} · {number(m.at)} ms</title></line>)}<text x="36" y="215">0 ms</text><text x="590" y="215">{number(chart.maxX)} ms</text><text x="4" y="16">{number(chart.maxY)}</text></svg>{unit==='tokens'&&chart.points.length===1&&<p>{t.oneToken}</p>}</>:<p>{t.noPoints}</p>}
    {chart.truncated&&<p>{t.truncated}</p>}
    <h3>{t.timeline}</h3><ol className="ai-activity-timeline">{Object.entries(r?.timeline??{}).filter(([,v])=>v!==null).sort((a,b)=>(a[1]??0)-(b[1]??0)).map(([key,value])=><li key={key}><span>{milestones[key]??key}</span><strong>+ {number(value)} ms</strong></li>)}</ol>
    <h3>{t.output}</h3><pre tabIndex={0}>{state.output||t.empty}</pre>
    <h3>{t.workflow}</h3><p>{label(r?.workflow?.status??'idle')}</p><ol>{r?.workflow?.stages?.map(stage=><li key={stage.id}><strong>{stage.label??stage.id}</strong> · {label(stage.status)}{stage.progress&&<span> · {number(stage.progress.completed)} / {number(stage.progress.total)}</span>}{stage.message&&<p>{stage.message}</p>}</li>)}</ol><p className="ai-activity-note">{t.note}</p>
    <details><summary>{t.metrics}</summary><pre tabIndex={0}>{JSON.stringify(r?.metrics??{},null,2)}</pre></details>
  </section>;
}
