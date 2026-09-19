/* The app's charts: lines, scatter, the flight time history and its
   overlay. Every colour is a token name resolved at render. */
import { useMemo } from "react";
import { fmt, isNum } from "@/lib/format";
import { useAppState } from "@/lib/store";
import { EVENT_TOKENS, series as seriesTok, tok, v } from "@/lib/tokens";
import { cn } from "@/lib/utils";
import { useUi } from "@/store/ui";
import { Segmented } from "@/components/ui";
import { Chart } from "./Chart";
import { axisStyle, base, legendStyle, tickFmt, tipRows, type ECOption } from "./theme";

export { Chart };
export { SERIES as PALETTE_TOKENS } from "@/lib/tokens";

export type Series = { name: string; x: (number | null)[]; y: (number | null)[]; color?: string; axis?: "y2"; dash?: boolean; width?: number; points?: boolean };
/** A reference line; `color` is a token name such as "--limit". */
export type Ref = { y: number; label?: string; color?: string; axis?: "y2" };
export type Marker = { x: number; label: string; color?: string };

/** Hooks the option memo to the theme so a flip rebuilds it from fresh tokens. */
export const useChartTheme = () => useUi((s) => s.resolved);

export function LineChart({ series, xLabel, yLabel, y2Label, refs = [], markers = [], markerLabels = true, height = 280, onHover, onLeave, points, legend = true }:
  { series: Series[]; xLabel?: string; yLabel?: string; y2Label?: string; refs?: Ref[]; markers?: Marker[]; markerLabels?: boolean; height?: number; onHover?: (x: number) => void; onLeave?: () => void; points?: boolean; legend?: boolean }) {
  const theme = useChartTheme();
  const option = useMemo<ECOption>(() => {
    const vis = series.filter((s) => s.x && s.x.length);
    const hasY2 = vis.some((s) => s.axis === "y2");
    const firstOf = (y2: boolean) => vis.findIndex((s) => (s.axis === "y2") === y2);
    const ax = axisStyle();
    const b = base();
    return {
      ...b,
      grid: { ...(b.grid as object), left: 56, right: hasY2 ? 62 : 24, top: 28, bottom: legend && vis.length > 1 ? 50 : 42 },
      legend: legend && vis.length > 1 ? legendStyle() : { show: false },
      tooltip: { ...(b.tooltip as object), trigger: "axis", axisPointer: { type: "line", lineStyle: { color: tok("--ink-3") } }, valueFormatter: (val: any) => fmt(val) },
      xAxis: { type: "value", name: xLabel, nameLocation: "middle", nameGap: 26, ...ax, axisLabel: { ...ax.axisLabel, formatter: (val: number) => tickFmt(val) }, scale: true },
      yAxis: [
        { type: "value", name: yLabel, nameLocation: "middle", nameGap: 44, ...ax, axisLabel: { ...ax.axisLabel, formatter: (val: number) => tickFmt(val) }, scale: true },
        ...(hasY2 ? [{ type: "value", name: y2Label, nameLocation: "middle", nameGap: 48, ...ax, splitLine: { show: false }, axisLabel: { ...ax.axisLabel, formatter: (val: number) => tickFmt(val) }, scale: true }] : []),
      ],
      series: vis.map((s, i) => {
        const color = tok(s.color || seriesTok(i));
        const mine = i === firstOf(s.axis === "y2");
        return {
          name: s.name, type: "line", yAxisIndex: s.axis === "y2" ? 1 : 0, showSymbol: !!(s.points || points), symbolSize: 6, sampling: "lttb",
          data: s.x.map((xv, k) => [xv, s.y[k]]).filter(([a, c]) => isNum(a) && isNum(c)),
          lineStyle: { width: s.width || 1.8, type: s.dash ? "dashed" : "solid" }, itemStyle: { color }, connectNulls: false, emphasis: { focus: "none" },
          markLine: mine ? {
            silent: true, symbol: "none", animation: false,
            label: { position: "insideEndTop", fontSize: 10, color: tok("--ink-3") },
            data: [
              ...refs.filter((r) => (r.axis === "y2") === (s.axis === "y2")).map((r) => ({ yAxis: r.y, name: r.label, lineStyle: { color: tok(r.color || "--ink-3"), type: "dashed" }, label: { formatter: r.label, color: tok(r.color || "--ink-3") } })),
              ...(i === 0 ? markers : []).map((m) => ({ xAxis: m.x, name: m.label, lineStyle: { color: tok(m.color || "--ink-3"), type: "dashed" }, label: markerLabels ? { formatter: m.label, color: tok(m.color || "--ink-3"), position: "insideStartTop" } : { show: false } })),
            ],
          } : undefined,
        };
      }),
    };
  }, [series, xLabel, yLabel, y2Label, refs, markers, markerLabels, points, legend, theme]);
  const events = useMemo(() => ({ updateAxisPointer: (e: any) => { const val = e?.axesInfo?.[0]?.value; if (onHover && isNum(val)) onHover(val); }, globalout: () => onLeave?.() }), [onHover, onLeave]);
  return <Chart option={option} height={height} onEvents={events} />;
}

export type ScatterPoint = { x: number; y: number; key: string; row: any };
export function ScatterChart({ points, xLabel, yLabel, band, xrefs = [], height = 320, color, shape, onClick, selectedKey, tip }:
  { points: ScatterPoint[]; xLabel?: string; yLabel?: string; band?: { y0: number; y1: number; label?: string }; xrefs?: { x: number; label?: string; color?: string }[]; height?: number;
    color?: (p: ScatterPoint) => string; shape?: (p: ScatterPoint) => string; onClick?: (p: ScatterPoint) => void; selectedKey?: string | null; tip?: (p: ScatterPoint) => [string, string][] }) {
  const theme = useChartTheme();
  const option = useMemo<ECOption>(() => {
    const ax = axisStyle();
    const b = base();
    return {
      ...b,
      tooltip: { ...(b.tooltip as object), trigger: "item", formatter: (p: any) => tipRows(tip ? tip(p.data.p) : [[xLabel || "x", fmt(p.data.p.x)], [yLabel || "y", fmt(p.data.p.y)]]) },
      xAxis: { type: "value", name: xLabel, nameLocation: "middle", nameGap: 26, ...ax, scale: true, axisLabel: { ...ax.axisLabel, formatter: (val: number) => tickFmt(val) } },
      yAxis: { type: "value", name: yLabel, nameLocation: "middle", nameGap: 48, ...ax, scale: true, axisLabel: { ...ax.axisLabel, formatter: (val: number) => tickFmt(val) } },
      series: [{
        type: "scatter",
        data: points.map((p) => ({
          value: [p.x, p.y], p, symbol: (shape?.(p) || "circle") === "square" ? "rect" : shape?.(p) || "circle", symbolSize: p.key === selectedKey ? 15 : 9,
          itemStyle: { color: tok(color?.(p) || "--series-1"), opacity: 0.85, borderColor: p.key === selectedKey ? tok("--ink") : undefined, borderWidth: p.key === selectedKey ? 2 : 0 },
        })),
        emphasis: { scale: 1.3 },
        markArea: band ? { silent: true, itemStyle: { color: tok("--band") }, label: { position: "insideRight", fontSize: 10, color: tok("--good") }, data: [[{ yAxis: band.y0, name: band.label }, { yAxis: band.y1 }]] } : undefined,
        markLine: xrefs.length ? { silent: true, symbol: "none", animation: false, label: { fontSize: 10, position: "insideEndTop" }, data: xrefs.map((r) => ({ xAxis: r.x, name: r.label, lineStyle: { color: tok(r.color || "--ink-3"), type: "dashed" }, label: { formatter: r.label, color: tok(r.color || "--ink-3") } })) } : undefined,
      }],
    };
  }, [points, xLabel, yLabel, band, xrefs, color, shape, selectedKey, tip, theme]);
  return <Chart option={option} height={height} onEvents={{ click: (e: any) => e?.data?.p && onClick?.(e.data.p) }} />;
}

/* ---------------------------------------------------- flight history */

export type HistoryFrame = { n: number; stride: number; columns: Record<string, (number | null)[]>; summary: Record<string, number | null> };
export const EVENT_COLORS = EVENT_TOKENS;

/* Last instant with thrust after ignition (the sustainer's burnout). */
export function sustainerBurnout(t: HistoryFrame): number | null {
  const c = t.columns, tIgn = t.summary?.t_ign_s;
  if (!isNum(tIgn) || !c.thrust_lb) return null;
  let last: number | null = null;
  for (let i = 0; i < c.time_s.length; i++) if ((c.time_s[i] as number) > tIgn && (c.thrust_lb[i] ?? 0) > 0) last = c.time_s[i] as number;
  return last;
}
export function historyMarkers(t: HistoryFrame): Marker[] {
  const sm = t.summary || {}, tSus = sustainerBurnout(t);
  const out: Marker[] = [];
  if (isNum(sm.t_burnout_s)) out.push({ x: sm.t_burnout_s, label: `burnout ${fmt(sm.t_burnout_s, 2)} s`, color: EVENT_TOKENS.burnout });
  if (isNum(sm.t_sep_s)) out.push({ x: sm.t_sep_s, label: `separation ${fmt(sm.t_sep_s, 2)} s`, color: EVENT_TOKENS.separation });
  if (isNum(sm.t_ign_s)) out.push({ x: sm.t_ign_s, label: `ignition ${fmt(sm.t_ign_s, 2)} s`, color: EVENT_TOKENS.ignition });
  if (isNum(tSus)) out.push({ x: tSus, label: `sustainer burnout ${fmt(tSus, 2)} s`, color: EVENT_TOKENS.sustainer_burnout });
  if (isNum(sm.t_apogee_s)) out.push({ x: sm.t_apogee_s, label: `apogee ${fmt(sm.t_apogee_s, 1)} s`, color: EVENT_TOKENS.apogee });
  return out;
}

const MODES = [{ value: "mach", label: "Mach & altitude" }, { value: "vel", label: "velocity & thrust" }, { value: "forces", label: "thrust, drag, weight" }, { value: "accel", label: "acceleration" }];

export function HistoryChart({ t, mode, onMode, onHover, onLeave, height = 300, tmax }:
  { t: HistoryFrame; mode: string; onMode: (m: string) => void; onHover?: (x: number) => void; onLeave?: () => void; height?: number; tmax?: number | null }) {
  const state = useAppState();
  const cfg = state?.config;
  const c = t.columns, sm = t.summary || {};
  const markers = historyMarkers(t);
  const cut = (arr: (number | null)[]) => (tmax ? arr.filter((_, i) => (c.time_s[i] ?? 0) <= tmax) : arr);
  const x = cut(c.time_s);
  let series: Series[], yLabel = "", y2Label: string | undefined, refs: Ref[] = [];
  if (mode === "vel") { series = [{ name: "velocity [fps]", x, y: cut(c.velocity_fps) }, { name: "thrust [lb]", x, y: cut(c.thrust_lb), axis: "y2" }]; yLabel = "velocity [ft/s]"; y2Label = "thrust [lb]"; }
  else if (mode === "forces") { series = [{ name: "thrust [lb]", x, y: cut(c.thrust_lb) }, { name: "drag [lb]", x, y: cut(c.drag_lb) }, { name: "weight [lb]", x, y: cut(c.weight_lb) }]; yLabel = "lb"; }
  else if (mode === "accel") { series = [{ name: "accel [ft/s²]", x, y: cut(c.accel_fps2) }, { name: "accel-V", x, y: cut(c.accel_v_fps2) }]; yLabel = "ft/s²"; }
  else {
    series = [{ name: "Mach", x, y: cut(c.mach) }, { name: "altitude [ft]", x, y: cut(c.altitude_ft), axis: "y2" }]; yLabel = "Mach"; y2Label = "altitude [ft]";
    if (cfg) refs = [{ y: cfg.profiles.supersonic_min_mach, label: `M ${cfg.profiles.supersonic_min_mach}`, color: "--limit" }, { y: cfg.profiles.subsonic_max_mach, label: `M ${cfg.profiles.subsonic_max_mach}`, color: "--good" }, { y: cfg.target.apogee_ft, label: `target ${fmt(cfg.target.apogee_ft, 0)} ft`, axis: "y2", color: "--target" }];
  }
  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <Segmented sm value={mode} options={MODES} onChange={onMode} />
        <span className="text-[12px] text-ink-2 num">apogee {fmt(sm.apogee_ft, 0)} ft · max Mach {fmt(sm.max_mach, 3)} · max vel {fmt(sm.max_vel_fps, 0)} fps</span>
      </div>
      {markers.length ? <EventLegend markers={markers} /> : null}
      <LineChart series={series} xLabel="time [s]" yLabel={yLabel} y2Label={y2Label} markers={markers} markerLabels={false} refs={refs} height={height} onHover={onHover} onLeave={onLeave} />
    </div>
  );
}

export function EventLegend({ markers }: { markers: Marker[] }) {
  return (
    <div className="chart-legend">
      {markers.map((m) => <span key={m.label} className="inline-flex items-center gap-1.5" style={{ color: v(m.color || "--ink-3") }}><span className="swatch tick" /><span className="text-ink-2">{m.label}</span></span>)}
    </div>
  );
}

export function SeriesLegend({ items, className }: { items: { name: string; color: string; dash?: boolean }[]; className?: string }) {
  return (
    <div className={cn("chart-legend", className)}>
      {items.map((it) => <span key={it.name} className="inline-flex items-center gap-1.5" style={{ color: v(it.color) }}><span className={cn("swatch", it.dash ? "dash" : "line")} /><span className="text-ink-2">{it.name}</span></span>)}
    </div>
  );
}

export function HistoryOverlay({ items, mode, height = 300 }: { items: { name: string; hist: HistoryFrame; color: string; dash?: boolean }[]; mode: string; height?: number }) {
  const state = useAppState();
  const cfg = state?.config;
  const col = ({ mach: "mach", altitude: "altitude_ft", velocity: "velocity_fps" } as Record<string, string>)[mode] || "mach";
  const yLabel = ({ mach: "Mach", altitude: "altitude [ft]", velocity: "velocity [ft/s]" } as Record<string, string>)[mode] || "Mach";
  const series: Series[] = items.map((it) => ({ name: it.name, x: it.hist.columns.time_s, y: it.hist.columns[col], color: it.color, dash: it.dash }));
  const refs: Ref[] = !cfg ? [] : col === "mach" ? [{ y: cfg.profiles.supersonic_min_mach, label: `M ${cfg.profiles.supersonic_min_mach}`, color: "--limit" }, { y: cfg.profiles.subsonic_max_mach, label: `M ${cfg.profiles.subsonic_max_mach}`, color: "--good" }] : col === "altitude_ft" ? [{ y: cfg.target.apogee_ft, label: `target ${fmt(cfg.target.apogee_ft, 0)} ft`, color: "--target" }] : [];
  return <LineChart series={series} xLabel="time [s]" yLabel={yLabel} refs={refs} height={height} />;
}
