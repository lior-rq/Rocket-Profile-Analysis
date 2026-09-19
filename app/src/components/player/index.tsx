/* Flight player: one playhead drives the vehicle diagram, the ascent track,
   the staging timeline and the motors' thrust curves. A port of the SVG
   player from the vanilla GUI; the drawings stay SVG (1:1 CSS px). */
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Download, Pause, Play, SkipBack, SkipForward } from "lucide-react";
import { toast } from "sonner";
import { BASE } from "@/lib/api";
import { esc, fmt, isNum } from "@/lib/format";
import { cn } from "@/lib/utils";
import { Button, Chip, Icon, IconButton, Kbd, Pill, Problem, Segmented, Stat, StatGrid } from "../ui";

export const N_PER_LB = 4.448222, IN_PER_MM = 1 / 25.4, KG_TO_LB = 2.20462262;
export const PHASE_DEFS = [{ id: "boost", name: "boost" }, { id: "sep_delay", name: "separation delay" }, { id: "ign_delay", name: "ignition delay" }, { id: "sustain", name: "sustainer burn" }, { id: "coast", name: "coast to apogee" }] as const;
export type T6 = (number | null)[];
export type Snap = { t: number; phase: number; attached: boolean; firing: boolean; alt: number | null; mach: number | null; vel: number | null };
export type Hist = { columns: Record<string, (number | null)[]> } | null;

export function lowerBound(xs: (number | null)[], v: number) { let lo = 0, hi = xs.length; while (lo < hi) { const mid = (lo + hi) >> 1; if ((xs[mid] as number) < v) lo = mid + 1; else hi = mid; } return lo; }
export function interpAt(xs: (number | null)[] | undefined, ys: (number | null)[] | undefined, t: number): number | null {
  if (!xs || !xs.length || !ys) return null;
  if (t <= (xs[0] as number)) return isNum(ys[0]) ? ys[0] : null;
  if (t >= (xs[xs.length - 1] as number)) return isNum(ys[ys.length - 1]) ? (ys[ys.length - 1] as number) : null;
  const i = Math.min(xs.length - 1, Math.max(1, lowerBound(xs, t)));
  const x0 = xs[i - 1] as number, x1 = xs[i] as number, y0 = ys[i - 1], y1 = ys[i];
  if (!isNum(y0)) return isNum(y1) ? y1 : null;
  if (!isNum(y1)) return y0;
  return y0 + (y1 - y0) * ((t - x0) / (x1 - x0 || 1));
}
export function phaseIndexAt(t: number, T: T6) { let idx = 0; for (let i = 0; i <= 4; i++) if (isNum(T[i]) && t >= (T[i] as number) - 1e-9) idx = i; return idx; }
export function stagingTimes(r: any, dz: any): T6 {
  const tb = dz.booster ? dz.booster.burn_time_s : null, ts = dz.sustainer ? dz.sustainer.burn_time_s : null;
  const t0 = 0, t1 = isNum(tb) ? tb : null;
  const t2 = isNum(t1) && isNum(r.sep_delay_s) ? t1 + r.sep_delay_s : null;
  const t3 = isNum(t2) && isNum(r.ign_delay_s) ? t2 + r.ign_delay_s : null;
  const t4 = isNum(t3) && isNum(ts) ? t3 + ts : null;
  const t5 = isNum(r.t_apogee_s) ? r.t_apogee_s : null;
  return [t0, t1, t2, t3, t4, t5];
}
export function niceTicks(lo: number, hi: number, n = 6) {
  if (!isFinite(lo) || !isFinite(hi)) return [] as number[];
  if (lo === hi) { lo -= 1; hi += 1; }
  const step0 = (hi - lo) / n, mag = Math.pow(10, Math.floor(Math.log10(step0))), r = step0 / mag;
  const step = (r < 1.5 ? 1 : r < 3 ? 2 : r < 7 ? 5 : 10) * mag;
  const out: number[] = [];
  for (let v = Math.ceil(lo / step) * step; v <= hi + step * 1e-6; v += step) out.push(+v.toFixed(10));
  return out;
}
/* Width of a box, re-measured on resize. */
export function useWidth<T extends HTMLElement>(min = 320): [React.RefObject<T | null>, number] {
  const ref = useRef<T>(null);
  const [w, setW] = useState(0);
  useLayoutEffect(() => {
    const el = ref.current; if (!el) return;
    const update = () => setW(Math.max(min, Math.round(el.clientWidth || 0)));
    update();
    const ro = new ResizeObserver(update); ro.observe(el);
    return () => ro.disconnect();
  }, [min]);
  return [ref, w];
}

/* ---- the player -------------------------------------------------------------- */
export type Player = { t: number; playing: boolean; speed: number; end: number; seek: (t: number) => void; preview: (t: number) => void; clearPreview: () => void; toggle: () => void; setSpeed: (x: number) => void; snap: Snap };
export function usePlayer(end: number, T: T6, hist: Hist, key: string): Player {
  const [t, setT] = useState(0);
  const [preview, setPreview] = useState<number | null>(null);
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState(1);
  const tRef = useRef(0), playingRef = useRef(false), speedRef = useRef(1), raf = useRef<number | null>(null), lastTs = useRef<number | null>(null);
  useEffect(() => { tRef.current = 0; setT(0); setPlaying(false); playingRef.current = false; }, [key]);
  const clampT = useCallback((v: number) => Math.max(0, Math.min(end, isNum(v) ? v : 0)), [end]);
  const frame = useCallback((ts: number) => {
    if (!playingRef.current) return;
    if (lastTs.current != null) tRef.current = clampT(tRef.current + ((ts - lastTs.current) / 1000) * speedRef.current);
    lastTs.current = ts;
    setT(tRef.current);
    if (tRef.current >= end) { playingRef.current = false; lastTs.current = null; setPlaying(false); return; }
    raf.current = requestAnimationFrame(frame);
  }, [clampT, end]);
  useEffect(() => () => { if (raf.current) cancelAnimationFrame(raf.current); }, []);
  const play = () => { if (playingRef.current) return; if (tRef.current >= end - 1e-6) tRef.current = 0; playingRef.current = true; lastTs.current = null; setPlaying(true); raf.current = requestAnimationFrame(frame); };
  const pause = () => { playingRef.current = false; if (raf.current) cancelAnimationFrame(raf.current); raf.current = null; setPlaying(false); };
  const shown = preview ?? t;
  const c = hist?.columns;
  const snap: Snap = useMemo(() => ({
    t: shown, phase: phaseIndexAt(shown, T), attached: !isNum(T[2]) || shown < (T[2] as number), firing: (isNum(T[1]) && shown <= (T[1] as number)) || (isNum(T[3]) && isNum(T[4]) && shown >= (T[3] as number) && shown <= (T[4] as number)),
    alt: c ? interpAt(c.time_s, c.altitude_ft, shown) : null, mach: c ? interpAt(c.time_s, c.mach, shown) : null, vel: c ? interpAt(c.time_s, c.velocity_fps, shown) : null,
  }), [shown, T, c]);
  return { t, playing, speed, end, snap, seek: (v) => { tRef.current = clampT(v); setT(tRef.current); setPreview(null); }, preview: (v) => setPreview(clampT(v)), clearPreview: () => setPreview(null), toggle: () => (playingRef.current ? pause() : play()), setSpeed: (x) => { speedRef.current = x; setSpeed(x); } };
}

/* ---- module panel: one bordered box per part of the player ---------------------- */
export function Module({ title, extra, children, className, bodyClass }: { title: ReactNode; extra?: ReactNode; children: ReactNode; className?: string; bodyClass?: string }) {
  return <section className={cn("fc-module", className)}>
    <header className="fc-module-head"><div className="fc-module-title">{title}</div>{extra ? <div className="fc-module-extra">{extra}</div> : null}</header>
    <div className={cn("fc-module-body", bodyClass)}>{children}</div>
  </section>;
}

/* ---- vehicle diagram ----------------------------------------------------------- */
export function noseProfile(shape: string, L: number, R: number, n = 28) {
  const s = String(shape || "").toLowerCase(); const pts: [number, number][] = [];
  for (let i = 0; i <= n; i++) {
    const t = i / n, x = L * t; let y: number;
    if (s.includes("conic")) y = R * t;
    else if (s.includes("ellip")) y = R * Math.sqrt(Math.max(0, 1 - (1 - t) * (1 - t)));
    else if (s.includes("parab")) y = R * (2 * t - t * t);
    else if (s.includes("power")) y = R * Math.sqrt(t);
    else if (s.includes("haack") || s.includes("karman")) { const C = s.includes("lv") ? 1 / 3 : 0; const th = Math.acos(1 - 2 * t); y = (R / Math.sqrt(Math.PI)) * Math.sqrt(Math.max(0, th - Math.sin(2 * th) / 2 + C * Math.pow(Math.sin(th), 3))); }
    else { const rho = (R * R + L * L) / (2 * R); y = Math.sqrt(Math.max(0, rho * rho - (L - x) * (L - x))) + R - rho; }
    pts.push([x, y]);
  }
  return pts;
}
export function RocketDiagram({ r, dz, snap }: { r: any; dz: any; snap: Snap }) {
  const [ref, W] = useWidth<HTMLDivElement>(360);
  const geo = dz.vehicle, b = dz.booster, s = dz.sustainer;
  const svg = useMemo(() => {
    if (!geo || !geo.parts || !geo.parts.length || !W) return "";
    const ML = 20, GAP = 60, FLAME = 66;
    const ppi = (W - ML - GAP - FLAME - 20) / geo.total_length_in;
    const X = (v: number) => ML + v * ppi;
    const uid = "rk" + Math.random().toString(36).slice(2, 7);
    const sus = geo.parts.filter((p: any) => p.type !== "Booster"), boo = geo.parts.filter((p: any) => p.type === "Booster");
    const susAft = sus.length ? Math.max(...sus.map((p: any) => p.location_in + p.length_in)) : 0;
    const booAft = boo.length ? Math.max(...boo.map((p: any) => p.location_in + p.length_in)) : susAft;
    const susAftTube = sus.filter((p: any) => p.type !== "NoseCone").sort((p: any, q: any) => q.location_in + q.length_in - (p.location_in + p.length_in))[0] || sus[sus.length - 1];
    const rad = (p: any) => (p.diameter_in / 2) * ppi;
    const maxSpan = Math.max(0, ...geo.parts.map((p: any) => (p.fins ? p.fins.span_in : 0))) * ppi;
    const rMax = (geo.max_diameter_in / 2) * ppi;
    const H = Math.ceil(2 * (rMax + maxSpan) + 60), cy = H / 2;
    const defs = `<defs><linearGradient id="${uid}-flame" x1="0" y1="0" x2="1" y2="0"><stop offset="0" style="stop-color:var(--flame-0)"/><stop offset=".45" style="stop-color:var(--flame-1)"/><stop offset="1" style="stop-color:var(--flame-1);stop-opacity:0"/></linearGradient></defs>`;
    const finPoly = (p: any, side: number) => { const f = p.fins; if (!f) return ""; const aft = X(p.location_in + p.length_in), rr = rad(p); const le = aft - f.location_in * ppi, te = le + f.root_chord_in * ppi, tle = le + f.sweep_in * ppi, tte = tle + f.tip_chord_in * ppi; const y0 = cy + side * rr, y1 = cy + side * (rr + f.span_in * ppi); return `<polygon class="fin" points="${le.toFixed(1)},${y0.toFixed(1)} ${tle.toFixed(1)},${y1.toFixed(1)} ${tte.toFixed(1)},${y1.toFixed(1)} ${te.toFixed(1)},${y0.toFixed(1)}"/>`; };
    const partShape = (p: any) => {
      const x0 = X(p.location_in), x1 = X(p.location_in + p.length_in), rr = rad(p);
      if (p.type === "NoseCone") { const pts = noseProfile(p.shape, x1 - x0, rr); const top = pts.map(([x, y]) => `${(x0 + x).toFixed(1)},${(cy - y).toFixed(1)}`).join(" "); const bot = pts.slice().reverse().map(([x, y]) => `${(x0 + x).toFixed(1)},${(cy + y).toFixed(1)}`).join(" "); return `<polygon class="body nose" points="${top} ${bot}"/>`; }
      if (p.type === "Transition") { const r0 = ((p.front_diameter_in || p.diameter_in) / 2) * ppi, r1 = ((p.rear_diameter_in || p.diameter_in) / 2) * ppi; return `<polygon class="body" points="${x0},${cy - r0} ${x1},${cy - r1} ${x1},${cy + r1} ${x0},${cy + r0}"/>`; }
      let out = finPoly(p, -1) + finPoly(p, 1);
      const bt = p.boattail_length_in || 0;
      out += `<rect class="body ${p.type === "Booster" ? "booster" : "sustainer"}" x="${x0.toFixed(1)}" y="${(cy - rr).toFixed(1)}" width="${(x1 - x0 - bt * ppi).toFixed(1)}" height="${(2 * rr).toFixed(1)}"/>`;
      if (bt > 0) { const rb = ((p.boattail_rear_diameter_in || p.diameter_in) / 2) * ppi, xb = x1 - bt * ppi; out += `<polygon class="body" points="${xb},${cy - rr} ${x1},${cy - rb} ${x1},${cy + rb} ${xb},${cy + rr}"/>`; }
      return out;
    };
    const motorShape = (m: any, aftIn: number, host: any, cls: string) => {
      if (!m) return "";
      const len = Math.min(m.length_mm * IN_PER_MM, host ? host.length_in * 0.96 : 1e9) * ppi, hr = Math.min(((m.diameter_mm * IN_PER_MM) / 2) * ppi, (host ? rad(host) : rMax) * 0.92);
      const x1 = X(aftIn), x0 = x1 - len;
      const ex = ((m.nozzle_exit_in || m.diameter_mm * IN_PER_MM * 0.8) / 2) * ppi, th = ((m.nozzle_throat_in || m.nozzle_exit_in * 0.45 || 1) / 2) * ppi, nl = Math.min(2.6 * ppi, len * 0.25);
      return `<g class="motor ${cls}"><rect x="${x0.toFixed(1)}" y="${(cy - hr).toFixed(1)}" width="${len.toFixed(1)}" height="${(2 * hr).toFixed(1)}" rx="2"/><path class="grain" d="M${(x0 + 4).toFixed(1)},${cy}H${(x1 - 4).toFixed(1)}"/><polygon class="nozzle" points="${x1.toFixed(1)},${(cy - th).toFixed(1)} ${(x1 + nl).toFixed(1)},${(cy - ex).toFixed(1)} ${(x1 + nl).toFixed(1)},${(cy + ex).toFixed(1)} ${x1.toFixed(1)},${(cy + th).toFixed(1)}"/></g>`;
    };
    const flame = (m: any, aftIn: number, cls: string) => { if (!m) return ""; const nl = Math.min(2.6 * ppi, m.length_mm * IN_PER_MM * ppi * 0.25), x = X(aftIn) + nl, ex = ((m.nozzle_exit_in || m.diameter_mm * IN_PER_MM * 0.8) / 2) * ppi; return `<path class="flame ${cls}" fill="url(#${uid}-flame)" d="M${x},${cy - ex} Q${x + FLAME * 0.55},${cy - ex * 1.6} ${x + FLAME},${cy} Q${x + FLAME * 0.55},${cy + ex * 1.6} ${x},${cy + ex}Z"/>`; };
    const booHost = boo.slice().sort((p: any, q: any) => q.location_in + q.length_in - (p.location_in + p.length_in))[0];
    const booG = boo.length ? `<g class="booster-g">${boo.map(partShape).join("")}${motorShape(b, booAft, booHost, "booster")}${flame(b, booAft, "booster")}</g>` : "";
    const susG = `<g class="sustainer-g">${sus.map(partShape).join("")}${motorShape(s, susAft, susAftTube, "sustainer")}${flame(s, susAft, "sustainer")}</g>`;
    const susMx = s ? X(susAft) - (Math.min(s.length_mm * IN_PER_MM, susAftTube ? susAftTube.length_in * 0.96 : 1e9) * ppi) / 2 : X(susAft / 2);
    const booMx = b && boo.length ? X(booAft) - (Math.min(b.length_mm * IN_PER_MM, booHost.length_in * 0.96) * ppi) / 2 : X((susAft + booAft) / 2);
    const topY = cy - rMax - maxSpan, botY = cy + rMax + maxSpan;
    const tag = (x: number, y: number, cls: string, text: string) => `<text class="tag ${cls}" x="${x.toFixed(1)}" y="${y.toFixed(1)}" text-anchor="middle">${esc(text)}</text>`;
    const anno = `<g class="anno">${tag(susMx, 14, "sustainer", s ? s.label : "sustainer ?")}${boo.length ? tag(booMx, H - 6, "booster", b ? b.label : "booster ?") : ""}<line class="sepline" x1="${X(susAft).toFixed(1)}" y1="${(topY - 6).toFixed(1)}" x2="${X(susAft).toFixed(1)}" y2="${(botY + 6).toFixed(1)}"><title>separation plane</title></line><g class="sepgap"><line x1="${(X(susAft) + 4).toFixed(1)}" y1="${(cy + rMax + 8).toFixed(1)}" x2="${(X(susAft) + GAP - 4).toFixed(1)}" y2="${(cy + rMax + 8).toFixed(1)}"/></g></g>`;
    return `<svg viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" style="--sep-gap:${GAP}px">${defs}${booG}${susG}${anno}</svg>`;
  }, [geo, b, s, W]);
  if (!geo || !geo.parts || !geo.parts.length) return <Problem tone="info">no vehicle geometry — the CDX1 file could not be read{geo && geo.error ? ` (${geo.error})` : ""}</Problem>;
  const id = PHASE_DEFS[snap.phase].id;
  const what: Record<string, string> = { boost: `${r.booster} burning, stack attached`, sep_delay: "coasting attached, about to separate", ign_delay: "separated, sustainer coasting before ignition", sustain: `${s ? s.label : "sustainer"} burning`, coast: `coasting to apogee${isNum(r.apogee_ft) ? " at " + fmt(r.apogee_ft, 0) + " ft" : ""}` };
  return <div><div ref={ref} className="rocket-svg" data-phase={id} dangerouslySetInnerHTML={{ __html: svg }} /><div className="mt-1 text-[12px] text-ink-2">{PHASE_DEFS[snap.phase].name} · {what[id]} · t = {fmt(snap.t, snap.t < 60 ? 2 : 1)} s</div></div>;
}

/* ---- ascent track ---------------------------------------------------------------- */
const machZone = (mach: number | null, cfg: any) => !isNum(mach) ? "" : mach >= cfg.profiles.supersonic_min_mach ? "err" : mach <= cfg.profiles.subsonic_max_mach ? "ok" : "warn";
export function AscentTrack({ r, cfg, d, T, snap }: { r: any; cfg: any; d: any; T: T6; snap: Snap }) {
  // The box is sized by the grid row (h-full); the SVG sits absolutely inside
  // it so its own size never feeds back into the measurement.
  const ref = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ W: 0, H: 0 });
  useLayoutEffect(() => {
    const el = ref.current; if (!el) return;
    const update = () => { const W = Math.max(90, Math.round(el.clientWidth)), H = Math.max(150, Math.round(el.clientHeight)); setSize((s) => (s.W === W && s.H === H ? s : { W, H })); };
    update();
    const ro = new ResizeObserver(update); ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const { W, H } = size;
  const target = d.target_ft, tol = d.tolerance_ft;
  const top = Math.max(r.apogee_ft || 0, target || 0, r.alt_at_ign_ft || 0, 1000) * 1.1;
  const gx = 34, gTop = 22, gBot = H - 12, cx = gx + (W - 8 - gx) / 2, right = W - 8;
  const y = (alt: number) => gBot - Math.max(0, Math.min(1, (alt || 0) / top)) * (gBot - gTop);
  const tickLbl = (v: number) => (Math.abs(v) >= 1000 ? (v / 1000).toFixed(v % 1000 ? 1 : 0) + "k" : fmt(v, 0));
  const sepRef = useRef<number | null>(null);
  const yy = isNum(snap.alt) ? y(snap.alt) : y(0);
  let booster: { y: number; rot: number; op: number } | null = null;
  if (isNum(T[2]) && snap.t >= (T[2] as number)) { if (sepRef.current === null) sepRef.current = isNum(snap.alt) ? snap.alt : 0; const dt = snap.t - (T[2] as number); booster = { y: Math.min(gBot - 6, y(sepRef.current) + 30 * dt * dt), rot: dt * 25, op: Math.max(0, 1 - dt / 6) }; } else sepRef.current = null;
  const gauge = () => { const sub = cfg.profiles.subsonic_max_mach, sup = cfg.profiles.supersonic_min_mach; const gmax = Math.max(sup * 1.5, (r.max_mach || 0) * 1.1, 1.6); const x = (m: number) => Math.max(0, Math.min(100, (m / gmax) * 100)); return <div className="mach-gauge mt-1"><svg viewBox="0 0 100 8" preserveAspectRatio="none"><rect className="mg-sub" x="0" y="0" width={x(sub)} height="8" /><rect className="mg-trans" x={x(sub)} y="0" width={x(sup) - x(sub)} height="8" /><rect className="mg-sup" x={x(sup)} y="0" width={100 - x(sup)} height="8" /><rect className="mg-mark" x={isNum(snap.mach) ? Math.max(0, x(snap.mach) - 1) : 0} y="0" width="2" height="8" /></svg></div>; };
  const Tile = ({ label, value, zone, extra }: { label: string; value: string; zone?: string; extra?: ReactNode }) => <div className={cn("stat !min-w-0 !px-2.5 !py-1.5", zone === "ok" && "ok", zone === "warn" && "warn", zone === "err" && "bad")}><div className="stat-label">{label}</div><div className="stat-value !text-[14px]">{value}</div>{extra}</div>;
  return <div className="flex min-h-[280px] flex-1 gap-2">
    <div ref={ref} className="ascent-svg relative min-w-0 flex-1 self-stretch">
      {W && H ? <svg className="absolute inset-0" width={W} height={H} viewBox={`0 0 ${W} ${H}`}>
        <defs><linearGradient id="rk-flame-grad" x1="0" y1="0" x2="0" y2="1"><stop offset="0" style={{ stopColor: "var(--flame-0)" }} /><stop offset=".45" style={{ stopColor: "var(--flame-1)" }} /><stop offset="1" style={{ stopColor: "var(--bad)", stopOpacity: 0 }} /></linearGradient></defs>
        <g className="axis">{niceTicks(0, top, H > 300 ? 6 : 4).map((v) => <g key={v}><line className="grid" x1={gx} x2={right} y1={y(v)} y2={y(v)} /><text className="axis-lbl" x={gx - 5} y={y(v) + 3.5} textAnchor="end">{tickLbl(v)}</text></g>)}</g>
        {isNum(target) && isNum(tol) ? <rect className="tol-band" x={gx} y={y(target + tol)} width={right - gx} height={Math.max(0, y(target - tol) - y(target + tol))} /> : null}
        {isNum(target) ? <><line className="target-line" x1={gx} x2={right} y1={y(target)} y2={y(target)}><title>target {fmt(target, 0)} ft</title></line><text className="target-lbl" x={right - 8} y={y(target) - 3} textAnchor="end">target</text></> : null}
        <line className="ground" x1={gx} x2={right} y1={y(0)} y2={y(0)} />
        {isNum(r.apogee_ft) ? <circle className="ev-dot apogee" cx={right} cy={y(r.apogee_ft)} r="3"><title>apogee {fmt(r.apogee_ft, 0)} ft</title></circle> : null}
        {isNum(r.alt_at_ign_ft) ? <circle className="ev-dot ign" cx={right} cy={y(r.alt_at_ign_ft)} r="3"><title>ignition {fmt(r.alt_at_ign_ft, 0)} ft</title></circle> : null}
        <g opacity={booster ? booster.op : 0} transform={booster ? `translate(${cx.toFixed(1)},${booster.y.toFixed(1)}) rotate(${booster.rot.toFixed(1)})` : `translate(${cx},${gBot})`}><rect className="rk-booster" x="-3.6" y="-7" width="7.2" height="14" rx="1.6" /><path className="rk-booster-fin" d="M-3.6,0 L-8,7 L-3.6,5 Z M3.6,0 L8,7 L3.6,5 Z" /></g>
        <g transform={`translate(${cx.toFixed(1)},${yy.toFixed(1)})`}><path className="rk-fin" d="M-4.2,-7 L-10,4.5 L-10,6 L-4.2,2.5 Z M4.2,-7 L10,4.5 L10,6 L4.2,2.5 Z" /><path className="rk-body" d="M0,-28 C3.2,-24 4.2,-19 4.2,-12 L4.2,3 L-4.2,3 L-4.2,-12 C-4.2,-19 -3.2,-24 0,-28 Z" /><path className="rk-nose" d="M0,-28 C2.3,-25 3.5,-22 3.9,-18 L-3.9,-18 C-3.5,-22 -2.3,-25 0,-28 Z" /><circle className="rk-win" cx="0" cy="-10.5" r="2.1" /><path className="rk-noz" d="M-2.6,3 L-3.6,6.5 L3.6,6.5 L2.6,3 Z" /><path className={cn("rk-flame", snap.firing && "on")} fill="url(#rk-flame-grad)" d="M-3.4,6.5 C-4.6,12 -2.4,17 0,23 C2.4,17 4.6,12 3.4,6.5 Z" /></g>
      </svg> : null}
    </div>
    <div className="flex w-[120px] shrink-0 flex-col gap-1.5">
      <Tile label="altitude" value={isNum(snap.alt) ? fmt(snap.alt, 0) + " ft" : "—"} />
      <Tile label="Mach" value={isNum(snap.mach) ? fmt(snap.mach, 2) : "—"} zone={machZone(snap.mach, cfg)} extra={gauge()} />
      <Tile label="velocity" value={isNum(snap.vel) ? fmt(snap.vel, 0) + " fps" : "—"} />
      <Tile label="t" value={fmt(snap.t, snap.t < 60 ? 1 : 0) + " s"} />
    </div>
  </div>;
}

/* ---- staging timeline + thrust lane -------------------------------------------------- */
export function StagingTimeline({ dz, player, T }: { dz: any; player: Player; T: T6 }) {
  const [ref, W] = useWidth<HTMLDivElement>(320);
  const end = player.end, snap = player.snap;
  const x0 = 20, MR = 20, barY = 24, barH = 24, tickY = barY + barH + 4, labelY = 62;
  const lensLo = T[1], lensHi = T[3];
  const showLens = isNum(lensLo) && isNum(lensHi) && lensHi > lensLo && lensHi - lensLo < 0.12 * end;
  const padded = showLens ? [(lensLo as number) - ((lensHi as number) - (lensLo as number)) * 0.6, (lensHi as number) + ((lensHi as number) - (lensLo as number)) * 0.6] : null;
  const lensY = 84, lensH = 22, H = showLens ? lensY + lensH + 40 : 76, laneH = 56;
  const x1 = W - MR;
  const xAt = (t: number) => x0 + Math.max(0, Math.min(1, t / end)) * (x1 - x0);
  const lensX = (t: number) => x0 + Math.max(0, Math.min(1, (t - (padded as number[])[0]) / ((padded as number[])[1] - (padded as number[])[0]))) * (x1 - x0);
  const dragging = useRef(false);
  useEffect(() => { const up = () => { dragging.current = false; }; window.addEventListener("mouseup", up); return () => window.removeEventListener("mouseup", up); }, []);
  const timeAt = (ev: React.MouseEvent<SVGSVGElement>) => { const rect = ev.currentTarget.getBoundingClientRect(); const px = ((ev.clientX - rect.left) / rect.width) * W; return Math.max(0, Math.min(end, ((px - x0) / (x1 - x0)) * end)); };
  const scrub = { onMouseDown: (e: React.MouseEvent<SVGSVGElement>) => { dragging.current = true; player.seek(timeAt(e)); }, onMouseMove: (e: React.MouseEvent<SVGSVGElement>) => (dragging.current ? player.seek(timeAt(e)) : player.preview(timeAt(e))), onMouseLeave: () => { dragging.current = false; player.clearPreview(); } };
  const px = xAt(snap.t);
  const segX = PHASE_DEFS.map((_, i) => (isNum(T[i]) ? xAt(T[i] as number) : null));
  const peak = Math.max((dz.booster && dz.booster.peak_thrust_n) || 0, (dz.sustainer && dz.sustainer.peak_thrust_n) || 0) || 1;
  const areaPath = (curve: any, t0: number) => { if (!curve || !curve.t.length) return ""; let d = `M${xAt(t0).toFixed(1)},${laneH}`; for (let i = 0; i < curve.t.length; i++) d += `L${xAt(t0 + curve.t[i]).toFixed(1)},${(laneH - (curve.f[i] / peak) * laneH).toFixed(1)}`; return d + `L${xAt(t0 + curve.t[curve.t.length - 1]).toFixed(1)},${laneH}Z`; };
  const bPath = dz.booster ? areaPath(dz.booster.curve, 0) : "", sPath = dz.sustainer && isNum(T[3]) ? areaPath(dz.sustainer.curve, T[3] as number) : "";
  const uid = useMemo(() => "lane" + Math.random().toString(36).slice(2, 7), []);
  let lastX = -Infinity, row = 0;
  return <div ref={ref}>
    {W ? <>
      <div className="timeline-svg"><svg viewBox={`0 0 ${W} ${H}`} width={W} height={H} {...scrub}>
        <g className="ev-mark"><line x1={x0} x2={x0} y1={barY - 8} y2={barY} /><text x={x0} y={barY - 11} textAnchor="start">liftoff</text></g>
        {isNum(T[5]) ? <g className="ev-mark"><line x1={xAt(T[5] as number)} x2={xAt(T[5] as number)} y1={barY - 8} y2={barY} /><text x={xAt(T[5] as number)} y={barY - 11} textAnchor="end">apogee</text></g> : null}
        {PHASE_DEFS.map((p, i) => { const xa = segX[i], xb = segX[i + 1]; if (!isNum(xa) || !isNum(xb)) return null; const durTxt = `${fmt((T[i + 1] as number) - (T[i] as number), (T[i + 1] as number) - (T[i] as number) < 10 ? 2 : 1)} s`; return <g key={p.id}><rect className={`seg-base ${p.id}`} x={xa} y={barY} width={xb - xa} height={barH} rx="3"><title>{p.name}: {durTxt} ({fmt(T[i], 2)} s to {fmt(T[i + 1], 2)} s)</title></rect><rect className={`seg-fill ${p.id}`} x={xa} y={barY} width={Math.max(0, Math.min(xb, px) - xa)} height={barH} rx="3" />{!showLens && (i === 1 || i === 2) && xb - xa > 40 ? <text className="seg-label" x={(xa + xb) / 2} y={barY + barH / 2 + 4} textAnchor="middle">{i === 1 ? "sep" : "ign"}</text> : null}</g>; })}
        {niceTicks(0, end, W > 700 ? 8 : 5).map((v) => <g key={v}><line className="tick" x1={xAt(v)} x2={xAt(v)} y1={barY + barH} y2={tickY} /><text x={xAt(v)} y={labelY} textAnchor="middle">{fmt(v, 0)}s</text></g>)}
        {showLens ? <>
          <line className="lens-guide" x1={xAt((padded as number[])[0])} y1={barY + barH} x2={x0} y2={lensY} /><line className="lens-guide" x1={xAt((padded as number[])[1])} y1={barY + barH} x2={x1} y2={lensY} />
          <rect className="lens-bg" x={x0} y={lensY} width={x1 - x0} height={lensH} rx="3" />
          {[1, 2].map((i) => { const xa = lensX(T[i] as number), xb = lensX(T[i + 1] as number), lx = lensX(snap.t); return <g key={i}><rect className={`seg-base ${PHASE_DEFS[i].id}`} x={xa} y={lensY} width={xb - xa} height={lensH} rx="2" /><rect className={`seg-fill ${PHASE_DEFS[i].id}`} x={xa} y={lensY} width={Math.max(0, Math.min(xb, lx) - xa)} height={lensH} rx="2" /></g>; })}
          {([[T[1], "burnout"], [T[2], "separation"], [T[3], "ignition"]] as [number, string][]).map(([tt, label]) => { const xx = lensX(tt); row = xx - lastX < 104 ? row + 1 : 0; lastX = xx; const ly = lensY + lensH + 16 + row * 13; return <g key={label}><line className="ev-tick" x1={xx} x2={xx} y1={lensY - 4} y2={lensY + lensH + 4} /><text className="ev-label" x={xx} y={ly} textAnchor="middle">{label} {fmt(tt, 2)}s</text></g>; })}
          <line className="playhead" x1={lensX(snap.t)} x2={lensX(snap.t)} y1={lensY - 6} y2={lensY + lensH + 6} />
        </> : null}
        <line className="playhead" x1={px} x2={px} y1={barY - 10} y2={showLens ? lensY : barY + barH} />
      </svg></div>
      <div className="my-1 flex flex-wrap gap-1">{PHASE_DEFS.map((p, i) => { const d = isNum(T[i]) && isNum(T[i + 1]) ? (T[i + 1] as number) - (T[i] as number) : null; return <Chip key={p.id} sm className={cn("phase-chip", p.id)} on={snap.phase === i} disabled={!isNum(T[i])} onClick={() => isNum(T[i]) && player.seek(T[i] as number)}><span className="dot" /><span>{p.name}</span><span className="text-ink-3 num">{isNum(d) ? fmt(d, d < 10 ? 2 : 1) + " s" : "?"}</span></Chip>; })}</div>
      <div className="thrust-lane"><svg viewBox={`0 0 ${W} ${laneH}`} width={W} height={laneH} {...scrub}>
        <clipPath id={uid}><rect x="0" y="0" width={Math.max(0, px)} height={laneH} /></clipPath>
        {bPath ? <path className="lane-area dim booster" d={bPath} /> : null}{sPath ? <path className="lane-area dim sustainer" d={sPath} /> : null}
        <g clipPath={`url(#${uid})`}>{bPath ? <path className="lane-area bright booster" d={bPath} /> : null}{sPath ? <path className="lane-area bright sustainer" d={sPath} /> : null}</g>
        <line className="playhead" x1={px} x2={px} y1="0" y2={laneH} />
      </svg></div>
    </> : null}
  </div>;
}

/* ---- thrust chart + motor panel ----------------------------------------------------- */
export function ThrustChart({ m, color, kind, T, snap }: { m: any; color: string; kind: "booster" | "sustainer"; T: T6; snap: Snap }) {
  const [ref, W] = useWidth<HTMLDivElement>(260);
  const [tip, setTip] = useState<{ x: number; y: number; t: number; f: number } | null>(null);
  const c = m.curve;
  const H = 170, ml = 56, mr = 14, mt = 16, mb = 26, ih = H - mt - mb, iw = W - ml - mr;
  const tmax = c.t[c.t.length - 1] || 1, fmax = (Math.max(...c.f) || 1) * 1.12;
  const sx = (t: number) => ml + (t / tmax) * iw, sy = (f: number) => mt + ih - (f / fmax) * ih;
  const findIdx = (tv: number) => { let lo = 0, hi = c.t.length - 1; while (lo < hi) { const mid = (lo + hi) >> 1; if (c.t[mid] < tv) lo = mid + 1; else hi = mid; } return lo; };
  const peakIdx = c.f.indexOf(Math.max(...c.f));
  const burnEnd = kind === "booster" ? T[1] : T[4], burnStart = kind === "booster" ? 0 : T[3];
  const active = isNum(burnStart) && isNum(burnEnd) && snap.t >= burnStart && snap.t <= burnEnd;
  const localT = active ? Math.min(snap.t - (burnStart as number), tmax) : null;
  let path = `M${sx(0).toFixed(1)},${sy(0).toFixed(1)}`;
  for (let i = 0; i < c.t.length; i++) path += `L${sx(c.t[i]).toFixed(1)},${sy(c.f[i]).toFixed(1)}`;
  const area = path + `L${sx(tmax).toFixed(1)},${sy(0).toFixed(1)}Z`;
  const peakX = sx(c.t[peakIdx]), peakY = sy(c.f[peakIdx]), flip = peakX > ml + iw * 0.7;
  const uid = useMemo(() => "cf" + Math.random().toString(36).slice(2, 7), []);
  const revealW = active ? Math.max(0, sx(localT as number) - ml) : isNum(burnEnd) && snap.t > burnEnd ? iw : 0;
  return <div ref={ref} className={cn("thrust-chart relative", active && "burning")} onMouseMove={(ev) => { const rect = ev.currentTarget.getBoundingClientRect(); const px = ((ev.clientX - rect.left) / rect.width) * W; if (px < ml || px > W - mr) { setTip(null); return; } const tv = Math.max(0, Math.min(tmax, ((px - ml) / iw) * tmax)); setTip({ x: ev.clientX - rect.left, y: ev.clientY - rect.top, t: tv, f: c.f[findIdx(tv)] }); }} onMouseLeave={() => setTip(null)}>
    {W ? <svg viewBox={`0 0 ${W} ${H}`} width={W} height={H}>
      <g className="grid">{niceTicks(0, fmax, 5).map((v) => <line key={v} x1={ml} x2={W - mr} y1={sy(v)} y2={sy(v)} />)}</g>
      <g className="axis">{niceTicks(0, fmax, 5).map((v) => <text key={v} x={ml - 6} y={sy(v) + 3.5} textAnchor="end">{fmt(v, 0)}</text>)}{niceTicks(0, tmax, W > 420 ? 6 : 4).map((v) => <g key={v}><line x1={sx(v)} x2={sx(v)} y1={mt + ih} y2={mt + ih + 4} /><text x={sx(v)} y={mt + ih + 16} textAnchor="middle">{fmt(v, v < 10 ? 1 : 0)}s</text></g>)}<text transform={`translate(11,${mt + ih / 2}) rotate(-90)`} textAnchor="middle">thrust [N]</text></g>
      <path className="area" d={area} fill={color} /><line className="avg-line" x1={ml} x2={W - mr} y1={sy(m.avg_thrust_n)} y2={sy(m.avg_thrust_n)} /><path className="line" d={path} stroke={color} />
      <circle className="peak-dot" cx={peakX} cy={peakY} r="3" fill={color} />
      <text className="peak-label" x={peakX + (flip ? -6 : 6)} y={peakY - 6} textAnchor={flip ? "end" : "start"}>peak {fmt(c.f[peakIdx], 0)} N</text>
      <text className="avg-label" x={W - mr - 3} y={sy(m.avg_thrust_n) - 4} textAnchor="end">avg {fmt(m.avg_thrust_n, 0)} N</text>
      <clipPath id={uid}><rect x={ml} y="0" width={revealW} height={H} /></clipPath>
      <path className="line bright" clipPath={`url(#${uid})`} d={path} stroke={color} />
      {active ? <circle className="cursor" r="4" fill={color} cx={sx(localT as number)} cy={sy(c.f[findIdx(localT as number)])} /> : null}
      {tip ? <line className="hover-line" x1={sx(tip.t)} x2={sx(tip.t)} y1={mt} y2={mt + ih} /> : null}
    </svg> : null}
    {tip ? <div className="pointer-events-none absolute z-10 tip glass-strong !text-[11px] num" style={{ left: tip.x + 14 + 150 > W ? tip.x - 160 : tip.x + 14, top: Math.max(0, tip.y - 10) }}><div><b>t</b> {fmt(tip.t, 2)} s</div><div><span style={{ color }}>thrust</span> {fmt(tip.f, 0)} N</div></div> : null}
  </div>;
}
export function MotorPanel({ kind, m, err, r, T, snap }: { kind: "booster" | "sustainer"; m: any; err?: string; r: any; T: T6; snap: Snap }) {
  const color = kind === "booster" ? "var(--booster)" : "var(--sustainer)";
  const head = (name: ReactNode, extra?: ReactNode) => <span className="flex flex-wrap items-center gap-2 normal-case tracking-normal"><span className={cn("stage-tag", kind)}>{kind}</span><b className="text-[13px] text-ink">{name}</b>{extra}</span>;
  if (!m) return <Module title={head(kind === "booster" ? r.booster : r.sustainer || "—")}><Problem tone="warn">{err || "motor not found"}</Problem></Module>;
  const burnEnd = kind === "booster" ? T[1] : T[4], burnStart = kind === "booster" ? 0 : T[3];
  const burning = isNum(burnStart) && isNum(burnEnd) && snap.t >= burnStart && snap.t <= burnEnd;
  return <Module title={head(m.label, <>{m.designation !== m.label ? <span className="text-[12px] font-normal text-ink-3">{m.designation}</span> : null}{burning ? <Pill tone="info" lower>burning</Pill> : null}</>)} extra={<a className="link" href={`${BASE}/download/eng?kind=${kind}&label=${encodeURIComponent(m.label)}`} download title={`download ${m.label}.eng`}><Icon of={Download} size="xs" />.eng</a>}>
    <StatGrid className="mb-2"><Stat label="total impulse" value={fmt(m.total_impulse_ns, 0)} unit={`N·s${m.impulse_class ? " · " + m.impulse_class : ""}`} /><Stat label="burn time" value={fmt(m.burn_time_s, 2)} unit="s" /><Stat label="avg / peak" value={`${fmt(m.avg_thrust_n, 0)} / ${fmt(m.peak_thrust_n, 0)}`} unit="N" /><Stat label="propellant" value={fmt(m.prop_mass_kg, 2)} unit="kg" sub={`${fmt(m.prop_mass_kg * KG_TO_LB, 2)} lb`} /><Stat label="size" value={`${fmt(m.diameter_mm, 0)} × ${fmt(m.length_mm, 0)}`} unit="mm" /><Stat label="nozzle throat / exit" value={`${fmt(m.nozzle_throat_in, 2)} / ${fmt(m.nozzle_exit_in, 2)}`} unit="in" /></StatGrid>
    <ThrustChart m={m} color={color} kind={kind} T={T} snap={snap} />
    <div className="mt-1 font-mono text-[11px] text-ink-3 truncate" title={m.file}>{m.file.split("/").pop()}{m.n_in_file > 1 ? ` (motor ${m.designation} of ${m.n_in_file})` : ""}</div>
  </Module>;
}

/* ---- the whole flight configuration card --------------------------------------------- */
export function FlightConfig({ r, dz, hist, histKind, cfg, d, onPlayerChange }: { r: any; dz: any; hist: Hist; histKind: string | null; cfg: any; d: any; onPlayerChange?: (p: Player) => void }) {
  const b = dz.booster, s = dz.sustainer;
  const sLabel = s ? s.label : r.sustainer || "";
  const T = useMemo(() => stagingTimes(r, dz), [r, dz]);
  const end = isNum(T[5]) ? (T[5] as number) * 1.04 : isNum(T[4]) ? (T[4] as number) * 1.25 : isNum(T[1]) ? (T[1] as number) * 5 : 10;
  const key = `${r.booster}|${sLabel}|${r.profile}`;
  const player = usePlayer(end, T, hist, key);
  useEffect(() => { onPlayerChange?.(player); }, [player.snap, player.playing]); // eslint-disable-line react-hooks/exhaustive-deps
  const canZip = !!(b && s);
  const q = `booster=${encodeURIComponent(r.booster)}&sustainer=${encodeURIComponent(sLabel)}`;
  const seekEvent = (dir: 1 | -1) => { const ts = T.filter(isNum) as number[]; const t = player.t; const next = dir > 0 ? ts.find((x) => x > t + 1e-6) : ts.slice().reverse().find((x) => x < t - 1e-6); player.seek(next ?? (dir > 0 ? player.end : 0)); };
  return <div className="glass card static flight-config" tabIndex={0} onKeyDown={(e) => { if (e.code === "Space") { e.preventDefault(); player.toggle(); } else if (e.code === "ArrowRight") { e.preventDefault(); player.seek(player.t + (e.shiftKey ? 1 : 0.1)); } else if (e.code === "ArrowLeft") { e.preventDefault(); player.seek(player.t - (e.shiftKey ? 1 : 0.1)); } else if (e.code === "Home") { e.preventDefault(); player.seek(0); } else if (e.code === "End") { e.preventDefault(); player.seek(player.end); } }}>
    <div className="flex flex-wrap items-center gap-2 border-b border-line pb-3"><span className="card-title">Flight configuration</span>{histKind === "estimated" ? <Pill tone="warn" title="estimate; run verify for the checked flight">estimated</Pill> : histKind === "verified" ? <Pill tone="good">verified</Pill> : null}<span className="flex-1" />
      {b ? <a className="link" href={`${BASE}/download/eng?kind=booster&label=${encodeURIComponent(b.label)}`} download><Icon of={Download} size="xs" />booster</a> : null}{s ? <a className="link" href={`${BASE}/download/eng?kind=sustainer&label=${encodeURIComponent(sLabel)}`} download><Icon of={Download} size="xs" />sustainer</a> : null}
      <Button variant="primary" size="sm" asChild disabled={!canZip}><a href={canZip ? `${BASE}/download/combo?${q}&profile=${encodeURIComponent(r.profile || "")}` : undefined} download onClick={(e) => { if (!canZip) { e.preventDefault(); toast.error("cannot build the combo: a motor is missing"); } else toast(`downloading ${r.booster} + ${sLabel} motor combo`); }}><Icon of={Download} size="sm" />combo</a></Button></div>
    <div className="grid gap-3 lg:grid-cols-[minmax(0,3fr)_minmax(0,2fr)] mt-3">
      <div className="flex flex-col gap-3">
        <Module title="Vehicle" extra={<>{(dz.vehicle && dz.vehicle.file) || "?"} · {dz.vehicle ? fmt(dz.vehicle.total_length_in, 1) : "?"} in overall · {dz.vehicle ? fmt(dz.vehicle.max_diameter_in, 2) : "?"} in dia</>}><RocketDiagram r={r} dz={dz} snap={player.snap} /></Module>
        <Module title="Timeline" extra={<><IconButton icon={SkipBack} label="previous event" onClick={() => seekEvent(-1)} className="!w-7 !h-7" /><Button size="sm" variant="primary" title="play / pause (space)" onClick={player.toggle} className="!px-2.5"><Icon of={player.playing ? Pause : Play} size="sm" />{player.playing ? "pause" : "play"}</Button><IconButton icon={SkipForward} label="next event" onClick={() => seekEvent(1)} className="!w-7 !h-7" /><Segmented sm value={player.speed} options={[1, 2, 4, 8].map((x) => ({ value: x, label: `${x}x` }))} onChange={(x) => player.setSpeed(x)} /><span className="ml-1 text-ink-3 hidden xl:inline"><Kbd>space</Kbd> play · <Kbd>arrows</Kbd> step · <Kbd>shift</Kbd> x10</span></>}><StagingTimeline dz={dz} player={player} T={T} /></Module>
      </div>
      <Module title="Ascent" bodyClass="flex flex-col"><AscentTrack r={r} cfg={cfg} d={d} T={T} snap={player.snap} /></Module>
    </div>
    <div className="mt-3 grid gap-3 md:grid-cols-2"><MotorPanel kind="booster" m={b} err={dz.booster_error} r={r} T={T} snap={player.snap} /><MotorPanel kind="sustainer" m={s} err={dz.sustainer_error} r={r} T={T} snap={player.snap} /></div>
  </div>;
}
