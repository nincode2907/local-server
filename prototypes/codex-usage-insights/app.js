const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
const TZ = 'Asia/Ho_Chi_Minh';
const colors = { cached: '#9aa9c5', uncached: '#2854d7', output: '#13786f', purple: '#8375d7', amber: '#c68c3f', teal: '#13786f', blue: '#2854d7' };
const projects = [
  { id: 'codex-server', name: 'codex-server', weight: 22 },
  { id: 'memoryos', name: 'memoryOS', weight: 20 },
  { id: 'agent-corporation', name: 'agent-corporation', weight: 17 },
  { id: 'jlpt-study', name: 'jlpt-study', weight: 12 },
  { id: 'ui-lens', name: 'ui-lens', weight: 10 },
  { id: 'news', name: 'news', weight: 9 },
  { id: 'cross-neo', name: 'cross-neo', weight: 6 },
  { id: 'personal', name: 'personal', weight: 4 },
];
const models = [
  { id: 'gpt-5-codex', name: 'gpt-5-codex', weight: 57, inputRate: 1.25, cachedRate: .125, outputRate: 10 },
  { id: 'gpt-5-mini', name: 'gpt-5-mini', weight: 27, inputRate: .25, cachedRate: .025, outputRate: 2 },
  { id: 'o4-mini', name: 'o4-mini', weight: 16, inputRate: 1.1, cachedRate: .275, outputRate: 4.4 },
];
const sources = [{ id: 'codex', name: 'Codex CLI' }, { id: 'ollama', name: 'Ollama' }];
const state = { range: 'today', metric: 'tokens', distribution: 'project', project: '', model: '', source: '', hideCache: false, selected: null };

const formatter = new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' });
const timeParts = new Intl.DateTimeFormat('en-GB', { timeZone: TZ, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
const dateParts = new Intl.DateTimeFormat('vi-VN', { timeZone: TZ, day: '2-digit', month: '2-digit' });
const now = new Date();
const todayKey = formatter.format(now);
const currentHour = Number(new Intl.DateTimeFormat('en-GB', { timeZone: TZ, hour: '2-digit', hourCycle: 'h23' }).format(now));
const dateFromKey = key => new Date(`${key}T00:00:00+07:00`);
const keyFromDate = date => formatter.format(date);
const offsetKey = days => { const date = dateFromKey(todayKey); date.setUTCDate(date.getUTCDate() + days); return keyFromDate(date); };
const eventDate = (key, hour, minute) => new Date(Date.parse(`${key}T00:00:00+07:00`) + hour * 3600000 + minute * 60000);
const numberFmt = new Intl.NumberFormat('vi-VN', { maximumFractionDigits: 0 });
const moneyFmt = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: 3, maximumFractionDigits: 3 });
const escapeHtml = value => String(value ?? '').replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]);
const compact = value => {
  if (!Number.isFinite(value)) return '—';
  const abs = Math.abs(value);
  if (abs >= 1000000) return `${(value / 1000000).toLocaleString('vi-VN', { maximumFractionDigits: 1 })}M`;
  if (abs >= 10000) return `${(value / 1000).toLocaleString('vi-VN', { maximumFractionDigits: 1 })}k`;
  return numberFmt.format(Math.round(value));
};
const formatMetric = (value, metric = state.metric) => metric === 'cost' ? (Number.isFinite(value) ? moneyFmt.format(value) : '—') : compact(value);
const metricName = metric => ({ tokens: 'tokens', cost: 'USD ước tính', turns: 'turns' })[metric];
const metricUnit = metric => ({ tokens: 'tokens', cost: 'USD', turns: 'turns' })[metric];
const dateLabel = key => dateParts.format(dateFromKey(key));
const hourLabel = hour => `${String(hour).padStart(2, '0')}:00`;
const timeLabel = date => timeParts.format(date);

function rng(seed) {
  let value = seed >>> 0;
  return () => { value = (value * 1664525 + 1013904223) >>> 0; return value / 4294967296; };
}
function choose(items, random) {
  const total = items.reduce((sum, item) => sum + item.weight, 0);
  let mark = random() * total;
  return items.find(item => (mark -= item.weight) < 0) || items[items.length - 1];
}
function hash(text) { let h = 2166136261; for (const char of text) { h ^= char.charCodeAt(0); h = Math.imul(h, 16777619); } return h >>> 0; }

function createEvents() {
  const result = [];
  for (let dayOffset = -29; dayOffset <= 0; dayOffset++) {
    const key = offsetKey(dayOffset);
    const random = rng(hash(key));
    const unknownOnlyDay = dayOffset === -20;
    const lastHour = dayOffset === 0 ? currentHour : 23;
    for (let hour = 0; hour <= lastHour; hour++) {
      const daytime = hour >= 7 && hour <= 21;
      const spikeWindow = dayOffset === -2 && (hour === 10 || hour === 11);
      const createCount = unknownOnlyDay ? (hour === 10 ? 1 : 0) : spikeWindow ? 3 : random() < (daytime ? .72 : .12) ? (random() < .18 ? 2 : 1) : 0;
      for (let i = 0; i < createCount; i++) {
        const project = choose(projects, random);
        const model = choose(models, random);
        const hasUsage = !unknownOnlyDay && random() > .065;
        const input = hasUsage ? Math.round((5200 + random() * 38000) * (spikeWindow ? 2.5 : 1)) : null;
        const cachedInput = hasUsage ? Math.round(input * (.58 + random() * .34)) : null;
        const output = hasUsage ? Math.round((420 + random() * 7200) * (spikeWindow ? 1.8 : 1)) : null;
        const source = random() < .16 ? 'ollama' : 'codex';
        const minute = Math.floor(random() * 60);
        const at = eventDate(key, hour, minute);
        const cost = hasUsage ? ((input - cachedInput) * model.inputRate + cachedInput * model.cachedRate + output * model.outputRate) / 1000000 : null;
        const id = `${key.replaceAll('-', '')}-${String(hour).padStart(2, '0')}-${i}-${project.id}-${Math.floor(random() * 90 + 10)}`;
        result.push({ id, at, key, hour, project: project.id, model: model.id, source, input, cachedInput, output, turns: 1, cost, session: `${key.replaceAll('-', '')}-${project.id}-${Math.floor(hour / 4)}-${i % 2}` });
      }
    }
  }
  return result.sort((a, b) => b.at - a.at);
}
const events = createEvents();

function inRange(event, range) {
  if (range === 'today') return event.key === todayKey && event.hour <= currentHour;
  if (range === 'yesterday') return event.key === offsetKey(-1);
  const days = range === '7d' ? 7 : 30;
  return event.key >= offsetKey(-(days - 1)) && event.key <= todayKey;
}
function filteredEvents(range = state.range) {
  return events.filter(event => inRange(event, range) && (!state.project || event.project === state.project) && (!state.model || event.model === state.model) && (!state.source || event.source === state.source));
}
function aggregate(list) {
  const known = list.filter(event => event.input !== null && event.output !== null);
  const input = known.reduce((sum, event) => sum + event.input, 0);
  const cached = known.reduce((sum, event) => sum + event.cachedInput, 0);
  const output = known.reduce((sum, event) => sum + event.output, 0);
  const costEvents = list.filter(event => event.cost !== null);
  return {
    input, cached, uncached: input - cached, output, tokens: input + output,
    turns: list.length, cost: costEvents.reduce((sum, event) => sum + event.cost, 0),
    unknown: list.length - known.length, knownTurns: known.length, costKnown: costEvents.length,
  };
}
function metricValue(list, metric = state.metric) {
  const totals = aggregate(list);
  return metric === 'cost' ? (totals.costKnown ? totals.cost : null) : metric === 'turns' ? totals.turns : (totals.knownTurns ? totals.tokens : null);
}
function currentBuckets(range) {
  if (range === 'today' || range === 'yesterday') {
    const key = range === 'today' ? todayKey : offsetKey(-1);
    const maxHour = range === 'today' ? currentHour : 23;
    return Array.from({ length: maxHour + 1 }, (_, hour) => ({ id: `${key}-${hour}`, key, hour, label: hourLabel(hour), short: hour % 6 === 0 || hour === maxHour ? String(hour).padStart(2, '0') : '' }));
  }
  const count = range === '7d' ? 7 : 30;
  return Array.from({ length: count }, (_, index) => {
    const key = offsetKey(index - (count - 1));
    return { id: key, key, hour: null, label: dateLabel(key), short: range === '7d' || index % 5 === 0 || index === count - 1 ? dateLabel(key) : '' };
  });
}
function bucketEvents(bucket, list) { return list.filter(event => event.key === bucket.key && (bucket.hour === null || event.hour === bucket.hour)); }
function seriesFor(list) {
  const totals = aggregate(list);
  if (state.metric !== 'tokens') return [{ key: state.metric, value: state.metric === 'cost' ? (totals.costKnown ? totals.cost : null) : totals.turns, color: state.metric === 'cost' ? colors.purple : colors.blue }];
  if (totals.turns > 0 && totals.knownTurns === 0) return [
    { key: 'cached', value: null, color: colors.cached },
    { key: 'uncached', value: null, color: colors.uncached },
    { key: 'output', value: null, color: colors.output },
  ];
  return [
    { key: 'cached', value: state.hideCache ? 0 : totals.cached, color: colors.cached },
    { key: 'uncached', value: totals.uncached, color: colors.uncached },
    { key: 'output', value: totals.output, color: colors.output },
  ];
}
function amountFor(list, metric = state.metric) { return metricValue(list, metric); }
function availableTotals(list) { return aggregate(list); }

function fillFilters() {
  const projectSelect = $('#project-filter');
  const modelSelect = $('#model-filter');
  const sourceSelect = $('#source-filter');
  projectSelect.innerHTML = '<option value="">Tất cả project</option>' + projects.map(item => `<option value="${item.id}">${item.name}</option>`).join('');
  modelSelect.innerHTML = '<option value="">Tất cả model</option>' + models.map(item => `<option value="${item.id}">${item.name}</option>`).join('');
  sourceSelect.innerHTML = '<option value="">Tất cả nguồn</option>' + sources.map(item => `<option value="${item.id}">${item.name}</option>`).join('');
}

function renderKpis(list) {
  const totals = aggregate(list);
  const value = metricValue(list);
  const denominator = state.metric === 'cost' ? totals.costKnown : state.metric === 'turns' ? totals.turns : totals.knownTurns;
  const average = denominator ? (state.metric === 'turns' ? 1 : (value || 0) / denominator) : null;
  const buckets = currentBuckets(state.range).map(bucket => ({ bucket, value: amountFor(bucketEvents(bucket, list)) })).filter(item => item.value !== null);
  const peak = buckets.reduce((best, item) => item.value > (best?.value ?? -1) ? item : best, null);
  let baselineNote = `${numberFmt.format(list.length)} turns trong khoảng này`;
  if (state.range === 'today') {
    const previous = metricValue(filteredEvents('yesterday'));
    baselineNote = previous === null
      ? 'Đối chiếu toàn bộ hôm qua: chưa có usage'
      : `Hôm qua trọn ngày: ${formatMetric(previous)} ${metricUnit(state.metric)}`;
  }
  const missing = totals.unknown ? `${numberFmt.format(totals.unknown)} turns thiếu usage · chưa tính vào số đã biết` : 'Đã có usage cho mọi turn trong mẫu';
  const knownLabel = state.metric === 'tokens' ? 'Tokens đã ghi nhận' : state.metric === 'cost' ? 'Chi phí ước tính · turns có giá' : 'Turns quan sát được';
  const coverageNote = state.metric === 'tokens'
    ? `${numberFmt.format(totals.knownTurns)}/${numberFmt.format(totals.turns)} turns có usage${totals.unknown ? ` · ${numberFmt.format(totals.unknown)} chưa biết` : ''}`
    : state.metric === 'cost'
      ? `${numberFmt.format(totals.costKnown)}/${numberFmt.format(totals.turns)} turns có giá${totals.unknown ? ` · ${numberFmt.format(totals.unknown)} thiếu usage` : ''}`
      : baselineNote;
  const cards = [
    { label: knownLabel, icon: 'Σ', value: value === null ? '—' : formatMetric(value), note: state.metric === 'turns' ? baselineNote : coverageNote },
    { label: `Trung bình / ${state.metric === 'turns' ? 'bucket' : 'turn'}`, icon: 'Ø', value: average === null ? '—' : formatMetric(average), note: denominator ? `${numberFmt.format(denominator)} lượt có dữ liệu phù hợp` : 'Chưa có dữ liệu phù hợp' },
    { label: 'Khoảng cao nhất', icon: '↗', value: peak?.value ? formatMetric(peak.value) : '—', note: peak?.value ? `${peak.bucket.label} · ${metricUnit(state.metric)}` : 'Chưa có usage trong khoảng' },
    { label: 'Usage chưa biết', icon: '?', value: numberFmt.format(totals.unknown), note: missing },
  ];
  $('#kpis').innerHTML = cards.map(card => `<article class="kpi"><div class="kpi-label"><span>${escapeHtml(card.label)}</span><span aria-hidden="true">${card.icon}</span></div><div class="kpi-value">${escapeHtml(card.value)}</div><p class="kpi-note">${escapeHtml(card.note)}</p></article>`).join('');
}

function renderLegend(series) {
  const labels = { cached: 'Cached Input', uncached: 'Uncached Input', output: 'Output', total: 'Tổng tokens', cost: 'Chi phí', turns: 'Turns' };
  $('#primary-legend').innerHTML = series.map(item => `<span><i class="swatch" style="--swatch:${item.color}"></i>${labels[item.key]}</span>`).join('');
}
function renderPrimary(list) {
  const rangeLabels = { today: 'từ 00:00 đến giờ hiện tại', yesterday: 'đủ 24 giờ', '7d': '7 ngày lịch gần nhất · gồm hôm nay', '30d': '30 ngày lịch gần nhất · gồm hôm nay' };
  $('#primary-subtitle').textContent = rangeLabels[state.range];
  $('#chart-unit').textContent = metricUnit(state.metric);
  $('#primary-title').textContent = state.range === 'today' || state.range === 'yesterday' ? 'Usage theo giờ' : state.range === '7d' ? 'Usage theo ngày' : 'Xu hướng 30 ngày';
  const buckets = currentBuckets(state.range);
  const groups = buckets.map(bucket => ({ bucket, events: bucketEvents(bucket, list) }));
  if (!groups.some(group => group.events.length)) {
    $('#primary-chart').innerHTML = '<div class="empty-state">Không có usage cho bộ lọc này.</div>';
    $('#primary-legend').innerHTML = '';
    $('#primary-note').textContent = 'Thử chọn project, model hoặc nguồn khác.';
    return;
  }
  const chartSeries = seriesFor(list);
  const width = 760, height = 260, left = 45, right = 12, top = 12, bottom = 223;
  const plotW = width - left - right, plotH = bottom - top;
  const seriesByBucket = groups.map(group => seriesFor(group.events));
  const totals = seriesByBucket.map((items, index) => {
    if (items.every(item => item.value === null)) return null;
    if (state.metric === 'tokens') {
      const bucketTotals = aggregate(groups[index].events);
      return bucketTotals.knownTurns ? bucketTotals.tokens : null;
    }
    return items.reduce((sum, item) => sum + (item.value ?? 0), 0);
  });
  const max = Math.max(...totals.filter(value => value !== null), 1) * 1.1;
  const y = value => bottom - (value / max) * plotH;
  const tickLines = [0, .25, .5, .75, 1].map(ratio => {
    const yPos = bottom - plotH * ratio;
    const tick = state.metric === 'cost' ? moneyFmt.format(max * ratio) : compact(max * ratio);
    return `<line class="chart-gridline" x1="${left}" y1="${yPos}" x2="${width - right}" y2="${yPos}"/><text class="chart-axis" x="${left - 7}" y="${yPos + 3}" text-anchor="end">${escapeHtml(tick)}</text>`;
  }).join('');
  const barGap = groups.length > 20 ? 4 : groups.length > 10 ? 7 : 11;
  const barWidth = Math.max(5, Math.min(34, (plotW - barGap * groups.length) / groups.length));
  const step = plotW / groups.length;
  let marks = '';
  if (state.range === '30d') {
    const drawComponents = state.metric === 'tokens' && !totals.some(value => value === null);
    const components = chartSeries.filter(series => !(state.hideCache && series.key === 'cached') && seriesByBucket.some(bucketSeries => (bucketSeries.find(item => item.key === series.key)?.value ?? 0) > 0));
    const visibleLegend = drawComponents
      ? [...components, ...(totals.some(value => value !== null) ? [{ key: 'total', value: null, color: colors.blue }] : [])]
      : totals.some(value => value !== null) ? [{ key: state.metric === 'tokens' ? 'total' : state.metric, value: null, color: colors.blue }] : [];
    renderLegend(visibleLegend);
    const xAt = index => left + step * index + step / 2;
    const cumulative = groups.map(() => 0);
    const areaLayers = !drawComponents ? '' : chartSeries.filter(series => !(state.hideCache && series.key === 'cached')).map(series => {
      const topPoints = groups.map((_, index) => {
        const value = seriesByBucket[index].find(item => item.key === series.key)?.value || 0;
        cumulative[index] += value;
        return { x: xAt(index), y: y(cumulative[index]) };
      });
      const bottomPoints = groups.map((_, index) => {
        const value = cumulative[index] - (seriesByBucket[index].find(item => item.key === series.key)?.value || 0);
        return { x: xAt(index), y: y(value) };
      });
      const d = `M${topPoints.map(point => `${point.x},${point.y}`).join(' L')} L${bottomPoints.reverse().map(point => `${point.x},${point.y}`).join(' L')} Z`;
      return `<path d="${d}" fill="${series.color}" fill-opacity=".24" stroke="none"/>`;
    }).join('');
    const totalPoints = totals.map((value, index) => ({ x: xAt(index), y: y(value ?? 0), known: value !== null }));
    let line = '';
    let lineOpen = false;
    totalPoints.forEach(point => {
      if (!point.known) { lineOpen = false; return; }
      line += `${lineOpen ? ' L' : ' M'}${point.x},${point.y}`;
      lineOpen = true;
    });
    const points = totalPoints.map((point, index) => {
      const group = groups[index];
      if (!point.known) {
        const tip = `${group.bucket.label} · ${group.events.length} turns có chi phí chưa biết; không tính thành 0.`;
        return `<circle class="chart-point chart-bar" cx="${point.x}" cy="${bottom - 2}" r="4" fill="var(--surface)" stroke="${colors.amber}" stroke-width="1.5" stroke-dasharray="2 1" tabindex="0" role="button" aria-label="${escapeHtml(tip)}" data-tip="${escapeHtml(tip)}"/>`;
      }
      const tip = `${group.bucket.label} · ${formatMetric(totals[index])} ${metricUnit(state.metric)} · ${group.events.length} turns`;
      return `<circle class="chart-point chart-bar" cx="${point.x}" cy="${point.y}" r="3.2" fill="${colors.blue}" tabindex="0" role="button" aria-label="${escapeHtml(tip)}" data-tip="${escapeHtml(tip)}"/>`;
    }).join('');
    marks = `${areaLayers}<path d="${line}" fill="none" stroke="${colors.blue}" stroke-width="2.4" stroke-linejoin="round"/>${points}`;
  } else {
    renderLegend(chartSeries.filter(series => !(state.hideCache && series.key === 'cached') && seriesByBucket.some(bucketSeries => (bucketSeries.find(item => item.key === series.key)?.value ?? 0) > 0)));
    marks = groups.map((group, index) => {
      const x = left + step * index + (step - barWidth) / 2;
      let base = bottom;
      const segments = seriesByBucket[index].map(series => {
        if (series.value === null) return '';
        const h = Math.max(0, (series.value / max) * plotH);
        const yPos = base - h;
        base = yPos;
        if (!h) return '';
        const totals = aggregate(group.events);
        const dataValue = state.metric === 'tokens' ? `${numberFmt.format(series.value)} ${series.key === 'cached' ? 'cached input' : series.key === 'uncached' ? 'uncached input' : 'output'}` : `${formatMetric(series.value)} ${metricUnit(state.metric)}`;
        const tip = `${group.bucket.label} · ${dataValue} · ${group.events.length} turns${totals.unknown ? ` · ${totals.unknown} thiếu usage` : ''}`;
        return `<rect class="chart-bar" x="${x}" y="${yPos}" width="${barWidth}" height="${h}" rx="2" fill="${series.color}" tabindex="0" role="button" aria-label="${escapeHtml(tip)}" data-tip="${escapeHtml(tip)}"/>`;
      }).join('');
      if (totals[index] !== null || !group.events.length) return segments;
      const tip = `${group.bucket.label} · ${group.events.length} turns có ${state.metric === 'cost' ? 'chi phí' : 'usage'} chưa biết; không tính thành 0.`;
      const marker = `<circle class="chart-point chart-bar" cx="${x + barWidth / 2}" cy="${bottom - 2}" r="4" fill="var(--surface)" stroke="${colors.amber}" stroke-width="1.5" stroke-dasharray="2 1" tabindex="0" role="button" aria-label="${escapeHtml(tip)}" data-tip="${escapeHtml(tip)}"/>`;
      return segments + marker;
    }).join('');
    if (state.range === 'today') {
      const currentIndex = groups.findIndex(group => group.bucket.hour === currentHour);
      if (currentIndex >= 0) {
        const x = left + step * currentIndex;
        marks += `<rect x="${x}" y="${top}" width="${step}" height="${plotH + 1}" fill="var(--blue-soft)" fill-opacity=".36" stroke="${colors.blue}" stroke-width="1.5" rx="3" pointer-events="none"/>`;
      }
    }
  }
  const labelEvery = groups.length > 20 ? 5 : groups.length > 12 ? 3 : 1;
  const labels = groups.map((group, index) => {
    const show = group.bucket.short && (index % labelEvery === 0 || index === groups.length - 1);
    if (!show) return '';
    const x = left + step * index + step / 2;
    return `<text class="chart-axis" x="${x}" y="246" text-anchor="middle">${escapeHtml(group.bucket.short)}</text>`;
  }).join('');
  $('#primary-chart').innerHTML = `<svg viewBox="0 0 ${width} ${height}" role="img" aria-label="${escapeHtml($('#primary-title').textContent)}: ${escapeHtml(metricName(state.metric))}">${tickLines}${marks}${labels}</svg>`;
  $('#primary-note').textContent = state.range === 'today'
    ? `Giờ hiện tại ${hourLabel(currentHour)}–${timeLabel(now)} · đang ghi nhận, chưa trọn giờ. Các giờ sau chưa tới; không tính là 0.`
    : state.range === '30d' ? 'Mỗi điểm dựa trên usage event trong ngày; hôm nay vẫn đang tiếp diễn.' : 'Bucket được tính từ thời điểm usage event phát sinh, không dùng thời điểm tạo session.';
}

function renderComposition(list) {
  const totals = aggregate(list);
  if (!list.length || totals.knownTurns === 0) {
    $('#composition-chart').innerHTML = `<div class="empty-state">${list.length ? `${totals.unknown} turn(s) có usage chưa biết; chưa thể lập cơ cấu token.` : 'Không có usage trong khoảng này để lập cơ cấu token.'}</div>`;
    $('#hide-cache').disabled = state.metric !== 'tokens';
    return;
  }
  const tokenTotal = totals.tokens;
  const inputForDisplay = [totals.cached, totals.uncached, totals.output];
  const displayValues = state.hideCache ? [0, totals.uncached, totals.output] : inputForDisplay;
  const visibleTotal = displayValues.reduce((sum, value) => sum + value, 0);
  const rows = [
    { key: 'cached', label: 'Cached Input', value: totals.cached, color: colors.cached },
    { key: 'uncached', label: 'Uncached Input', value: totals.uncached, color: colors.uncached },
    { key: 'output', label: 'Output', value: totals.output, color: colors.output },
  ].filter(row => !(state.hideCache && row.key === 'cached'));
  const totalLabel = state.hideCache ? `${compact(visibleTotal)} visible` : `${compact(tokenTotal)} total tokens`;
  $('#composition-chart').innerHTML = `<div class="composition-total"><span>Cơ cấu trong khoảng đang chọn</span><strong>${escapeHtml(totalLabel)}</strong></div><div class="composition-bar" aria-label="Tỷ lệ thành phần token">${rows.map(row => `<span style="width:${visibleTotal ? row.value / visibleTotal * 100 : 0}%;background:${row.color}" title="${row.label}: ${numberFmt.format(row.value)}"></span>`).join('')}</div><div class="composition-list">${rows.map(row => `<div class="composition-row"><span class="composition-label"><i class="swatch" style="--swatch:${row.color}"></i>${row.label}</span><strong>${numberFmt.format(row.value)}</strong><small>${visibleTotal ? (row.value / visibleTotal * 100).toFixed(1) : '0.0'}%</small></div>`).join('')}</div>${totals.unknown ? `<p class="panel-note">${totals.unknown} turn(s) chưa có usage; không được tính bằng 0.</p>` : ''}`;
  $('#hide-cache').disabled = state.metric !== 'tokens';
}

function groupBy(list, keyName) {
  const map = new Map();
  for (const event of list) {
    const key = event[keyName];
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(event);
  }
  return [...map.entries()].map(([key, items]) => ({ key, items, totals: aggregate(items) }));
}
function selectedClass(type, id) { return state.selected?.type === type && state.selected?.id === id ? 'selected' : ''; }
function selectEntity(type, id) {
  state.selected = state.selected?.type === type && state.selected?.id === id ? null : { type, id };
  render();
}

function renderTables(list) {
  const projectGroups = groupBy(list, 'project').sort((a, b) => b.totals.tokens - a.totals.tokens).slice(0, 7);
  const modelGroups = groupBy(list, 'model').sort((a, b) => b.totals.tokens - a.totals.tokens);
  $('#project-table').innerHTML = projectGroups.length ? `<table><thead><tr><th>Project</th><th class="num">Turns</th><th class="num">Tokens</th><th class="num">USD*</th></tr></thead><tbody>${projectGroups.map(group => {
    const item = projects.find(project => project.id === group.key);
    const cost = group.totals.costKnown ? moneyFmt.format(group.totals.cost) : '—';
    return `<tr data-entity="project" data-id="${group.key}" class="${selectedClass('project', group.key)}"><td>${item.name}${group.totals.unknown ? `<span class="sub unknown">${group.totals.unknown} turn thiếu usage</span>` : ''}</td><td class="num">${numberFmt.format(group.totals.turns)}</td><td class="num">${group.totals.knownTurns ? compact(group.totals.tokens) : '—'}</td><td class="num">${cost}</td></tr>`;
  }).join('')}</tbody></table>` : '<div class="empty-state">Không có project trong khoảng này.</div>';
  $('#model-table').innerHTML = modelGroups.length ? `<table><thead><tr><th>Model</th><th class="num">Turns</th><th class="num">Tokens / turn</th><th class="num">USD*</th></tr></thead><tbody>${modelGroups.map(group => {
    const item = models.find(model => model.id === group.key);
    const cost = group.totals.costKnown ? moneyFmt.format(group.totals.cost) : '—';
    const avg = group.totals.knownTurns ? compact(group.totals.tokens / group.totals.knownTurns) : '—';
    return `<tr data-entity="model" data-id="${group.key}" class="${selectedClass('model', group.key)}"><td>${item.name}${group.totals.unknown ? `<span class="sub unknown">${group.totals.unknown} usage thiếu</span>` : ''}</td><td class="num">${numberFmt.format(group.totals.turns)}</td><td class="num">${avg}</td><td class="num">${cost}</td></tr>`;
  }).join('')}</tbody></table>` : '<div class="empty-state">Không có model trong khoảng này.</div>';
  const recent = list.slice(0, 6);
  $('#timeline-table').innerHTML = recent.length ? `<table><thead><tr><th>Thời điểm</th><th>Project / model</th><th class="num">Usage</th></tr></thead><tbody>${recent.map(event => {
    const p = projects.find(item => item.id === event.project), m = models.find(item => item.id === event.model);
    const usage = event.input === null ? '<span class="unknown">Chưa biết</span>' : compact(event.input + event.output);
    return `<tr data-entity="project" data-id="${event.project}" class="${selectedClass('project', event.project)}"><td>${dateLabel(event.key)}<span class="sub">${timeLabel(event.at)} · UTC+7</span></td><td>${p.name}<span class="sub">${m.name}</span></td><td class="num">${usage}</td></tr>`;
  }).join('')}</tbody></table>` : '<div class="empty-state">Chưa có activity event.</div>';
  const sessions = groupBy(list, 'session').sort((a, b) => b.items[0].at - a.items[0].at).slice(0, 6);
  $('#session-table').innerHTML = sessions.length ? `<table><thead><tr><th>Session / project</th><th class="num">Turns</th><th class="num">Tokens</th></tr></thead><tbody>${sessions.map(group => {
    const first = group.items[0], p = projects.find(item => item.id === first.project);
    const tokenValue = group.totals.knownTurns ? compact(group.totals.tokens) : '—';
    return `<tr data-entity="project" data-id="${first.project}" class="${selectedClass('project', first.project)}"><td><code>${escapeHtml(group.key.slice(0, 25))}</code><span class="sub">${p.name} · ${dateLabel(first.key)} ${timeLabel(first.at)}</span></td><td class="num">${group.totals.turns}${group.totals.unknown ? `<span class="sub unknown">${group.totals.unknown} chưa biết</span>` : ''}</td><td class="num">${tokenValue}</td></tr>`;
  }).join('')}</tbody></table>` : '<div class="empty-state">Chưa có session trong khoảng này.</div>';
}

function distributionItems(list, type, limit = 5) {
  const groups = groupBy(list, type === 'project' ? 'project' : 'model').map(group => ({
    id: group.key,
    name: (type === 'project' ? projects : models).find(item => item.id === group.key)?.name || group.key,
    value: amountFor(group.items),
  })).filter(item => item.value !== null).sort((a, b) => b.value - a.value);
  if (groups.length <= limit) return groups;
  const top = groups.slice(0, limit);
  const rest = groups.slice(limit).reduce((sum, item) => sum + item.value, 0);
  if (rest) top.push({ id: '__others__', name: 'Khác', value: rest });
  return top;
}
function polarPoint(cx, cy, radius, angle) { const radians = (angle - 90) * Math.PI / 180; return { x: cx + radius * Math.cos(radians), y: cy + radius * Math.sin(radians) }; }
function arcPath(cx, cy, radius, start, end) {
  const from = polarPoint(cx, cy, radius, end), to = polarPoint(cx, cy, radius, start);
  const large = end - start > 180 ? 1 : 0;
  return `M ${from.x} ${from.y} A ${radius} ${radius} 0 ${large} 0 ${to.x} ${to.y} L ${cx} ${cy} Z`;
}
function renderDonut(items, type, list) {
  const total = items.reduce((sum, item) => sum + item.value, 0);
  if (!total) {
    const unavailable = list.some(event => state.metric === 'tokens' ? event.input === null : state.metric === 'cost' ? event.cost === null : false);
    $('#secondary-chart').innerHTML = `<div class="empty-state">${unavailable ? 'Usage của các lượt trong khoảng chưa biết; chưa thể lập phân bổ.' : 'Không có dữ liệu để phân bổ.'}</div>`;
    $('#secondary-legend').innerHTML = '';
    return;
  }
  const palette = [colors.blue, colors.teal, colors.purple, colors.amber, '#6b8ecb', '#a5b5cb'];
  let angle = 0;
  const segments = items.map((item, index) => {
    const span = (item.value / total) * 359.7;
    const path = arcPath(60, 60, 45, angle, angle + span);
    const percent = item.value / total * 100;
    const tip = `${item.name} · ${formatMetric(item.value)} ${metricUnit(state.metric)} · ${percent.toFixed(1)}%`;
    const selected = selectedClass(type, item.id);
    const piece = `<path class="donut-segment chart-bar ${selected}" d="${path}" fill="${palette[index % palette.length]}" tabindex="0" role="button" aria-label="${escapeHtml(tip)}" data-entity="${type}" data-id="${item.id}" data-tip="${escapeHtml(tip)}"/>`;
    angle += span;
    return piece;
  }).join('');
  $('#secondary-chart').innerHTML = `<div class="donut-layout"><svg class="donut" viewBox="0 0 120 120" role="img" aria-label="Phân bổ ${type === 'project' ? 'project' : 'model'}"><circle cx="60" cy="60" r="45" fill="var(--surface-soft)"/>${segments}<circle cx="60" cy="60" r="27" fill="var(--surface)" pointer-events="none"/><text class="donut-total" x="60" y="58">${escapeHtml(compact(total))}</text><text class="donut-caption" x="60" y="70">${escapeHtml(metricUnit(state.metric))}</text></svg><div class="distribution-legend">${items.map((item, index) => {
    const percent = item.value / total * 100;
    return `<button type="button" data-entity="${type}" data-id="${item.id}" class="${selectedClass(type, item.id)}"><i class="swatch" style="--swatch:${palette[index % palette.length]}"></i><span class="legend-name">${escapeHtml(item.name)}</span><span class="legend-value">${percent.toFixed(0)}%</span></button>`;
  }).join('')}</div></div>`;
  $$('.donut-segment', $('#secondary-chart')).forEach(segment => segment.addEventListener('click', () => selectEntity(segment.dataset.entity, segment.dataset.id)));
  $$('.distribution-legend button', $('#secondary-chart')).forEach(button => button.addEventListener('click', () => selectEntity(button.dataset.entity, button.dataset.id)));
  const unknown = list.filter(event => state.metric === 'tokens' ? event.input === null : state.metric === 'cost' ? event.cost === null : false).length;
  $('#secondary-subtitle').textContent = `${items.length > 5 ? 'Top 5 + khác' : 'Tỷ trọng'} · ${formatMetric(total)} ${metricUnit(state.metric)} đã ghi nhận${unknown ? ` · ${unknown} turns thiếu usage, chưa tính` : ''}`;
}

function renderHeatmap(list) {
  const days = Array.from({ length: 7 }, (_, i) => ({ key: offsetKey(i - 6), events: [] }));
  for (const event of list) {
    const day = days.find(item => item.key === event.key);
    if (day) day.events.push(event);
  }
  const amounts = days.flatMap(day => Array.from({ length: 24 }, (_, hour) => day.key === todayKey && hour > currentHour ? null : amountFor(day.events.filter(event => event.hour === hour)))).filter(value => value !== null);
  const max = Math.max(...amounts, 1);
  let hasUnknown = false, hasPartial = false;
  const cells = days.map(day => {
    const label = dateLabel(day.key);
    const cells = Array.from({ length: 24 }, (_, hour) => {
      const future = day.key === todayKey && hour > currentHour;
      const bucket = day.events.filter(event => event.hour === hour);
      const value = amountFor(bucket);
      if (future) return `<span class="heat-cell future" aria-hidden="true"></span>`;
      if (!bucket.length) {
        const tip = `${label} ${hourLabel(hour)} · không có usage event`;
        return `<button class="heat-cell level-0" type="button" data-tip="${escapeHtml(tip)}" aria-label="${escapeHtml(tip)}"></button>`;
      }
      if (value === null) {
        hasUnknown = true;
        const tip = `${label} ${hourLabel(hour)} · ${bucket.length} turns có ${metricName(state.metric)} chưa biết; không tính thành 0.`;
        return `<button class="heat-cell unknown" type="button" data-tip="${escapeHtml(tip)}" aria-label="${escapeHtml(tip)}"></button>`;
      }
      const level = value === 0 ? 0 : Math.min(4, Math.ceil(value / max * 4));
      const missing = bucket.filter(event => event.input === null || state.metric === 'cost' && event.cost === null).length;
      if (missing) hasPartial = true;
      const tip = `${label} ${hourLabel(hour)} · ${formatMetric(value)} ${metricUnit(state.metric)} đã ghi nhận · ${bucket.length} turns${missing ? ` · ${missing} turns thiếu usage/giá, chưa tính` : ''}`;
      return `<button class="heat-cell level-${level}${missing ? ' partial' : ''}" type="button" data-tip="${escapeHtml(tip)}" aria-label="${escapeHtml(tip)}"></button>`;
    }).join('');
    return `<div class="heat-row"><span class="heat-day">${escapeHtml(label)}</span>${cells}</div>`;
  }).join('');
  const hours = Array.from({ length: 24 }, (_, hour) => `<span class="heat-hour">${hour % 2 === 0 ? String(hour).padStart(2, '0') : ''}</span>`).join('');
  $('#secondary-chart').innerHTML = `<div class="heatmap-scroll" tabindex="0" role="region" aria-label="Heatmap 7 ngày theo giờ, cuộn ngang để xem đủ 24 giờ"><div class="heatmap-grid"><div class="heatmap-hours"><span></span>${hours}</div>${cells}</div></div>`;
  $('#secondary-title').textContent = 'Activity Heatmap';
  $('#secondary-subtitle').textContent = '7 ngày × 24 giờ · số đã ghi nhận theo usage event';
  $('#secondary-legend').innerHTML = `<span class="heat-legend"><i class="heat-cell level-0"></i>Ít</span><span class="heat-legend"><i class="heat-cell level-2"></i>Vừa</span><span class="heat-legend"><i class="heat-cell level-4"></i>Nhiều</span>${hasUnknown ? '<span class="heat-legend"><i class="heat-cell unknown"></i>Chưa biết</span>' : ''}${hasPartial ? '<span class="heat-legend"><i class="heat-cell level-2 partial"></i>Thiếu usage/giá</span>' : ''}<span class="heat-legend"><i class="heat-cell future"></i>Chưa tới</span>`;
  $$('.heat-cell[data-tip]', $('#secondary-chart')).forEach(cell => cell.addEventListener('click', () => showTip(cell.dataset.tip)));
}

function renderTopProjects(list) {
  const items = distributionItems(list, 'project', 6);
  const total = items.reduce((sum, item) => sum + item.value, 0);
  if (!total) {
    const unavailable = list.some(event => state.metric === 'tokens' ? event.input === null : state.metric === 'cost' ? event.cost === null : false);
    $('#secondary-chart').innerHTML = `<div class="empty-state">${unavailable ? 'Usage chưa biết; chưa thể xếp hạng project theo chỉ số này.' : 'Không có project để xếp hạng.'}</div>`;
    $('#secondary-legend').innerHTML = '';
    return;
  }
  const max = Math.max(...items.map(item => item.value), 1);
  $('#secondary-chart').innerHTML = `<div class="top-projects">${items.map((item, index) => {
    const width = item.value / max * 100;
    const percent = item.value / total * 100;
    const tip = `${item.name} · ${formatMetric(item.value)} ${metricUnit(state.metric)} · ${percent.toFixed(1)}%`;
    return `<button class="top-project-row ${selectedClass('project', item.id)}" type="button" data-entity="project" data-id="${item.id}" data-tip="${escapeHtml(tip)}"><span class="top-project-label">${escapeHtml(item.name)}</span><span class="top-project-track"><i style="width:${width}%;--bar:${[colors.blue, colors.teal, colors.purple, colors.amber][index % 4]}"></i></span><span class="top-project-value">${percent.toFixed(0)}%</span></button>`;
  }).join('')}</div>`;
  $('#secondary-legend').innerHTML = `<span class="top-project-total">${formatMetric(total)} ${metricUnit(state.metric)} · Top 6 + Khác</span>`;
  $$('.top-project-row', $('#secondary-chart')).forEach(row => row.addEventListener('click', () => selectEntity(row.dataset.entity, row.dataset.id)));
}

function renderSecondary(list) {
  const toggle = $('#distribution-toggle');
  toggle.hidden = !(state.range === 'yesterday');
  if (state.range === '7d') { renderHeatmap(list); return; }
  if (state.range === '30d') { $('#secondary-title').textContent = 'Project usage'; $('#secondary-subtitle').textContent = 'Xếp hạng theo chỉ số đang chọn'; renderTopProjects(list); return; }
  const type = state.range === 'yesterday' ? state.distribution : 'project';
  $('#secondary-title').textContent = state.range === 'today' ? 'Project share' : `${type === 'project' ? 'Project' : 'Model'} distribution`;
  $('#secondary-subtitle').textContent = state.range === 'today' ? 'Top 5 project + phần còn lại' : 'Phân bổ trong 24 giờ hoàn tất';
  renderDonut(distributionItems(list, type, 5), type, list);
  $$('[data-distribution]').forEach(button => button.setAttribute('aria-pressed', String(button.dataset.distribution === state.distribution)));
}

function showTip(text) { $('#chart-tooltip').textContent = text; }
function attachTips() {
  $$('#primary-chart [data-tip], #secondary-chart [data-tip]').forEach(element => {
    element.addEventListener('pointerenter', () => showTip(element.dataset.tip));
    element.addEventListener('focus', () => showTip(element.dataset.tip));
    element.addEventListener('click', () => showTip(element.dataset.tip));
    element.addEventListener('keydown', event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); showTip(element.dataset.tip); } });
  });
}
function updateSelectedRows() {
  $$('[data-entity][data-id]').forEach(item => {
    item.classList.toggle('selected', state.selected?.type === item.dataset.entity && state.selected?.id === item.dataset.id);
  });
  $$('[data-entity="project"], [data-entity="model"]', $('#project-table')).forEach(item => item.addEventListener('click', () => selectEntity(item.dataset.entity, item.dataset.id)));
  $$('[data-entity="project"], [data-entity="model"]', $('#model-table')).forEach(item => item.addEventListener('click', () => selectEntity(item.dataset.entity, item.dataset.id)));
  $$('[data-entity="project"], [data-entity="model"]', $('#timeline-table')).forEach(item => item.addEventListener('click', () => selectEntity(item.dataset.entity, item.dataset.id)));
  $$('[data-entity="project"], [data-entity="model"]', $('#session-table')).forEach(item => item.addEventListener('click', () => selectEntity(item.dataset.entity, item.dataset.id)));
  attachTips();
}

function render() {
  const list = filteredEvents();
  assertRenderConsistency(list);
  renderKpis(list);
  renderPrimary(list);
  renderSecondary(list);
  renderComposition(list);
  renderTables(list);
  updateSelectedRows();
}

function assertRenderConsistency(list) {
  const totals = aggregate(list);
  const expected = metricValue(list) ?? 0;
  const near = (a, b) => Math.abs(a - b) <= Math.max(0.000001, Math.abs(b) * 1e-10);
  const check = (name, actual, target) => {
    const passed = near(actual, target);
    console.assert(passed, `[Usage Insights] ${name}: ${actual} !== ${target}`);
    (window.__usageInsightAssertions ||= []).push({ name, passed, actual, expected: target });
  };
  window.__usageInsightAssertions = [];
  check('filtered tokens = input + output', totals.input + totals.output, totals.tokens);
  check('filtered input = cached + uncached', totals.cached + totals.uncached, totals.input);
  const bucketTotal = currentBuckets(state.range).reduce((sum, bucket) => sum + (amountFor(bucketEvents(bucket, list)) ?? 0), 0);
  check('chart buckets = active filtered metric', bucketTotal, expected);
  check('project groups = active filtered metric', groupBy(list, 'project').reduce((sum, group) => sum + (amountFor(group.items) ?? 0), 0), expected);
  check('model groups = active filtered metric', groupBy(list, 'model').reduce((sum, group) => sum + (amountFor(group.items) ?? 0), 0), expected);
  const donut = distributionItems(list, state.range === 'yesterday' && state.distribution === 'model' ? 'model' : 'project', 5);
  check('distribution total = active filtered metric', donut.reduce((sum, item) => sum + item.value, 0), expected);
  if (state.metric === 'tokens' && totals.knownTurns) {
    const stripTotal = totals.cached + totals.uncached + totals.output;
    check('composition strip = known filtered tokens', stripTotal, totals.tokens);
  }
}

fillFilters();
$('#updated-at').textContent = `Mẫu tạo lúc ${timeLabel(now)} · ${dateLabel(todayKey)}`;
$$('[data-range]').forEach(button => button.addEventListener('click', () => {
  state.range = button.dataset.range;
  $$('[data-range]').forEach(item => item.setAttribute('aria-pressed', String(item === button)));
  state.selected = null;
  render();
}));
$$('[data-metric]').forEach(button => button.addEventListener('click', () => {
  state.metric = button.dataset.metric;
  $$('[data-metric]').forEach(item => item.setAttribute('aria-pressed', String(item === button)));
  render();
}));
$$('[data-distribution]').forEach(button => button.addEventListener('click', () => {
  state.distribution = button.dataset.distribution;
  $$('[data-distribution]').forEach(item => item.setAttribute('aria-pressed', String(item === button)));
  render();
}));
$('#project-filter').addEventListener('change', event => { state.project = event.target.value; state.selected = null; render(); });
$('#model-filter').addEventListener('change', event => { state.model = event.target.value; state.selected = null; render(); });
$('#source-filter').addEventListener('change', event => { state.source = event.target.value; state.selected = null; render(); });
$('#hide-cache').addEventListener('change', event => { state.hideCache = event.target.checked; render(); });
$('#theme-toggle').addEventListener('click', () => {
  const dark = document.documentElement.dataset.theme !== 'dark';
  document.documentElement.dataset.theme = dark ? 'dark' : 'light';
  $('#theme-toggle').setAttribute('aria-pressed', String(dark));
  $('#theme-toggle').setAttribute('aria-label', dark ? 'Chuyển sang chế độ sáng' : 'Chuyển sang chế độ tối');
  try { localStorage.setItem('codex-usage-prototype-theme', dark ? 'dark' : 'light'); } catch {}
});
try {
  const saved = localStorage.getItem('codex-usage-prototype-theme');
  if (saved === 'dark') { document.documentElement.dataset.theme = 'dark'; $('#theme-toggle').setAttribute('aria-pressed', 'true'); $('#theme-toggle').setAttribute('aria-label', 'Chuyển sang chế độ sáng'); }
} catch {}
render();
