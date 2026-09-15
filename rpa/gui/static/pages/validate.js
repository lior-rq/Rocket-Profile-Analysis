import { $, App, fmt, go, h, isNum, lightbox, pageState, pages, render } from '../core.js';
import { badge, callout, cmdPreview, dataTable, runButton, stepPage } from '../components.js';

// ---- step 4: validate -------------------------------------------------------
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
        v.n ? dataTable({ columns: ['pass', 'case', 'fail_reasons', 'apogee_ref_ft', 'apogee_ours_ft', 'apogee_err_pct', 'mach_burnout_ref', 'mach_burnout_ours', 'mach_burnout_err', 'sep_delay_s', 'ign_delay_s', 'cd_median_err_pct', 'cd_p95_err_pct', 'mach_max_abs_err', 'weight_max_abs_err_lb'], rows: v.rows,
          labels: { sep_delay_s: 'sep', ign_delay_s: 'ign', apogee_ref_ft: 'RASAero apogee', apogee_ours_ft: 'python apogee', apogee_err_pct: 'apogee err %', mach_burnout_ref: 'M@bo RAS', mach_burnout_ours: 'M@bo py', mach_burnout_err: 'M@bo err', cd_median_err_pct: 'CD med %', cd_p95_err_pct: 'CD p95 %', mach_max_abs_err: 'atm Mach err', weight_max_abs_err_lb: 'weight err lb', fail_reasons: 'why' },
          format: { pass: v2 => badge(v2 ? 'ok' : 'err', v2 ? 'PASS' : 'FAIL'), apogee_ref_ft: x => fmt(x, 0), apogee_ours_ft: x => fmt(x, 0), apogee_err_pct: x => isNum(x) ? (x >= 0 ? '+' : '') + x.toFixed(2) : '—', mach_burnout_err: x => fmt(x, 4), mach_max_abs_err: x => fmt(x, 4), mach_burnout_ref: x => fmt(x, 3), mach_burnout_ours: x => fmt(x, 3) },
          cellClass: (c, x) => (c === 'apogee_err_pct' && isNum(x) && Math.abs(x) > tol.apogee_tol_pct) || (c === 'mach_burnout_err' && isNum(x) && Math.abs(x) > tol.mach_at_burnout_tol) ? 'hl' : '',
          onRow: r => { ps.sel = r.case; render(true); }, rowKey: r => r.case, selected: sel, wrap: ['fail_reasons'] }) : h('div', { class: 'muted' }, 'no validation yet')),
      selRow && selRow.png ? h('div', { class: 'card' }, h('h2', null, `Overlay: ${selRow.case}`, h('span', { class: 'right' }, 'python (dashed) over RASAero (solid); click to enlarge')), h('div', { class: 'plot', onclick: () => lightbox('/files/' + selRow.png + '?t=' + (v.file.mtime || 0)) }, h('img', { src: '/files/' + selRow.png + '?t=' + (v.file.mtime || 0) }))) : null],
    how: h('p', null, 'For each reference case the Python simulator flies the same row and the two histories are compared: the atmosphere (Mach recomputed from RASAero\'s own velocity and altitude), the CD lookup at RASAero\'s Mach, the reconstructed drag, the weight and thrust histories (nearest sample within ±2 steps), then apogee, time to apogee and Mach at burnout. Results go to ', h('code', null, 'output/validation/'), ' with an overlay plot per case.'),
  });
};
