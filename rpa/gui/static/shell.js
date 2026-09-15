import { $, App, STATUS_TEXT, STEPS, api, applyHash, busy, cached, clock, currentHash, dropUnversionedCache, dur, eta, fmt, go, h, isNum, lightbox, pages, stepStatus, toast, trackProgress } from './core.js';
import { WORKER_CLS, badge, callout, cancelRun, modal, outcomeText } from './components.js';

// ============================================================================
// shell: sidebar, topbar, activity panel
// ============================================================================

export function renderSidebar() {
  const sb = $('#sidebar');
  sb.innerHTML = '';
  const item = (id, num, title, sub, status) => h('button', { class: 'nav-item ' + (App.page === id ? 'active' : ''), type: 'button', 'aria-current': App.page === id ? 'page' : null, onclick: () => go(id) },
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
  const last = App.state && App.state.history && App.state.history.length ? App.state.history[App.state.history.length - 1] : null;
  sb.append(item('runs', '≡', 'Runs & logs', last ? `last: rpa ${last.stage} ${outcomeText(last)}` : 'logs and result snapshots', last && last.exit_code !== 0 && !last.cancelled && !(last.exit_code === 1 && ['check', 'validate'].includes(last.stage)) ? 'err' : ''));
}

export function renderTopbar() {
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

export async function quitServer() {
  const ok = await modal({ title: 'Stop the Rocket Profile Analysis server?', body: busy() ? `"${App.state.runner.stage}" is still running and will be cancelled. The VM worker keeps running; relaunch the app to come back.` : 'The VM worker keeps running; relaunch the app to come back.', okLabel: 'Quit', danger: true });
  if (!ok) return;
  try { await api('/api/quit', { body: {} }); } catch (e) { /* the server is going away */ }
  App.stopped = true;
  if (App.es) App.es.close();
  $('#main').innerHTML = '';
  $('#main').append(h('div', { class: 'card', style: { maxWidth: '520px', margin: '60px auto' } }, h('h2', null, 'Server stopped'), h('p', null, 'The Rocket Profile Analysis server has been shut down. You can close this tab. To come back, open the app again (or run ', h('code', null, 'python -m rpa gui'), ').')));
  $('#topbar-right').innerHTML = '';
  $('#topbar-right').append(h('span', { class: 'pill' }, h('span', { class: 'dot' }), 'stopped'));
}

export function applyTheme() {
  try { localStorage.setItem('rpa-theme', App.theme); } catch (e) { /* ignore */ }
  if (App.theme === 'auto') delete document.documentElement.dataset.theme; else document.documentElement.dataset.theme = App.theme;
}

export function renderActivity() {
  const act = $('#activity');
  const s = App.state;
  const r = s ? s.runner : { running: false };
  act.className = 'activity' + (App.collapsed ? ' collapsed' : '');
  let bar = $('.bar', act), log = $('.log', act);
  if (!bar) {
    bar = h('div', { class: 'bar' });
    log = h('div', { class: 'log' });
    log.addEventListener('scroll', () => { App.follow = log.scrollTop + log.clientHeight >= log.scrollHeight - 8; });
    // drag the panel's top edge to resize the log; the height is remembered
    const handle = h('div', { class: 'act-handle', title: 'drag to resize the log' });
    let hgt = 300;
    try { hgt = Number(localStorage.getItem('rpa-activity-h')) || 300; } catch (e) { /* ignore */ }
    act.style.setProperty('--activity-h', hgt + 'px');
    handle.addEventListener('mousedown', ev => {
      ev.preventDefault();
      const y0 = ev.clientY, h0 = log.getBoundingClientRect().height;
      const move = e => act.style.setProperty('--activity-h', Math.max(80, Math.min(window.innerHeight * 0.8, h0 + (y0 - e.clientY))) + 'px');
      const up = () => { window.removeEventListener('mousemove', move); window.removeEventListener('mouseup', up); try { localStorage.setItem('rpa-activity-h', String(Math.round(log.getBoundingClientRect().height))); } catch (e) { /* ignore */ } };
      window.addEventListener('mousemove', move);
      window.addEventListener('mouseup', up);
    });
    act.append(handle, bar, log);
  }
  log.classList.toggle('errors-only', !!App.errorsOnly);
  bar.innerHTML = '';
  bar.append(...[
    h('button', { class: 'btn sm ghost', onclick: () => { App.collapsed = !App.collapsed; renderActivity(); } }, App.collapsed ? '▲ Activity' : '▼ Activity'),
    r.running ? h('span', { class: 'badge running' }, `running: rpa ${[r.stage, ...(r.args || [])].join(' ')}`) : h('span', { class: 'badge ok' }, 'idle'),
    r.side ? h('span', { class: 'badge running', title: 'a light stage running beside the main one' }, `+ ${r.side.stage} · ${dur(r.side.elapsed_s)}`) : null,
    r.running ? h('div', { class: 'progress grow ' + (r.progress && r.progress.total ? '' : 'indet') }, h('div', { style: { width: (r.progress && r.progress.total ? 100 * r.progress.done / r.progress.total : 30) + '%' } })) : h('span', { class: 'grow' }),
    r.running ? h('span', { class: 'muted small' }, `${r.substage ? r.substage + ' · ' : ''}${r.round ? `round ${r.round.round} · ` : ''}${r.progress && r.progress.total ? `${r.progress.done}/${r.progress.total} · ` : ''}${dur(r.elapsed_s)}${eta(r) ? ' · ' + eta(r) : ''}`) : (r.finished ? h('span', { class: 'muted small' }, `last: rpa ${r.stage} ${outcomeText(r)} · ${dur(r.elapsed_s)}`) : null),
    r.running ? h('button', { class: 'btn sm danger', onclick: cancelRun }, 'Cancel') : null,
    h('button', { class: 'btn sm ghost', onclick: () => { App.lines = []; log.innerHTML = ''; } }, 'Clear'),
    h('button', { class: 'btn sm ghost', title: 'copy the whole log to the clipboard', onclick: () => navigator.clipboard.writeText(App.lines.map(l => `${clock(l.t)}  ${l.text}`).join('\n')).then(() => toast('log copied'), () => toast('copy failed', 'err')) }, 'Copy'),
    h('label', { class: 'check small' }, h('input', { type: 'checkbox', checked: !!App.errorsOnly, onchange: e => { App.errorsOnly = e.target.checked; log.classList.toggle('errors-only', App.errorsOnly); } }), 'errors only'),
    h('label', { class: 'check small' }, h('input', { type: 'checkbox', checked: App.follow, onchange: e => { App.follow = e.target.checked; if (App.follow) log.scrollTop = log.scrollHeight; } }), 'follow'),
  ].filter(Boolean));
}

export function appendLog(rec) {
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
export function stateHash(s) {
  const c = JSON.parse(JSON.stringify(s));
  delete c.now; delete c.runner.elapsed_s;
  if (c.worker) { delete c.worker.detail; delete c.worker.last_seen; c.worker.jobs = c.worker.jobs.map(j => j.name + j.state); c.worker.console_tail = c.worker.console_tail.length; if (c.worker.heartbeat) { delete c.worker.heartbeat.age_s; delete c.worker.heartbeat.epoch; delete c.worker.heartbeat.time; } if (c.worker.vm && c.worker.vm.op) delete c.worker.vm.op.elapsed_s; }
  return JSON.stringify(c);
}
/* Rebuilding #main resets its scroll position, so the same page is
   re-rendered with the previous scroll (and inner table scroll) kept; a
   spacer holds the old height until the async blocks have loaded again. */

export const SCROLLERS = '.tablewrap, .console, .picker .files';

export function render(force) {
  if (!App.state) return;
  renderSidebar();
  renderTopbar();
  renderActivity();
  const main = $('#main');
  const active = document.activeElement;
  if (!force && active && main.contains(active) && ['INPUT', 'SELECT', 'TEXTAREA'].includes(active.tagName)) return;
  if (App.scrollSpacer) App.scrollSpacer();
  const keep = App.renderedPage === App.page ? { top: main.scrollTop, height: main.scrollHeight, inner: [...main.querySelectorAll(SCROLLERS)].map(el => el.scrollTop) } : null;
  App.pendingBlocks = 0;
  main.innerHTML = '';
  try {
    main.append((pages[App.page] || pages.overview)());
  } catch (e) {
    console.error(e);
    main.append(callout('err', 'render error: ' + e.message));
  }
  App.renderedPage = App.page;
  syncHash();
  if (keep && keep.top > 0) restoreScroll(main, keep);
}

/* Keep #hash = page/tab?sel so links and Back work: a new page or tab is a
   history entry, a changed selection only replaces the current one. */
function syncHash() {
  const want = currentHash(), cur = location.hash.replace('#', '');
  if (want === cur) return;
  const head = s => s.split('?')[0];
  if (cur && head(want) !== head(cur)) history.pushState(null, '', '#' + want);
  else history.replaceState(null, '', '#' + want);
}

export function restoreScroll(main, keep) {
  const spacer = h('div', { class: 'scroll-keep', style: { height: Math.max(0, keep.height - main.scrollHeight) + 'px' } });
  main.append(spacer);
  main.scrollTop = keep.top;
  const inner = () => main.querySelectorAll(SCROLLERS).forEach((el, i) => { if (isNum(keep.inner[i]) && !el.scrollTop) el.scrollTop = keep.inner[i]; });
  inner();
  const done = () => { spacer.remove(); if (App.scrollSpacer === done) App.scrollSpacer = null; };
  App.scrollSpacer = done;
  App.scrollInner = inner;   // tables inside async blocks appear later
  if (!App.pendingBlocks) done();
  else setTimeout(done, 4000);   // in case a block never settles
}

export async function refresh(force) {
  if (App.stopped) return;
  try {
    const s = await api('/api/state');
    const hash = stateHash(s);
    const changed = hash !== App.lastHash;
    App.state = s;
    App.lastHash = hash;
    if (changed) dropUnversionedCache();
    if (changed || force) render(force);
    else { renderTopbar(); renderActivity(); }
  } catch (e) {
    $('#topbar-right').innerHTML = '';
    $('#topbar-right').append(h('span', { class: 'pill err' }, h('span', { class: 'dot' }), 'server unreachable — is `python -m rpa gui` still running?'));
  }
}

export function connectEvents() {
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

export async function init() {
  applyTheme();
  applyHash(location.hash);
  window.addEventListener('hashchange', () => { if (location.hash.replace('#', '') !== currentHash() && applyHash(location.hash)) { render(true); $('#main').scrollTo(0, 0); } });
  window.addEventListener('beforeunload', e => { const ps = App.ps.inputs; if (ps && ps.edits && Object.keys(ps.edits).length) { e.preventDefault(); e.returnValue = ''; } });
  document.addEventListener('keydown', e => { if (e.key === 'Escape') { const lb = $('#lightbox'); if (!lb.hidden) lb.hidden = true; } });
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


// ---- sustainer selection summary (motors.sustainer_selection from /api/state) ----
/* Labels the optimizer actually flies: the cached pick, else the
   max-impulse candidate (mode best, or nothing picked yet). */

App.render = render;
App.renderActivity = renderActivity;
App.refresh = refresh;
