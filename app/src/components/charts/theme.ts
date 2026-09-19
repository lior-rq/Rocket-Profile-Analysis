/* One look for every chart, read from the page's own tokens so a theme
   switch redraws them in step. */
import type { EChartsCoreOption } from "echarts/core";
import { fmt } from "@/lib/format";
import { tok } from "@/lib/tokens";

export type ECOption = EChartsCoreOption;

export const tickFmt = (v: number) => (Math.abs(v) >= 10000 ? (v / 1000).toFixed(v % 1000 ? 1 : 0) + "k" : fmt(v));

export const axisStyle = () => ({
  axisLine: { lineStyle: { color: tok("--line") } },
  axisTick: { show: false },
  axisLabel: { color: tok("--ink-3"), fontSize: 10.5, fontFamily: tok("--mono") || "monospace" },
  splitLine: { lineStyle: { color: tok("--line-2") } },
  nameTextStyle: { color: tok("--ink-2"), fontSize: 11 },
});

export function base(animated = false): ECOption {
  return {
    animation: animated, animationDuration: 300, animationEasing: "cubicOut",
    textStyle: { fontFamily: tok("--sans") || "system-ui, sans-serif", fontSize: 11, color: tok("--ink-2") },
    tooltip: {
      backgroundColor: tok("--bg-2"), borderColor: tok("--line"), borderWidth: 1, padding: [6, 10],
      textStyle: { color: tok("--ink"), fontSize: 12, fontFamily: tok("--sans") || "system-ui, sans-serif" },
      extraCssText: "border-radius:10px;box-shadow:var(--shadow-lg);", className: "echarts-tip", confine: true, appendToBody: true,
    },
    grid: { left: 56, right: 24, top: 28, bottom: 42, containLabel: false, show: true, backgroundColor: tok("--plot-bg"), borderColor: tok("--line") },
  };
}

export const legendStyle = () => ({ bottom: 0, left: 0, textStyle: { color: tok("--ink-2"), fontSize: 10.5 }, itemWidth: 14, itemHeight: 8, icon: "roundRect" });

export const tipRows = (rows: [string, string][]) =>
  rows.map(([k, v]) => `<div class="row"><span>${k}</span><b>${v}</b></div>`).join("");
