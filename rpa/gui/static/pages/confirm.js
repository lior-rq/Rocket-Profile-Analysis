import { App, ago, fmt, h, isNum, pageState, pages, render } from '../core.js';
import { callout, cmdPreview, dataTable, runButton, stat, stepPage, workerNote, workerOk } from '../components.js';

// ---- step 7: confirm --------------------------------------------------------
pages.confirm = () => {
  const s = App.state, c = s.confirm, d = s.results;
  const shortlist = d.shortlist || [];
  const ps = pageState('confirm', { top: 3, unsolved: true, mode: 'top' });
  const mode = ps.mode === 'shortlist' && shortlist.length ? 'shortlist' : 'top';
  const args = mode === 'shortlist' ? ['--designs', shortlist.join(',')] : ['--top', String(ps.top), ...(ps.unsolved ? ['--include-unsolved'] : [])];
  const radio = (value, label, extra) => h('label', { class: 'check' }, h('input', { type: 'radio', name: 'confirm-mode', checked: mode === value, disabled: value === 'shortlist' && !shortlist.length, onchange: () => { ps.mode = value; render(true); } }), label, extra || null);
  return stepPage({
    id: 'confirm',
    summary: 'The chosen designs are written into one CDX1 and re-run through RASAero II in the VM — the tool of record — and RASAero\'s apogee is compared with the Python simulator\'s. Use it to sign off on the final choice.',
    action: {
      vm: true,
      prereqs: [{ label: `${d.n || 0} designs`, ok: d.n > 0, hint: 'run the optimizer first (step 5)' }, { label: 'VM worker', ok: workerOk(s), hint: 'the worker does not seem to be running in the VM' }],
      buttons: [runButton({ stage: 'confirm', args, label: mode === 'shortlist' ? `Confirm the ${shortlist.length} shortlisted in RASAero` : `Confirm the top ${ps.top} in RASAero`, primary: true, disabled: !d.n })],
      options: h('div', { class: 'stack gap-1' },
        h('div', { class: 'row' }, radio('top', 'the', h('input', { type: 'number', min: 1, max: 100, class: 'inline-num', value: ps.top, onchange: e => { ps.top = Number(e.target.value) || 3; ps.mode = 'top'; render(true); } }), ' designs closest to the target'),
          h('label', { class: 'check', hidden: mode !== 'top' }, h('input', { type: 'checkbox', checked: ps.unsolved, onchange: e => { ps.unsolved = e.target.checked; render(true); } }), 'include unsolved designs (the closest ones when nothing is solved)')),
        h('div', { class: 'row' }, radio('shortlist', shortlist.length ? `the ${shortlist.length} shortlisted design${shortlist.length === 1 ? '' : 's'}` : 'the shortlist (empty — star designs on the Results page)'))),
      notes: [
        d.n && !d.n_solved && !ps.unsolved && mode === 'top' ? callout('warn', 'There are no solved designs; tick “include unsolved” to confirm the closest ones.') : null,
        c.stale ? callout('warn', 'designs.csv is newer than this confirmation — re-run it.') : null,
        workerNote(s)],
      cmd: cmdPreview('confirm', args),
    },
    content: [
      h('div', { class: 'card' }, h('h2', null, 'RASAero vs python', h('span', { class: 'right' }, c.file.exists ? ago(c.file.mtime) : '')),
        c.rows.length ? h('div', null,
          h('div', { class: 'stat-list mb-3' }, stat('designs confirmed', c.rows.length), stat('max |difference|', fmt(Math.max(...c.rows.map(r => Math.abs(r.diff_pct || 0))), 2), '%', Math.max(...c.rows.map(r => Math.abs(r.diff_pct || 0))) < 1 ? 'ok' : 'warn'), stat('mean difference', fmt(c.rows.reduce((a, r) => a + (r.diff_pct || 0), 0) / c.rows.length, 2), '%')),
          dataTable({ columns: ['booster', 'sustainer', 'profile', 'sep_delay_s', 'ign_delay_s', 'apogee_python_ft', 'apogee_rasaero_ft', 'diff_ft', 'diff_pct', 'max_vel_rasaero_fps', 't_apogee_rasaero_s'], rows: c.rows, labels: { sep_delay_s: 'sep [s]', ign_delay_s: 'ign [s]', apogee_python_ft: 'python apogee', apogee_rasaero_ft: 'RASAero apogee', diff_ft: 'Δ ft', diff_pct: 'Δ %', max_vel_rasaero_fps: 'RASAero max vel', t_apogee_rasaero_s: 'RASAero t apogee' }, format: { apogee_python_ft: v => fmt(v, 0), apogee_rasaero_ft: v => fmt(v, 0), diff_ft: v => isNum(v) ? (v > 0 ? '+' : '') + fmt(v, 0) : '—', diff_pct: v => isNum(v) ? (v > 0 ? '+' : '') + v.toFixed(2) : '—' }, tools: { csv: 'confirm.csv' } })) : h('div', { class: 'muted' }, 'nothing confirmed yet'))],
    how: h('p', null, 'One batched CDX1 with the chosen rows goes through the VM worker (File → Open, Rerun All Simulations, Save As); RASAero writes MaxAltitude back into the file, and the comparison is stored in ', h('code', null, 'output/confirm.csv'), '. With the shortlist the exact starred designs are sent (', h('code', null, 'rpa confirm --designs …'), ').'),
  });
};
