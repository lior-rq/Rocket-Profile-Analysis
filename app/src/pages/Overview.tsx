import { Link, useNavigate } from "@tanstack/react-router";
import { useApp } from "@/lib/store";
import { dur, fmt, fmtFt } from "@/lib/format";
import { STEPS, stepStatus } from "@/lib/types";
import { Callout, KV, RunHistory, Stat, StatList, WorkerCard } from "@/components/common";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardTitle } from "@/components/ui/card";

function sustainerSummary(m: any) {
  const sel = m.sustainer_selection || {}; const picked = sel.selected;
  if (picked && picked.length) return `${picked.map((x: any) => x.label).join(", ")} (${sel.mode}, ${picked.length} of ${m.n_sustainer_candidates})`;
  if (sel.mode === "best" || !sel.mode) return `${m.sustainer.label} (${fmt(m.sustainer.total_impulse_ns, 0)} N·s, highest of ${m.n_sustainer_candidates})`;
  return `${sel.mode}: picked at the characterize step (${m.n_sustainer_candidates} candidates)`;
}

export function OverviewPage() {
  const { state: s, setActivityOpen } = useApp();
  const nav = useNavigate();
  if (!s) return null;
  const d = s.results, cfg = s.config;
  const st = (id: string) => stepStatus(s, id);
  const blocking = STEPS.find((x) => !x.optional && ["todo", "error", "stale", "unchecked"].includes(st(x.id)));
  const attention = STEPS.filter((x) => !x.optional && ["warn", "partial"].includes(st(x.id)));
  const running = STEPS.find((x) => st(x.id) === "running");
  const changesText = (list: string[]) => { const c = list || []; return c.length ? " — " + c.slice(0, 2).join("; ") + (c.length > 2 ? ` (+${c.length - 2} more)` : "") : ""; };
  const why = (x: any) => { const t = st(x.id); if (t === "stale" && x.id === "optimize") return changesText(s.optimize.changes) || " — its inputs changed since it last ran"; if (t === "unchecked") return (changesText(s.inputs.changes) || " — inputs changed") + ", press Check"; return ({ stale: " — its inputs changed since it last ran", error: " — there is a problem to fix", todo: "" } as any)[t] || ""; };
  const nextText = running ? `Step ${running.n} (${running.title}) is running.` : blocking ? (blocking.id === "results" ? "Run the optimizer (step 4) to get results." : `step ${blocking.n}, ${blocking.title}${why(blocking)}.`) : attention.length ? `All steps have been run; step ${attention[0].n} (${attention[0].title}) needs a look.` : "Every step is complete. Re-run steps whose inputs changed (they are flagged \"out of date\").";
  const headline = () => {
    if (!d.n) return <Callout kind="info"><b>No results yet. </b>Follow the steps in order; the optimizer runs on this machine with RASAero's own engine.</Callout>;
    const b = d.best, tgt = d.target_ft, c = d.counts || {};
    if (d.n_solved) return <Callout kind="ok"><b>{d.n_solved} design(s) hit {fmtFt(tgt)} ± {fmt(d.tolerance_ft, 0)} ft</b> — {d.n_verified_ok} verified. Best: <b>{b.booster} · {b.profile}</b> sep {b.sep_delay_s}s, ign {b.ign_delay_s}s → {fmtFt(b.apogee_ft)}.</Callout>;
    if ((c.overpowered || 0) === d.n) return <Callout kind="warn"><b>Every candidate overshoots {fmtFt(tgt)}.</b> Lowest reachable apogee is {fmtFt(d.apogee_min_ft)} ({b.booster}, {b.profile}, sep {b.sep_delay_s}s, ign {b.ign_delay_s}s after separation). Heavier hardware mass, a lower-impulse sustainer, airbrakes/ballast, or a shorter ignition gap would bring it down.</Callout>;
    if ((c.underpowered || 0) === d.n) return <Callout kind="warn"><b>No candidate reaches {fmtFt(tgt)}.</b> Highest reachable apogee is {fmtFt(d.apogee_max_ft)} ({b.booster}, {b.profile}). A lighter hardware mass or more impulse is needed.</Callout>;
    return <Callout kind="warn"><b>No design hit the target.</b> {c.overpowered || 0} overpowered, {c.underpowered || 0} underpowered, {c.unsolved || 0} unsolved. Closest: {b.booster} {b.profile} → {fmtFt(b.apogee_ft)}.</Callout>;
  };
  const m = s.inputs.motors;
  const lr = s.optimize.last_run;
  return <div className="flex flex-col gap-4">
    <div><h1 className="text-[22px] font-semibold">Overview</h1><div className="mt-1 max-w-[900px] text-[13px] text-muted">Where the project stands, what the optimizer found, and what to do next. Work through the steps in the sidebar from top to bottom — each one explains what it needs, what it produces and has a single Run button.</div></div>
    <div className="flex flex-wrap items-center gap-3 rounded-md border border-accent/30 bg-accent-bg/40 px-3 py-2"><div className="text-[13px]"><b>Next: </b>{nextText}</div>{running ? <Button size="sm" onClick={() => setActivityOpen(true)}>Show log</Button> : blocking ? <Button size="sm" variant="primary" onClick={() => nav({ to: blocking.id === "results" ? "/optimize" : blocking.path })}>Go to step {blocking.id === "results" ? 4 : blocking.n} →</Button> : attention.length ? <Button size="sm" onClick={() => nav({ to: attention[0].path })}>Open step {attention[0].n} →</Button> : <Button size="sm" onClick={() => nav({ to: "/results" })}>Open results →</Button>}</div>
    <Card><CardTitle>Progress</CardTitle><div className="grid grid-cols-2 gap-2 md:grid-cols-3 xl:grid-cols-6">{STEPS.map((x) => <Link key={x.id} to={x.path} className="rounded-md border border-line bg-panel-2 p-2 hover:border-accent"><div className="text-[10px] uppercase text-muted">step {x.n}</div><div className="text-[13px] font-medium leading-4">{x.title}</div><div className="mt-1"><Badge status={st(x.id)} /></div></Link>)}</div></Card>
    <div className="grid gap-4 lg:grid-cols-2">
      <Card><CardTitle>Headline result</CardTitle>{headline()}
        {d.n ? <StatList className="mt-3"><Stat label="target" value={fmt(d.target_ft, 0)} unit="ft" /><Stat label="designs" value={d.n} /><Stat label="solved" value={d.n_solved} cls={d.n_solved ? "ok" : "warn"} /><Stat label="overpowered" value={(d.counts || {}).overpowered || 0} /><Stat label="underpowered" value={(d.counts || {}).underpowered || 0} />{Object.entries(d.eligibility || {}).map(([p, v]: any) => <Stat key={p} label={`${p} eligible`} value={`${v.eligible}/${v.total}`} />)}</StatList> : null}
        {d.n ? <div className="mt-3"><Button asChild><Link to="/results">Open results →</Link></Button></div> : null}</Card>
      <div className="flex flex-col gap-4">
        <Card><CardTitle right={<Link to="/inputs" className="text-accent">edit →</Link>}>Vehicle & target</CardTitle>
          <KV pairs={[["OpenRocket model", s.inputs.ork.name ? s.inputs.ork.name + (s.inputs.ork.exists ? "" : " (missing)") : "not set"], ["RASAero model", s.inputs.cdx1.name ? s.inputs.cdx1.name + (s.inputs.cdx1.exists ? "" : " (missing)") : "not set"], ["boosters", `${s.inputs.boosters.n} candidates from ${s.inputs.boosters.sources.length} source(s)`], ["sustainers", m ? sustainerSummary(m) : "—"], ["hardware mass", s.mass.hardware_mass_lb != null ? `${fmt(s.mass.hardware_mass_lb, 0)} lb dry` : ".ork masses"], ["target apogee", `${fmt(cfg.target.apogee_ft, 0)} ± ${fmt(cfg.target.tolerance_ft, 0)} ft`], ["profiles", `subsonic < M${cfg.profiles.subsonic_max_mach}, supersonic ≥ M${cfg.profiles.supersonic_min_mach} (margin ${cfg.profiles.mach_margin})`], ["delay windows", `separation ${fmt(cfg.profiles.separation_delay_min_s)}–${fmt(cfg.profiles.separation_delay_max_s)} s after burnout · ignition ${fmt(cfg.profiles.ignition_delay_min_s)}–${fmt(cfg.profiles.ignition_delay_max_s)} s after separation`], ["backend", cfg.backend]]} /></Card>
        <WorkerCard />
      </div>
    </div>
    <div className="grid gap-4 lg:grid-cols-2">
      <Card><CardTitle>Recent runs</CardTitle><RunHistory hist={s.history} /></Card>
      <Card><CardTitle>How to use this tool</CardTitle><ol className="list-decimal pl-5 text-[13px] leading-6 text-muted [&_b]:text-fg">
        <li><b>Step 1</b> — pick your .ork, .CDX1 and motor files (folders or single files, anywhere on disk), set the hardware mass and the target apogee, then press <b>Check</b>.</li>
        <li><b>Steps 2–3</b> — optional: export a few flights from the RASAero GUI (VM) and check that the bundled engine reproduces them. Every simulation runs on this machine with RASAero's own engine, so most projects skip this.</li>
        <li><b>Step 4</b> — run the optimizer as often as you like ({lr ? `the last full run took ${dur(lr.elapsed_s)}` : "seconds to minutes, depending on the grids"}).</li>
        <li><b>Steps 5–6</b> — read the results, then confirm the chosen designs in RASAero.</li>
        <li>The panel at the bottom shows the live log of whatever is running. Every Run button shows the equivalent command line, so everything can also be scripted.</li></ol></Card>
    </div>
  </div>;
}
