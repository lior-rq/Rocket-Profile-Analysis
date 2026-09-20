/* App-specific compositions built on the primitives: the run button, the
   action panel, the step page frame, file rows, history, the report view. */
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Link, useNavigate } from "@tanstack/react-router";
import { AlertTriangle, ArrowLeft, ArrowRight, Check as CheckIcon, ChevronRight, Cpu, ExternalLink, X } from "lucide-react";
import { motion } from "motion/react";
import { toast } from "sonner";
import { api, fileUrl } from "@/lib/api";
import { ago, dateTime, dur, esc, fmt, isNum, sizeFmt } from "@/lib/format";
import { useAppState, useBusy, useRunner } from "@/lib/store";
import { FINDINGS_STAGES, LIGHT_STAGES, STEPS, outcomeText, stepStatus, type FileInfo, type RunRecord } from "@/lib/types";
import { cn } from "@/lib/utils";
import { useUi } from "@/store/ui";
import { Badge, Button, Card, ConfirmDialog, Dot, Icon, KV, LiveDot, Pill, Problem, RM, cx } from "./ui";

export { KV, Problem };

/* ---------------------------------------------------------- headings */

export function StepHead({ title, sub, kicker, children, className }: { title: ReactNode; sub?: ReactNode; kicker?: ReactNode; children?: ReactNode; className?: string }) {
  return (
    <header className={cn("flex items-end justify-between gap-4 flex-wrap", className)}>
      <div className="min-w-0">
        {kicker && <div className="micro mb-1">{kicker}</div>}
        <motion.h1 initial={RM ? false : { opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.05 }} className="text-[26px] font-semibold tracking-tight flex items-center gap-3 flex-wrap">
          {title}
        </motion.h1>
        {sub && <motion.p initial={RM ? false : { opacity: 0 }} animate={{ opacity: 1 }} transition={{ delay: 0.12 }} className="text-ink-2 text-[13.5px] mt-1 max-w-[900px] leading-relaxed">{sub}</motion.p>}
      </div>
      {children && <div className="flex items-center gap-2 flex-wrap shrink-0">{children}</div>}
    </header>
  );
}

export function StepPage({ id, summary, action, children, how, extraStatus }: { id: string; summary?: ReactNode; action?: ReactNode; children?: ReactNode; how?: ReactNode; extraStatus?: ReactNode }) {
  const state = useAppState();
  const st = STEPS.find((x) => x.id === id)!;
  const status = stepStatus(state, id);
  const list = STEPS as readonly (typeof STEPS)[number][];
  const prev = list[st.n - 2], next = list[st.n];
  return (
    <div className="flex flex-col gap-4">
      <StepHead kicker={`Step ${st.n} of ${STEPS.length}`} title={<>{st.title}<Badge status={status} />{extraStatus}</>} sub={summary} />
      {action}
      {children}
      {how ? <HowCard>{how}</HowCard> : null}
      <div className="flex items-center gap-2 pt-2">
        <Button variant="ghost" asChild><Link to={prev ? prev.path : "/"}><Icon of={ArrowLeft} size="sm" />{prev ? `Step ${prev.n}: ${prev.short}` : "Overview"}</Link></Button>
        <span className="flex-1" />
        <Button variant="ghost" asChild><Link to={next ? next.path : "/"}>{next ? `Step ${next.n}: ${next.short}` : "Overview"}<Icon of={ArrowRight} size="sm" /></Link></Button>
      </div>
    </div>
  );
}

function HowCard({ children }: { children: ReactNode }) {
  const [open, setOpen] = useState(false);
  return (
    <Card static tight>
      <button type="button" className="flex items-center gap-2 text-[13px] font-semibold text-left w-full" onClick={() => setOpen(!open)} aria-expanded={open}>
        <motion.span animate={{ rotate: open ? 90 : 0 }} transition={{ duration: 0.15 }} className="inline-flex"><Icon of={ChevronRight} size="sm" /></motion.span>
        How this step works
      </button>
      {open && <div className="text-[13px] leading-6 text-ink-2 [&_b]:text-ink [&_code]:font-mono [&_code]:text-[12px] [&_ol]:list-decimal [&_ol]:pl-5 [&_ul]:list-disc [&_ul]:pl-5 [&_p+p]:mt-2">{children}</div>}
    </Card>
  );
}

/* ------------------------------------------------------------- bits */

export function CmdPreview({ stage, args }: { stage: string; args?: string[] }) {
  return <div className="font-mono text-[12px] text-ink-3" title="the equivalent command line">$ rpa <b className="text-ink font-semibold">{[stage, ...(args || [])].join(" ")}</b></div>;
}

export function FileRow({ fi, stale }: { fi: FileInfo; stale?: boolean }) {
  return (
    <div className="flex items-center gap-2.5 py-1.5 text-[13px]" title={fi.path || undefined}>
      <Dot tone={!fi.exists ? "muted" : stale ? "warn" : "good"} />
      <span className="font-mono text-[12px] truncate">{fi.name || fi.path}</span>
      <span className="ml-auto text-[12px] text-ink-3 whitespace-nowrap num">{fi.exists ? `${sizeFmt(fi.size)} · ${ago(fi.mtime)}` : "missing"}</span>
    </div>
  );
}

/* First click arms it; second click within 5 s runs. */
export function ConfirmButton({ label, armedLabel, onClick, variant = "ghost", size = "sm", className, disabled }:
  { label: ReactNode; armedLabel: ReactNode; onClick: () => Promise<unknown> | void; variant?: "ghost" | "chip" | "primary"; size?: "sm" | "md"; className?: string; disabled?: boolean }) {
  const [armed, setArmed] = useState(false);
  const [busy, setBusy] = useState(false);
  useEffect(() => { if (!armed) return; const t = setTimeout(() => setArmed(false), 5000); return () => clearTimeout(t); }, [armed]);
  return (
    <Button variant={armed ? "danger" : variant} size={size} className={className} disabled={disabled || busy}
            onClick={async () => { if (!armed) { setArmed(true); return; } setArmed(false); setBusy(true); try { await onClick(); } finally { setBusy(false); } }}>
      {armed ? armedLabel : label}
    </Button>
  );
}

export async function cancelRun() { try { await api("/api/cancel", {}); toast("cancel requested"); } catch (e: any) { toast.error(e.message); } }

export function RunButton({ stage, args = [], label, primary, disabled, title, confirmText, size, className }:
  { stage: string; args?: string[]; label?: ReactNode; primary?: boolean; disabled?: boolean; title?: string; confirmText?: string | null; size?: "sm" | "md"; className?: string }) {
  const runner = useRunner();
  const busy = useBusy();
  const setDrawerOpen = useUi((s) => s.setDrawerOpen), setFollow = useUi((s) => s.setFollow);
  const [ask, setAsk] = useState(false);
  const [starting, setStarting] = useState(false);
  const same = (x: any) => x && x.stage === stage && JSON.stringify(x.args) === JSON.stringify(args);
  const mine = (busy && same(runner)) || same(runner?.side);
  const blocked = busy && !(LIGHT_STAGES.includes(stage) && !runner?.side);
  const start = async () => {
    setStarting(true);
    try { await api("/api/run", { stage, args, label: typeof label === "string" ? label : undefined }); setDrawerOpen(true); setFollow(true); toast(`started: rpa ${[stage, ...args].join(" ")}`); }
    catch (e: any) { toast.error(e.message); }
    finally { setStarting(false); }
  };
  return (
    <>
      <Button variant={primary ? "primary" : "ghost"} size={size} className={className} disabled={disabled || blocked || starting}
              title={blocked ? `busy: ${runner?.stage} is running${runner?.side ? " and " + runner.side.stage + " beside it" : ""}` : title || ""}
              onClick={() => (confirmText ? setAsk(true) : start())}>
        {mine ? <LiveDot tone={primary ? "good" : "info"} /> : null}
        {mine ? "running…" : label || `Run ${stage}`}
      </Button>
      {confirmText ? <ConfirmDialog open={ask} onOpenChange={setAsk} title="Are you sure?" body={confirmText} okLabel="Run" danger onOk={start} /> : null}
    </>
  );
}

/* options sit beside the buttons; stats get the full width under them. */
export function ActionPanel({ title, prereqs = [], buttons, options, stats, notes, cmd, engine }:
  { title?: string; prereqs?: { label: string; ok: boolean | "warn"; hint?: string }[]; buttons?: ReactNode; options?: ReactNode; stats?: ReactNode; notes?: ReactNode; cmd?: ReactNode; engine?: boolean }) {
  const missing = prereqs.filter((p) => p.ok === false);
  return (
    <Card glow="accent" className="action-panel" static>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="micro flex items-center gap-2">{title || "Run this step"}{engine ? <Pill tone="accent" lower><Icon of={Cpu} size="xs" />RASAero engine</Pill> : null}</div>
        {prereqs.length ? (
          <div className="flex flex-wrap gap-1.5">
            {prereqs.map((p, i) => (
              <span key={i} title={p.hint || ""} className={cx("chip sm", p.ok === false ? "tone-bad" : p.ok === "warn" ? "tone-warn" : "tone-good")}>
                <Icon of={p.ok === false ? X : p.ok === "warn" ? AlertTriangle : CheckIcon} size="xs" />{p.label}
              </span>
            ))}
          </div>
        ) : null}
      </div>
      <div className="flex flex-wrap items-start gap-3">
        <div className="flex flex-wrap gap-2">{buttons}</div>
        {options ? <div className="min-w-[260px] flex-1">{options}</div> : null}
      </div>
      {stats ? <div>{stats}</div> : null}
      {missing.length ? <Problem tone="warn"><b>Before you run: </b>{missing.map((p) => p.hint || p.label).join(" · ")}</Problem> : null}
      {notes ? <div className="flex flex-col gap-2">{notes}</div> : null}
      {cmd}
    </Card>
  );
}

export function RunHistory({ hist }: { hist: RunRecord[] }) {
  const nav = useNavigate();
  if (!hist || !hist.length) return <p className="text-[12.5px] text-ink-3">nothing has been run from this app yet</p>;
  const rows = hist.slice().reverse().slice(0, 12);
  const failed = (r: RunRecord) => r.exit_code !== 0 && !r.cancelled && !(r.exit_code === 1 && FINDINGS_STAGES.includes(r.stage));
  return (
    <div className="flex flex-col divide-y divide-line-2">
      {rows.map((r, i) => (
        <button key={i} type="button" className="flex flex-wrap items-center gap-2.5 py-1.5 px-1 -mx-1 rounded-1 text-left text-[13px] hover:bg-surface-2 transition-colors"
                onClick={() => nav({ to: "/runs", search: { sel: String(r.started) } as any })}>
          <Dot tone={failed(r) ? "bad" : r.cancelled ? "muted" : r.exit_code === 0 ? "good" : "warn"} />
          <span className="font-mono text-[12px]">{["rpa", r.stage, ...(r.args || [])].join(" ")}</span>
          <span className="ml-auto text-[12px] text-ink-3 num">{outcomeText(r)} · {dur(r.elapsed_s)} · {dateTime(r.finished)}</span>
          {failed(r) && r.last_error ? <span className="basis-full text-[12px] text-bad truncate">{r.last_error}</span> : null}
        </button>
      ))}
    </div>
  );
}

export function EngineCard() {
  const state = useAppState();
  if (!state) return null;
  const e = state.engine || {};
  return (
    <Card title="RASAero engine" actions={<Link to="/engine" className="link">details<Icon of={ArrowRight} size="xs" /></Link>}>
      <div className="flex items-center gap-2"><Badge status={e.ok ? "ok" : "err"}>{e.ok ? "ready" : "missing"}</Badge><span className="text-[12px] text-ink-2">{e.ok ? "RASAero's engine, on this machine" : e.detail}</span></div>
      <KV pairs={[["engine", e.ok ? `native · ${e.pool?.pools?.[0] ? e.pool.pools[0].alive + " host(s) warm" : "ready"}` : e.detail || "—"], ["OpenRocket", e.warmup?.openrocket || (e.openrocket?.jar ? "found" : "not found")]]} />
    </Card>
  );
}

export function RevealButton({ path, children, size = "sm" }: { path: string; children: ReactNode; size?: "sm" | "md" }) {
  return <Button size={size} variant="ghost" onClick={() => api("/api/reveal", { path }).catch((e: any) => toast.error(e.message))}><Icon of={ExternalLink} size="sm" />{children}</Button>;
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
      const btn = document.createElement("button"); btn.className = "chip sm mt-2"; btn.textContent = `show all ${rows.length} rows`;
      btn.onclick = () => { rows.forEach((r) => { r.hidden = false; }); btn.remove(); };
      table.parentElement?.after(btn);
    }
  }, [html]);
  return <div><div className="mb-2 flex justify-end"><RevealButton path="output/report.md">Reveal report.md</RevealButton></div><div ref={ref} className="md" dangerouslySetInnerHTML={{ __html: html }} /></div>;
}

export function Lightbox({ src, onClose }: { src: string | null; onClose: () => void }) {
  useEffect(() => { if (!src) return; const k = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); }; document.addEventListener("keydown", k); return () => document.removeEventListener("keydown", k); }, [src, onClose]);
  if (!src) return null;
  return <div className="dialog-overlay flex items-center justify-center p-6" onClick={onClose}><img src={src} className="max-h-full max-w-full rounded-3 bg-white shadow-card-lg" alt="" /></div>;
}
export const plotUrl = (p: FileInfo) => fileUrl(p.path || "", p.mtime);
export { fmt, isNum };
