import { $, App, STEPS, dur, fmt, fmtFt, go, h, pages, renderActivity, stepStatus } from '../core.js';
import { badge, callout, kv, runHistory, stat, sustainerSummary, workerCard } from '../components.js';

// ---- overview ---------------------------------------------------------------
pages.overview = () => {
  const s = App.state;
  const d = s.results;
  const cfg = s.config;
  const blocking = STEPS.find(st => ['todo', 'error', 'stale', 'unchecked'].includes(stepStatus(st.id)));
  const attention = STEPS.filter(st => ['warn', 'partial'].includes(stepStatus(st.id)));
  const running = STEPS.find(st => stepStatus(st.id) === 'running');
  const changesText = list => { const c = list || []; return c.length ? ' — ' + c.slice(0, 2).join('; ') + (c.length > 2 ? ` (+${c.length - 2} more)` : '') : ''; };
  const why = st => {
    const stt = stepStatus(st.id);
    if (stt === 'stale' && st.id === 'optimize') return changesText(s.optimize.changes) || ' — its inputs changed since it last ran';
    if (stt === 'unchecked') return (changesText(s.inputs.changes) || ' — inputs changed') + ', press Check';
    return { stale: ' — its inputs changed since it last ran', error: ' — there is a problem to fix', todo: '' }[stt] || '';
  };
  const nextText = running ? `Step ${running.n} (${running.title}) is running.` : blocking ? (blocking.id === 'results' ? 'Run the optimizer (step 5) to get results.' : `step ${blocking.n}, ${blocking.title}${why(blocking)}.`) : attention.length ? `All steps have been run; step ${attention[0].n} (${attention[0].title}) needs a look.` : 'Every step is complete. Re-run steps whose inputs changed (they are flagged "out of date").';
  const headline = () => {
    if (!d.n) return callout('info', h('b', null, 'No results yet. '), 'Follow the steps in order; the optimizer runs on this Mac once the aero tables exist.');
    const b = d.best;
    const solved = d.n_solved;
    const tgt = d.target_ft;
    const over = (d.counts || {}).overpowered || 0, under = (d.counts || {}).underpowered || 0, unsolved = (d.counts || {}).unsolved || 0;
    if (solved) return callout('ok', h('b', null, `${solved} design(s) hit ${fmtFt(tgt)} ± ${fmt(d.tolerance_ft, 0)} ft`), ` — ${d.n_verified_ok} verified. Best: `, h('b', null, `${b.booster} · ${b.profile}`), ` sep ${b.sep_delay_s}s, ign ${b.ign_delay_s}s → ${fmtFt(b.apogee_ft)}.`);
    if (over === d.n) return callout('warn', h('b', null, `Every candidate overshoots ${fmtFt(tgt)}.`), ` Lowest reachable apogee is ${fmtFt(d.apogee_min_ft)} (${b.booster}, ${b.profile}, sep ${b.sep_delay_s}s, ign ${b.ign_delay_s}s after separation). Heavier hardware mass, a lower-impulse sustainer, airbrakes/ballast, or a shorter ignition gap would bring it down.`);
    if (under === d.n) return callout('warn', h('b', null, `No candidate reaches ${fmtFt(tgt)}.`), ` Highest reachable apogee is ${fmtFt(d.apogee_max_ft)} (${b.booster}, ${b.profile}). A lighter hardware mass or more impulse is needed.`);
    return callout('warn', h('b', null, 'No design hit the target.'), ` ${over} overpowered, ${under} underpowered, ${unsolved} unsolved. Closest: ${b.booster} ${b.profile} → ${fmtFt(b.apogee_ft)}.`);
  };
  const el = d.eligibility || {};
  const m = s.inputs.motors;
  return h('div', { class: 'stack' },
    h('div', { class: 'page-head' }, h('div', null, h('h1', null, 'Overview'), h('div', { class: 'desc' }, 'Where the project stands, what the optimizer found, and what to do next. Work through the steps in the sidebar from top to bottom — each one explains what it needs, what it produces and has a single Run button.'))),
    h('div', { class: 'next-action' }, h('div', { class: 't' }, h('b', null, 'Next: '), nextText), running ? h('button', { class: 'btn sm', onclick: () => { App.collapsed = false; renderActivity(); } }, 'Show log') : blocking ? h('button', { class: 'btn sm primary', onclick: () => go(blocking.id === 'results' ? 'optimize' : blocking.id) }, `Go to step ${blocking.id === 'results' ? 5 : blocking.n} →`) : attention.length ? h('button', { class: 'btn sm', onclick: () => go(attention[0].id) }, `Open step ${attention[0].n} →`) : h('button', { class: 'btn sm', onclick: () => go('results') }, 'Open results →')),
    h('div', { class: 'card' }, h('h2', null, 'Progress'),
      h('div', { class: 'steps-strip' }, STEPS.map(st => { const stt = stepStatus(st.id); return h('button', { class: 's', type: 'button', onclick: () => go(st.id) }, h('div', { class: 'n' }, `step ${st.n}`), h('div', { class: 't' }, st.title), h('div', { class: 'b' }, badge(stt))); }))),
    h('div', { class: 'grid c2' },
      h('div', { class: 'card' }, h('h2', null, 'Headline result'),
        headline(),
        d.n ? h('div', { class: 'stat-list mt-3' },
          stat('target', fmt(d.target_ft, 0), 'ft'),
          stat('designs', d.n),
          stat('solved', d.n_solved, null, d.n_solved ? 'ok' : 'warn'),
          stat('overpowered', (d.counts || {}).overpowered || 0),
          stat('underpowered', (d.counts || {}).underpowered || 0),
          ...Object.entries(el).map(([p, v]) => stat(`${p} eligible`, `${v.eligible}/${v.total}`))) : null,
        d.n ? h('div', { class: 'row mt-3' }, h('button', { class: 'btn', onclick: () => go('results') }, 'Open results →')) : null),
      h('div', { class: 'stack' },
        h('div', { class: 'card' }, h('h2', null, 'Vehicle & target', h('span', { class: 'right' }, h('a', { href: '#inputs', onclick: e => { e.preventDefault(); go('inputs'); } }, 'edit →'))),
          kv([
            ['OpenRocket model', s.inputs.ork.name + (s.inputs.ork.exists ? '' : ' (missing)')],
            ['RASAero model', s.inputs.cdx1.name + (s.inputs.cdx1.exists ? '' : ' (missing)')],
            ['boosters', `${s.inputs.boosters.n} candidates from ${s.inputs.boosters.sources.length} source(s)`],
            ['sustainers', m ? sustainerSummary(m) : '—'],
            ['hardware mass', s.mass.hardware_mass_lb != null ? `${fmt(s.mass.hardware_mass_lb, 0)} lb dry` : '.ork masses'],
            ['target apogee', `${fmt(cfg.target.apogee_ft, 0)} ± ${fmt(cfg.target.tolerance_ft, 0)} ft`],
            ['profiles', `subsonic < M${cfg.profiles.subsonic_max_mach}, supersonic ≥ M${cfg.profiles.supersonic_min_mach} (margin ${cfg.profiles.mach_margin})`],
            ['delay windows', `separation ${fmt(cfg.profiles.separation_delay_min_s)}–${fmt(cfg.profiles.separation_delay_max_s)} s after burnout · ignition ${fmt(cfg.profiles.ignition_delay_min_s)}–${fmt(cfg.profiles.ignition_delay_max_s)} s after separation`],
            ['backend', cfg.backend],
          ])),
        workerCard(s))),
    h('div', { class: 'grid c2' },
      h('div', { class: 'card' }, h('h2', null, 'Recent runs'), runHistory(s.history)),
      howToCard(s)));
};

export function howToCard(s) {
  const key = 'rpa-howto-open';
  let open = true;
  try { open = localStorage.getItem(key) !== '0'; } catch (e) { /* ignore */ }
  const lr = s.optimize.last_run;
  const runTxt = lr ? `the last full run took ${dur(lr.elapsed_s)}` : 'minutes on this Mac, depending on the grids';
  return h('details', { class: 'card how-card', open, ontoggle: e => { try { localStorage.setItem(key, e.target.open ? '1' : '0'); } catch (err) { /* ignore */ } } },
    h('summary', null, h('h2', null, 'How to use this tool')),
    h('ol', { class: 'howto' },
      h('li', null, h('b', null, 'Step 1'), ' — point the tool at your .ork, .CDX1 and motor files (tick any mix of folders and single .eng files), set the hardware mass and the target apogee, then press ', h('b', null, 'Check'), '.'),
      h('li', null, h('b', null, 'Steps 2–4'), ' — done once per vehicle revision: export RASAero\'s drag tables, fly a few reference cases in RASAero and validate the fast simulator against them. Steps marked ', h('span', { class: 'badge info' }, 'needs the VM worker'), ' drive RASAero in the Windows VM — press ', h('b', null, 'Start VM worker'), ' (worker card, or the note on those steps) and the VM is booted and the worker started for you.'),
      h('li', null, h('b', null, 'Step 5'), ` — run the optimizer as often as you like (${runTxt}).`),
      h('li', null, h('b', null, 'Steps 6–7'), ' — read the results, then confirm the chosen designs in RASAero itself.'),
      h('li', null, 'The panel at the bottom shows the live log of whatever is running. Every Run button shows the equivalent command line, so everything can also be scripted.')));
}
