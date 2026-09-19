import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { api, connectEvents, type LogLine, type RunnerStatus } from "./api";
import { dur } from "./format";
import { outcomeText, type AppState } from "./types";

type Ctx = {
  state: AppState | null; stateError: string | null; refresh: () => Promise<void>;
  runner: RunnerStatus | null; lines: LogLine[]; clearLog: () => void;
  activityOpen: boolean; setActivityOpen: (v: boolean) => void; follow: boolean; setFollow: (v: boolean) => void; errorsOnly: boolean; setErrorsOnly: (v: boolean) => void;
  theme: string; setTheme: (t: string) => void; connected: boolean; stopped: boolean; setStopped: (v: boolean) => void;
  subStart: number | null;
};
const AppCtx = createContext<Ctx | null>(null);
const MAX_LINES = 4000;

export function AppProvider({ children }: { children: ReactNode }) {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ["state"], queryFn: () => api<AppState>("/api/state"), refetchInterval: 15000, retry: 1 });
  const [runner, setRunner] = useState<RunnerStatus | null>(null);
  const [lines, setLines] = useState<LogLine[]>([]);
  const lastSeq = useRef(0);
  const [activityOpen, setActivityOpen] = useState(false);
  const [follow, setFollow] = useState(true);
  const [errorsOnly, setErrorsOnly] = useState(false);
  const [connected, setConnected] = useState(false);
  const [stopped, setStopped] = useState(false);
  const [theme, setThemeState] = useState<string>(() => { try { return localStorage.getItem("rpa-theme") || "auto"; } catch { return "auto"; } });
  const prevRunning = useRef(false);
  const [subStart, setSubStart] = useState<number | null>(null);
  const subKey = useRef<string | null>(null);

  const setTheme = useCallback((t: string) => {
    setThemeState(t);
    try { localStorage.setItem("rpa-theme", t); } catch { /* ignore */ }
    const dark = t === "dark" || (t === "auto" && matchMedia("(prefers-color-scheme: dark)").matches);
    document.documentElement.classList.toggle("dark", dark);
  }, []);
  useEffect(() => { setTheme(theme); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const refresh = useCallback(async () => { await qc.invalidateQueries({ queryKey: ["state"] }); }, [qc]);

  useEffect(() => {
    api<{ lines: LogLine[]; runner: RunnerStatus }>("/api/log?after=0").then((lg) => {
      lastSeq.current = lg.lines.length ? lg.lines[lg.lines.length - 1].seq : 0;
      setLines(lg.lines.slice(-MAX_LINES));
      setRunner(lg.runner);
      prevRunning.current = lg.runner.running;
      if (lg.runner.running) setActivityOpen(true);
    }).catch(() => { /* server not up yet */ });
    let changeTimer: number | null = null;
    const stop = connectEvents({
      open: () => setConnected(true),
      error: () => setConnected(false),
      log: (rec) => { if (rec.seq > lastSeq.current) { lastSeq.current = rec.seq; setLines((ls) => (ls.length >= MAX_LINES ? [...ls.slice(1), rec] : [...ls, rec])); } },
      state: (r) => {
        setRunner(r);
        const key = r.running ? `${r.stage}|${r.substage}|${r.round && r.round.round}|${r.progress && r.progress.total}` : null;
        if (key !== subKey.current) { subKey.current = key; setSubStart(r.running ? Date.now() / 1000 : null); }
        if (!r.running && prevRunning.current) {
          const ok = r.exit_code === 0, findings = r.exit_code === 1 && r.stage === "check";
          const msg = `rpa ${r.stage} ${outcomeText(r)} (${dur(r.elapsed_s)})`;
          if (r.cancelled) toast(msg); else if (ok) toast.success(msg); else if (findings) toast.warning(msg); else toast.error(msg, { action: { label: "show log", onClick: () => setActivityOpen(true) } });
        }
        prevRunning.current = r.running;
        if (!r.running) setTimeout(() => qc.invalidateQueries({ queryKey: ["state"] }), 400);
      },
      changed: () => { if (changeTimer) clearTimeout(changeTimer); changeTimer = window.setTimeout(() => qc.invalidateQueries({ queryKey: ["state"] }), 350); },
    });
    return () => { stop(); if (changeTimer) clearTimeout(changeTimer); };
  }, [qc]);

  // elapsed_s ticks locally while a stage runs
  const [tick, setTick] = useState(0);
  useEffect(() => { if (!runner?.running) return; const id = setInterval(() => setTick((t) => t + 1), 1000); return () => clearInterval(id); }, [runner?.running]);
  const liveRunner = useMemo(() => (runner && runner.running && runner.started ? { ...runner, elapsed_s: Date.now() / 1000 - runner.started } : runner), [runner, tick]);

  const state = q.data ?? null;
  const value: Ctx = useMemo(() => ({
    state: state ? { ...state, runner: liveRunner ?? state.runner } : null, stateError: q.error ? String((q.error as Error).message) : null, refresh,
    runner: liveRunner ?? state?.runner ?? null, lines, clearLog: () => setLines([]),
    activityOpen, setActivityOpen, follow, setFollow, errorsOnly, setErrorsOnly, theme, setTheme, connected, stopped, setStopped, subStart,
  }), [state, liveRunner, q.error, refresh, lines, activityOpen, follow, errorsOnly, theme, setTheme, connected, stopped, subStart]);
  return <AppCtx.Provider value={value}>{children}</AppCtx.Provider>;
}

export function useApp(): Ctx {
  const c = useContext(AppCtx);
  if (!c) throw new Error("useApp outside AppProvider");
  return c;
}
export const useAppState = () => useApp().state;
export const useBusy = () => !!useApp().runner?.running;

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
