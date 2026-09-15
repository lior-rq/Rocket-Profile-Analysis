import { $, App, ago, api, dur, h, lightbox, pageState, pages, render, spinner, toast } from '../core.js';
import { asyncBlock, badge, confirmBtn, dataTable, fileRow, kv, runButton, workerCard } from '../components.js';

const LINE_CLS = t => /Traceback|Error|error|FAIL|failure|failed/.test(t) ? 'bad' : /!!|warning|WARN/.test(t) ? 'warn' : '';
/* The worker's console with error lines highlighted; follows the tail
   unless the user scrolled up. */
function consoleCard(w, ps) {
  const box = h('div', { class: 'console worker-console' });
  const fill = lines => { box.innerHTML = ''; box.append(...lines.map(t => h('div', { class: 'ln ' + LINE_CLS(t) }, t))); if (ps.follow !== false) requestAnimationFrame(() => { box.scrollTop = box.scrollHeight; }); };
  fill(w.console_tail || ['nothing yet']);
  const full = h('button', { class: 'btn sm ghost', onclick: async e => { const b = e.currentTarget; b.disabled = true; try { const t = await api('/api/text?path=worker/console.log'); fill(t.text.split('\n')); box.classList.add('tall'); } catch (err) { toast(err.message, 'err'); } b.disabled = false; } }, 'full log');
  return h('div', { class: 'card' },
    h('h2', null, 'Worker console', h('span', { class: 'right row gap-1' }, w.last_seen ? `worker/console.log · ${ago(w.last_seen)}` : 'no console.log', full,
      h('button', { class: 'btn sm ghost', onclick: () => { box.scrollTop = box.scrollHeight; } }, 'jump to latest'),
      h('label', { class: 'check small' }, h('input', { type: 'checkbox', checked: ps.follow !== false, onchange: e => { ps.follow = e.target.checked; if (ps.follow) box.scrollTop = box.scrollHeight; } }), 'follow'))),
    box);
}
async function jobAction(name, action) {
  try { await api('/api/job/' + encodeURIComponent(name), { body: { action } }); if (action !== 'reveal') { toast(`job ${name}: ${action === 'discard' ? 'discarded' : 'deleted'}`, 'ok'); App.ps.worker.full = null; render(true); } }
  catch (e) { toast(e.message, 'err'); }
}

// ---- worker & jobs ----------------------------------------------------------
pages.worker = () => {
  const s = App.state;
  const ps = pageState('worker', { sel: null });
  // the state payload carries a trimmed worker view; this page wants all of it
  const full = ps.full && ps.fullAt === s.now ? ps.full : null;
  if (!full) {
    return asyncBlock(async () => { ps.full = await api('/api/worker'); ps.fullAt = s.now; return workerPage(s, ps); }, 'Loading jobs…');
  }
  return workerPage(s, ps);
};

export function workerPage(s, ps) {
  const w = ps.full;
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
        h('div', { class: 'row mt-1' }, h('button', { class: 'btn sm', onclick: async e => { const b = e.currentTarget; b.disabled = true; b.prepend(spinner()); try { const g = await api('/api/vm/guest'); ps.guest = g; } catch (err) { ps.guest = { error: err.message }; } render(true); } }, 'Query the guest (who is logged on, task state, worker processes)'),
          ps.guest ? h('span', { class: 'small ' + (ps.guest.error ? '' : 'muted'), style: ps.guest.error ? { color: 'var(--err)' } : null }, ps.guest.error ? ps.guest.error : `user ${ps.guest.user || 'nobody'} · task ${ps.guest.task} · ${(ps.guest.workers || []).length} worker process(es)${(ps.guest.workers || []).length ? ' (pid ' + ps.guest.workers.map(x => x.pid).join(', ') + ')' : ''} · ${ps.guest.time}`) : null))),
    consoleCard(w, ps),
    h('div', { class: 'stack' },
      h('div', { class: 'card' }, h('h2', null, `Jobs (${w.jobs.length} of ${w.n_jobs})`, h('span', { class: 'right' }, h('input', { type: 'text', class: 'searchbox', placeholder: 'filter jobs…', value: ps.q || '', onchange: e => { ps.q = e.target.value; render(true); } }))),
        h('div', { class: 'jobs-table' }, dataTable({
          columns: ['name', 'state', 'why', 'type', 'done', 'created', 'actions'],
          rows: (ps.q ? w.jobs.filter(j => `${j.name} ${j.type} ${j.state}`.toLowerCase().includes(ps.q.toLowerCase())) : w.jobs).map(j => ({ ...j, why: j.done && j.done.status !== 'ok' ? (j.done.message || 'failed') : '', actions: '' })),
          labels: { done: 'took', actions: '' },
          format: {
            state: v => badge({ ok: 'ok', failed: 'err', running: 'running', queued: 'queued', orphan: 'orphan', empty: 'todo' }[v] || 'todo', v),
            why: v => v || '—', type: v => ({ aero_export: 'aero', export_batch: 'export×n', rerun_save: 'rerun' }[v] || v), done: v => v ? `${dur(v.elapsed_s)}` : '—', created: v => v ? v.replace('T', ' ').slice(5, 16) : '—',
            actions: (v, r) => h('span', { class: 'row gap-1', onclick: e => e.stopPropagation() },
              h('button', { class: 'btn sm ghost', title: 'reveal the job folder in Finder', onclick: () => jobAction(r.name, 'reveal') }, 'reveal'),
              ['queued', 'orphan', 'empty'].includes(r.state) ? confirmBtn('discard', 'sure?', () => jobAction(r.name, 'discard'), 'btn sm ghost') : null,
              ['ok', 'failed'].includes(r.state) ? confirmBtn('delete', 'sure?', () => jobAction(r.name, 'delete'), 'btn sm ghost') : null),
          },
          wrap: ['why'], onRow: r => { ps.sel = r.name; render(true); }, rowKey: r => r.name, selected: ps.sel, maxHeight: '460px', stickyFirst: true, tools: { chooser: 'worker.jobs', csv: 'jobs.csv', hiddenDefault: ['type'] },
        }))),
      h('div', { class: 'card' }, h('h2', null, 'Job detail'), jobDetail)));
};
