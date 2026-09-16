import { useEffect, useRef, useState } from "react";
import { Link, Outlet, useRouterState } from "@tanstack/react-router";
import { toast } from "sonner";
import { Activity, ChevronDown, ChevronUp, Copy, Cpu, History, Home, ListChecks, Moon, Power, Settings, Sun, SunMoon, Trash2 } from "lucide-react";
import { api } from "@/lib/api";
import { clock, dur, fmt } from "@/lib/format";
import { useApp, useEta } from "@/lib/store";
import { STATUS_TEXT, STEPS, outcomeText, stepStatus } from "@/lib/types";
import { cn } from "@/lib/utils";
import { cancelRun } from "./common";
import { Badge } from "./ui/badge";
import { Button } from "./ui/button";
import { ConfirmDialog } from "./ui/dialog";
import { Progress } from "./ui/progress";

const NUM_CLS: Record<string, string> = { ok: "bg-ok text-white", partial: "bg-warn text-white", warn: "bg-warn text-white", stale: "bg-warn text-white", error: "bg-err text-white", running: "bg-run text-white animate-pulse", todo: "bg-panel-2 text-muted border border-line", unchecked: "bg-panel-2 text-muted border border-line" };

function NavItem({ to, num, title, sub, status, active }: { to: string; num: React.ReactNode; title: string; sub?: string; status?: string; active: boolean }) {
  return <Link to={to} className={cn("flex items-center gap-2.5 rounded-md px-2 py-1.5 text-left hover:bg-panel-2", active && "bg-accent-bg/70 dark:bg-accent-bg/40")} aria-current={active ? "page" : undefined}>
    <span className={cn("grid h-6 w-6 shrink-0 place-items-center rounded-full text-[11px] font-semibold", NUM_CLS[status || "todo"])}>{num}</span>
    <span className="min-w-0"><span className="block truncate text-[13px] font-medium">{title}</span>{sub ? <span className={cn("block truncate text-[11px] text-muted", status === "running" && "text-run")}>{sub}</span> : null}</span>
  </Link>;
}

export function Sidebar() {
  const { state } = useApp();
  const path = useRouterState({ select: (s) => s.location.pathname });
  const w = state?.worker, e = state?.engine;
  const last = state?.history?.length ? state.history[state.history.length - 1] : null;
  const lastBad = last && last.exit_code !== 0 && !last.cancelled && !(last.exit_code === 1 && ["check", "validate"].includes(last.stage));
  return <nav className="flex h-full w-[260px] shrink-0 flex-col gap-0.5 overflow-y-auto border-r border-line bg-panel px-2 py-3">
    <NavItem to="/" num={<Home className="h-3.5 w-3.5" />} title="Overview" sub="status & next action" active={path === "/"} />
    <div className="mt-2 px-2 text-[10px] font-semibold uppercase tracking-wider text-faint">Step by step</div>
    {STEPS.map((st) => { const s = stepStatus(state, st.id); return <NavItem key={st.id} to={st.path} num={st.n} title={st.title} sub={s === "running" ? "running…" : (STATUS_TEXT[s] || s) + " · " + st.sub} status={s} active={path.startsWith(st.path)} />; })}
    <div className="mt-2 px-2 text-[10px] font-semibold uppercase tracking-wider text-faint">Infrastructure</div>
    <NavItem to="/engine" num={<Cpu className="h-3.5 w-3.5" />} title="Engine" sub={e ? (e.ok ? `native · ${e.pool?.pools?.[0]?.alive ?? 0} hosts warm` : e.detail) : w ? `${w.state} · ${w.detail}` : ""} status={e?.ok ? "ok" : "error"} active={path === "/engine"} />
    <NavItem to="/runs" num={<History className="h-3.5 w-3.5" />} title="Runs & logs" sub={last ? `last: rpa ${last.stage} ${outcomeText(last)}` : "logs and result snapshots"} status={lastBad ? "error" : "todo"} active={path === "/runs"} />
    <NavItem to="/settings" num={<Settings className="h-3.5 w-3.5" />} title="Settings" sub="config.yaml" status="todo" active={path === "/settings"} />
    <div className="mt-auto px-2 pt-3 text-[11px] text-faint"><ListChecks className="mr-1 inline h-3 w-3" />{state?.root ? state.root.split(/[\\/]/).slice(-1)[0] : "…"}</div>
  </nav>;
}

export function Topbar() {
  const { state, runner, theme, setTheme, activityOpen, setActivityOpen, connected, stopped, setStopped } = useApp();
  const [quitAsk, setQuitAsk] = useState(false);
  const r = runner;
  const busy = !!r?.running;
  const quit = async () => { try { await api("/api/quit", {}); } catch { /* going away */ } setStopped(true); };
  return <header className="flex h-12 shrink-0 items-center gap-3 border-b border-line bg-panel px-4">
    <div className="flex items-center gap-2"><span className="text-lg">🚀</span><div><div className="text-[14px] font-semibold leading-4">Rocket Profile Analysis</div><div className="text-[10.5px] text-muted">Two-stage flight profile optimizer · OpenRocket + RASAero II</div></div></div>
    <div className="ml-auto flex flex-wrap items-center gap-1.5 text-[12px]">
      {state ? <span className="rounded-full border border-line px-2 py-0.5" title="target apogee">🎯 {fmt(state.config.target.apogee_ft, 0)} ± {fmt(state.config.target.tolerance_ft, 0)} ft</span> : null}
      {state ? <span className="rounded-full border border-line px-2 py-0.5" title="simulation backend">backend: {state.config.backend}</span> : null}
      {state ? <Link to="/engine" className={cn("rounded-full border px-2 py-0.5", state.engine?.ok ? "border-ok/40 bg-ok-bg text-ok" : "border-err/40 bg-err-bg text-err")} title={state.engine?.detail}>● engine: {state.engine?.ok ? "ready" : "missing"}</Link> : null}
      <button type="button" className={cn("rounded-full border px-2 py-0.5", busy ? "border-run/40 bg-run-bg text-run" : "border-ok/40 bg-ok-bg text-ok")} onClick={() => setActivityOpen(!activityOpen)} title={busy ? `running ${r?.stage}` : "idle"}>● {busy ? `running: ${r?.stage}${r?.substage && r.stage === "run" ? " › " + r.substage : ""} · ${dur(r?.elapsed_s)}` : stopped ? "stopped" : connected ? "idle" : "connecting…"}</button>
      <button type="button" className="rounded-full border border-line px-2 py-0.5 inline-flex items-center gap-1" title={`theme: ${theme}`} onClick={() => setTheme(theme === "auto" ? "light" : theme === "light" ? "dark" : "auto")}>{theme === "auto" ? <SunMoon className="h-3.5 w-3.5" /> : theme === "light" ? <Sun className="h-3.5 w-3.5" /> : <Moon className="h-3.5 w-3.5" />}{theme}</button>
      <button type="button" className="rounded-full border border-line px-2 py-0.5 inline-flex items-center gap-1" title="quit the app" onClick={() => setQuitAsk(true)}><Power className="h-3.5 w-3.5" />quit</button>
    </div>
    <ConfirmDialog open={quitAsk} onOpenChange={setQuitAsk} title="Quit Rocket Profile Analysis?" body={busy ? `"${r?.stage}" is still running and will be cancelled.` : "The engine processes are stopped; relaunch the app to come back."} okLabel="Quit" danger onOk={quit} />
  </header>;
}

const lineClass = (t: string) => t.startsWith("$ ") ? "cmd" : t.startsWith("vm: FAILED") ? "bad" : t.startsWith("vm:") ? "hdr" : /^===/.test(t) ? "hdr" : /^---/.test(t) ? (t.includes("findings") ? "warn" : t.includes("finished") ? "done" : "bad") : /Traceback|Error|error|FAIL|failure|failed/.test(t) ? "bad" : /!!|warning|WARN|stale/.test(t) ? "warn" : "";

export function ActivityPanel() {
  const { runner, lines, clearLog, activityOpen, setActivityOpen, follow, setFollow, errorsOnly, setErrorsOnly, subStart } = useApp();
  const logRef = useRef<HTMLDivElement>(null);
  const eta = useEta(runner, subStart);
  const r = runner;
  const [h, setH] = useState<number>(() => { try { return Number(localStorage.getItem("rpa-activity-h")) || 260; } catch { return 260; } });
  useEffect(() => { if (follow && logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight; }, [lines, follow, activityOpen]);
  const drag = (ev: React.MouseEvent) => {
    ev.preventDefault();
    const y0 = ev.clientY, h0 = h;
    const move = (e: MouseEvent) => setH(Math.max(80, Math.min(window.innerHeight * 0.8, h0 + (y0 - e.clientY))));
    const up = () => { window.removeEventListener("mousemove", move); window.removeEventListener("mouseup", up); setH((v) => { try { localStorage.setItem("rpa-activity-h", String(Math.round(v))); } catch { /* ignore */ } return v; }); };
    window.addEventListener("mousemove", move); window.addEventListener("mouseup", up);
  };
  const pct = r?.progress?.total ? (100 * r.progress.done) / r.progress.total : undefined;
  return <section className="shrink-0 border-t border-line bg-panel">
    {activityOpen ? <div className="h-1 cursor-row-resize bg-line hover:bg-accent" onMouseDown={drag} title="drag to resize the log" /> : null}
    <div className="flex flex-wrap items-center gap-2 px-3 py-1.5 text-[12px]">
      <Button size="sm" variant="ghost" onClick={() => setActivityOpen(!activityOpen)}>{activityOpen ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronUp className="h-3.5 w-3.5" />}<Activity className="h-3.5 w-3.5" />Activity</Button>
      {r?.running ? <Badge status="running">running: rpa {[r.stage, ...(r.args || [])].join(" ")}</Badge> : <Badge status="ok">idle</Badge>}
      {r?.side ? <Badge status="running" title="a light stage running beside the main one">+ {r.side.stage} · {dur(r.side.elapsed_s)}</Badge> : null}
      {r?.running ? <Progress className="max-w-[320px] flex-1" value={pct} indeterminate={pct === undefined} /> : <span className="flex-1" />}
      {r?.running ? <span className="text-muted">{r.substage ? r.substage + " · " : ""}{r.round ? `round ${r.round.round} · ` : ""}{r.progress?.total ? `${r.progress.done}/${r.progress.total} · ` : ""}{dur(r.elapsed_s)}{eta ? " · " + eta : ""}</span> : r?.finished ? <span className="text-muted">last: rpa {r.stage} {outcomeText(r)} · {dur(r.elapsed_s)}</span> : null}
      {r?.running ? <Button size="sm" variant="danger" onClick={cancelRun}>Cancel</Button> : null}
      <Button size="sm" variant="ghost" onClick={clearLog}><Trash2 className="h-3.5 w-3.5" />Clear</Button>
      <Button size="sm" variant="ghost" title="copy the whole log" onClick={() => navigator.clipboard.writeText(lines.map((l) => `${clock(l.t)}  ${l.text}`).join("\n")).then(() => toast("log copied"), () => toast.error("copy failed"))}><Copy className="h-3.5 w-3.5" />Copy</Button>
      <label className="inline-flex items-center gap-1"><input type="checkbox" checked={errorsOnly} onChange={(e) => setErrorsOnly(e.target.checked)} />errors only</label>
      <label className="inline-flex items-center gap-1"><input type="checkbox" checked={follow} onChange={(e) => { setFollow(e.target.checked); if (e.target.checked && logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight; }} />follow</label>
    </div>
    {activityOpen ? <div ref={logRef} className={cn("overflow-auto border-t border-line bg-panel-2 font-mono text-[12px] leading-[1.45]", errorsOnly && "errors-only")} style={{ height: h }} onScroll={() => { const el = logRef.current; if (!el) return; const atEnd = el.scrollTop + el.clientHeight >= el.scrollHeight - 8; if (atEnd !== follow) setFollow(atEnd); }}>
      {lines.map((l) => <div key={l.seq} className={cn("log-line", lineClass(l.text))}>{clock(l.t)}  {l.text}</div>)}
    </div> : null}
  </section>;
}

export function Shell() {
  const { stateError, state, stopped } = useApp();
  const mainRef = useRef<HTMLDivElement>(null);
  const path = useRouterState({ select: (s) => s.location.pathname });
  useEffect(() => { mainRef.current?.scrollTo(0, 0); }, [path]);
  return <div className="flex h-full flex-col">
    <Topbar />
    <div className="flex min-h-0 flex-1">
      <Sidebar />
      <main ref={mainRef} className="min-w-0 flex-1 overflow-auto px-6 py-5">
        {stopped ? <div className="card mx-auto mt-16 max-w-[520px]"><h2 className="text-lg font-semibold">Stopped</h2><p className="mt-2 text-muted">The Rocket Profile Analysis service has been shut down. Relaunch the app to come back.</p></div>
          : !state && stateError ? <div className="card mx-auto mt-16 max-w-[560px]"><h2 className="text-lg font-semibold">Connecting…</h2><p className="mt-2 text-muted">The service is not answering yet ({stateError}). It starts with the app; if this persists, open Runs & logs after a restart.</p></div>
          : !state ? <div className="p-8 text-muted">Connecting…</div> : <Outlet />}
      </main>
    </div>
    <ActivityPanel />
  </div>;
}
