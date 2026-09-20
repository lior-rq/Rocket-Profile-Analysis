/* UI state that is nobody's server data: theme, the activity drawer, the
   log filters, the table column choices. Persisted where it should be. */
import { create } from "zustand";
import { persist } from "zustand/middleware";

export type ThemeChoice = "auto" | "light" | "dark";
export type Resolved = "light" | "dark";

const systemDark = () => typeof matchMedia !== "undefined" && matchMedia("(prefers-color-scheme: dark)").matches;
const resolve = (t: ThemeChoice): Resolved => (t === "dark" || (t === "auto" && systemDark()) ? "dark" : "light");

function applyTheme(r: Resolved) {
  const el = document.documentElement;
  el.dataset.theme = r;
  el.style.colorScheme = r;
}

/* Column choices once lived in localStorage as "rpa-cols:<chooser>". Fold
   them into hiddenCols on first load, then drop the old keys. */
function migrateLegacyCols(s: UiState) {
  try {
    for (const k of Object.keys(localStorage)) {
      if (!k.startsWith("rpa-cols:")) continue;
      const name = k.slice("rpa-cols:".length);
      const cols = JSON.parse(localStorage.getItem(k) || "null");
      if (Array.isArray(cols) && !(name in s.hiddenCols)) s.setHiddenCols(name, cols.filter((c) => typeof c === "string"));
      localStorage.removeItem(k);
    }
  } catch { /* storage unavailable */ }
}

interface UiState {
  theme: ThemeChoice;
  resolved: Resolved;
  drawerOpen: boolean;
  drawerHeight: number;
  follow: boolean;
  errorsOnly: boolean;
  stopped: boolean;
  connected: boolean;
  hiddenCols: Record<string, string[]>;
  setTheme(t: ThemeChoice): void;
  cycleTheme(): void;
  setDrawerOpen(v: boolean): void;
  setDrawerHeight(h: number): void;
  setFollow(v: boolean): void;
  setErrorsOnly(v: boolean): void;
  setStopped(v: boolean): void;
  setConnected(v: boolean): void;
  setHiddenCols(key: string, cols: string[]): void;
}

export const useUi = create<UiState>()(persist((set, get) => ({
  theme: "auto",
  resolved: "dark",
  drawerOpen: false,
  drawerHeight: 260,
  follow: true,
  errorsOnly: false,
  stopped: false,
  connected: false,
  hiddenCols: {},
  setTheme: (t) => { const r = resolve(t); applyTheme(r); set({ theme: t, resolved: r }); },
  cycleTheme: () => { const t = get().theme; get().setTheme(t === "auto" ? "light" : t === "light" ? "dark" : "auto"); },
  setDrawerOpen: (v) => set({ drawerOpen: v }),
  setDrawerHeight: (h) => set({ drawerHeight: Math.round(h) }),
  setFollow: (v) => set({ follow: v }),
  setErrorsOnly: (v) => set({ errorsOnly: v }),
  setStopped: (v) => set({ stopped: v }),
  setConnected: (v) => set({ connected: v }),
  setHiddenCols: (key, cols) => set((s) => ({ hiddenCols: { ...s.hiddenCols, [key]: cols } })),
}), {
  name: "rpa-ui",
  partialize: (s) => ({ theme: s.theme, drawerHeight: s.drawerHeight, hiddenCols: s.hiddenCols, errorsOnly: s.errorsOnly }),
  // The boot script in index.html reads "rpa-theme"; keep that key in step.
  onRehydrateStorage: () => (s) => {
    if (!s) return;
    let legacy: string | null = null;
    try { legacy = localStorage.getItem("rpa-theme"); } catch { /* ignore */ }
    const t = (legacy === "light" || legacy === "dark" || legacy === "auto") && s.theme === "auto" && legacy !== "auto" ? (legacy as ThemeChoice) : s.theme;
    s.setTheme(t);
    migrateLegacyCols(s);
  },
}));

/* Keep "rpa-theme" written for the boot script, and follow the OS in auto. */
useUi.subscribe((s, prev) => {
  if (s.theme !== prev.theme) { try { localStorage.setItem("rpa-theme", s.theme); } catch { /* ignore */ } }
});
if (typeof matchMedia !== "undefined") {
  matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => {
    const s = useUi.getState();
    if (s.theme === "auto") s.setTheme("auto");
  });
}
if (typeof document !== "undefined") {
  // The boot script set data-theme before first paint; the store follows it.
  const cur = document.documentElement.dataset.theme === "light" ? "light" : "dark";
  useUi.setState({ resolved: cur });
}
