import { $, api, clock, dur, esc, fmt, h, isNum, toast } from './core.js';
import { badge, callout, stat } from './components.js';
import { niceTicks, responsive } from './charts.js';

// ---- flight configuration infographic (results › design detail) -------------
export const N_PER_LB = 4.448222, IN_PER_MM = 1 / 25.4, KG_TO_LB = 2.20462262;

export const PHASE_DEFS = [
  { id: 'boost', name: 'boost' },
  { id: 'sep_delay', name: 'separation delay' },
  { id: 'ign_delay', name: 'ignition delay' },
  { id: 'sustain', name: 'sustainer burn' },
  { id: 'coast', name: 'coast to apogee' },
];

// ---- flight player: one playhead drives the vehicle, ascent, timeline and
// thrust views together. `hist` (from /api/history or /api/flight) supplies
// real mach/altitude/velocity; without it those readouts stay blank.
export function lowerBound(xs, v) {
  let lo = 0, hi = xs.length;
  while (lo < hi) { const mid = (lo + hi) >> 1; if (xs[mid] < v) lo = mid + 1; else hi = mid; }
  return lo;
}

export function interpAt(xs, ys, t) {
  if (!xs || !xs.length) return null;
  if (t <= xs[0]) return isNum(ys[0]) ? ys[0] : null;
  if (t >= xs[xs.length - 1]) return isNum(ys[ys.length - 1]) ? ys[ys.length - 1] : null;
  const i = Math.min(xs.length - 1, Math.max(1, lowerBound(xs, t)));
  const x0 = xs[i - 1], x1 = xs[i], y0 = ys[i - 1], y1 = ys[i];
  if (!isNum(y0)) return isNum(y1) ? y1 : null;
  if (!isNum(y1)) return y0;
  return y0 + (y1 - y0) * ((t - x0) / ((x1 - x0) || 1));
}

export function phaseIndexAt(t, T) {
  let idx = 0;
  for (let i = 0; i <= 4; i++) if (isNum(T[i]) && t >= T[i] - 1e-9) idx = i;
  return idx;
}

export function createFlightPlayer(end, T, hist) {
  const views = [];
  const playSubs = [];
  let t = 0, playing = false, speed = 1, raf = null, lastTs = null, rootEl = null;
  const clampT = v => Math.max(0, Math.min(end, isNum(v) ? v : 0));
  function sample(tt) {
    const c = hist && hist.columns;
    return {
      t: tt, phase: phaseIndexAt(tt, T),
      attached: !isNum(T[2]) || tt < T[2],
      firing: (isNum(T[1]) && tt <= T[1]) || (isNum(T[3]) && isNum(T[4]) && tt >= T[3] && tt <= T[4]),
      alt: c ? interpAt(c.time_s, c.altitude_ft, tt) : null,
      mach: c ? interpAt(c.time_s, c.mach, tt) : null,
      vel: c ? interpAt(c.time_s, c.velocity_fps, tt) : null,
    };
  }
  function paint(tt) { const snap = sample(tt); for (const v of views) v.update(snap); }
  function frame(ts) {
    if (!playing) return;
    if (rootEl && !document.body.contains(rootEl)) { playing = false; lastTs = null; return; }
    if (lastTs != null) t = clampT(t + (ts - lastTs) / 1000 * speed);
    lastTs = ts;
    paint(t);
    if (t >= end) { playing = false; lastTs = null; playSubs.forEach(fn => fn(false)); return; }
    raf = requestAnimationFrame(frame);
  }
  return {
    seek(tt) { t = clampT(tt); paint(t); },
    preview(tt) { paint(clampT(tt)); },
    clearPreview() { paint(t); },
    play() { if (playing) return; if (t >= end - 1e-6) t = 0; playing = true; lastTs = null; raf = requestAnimationFrame(frame); playSubs.forEach(fn => fn(true)); },
    pause() { if (!playing) return; playing = false; if (raf) cancelAnimationFrame(raf); raf = null; playSubs.forEach(fn => fn(false)); },
    toggle() { this.playing ? this.pause() : this.play(); },
    setSpeed(x) { speed = x; },
    stop() { this.pause(); },
    resetViews() { views.length = 0; },
    addView(v) { views.push(v); v.update(sample(t)); },
    onPlayState(fn) { playSubs.push(fn); },
    setRoot(el) { rootEl = el; },
    get t() { return t; }, get playing() { return playing; }, get speed() { return speed; }, get end() { return end; },
  };
}

/* Nose profile y(x) from the tip, RASAero shape names. */
export function noseProfile(shape, L, R, n = 28) {
  const s = String(shape || '').toLowerCase();
  const pts = [];
  for (let i = 0; i <= n; i++) {
    const t = i / n, x = L * t;   // t from i: x / L can exceed 1 by float error
    let y;
    if (s.includes('conic')) y = R * t;
    else if (s.includes('ellip')) y = R * Math.sqrt(Math.max(0, 1 - (1 - t) * (1 - t)));
    else if (s.includes('parab')) y = R * (2 * t - t * t);
    else if (s.includes('power')) y = R * Math.sqrt(t);
    else if (s.includes('haack') || s.includes('karman')) { const C = s.includes('lv') ? 1 / 3 : 0; const th = Math.acos(1 - 2 * t); y = R / Math.sqrt(Math.PI) * Math.sqrt(Math.max(0, th - Math.sin(2 * th) / 2 + C * Math.pow(Math.sin(th), 3))); }
    else { const rho = (R * R + L * L) / (2 * R); y = Math.sqrt(Math.max(0, rho * rho - (L - x) * (L - x))) + R - rho; }
    pts.push([x, y]);
  }
  return pts;
}

/* Staging events for a design: [liftoff, burnout, separation, ignition, sustainer burnout, apogee]. */
export function stagingTimes(r, dz) {
  const tb = dz.booster ? dz.booster.burn_time_s : null, ts = dz.sustainer ? dz.sustainer.burn_time_s : null;
  const t0 = 0, t1 = isNum(tb) ? tb : null;
  const t2 = isNum(t1) && isNum(r.sep_delay_s) ? t1 + r.sep_delay_s : null;
  const t3 = isNum(t2) && isNum(r.ign_delay_s) ? t2 + r.ign_delay_s : null;
  const t4 = isNum(t3) && isNum(ts) ? t3 + ts : null;
  const t5 = isNum(r.t_apogee_s) ? r.t_apogee_s : null;
  return [t0, t1, t2, t3, t4, t5];
}

/* Vehicle drawing. Long specs (motor N·s, timing sentences) live in the
   HTML panels around it, not as SVG text - a short tag + hover title is
   all the diagram itself carries, so nothing here can overlap. */

export function rocketDiagram(r, dz, T) {
  const geo = dz.vehicle, b = dz.booster, s = dz.sustainer;
  if (!geo || !geo.parts || !geo.parts.length) return { el: callout('info', 'no vehicle geometry — the CDX1 file could not be read' + (geo && geo.error ? ` (${geo.error})` : '')), view: { update() {} } };
  const wrap = h('div', { class: 'rocket-svg' });
  const status = h('div', { class: 'muted small fc-status' });
  const what = { boost: `${r.booster} burning, stack attached`, sep_delay: 'coasting attached, about to separate', ign_delay: 'separated, sustainer coasting before ignition', sustain: `${s ? s.label : 'sustainer'} burning`, coast: `coasting to apogee${isNum(r.apogee_ft) ? ' at ' + fmt(r.apogee_ft, 0) + ' ft' : ''}` };
  // drawn 1:1 in CSS px: the vehicle takes the panel width, the fixed
  // allowances (margins, separation gap, flame) and the text do not scale
  const build = W => {
    const ML = 20, GAP = 60, FLAME = 66;
    const ppi = (W - ML - GAP - FLAME - 20) / geo.total_length_in;
    const X = v => ML + v * ppi;
    const uid = 'rk' + Math.random().toString(36).slice(2, 7);
    const sus = geo.parts.filter(p => p.type !== 'Booster'), boo = geo.parts.filter(p => p.type === 'Booster');
    const susAft = sus.length ? Math.max(...sus.map(p => p.location_in + p.length_in)) : 0;
    const booAft = boo.length ? Math.max(...boo.map(p => p.location_in + p.length_in)) : susAft;
    const susAftTube = sus.filter(p => p.type !== 'NoseCone').sort((p, q) => (q.location_in + q.length_in) - (p.location_in + p.length_in))[0] || sus[sus.length - 1];
    const rad = p => p.diameter_in / 2 * ppi;
    const maxSpan = Math.max(0, ...geo.parts.map(p => p.fins ? p.fins.span_in : 0)) * ppi;
    const rMax = geo.max_diameter_in / 2 * ppi;
    // just tall enough for the fins plus a tag line above and below
    const H = Math.ceil(2 * (rMax + maxSpan) + 60), cy = H / 2;
    let defs = `<defs><linearGradient id="${uid}-flame" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stop-color="#fef08a"/><stop offset=".45" stop-color="#f97316"/><stop offset="1" stop-color="#f97316" stop-opacity="0"/></linearGradient></defs>`;
    const finPoly = (p, side) => {
      const f = p.fins; if (!f) return '';
      const aft = X(p.location_in + p.length_in), rr = rad(p);
      const le = aft - f.location_in * ppi, te = le + f.root_chord_in * ppi, tle = le + f.sweep_in * ppi, tte = tle + f.tip_chord_in * ppi;
      const y0 = cy + side * rr, y1 = cy + side * (rr + f.span_in * ppi);
      return `<polygon class="fin" points="${le.toFixed(1)},${y0.toFixed(1)} ${tle.toFixed(1)},${y1.toFixed(1)} ${tte.toFixed(1)},${y1.toFixed(1)} ${te.toFixed(1)},${y0.toFixed(1)}"/>`;
    };
    const partShape = p => {
      const x0 = X(p.location_in), x1 = X(p.location_in + p.length_in), rr = rad(p);
      if (p.type === 'NoseCone') {
        const pts = noseProfile(p.shape, x1 - x0, rr);
        const top = pts.map(([x, y]) => `${(x0 + x).toFixed(1)},${(cy - y).toFixed(1)}`).join(' ');
        const bot = pts.slice().reverse().map(([x, y]) => `${(x0 + x).toFixed(1)},${(cy + y).toFixed(1)}`).join(' ');
        return `<polygon class="body nose" points="${top} ${bot}"/>`;
      }
      if (p.type === 'Transition') {
        const r0 = (p.front_diameter_in || p.diameter_in) / 2 * ppi, r1 = (p.rear_diameter_in || p.diameter_in) / 2 * ppi;
        return `<polygon class="body" points="${x0},${cy - r0} ${x1},${cy - r1} ${x1},${cy + r1} ${x0},${cy + r0}"/>`;
      }
      let out = finPoly(p, -1) + finPoly(p, 1);
      const bt = p.boattail_length_in || 0;
      out += `<rect class="body ${p.type === 'Booster' ? 'booster' : 'sustainer'}" x="${x0.toFixed(1)}" y="${(cy - rr).toFixed(1)}" width="${(x1 - x0 - bt * ppi).toFixed(1)}" height="${(2 * rr).toFixed(1)}"/>`;
      if (bt > 0) { const rb = (p.boattail_rear_diameter_in || p.diameter_in) / 2 * ppi, xb = x1 - bt * ppi; out += `<polygon class="body" points="${xb},${cy - rr} ${x1},${cy - rb} ${x1},${cy + rb} ${xb},${cy + rr}"/>`; }
      return out;
    };
    const motorShape = (m, aftIn, host, cls) => {
      if (!m) return '';
      const len = Math.min(m.length_mm * IN_PER_MM, host ? host.length_in * 0.96 : 1e9) * ppi, hr = Math.min(m.diameter_mm * IN_PER_MM / 2 * ppi, (host ? rad(host) : rMax) * 0.92);
      const x1 = X(aftIn), x0 = x1 - len;
      const ex = (m.nozzle_exit_in || m.diameter_mm * IN_PER_MM * 0.8) / 2 * ppi, th = (m.nozzle_throat_in || m.nozzle_exit_in * 0.45 || 1) / 2 * ppi, nl = Math.min(2.6 * ppi, len * 0.25);
      return `<g class="motor ${cls}"><rect x="${x0.toFixed(1)}" y="${(cy - hr).toFixed(1)}" width="${len.toFixed(1)}" height="${(2 * hr).toFixed(1)}" rx="2"/>` +
        `<path class="grain" d="M${(x0 + 4).toFixed(1)},${cy}H${(x1 - 4).toFixed(1)}"/>` +
        `<polygon class="nozzle" points="${x1.toFixed(1)},${(cy - th).toFixed(1)} ${(x1 + nl).toFixed(1)},${(cy - ex).toFixed(1)} ${(x1 + nl).toFixed(1)},${(cy + ex).toFixed(1)} ${x1.toFixed(1)},${(cy + th).toFixed(1)}"/></g>`;
    };
    const flame = (m, aftIn, cls) => {
      if (!m) return '';
      const nl = Math.min(2.6 * ppi, m.length_mm * IN_PER_MM * ppi * 0.25), x = X(aftIn) + nl, ex = (m.nozzle_exit_in || m.diameter_mm * IN_PER_MM * 0.8) / 2 * ppi;
      return `<path class="flame ${cls}" fill="url(#${uid}-flame)" d="M${x},${cy - ex} Q${x + FLAME * .55},${cy - ex * 1.6} ${x + FLAME},${cy} Q${x + FLAME * .55},${cy + ex * 1.6} ${x},${cy + ex}Z"/>`;
    };
    const susMotorHost = susAftTube;
    const booHost = boo.sort((p, q) => (q.location_in + q.length_in) - (p.location_in + p.length_in))[0];
    const booG = boo.length ? `<g class="booster-g">${boo.map(partShape).join('')}${motorShape(b, booAft, booHost, 'booster')}${flame(b, booAft, 'booster')}</g>` : '';
    const susG = `<g class="sustainer-g">${sus.map(partShape).join('')}${motorShape(s, susAft, susMotorHost, 'sustainer')}${flame(s, susAft, 'sustainer')}</g>`;
    const susMx = s ? X(susAft) - Math.min(s.length_mm * IN_PER_MM, susMotorHost ? susMotorHost.length_in * .96 : 1e9) * ppi / 2 : X(susAft / 2);
    const booMx = b && boo.length ? X(booAft) - Math.min(b.length_mm * IN_PER_MM, booHost.length_in * .96) * ppi / 2 : X((susAft + booAft) / 2);
    const topY = cy - rMax - maxSpan, botY = cy + rMax + maxSpan;
    const tag = (x, y, cls, text) => `<text class="tag ${cls}" x="${x.toFixed(1)}" y="${y.toFixed(1)}" text-anchor="middle">${esc(text)}</text>`;
    const anno = `<g class="anno">` +
      tag(susMx, 14, 'sustainer', s ? s.label : 'sustainer ?') +
      (boo.length ? tag(booMx, H - 6, 'booster', b ? b.label : 'booster ?') : '') +
      `<line class="sepline" x1="${X(susAft).toFixed(1)}" y1="${(topY - 6).toFixed(1)}" x2="${X(susAft).toFixed(1)}" y2="${(botY + 6).toFixed(1)}"><title>separation plane</title></line>` +
      `<g class="sepgap"><line x1="${(X(susAft) + 4).toFixed(1)}" y1="${(cy + rMax + 8).toFixed(1)}" x2="${(X(susAft) + GAP - 4).toFixed(1)}" y2="${(cy + rMax + 8).toFixed(1)}"/></g>` +
      `</g>`;
    return h('div', { html: `<svg viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" style="--sep-gap:${GAP}px">${defs}${booG}${susG}${anno}</svg>` });
  };
  wrap.append(responsive(build, 360));
  const el = h('div', { class: 'fc-diagram' }, wrap, status);
  return {
    el,
    view: {
      update(snap) {
        const id = PHASE_DEFS[snap.phase].id;
        wrap.dataset.phase = id;
        status.textContent = `${PHASE_DEFS[snap.phase].name} · ${what[id]} · t = ${fmt(snap.t, snap.t < 60 ? 2 : 1)} s`;
      },
    },
  };
}

/* Mach 0/subsonic-max/supersonic-min color zone, matching the ref lines
   already used on the verified time-history chart. */

export function machZone(mach, cfg) {
  if (!isNum(mach)) return '';
  if (mach >= cfg.profiles.supersonic_min_mach) return 'err';
  if (mach <= cfg.profiles.subsonic_max_mach) return 'ok';
  return 'warn';
}

export function machGauge(cfg, maxMach) {
  const sub = cfg.profiles.subsonic_max_mach, sup = cfg.profiles.supersonic_min_mach;
  const gmax = Math.max(sup * 1.5, (maxMach || 0) * 1.1, 1.6);
  const W = 100, H = 8;
  const x = m => Math.max(0, Math.min(W, m / gmax * W));
  const svg = `<svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none">` +
    `<rect class="mg-sub" x="0" y="0" width="${x(sub).toFixed(1)}" height="${H}"/>` +
    `<rect class="mg-trans" x="${x(sub).toFixed(1)}" y="0" width="${(x(sup) - x(sub)).toFixed(1)}" height="${H}"/>` +
    `<rect class="mg-sup" x="${x(sup).toFixed(1)}" y="0" width="${(W - x(sup)).toFixed(1)}" height="${H}"/>` +
    `<rect id="mk" class="mg-mark" x="0" y="0" width="2" height="${H}"/></svg>`;
  const el = h('div', { class: 'mach-gauge', html: svg });
  const mk = el.querySelector('#mk');
  return { el, set: m => mk.setAttribute('x', isNum(m) ? Math.max(0, x(m) - 1).toFixed(1) : 0) };
}

export function hudTile(label) {
  const v = h('div', { class: 'hud-v' }, '—');
  const el = h('div', { class: 'hud-tile' }, h('div', { class: 'hud-l' }, label), v);
  return { el, set(text, zone) { v.textContent = text; el.className = 'hud-tile' + (zone ? ' ' + zone : ''); } };
}

/* Rocket climbing a vertical altitude track, with live alt/Mach/velocity
   readouts beside it. Drawn 1:1 in CSS px and re-laid out on resize so it
   fills whatever height the row has. The booster's post-separation fall is
   illustrative only - no trajectory is simulated for it. */

export function ascentTrack(r, cfg, d, T) {
  const target = d.target_ft, tol = d.tolerance_ft;
  const top = Math.max(r.apogee_ft || 0, target || 0, r.alt_at_ign_ft || 0, 1000) * 1.1;
  const tickLbl = v => Math.abs(v) >= 1000 ? (v / 1000).toFixed(v % 1000 ? 1 : 0) + 'k' : fmt(v, 0);
  const svgWrap = h('div', { class: 'ascent-svg' });
  const rocketIcon = `<g id="rk-g">` +
    `<path class="rk-fin" d="M-4.2,-7 L-10,4.5 L-10,6 L-4.2,2.5 Z M4.2,-7 L10,4.5 L10,6 L4.2,2.5 Z"/>` +
    `<path class="rk-body" d="M0,-28 C3.2,-24 4.2,-19 4.2,-12 L4.2,3 L-4.2,3 L-4.2,-12 C-4.2,-19 -3.2,-24 0,-28 Z"/>` +
    `<path class="rk-nose" d="M0,-28 C2.3,-25 3.5,-22 3.9,-18 L-3.9,-18 C-3.5,-22 -2.3,-25 0,-28 Z"/>` +
    `<circle class="rk-win" cx="0" cy="-10.5" r="2.1"/>` +
    `<path class="rk-noz" d="M-2.6,3 L-3.6,6.5 L3.6,6.5 L2.6,3 Z"/>` +
    `<path id="rkflame" class="rk-flame" fill="url(#rk-flame-grad)" d="M-3.4,6.5 C-4.6,12 -2.4,17 0,23 C2.4,17 4.6,12 3.4,6.5 Z"/>` +
    `</g>`;
  const boosterIcon = `<g id="bk-g" opacity="0"><rect class="rk-booster" x="-3.6" y="-7" width="7.2" height="14" rx="1.6"/>` +
    `<path class="rk-booster-fin" d="M-3.6,0 L-8,7 L-3.6,5 Z M3.6,0 L8,7 L3.6,5 Z"/></g>`;
  let W = 150, H = 240, gx = 34, gTop = 22, gBot = H - 12, cx = 90, y = () => gBot;
  let rkG, bkG, flameEl, last = null, sepY = null;
  const layout = () => {
    W = Math.max(90, svgWrap.clientWidth || W); H = Math.max(150, svgWrap.clientHeight || H);
    gBot = H - 12; cx = gx + (W - 8 - gx) / 2;
    y = alt => gBot - Math.max(0, Math.min(1, (alt || 0) / top)) * (gBot - gTop);
    const right = W - 8;
    const axis = niceTicks(0, top, H > 300 ? 6 : 4).map(v => `<line class="grid" x1="${gx}" x2="${right}" y1="${y(v).toFixed(1)}" y2="${y(v).toFixed(1)}"/><text class="axis-lbl" x="${gx - 5}" y="${(y(v) + 3.5).toFixed(1)}" text-anchor="end">${tickLbl(v)}</text>`).join('');
    const tolSvg = (isNum(target) && isNum(tol)) ? `<rect class="tol-band" x="${gx}" y="${y(target + tol).toFixed(1)}" width="${(right - gx).toFixed(1)}" height="${Math.max(0, y(target - tol) - y(target + tol)).toFixed(1)}"/>` : '';
    const targetSvg = isNum(target) ? `<line class="target-line" x1="${gx}" x2="${right}" y1="${y(target).toFixed(1)}" y2="${y(target).toFixed(1)}"><title>target ${fmt(target, 0)} ft</title></line><text class="target-lbl" x="${right - 8}" y="${(y(target) - 3).toFixed(1)}" text-anchor="end">target</text>` : '';
    const dot = (alt, cls, label) => isNum(alt) ? `<circle class="ev-dot ${cls}" cx="${right}" cy="${y(alt).toFixed(1)}" r="3"><title>${esc(label)} ${fmt(alt, 0)} ft</title></circle>` : '';
    svgWrap.innerHTML = `<svg width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">` +
      `<defs><linearGradient id="rk-flame-grad" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#fef08a"/><stop offset=".45" stop-color="#f97316"/><stop offset="1" stop-color="#ef4444" stop-opacity="0"/></linearGradient></defs>` +
      `<g class="axis">${axis}</g>${tolSvg}${targetSvg}` +
      `<line class="ground" x1="${gx}" x2="${right}" y1="${y(0).toFixed(1)}" y2="${y(0).toFixed(1)}"/>` +
      dot(r.apogee_ft, 'apogee', 'apogee') + dot(r.alt_at_ign_ft, 'ign', 'ignition') +
      boosterIcon + rocketIcon + `</svg>`;
    rkG = svgWrap.querySelector('#rk-g'); bkG = svgWrap.querySelector('#bk-g'); flameEl = svgWrap.querySelector('#rkflame');
    if (last) paint(last);
  };
  const paint = snap => {
    const yy = isNum(snap.alt) ? y(snap.alt) : y(0);
    rkG.setAttribute('transform', `translate(${cx.toFixed(1)},${yy.toFixed(1)})`);
    flameEl.classList.toggle('on', !!snap.firing);
    if (isNum(T[2]) && snap.t >= T[2]) {
      if (sepY === null) sepY = isNum(snap.alt) ? snap.alt : 0;
      const dt = snap.t - T[2];
      const by = Math.min(gBot - 6, y(sepY) + 30 * dt * dt);
      bkG.setAttribute('transform', `translate(${cx.toFixed(1)},${by.toFixed(1)}) rotate(${(dt * 25).toFixed(1)})`);
      bkG.setAttribute('opacity', Math.max(0, 1 - dt / 6));
    } else {
      bkG.setAttribute('opacity', 0);
      sepY = null;
    }
  };
  layout();
  if (window.ResizeObserver) new ResizeObserver(() => layout()).observe(svgWrap);
  const altTile = hudTile('altitude'), velTile = hudTile('velocity'), timeTile = hudTile('t');
  const machV = h('div', { class: 'hud-v' }, '—');
  const gauge = machGauge(cfg, r.max_mach);
  const machBox = h('div', { class: 'hud-tile' }, h('div', { class: 'hud-l' }, 'Mach'), machV, gauge.el);
  const hud = h('div', { class: 'hud' }, altTile.el, machBox, velTile.el, timeTile.el);
  const el = h('div', { class: 'ascent-panel' }, svgWrap, hud);
  return {
    el,
    view: {
      update(snap) {
        last = snap;
        paint(snap);
        altTile.set(isNum(snap.alt) ? fmt(snap.alt, 0) + ' ft' : '—');
        machV.textContent = isNum(snap.mach) ? fmt(snap.mach, 2) : '—';
        machBox.className = 'hud-tile' + (isNum(snap.mach) ? ' ' + machZone(snap.mach, cfg) : '');
        gauge.set(snap.mach);
        velTile.set(isNum(snap.vel) ? fmt(snap.vel, 0) + ' fps' : '—');
        timeTile.set(fmt(snap.t, snap.t < 60 ? 1 : 0) + ' s');
      },
    },
  };
}

/* Timeline to scale: a progress fill for each phase, a zoomed "lens" for
   the (often sub-second) separation/ignition delays, and a thrust lane
   from the motors' own curves so booster and sustainer burns line up with
   the flight clock. Both strips are drawn 1:1 in CSS px. */

export function stagingTimeline(r, dz, player, T) {
  const end = player.end;
  const x0 = 20, MR = 20;
  const barY = 24, barH = 24, tickY = barY + barH + 4, labelY = 62;
  const lensLo = T[1], lensHi = T[3];
  const showLens = isNum(lensLo) && isNum(lensHi) && lensHi > lensLo && (lensHi - lensLo) < 0.12 * end;
  const padded = showLens ? [lensLo - (lensHi - lensLo) * 0.6, lensHi + (lensHi - lensLo) * 0.6] : null;
  const lensY = 84, lensH = 22;
  const H = showLens ? lensY + lensH + 40 : 76;
  const laneH = 56;
  const peak = Math.max((dz.booster && dz.booster.peak_thrust_n) || 0, (dz.sustainer && dz.sustainer.peak_thrust_n) || 0) || 1;
  const scaleFor = W => { const x1 = W - MR; return { W, x1, xAt: t => x0 + Math.max(0, Math.min(1, t / end)) * (x1 - x0), lensX: t => x0 + Math.max(0, Math.min(1, (t - padded[0]) / (padded[1] - padded[0]))) * (x1 - x0) }; };
  const tl = {}, lane = {};   // geometry + live elements of the current drawings
  let lastSnap = null, dragging = false;
  window.addEventListener('mouseup', () => { dragging = false; });

  const chips = h('div', { class: 'phase-chips' }, PHASE_DEFS.map((p, i) => {
    const dur = isNum(T[i]) && isNum(T[i + 1]) ? T[i + 1] - T[i] : null;
    const chip = h('button', { class: 'phase-chip ' + p.id, disabled: !isNum(T[i]) }, h('span', { class: 'dot' }), h('span', null, p.name), h('span', { class: 'muted' }, isNum(dur) ? fmt(dur, dur < 10 ? 2 : 1) + ' s' : '?'));
    chip.onclick = () => isNum(T[i]) && player.seek(T[i]);
    return chip;
  }));

  // scrubbing: hover previews, click/drag seeks, leaving reverts to the
  // committed position
  const wireScrub = (svgEl, geo) => {
    const timeAt = ev => { const rect = svgEl.getBoundingClientRect(); const px = (ev.clientX - rect.left) / rect.width * geo.W; return Math.max(0, Math.min(end, (px - x0) / (geo.x1 - x0) * end)); };
    svgEl.addEventListener('mousedown', ev => { dragging = true; player.seek(timeAt(ev)); });
    svgEl.addEventListener('mousemove', ev => { if (dragging) player.seek(timeAt(ev)); else player.preview(timeAt(ev)); });
    svgEl.addEventListener('mouseleave', () => { dragging = false; player.clearPreview(); });
  };

  const applySnap = snap => {
    if (tl.playhead) {
      const px = tl.xAt(snap.t);
      tl.playhead.setAttribute('x1', px); tl.playhead.setAttribute('x2', px);
      for (let i = 0; i < PHASE_DEFS.length; i++) {
        if (!tl.fills[i] || !isNum(tl.segX[i]) || !isNum(tl.segX[i + 1])) continue;
        tl.fills[i].setAttribute('width', Math.max(0, Math.min(tl.segX[i + 1], px) - tl.segX[i]));
      }
      if (showLens) {
        const lx = tl.lensX(snap.t);
        tl.lensPlayhead.setAttribute('x1', lx); tl.lensPlayhead.setAttribute('x2', lx);
        for (const i of [1, 2]) {
          if (!isNum(T[i]) || !isNum(T[i + 1])) continue;
          const xa = tl.lensX(T[i]), xb = tl.lensX(T[i + 1]);
          tl.lensFills[i].setAttribute('width', Math.max(0, Math.min(xb, lx) - xa));
        }
      }
    }
    chips.children[snap.phase] && [...chips.children].forEach((c, i) => c.classList.toggle('active', i === snap.phase));
    if (lane.reveal) {
      const px = lane.xAt(snap.t);
      lane.laneHead.setAttribute('x1', px); lane.laneHead.setAttribute('x2', px);
      lane.reveal.setAttribute('width', Math.max(0, px));
    }
  };

  const buildTimeline = W => {
    const geo = scaleFor(W), { x1, xAt, lensX } = geo;
    const segX = PHASE_DEFS.map((p, i) => isNum(T[i]) ? xAt(T[i]) : null);
    let segSvg = '';
    for (let i = 0; i < PHASE_DEFS.length; i++) {
      const xa = segX[i], xb = segX[i + 1];
      if (!isNum(xa) || !isNum(xb)) continue;
      const durTxt = isNum(T[i]) && isNum(T[i + 1]) ? `${fmt(T[i + 1] - T[i], (T[i + 1] - T[i]) < 10 ? 2 : 1)} s` : '?';
      segSvg += `<rect class="seg-base ${PHASE_DEFS[i].id}" x="${xa.toFixed(1)}" y="${barY}" width="${(xb - xa).toFixed(1)}" height="${barH}" rx="3"><title>${esc(PHASE_DEFS[i].name)}: ${durTxt} (${fmt(T[i], 2)} s → ${fmt(T[i + 1], 2)} s)</title></rect>`;
      segSvg += `<rect class="seg-fill ${PHASE_DEFS[i].id}" id="fill-${i}" x="${xa.toFixed(1)}" y="${barY}" width="0" height="${barH}" rx="3"/>`;
      if (!showLens && (i === 1 || i === 2) && (xb - xa) > 40) segSvg += `<text class="seg-label" x="${((xa + xb) / 2).toFixed(1)}" y="${(barY + barH / 2 + 4).toFixed(1)}" text-anchor="middle">${i === 1 ? 'sep' : 'ign'}</text>`;
    }
    const evSvg = `<g class="ev-mark"><line x1="${x0}" x2="${x0}" y1="${barY - 8}" y2="${barY}"/><text x="${x0}" y="${barY - 11}" text-anchor="start">liftoff</text></g>` +
      (isNum(T[5]) ? `<g class="ev-mark"><line x1="${xAt(T[5]).toFixed(1)}" x2="${xAt(T[5]).toFixed(1)}" y1="${barY - 8}" y2="${barY}"/><text x="${xAt(T[5]).toFixed(1)}" y="${barY - 11}" text-anchor="end">apogee</text></g>` : '');
    const axisSvg = niceTicks(0, end, W > 700 ? 8 : 5).map(v => `<line class="tick" x1="${xAt(v).toFixed(1)}" x2="${xAt(v).toFixed(1)}" y1="${barY + barH}" y2="${tickY}"/><text x="${xAt(v).toFixed(1)}" y="${labelY}" text-anchor="middle">${fmt(v, 0)}s</text>`).join('');
    let lensSvg = '', guides = '';
    if (showLens) {
      guides = `<line class="lens-guide" x1="${xAt(padded[0]).toFixed(1)}" y1="${barY + barH}" x2="${x0}" y2="${lensY}"/><line class="lens-guide" x1="${xAt(padded[1]).toFixed(1)}" y1="${barY + barH}" x2="${x1}" y2="${lensY}"/>`;
      lensSvg += `<rect class="lens-bg" x="${x0}" y="${lensY}" width="${(x1 - x0).toFixed(1)}" height="${lensH}" rx="3"/>`;
      for (const i of [1, 2]) {
        const xa = lensX(T[i]), xb = lensX(T[i + 1]);
        lensSvg += `<rect class="seg-base ${PHASE_DEFS[i].id}" x="${xa.toFixed(1)}" y="${lensY}" width="${(xb - xa).toFixed(1)}" height="${lensH}" rx="2"/>`;
        lensSvg += `<rect class="seg-fill ${PHASE_DEFS[i].id}" id="lensfill-${i}" x="${xa.toFixed(1)}" y="${lensY}" width="0" height="${lensH}" rx="2"/>`;
      }
      let lastX = -Infinity, row = 0;
      for (const [tt, label] of [[T[1], 'burnout'], [T[2], 'separation'], [T[3], 'ignition']]) {
        const xx = lensX(tt);
        row = (xx - lastX < 104) ? row + 1 : 0;
        lastX = xx;
        const ly = lensY + lensH + 16 + row * 13;
        lensSvg += `<line class="ev-tick" x1="${xx.toFixed(1)}" x2="${xx.toFixed(1)}" y1="${lensY - 4}" y2="${(lensY + lensH + 4).toFixed(1)}"/><text class="ev-label" x="${xx.toFixed(1)}" y="${ly.toFixed(1)}" text-anchor="middle">${label} ${fmt(tt, 2)}s</text>`;
      }
      lensSvg += `<line id="lensplayhead" class="playhead" x1="0" x2="0" y1="${lensY - 6}" y2="${lensY + lensH + 6}"/>`;
    }
    const playheadBottom = showLens ? lensY : barY + barH;
    const svg = `<svg viewBox="0 0 ${W} ${H}" width="${W}" height="${H}">${evSvg}${segSvg}${axisSvg}${guides}${lensSvg}<line id="playhead" class="playhead" x1="0" x2="0" y1="${barY - 10}" y2="${playheadBottom}"/></svg>`;
    const wrap = h('div', { html: svg });
    Object.assign(tl, geo, { segX, svgEl: wrap.querySelector('svg'), playhead: wrap.querySelector('#playhead'), lensPlayhead: wrap.querySelector('#lensplayhead'), fills: PHASE_DEFS.map((p, i) => wrap.querySelector('#fill-' + i)), lensFills: { 1: wrap.querySelector('#lensfill-1'), 2: wrap.querySelector('#lensfill-2') } });
    wireScrub(tl.svgEl, tl);
    if (lastSnap) applySnap(lastSnap);
    return wrap;
  };

  // thrust lane: the motors' own curves, positioned at their real burn
  // times and filled up to the playhead - no separate flight-history
  // dependency, so it works even before verify has run.
  const buildLane = W => {
    const geo = scaleFor(W), { xAt } = geo;
    const areaPath = (curve, t0) => {
      if (!curve || !curve.t.length) return '';
      let d = `M${xAt(t0).toFixed(1)},${laneH.toFixed(1)}`;
      for (let i = 0; i < curve.t.length; i++) d += `L${xAt(t0 + curve.t[i]).toFixed(1)},${(laneH - curve.f[i] / peak * laneH).toFixed(1)}`;
      return d + `L${xAt(t0 + curve.t[curve.t.length - 1]).toFixed(1)},${laneH.toFixed(1)}Z`;
    };
    const bPath = dz.booster ? areaPath(dz.booster.curve, 0) : '';
    const sPath = (dz.sustainer && isNum(T[3])) ? areaPath(dz.sustainer.curve, T[3]) : '';
    const laneUid = 'lane' + Math.random().toString(36).slice(2, 7);
    const svg = `<svg viewBox="0 0 ${W} ${laneH}" width="${W}" height="${laneH}">` +
      `<clipPath id="${laneUid}"><rect id="reveal" x="0" y="0" width="0" height="${laneH}"/></clipPath>` +
      (bPath ? `<path class="lane-area dim booster" d="${bPath}"/>` : '') + (sPath ? `<path class="lane-area dim sustainer" d="${sPath}"/>` : '') +
      `<g clip-path="url(#${laneUid})">${bPath ? `<path class="lane-area bright booster" d="${bPath}"/>` : ''}${sPath ? `<path class="lane-area bright sustainer" d="${sPath}"/>` : ''}</g>` +
      `<line id="lanehead" class="playhead" x1="0" x2="0" y1="0" y2="${laneH}"/></svg>`;
    const wrap = h('div', { html: svg });
    Object.assign(lane, geo, { svgEl: wrap.querySelector('svg'), reveal: wrap.querySelector('#reveal'), laneHead: wrap.querySelector('#lanehead') });
    wireScrub(lane.svgEl, lane);
    if (lastSnap) applySnap(lastSnap);
    return wrap;
  };

  const el = h('div', null, h('div', { class: 'timeline-svg' }, responsive(buildTimeline, 320)), chips, h('div', { class: 'thrust-lane' }, responsive(buildLane, 320)));
  return { el, view: { update(snap) { lastSnap = snap; applySnap(snap); } } };
}

/* Thrust curve with real axes, an average-thrust reference, a peak
   label that flips side near the right edge, and a live cursor while
   the flight player is inside this motor's burn window. */

export function thrustChart(m, color, kind, T) {
  const c = m.curve;
  const H = 170, ml = 56, mr = 14, mt = 16, mb = 26, ih = H - mt - mb;
  const tmax = c.t[c.t.length - 1] || 1, fmax = (Math.max(...c.f) || 1) * 1.12;
  const findIdx = tv => { let lo = 0, hi = c.t.length - 1; while (lo < hi) { const mid = (lo + hi) >> 1; if (c.t[mid] < tv) lo = mid + 1; else hi = mid; } return lo; };
  const peakIdx = c.f.indexOf(Math.max(...c.f));
  const textW = t => t.length * 6.2 + 4;
  const peakTxt = `peak ${fmt(c.f[peakIdx], 0)} N`, avgTxt = `avg ${fmt(m.avg_thrust_n, 0)} N`;
  const cur = {};   // geometry + live elements of the current drawing
  let lastSnap = null;
  const applySnap = snap => {
    const burnEndAbs = kind === 'booster' ? T[1] : T[4];
    const burnStartAbs = kind === 'booster' ? 0 : T[3];
    const active = isNum(burnStartAbs) && isNum(burnEndAbs) && snap.t >= burnStartAbs && snap.t <= burnEndAbs;
    el.classList.toggle('burning', active);
    if (active) {
      const localT = Math.min(snap.t - burnStartAbs, tmax);
      cur.cfr.setAttribute('width', Math.max(0, cur.sx(localT) - ml));
      cur.cursor.setAttribute('opacity', 1);
      cur.cursor.setAttribute('cx', cur.sx(localT));
      cur.cursor.setAttribute('cy', cur.sy(c.f[findIdx(localT)]));
    } else {
      cur.cfr.setAttribute('width', isNum(burnEndAbs) && snap.t > burnEndAbs ? cur.iw : 0);
      cur.cursor.setAttribute('opacity', 0);
    }
  };
  const build = W => {
    const iw = W - ml - mr;
    const sx = t => ml + t / tmax * iw, sy = f => mt + ih - f / fmax * ih;
    let path = `M${sx(0).toFixed(1)},${sy(0).toFixed(1)}`;
    for (let i = 0; i < c.t.length; i++) path += `L${sx(c.t[i]).toFixed(1)},${sy(c.f[i]).toFixed(1)}`;
    const area = path + `L${sx(tmax).toFixed(1)},${sy(0).toFixed(1)}Z`;
    const avgY = sy(m.avg_thrust_n);
    const peakX = sx(c.t[peakIdx]), peakY = sy(c.f[peakIdx]), peakFlip = peakX > ml + iw * 0.7;
    let svg = `<svg viewBox="0 0 ${W} ${H}" width="${W}" height="${H}">`;
    svg += '<g class="grid">' + niceTicks(0, fmax, 5).map(v => `<line x1="${ml}" x2="${W - mr}" y1="${sy(v).toFixed(1)}" y2="${sy(v).toFixed(1)}"/>`).join('') + '</g>';
    svg += '<g class="axis">' + niceTicks(0, fmax, 5).map(v => `<text x="${ml - 6}" y="${(sy(v) + 3.5).toFixed(1)}" text-anchor="end">${fmt(v, 0)}</text>`).join('') +
      niceTicks(0, tmax, W > 420 ? 6 : 4).map(v => `<line x1="${sx(v).toFixed(1)}" x2="${sx(v).toFixed(1)}" y1="${mt + ih}" y2="${mt + ih + 4}"/><text x="${sx(v).toFixed(1)}" y="${mt + ih + 16}" text-anchor="middle">${fmt(v, v < 10 ? 1 : 0)}s</text>`).join('') +
      `<text transform="translate(11,${mt + ih / 2}) rotate(-90)" text-anchor="middle">thrust [N]</text></g>`;
    svg += `<path class="area" d="${area}" fill="${color}"/>`;
    svg += `<line class="avg-line" x1="${ml}" x2="${W - mr}" y1="${avgY.toFixed(1)}" y2="${avgY.toFixed(1)}"/>`;
    svg += `<path class="line" d="${path}" stroke="${color}"/>`;
    svg += `<circle class="peak-dot" cx="${peakX.toFixed(1)}" cy="${peakY.toFixed(1)}" r="3" fill="${color}"/>`;
    // peak label first; the avg label moves to the left end (or under its
    // line) when a flat curve would put the two on top of each other
    const peakBox = { x: peakFlip ? peakX - 6 - textW(peakTxt) : peakX + 6, y: peakY - 16, w: textW(peakTxt), h: 13 };
    const overlaps = b => b.x < peakBox.x + peakBox.w && b.x + b.w > peakBox.x && b.y < peakBox.y + peakBox.h && b.y + b.h > peakBox.y;
    const avgW = textW(avgTxt);
    let avgX = W - mr - 3, avgAnchor = 'end', avgYl = avgY - 4;
    if (overlaps({ x: avgX - avgW, y: avgYl - 10, w: avgW, h: 13 })) { avgX = ml + 4; avgAnchor = 'start'; }
    if (overlaps({ x: avgX, y: avgYl - 10, w: avgW, h: 13 })) avgYl = avgY + 12;
    svg += `<text class="peak-label" x="${(peakX + (peakFlip ? -6 : 6)).toFixed(1)}" y="${(peakY - 6).toFixed(1)}" text-anchor="${peakFlip ? 'end' : 'start'}">${peakTxt}</text>`;
    svg += `<text class="avg-label" x="${avgX.toFixed(1)}" y="${avgYl.toFixed(1)}" text-anchor="${avgAnchor}">${avgTxt}</text>`;
    svg += `<clipPath id="cf-${kind}"><rect id="cfr" x="${ml}" y="0" width="0" height="${H}"/></clipPath>`;
    svg += `<path class="line bright" clip-path="url(#cf-${kind})" d="${path}" stroke="${color}"/>`;
    svg += `<circle id="cursor" class="cursor" r="4" fill="${color}" opacity="0"/>`;
    svg += `<line id="hv" class="hover-line" x1="0" x2="0" y1="${mt}" y2="${mt + ih}" visibility="hidden"/>`;
    svg += '</svg>';
    const svgWrap = h('div', { html: svg });
    Object.assign(cur, { W, iw, sx, sy, svgEl: svgWrap.querySelector('svg'), cfr: svgWrap.querySelector('#cfr'), cursor: svgWrap.querySelector('#cursor'), hv: svgWrap.querySelector('#hv') });
    if (lastSnap) applySnap(lastSnap);
    return svgWrap;
  };
  const el = h('div', { class: 'chart thrust-chart' });
  const tip = h('div', { class: 'tip', hidden: true });
  el.append(responsive(build, 260), tip);
  el.addEventListener('mousemove', ev => {
    const rect = cur.svgEl.getBoundingClientRect();
    const px = (ev.clientX - rect.left) / rect.width * cur.W;
    if (px < ml || px > cur.W - mr) { tip.hidden = true; cur.hv.setAttribute('visibility', 'hidden'); return; }
    const tv = Math.max(0, Math.min(tmax, (px - ml) / cur.iw * tmax));
    const fv = c.f[findIdx(tv)];
    cur.hv.setAttribute('x1', cur.sx(tv)); cur.hv.setAttribute('x2', cur.sx(tv)); cur.hv.setAttribute('visibility', 'visible');
    tip.innerHTML = `<div class="r"><b>t</b><span>${fmt(tv, 2)} s</span></div><div class="r"><span style="color:${color}">thrust</span><span>${fmt(fv, 0)} N</span></div>`;
    tip.hidden = false;
    const left = ev.clientX - rect.left, top = ev.clientY - rect.top;
    tip.style.left = (left + 14 + 150 > rect.width ? left - 160 : left + 14) + 'px';
    tip.style.top = Math.max(0, top - 10) + 'px';
  });
  el.addEventListener('mouseleave', () => { tip.hidden = true; cur.hv.setAttribute('visibility', 'hidden'); });
  return { el, view: { update(snap) { lastSnap = snap; applySnap(snap); } } };
}

export function motorPanel(kind, m, err, r, T) {
  const color = kind === 'booster' ? 'var(--c2)' : 'var(--c1)';
  if (!m) return { el: h('div', { class: 'motor-panel ' + kind }, h('div', { class: 'mp-head' }, h('span', { class: 'mp-kind', style: { background: color } }, kind), h('b', null, kind === 'booster' ? r.booster : (r.sustainer || '—'))), callout('warn', err || 'motor not found')), view: { update() {} } };
  const lb = v => `${fmt(v * KG_TO_LB, 2)} lb`;
  const dl = h('a', { class: 'btn sm ghost', href: `/download/eng?kind=${kind}&label=${encodeURIComponent(m.label)}`, download: '', title: `download ${m.label}.eng` }, '⬇');
  const burning = h('span', { class: 'pill run burn-badge', hidden: true }, 'burning');
  const chart = thrustChart(m, color, kind, T);
  const el = h('div', { class: 'motor-panel ' + kind },
    h('div', { class: 'mp-head' }, h('span', { class: 'mp-kind', style: { background: color } }, kind), h('b', null, m.label), m.designation !== m.label ? h('span', { class: 'muted small' }, m.designation) : null, burning, h('span', { class: 'spacer' }), dl),
    h('div', { class: 'mp-body' },
      h('div', { class: 'stat-list compact' },
        stat('total impulse', fmt(m.total_impulse_ns, 0), `N·s${m.impulse_class ? ' · ' + m.impulse_class : ''}`),
        stat('burn time', fmt(m.burn_time_s, 2), 's'),
        stat('avg / peak thrust', `${fmt(m.avg_thrust_n, 0)} / ${fmt(m.peak_thrust_n, 0)}`, 'N'),
        stat('propellant', fmt(m.prop_mass_kg, 2), 'kg', null, lb(m.prop_mass_kg)),
        stat('size', `${fmt(m.diameter_mm, 0)} × ${fmt(m.length_mm, 0)}`, 'mm'),
        stat('nozzle throat / exit', `${fmt(m.nozzle_throat_in, 2)} / ${fmt(m.nozzle_exit_in, 2)}`, 'in')),
      chart.el),
    h('div', { class: 'muted small mono mp-file', title: m.file }, m.file.split('/').pop() + (m.n_in_file > 1 ? ` (motor ${m.designation} of ${m.n_in_file})` : '')));
  return {
    el,
    view: {
      update(snap) {
        const burnEndAbs = kind === 'booster' ? T[1] : T[4];
        const burnStartAbs = kind === 'booster' ? 0 : T[3];
        burning.hidden = !(isNum(burnStartAbs) && isNum(burnEndAbs) && snap.t >= burnStartAbs && snap.t <= burnEndAbs);
        chart.view.update(snap);
      },
    },
  };
}

export function flightConfig(r, dz, hist, histKind, ps, cfg, d) {
  const b = dz.booster, s = dz.sustainer;
  const sLabel = s ? s.label : (r.sustainer || '');
  const q = `booster=${encodeURIComponent(r.booster)}&sustainer=${encodeURIComponent(sLabel)}`;
  const canZip = !!(b && s);
  const zip = h('a', { class: 'btn primary sm', href: canZip ? `/download/combo?${q}&profile=${encodeURIComponent(r.profile || '')}` : null, download: '', title: canZip ? 'zip: booster .eng, sustainer .eng, both in one RASP file, design.json' : 'a motor file is missing', onclick: e => { if (!canZip) { e.preventDefault(); toast('cannot build the combo: a motor is missing', 'err'); } else toast(`downloading ${r.booster} + ${sLabel} motor combo`); } }, '⬇ combo');
  const engB = b ? h('a', { class: 'btn sm ghost', href: `/download/eng?kind=booster&label=${encodeURIComponent(b.label)}`, download: '' }, '⬇ booster') : null;
  const engS = s ? h('a', { class: 'btn sm ghost', href: `/download/eng?kind=sustainer&label=${encodeURIComponent(sLabel)}`, download: '' }, '⬇ sustainer') : null;

  const T = stagingTimes(r, dz);
  const end = isNum(T[5]) ? T[5] * 1.04 : isNum(T[4]) ? T[4] * 1.25 : isNum(T[1]) ? T[1] * 5 : 10;
  const key = `${r.booster}|${sLabel}|${r.profile}`;
  let player = ps.player;
  if (!player || ps.playerKey !== key) {
    if (player) player.stop();
    player = createFlightPlayer(end, T, hist);
    ps.player = player; ps.playerKey = key;
  } else {
    player.resetViews();
  }

  const diagram = rocketDiagram(r, dz, T);
  const ascent = ascentTrack(r, cfg, d, T);
  const timeline = stagingTimeline(r, dz, player, T);
  const boosterPanel = motorPanel('booster', b, dz.booster_error, r, T);
  const sustainerPanel = motorPanel('sustainer', s, dz.sustainer_error, r, T);

  const playBtn = h('button', { class: 'btn sm primary', title: 'play / pause (space)' }, player.playing ? '❚❚' : '▶');
  playBtn.onclick = () => player.toggle();
  player.onPlayState(playing => { playBtn.textContent = playing ? '❚❚' : '▶'; });
  const speedSel = h('select', { class: 'inline-sel', title: 'playback speed' }, [1, 2, 4, 8].map(x => h('option', { value: x, selected: player.speed === x }, x + '×')));
  speedSel.onchange = () => player.setSpeed(Number(speedSel.value));

  const root = h('div', { class: 'card flight-config', tabindex: '0' },
    h('div', { class: 'row fc-toolbar' }, h('b', null, 'Flight configuration'), histKind === 'estimated' ? h('span', { class: 'pill warn', title: 'python estimate; run verify for the RASAero-checked flight' }, 'estimated') : null, h('span', { class: 'spacer' }), engB, engS, zip),
    h('div', { class: 'fc-grid' },
      h('div', { class: 'fc-panel fc-vehicle' },
        h('div', { class: 'fc-panel-head row between' }, h('span', null, 'VEHICLE'), h('span', { class: 'fc-caption' }, `${(dz.vehicle && dz.vehicle.file) || '?'} · ${dz.vehicle ? fmt(dz.vehicle.total_length_in, 1) : '?'} in overall · ${dz.vehicle ? fmt(dz.vehicle.max_diameter_in, 2) : '?'} in dia`)),
        diagram.el),
      h('div', { class: 'fc-panel fc-timeline' },
        h('div', { class: 'fc-panel-head row between' }, h('span', null, 'TIMELINE'), h('div', { class: 'row gap-1' }, playBtn, speedSel, h('span', { class: 'kbd-hint', title: 'keyboard, once the flight configuration card has focus' }, h('kbd', null, 'space'), ' play · ', h('kbd', null, '←'), h('kbd', null, '→'), ' step · ', h('kbd', null, 'shift'), ' ×10'))),
        timeline.el),
      h('div', { class: 'fc-panel fc-ascent' }, h('div', { class: 'fc-panel-head' }, 'ASCENT'), ascent.el)),
    h('div', { class: 'grid c2 motor-grid' }, boosterPanel.el, sustainerPanel.el));

  player.setRoot(root);
  for (const v of [diagram, ascent, timeline, boosterPanel, sustainerPanel]) player.addView(v.view);
  root.addEventListener('keydown', e => {
    if (e.code === 'Space') { e.preventDefault(); player.toggle(); }
    else if (e.code === 'ArrowRight') { e.preventDefault(); player.seek(player.t + (e.shiftKey ? 1 : 0.1)); }
    else if (e.code === 'ArrowLeft') { e.preventDefault(); player.seek(player.t - (e.shiftKey ? 1 : 0.1)); }
    else if (e.code === 'Home') { e.preventDefault(); player.seek(0); }
    else if (e.code === 'End') { e.preventDefault(); player.seek(player.end); }
  });
  return { el: root, player };
}
