import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Link, useNavigate } from "@tanstack/react-router";
import { toast } from "sonner";
import { api, fileUrl } from "@/lib/api";
import { ago, dateTime, dur, esc, fmt, isNum, sizeFmt } from "@/lib/format";
import { useApp, useBusy } from "@/lib/store";
import { FINDINGS_STAGES, LIGHT_STAGES, STEPS, outcomeText, stepStatus, type FileInfo, type RunRecord } from "@/lib/types";
import { cn } from "@/lib/utils";
import { Badge } from "./ui/badge";
import { Button } from "./ui/button";
import { Card } from "./ui/card";
import { ConfirmDialog } from "./ui/dialog";

export function Callout({ kind, children, className }: { kind: "info" | "ok" | "warn" | "err"; children: ReactNode; className?: string }) {
  const cls = { info: "bg-info-bg/60 border-info/30", ok: "bg-ok-bg/60 border-ok/30", warn: "bg-warn-bg/60 border-warn/30", err: "bg-err-bg/60 border-err/30" }[kind];
  return <div className={cn("rounded-md border px-3 py-2 text-[13px] leading-5", cls, className)}>{children}</div>;
}

export function KV({ pairs }: { pairs: (readonly [ReactNode, ReactNode] | null | false | undefined)[] }) {
  return <div className="grid grid-cols-[max-content_1fr] gap-x-4 gap-y-1 text-[13px]">{pairs.filter(Boolean).map((p, i) => { const [k, v] = p as [ReactNode, ReactNode]; return <div key={i} className="contents"><div className="text-muted">{k}</div><div>{v}</div></div>; })}</div>;
}

export function Stat({ label, value, unit, cls, sub, wide }: { label: string; value: ReactNode; unit?: ReactNode; cls?: string | null; sub?: ReactNode; wide?: boolean }) {
  if (unit && typeof unit === "string" && unit.length > 12 && !sub) { sub = unit; unit = undefined; }
  const color = cls === "ok" ? "text-ok" : cls === "warn" ? "text-warn" : cls === "err" ? "text-err" : "";
  return <div className={cn("min-w-[110px] rounded-md border border-line bg-panel-2 px-3 py-2", wide && "col-span-2")} title={typeof sub === "string" ? sub : undefined}><div className="text-[11px] uppercase tracking-wide text-muted truncate" title={label}>{label}</div><div className={cn("text-[17px] font-semibold leading-6 truncate", color)}>{value}{unit ? <small className="ml-1 text-[11px] font-normal text-muted">{unit}</small> : null}</div>{sub ? <div className="text-[11px] text-muted truncate">{sub}</div> : null}</div>;
}
/* grid: tiles fill the row edge to edge instead of hugging the left. */
export function StatList({ children, className, grid }: { children: ReactNode; className?: string; grid?: boolean }) { return <div className={cn(grid ? "grid grid-cols-[repeat(auto-fill,minmax(160px,1fr))] gap-2" : "flex flex-wrap gap-2", className)}>{children}</div>; }

export function CmdPreview({ stage, args }: { stage: string; args?: string[] }) {
  return <div className="mt-2 font-mono text-[12px] text-muted" title="the equivalent command line">$ rpa <b className="text-fg">{[stage, ...(args || [])].join(" ")}</b></div>;
}

export function FileRow({ fi, stale }: { fi: FileInfo; stale?: boolean }) {
  return <div className="flex items-center gap-2 py-1 text-[13px]" title={fi.path || undefined}><span className={cn("inline-block h-2.5 w-2.5 rounded-full", !fi.exists ? "bg-faint" : stale ? "bg-warn" : "bg-ok")} /><span className="font-mono text-[12px] truncate">{fi.name || fi.path}</span><span className="ml-auto text-[12px] text-muted whitespace-nowrap">{fi.exists ? `${sizeFmt(fi.size)} · ${ago(fi.mtime)}` : "missing"}</span></div>;
}

/* First click arms it; second click within 5 s runs. */
export function ConfirmButton({ label, armedLabel, onClick, variant = "default", size = "sm", className, disabled }: { label: ReactNode; armedLabel: ReactNode; onClick: () => Promise<unknown> | void; variant?: any; size?: any; className?: string; disabled?: boolean }) {
  const [armed, setArmed] = useState(false);
  const [busy, setBusy] = useState(false);
  useEffect(() => { if (!armed) return; const t = setTimeout(() => setArmed(false), 5000); return () => clearTimeout(t); }, [armed]);
  return <Button variant={armed ? "danger" : variant} size={size} className={className} disabled={disabled || busy} onClick={async () => { if (!armed) { setArmed(true); return; } setArmed(false); setBusy(true); try { await onClick(); } finally { setBusy(false); } }}>{armed ? armedLabel : label}</Button>;
}

export async function cancelRun() { try { await api("/api/cancel", {}); toast("cancel requested"); } catch (e: any) { toast.error(e.message); } }

export function RunButton({ stage, args = [], label, primary, disabled, title, confirmText, size, className }: { stage: string; args?: string[]; label?: ReactNode; primary?: boolean; disabled?: boolean; title?: string; confirmText?: string | null; size?: any; className?: string }) {
  const { runner, setActivityOpen, setFollow } = useApp();
  const busy = useBusy();
  const [ask, setAsk] = useState(false);
  const [starting, setStarting] = useState(false);
  const same = (x: any) => x && x.stage === stage && JSON.stringify(x.args) === JSON.stringify(args);
  const mine = (busy && same(runner)) || same(runner?.side);
  const blocked = busy && !(LIGHT_STAGES.includes(stage) && !runner?.side);
  const start = async () => {
    setStarting(true);
    try { await api("/api/run", { stage, args, label: typeof label === "string" ? label : undefined }); setActivityOpen(true); setFollow(true); toast(`started: rpa ${[stage, ...args].join(" ")}`); }
    catch (e: any) { toast.error(e.message); }
    finally { setStarting(false); }
  };
  return <>
    <Button variant={primary ? "primary" : "default"} size={size} className={className} disabled={disabled || blocked || starting} title={blocked ? `busy: ${runner?.stage} is running${runner?.side ? " and " + runner.side.stage + " beside it" : ""}` : title || ""} onClick={() => (confirmText ? setAsk(true) : start())}>{mine ? <span className="inline-block h-3 w-3 animate-spin rounded-full border-2 border-current border-t-transparent" /> : null}{mine ? "running…" : label || `Run ${stage}`}</Button>
    {confirmText ? <ConfirmDialog open={ask} onOpenChange={setAsk} title="Are you sure?" body={confirmText} okLabel="Run" danger onOk={start} /> : null}
  </>;
}

/* options sit beside the buttons; stats get the full width under them. */
export function ActionPanel({ title, prereqs = [], buttons, options, stats, notes, cmd, vm }: { title?: string; prereqs?: { label: string; ok: boolean | "warn"; hint?: string }[]; buttons?: ReactNode; options?: ReactNode; stats?: ReactNode; notes?: ReactNode; cmd?: ReactNode; vm?: boolean }) {
  const missing = prereqs.filter((p) => p.ok === false);
  return <div className="rounded-[var(--radius-card)] border border-accent/30 bg-accent-bg/30 p-4 dark:bg-accent-bg/20">
    <div className="mb-2 flex flex-wrap items-center justify-between gap-2"><div className="text-[13px] font-semibold uppercase tracking-wide text-muted">{title || "Run this step"}{vm ? <Badge status="info" className="ml-2 normal-case tracking-normal">RASAero engine</Badge> : null}</div>
      {prereqs.length ? <div className="flex flex-wrap gap-1.5">{prereqs.map((p, i) => <span key={i} title={p.hint || ""} className={cn("rounded-full border px-2 py-[1px] text-[11px]", p.ok === false ? "border-err/40 bg-err-bg text-err" : p.ok === "warn" ? "border-warn/40 bg-warn-bg text-warn" : "border-ok/40 bg-ok-bg text-ok")}>{p.ok === false ? "✗" : p.ok === "warn" ? "!" : "✓"} {p.label}</span>)}</div> : null}</div>
    <div className="flex flex-wrap items-start gap-3"><div className="flex flex-wrap gap-2">{buttons}</div>{options ? <div className="min-w-[260px] flex-1">{options}</div> : null}</div>
    {stats ? <div className="mt-3">{stats}</div> : null}
    {missing.length ? <Callout kind="warn" className="mt-3"><b>Before you run: </b>{missing.map((p) => p.hint || p.label).join(" · ")}</Callout> : null}
    {notes ? <div className="mt-3 flex flex-col gap-2">{notes}</div> : null}
    {cmd}
  </div>;
}

export function StepPage({ id, summary, action, children, how, extraStatus }: { id: string; summary?: ReactNode; action?: ReactNode; children?: ReactNode; how?: ReactNode; extraStatus?: ReactNode }) {
  const { state } = useApp();
  const st = STEPS.find((x) => x.id === id)!;
  const status = stepStatus(state, id);
  const list = STEPS as readonly (typeof STEPS)[number][];
  const prev = list[st.n - 2], next = list[st.n];
  return <div className="flex flex-col gap-4">
    <div><div className="text-[11px] uppercase tracking-wide text-muted">Step {st.n} of {STEPS.length}</div><div className="flex flex-wrap items-center gap-2"><h1 className="text-[22px] font-semibold">{st.title}</h1><Badge status={status} />{extraStatus}</div>{summary ? <div className="mt-1 max-w-[900px] text-[13px] text-muted">{summary}</div> : null}</div>
    {action}
    {children}
    {how ? <details className="card"><summary className="cursor-pointer text-[13px] font-semibold">How this step works</summary><div className="mt-2 text-[13px] leading-6 text-muted [&_b]:text-fg [&_code]:font-mono [&_code]:text-[12px] [&_ol]:list-decimal [&_ol]:pl-5 [&_ul]:list-disc [&_ul]:pl-5">{how}</div></details> : null}
    <div className="flex items-center gap-2 pt-2"><Button asChild><Link to={prev ? prev.path : "/"}>{prev ? `← Step ${prev.n}: ${prev.short}` : "← Overview"}</Link></Button><span className="flex-1" /><Button asChild><Link to={next ? next.path : "/"}>{next ? `Step ${next.n}: ${next.short} →` : "Overview →"}</Link></Button></div>
  </div>;
}

export function RunHistory({ hist }: { hist: RunRecord[] }) {
  const nav = useNavigate();
  if (!hist || !hist.length) return <div className="text-[12px] text-muted">nothing has been run from this app yet</div>;
  const rows = hist.slice().reverse().slice(0, 12);
  const failed = (r: RunRecord) => r.exit_code !== 0 && !r.cancelled && !(r.exit_code === 1 && FINDINGS_STAGES.includes(r.stage));
  return <div className="flex flex-col divide-y divide-line">{rows.map((r, i) => <button key={i} type="button" className="flex flex-wrap items-center gap-2 py-1.5 text-left text-[13px] hover:bg-panel-2" onClick={() => nav({ to: "/runs", search: { sel: String(r.started) } as any })}><span className={cn("inline-block h-2.5 w-2.5 rounded-full", failed(r) ? "bg-err" : r.cancelled ? "bg-faint" : r.exit_code === 0 ? "bg-ok" : "bg-warn")} /><span className="font-mono text-[12px]">{["rpa", r.stage, ...(r.args || [])].join(" ")}</span><span className="ml-auto text-[12px] text-muted">{outcomeText(r)} · {dur(r.elapsed_s)} · {dateTime(r.finished)}</span>{failed(r) && r.last_error ? <span className="basis-full text-[12px] text-err truncate">{r.last_error}</span> : null}</button>)}</div>;
}

export function WorkerCard() {
  const { state } = useApp();
  if (!state) return null;
  const w = state.worker, e = state.engine || {};
  const cls: Record<string, string> = { busy: "run", online: "ok", idle: "ok", queued: "warn", unresponsive: "err", offline: "err" };
  return <Card><div className="mb-2 flex items-center justify-between"><h2 className="text-[15px] font-semibold">RASAero engine</h2><Link to="/engine" className="text-[12px] text-accent">details →</Link></div>
    <div className="flex items-center gap-2"><Badge status={cls[w.state] || "todo"}>{w.state}</Badge><span className="text-[12px] text-muted">{w.detail}</span></div>
    <KV pairs={[["engine", e.ok ? `native · ${e.pool?.pools?.[0] ? e.pool.pools[0].alive + " host(s) warm" : "ready"}` : e.detail || "—"], ["OpenRocket", e.warmup?.openrocket || (e.openrocket?.jar ? "found" : "not found")], ["mode", w.mode === "auto" ? "auto" : "manual"]]} />
  </Card>;
}

/* ---- markdown (report.md) ------------------------------------------------ */
export function mdToHtml(text: string): string {
  const lines = text.split("\n");
  let html = "", i = 0;
  const inline = (s: string) => esc(s).replace(/`([^`]+)`/g, "<code>$1</code>").replace(/\*\*([^*]+)\*\*/g, "<b>$1</b>").replace(/\*([^*]+)\*/g, "<i>$1</i>");
  while (i < lines.length) {
    const ln = lines[i];
    if (/^\s*\|/.test(ln)) {
      const rows: string[] = [];
      while (i < lines.length && /^\s*\|/.test(lines[i])) { rows.push(lines[i]); i++; }
      const cells = (r: string) => r.trim().replace(/^\||\|$/g, "").split("|").map((c) => c.trim());
      const head = cells(rows[0]);
      const body = rows.slice(1).filter((r) => !/^\s*\|?\s*:?-+/.test(r)).map(cells);
      html += '<div class="overflow-auto"><table><thead><tr>' + head.map((c) => `<th>${inline(c)}</th>`).join("") + "</tr></thead><tbody>" + body.map((r) => "<tr>" + r.map((c) => `<td>${inline(c)}</td>`).join("") + "</tr>").join("") + "</tbody></table></div>";
      continue;
    }
    const hm = /^(#{1,4})\s+(.*)$/.exec(ln);
    if (hm) { html += `<h${hm[1].length}>${inline(hm[2])}</h${hm[1].length}>`; i++; continue; }
    if (/^\s*[-*]\s+/.test(ln)) { html += "<ul>"; while (i < lines.length && /^\s*[-*]\s+/.test(lines[i])) { html += `<li>${inline(lines[i].replace(/^\s*[-*]\s+/, ""))}</li>`; i++; } html += "</ul>"; continue; }
    if (/^```/.test(ln)) { let code = ""; i++; while (i < lines.length && !/^```/.test(lines[i])) { code += lines[i] + "\n"; i++; } i++; html += `<pre class="console">${esc(code)}</pre>`; continue; }
    if (ln.trim() === "") { i++; continue; }
    let para = ln; i++;
    while (i < lines.length && lines[i].trim() !== "" && !/^(#|\s*[-*]\s|\s*\||```)/.test(lines[i])) { para += " " + lines[i]; i++; }
    html += `<p>${inline(para)}</p>`;
  }
  return html;
}
export function ReportView({ text }: { text: string }) {
  const html = useMemo(() => mdToHtml(text), [text]);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const md = ref.current; if (!md) return;
    for (const table of md.querySelectorAll("table")) {
      const rows = table.tBodies[0] ? [...table.tBodies[0].rows] : [];
      if (rows.length <= 50) continue;
      rows.slice(25).forEach((r) => { r.hidden = true; });
      const btn = document.createElement("button"); btn.className = "mt-2 rounded border border-line px-2 py-1 text-[12px]"; btn.textContent = `show all ${rows.length} rows`;
      btn.onclick = () => { rows.forEach((r) => { r.hidden = false; }); btn.remove(); };
      table.parentElement?.after(btn);
    }
  }, [html]);
  return <div><div className="mb-2 flex justify-end"><Button size="sm" onClick={() => api("/api/reveal", { path: "output/report.md" }).catch((e: any) => toast.error(e.message))}>Reveal report.md</Button></div><div ref={ref} className="md" dangerouslySetInnerHTML={{ __html: html }} /></div>;
}

export function Lightbox({ src, onClose }: { src: string | null; onClose: () => void }) {
  useEffect(() => { if (!src) return; const k = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); }; document.addEventListener("keydown", k); return () => document.removeEventListener("keydown", k); }, [src, onClose]);
  if (!src) return null;
  return <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-6" onClick={onClose}><img src={src} className="max-h-full max-w-full rounded bg-white" /></div>;
}
export const plotUrl = (p: FileInfo) => fileUrl(p.path || "", p.mtime);
export { fmt, isNum };
