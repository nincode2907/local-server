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

function badge(status) { return `<span class="badge ${escape(status)}">${escape(statusNames[status] ?? status)}</span>`; }
function setOnline(online, text) {
  $('connection-dot').className = `dot ${online ? 'online' : 'offline'}`;
  $('connection-label').textContent = text;
}
async function get(path, signal) {
  const response = await fetch(path, { signal, headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : {}, cache: 'no-store' });
  if (response.status === 401) { const error = new Error('Nhập token để xem dữ liệu.'); error.auth = true; throw error; }
  const data = await response.json();
  if (!response.ok) throw new Error(data.error?.message ?? `HTTP ${response.status}`);
  return data;
}
function chart(timeline, range) {
  const width = Math.max(280, $('activity-chart').clientWidth - 32), height = 230, left = 36, right = 15, top = 15, bottom = 37;
  const plotH = height - top - bottom, plotW = width - left - right;
  const max = Math.max(4, ...timeline.map(b => b.calls));
  const ceiling = Math.ceil(max / 4) * 4;
  const step = plotW / timeline.length;
  let svg = `<svg viewBox="0 0 ${width} ${height}" role="img" aria-label="Biểu đồ call theo thời gian. Tổng ${number(timeline.reduce((sum, b) => sum + b.calls, 0))} call.">`;
  for (let i = 0; i <= 4; i++) {
    const y = top + plotH * i / 4;
    svg += `<line x1="${left}" x2="${width - right}" y1="${y}" y2="${y}" stroke="#e7edf5" stroke-dasharray="3 4"/><text x="${left - 10}" y="${y + 4}" text-anchor="end" fill="#627087" font-size="10">${number(ceiling * (4 - i) / 4)}</text>`;
  }
  const colors = { success: '#2854d7', errors: '#a33345', rejected: '#9b5d14', active: '#13786f' };
  timeline.forEach((b, index) => {
    let offset = 0;
    const x = left + index * step + step * .19;
    for (const [key, color] of Object.entries(colors)) {
      const h = b[key] / ceiling * plotH;
      if (h) svg += `<rect x="${x}" y="${top + plotH - offset - h}" width="${step * .62}" height="${h}" fill="${color}" rx="1"><title>${escape(date(b.time) + ' ' + time(b.time))}: ${number(b.calls)} call · ${number(b.tokens)} token</title></rect>`;
      offset += h;
    }
    if (index === 0 || index === timeline.length - 1 || index % Math.ceil(timeline.length / 6) === 0) {
      const label = range === '7d' || range === '30d' ? date(b.time).slice(0, 5) : time(b.time).slice(0, 5);
      svg += `<text x="${x + step * .31}" y="${height - 12}" text-anchor="middle" fill="#627087" font-size="10">${escape(label)}</text>`;
    }
  });
  $('activity-chart').innerHTML = svg + '</svg>';
  $('chart-empty').hidden = timeline.some(b => b.calls > 0);
}
function renderOverview(data) {
  lastOverview = data;
  const s = data.summary;
  $('total').textContent = number(s.total_calls);
  $('call-breakdown').textContent = `${number(s.codex_calls)} lượt gọi Codex · ${number(s.rejected_calls)} từ chối`;
  const totalTokens = s.input_tokens + s.output_tokens;
  $('tokens').textContent = number(totalTokens);
  $('token-breakdown').textContent = `${number(s.input_tokens)} input / ${number(s.output_tokens)} output`;
  $('latency').textContent = seconds(s.avg_duration_ms);
  $('p95').textContent = `p95 ${seconds(s.p95_duration_ms)} · lượt đã gọi Codex`;
  const completed = s.total_calls - s.active_calls;
  $('success-rate').textContent = completed ? `${new Intl.NumberFormat('vi-VN', { maximumFractionDigits: 1 }).format(s.successful_calls / completed * 100)}%` : '—';
  $('success-breakdown').textContent = `${number(s.successful_calls)} thành công · ${number(s.failed_calls)} lỗi / hủy`;
  $('active').textContent = `${number(s.active_calls)} đang xử lý`;
  $('token-total').textContent = number(totalTokens);
  $('input-tokens').textContent = number(s.input_tokens);
  $('output-tokens').textContent = number(s.output_tokens);
  $('cached-tokens').textContent = number(s.cached_tokens);
  $('reasoning-tokens').textContent = number(s.reasoning_tokens);
  $('tool-calls').textContent = number(s.tool_calls);
  $('token-bar').replaceChildren();
  for (const [amount, color] of [[s.input_tokens, '#2854d7'], [s.output_tokens, '#13786f']]) {
    const segment = document.createElement('span'); segment.style.width = `${totalTokens ? amount / totalTokens * 100 : 0}%`; segment.style.backgroundColor = color; $('token-bar').append(segment);
  }
  $('usage-note').textContent = s.usage_unknown_calls ? `${number(s.usage_unknown_calls)} lượt gọi Codex chưa có usage. Token hiển thị chỉ gồm số đã ghi nhận.` : `Đã ghi nhận usage của ${number(s.usage_known_calls)} lượt. Cache nằm trong input; reasoning nằm trong output.`;
  $('default-model').textContent = data.server.default_model;
  $('server-meta').textContent = `${data.server.default_reasoning} reasoning · uptime ${number(Math.floor(data.server.uptime_seconds / 60))} phút`;
  $('model-rows').innerHTML = data.models.map(m => `<tr><td><span class="model-name">${escape(m.model)}</span><div class="model-meter"><span data-width="${s.total_calls ? m.calls / s.total_calls * 100 : 0}"></span></div></td><td class="number">${number(m.calls)}</td><td class="number">${number(m.input_tokens)}</td><td class="number">${number(m.output_tokens)}</td><td class="number">${seconds(m.avg_duration_ms)}</td><td class="number">${money(m.cost_usd)}</td></tr>`).join('');
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
  $('call-rows').innerHTML = rows.map(r => `<tr><td class="timestamp">${escape(time(r.started_at))}<small>${escape(date(r.started_at))}</small></td><td><span class="model-name">${escape(r.model)}</span><div class="endpoint">${escape(r.endpoint)} · ${escape(r.reasoning)}</div></td><td>${badge(r.status)}</td><td class="number">${r.input_tokens === null ? '—' : number(r.input_tokens + r.output_tokens)}</td><td class="number">${seconds(r.duration_ms)}</td><td class="number">${money(r.cost_usd)}</td><td><button type="button" class="quiet details-button" data-call="${escape(r.id)}" aria-label="Chi tiết call ${escape(r.id)}">Chi tiết ↗</button></td></tr>`).join('');
  $('calls-empty').hidden = data.total !== 0;
  $('history-description').textContent = `${number(data.total)} call trong khoảng thời gian đã chọn. Chỉ hiển thị số liệu xử lý.`;
  $('page-info').textContent = data.total ? `${number((page - 1) * data.page_size + 1)}–${number(Math.min(page * data.page_size, data.total))} / ${number(data.total)} call` : '0 call';
  $('page-number').textContent = `Trang ${page}`;
  $('previous').disabled = page <= 1;
  $('next').disabled = page * data.page_size >= data.total;
}
function showDetail(id, record) {
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
}
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
  ['stats','chat','catalog'].forEach(id => { $(`view-${id}`).hidden = id !== name; });
  document.querySelectorAll('[data-view]').forEach(b => { b.classList.toggle('selected', b.dataset.view === name); b.setAttribute('aria-pressed', String(b.dataset.view === name)); });
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
  $('chat-messages').innerHTML = c.entries.map((e,i) => `<article class="chat-message ${e.role}"><small>${e.role === 'user' ? 'Bạn' : 'Codex'}</small><div class="message-text">${escape(e.text)}</div>${e.details ? `<button class="quiet" data-entry="${i}">Chi tiết lượt này ↗</button>` : ''}</article>`).join('') + (c.pending ? '<div class="thinking" role="status">Codex đang suy nghĩ…</div>' : '') + (!c.entries.length && !c.pending ? '<div class="chat-empty"><h3>Bắt đầu một lượt test</h3><p>Chọn model, mức reasoning và gửi tin nhắn.<br>Mỗi request gửi context hiện có trong tab này.</p></div>' : '');
  $('chat-messages').scrollTop = $('chat-messages').scrollHeight;
}
async function copy(value, button) {
  try { await navigator.clipboard.writeText(value); const old = button.textContent; button.textContent = 'Đã copy'; setTimeout(() => { button.textContent = old; },1500); }
  catch { $('error').textContent = `Không copy được. Model ID: ${value}`; $('error').hidden = false; }
}
$('chat-form').addEventListener('submit', async event => {
  event.preventDefault(); saveChat(); const c = currentChat(); if (!c || c.pending || !c.draft.trim()) return;
  const message = { role: 'user', content: c.draft.trim() };
  const submitted = { model: c.model, reasoning_effort: c.reasoning, messages: [...(c.context.trim() ? [{ role: 'system',content: c.context.trim() }] : []), ...c.messages,message] };
  c.entries.push({ role: 'user',text: message.content }); c.draft = ''; c.pending = true;
  c.controller = new AbortController(); const start = performance.now(); renderChat();
  let callId, result, status, metric, failure;
  try {
    const response = await fetch('/api/playground/chat', { method: 'POST', signal: c.controller.signal, headers: { 'Content-Type': 'application/json','X-Codex-Playground': '1',...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}) }, body: JSON.stringify(submitted) });
    callId = response.headers.get('X-Codex-Call-Id'); status = response.status; result = await response.json();
    if (!response.ok) { if (response.status === 401) $('auth-form').hidden = false; throw new Error(result.error?.message ?? `HTTP ${status}`); }
    c.messages.push(message,result.choices[0].message);
  } catch (error) { failure = error.name === 'AbortError' ? 'Đã dừng lượt chat.' : error.message; }
  const elapsed = performance.now() - start;
  if (callId) { try { metric = await get(`/api/stats/calls/${callId}`); } catch {} }
  c.entries.push({ role: 'assistant', text: failure ?? result.choices[0].message.content ?? '', details: { request: submitted, response: result ?? null, metrics: metric ?? null, call_id: callId ?? null, http_status: status ?? null, client_duration_ms: elapsed, error: failure ?? null } });
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
$('chat-messages').addEventListener('click', event => { const b = event.target.closest('[data-entry]'); if (!b) return; const details = currentChat().entries[Number(b.dataset.entry)].details; if (details.metrics) showDetail(details.call_id, details.metrics); else { $('detail-content').innerHTML = '<p class="usage-note">' + escape(details.error ?? 'Chưa có metadata từ server.') + '</p>'; $('call-detail').showModal(); } const raw = document.createElement('details'); raw.className = 'system-context'; const summary = document.createElement('summary'); summary.textContent = 'Request / response đầy đủ · chỉ trong bộ nhớ trang'; const pre = document.createElement('pre'); pre.className = 'detail-json'; pre.textContent = JSON.stringify(details,null,2); raw.append(summary,pre); $('detail-content').append(raw); });
$('copy-model').addEventListener('click', event => copy($('chat-model').value,event.currentTarget));
$('catalog-rows').addEventListener('click', event => { const b = event.target.closest('button'); if (b?.dataset.copy) copy(b.dataset.copy,b); if (b?.dataset.try) { saveChat(); newChat(b.dataset.try); view('chat'); } });
$('model-search').addEventListener('input',renderCatalog);
$('cost-group').addEventListener('change', () => loadCosts().catch(error => { $('error').textContent = error.message; $('error').hidden = false; }));
document.querySelectorAll('[data-view]').forEach(b => b.addEventListener('click', () => view(b.dataset.view)));
load();
