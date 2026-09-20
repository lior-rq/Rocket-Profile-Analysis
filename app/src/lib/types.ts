export type FileInfo = { name: string | null; path: string | null; exists: boolean; mtime: number | null; size: number | null };
export type RunRecord = { stage: string; args: string[]; label?: string | null; started: number | null; finished: number | null; elapsed_s: number; exit_code: number | null; cancelled: boolean; error_lines: number; last_error: string | null; log: string | null; side?: boolean; source?: string };
export type StepStatus = "ok" | "partial" | "todo" | "stale" | "warn" | "error" | "unchecked" | "running";
export type AppState = {
  now: number; root: string; config: any;
  inputs: any; mass: any; optimize: any; results: any; confirm: any;
  runner: import("./api").RunnerStatus; history: RunRecord[]; plots: FileInfo[]; disk: any; engine: any;
};
export const STEPS = [
  { id: "inputs", n: 1, title: "Inputs & settings", sub: "Vehicle, motors, mass, target", short: "Inputs", path: "/inputs", optional: false },
  { id: "optimize", n: 2, title: "Optimize", sub: "Search staging delays", short: "Optimize", path: "/optimize", optional: false },
  { id: "results", n: 3, title: "Results", sub: "Designs, plots, report", short: "Results", path: "/results", optional: false },
  { id: "confirm", n: 4, title: "Confirm in RASAero", sub: "Final check", short: "Confirm", path: "/confirm", optional: false },
] as const;
export type StepId = (typeof STEPS)[number]["id"];
export const STATUS_TEXT: Record<string, string> = { ok: "done", partial: "partial", todo: "not started", stale: "out of date", warn: "needs attention", error: "problem", unchecked: "not checked", running: "running" };
export const RUN_STAGES = ["run", "motors", "mass", "characterize", "search", "verify", "report"];
export const FINDINGS_STAGES = ["check"];
export const LIGHT_STAGES = ["check", "report"];

export function stepStatus(s: AppState | null | undefined, id: string): StepStatus {
  if (!s) return "todo";
  const r = s.runner;
  if (r.running) {
    const st = r.stage;
    if ((id === "inputs" && (st === "check" || st === "mass")) || (id === "optimize" && RUN_STAGES.includes(st || "")) || (id === "confirm" && st === "confirm")) return "running";
  }
  return ((s as any)[id] && (s as any)[id].status) || "todo";
}
/* The computed mass table, or null when absent or unreadable. */
export const massTable = (s: AppState | null | undefined): any => (s?.mass?.table && !s.mass.table.error ? s.mass.table : null);
export function outcomeText(r: { cancelled?: boolean; exit_code: number | null; stage: string | null }) {
  return r.cancelled ? "cancelled" : r.exit_code === 0 ? "finished" : r.exit_code === 1 && FINDINGS_STAGES.includes(r.stage || "") ? "finished with findings" : `failed (exit ${r.exit_code})`;
}
/** Why a finished search has no designs, from the results summary. Null
    when nothing was searched yet. */
export function emptySearchText(d: any, cfg: any): string | null {
  if (!d || d.n || !d.searched) return null;
  const elig = (d.eligibility || {}) as Record<string, { eligible: number; total: number }>;
  const profiles = Object.entries(elig);
  const eligible = profiles.reduce((a, [, x]) => a + x.eligible, 0);
  if (!profiles.length) return "The optimizer finished without a candidate to search.";
  const per = profiles.map(([p, x]) => `${p} ${x.eligible}/${x.total}`).join(", ");
  if (eligible) return `${eligible} candidate(s) were eligible (${per}) but the search produced no design; rerun with "include unsolved" to keep the ones that did not converge.`;
  const c = d.characterization, pr = cfg?.profiles || {};
  const band = isFinite(pr.subsonic_max_mach - pr.mach_margin) ? ` The subsonic profile needs a peak below Mach ${(pr.subsonic_max_mach - pr.mach_margin).toFixed(2)}, the supersonic one a peak of at least Mach ${(pr.supersonic_min_mach + pr.mach_margin).toFixed(2)}.` : "";
  const peak = c && c.max_mach_boost_min != null ? ` Every stack peaks between Mach ${c.max_mach_boost_min.toFixed(2)} and ${c.max_mach_boost_max.toFixed(2)} during boost.` : "";
  return `No (booster, sustainer) pair was eligible for either profile (${per}), so there was nothing to search.${peak}${band} A different hardware mass, booster set, or Mach limits in Inputs would change that.`;
}

export function searchedSustainers(m: any): Set<string> {
  if (!m) return new Set();
  const picked = ((m.sustainer_selection || {}).selected || []).map((x: any) => x.label);
  return new Set(picked.length ? picked : [m.sustainer.label]);
}
