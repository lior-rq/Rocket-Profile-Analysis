import { $, App, ago, api, cached, fmt, h, pageState, pages, render } from '../core.js';
import { asyncBlock, badge, callout, cmdPreview, dataTable, runButton, stepPage, workerNote, workerOk } from '../components.js';
import { lineChart } from '../charts.js';

// ---- step 2: aero tables ----------------------------------------------------
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
      h('div', { class: 'row mb-1' }, h('span', { class: 'muted small' }, 'table:'), h('select', { style: { width: 'auto' }, onchange: e => { ps.sel = e.target.value; render(true); } }, choices.map(([pth, name]) => h('option', { value: pth, selected: pth === pick }, name)))),
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
      h('div', { class: 'stack' },
        h('div', { class: 'card' }, h('h2', null, `Planned tables (${a.n_have}/${a.n_plan} present)`, h('span', { class: 'right' }, `altitudes ${a.settings.altitudes_ft.join(', ')} ft · nozzles: ${a.settings.stack_nozzles_in === 'auto' ? 'min / mid / max of the booster set' : a.settings.stack_nozzles_in}`)),
          dataTable({ columns: ['config', 'nozzle_in', 'altitude_ft', 'name', 'status', 'mtime'], rows, labels: { nozzle_in: 'nozzle exit [in]', altitude_ft: 'altitude [ft]', name: 'file', mtime: 'exported' }, format: { status: v => badge(v), mtime: v => v ? ago(v) : '—', altitude_ft: v => fmt(v, 0) }, onRow: r => { if (r.exists) { ps.sel = r.path; render(true); } }, rowKey: r => r.path, selected: ps.sel }),
          a.extra.length ? h('div', { class: 'muted small mt-2' }, `${a.extra.length} other table(s) in ${a.dir} are also loaded and interpolated: ${a.extra.map(e => e.name).join(', ')}`) : null),
        h('div', { class: 'card' }, h('h2', null, 'Drag curve'), chart))],
    how: h('ol', { class: 'howto' },
      h('li', null, 'The worker opens the CDX1 with the chosen nozzle written into the design and every simulation row (power-on CD depends on it).'),
      h('li', null, h('b', null, 'Options → Mach-Alt'), ' is set to the table altitude so the Reynolds number matches the flight regime.'),
      h('li', null, h('b', null, 'Aero Plots'), ' is opened for “Sustainer + Booster” (stack) or “Sustainer” and exported to CSV (Mach 0.01–25).'),
      h('li', null, 'The CSV lands in ', h('code', null, a.dir), ' as ', h('code', null, '<stack|sustainer>_alt<ft>_noz<in>.csv'), '; the simulator interpolates between nozzle diameters and altitudes. Tables depend only on the geometry, so they survive motor changes.')),
  });
};
