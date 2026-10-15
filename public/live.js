'use strict';
(async () => {
  const {createActivityClient,outputChart}=await import('/dashboard/assets/activity-client.js');
  const client=createActivityClient({headers:()=>apiKey?{Authorization:`Bearer ${apiKey}`}:{}});
  const runs=new Map(),labels={queued:'Chờ xử lý',running:'Đang chạy',completed:'Hoàn tất',failed:'Lỗi',cancelled:'Đã hủy',interrupted:'Gián đoạn',idle:'Chưa bắt đầu'};
  const active=r=>['queued','running'].includes(r.status),ms=v=>v===null||v===undefined?'—':seconds(v);
  let feedController,detailController,selected='',returnView='live',detailState=null,callRecord=null,connection='',runMissing=false,frame,latencyController;
  const timelineLabels={received:'Nhận request',enqueued:'Vào queue',dequeued:'Rời queue',provider_started:'Bắt đầu provider',first_output:'Output đầu tiên',last_output:'Output cuối',provider_finished:'Provider hoàn tất',first_content_sent:'Ghi content ra HTTP',finished:'Kết thúc inference',response_finished:'Gửi xong HTTP response'};
  function renderList() {
    const list=[...runs.values()].sort((a,b)=>Number(active(b))-Number(active(a))||b.created_at-a.created_at).slice(0,128),tbody=$('live-rows');
    const old=new Map([...tbody.querySelectorAll('tr[data-run]')].map(row=>[row.dataset.run,row]));
    if(list.length&&!old.size)tbody.replaceChildren();
    for(const[index,r]of list.entries()) {
      let row=old.get(r.run_id);if(!row){row=document.createElement('tr');row.dataset.run=r.run_id;for(let i=0;i<7;i++)row.append(document.createElement('td'));}old.delete(r.run_id);
      const elapsed=active(r)?Math.max(0,Date.now()-r.created_at):r.timeline.finished;
      const last=r.timeline.last_output===null?'Chưa có output':active(r)?`Output cuối: ${ms(Math.max(0,elapsed-r.timeline.last_output))} trước`:`Output lúc + ${ms(r.timeline.last_output)}`;
      const cells=[`<code>${escape(r.run_id.slice(0,8))}</code><small>${escape(r.model)} · ${escape(r.provider)}</small>`,`${escape(labels[r.status]??r.status)}<small>Workflow: ${escape(labels[r.workflow?.status]??'Chưa có')}</small>`,`${ms(elapsed)}<small>${last}</small>`,ms(r.metrics.ttfo?.value),`${number(r.metrics.output_bytes?.value)} bytes<small>${number(r.metrics.output_characters?.value)} ký tự · ${number(r.metrics.output_updates?.value)} update</small>`,`${number(r.metrics.output_tokens?.value)}<small>${r.metrics.output_tokens?.value===null?'Chưa có usage cuối':'Usage provider · gồm reasoning'}</small>`,`<div class="live-actions"><a href="/dashboard/requests/${escape(r.run_id)}" class="quiet request-link" data-request-open="${escape(r.run_id)}">Xem chi tiết</a>${active(r)?`<button type="button" class="quiet" data-live-cancel="${escape(r.run_id)}">Hủy</button>`:''}</div>`];
      cells.forEach((html,i)=>{if(row.cells[i].innerHTML!==html)row.cells[i].innerHTML=html;});if(tbody.children[index]!==row)tbody.insertBefore(row,tbody.children[index]??null);
    }
    for(const row of old.values())row.remove();
    if(!list.length&&!tbody.querySelector('.empty-table'))tbody.innerHTML='<tr><td colspan="7" class="empty-table">Chưa có request. Gọi API hoặc gửi một lượt Test chat để theo dõi.</td></tr>';
  }
  const schedule=()=>{if(!frame)frame=requestAnimationFrame(()=>{frame=null;renderList();});};
  async function connectFeed() {
    feedController?.abort();const controller=feedController=new AbortController();
    await client.watchFeed({signal:controller.signal,onConnection:(status,error)=>{
      if(status==='unauthorized')$('auth-form').hidden=false;
      $('live-status').textContent=({connecting:'Đang kết nối event stream…',connected:'Đã kết nối · cập nhật theo event.',reconnecting:'Mất kết nối · đang thử lại…',replay_reset:'Cursor hết hạn · đang tải snapshot mới.',unauthorized:'Nhập token admin để xem request.',error:error?.message??'Không kết nối được.'})[status]??status;
    },onPacket:({data,type})=>{
      if(type==='snapshot'){runs.clear();data.runs.forEach(r=>runs.set(r.run_id,r));}
      else if(data.type==='run.updated'){const old=runs.get(data.run_id);if(!old||data.seq>=old.seq)runs.set(data.run_id,data.payload);}
      if(runs.size>128){const old=[...runs.values()].filter(r=>!active(r)).sort((a,b)=>a.created_at-b.created_at)[0];if(old)runs.delete(old.run_id);}
      schedule();
    }});
  }
  async function loadLatency() {
    latencyController?.abort();const controller=latencyController=new AbortController();$('latency-refresh').disabled=true;
    const params=new URLSearchParams({range:$('latency-range').value,status:$('latency-status').value});if($('latency-provider').value)params.set('provider',$('latency-provider').value);if($('latency-model').value.trim())params.set('model',$('latency-model').value.trim());
    try {
      const data=await get(`/api/runs/latency?${params}`,controller.signal);
      const pair=m=>`${ms(m.p50)} / ${ms(m.p95)}<small>${number(m.sample_count)} sample · ${number(m.unknown_count)} chưa có dữ liệu</small>`;
      $('latency-cards').innerHTML=[['duration','Duration'],['ttfo','TTFO'],['queue_wait','Queue wait']].map(([key,title])=>`<article class="metric"><div class="metric-label">${title} · p50 / p95</div><div class="latency-value">${pair(data.summary[key])}</div></article>`).join('');
      $('latency-note').textContent=`${number(data.summary.run_count)} run trong cohort · trạng thái ${labels[data.status]??'tất cả'} · nearest-rank · ${date(data.since)} ${time(data.since)} → ${date(data.until)} ${time(data.until)}${data.truncated?' · giới hạn 100.000 run mới nhất, không đại diện toàn cửa sổ':''}.`;
      $('latency-rows').innerHTML=data.groups.map(g=>`<tr><td>${escape(g.provider)} / ${escape(g.model)}</td><td>${pair(g.duration)}</td><td>${pair(g.ttfo)}</td><td>${pair(g.queue_wait)}</td></tr>`).join('')||'<tr><td colspan="4" class="empty-table">Chưa có sample phù hợp.</td></tr>';
    }catch(error){if(error.name!=='AbortError'){$('latency-note').textContent=error.message;if(error.auth)$('auth-form').hidden=false;}}
    finally{if(latencyController===controller)$('latency-refresh').disabled=false;}
  }
  function renderChart(r) {
    const unit=$('request-chart-unit').value;
    const markers=[...['first_output','last_output','provider_finished','first_content_sent'].map(key=>({at:r?.timeline[key],title:timelineLabels[key]})),...(r?.workflow?.stages??[]).flatMap(stage=>[{at:Math.max(0,stage.started_at-r.created_at),title:`Workflow: ${stage.label??stage.id} · bắt đầu`},...(stage.finished_at?[{at:Math.max(0,stage.finished_at-r.created_at),title:`Workflow: ${stage.label??stage.id} · kết thúc`}]:[])])].filter(m=>typeof m.at==='number'&&Number.isFinite(m.at));
    const chart=outputChart(r?.history,unit,760,220,Math.max(0,...markers.map(m=>m.at)));
    if(!chart.points.length){$('request-chart').innerHTML='<p class="usage-note">Chưa có sample thực cho đơn vị này.</p>';}
    else $('request-chart').innerHTML=`<svg viewBox="0 0 ${chart.width} ${chart.height}" role="img" aria-label="Output ${escape(unit)} theo elapsed milliseconds"><line x1="36" y1="192" x2="744" y2="192" stroke="#c0ccdc"/>${chart.paths.map(d=>`<path d="${d}" stroke="#2854d7" stroke-width="2" fill="none"/>`).join('')}${chart.points.map(p=>`<circle cx="${p.x}" cy="${p.y}" r="3" fill="#2854d7"><title>${number(p.elapsed_ms)} ms · ${number(p.value)} ${escape(unit)}</title></circle>`).join('')}${markers.map(({at,title})=>{const x=36+at/chart.maxX*(chart.width-52);return `<line x1="${x}" x2="${x}" y1="16" y2="192" stroke="#9b5d14" stroke-dasharray="3 4"><title>${escape(title)} · ${ms(at)}</title></line>`;}).join('')}<text x="36" y="215">0 ms</text><text x="590" y="215">${number(chart.maxX)} ms</text><text x="4" y="14">${number(chart.maxY)}</text></svg>`;
    $('request-chart-note').textContent=`${chart.points.length} sample ${unit==='tokens'?'usage provider thực':'output quan sát'}${unit==='tokens'&&chart.points.length===1?' · một điểm usage không cho biết tốc độ sinh token':''}${chart.truncated?' · chỉ giữ điểm đầu và 255 điểm mới nhất; không nối đoạn thiếu':''}. Token gồm reasoning nếu provider gộp chung. Mốc workflow là thời điểm gateway nhận báo cáo của app.`;
  }
  function renderDetail() {
    if(!selected||$('view-request').hidden)return;
    const r=detailState?.run;
    $('request-id').textContent=selected;$('request-model').textContent=r?`${r.model} · ${r.provider}`:callRecord?`${callRecord.model} · call trước instrumentation`:'';
    $('request-state').textContent=`${r?(labels[r.status]??r.status):callRecord?(statusNames[callRecord.status]??callRecord.status):'Đang tải…'}${connection?' · '+connection:''}`;
    $('request-cancel').hidden=!r||!active(r);
    const notes=[];if(detailState?.replayUnavailable)notes.push('Replay body đã hết hạn hoặc không đầy đủ; phần output có thể chỉ là một phần. Sample số liệu vẫn còn.');if(detailState?.partial)notes.push('Output chưa hoàn chỉnh, không phải completion được xác nhận.');if(!r&&callRecord)notes.push('Call cũ chưa có run/timing samples. Không backfill TTFO hoặc dựng lại output từ usage.');
    $('request-notice').hidden=!notes.length;$('request-notice').textContent=notes.join(' ');
    $('request-summary').innerHTML=[['duration','Duration'],['ttfo','TTFO · quan sát'],['queue_wait','Queue wait · quan sát'],['inter_chunk_p95','Inter-chunk p95']].map(([key,label])=>`<article class="metric"><div class="metric-label">${label}</div><div class="latency-value">${ms(r?.metrics[key]?.value??(key==='duration'?callRecord?.duration_ms:null))}</div></article>`).join('');
    const timeline=r?.timeline??{received:0,finished:callRecord?.duration_ms??null};
    $('request-timeline').innerHTML=Object.entries(timeline).filter(([,v])=>v!==null&&v!==undefined).sort((a,b)=>a[1]-b[1]).map(([key,value])=>`<li>${escape(timelineLabels[key]??key)}<small>+ ${ms(value)}</small></li>`).join('');
    const workflow=r?.workflow,stages=workflow?.stages??[];
    const stagesHtml=`<p>${escape(labels[workflow?.status]??'Chưa có workflow')} · nguồn client_reported</p><ol class="request-stage-list">${stages.map(s=>`<li><strong>${escape(s.label??s.id)}</strong> · ${escape(labels[s.status]??s.status)}${s.progress?` · ${number(s.progress.completed)} / ${number(s.progress.total)} work units`:''}<small>${escape(s.message??'')} · nhận ${escape(time(s.started_at))}${s.finished_at?' → '+escape(time(s.finished_at)):''}</small></li>`).join('')}</ol>`;
    $('request-workflow').innerHTML=stagesHtml;$('request-stages').innerHTML=stagesHtml;
    if($('request-output').textContent!==detailState?.output)$('request-output').textContent=detailState?.output||'Chưa có output replay.';
    $('request-metrics').innerHTML=Object.entries(r?.metrics??{}).map(([key,m])=>`<tr><td><code>${escape(key)}</code></td><td>${number(m.value)} ${escape(m.unit)}${m.total_observed!==undefined?`<small>${number(m.value)} / ${number(m.total_observed)} gap · ${escape(m.window)}</small>`:''}</td><td>${escape(m.source)}<small>${escape(m.reason??'')}</small></td></tr>`).join('')||'<tr><td colspan="3">Chưa có metric instrumented cho call này.</td></tr>';
    $('request-metadata').textContent=JSON.stringify(callRecord??{},null,2);renderChart(r);
  }
  async function openDetail(id,record,{push=true}={}) {
    if(!/^[a-f0-9-]{36}$/.test(id))return;
    if($('view-request').hidden)returnView=document.querySelector('[id^="view-"]:not([hidden])')?.id.slice(5)??'live';
    detailController?.abort();const controller=detailController=new AbortController();selected=id;detailState=null;callRecord=record??null;runMissing=false;connection='Đang kết nối';
    $('call-detail').close();$('detail-content').replaceChildren();$('request-inspector-host').replaceChildren();
    if(push&&location.pathname!==`/dashboard/requests/${id}`)history.pushState({request:id},'',`/dashboard/requests/${id}`);
    view('request');renderDetail();
    void get(`/api/stats/calls/${id}`,controller.signal).then(metric=>{if(selected!==id||controller.signal.aborted)return;callRecord=metric;if(runMissing)connection='Metadata call cũ';renderDetail();$('request-inspector-host').innerHTML=`<section id="request-inspector" data-id="${escape(id)}"><p class="usage-note">Đang tải Inspector…</p></section>`;loadInspector(id,metric);}).catch(error=>{if(error.name!=='AbortError'&&error.auth)$('auth-form').hidden=false;});
    await client.watchRun(id,{signal:controller.signal,followWorkflow:true,onState:state=>{if(!controller.signal.aborted&&selected===id){detailState=state;renderDetail();}},onConnection:(status,error)=>{
      if(controller.signal.aborted||selected!==id)return;
      runMissing=error?.code==='run_not_found';
      connection=({connecting:'Đang kết nối',connected:'Đã kết nối',reconnecting:'Đang kết nối lại',ended:'Đã kết thúc',replay_reset:'Replay reset',unauthorized:'Cần token admin',error:callRecord?'Chỉ có metadata của call cũ':error?.message??'Không tải được run'})[status]??status;
      if(status==='unauthorized')$('auth-form').hidden=false;renderDetail();
    }});
  }
  window.openRequestDetail=(id,record)=>void openDetail(id,record);
  window.stopRequestDetail=()=>detailController?.abort();
  window.refreshLive=()=>{if(!feedController||feedController.signal.aborted)void connectFeed();void loadLatency();};
  window.stopLive=()=>{feedController?.abort();latencyController?.abort();};
  $('live-reconnect').onclick=()=>void connectFeed();$('latency-filter').onsubmit=event=>{event.preventDefault();void loadLatency();};
  $('request-chart-unit').onchange=()=>renderChart(detailState?.run);
  $('request-reconnect').onclick=()=>void openDetail(selected,callRecord,{push:false});
  $('request-back').onclick=()=>{history.pushState({view:returnView},'','/dashboard');view(returnView);};
  $('request-cancel').onclick=async()=>{const id=selected;$('request-cancel').disabled=true;try{await client.cancel(id);}catch(error){$('request-state').textContent=error.message;}finally{$('request-cancel').disabled=false;}};
  $('live-rows').addEventListener('click',async event=>{
    const link=event.target.closest('[data-request-open]');if(link&&!event.ctrlKey&&!event.metaKey&&!event.shiftKey){event.preventDefault();return openDetail(link.dataset.requestOpen);}
    const button=event.target.closest('[data-live-cancel]');if(!button)return;button.disabled=true;
    try{await client.cancel(button.dataset.liveCancel);$('live-status').textContent='Đã gửi yêu cầu hủy.';}catch(error){$('live-status').textContent=error.message;button.disabled=false;}
  });
  const tabs=[...document.querySelectorAll('[data-request-tab]')];
  function selectTab(name){for(const tab of tabs){const chosen=tab.dataset.requestTab===name;tab.setAttribute('aria-selected',String(chosen));tab.tabIndex=chosen?0:-1;$(`request-pane-${tab.dataset.requestTab}`).hidden=!chosen;}}
  tabs.forEach((tab,i)=>{tab.onclick=()=>selectTab(tab.dataset.requestTab);tab.onkeydown=event=>{const next=event.key==='ArrowRight'?(i+1)%tabs.length:event.key==='ArrowLeft'?(i+tabs.length-1)%tabs.length:event.key==='Home'?0:event.key==='End'?tabs.length-1:null;if(next!==null){event.preventDefault();selectTab(tabs[next].dataset.requestTab);tabs[next].focus();}};});
  $('auth-form').addEventListener('submit',()=>{if(!$('view-request').hidden)void openDetail(selected,callRecord,{push:false});else if(!$('view-live').hidden)window.refreshLive();});
  const locationRequest=()=>/^\/dashboard\/requests\/([a-f0-9-]{36})$/.exec(location.pathname)?.[1];
  window.addEventListener('popstate',()=>{const id=locationRequest();if(id)void openDetail(id,undefined,{push:false});else view(history.state?.view??returnView);});
  window.addEventListener('pagehide',()=>{window.stopLive();window.stopRequestDetail();});
  setInterval(()=>{if(!$('view-live').hidden)schedule();},1000);
  const initial=locationRequest();if(initial)void openDetail(initial,undefined,{push:false});
})().catch(error=>{$('error').hidden=false;$('error').textContent=`Không tải được activity client: ${error.message}`;});
