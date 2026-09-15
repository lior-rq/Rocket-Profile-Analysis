import { $, App, RUN_STAGES, STATUS_TEXT, ago, api, cached, dateTime, dur, eta, fmt, gridSummary, h, pageState, pages, refresh, render, searchedSustainers, sizeFmt, toast } from '../core.js';
import { callout, cancelRun, cmdPreview, confirmBtn, fileRow, outcomeText, runButton, stepPage, workerOk } from '../components.js';

// ---- step 5: optimize -------------------------------------------------------
pages.optimize = () => {
  const s = App.state, o = s.optimize, cfg = s.config;
  const ps = pageState('optimize', { fresh: false, limit: '', boosters: '', unsolved: false, decel: false, backend: '' });
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
    const desc = { motors: 'parse .eng, stage motor files', mass: 'pick the sustainers to search; OpenRocket: weight & CG per (booster, sustainer)', characterize: 'one long-coast flight per (booster, sustainer) → Mach at burnout, eligibility', search: 'ignition-delay sweep + bracket refinement per (booster, sustainer, profile)', verify: 'full time history of each solution, rule check', report: 'report.md, ranked designs, plots' }[st.name];
    const prog = isRun ? [r.round ? `round ${r.round.round}` : null, r.progress && r.progress.total ? `${r.progress.done}/${r.progress.total}` : null].filter(Boolean).join(' · ') : '';
    return h('div', { class: 'substage ' + (isRun ? 'running' : st.done ? (st.stale ? 'stale' : 'done') : ''), title: st.stale && st.changes && st.changes.length ? st.changes.join('\n') : '' }, h('span', { class: 'i' }), h('div', null, h('div', { class: 't' }, st.name, ' ', prog ? h('span', { class: 'muted small' }, prog) : null), h('div', { class: 'd' }, isRun ? 'running…' : st.done ? (st.stale ? 'out of date · ' : '') + ago(st.mtime) : desc)));
  });
  const backendNote = backend === 'python' ? (s.validate.status === 'ok' ? null : callout('warn', h('b', null, 'The python simulator is not validated for this vehicle yet '), `(step 4: ${STATUS_TEXT[s.validate.status] || s.validate.status}). It will still run, but treat the numbers with care until validation passes.`)) : backend === 'rasaero' ? callout('info', 'RASAero backend: every simulation batch goes through the VM worker — expect hours for 60 boosters.') : callout('info', 'OpenRocket backend: preview only, its aerodynamics differ from RASAero.');
  const g = gridSummary(cfg.profiles);
  const nSus = searchedSustainers(s.inputs.motors).size || 1;
  const pairs = (s.inputs.boosters.n || 0) * nSus;
  const elig = s.results.eligibility && Object.keys(s.results.eligibility).length ? Object.values(s.results.eligibility).reduce((a, v) => a + v.eligible, 0) : null;
  const sizeNote = callout('info', h('b', null, 'Search size: '), `${pairs} (booster, sustainer) pairs${elig != null ? `, ${elig} eligible (pair, profile) candidates` : ''} × ${g.sep.length} separation × ${g.ign.length} ignition delays ≈ ${fmt((elig != null ? elig : pairs) * g.sep.length * g.ign.length, 0)} flights in the coarse grid, plus refinement.`,
    g.capped ? h('span', { class: 'warn-text' }, ` Separation step coarsened to ${fmt(g.sepStep, 2)} s (the search caps it at 9 points).`) : '',
    o.last_run ? ` The last full run took ${dur(o.last_run.elapsed_s)}.` : '');
  const changeNote = o.stale && !running ? callout('warn', h('b', null, 'Changed since the last run: '), h('ul', null, (o.changes || []).map(c => h('li', null, c))), 'Tick "fresh run" so every stage is recomputed.') : null;
  return stepPage({
    id: 'optimize',
    summary: `For every booster: one long-coast flight characterizes the attached stack and decides which profiles it is eligible for; then, for each eligible (booster, profile), separation delays ${fmt(cfg.profiles.separation_delay_min_s)}–${fmt(cfg.profiles.separation_delay_max_s)} s and ignition delays ${fmt(cfg.profiles.ignition_delay_min_s)}–${fmt(cfg.profiles.ignition_delay_max_s)} s are searched until the apogee hits ${fmt(cfg.target.apogee_ft, 0)} ± ${fmt(cfg.target.tolerance_ft, 0)} ft. Solutions are re-flown with a full time history and checked against the profile rule.`,
    action: {
      prereqs: [{ label: 'inputs checked', ok: s.inputs.status === 'ok' ? true : s.inputs.status === 'error' ? false : 'warn', hint: s.inputs.status === 'error' ? 'fix the input problems in step 1' : 'inputs not checked since they changed' }, backend === 'python' ? { label: 'simulator validated', ok: s.validate.status === 'ok' ? true : 'warn', hint: 'validation not passing' } : { label: 'VM worker', ok: workerOk(s), hint: 'the worker does not seem to be running' }, { label: `mass ${s.mass.hardware_mass_lb != null ? s.mass.hardware_mass_lb + ' lb' : '.ork'}`, ok: true }],
      buttons: [running ? h('button', { class: 'btn danger', onclick: cancelRun }, 'Cancel run') : runButton({ stage: 'run', args: args(), label: 'Run the optimizer (all stages)', primary: true, confirmText: ps.fresh ? 'Fresh run: the cached mass table, characterization, eligibility and designs in output/ will be deleted and recomputed. Continue?' : null })],
      options: h('div', { class: 'stack', style: { gap: '8px' } },
        h('div', { class: 'row' },
          chk('Fresh run (recompute cached stages)', 'fresh', 'deletes mass_table/characterization/eligibility/designs before running'),
          chk('Export a full time history for every design, not only the solved ones', 'unsolved', '--include-unsolved: verify unsolved designs too. Costs ~1.4 MB per design; without it the results page simulates a design on demand when you open it'),
          chk('Also try "decelerate below Mach 0.9, then separate"', 'decel', 'a supersonic booster coasts attached and separates subsonic; crosses the transonic band twice')),
        h('div', { class: 'row' },
          h('label', { class: 'check' }, 'backend', h('select', { style: { width: 'auto' }, onchange: e => { ps.backend = e.target.value; render(true); } }, [['', `config (${cfg.backend})`], ['python', 'python'], ['rasaero', 'rasaero (VM)'], ['openrocket', 'openrocket (preview)']].map(([v, l]) => h('option', { value: v, selected: ps.backend === v }, l)))),
          h('label', { class: 'check' }, 'only the first', h('input', { type: 'number', min: 1, class: 'inline-num', value: ps.limit, placeholder: 'all', onchange: e => { ps.limit = e.target.value; render(true); } }), 'boosters'),
          h('label', { class: 'check' }, 'only', h('input', { type: 'text', value: ps.boosters, placeholder: 'e.g. 01,32,60 or labels', style: { width: '200px' }, onchange: e => { ps.boosters = e.target.value; render(true); } })))),
      notes: [backendNote, changeNote, sizeNote],
      cmd: cmdPreview('run', args()),
    },
    content: [
      h('div', { class: 'card' }, h('h2', null, 'Stages', h('span', { class: 'right' }, o.last_run ? `last full run: ${outcomeText(o.last_run)}, ${dur(o.last_run.elapsed_s)}, ${dateTime(o.last_run.finished)}` : 'not run from this GUI yet')),
        h('div', { class: 'substages' }, sub),
        running ? h('div', { class: 'row mt-2' }, h('div', { class: 'progress ' + (r.progress && r.progress.total ? '' : 'indet') }, h('div', { style: { width: (r.progress && r.progress.total ? 100 * r.progress.done / r.progress.total : 30) + '%' } })), h('span', { class: 'muted small' }, `${r.substage || r.stage}${r.round ? ` · round ${r.round.round} (${fmt(r.round.rows, 0)} rows)` : ''} · ${dur(r.elapsed_s)}${eta(r) ? ' · ' + eta(r) : ''}`)) : null,
        h('div', { class: 'sep' }),
        h('p', { class: 'muted small' }, 'Run a single stage (it reads the previous stage\'s files from output/ and recomputes them if missing) — useful after changing the target (search → verify → report) or the profile rules (characterize onwards):'),
        h('div', { class: 'row' }, ['motors', 'mass', 'characterize', 'search', 'verify', 'report'].map(st => runButton({ stage: st, args: args().filter(a => a !== '--fresh'), label: st, cls: 'sm' })))),
      h('div', { class: 'card' }, h('h2', null, 'Output files'), h('div', { class: 'filelist' }, (() => { const seen = new Set(); return o.substages.flatMap(st => st.files.filter(f => !seen.has(f.path) && seen.add(f.path)).map(f => fileRow(f, { stale: st.stale }))); })()),
        h('div', { class: 'sep' }),
        diskCard(s))],
    how: h('ol', { class: 'howto' },
      h('li', null, h('b', null, 'motors'), ' — parse the .eng files, stage them for RASAero.'),
      h('li', null, h('b', null, 'mass'), ' — pick the sustainers to search (sustainer_selection), then OpenRocket: sustainer and stack weight/CG per (booster, sustainer), scaled to the hardware mass.'),
      h('li', null, h('b', null, 'characterize'), ' — one long-coast flight per booster (separation and ignition 15 s late): peak boost Mach, Mach at burnout, how long after burnout the stack drops below Mach 1.2 / 0.9 → which profiles each booster is eligible for.'),
      h('li', null, h('b', null, 'search'), ' — per eligible (booster, profile) and per separation delay on the grid: a coarse ignition-delay grid, then bracket refinement until the apogee is within tolerance. The best per (booster, profile) is kept: solved first, then the smallest miss, then the shortest coast (highest velocity at ignition).'),
      h('li', null, h('b', null, 'verify'), ' — full time history of every solution; Mach at separation, velocity/altitude at ignition, max acceleration; pass/fail against the profile rule.'),
      h('li', null, h('b', null, 'report'), ' — report.md, ranked designs, plots.')),
  });
};

/* A button whose first click arms it ("click again") and whose second
   click, within 5 s, runs the action - no window.confirm. */

/* Disk use of the bulky outputs with one-click cleanup (Optimize page). */
export function diskCard(s) {
  const dk = s.disk;
  if (!dk) return null;
  const clean = async (what, older) => {
    try { const r = await api('/api/cleanup', { body: { what, older_days: older } }); toast(`removed ${r.removed} item(s), ${sizeFmt(r.bytes)}`, 'ok'); refresh(true); }
    catch (e) { toast(e.message, 'err'); }
  };
  const row = (label, info, btn) => h('div', { class: 'f' }, h('span', { class: 'i', style: info.bytes > 200 * 1048576 ? { background: 'var(--warn)' } : null }), h('span', { class: 'n' }, info.path), h('span', { class: 'muted small' }, label), h('span', { class: 'm' }, `${sizeFmt(info.bytes)} · ${info.files} file${info.files === 1 ? '' : 's'}`), btn);
  return h('div', null,
    h('h3', { class: 'mb-2 disk-head' }, 'Disk', h('span', { class: 'right' }, `${sizeFmt(dk.histories.bytes + dk.jobs.bytes + dk.search_rows.bytes)} in the bulky outputs`)),
    h('div', { class: 'filelist disk' },
      row('time histories (verify; the player simulates on demand without them)', dk.histories, dk.histories.files ? confirmBtn('Clear histories', 'Click again to delete', () => clean('histories')) : null),
      row(`${dk.jobs.folders} job folder(s) for the VM worker`, dk.jobs, dk.jobs.folders ? confirmBtn('Delete finished jobs older than 7 days', 'Click again to delete', () => clean('jobs', 7)) : null),
      row('every simulated row of the last search (debugging only)', dk.search_rows, dk.search_rows.files ? confirmBtn('Delete', 'Click again to delete', () => clean('search_rows')) : null)));
}
