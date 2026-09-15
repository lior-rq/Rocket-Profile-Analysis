import { $, App, STATUS_TEXT, STEPS, ago, api, blockSettled, busy, dateTime, dur, esc, fmt, go, h, isNum, render, sizeFmt, spinner, stepStatus, toast } from './core.js';

// ============================================================================
// generic components
// ============================================================================
export const badge = (st, text) => h('span', { class: 'badge ' + st }, text || STATUS_TEXT[st] || st);

export function kv(pairs) {
  return h('div', { class: 'kv' }, pairs.filter(p => p).map(([k, v]) => [h('div', { class: 'k' }, k), h('div', { class: 'v' }, v)]));
}
/* A unit longer than a few characters is shown as a clipped sub-line, so
   tiles in a row stay one value high. */

export function stat(label, value, unit, cls, sub) {
  if (unit && String(unit).length > 12 && !sub) { sub = unit; unit = null; }
  return h('div', { class: 'stat ' + (cls || ''), title: sub || null },
    h('div', { class: 'l', title: label }, label),
    h('div', { class: 'v', title: value instanceof Node ? null : String(value) }, value, unit ? h('small', null, ' ' + unit) : null),
    sub ? h('div', { class: 's' }, sub) : null);
}

export function callout(kind, ...kids) { return h('div', { class: 'callout ' + kind }, ...kids); }

export function cmdPreview(stage, args) {
  return h('div', { class: 'cmd', title: 'the equivalent command line' }, '$ .venv/bin/python -m rpa ', h('b', null, [stage, ...(args || [])].join(' ')));
}

export function outcomeText(r) { return r.cancelled ? 'cancelled' : r.exit_code === 0 ? 'finished' : (r.exit_code === 1 && ['check', 'validate'].includes(r.stage)) ? 'finished with findings' : 'failed (exit ' + r.exit_code + ')'; }

export async function cancelRun() { try { await api('/api/cancel', { body: {} }); toast('cancel requested'); } catch (e) { toast(e.message, 'err'); } }

const LIGHT_STAGES = ['check', 'report'];  // may run beside a long stage (rpa/gui/runner.py)
export function runButton({ stage, args = [], label, primary, disabled, title, cls, confirmText }) {
  const r = App.state && App.state.runner;
  const side = r && r.side;
  const same = (x) => x && x.stage === stage && JSON.stringify(x.args) === JSON.stringify(args);
  const mine = (busy() && same(r)) || same(side);
  const blocked = busy() && !(LIGHT_STAGES.includes(stage) && !side);
  const b = h('button', { class: 'btn ' + (primary ? 'primary ' : '') + (mine ? 'running ' : '') + (cls || ''), disabled: disabled || blocked, title: blocked ? `busy: ${r.stage} is running${side ? ' and ' + side.stage + ' beside it' : ''}` : (title || '') }, mine ? spinner() : null, mine ? 'running…' : (label || `Run ${stage}`));
  let armed = null;   // confirmText: the first click arms the button, the second runs
  b.onclick = async () => {
    if (confirmText && !armed) {
      armed = setTimeout(() => { armed = null; b.textContent = label || `Run ${stage}`; b.classList.remove('danger'); b.title = title || ''; }, 6000);
      b.textContent = 'Click again to confirm';
      b.title = confirmText;
      b.classList.add('danger');
      return;
    }
    if (armed) { clearTimeout(armed); armed = null; b.classList.remove('danger'); }
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

export function stepPage({ id, summary, action, content, how, extraStatus }) {
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
export function actionPanel({ prereqs = [], buttons = [], options, cmd, notes = [], title }) {
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

export function fileRow(fi, opts = {}) {
  const cls = !fi.exists ? '' : opts.stale ? 'stale' : 'ok';
  return h('div', { class: 'f ' + cls, title: fi.path },
    h('span', { class: 'i' }),
    h('span', { class: 'n' }, fi.name || fi.path),
    fi.exists ? h('span', { class: 'm' }, `${sizeFmt(fi.size)} · ${ago(fi.mtime)}`) : h('span', { class: 'm' }, 'missing'));
}

export function subTabs(ps, key, items, onChange) {
  return h('div', { class: 'tabs', role: 'tablist' }, items.map(([k, label, extra]) => h('button', { class: 'tab ' + (ps[key] === k ? 'active' : ''), type: 'button', role: 'tab', 'aria-selected': String(ps[key] === k), onclick: () => { ps[key] = k; if (onChange) onChange(k); else render(true); } }, label, extra != null && extra !== '' ? h('span', { class: 'tab-extra' }, extra) : null)));
}

/* A small dialog with a focus trap; resolves true on OK. Replaces window.confirm. */
export function modal({ title, body, okLabel = 'OK', cancelLabel = 'Cancel', danger }) {
  return new Promise(resolve => {
    const prev = document.activeElement;
    const ok = h('button', { class: 'btn ' + (danger ? 'danger' : 'primary'), onclick: () => done(true) }, okLabel);
    const cancel = h('button', { class: 'btn', onclick: () => done(false) }, cancelLabel);
    const box = h('div', { class: 'modal', role: 'dialog', 'aria-modal': 'true', 'aria-label': title }, h('h3', null, title), h('div', { class: 'modal-body' }, body), h('div', { class: 'row', style: { justifyContent: 'flex-end' } }, cancel, ok));
    const back = h('div', { class: 'modal-back', onclick: e => { if (e.target === back) done(false); } }, box);
    const key = e => {
      if (e.key === 'Escape') { e.preventDefault(); done(false); }
      else if (e.key === 'Tab') { const f = [cancel, ok]; const i = f.indexOf(document.activeElement); e.preventDefault(); f[(i + (e.shiftKey ? -1 : 1) + f.length) % f.length].focus(); }
    };
    const done = v => { document.removeEventListener('keydown', key, true); back.remove(); if (prev && prev.focus) prev.focus(); resolve(v); };
    document.addEventListener('keydown', key, true);
    document.body.append(back);
    ok.focus();
  });
}

export const WORKER_CLS = { busy: 'run', online: 'ok', idle: 'ok', queued: 'warn', unresponsive: 'err', offline: 'err', unknown: 'todo' };

export const workerUp = s => ['busy', 'online', 'idle', 'queued'].includes(s.worker.state);

export const workerOk = s => workerUp(s) ? true : 'warn';

export function vmButtons(s, opts = {}) {
  const w = s.worker, vm = w.vm || {};
  const op = vm.op || {};
  const call = async (path, label) => {
    try { await api(path, { body: {} }); App.collapsed = false; toast(label); }
    catch (e) { toast(e.message, 'err'); }
  };
  if (!vm.available) return h('span', { class: 'muted small' }, 'UTM not found on this Mac (config vm.utmctl) — start the worker by hand: ', h('code', null, 'python Z:\\worker\\run_worker.py'));
  const busyOp = op.running;
  const start = h('button', { class: 'btn ' + (opts.primary === false ? '' : 'primary ') + (opts.small ? 'sm' : ''), disabled: busyOp || workerUp(s), title: workerUp(s) ? 'the worker is already running' : `boots the UTM VM "${vm.name}" if needed and starts the worker on its desktop`, onclick: () => call('/api/vm/start', 'starting the VM worker — progress in the activity log') }, busyOp && op.op === 'start' ? spinner() : '▶', ' ', busyOp && op.op === 'start' ? 'starting…' : 'Start VM worker');
  const stopping = busyOp && op.op === 'stop';
  const stop = w.state === 'busy' && !busyOp
    ? confirmBtn('■ Stop worker', 'Job in progress — click again to stop it', () => call('/api/vm/stop', 'stopping the worker'), 'btn ' + (opts.small ? 'sm' : ''))
    : h('button', { class: 'btn ' + (opts.small ? 'sm' : ''), disabled: busyOp || !workerUp(s), onclick: () => call('/api/vm/stop', 'stopping the worker') }, stopping ? spinner() : '■', ' ', stopping ? 'stopping…' : 'Stop worker');
  return h('span', { class: 'row gap-1' }, start, opts.noStop ? null : stop);
}

export function workerNote(s) {
  const w = s.worker;
  if (workerUp(s)) return null;
  const op = (w.vm || {}).op || {};
  return callout(op.running ? 'info' : 'warn', h('b', null, 'VM worker is ' + w.state + ': '), w.detail, '. ', op.running ? h('span', null, spinner(), ` ${op.op === 'start' ? 'starting' : 'stopping'}… (${dur(op.elapsed_s)}, details in the activity log)`) : vmButtons(s, { small: true, noStop: true }), ' ', h('a', { href: '#worker', onclick: e => { e.preventDefault(); go('worker'); } }, 'worker page'));
}

// ---- data table -------------------------------------------------------------
/* Sortable table. `tools` adds a toolbar: row count, a column chooser
   (persisted under localStorage 'rpa-cols:<chooser>'), CSV export of the
   rows as shown. Headers are buttons and clickable rows take the keyboard. */
export function dataTable({ columns, rows, labels = {}, format = {}, hide = [], onRow, rowKey, selected, sort, rowClass, wrap = [], maxHeight, cellClass, tools, stickyFirst }) {
  const storeKey = tools && tools.chooser ? 'rpa-cols:' + tools.chooser : null;
  let hidden = new Set(hide);
  if (storeKey) {
    let stored = null;
    try { stored = JSON.parse(localStorage.getItem(storeKey) || 'null'); } catch (e) { /* ignore */ }
    for (const c of (Array.isArray(stored) ? stored : (tools.hiddenDefault || []))) hidden.add(c);
  }
  const st = { key: sort ? sort.key : null, dir: sort ? (sort.dir || 1) : 1 };
  const wrapEl = h('div', { class: 'tablewrap', style: maxHeight ? { maxHeight } : null });
  const isNumCol = c => rows.some(r => isNum(r[c]));
  const sorted = () => {
    const data = rows.slice();
    if (st.key) {
      const k = st.key, d = st.dir;
      data.sort((a, b) => {
        const x = a[k], y = b[k];
        if (x === null || x === undefined) return 1;
        if (y === null || y === undefined) return -1;
        return (isNum(x) && isNum(y) ? x - y : String(x).localeCompare(String(y))) * d;
      });
    }
    return data;
  };
  const draw = () => {
    const cols = columns.filter(c => !hidden.has(c));
    const data = sorted();
    const thead = h('thead', null, h('tr', null, cols.map(c => h('th', { class: (isNumCol(c) ? 'n ' : '') + (st.key === c ? 'sorted' : ''), 'aria-sort': st.key === c ? (st.dir > 0 ? 'ascending' : 'descending') : 'none' },
      h('button', { class: 'th-btn', type: 'button', onclick: () => { if (st.key === c) st.dir *= -1; else { st.key = c; st.dir = 1; } draw(); } }, (labels[c] || c) + (st.key === c ? (st.dir > 0 ? ' ▲' : ' ▼') : ''))))));
    const tbody = h('tbody', null, data.map(r => {
      const key = rowKey ? rowKey(r) : null;
      const tr = h('tr', { class: [onRow ? 'clickable' : '', selected && key === selected ? 'sel' : '', rowClass ? rowClass(r) : ''].join(' '), tabindex: onRow ? '0' : null, onclick: onRow ? () => onRow(r) : null, onkeydown: onRow ? e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onRow(r); } } : null },
        cols.map(c => {
          const v = r[c];
          const content = format[c] ? format[c](v, r) : fmt(v);
          return h('td', { class: [isNumCol(c) ? 'n' : '', wrap.includes(c) ? 'wrap' : '', cellClass ? (cellClass(c, v, r) || '') : ''].join(' ') }, content);
        }));
      return tr;
    }));
    wrapEl.innerHTML = '';
    wrapEl.append(h('table', { class: 'data' + (stickyFirst ? ' sticky-first' : '') }, thead, tbody));
  };
  draw();
  if (!tools) return wrapEl;
  const bar = h('div', { class: 'table-tools' });
  if (tools.count !== false) bar.append(h('span', { class: 'muted small' }, `${rows.length} row${rows.length === 1 ? '' : 's'}`));
  if (tools.chooser) {
    bar.append(h('details', { class: 'col-chooser' }, h('summary', { class: 'btn sm' }, 'columns ▾'),
      h('div', { class: 'col-list' }, columns.filter(c => !hide.includes(c)).map(c => h('label', { class: 'check small' },
        h('input', { type: 'checkbox', checked: !hidden.has(c), onchange: e => { if (e.target.checked) hidden.delete(c); else hidden.add(c); try { localStorage.setItem(storeKey, JSON.stringify([...hidden])); } catch (err) { /* ignore */ } draw(); } }), labels[c] || c)))));
  }
  if (tools.csv) bar.append(h('button', { class: 'btn sm', onclick: () => downloadCsv(tools.csv, columns.filter(c => !hidden.has(c) && c !== 'star'), sorted(), labels) }, 'Export CSV'));
  if (tools.extra) bar.append(...[].concat(tools.extra).filter(Boolean));
  return h('div', null, bar, wrapEl);
}
function downloadCsv(name, cols, rows, labels) {
  const q = v => { const s = v == null ? '' : String(v); return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; };
  const text = [cols.map(c => q(labels[c] || c)).join(',')].concat(rows.map(r => cols.map(c => q(r[c])).join(','))).join('\n');
  const url = URL.createObjectURL(new Blob([text], { type: 'text/csv' }));
  const a = h('a', { href: url, download: name });
  document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

// ---- minimal markdown (report.md) -------------------------------------------
export function mdRender(text) {
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

/* report.md with a table of contents and the long tables folded: the
   characterization and design tables run to hundreds of rows. */

export function reportView(text, fold = 25, foldAbove = 50) {
  const md = mdRender(text);
  const heads = [...md.querySelectorAll('h1, h2, h3')];
  heads.forEach((el, i) => { el.id = 'rep-' + i; });
  const toc = heads.length > 1 ? h('nav', { class: 'report-toc' }, h('span', { class: 'muted small' }, 'Contents:'), heads.map(el => h('a', { href: '#' + el.id, class: 'toc-' + el.tagName.toLowerCase(), onclick: e => { e.preventDefault(); el.scrollIntoView({ block: 'start', behavior: 'smooth' }); } }, el.textContent))) : null;
  for (const table of md.querySelectorAll('table')) {
    const rows = table.tBodies[0] ? [...table.tBodies[0].rows] : [];
    if (rows.length <= foldAbove) continue;
    rows.slice(fold).forEach(r => { r.hidden = true; });
    const btn = h('button', { class: 'btn sm mt-2', onclick: () => { rows.forEach(r => { r.hidden = false; }); btn.remove(); } }, `show all ${rows.length} rows`);
    table.parentElement.after(btn);
  }
  return h('div', null,
    h('div', { class: 'row mb-2', style: { justifyContent: 'space-between' } }, toc || h('span'), h('button', { class: 'btn sm', onclick: () => api('/api/reveal', { body: { path: 'output/report.md' } }).catch(e => toast(e.message, 'err')) }, 'Reveal report.md')),
    md);
}

// ============================================================================
// data loading with caching
// ============================================================================
/* Fetch-once cache. An entry with a `version` (the mtime of the file it
   came from, as reported by /api/state) stays valid while that version
   holds; entries without one expire after `ttl` and on any state change. */

export function asyncBlock(fn, placeholder = 'Loading…') {
  const el = h('div', null, h('div', { class: 'loading-inline' }, spinner(), placeholder));
  App.pendingBlocks = (App.pendingBlocks || 0) + 1;
  Promise.resolve().then(fn).then(node => { el.innerHTML = ''; if (node) el.append(node); blockSettled(); }).catch(e => { el.innerHTML = ''; el.append(callout('err', e.message)); blockSettled(); });
  return el;
}

export function runHistory(hist) {
  if (!hist || !hist.length) return h('div', { class: 'muted small' }, 'nothing has been run from this GUI yet');
  const rows = hist.slice().reverse().slice(0, 12);
  const failed = r => r.exit_code !== 0 && !r.cancelled && !(r.exit_code === 1 && ['check', 'validate'].includes(r.stage));
  return h('div', { class: 'filelist runs' }, rows.map(r => h('div', { class: 'f clickable ' + (r.exit_code === 0 ? 'ok' : r.cancelled ? '' : 'stale'), title: 'open the log', tabindex: '0', onclick: () => go('runs', { sel: String(r.started) }), onkeydown: e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); go('runs', { sel: String(r.started) }); } } },
    h('span', { class: 'i', style: failed(r) ? { background: 'var(--err)' } : null }),
    h('span', { class: 'n' }, ['rpa', r.stage, ...(r.args || [])].join(' ')),
    h('span', { class: 'm' }, `${outcomeText(r)} · ${dur(r.elapsed_s)} · ${dateTime(r.finished)}`),
    failed(r) && r.last_error ? h('span', { class: 'err-line' }, r.last_error) : null)));
}

export function workerCard(s) {
  const w = s.worker, vm = w.vm || {}, op = vm.op || {}, hb = w.heartbeat;
  const cls = WORKER_CLS[w.state] || 'todo';
  return h('div', { class: 'card' }, h('h2', null, 'RASAero worker (VM)', h('span', { class: 'right' }, h('a', { href: '#worker', onclick: e => { e.preventDefault(); go('worker'); } }, 'details →'))),
    h('div', { class: 'row between' }, h('span', { class: 'row' }, badge(cls, w.state), h('span', { class: 'muted small' }, w.detail)), vmButtons(s, { small: true })),
    op.running ? h('div', { class: 'loading-inline' }, spinner(), `${op.op === 'start' ? 'starting' : 'stopping'} the worker… ${dur(op.elapsed_s)} — progress in the activity log`) : op.finished ? h('div', { class: 'small ' + (op.ok ? 'muted' : ''), style: op.ok ? null : { color: 'var(--err)' } }, `${op.op}: ${op.message} (${ago(op.finished)})`) : null,
    h('div', { class: 'kv small mt-1' },
      h('div', { class: 'k' }, 'UTM virtual machine'), h('div', { class: 'v' }, vm.available ? `${vm.name}: ${vm.status || 'not found'}` : 'utmctl not found (vm.utmctl in config.yaml)'),
      h('div', { class: 'k' }, 'heartbeat'), h('div', { class: 'v' }, hb ? `${hb.status}, ${ago(hb.epoch)} · ${hb.host || ''}${hb.user ? ' / ' + hb.user : ''} · pids ${hb.launcher_pid}/${hb.worker_pid || '?'}` : 'none yet (written by run_worker.py every 15 s)'),
      h('div', { class: 'k' }, 'last console activity'), h('div', { class: 'v' }, w.last_seen ? `${ago(w.last_seen)} (${dateTime(w.last_seen)})` : 'no log'),
      h('div', { class: 'k' }, 'worker version'), h('div', { class: 'v' }, w.version ? 'v' + w.version : '—'),
      h('div', { class: 'k' }, 'queue'), h('div', { class: 'v' }, `${w.n_active} running, ${w.n_queued} waiting${w.n_orphan ? `, ${w.n_orphan} orphan` : ''}`),
      w.current_job ? h('div', { class: 'k' }, 'current job') : null, w.current_job ? h('div', { class: 'v' }, `${w.current_job.name}${w.current_job.elapsed_s != null ? ' · ' + dur(w.current_job.elapsed_s) : ''}`) : null,
      h('div', { class: 'k' }, 'mode'), h('div', { class: 'v' }, w.mode === 'auto' ? 'auto (worker polls jobs/)' : 'manual (you drive RASAero by hand)')));
}

export function confirmBtn(label, armedLabel, fn, cls = 'btn sm') {
  let armed = null;
  const b = h('button', { class: cls }, label);
  b.onclick = async () => {
    if (!armed) { armed = setTimeout(() => { armed = null; b.textContent = label; b.classList.remove('danger'); }, 5000); b.textContent = armedLabel; b.classList.add('danger'); return; }
    clearTimeout(armed); armed = null; b.disabled = true; b.textContent = label; b.classList.remove('danger');
    try { await fn(); } finally { b.disabled = false; }
  };
  return b;
}

export function sustainerSummary(m) {
  const sel = m.sustainer_selection || {};
  const picked = sel.selected;
  if (picked && picked.length) return `${picked.map(x => x.label).join(', ')} (${sel.mode}, ${picked.length} of ${m.n_sustainer_candidates})`;
  if (sel.mode === 'best' || !sel.mode) return `${m.sustainer.label} (${fmt(m.sustainer.total_impulse_ns, 0)} N·s, highest of ${m.n_sustainer_candidates})`;
  return `${sel.mode}: picked at the mass step (${m.n_sustainer_candidates} candidates)`;
}

export function sustainerStat(m) {
  const sel = m.sustainer_selection || {}, n = m.n_sustainer_candidates;
  const picked = sel.selected;
  if (picked && picked.length === 1) return stat('sustainer searched', picked[0].label, null, null, `${sel.mode} · 1 of ${n} candidates`);
  if (picked && picked.length) return stat('sustainers searched', picked.length, `of ${n}`, null, `${sel.mode}: ${picked.map(x => x.label).join(', ')}`);
  if (sel.mode === 'best' || !sel.mode) return stat('sustainer searched', m.sustainer.label, null, null, `highest impulse of ${n} candidates`);
  return stat('sustainers searched', 'not picked yet', null, null, `${sel.mode} · ${n} candidates`);
}
