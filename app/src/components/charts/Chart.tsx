/* An ECharts instance bound to one div. Redraws whenever its option
   changes and whenever the theme flips; resizes with its box. */
import * as echarts from "echarts/core";
import { BarChart, LineChart, ScatterChart } from "echarts/charts";
import { DataZoomComponent, GridComponent, LegendComponent, MarkAreaComponent, MarkLineComponent, TooltipComponent } from "echarts/components";
import { CanvasRenderer } from "echarts/renderers";
import { useEffect, useRef } from "react";
import { cn } from "@/lib/utils";
import { useUi } from "@/store/ui";
import type { ECOption } from "./theme";

echarts.use([LineChart, ScatterChart, BarChart, GridComponent, TooltipComponent, LegendComponent, MarkLineComponent, MarkAreaComponent, DataZoomComponent, CanvasRenderer]);

export type Events = Record<string, (e: any) => void>;

export function Chart({ option, height = 280, className, onEvents, freshKey }:
  { option: ECOption; height?: number; className?: string; onEvents?: Events; freshKey?: string | number }) {
  const ref = useRef<HTMLDivElement>(null);
  const inst = useRef<echarts.ECharts | null>(null);
  const theme = useUi((s) => s.resolved);
  const handlers = useRef<Events | undefined>(onEvents);
  handlers.current = onEvents;
  const drawn = useRef<string | number | undefined>(undefined);

  useEffect(() => {
    const node = ref.current;
    if (!node) return;
    const chart = echarts.init(node, undefined, { renderer: "canvas", useDirtyRect: true });
    inst.current = chart;
    const ro = new ResizeObserver(() => { try { chart.resize(); } catch { /* disposed */ } });
    ro.observe(node);
    // Listeners are attached once and dispatch to the latest handlers.
    for (const ev of ["click", "updateAxisPointer", "globalout", "mouseover", "mouseout"]) {
      chart.on(ev, (e: any) => handlers.current?.[ev]?.(e));
    }
    return () => { ro.disconnect(); chart.dispose(); inst.current = null; };
  }, []);

  useEffect(() => {
    const chart = inst.current;
    if (!chart) return;
    const fresh = freshKey !== undefined && drawn.current !== freshKey;
    drawn.current = freshKey;
    chart.setOption({ ...option, animation: fresh ? true : (option as any).animation ?? false }, { notMerge: true, lazyUpdate: true });
  }, [option, theme, freshKey]);

  return <div ref={ref} className={cn("chart", className)} style={{ height, minHeight: height }} />;
}
