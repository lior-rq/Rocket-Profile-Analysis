import { $, App, ago, api, cached, fmt, h, pageState, pages, render } from '../core.js';
import { asyncBlock, badge, callout, cmdPreview, dataTable, kv, runButton, stepPage, workerNote, workerOk } from '../components.js';
import { historyChart } from '../charts.js';

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
      h('div', { class: 'stack' },
        h('div', { class: 'card' }, h('h2', null, `Reference cases (${r.n})`),
          r.n ? dataTable({ columns: ['name', 'booster', 'sustainer', 'sep_delay_s', 'ign_delay_s', 'apogee_ft', 'max_vel_fps', 'mtime'], rows: r.cases, labels: { sep_delay_s: 'sep [s]', ign_delay_s: 'ign [s]', apogee_ft: 'RASAero apogee [ft]', max_vel_fps: 'max vel [fps]', mtime: 'exported' }, format: { mtime: v => ago(v), apogee_ft: v => fmt(v, 0), max_vel_fps: v => fmt(v, 0) }, onRow: row => { ps.sel = row.name; render(true); }, rowKey: row => row.name, selected: ps.sel || (r.cases[0] || {}).name }) : h('div', { class: 'muted' }, 'none yet'),
          h('div', { class: 'sep' }),
          kv([
            ['density calibration', r.calibration.exists ? `${r.calibration.info ? `${r.calibration.info.bins} bins, ${fmt(r.calibration.info.alt_min_ft, 0)}–${fmt(r.calibration.info.alt_max_ft, 0)} ft` : 'present'} (${ago(r.calibration.mtime)})` : h('span', { class: 'badge todo' }, 'not yet — written by this step and by validate')],
            ['delay convention', 'separation delay from burnout; ignition delay from separation (RASAero)'],
          ])),
        h('div', { class: 'card' }, h('h2', null, 'Flight (RASAero export)'), chart))],
    how: h('p', null, 'Each case is one RASAero simulation row (booster, separation delay, ignition delay) with the masses from the mass table. The worker runs it, opens View Data and exports the full time history at 0.01 s; the export and the row inputs are stored side by side in ', h('code', null, r.dir), '. The density profile RASAero used is recovered from the coast phases of these exports (ρ = 2D / V²·S·CD) and reused by the Python simulator.'),
  });
};
