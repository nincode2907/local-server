'use strict';
const $ = id => document.getElementById(id);
const nf = new Intl.NumberFormat('vi-VN');
const timezone = 'Asia/Ho_Chi_Minh';
const time = value => new Intl.DateTimeFormat('vi-VN', { timeZone: timezone, hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false }).format(value);
const date = value => new Intl.DateTimeFormat('vi-VN', { timeZone: timezone, day: '2-digit', month: '2-digit', year: 'numeric' }).format(value);
const escape = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const number = value => value === null || value === undefined ? '—' : nf.format(value);
const seconds = value => value === null || value === undefined ? '—' : `${new Intl.NumberFormat('vi-VN', { maximumFractionDigits: 2 }).format(value / 1000)} s`;
const statusNames = { success: 'Thành công', error: 'Lỗi', rejected: 'Từ chối', running: 'Đang chạy', pending: 'Chờ xử lý', cancelled: 'Đã hủy', interrupted: 'Gián đoạn' };
let apiKey = '', page = 1, rows = [], controller, lastOverview, loading = false;

function setTheme(theme, persist = false) {
  const dark = theme === 'dark';
  document.documentElement.dataset.theme = dark ? 'dark' : 'light';
  const button = $('theme-toggle');
  button.setAttribute('aria-pressed', String(dark));
  button.setAttribute('aria-label', dark ? 'Chuyển sang chế độ sáng' : 'Chuyển sang chế độ tối');
  button.title = dark ? 'Chuyển sang chế độ sáng' : 'Chuyển sang chế độ tối';
  if (persist) { try { localStorage.setItem('codex-dashboard-theme', dark ? 'dark' : 'light'); } catch {} }
}
let savedTheme = 'light';
try { savedTheme = localStorage.getItem('codex-dashboard-theme') === 'dark' ? 'dark' : 'light'; } catch {}
setTheme(savedTheme);
$('theme-toggle').addEventListener('click', () => setTheme(document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark', true));

function badge(status) { return `<span class="badge ${escape(status)}">${escape(statusNames[status] ?? status)}</span>`; }
function setOnline(online, text) {
  $('connection-dot').className = `dot ${online ? 'online' : 'offline'}`;
  $('connection-label').textContent = text;
}
async function get(path, signal) {
  const response = await fetch(path, { signal, headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : {}, cache: 'no-store' });
  if (response.status === 401) { const error = new Error('Nhập token để xem dữ liệu.'); error.auth = true; throw error; }
  const data = await response.json();
  if (!response.ok) { const error = new Error(data.error?.message ?? `HTTP ${response.status}`); if (data.error?.code === 'admin_required') error.auth = true; throw error; }
  return data;
}
function chart(timeline, range) {
  const host = $('activity-chart'), ceiling = Math.max(4,Math.ceil(Math.max(0,...timeline.map(bucket=>bucket.calls))/4)*4);
  const keys = [['success','Thành công'],['errors','Lỗi / hủy'],['rejected','Từ chối'],['active','Đang xử lý']];
  const total = timeline.reduce((sum,bucket)=>sum+bucket.calls,0), animate = total > 0 && !host.dataset.chartRendered;
  const columns = timeline.map((bucket,index)=>{
    const label = range === '7d' || range === '30d' ? date(bucket.time).slice(0,5) : time(bucket.time).slice(0,5);
    const showLabel = index === 0 || index === timeline.length-1 || index % Math.ceil(timeline.length/6) === 0;
    const details = `${date(bucket.time)} ${time(bucket.time)} · ${number(bucket.calls)} call · ${number(bucket.tokens)} token · ${number(bucket.success)} thành công · ${number(bucket.errors)} lỗi hoặc hủy · ${number(bucket.rejected)} từ chối · ${number(bucket.active)} đang xử lý`;
    const bars = keys.map(([key])=>`<i class="activity-segment ${key} activity-height-${Math.min(100,Math.round(Math.max(0,bucket[key])/ceiling*100))}"></i>`).join('');
    return `<div class="activity-column${animate&&bucket.calls?' chart-grow':''} activity-delay-${Math.min(index,18)}" tabindex="0" role="img" aria-label="${escape(details)}" data-tooltip="${escape(details)}"><div class="activity-stack">${bars}</div><span class="activity-label">${showLabel?escape(label):'&nbsp;'}</span></div>`;
  }).join('');
  const ticks=[4,3,2,1,0].map((step,index)=>`<span class="activity-tick-${index}">${number(ceiling*step/4)}</span>`).join('');
  host.innerHTML=`<div class="activity-css-chart" role="group" aria-label="Biểu đồ call theo thời gian. Tổng ${number(total)} call."><div class="activity-y-axis" aria-hidden="true">${ticks}</div><div class="activity-plot"><div class="activity-gridlines" aria-hidden="true"></div><div class="activity-columns">${columns}</div></div></div>`;
  if(total)host.dataset.chartRendered='true';
  $('chart-empty').hidden = timeline.some(b => b.calls > 0);
}
function renderOverview(data) {
  lastOverview = data;
  const s = data.summary;
  $('total').textContent = number(s.total_calls);
  $('call-breakdown').textContent = `${number(s.codex_calls)} lượt gọi provider · ${number(s.rejected_calls)} từ chối`;
  const totalTokens = s.input_tokens + s.output_tokens;
  $('tokens').textContent = number(totalTokens);
  $('token-breakdown').textContent = `${number(s.input_tokens)} input / ${number(s.output_tokens)} output · cache hit ${s.input_tokens&&!s.cache_unknown_calls ? (s.cached_tokens/s.input_tokens*100).toFixed(1)+'%' : '—'}`;
  $('latency').textContent = seconds(s.avg_duration_ms);
  $('p95').textContent = `p95 ${seconds(s.p95_duration_ms)} · lượt đã gọi Codex`;
  const completed = s.total_calls - s.active_calls;
  $('success-rate').textContent = completed ? `${new Intl.NumberFormat('vi-VN', { maximumFractionDigits: 1 }).format(s.successful_calls / completed * 100)}%` : '—';
  $('success-breakdown').textContent = `${number(s.successful_calls)} thành công · ${number(s.failed_calls)} lỗi / hủy`;
  $('active').textContent = `${number(s.active_calls)} đang xử lý`;
  $('token-total').textContent = number(totalTokens);
  $('input-tokens').textContent = number(s.input_tokens);
  $('output-tokens').textContent = number(s.output_tokens);
  $('cached-tokens').textContent = number(s.cache_unknown_calls===s.usage_known_calls&&s.cache_unknown_calls>0?null:s.cached_tokens);
  $('cache-hit-rate').textContent = s.input_tokens&&!s.cache_unknown_calls ? `${(s.cached_tokens/s.input_tokens*100).toFixed(1)}%` : '—';
  $('reasoning-tokens').textContent = number(s.reasoning_unknown_calls===s.usage_known_calls&&s.reasoning_unknown_calls>0?null:s.reasoning_tokens);
  $('tool-calls').textContent = number(s.tool_calls);
  $('token-bar').replaceChildren();
  for (const [amount, kind] of [[s.input_tokens, 'token-input'], [s.output_tokens, 'token-output']]) {
    const width = totalTokens ? Math.round(amount / totalTokens * 100) : 0;
    const segment = document.createElement('span'); segment.className = `token-segment ${kind} token-width-${width}`; $('token-bar').append(segment);
  }
  $('usage-note').textContent = s.usage_unknown_calls ? `${number(s.usage_unknown_calls)} lượt gọi provider chưa có usage. Token hiển thị chỉ gồm số đã ghi nhận.` : `Đã ghi nhận usage của ${number(s.usage_known_calls)} lượt. Cache nằm trong input; reasoning nằm trong output.`;
  $('default-model').textContent = data.server.default_model;
  $('server-meta').textContent = `${data.server.default_reasoning} reasoning · uptime ${number(Math.floor(data.server.uptime_seconds / 60))} phút`;
  if(s.cache_unknown_calls||s.reasoning_unknown_calls)$('usage-note').textContent+=` Cache unknown: ${number(s.cache_unknown_calls)} lượt; reasoning unknown: ${number(s.reasoning_unknown_calls)} lượt. Không coi là 0.`;
  $('model-rows').innerHTML = data.models.map(m => `<tr><td><span class="model-name">${escape(m.provider??'codex')} / ${escape(m.model)}</span><div class="model-meter"><span data-width="${s.total_calls ? m.calls / s.total_calls * 100 : 0}"></span></div></td><td class="number">${number(m.calls)}</td><td class="number">${number(m.input_tokens)}</td><td class="number">${number(m.output_tokens)}</td><td class="number">${seconds(m.avg_duration_ms)}</td><td class="number">${money(m.cost_usd)}</td></tr>`).join('');
  document.querySelectorAll('[data-width]').forEach(e => { e.style.width = `${e.dataset.width}%`; });
  $('models-empty').hidden = data.models.length > 0;
  const selected = $('model').value;
  const models = [...new Set([data.server.default_model, ...data.available_models])];
  $('model').innerHTML = '<option value="">Tất cả model</option>' + models.map(m => `<option value="${escape(m)}">${escape(m)}</option>`).join('');
  $('model').value = selected;
  $('recorded-since').textContent = data.recorded_since ? `Ghi nhận từ ${time(data.recorded_since)} · ${date(data.recorded_since)}. Lịch sử giữ sau restart.` : 'Chưa có lịch sử. Các call mới sẽ được lưu sau khi bật thống kê.';
  setOnline(true, data.server.active_requests ? `Đang xử lý ${data.server.active_requests}/${data.server.max_concurrent}` : 'Server đang hoạt động');
  chart(data.timeline, data.range);
}
function renderCalls(data) {
  rows = data.data;
  $('call-rows').innerHTML = rows.map(r => `<tr><td class="timestamp">${escape(time(r.started_at))}<small>${escape(date(r.started_at))}</small></td><td><span class="model-name">${escape(r.model)}</span><div class="endpoint">${escape(r.provider??'codex')} · ${escape(r.endpoint)} · ${escape(r.provider&&r.provider!=='codex'?'sampling local':r.reasoning)}</div></td><td>${badge(r.status)}</td><td class="number">${r.input_tokens === null ? '—' : number(r.input_tokens + r.output_tokens)}</td><td class="number latency-value">${seconds(r.duration_ms)}</td><td class="number">${money(r.cost_usd)}</td><td><button type="button" class="quiet details-button" data-call="${escape(r.id)}" aria-label="Chi tiết call ${escape(r.id)}">Chi tiết <span aria-hidden="true">↗</span></button></td></tr>`).join('');
  $('calls-empty').hidden = data.total !== 0;
  $('history-description').textContent = `${number(data.total)} call trong khoảng thời gian đã chọn. Chỉ hiển thị số liệu xử lý.`;
  $('page-info').textContent = data.total ? `${number((page - 1) * data.page_size + 1)}–${number(Math.min(page * data.page_size, data.total))} / ${number(data.total)} call` : '0 call';
  $('page-number').textContent = `Trang ${page}`;
  $('previous').disabled = page <= 1;
  $('next').disabled = page * data.page_size >= data.total;
}
function showDetail(id, record) {
  if(window.openRequestDetail)return window.openRequestDetail(id,record);
  $('call-detail').classList.remove('native-details-dialog');
  $('call-detail').querySelector('h2').textContent = 'Chi tiết call';
  const r = record ?? rows.find(row => row.id === id);
  if (!r) return;
  const field = (label, value, full = false) => `<div${full ? ' class="full"' : ''}><dt>${escape(label)}</dt><dd>${escape(value)}</dd></div>`;
  $('detail-content').innerHTML = '<dl class="detail-grid">' +
    field('Call ID', r.id, true) + field('Endpoint', r.endpoint, true) +
    field('Model', r.model) + field('Reasoning', r.reasoning) +
    field('Trạng thái', statusNames[r.status] ?? r.status) + field('HTTP', r.http_status ?? '—') +
    field('Bắt đầu', `${date(r.started_at)} ${time(r.started_at)}`) + field('Thời gian xử lý', seconds(r.duration_ms)) +
    field('Input token', number(r.input_tokens)) + field('Output token', number(r.output_tokens)) +
    field('Cached token', number(r.cached_tokens)) + field('Reasoning token', number(r.reasoning_tokens)) +
    field('Chi phí ước tính USD', money(r.cost_usd)) + field('Input · cache · output USD', `${money(r.input_cost_usd)} · ${money(r.cached_cost_usd)} · ${money(r.output_cost_usd)}`) + field('Giá / 1M input · output · cache', `${r.input_rate ?? '—'} · ${r.output_rate ?? '—'} · ${r.cached_rate ?? '—'}`) + field('Snapshot giá', r.price_checked_on ?? 'Chưa có giá') + field('Nguồn giá', r.price_source ?? '—', true) +
    field('Function calls', number(r.tool_calls)) + field('Finish reason', r.finish_reason ?? '—') +
    field('Đã gọi Codex', r.codex_started ? 'Có' : 'Chưa') + field('Mã lỗi', r.error_code ?? '—') +
    field('Session ID', r.session_id ?? 'Chat stateless', true) + '</dl>';
  if (!$('call-detail').open) $('call-detail').showModal();
  $('call-detail').classList.add('inspector-dialog');
  const metricsContent = $('detail-content').innerHTML;
  $('detail-content').innerHTML = `<details class="inspector-summary"><summary>Metadata, usage, giá và độ trễ</summary>${metricsContent}</details><section id="request-inspector" data-id="${escape(id)}"><p class="usage-note" role="status">Đang tải AI Request Inspector…</p></section>`;
  loadInspector(id, r);
}
let inspectorView = null;
async function loadInspector(id, record) {
  inspectorView = { id, record, data: null };
  try {
    const data = await get(`/api/stats/calls/${id}/inspector`);
    if ($('request-inspector')?.dataset.id !== id || !($('call-detail').open || !$('view-request').hidden)) return;
    inspectorView = { id, record, data };
    renderInspector();
  } catch (error) {
    if ($('request-inspector')?.dataset.id === id) $('request-inspector').innerHTML = `<p class="notice" role="alert">${escape(error.message)} <button type="button" data-inspector-retry>Thử lại</button></p>`;
  }
}
function inspectorCard(title, provenance, value, json = false) {
  if (value === undefined) return '';
  const text = json ? JSON.stringify(value, null, 2) : String(value);
  return `<article class="inspector-segment"><header><strong>${escape(title)}</strong><span class="provenance">${escape(provenance)}</span><button type="button" class="quiet" data-inspector-copy>Sao chép</button></header>${json ? '<details><summary>JSON · mở / thu gọn</summary>' : ''}<pre class="detail-json" tabindex="0">${escape(text)}</pre>${json ? '</details>' : ''}</article>`;
}
function inspectorMessages(messages, provenance = 'Client supplied') {
  return (messages ?? []).map((entry, index) => {
    const message = entry.message ?? entry, source = entry.provenance ?? provenance;
    return `<article class="inspector-segment message-card role-${escape(message.role)}"><header><strong>${index + 1}. ${escape(message.role)}</strong><span class="provenance">${escape(source)}${entry.restored_by_gateway ? ' · Gateway restored' : ''}</span><button type="button" class="quiet" data-inspector-copy>Sao chép</button></header><pre class="detail-json" tabindex="0">${escape(message.content === null ? 'null' : message.content ?? '')}</pre>${Object.keys(message).some(k => !['role','content'].includes(k)) ? `<details><summary>Tool calls / thuộc tính message</summary><pre class="detail-json">${escape(JSON.stringify(message,null,2))}</pre></details>` : ''}</article>`;
  }).join('');
}
function renderInspector() {
  if (!inspectorView || !$('request-inspector')) return;
  const {record, data} = inspectorView, segments = data.snapshot?.segments ?? [];
  const segment = key => segments.find(s => s.key === key);
  const incoming = segment('incoming'), gateway = segment('gateway'), cli = segment('cli_boundary');
  const reasons = { disabled: 'Ghi body đang tắt. Bật INSPECTOR_ENABLED=true rồi restart để ghi các request mới.', unavailable: 'Không có snapshot: call cũ, đã xóa, hết retention hoặc không ghi được. Không thể khôi phục body từ metadata.', ephemeral: 'Playground không lưu body trên server; request/response chỉ có trong bộ nhớ tab hiện tại.' };
  const missing = '<p class="usage-note">Phần này chưa có dữ liệu quan sát được.</p>';
  const rawSegment = s => !s ? '' : s.unavailable ? inspectorCard(s.key, 'Internal / unavailable', s.unavailable) : inspectorCard(s.key === 'codex_response' && s.data?.complete === false ? 'Codex response · partial / CLI chưa hoàn tất' : s.key, s.provenance, s.data, true);
  const messages = incoming?.data ? inspectorMessages(incoming.data.messages, incoming.data.message_mapping === 'Original client messages' ? 'Client supplied' : 'Client supplied · Gateway generated role') : missing;
  const fullPrompt = rawSegment(incoming) + (gateway?.data ? inspectorCard('Prompt truyền vào provider.run()', 'Gateway generated · Client supplied messages', gateway.data.prompt) + inspectorCard('Request đã chuẩn hóa và tham số hiệu lực', 'Gateway generated', gateway.data, true) + inspectorMessages(gateway.data.forwarded_messages) : rawSegment(gateway)) +
    (cli?.data ? inspectorCard('Instructions file của gateway', 'Gateway generated', cli.data.instructions) + inspectorCard('Ngay trước CLI spawn', 'Gateway generated', cli.data, true) : rawSegment(cli)) +
    inspectorCard('Context nội bộ Codex', 'Internal / unavailable', 'Không quan sát được system prompt nội bộ, history do CLI resume, compaction hay private reasoning. Full Prompt chỉ là payload và prompt quan sát được ở gateway.');
  const response = rawSegment(segment('codex_response')) + rawSegment(segment('http_response'));
  const metadata = inspectorCard('Metadata / usage / pricing / latency', 'Gateway generated · usage: SDK observable', record, true) +
    (incoming?.data ? inspectorCard('Request parameters gốc', 'Client supplied', Object.fromEntries(Object.entries(incoming.data.payload).filter(([key])=>!['messages','message','prompt'].includes(key))), true) : '') +
    (gateway?.data ? inspectorCard('Tham số hiệu lực, session và thread', 'Gateway generated · thread_id_after: SDK observable', {effective_parameters: gateway.data.effective_parameters, normalized_parameters:Object.fromEntries(Object.entries(gateway.data.validated_request).filter(([key])=>key!=='messages')), session_id: gateway.data.session_id, thread_id_before: gateway.data.thread_id_before, thread_id_after:segment('codex_response')?.data?.thread_id ?? null}, true) : '') +
    inspectorCard('Thời điểm capture & retention', 'Gateway generated', {created_at: data.snapshot?.created_at ?? null, expires_at: data.snapshot?.expires_at ?? null, capture_points: segments.map(({key,provenance,captured_at,unavailable}) => ({key,provenance,captured_at,unavailable}))}, true) +
    inspectorCard('Token accounting', 'SDK observable', record.input_tokens === null ? 'Chưa có usage thực tế. Không ước tính token hoặc phân bổ theo context.' : 'Input/output/cache/reasoning token ở metadata là usage thực tế. Cache thuộc input, reasoning thuộc output. Không có token accounting cho từng message/context; không tính phần dư để suy ra context nội bộ.');
  $('request-inspector').innerHTML = `<div class="inspector-heading"><h3>AI Request Inspector</h3><button type="button" class="quiet" data-inspector-refresh>Làm mới</button><button type="button" class="quiet" data-inspector-delete ${data.snapshot ? '' : 'disabled'}>Xóa snapshot này</button><button type="button" class="quiet" data-inspector-delete-all>Xóa toàn bộ snapshot</button></div><p class="usage-note">Bản ghi đã áp dụng redaction; credentials và secret đã biết được che. Không ghi headers xác thực hoặc private reasoning. Retention: ${escape(data.retention_ms ? `${number(data.retention_ms / 3600000)} giờ` : '—')}.</p>${data.status !== 'captured' ? `<p class="notice">${escape(reasons[data.status] ?? reasons.unavailable)}</p>` : ''}<p class="usage-note">Đây là context gateway quan sát được, không phải toàn bộ provider-internal prompt.</p><div class="inspector-tools"><label>Tìm trong tab hiện tại <input id="inspector-search" type="search" placeholder="Nội dung, role, tham số…"></label><span id="inspector-search-status" role="status" aria-live="polite"></span></div><div class="inspector-tabs" role="tablist" aria-label="AI Request Inspector">${['Messages','Full Prompt','Response','Metadata'].map((title,i)=>`<button type="button" role="tab" id="inspector-tab-${i}" data-inspector-tab="${i}" aria-controls="inspector-panel-${i}" aria-selected="${i === 0}" tabindex="${i === 0 ? 0 : -1}">${title}</button>`).join('')}</div>${[messages, fullPrompt || missing, response || missing, metadata].map((content,i)=>`<div role="tabpanel" id="inspector-panel-${i}" aria-labelledby="inspector-tab-${i}" tabindex="0" ${i ? 'hidden' : ''}>${content}</div>`).join('')}<p id="inspector-action-status" class="usage-note" role="status" aria-live="polite"></p>`;
}
function selectInspectorTab(index) {
  document.querySelectorAll('[data-inspector-tab]').forEach(button => { const selected = Number(button.dataset.inspectorTab) === index; button.setAttribute('aria-selected', String(selected)); button.tabIndex = selected ? 0 : -1; });
  for (let i = 0; i < 4; i++) $(`inspector-panel-${i}`).hidden = i !== index;
  if ($('inspector-search')) { $('inspector-search').value = ''; filterInspector(''); }
}
function filterInspector(query) {
  const panel = document.querySelector('#request-inspector [role=tabpanel]:not([hidden])');
  if (!panel) return;
  let matches = 0;
  panel.querySelectorAll('.inspector-segment').forEach(card => { card.hidden = !card.textContent.toLocaleLowerCase().includes(query.toLocaleLowerCase()); if (!card.hidden) { matches++; if (query) card.querySelectorAll('details').forEach(details => { details.open = true; }); } });
  $('inspector-search-status').textContent = query ? `${matches} mục khớp` : '';
}
document.addEventListener('input', event => { if (event.target.id === 'inspector-search') filterInspector(event.target.value); });
document.addEventListener('keydown', event => {
  const tab = event.target.closest('[data-inspector-tab]'); if (!tab) return;
  const current = Number(tab.dataset.inspectorTab), next = event.key === 'ArrowRight' ? (current+1)%4 : event.key === 'ArrowLeft' ? (current+3)%4 : event.key === 'Home' ? 0 : event.key === 'End' ? 3 : null;
  if (next !== null) { event.preventDefault(); selectInspectorTab(next); $(`inspector-tab-${next}`).focus(); }
});
document.addEventListener('click', async event => {
  if(!event.target.closest('#request-inspector'))return;
  const button = event.target.closest('button'); if (!button) return;
  if (button.hasAttribute('data-inspector-tab')) return selectInspectorTab(Number(button.dataset.inspectorTab));
  if (button.hasAttribute('data-inspector-refresh') || button.hasAttribute('data-inspector-retry')) { const id = $('request-inspector')?.dataset.id; const record = inspectorView?.id === id ? inspectorView.record : rows.find(r => r.id === id); if (record) await loadInspector(id, record); return; }
  const status = $('inspector-action-status');
  if (button.hasAttribute('data-inspector-copy')) {
    try { await navigator.clipboard.writeText(button.closest('.inspector-segment').querySelector('pre').textContent); if (status) status.textContent = 'Đã sao chép nội dung đã redact.'; }
    catch { if (status) status.textContent = 'Không truy cập được clipboard. Chọn và sao chép văn bản trong khung.'; }
  }
  if ((button.hasAttribute('data-inspector-delete') || button.hasAttribute('data-inspector-delete-all')) && inspectorView) {
    const all = button.hasAttribute('data-inspector-delete-all');
    if (!confirm(all ? 'Xóa toàn bộ snapshot inspector? Metadata, usage và session vẫn được giữ.' : 'Xóa snapshot inspector của call này? Metadata và usage vẫn được giữ.')) return;
    const view = inspectorView; button.disabled = true;
    try {
      const response = await fetch(all ? '/api/stats/inspector' : `/api/stats/calls/${view.id}/inspector`, {method:'DELETE', body:'{}', headers:{'Content-Type':'application/json','X-Codex-Inspector':'1', ...(apiKey ? {Authorization:`Bearer ${apiKey}`} : {})}});
      if (!response.ok) throw new Error((await response.json()).error?.message ?? `HTTP ${response.status}`);
      if (inspectorView === view) await loadInspector(view.id, view.record);
    } catch (error) { if (status) status.textContent = `Xóa thất bại: ${error.message}`; button.disabled = false; }
  }
});
async function load({ quiet = false } = {}) {
  if (quiet && loading) return;
  controller?.abort(); controller = new AbortController();
  const current = controller;
  loading = true;
  $('refresh').disabled = true;
  const params = new URLSearchParams({ range: $('range').value });
  if ($('model').value) params.set('model', $('model').value);
  const callParams = new URLSearchParams(params); callParams.set('page', page);
  if ($('status').value) callParams.set('status', $('status').value);
  try {
    const [overview, calls] = await Promise.all([get(`/api/stats/overview?${params}`, current.signal), get(`/api/stats/calls?${callParams}`, current.signal)]);
    if (current !== controller) return;
    if (page > 1 && !calls.data.length) { page = Math.max(1, Math.ceil(calls.total / calls.page_size)); loading = false; return load(); }
    renderOverview(overview); renderCalls(calls);
    await Promise.all([loadCosts(), loadCatalog()]);
    $('updated').textContent = `Cập nhật ${time(Date.now())}`;
    $('auth-form').hidden = true; $('error').hidden = true;
  } catch (error) {
    if (error.name === 'AbortError' || current !== controller) return;
    setOnline(false, error.auth ? 'Cần token' : 'Mất kết nối');
    $('auth-form').hidden = !error.auth;
    $('error').hidden = Boolean(error.auth && !apiKey);
    $('error').textContent = error.auth ? 'Token chưa hợp lệ. Kiểm tra LOCAL_API_KEY và thử lại.' : error.message === 'Failed to fetch' ? 'Không kết nối được server. Kiểm tra server đang chạy và bấm Làm mới.' : `Không cập nhật được dữ liệu: ${error.message}`;
    $('updated').textContent = lastOverview ? 'Đang hiển thị dữ liệu lần cập nhật trước' : 'Chưa cập nhật';
  } finally {
    if (current === controller) { loading = false; $('refresh').disabled = false; }
  }
}
['range', 'model', 'status'].forEach(id => $(id).addEventListener('change', () => { page = 1; load(); }));
$('refresh').addEventListener('click', () => load());
$('previous').addEventListener('click', () => { page = Math.max(1, page - 1); load(); });
$('next').addEventListener('click', () => { page++; load(); });
$('call-rows').addEventListener('click', event => { const button = event.target.closest('[data-call]'); if (button) showDetail(button.dataset.call); });
$('close-detail').addEventListener('click', () => $('call-detail').close());
$('auth-form').addEventListener('submit', event => { event.preventDefault(); apiKey = $('api-key').value; $('api-key').value = ''; load(); });
setInterval(() => { if ($('auto-refresh').checked && !document.hidden && $('auth-form').hidden) load({ quiet: true }); }, 5000);
document.addEventListener('visibilitychange', () => { if (!document.hidden && $('auto-refresh').checked) load({ quiet: true }); });
window.addEventListener('resize', () => { if (lastOverview) chart(lastOverview.timeline, lastOverview.range); });

const money = value => value === null || value === undefined ? '—' : '$' + Number(value).toLocaleString('en-US', { minimumFractionDigits: 4, maximumFractionDigits: 6 });
let modelCatalog, chats = [], activeChat;
async function loadCosts() {
  const params = new URLSearchParams({ group: $('cost-group').value });
  if ($('model').value) params.set('model', $('model').value);
  const data = await get(`/api/stats/costs?${params}`);
  $('cost-cards').innerHTML = [['Hôm nay',data.current.day],['Tuần này',data.current.week],['Tháng này',data.current.month],['Tổng từ trước đến nay',data.current.total]].map(([label,value]) => `<div><small>${label}</small><strong>${money(value)}</strong></div>`).join('');
  $('cost-note').textContent = `${data.unpriced_calls} lượt chưa tính được do thiếu giá hoặc usage; tổng chỉ gồm lượt có đủ dữ liệu. Bộ lọc model áp dụng, khoảng thời gian phía dưới không áp dụng cho bảng chi phí.`;
  $('cost-rows').innerHTML = data.periods.map(p => `<tr><td>${escape(p.period)}</td><td class="number">${number(p.priced_calls)}</td><td class="number">${number(p.unpriced_calls)}</td><td class="number">${money(p.cost_usd)}</td></tr>`).join('') || '<tr><td colspan="4" class="empty-table">Chưa có dữ liệu chi phí</td></tr>';
}
async function loadCatalog() {
  if (modelCatalog) return;
  modelCatalog = await get('/api/models');
  $('catalog-note').textContent = `Snapshot ${modelCatalog.checked_on} · USD / 1M token. Khả dụng trong catalog không đảm bảo quyền của tài khoản hiện tại.`;
  $('chat-model').innerHTML = modelCatalog.models.filter(m => m.chat_supported).map(m => `<option value="${escape(m.id)}">${escape(m.id)}${m.availability === 'rollout' ? ' · rollout' : ''}</option>`).join('');
  if (!chats.length) newChat();
  renderCatalog();
}
function renderCatalog() {
  const search = $('model-search').value.toLowerCase();
  $('catalog-rows').innerHTML = modelCatalog.models.filter(m => `${m.id} ${m.provider}`.toLowerCase().includes(search)).map(m => `<tr><td><code>${escape(m.id)}</code><span class="catalog-provider">${escape(m.name)} · ${escape(m.provider)}</span></td><td>${escape(m.availability)}<p class="catalog-note">${escape(m.note)}</p></td><td class="number">${money(m.price?.input_per_million)}</td><td class="number">${money(m.price?.cached_input_per_million)}</td><td class="number">${money(m.price?.output_per_million)}</td><td><div class="catalog-actions"><button class="quiet" data-copy="${escape(m.id)}">Copy</button>${m.chat_supported ? `<button class="quiet" data-try="${escape(m.id)}">Test →</button>` : ''}</div></td></tr>`).join('');
}
function view(name) {
  if(name!=='request'){window.stopRequestDetail?.();if(/^\/dashboard\/requests\//.test(location.pathname))history.pushState({view:name},'', '/dashboard');}
  ['stats','native','videos','chat','catalog','live','request','lab'].forEach(id => { $(`view-${id}`).hidden = id !== name; });
  document.querySelectorAll('[data-view]').forEach(b => { b.classList.toggle('selected', b.dataset.view === name); b.setAttribute('aria-pressed', String(b.dataset.view === name)); });
  if(name==='lab')window.refreshLab?.();else window.stopLab?.();
  if (name === 'live') window.refreshLive?.();
  else window.stopLive?.();
  if (name === 'native') loadNative();
  if (name === 'videos') loadVideos();
  if (name === 'stats' && lastOverview) chart(lastOverview.timeline,lastOverview.range);
}
function currentChat() { return chats.find(c => c.id === activeChat); }
function newChat(model) {
  const id = crypto.randomUUID();
  chats.push({ id, title: `Chat ${chats.length + 1}`, model: model ?? lastOverview?.server.default_model ?? $('chat-model').value, reasoning: lastOverview?.server.default_reasoning ?? 'medium', context: '', messages: [], entries: [], draft: '', pending: false });
  activeChat = id; renderChat();
}
function saveChat() {
  const c = currentChat(); if (!c) return;
  c.model = $('chat-model').value; c.reasoning = $('chat-reasoning').value; c.context = $('chat-context').value; c.draft = $('chat-input').value;
}
function reasoningOptions(c) {
  const model = modelCatalog.models.find(m => m.id === c.model);
  const values = model?.reasoning ?? ['low','medium','high'];
  if (!values.includes(c.reasoning)) c.reasoning = values.includes(model?.default_effort) ? model.default_effort : values[0];
  $('chat-reasoning').innerHTML = values.map(v => `<option value="${escape(v)}">${escape(v)}</option>`).join('');
  $('chat-reasoning').value = c.reasoning;
}
function renderChat() {
  const c = currentChat(); if (!c || !modelCatalog) return;
  $('chat-tabs').innerHTML = chats.map(t => `<button class="${t.id === c.id ? 'selected' : ''}" data-chat="${t.id}" aria-pressed="${t.id === c.id}">${escape(t.title)}${t.pending ? ' · …' : ''}</button>`).join('');
  $('chat-model').value = c.model;
  if (!$('chat-model').value) c.model = $('chat-model').value = modelCatalog.models.find(m => m.chat_supported).id;
  reasoningOptions(c); $('chat-context').value = c.context; $('chat-input').value = c.draft;
  for (const id of ['chat-model','chat-reasoning','chat-context','send-chat','clear-chat']) $(id).disabled = c.pending;
  $('stop-chat').hidden = !c.pending;
  $('chat-hint').textContent = c.pending ? (c.streamStatus ?? 'Đang mở luồng phản hồi…') : (c.streamStatus ?? 'Thread tạm · câu trả lời được nhận theo luồng, không lưu conversation');
  $('chat-messages').innerHTML = c.entries.map((e,i) => `<article class="chat-message ${e.role}${e.streaming ? ' chat-streaming' : ''}${(e.displayText ?? e.text) ? ' chat-has-content' : ''}" data-chat-entry="${i}"><div class="chat-message-heading"><small>${e.role === 'user' ? 'Bạn' : 'Codex'}</small>${e.streaming ? '<span class="chat-phase">' + (e.text ? 'Đang hiển thị' : 'Đang chờ phản hồi') + '</span>' : ''}</div><div class="chat-waiting" aria-hidden="true"><i></i><i></i><i></i></div><div class="message-text">${escape(e.displayText ?? e.text)}</div>${e.error ? `<p class="chat-message-error" role="status">Luồng chưa hoàn tất: ${escape(e.error)}</p>` : ''}${e.details ? `<button class="quiet" data-entry="${i}">Chi tiết lượt này ↗</button>` : ''}</article>`).join('') + (!c.entries.length && !c.pending ? '<div class="chat-empty"><div class="chat-startmark" aria-hidden="true">✦</div><h3>Bắt đầu một lượt test</h3><p>Chọn model và mức reasoning, rồi gửi tin nhắn. Nội dung nhận từ gateway sẽ được hiển thị dần.</p><div class="chat-suggestions"><button type="button" data-chat-prompt="Hãy viết một câu trả lời dài khoảng 5 đoạn để tôi quan sát nội dung stream xuất hiện dần.">Kiểm tra phản hồi dài và quan sát nội dung stream</button><button type="button" data-chat-prompt="Giải thích cách đọc các sự kiện Server-Sent Events (SSE) trong một ứng dụng trình duyệt.">Giải thích cách đọc sự kiện SSE trong trình duyệt</button><button type="button" data-chat-prompt="Viết ví dụ TypeScript parse một luồng SSE, xử lý dữ liệu chia qua nhiều chunk và kết thúc bằng [DONE].">Viết ví dụ parse SSE bằng TypeScript</button><button type="button" data-chat-prompt="Giải thích cách hủy một request đang stream bằng AbortController.">Giải thích cách dừng request stream</button></div></div>' : '');
  $('chat-messages').scrollTop = $('chat-messages').scrollHeight;
}
// Smooth presentation of received text. Network timing/counts are recorded separately.
function createChatPresenter(chat, entry) {
  const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)');
  let frame = null, previous = 0, stopped = false, finishing = false, resolveFinished;
  const completed = new Promise(resolve => { resolveFinished = resolve; });
  entry.displayText = '';
  const paint = () => {
    if (activeChat !== chat.id) return;
    const container = $('chat-messages');
    const follow = container.scrollHeight - container.clientHeight - container.scrollTop < 80;
    const article = container.querySelector(`[data-chat-entry="${chat.entries.indexOf(entry)}"]`);
    if (article) {
      const text = article.querySelector('.message-text');
      if (text.textContent !== entry.displayText) text.textContent = entry.displayText;
      article.classList.toggle('chat-has-content', !!entry.displayText);
      article.classList.toggle('chat-revealing', !!entry.displayText && entry.streaming);
      const phase = article.querySelector('.chat-phase');
      if (phase) phase.textContent = entry.text ? (finishing ? 'Đang hiển thị' : 'Đang nhận phản hồi') : 'Đang chờ phản hồi';
    }
    if (follow) container.scrollTop = container.scrollHeight;
  };
  const tick = now => {
    frame = null;
    const elapsed = previous ? Math.min(now - previous, 64) : 16;
    previous = now;
    const remaining = entry.text.length - entry.displayText.length;
    let end = reducedMotion.matches ? entry.text.length : Math.min(entry.text.length, entry.displayText.length + Math.max(1, Math.ceil(remaining * elapsed / 160)));
    // Never show half of an emoji/surrogate pair.
    if (end < entry.text.length && /[\uD800-\uDBFF]/.test(entry.text[end - 1] ?? '')) end++;
    entry.displayText = entry.text.slice(0,end); paint();
    if (entry.displayText.length < entry.text.length) schedule();
    else if (finishing) resolveFinished();
  };
  const schedule = () => { if (frame === null && !stopped) frame = requestAnimationFrame(tick); };
  const flush = () => {
    if (frame !== null) cancelAnimationFrame(frame);
    frame = null; entry.displayText = entry.text; paint();
  };
  // Hidden tabs must not keep a request pending while animation frames are suspended.
  const visibility = () => { if (document.hidden) { flush(); if (finishing) resolveFinished(); } };
  document.addEventListener('visibilitychange',visibility);
  return {
    update() { previous = frame === null ? 0 : previous; if (document.hidden || reducedMotion.matches) flush(); else schedule(); },
    finish() { finishing = true; if (document.hidden || reducedMotion.matches || entry.displayText === entry.text) { flush(); resolveFinished(); } else schedule(); return completed; },
    stop() { stopped = true; flush(); resolveFinished(); document.removeEventListener('visibilitychange',visibility); },
  };
}
async function readPlaygroundStream(response, onDelta) {
  if (!response.body) throw new Error('Trình duyệt không đọc được response stream.');
  const reader = response.body.getReader(), decoder = new TextDecoder();
  const state = { id: null, object: 'chat.completion', created: null, model: null, content: '', finishReason: null, usage: null, toolCalls: new Map(), done: false };
  const parseBlock = block => {
    const data = block.split(/\r?\n/).filter(line => line.startsWith('data:')).map(line => line.slice(5).trimStart()).join('\n');
    if (!data) return;
    if (data === '[DONE]') { state.done = true; return; }
    const chunk = JSON.parse(data);
    if (chunk.error) throw new Error(chunk.error.message ?? 'Stream bị gián đoạn.');
    state.id ??= chunk.id ?? null; state.created ??= chunk.created ?? null; state.model ??= chunk.model ?? null;
    if (chunk.usage !== undefined) state.usage = chunk.usage;
    for (const choice of chunk.choices ?? []) {
      const delta = choice.delta ?? {};
      if (typeof delta.content === 'string' && delta.content) { state.content += delta.content; onDelta(delta.content); }
      for (const tool of delta.tool_calls ?? []) {
        const index = Number(tool.index ?? state.toolCalls.size), current = state.toolCalls.get(index) ?? { id: '', type: 'function', function: { name: '', arguments: '' } };
        if (tool.id) current.id = tool.id;
        if (tool.type) current.type = tool.type;
        if (tool.function?.name) current.function.name += tool.function.name;
        if (tool.function?.arguments) current.function.arguments += tool.function.arguments;
        state.toolCalls.set(index, current);
      }
      if (choice.finish_reason) state.finishReason = choice.finish_reason;
    }
  };
  let buffer = '';
  try {
    while (true) {
      const { value, done } = await reader.read();
      buffer += decoder.decode(value ?? new Uint8Array(), { stream: !done });
      let boundary;
      while ((boundary = buffer.match(/\r?\n\r?\n/))) {
        const index = boundary.index;
        parseBlock(buffer.slice(0,index)); buffer = buffer.slice(index + boundary[0].length);
      }
      if (done) { if (buffer.trim()) parseBlock(buffer); break; }
    }
  } catch (error) {
    await reader.cancel().catch(() => {});
    throw error;
  } finally { reader.releaseLock(); }
  if (!state.done) throw new Error('Luồng kết thúc trước tín hiệu hoàn tất.');
  const message = { role: 'assistant', content: state.content };
  const tool_calls = [...state.toolCalls.entries()].sort((a,b) => a[0]-b[0]).map(([,tool]) => tool);
  if (tool_calls.length) message.tool_calls = tool_calls;
  return { id: state.id, object: state.object, created: state.created, model: state.model, choices: [{ index: 0, message, finish_reason: state.finishReason }], usage: state.usage };
}
async function copy(value, button) {
  try { await navigator.clipboard.writeText(value); const old = button.textContent; button.textContent = 'Đã copy'; setTimeout(() => { button.textContent = old; },1500); }
  catch { $('error').textContent = `Không copy được. Model ID: ${value}`; $('error').hidden = false; }
}
$('chat-form').addEventListener('submit', async event => {
  event.preventDefault(); saveChat(); const c = currentChat(); if (!c || c.pending || !c.draft.trim()) return;
  const message = { role: 'user', content: c.draft.trim() };
  const submitted = { model: c.model, reasoning_effort: c.reasoning, stream: true, stream_options: { include_usage: true }, messages: [...(c.context.trim() ? [{ role: 'system',content: c.context.trim() }] : []), ...c.messages,message] };
  c.entries.push({ role: 'user',text: message.content });
  const assistantEntry = { role: 'assistant', text: '', streaming: true }; c.entries.push(assistantEntry);
  c.draft = ''; c.pending = true; c.streamStatus = 'Đang kết nối tới luồng phản hồi…';
  c.controller = new AbortController(); const start = performance.now(); renderChat();
  const presenter = createChatPresenter(c,assistantEntry), signal = c.controller.signal;
  signal.addEventListener('abort',presenter.stop,{once:true});
  if (!matchMedia('(prefers-reduced-motion: reduce)').matches) {
    $('chat-messages').querySelectorAll('.chat-message:nth-last-child(-n+2)').forEach(node => node.animate([{opacity:0,transform:'translateY(8px)'},{opacity:1,transform:'translateY(0)'}],{duration:220,easing:'cubic-bezier(.2,.8,.2,1)'}));
  }
  let callId, result, status, metric, failure;
  let firstContentAt = null, deltaCount = 0, lastHintAt = 0;
  try {
    const response = await fetch('/api/playground/chat', { method: 'POST', signal: c.controller.signal, headers: { 'Content-Type': 'application/json','X-Codex-Playground': '1',...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}) }, body: JSON.stringify(submitted) });
    callId = response.headers.get('X-Codex-Call-Id'); status = response.status;
    if (!response.ok) { const errorBody = await response.json().catch(() => ({})); if (response.status === 401) $('auth-form').hidden = false; throw new Error(errorBody.error?.message ?? `HTTP ${status}`); }
    if (!response.headers.get('Content-Type')?.includes('text/event-stream')) throw new Error('Gateway không trả về SSE stream như mong đợi.');
    result = await readPlaygroundStream(response, delta => {
      const now = performance.now(); firstContentAt ??= now; assistantEntry.text += delta; deltaCount++;
      c.streamStatus = `Đang nhận · TTFO ${((firstContentAt-start)/1000).toFixed(2)} s · ${deltaCount} đoạn · ${assistantEntry.text.length} ký tự`;
      presenter.update();
      if (activeChat === c.id && now-lastHintAt > 150) { $('chat-hint').textContent = c.streamStatus; lastHintAt = now; }
    });
    c.messages.push(message,result.choices[0].message);
  } catch (error) { failure = error.name === 'AbortError' ? 'Đã dừng lượt chat.' : error.message; assistantEntry.error = failure; }
  const elapsed = performance.now() - start;
  c.streamStatus = failure ? 'Luồng đã dừng.' : `Đã nhận ${deltaCount} đoạn · ${assistantEntry.text.length} ký tự · đang hiển thị`;
  if (activeChat === c.id) $('chat-hint').textContent = c.streamStatus;
  if (failure) presenter.stop();
  await presenter.finish();
  presenter.stop(); signal.removeEventListener('abort',presenter.stop);
  if (callId) { try { metric = await get(`/api/stats/calls/${callId}`); } catch {} }
  assistantEntry.streaming = false;
  assistantEntry.details = { request: submitted, response: result ?? null, metrics: metric ?? null, call_id: callId ?? null, http_status: status ?? null, client_duration_ms: elapsed, first_content_ms: firstContentAt === null ? null : firstContentAt-start, received_content_deltas: deltaCount, error: failure ?? null };
  c.streamStatus = failure ? `Stream dừng · ${assistantEntry.text.length} ký tự đã nhận` : `Hoàn tất · TTFO ${firstContentAt === null ? '—' : ((firstContentAt-start)/1000).toFixed(2)+' s'} · ${(elapsed/1000).toFixed(2)} s nhận · ${deltaCount === 1 ? 'Gateway trả 1 đoạn; giao diện hiển thị dần' : `${deltaCount} đoạn nhận từ gateway`}`;
  c.pending = false; c.controller = null;
  if (activeChat === c.id) renderChat(); load({ quiet: true });
});
$('chat-input').addEventListener('keydown', event => { if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) { event.preventDefault(); $('chat-form').requestSubmit(); } });
$('chat-input').addEventListener('input',saveChat); $('chat-context').addEventListener('input',saveChat);
$('chat-model').addEventListener('change', () => { const c = currentChat(); c.model = $('chat-model').value; reasoningOptions(c); });
$('chat-reasoning').addEventListener('change',saveChat);
$('stop-chat').addEventListener('click', () => currentChat()?.controller?.abort());
$('new-chat').addEventListener('click', () => { saveChat(); newChat(); });
$('clear-chat').addEventListener('click', () => { const c = currentChat(); if (c.pending) return; chats = chats.filter(t => t.id !== c.id); if (!chats.length) newChat(); else { activeChat = chats[0].id; renderChat(); } });
$('chat-tabs').addEventListener('click', event => { const b = event.target.closest('[data-chat]'); if (b) { saveChat(); activeChat = b.dataset.chat; renderChat(); } });
$('chat-messages').addEventListener('click', event => { const prompt = event.target.closest('[data-chat-prompt]'); if (prompt) { $('chat-input').value = prompt.dataset.chatPrompt; $('chat-input').dispatchEvent(new Event('input',{bubbles:true})); $('chat-input').focus(); return; } const b = event.target.closest('[data-entry]'); if (!b) return; const details = currentChat().entries[Number(b.dataset.entry)].details; if (details.metrics) showDetail(details.call_id, details.metrics); else { $('detail-content').innerHTML = '<p class="usage-note">' + escape(details.error ?? 'Chưa có metadata từ server.') + '</p>'; $('call-detail').showModal(); } const raw = document.createElement('details'); raw.className = 'system-context'; const summary = document.createElement('summary'); summary.textContent = 'Request / response đầy đủ · chỉ trong bộ nhớ trang'; const pre = document.createElement('pre'); pre.className = 'detail-json'; pre.textContent = JSON.stringify(details,null,2); raw.append(summary,pre); $('detail-content').append(raw); });
$('copy-model').addEventListener('click', event => copy($('chat-model').value,event.currentTarget));
$('catalog-rows').addEventListener('click', event => { const b = event.target.closest('button'); if (b?.dataset.copy) copy(b.dataset.copy,b); if (b?.dataset.try) { saveChat(); newChat(b.dataset.try); view('chat'); } });
$('model-search').addEventListener('input',renderCatalog);
$('cost-group').addEventListener('change', () => loadCosts().catch(error => { $('error').textContent = error.message; $('error').hidden = false; }));
document.querySelectorAll('[data-view]').forEach(b => b.addEventListener('click', () => view(b.dataset.view)));

let nativePage = 1, nativeController, nativeLoading = false;
let nativeProjects = [], nativeProjectTotal = 0;
let nativeProjectSort = { key: 'tokens', direction: 'desc' };
function sortedNativeProjects(list) {
  const value = row => nativeProjectSort.key === 'tokens' ? row.input_tokens + row.output_tokens : row.calls > row.unpriced_events ? row.cost_usd : null;
  return [...list].sort((a,b) => {
    const av = value(a), bv = value(b);
    if (av == null || bv == null) return av == null ? (bv == null ? a.key.localeCompare(b.key) : 1) : -1;
    return (nativeProjectSort.direction === 'asc' ? av - bv : bv - av) || a.key.localeCompare(b.key);
  });
}
function renderNativeProjects() {
  $('native-projects').innerHTML = nativeGrouped(sortedNativeProjects(nativeProjects), nativeProjectTotal, true);
  $('native-projects').querySelectorAll('[data-native-width]').forEach(e => { e.style.width = e.dataset.nativeWidth + '%'; });
  document.querySelectorAll('[data-project-sort]').forEach(button => {
    const active = button.dataset.projectSort === nativeProjectSort.key;
    const ascending = nativeProjectSort.direction === 'asc';
    const label = button.dataset.projectSort === 'tokens' ? 'Token' : 'USD ước tính';
    button.closest('th').setAttribute('aria-sort', active ? (ascending ? 'ascending' : 'descending') : 'none');
    button.querySelector('span').textContent = active ? (ascending ? '↑' : '↓') : '↕';
    button.setAttribute('aria-label', active ? `${label}: ${ascending ? 'tăng' : 'giảm'} dần. Bấm để sắp xếp ${ascending ? 'giảm' : 'tăng'} dần` : `Sắp xếp ${label} giảm dần`);
  });
}
document.querySelectorAll('[data-project-sort]').forEach(button => button.addEventListener('click', () => {
  const key = button.dataset.projectSort;
  nativeProjectSort = { key, direction: key === nativeProjectSort.key && nativeProjectSort.direction === 'desc' ? 'asc' : 'desc' };
  renderNativeProjects();
}));
const sourceLabels = { 'gateway-log':'Gateway · từ rollout', exec:'Codex exec', cli:'Codex CLI', vscode:'VS Code / App (vscode)', subagent:'Subagent', unknown:'Chưa xác định' };
const compact = value => value >= 1000000 ? new Intl.NumberFormat('vi-VN',{notation:'compact',maximumFractionDigits:2}).format(value) : number(value);
const nativeCost = row => `${row.calls > row.unpriced_events ? money(row.cost_usd) : '—'}${row.unpriced_events ? `<small class="native-cost-unknown">${number(row.unpriced_events)} record chưa có giá</small>` : ''}`;
const nativeValue = (value,kind) => kind === 'cost' ? money(value) : new Intl.NumberFormat('vi-VN',{maximumFractionDigits:1}).format(value);
function nativePeriodNote(data,key,current,kind='number') {
  const read = summary => key === 'total_tokens' ? Number(summary.input_tokens)+Number(summary.output_tokens) : summary[key];
  if (data.comparison) {
    const previous = Number(read(data.comparison.summary) ?? 0), value = Number(current ?? 0);
    if (!previous) return `<span class="metric-trend metric-trend-neutral">${value ? 'Mới' : 'Không đổi'} · so với ${data.comparison.label.toLowerCase()}</span>`;
    const delta = (value-previous)/previous*100;
    if (Math.abs(delta)<0.05) return `<span class="metric-trend metric-trend-neutral">— Không đổi · so với ${data.comparison.label.toLowerCase()}</span>`;
    return `<span class="metric-trend metric-trend-${delta>0?'up':'down'}">${delta>0?'↑':'↓'} ${Math.abs(delta).toFixed(1)}% · so với ${data.comparison.label.toLowerCase()}</span>`;
  }
  if (data.average && key !== 'tokens_per_turn') {
    const average = read(data.average.summary), unit = data.average.unit === 'month' ? 'tháng' : 'ngày';
    return `TB ${nativeValue(average,kind)}/${unit}`;
  }
  return '';
}
function nativeOptions(id,values,label) {
  const selected = $(id).value; $(id).innerHTML = `<option value="">${label}</option>` + values.map(v=>`<option value="${escape(v)}">${escape(id==='native-source' ? sourceLabels[v] ?? v : v)}</option>`).join(''); $(id).value = selected;
}
function nativeGrouped(list,total,project=false) { return list.map(r=>`<tr><td class="${project ? 'native-path' : 'model-name'}">${project ? `<strong>${escape(r.key.split('/').filter(Boolean).pop() ?? r.key)}</strong><small>${escape(r.key)}</small>` : escape(r.key)}<div class="native-meter"><span data-native-width="${total ? (r.input_tokens+r.output_tokens)/total*100 : 0}"></span></div></td>${project ? '' : `<td class="number">${number(r.sessions)}</td>`}<td class="number">${number(r.input_tokens+r.output_tokens)}</td><td class="number">${r.tokens_per_turn === null ? '—' : number(Math.round(r.tokens_per_turn))}<small class="native-stat-note">${number(r.usage_turns)} turn có usage</small></td>${project ? `<td class="number">${money(r.cost_per_session)}<small class="native-stat-note">${number(r.priced_sessions)}/${number(r.sessions)} session đủ giá${r.unpriced_sessions ? ' · tổng có thể thiếu' : ''}</small></td>` : ''}<td class="number">${nativeCost(r)}</td></tr>`).join('') || '<tr><td colspan="5" class="empty-table">Chưa có usage trong bộ lọc</td></tr>'; }
async function loadNative({quiet=false}={}) {
  if (quiet && nativeLoading) return;
  nativeController?.abort(); const controller = nativeController = new AbortController(); nativeLoading=true;
  $('native-refresh').disabled=true;
  const params = new URLSearchParams({range:$('native-range').value,group:$('native-group').value,page:nativePage});
  for (const key of ['model','source','project']) if ($(`native-${key}`).value) params.set(key,$(`native-${key}`).value);
  try {
    const d = await get(`/api/native/overview?${params}`,controller.signal);
    if (controller !== nativeController) return;
    if (nativePage>1 && !d.data.length) {nativePage=Math.max(1,Math.ceil(d.total/d.page_size));return loadNative();}
    const s=d.summary, total=s.input_tokens+s.output_tokens;
    $('native-sync').textContent = `${d.collector.syncing ? 'Đang đồng bộ…' : 'Đồng bộ mỗi '+d.collector.interval_ms/1000+'s'} · ${d.collector.last_sync ? 'Lần cuối '+date(d.collector.last_sync)+' '+time(d.collector.last_sync) : 'Đang nhập lịch sử lần đầu'} · ${d.collector.home}${d.collector.issues.length ? ' · '+d.collector.issues.join(' ') : ''}`;
    const cards = [
      ['Sessions',s.sessions,`${s.usage_unavailable_sessions} session chưa có usage`,'sessions','number'],
      ['Turns',s.turns,`${s.calls} usage record · không phải số HTTP call`,'turns','number'],
      ['Input tokens',s.input_tokens,`Cache hit rate: ${s.cache_hit_rate === null ? '—' : (s.cache_hit_rate*100).toFixed(1)+'%'} · cached / input`,'input_tokens','number'],
      ['Output tokens',s.output_tokens,`${number(s.reasoning_tokens)} reasoning trong output`,'output_tokens','number'],
      ['Cached tokens',s.cached_tokens,s.input_tokens ? `${(s.cached_tokens/s.input_tokens*100).toFixed(1)}% input được cache` : '—','cached_tokens','number'],
      ['Tổng token',total,`Cache hit rate: ${s.cache_hit_rate === null ? '—' : (s.cache_hit_rate*100).toFixed(1)+'%'}`,'total_tokens','number'],
      ['API-equivalent cost',s.cost_usd,`${s.unpriced_events} record chưa có giá`,'cost_usd','cost'],
      ['Token / turn',s.tokens_per_turn === null ? null : Math.round(s.tokens_per_turn),`${number(s.usage_turns)} turn có usage · ${number(s.unattributed_events)} record chưa gắn turn`,'tokens_per_turn','number']
    ];
    $('native-cards').innerHTML=cards.map(([label,value,note,key,kind])=>{
      const periodNote=nativePeriodNote(d,key,value,kind);
      return `<article class="metric"><div class="metric-label">${label}</div><div class="metric-value" title="${escape(number(value))}">${kind==='cost' ? money(value) : compact(value)}</div><p>${periodNote ? `${periodNote}<span class="metric-period-note">${escape(note)}</span>` : escape(note)}</p></article>`;
    }).join('');
    $('native-note').textContent=`${d.range.label}: ${date(d.range.since)} ${time(d.range.since)} → ${date(d.range.until)} ${time(d.range.until)} (UTC+7). Giá API tham khảo, không phải hóa đơn Plus. Nguồn lấy từ metadata; vscode có thể là App hoặc VS Code. Gateway trong rollout chỉ là dữ liệu quan sát, không cộng vào thống kê server. Log cũ dùng chênh lệch token_count; record response được ưu tiên. Session không còn rollout hoặc thread ephemeral có thể không có usage.`;

    $('native-spike-count').textContent = number(s.context_spikes);
    $('native-spike-note').textContent = `Hiển thị ${number(d.spikes.length)}/${number(s.context_spikes)} cảnh báo gần nhất trong bộ lọc. Input record tăng >2× và ≥50k, cùng session/model; cần kiểm tra, không kết luận lãng phí.`;
    $('native-spikes').innerHTML=d.spikes.map(r=>`<tr><td class="native-path"><strong>${escape(r.cwd.split('/').filter(Boolean).pop() ?? r.cwd)}</strong><small>${escape(r.session_id)}</small></td><td><code>${escape(r.model)}</code><small class="native-stat-note">${escape(date(r.timestamp)+' '+time(r.timestamp))}</small></td><td class="spike-sequence">${r.sequence.map(n=>number(n)).join(' → ')}</td><td class="number">${r.growth_ratio.toFixed(1)}×</td><td><button class="quiet" data-native-session="${escape(r.session_id)}">Xem session ↗</button></td></tr>`).join('') || '<tr><td colspan="5" class="empty-table">Không có context spike trong bộ lọc.</td></tr>';
    nativeProjects=d.projects;nativeProjectTotal=total;renderNativeProjects();$('native-models').innerHTML=nativeGrouped(d.models,total);
    document.querySelectorAll('[data-native-width]').forEach(e=>{e.style.width=e.dataset.nativeWidth+'%';});
    $('native-periods').innerHTML=d.periods.map(r=>`<tr><td>${escape(r.period)}</td><td class="number">${number(r.calls)}</td><td class="number">${number(r.input_tokens)}</td><td class="number">${number(r.cached_tokens)}</td><td class="number">${number(r.output_tokens)}</td><td class="number">${nativeCost(r)}</td></tr>`).join('') || '<tr><td colspan="6" class="empty-table">Chưa có usage</td></tr>';
    $('native-sessions').innerHTML=d.data.map(r=>`<tr><td class="native-path"><strong>${escape(r.cwd.split('/').filter(Boolean).pop() ?? r.cwd)}</strong><small>${escape(r.cwd)}<br>${escape(r.id)}<br>${r.updated_at ? escape(date(r.updated_at)+' '+time(r.updated_at)) : '—'}</small></td><td><span class="badge success">${escape(sourceLabels[r.source] ?? r.source)}</span><div class="endpoint">${escape(r.model)}</div>${r.context_spikes ? `<small class="native-cost-unknown">${number(r.context_spikes)} context spike</small>` : ''}${r.malformed || r.resets ? '<small class="native-cost-unknown">Log có dòng lỗi / bộ đếm reset</small>' : ''}</td><td class="number">${number(r.turns)}</td><td class="number">${r.usage_available ? number(r.input_tokens+r.output_tokens) : '—'}</td><td class="number">${r.tokens_per_turn === null ? '—' : number(Math.round(r.tokens_per_turn))}</td><td class="number">${seconds(r.duration_ms)}</td><td class="number">${nativeCost(r)}</td><td><button class="quiet" data-native-session="${escape(r.id)}">Chi tiết ↗</button></td></tr>`).join('') || '<tr><td colspan="8" class="empty-table">Chưa tìm thấy session trong bộ lọc</td></tr>';
    $('native-history-note').textContent=`${number(d.total)} session · token theo bộ lọc. Thời gian là tổng turn đã hoàn thành được chọn, không gồm thời gian chờ giữa các turn.`;
    $('native-page-info').textContent=`${number(d.total)} session`; $('native-page-number').textContent=`Trang ${nativePage}`;
    $('native-previous').disabled=nativePage<=1;$('native-next').disabled=nativePage*d.page_size>=d.total;
    nativeOptions('native-model',d.filters.models,'Tất cả model');nativeOptions('native-project',d.filters.projects,'Tất cả project');nativeOptions('native-source',d.filters.sources,'Tất cả nguồn');
  } catch(error) {
    if(error.name==='AbortError')return;
    $('native-sync').textContent=error.message;if(error.auth)$('auth-form').hidden=false;
  } finally {if(controller===nativeController){nativeLoading=false;$('native-refresh').disabled=false;}}
}
async function nativeDetail(id) {
  try {
    const d=await get(`/api/native/sessions/${encodeURIComponent(id)}`), s=d.session;
    $('call-detail').classList.add('native-details-dialog');$('call-detail').querySelector('h2').textContent='Chi tiết Codex session';
    const spikeTurns=new Set(d.spikes.map(s=>s.turn_id));
    const turnRows=d.turns.map(t=>{
      const spike=spikeTurns.has(t.id);
      return `<tr><td>${escape(t.id.split(':').pop())}<br>${escape(t.model)} · ${escape(t.reasoning)}<br>${escape(t.status)}${spike ? '<small class="native-cost-unknown">Context spike</small>' : ''}</td><td>${escape(date(t.started_at)+' '+time(t.started_at))}</td><td class="number">${number(t.input_tokens)}</td><td class="number">${number(t.cached_tokens)}</td><td class="number">${number(t.output_tokens)}</td><td class="number">${t.finished_at===null ? '—' : seconds(t.finished_at-t.started_at)}</td><td class="number">${money(t.cost_usd)}</td></tr>`;
    }).join('');
    $('detail-content').innerHTML=`<div class="native-detail-head"><p>${escape(s.id)}<br>${escape(s.cwd)}<br>${escape(sourceLabels[s.source] ?? s.source)} · ${escape(s.model)}</p><p>Thời điểm session: ${escape(date(s.created_at)+' '+time(s.created_at))} → ${escape(date(s.updated_at)+' '+time(s.updated_at))}<br>Rollout: ${escape(s.rollout_path ?? 'Chưa tìm thấy rollout')}</p><p>${number(s.malformed)} dòng không parse được · ${number(s.resets)} lần bộ đếm reset</p>${d.spikes.length ? `<div class="native-spike">${number(d.spikes.length)} context spike · input mỗi usage record tăng >2× và ≥50k, cùng model.<ul>${d.spikes.slice(-20).map(e=>`<li>${escape(e.model)} · ${escape(date(e.timestamp)+' '+time(e.timestamp))}: ${e.sequence.map(n=>number(n)).join(' → ')} (${e.growth_ratio.toFixed(1)}×)</li>`).join('')}</ul></div>` : ''}</div><div class="native-detail-table"><table><thead><tr><th>Turn / model</th><th>Bắt đầu</th><th>Input</th><th>Cache</th><th>Output</th><th>Thời gian</th><th>USD</th></tr></thead><tbody>${turnRows || '<tr><td colspan="7">Chưa có turn được ghi trong rollout.</td></tr>'}</tbody></table></div><details class="system-context"><summary>Usage events & snapshot giá · tối đa 200 record mới nhất</summary><pre class="detail-json">${escape(JSON.stringify(d.events,null,2))}</pre></details>`;
    const tags=document.createElement('div');tags.className='video-session-tags';
    tags.innerHTML=(d.video_tags??[]).map(t=>`<button class="quiet" data-video-open="${escape(t.video_build_id)}">Video: ${escape(t.video_build_id)} · Stage: ${escape(t.stage)}</button>`).join('')||'<p class="subtitle">Chưa gắn video build.</p>';
    const options=videoData??await get('/api/videos');
    tags.innerHTML+=`<form id="video-session-link" class="video-actions"><label>Video<select name="build" required><option value="">Chọn build đã tạo</option>${options.builds.map(b=>`<option value="${escape(b.id)}">${escape(b.title)} · ${escape(b.id)}</option>`).join('')}</select></label><label>Stage<select name="stage">${videoStages.map(t=>`<option>${t}</option>`).join('')}</select></label><button class="quiet" type="submit">Gắn video/stage</button><span id="video-link-error" class="subtitle" role="status"></span></form>`;
    $('detail-content').prepend(tags);
    tags.addEventListener('click',e=>{const b=e.target.closest('[data-video-open]');if(b){$('call-detail').close();view('videos');showVideoBuild(b.dataset.videoOpen);}});
    tags.querySelector('form').addEventListener('submit',async e=>{
      e.preventDefault();const form=e.currentTarget,button=form.querySelector('button');button.disabled=true;
      try{const buildId=form.elements.build.value,entry=await get(`/api/videos/${encodeURIComponent(buildId)}`),stage=form.elements.stage.value;
        const ranks={PLAN:0,BUILD:1,REVISE:2,FINISH:3},newStage={id:crypto.randomUUID(),stage,session_id:s.id,model:s.model,notes:'',approved:false};
        const at=entry.manifest.stages.findIndex(t=>ranks[t.stage]>ranks[stage]);entry.manifest.stages.splice(at<0?entry.manifest.stages.length:at,0,newStage);
        await writeVideo(`/api/videos/${encodeURIComponent(buildId)}`,entry.manifest,'PUT');videoData=null;await nativeDetail(id);
      }catch(error){tags.querySelector('#video-link-error').textContent=error.message;}finally{button.disabled=false;}
    });
    if(!$('call-detail').open)$('call-detail').showModal();
  }catch(error){$('native-sync').textContent=error.message;}
}
['range','model','source','project','group'].forEach(key=>$(`native-${key}`).addEventListener('change',()=>{nativePage=1;loadNative();}));
$('native-refresh').addEventListener('click',()=>loadNative());
$('native-previous').addEventListener('click',()=>{nativePage--;loadNative();});$('native-next').addEventListener('click',()=>{nativePage++;loadNative();});
$('view-native').addEventListener('click',event=>{const b=event.target.closest('[data-native-session]');if(b)nativeDetail(b.dataset.nativeSession);});
setInterval(()=>{if(!$('view-native').hidden&&!document.hidden&&$('auto-refresh').checked)loadNative({quiet:true});},5000);
let videoData=null,videoEditing=null,videoImportMode=false,videoGeneration=0,videoOpenId=null;
const videoStages=['PLAN','BUILD','REVISE','FINISH'],videoScores=['clarity','visual','motion','originality','wow','technical','overall'];
const videoStatus={planned:'Đã lên kế hoạch',preview:'Preview',approved:'Đã duyệt',final:'Hoàn tất'};
const videoDecimal=v=>v==null?'—':new Intl.NumberFormat('vi-VN',{maximumFractionDigits:2}).format(v);
async function writeVideo(path,manifest,method='POST') {
  const response=await fetch(path,{method,headers:{'Content-Type':'application/json','X-Codex-Video':'1',...(apiKey?{Authorization:`Bearer ${apiKey}`}:{})},body:JSON.stringify(manifest)});
  const data=await response.json();if(!response.ok)throw new Error(data.error?.message??`HTTP ${response.status}`);return data;
}
async function loadVideos() {
  const generation=++videoGeneration;$('video-refresh').disabled=true;
  try {
    const data=await get('/api/videos');if(generation!==videoGeneration)return;videoData=data;const s=data.summary;
    const cards=[['Builds',number(s.builds),'Tất cả thử nghiệm'],['Approved first pass',number(s.approved_first_pass),`${s.first_pass_rate===null?'—':(s.first_pass_rate*100).toFixed(1)+'%'} / ${number(s.approved_previews)} preview đã duyệt`],['Avg revisions',videoDecimal(s.avg_revisions),'Số lần chỉnh sửa / build'],['Avg overall',videoDecimal(s.avg_overall),'Score được nhập · 0–10'],['Avg wow',videoDecimal(s.avg_wow),'Score được nhập · 0–10'],['Avg cost → approved',money(s.avg_cost_to_approved),`${s.cost_samples}/${s.approved_previews} preview đủ dữ liệu giá`],['Avg time → approved',seconds(s.avg_time_to_approved_ms),`${s.time_samples}/${s.approved_previews} preview đủ thời gian turn`]];
    $('video-cards').innerHTML=cards.map(([label,value,note])=>`<article class="metric"><div class="metric-label">${label}</div><div class="metric-value">${value}</div><p>${escape(note)}</p></article>`).join('');
    $('video-rows').innerHTML=data.builds.map(b=>`<tr><td><button class="quiet" data-video-open="${escape(b.id)}">${escape(b.title)}</button><small class="native-stat-note">${escape(b.id)} · ${escape(b.type)}</small></td><td>${escape(b.engine)}</td><td class="video-pipeline">${b.stages.map(s=>`${escape(s.stage)} · ${escape(s.usage.models.join('+')||s.model||'—')}`).join('<br>')||'—'}</td><td class="number">${videoDecimal(b.duration)} s<small class="native-stat-note">${escape(b.aspect_ratio)}</small></td><td class="number">${number(b.revisions)}</td><td class="number">${videoDecimal(b.quality.overall)}</td><td class="number">${videoDecimal(b.quality.wow)}</td><td class="number">${number(b.usage.tokens)}</td><td class="number">${money(b.usage.cost_usd)}</td><td class="number">${seconds(b.usage.elapsed_ms)}</td><td><span class="badge ${b.status==='planned'?'pending':'success'}">${escape(videoStatus[b.status])}</span></td></tr>`).join('')||'<tr><td colspan="11" class="empty-table">Chưa có video build. Tạo build hoặc import manifest JSON để bắt đầu.</td></tr>';
    $('video-list-note').textContent=`${s.builds} build · mở tiêu đề để xem timeline, sửa metadata và export manifest. Giá API tham khảo; — nghĩa là dữ liệu chưa đầy đủ.`;
    renderVideoComparisons();$('video-error').hidden=true;
  }catch(error){$('video-error').hidden=false;$('video-error').textContent=error.message;if(error.auth)$('auth-form').hidden=false;}
  finally{if(generation===videoGeneration)$('video-refresh').disabled=false;}
}
function renderVideoComparisons() {
  if(!videoData)return;
  $('video-comparisons').innerHTML=videoData.comparisons[$('video-comparison').value].map(r=>`<tr><td class="video-pipeline">${escape(r.key)}</td><td class="number">${number(r.builds)}</td><td class="number">${videoDecimal(r.avg_overall)}</td><td class="number">${videoDecimal(r.avg_wow)}</td><td class="number">${videoDecimal(r.quality_per_dollar)}<small class="native-stat-note">${r.quality_cost_samples} mẫu</small></td><td class="number">${videoDecimal(r.quality_per_minute)}<small class="native-stat-note">${r.quality_time_samples} mẫu</small></td><td class="number">${r.first_pass_rate===null?'—':(r.first_pass_rate*100).toFixed(1)+'%'}<small class="native-stat-note">${r.approved_first_pass}/${r.approved_previews} preview đã duyệt</small></td></tr>`).join('')||'<tr><td colspan="7" class="empty-table">Chưa có dữ liệu so sánh.</td></tr>';
}
async function showVideoBuild(id) {
  videoOpenId=id;$('video-detail').hidden=false;$('video-detail').innerHTML='<p class="usage-note" role="status">Đang đọc video build…</p>';
  try {
    const {build:b,manifest}=await get(`/api/videos/${encodeURIComponent(id)}`);if(videoOpenId!==id)return;
    const stageCards=b.stages.map(s=>`<article class="video-stage-card"><div class="video-stage-title"><strong>${escape(s.stage)}</strong><span class="badge ${s.approved?'success':'pending'}">${s.approved?'Đã duyệt':'Chưa duyệt'}</span></div><p>${escape(s.usage.models.join('+')||s.model||'Chưa chọn model')}${s.model&&s.usage.models.length?`<small class="native-stat-note">Model trong manifest: ${escape(s.model)}</small>`:''}</p><p>${s.session_id?`<button class="quiet" data-native-session="${escape(s.session_id)}">Session: ${escape(s.session_id)}</button>`:'Chưa nối session'}</p><p class="subtitle">${number(s.usage.tokens)} token · ${money(s.usage.cost_usd)} · ${seconds(s.usage.elapsed_ms)}</p><p class="subtitle">${s.usage.session_found?'Đã tìm thấy session':'Chưa có session local'} · ${s.usage.records} usage record · ${s.usage.turns} turn${s.usage.missing_usage_turns?` · ${s.usage.missing_usage_turns} turn thiếu usage`:''}${s.usage.unpriced_records?` · ${s.usage.unpriced_records} record thiếu giá`:''}</p>${s.turn_ids?`<p class="native-stat-note">Turn IDs: ${escape(s.turn_ids.join(', '))}</p>`:''}${s.approved_at?`<p class="native-stat-note">Duyệt: ${escape(date(s.approved_at)+' '+time(s.approved_at))}</p>`:''}<p class="video-notes">${escape(s.notes||'Chưa có notes.')}</p></article>`).join('');
    $('video-detail').innerHTML=`<div class="panel-heading"><div><h2>${escape(b.title)}</h2><p>${escape(b.id)} · ${escape(b.engine)} · ${videoDecimal(b.duration)} s · ${escape(b.aspect_ratio)} · ${escape(videoStatus[b.status])}</p></div><div class="video-actions"><button class="quiet" id="video-detail-edit">Chỉnh sửa</button><button class="quiet" id="video-detail-export">Export manifest</button><button class="quiet" id="video-detail-close">Đóng</button></div></div><div class="video-detail-body"><h3>Timeline PLAN → BUILD → REVISE → FINISH</h3><div class="video-timeline">${stageCards||'<p class="subtitle">Chưa có stage. Thêm stage khi chỉnh sửa build.</p>'}</div><h3>Quality scores · 0–10</h3><dl class="video-quality-grid">${videoScores.map(k=>`<div><dt>${escape(k)}</dt><dd>${videoDecimal(b.quality[k])}</dd></div>`).join('')}</dl><div class="video-paths"><p>Preview: <code>${escape(b.preview_path||'—')}</code></p><p>Final: <code>${escape(b.final_path||'—')}</code></p><p class="subtitle">Chỉ lưu đường dẫn metadata; dashboard không đọc hoặc thực thi file trên máy.</p></div><p class="subtitle">Đến preview đã duyệt: ${money(b.approved_preview?.cost_usd)} · ${seconds(b.approved_preview?.elapsed_ms)}. Tổng build chỉ có giá/thời gian khi mọi stage đều đủ dữ liệu.</p><details><summary>Manifest version 1</summary><pre class="detail-json">${escape(JSON.stringify(manifest,null,2))}</pre></details></div>`;
    $('video-detail-edit').onclick=()=>openVideoEditor(manifest);
    $('video-detail-close').onclick=()=>{$('video-detail').hidden=true;videoOpenId=null;};
    $('video-detail-export').onclick=()=>{const url=URL.createObjectURL(new Blob([JSON.stringify(manifest,null,2)],{type:'application/json'}));const a=document.createElement('a');a.href=url;a.download=`${b.id}.video-build.json`;a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);};
    $('video-detail').scrollIntoView({block:'start',behavior:'auto'});
  }catch(error){$('video-detail').innerHTML=`<p class="notice" role="alert">${escape(error.message)}</p>`;}
}
const videoField=(label,key,value,type='text',attrs='')=>`<label>${escape(label)}<input name="${key}" type="${type}" value="${escape(value??'')}" ${attrs}></label>`;
function videoStageForm(s={stage:'BUILD',model:'',notes:'',session_id:null,approved:false}) {
  const item=document.createElement('div');item.className='video-stage-form';item.dataset.stageId=s.id||crypto.randomUUID();item.dataset.approvedAt=s.approved_at??'';
  item.innerHTML=`<label>Stage<select name="stage">${videoStages.map(t=>`<option ${t===s.stage?'selected':''}>${t}</option>`).join('')}</select></label>${videoField('Session ID','session_id',s.session_id,'text','list="video-session-options" maxlength="128"')}${videoField('Model','model',s.model,'text','maxlength="128"')}${videoField('Turn IDs · tùy chọn, ngăn cách bằng dấu phẩy','turn_ids',s.turn_ids?.join(', '))}<label class="toggle"><input name="approved" type="checkbox" ${s.approved?'checked':''}>Đã duyệt</label><button type="button" class="quiet video-stage-remove" aria-label="Bỏ stage khỏi manifest">Bỏ stage</button><label class="video-stage-notes">Notes<textarea name="notes" rows="2" maxlength="4000">${escape(s.notes)}</textarea></label>`;
  item.querySelector('.video-stage-remove').onclick=()=>{item.remove();updateVideoManifest();};$('video-stage-fields').append(item);
}
function readVideoForm() {
  const f=$('video-form').elements,build={id:f.id.value,title:f.title.value,type:f.type.value,engine:f.engine.value,duration:Number(f.duration.value),aspect_ratio:f.aspect_ratio.value,status:f.status.value,revisions:Number(f.revisions.value),preview_path:f.preview_path.value||null,final_path:f.final_path.value||null,quality:{}};
  for(const key of videoScores)build.quality[key]=f[`score_${key}`].value===''?null:Number(f[`score_${key}`].value);
  const stages=[...document.querySelectorAll('.video-stage-form')].map(e=>{const val=k=>e.querySelector(`[name="${k}"]`).value;return {id:e.dataset.stageId,stage:val('stage'),session_id:val('session_id')||null,model:val('model'),notes:val('notes'),approved:e.querySelector('[name="approved"]').checked,approved_at:e.dataset.approvedAt===''?null:Number(e.dataset.approvedAt),...(val('turn_ids').trim()?{turn_ids:val('turn_ids').split(/[\s,]+/).filter(Boolean)}:{})};});
  return {version:1,build,stages};
}
function updateVideoManifest(){if(!videoImportMode)$('video-manifest').value=JSON.stringify(readVideoForm(),null,2);}
async function openVideoEditor(manifest=null,importMode=false) {
  videoImportMode=importMode;videoEditing=manifest?.build.id??null;
  const b=manifest?.build??{id:`video-${Date.now()}`,title:'',type:'explainer',engine:'remotion',duration:30,aspect_ratio:'16:9',status:'planned',revisions:0,quality:{}};
  const select=(label,key,options)=>`<label>${label}<select name="${key}">${options.map(v=>`<option value="${v}" ${v===b[key]?'selected':''}>${key==='status'?videoStatus[v]:v}</option>`).join('')}</select></label>`;
  $('video-editor-title').textContent=importMode?'Import video-build manifest':manifest?'Chỉnh sửa build':'Build mới';
  $('video-form-fields').innerHTML=videoField('ID / slug','id',b.id,'text',`required maxlength="128" ${manifest?'readonly':''}`)+videoField('Tiêu đề','title',b.title,'text','required maxlength="240"')+videoField('Loại video','type',b.type,'text','required maxlength="80"')+select('Engine','engine',['remotion','manim','ffmpeg','hybrid'])+videoField('Thời lượng · giây','duration',b.duration,'number','required min="0" max="86400" step="0.1"')+videoField('Aspect ratio','aspect_ratio',b.aspect_ratio,'text','required placeholder="16:9"')+select('Trạng thái','status',['planned','preview','approved','final'])+videoField('Revisions','revisions',b.revisions,'number','required min="0" max="10000" step="1"')+videoField('Preview path','preview_path',b.preview_path)+videoField('Final path','final_path',b.final_path);
  $('video-score-fields').innerHTML=videoScores.map(k=>videoField(k,`score_${k}`,b.quality[k],'number','min="0" max="10" step="0.1"')).join('');
  $('video-stage-fields').innerHTML='';(manifest?.stages??[{stage:'PLAN',model:'gpt-6.1-sol',notes:'',approved:false},{stage:'BUILD',model:'gpt-6-luna',notes:'',approved:false}]).forEach(videoStageForm);
  $('video-form-fields').hidden=importMode;$('video-quality').hidden=importMode;$('video-stage-add').closest('fieldset').hidden=importMode;
  for(const field of $('video-form-fields').querySelectorAll('input'))field.required=!importMode&&['id','title','type','duration','aspect_ratio','revisions'].includes(field.name);
  $('video-manifest-area').open=importMode;$('video-manifest').required=importMode;$('video-manifest').readOnly=!importMode;
  $('video-form-error').hidden=true;updateVideoManifest();if(importMode)$('video-manifest').value=JSON.stringify({version:1,build:{...b,title:'Video thử nghiệm',preview_path:null,final_path:null},stages:[]},null,2);
  $('video-editor').showModal();
  try{const data=await get('/api/videos/sessions');let list=$('video-session-options');if(!list){list=document.createElement('datalist');list.id='video-session-options';$('video-form').append(list);}list.innerHTML=data.sessions.map(s=>`<option value="${escape(s.id)}">${escape(s.cwd)} · ${escape(s.model)}</option>`).join('');}catch{}
}
$('video-form').addEventListener('input',updateVideoManifest);$('video-form').addEventListener('change',updateVideoManifest);
$('video-form').addEventListener('submit',async e=>{
  e.preventDefault();$('video-save').disabled=true;$('video-form-error').hidden=true;
  try{const manifest=videoImportMode?JSON.parse($('video-manifest').value):readVideoForm();const path=videoEditing?`/api/videos/${encodeURIComponent(videoEditing)}`:videoImportMode?'/api/videos/import':'/api/videos';const b=await writeVideo(path,manifest,videoEditing?'PUT':'POST');$('video-editor').close();await loadVideos();await showVideoBuild(b.id);}
  catch(error){$('video-form-error').hidden=false;$('video-form-error').textContent=error.message;}
  finally{$('video-save').disabled=false;}
});
$('video-stage-add').onclick=()=>{videoStageForm();updateVideoManifest();};
$('video-new').onclick=()=>openVideoEditor();$('video-import').onclick=()=>openVideoEditor(null,true);
for(const id of ['video-editor-close','video-cancel'])$(id).onclick=()=>$('video-editor').close();
$('video-refresh').onclick=async()=>{await loadVideos();if(videoOpenId)await showVideoBuild(videoOpenId);};
$('video-comparison').onchange=renderVideoComparisons;
$('view-videos').addEventListener('click',e=>{const b=e.target.closest('[data-video-open]');if(b)showVideoBuild(b.dataset.videoOpen);const s=e.target.closest('[data-native-session]');if(s)nativeDetail(s.dataset.nativeSession);});
setInterval(()=>{if(!$('view-videos').hidden&&!document.hidden&&$('auto-refresh').checked&&!$('video-editor').open)loadVideos();},5000);
load();
