import { App, api, cached, dateTime, fmt, fmtFt, h, isNum, lightbox, pageState, pages, refresh, render, toast } from '../core.js';
import { asyncBlock, badge, callout, confirmBtn, dataTable, reportView, runButton, stat, stepPage, subTabs } from '../components.js';
import { PALETTE, historyChart, historyOverlay, lineChart, scatterChart } from '../charts.js';
import { flightConfig } from '../player.js';

// ---- step 6: results --------------------------------------------------------
const STATUS_BADGE = { solved: 'ok', overpowered: 'warn', underpowered: 'warn', unsolved: 'err', infeasible: 'todo' };
const STATUS_COLOR = { solved: '#16a34a', overpowered: '#d97706', underpowered: '#9333ea', unsolved: '#dc2626' };
const keyOf = r => `${r.booster}|${r.sustainer ?? ''}|${r.profile}`;
const byDev = (a, b) => Math.abs(a.dev_ft ?? 1e9) - Math.abs(b.dev_ft ?? 1e9);
const signed = (v, d = 0) => isNum(v) ? (v > 0 ? '+' : '') + fmt(v, d) : '—';

/* designs.csv with the derived columns every tab uses, cached per file version */
async function loadDesigns(d) {
  const t = await cached('t:designs', '/api/table/designs', 0, d.mtime);
  return t.rows.map(r => ({ ...r, key: keyOf(r), dev_ft: isNum(r.apogee_ft) ? r.apogee_ft - d.target_ft : null, coast_s: isNum(r.sep_delay_s) && isNum(r.ign_delay_s) ? r.sep_delay_s + r.ign_delay_s : null }));
}
function characterizeVersion() {
  const st = (App.state.optimize.substages || []).find(x => x.name === 'characterize');
  return st ? st.mtime : undefined;
}
async function setShortlist(body) {
  try { await api('/api/shortlist', { body }); await refresh(true); } catch (e) { toast(e.message, 'err'); }
}
function starBtn(key, shortlist) {
  const on = shortlist.includes(key);
  return h('button', { class: 'star' + (on ? ' on' : ''), type: 'button', title: on ? 'remove from the shortlist' : 'add to the shortlist', 'aria-label': on ? 'remove from the shortlist' : 'add to the shortlist', onclick: e => { e.stopPropagation(); setShortlist(on ? { remove: key } : { add: key }); } }, on ? '★' : '☆');
}
function selectDesign(ps, key) { ps.sel = key; ps.tab = 'designs'; render(true); }

/* The verified history if verify exported one, else a python estimate. */
async function loadHistory(r, d) {
  const s = App.state;
  const ver = `${d.mtime}|${s.inputs.inputs_mtime}|${s.mass.table ? s.mass.table.mtime : ''}`;
  const key = keyOf(r);
  const dz = await cached('design:' + key, `/api/design?booster=${encodeURIComponent(r.booster)}${r.sustainer ? '&sustainer=' + encodeURIComponent(r.sustainer) : ''}${r.profile ? '&profile=' + encodeURIComponent(r.profile) : ''}`, 0, ver);
  if (dz.history) return { dz, hist: await cached('hist:' + dz.history.path, '/api/history?path=' + encodeURIComponent(dz.history.path), 0, dz.history.mtime), kind: 'verified' };
  if (r.sustainer && isNum(r.sep_delay_s) && isNum(r.ign_delay_s)) {
    try { return { dz, hist: await cached('flight:' + key, `/api/flight?booster=${encodeURIComponent(r.booster)}&sustainer=${encodeURIComponent(r.sustainer)}&profile=${encodeURIComponent(r.profile || '')}&sep=${r.sep_delay_s}&ign=${r.ign_delay_s}`, 0, ver), kind: 'estimated' }; }
    catch (e) { /* no estimate either: the static diagram still draws */ }
  }
  return { dz, hist: null, kind: null };
}

pages.results = () => {
  const s = App.state, d = s.results, cfg = s.config;
  const ps = pageState('results', { tab: 'designs', sel: null, filter: 'all', q: '', xMetric: 'mach_at_sep', eligOnly: true, ovMode: 'mach' });
  if (!d.n) return stepPage({ id: 'results', summary: 'Designs, eligibility, characterization, time histories, plots and the written report.', content: [callout('info', 'No results yet — run the optimizer (step 5).')] });
  const shortlist = d.shortlist || [];
  const nElig = d.eligibility ? Object.values(d.eligibility).reduce((a, v) => a + v.eligible, 0) : null;
  const tabs = subTabs(ps, 'tab', [['designs', 'Designs', d.n], ['matrix', 'Matrix'], ['tradespace', 'Trade space'], ['shortlist', 'Shortlist', shortlist.length || null], ['eligibility', 'Eligibility', nElig], ['characterization', 'Characterization'], ['plots', 'Plots'], ['previous', 'Previous runs'], ['report', 'Report']]);
  const TABS = {
    designs: () => designsTab(ps, d, cfg, shortlist),
    previous: () => asyncBlock(async () => previousTab(await loadDesigns(d), ps, d), 'Loading snapshots…'),
    matrix: () => asyncBlock(async () => matrixTab(await loadDesigns(d), ps, shortlist)),
    tradespace: () => asyncBlock(async () => tradespaceTab(await loadDesigns(d), ps, d, cfg)),
    shortlist: () => asyncBlock(async () => shortlistTab(await loadDesigns(d), ps, d, cfg, shortlist), 'Loading designs…'),
    eligibility: () => eligibilityTab(ps, cfg),
    characterization: () => characterizationTab(ps, cfg),
    plots: () => asyncBlock(async () => plotsTab(await loadDesigns(d), ps, d, cfg, shortlist, s), 'Loading flights…'),
    report: () => asyncBlock(async () => { const rr = await api('/api/report'); return rr.exists ? reportView(rr.text) : callout('info', 'no report.md yet — run the report stage'); }),
  };
  const body = (TABS[ps.tab] || TABS.designs)();
  return stepPage({
    id: 'results',
    summary: 'Every (booster, sustainer, profile) candidate with the delays found, its apogee and status. Star the designs worth keeping: the shortlist compares them side by side and sends them to RASAero together.',
    action: {
      title: 'Results',
      buttons: [h('button', { class: 'btn', onclick: () => api('/api/reveal', { body: { path: 'output' } }).catch(e => toast(e.message, 'err')) }, 'Reveal output folder'), runButton({ stage: 'report', label: 'Rebuild report & plots' }),
        confirmBtn('Snapshot results', 'Click again to snapshot', async () => { try { const r = await api('/api/archive', { body: {} }); toast(`snapshot ${r.name} (${r.files.length} files) in output-archive/`, 'ok'); } catch (e) { toast(e.message, 'err'); } }, 'btn')],
      options: h('div', { class: 'stat-list' },
        stat('target', fmt(d.target_ft, 0), 'ft'),
        stat('designs', d.n),
        stat('solved', d.n_solved, null, d.n_solved ? 'ok' : 'warn'),
        stat('shortlisted', shortlist.length, null, shortlist.length ? 'ok' : null),
        ...Object.entries(d.counts || {}).filter(([k]) => k !== 'solved').map(([k, v]) => stat(k, v)),
        ...Object.entries(d.eligibility || {}).map(([p, v]) => stat(`${p} eligible`, `${v.eligible}/${v.total}`)),
        d.characterization ? stat('Mach at burnout', `${fmt(d.characterization.mach_burnout_min, 2)}–${fmt(d.characterization.mach_burnout_max, 2)}`) : null,
        d.sustainer && d.sustainer.motors ? (d.sustainer.motors.length === 1
          ? stat('sustainer', d.sustainer.motors[0].label, null, null, `${fmt(d.sustainer.motors[0].total_impulse_ns, 0)} N·s`)
          : stat('sustainers', d.sustainer.motors.length, 'searched', null, d.sustainer.motors.map(x => x.label).join(', '))) : null,
        s.mass.table && !s.mass.table.error ? stat('pad weight', `${fmt(s.mass.table.combined_wt_lb[0], 0)}–${fmt(s.mass.table.combined_wt_lb[1], 0)}`, 'lb') : null),
    },
    content: [h('div', { class: 'card tabbed' }, tabs, body)],
    how: h('p', null, h('b', null, 'Status: '), 'solved = an ignition delay hits the target within tolerance · overpowered = apogee stays above the target even at the shortest allowed coast · underpowered = even the best coast falls short · unsolved = a bracket was found but did not converge. ', h('b', null, 'Δ target'), ' is apogee − target. ', h('b', null, 'Matrix'), ' shows every booster against every sustainer, ', h('b', null, 'Trade space'), ' plots apogee against the staging numbers, and ', h('b', null, 'Shortlist'), ' compares the starred designs and confirms them in RASAero.'),
  });
};

// ---- designs table + detail -------------------------------------------------
function designsTab(ps, d, cfg, shortlist) {
  return asyncBlock(async () => {
    const rows = await loadDesigns(d);
    const statuses = ['all', ...new Set(rows.map(r => r.status))];
    const f = ps.numFilters || (ps.numFilters = { dev: '', mach: '', g: '', vign: '' });
    let filtered = ps.filter === 'all' ? rows : rows.filter(r => r.status === ps.filter);
    if (f.dev !== '') filtered = filtered.filter(r => isNum(r.dev_ft) && Math.abs(r.dev_ft) <= +f.dev);
    if (f.mach !== '') filtered = filtered.filter(r => isNum(r.mach_at_sep) && r.mach_at_sep >= +f.mach);
    if (f.g !== '') filtered = filtered.filter(r => isNum(r.max_accel_g) && r.max_accel_g <= +f.g);
    if (f.vign !== '') filtered = filtered.filter(r => isNum(r.vel_at_ign_fps) && r.vel_at_ign_fps >= +f.vign);
    if (ps.q) { const q = ps.q.toLowerCase(); filtered = filtered.filter(r => `${r.booster} ${r.sustainer} ${r.profile} ${r.status}`.toLowerCase().includes(q)); }
    filtered = filtered.slice().sort(byDev);
    if (!ps.sel || !rows.some(r => r.key === ps.sel)) { const best = rows.slice().sort(byDev)[0]; ps.sel = best ? best.key : null; }
    const selIdx = filtered.findIndex(r => r.key === ps.sel);
    const selRow = selIdx >= 0 ? filtered[selIdx] : rows.find(r => r.key === ps.sel);
    // the player's shortcuts need the card focused; do it without scrolling
    const goTo = row => { ps.sel = row.key; render(); setTimeout(() => { const fc = document.querySelector('.flight-config'); if (fc) fc.focus({ preventScroll: true }); }, 60); };
    const nav = selRow && selIdx >= 0 ? { prev: selIdx > 0 ? filtered[selIdx - 1] : null, next: selIdx < filtered.length - 1 ? filtered[selIdx + 1] : null, onSelect: goTo, pos: `${selIdx + 1} / ${filtered.length}` } : null;
    const numIn = (label, k, ph, title) => h('label', { class: 'check small', title }, label, h('input', { type: 'number', class: 'inline-num', value: f[k], placeholder: ph, step: 'any', onchange: e => { f[k] = e.target.value; render(true); } }));
    const table = dataTable({
      columns: ['booster', 'star', 'sustainer', 'profile', 'status', 'sep_delay_s', 'ign_delay_s', 'apogee_ft', 'dev_ft', 'apogee_min_delay_ft', 'apogee_max_delay_ft', 'mach_at_sep', 'vel_at_ign_fps', 'mach_at_ign', 'alt_at_ign_ft', 'max_mach', 'max_accel_g', 't_apogee_s', 'verified_ok', 'n_sims'],
      rows: filtered.map(r => ({ ...r, star: shortlist.includes(r.key) })),
      labels: { star: '★', sep_delay_s: 'sep [s]', ign_delay_s: 'ign [s]', apogee_ft: 'apogee [ft]', dev_ft: 'Δ target', apogee_min_delay_ft: 'apogee @min ign', apogee_max_delay_ft: 'apogee @max ign', mach_at_sep: 'M @sep', vel_at_ign_fps: 'v @ign [fps]', mach_at_ign: 'M @ign', alt_at_ign_ft: 'alt @ign', max_mach: 'max M', max_accel_g: 'max g', t_apogee_s: 't apogee', verified_ok: 'verified', n_sims: 'sims' },
      format: { star: (v, r) => starBtn(r.key, shortlist), status: v => badge(STATUS_BADGE[v] || 'todo', v), verified_ok: v => v === null || v === undefined ? '—' : badge(v ? 'ok' : 'err', v ? 'ok' : 'fail'), dev_ft: v => signed(v), apogee_ft: v => fmt(v, 0), apogee_min_delay_ft: v => fmt(v, 0), apogee_max_delay_ft: v => fmt(v, 0), mach_at_sep: v => fmt(v, 3), mach_at_ign: v => fmt(v, 3) },
      onRow: goTo, rowKey: r => r.key, selected: ps.sel, maxHeight: '420px', stickyFirst: true,
      tools: { chooser: 'results.designs', csv: 'designs-filtered.csv', hiddenDefault: ['apogee_min_delay_ft', 'apogee_max_delay_ft', 'mach_at_ign', 'n_sims'] },
    });
    return h('div', null,
      selRow ? designDetail(selRow, d, cfg, nav, shortlist) : null,
      h('div', { class: 'card tight mt-4' },
        h('div', { class: 'toolbar' },
          h('span', { class: 'muted small' }, 'status:'), statuses.map(st => h('button', { class: 'btn sm ' + (ps.filter === st ? 'primary' : ''), onclick: () => { ps.filter = st; render(true); } }, st === 'all' ? `all (${rows.length})` : `${st} (${rows.filter(r => r.status === st).length})`)),
          h('span', { class: 'spacer' }),
          numIn('|Δ target| ≤', 'dev', 'ft', 'keep designs within this distance of the target'), numIn('M @sep ≥', 'mach', 'Mach', 'minimum Mach at separation'), numIn('v @ign ≥', 'vign', 'fps', 'minimum velocity at ignition'), numIn('max g ≤', 'g', 'g', 'maximum acceleration'),
          h('input', { type: 'text', class: 'searchbox', placeholder: 'filter boosters…', value: ps.q || '', onchange: e => { ps.q = e.target.value; render(true); } })),
        h('div', { class: 'muted small mb-1' }, 'sorted by distance to target · click a row for details · ★ adds it to the shortlist'),
        table));
  });
}

function designDetail(r, d, cfg, nav, shortlist) {
  const key = r.key || keyOf(r);
  const ps = pageState('results');
  const samplesChart = asyncBlock(async () => {
    const all = await cached('samples:' + key, '/api/samples?key=' + encodeURIComponent(key), 0, d.mtime);
    const pts = (all[key] || []).filter(p => isNum(p[1]));
    if (!pts.length) return h('div', { class: 'muted small' }, 'no search samples for this candidate');
    const bySep = new Map();
    for (const p of pts) { const sep = p.length > 2 ? p[2] : r.sep_delay_s; if (!bySep.has(sep)) bySep.set(sep, []); bySep.get(sep).push(p); }
    const seps = [...bySep.keys()].sort((a, b) => a - b);
    const series = seps.map(sep => { const q = bySep.get(sep).sort((a, b) => a[0] - b[0]); return { name: `sep ${fmt(sep, 2)} s`, x: q.map(p => p[0]), y: q.map(p => p[1]), points: true, width: sep === r.sep_delay_s ? 2.6 : 1.4 }; });
    return lineChart({ series, xLabel: 'ignition delay after separation [s]', yLabel: 'apogee [ft]', height: 240, refs: [{ y: d.target_ft, label: 'target', color: '#dc2626' }], markers: isNum(r.ign_delay_s) ? [{ x: r.ign_delay_s, label: 'chosen', color: '#16a34a' }] : [] });
  }, 'Loading search samples…');
  const flightBlock = asyncBlock(async () => {
    const { dz, hist, kind } = await loadHistory(r, d);
    const fc = flightConfig(r, dz, hist, kind, ps, cfg, d);
    return h('div', { class: 'stack' },
      fc.el,
      h('div', { class: 'grid c2' },
        h('div', { class: 'card tight' }, h('div', { class: 'fc-panel-head' }, 'SEARCH SAMPLES'), samplesChart),
        hist
          ? h('div', { class: 'card tight' },
            h('div', { class: 'row between' }, h('div', { class: 'fc-panel-head' }, kind === 'verified' ? 'VERIFIED TIME HISTORY' : 'ESTIMATED TIME HISTORY'), kind === 'estimated' ? h('span', { class: 'muted small' }, 'python sim, not yet verified') : null),
            historyChart(hist, null, { onHover: t => fc.player.preview(t), onLeave: () => fc.player.clearPreview() }))
          : h('div', { class: 'card tight' }, h('div', { class: 'fc-panel-head' }, 'TIME HISTORY'), h('div', { class: 'muted small' }, 'no time history yet — run verify, or check sep/ign delays'))));
  }, 'Loading flight configuration…');
  const navBtn = (rw, dir) => h('button', { class: 'btn sm ghost', disabled: !rw, title: rw ? `${rw.booster}${rw.sustainer ? ' + ' + rw.sustainer : ''} · ${rw.profile}` : '', onclick: () => rw && nav.onSelect(rw) }, dir < 0 ? '‹ prev' : 'next ›');
  const devFt = isNum(r.apogee_ft) ? r.apogee_ft - d.target_ft : null;
  return h('div', { class: 'stack mt-4' },
    h('div', { class: 'card tight' },
      h('div', { class: 'row', style: { justifyContent: 'space-between', flexWrap: 'wrap', gap: '8px' } },
        h('div', { class: 'row', style: { gap: '10px', flexWrap: 'wrap', alignItems: 'baseline' } },
          starBtn(key, shortlist),
          h('h3', null, `${r.booster}${r.sustainer ? ' + ' + r.sustainer : ''}`), h('span', { class: 'muted' }, r.profile), badge(STATUS_BADGE[r.status] || 'todo', r.status)),
        nav ? h('div', { class: 'row gap-1' }, navBtn(nav.prev, -1), h('span', { class: 'muted small' }, nav.pos), navBtn(nav.next, 1)) : null),
      h('div', { class: 'stat-list detail mt-2' },
        stat('apogee', fmt(r.apogee_ft, 0), 'ft', Math.abs((r.apogee_ft ?? 0) - d.target_ft) <= d.tolerance_ft ? 'ok' : 'warn'),
        stat('Δ target', signed(devFt), 'ft'),
        stat('separation', fmt(r.sep_delay_s, 2), 's after burnout'),
        stat('ignition', fmt(r.ign_delay_s, 2), 's after separation'),
        stat('Mach @ sep', fmt(r.mach_at_sep, 3)),
        stat('max Mach', fmt(r.max_mach, 3)),
        stat('max accel', fmt(r.max_accel_g, 1), 'g')),
      r.hint ? h('div', { class: 'callout warn mt-2' }, h('b', null, 'hint: '), r.hint) : null,
      r.verify_note ? h('div', { class: 'callout err mt-2' }, h('b', null, 'verification: '), r.verify_note) : null),
    flightBlock);
}

// ---- matrix: boosters × (sustainer, profile) --------------------------------
function matrixTab(rows, ps, shortlist) {
  const sus = [...new Set(rows.map(r => r.sustainer ?? ''))], profs = [...new Set(rows.map(r => r.profile))];
  const cols = sus.flatMap(su => profs.map(p => ({ su, p }))).filter(c => rows.some(r => (r.sustainer ?? '') === c.su && r.profile === c.p));
  const byB = new Map();
  for (const r of rows) { if (!byB.has(r.booster)) byB.set(r.booster, []); byB.get(r.booster).push(r); }
  const bestDev = b => Math.min(...byB.get(b).map(r => Math.abs(r.dev_ft ?? 1e9)));
  const boosters = [...byB.keys()].sort((a, b) => bestDev(a) - bestDev(b));
  const cell = r => !r ? h('td', { class: 'cell none' }, '—') : h('td', {
    class: 'cell ' + r.status + (r.key === ps.sel ? ' sel' : '') + (shortlist.includes(r.key) ? ' star' : ''),
    title: `${r.booster} + ${r.sustainer} · ${r.profile} · ${r.status}\nsep ${r.sep_delay_s} s, ign ${r.ign_delay_s} s · Δ ${signed(r.dev_ft)} ft · M@sep ${fmt(r.mach_at_sep, 2)} · click to open`,
    onclick: () => selectDesign(ps, r.key),
  }, fmt(r.apogee_ft, 0), h('span', { class: 'd' }, signed(r.dev_ft)));
  const table = h('table', { class: 'data matrix' },
    h('thead', null, h('tr', null, h('th', null, 'booster'), h('th', { class: 'n' }, 'best |Δ|'), cols.map(c => h('th', null, c.su || '—', h('br'), h('span', { class: 'muted' }, c.p))))),
    h('tbody', null, boosters.map(b => { const rs = byB.get(b); return h('tr', null, h('td', null, b), h('td', { class: 'n' }, fmt(bestDev(b), 0)), cols.map(c => cell(rs.find(r => (r.sustainer ?? '') === c.su && r.profile === c.p)))); })));
  return h('div', null,
    h('p', { class: 'muted small' }, 'Apogee [ft] of every (booster, sustainer, profile) design, boosters ordered by their closest design, Δ target under each value. Click a cell to open the design.'),
    h('div', { class: 'legend mb-2' }, [['solved', 'ok'], ['overpowered', 'warn'], ['underpowered', 'warn'], ['unsolved', 'err']].map(([k, c]) => h('span', null, badge(c, k))), h('span', null, '★ shortlisted')),
    h('div', { class: 'tablewrap', style: { maxHeight: '640px' } }, table));
}

// ---- trade space scatter ----------------------------------------------------
function tradespaceTab(rows, ps, d, cfg) {
  const metrics = { mach_at_sep: 'Mach at separation', vel_at_ign_fps: 'velocity at ignition [fps]', alt_at_ign_ft: 'altitude at ignition [ft]', coast_s: 'coast: separation + ignition delay [s]', max_accel_g: 'max acceleration [g]', t_apogee_s: 'time to apogee [s]', max_mach: 'max Mach' };
  const xm = metrics[ps.xMetric] ? ps.xMetric : 'mach_at_sep';
  const pts = rows.filter(r => isNum(r[xm]) && isNum(r.apogee_ft)).map(r => ({ x: r[xm], y: r.apogee_ft, key: r.key, row: r }));
  const p = cfg.profiles;
  const xrefs = xm === 'mach_at_sep' ? [{ x: p.supersonic_min_mach, label: `M ${p.supersonic_min_mach}`, color: '#dc2626' }, { x: p.subsonic_max_mach, label: `M ${p.subsonic_max_mach}`, color: '#16a34a' }] : [];
  const chart = scatterChart({
    points: pts, xLabel: metrics[xm], yLabel: 'apogee [ft]', height: 380,
    band: { y0: d.target_ft - d.tolerance_ft, y1: d.target_ft + d.tolerance_ft, label: `target ${fmt(d.target_ft, 0)} ± ${fmt(d.tolerance_ft, 0)} ft` }, xrefs,
    color: q => STATUS_COLOR[q.row.status] || '#64748b',
    shape: q => q.row.profile === 'subsonic' ? 'square' : q.row.profile === 'supersonic' ? 'circle' : 'diamond',
    selectedKey: ps.sel, onClick: q => selectDesign(ps, q.key),
    tip: q => [['design', `${q.row.booster} + ${q.row.sustainer}`], ['profile', `${q.row.profile} · ${q.row.status}`], [metrics[xm], fmt(q.x)], ['apogee', fmtFt(q.y)], ['Δ target', signed(q.row.dev_ft) + ' ft'], ['delays', `sep ${q.row.sep_delay_s} s · ign ${q.row.ign_delay_s} s`]],
  });
  return h('div', null,
    h('div', { class: 'row between mb-1' },
      h('label', { class: 'check' }, 'x axis', h('select', { class: 'inline-sel', onchange: e => { ps.xMetric = e.target.value; render(true); } }, Object.entries(metrics).map(([v, l]) => h('option', { value: v, selected: xm === v }, l)))),
      h('div', { class: 'legend' }, Object.entries(STATUS_COLOR).filter(([k]) => rows.some(r => r.status === k)).map(([k, c]) => h('span', null, h('span', { class: 'sw', style: { background: c, height: '10px', borderRadius: '50%', width: '10px' } }), k)),
        h('span', null, h('span', { class: 'shape circle' }), 'supersonic'), h('span', null, h('span', { class: 'shape' }), 'subsonic'), h('span', null, h('span', { class: 'shape diamond' }), 'other'))),
    chart,
    h('p', { class: 'muted small mt-1' }, `${pts.length} designs · the green band is the target tolerance · click a point to open the design`));
}

// ---- shortlist: side-by-side compare + confirm ------------------------------
function shortlistTab(rows, ps, d, cfg, shortlist) {
  const items = shortlist.map(k => rows.find(r => r.key === k)).filter(Boolean);
  const gone = shortlist.filter(k => !rows.some(r => r.key === k));
  if (!items.length) return callout('info', h('b', null, 'Nothing shortlisted yet. '), 'Star designs (☆) in the Designs table or in a design\'s detail; they line up here side by side with their flights overlaid, and can be sent to RASAero together.', gone.length ? ` ${gone.length} starred key(s) are no longer in designs.csv.` : '');
  const metrics = [
    ['status', r => badge(STATUS_BADGE[r.status] || 'todo', r.status)], ['apogee [ft]', r => fmt(r.apogee_ft, 0)], ['Δ target [ft]', r => signed(r.dev_ft)],
    ['separation delay [s]', r => fmt(r.sep_delay_s, 2)], ['ignition delay [s]', r => fmt(r.ign_delay_s, 2)], ['Mach at separation', r => fmt(r.mach_at_sep, 3)],
    ['velocity at ignition [fps]', r => fmt(r.vel_at_ign_fps, 0)], ['altitude at ignition [ft]', r => fmt(r.alt_at_ign_ft, 0)], ['max Mach', r => fmt(r.max_mach, 3)],
    ['max acceleration [g]', r => fmt(r.max_accel_g, 1)], ['time to apogee [s]', r => fmt(r.t_apogee_s, 1)], ['verified', r => r.verified_ok == null ? '—' : badge(r.verified_ok ? 'ok' : 'err', r.verified_ok ? 'ok' : 'fail')]];
  const table = h('table', { class: 'data cmp-table' },
    h('thead', null, h('tr', null, h('th', null, ''), items.map((r, i) => h('th', { class: 'dcol' }, h('span', { class: 'sw', style: { background: PALETTE[i % PALETTE.length] } }), ' ', h('a', { href: '#', onclick: e => { e.preventDefault(); selectDesign(ps, r.key); } }, r.booster), h('br'), h('span', { class: 'muted' }, `${r.sustainer} · ${r.profile}`), ' ', h('button', { class: 'btn sm ghost', title: 'remove from the shortlist', onclick: () => setShortlist({ remove: r.key }) }, '×'))))),
    h('tbody', null, metrics.map(([label, f]) => h('tr', null, h('td', { class: 'muted' }, label), items.map(r => h('td', { class: 'n' }, f(r)))))));
  const overlay = asyncBlock(async () => {
    const hs = await Promise.all(items.map(r => loadHistory(r, d)));
    const withH = items.map((r, i) => ({ name: `${r.booster} + ${r.sustainer}`, hist: hs[i].hist, color: PALETTE[i % PALETTE.length], dash: hs[i].kind === 'estimated' })).filter(x => x.hist);
    if (!withH.length) return h('div', { class: 'muted small' }, 'no flight histories yet');
    return h('div', null,
      h('div', { class: 'row mb-1' }, h('span', { class: 'muted small' }, 'overlay:'), h('select', { class: 'inline-sel', onchange: e => { ps.ovMode = e.target.value; render(true); } }, [['mach', 'Mach'], ['altitude', 'altitude'], ['velocity', 'velocity']].map(([v, l]) => h('option', { value: v, selected: ps.ovMode === v }, l))), withH.some(x => x.dash) ? h('span', { class: 'muted small' }, 'dashed = python estimate, not verified') : null),
      historyOverlay(withH, ps.ovMode, cfg));
  }, 'Loading flights…');
  const confirmRun = runButton({ stage: 'confirm', args: ['--designs', items.map(r => r.key).join(',')], label: `Confirm these ${items.length} in RASAero`, primary: true, title: 'one CDX1 with these rows, re-run in RASAero through the VM worker (step 7)' });
  return h('div', { class: 'stack' },
    h('div', { class: 'row between' },
      h('span', { class: 'muted small' }, `${items.length} shortlisted design${items.length === 1 ? '' : 's'}${gone.length ? ` · ${gone.length} starred key(s) no longer in designs.csv` : ''} · kept in output/shortlist.json`),
      h('div', { class: 'row gap-1' }, confirmRun, confirmBtn('Clear shortlist', 'Click again to clear', () => setShortlist({ keys: [] })))),
    h('div', { class: 'tablewrap' }, table),
    h('div', { class: 'card tight' }, h('div', { class: 'fc-panel-head' }, 'FLIGHTS OVERLAID'), overlay));
}

// ---- previous runs: diff against a snapshot in output-archive/ ---------------
async function previousTab(rows, ps, d) {
  const { archives } = await api('/api/archives');
  if (!archives.length) return callout('info', h('b', null, 'No result snapshots yet. '), 'One is taken automatically before every fresh run; "Snapshot results" above takes one now.');
  const name = archives.some(a => a.name === ps.archive) ? ps.archive : archives[0].name;
  const arc = await cached('archive:' + name, '/api/archive?name=' + encodeURIComponent(name), 600000);
  const old = new Map(arc.rows.map(r => [keyOf(r), r]));
  const cur = new Map(rows.map(r => [r.key, r]));
  const keys = [...new Set([...old.keys(), ...cur.keys()])];
  const diff = keys.map(k => {
    const a = old.get(k), b = cur.get(k), any = b || a;
    const moved = a && b && isNum(a.apogee_ft) && isNum(b.apogee_ft) && Math.abs(b.apogee_ft - a.apogee_ft) > 1;
    return { key: k, booster: any.booster, sustainer: any.sustainer, profile: any.profile, status_before: a ? a.status : null, status_after: b ? b.status : null, apogee_before: a ? a.apogee_ft : null, apogee_after: b ? b.apogee_ft : null, delta_ft: a && b && isNum(a.apogee_ft) && isNum(b.apogee_ft) ? b.apogee_ft - a.apogee_ft : null, change: !a ? 'new' : !b ? 'removed' : a.status !== b.status ? 'status' : moved ? 'apogee' : 'same' };
  });
  const changed = diff.filter(r => r.change !== 'same');
  const counts = list => { const m = {}; for (const r of list) m[r.status] = (m[r.status] || 0) + 1; return Object.entries(m).map(([k, v]) => `${v} ${k}`).join(' · ') || '—'; };
  return h('div', { class: 'stack' },
    h('div', { class: 'row between' },
      h('label', { class: 'check' }, 'compare with', h('select', { class: 'inline-sel', onchange: e => { ps.archive = e.target.value; render(true); } }, archives.map(a => h('option', { value: a.name, selected: a.name === name }, `${a.name}${a.label ? ' · ' + a.label : ''} — ${a.n_designs} designs, ${dateTime(a.mtime)}`)))),
      h('span', { class: 'muted small' }, `then: ${counts(arc.rows)} · now: ${counts(rows)}`)),
    h('div', { class: 'stat-list' },
      stat('changed', changed.length, `of ${keys.length} designs`, changed.length ? 'warn' : 'ok'),
      stat('status changed', diff.filter(r => r.change === 'status').length), stat('apogee moved', diff.filter(r => r.change === 'apogee').length),
      stat('new', diff.filter(r => r.change === 'new').length), stat('removed', diff.filter(r => r.change === 'removed').length),
      arc.target_ft != null && arc.target_ft !== d.target_ft ? stat('target then', fmt(arc.target_ft, 0), 'ft', 'warn') : null),
    dataTable({
      columns: ['booster', 'sustainer', 'profile', 'change', 'status_before', 'status_after', 'apogee_before', 'apogee_after', 'delta_ft'],
      rows: (ps.showSame ? diff : changed).slice().sort((a, b) => Math.abs(b.delta_ft ?? 0) - Math.abs(a.delta_ft ?? 0)),
      labels: { status_before: 'status then', status_after: 'status now', apogee_before: 'apogee then', apogee_after: 'apogee now', delta_ft: 'Δ apogee' },
      format: { change: v => badge({ same: 'todo', status: 'warn', apogee: 'info', new: 'ok', removed: 'err' }[v] || 'todo', v), status_before: v => v ? badge(STATUS_BADGE[v] || 'todo', v) : '—', status_after: v => v ? badge(STATUS_BADGE[v] || 'todo', v) : '—', apogee_before: v => fmt(v, 0), apogee_after: v => fmt(v, 0), delta_ft: v => signed(v) },
      onRow: r => { if (cur.has(r.key)) selectDesign(ps, r.key); }, rowKey: r => r.key, maxHeight: '520px', stickyFirst: true,
      tools: { csv: 'run-diff.csv', extra: h('label', { class: 'check small' }, h('input', { type: 'checkbox', checked: !!ps.showSame, onchange: e => { ps.showSame = e.target.checked; render(true); } }), 'show unchanged designs too') },
    }));
}

// ---- eligibility -------------------------------------------------------------
function eligibilityTab(ps, cfg) {
  return asyncBlock(async () => {
    const t = await cached('t:eligibility', '/api/table/eligibility', 0, characterizeVersion());
    const nElig = t.rows.filter(r => r.eligible).length;
    const rows = ps.eligOnly ? t.rows.filter(r => r.eligible) : t.rows;
    return h('div', null,
      h('p', { class: 'muted small' }, `subsonic: the attached stack must stay below Mach ${cfg.profiles.subsonic_max_mach} − ${cfg.profiles.mach_margin} throughout boost. supersonic: separation must happen at or above Mach ${cfg.profiles.supersonic_min_mach} + ${cfg.profiles.mach_margin}; the physics limit is how long after burnout that is still true, and the searched separation window (sep min–max) is your window clipped to it.`),
      dataTable({ columns: t.columns, rows, labels: { sep_min_s: 'sep min [s]', sep_max_s: 'sep max [s]', sep_window_max_s: 'physics limit [s]' }, format: { eligible: v => badge(v ? 'ok' : 'todo', v ? 'eligible' : 'no') }, wrap: ['reason'], rowClass: r => r.eligible ? '' : 'dim', maxHeight: '560px',
        tools: { chooser: 'results.eligibility', csv: 'eligibility.csv', extra: h('label', { class: 'check small' }, h('input', { type: 'checkbox', checked: ps.eligOnly, onchange: e => { ps.eligOnly = e.target.checked; render(true); } }), `eligible only (${nElig} of ${t.rows.length})`) } }));
  });
}

// ---- characterization ----------------------------------------------------------
const CHAR_METRICS = { mach_burnout: 'Mach at burnout', max_mach_boost: 'peak boost Mach', t_burnout_s: 'burnout time [s]', alt_burnout_ft: 'altitude at burnout [ft]', vel_burnout_fps: 'velocity at burnout [fps]', t_below_supersonic_s: 'seconds above Mach 1.2 after burnout' };
function characterizationChart(rows, cfg, metric, height = 240) {
  const bySus = new Map();
  for (const r of rows) { const k = r.sustainer || '—'; if (!bySus.has(k)) bySus.set(k, []); bySus.get(k).push(r); }
  const series = [...bySus.entries()].map(([sus, rs]) => ({ name: sus, x: rs.map((_, i) => i + 1), y: rs.map(r => r[metric]), points: true, width: 1.2 }));
  const machRefs = [{ y: cfg.profiles.supersonic_min_mach + cfg.profiles.mach_margin, label: 'supersonic limit + margin', color: '#dc2626' }, { y: cfg.profiles.subsonic_max_mach - cfg.profiles.mach_margin, label: 'subsonic limit − margin', color: '#16a34a' }];
  return lineChart({ series, xLabel: 'booster #', yLabel: CHAR_METRICS[metric] || metric, height, refs: metric === 'mach_burnout' || metric === 'max_mach_boost' ? machRefs : [] });
}
function characterizationTab(ps, cfg) {
  return asyncBlock(async () => {
    const t = await cached('t:characterization', '/api/table/characterization', 0, characterizeVersion());
    const metric = CHAR_METRICS[ps.charMetric] ? ps.charMetric : 'mach_burnout';
    const sus = [...new Set(t.rows.map(r => r.sustainer || '—'))];
    const susFilter = ps.charSus && sus.includes(ps.charSus) ? ps.charSus : '';
    return h('div', null,
      h('p', { class: 'muted small' }, 'One long-coast flight per (booster, sustainer) pair, stack attached. One line per sustainer, boosters in motor-file order. t_below_* = seconds after burnout until the stack drops below Mach 1.2 / 0.9.'),
      h('div', { class: 'row mb-2' }, h('span', { class: 'muted small' }, 'metric:'), h('select', { class: 'inline-sel', onchange: e => { ps.charMetric = e.target.value; render(true); } }, Object.entries(CHAR_METRICS).map(([v, l]) => h('option', { value: v, selected: metric === v }, l))),
        h('span', { class: 'muted small' }, 'table:'), h('select', { class: 'inline-sel', onchange: e => { ps.charSus = e.target.value; render(true); } }, [['', `all sustainers (${t.rows.length})`], ...sus.map(k => [k, k])].map(([v, l]) => h('option', { value: v, selected: susFilter === v }, l)))),
      characterizationChart(t.rows, cfg, metric),
      dataTable({ columns: t.columns, rows: susFilter ? t.rows.filter(r => (r.sustainer || '—') === susFilter) : t.rows, hide: ['note'], format: { events_consistent: v => badge(v ? 'ok' : 'err', v ? 'ok' : 'mismatch') }, maxHeight: '480px', stickyFirst: true, tools: { chooser: 'results.characterization', csv: 'characterization.csv' } }));
  });
}

// ---- plots: interactive versions of the report figures -------------------------
async function plotsTab(rows, ps, d, cfg, shortlist, s) {
  const chosen = shortlist.map(k => rows.find(r => r.key === k)).filter(Boolean);
  const set = chosen.length ? chosen : rows.slice().sort(byDev).slice(0, 8);
  const colorOf = r => PALETTE[set.indexOf(r) % PALETTE.length];
  const samples = await cached('samples:' + set.map(r => r.key).join(','), '/api/samples?keys=' + encodeURIComponent(set.map(r => r.key).join(',')), 0, d.mtime);
  const profiles = [...new Set(set.map(r => r.profile))];
  const perProfile = profiles.map(p => {
    const series = set.filter(r => r.profile === p).map(r => {
      const pts = (samples[r.key] || []).filter(q => isNum(q[1]) && (q.length < 3 || Math.abs(q[2] - r.sep_delay_s) < 1e-6)).sort((a, b) => a[0] - b[0]);
      return { name: `${r.booster} + ${r.sustainer}`, x: pts.map(q => q[0]), y: pts.map(q => q[1]), points: true, color: colorOf(r) };
    });
    return h('div', { class: 'card tight' }, h('div', { class: 'fc-panel-head' }, `APOGEE VS IGNITION DELAY · ${p}`), lineChart({ series, xLabel: 'ignition delay after separation [s] (at each design\'s separation delay)', yLabel: 'apogee [ft]', height: 260, refs: [{ y: d.target_ft, label: 'target', color: '#dc2626' }] }));
  });
  const hs = await Promise.all(set.map(r => loadHistory(r, d)));
  const withH = set.map((r, i) => ({ name: `${r.booster} + ${r.sustainer} · ${r.profile}`, hist: hs[i].hist, color: colorOf(r), dash: hs[i].kind === 'estimated' })).filter(x => x.hist);
  const ct = await cached('t:characterization', '/api/table/characterization', 0, characterizeVersion()).catch(() => null);
  return h('div', { class: 'stack' },
    h('p', { class: 'muted small' }, chosen.length ? `The ${chosen.length} shortlisted design(s).` : `The 8 designs closest to the target — star designs to choose which appear here.`),
    h('div', { class: 'grid c2' }, ...perProfile),
    h('div', { class: 'card tight' }, h('div', { class: 'fc-panel-head' }, 'MACH VS TIME'), withH.length ? historyOverlay(withH, 'mach', cfg) : h('div', { class: 'muted small' }, 'no flight histories'), withH.some(x => x.dash) ? h('div', { class: 'muted small' }, 'dashed = python estimate, not verified') : null),
    ct && ct.rows.length ? h('div', { class: 'card tight' }, h('div', { class: 'fc-panel-head' }, 'BOOST CHARACTERIZATION · MACH AT BURNOUT'), characterizationChart(ct.rows, cfg, 'mach_burnout', 220)) : null,
    s.plots.length ? h('div', { class: 'muted small' }, 'Report figures (PNG, from the report stage): ', s.plots.map((p, i) => [i ? ' · ' : '', h('a', { href: '#', onclick: e => { e.preventDefault(); lightbox('/files/' + p.path + '?t=' + p.mtime); } }, p.name)])) : null);
}
