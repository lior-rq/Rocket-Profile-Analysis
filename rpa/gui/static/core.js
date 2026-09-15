
/* Rocket Profile Analysis - local GUI. Talks to rpa/gui/server.py. */

// ============================================================================
// small helpers
// ============================================================================
export const $ = (s, el = document) => el.querySelector(s);

export function h(tag, attrs, ...kids) {
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

export const isNum = v => typeof v === 'number' && Number.isFinite(v);

export function fmt(v, d) {
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

export const fmtFt = v => isNum(v) ? fmt(v, 0) + ' ft' : '—';

export function ago(ts) {
  if (!ts) return 'never';
  const s = Math.max(0, (Date.now() / 1000) - ts);
  if (s < 60) return `${Math.round(s)}s ago`;
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400) return `${(s / 3600).toFixed(1)} h ago`;
  return `${Math.round(s / 86400)} d ago`;
}

export function clock(ts) { return ts ? new Date(ts * 1000).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' }) : '—'; }

export function dateTime(ts) { return ts ? new Date(ts * 1000).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : '—'; }

export function dur(s) {
  if (!isNum(s)) return '—';
  if (s < 60) return `${Math.round(s)}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m ${Math.round(s % 60)}s`;
  return `${Math.floor(s / 3600)}h ${Math.round((s % 3600) / 60)}m`;
}

export function sizeFmt(b) { if (!isNum(b)) return ''; if (b < 1024) return b + ' B'; if (b < 1048576) return (b / 1024).toFixed(0) + ' KB'; if (b < 1073741824) return (b / 1048576).toFixed(1) + ' MB'; return (b / 1073741824).toFixed(2) + ' GB'; }
/* The delay grids the search flies (rpa/search.py separation_grid and
   _coarse_delays): separation is capped at 9 points, both ends kept. */

export function sepGridPoints(lo, hi, step, maxPoints = 9) {
  lo = +lo; hi = +hi; step = +step;
  if (!(hi - lo > 1e-9)) return [+lo.toFixed(2)];
  const st = Math.max(step, (hi - lo) / (maxPoints - 1));
  const n = Math.floor((hi - lo) / st + 1e-9) + 1;
  const pts = new Set();
  for (let i = 0; i < n; i++) pts.add(+(lo + i * st).toFixed(2));
  pts.add(+hi.toFixed(2));
  return [...pts].sort((a, b) => a - b);
}

export function ignGridPoints(lo, hi, step) {
  lo = +lo; hi = +hi; step = +step;
  if (lo > hi || !(step > 0)) return [+lo.toFixed(2)];
  const n = Math.floor((hi - lo) / step + 1e-9) + 1;
  const ds = [];
  for (let i = 0; i < n; i++) ds.push(+(lo + i * step).toFixed(2));
  if (ds[ds.length - 1] < hi - 1e-6) ds.push(+hi.toFixed(2));
  return ds;
}

export function gridSummary(p) {
  const sep = sepGridPoints(p.separation_delay_min_s, p.separation_delay_max_s, p.separation_step_s);
  const ign = ignGridPoints(p.ignition_delay_min_s, p.ignition_delay_max_s, p.coarse_step_s);
  const sepStep = sep.length > 1 ? sep[1] - sep[0] : 0;
  return { sep, ign, sepStep, capped: sep.length > 1 && sepStep > +p.separation_step_s + 1e-9 };
}

export function esc(s) { return String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }

export async function api(path, opts) {
  const r = await fetch(path, opts && opts.body ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(opts.body) } : opts);
  let data = null;
  try { data = await r.json(); } catch (e) { data = { error: `bad response (${r.status})` }; }
  if (!r.ok || (data && data.error)) throw new Error((data && data.error) || `HTTP ${r.status}`);
  return data;
}

export function toast(msg, kind = '', action) {
  const t = h('div', { class: 'toast ' + kind }, msg, action ? h('a', { onclick: () => { action.fn(); t.remove(); } }, action.label) : null);
  $('#toasts').append(t);
  setTimeout(() => t.remove(), kind === 'err' ? 9000 : action ? 8000 : 3500);
}

export const spinner = () => h('span', { class: 'spin' });

export function lightbox(src) {
  const lb = $('#lightbox');
  lb.innerHTML = '';
  lb.append(h('img', { src }));
  lb.hidden = false;
  lb.onclick = () => { lb.hidden = true; };
}

// ============================================================================
// app state
// ============================================================================
export const App = {
  state: null,
  page: 'overview',
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

export const STEPS = [
  { id: 'inputs', n: 1, title: 'Inputs & settings', sub: 'Vehicle, motors, mass, target', short: 'Inputs' },
  { id: 'aero', n: 2, title: 'Aero tables', sub: 'RASAero drag export (VM)', short: 'Aero tables' },
  { id: 'reference', n: 3, title: 'Reference flights', sub: 'RASAero runs (VM)', short: 'Reference' },
  { id: 'validate', n: 4, title: 'Validate simulator', sub: 'Python vs RASAero', short: 'Validate' },
  { id: 'optimize', n: 5, title: 'Optimize', sub: 'Search staging delays', short: 'Optimize' },
  { id: 'results', n: 6, title: 'Results', sub: 'Designs, plots, report', short: 'Results' },
  { id: 'confirm', n: 7, title: 'Confirm in RASAero', sub: 'Final check (VM)', short: 'Confirm' },
];

export const STATUS_TEXT = { ok: 'done', partial: 'partial', todo: 'not started', stale: 'out of date', warn: 'needs attention', error: 'problem', unchecked: 'not checked', running: 'running' };

export const RUN_STAGES = ['run', 'motors', 'mass', 'characterize', 'search', 'verify', 'report'];

export function stepStatus(id) {
  const s = App.state;
  if (!s) return 'todo';
  const r = s.runner;
  if (r.running) {
    const st = r.stage;
    if ((id === 'inputs' && (st === 'check' || st === 'mass')) || (id === 'aero' && st === 'aero') || (id === 'reference' && st === 'reference') || (id === 'validate' && st === 'validate') || (id === 'optimize' && RUN_STAGES.includes(st)) || (id === 'confirm' && st === 'confirm')) return 'running';
  }
  return (s[id] && s[id].status) || 'todo';
}

/* Per-page UI state; `init` fills in defaults a deep link did not set. */
export function pageState(page, init) {
  if (!App.ps[page]) App.ps[page] = {};
  if (init) for (const k of Object.keys(init)) if (!(k in App.ps[page])) App.ps[page][k] = init[k];
  return App.ps[page];
}

export function busy() { return App.state && App.state.runner.running; }

/* Open a page; `extra` pre-sets its state (tab, sel, ...). The shell writes
   the matching #hash after rendering. */
export function go(page, extra) { App.page = page; if (extra) Object.assign(pageState(page), extra); render(true); $('#main').scrollTo(0, 0); }

// ---- deep links: #page[/tab][?sel=...] ---------------------------------------
const HASH_KEYS = { results: ['tab', 'sel', 'archive'], inputs: ['tab'], validate: ['sel'], worker: ['sel'], runs: ['sel'], reference: ['sel'], aero: ['sel'] };
export function currentHash() {
  const ps = App.ps[App.page] || {};
  const keys = HASH_KEYS[App.page] || [];
  let s = App.page;
  if (keys.includes('tab') && ps.tab) s += '/' + ps.tab;
  const q = keys.filter(k => k !== 'tab' && ps[k] != null && ps[k] !== '').map(k => k + '=' + encodeURIComponent(ps[k]));
  return q.length ? s + '?' + q.join('&') : s;
}
export function applyHash(hash) {
  const m = /^#?([\w-]+)(?:\/([\w-]+))?(?:\?(.*))?$/.exec(hash || '');
  if (!m) return false;
  const ps = pageState(m[1]);
  if (m[2]) ps.tab = m[2];
  if (m[3]) for (const [k, v] of new URLSearchParams(m[3])) ps[k] = v;
  App.page = m[1];
  return true;
}

export async function cached(key, url, ttl = 4000, version) {
  const c = App.cache[key];
  if (c && (version !== undefined ? c.version === version : Date.now() - c.t < ttl)) return c.v;
  const v = await api(url);
  App.cache[key] = { t: Date.now(), v, version };
  return v;
}

export function dropUnversionedCache() {
  for (const k of Object.keys(App.cache)) if (App.cache[k].version === undefined) delete App.cache[k];
}

// ============================================================================
// pages
// ============================================================================
export const pages = {};

export function eta(r) {
  if (!r.running || !r.progress || !r.progress.total || !App.subStart) return '';
  const done = r.progress.done, total = r.progress.total;
  if (done < 2) return '';
  const rate = (done - 1) / Math.max(0.5, (Date.now() / 1000) - App.subStart);
  const left = (total - done) / rate;
  return left > 1 ? `~${dur(left)} left` : '';
}

export function trackProgress(r) {
  const key = r.running ? `${r.stage}|${r.substage}|${r.round && r.round.round}|${r.progress && r.progress.total}` : null;
  if (key !== App.subKey) { App.subKey = key; App.subStart = r.running ? Date.now() / 1000 : null; }
}

export function blockSettled() {
  App.pendingBlocks = Math.max(0, (App.pendingBlocks || 0) - 1);
  if (App.scrollInner) App.scrollInner();
  if (!App.pendingBlocks) { if (App.scrollSpacer) App.scrollSpacer(); App.scrollInner = null; }
}

export function searchedSustainers(m) {
  if (!m) return new Set();
  const picked = ((m.sustainer_selection || {}).selected || []).map(x => x.label);
  return new Set(picked.length ? picked : [m.sustainer.label]);
}

/* The shell installs the real implementations on App; pages reach them
   through these so no module imports the shell. */
export function render(force) { if (App.render) App.render(force); }
export function renderActivity() { if (App.renderActivity) App.renderActivity(); }
export function refresh(force) { return App.refresh ? App.refresh(force) : Promise.resolve(); }
