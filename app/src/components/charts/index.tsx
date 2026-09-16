import { useMemo } from "react";
import ReactECharts from "echarts-for-react";
import type { EChartsOption } from "echarts";
import { fmt, isNum } from "@/lib/format";
import { useApp } from "@/lib/store";

export const PALETTE = ["#2563eb", "#f97316", "#16a34a", "#9333ea", "#dc2626", "#0891b2", "#ca8a04", "#db2777"];
const css = (v: string) => getComputedStyle(document.documentElement).getPropertyValue(v).trim() || undefined;
const axisStyle = () => ({ axisLine: { lineStyle: { color: css("--border-strong") } }, axisLabel: { color: css("--muted"), fontSize: 11 }, splitLine: { lineStyle: { color: css("--border") } }, nameTextStyle: { color: css("--muted"), fontSize: 11 } });
const base = (): EChartsOption => ({ animation: false, textStyle: { fontFamily: "Inter, system-ui, sans-serif", fontSize: 11 }, tooltip: { backgroundColor: css("--panel"), borderColor: css("--border"), textStyle: { color: css("--text"), fontSize: 12 } }, grid: { left: 56, right: 24, top: 28, bottom: 42, containLabel: false } });
const tickFmt = (v: number) => (Math.abs(v) >= 10000 ? (v / 1000).toFixed(v % 1000 ? 1 : 0) + "k" : fmt(v));

export type Series = { name: string; x: (number | null)[]; y: (number | null)[]; color?: string; axis?: "y2"; dash?: boolean; width?: number; points?: boolean };
export type Ref = { y: number; label?: string; color?: string; axis?: "y2" };
export type Marker = { x: number; label: string; color?: string };

export function LineChart({ series, xLabel, yLabel, y2Label, refs = [], markers = [], height = 280, onHover, onLeave, points }: { series: Series[]; xLabel?: string; yLabel?: string; y2Label?: string; refs?: Ref[]; markers?: Marker[]; height?: number; onHover?: (x: number) => void; onLeave?: () => void; points?: boolean }) {
  const { theme } = useApp();
  const option = useMemo<EChartsOption>(() => {
    const vis = series.filter((s) => s.x && s.x.length);
    const hasY2 = vis.some((s) => s.axis === "y2");
    return {
      ...base(),
      grid: { left: 56, right: hasY2 ? 62 : 24, top: 28, bottom: 42 },
      legend: { bottom: 0, left: 0, textStyle: { color: css("--muted"), fontSize: 11 }, itemWidth: 14, itemHeight: 8 },
      tooltip: { ...(base().tooltip as object), trigger: "axis", axisPointer: { type: "line" }, valueFormatter: (v: any) => fmt(v) },
      xAxis: { type: "value", name: xLabel, nameLocation: "middle", nameGap: 26, ...axisStyle(), axisLabel: { ...axisStyle().axisLabel, formatter: (v: number) => tickFmt(v) }, scale: true },
      yAxis: [{ type: "value", name: yLabel, nameLocation: "middle", nameGap: 44, ...axisStyle(), axisLabel: { ...axisStyle().axisLabel, formatter: (v: number) => tickFmt(v) }, scale: true }, ...(hasY2 ? [{ type: "value" as const, name: y2Label, nameLocation: "middle" as const, nameGap: 48, ...axisStyle(), splitLine: { show: false }, axisLabel: { ...axisStyle().axisLabel, formatter: (v: number) => tickFmt(v) }, scale: true }] : [])],
      series: vis.map((s, i) => ({
        name: s.name, type: "line", yAxisIndex: s.axis === "y2" ? 1 : 0, showSymbol: !!(s.points || points), symbolSize: 6, sampling: "lttb",
        data: s.x.map((xv, k) => [xv, s.y[k]]).filter(([a, b]) => isNum(a) && isNum(b)),
        lineStyle: { width: s.width || 1.8, type: s.dash ? "dashed" : "solid" }, itemStyle: { color: s.color || PALETTE[i % PALETTE.length] }, connectNulls: false,
        markLine: i === 0 ? { silent: true, symbol: "none", label: { position: "insideEndTop", fontSize: 10, color: css("--muted") }, data: [...refs.filter((r) => (r.axis === "y2") === (s.axis === "y2")).map((r) => ({ yAxis: r.y, name: r.label, lineStyle: { color: r.color || "#94a3b8", type: "dashed" }, label: { formatter: r.label, color: r.color } })), ...markers.map((m) => ({ xAxis: m.x, name: m.label, lineStyle: { color: m.color || "#64748b", type: "dashed" }, label: { formatter: m.label, color: m.color, position: "insideStartTop" } }))] } : undefined,
      })),
    } as EChartsOption;
  }, [series, xLabel, yLabel, y2Label, refs, markers, points, theme]);
  const events = useMemo(() => ({ updateAxisPointer: (e: any) => { const v = e?.axesInfo?.[0]?.value; if (onHover && isNum(v)) onHover(v); }, globalout: () => onLeave?.() }), [onHover, onLeave]);
  return <ReactECharts option={option} style={{ height, width: "100%" }} notMerge lazyUpdate onEvents={events} />;
}

export function ScatterChart({ points, xLabel, yLabel, band, xrefs = [], height = 320, color, shape, onClick, selectedKey, tip }: { points: { x: number; y: number; key: string; row: any }[]; xLabel?: string; yLabel?: string; band?: { y0: number; y1: number; label?: string }; xrefs?: { x: number; label?: string; color?: string }[]; height?: number; color?: (p: any) => string; shape?: (p: any) => string; onClick?: (p: any) => void; selectedKey?: string | null; tip?: (p: any) => [string, string][] }) {
  const { theme } = useApp();
  const option = useMemo<EChartsOption>(() => ({
    ...base(),
    tooltip: { ...(base().tooltip as object), trigger: "item", formatter: (p: any) => (tip ? tip(p.data.p) : [[xLabel || "x", fmt(p.data.p.x)], [yLabel || "y", fmt(p.data.p.y)]]).map(([k, v]) => `<div style="display:flex;justify-content:space-between;gap:12px"><span>${k}</span><b>${v}</b></div>`).join("") },
    xAxis: { type: "value", name: xLabel, nameLocation: "middle", nameGap: 26, ...axisStyle(), scale: true, axisLabel: { ...axisStyle().axisLabel, formatter: (v: number) => tickFmt(v) } },
    yAxis: { type: "value", name: yLabel, nameLocation: "middle", nameGap: 48, ...axisStyle(), scale: true, axisLabel: { ...axisStyle().axisLabel, formatter: (v: number) => tickFmt(v) } },
    series: [{
      type: "scatter", data: points.map((p) => ({ value: [p.x, p.y], p, symbol: (shape?.(p) || "circle") === "square" ? "rect" : shape?.(p) || "circle", symbolSize: p.key === selectedKey ? 15 : 9, itemStyle: { color: color?.(p) || PALETTE[0], opacity: 0.85, borderColor: p.key === selectedKey ? css("--text") : undefined, borderWidth: p.key === selectedKey ? 2 : 0 } })),
      markArea: band ? { silent: true, itemStyle: { color: "rgba(22,163,74,.12)" }, label: { position: "insideRight", fontSize: 10, color: "#16a34a" }, data: [[{ yAxis: band.y0, name: band.label }, { yAxis: band.y1 }]] } : undefined,
      markLine: xrefs.length ? { silent: true, symbol: "none", label: { fontSize: 10, position: "insideEndTop" }, data: xrefs.map((r) => ({ xAxis: r.x, name: r.label, lineStyle: { color: r.color || "#94a3b8", type: "dashed" }, label: { formatter: r.label, color: r.color } })) } : undefined,
    }],
  }) as EChartsOption, [points, xLabel, yLabel, band, xrefs, color, shape, selectedKey, tip, theme]);
  return <ReactECharts option={option} style={{ height, width: "100%" }} notMerge lazyUpdate onEvents={{ click: (e: any) => e?.data?.p && onClick?.(e.data.p) }} />;
}

export type HistoryFrame = { n: number; stride: number; columns: Record<string, (number | null)[]>; summary: Record<string, number | null> };
export function HistoryChart({ t, mode, onMode, onHover, onLeave, height = 300, tmax }: { t: HistoryFrame; mode: string; onMode: (m: string) => void; onHover?: (x: number) => void; onLeave?: () => void; height?: number; tmax?: number | null }) {
  const { state } = useApp();
  const cfg = state?.config;
  const c = t.columns, sm = t.summary || {};
  const markers: Marker[] = [];
  if (isNum(sm.t_burnout_s)) markers.push({ x: sm.t_burnout_s, label: `burnout ${fmt(sm.t_burnout_s, 2)}s`, color: "#f97316" });
  if (isNum(sm.t_sep_s)) markers.push({ x: sm.t_sep_s, label: `separation ${fmt(sm.t_sep_s, 2)}s`, color: "#9333ea" });
  if (isNum(sm.t_ign_s)) markers.push({ x: sm.t_ign_s, label: `ignition ${fmt(sm.t_ign_s, 2)}s`, color: "#dc2626" });
  if (isNum(sm.t_apogee_s)) markers.push({ x: sm.t_apogee_s, label: `apogee ${fmt(sm.t_apogee_s, 1)}s`, color: "#16a34a" });
  const cut = (arr: (number | null)[]) => (tmax ? arr.filter((_, i) => (c.time_s[i] ?? 0) <= tmax) : arr);
  const x = cut(c.time_s);
  const modes: Record<string, string> = { mach: "Mach & altitude", vel: "velocity & thrust", forces: "thrust, drag, weight", accel: "acceleration" };
  let series: Series[], yLabel = "", y2Label: string | undefined, refs: Ref[] = [];
  if (mode === "vel") { series = [{ name: "velocity [fps]", x, y: cut(c.velocity_fps) }, { name: "thrust [lb]", x, y: cut(c.thrust_lb), axis: "y2" }]; yLabel = "velocity [ft/s]"; y2Label = "thrust [lb]"; }
  else if (mode === "forces") { series = [{ name: "thrust [lb]", x, y: cut(c.thrust_lb) }, { name: "drag [lb]", x, y: cut(c.drag_lb) }, { name: "weight [lb]", x, y: cut(c.weight_lb) }]; yLabel = "lb"; }
  else if (mode === "accel") { series = [{ name: "accel [ft/s²]", x, y: cut(c.accel_fps2) }, { name: "accel-V", x, y: cut(c.accel_v_fps2) }]; yLabel = "ft/s²"; }
  else { series = [{ name: "Mach", x, y: cut(c.mach) }, { name: "altitude [ft]", x, y: cut(c.altitude_ft), axis: "y2" }]; yLabel = "Mach"; y2Label = "altitude [ft]"; if (cfg) refs = [{ y: cfg.profiles.supersonic_min_mach, label: `M ${cfg.profiles.supersonic_min_mach}`, color: "#dc2626" }, { y: cfg.profiles.subsonic_max_mach, label: `M ${cfg.profiles.subsonic_max_mach}`, color: "#16a34a" }, { y: cfg.target.apogee_ft, label: `target ${fmt(cfg.target.apogee_ft, 0)} ft`, axis: "y2", color: "#2563eb" }]; }
  return <div>
    <div className="mb-1 flex flex-wrap items-center justify-between gap-2"><div className="flex gap-1">{Object.entries(modes).map(([k, v]) => <button key={k} type="button" className={`rounded-full border px-2 py-0.5 text-[12px] ${mode === k ? "border-accent bg-accent-bg" : "border-line text-muted"}`} onClick={() => onMode(k)}>{v}</button>)}</div><span className="text-[12px] text-muted">apogee {fmt(sm.apogee_ft, 0)} ft · max Mach {fmt(sm.max_mach, 3)} · max vel {fmt(sm.max_vel_fps, 0)} fps · {t.n} samples</span></div>
    <LineChart series={series} xLabel="time [s]" yLabel={yLabel} y2Label={y2Label} markers={markers} refs={refs} height={height} onHover={onHover} onLeave={onLeave} />
  </div>;
}

export function HistoryOverlay({ items, mode, height = 300 }: { items: { name: string; hist: HistoryFrame; color: string; dash?: boolean }[]; mode: string; height?: number }) {
  const { state } = useApp();
  const cfg = state?.config;
  const col = ({ mach: "mach", altitude: "altitude_ft", velocity: "velocity_fps" } as Record<string, string>)[mode] || "mach";
  const yLabel = ({ mach: "Mach", altitude: "altitude [ft]", velocity: "velocity [ft/s]" } as Record<string, string>)[mode] || "Mach";
  const series: Series[] = items.map((it) => ({ name: it.name, x: it.hist.columns.time_s, y: it.hist.columns[col], color: it.color, dash: it.dash }));
  const refs: Ref[] = !cfg ? [] : col === "mach" ? [{ y: cfg.profiles.supersonic_min_mach, label: `M ${cfg.profiles.supersonic_min_mach}`, color: "#dc2626" }, { y: cfg.profiles.subsonic_max_mach, label: `M ${cfg.profiles.subsonic_max_mach}`, color: "#16a34a" }] : col === "altitude_ft" ? [{ y: cfg.target.apogee_ft, label: `target ${fmt(cfg.target.apogee_ft, 0)} ft`, color: "#2563eb" }] : [];
  return <LineChart series={series} xLabel="time [s]" yLabel={yLabel} refs={refs} height={height} />;
}
