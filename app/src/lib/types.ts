export type FileInfo = { name: string | null; path: string | null; exists: boolean; mtime: number | null; size: number | null };
export type RunRecord = { stage: string; args: string[]; label?: string | null; started: number | null; finished: number | null; elapsed_s: number; exit_code: number | null; cancelled: boolean; error_lines: number; last_error: string | null; log: string | null; side?: boolean; source?: string };
export type StepStatus = "ok" | "partial" | "todo" | "stale" | "warn" | "error" | "unchecked" | "running";
export type AppState = {
  now: number; root: string; config: any;
  inputs: any; mass: any; aero: any; reference: any; validate: any; optimize: any; results: any; confirm: any; worker: any;
  runner: import("./api").RunnerStatus; history: RunRecord[]; plots: FileInfo[]; disk: any; engine: any;
};
export const STEPS = [
  { id: "inputs", n: 1, title: "Inputs & settings", sub: "Vehicle, motors, mass, target", short: "Inputs", path: "/inputs" },
  { id: "aero", n: 2, title: "Aero tables", sub: "RASAero drag curves", short: "Aero tables", path: "/aero" },
  { id: "reference", n: 3, title: "Reference flights", sub: "RASAero runs", short: "Reference", path: "/reference" },
  { id: "validate", n: 4, title: "Validate simulator", sub: "Python vs RASAero", short: "Validate", path: "/validate" },
  { id: "optimize", n: 5, title: "Optimize", sub: "Search staging delays", short: "Optimize", path: "/optimize" },
  { id: "results", n: 6, title: "Results", sub: "Designs, plots, report", short: "Results", path: "/results" },
  { id: "confirm", n: 7, title: "Confirm in RASAero", sub: "Final check", short: "Confirm", path: "/confirm" },
] as const;
export type StepId = (typeof STEPS)[number]["id"];
export const STATUS_TEXT: Record<string, string> = { ok: "done", partial: "partial", todo: "not started", stale: "out of date", warn: "needs attention", error: "problem", unchecked: "not checked", running: "running" };
export const RUN_STAGES = ["run", "motors", "mass", "characterize", "search", "verify", "report"];
export const FINDINGS_STAGES = ["check", "validate"];
export const LIGHT_STAGES = ["check", "report"];

export function stepStatus(s: AppState | null | undefined, id: string): StepStatus {
  if (!s) return "todo";
  const r = s.runner;
  if (r.running) {
    const st = r.stage;
    if ((id === "inputs" && (st === "check" || st === "mass")) || (id === "aero" && st === "aero") || (id === "reference" && st === "reference") || (id === "validate" && st === "validate") || (id === "optimize" && RUN_STAGES.includes(st || "")) || (id === "confirm" && st === "confirm")) return "running";
  }
  return ((s as any)[id] && (s as any)[id].status) || "todo";
}
export function outcomeText(r: { cancelled?: boolean; exit_code: number | null; stage: string | null }) {
  return r.cancelled ? "cancelled" : r.exit_code === 0 ? "finished" : r.exit_code === 1 && FINDINGS_STAGES.includes(r.stage || "") ? "finished with findings" : `failed (exit ${r.exit_code})`;
}
export function searchedSustainers(m: any): Set<string> {
  if (!m) return new Set();
  const picked = ((m.sustainer_selection || {}).selected || []).map((x: any) => x.label);
  return new Set(picked.length ? picked : [m.sustainer.label]);
}
