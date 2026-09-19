/* Server data through TanStack Query; the live stream through store/live;
   the UI's own state through store/ui. This file wires them together. */
import { useEffect, useMemo } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { useLive, useRunner } from "@/store/live";
import { useUi } from "@/store/ui";
import { api, connectEvents, type LogLine, type RunnerStatus } from "./api";
import { dur } from "./format";
import { outcomeText, type AppState } from "./types";

export function useStateQuery() {
  return useQuery({ queryKey: ["state"], queryFn: () => api<AppState>("/api/state"), refetchInterval: 15000, retry: 1 });
}

/** The project state with the live runner folded in. */
export function useAppState(): AppState | null {
  const q = useStateQuery();
  const runner = useRunner();
  return useMemo(() => (q.data ? { ...q.data, runner: runner ?? q.data.runner } : null), [q.data, runner]);
}
export function useStateError(): string | null {
  const q = useStateQuery();
  return q.error ? String((q.error as Error).message) : null;
}
export function useRefresh() {
  const qc = useQueryClient();
  return async () => { await qc.invalidateQueries({ queryKey: ["state"] }); };
}
export { useBusy, useRunner } from "@/store/live";

/* Fetch-once cache keyed by a version (file mtime) or a TTL. */
export function useCached<T = any>(key: string, url: string | null, version?: unknown, ttl = 4000) {
  return useQuery<T>({ queryKey: ["cached", key, version ?? null], queryFn: () => api<T>(url as string), enabled: !!url, staleTime: version !== undefined ? Infinity : ttl, gcTime: 10 * 60 * 1000 });
}

/* ETA from the current batch progress. */
export function useEta(r: RunnerStatus | null, subStart: number | null): string {
  if (!r || !r.running || !r.progress || !r.progress.total || !subStart) return "";
  const done = r.progress.done, total = r.progress.total;
  if (done < 2) return "";
  const rate = (done - 1) / Math.max(0.5, Date.now() / 1000 - subStart);
  const left = (total - done) / rate;
  return left > 1 ? `~${dur(left)} left` : "";
}

/** One SSE connection for the whole app. Mount once. */
export function useLiveConnection() {
  const qc = useQueryClient();
  useEffect(() => {
    const live = useLive.getState;
    const ui = useUi.getState;
    let prevRunning = false;
    api<{ lines: LogLine[]; runner: RunnerStatus }>("/api/log?after=0").then((lg) => {
      live().seed(lg.lines, lg.runner);
      prevRunning = lg.runner.running;
      if (lg.runner.running) ui().setDrawerOpen(true);
    }).catch(() => { /* server not up yet */ });
    let changeTimer: number | null = null;
    const stop = connectEvents({
      open: () => ui().setConnected(true),
      error: () => ui().setConnected(false),
      log: (rec) => live().pushLine(rec),
      state: (r) => {
        live().setRunner(r);
        if (!r.running && prevRunning) {
          const ok = r.exit_code === 0, findings = r.exit_code === 1 && r.stage === "check";
          const msg = `rpa ${r.stage} ${outcomeText(r)} (${dur(r.elapsed_s)})`;
          if (r.cancelled) toast(msg); else if (ok) toast.success(msg); else if (findings) toast.warning(msg);
          else toast.error(msg, { action: { label: "show log", onClick: () => ui().setDrawerOpen(true) } });
        }
        prevRunning = r.running;
        if (!r.running) setTimeout(() => qc.invalidateQueries({ queryKey: ["state"] }), 400);
      },
      changed: () => { if (changeTimer) clearTimeout(changeTimer); changeTimer = window.setTimeout(() => qc.invalidateQueries({ queryKey: ["state"] }), 350); },
    });
    return () => { stop(); if (changeTimer) clearTimeout(changeTimer); };
  }, [qc]);
}
