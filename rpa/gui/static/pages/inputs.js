import { $, App, ago, api, busy, cached, dateTime, fmt, gridSummary, h, isNum, pageState, pages, refresh, render, searchedSustainers, toast } from '../core.js';
import { asyncBlock, badge, callout, cmdPreview, kv, runButton, stat, stepPage, subTabs, sustainerStat } from '../components.js';

// ---- step 1: inputs ---------------------------------------------------------
pages.inputs = () => {
  const s = App.state, cfg = s.config, inp = s.inputs, mass = s.mass;
  const ps = pageState('inputs', { edits: {}, options: null, tab: 'vehicle', mtab: 'boosters', open: {} });
  const cfgVal = dotted => dotted.split('.').reduce((o, k) => (o == null ? undefined : o[k]), cfg);
  const val = dotted => (dotted in ps.edits) ? ps.edits[dotted] : cfgVal(dotted);
  const dirty = () => Object.keys(ps.edits).length;
  const same = (a, b) => (a === b) || (a == null && b == null) || (isNum(a) && isNum(b) && Math.abs(a - b) < 1e-12) || (Array.isArray(a) && Array.isArray(b) && JSON.stringify(a) === JSON.stringify(b));
  const setEdit = (dotted, v) => { if (same(v, cfgVal(dotted))) delete ps.edits[dotted]; else ps.edits[dotted] = v; syncDirty(); };
  const dirtyEls = [];
  // effective search grids for the delay windows as typed (B4: the
  // separation step is capped at 9 points by the search)
  const previewEl = h('div', { class: 'callout info mt-2' });
  const drawPreview = () => {
    const p = {}; for (const k of ['separation_delay_min_s', 'separation_delay_max_s', 'separation_step_s', 'ignition_delay_min_s', 'ignition_delay_max_s', 'coarse_step_s']) p[k] = val('profiles.' + k);
    const g = gridSummary(p);
    previewEl.innerHTML = '';
    previewEl.append(h('b', null, 'Effective grids: '),
      `separation ${g.sep.length} point${g.sep.length === 1 ? '' : 's'} (${fmt(g.sep[0], 2)} → ${fmt(g.sep[g.sep.length - 1], 2)} s${g.sep.length > 1 ? `, every ${fmt(g.sepStep, 2)} s` : ''})`,
      g.capped ? h('span', { class: 'warn-text' }, ` — your ${fmt(+p.separation_step_s, 2)} s step is coarsened: the search caps separation at 9 points`) : '',
      ` · ignition ${g.ign.length} point${g.ign.length === 1 ? '' : 's'} (${fmt(g.ign[0], 2)} → ${fmt(g.ign[g.ign.length - 1], 2)} s every ${fmt(+p.coarse_step_s, 2)} s) · ${fmt(g.sep.length * g.ign.length, 0)} flights per candidate before refinement.`);
  };
  // what config.yaml would reject or the search could not use (G10)
  const problems = () => {
    const p = k => Number(val('profiles.' + k)), out = [];
    if (!(Number(val('target.apogee_ft')) > 0)) out.push('target apogee must be > 0');
    if (!(Number(val('target.tolerance_ft')) > 0)) out.push('tolerance must be > 0');
    if (p('separation_delay_min_s') > p('separation_delay_max_s')) out.push('separation delay: min is above max');
    if (p('ignition_delay_min_s') > p('ignition_delay_max_s')) out.push('ignition delay: min is above max');
    if (!(p('separation_step_s') > 0)) out.push('separation step must be > 0');
    if (!(p('coarse_step_s') > 0)) out.push('ignition step must be > 0');
    if (p('subsonic_max_mach') >= p('supersonic_min_mach')) out.push('subsonic max Mach must be below the supersonic min Mach');
    if (p('mach_margin') < 0) out.push('Mach margin must be ≥ 0');
    const c = val('sustainer_selection.count');
    if (c != null && c !== '' && !(c >= 1 && c <= 20)) out.push('sustainers searched: count must be 1–20');
    const hw = val('mass_model.hardware_mass_lb');
    if (hw != null && hw !== '' && !(hw > 0)) out.push('hardware mass must be > 0, or empty for the .ork masses');
    return out;
  };
  const syncDirty = () => {
    drawPreview();
    for (const [el, dotted] of dirtyEls) el.classList.toggle('dirty', dotted in ps.edits);
    const n = dirty();
    const pr = n ? problems() : [];
    saveBtn.disabled = !n || pr.length > 0; resetBtn.disabled = !n; saveCheckBtn.disabled = !n || pr.length > 0 || busy();
    saveBar.hidden = !n;
    $('.n', saveBar).textContent = `${n} unsaved change${n === 1 ? '' : 's'}`;
    problemsEl.hidden = !pr.length;
    problemsEl.textContent = pr.length ? 'Fix before saving: ' + pr.join(' · ') : '';
  };
  const numField = (label, dotted, hint, step, extra = {}) => {
    const inEl = h('input', { type: 'number', step: step || 'any', value: val(dotted) ?? '', placeholder: extra.placeholder || 'null', min: extra.min, max: extra.max });
    const clear = extra.clearable ? h('button', { class: 'btn sm ghost', type: 'button', title: 'clear the override', onclick: () => { inEl.value = ''; setEdit(dotted, null); syncClear(); } }, '× ', extra.clearLabel || 'clear') : null;
    const syncClear = () => { if (clear) clear.hidden = inEl.value === ''; };
    inEl.oninput = () => { setEdit(dotted, inEl.value === '' ? null : Number(inEl.value)); syncClear(); };
    inEl.onkeydown = e => { if (e.key === 'Enter' && dirty()) save(); };
    dirtyEls.push([inEl, dotted]);
    syncClear();
    return h('div', { class: 'field' }, h('label', null, label), clear ? h('div', { class: 'field-row' }, inEl, clear) : inEl, hint ? h('div', { class: 'hint' }, hint) : null);
  };
  const selField = (label, dotted, options, hint) => {
    const cur = val(dotted);
    const opts = options.slice();
    if (cur && !opts.some(o => o.value === cur)) opts.unshift({ value: cur, label: cur + ' (not found)' });
    const sel = h('select', null, opts.map(o => h('option', { value: o.value, selected: o.value === cur }, o.label || o.value)));
    sel.onchange = () => setEdit(dotted, sel.value);
    dirtyEls.push([sel, dotted]);
    return h('div', { class: 'field' }, h('label', null, label), sel, hint ? h('div', { class: 'hint' }, hint) : null);
  };
  const save = async (thenCheck) => {
    try {
      await api('/api/config', { body: { set: ps.edits } });
      ps.edits = {};
      toast('config.yaml saved', 'ok');
      App.cache = {};
      if (thenCheck) await api('/api/run', { body: { stage: 'check', args: [], label: 'check' } }).then(() => { App.collapsed = false; }).catch(e => toast(e.message, 'err'));
      await refresh(true);
    } catch (e) { toast(e.message, 'err'); }
  };
  const saveBtn = h('button', { class: 'btn primary', onclick: () => save(false) }, 'Save');
  const saveCheckBtn = h('button', { class: 'btn', onclick: () => save(true) }, 'Save & check');
  const resetBtn = h('button', { class: 'btn', onclick: () => { ps.edits = {}; render(true); } }, 'Discard');
  const problemsEl = h('div', { class: 'problems', hidden: true, style: { flexBasis: '100%' } });
  const saveBar = h('div', { class: 'savebar', hidden: true }, h('b', null, 'Unsaved'), h('span', { class: 'n' }), h('span', { class: 'muted small' }, '— written to config.yaml with its comments intact'), h('span', { style: { flex: 1 } }), saveBtn, saveCheckBtn, resetBtn, problemsEl);

  // ---- tab: vehicle
  const vehicleTab = () => asyncBlock(async () => {
    const o = ps.options || (ps.options = await api('/api/options'));
    const site = inp.site_cdx1 || inp.site || {};
    const siteField = (label, key, unit) => numField(`${label} [${unit}]`, `launch_site.${key}`, site[key] != null ? `empty = the CDX1 value (${fmt(site[key])} ${unit})` : 'empty = keep the CDX1 value', undefined, { placeholder: site[key] != null ? `${fmt(site[key])} (CDX1)` : 'CDX1 value', clearable: true, clearLabel: 'use CDX1 value' });
    const el = h('div', { class: 'grid c2' },
      h('div', { class: 'card' }, h('h2', null, 'Model files'),
        h('div', { class: 'form' },
          selField('OpenRocket model (.ork)', 'paths.ork', o.ork.map(v => ({ value: v })), 'mass distribution and CGs (SOP figs 7–10). Files found under input/'),
          selField('RASAero model (.CDX1)', 'paths.cdx1', o.cdx1.map(v => ({ value: v })), 'geometry, launch site and the simulation rows RASAero runs')),
        h('div', { class: 'sep' }),
        inp.site ? kv([
          ['reference diameter', `${fmt(inp.ref_diameter_in, 3)} in (largest body diameter in the CDX1)`],
          ['OpenRocket', inp.openrocket_jar.exists ? 'OpenRocket.app found' : h('span', { class: 'badge err' }, 'OpenRocket.app not found (paths.openrocket_jar)')],
        ]) : callout('warn', 'CDX1 not readable')),
      h('div', { class: 'card' }, h('h2', null, 'Launch site', h('span', { class: 'right' }, 'from the CDX1; override here if needed')),
        h('div', { class: 'form' }, siteField('Altitude', 'altitude_ft', 'ft'), siteField('Pressure', 'pressure_inhg', 'inHg'), siteField('Temperature', 'temperature_f', '°F'), siteField('Rod angle', 'rod_angle_deg', 'deg'), siteField('Rod length', 'rod_length_ft', 'ft'), siteField('Wind', 'wind_speed_mph', 'mph'))));
    syncDirty();
    return el;
  });

  // ---- tab: motors (picker)
  const listOr = kind => { const v = val('paths.' + kind); if (Array.isArray(v) && v.length) return v; const d = val('paths.' + kind + '_dir'); return d ? [d] : []; };  // legacy single-folder config
  const motorsTab = () => asyncBlock(async () => {
    const o = ps.options || (ps.options = await api('/api/options'));
    const m = inp.motors;
    let mt = { boosters: { rows: [] }, sustainers: { rows: [] } };
    try { mt = await cached('motors', '/api/motors', 0, inp.inputs_mtime); } catch (e) { /* the pickers still work without the per-motor list */ }
    const exclusions = kind => ({ get: () => val('paths.exclude_' + kind) || [], set: v => setEdit('paths.exclude_' + kind, v) });
    const el = h('div', { class: 'stack' },
      callout('info', 'Tick any mix of folders and files under ', h('code', null, 'input/'), ': one-motor ', h('code', null, '.eng'), ' files, multi-motor RASP ', h('code', null, '.eng'), ' files (every motor in them counts), and openMotor ', h('code', null, '.ric'), ' designs (simulated once with openMotor and cached). Every ticked booster motor is a candidate the optimizer will try; which of the ticked sustainer motors are flown with each booster is set under Target & rules (sustainer_selection: the max-impulse one, a few spanning the apogee range, or a list). Ids must be unique: the file name for one-motor files and .ric designs, the designation inside multi-motor files.'),
      h('div', { class: 'grid c2' },
        motorPicker({ kind: 'boosters', title: 'Booster candidates', tree: o.motor_dirs, get: () => listOr('boosters'), set: v => setEdit('paths.boosters', v), ps, problems: inp.boosters.problems, motors: mt.boosters.rows, exclude: exclusions('boosters') }),
        motorPicker({ kind: 'sustainers', title: 'Sustainer candidates', tree: o.motor_dirs, get: () => listOr('sustainers'), set: v => setEdit('paths.sustainers', v), ps, problems: inp.sustainers.problems, highlight: searchedSustainers(m), motors: mt.sustainers.rows, exclude: exclusions('sustainers') })),
      m ? h('div', { class: 'card' }, h('h2', null, 'Motor set as currently saved', h('span', { class: 'right' }, 'what the pipeline will use after Save')),
        h('div', { class: 'stat-list' },
          stat('boosters', m.n_boosters),
          stat('booster impulse', m.booster_impulse_ns ? `${fmt(m.booster_impulse_ns[0] / 1000, 1)}–${fmt(m.booster_impulse_ns[1] / 1000, 1)}` : '—', 'kN·s'),
          stat('booster nozzle exit', m.booster_nozzle_in ? `${fmt(m.booster_nozzle_in[0], 2)}–${fmt(m.booster_nozzle_in[1], 2)}` : '—', 'in'),
          sustainerStat(m)),
        m.boosters_missing_nozzle.length ? callout('warn', h('b', null, 'No nozzle exit diameter in: '), m.boosters_missing_nozzle.join(', '), ' — add a "Throat x in, exit y in" comment to the .eng or set rasaero.booster_nozzle_in.') : null) : callout('warn', 'The saved motor selection cannot be loaded — see the problems above.'));
    syncDirty();
    return el;
  });

  // ---- tab: mass
  const massTab = () => {
    const method = val('mass_model.method') || 'openrocket';
    const hw = val('mass_model.hardware_mass_lb');
    const t = mass.table, est = mass.estimate;
    const body = [];
    body.push(h('div', { class: 'form' },
      selField('Method', 'mass_model.method', [{ value: 'openrocket', label: 'openrocket – the .ork gives the mass distribution' }, { value: 'manual', label: 'manual – type the weights and CGs' }]),
      method === 'openrocket' ? numField('Vehicle hardware mass [lb]', 'mass_model.hardware_mass_lb', 'dry mass of the whole two-stage rocket: airframe, recovery, avionics, motor cases — everything except propellant. Empty = use the .ork masses as they are.', 0.5, { placeholder: 'use .ork masses', min: 0 }) : null));
    if (method === 'openrocket') {
      const rows = [];
      if (est) {
        rows.push(['propellant (from the .eng files)', `sustainer ${fmt(est.sustainer_prop_lb, 1)} lb · booster ${est.booster_prop_lb ? `${fmt(est.booster_prop_lb[0], 1)}–${fmt(est.booster_prop_lb[1], 1)}` : '—'} lb`]);
        if (hw != null && est.booster_prop_lb) rows.push(['loaded stack on the pad', `${fmt(hw + est.sustainer_prop_lb + est.booster_prop_lb[0], 0)}–${fmt(hw + est.sustainer_prop_lb + est.booster_prop_lb[1], 0)} lb (hardware + propellant)`]);
      }
      if (t && !t.error) {
        rows.push(['mass table (computed)', h('span', null, h('b', { class: t.stale ? 'warn-text' : 'ok-text' }, `${fmt(t.combined_wt_lb[0], 0)}–${fmt(t.combined_wt_lb[1], 0)} lb`), ` stack on the pad · sustainer ${fmt(t.sustainer_wt_lb, 1)} lb @ CG ${fmt(t.sustainer_cg_in, 1)} in · ${t.n} pairs · ${ago(t.mtime)}`)]);
        if (t.sustainer_dry_lb != null) rows.push(['dry split used' + (t.hardware_mass_lb != null ? '' : ' (.ork as-is)'), `sustainer ${fmt(t.sustainer_dry_lb, 1)} + booster ${fmt(t.booster_dry_lb, 1)} = ${fmt(t.sustainer_dry_lb + t.booster_dry_lb, 1)} lb`]);
      }
      if (rows.length) body.push(h('div', { class: 'mt-3' }, kv(rows)));
      if (t && !t.error && t.stale) body.push(callout('warn', h('b', null, 'The mass table is out of date: '), `it was computed with ${t.hardware_mass_lb == null ? 'the .ork masses' : t.hardware_mass_lb + ' lb'}${hw == null ? ' but the config now says .ork masses' : hw !== t.hardware_mass_lb ? `, the config now says ${hw} lb` : ''}. Save, then run the mass stage (the optimizer does it automatically too).`));
      if (!t) body.push(callout('info', 'No mass table yet — it is computed by the mass stage (or by the optimizer) from the .ork with OpenRocket, using the hardware mass above.'));
      body.push(h('p', { class: 'muted small mt-2' }, 'How it is applied: OpenRocket supplies each stage\'s dry mass, CG and motor position; both dry masses are scaled by one factor so the vehicle weighs the hardware mass empty, then the .eng propellant is added and the loaded weights / CGs RASAero needs are recombined. (The openrocket preview backend flies the unmodified .ork.)'));
    } else {
      const mp = 'mass_model.manual.';
      body.push(h('div', { class: 'form' },
        numField('Sustainer loaded weight [lb]', mp + 'sustainer_wt_lb'), numField('Sustainer CG [in from nose]', mp + 'sustainer_cg_in'),
        numField('Combined weight with the reference booster [lb]', mp + 'combined_wt_lb_ref'), numField('Combined CG with the reference booster [in]', mp + 'combined_cg_in_ref'),
        numField('Reference booster propellant [kg]', mp + 'ref_booster_prop_kg'), numField('Booster propellant CG [in from nose]', mp + 'booster_prop_cg_in', 'other boosters are derived by adding their propellant difference at this station')));
    }
    return h('div', { class: 'card' }, h('h2', null, 'Mass model', h('span', { class: 'right' }, runButton({ stage: 'mass', label: 'Compute mass table', cls: 'sm', disabled: dirty() > 0, title: dirty() ? 'save first' : '' }))), ...body);
  };

  // ---- tab: target & rules
  const targetTab = () => h('div', { class: 'grid two' },
    h('div', { class: 'card' }, h('h2', null, 'Target'),
      h('div', { class: 'form' },
        numField('Target apogee [ft]', 'target.apogee_ft', 'what the search aims for', 1),
        numField('Tolerance [ft]', 'target.tolerance_ft', 'a design is "solved" when |apogee − target| ≤ tolerance', 1),
        selField('Simulation backend', 'backend', [{ value: 'python', label: 'python – integrator on RASAero aero tables (fast, on this Mac)' }, { value: 'rasaero', label: 'rasaero – RASAero GUI in the VM (slow, tool of record)' }, { value: 'openrocket', label: 'openrocket – preview only (different aero)' }], 'python needs steps 2–4 once; rasaero needs the VM worker for every simulation'))),
    h('div', { class: 'card' }, h('h2', null, 'Sustainers searched'),
      h('p', { class: 'muted small' }, 'Every booster is paired with each of these sustainers. "span" flies one reference booster under every sustainer candidate (python backend, needs the aero tables) and keeps the ones at the lowest, highest and evenly spaced apogee; the pick is redone whenever the candidates or this setting change.'),
      h('div', { class: 'form' },
        selField('Selection', 'sustainer_selection.mode', [{ value: 'best', label: 'best – the max-impulse candidate only' }, { value: 'span', label: 'span – a few candidates spanning the apogee range' }, { value: 'list', label: 'list – exactly the labels in config.yaml sustainer_selection.labels' }], 'best = one sustainer, as before'),
        numField('How many (span)', 'sustainer_selection.count', 'min, max and evenly spaced between; 5 is plenty when the candidates differ by a few percent', 1, { min: 1, max: 20 }))),
    h('div', { class: 'card' }, h('h2', null, 'Profile rules'),
      h('p', { class: 'muted small' }, 'Two staging profiles are designed so the booster never separates in the transonic band: subsonic (the attached stack stays below Mach 0.9 throughout) and supersonic (separation happens above Mach 1.2).'),
      h('div', { class: 'form' },
        numField('Subsonic profile: max Mach', 'profiles.subsonic_max_mach', 'the attached stack never exceeds this', 0.01),
        numField('Supersonic profile: min Mach at separation', 'profiles.supersonic_min_mach', 'separation must happen at or above this', 0.01),
        numField('Design margin (Mach)', 'profiles.mach_margin', 'applied to both limits', 0.01))),
    h('div', { class: 'card' }, h('h2', null, 'Staging delay windows'),
      h('p', { class: 'muted small' }, 'The optimizer searches both delays inside these windows. Separation is counted from booster burnout, ignition from separation (RASAero\'s convention), so ', h('b', null, 'ignition can never happen before burnout'), ' — both minimums are floored at 0 (0 = at burnout / at separation). The supersonic rule narrows each booster\'s separation window further.'),
      h('div', { class: 'form' },
        numField('Separation delay: min [s]', 'profiles.separation_delay_min_s', 'earliest booster separation after burnout (0 = at burnout)', 0.05, { min: 0 }),
        numField('Separation delay: max [s]', 'profiles.separation_delay_max_s', 'latest booster separation after burnout', 0.05, { min: 0 }),
        numField('Separation delays tried: step [s]', 'profiles.separation_step_s', 'min, min+step, …, max (at most 9 points)', 0.05, { min: 0.05 }),
        numField('Ignition delay: min [s]', 'profiles.ignition_delay_min_s', 'earliest sustainer ignition after separation (0 = at separation)', 0.1, { min: 0 }),
        numField('Ignition delay: max [s]', 'profiles.ignition_delay_max_s', 'latest sustainer ignition after separation', 0.5, { min: 0 }),
        numField('Ignition delays tried: step [s]', 'profiles.coarse_step_s', 'coarse grid before the bracket refinement', 0.1, { min: 0.05 })),
      previewEl));

  const tabs = subTabs(ps, 'tab', [['vehicle', 'Vehicle & site'], ['motors', 'Motors', `${inp.boosters.n} + ${inp.sustainers.n}`], ['mass', 'Mass', mass.hardware_mass_lb != null ? `${fmt(mass.hardware_mass_lb, 0)} lb` : '.ork'], ['target', 'Target & rules', `${fmt(cfg.target.apogee_ft, 0)} ft`]]);
  const body = { vehicle: vehicleTab, motors: motorsTab, mass: massTab, target: targetTab }[ps.tab || 'vehicle']();
  const page = stepPage({
    id: 'inputs',
    summary: 'Tell the tool which vehicle and motor files to use, how heavy the hardware is and what apogee to aim for. Changes are saved into config.yaml; Check then parses every input and reports anything the later steps would trip over.',
    action: {
      title: 'Check the inputs',
      prereqs: [
        { label: '.ork', ok: inp.ork.exists, hint: 'OpenRocket model file missing' },
        { label: '.CDX1', ok: inp.cdx1.exists, hint: 'RASAero model file missing' },
        { label: `${inp.boosters.n} boosters`, ok: inp.boosters.n > 0 && !inp.boosters.problems.length, hint: 'no booster files selected' },
        { label: `${inp.sustainers.n} sustainers`, ok: inp.sustainers.n > 0 && !inp.sustainers.problems.length, hint: 'no sustainer files selected' },
        { label: 'saved', ok: dirty() ? false : true, hint: 'save your changes first' }],
      buttons: [runButton({ stage: 'check', label: 'Check inputs', primary: true, disabled: dirty() > 0, title: dirty() ? 'save your changes first' : '' })],
      notes: [
        inp.problems.length ? callout('err', h('b', null, 'Problems: '), h('ul', null, inp.problems.map(p => h('li', null, p)))) : null,
        inp.last_check ? callout(inp.last_check.exit_code === 0 ? 'ok' : 'warn', h('b', null, inp.last_check.exit_code === 0 ? 'Last check passed' : 'Last check reported problems'), ` (${dateTime(inp.last_check.finished)}${inp.status === 'unchecked' ? ', but inputs changed since' : ''}). `, inp.last_check.exit_code === 0 ? '' : 'Open the activity log for the list.') : callout('info', 'Not checked yet — press ', h('b', null, 'Check inputs'), '. The output appears in the activity panel below.')],
      cmd: cmdPreview('check'),
    },
    content: [h('div', { class: 'card tabbed' }, tabs, body)],
    how: h('div', null,
      h('p', null, 'Everything on this page lives in ', h('code', null, 'config.yaml'), ' (the GUI edits values in place and keeps the comments). The four tabs: '),
      h('ul', null, h('li', null, h('b', null, 'Vehicle & site'), ' — the .ork (mass distribution) and .CDX1 (geometry, launch site) files; launch-site overrides.'), h('li', null, h('b', null, 'Motors'), ' — any mix of folders and .eng files for the booster candidates and the sustainer candidates.'), h('li', null, h('b', null, 'Mass'), ' — the hardware (dry) mass; the .ork only supplies the split and the CGs.'), h('li', null, h('b', null, 'Target & rules'), ' — target apogee, tolerance, the transonic-separation rules and the simulation backend.')),
      h('p', null, h('b', null, 'Check'), ' parses the motors, reads the CDX1, verifies the aero-table coverage for the selected nozzle sizes and counts the reference cases.')),
  });
  page.prepend(saveBar);
  syncDirty();
  return page;
};

/* Checkbox tree of every .eng under input/, grouped by folder. The config
   value is a list of folders and/or files; a fully ticked folder is stored
   as the folder path, a partially ticked one as its file paths. */

export function motorPicker({ kind, title, tree, get, set, ps, problems = [], highlight, motors = [], exclude }) {
  const isHi = label => highlight instanceof Set ? highlight.has(label) : (highlight && label === highlight);
  const wrap = h('div', { class: 'card picker' });
  const selectedFiles = () => {
    const sel = new Set();
    const unknown = [];
    for (const entry of get()) {
      const f = tree.find(d => d.path === entry);
      if (f) f.files.forEach(x => sel.add(x.path));
      else if (tree.some(d => d.files.some(x => x.path === entry))) sel.add(entry);
      else unknown.push(entry);
    }
    return { sel, unknown };
  };
  const store = (sel) => {
    const out = [];
    for (const d of tree) {
      const inside = d.files.filter(x => sel.has(x.path));
      if (inside.length === d.files.length && d.files.length) out.push(d.path);
      else inside.forEach(x => out.push(x.path));
    }
    set(out);
    draw();
  };
  const openKey = kind + ':';
  const draw = () => {
    const { sel, unknown } = selectedFiles();
    const q = (ps['q_' + kind] || '').toLowerCase();
    const nFolders = tree.filter(d => d.files.some(x => sel.has(x.path))).length;
    const nMotors = tree.reduce((n, d) => n + d.files.filter(x => sel.has(x.path)).reduce((m, x) => m + (x.n_motors || 1), 0), 0);
    wrap.innerHTML = '';
    wrap.append(h('h2', null, title, h('span', { class: 'right' }, `${nMotors} motor${nMotors === 1 ? '' : 's'} in ${sel.size} file${sel.size === 1 ? '' : 's'} from ${nFolders} folder${nFolders === 1 ? '' : 's'}`)));
    wrap.append(h('div', { class: 'toolbar' },
      h('input', { type: 'text', class: 'searchbox', placeholder: 'filter by name…', value: ps['q_' + kind] || '', oninput: e => { ps['q_' + kind] = e.target.value; draw(); const box = wrap.querySelector('.searchbox'); box.focus(); box.setSelectionRange(box.value.length, box.value.length); } }),
      h('span', { class: 'spacer' }),
      h('button', { class: 'btn sm', onclick: () => store(new Set()) }, 'clear all')));
    if (unknown.length) wrap.append(callout('warn', h('b', null, 'Not found under input/: '), unknown.join(', '), ' — they will be dropped when you change the selection.'));
    if (problems.length) wrap.append(callout('err', problems.join(' · ')));
    if (!tree.length) wrap.append(callout('info', 'No .eng files found under input/. Put motor files in a folder there and reload.'));
    for (const d of tree) {
      const files = d.files.filter(x => !q || x.name.toLowerCase().includes(q) || (x.designation || '').toLowerCase().includes(q));
      if (q && !files.length) continue;
      const nSel = d.files.filter(x => sel.has(x.path)).length;
      const all = nSel === d.files.length && d.files.length > 0;
      const cb = h('input', { type: 'checkbox', checked: all, onclick: e => { e.stopPropagation(); const next = new Set(sel); if (all) d.files.forEach(x => next.delete(x.path)); else d.files.forEach(x => next.add(x.path)); store(next); } });
      cb.indeterminate = nSel > 0 && !all;
      const open = openKey + d.path in ps.open ? ps.open[openKey + d.path] : nSel > 0 || !!q;
      const det = h('details', { class: 'folder', open, ontoggle: e => { ps.open[openKey + d.path] = e.target.open; } },
        h('summary', null, cb, h('span', { class: 'fname' }, d.path), h('span', { class: 'fcount ' + (nSel ? 'on' : '') }, `${nSel}/${d.files.length}`)),
        h('div', { class: 'files' }, files.map(x => {
          const on = sel.has(x.path);
          const bad = !!x.error;
          const many = (x.n_motors || 1) > 1;
          const ric = x.kind === 'ric';
          const hi = isHi(x.label);
          const row = h('label', { class: 'file ' + (on ? 'on' : '') + (bad ? ' bad' : '') + (hi ? ' hi' : ''), title: x.error || x.path },
            h('input', { type: 'checkbox', checked: on, disabled: bad, onchange: () => { const next = new Set(sel); if (on) next.delete(x.path); else next.add(x.path); store(next); } }),
            h('span', { class: 'lbl' }, x.label),
            bad ? h('span', { class: 'badge err' }, 'unreadable') : ric && x.pending ? h('span', { class: 'meta' }, h('span', { class: 'badge warn' }, 'openMotor design'), ' not simulated yet — Check converts it (~1 s)') : many ? h('span', { class: 'meta' }, h('span', { class: 'badge info' }, `${x.n_motors} motors in this file`), ` · first: ${x.designation} · ${fmt((x.total_impulse_ns || 0) / 1000, 1)} kN·s`) : h('span', { class: 'meta' }, ric ? h('span', { class: 'badge info', title: 'openMotor .ric design, simulated with openMotor and cached' }, 'openMotor') : null, ric ? ' ' : '', `${fmt((x.total_impulse_ns || 0) / 1000, 1)} kN·s · ${fmt(x.burn_time_s, 1)} s · noz ${x.nozzle_exit_in != null ? fmt(x.nozzle_exit_in, 2) + ' in' : '?'}`),
            hi ? h('span', { class: 'badge ok', title: 'flown with every booster by the optimizer (sustainer_selection)' }, 'searched') : null);
          // multi-motor file: the motors inside it, each one switchable off
          // (config.yaml paths.exclude_<kind>); known only after a Save
          const inner = many && on && exclude ? motors.filter(mm => mm.file === x.path) : [];
          if (!inner.length) return row;
          const ex = new Set(exclude.get());
          const nOn = inner.filter(mm => !ex.has(mm.label)).length;
          const mkey = openKey + 'm:' + x.path;
          const det = h('details', { class: 'motors', open: !!ps.open[mkey], ontoggle: e => { ps.open[mkey] = e.target.open; } },
            h('summary', null, `${nOn} of ${inner.length} motors in this file are candidates`, nOn < inner.length ? h('button', { class: 'btn sm ghost', type: 'button', onclick: e => { e.preventDefault(); e.stopPropagation(); exclude.set([]); draw(); } }, 'use all') : null),
            h('div', null, inner.map(mm => {
              const used = !ex.has(mm.label);
              return h('label', { class: 'file inner ' + (used ? 'on' : '') + (isHi(mm.label) ? ' hi' : '') },
                h('input', { type: 'checkbox', checked: used, onchange: () => { const next = new Set(ex); if (used) next.add(mm.label); else next.delete(mm.label); exclude.set([...next].sort()); draw(); } }),
                h('span', { class: 'lbl' }, mm.label),
                h('span', { class: 'meta' }, `${fmt((mm.total_impulse_ns || 0) / 1000, 1)} kN·s · ${fmt(mm.burn_time_s, 1)} s · ${fmt(mm.avg_thrust_n, 0)} N avg · noz ${mm.nozzle_exit_in != null ? fmt(mm.nozzle_exit_in, 2) + ' in' : '?'}`),
                isHi(mm.label) ? h('span', { class: 'badge ok' }, 'searched') : null);
            })));
          return [row, det];
        })));
      wrap.append(det);
    }
  };
  draw();
  return wrap;
}
