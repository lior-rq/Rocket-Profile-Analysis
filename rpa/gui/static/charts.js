import { $, App, esc, fmt, h, isNum, pageState, render } from './core.js';

// ---- SVG line chart ---------------------------------------------------------
export const PALETTE = ['#2563eb', '#f97316', '#16a34a', '#9333ea', '#dc2626', '#0891b2', '#ca8a04', '#db2777'];

export function niceTicks(lo, hi, n = 6) {
  if (!isFinite(lo) || !isFinite(hi)) return [];
  if (lo === hi) { lo -= 1; hi += 1; }
  const step0 = (hi - lo) / n;
  const mag = Math.pow(10, Math.floor(Math.log10(step0)));
  const r = step0 / mag;
  const step = (r < 1.5 ? 1 : r < 3 ? 2 : r < 7 ? 5 : 10) * mag;
  const out = [];
  for (let v = Math.ceil(lo / step) * step; v <= hi + step * 1e-6; v += step) out.push(+v.toFixed(10));
  return out;
}
/* Charts are drawn 1:1 in CSS px (re-drawn when their box resizes) so
   axis text is always its real size instead of scaling with the SVG. */

export function responsive(draw, minW = 320) {
  const root = h('div', { class: 'chart-root' });
  let W = 0;
  const redraw = w => { W = w; root.innerHTML = ''; root.append(draw(W)); };
  redraw(Math.max(minW, root.clientWidth || 860));
  if (window.ResizeObserver) new ResizeObserver(en => { const w = Math.max(minW, Math.round(en[0].contentRect.width)); if (w && Math.abs(w - W) > 2) redraw(w); }).observe(root);
  return root;
}

export function lineChart(opts) { return responsive(W => lineChartSvg(opts, W)); }

export function lineChartSvg({ series, xLabel, yLabel, y2Label, markers = [], refs = [], title, height = 280, xDomain, yDomain, y2Domain, points, onHover, onLeave }, W) {
  const H = height;
  const hasY2 = series.some(s => s.axis === 'y2');
  const m = { l: 58, r: hasY2 ? 58 : 18, t: title ? 28 : 14, b: 42 };
  const iw = W - m.l - m.r, ih = H - m.t - m.b;
  const vis = series.filter(s => s.x && s.x.length);
  const ext = (arr) => { let lo = Infinity, hi = -Infinity; for (const v of arr) { if (isNum(v)) { if (v < lo) lo = v; if (v > hi) hi = v; } } return [lo, hi]; };
  let [x0, x1] = xDomain || ext(vis.flatMap(s => s.x));
  const yv = vis.filter(s => s.axis !== 'y2'), y2v = vis.filter(s => s.axis === 'y2');
  let [y0, y1] = yDomain || ext(yv.flatMap(s => s.y).concat(refs.filter(r => r.axis !== 'y2').map(r => r.y)));
  let [z0, z1] = y2Domain || ext(y2v.flatMap(s => s.y).concat(refs.filter(r => r.axis === 'y2').map(r => r.y)));
  if (!isFinite(x0)) { x0 = 0; x1 = 1; }
  if (!isFinite(y0)) { y0 = 0; y1 = 1; }
  if (!isFinite(z0)) { z0 = 0; z1 = 1; }
  const pad = (a, b) => { if (a === b) return [a - 1, b + 1]; const p = (b - a) * 0.06; return [a - (a >= 0 && a - p < 0 ? a : p), b + p]; };
  if (!yDomain) [y0, y1] = pad(y0, y1);
  if (!y2Domain) [z0, z1] = pad(z0, z1);
  const sx = v => m.l + (v - x0) / (x1 - x0 || 1) * iw;
  const sy = v => m.t + ih - (v - y0) / (y1 - y0 || 1) * ih;
  const sz = v => m.t + ih - (v - z0) / (z1 - z0 || 1) * ih;
  const xt = niceTicks(x0, x1, 8), yt = niceTicks(y0, y1, 6), zt = niceTicks(z0, z1, 6);
  const tickFmt = v => Math.abs(v) >= 10000 ? (v / 1000).toFixed(v % 1000 ? 1 : 0) + 'k' : fmt(v);
  let svg = `<svg viewBox="0 0 ${W} ${H}" width="${W}" height="${H}">`;
  if (title) svg += `<text class="title" x="${m.l}" y="16">${esc(title)}</text>`;
  svg += '<g class="grid">' + yt.map(v => `<line x1="${m.l}" x2="${W - m.r}" y1="${sy(v)}" y2="${sy(v)}"/>`).join('') + '</g>';
  svg += `<g class="axis"><path d="M${m.l},${m.t}V${m.t + ih}H${W - m.r}${hasY2 ? 'V' + m.t : ''}" fill="none"/>` +
    xt.map(v => `<line x1="${sx(v)}" x2="${sx(v)}" y1="${m.t + ih}" y2="${m.t + ih + 4}"/><text x="${sx(v)}" y="${m.t + ih + 16}" text-anchor="middle">${tickFmt(v)}</text>`).join('') +
    yt.map(v => `<text x="${m.l - 6}" y="${sy(v) + 3.5}" text-anchor="end">${tickFmt(v)}</text>`).join('') +
    (hasY2 ? zt.map(v => `<text x="${W - m.r + 6}" y="${sz(v) + 3.5}" text-anchor="start">${tickFmt(v)}</text>`).join('') : '') +
    (xLabel ? `<text x="${m.l + iw / 2}" y="${H - 8}" text-anchor="middle">${esc(xLabel)}</text>` : '') +
    (yLabel ? `<text transform="translate(13,${m.t + ih / 2}) rotate(-90)" text-anchor="middle">${esc(yLabel)}</text>` : '') +
    (hasY2 && y2Label ? `<text transform="translate(${W - 10},${m.t + ih / 2}) rotate(90)" text-anchor="middle">${esc(y2Label)}</text>` : '') + '</g>';
  // Labels are laid out against each other (and the plot edges) so that
  // close events never overlap; they are drawn last, on top of the series.
  const boxes = [], LH = 13;
  const textW = t => String(t).length * 6.2 + 4;
  const hit = b => boxes.some(o => b.x < o.x + o.w && b.x + b.w > o.x && b.y < o.y + o.h && b.y + b.h > o.y);
  let labels = '';
  for (const r of refs) {
    const y = r.axis === 'y2' ? sz(r.y) : sy(r.y);
    if (y < m.t || y > m.t + ih) continue;
    const col = r.color || '#94a3b8', w = textW(r.label || ''), x = W - m.r - 4;
    let by = y - 4;
    let box = { x: x - w, y: by - 10, w, h: LH };
    if (box.y < m.t || hit(box)) { by = y + 12; box = { x: x - w, y: by - 10, w, h: LH }; }
    boxes.push(box);
    svg += `<line class="ref" x1="${m.l}" x2="${W - m.r}" y1="${y}" y2="${y}" stroke="${col}"/>`;
    labels += `<text class="ref-lbl" x="${x}" y="${by.toFixed(1)}" text-anchor="end" fill="${col}">${esc(r.label || '')}</text>`;
  }
  markers.filter(mk => isNum(mk.x) && mk.x >= x0 && mk.x <= x1).sort((a, b) => a.x - b.x).forEach(mk => {
    const x = sx(mk.x), col = mk.color || '#64748b', w = textW(mk.label);
    const flip = x + 4 + w > W - m.r;
    const bx = flip ? x - 4 - w : Math.max(x + 4, m.l + 6);   // clear of the y axis at the left edge
    let by = m.t + 11, box;
    for (let k = 0; k < 8; k++) {
      by = m.t + 11 + k * LH;
      box = { x: bx, y: by - 10, w, h: LH };
      if (!hit(box)) break;
    }
    boxes.push(box);
    svg += `<line class="marker" x1="${x}" x2="${x}" y1="${m.t}" y2="${m.t + ih}" stroke="${col}"/>`;
    labels += `<text class="marker-lbl" x="${(flip ? x - 4 : bx).toFixed(1)}" y="${by.toFixed(1)}" text-anchor="${flip ? 'end' : 'start'}" fill="${col}">${esc(mk.label)}</text>`;
  });
  vis.forEach((s, i) => {
    const f = s.axis === 'y2' ? sz : sy;
    let d = '', pen = false;
    for (let k = 0; k < s.x.length; k++) {
      const xv = s.x[k], yv2 = s.y[k];
      if (!isNum(xv) || !isNum(yv2)) { pen = false; continue; }
      d += (pen ? 'L' : 'M') + sx(xv).toFixed(1) + ',' + f(yv2).toFixed(1);
      pen = true;
    }
    const color = s.color || PALETTE[i % PALETTE.length];
    svg += `<path class="series" d="${d}" stroke="${color}"${s.dash ? ' stroke-dasharray="5 3"' : ''}${s.width ? ` stroke-width="${s.width}"` : ''}/>`;
    if (s.points || points) svg += s.x.map((xv, k) => isNum(xv) && isNum(s.y[k]) ? `<circle cx="${sx(xv)}" cy="${f(s.y[k])}" r="3" fill="${color}"/>` : '').join('');
  });
  svg += labels;
  svg += `<line class="hover-line" id="hv" x1="0" x2="0" y1="${m.t}" y2="${m.t + ih}" visibility="hidden"/>`;
  svg += '</svg>';
  const el = h('div', { class: 'chart', html: svg });
  const legend = h('div', { class: 'legend' }, vis.map((s, i) => h('span', null, h('span', { class: 'sw', style: { background: s.color || PALETTE[i % PALETTE.length] } }), s.name + (s.axis === 'y2' ? ' (right)' : ''))));
  const tip = h('div', { class: 'tip', hidden: true });
  el.append(tip);
  const svgEl = el.querySelector('svg');
  const hv = el.querySelector('#hv');
  el.addEventListener('mousemove', ev => {
    const rect = svgEl.getBoundingClientRect();
    const px = (ev.clientX - rect.left) / rect.width * W;
    if (px < m.l || px > W - m.r) { tip.hidden = true; hv.setAttribute('visibility', 'hidden'); return; }
    const xv = x0 + (px - m.l) / iw * (x1 - x0);
    const rowsOut = [];
    let xNear = null;
    for (const s of vis) {
      let lo = 0, hi = s.x.length - 1;
      while (lo < hi) { const mid = (lo + hi) >> 1; if (s.x[mid] < xv) lo = mid + 1; else hi = mid; }
      const k = (lo > 0 && Math.abs(s.x[lo - 1] - xv) < Math.abs(s.x[lo] - xv)) ? lo - 1 : lo;
      if (xNear === null) xNear = s.x[k];
      rowsOut.push([s.name, s.y[k], s.color || PALETTE[vis.indexOf(s) % PALETTE.length]]);
    }
    if (xNear === null) return;
    hv.setAttribute('x1', sx(xNear)); hv.setAttribute('x2', sx(xNear)); hv.setAttribute('visibility', 'visible');
    tip.innerHTML = `<div class="r"><b>${esc(xLabel || 'x')}</b><span>${fmt(xNear)}</span></div>` + rowsOut.map(([n, v, c]) => `<div class="r"><span style="color:${c}">${esc(n)}</span><span>${fmt(v)}</span></div>`).join('');
    tip.hidden = false;
    const left = ev.clientX - rect.left, top = ev.clientY - rect.top;
    tip.style.left = (left + 14 + 180 > rect.width ? left - 190 : left + 14) + 'px';
    tip.style.top = Math.max(0, top - 10) + 'px';
    if (onHover) onHover(xNear);
  });
  el.addEventListener('mouseleave', () => { tip.hidden = true; hv.setAttribute('visibility', 'hidden'); if (onLeave) onLeave(); });
  return h('div', null, el, legend);
}

export function historyChart(t, title, opts = {}) {
  const c = t.columns, sm = t.summary || {};
  const markers = [];
  if (isNum(sm.t_burnout_s)) markers.push({ x: sm.t_burnout_s, label: `burnout ${fmt(sm.t_burnout_s, 2)}s`, color: '#f97316' });
  if (isNum(sm.t_sep_s)) markers.push({ x: sm.t_sep_s, label: `separation ${fmt(sm.t_sep_s, 2)}s`, color: '#9333ea' });
  if (isNum(sm.t_ign_s)) markers.push({ x: sm.t_ign_s, label: `ignition ${fmt(sm.t_ign_s, 2)}s`, color: '#dc2626' });
  if (isNum(sm.t_apogee_s)) markers.push({ x: sm.t_apogee_s, label: `apogee ${fmt(sm.t_apogee_s, 1)}s`, color: '#16a34a' });
  const cfg = App.state.config;
  const ps = pageState('histchart', { mode: 'mach' });
  const modes = { mach: 'Mach & altitude', vel: 'velocity & thrust', forces: 'thrust, drag, weight', accel: 'acceleration' };
  let series, yLabel, y2Label, refs = [];
  const tmax = opts.tmax || null;
  const cut = (arr) => tmax ? arr.filter((_, i) => c.time_s[i] <= tmax) : arr;
  const x = cut(c.time_s);
  if (ps.mode === 'mach') {
    series = [{ name: 'Mach', x, y: cut(c.mach) }, { name: 'altitude [ft]', x, y: cut(c.altitude_ft), axis: 'y2' }];
    yLabel = 'Mach'; y2Label = 'altitude [ft]';
    refs = [{ y: cfg.profiles.supersonic_min_mach, label: `M ${cfg.profiles.supersonic_min_mach}`, color: '#dc2626' }, { y: cfg.profiles.subsonic_max_mach, label: `M ${cfg.profiles.subsonic_max_mach}`, color: '#16a34a' }, { y: cfg.target.apogee_ft, label: `target ${fmt(cfg.target.apogee_ft, 0)} ft`, axis: 'y2', color: '#2563eb' }];
  } else if (ps.mode === 'vel') {
    series = [{ name: 'velocity [fps]', x, y: cut(c.velocity_fps) }, { name: 'thrust [lb]', x, y: cut(c.thrust_lb), axis: 'y2' }];
    yLabel = 'velocity [ft/s]'; y2Label = 'thrust [lb]';
  } else if (ps.mode === 'forces') {
    series = [{ name: 'thrust [lb]', x, y: cut(c.thrust_lb) }, { name: 'drag [lb]', x, y: cut(c.drag_lb) }, { name: 'weight [lb]', x, y: cut(c.weight_lb) }];
    yLabel = 'lb';
  } else {
    series = [{ name: 'accel [ft/s²]', x, y: cut(c.accel_fps2) }, { name: 'accel-V', x, y: cut(c.accel_v_fps2) }];
    yLabel = 'ft/s²';
  }
  return h('div', null,
    h('div', { class: 'row between mb-1' },
      h('div', { class: 'tabs mb-0', role: 'tablist', style: { borderBottom: 0 } }, Object.entries(modes).map(([k, v]) => h('button', { class: 'tab ' + (ps.mode === k ? 'active' : ''), type: 'button', role: 'tab', 'aria-selected': String(ps.mode === k), onclick: () => { ps.mode = k; render(); } }, v))),
      h('span', { class: 'muted small' }, `apogee ${fmt(sm.apogee_ft, 0)} ft · max Mach ${fmt(sm.max_mach, 3)} · max vel ${fmt(sm.max_vel_fps, 0)} fps · ${t.n} samples`)),
    lineChart({ series, xLabel: 'time [s]', yLabel, y2Label, markers, refs, title, height: 300, onHover: opts.onHover, onLeave: opts.onLeave }));
}

/* Scatter of designs: one mark per point (colour and shape by callback), a
   horizontal band (target ± tolerance), vertical reference lines, a hover
   tooltip and click-to-select. Drawn 1:1 in CSS px like lineChart. */
export function scatterChart({ points, xLabel, yLabel, band, xrefs = [], height = 320, color = () => PALETTE[0], shape = () => 'circle', onClick, selectedKey, tip }) {
  return responsive(W => {
    const H = height, m = { l: 62, r: 16, t: 14, b: 44 }, iw = W - m.l - m.r, ih = H - m.t - m.b;
    const ext = arr => { let lo = Infinity, hi = -Infinity; for (const v of arr) { if (isNum(v)) { if (v < lo) lo = v; if (v > hi) hi = v; } } return [lo, hi]; };
    let [x0, x1] = ext(points.map(p => p.x).concat(xrefs.map(r => r.x)));
    let [y0, y1] = ext(points.map(p => p.y).concat(band ? [band.y0, band.y1] : []));
    if (!isFinite(x0)) { x0 = 0; x1 = 1; }
    if (!isFinite(y0)) { y0 = 0; y1 = 1; }
    const pad = (a, b) => { if (a === b) return [a - 1, b + 1]; const p = (b - a) * 0.08; return [a - p, b + p]; };
    [x0, x1] = pad(x0, x1); [y0, y1] = pad(y0, y1);
    const sx = v => m.l + (v - x0) / (x1 - x0) * iw, sy = v => m.t + ih - (v - y0) / (y1 - y0) * ih;
    const xt = niceTicks(x0, x1, 8), yt = niceTicks(y0, y1, 6);
    const tickFmt = v => Math.abs(v) >= 10000 ? (v / 1000).toFixed(v % 1000 ? 1 : 0) + 'k' : fmt(v);
    let svg = `<svg viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" class="scatter">`;
    svg += '<g class="grid">' + yt.map(v => `<line x1="${m.l}" x2="${W - m.r}" y1="${sy(v)}" y2="${sy(v)}"/>`).join('') + '</g>';
    if (band) svg += `<rect class="band" x="${m.l}" y="${sy(band.y1).toFixed(1)}" width="${iw}" height="${Math.max(0, sy(band.y0) - sy(band.y1)).toFixed(1)}"/>` + (band.label ? `<text class="ref-lbl" x="${W - m.r - 4}" y="${(sy(band.y1) - 4).toFixed(1)}" text-anchor="end" fill="#16a34a">${esc(band.label)}</text>` : '');
    svg += `<g class="axis"><path d="M${m.l},${m.t}V${m.t + ih}H${W - m.r}" fill="none"/>` +
      xt.map(v => `<line x1="${sx(v)}" x2="${sx(v)}" y1="${m.t + ih}" y2="${m.t + ih + 4}"/><text x="${sx(v)}" y="${m.t + ih + 16}" text-anchor="middle">${tickFmt(v)}</text>`).join('') +
      yt.map(v => `<text x="${m.l - 6}" y="${sy(v) + 3.5}" text-anchor="end">${tickFmt(v)}</text>`).join('') +
      (xLabel ? `<text x="${m.l + iw / 2}" y="${H - 8}" text-anchor="middle">${esc(xLabel)}</text>` : '') +
      (yLabel ? `<text transform="translate(13,${m.t + ih / 2}) rotate(-90)" text-anchor="middle">${esc(yLabel)}</text>` : '') + '</g>';
    for (const r of xrefs) svg += `<line class="ref" x1="${sx(r.x).toFixed(1)}" x2="${sx(r.x).toFixed(1)}" y1="${m.t}" y2="${m.t + ih}" stroke="${r.color || '#94a3b8'}"/><text class="ref-lbl" x="${(sx(r.x) + 4).toFixed(1)}" y="${m.t + 11}" fill="${r.color || '#94a3b8'}">${esc(r.label || '')}</text>`;
    const ordered = points.slice().sort((a, b) => (a.key === selectedKey) - (b.key === selectedKey));
    svg += ordered.map(p => {
      const cx = sx(p.x), cy = sy(p.y), c = color(p), sel = p.key === selectedKey, r = sel ? 7 : 4.5, cls = 'pt' + (sel ? ' sel' : ''), sh = shape(p);
      if (sh === 'square') return `<rect class="${cls}" x="${(cx - r).toFixed(1)}" y="${(cy - r).toFixed(1)}" width="${(2 * r).toFixed(1)}" height="${(2 * r).toFixed(1)}" fill="${c}" fill-opacity=".8"/>`;
      if (sh === 'diamond') return `<rect class="${cls}" x="${(cx - r).toFixed(1)}" y="${(cy - r).toFixed(1)}" width="${(2 * r).toFixed(1)}" height="${(2 * r).toFixed(1)}" transform="rotate(45 ${cx.toFixed(1)} ${cy.toFixed(1)})" fill="${c}" fill-opacity=".8"/>`;
      return `<circle class="${cls}" cx="${cx.toFixed(1)}" cy="${cy.toFixed(1)}" r="${r}" fill="${c}" fill-opacity=".8"/>`;
    }).join('');
    svg += '</svg>';
    const el = h('div', { class: 'chart', html: svg });
    const tipEl = h('div', { class: 'tip', hidden: true });
    el.append(tipEl);
    const svgEl = el.querySelector('svg');
    const nearest = ev => {
      const rect = svgEl.getBoundingClientRect();
      const px = (ev.clientX - rect.left) / rect.width * W, py = (ev.clientY - rect.top) / rect.height * H;
      let best = null, bd = 144;
      for (const p of ordered) { const dx = sx(p.x) - px, dy = sy(p.y) - py, dd = dx * dx + dy * dy; if (dd < bd) { bd = dd; best = p; } }
      return { best, left: ev.clientX - rect.left, top: ev.clientY - rect.top, rect };
    };
    el.addEventListener('mousemove', ev => {
      const { best, left, top, rect } = nearest(ev);
      if (!best) { tipEl.hidden = true; el.style.cursor = ''; return; }
      el.style.cursor = 'pointer';
      tipEl.innerHTML = (tip ? tip(best) : [[xLabel, fmt(best.x)], [yLabel, fmt(best.y)]]).map(([k, v]) => `<div class="r"><span>${esc(k)}</span><span>${esc(v)}</span></div>`).join('');
      tipEl.hidden = false;
      tipEl.style.left = (left + 14 + 220 > rect.width ? left - 230 : left + 14) + 'px';
      tipEl.style.top = Math.max(0, top - 10) + 'px';
    });
    el.addEventListener('mouseleave', () => { tipEl.hidden = true; });
    el.addEventListener('click', ev => { const { best } = nearest(ev); if (best && onClick) onClick(best); });
    return el;
  }, 320);
}

/* Several flight histories on one time axis (Mach, altitude or velocity). */
export function historyOverlay(items, mode, cfg, height = 300) {
  const col = { mach: 'mach', altitude: 'altitude_ft', velocity: 'velocity_fps' }[mode] || 'mach';
  const yLabel = { mach: 'Mach', altitude: 'altitude [ft]', velocity: 'velocity [ft/s]' }[mode] || 'Mach';
  const series = items.map(it => ({ name: it.name, x: it.hist.columns.time_s, y: it.hist.columns[col], color: it.color, dash: it.dash }));
  const refs = col === 'mach' ? [{ y: cfg.profiles.supersonic_min_mach, label: `M ${cfg.profiles.supersonic_min_mach}`, color: '#dc2626' }, { y: cfg.profiles.subsonic_max_mach, label: `M ${cfg.profiles.subsonic_max_mach}`, color: '#16a34a' }]
    : col === 'altitude_ft' ? [{ y: cfg.target.apogee_ft, label: `target ${fmt(cfg.target.apogee_ft, 0)} ft`, color: '#2563eb' }] : [];
  return lineChart({ series, xLabel: 'time [s]', yLabel, refs, height });
}
