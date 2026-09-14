'use strict';
/* Rocket Profile Analysis - local GUI. Talks to rpa/gui/server.py. */

// ============================================================================
// small helpers
// ============================================================================
const $ = (s, el = document) => el.querySelector(s);

function h(tag, attrs, ...kids) {
  const el = document.createElement(tag);
  if (attrs) {
    for (const [k, v] of Object.entries(attrs)) {
      if (v === null || v === undefined || v === false) continue;
      if (k === 'class') el.className = v;
      else if (k === 'html') el.innerHTML = v;
      else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
      else if (k.startsWith('on')) el.addEventListener(k.slice(2).toLowerCase(), v);
      else if (k === 'dataset') Object.assign(el.dataset, v);
      else if (k in el && k !== 'list') { try { el[k] = v; } catch (e) { el.setAttribute(k, v); } }
      else el.setAttribute(k, v);
    }
  }
  for (const kid of kids.flat(Infinity)) {
    if (kid === null || kid === undefined || kid === false) continue;
    el.append(kid instanceof Node ? kid : document.createTextNode(String(kid)));
  }
  return el;
}

const isNum = v => typeof v === 'number' && Number.isFinite(v);
function fmt(v, d) {
  if (v === null || v === undefined || v === '') return '—';
  if (typeof v === 'boolean') return v ? 'yes' : 'no';
  if (!isNum(v)) return String(v);
  if (d !== undefined) return v.toLocaleString(undefined, { minimumFractionDigits: d, maximumFractionDigits: d });
  if (Number.isInteger(v)) return v.toLocaleString();
  const a = Math.abs(v);
  if (a >= 1000) return v.toLocaleString(undefined, { maximumFractionDigits: 0 });
  if (a >= 100) return v.toLocaleString(undefined, { maximumFractionDigits: 1 });
  if (a >= 10) return v.toLocaleString(undefined, { maximumFractionDigits: 2 });
  return v.toLocaleString(undefined, { maximumFractionDigits: 3 });
}
const fmtFt = v => isNum(v) ? fmt(v, 0) + ' ft' : '—';
function ago(ts) {
  if (!ts) return 'never';
  const s = Math.max(0, (Date.now() / 1000) - ts);
  if (s < 60) return `${Math.round(s)}s ago`;
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400) return `${(s / 3600).toFixed(1)} h ago`;
  return `${Math.round(s / 86400)} d ago`;
}
function clock(ts) { return ts ? new Date(ts * 1000).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' }) : '—'; }
function dateTime(ts) { return ts ? new Date(ts * 1000).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : '—'; }
function dur(s) {
  if (!isNum(s)) return '—';
  if (s < 60) return `${Math.round(s)}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m ${Math.round(s % 60)}s`;
  return `${Math.floor(s / 3600)}h ${Math.round((s % 3600) / 60)}m`;
}
function sizeFmt(b) { if (!isNum(b)) return ''; if (b < 1024) return b + ' B'; if (b < 1048576) return (b / 1024).toFixed(0) + ' KB'; return (b / 1048576).toFixed(1) + ' MB'; }
function esc(s) { return String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }

async function api(path, opts) {
  const r = await fetch(path, opts && opts.body ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(opts.body) } : opts);
  let data = null;
  try { data = await r.json(); } catch (e) { data = { error: `bad response (${r.status})` }; }
  if (!r.ok || (data && data.error)) throw new Error((data && data.error) || `HTTP ${r.status}`);
  return data;
}

function toast(msg, kind = '', action) {
  const t = h('div', { class: 'toast ' + kind }, msg, action ? h('a', { onclick: () => { action.fn(); t.remove(); } }, action.label) : null);
  $('#toasts').append(t);
  setTimeout(() => t.remove(), kind === 'err' ? 9000 : action ? 8000 : 3500);
}
const spinner = () => h('span', { class: 'spin' });
function lightbox(src) {
  const lb = $('#lightbox');
  lb.innerHTML = '';
  lb.append(h('img', { src }));
  lb.hidden = false;
  lb.onclick = () => { lb.hidden = true; };
}

// ============================================================================
// app state
// ============================================================================
const App = {
  state: null,
  page: location.hash.replace('#', '') || 'overview',
  ps: {},          // per-page UI state
  lines: [],       // activity log lines
  lastSeq: 0,
  follow: true,
  collapsed: true,
  cache: {},
  lastHash: '',
  es: null,
  theme: (() => { try { return localStorage.getItem('rpa-theme') || 'auto'; } catch (e) { return 'auto'; } })(),
  prevRunning: false,
  subStart: null,
  subKey: null,
};
const STEPS = [
  { id: 'inputs', n: 1, title: 'Inputs & settings', sub: 'Vehicle, motors, mass, target', short: 'Inputs' },
  { id: 'aero', n: 2, title: 'Aero tables', sub: 'RASAero drag export (VM)', short: 'Aero tables' },
  { id: 'reference', n: 3, title: 'Reference flights', sub: 'RASAero runs (VM)', short: 'Reference' },
  { id: 'validate', n: 4, title: 'Validate simulator', sub: 'Python vs RASAero', short: 'Validate' },
  { id: 'optimize', n: 5, title: 'Optimize', sub: 'Search staging delays', short: 'Optimize' },
  { id: 'results', n: 6, title: 'Results', sub: 'Designs, plots, report', short: 'Results' },
  { id: 'confirm', n: 7, title: 'Confirm in RASAero', sub: 'Final check (VM)', short: 'Confirm' },
];
const STATUS_TEXT = { ok: 'done', partial: 'partial', todo: 'not started', stale: 'out of date', warn: 'needs attention', error: 'problem', unchecked: 'not checked', running: 'running' };
const RUN_STAGES = ['run', 'motors', 'mass', 'characterize', 'search', 'verify', 'report'];
function stepStatus(id) {
  const s = App.state;
  if (!s) return 'todo';
  const r = s.runner;
  if (r.running) {
    const st = r.stage;
    if ((id === 'inputs' && (st === 'check' || st === 'mass')) || (id === 'aero' && st === 'aero') || (id === 'reference' && st === 'reference') || (id === 'validate' && st === 'validate') || (id === 'optimize' && RUN_STAGES.includes(st)) || (id === 'confirm' && st === 'confirm')) return 'running';
  }
  return (s[id] && s[id].status) || 'todo';
}
function pageState(page, init) { if (!App.ps[page]) App.ps[page] = init || {}; return App.ps[page]; }
function busy() { return App.state && App.state.runner.running; }
function go(page) { App.page = page; location.hash = page; render(true); $('#main').scrollTo(0, 0); }

// ============================================================================
// generic components
// ============================================================================
const badge = (st, text) => h('span', { class: 'badge ' + st }, text || STATUS_TEXT[st] || st);
function kv(pairs) {
  return h('div', { class: 'kv' }, pairs.filter(p => p).map(([k, v]) => [h('div', { class: 'k' }, k), h('div', { class: 'v' }, v)]));
}
function stat(label, value, unit, cls) {
  return h('div', { class: 'stat ' + (cls || '') }, h('div', { class: 'l' }, label), h('div', { class: 'v' }, value, unit ? h('small', null, ' ' + unit) : null));
}
function callout(kind, ...kids) { return h('div', { class: 'callout ' + kind }, ...kids); }
function cmdPreview(stage, args) {
  return h('div', { class: 'cmd', title: 'the equivalent command line' }, '$ .venv/bin/python -m rpa ', h('b', null, [stage, ...(args || [])].join(' ')));
}
function outcomeText(r) { return r.cancelled ? 'cancelled' : r.exit_code === 0 ? 'finished' : (r.exit_code === 1 && ['check', 'validate'].includes(r.stage)) ? 'finished with findings' : 'failed (exit ' + r.exit_code + ')'; }
async function cancelRun() { try { await api('/api/cancel', { body: {} }); toast('cancel requested'); } catch (e) { toast(e.message, 'err'); } }

function runButton({ stage, args = [], label, primary, disabled, title, cls, confirmText }) {
  const r = App.state && App.state.runner;
  const mine = busy() && r.stage === stage && JSON.stringify(r.args) === JSON.stringify(args);
  const b = h('button', { class: 'btn ' + (primary ? 'primary ' : '') + (mine ? 'running ' : '') + (cls || ''), disabled: disabled || busy(), title: busy() ? `busy: ${r.stage} is running` : (title || '') }, mine ? spinner() : null, mine ? 'running…' : (label || `Run ${stage}`));
  b.onclick = async () => {
    if (confirmText && !window.confirm(confirmText)) return;
    b.disabled = true;
    b.prepend(spinner());
    try {
      await api('/api/run', { body: { stage, args, label } });
      App.collapsed = false;
      App.follow = true;
      toast(`started: rpa ${[stage, ...args].join(' ')}`);
    } catch (e) { toast(e.message, 'err'); render(true); }
  };
  return b;
}

/* One step page, always the same shape:
   header (step N, title, status) -> one-line summary -> action panel
   (prerequisites, the Run button, its options, the command) -> content ->
   "how it works" (collapsed) -> previous / next step. */
function stepPage({ id, summary, action, content, how, extraStatus }) {
  const st = STEPS.find(x => x.id === id);
  const status = stepStatus(id);
  const prev = STEPS[st.n - 2], next = STEPS[st.n];
  return h('div', { class: 'stack' },
    h('div', { class: 'page-head' },
      h('div', null,
        h('div', { class: 'kicker' }, `Step ${st.n} of ${STEPS.length}`),
        h('div', { class: 'row' }, h('h1', null, st.title), badge(status), action && action.vm ? h('span', { class: 'badge info', title: 'this step drives RASAero II inside the Windows VM through the worker' }, 'needs the VM worker') : null, extraStatus || null),
        summary ? h('div', { class: 'desc' }, summary) : null)),
    action ? actionPanel(action) : null,
    ...(content || []).filter(Boolean),
    how ? h('details', { class: 'how' }, h('summary', null, 'How this step works'), h('div', { class: 'how-body' }, how)) : null,
    h('div', { class: 'stepnav' },
      prev ? h('button', { class: 'btn', onclick: () => go(prev.id) }, `← Step ${prev.n}: ${prev.short}`) : h('button', { class: 'btn', onclick: () => go('overview') }, '← Overview'),
      h('span', { class: 'spacer' }),
      next ? h('button', { class: 'btn', onclick: () => go(next.id) }, `Step ${next.n}: ${next.short} →`) : h('button', { class: 'btn', onclick: () => go('overview') }, 'Overview →')));
}

/* The action panel: what you need, what to click, what it costs. */
function actionPanel({ prereqs = [], buttons = [], options, cmd, notes = [], title }) {
  const missing = prereqs.filter(p => p.ok === false);
  return h('div', { class: 'action' },
    h('div', { class: 'action-head' },
      h('div', { class: 'action-title' }, title || 'Run this step'),
      prereqs.length ? h('div', { class: 'prereqs' }, prereqs.map(p => h('span', { class: 'prereq ' + (p.ok === false ? 'bad' : p.ok === 'warn' ? 'warn' : 'ok'), title: p.hint || '' }, p.ok === false ? '✗' : p.ok === 'warn' ? '!' : '✓', ' ', p.label))) : null),
    h('div', { class: 'action-body' },
      h('div', { class: 'action-buttons' }, ...buttons.filter(Boolean)),
      options ? h('div', { class: 'action-options' }, options) : null),
    missing.length ? callout('warn', h('b', null, 'Before you run: '), missing.map(p => p.hint || p.label).join(' · ')) : null,
    ...notes.filter(Boolean),
    cmd ? cmd : null);
}

function fileRow(fi, opts = {}) {
  const cls = !fi.exists ? '' : opts.stale ? 'stale' : 'ok';
  return h('div', { class: 'f ' + cls, title: fi.path },
    h('span', { class: 'i' }),
    h('span', { class: 'n' }, fi.name || fi.path),
    fi.exists ? h('span', { class: 'm' }, `${sizeFmt(fi.size)} · ${ago(fi.mtime)}`) : h('span', { class: 'm' }, 'missing'));
}
function subTabs(ps, key, items, onChange) {
  return h('div', { class: 'tabs' }, items.map(([k, label, extra]) => h('div', { class: 'tab ' + (ps[key] === k ? 'active' : ''), onclick: () => { ps[key] = k; if (onChange) onChange(k); else render(true); } }, label, extra ? h('span', { class: 'tab-extra' }, extra) : null)));
}
const WORKER_CLS = { busy: 'run', online: 'ok', idle: 'ok', queued: 'warn', unresponsive: 'err', offline: 'err', unknown: 'todo' };
const workerUp = s => ['busy', 'online', 'idle', 'queued'].includes(s.worker.state);
const workerOk = s => workerUp(s) ? true : 'warn';
function vmButtons(s, opts = {}) {
  const w = s.worker, vm = w.vm || {};
  const op = vm.op || {};
  const call = async (path, label) => {
    try { await api(path, { body: {} }); App.collapsed = false; toast(label); }
    catch (e) { toast(e.message, 'err'); }
  };
  if (!vm.available) return h('span', { class: 'muted small' }, 'UTM not found on this Mac (config vm.utmctl) — start the worker by hand: ', h('code', null, 'python Z:\\worker\\run_worker.py'));
  const busyOp = op.running;
  const start = h('button', { class: 'btn ' + (opts.primary === false ? '' : 'primary ') + (opts.small ? 'sm' : ''), disabled: busyOp || workerUp(s), title: workerUp(s) ? 'the worker is already running' : `boots the UTM VM "${vm.name}" if needed and starts the worker on its desktop`, onclick: () => call('/api/vm/start', 'starting the VM worker — progress in the activity log') }, busyOp && op.op === 'start' ? spinner() : '▶', ' ', busyOp && op.op === 'start' ? 'starting…' : 'Start VM worker');
  const stop = h('button', { class: 'btn ' + (opts.small ? 'sm' : ''), disabled: busyOp || !workerUp(s), onclick: () => { if (w.state === 'busy' && !window.confirm('The worker is in the middle of a job — stop it anyway?')) return; call('/api/vm/stop', 'stopping the worker'); } }, busyOp && op.op === 'stop' ? spinner() : '■', ' ', busyOp && op.op === 'stop' ? 'stopping…' : 'Stop worker');
  return h('span', { class: 'row', style: { gap: '6px' } }, start, opts.noStop ? null : stop);
}
function workerNote(s) {
  const w = s.worker;
  if (workerUp(s)) return null;
  const op = (w.vm || {}).op || {};
  return callout(op.running ? 'info' : 'warn', h('b', null, 'VM worker is ' + w.state + ': '), w.detail, '. ', op.running ? h('span', null, spinner(), ` ${op.op === 'start' ? 'starting' : 'stopping'}… (${dur(op.elapsed_s)}, details in the activity log)`) : vmButtons(s, { small: true, noStop: true }), ' ', h('a', { href: '#worker', onclick: e => { e.preventDefault(); go('worker'); } }, 'worker page'));
}

// ---- data table --------------------------------------------------------------
function dataTable({ columns, rows, labels = {}, format = {}, hide = [], onRow, rowKey, selected, sort, rowClass, wrap = [], maxHeight, cellClass }) {
  const cols = columns.filter(c => !hide.includes(c));
  const st = { key: sort ? sort.key : null, dir: sort ? (sort.dir || 1) : 1 };
  const wrapEl = h('div', { class: 'tablewrap', style: maxHeight ? { maxHeight } : null });
  const isNumCol = c => rows.some(r => isNum(r[c]));
  const draw = () => {
    let data = rows.slice();
    if (st.key) {
      const k = st.key, d = st.dir;
      data.sort((a, b) => {
        const x = a[k], y = b[k];
        if (x === null || x === undefined) return 1;
        if (y === null || y === undefined) return -1;
        return (isNum(x) && isNum(y) ? x - y : String(x).localeCompare(String(y))) * d;
      });
    }
    const thead = h('thead', null, h('tr', null, cols.map(c => h('th', { class: (isNumCol(c) ? 'n ' : '') + (st.key === c ? 'sorted' : ''), onclick: () => { if (st.key === c) st.dir *= -1; else { st.key = c; st.dir = 1; } draw(); } }, (labels[c] || c) + (st.key === c ? (st.dir > 0 ? ' ▲' : ' ▼') : '')))));
    const tbody = h('tbody', null, data.map(r => {
      const key = rowKey ? rowKey(r) : null;
      const tr = h('tr', { class: [onRow ? 'clickable' : '', selected && key === selected ? 'sel' : '', rowClass ? rowClass(r) : ''].join(' '), onclick: onRow ? () => onRow(r) : null },
        cols.map(c => {
          const v = r[c];
          let content = format[c] ? format[c](v, r) : fmt(v);
          return h('td', { class: [isNumCol(c) ? 'n' : '', wrap.includes(c) ? 'wrap' : '', cellClass ? (cellClass(c, v, r) || '') : ''].join(' ') }, content);
        }));
      return tr;
    }));
    wrapEl.innerHTML = '';
    wrapEl.append(h('table', { class: 'data' }, thead, tbody));
  };
  draw();
  return wrapEl;
}

// ---- SVG line chart ----------------------------------------------------------
const PALETTE = ['#2563eb', '#f97316', '#16a34a', '#9333ea', '#dc2626', '#0891b2', '#ca8a04', '#db2777'];
function niceTicks(lo, hi, n = 6) {
  if (!isFinite(lo) || !isFinite(hi)) return [];
  if (lo === hi) { lo -= 1; hi += 1; }
  const step0 = (hi - lo) / n;
  const mag = Math.pow(10, Math.floor(Math.log10(step0)));
  const r = step0 / mag;
  const step = (r < 1.5 ? 1 : r < 3 ? 2 : r < 7 ? 5 : 10) * mag;
  const out = [];
  for (let v = Math.ceil(lo / step) * step; v <= hi + step * 1e-6; v += step) out.push(+v.toFixed(10));
  return out;
}
function lineChart({ series, xLabel, yLabel, y2Label, markers = [], refs = [], title, height = 280, xDomain, yDomain, y2Domain, points }) {
  const W = 860, H = height;
  const hasY2 = series.some(s => s.axis === 'y2');
  const m = { l: 58, r: hasY2 ? 58 : 18, t: title ? 28 : 14, b: 42 };
  const iw = W - m.l - m.r, ih = H - m.t - m.b;
  const vis = series.filter(s => s.x && s.x.length);
  const ext = (arr) => { let lo = Infinity, hi = -Infinity; for (const v of arr) { if (isNum(v)) { if (v < lo) lo = v; if (v > hi) hi = v; } } return [lo, hi]; };
  let [x0, x1] = xDomain || ext(vis.flatMap(s => s.x));
  const yv = vis.filter(s => s.axis !== 'y2'), y2v = vis.filter(s => s.axis === 'y2');
  let [y0, y1] = yDomain || ext(yv.flatMap(s => s.y).concat(refs.filter(r => r.axis !== 'y2').map(r => r.y)));
  let [z0, z1] = y2Domain || ext(y2v.flatMap(s => s.y).concat(refs.filter(r => r.axis === 'y2').map(r => r.y)));
  if (!isFinite(x0)) { x0 = 0; x1 = 1; }
  if (!isFinite(y0)) { y0 = 0; y1 = 1; }
  if (!isFinite(z0)) { z0 = 0; z1 = 1; }
  const pad = (a, b) => { if (a === b) return [a - 1, b + 1]; const p = (b - a) * 0.06; return [a - (a >= 0 && a - p < 0 ? a : p), b + p]; };
  if (!yDomain) [y0, y1] = pad(y0, y1);
  if (!y2Domain) [z0, z1] = pad(z0, z1);
  const sx = v => m.l + (v - x0) / (x1 - x0 || 1) * iw;
  const sy = v => m.t + ih - (v - y0) / (y1 - y0 || 1) * ih;
  const sz = v => m.t + ih - (v - z0) / (z1 - z0 || 1) * ih;
  const xt = niceTicks(x0, x1, 8), yt = niceTicks(y0, y1, 6), zt = niceTicks(z0, z1, 6);
  const tickFmt = v => Math.abs(v) >= 10000 ? (v / 1000).toFixed(v % 1000 ? 1 : 0) + 'k' : fmt(v);
  let svg = `<svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="xMidYMid meet">`;
  if (title) svg += `<text class="title" x="${m.l}" y="16">${esc(title)}</text>`;
  svg += '<g class="grid">' + yt.map(v => `<line x1="${m.l}" x2="${W - m.r}" y1="${sy(v)}" y2="${sy(v)}"/>`).join('') + '</g>';
  svg += `<g class="axis"><path d="M${m.l},${m.t}V${m.t + ih}H${W - m.r}${hasY2 ? 'V' + m.t : ''}" fill="none"/>` +
    xt.map(v => `<line x1="${sx(v)}" x2="${sx(v)}" y1="${m.t + ih}" y2="${m.t + ih + 4}"/><text x="${sx(v)}" y="${m.t + ih + 16}" text-anchor="middle">${tickFmt(v)}</text>`).join('') +
    yt.map(v => `<text x="${m.l - 6}" y="${sy(v) + 3.5}" text-anchor="end">${tickFmt(v)}</text>`).join('') +
    (hasY2 ? zt.map(v => `<text x="${W - m.r + 6}" y="${sz(v) + 3.5}" text-anchor="start">${tickFmt(v)}</text>`).join('') : '') +
    (xLabel ? `<text x="${m.l + iw / 2}" y="${H - 8}" text-anchor="middle">${esc(xLabel)}</text>` : '') +
    (yLabel ? `<text transform="translate(13,${m.t + ih / 2}) rotate(-90)" text-anchor="middle">${esc(yLabel)}</text>` : '') +
    (hasY2 && y2Label ? `<text transform="translate(${W - 10},${m.t + ih / 2}) rotate(90)" text-anchor="middle">${esc(y2Label)}</text>` : '') + '</g>';
  for (const r of refs) {
    const y = r.axis === 'y2' ? sz(r.y) : sy(r.y);
    if (y < m.t || y > m.t + ih) continue;
    svg += `<line class="ref" x1="${m.l}" x2="${W - m.r}" y1="${y}" y2="${y}" stroke="${r.color || '#94a3b8'}"/><text class="marker-lbl" x="${W - m.r - 4}" y="${y - 4}" text-anchor="end" fill="${r.color || '#94a3b8'}">${esc(r.label || '')}</text>`;
  }
  markers.forEach((mk, i) => {
    if (!isNum(mk.x) || mk.x < x0 || mk.x > x1) return;
    const x = sx(mk.x);
    svg += `<line class="marker" x1="${x}" x2="${x}" y1="${m.t}" y2="${m.t + ih}" stroke="${mk.color || '#64748b'}"/><text class="marker-lbl" x="${x + 3}" y="${m.t + 11 + (i % 3) * 12}" fill="${mk.color || '#64748b'}">${esc(mk.label)}</text>`;
  });
  vis.forEach((s, i) => {
    const f = s.axis === 'y2' ? sz : sy;
    let d = '', pen = false;
    for (let k = 0; k < s.x.length; k++) {
      const xv = s.x[k], yv2 = s.y[k];
      if (!isNum(xv) || !isNum(yv2)) { pen = false; continue; }
      d += (pen ? 'L' : 'M') + sx(xv).toFixed(1) + ',' + f(yv2).toFixed(1);
      pen = true;
    }
    const color = s.color || PALETTE[i % PALETTE.length];
    svg += `<path class="series" d="${d}" stroke="${color}"${s.dash ? ' stroke-dasharray="5 3"' : ''}${s.width ? ` stroke-width="${s.width}"` : ''}/>`;
    if (s.points || points) svg += s.x.map((xv, k) => isNum(xv) && isNum(s.y[k]) ? `<circle cx="${sx(xv)}" cy="${f(s.y[k])}" r="3" fill="${color}"/>` : '').join('');
  });
  svg += `<line class="hover-line" id="hv" x1="0" x2="0" y1="${m.t}" y2="${m.t + ih}" visibility="hidden"/>`;
  svg += '</svg>';
  const el = h('div', { class: 'chart', html: svg });
  const legend = h('div', { class: 'legend' }, vis.map((s, i) => h('span', null, h('span', { class: 'sw', style: { background: s.color || PALETTE[i % PALETTE.length] } }), s.name + (s.axis === 'y2' ? ' (right)' : ''))));
  const tip = h('div', { class: 'tip', hidden: true });
  el.append(tip);
  const svgEl = el.querySelector('svg');
  const hv = el.querySelector('#hv');
  el.addEventListener('mousemove', ev => {
    const rect = svgEl.getBoundingClientRect();
    const px = (ev.clientX - rect.left) / rect.width * W;
    if (px < m.l || px > W - m.r) { tip.hidden = true; hv.setAttribute('visibility', 'hidden'); return; }
    const xv = x0 + (px - m.l) / iw * (x1 - x0);
    const rowsOut = [];
    let xNear = null;
    for (const s of vis) {
      let lo = 0, hi = s.x.length - 1;
      while (lo < hi) { const mid = (lo + hi) >> 1; if (s.x[mid] < xv) lo = mid + 1; else hi = mid; }
      const k = (lo > 0 && Math.abs(s.x[lo - 1] - xv) < Math.abs(s.x[lo] - xv)) ? lo - 1 : lo;
      if (xNear === null) xNear = s.x[k];
      rowsOut.push([s.name, s.y[k], s.color || PALETTE[vis.indexOf(s) % PALETTE.length]]);
    }
    if (xNear === null) return;
    hv.setAttribute('x1', sx(xNear)); hv.setAttribute('x2', sx(xNear)); hv.setAttribute('visibility', 'visible');
    tip.innerHTML = `<div class="r"><b>${esc(xLabel || 'x')}</b><span>${fmt(xNear)}</span></div>` + rowsOut.map(([n, v, c]) => `<div class="r"><span style="color:${c}">${esc(n)}</span><span>${fmt(v)}</span></div>`).join('');
    tip.hidden = false;
    const left = ev.clientX - rect.left, top = ev.clientY - rect.top;
    tip.style.left = (left + 14 + 180 > rect.width ? left - 190 : left + 14) + 'px';
    tip.style.top = Math.max(0, top - 10) + 'px';
  });
  el.addEventListener('mouseleave', () => { tip.hidden = true; hv.setAttribute('visibility', 'hidden'); });
  return h('div', null, el, legend);
}
// ---- minimal markdown (report.md) --------------------------------------------
function mdRender(text) {
  const lines = text.split('\n');
  let html = '', i = 0;
  const inline = s => esc(s).replace(/`([^`]+)`/g, '<code>$1</code>').replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>').replace(/\*([^*]+)\*/g, '<i>$1</i>');
  while (i < lines.length) {
    const ln = lines[i];
    if (/^\s*\|/.test(ln)) {
      const rows = [];
      while (i < lines.length && /^\s*\|/.test(lines[i])) { rows.push(lines[i]); i++; }
      const cells = r => r.trim().replace(/^\||\|$/g, '').split('|').map(c => c.trim());
      const head = cells(rows[0]);
      const body = rows.slice(1).filter(r => !/^\s*\|?\s*:?-+/.test(r)).map(cells);
      html += '<div class="tw"><table><thead><tr>' + head.map(c => `<th>${inline(c)}</th>`).join('') + '</tr></thead><tbody>' + body.map(r => '<tr>' + r.map(c => `<td>${inline(c)}</td>`).join('') + '</tr>').join('') + '</tbody></table></div>';
      continue;
    }
    const hm = /^(#{1,4})\s+(.*)$/.exec(ln);
    if (hm) { html += `<h${hm[1].length}>${inline(hm[2])}</h${hm[1].length}>`; i++; continue; }
    if (/^\s*[-*]\s+/.test(ln)) {
      html += '<ul>';
      while (i < lines.length && /^\s*[-*]\s+/.test(lines[i])) { html += `<li>${inline(lines[i].replace(/^\s*[-*]\s+/, ''))}</li>`; i++; }
      html += '</ul>';
      continue;
    }
    if (/^```/.test(ln)) {
      let code = ''; i++;
      while (i < lines.length && !/^```/.test(lines[i])) { code += lines[i] + '\n'; i++; }
      i++;
      html += `<pre class="console">${esc(code)}</pre>`;
      continue;
    }
    if (ln.trim() === '') { i++; continue; }
    let para = ln; i++;
    while (i < lines.length && lines[i].trim() !== '' && !/^(#|\s*[-*]\s|\s*\||```)/.test(lines[i])) { para += ' ' + lines[i]; i++; }
    html += `<p>${inline(para)}</p>`;
  }
  return h('div', { class: 'md', html });
}

// ============================================================================
// data loading with caching
// ============================================================================
async function cached(key, url, ttl = 4000) {
  const c = App.cache[key];
  if (c && Date.now() - c.t < ttl) return c.v;
  const v = await api(url);
  App.cache[key] = { t: Date.now(), v };
  return v;
}
function asyncBlock(fn, placeholder = 'Loading…') {
  const el = h('div', null, h('div', { class: 'loading-inline' }, spinner(), placeholder));
  Promise.resolve().then(fn).then(node => { el.innerHTML = ''; if (node) el.append(node); }).catch(e => { el.innerHTML = ''; el.append(callout('err', e.message)); });
  return el;
}

// ============================================================================
// pages
// ============================================================================
const pages = {};

// ---- overview ----------------------------------------------------------------
pages.overview = () => {
  const s = App.state;
  const d = s.results;
  const cfg = s.config;
  const blocking = STEPS.find(st => ['todo', 'error', 'stale', 'unchecked'].includes(stepStatus(st.id)));
  const attention = STEPS.filter(st => ['warn', 'partial'].includes(stepStatus(st.id)));
  const running = STEPS.find(st => stepStatus(st.id) === 'running');
  const why = st => ({ stale: ' — its inputs changed since it last ran', unchecked: ' — inputs changed, press Check', error: ' — there is a problem to fix', todo: '' }[stepStatus(st.id)] || '');
  const nextText = running ? `Step ${running.n} (${running.title}) is running.` : blocking ? (blocking.id === 'results' ? 'Run the optimizer (step 5) to get results.' : `step ${blocking.n}, ${blocking.title}${why(blocking)}.`) : attention.length ? `All steps have been run; step ${attention[0].n} (${attention[0].title}) needs a look.` : 'Every step is complete. Re-run steps whose inputs changed (they are flagged "out of date").';
  const headline = () => {
    if (!d.n) return callout('info', h('b', null, 'No results yet. '), 'Follow the steps in order; the optimizer runs on this Mac in under a minute once the aero tables exist.');
    const b = d.best;
    const solved = d.n_solved;
    const tgt = d.target_ft;
    const over = (d.counts || {}).overpowered || 0, under = (d.counts || {}).underpowered || 0, unsolved = (d.counts || {}).unsolved || 0;
    if (solved) return callout('ok', h('b', null, `${solved} design(s) hit ${fmtFt(tgt)} ± ${fmt(d.tolerance_ft, 0)} ft`), ` — ${d.n_verified_ok} verified. Best: `, h('b', null, `${b.booster} · ${b.profile}`), ` sep ${b.sep_delay_s}s, ign ${b.ign_delay_s}s → ${fmtFt(b.apogee_ft)}.`);
    if (over === d.n) return callout('warn', h('b', null, `Every candidate overshoots ${fmtFt(tgt)}.`), ` Lowest reachable apogee is ${fmtFt(d.apogee_min_ft)} (${b.booster}, ${b.profile}, sep ${b.sep_delay_s}s, ign ${b.ign_delay_s}s after separation). Heavier hardware mass, a lower-impulse sustainer, airbrakes/ballast, or a shorter ignition gap would bring it down.`);
    if (under === d.n) return callout('warn', h('b', null, `No candidate reaches ${fmtFt(tgt)}.`), ` Highest reachable apogee is ${fmtFt(d.apogee_max_ft)} (${b.booster}, ${b.profile}). A lighter hardware mass or more impulse is needed.`);
    return callout('warn', h('b', null, 'No design hit the target.'), ` ${over} overpowered, ${under} underpowered, ${unsolved} unsolved. Closest: ${b.booster} ${b.profile} → ${fmtFt(b.apogee_ft)}.`);
  };
  const el = d.eligibility || {};
  const m = s.inputs.motors;
  return h('div', { class: 'stack' },
    h('div', { class: 'page-head' }, h('div', null, h('h1', null, 'Overview'), h('div', { class: 'desc' }, 'Where the project stands, what the optimizer found, and what to do next. Work through the steps in the sidebar from top to bottom — each one explains what it needs, what it produces and has a single Run button.'))),
    h('div', { class: 'next-action' }, h('div', { class: 't' }, h('b', null, 'Next: '), nextText), running ? h('button', { class: 'btn sm', onclick: () => { App.collapsed = false; renderActivity(); } }, 'Show log') : blocking ? h('button', { class: 'btn sm primary', onclick: () => go(blocking.id === 'results' ? 'optimize' : blocking.id) }, `Go to step ${blocking.id === 'results' ? 5 : blocking.n} →`) : attention.length ? h('button', { class: 'btn sm', onclick: () => go(attention[0].id) }, `Open step ${attention[0].n} →`) : h('button', { class: 'btn sm', onclick: () => go('results') }, 'Open results →')),
    h('div', { class: 'card' }, h('h2', null, 'Progress'),
      h('div', { class: 'steps-strip' }, STEPS.map(st => { const stt = stepStatus(st.id); return h('div', { class: 's', onclick: () => go(st.id) }, h('div', { class: 'n' }, `step ${st.n}`), h('div', { class: 't' }, st.title), h('div', { class: 'b' }, badge(stt))); }))),
    h('div', { class: 'grid c2' },
      h('div', { class: 'card' }, h('h2', null, 'Headline result'),
        headline(),
        d.n ? h('div', { class: 'stat-list', style: { marginTop: '12px' } },
          stat('target', fmt(d.target_ft, 0), 'ft'),
          stat('designs', d.n),
          stat('solved', d.n_solved, null, d.n_solved ? 'ok' : 'warn'),
          stat('overpowered', (d.counts || {}).overpowered || 0),
          stat('underpowered', (d.counts || {}).underpowered || 0),
          ...Object.entries(el).map(([p, v]) => stat(`${p} eligible`, `${v.eligible}/${v.total}`))) : null,
        d.n ? h('div', { class: 'row', style: { marginTop: '12px' } }, h('button', { class: 'btn', onclick: () => go('results') }, 'Open results →')) : null),
      h('div', { class: 'stack' },
        h('div', { class: 'card' }, h('h2', null, 'Vehicle & target', h('span', { class: 'right' }, h('a', { href: '#inputs', onclick: e => { e.preventDefault(); go('inputs'); } }, 'edit →'))),
          kv([
            ['OpenRocket model', s.inputs.ork.name + (s.inputs.ork.exists ? '' : ' (missing)')],
            ['RASAero model', s.inputs.cdx1.name + (s.inputs.cdx1.exists ? '' : ' (missing)')],
            ['boosters', `${s.inputs.boosters.n} candidates from ${s.inputs.boosters.sources.length} source(s)`],
            ['sustainer', m ? `${m.sustainer.label} (${fmt(m.sustainer.total_impulse_ns, 0)} N·s, highest of ${m.n_sustainer_candidates})` : '—'],
            ['hardware mass', s.mass.hardware_mass_lb != null ? `${fmt(s.mass.hardware_mass_lb, 0)} lb dry` : '.ork masses'],
            ['target apogee', `${fmt(cfg.target.apogee_ft, 0)} ± ${fmt(cfg.target.tolerance_ft, 0)} ft`],
            ['profiles', `subsonic < M${cfg.profiles.subsonic_max_mach}, supersonic ≥ M${cfg.profiles.supersonic_min_mach} (margin ${cfg.profiles.mach_margin})`],
            ['delay windows', `separation ${fmt(cfg.profiles.separation_delay_min_s)}–${fmt(cfg.profiles.separation_delay_max_s)} s after burnout · ignition ${fmt(cfg.profiles.ignition_delay_min_s)}–${fmt(cfg.profiles.ignition_delay_max_s)} s after separation`],
            ['backend', cfg.backend],
          ])),
        workerCard(s))),
    h('div', { class: 'grid c2' },
      h('div', { class: 'card' }, h('h2', null, 'Recent runs'), runHistory(s.history)),
      h('div', { class: 'card' }, h('h2', null, 'How to use this tool'),
        h('ol', { class: 'howto' },
          h('li', null, h('b', null, 'Step 1'), ' — point the tool at your .ork, .CDX1 and motor files (tick any mix of folders and single .eng files), set the hardware mass and the target apogee, then press ', h('b', null, 'Check'), '.'),
          h('li', null, h('b', null, 'Steps 2–4'), ' — done once per vehicle revision: export RASAero\'s drag tables, fly a few reference cases in RASAero and validate the fast simulator against them. Steps marked ', h('span', { class: 'badge info' }, 'needs the VM worker'), ' drive RASAero in the Windows VM — press ', h('b', null, 'Start VM worker'), ' (worker card, or the note on those steps) and the VM is booted and the worker started for you.'),
          h('li', null, h('b', null, 'Step 5'), ' — run the optimizer as often as you like (about a minute for 60 boosters, on this Mac).'),
          h('li', null, h('b', null, 'Steps 6–7'), ' — read the results, then confirm the chosen designs in RASAero itself.'),
          h('li', null, 'The panel at the bottom shows the live log of whatever is running. Every Run button shows the equivalent command line, so everything can also be scripted.')))));
};

function runHistory(hist) {
  if (!hist || !hist.length) return h('div', { class: 'muted small' }, 'nothing has been run from this GUI yet');
  const rows = hist.slice().reverse().slice(0, 12);
  return h('div', { class: 'filelist' }, rows.map(r => h('div', { class: 'f ' + (r.exit_code === 0 ? 'ok' : r.cancelled ? '' : 'stale') },
    h('span', { class: 'i', style: r.exit_code !== 0 && !r.cancelled ? { background: 'var(--err)' } : null }),
    h('span', { class: 'n' }, ['rpa', r.stage, ...(r.args || [])].join(' ')),
    h('span', { class: 'm' }, `${outcomeText(r)} · ${dur(r.elapsed_s)} · ${dateTime(r.finished)}`))));
}

function workerCard(s) {
  const w = s.worker, vm = w.vm || {}, op = vm.op || {}, hb = w.heartbeat;
  const cls = WORKER_CLS[w.state] || 'todo';
  return h('div', { class: 'card' }, h('h2', null, 'RASAero worker (VM)', h('span', { class: 'right' }, h('a', { href: '#worker', onclick: e => { e.preventDefault(); go('worker'); } }, 'details →'))),
    h('div', { class: 'row', style: { justifyContent: 'space-between' } }, h('span', { class: 'row' }, badge(cls, w.state), h('span', { class: 'muted small' }, w.detail)), vmButtons(s, { small: true })),
    op.running ? h('div', { class: 'loading-inline' }, spinner(), `${op.op === 'start' ? 'starting' : 'stopping'} the worker… ${dur(op.elapsed_s)} — progress in the activity log`) : op.finished ? h('div', { class: 'small ' + (op.ok ? 'muted' : ''), style: op.ok ? null : { color: 'var(--err)' } }, `${op.op}: ${op.message} (${ago(op.finished)})`) : null,
    h('div', { class: 'kv small', style: { marginTop: '8px' } },
      h('div', { class: 'k' }, 'UTM virtual machine'), h('div', { class: 'v' }, vm.available ? `${vm.name}: ${vm.status || 'not found'}` : 'utmctl not found (vm.utmctl in config.yaml)'),
      h('div', { class: 'k' }, 'heartbeat'), h('div', { class: 'v' }, hb ? `${hb.status}, ${ago(hb.epoch)} · ${hb.host || ''}${hb.user ? ' / ' + hb.user : ''} · pids ${hb.launcher_pid}/${hb.worker_pid || '?'}` : 'none yet (written by run_worker.py every 15 s)'),
      h('div', { class: 'k' }, 'last console activity'), h('div', { class: 'v' }, w.last_seen ? `${ago(w.last_seen)} (${dateTime(w.last_seen)})` : 'no log'),
      h('div', { class: 'k' }, 'worker version'), h('div', { class: 'v' }, w.version ? 'v' + w.version : '—'),
      h('div', { class: 'k' }, 'queue'), h('div', { class: 'v' }, `${w.n_active} running, ${w.n_queued} waiting`),
      h('div', { class: 'k' }, 'mode'), h('div', { class: 'v' }, w.mode === 'auto' ? 'auto (worker polls jobs/)' : 'manual (you drive RASAero by hand)')));
}

// ---- step 1: inputs ----------------------------------------------------------
pages.inputs = () => {
  const s = App.state, cfg = s.config, inp = s.inputs, mass = s.mass;
  const ps = pageState('inputs', { edits: {}, options: null, tab: 'vehicle', mtab: 'boosters', open: {} });
  const cfgVal = dotted => dotted.split('.').reduce((o, k) => (o == null ? undefined : o[k]), cfg);
  const val = dotted => (dotted in ps.edits) ? ps.edits[dotted] : cfgVal(dotted);
  const dirty = () => Object.keys(ps.edits).length;
  const same = (a, b) => (a === b) || (a == null && b == null) || (isNum(a) && isNum(b) && Math.abs(a - b) < 1e-12) || (Array.isArray(a) && Array.isArray(b) && JSON.stringify(a) === JSON.stringify(b));
  const setEdit = (dotted, v) => { if (same(v, cfgVal(dotted))) delete ps.edits[dotted]; else ps.edits[dotted] = v; syncDirty(); };
  const dirtyEls = [];
  const syncDirty = () => {
    for (const [el, dotted] of dirtyEls) el.classList.toggle('dirty', dotted in ps.edits);
    const n = dirty();
    saveBtn.disabled = !n; resetBtn.disabled = !n; saveCheckBtn.disabled = !n || busy();
    saveBar.hidden = !n;
    $('.n', saveBar).textContent = `${n} unsaved change${n === 1 ? '' : 's'}`;
  };
  const numField = (label, dotted, hint, step, extra = {}) => {
    const inEl = h('input', { type: 'number', step: step || 'any', value: val(dotted) ?? '', placeholder: extra.placeholder || 'null', min: extra.min });
    inEl.oninput = () => setEdit(dotted, inEl.value === '' ? null : Number(inEl.value));
    inEl.onkeydown = e => { if (e.key === 'Enter' && dirty()) save(); };
    dirtyEls.push([inEl, dotted]);
    return h('div', { class: 'field' }, h('label', null, label), inEl, hint ? h('div', { class: 'hint' }, hint) : null);
  };
  const selField = (label, dotted, options, hint) => {
    const cur = val(dotted);
    const opts = options.slice();
    if (cur && !opts.some(o => o.value === cur)) opts.unshift({ value: cur, label: cur + ' (not found)' });
    const sel = h('select', null, opts.map(o => h('option', { value: o.value, selected: o.value === cur }, o.label || o.value)));
    sel.onchange = () => setEdit(dotted, sel.value);
    dirtyEls.push([sel, dotted]);
    return h('div', { class: 'field' }, h('label', null, label), sel, hint ? h('div', { class: 'hint' }, hint) : null);
  };
  const save = async (thenCheck) => {
    try {
      await api('/api/config', { body: { set: ps.edits } });
      ps.edits = {};
      toast('config.yaml saved', 'ok');
      App.cache = {};
      if (thenCheck) await api('/api/run', { body: { stage: 'check', args: [], label: 'check' } }).then(() => { App.collapsed = false; }).catch(e => toast(e.message, 'err'));
      await refresh(true);
    } catch (e) { toast(e.message, 'err'); }
  };
  const saveBtn = h('button', { class: 'btn primary', onclick: () => save(false) }, 'Save');
  const saveCheckBtn = h('button', { class: 'btn', onclick: () => save(true) }, 'Save & check');
  const resetBtn = h('button', { class: 'btn', onclick: () => { ps.edits = {}; render(true); } }, 'Discard');
  const saveBar = h('div', { class: 'savebar', hidden: true }, h('b', null, 'Unsaved'), h('span', { class: 'n' }), h('span', { class: 'muted small' }, '— written to config.yaml with its comments intact'), h('span', { style: { flex: 1 } }), saveBtn, saveCheckBtn, resetBtn);

  // ---- tab: vehicle
  const vehicleTab = () => asyncBlock(async () => {
    const o = ps.options || (ps.options = await api('/api/options'));
    const site = inp.site || {};
    const siteField = (label, key, unit) => numField(`${label} [${unit}]`, `launch_site.${key}`, `CDX1 value: ${fmt(site[key])} — leave empty to keep it`);
    const el = h('div', { class: 'grid c2' },
      h('div', { class: 'card' }, h('h2', null, 'Model files'),
        h('div', { class: 'form' },
          selField('OpenRocket model (.ork)', 'paths.ork', o.ork.map(v => ({ value: v })), 'mass distribution and CGs (SOP figs 7–10). Files found under input/'),
          selField('RASAero model (.CDX1)', 'paths.cdx1', o.cdx1.map(v => ({ value: v })), 'geometry, launch site and the simulation rows RASAero runs')),
        h('div', { class: 'sep' }),
        inp.site ? kv([
          ['reference diameter', `${fmt(inp.ref_diameter_in, 3)} in (largest body diameter in the CDX1)`],
          ['OpenRocket', inp.openrocket_jar.exists ? 'OpenRocket.app found' : h('span', { class: 'badge err' }, 'OpenRocket.app not found (paths.openrocket_jar)')],
        ]) : callout('warn', 'CDX1 not readable')),
      h('div', { class: 'card' }, h('h2', null, 'Launch site', h('span', { class: 'right' }, 'from the CDX1; override here if needed')),
        h('div', { class: 'form' }, siteField('Altitude', 'altitude_ft', 'ft'), siteField('Pressure', 'pressure_inhg', 'inHg'), siteField('Temperature', 'temperature_f', '°F'), siteField('Rod angle', 'rod_angle_deg', 'deg'), siteField('Rod length', 'rod_length_ft', 'ft'), siteField('Wind', 'wind_speed_mph', 'mph'))));
    syncDirty();
    return el;
  });

  // ---- tab: motors (picker)
  const listOr = kind => { const v = val('paths.' + kind); if (Array.isArray(v) && v.length) return v; const d = val('paths.' + kind + '_dir'); return d ? [d] : []; };  // legacy single-folder config
  const motorsTab = () => asyncBlock(async () => {
    const o = ps.options || (ps.options = await api('/api/options'));
    const m = inp.motors;
    const el = h('div', { class: 'stack' },
      callout('info', 'Tick any mix of folders and files under ', h('code', null, 'input/'), ': one-motor ', h('code', null, '.eng'), ' files, multi-motor RASP ', h('code', null, '.eng'), ' files (every motor in them counts), and openMotor ', h('code', null, '.ric'), ' designs (simulated once with openMotor and cached). Every ticked booster motor is a candidate the optimizer will try; among the ticked sustainer motors the one with the highest total impulse is used. Ids must be unique: the file name for one-motor files and .ric designs, the designation inside multi-motor files.'),
      h('div', { class: 'grid c2' },
        motorPicker({ kind: 'boosters', title: 'Booster candidates', tree: o.motor_dirs, get: () => listOr('boosters'), set: v => setEdit('paths.boosters', v), ps, problems: inp.boosters.problems }),
        motorPicker({ kind: 'sustainers', title: 'Sustainer candidates', tree: o.motor_dirs, get: () => listOr('sustainers'), set: v => setEdit('paths.sustainers', v), ps, problems: inp.sustainers.problems, highlight: m ? m.sustainer.label : null })),
      m ? h('div', { class: 'card' }, h('h2', null, 'Motor set as currently saved', h('span', { class: 'right' }, 'what the pipeline will use after Save')),
        h('div', { class: 'stat-list' },
          stat('boosters', m.n_boosters),
          stat('booster impulse', m.booster_impulse_ns ? `${fmt(m.booster_impulse_ns[0] / 1000, 1)}–${fmt(m.booster_impulse_ns[1] / 1000, 1)}` : '—', 'kN·s'),
          stat('booster nozzle exit', m.booster_nozzle_in ? `${fmt(m.booster_nozzle_in[0], 2)}–${fmt(m.booster_nozzle_in[1], 2)}` : '—', 'in'),
          stat('sustainer used', m.sustainer.label, `${fmt(m.sustainer.total_impulse_ns, 0)} N·s · highest of ${m.n_sustainer_candidates}`)),
        m.boosters_missing_nozzle.length ? callout('warn', h('b', null, 'No nozzle exit diameter in: '), m.boosters_missing_nozzle.join(', '), ' — add a "Throat x in, exit y in" comment to the .eng or set rasaero.booster_nozzle_in.') : null) : callout('warn', 'The saved motor selection cannot be loaded — see the problems above.'));
    syncDirty();
    return el;
  });

  // ---- tab: mass
  const massTab = () => {
    const method = val('mass_model.method') || 'openrocket';
    const hw = val('mass_model.hardware_mass_lb');
    const t = mass.table, est = mass.estimate;
    const body = [];
    body.push(h('div', { class: 'form' },
      selField('Method', 'mass_model.method', [{ value: 'openrocket', label: 'openrocket – the .ork gives the mass distribution' }, { value: 'manual', label: 'manual – type the weights and CGs' }]),
      method === 'openrocket' ? numField('Vehicle hardware mass [lb]', 'mass_model.hardware_mass_lb', 'dry mass of the whole two-stage rocket: airframe, recovery, avionics, motor cases — everything except propellant. Empty = use the .ork masses as they are.', 0.5, { placeholder: 'use .ork masses', min: 0 }) : null));
    if (method === 'openrocket') {
      const items = [];
      if (est) {
        items.push(stat('propellant (from the .eng files)', `${fmt(est.sustainer_prop_lb, 1)} + ${est.booster_prop_lb ? `${fmt(est.booster_prop_lb[0], 1)}–${fmt(est.booster_prop_lb[1], 1)}` : '—'}`, 'lb sustainer + booster'));
        if (hw != null && est.booster_prop_lb) items.push(stat('loaded stack on the pad', `${fmt(hw + est.sustainer_prop_lb + est.booster_prop_lb[0], 0)}–${fmt(hw + est.sustainer_prop_lb + est.booster_prop_lb[1], 0)}`, 'lb = hardware + propellant'));
      }
      if (t && !t.error) {
        items.push(stat('mass table (computed)', `${fmt(t.combined_wt_lb[0], 0)}–${fmt(t.combined_wt_lb[1], 0)}`, `lb stack · sustainer ${fmt(t.sustainer_wt_lb, 1)} lb @ CG ${fmt(t.sustainer_cg_in, 1)} in`, t.stale ? 'warn' : 'ok'));
        if (t.sustainer_dry_lb != null) items.push(stat('dry split used' + (t.hardware_mass_lb != null ? '' : ' (.ork as-is)'), `${fmt(t.sustainer_dry_lb, 1)} + ${fmt(t.booster_dry_lb, 1)}`, `lb = ${fmt(t.sustainer_dry_lb + t.booster_dry_lb, 1)} lb sustainer + booster`));
      }
      body.push(h('div', { class: 'stat-list', style: { marginTop: '12px' } }, items));
      if (t && !t.error && t.stale) body.push(callout('warn', h('b', null, 'The mass table is out of date: '), `it was computed with ${t.hardware_mass_lb == null ? 'the .ork masses' : t.hardware_mass_lb + ' lb'}${hw == null ? ' but the config now says .ork masses' : hw !== t.hardware_mass_lb ? `, the config now says ${hw} lb` : ''}. Save, then run the mass stage (the optimizer does it automatically too).`));
      if (!t) body.push(callout('info', 'No mass table yet — it is computed by the mass stage (or by the optimizer) from the .ork with OpenRocket, using the hardware mass above.'));
      body.push(h('p', { class: 'muted small', style: { marginTop: '10px' } }, 'How it is applied: OpenRocket supplies each stage\'s dry mass, CG and motor position; both dry masses are scaled by one factor so the vehicle weighs the hardware mass empty, then the .eng propellant is added and the loaded weights / CGs RASAero needs are recombined. (The openrocket preview backend flies the unmodified .ork.)'));
    } else {
      const mp = 'mass_model.manual.';
      body.push(h('div', { class: 'form' },
        numField('Sustainer loaded weight [lb]', mp + 'sustainer_wt_lb'), numField('Sustainer CG [in from nose]', mp + 'sustainer_cg_in'),
        numField('Combined weight with the reference booster [lb]', mp + 'combined_wt_lb_ref'), numField('Combined CG with the reference booster [in]', mp + 'combined_cg_in_ref'),
        numField('Reference booster propellant [kg]', mp + 'ref_booster_prop_kg'), numField('Booster propellant CG [in from nose]', mp + 'booster_prop_cg_in', 'other boosters are derived by adding their propellant difference at this station')));
    }
    return h('div', { class: 'card' }, h('h2', null, 'Mass model', h('span', { class: 'right' }, runButton({ stage: 'mass', label: 'Compute mass table', cls: 'sm', disabled: dirty() > 0, title: dirty() ? 'save first' : '' }))), ...body);
  };

  // ---- tab: target & rules
  const targetTab = () => h('div', { class: 'grid c2' },
    h('div', { class: 'card' }, h('h2', null, 'Target'),
      h('div', { class: 'form' },
        numField('Target apogee [ft]', 'target.apogee_ft', 'what the search aims for', 1),
        numField('Tolerance [ft]', 'target.tolerance_ft', 'a design is "solved" when |apogee − target| ≤ tolerance', 1),
        selField('Simulation backend', 'backend', [{ value: 'python', label: 'python – integrator on RASAero aero tables (fast, on this Mac)' }, { value: 'rasaero', label: 'rasaero – RASAero GUI in the VM (slow, tool of record)' }, { value: 'openrocket', label: 'openrocket – preview only (different aero)' }], 'python needs steps 2–4 once; rasaero needs the VM worker for every simulation'))),
    h('div', { class: 'card' }, h('h2', null, 'Profile rules'),
      h('p', { class: 'muted small' }, 'Two staging profiles are designed so the booster never separates in the transonic band: subsonic (the attached stack stays below Mach 0.9 throughout) and supersonic (separation happens above Mach 1.2).'),
      h('div', { class: 'form' },
        numField('Subsonic profile: max Mach', 'profiles.subsonic_max_mach', 'the attached stack never exceeds this', 0.01),
        numField('Supersonic profile: min Mach at separation', 'profiles.supersonic_min_mach', 'separation must happen at or above this', 0.01),
        numField('Design margin (Mach)', 'profiles.mach_margin', 'applied to both limits', 0.01))),
    h('div', { class: 'card' }, h('h2', null, 'Staging delay windows'),
      h('p', { class: 'muted small' }, 'The optimizer searches both delays inside these windows. Separation is counted from booster burnout, ignition from separation (RASAero\'s convention), so ', h('b', null, 'ignition can never happen before burnout'), ' — both minimums are floored at 0 (0 = at burnout / at separation). The supersonic rule narrows each booster\'s separation window further.'),
      h('div', { class: 'form' },
        numField('Separation delay: min [s]', 'profiles.separation_delay_min_s', 'earliest booster separation after burnout (0 = at burnout)', 0.05, { min: 0 }),
        numField('Separation delay: max [s]', 'profiles.separation_delay_max_s', 'latest booster separation after burnout', 0.05, { min: 0 }),
        numField('Separation delays tried: step [s]', 'profiles.separation_step_s', 'min, min+step, …, max (at most 9 points)', 0.05, { min: 0.05 }),
        numField('Ignition delay: min [s]', 'profiles.ignition_delay_min_s', 'earliest sustainer ignition after separation (0 = at separation)', 0.1, { min: 0 }),
        numField('Ignition delay: max [s]', 'profiles.ignition_delay_max_s', 'latest sustainer ignition after separation', 0.5, { min: 0 }),
        numField('Ignition delays tried: step [s]', 'profiles.coarse_step_s', 'coarse grid before the bracket refinement', 0.1, { min: 0.05 }))));

  const tabs = subTabs(ps, 'tab', [['vehicle', 'Vehicle & site'], ['motors', 'Motors', `${inp.boosters.n} + ${inp.sustainers.n}`], ['mass', 'Mass', mass.hardware_mass_lb != null ? `${fmt(mass.hardware_mass_lb, 0)} lb` : '.ork'], ['target', 'Target & rules', `${fmt(cfg.target.apogee_ft, 0)} ft`]]);
  const body = { vehicle: vehicleTab, motors: motorsTab, mass: massTab, target: targetTab }[ps.tab || 'vehicle']();
  const page = stepPage({
    id: 'inputs',
    summary: 'Tell the tool which vehicle and motor files to use, how heavy the hardware is and what apogee to aim for. Changes are saved into config.yaml; Check then parses every input and reports anything the later steps would trip over.',
    action: {
      title: 'Check the inputs',
      prereqs: [
        { label: '.ork', ok: inp.ork.exists, hint: 'OpenRocket model file missing' },
        { label: '.CDX1', ok: inp.cdx1.exists, hint: 'RASAero model file missing' },
        { label: `${inp.boosters.n} boosters`, ok: inp.boosters.n > 0 && !inp.boosters.problems.length, hint: 'no booster files selected' },
        { label: `${inp.sustainers.n} sustainers`, ok: inp.sustainers.n > 0 && !inp.sustainers.problems.length, hint: 'no sustainer files selected' },
        { label: 'saved', ok: dirty() ? false : true, hint: 'save your changes first' }],
      buttons: [runButton({ stage: 'check', label: 'Check inputs', primary: true, disabled: dirty() > 0, title: dirty() ? 'save your changes first' : '' })],
      notes: [
        inp.problems.length ? callout('err', h('b', null, 'Problems: '), h('ul', null, inp.problems.map(p => h('li', null, p)))) : null,
        inp.last_check ? callout(inp.last_check.exit_code === 0 ? 'ok' : 'warn', h('b', null, inp.last_check.exit_code === 0 ? 'Last check passed' : 'Last check reported problems'), ` (${dateTime(inp.last_check.finished)}${inp.status === 'unchecked' ? ', but inputs changed since' : ''}). `, inp.last_check.exit_code === 0 ? '' : 'Open the activity log for the list.') : callout('info', 'Not checked yet — press ', h('b', null, 'Check inputs'), '. The output appears in the activity panel below.')],
      cmd: cmdPreview('check'),
    },
    content: [h('div', { class: 'card tabbed' }, tabs, body)],
    how: h('div', null,
      h('p', null, 'Everything on this page lives in ', h('code', null, 'config.yaml'), ' (the GUI edits values in place and keeps the comments). The four tabs: '),
      h('ul', null, h('li', null, h('b', null, 'Vehicle & site'), ' — the .ork (mass distribution) and .CDX1 (geometry, launch site) files; launch-site overrides.'), h('li', null, h('b', null, 'Motors'), ' — any mix of folders and .eng files for the booster candidates and the sustainer candidates.'), h('li', null, h('b', null, 'Mass'), ' — the hardware (dry) mass; the .ork only supplies the split and the CGs.'), h('li', null, h('b', null, 'Target & rules'), ' — target apogee, tolerance, the transonic-separation rules and the simulation backend.')),
      h('p', null, h('b', null, 'Check'), ' parses the motors, reads the CDX1, verifies the aero-table coverage for the selected nozzle sizes and counts the reference cases.')),
  });
  page.prepend(saveBar);
  syncDirty();
  return page;
};

/* Checkbox tree of every .eng under input/, grouped by folder. The config
   value is a list of folders and/or files; a fully ticked folder is stored
   as the folder path, a partially ticked one as its file paths. */
function motorPicker({ kind, title, tree, get, set, ps, problems = [], highlight }) {
  const wrap = h('div', { class: 'card picker' });
  const selectedFiles = () => {
    const sel = new Set();
    const unknown = [];
    for (const entry of get()) {
      const f = tree.find(d => d.path === entry);
      if (f) f.files.forEach(x => sel.add(x.path));
      else if (tree.some(d => d.files.some(x => x.path === entry))) sel.add(entry);
      else unknown.push(entry);
    }
    return { sel, unknown };
  };
  const store = (sel) => {
    const out = [];
    for (const d of tree) {
      const inside = d.files.filter(x => sel.has(x.path));
      if (inside.length === d.files.length && d.files.length) out.push(d.path);
      else inside.forEach(x => out.push(x.path));
    }
    set(out);
    draw();
  };
  const openKey = kind + ':';
  const draw = () => {
    const { sel, unknown } = selectedFiles();
    const q = (ps['q_' + kind] || '').toLowerCase();
    const nFolders = tree.filter(d => d.files.some(x => sel.has(x.path))).length;
    const nMotors = tree.reduce((n, d) => n + d.files.filter(x => sel.has(x.path)).reduce((m, x) => m + (x.n_motors || 1), 0), 0);
    wrap.innerHTML = '';
    wrap.append(h('h2', null, title, h('span', { class: 'right' }, `${nMotors} motor${nMotors === 1 ? '' : 's'} in ${sel.size} file${sel.size === 1 ? '' : 's'} from ${nFolders} folder${nFolders === 1 ? '' : 's'}`)));
    wrap.append(h('div', { class: 'toolbar' },
      h('input', { type: 'text', class: 'searchbox', placeholder: 'filter by name…', value: ps['q_' + kind] || '', oninput: e => { ps['q_' + kind] = e.target.value; draw(); const box = wrap.querySelector('.searchbox'); box.focus(); box.setSelectionRange(box.value.length, box.value.length); } }),
      h('span', { class: 'spacer' }),
      h('button', { class: 'btn sm', onclick: () => store(new Set()) }, 'clear all')));
    if (unknown.length) wrap.append(callout('warn', h('b', null, 'Not found under input/: '), unknown.join(', '), ' — they will be dropped when you change the selection.'));
    if (problems.length) wrap.append(callout('err', problems.join(' · ')));
    if (!tree.length) wrap.append(callout('info', 'No .eng files found under input/. Put motor files in a folder there and reload.'));
    for (const d of tree) {
      const files = d.files.filter(x => !q || x.name.toLowerCase().includes(q) || (x.designation || '').toLowerCase().includes(q));
      if (q && !files.length) continue;
      const nSel = d.files.filter(x => sel.has(x.path)).length;
      const all = nSel === d.files.length && d.files.length > 0;
      const cb = h('input', { type: 'checkbox', checked: all, onclick: e => { e.stopPropagation(); const next = new Set(sel); if (all) d.files.forEach(x => next.delete(x.path)); else d.files.forEach(x => next.add(x.path)); store(next); } });
      cb.indeterminate = nSel > 0 && !all;
      const open = openKey + d.path in ps.open ? ps.open[openKey + d.path] : nSel > 0 || !!q;
      const det = h('details', { class: 'folder', open, ontoggle: e => { ps.open[openKey + d.path] = e.target.open; } },
        h('summary', null, cb, h('span', { class: 'fname' }, d.path), h('span', { class: 'fcount ' + (nSel ? 'on' : '') }, `${nSel}/${d.files.length}`)),
        h('div', { class: 'files' }, files.map(x => {
          const on = sel.has(x.path);
          const bad = !!x.error;
          const many = (x.n_motors || 1) > 1;
          const ric = x.kind === 'ric';
          return h('label', { class: 'file ' + (on ? 'on' : '') + (bad ? ' bad' : '') + (highlight && x.label === highlight ? ' hi' : ''), title: x.error || x.path },
            h('input', { type: 'checkbox', checked: on, disabled: bad, onchange: () => { const next = new Set(sel); if (on) next.delete(x.path); else next.add(x.path); store(next); } }),
            h('span', { class: 'lbl' }, x.label),
            bad ? h('span', { class: 'badge err' }, 'unreadable') : ric && x.pending ? h('span', { class: 'meta' }, h('span', { class: 'badge warn' }, 'openMotor design'), ' not simulated yet — Check converts it (~1 s)') : many ? h('span', { class: 'meta' }, h('span', { class: 'badge info' }, `${x.n_motors} motors in this file`), ` · first: ${x.designation} · ${fmt((x.total_impulse_ns || 0) / 1000, 1)} kN·s`) : h('span', { class: 'meta' }, ric ? h('span', { class: 'badge info', title: 'openMotor .ric design, simulated with openMotor and cached' }, 'openMotor') : null, ric ? ' ' : '', `${fmt((x.total_impulse_ns || 0) / 1000, 1)} kN·s · ${fmt(x.burn_time_s, 1)} s · noz ${x.nozzle_exit_in != null ? fmt(x.nozzle_exit_in, 2) + ' in' : '?'}`),
            highlight && x.label === highlight ? h('span', { class: 'badge ok' }, 'used') : null);
        })));
      wrap.append(det);
    }
  };
  draw();
  return wrap;
}

// ---- step 2: aero tables -----------------------------------------------------
pages.aero = () => {
  const s = App.state, a = s.aero;
  const ps = pageState('aero', { sel: null });
  const rows = a.plan.map(r => ({ ...r, status: r.exists ? (a.stale ? 'stale' : 'ok') : 'todo' }));
  const chart = asyncBlock(async () => {
    const pick = ps.sel || (rows.find(r => r.exists) || (a.extra[0] ? { path: a.extra[0].path } : {})).path;
    if (!pick) return h('div', { class: 'muted small' }, 'no table to plot yet');
    const t = await cached('aero:' + pick, '/api/aero?path=' + encodeURIComponent(pick), 60000);
    const lim = t.mach.findIndex(m => m > 5.05);
    const cut = arr => lim > 0 ? arr.slice(0, lim) : arr;
    const choices = rows.filter(r => r.exists).map(r => [r.path, r.name]).concat(a.extra.map(e => [e.path, e.name]));
    return h('div', null,
      h('div', { class: 'row', style: { marginBottom: '8px' } }, h('span', { class: 'muted small' }, 'table:'), h('select', { style: { width: 'auto' }, onchange: e => { ps.sel = e.target.value; render(true); } }, choices.map(([pth, name]) => h('option', { value: pth, selected: pth === pick }, name)))),
      lineChart({ series: [{ name: 'CD power-off', x: cut(t.mach), y: cut(t.cd_off) }, { name: 'CD power-on', x: cut(t.mach), y: cut(t.cd_on) }], xLabel: 'Mach', yLabel: 'CD (ref. area from body diameter)', height: 260 }));
  });
  return stepPage({
    id: 'aero',
    summary: 'The fast Python simulator flies on RASAero\'s own drag curves. This exports them once per vehicle revision: the worker opens RASAero in the VM and saves Aero Plots for the full stack and for the sustainer alone, at the nozzle sizes and altitudes below.',
    action: {
      vm: true,
      prereqs: [{ label: 'CDX1', ok: s.inputs.cdx1.exists, hint: 'the RASAero model file is missing' }, { label: 'motors selected', ok: s.inputs.boosters.n > 0, hint: 'select booster files in step 1' }, { label: 'VM worker', ok: workerOk(s), hint: 'the worker does not seem to be running in the VM' }],
      buttons: [runButton({ stage: 'aero', label: a.n_have < a.n_plan ? `Export the ${a.n_plan - a.n_have} missing table(s)` : 'All planned tables present', primary: true, disabled: a.n_have === a.n_plan }), runButton({ stage: 'aero', args: ['--fresh'], label: 'Re-export everything', confirmText: `Re-export all ${a.n_plan} aero tables through RASAero in the VM (about a minute each), overwriting the existing files?` })],
      notes: [
        a.error ? callout('err', a.error) : null,
        a.stale ? callout('warn', 'The CDX1 is newer than these tables — re-export them if the geometry changed.') : null,
        a.covered && a.n_have < a.n_plan ? callout('ok', h('b', null, 'Coverage OK. '), `The tables present span the nozzle diameters of the current motor set, so the simulator can already run; the ${a.n_plan - a.n_have} planned table(s) would only refine the interpolation at this set's exact min/mid/max nozzle sizes.`) : null,
        !a.covered && a.coverage_problems && a.coverage_problems.length ? callout('warn', h('b', null, 'Coverage problems: '), h('ul', null, a.coverage_problems.map(x => h('li', null, x)))) : null,
        workerNote(s)],
      cmd: cmdPreview('aero'),
    },
    content: [
      h('div', { class: 'split' },
        h('div', { class: 'card' }, h('h2', null, `Planned tables (${a.n_have}/${a.n_plan} present)`, h('span', { class: 'right' }, `altitudes ${a.settings.altitudes_ft.join(', ')} ft · nozzles: ${a.settings.stack_nozzles_in === 'auto' ? 'min / mid / max of the booster set' : a.settings.stack_nozzles_in}`)),
          dataTable({ columns: ['config', 'nozzle_in', 'altitude_ft', 'name', 'status', 'mtime'], rows, labels: { nozzle_in: 'nozzle exit [in]', altitude_ft: 'altitude [ft]', name: 'file', mtime: 'exported' }, format: { status: v => badge(v), mtime: v => v ? ago(v) : '—', altitude_ft: v => fmt(v, 0) }, onRow: r => { if (r.exists) { ps.sel = r.path; render(true); } }, rowKey: r => r.path, selected: ps.sel }),
          a.extra.length ? h('div', { class: 'muted small', style: { marginTop: '10px' } }, `${a.extra.length} other table(s) in ${a.dir} are also loaded and interpolated: ${a.extra.map(e => e.name).join(', ')}`) : null),
        h('div', { class: 'card' }, h('h2', null, 'Drag curve'), chart))],
    how: h('ol', { class: 'howto' },
      h('li', null, 'The worker opens the CDX1 with the chosen nozzle written into the design and every simulation row (power-on CD depends on it).'),
      h('li', null, h('b', null, 'Options → Mach-Alt'), ' is set to the table altitude so the Reynolds number matches the flight regime.'),
      h('li', null, h('b', null, 'Aero Plots'), ' is opened for “Sustainer + Booster” (stack) or “Sustainer” and exported to CSV (Mach 0.01–25).'),
      h('li', null, 'The CSV lands in ', h('code', null, a.dir), ' as ', h('code', null, '<stack|sustainer>_alt<ft>_noz<in>.csv'), '; the simulator interpolates between nozzle diameters and altitudes. Tables depend only on the geometry, so they survive motor changes.')),
  });
};

// ---- step 3: reference flights ----------------------------------------------
pages.reference = () => {
  const s = App.state, r = s.reference;
  const ps = pageState('reference', { cases: 8, sel: null });
  const chart = asyncBlock(async () => {
    const pick = ps.sel || (r.cases[0] || {}).name;
    if (!pick) return h('div', { class: 'muted small' }, 'no reference flight yet');
    const path = `${r.dir}/${pick}.csv`;
    const t = await cached('hist:' + path, '/api/history?path=' + encodeURIComponent(path), 60000);
    return historyChart(t, pick);
  });
  return stepPage({
    id: 'reference',
    summary: 'A handful of complete flights are simulated in RASAero itself and their full View Data exports are stored. They are the ground truth the Python simulator is validated against (step 4), and RASAero\'s air-density profile is recovered from them. Cases spread over the booster set and over short and long coasts.',
    action: {
      vm: true,
      prereqs: [{ label: 'aero tables', ok: s.aero.n_have > 0 || s.aero.covered, hint: 'export the aero tables first (step 2)' }, { label: 'mass table', ok: !!(s.mass.table && !s.mass.table.error), hint: 'computed on demand from the .ork' }, { label: 'VM worker', ok: workerOk(s), hint: 'the worker does not seem to be running in the VM' }],
      buttons: [runButton({ stage: 'reference', args: ['--cases', String(ps.cases)], label: `Export ${ps.cases} reference flight${ps.cases === 1 ? '' : 's'}`, primary: true })],
      options: h('label', { class: 'check' }, 'cases', h('input', { type: 'number', min: 1, max: 30, value: ps.cases, class: 'inline-num', onchange: e => { ps.cases = Number(e.target.value) || 8; render(true); } }), h('span', { class: 'muted small' }, '(about 2 min each; 8 is plenty)')),
      notes: [
        r.n && r.n < 5 ? callout('warn', `${r.n} case(s) so far — at least 5 give a meaningful validation and density calibration.`) : null,
        r.stale ? callout('warn', 'The CDX1 is newer than these flights — export fresh ones if the vehicle changed.') : null,
        workerNote(s)],
      cmd: cmdPreview('reference', ['--cases', String(ps.cases)]),
    },
    content: [
      h('div', { class: 'split' },
        h('div', { class: 'card' }, h('h2', null, `Reference cases (${r.n})`),
          r.n ? dataTable({ columns: ['name', 'booster', 'sep_delay_s', 'ign_delay_s', 'apogee_ft', 'max_vel_fps', 'mtime'], rows: r.cases, labels: { sep_delay_s: 'sep [s]', ign_delay_s: 'ign [s]', apogee_ft: 'RASAero apogee [ft]', max_vel_fps: 'max vel [fps]', mtime: 'exported' }, format: { mtime: v => ago(v), apogee_ft: v => fmt(v, 0), max_vel_fps: v => fmt(v, 0) }, onRow: row => { ps.sel = row.name; render(true); }, rowKey: row => row.name, selected: ps.sel || (r.cases[0] || {}).name }) : h('div', { class: 'muted' }, 'none yet'),
          h('div', { class: 'sep' }),
          kv([
            ['density calibration', r.calibration.exists ? `${r.calibration.info ? `${r.calibration.info.bins} bins, ${fmt(r.calibration.info.alt_min_ft, 0)}–${fmt(r.calibration.info.alt_max_ft, 0)} ft` : 'present'} (${ago(r.calibration.mtime)})` : h('span', { class: 'badge todo' }, 'not yet — written by this step and by validate')],
            ['delay convention', 'separation delay from burnout; ignition delay from separation (RASAero)'],
          ])),
        h('div', { class: 'card' }, h('h2', null, 'Flight (RASAero export)'), chart))],
    how: h('p', null, 'Each case is one RASAero simulation row (booster, separation delay, ignition delay) with the masses from the mass table. The worker runs it, opens View Data and exports the full time history at 0.01 s; the export and the row inputs are stored side by side in ', h('code', null, r.dir), '. The density profile RASAero used is recovered from the coast phases of these exports (ρ = 2D / V²·S·CD) and reused by the Python simulator.'),
  });
};

// ---- step 4: validate --------------------------------------------------------
pages.validate = () => {
  const s = App.state, v = s.validate;
  const ps = pageState('validate', { sel: null });
  const tol = v.tolerances;
  const sel = ps.sel || (v.rows[0] || {}).case;
  const selRow = v.rows.find(r => r.case === sel);
  return stepPage({
    id: 'validate',
    summary: 'Runs every reference flight through the Python simulator and compares it with RASAero term by term. Takes seconds. Re-run it whenever the vehicle, the aero tables or the simulator change; the optimizer should not be trusted while this fails.',
    action: {
      prereqs: [{ label: `${s.reference.n} reference flights`, ok: s.reference.n > 0, hint: 'export reference flights first (step 3)' }, { label: 'aero tables', ok: s.aero.n_have > 0 || s.aero.covered, hint: 'export the aero tables first (step 2)' }],
      buttons: [runButton({ stage: 'validate', label: 'Run validation', primary: true, disabled: !s.reference.n || !(s.aero.n_have || s.aero.covered) })],
      notes: [
        v.stale ? callout('warn', 'The reference flights or aero tables are newer than this validation — re-run it.') : null,
        v.n ? callout(v.n_pass === v.n ? 'ok' : 'warn', h('b', null, `${v.n_pass}/${v.n} cases pass`), ` (apogee within ${tol.apogee_tol_pct} %, Mach at burnout within ${tol.mach_at_burnout_tol}, CD within ${tol.cd_tol_pct} %, weight within ${tol.weight_tol_lb} lb, atmosphere/Mach within ${tol.mach_tol}). `, v.n_pass < v.n ? 'A case that lights the sustainer at near-zero velocity (a long coast past apogee) is degenerate and expected to miss; any other failure means the simulator does not match this vehicle.' : '') : null],
      cmd: cmdPreview('validate'),
    },
    content: [
      h('div', { class: 'card' }, h('h2', null, 'Cases', h('span', { class: 'right' }, 'click a row to see its overlay plot')),
        v.n ? dataTable({ columns: ['case', 'sep_delay_s', 'ign_delay_s', 'apogee_ref_ft', 'apogee_ours_ft', 'apogee_err_pct', 'mach_burnout_ref', 'mach_burnout_ours', 'mach_burnout_err', 'cd_median_err_pct', 'cd_p95_err_pct', 'mach_max_abs_err', 'weight_max_abs_err_lb', 'pass', 'fail_reasons'], rows: v.rows,
          labels: { sep_delay_s: 'sep', ign_delay_s: 'ign', apogee_ref_ft: 'RASAero apogee', apogee_ours_ft: 'python apogee', apogee_err_pct: 'apogee err %', mach_burnout_ref: 'M@bo RAS', mach_burnout_ours: 'M@bo py', mach_burnout_err: 'M@bo err', cd_median_err_pct: 'CD med %', cd_p95_err_pct: 'CD p95 %', mach_max_abs_err: 'atm Mach err', weight_max_abs_err_lb: 'weight err lb', fail_reasons: 'why' },
          format: { pass: v2 => badge(v2 ? 'ok' : 'err', v2 ? 'PASS' : 'FAIL'), apogee_ref_ft: x => fmt(x, 0), apogee_ours_ft: x => fmt(x, 0), apogee_err_pct: x => isNum(x) ? (x >= 0 ? '+' : '') + x.toFixed(2) : '—', mach_burnout_err: x => fmt(x, 4), mach_max_abs_err: x => fmt(x, 4), mach_burnout_ref: x => fmt(x, 3), mach_burnout_ours: x => fmt(x, 3) },
          cellClass: (c, x) => (c === 'apogee_err_pct' && isNum(x) && Math.abs(x) > tol.apogee_tol_pct) || (c === 'mach_burnout_err' && isNum(x) && Math.abs(x) > tol.mach_at_burnout_tol) ? 'hl' : '',
          onRow: r => { ps.sel = r.case; render(true); }, rowKey: r => r.case, selected: sel, wrap: ['fail_reasons'] }) : h('div', { class: 'muted' }, 'no validation yet')),
      selRow && selRow.png ? h('div', { class: 'card' }, h('h2', null, `Overlay: ${selRow.case}`, h('span', { class: 'right' }, 'python (dashed) over RASAero (solid); click to enlarge')), h('div', { class: 'plot', onclick: () => lightbox('/files/' + selRow.png + '?t=' + (v.file.mtime || 0)) }, h('img', { src: '/files/' + selRow.png + '?t=' + (v.file.mtime || 0) }))) : null],
    how: h('p', null, 'For each reference case the Python simulator flies the same row and the two histories are compared: the atmosphere (Mach recomputed from RASAero\'s own velocity and altitude), the CD lookup at RASAero\'s Mach, the reconstructed drag, the weight and thrust histories (nearest sample within ±2 steps), then apogee, time to apogee and Mach at burnout. Results go to ', h('code', null, 'output/validation/'), ' with an overlay plot per case.'),
  });
};

// ---- step 5: optimize --------------------------------------------------------
pages.optimize = () => {
  const s = App.state, o = s.optimize, cfg = s.config;
  const ps = pageState('optimize', { fresh: false, limit: '', boosters: '', unsolved: true, decel: false, backend: '' });
  const args = () => {
    const a = [];
    if (ps.fresh) a.push('--fresh');
    if (ps.backend) a.push('--backend', ps.backend);
    if (ps.limit) a.push('--limit', String(ps.limit));
    if (ps.boosters.trim()) a.push('--boosters', ps.boosters.trim());
    if (ps.unsolved) a.push('--include-unsolved');
    if (ps.decel) a.push('--decel-subsonic');
    return a;
  };
  const chk = (label, key, hint) => h('label', { class: 'check', title: hint || '' }, h('input', { type: 'checkbox', checked: ps[key], onchange: e => { ps[key] = e.target.checked; render(true); } }), label);
  const r = s.runner;
  const running = r.running && RUN_STAGES.includes(r.stage);
  const backend = ps.backend || cfg.backend;
  const sub = o.substages.map(st => {
    const isRun = running && (r.substage === st.name || r.stage === st.name);
    const desc = { motors: 'parse .eng, pick sustainer, stage motor files', mass: 'OpenRocket: weight & CG per booster', characterize: 'one long-coast flight per booster → Mach at burnout, eligibility', search: 'ignition-delay sweep + bracket refinement per (booster, profile)', verify: 'full time history of each solution, rule check', report: 'report.md, ranked designs, plots' }[st.name];
    return h('div', { class: 'substage ' + (isRun ? 'running' : st.done ? (st.stale ? 'stale' : 'done') : '') }, h('span', { class: 'i' }), h('div', null, h('div', { class: 't' }, st.name, ' ', isRun && r.progress && r.progress.total ? h('span', { class: 'muted small' }, `${r.progress.done}/${r.progress.total}`) : isRun && r.progress && r.progress.round !== undefined ? h('span', { class: 'muted small' }, `round ${r.progress.round}`) : null), h('div', { class: 'd' }, isRun ? 'running…' : st.done ? (st.stale ? 'out of date · ' : '') + ago(st.mtime) : desc)));
  });
  const backendNote = backend === 'python' ? (s.validate.status === 'ok' ? null : callout('warn', h('b', null, 'The python simulator is not validated for this vehicle yet '), `(step 4: ${STATUS_TEXT[s.validate.status] || s.validate.status}). It will still run, but treat the numbers with care until validation passes.`)) : backend === 'rasaero' ? callout('info', 'RASAero backend: every simulation batch goes through the VM worker — expect hours for 60 boosters.') : callout('info', 'OpenRocket backend: preview only, its aerodynamics differ from RASAero.');
  return stepPage({
    id: 'optimize',
    summary: `For every booster: one long-coast flight characterizes the attached stack and decides which profiles it is eligible for; then, for each eligible (booster, profile), separation delays ${fmt(cfg.profiles.separation_delay_min_s)}–${fmt(cfg.profiles.separation_delay_max_s)} s and ignition delays ${fmt(cfg.profiles.ignition_delay_min_s)}–${fmt(cfg.profiles.ignition_delay_max_s)} s are searched until the apogee hits ${fmt(cfg.target.apogee_ft, 0)} ± ${fmt(cfg.target.tolerance_ft, 0)} ft. Solutions are re-flown with a full time history and checked against the profile rule.`,
    action: {
      prereqs: [{ label: 'inputs checked', ok: s.inputs.status === 'ok' ? true : s.inputs.status === 'error' ? false : 'warn', hint: s.inputs.status === 'error' ? 'fix the input problems in step 1' : 'inputs not checked since they changed' }, backend === 'python' ? { label: 'simulator validated', ok: s.validate.status === 'ok' ? true : 'warn', hint: 'validation not passing' } : { label: 'VM worker', ok: workerOk(s), hint: 'the worker does not seem to be running' }, { label: `mass ${s.mass.hardware_mass_lb != null ? s.mass.hardware_mass_lb + ' lb' : '.ork'}`, ok: true }],
      buttons: [running ? h('button', { class: 'btn danger', onclick: cancelRun }, 'Cancel run') : runButton({ stage: 'run', args: args(), label: 'Run the optimizer (all stages)', primary: true, confirmText: ps.fresh ? 'Fresh run: the cached mass table, characterization, eligibility and designs in output/ will be deleted and recomputed. Continue?' : null })],
      options: h('div', { class: 'stack', style: { gap: '8px' } },
        h('div', { class: 'row' },
          chk('Fresh run (recompute cached stages)', 'fresh', 'deletes mass_table/characterization/eligibility/designs before running'),
          chk('Keep a full history of the closest design of every booster', 'unsolved', '--include-unsolved: verify unsolved designs too'),
          chk('Also try "decelerate below Mach 0.9, then separate"', 'decel', 'a supersonic booster coasts attached and separates subsonic; crosses the transonic band twice')),
        h('div', { class: 'row' },
          h('label', { class: 'check' }, 'backend', h('select', { style: { width: 'auto' }, onchange: e => { ps.backend = e.target.value; render(true); } }, [['', `config (${cfg.backend})`], ['python', 'python'], ['rasaero', 'rasaero (VM)'], ['openrocket', 'openrocket (preview)']].map(([v, l]) => h('option', { value: v, selected: ps.backend === v }, l)))),
          h('label', { class: 'check' }, 'only the first', h('input', { type: 'number', min: 1, class: 'inline-num', value: ps.limit, placeholder: 'all', onchange: e => { ps.limit = e.target.value; render(true); } }), 'boosters'),
          h('label', { class: 'check' }, 'only', h('input', { type: 'text', value: ps.boosters, placeholder: 'e.g. 01,32,60 or labels', style: { width: '200px' }, onchange: e => { ps.boosters = e.target.value; render(true); } })))),
      notes: [backendNote, o.stale && !running ? callout('warn', 'Inputs changed since the last run — tick "fresh run" so every stage is recomputed.') : null],
      cmd: cmdPreview('run', args()),
    },
    content: [
      h('div', { class: 'card' }, h('h2', null, 'Stages', h('span', { class: 'right' }, o.last_run ? `last full run: ${outcomeText(o.last_run)}, ${dur(o.last_run.elapsed_s)}, ${dateTime(o.last_run.finished)}` : 'not run from this GUI yet')),
        h('div', { class: 'substages' }, sub),
        running ? h('div', { class: 'row', style: { marginTop: '10px' } }, h('div', { class: 'progress ' + (r.progress && r.progress.total ? '' : 'indet') }, h('div', { style: { width: (r.progress && r.progress.total ? 100 * r.progress.done / r.progress.total : 30) + '%' } })), h('span', { class: 'muted small' }, `${r.substage || r.stage} · ${dur(r.elapsed_s)}${eta(r) ? ' · ' + eta(r) : ''}`)) : null,
        h('div', { class: 'sep' }),
        h('p', { class: 'muted small' }, 'Run a single stage (it reads the previous stage\'s files from output/ and recomputes them if missing) — useful after changing the target (search → verify → report) or the profile rules (characterize onwards):'),
        h('div', { class: 'row' }, ['motors', 'mass', 'characterize', 'search', 'verify', 'report'].map(st => runButton({ stage: st, args: args().filter(a => a !== '--fresh'), label: st, cls: 'sm' })))),
      h('div', { class: 'card' }, h('h2', null, 'Output files'), h('div', { class: 'filelist' }, o.substages.flatMap(st => st.files.map(f => fileRow(f, { stale: st.stale })))))],
    how: h('ol', { class: 'howto' },
      h('li', null, h('b', null, 'motors'), ' — parse the .eng files, pick the max-impulse sustainer, stage the files for RASAero.'),
      h('li', null, h('b', null, 'mass'), ' — OpenRocket: sustainer and stack weight/CG per booster, scaled to the hardware mass.'),
      h('li', null, h('b', null, 'characterize'), ' — one long-coast flight per booster (separation and ignition 15 s late): peak boost Mach, Mach at burnout, how long after burnout the stack drops below Mach 1.2 / 0.9 → which profiles each booster is eligible for.'),
      h('li', null, h('b', null, 'search'), ' — per eligible (booster, profile) and per separation delay on the grid: a coarse ignition-delay grid, then bracket refinement until the apogee is within tolerance. The best per (booster, profile) is kept: solved first, then the smallest miss, then the shortest coast (highest velocity at ignition).'),
      h('li', null, h('b', null, 'verify'), ' — full time history of every solution; Mach at separation, velocity/altitude at ignition, max acceleration; pass/fail against the profile rule.'),
      h('li', null, h('b', null, 'report'), ' — report.md, ranked designs, plots.')),
  });
};

// ---- step 6: results ---------------------------------------------------------
pages.results = () => {
  const s = App.state, d = s.results, cfg = s.config;
  const ps = pageState('results', { tab: 'designs', sel: null, filter: 'all' });
  if (!d.n) return stepPage({ id: 'results', summary: 'Designs, eligibility, characterization, time histories, plots and the written report.', content: [callout('info', 'No results yet — run the optimizer (step 5).')] });
  const tabs = subTabs(ps, 'tab', [['designs', 'Designs', d.n], ['eligibility', 'Eligibility'], ['characterization', 'Characterization'], ['plots', 'Plots'], ['report', 'Report']]);
  let body;
  if (ps.tab === 'designs') body = designsTab(ps, d, cfg);
  else if (ps.tab === 'eligibility') body = asyncBlock(async () => {
    const t = await cached('t:eligibility', '/api/table/eligibility');
    return h('div', null,
      h('p', { class: 'muted small' }, `subsonic: the attached stack must stay below Mach ${cfg.profiles.subsonic_max_mach} − ${cfg.profiles.mach_margin} throughout boost. supersonic: separation must happen at or above Mach ${cfg.profiles.supersonic_min_mach} + ${cfg.profiles.mach_margin}; the physics limit is how long after burnout that is still true, and the searched separation window (sep min–max) is your window clipped to it.`),
      dataTable({ columns: t.columns, rows: t.rows, labels: { sep_min_s: 'sep min [s]', sep_max_s: 'sep max [s]', sep_window_max_s: 'physics limit [s]' }, format: { eligible: v => badge(v ? 'ok' : 'todo', v ? 'eligible' : 'no') }, wrap: ['reason'], rowClass: r => r.eligible ? '' : 'dim' }));
  });
  else if (ps.tab === 'characterization') body = asyncBlock(async () => {
    const t = await cached('t:characterization', '/api/table/characterization');
    return h('div', null,
      h('p', { class: 'muted small' }, 'One long-coast flight per booster with the fixed sustainer (attached stack). t_below_* = seconds after burnout until the stack drops below Mach 1.2 / 0.9.'),
      lineChart({ series: [{ name: 'Mach at burnout', x: t.rows.map((_, i) => i + 1), y: t.rows.map(r => r.mach_burnout), points: true }, { name: 'peak boost Mach', x: t.rows.map((_, i) => i + 1), y: t.rows.map(r => r.max_mach_boost), points: true }], xLabel: 'booster #', yLabel: 'Mach', height: 220, refs: [{ y: cfg.profiles.supersonic_min_mach + cfg.profiles.mach_margin, label: 'supersonic limit + margin', color: '#dc2626' }, { y: cfg.profiles.subsonic_max_mach - cfg.profiles.mach_margin, label: 'subsonic limit − margin', color: '#16a34a' }] }),
      dataTable({ columns: t.columns, rows: t.rows, hide: ['note'], format: { events_consistent: v => badge(v ? 'ok' : 'err', v ? 'ok' : 'mismatch') }, maxHeight: '480px' }));
  });
  else if (ps.tab === 'plots') body = h('div', { class: 'grid c2' }, s.plots.length ? s.plots.map(p => h('div', { class: 'card tight' }, h('h3', null, p.name, h('span', { class: 'right' }, ago(p.mtime))), h('div', { class: 'plot', onclick: () => lightbox('/files/' + p.path + '?t=' + p.mtime) }, h('img', { src: '/files/' + p.path + '?t=' + p.mtime })))) : callout('info', 'no plots — run the report stage'));
  else body = asyncBlock(async () => { const rr = await api('/api/report'); return rr.exists ? mdRender(rr.text) : callout('info', 'no report.md yet — run the report stage'); });
  return stepPage({
    id: 'results',
    summary: 'Every (booster, profile) candidate with the delays found, its apogee and status. Click a design for its apogee-vs-delay curve and time history.',
    action: {
      title: 'Results',
      buttons: [h('button', { class: 'btn', onclick: () => api('/api/reveal', { body: { path: 'output' } }).catch(e => toast(e.message, 'err')) }, 'Reveal output folder'), runButton({ stage: 'report', label: 'Rebuild report & plots' })],
      options: h('div', { class: 'stat-list' },
        stat('target', fmt(d.target_ft, 0), 'ft'),
        stat('designs', d.n),
        stat('solved', d.n_solved, null, d.n_solved ? 'ok' : 'warn'),
        stat('verified ok', d.n_verified_ok),
        ...Object.entries(d.counts || {}).filter(([k]) => k !== 'solved').map(([k, v]) => stat(k, v)),
        ...Object.entries(d.eligibility || {}).map(([p, v]) => stat(`${p} eligible`, `${v.eligible}/${v.total}`)),
        d.characterization ? stat('Mach at burnout', `${fmt(d.characterization.mach_burnout_min, 2)}–${fmt(d.characterization.mach_burnout_max, 2)}`) : null,
        d.sustainer ? stat('sustainer', d.sustainer.label, `${fmt(d.sustainer.total_impulse_ns, 0)} N·s`) : null,
        s.mass.table && !s.mass.table.error ? stat('pad weight', `${fmt(s.mass.table.combined_wt_lb[0], 0)}–${fmt(s.mass.table.combined_wt_lb[1], 0)}`, 'lb') : null),
    },
    content: [h('div', { class: 'card tabbed' }, tabs, body)],
    how: h('p', null, h('b', null, 'Status: '), 'solved = an ignition delay hits the target within tolerance · overpowered = apogee stays above the target even at the shortest allowed coast · underpowered = even the best coast falls short · unsolved = a bracket was found but did not converge. ', h('b', null, 'Δ target'), ' is apogee − target. Rows are ordered by |Δ target|; click any row for details.'),
  });
};

// ---- step 7: confirm ---------------------------------------------------------
pages.confirm = () => {
  const s = App.state, c = s.confirm, d = s.results;
  const ps = pageState('confirm', { top: 3, unsolved: true });
  const args = ['--top', String(ps.top), ...(ps.unsolved ? ['--include-unsolved'] : [])];
  return stepPage({
    id: 'confirm',
    summary: 'The designs closest to the target are written into one CDX1 and re-run through RASAero II in the VM — the tool of record — and RASAero\'s apogee is compared with the Python simulator\'s. Use it to sign off on the final choice.',
    action: {
      vm: true,
      prereqs: [{ label: `${d.n || 0} designs`, ok: d.n > 0, hint: 'run the optimizer first (step 5)' }, { label: 'VM worker', ok: workerOk(s), hint: 'the worker does not seem to be running in the VM' }],
      buttons: [runButton({ stage: 'confirm', args, label: `Confirm the top ${ps.top} in RASAero`, primary: true, disabled: !d.n })],
      options: h('div', { class: 'row' }, h('label', { class: 'check' }, 'designs', h('input', { type: 'number', min: 1, max: 100, class: 'inline-num', value: ps.top, onchange: e => { ps.top = Number(e.target.value) || 3; render(true); } })), h('label', { class: 'check' }, h('input', { type: 'checkbox', checked: ps.unsolved, onchange: e => { ps.unsolved = e.target.checked; render(true); } }), 'include unsolved designs (the closest ones when nothing is solved)')),
      notes: [
        d.n && !d.n_solved && !ps.unsolved ? callout('warn', 'There are no solved designs; tick “include unsolved” to confirm the closest ones.') : null,
        c.stale ? callout('warn', 'designs.csv is newer than this confirmation — re-run it.') : null,
        workerNote(s)],
      cmd: cmdPreview('confirm', args),
    },
    content: [
      h('div', { class: 'card' }, h('h2', null, 'RASAero vs python', h('span', { class: 'right' }, c.file.exists ? ago(c.file.mtime) : '')),
        c.rows.length ? h('div', null,
          h('div', { class: 'stat-list', style: { marginBottom: '12px' } }, stat('designs confirmed', c.rows.length), stat('max |difference|', fmt(Math.max(...c.rows.map(r => Math.abs(r.diff_pct || 0))), 2), '%', Math.max(...c.rows.map(r => Math.abs(r.diff_pct || 0))) < 1 ? 'ok' : 'warn'), stat('mean difference', fmt(c.rows.reduce((a, r) => a + (r.diff_pct || 0), 0) / c.rows.length, 2), '%')),
          dataTable({ columns: ['booster', 'profile', 'sep_delay_s', 'ign_delay_s', 'apogee_python_ft', 'apogee_rasaero_ft', 'diff_ft', 'diff_pct', 'max_vel_rasaero_fps', 't_apogee_rasaero_s'], rows: c.rows, labels: { sep_delay_s: 'sep [s]', ign_delay_s: 'ign [s]', apogee_python_ft: 'python apogee', apogee_rasaero_ft: 'RASAero apogee', diff_ft: 'Δ ft', diff_pct: 'Δ %', max_vel_rasaero_fps: 'RASAero max vel', t_apogee_rasaero_s: 'RASAero t apogee' }, format: { apogee_python_ft: v => fmt(v, 0), apogee_rasaero_ft: v => fmt(v, 0), diff_ft: v => isNum(v) ? (v > 0 ? '+' : '') + fmt(v, 0) : '—', diff_pct: v => isNum(v) ? (v > 0 ? '+' : '') + v.toFixed(2) : '—' } })) : h('div', { class: 'muted' }, 'nothing confirmed yet'))],
    how: h('p', null, 'One batched CDX1 with the chosen rows goes through the VM worker (File → Open, Rerun All Simulations, Save As); RASAero writes MaxAltitude back into the file, and the comparison is stored in ', h('code', null, 'output/confirm.csv'), '.'),
  });
};

// ---- worker & jobs -----------------------------------------------------------
pages.worker = () => {
  const s = App.state, w = s.worker;
  const ps = pageState('worker', { sel: null });
  const jobDetail = asyncBlock(async () => {
    if (!ps.sel) return h('div', { class: 'muted small' }, 'select a job');
    const j = await api('/api/job/' + encodeURIComponent(ps.sel));
    return h('div', { class: 'stack' },
      kv([['job', j.name], ['type', `${j.type} (${j.n_rows} rows)`], ['created', j.created], ['claimed', j.claimed_at || '—'], ['result', j.done ? `${j.done.status}${j.done.message ? ': ' + j.done.message : ''} in ${dur(j.done.elapsed_s)} (${j.done.finished})` : j.state]]),
      j.images.length ? h('div', { class: 'gallery' }, j.images.map(im => h('figure', { onclick: () => lightbox('/files/' + im) }, h('img', { src: '/files/' + im, loading: 'lazy' }), h('figcaption', null, im.split('/').pop())))) : null,
      h('div', { class: 'console' }, j.worker_log.join('\n') || 'no worker.log'),
      h('div', { class: 'filelist' }, j.files.map(f => fileRow(f))));
  });
  return h('div', { class: 'stack' },
    h('div', { class: 'page-head' }, h('div', null, h('h1', null, 'RASAero worker & jobs'), h('div', { class: 'desc' }, 'RASAero II only runs in the Windows VM. Steps 2, 3 and 7 (and the rasaero backend) write job folders into jobs/; the worker in the VM polls that folder, drives RASAero, and writes the results back. Everything the worker does is logged here.')),
      h('div', { class: 'actions' }, h('button', { class: 'btn', onclick: () => api('/api/reveal', { body: { path: 'jobs' } }).catch(e => toast(e.message, 'err')) }, 'Reveal jobs folder'), runButton({ stage: 'inspect', label: 'Inspect RASAero GUI (debug)' }))),
    h('div', { class: 'grid c2' },
      workerCard(s),
      h('div', { class: 'card' }, h('h2', null, 'Starting and stopping the worker'),
        h('p', null, h('b', null, 'Start VM worker'), ' does everything: boots the UTM VM if it is off, waits for Windows, registers a scheduled task bound to the logged-on user (that is what puts the worker on the desktop, where it can drive RASAero), starts it, and waits for the worker\'s heartbeat on the share. The task also runs at every Windows logon, so after the first time the worker comes up on its own.'),
        h('ul', { class: 'howto' },
          h('li', null, 'Windows must have a user logged on (enable auto-login in the VM to make this hands-off).'),
          h('li', null, 'The worker\'s console window appears on the VM desktop; leave it alone while jobs run — it moves the mouse and types into RASAero.'),
          h('li', null, 'Manual fallback: ', h('code', null, 'python Z:\\worker\\run_worker.py'), ' in a PowerShell window inside the VM.')),
        h('div', { class: 'row', style: { marginTop: '8px' } }, h('button', { class: 'btn sm', onclick: async e => { const b = e.currentTarget; b.disabled = true; b.prepend(spinner()); try { const g = await api('/api/vm/guest'); ps.guest = g; } catch (err) { ps.guest = { error: err.message }; } render(true); } }, 'Query the guest (who is logged on, task state, worker processes)'),
          ps.guest ? h('span', { class: 'small ' + (ps.guest.error ? '' : 'muted'), style: ps.guest.error ? { color: 'var(--err)' } : null }, ps.guest.error ? ps.guest.error : `user ${ps.guest.user || 'nobody'} · task ${ps.guest.task} · ${(ps.guest.workers || []).length} worker process(es)${(ps.guest.workers || []).length ? ' (pid ' + ps.guest.workers.map(x => x.pid).join(', ') + ')' : ''} · ${ps.guest.time}`) : null))),
    h('div', { class: 'card' }, h('h2', null, 'Worker console', h('span', { class: 'right' }, w.last_seen ? `worker/console.log · ${ago(w.last_seen)}` : 'no console.log')), h('div', { class: 'console' }, (w.console_tail || []).join('\n') || 'nothing yet')),
    h('div', { class: 'split' },
      h('div', { class: 'card' }, h('h2', null, `Jobs (${w.jobs.length} most recent)`, h('span', { class: 'right' }, h('input', { type: 'text', class: 'searchbox', placeholder: 'filter jobs…', value: ps.q || '', oninput: e => { ps.q = e.target.value; const q = ps.q.toLowerCase(); for (const tr of $('#main').querySelectorAll('.jobs-table tbody tr')) tr.hidden = q && !tr.textContent.toLowerCase().includes(q); } }))),
        h('div', { class: 'jobs-table' }, dataTable({ columns: ['name', 'type', 'n_rows', 'state', 'created', 'done'], rows: ps.q ? w.jobs.filter(j => `${j.name} ${j.type} ${j.state}`.toLowerCase().includes(ps.q.toLowerCase())) : w.jobs, labels: { n_rows: 'rows' }, format: { state: v => badge({ ok: 'ok', failed: 'err', running: 'running', queued: 'queued', empty: 'todo' }[v] || 'todo', v), done: v => v ? `${dur(v.elapsed_s)}` : '—', created: v => v ? v.replace('T', ' ') : '—' }, onRow: r => { ps.sel = r.name; render(true); }, rowKey: r => r.name, selected: ps.sel, maxHeight: '460px' }))),
      h('div', { class: 'card' }, h('h2', null, 'Job detail'), jobDetail)));
};

function historyChart(t, title, opts = {}) {
  const c = t.columns, sm = t.summary || {};
  const markers = [];
  if (isNum(sm.t_burnout_s)) markers.push({ x: sm.t_burnout_s, label: `burnout ${fmt(sm.t_burnout_s, 2)}s`, color: '#f97316' });
  if (isNum(sm.t_sep_s)) markers.push({ x: sm.t_sep_s, label: `separation ${fmt(sm.t_sep_s, 2)}s`, color: '#9333ea' });
  if (isNum(sm.t_ign_s)) markers.push({ x: sm.t_ign_s, label: `ignition ${fmt(sm.t_ign_s, 2)}s`, color: '#dc2626' });
  if (isNum(sm.t_apogee_s)) markers.push({ x: sm.t_apogee_s, label: `apogee ${fmt(sm.t_apogee_s, 1)}s`, color: '#16a34a' });
  const cfg = App.state.config;
  const ps = pageState('histchart', { mode: 'mach' });
  const modes = { mach: 'Mach & altitude', vel: 'velocity & thrust', forces: 'thrust, drag, weight', accel: 'acceleration' };
  let series, yLabel, y2Label, refs = [];
  const tmax = opts.tmax || null;
  const cut = (arr) => tmax ? arr.filter((_, i) => c.time_s[i] <= tmax) : arr;
  const x = cut(c.time_s);
  if (ps.mode === 'mach') {
    series = [{ name: 'Mach', x, y: cut(c.mach) }, { name: 'altitude [ft]', x, y: cut(c.altitude_ft), axis: 'y2' }];
    yLabel = 'Mach'; y2Label = 'altitude [ft]';
    refs = [{ y: cfg.profiles.supersonic_min_mach, label: `M ${cfg.profiles.supersonic_min_mach}`, color: '#dc2626' }, { y: cfg.profiles.subsonic_max_mach, label: `M ${cfg.profiles.subsonic_max_mach}`, color: '#16a34a' }, { y: cfg.target.apogee_ft, label: `target ${fmt(cfg.target.apogee_ft, 0)} ft`, axis: 'y2', color: '#2563eb' }];
  } else if (ps.mode === 'vel') {
    series = [{ name: 'velocity [fps]', x, y: cut(c.velocity_fps) }, { name: 'thrust [lb]', x, y: cut(c.thrust_lb), axis: 'y2' }];
    yLabel = 'velocity [ft/s]'; y2Label = 'thrust [lb]';
  } else if (ps.mode === 'forces') {
    series = [{ name: 'thrust [lb]', x, y: cut(c.thrust_lb) }, { name: 'drag [lb]', x, y: cut(c.drag_lb) }, { name: 'weight [lb]', x, y: cut(c.weight_lb) }];
    yLabel = 'lb';
  } else {
    series = [{ name: 'accel [ft/s²]', x, y: cut(c.accel_fps2) }, { name: 'accel-V', x, y: cut(c.accel_v_fps2) }];
    yLabel = 'ft/s²';
  }
  return h('div', null,
    h('div', { class: 'row', style: { marginBottom: '8px', justifyContent: 'space-between' } },
      h('div', { class: 'tabs', style: { marginBottom: 0, borderBottom: 0 } }, Object.entries(modes).map(([k, v]) => h('div', { class: 'tab ' + (ps.mode === k ? 'active' : ''), onclick: () => { ps.mode = k; render(); } }, v))),
      h('span', { class: 'muted small' }, `apogee ${fmt(sm.apogee_ft, 0)} ft · max Mach ${fmt(sm.max_mach, 3)} · max vel ${fmt(sm.max_vel_fps, 0)} fps · ${t.n} samples`)),
    lineChart({ series, xLabel: 'time [s]', yLabel, y2Label, markers, refs, title, height: 300 }));
}

function designsTab(ps, d, cfg) {
  const container = h('div');
  const load = async () => {
    const t = await cached('t:designs', '/api/table/designs');
    const rows = t.rows.map(r => ({ ...r, dev_ft: isNum(r.apogee_ft) ? r.apogee_ft - d.target_ft : null }));
    const statuses = ['all', ...new Set(rows.map(r => r.status))];
    const filtered = (ps.filter === 'all' ? rows : rows.filter(r => r.status === ps.filter)).slice().sort((a, b) => Math.abs(a.dev_ft ?? 1e9) - Math.abs(b.dev_ft ?? 1e9));
    if (ps.q) { const q = ps.q.toLowerCase(); setTimeout(() => { for (const tr of table.querySelectorAll('tbody tr')) tr.hidden = !tr.textContent.toLowerCase().includes(q); }, 0); }
    const key = r => `${r.booster}|${r.profile}`;
    if (!ps.sel || !rows.some(r => key(r) === ps.sel)) { const best = rows.slice().sort((a, b) => Math.abs(a.dev_ft ?? 1e9) - Math.abs(b.dev_ft ?? 1e9))[0]; ps.sel = best ? key(best) : null; }
    const selRow = rows.find(r => key(r) === ps.sel);
    const table = dataTable({
      columns: ['booster', 'profile', 'status', 'sep_delay_s', 'ign_delay_s', 'apogee_ft', 'dev_ft', 'apogee_min_delay_ft', 'apogee_max_delay_ft', 'mach_at_sep', 'vel_at_ign_fps', 'mach_at_ign', 'alt_at_ign_ft', 'max_mach', 'max_accel_g', 't_apogee_s', 'verified_ok', 'n_sims'],
      rows: filtered,
      labels: { sep_delay_s: 'sep [s]', ign_delay_s: 'ign [s]', apogee_ft: 'apogee [ft]', dev_ft: 'Δ target', apogee_min_delay_ft: 'apogee @min ign', apogee_max_delay_ft: 'apogee @max ign', mach_at_sep: 'M @sep', vel_at_ign_fps: 'v @ign [fps]', mach_at_ign: 'M @ign', alt_at_ign_ft: 'alt @ign', max_mach: 'max M', max_accel_g: 'max g', t_apogee_s: 't apogee', verified_ok: 'verified', n_sims: 'sims' },
      format: { status: v => badge({ solved: 'ok', overpowered: 'warn', underpowered: 'warn', unsolved: 'err', infeasible: 'todo' }[v] || 'todo', v), verified_ok: v => v === null || v === undefined ? '—' : badge(v ? 'ok' : 'err', v ? 'ok' : 'fail'), dev_ft: v => isNum(v) ? (v > 0 ? '+' : '') + fmt(v, 0) : '—', apogee_ft: v => fmt(v, 0), apogee_min_delay_ft: v => fmt(v, 0), apogee_max_delay_ft: v => fmt(v, 0), mach_at_sep: v => fmt(v, 3), mach_at_ign: v => fmt(v, 3) },
      onRow: r => { ps.sel = key(r); render(); }, rowKey: key, selected: ps.sel, maxHeight: '420px',
    });
    const detail = selRow ? designDetail(selRow, d, cfg) : null;
    return h('div', null,
      h('div', { class: 'toolbar' }, h('span', { class: 'muted small' }, 'status:'), statuses.map(st => h('button', { class: 'btn sm ' + (ps.filter === st ? 'primary' : ''), onclick: () => { ps.filter = st; render(true); } }, st === 'all' ? `all (${rows.length})` : `${st} (${rows.filter(r => r.status === st).length})`)), h('span', { class: 'spacer' }), h('input', { type: 'text', class: 'searchbox', placeholder: 'filter boosters…', value: ps.q || '', oninput: e => { ps.q = e.target.value; const q = ps.q.toLowerCase(); for (const tr of table.querySelectorAll('tbody tr')) tr.hidden = q && !tr.textContent.toLowerCase().includes(q); } }), h('span', { class: 'muted small' }, 'sorted by distance to target; click a row for details')),
      table,
      detail);
  };
  container.append(asyncBlock(load));
  return container;
}

function designDetail(r, d, cfg) {
  const key = `${r.booster}|${r.profile}`;
  const ps = pageState('results');
  const samplesChart = asyncBlock(async () => {
    const all = await cached('samples', '/api/samples', 10000);
    const pts = (all[key] || []).filter(p => isNum(p[1]));
    if (!pts.length) return h('div', { class: 'muted small' }, 'no search samples for this candidate');
    const bySep = new Map();
    for (const p of pts) { const sep = p.length > 2 ? p[2] : r.sep_delay_s; if (!bySep.has(sep)) bySep.set(sep, []); bySep.get(sep).push(p); }
    const seps = [...bySep.keys()].sort((a, b) => a - b);
    const series = seps.map(sep => { const q = bySep.get(sep).sort((a, b) => a[0] - b[0]); return { name: `sep ${fmt(sep, 2)} s`, x: q.map(p => p[0]), y: q.map(p => p[1]), points: true, width: sep === r.sep_delay_s ? 2.6 : 1.4 }; });
    return lineChart({ series, xLabel: 'sustainer ignition delay after separation [s]', yLabel: 'apogee [ft]', height: 260, refs: [{ y: d.target_ft, label: `target ${fmt(d.target_ft, 0)} ft`, color: '#dc2626' }], markers: isNum(r.ign_delay_s) ? [{ x: r.ign_delay_s, label: `chosen: sep ${fmt(r.sep_delay_s, 2)} s, ign ${fmt(r.ign_delay_s, 2)} s`, color: '#16a34a' }] : [], title: `${r.booster} · ${r.profile}: apogee vs ignition delay, one curve per separation delay (${pts.length} simulations)` });
  });
  const histChart = asyncBlock(async () => {
    const hs = await cached('histories', '/api/histories', 10000);
    const final = hs.histories.find(x => x.name === `final-${r.booster}-${r.profile}`);
    const char = hs.histories.find(x => x.name === `char-${r.booster}`);
    const pick = final || char;
    if (!pick) return h('div', { class: 'muted small' }, 'no time history for this design yet (verify stage)');
    const t = await cached('hist:' + pick.path, '/api/history?path=' + encodeURIComponent(pick.path) + '&t=' + pick.mtime, 60000);
    return h('div', null, h('div', { class: 'muted small', style: { marginBottom: '6px' } }, final ? `verified flight (final-${r.booster}-${r.profile}.csv)` : `no verified flight for this design — showing the characterization flight (char-${r.booster}.csv, long coast)`), historyChart(t, pick.name));
  });
  return h('div', { class: 'stack', style: { marginTop: '16px' } },
    h('div', { class: 'card tight' },
      h('h3', null, `${r.booster} · ${r.profile}`, badge({ solved: 'ok', overpowered: 'warn', underpowered: 'warn', unsolved: 'err' }[r.status] || 'todo', r.status)),
      h('div', { class: 'stat-list' },
        stat('separation', fmt(r.sep_delay_s, 2), 's after burnout'),
        stat('ignition', fmt(r.ign_delay_s, 2), 's after separation'),
        stat('apogee', fmt(r.apogee_ft, 0), 'ft', Math.abs((r.apogee_ft ?? 0) - d.target_ft) <= d.tolerance_ft ? 'ok' : 'warn'),
        stat('Mach at separation', fmt(r.mach_at_sep, 3)),
        stat('velocity at ignition', fmt(r.vel_at_ign_fps, 0), 'fps'),
        stat('altitude at ignition', fmt(r.alt_at_ign_ft, 0), 'ft'),
        stat('max Mach', fmt(r.max_mach, 3)),
        stat('max accel', fmt(r.max_accel_g, 1), 'g')),
      r.hint ? h('div', { class: 'callout warn', style: { marginTop: '10px' } }, h('b', null, 'hint: '), r.hint) : null,
      r.verify_note ? h('div', { class: 'callout err', style: { marginTop: '10px' } }, h('b', null, 'verification: '), r.verify_note) : null),
    h('div', { class: 'grid c2' }, h('div', { class: 'card tight' }, samplesChart), h('div', { class: 'card tight' }, histChart)));
}

// ============================================================================
// shell: sidebar, topbar, activity panel
// ============================================================================

function renderSidebar() {
  const sb = $('#sidebar');
  sb.innerHTML = '';
  const item = (id, num, title, sub, status) => h('div', { class: 'nav-item ' + (App.page === id ? 'active' : ''), onclick: () => go(id) },
    h('span', { class: 'num ' + (status || '') }, num), h('div', { class: 'lbl' }, h('div', { class: 't' }, title), h('div', { class: 'nav-sub ' + (status === 'running' ? 'running' : '') }, sub)));
  sb.append(item('overview', '⌂', 'Overview', 'status & next action', ''));
  sb.append(h('div', { class: 'nav-group' }, 'Step by step'));
  for (const st of STEPS) {
    const stt = stepStatus(st.id);
    sb.append(item(st.id, st.n, st.title, stt === 'running' ? 'running…' : (STATUS_TEXT[stt] || stt) + ' · ' + st.sub, stt));
  }
  sb.append(h('div', { class: 'nav-group' }, 'Infrastructure'));
  const w = App.state ? App.state.worker : null;
  sb.append(item('worker', '⚙', 'VM worker & jobs', w ? `${w.state} · ${w.detail}` : '', w ? ({ busy: 'running', online: 'ok', idle: 'ok', queued: 'warn', unresponsive: 'err', offline: 'err' }[w.state] || '') : ''));
}

function renderTopbar() {
  const s = App.state, el = $('#topbar-right');
  el.innerHTML = '';
  if (!s) return;
  const r = s.runner;
  el.append(h('span', { class: 'pill', title: 'target apogee' }, `🎯 ${fmt(s.config.target.apogee_ft, 0)} ± ${fmt(s.config.target.tolerance_ft, 0)} ft`));
  el.append(h('span', { class: 'pill', title: 'simulation backend' }, `backend: ${s.config.backend}`));
  const wcls = WORKER_CLS[s.worker.state] || '';
  el.append(h('span', { class: 'pill ' + wcls, title: s.worker.detail, onclick: () => go('worker'), style: { cursor: 'pointer' } }, h('span', { class: 'dot' }), `VM worker: ${s.worker.state}`));
  el.append(h('span', { class: 'pill ' + (r.running ? 'run' : 'ok'), title: r.running ? `running ${r.stage}` : 'idle', onclick: () => { App.collapsed = !App.collapsed; renderActivity(); }, style: { cursor: 'pointer' } }, h('span', { class: 'dot' }), r.running ? `running: ${r.stage}${r.substage && r.stage === 'run' ? ' › ' + r.substage : ''} · ${dur(r.elapsed_s)}` : 'idle'));
  const th = App.theme;
  el.append(h('span', { class: 'pill theme-btn', title: 'theme: ' + th + ' (click to change)', onclick: () => { App.theme = th === 'auto' ? 'light' : th === 'light' ? 'dark' : 'auto'; applyTheme(); renderTopbar(); } }, th === 'auto' ? '◐ auto' : th === 'light' ? '☀ light' : '☾ dark'));
  el.append(h('span', { class: 'pill theme-btn', title: 'stop the local server (the VM worker keeps running)', onclick: quitServer }, '⏻ quit'));
}
async function quitServer() {
  if (busy() && !window.confirm(`"${App.state.runner.stage}" is still running and will be cancelled. Quit anyway?`)) return;
  if (!busy() && !window.confirm('Stop the Rocket Profile Analysis server? (The VM worker keeps running; relaunch the app to come back.)')) return;
  try { await api('/api/quit', { body: {} }); } catch (e) { /* the server is going away */ }
  App.stopped = true;
  if (App.es) App.es.close();
  $('#main').innerHTML = '';
  $('#main').append(h('div', { class: 'card', style: { maxWidth: '520px', margin: '60px auto' } }, h('h2', null, 'Server stopped'), h('p', null, 'The Rocket Profile Analysis server has been shut down. You can close this tab. To come back, open the app again (or run ', h('code', null, 'python -m rpa gui'), ').')));
  $('#topbar-right').innerHTML = '';
  $('#topbar-right').append(h('span', { class: 'pill' }, h('span', { class: 'dot' }), 'stopped'));
}
function applyTheme() {
  try { localStorage.setItem('rpa-theme', App.theme); } catch (e) { /* ignore */ }
  if (App.theme === 'auto') delete document.documentElement.dataset.theme; else document.documentElement.dataset.theme = App.theme;
}

function renderActivity() {
  const act = $('#activity');
  const s = App.state;
  const r = s ? s.runner : { running: false };
  act.className = 'activity' + (App.collapsed ? ' collapsed' : '');
  let bar = $('.bar', act), log = $('.log', act);
  if (!bar) {
    bar = h('div', { class: 'bar' });
    log = h('div', { class: 'log' });
    log.addEventListener('scroll', () => { App.follow = log.scrollTop + log.clientHeight >= log.scrollHeight - 8; });
    act.append(bar, log);
  }
  bar.innerHTML = '';
  bar.append(...[
    h('button', { class: 'btn sm ghost', onclick: () => { App.collapsed = !App.collapsed; renderActivity(); } }, App.collapsed ? '▲ Activity' : '▼ Activity'),
    r.running ? h('span', { class: 'badge running' }, `running: rpa ${[r.stage, ...(r.args || [])].join(' ')}`) : h('span', { class: 'badge ok' }, 'idle'),
    r.running ? h('div', { class: 'progress grow ' + (r.progress && r.progress.total ? '' : 'indet') }, h('div', { style: { width: (r.progress && r.progress.total ? 100 * r.progress.done / r.progress.total : 30) + '%' } })) : h('span', { class: 'grow' }),
    r.running ? h('span', { class: 'muted small' }, `${r.substage ? r.substage + ' · ' : ''}${r.progress && r.progress.total ? `${r.progress.done}/${r.progress.total} · ` : ''}${dur(r.elapsed_s)}${eta(r) ? ' · ' + eta(r) : ''}`) : (r.finished ? h('span', { class: 'muted small' }, `last: rpa ${r.stage} ${outcomeText(r)} · ${dur(r.elapsed_s)}`) : null),
    r.running ? h('button', { class: 'btn sm danger', onclick: cancelRun }, 'Cancel') : null,
    h('button', { class: 'btn sm ghost', onclick: () => { App.lines = []; log.innerHTML = ''; } }, 'Clear'),
    h('label', { class: 'check small' }, h('input', { type: 'checkbox', checked: App.follow, onchange: e => { App.follow = e.target.checked; if (App.follow) log.scrollTop = log.scrollHeight; } }), 'follow'),
  ].filter(Boolean));
}

function eta(r) {
  if (!r.running || !r.progress || !r.progress.total || !App.subStart) return '';
  const done = r.progress.done, total = r.progress.total;
  if (done < 2) return '';
  const rate = (done - 1) / Math.max(0.5, (Date.now() / 1000) - App.subStart);
  const left = (total - done) / rate;
  return left > 1 ? `~${dur(left)} left` : '';
}
function trackProgress(r) {
  const key = r.running ? `${r.stage}|${r.substage}|${r.progress && r.progress.total}` : null;
  if (key !== App.subKey) { App.subKey = key; App.subStart = r.running ? Date.now() / 1000 : null; }
}
function appendLog(rec) {
  const log = $('#activity .log');
  if (!log) return;
  App.lines.push(rec);
  if (App.lines.length > 4000) { App.lines.shift(); if (log.firstChild) log.firstChild.remove(); }
  const t = rec.text;
  const cls = t.startsWith('$ ') ? 'cmd' : t.startsWith('vm: FAILED') ? 'bad' : t.startsWith('vm:') ? 'hdr' : /^===/.test(t) ? 'hdr' : /^---/.test(t) ? (t.includes('findings') ? 'warn' : t.includes('finished') ? 'done' : 'bad') : /Traceback|Error|error|FAIL|failure|failed/.test(t) ? 'bad' : /!!|warning|WARN|stale/.test(t) ? 'warn' : '';
  log.append(h('div', { class: 'ln ' + cls }, `${clock(rec.t)}  ${t}`));
  if (App.follow) log.scrollTop = log.scrollHeight;
}

// ============================================================================
// render loop & data refresh
// ============================================================================
function stateHash(s) {
  const c = JSON.parse(JSON.stringify(s));
  delete c.now; delete c.runner.elapsed_s;
  if (c.worker) { delete c.worker.detail; c.worker.jobs = c.worker.jobs.map(j => j.name + j.state); c.worker.console_tail = c.worker.console_tail.length; if (c.worker.heartbeat) { delete c.worker.heartbeat.age_s; delete c.worker.heartbeat.epoch; delete c.worker.heartbeat.time; } if (c.worker.vm && c.worker.vm.op) delete c.worker.vm.op.elapsed_s; }
  return JSON.stringify(c);
}
function render(force) {
  if (!App.state) return;
  renderSidebar();
  renderTopbar();
  renderActivity();
  const main = $('#main');
  const active = document.activeElement;
  if (!force && active && main.contains(active) && ['INPUT', 'SELECT', 'TEXTAREA'].includes(active.tagName)) return;
  main.innerHTML = '';
  try {
    main.append((pages[App.page] || pages.overview)());
  } catch (e) {
    console.error(e);
    main.append(callout('err', 'render error: ' + e.message));
  }
}

async function refresh(force) {
  if (App.stopped) return;
  try {
    const s = await api('/api/state');
    const hash = stateHash(s);
    const changed = hash !== App.lastHash;
    App.state = s;
    App.lastHash = hash;
    if (changed) App.cache = {};
    if (changed || force) render(force);
    else { renderTopbar(); renderActivity(); }
  } catch (e) {
    $('#topbar-right').innerHTML = '';
    $('#topbar-right').append(h('span', { class: 'pill err' }, h('span', { class: 'dot' }), 'server unreachable — is `python -m rpa gui` still running?'));
  }
}

function connectEvents() {
  if (App.es) App.es.close();
  const es = new EventSource('/api/events');
  App.es = es;
  es.addEventListener('log', ev => { const rec = JSON.parse(ev.data); if (rec.seq > App.lastSeq) { App.lastSeq = rec.seq; appendLog(rec); } });
  es.addEventListener('state', ev => {
    const r = JSON.parse(ev.data);
    trackProgress(r);
    if (App.state) { App.state.runner = r; renderTopbar(); renderActivity(); renderSidebar(); }
    if (!r.running && App.prevRunning) {
      const ok = r.exit_code === 0, findings = r.exit_code === 1 && ['check', 'validate'].includes(r.stage);
      const dest = ['run', 'search', 'verify', 'report'].includes(r.stage) ? 'results' : r.stage === 'validate' ? 'validate' : r.stage === 'confirm' ? 'confirm' : r.stage === 'aero' ? 'aero' : r.stage === 'reference' ? 'reference' : r.stage === 'check' || r.stage === 'mass' ? 'inputs' : null;
      toast(`rpa ${r.stage} ${outcomeText(r)} (${dur(r.elapsed_s)})`, r.cancelled ? '' : ok ? 'ok' : findings ? '' : 'err', dest && dest !== App.page ? { label: `open ${dest} →`, fn: () => go(dest) } : (!ok && !r.cancelled ? { label: 'show log', fn: () => { App.collapsed = false; renderActivity(); } } : null));
    }
    App.prevRunning = r.running;
    if (!r.running) setTimeout(() => refresh(true), 400);   // outputs changed
    else if (App.page === 'optimize') render();
  });
  let changeTimer = null;
  es.addEventListener('changed', () => { clearTimeout(changeTimer); changeTimer = setTimeout(() => refresh(false), 350); });
  es.onerror = () => { if (!App.stopped) setTimeout(connectEvents, 3000); };
}

async function init() {
  applyTheme();
  window.addEventListener('hashchange', () => { const p = location.hash.replace('#', ''); if (p && p !== App.page) { App.page = p; render(true); } });
  try {
    const lg = await api('/api/log?after=0');
    for (const rec of lg.lines) { App.lastSeq = rec.seq; App.lines.push(rec); }
  } catch (e) { /* ignore */ }
  await refresh(true);
  const log = $('#activity .log');
  if (log) { for (const rec of App.lines) { const t = rec.text; const cls = t.startsWith('$ ') ? 'cmd' : /^===/.test(t) ? 'hdr' : /^---/.test(t) ? (t.includes('finished') ? 'done' : 'bad') : ''; log.append(h('div', { class: 'ln ' + cls }, `${clock(rec.t)}  ${t}`)); } log.scrollTop = log.scrollHeight; }
  if (App.state && App.state.runner.running) { App.collapsed = false; App.prevRunning = true; trackProgress(App.state.runner); }
  renderActivity();
  connectEvents();
  setInterval(() => refresh(false), 15000);   // fallback; the server pushes a 'changed' event whenever a file changes
  setInterval(() => { if (App.state && App.state.runner.running) { App.state.runner.elapsed_s = (Date.now() / 1000) - App.state.runner.started; renderActivity(); renderTopbar(); } }, 1000);
}
init();
