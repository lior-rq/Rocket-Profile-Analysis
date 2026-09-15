import { App, api, dateTime, dur, go, h, pageState, pages, render, sizeFmt, toast } from '../core.js';
import { asyncBlock, badge, confirmBtn, dataTable, outcomeText } from '../components.js';

// ---- runs & logs: every command started from the GUI, its log, the snapshots -
const FINDINGS = ['check', 'validate'];
const outcomeClass = r => r.cancelled ? 'todo' : r.exit_code === 0 ? 'ok' : (r.exit_code === 1 && FINDINGS.includes(r.stage)) ? 'warn' : 'err';

pages.runs = () => {
  const ps = pageState('runs', { sel: null });
  return asyncBlock(async () => {
    const [rr, ar] = await Promise.all([api('/api/runs'), api('/api/archives')]);
    const hist = rr.history.slice().reverse();
    const rows = hist.map(r => ({ ...r, id: String(r.started), cmd: ['rpa', r.stage, ...(r.args || [])].join(' '), outcome: outcomeText(r) + (r.side ? ' · beside a run' : '') }));
    const sel = rows.find(r => r.id === String(ps.sel)) || null;
    const table = dataTable({
      columns: ['finished', 'cmd', 'outcome', 'elapsed_s', 'last_error', 'log'], rows,
      labels: { cmd: 'command', elapsed_s: 'took', last_error: 'last error line' },
      format: { finished: v => dateTime(v), elapsed_s: v => dur(v), outcome: (v, r) => badge(outcomeClass(r), v), log: v => v ? 'view' : '—', last_error: v => v || '—' },
      onRow: r => { ps.sel = r.id; render(true); }, rowKey: r => r.id, selected: sel ? sel.id : null, wrap: ['last_error'], maxHeight: '420px', tools: { csv: 'runs.csv' },
    });
    const logView = sel && sel.log
      ? asyncBlock(async () => { const t = await api('/api/text?path=' + encodeURIComponent(sel.log)); return h('pre', { class: 'console log-view' }, t.text || '(empty)'); }, 'Loading log…')
      : h('div', { class: 'muted small' }, sel ? 'no log file for this run (it predates per-run logs)' : 'select a run above to read its log');
    const archives = ar.archives || [];
    return h('div', { class: 'stack' },
      h('div', { class: 'page-head' },
        h('div', null, h('h1', null, 'Runs & logs'), h('div', { class: 'desc' }, 'Every command started from this GUI with its outcome and full log (output/gui_logs/), and the result snapshots kept in output-archive/ — one is taken automatically before every fresh run, so the previous answer is never lost.')),
        h('div', { class: 'actions' }, confirmBtn('Snapshot current results', 'Click again to snapshot', async () => { try { const r = await api('/api/archive', { body: {} }); toast(`snapshot ${r.name} (${r.files.length} files)`, 'ok'); render(true); } catch (e) { toast(e.message, 'err'); } }, 'btn'))),
      h('div', { class: 'card' }, h('h2', null, `Runs (${rows.length})`, h('span', { class: 'right' }, 'click a row for its log')), rows.length ? table : h('div', { class: 'muted small' }, 'nothing has been run from this GUI yet')),
      h('div', { class: 'card' }, h('h2', null, sel ? `Log · rpa ${[sel.stage, ...(sel.args || [])].join(' ')} · ${dateTime(sel.finished)}` : 'Log', sel && sel.log ? h('span', { class: 'right mono' }, sel.log) : null), logView),
      h('div', { class: 'card' }, h('h2', null, `Result snapshots (${archives.length})`, h('span', { class: 'right' }, 'compared on Results › Previous runs')),
        archives.length
          ? dataTable({ columns: ['name', 'label', 'n_designs', 'mtime', 'bytes'], rows: archives, labels: { n_designs: 'designs', mtime: 'taken', bytes: 'size' }, format: { mtime: v => dateTime(v), bytes: v => sizeFmt(v), label: v => v || '—' }, onRow: r => go('results', { tab: 'previous', archive: r.name }), rowKey: r => r.name, maxHeight: '320px' })
          : h('div', { class: 'muted small' }, 'none yet — one is taken automatically before every fresh run, or press Snapshot current results')));
  }, 'Loading runs…');
};
