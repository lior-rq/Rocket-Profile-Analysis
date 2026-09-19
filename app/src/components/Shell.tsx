/* The chrome around the pages: top bar, progress strip, stepper, the
   activity drawer, and the frame that holds them with the backdrop. */
import { useEffect, useRef, useState } from "react";
import { Link, Outlet, useRouterState } from "@tanstack/react-router";
import { Activity, ChevronDown, ChevronUp, Copy, Cpu, Crosshair, FolderOpen, History, Home, Moon, Power, Settings, Sun, SunMoon, Trash2, Wrench, type LucideIcon } from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import { toast } from "sonner";
import { api } from "@/lib/api";
import { clock, dur, fmt } from "@/lib/format";
import { useAppState, useEta, useLiveConnection, useRunner, useStateError } from "@/lib/store";
import { STATUS_TEXT, STEPS, outcomeText, stepStatus } from "@/lib/types";
import { cn } from "@/lib/utils";
import { useLive, useSubStart } from "@/store/live";
import { useUi } from "@/store/ui";
import { cancelRun } from "./common";
import { Badge, Bar, Button, Check, ConfirmDialog, Icon, IconButton, LiveDot, Mark, Tip, spring, stagger, type Tone } from "./ui";

/* ------------------------------------------------------------ topbar */

export function Topbar() {
  const state = useAppState();
  const runner = useRunner();
  const theme = useUi((s) => s.theme), cycleTheme = useUi((s) => s.cycleTheme);
  const drawerOpen = useUi((s) => s.drawerOpen), setDrawerOpen = useUi((s) => s.setDrawerOpen);
  const connected = useUi((s) => s.connected), stopped = useUi((s) => s.stopped), setStopped = useUi((s) => s.setStopped);
  const path = useRouterState({ select: (s) => s.location.pathname });
  const [quitAsk, setQuitAsk] = useState(false);
  const busy = !!runner?.running;
  const quit = async () => { try { await api("/api/quit", {}); } catch { /* going away */ } setStopped(true); };
  const e = state?.engine;
  const last = state?.history?.length ? state.history[state.history.length - 1] : null;
  const lastBad = last && last.exit_code !== 0 && !last.cancelled && !(last.exit_code === 1 && last.stage === "check");
  const ThemeIcon = theme === "auto" ? SunMoon : theme === "light" ? Sun : Moon;
  const project = state?.root ? state.root.split(/[\\/]/).slice(-1)[0] : null;
  return (
    <motion.header initial={{ y: -24, opacity: 0 }} animate={{ y: 0, opacity: 1 }} transition={spring}
      className="glass-bar topbar sticky top-3 z-[var(--z-bar)] mx-4 mt-3 px-4 h-[var(--bar-h)] flex items-center gap-3">
      <Link to="/" className="flex items-center gap-3 min-w-0 hover:no-underline text-ink">
        <motion.span animate={{ rotate: [0, 2, -2, 0] }} transition={{ duration: 8, repeat: Infinity, ease: "easeInOut" }} className="inline-flex"><Mark size={36} /></motion.span>
        <span className="leading-tight min-w-0 hidden sm:block">
          <span className="block font-semibold text-[14px] tracking-tight truncate">Rocket Profile Analysis</span>
          <span className="block text-[11px] text-ink-3 truncate">two-stage flight profile · OpenRocket + RASAero II</span>
        </span>
      </Link>

      <div className="hidden lg:flex items-center gap-1.5 min-w-0 ml-2">
        {project && <Tip text={state?.root}><span className="topbar-chip"><Icon of={FolderOpen} size="sm" /><span className="truncate max-w-[180px]">{project}</span></span></Tip>}
        {state && <Tip text="target apogee"><span className="topbar-chip num"><Icon of={Crosshair} size="sm" />{fmt(state.config.target.apogee_ft, 0)} ± {fmt(state.config.target.tolerance_ft, 0)} ft</span></Tip>}
        {state && (
          <Tip text={e?.detail || "simulation engine"}>
            <Link to="/engine" className={cn("topbar-chip btn hover:no-underline", e?.ok ? "tone-good" : "tone-bad")}>
              <Icon of={Cpu} size="sm" />engine: {e?.ok ? "ready" : "missing"}
            </Link>
          </Tip>
        )}
        <button type="button" data-drawer-toggle className={cn("topbar-chip btn", busy ? "tone-info" : connected && !stopped ? "tone-good" : "")} onClick={() => setDrawerOpen(!drawerOpen)}
                title={busy ? `running ${runner?.stage}` : "idle"}>
          {busy ? <LiveDot tone="info" /> : <span className={cn("dot", connected && !stopped ? "tone-good" : "tone-muted")} />}
          {busy ? <span className="num">running: {runner?.stage}{runner?.substage && runner.stage === "run" ? " · " + runner.substage : ""} · {dur(runner?.elapsed_s)}</span>
                : stopped ? "stopped" : connected ? "idle" : "connecting…"}
        </button>
      </div>

      <div className="ml-auto flex items-center gap-1">
        <NavIcon to="/setup" icon={Wrench} label="Setup" active={path === "/setup"} />
        <NavIcon to="/engine" icon={Cpu} label="Engine" active={path === "/engine"} dot={e ? (e.ok ? null : "bad") : null} />
        <NavIcon to="/runs" icon={History} label={last ? `Runs & logs · last: rpa ${last.stage} ${outcomeText(last)}` : "Runs & logs"} active={path === "/runs"} dot={lastBad ? "bad" : null} />
        <NavIcon to="/settings" icon={Settings} label="Settings · config.yaml" active={path === "/settings"} />
        <span className="w-px h-6 bg-line mx-1" />
        <IconButton icon={ThemeIcon} label={`theme: ${theme}`} onClick={cycleTheme} />
        <IconButton icon={Power} label="quit the app" onClick={() => setQuitAsk(true)} />
      </div>
      <ConfirmDialog open={quitAsk} onOpenChange={setQuitAsk} title="Quit Rocket Profile Analysis?"
                     body={busy ? `"${runner?.stage}" is still running and will be cancelled.` : "The engine processes are stopped; relaunch the app to come back."} okLabel="Quit" danger onOk={quit} />
    </motion.header>
  );
}

function NavIcon({ to, icon, label, active, dot }: { to: string; icon: LucideIcon; label: string; active: boolean; dot?: Tone | null }) {
  return (
    <Tip text={label}>
      <Link to={to} className={cn("icon-btn hover:no-underline", active && "on")} aria-label={label} aria-current={active ? "page" : undefined}>
        <Icon of={icon} size="md" />
        {dot && <span className={cn("dot", `tone-${dot}`)} />}
      </Link>
    </Tip>
  );
}

/* ---------------------------------------------------- progress strip */

export function ProgressStrip() {
  const r = useRunner();
  const subStart = useSubStart();
  const eta = useEta(r, subStart);
  const live = !!r?.running;
  const pct = r?.progress?.total ? r.progress.done / r.progress.total : undefined;
  return (
    <AnimatePresence initial={false}>
      {live && (
        <motion.div initial={{ height: 0, opacity: 0 }} animate={{ height: "auto", opacity: 1 }} exit={{ height: 0, opacity: 0 }} transition={spring} className="mx-4 mt-3 overflow-hidden">
          <div className="glass px-4 py-2.5 flex items-center gap-4">
            <LiveDot tone="info" />
            <span className="text-[12.5px] font-medium whitespace-nowrap">rpa {r!.stage}{r!.substage ? <span className="text-ink-3"> · {r!.substage}</span> : null}</span>
            <Bar className="flex-1" fraction={pct} indeterminate={pct === undefined} tone="info" />
            <span className="text-[12px] text-ink-2 num whitespace-nowrap">
              {r!.round ? `round ${r!.round.round} · ` : ""}{r!.progress?.total ? `${r!.progress.done}/${r!.progress.total} · ` : ""}{dur(r!.elapsed_s)}{eta ? " · " + eta : ""}
            </span>
            <button type="button" className="link" onClick={cancelRun}>Cancel</button>
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}

/* ----------------------------------------------------------- stepper */

const RING: Record<string, string> = { ok: "done", partial: "warn", warn: "warn", stale: "warn", error: "bad", running: "run", todo: "", unchecked: "" };

export function Stepper() {
  const state = useAppState();
  const path = useRouterState({ select: (s) => s.location.pathname });
  const id = "stepper";
  const items = [
    { key: "overview", to: "/", label: "Overview", active: path === "/", ring: <Icon of={Home} size="sm" />, status: "", sub: "" },
    ...STEPS.map((st) => {
      const s = stepStatus(state, st.id);
      return { key: st.id, to: st.path, label: st.title, active: path.startsWith(st.path), status: s, sub: s === "running" ? "running" : STATUS_TEXT[s] || s,
        ring: s === "running" ? <LiveDot tone="info" /> : <span className={cn("step-ring", path.startsWith(st.path) && "active", RING[s])}>{s === "ok" ? <CheckMark /> : st.n}</span> };
    }),
  ];
  return (
    <nav className="mx-4 mt-4 scroll-x" aria-label="Steps">
      <div className="flex gap-1 pb-1 px-1 w-max min-w-full">
        {items.map((it) => (
          <Link key={it.key} to={it.to} className={cn("step-tab hover:no-underline", it.active && "active", it.status === "ok" && "done")} aria-current={it.active ? "page" : undefined} title={it.sub}>
            {it.active && <motion.span layoutId={`${id}-pill`} transition={spring} className="step-tab-pill glass-strong" />}
            {it.ring}
            <span>{it.label}</span>
            {it.status && it.status !== "ok" && it.status !== "todo" ? <Badge status={it.status} lower className="hidden xl:inline-flex" /> : null}
          </Link>
        ))}
      </div>
    </nav>
  );
}

function CheckMark() {
  return <svg viewBox="0 0 12 12" width="10" height="10" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M2 6.5l2.5 2.5L10 3.5" /></svg>;
}

/* ------------------------------------------------------------ drawer */

const lineClass = (t: string) => t.startsWith("$ ") ? "cmd" : t.startsWith("vm: FAILED") ? "bad" : t.startsWith("vm:") ? "hdr" : /^===/.test(t) ? "hdr" : /^---/.test(t) ? (t.includes("findings") ? "warn" : t.includes("finished") ? "done" : "bad") : /Traceback|Error|error|FAIL|failure|failed/.test(t) ? "bad" : /!!|warning|WARN|stale/.test(t) ? "warn" : "";

function LogBody({ height }: { height: number }) {
  const lines = useLive((s) => s.lines);
  const follow = useUi((s) => s.follow), setFollow = useUi((s) => s.setFollow), errorsOnly = useUi((s) => s.errorsOnly);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => { if (follow && ref.current) ref.current.scrollTop = ref.current.scrollHeight; }, [lines, follow]);
  return (
    <div ref={ref} className={cn("overflow-auto border-t border-line py-1", errorsOnly && "errors-only")} style={{ height }}
         onScroll={() => { const el = ref.current; if (!el) return; const atEnd = el.scrollTop + el.clientHeight >= el.scrollHeight - 8; if (atEnd !== follow) setFollow(atEnd); }}>
      {lines.length ? lines.map((l) => <div key={l.seq} className={cn("log-line", lineClass(l.text))}><span className="log-t">{clock(l.t)}</span>{l.text}</div>)
                    : <div className="log-line text-ink-3">nothing logged yet</div>}
    </div>
  );
}

export function ActivityDrawer() {
  const r = useRunner();
  const subStart = useSubStart();
  const eta = useEta(r, subStart);
  const open = useUi((s) => s.drawerOpen), setOpen = useUi((s) => s.setDrawerOpen);
  const height = useUi((s) => s.drawerHeight), setHeight = useUi((s) => s.setDrawerHeight);
  const follow = useUi((s) => s.follow), setFollow = useUi((s) => s.setFollow);
  const errorsOnly = useUi((s) => s.errorsOnly), setErrorsOnly = useUi((s) => s.setErrorsOnly);
  const clearLog = useLive((s) => s.clearLog);
  const pct = r?.progress?.total ? r.progress.done / r.progress.total : undefined;
  const drag = (ev: React.PointerEvent<HTMLDivElement>) => {
    ev.preventDefault();
    const el = ev.currentTarget; el.setPointerCapture(ev.pointerId);
    document.body.classList.add("dragging");
    const y0 = ev.clientY, h0 = height;
    const move = (e: PointerEvent) => setHeight(Math.max(80, Math.min(window.innerHeight * 0.8, h0 + (y0 - e.clientY))));
    const up = () => { el.removeEventListener("pointermove", move); el.removeEventListener("pointerup", up); document.body.classList.remove("dragging"); };
    el.addEventListener("pointermove", move); el.addEventListener("pointerup", up);
  };
  const copy = () => {
    const lines = useLive.getState().lines;
    navigator.clipboard.writeText(lines.map((l) => `${clock(l.t)}  ${l.text}`).join("\n")).then(() => toast("log copied"), () => toast.error("copy failed"));
  };
  return (
    <motion.section initial={{ y: 24, opacity: 0 }} animate={{ y: 0, opacity: 1 }} transition={spring}
      className="glass-bar drawer sticky bottom-3 z-[var(--z-drawer)] mx-4 mb-3 mt-4" aria-label="Activity">
      {open && <div className="drag-handle mx-4 mt-1" onPointerDown={drag} title="drag to resize the log" />}
      <div className="flex flex-wrap items-center gap-2 px-3 min-h-[var(--drawer-h)] text-[12px]">
        <Button size="sm" variant="ghost" data-drawer-toggle onClick={() => setOpen(!open)} aria-expanded={open}>
          <Icon of={open ? ChevronDown : ChevronUp} size="sm" /><Icon of={Activity} size="sm" />Activity
        </Button>
        {r?.running ? <Badge status="running" lower><LiveDot tone="info" />running: rpa {[r.stage, ...(r.args || [])].join(" ")}</Badge> : <Badge status="ok" lower>idle</Badge>}
        {r?.side ? <Badge status="running" lower title="a light stage running beside the main one">+ {r.side.stage} · {dur(r.side.elapsed_s)}</Badge> : null}
        {r?.running ? <Bar className="max-w-[320px] flex-1" fraction={pct} indeterminate={pct === undefined} tone="info" /> : <span className="flex-1" />}
        {r?.running ? <span className="text-ink-2 num">{r.substage ? r.substage + " · " : ""}{r.round ? `round ${r.round.round} · ` : ""}{r.progress?.total ? `${r.progress.done}/${r.progress.total} · ` : ""}{dur(r.elapsed_s)}{eta ? " · " + eta : ""}</span>
          : r?.finished ? <span className="text-ink-3 num">last: rpa {r.stage} {outcomeText(r)} · {dur(r.elapsed_s)}</span> : null}
        {r?.running ? <Button size="sm" variant="danger" onClick={cancelRun}>Cancel</Button> : null}
        <Button size="sm" variant="chip" onClick={clearLog}><Icon of={Trash2} size="xs" />Clear</Button>
        <Button size="sm" variant="chip" title="copy the whole log" onClick={copy}><Icon of={Copy} size="xs" />Copy</Button>
        <Check checked={errorsOnly} onChange={setErrorsOnly} className="text-[12px]"><span className="text-[12px]">errors only</span></Check>
        <Check checked={follow} onChange={setFollow}><span className="text-[12px]">follow</span></Check>
      </div>
      <AnimatePresence initial={false}>
        {open && (
          <motion.div key="log" initial={{ height: 0, opacity: 0 }} animate={{ height: "auto", opacity: 1 }} exit={{ height: 0, opacity: 0 }} transition={{ type: "spring", stiffness: 300, damping: 32 }} className="overflow-hidden">
            <LogBody height={height} />
          </motion.div>
        )}
      </AnimatePresence>
    </motion.section>
  );
}

/* ------------------------------------------------------------- frame */

function Notice({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="glass card static max-w-[560px] mx-auto mt-16 items-center text-center !py-10">
      <motion.span animate={{ opacity: [0.5, 1, 0.5] }} transition={{ duration: 1.6, repeat: Infinity }} className="inline-flex"><Mark size={44} /></motion.span>
      <h2 className="text-[18px] font-semibold mt-2">{title}</h2>
      <p className="text-ink-2 text-[13.5px] leading-relaxed">{children}</p>
    </div>
  );
}

export function Shell() {
  useLiveConnection();
  const state = useAppState();
  const stateError = useStateError();
  const stopped = useUi((s) => s.stopped);
  const path = useRouterState({ select: (s) => s.location.pathname });
  useEffect(() => { window.scrollTo(0, 0); }, [path]);
  return (
    <div className="min-h-full flex flex-col">
      <div className="backdrop" aria-hidden="true" />
      <Topbar />
      <ProgressStrip />
      <Stepper />
      <main className="flex-1 mx-4 mt-4 min-w-0">
        {stopped ? <Notice title="Stopped">The Rocket Profile Analysis service has been shut down. Relaunch the app to come back.</Notice>
          : !state && stateError ? <Notice title="Connecting…">The service is not answering yet ({stateError}). It starts with the app; if this persists, open Runs &amp; logs after a restart.</Notice>
          : !state ? <Notice title="Connecting…">Reading the project.</Notice>
          : (
            <motion.div key={path} variants={stagger} initial="hidden" animate="show" className="flex flex-col gap-4">
              <Outlet />
            </motion.div>
          )}
      </main>
      <ActivityDrawer />
    </div>
  );
}
