/* The live stream: runner status and the log, written only by the SSE
   client. Pages select the runner; the drawer alone selects the lines. */
import { create } from "zustand";
import { type LogLine, type RunnerStatus } from "@/lib/api";

const MAX_LINES = 4000;

interface LiveState {
  runner: RunnerStatus | null;
  lines: LogLine[];
  lastSeq: number;
  subStart: number | null;
  subKey: string | null;
  tick: number;
  setRunner(r: RunnerStatus): void;
  seed(lines: LogLine[], runner: RunnerStatus): void;
  pushLine(rec: LogLine): void;
  clearLog(): void;
  bump(): void;
}

export const useLive = create<LiveState>()((set, get) => ({
  runner: null,
  lines: [],
  lastSeq: 0,
  subStart: null,
  subKey: null,
  tick: 0,
  setRunner: (r) => {
    const key = r.running ? `${r.stage}|${r.substage}|${r.round && r.round.round}|${r.progress && r.progress.total}` : null;
    const s = get();
    set(key !== s.subKey ? { runner: r, subKey: key, subStart: r.running ? Date.now() / 1000 : null } : { runner: r });
  },
  seed: (lines, runner) => {
    set({ lines: lines.slice(-MAX_LINES), lastSeq: lines.length ? lines[lines.length - 1].seq : 0 });
    get().setRunner(runner);
  },
  pushLine: (rec) => {
    const s = get();
    if (rec.seq <= s.lastSeq) return;
    set({ lastSeq: rec.seq, lines: s.lines.length >= MAX_LINES ? [...s.lines.slice(1), rec] : [...s.lines, rec] });
  },
  clearLog: () => set({ lines: [] }),
  bump: () => set((s) => ({ tick: s.tick + 1 })),
}));

/* elapsed_s ticks locally while a stage runs. */
let timer: number | null = null;
useLive.subscribe((s, prev) => {
  const running = !!s.runner?.running;
  if (running === !!prev.runner?.running && timer !== null === running) return;
  if (running && timer === null) timer = window.setInterval(() => useLive.getState().bump(), 1000);
  if (!running && timer !== null) { clearInterval(timer); timer = null; }
});

/** The runner with elapsed_s advanced to now. */
export function useRunner(): RunnerStatus | null {
  const runner = useLive((s) => s.runner);
  useLive((s) => s.tick);
  if (runner && runner.running && runner.started) return { ...runner, elapsed_s: Date.now() / 1000 - runner.started };
  return runner;
}
export const useBusy = () => useLive((s) => !!s.runner?.running);
export const useSubStart = () => useLive((s) => s.subStart);
