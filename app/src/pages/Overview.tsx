import { Link, useNavigate } from "@tanstack/react-router";
import { ArrowRight, ScrollText } from "lucide-react";
import { motion } from "motion/react";
import { EngineCard, RunHistory, StepHead } from "@/components/common";
import { AnimatedNumber, Badge, Button, Card, Icon, KV, LiveDot, Problem, Stat, StatGrid, rise } from "@/components/ui";
import { dur, fmt, fmtFt } from "@/lib/format";
import { useAppState } from "@/lib/store";
import { STEPS, stepStatus } from "@/lib/types";
import { cn } from "@/lib/utils";
import { useUi } from "@/store/ui";

function sustainerSummary(m: any) {
  const sel = m.sustainer_selection || {}; const picked = sel.selected;
  if (picked && picked.length) return `${picked.map((x: any) => x.label).join(", ")} (${sel.mode}, ${picked.length} of ${m.n_sustainer_candidates})`;
  if (sel.mode === "best" || !sel.mode) return `${m.sustainer.label} (${fmt(m.sustainer.total_impulse_ns, 0)} N·s, highest of ${m.n_sustainer_candidates})`;
  return `${sel.mode}: picked at the characterize step (${m.n_sustainer_candidates} candidates)`;
}

const RING: Record<string, string> = { ok: "done", partial: "warn", warn: "warn", stale: "warn", error: "bad", running: "run" };

export function OverviewPage() {
  const s = useAppState();
  const setDrawerOpen = useUi((x) => x.setDrawerOpen);
  const nav = useNavigate();
  if (!s) return null;
  const d = s.results, cfg = s.config;
  const st = (id: string) => stepStatus(s, id);
  const blocking = STEPS.find((x) => !x.optional && ["todo", "error", "stale", "unchecked"].includes(st(x.id)));
  const attention = STEPS.filter((x) => !x.optional && ["warn", "partial"].includes(st(x.id)));
  const running = STEPS.find((x) => st(x.id) === "running");
  const changesText = (list: string[]) => { const c = list || []; return c.length ? " — " + c.slice(0, 2).join("; ") + (c.length > 2 ? ` (+${c.length - 2} more)` : "") : ""; };
  const why = (x: any) => { const t = st(x.id); if (t === "stale" && x.id === "optimize") return changesText(s.optimize.changes) || " — its inputs changed since it last ran"; if (t === "unchecked") return (changesText(s.inputs.changes) || " — inputs changed") + ", press Check"; return ({ stale: " — its inputs changed since it last ran", error: " — there is a problem to fix", todo: "" } as any)[t] || ""; };
  const nextText = running ? `Step ${running.n} (${running.title}) is running.` : blocking ? (blocking.id === "results" ? "Run the optimizer (step 2) to get results." : `step ${blocking.n}, ${blocking.title}${why(blocking)}.`) : attention.length ? `All steps have been run; step ${attention[0].n} (${attention[0].title}) needs a look.` : "Every step is complete. Re-run steps whose inputs changed (they are flagged \"out of date\").";
  const headline = () => {
    if (!d.n) return <Problem tone="info"><b>No results yet. </b>Follow the steps in order; the optimizer runs on this machine with RASAero's own engine.</Problem>;
    const b = d.best, tgt = d.target_ft, c = d.counts || {};
    if (d.n_solved) return <Problem tone="ok"><b>{d.n_solved} design(s) hit {fmtFt(tgt)} ± {fmt(d.tolerance_ft, 0)} ft</b> — {d.n_verified_ok} verified. Best: <b>{b.booster} · {b.profile}</b> sep {b.sep_delay_s}s, ign {b.ign_delay_s}s to {fmtFt(b.apogee_ft)}.</Problem>;
    if ((c.overpowered || 0) === d.n) return <Problem tone="warn"><b>Every candidate overshoots {fmtFt(tgt)}.</b> Lowest reachable apogee is {fmtFt(d.apogee_min_ft)} ({b.booster}, {b.profile}, sep {b.sep_delay_s}s, ign {b.ign_delay_s}s after separation). Heavier hardware mass, a lower-impulse sustainer, airbrakes/ballast, or a shorter ignition gap would bring it down.</Problem>;
    if ((c.underpowered || 0) === d.n) return <Problem tone="warn"><b>No candidate reaches {fmtFt(tgt)}.</b> Highest reachable apogee is {fmtFt(d.apogee_max_ft)} ({b.booster}, {b.profile}). A lighter hardware mass or more impulse is needed.</Problem>;
    return <Problem tone="warn"><b>No design hit the target.</b> {c.overpowered || 0} overpowered, {c.underpowered || 0} underpowered, {c.unsolved || 0} unsolved. Closest: {b.booster} {b.profile} at {fmtFt(b.apogee_ft)}.</Problem>;
  };
  const m = s.inputs.motors;
  const lr = s.optimize.last_run;
  const best = d.n ? d.best : null;
  return (
    <>
      <StepHead title="Overview" sub="Where the project stands, what the optimizer found, and what to do next. Work through the steps from left to right; each one explains what it needs, what it produces and has a single Run button." />

      <Card glow="accent" static plain className="!py-3.5">
        <div className="flex flex-wrap items-center gap-3">
          {running ? <LiveDot tone="info" /> : null}
          <div className="text-[13.5px]"><b>Next: </b>{nextText}</div>
          <span className="flex-1" />
          {running ? <Button size="sm" variant="ghost" onClick={() => setDrawerOpen(true)}><Icon of={ScrollText} size="sm" />Show log</Button>
            : blocking ? <Button size="sm" variant="primary" onClick={() => nav({ to: blocking.id === "results" ? "/optimize" : blocking.path })}>Go to step {blocking.id === "results" ? 2 : blocking.n}<Icon of={ArrowRight} size="sm" /></Button>
            : attention.length ? <Button size="sm" variant="ghost" onClick={() => nav({ to: attention[0].path })}>Open step {attention[0].n}<Icon of={ArrowRight} size="sm" /></Button>
            : <Button size="sm" variant="ghost" onClick={() => nav({ to: "/results" })}>Open results<Icon of={ArrowRight} size="sm" /></Button>}
        </div>
      </Card>

      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        {STEPS.map((x) => {
          const t = st(x.id);
          return (
            <motion.div key={x.id} variants={rise} className="min-w-0">
              <Link to={x.path} className="glass card tight hover:no-underline text-ink block h-full !gap-2">
                <div className="flex items-center gap-2">
                  {t === "running" ? <LiveDot tone="info" /> : <span className={cn("step-ring", RING[t])}>{x.n}</span>}
                  <span className="micro">step {x.n}</span>
                </div>
                <div className="text-[13.5px] font-semibold leading-tight">{x.title}</div>
                <div className="text-[12px] text-ink-3 leading-tight">{x.sub}</div>
                <div className="mt-1"><Badge status={t} /></div>
              </Link>
            </motion.div>
          );
        })}
      </div>

      <div className="grid gap-4 lg:grid-cols-2 lg:items-start">
        <Card title="Headline result">
          {headline()}
          {d.n ? (
            <StatGrid>
              <Stat label="target" value={fmt(d.target_ft, 0)} unit="ft" />
              <Stat label="designs" value={d.n} />
              <Stat label="solved" value={d.n_solved} tone={d.n_solved ? "ok" : "warn"} />
              <Stat label="overpowered" value={(d.counts || {}).overpowered || 0} />
              <Stat label="underpowered" value={(d.counts || {}).underpowered || 0} />
              {best && Number.isFinite(best.apogee_ft) ? <Stat label="best apogee" value={<AnimatedNumber value={best.apogee_ft} format={(x) => fmt(x, 0)} />} unit="ft" sub={`${best.booster} · ${best.profile}`} tone="accent" /> : null}
              {Object.entries(d.eligibility || {}).map(([p, x]: any) => <Stat key={p} label={`${p} eligible`} value={`${x.eligible}/${x.total}`} />)}
            </StatGrid>
          ) : null}
          {d.n ? <div><Button variant="ghost" asChild><Link to="/results">Open results<Icon of={ArrowRight} size="sm" /></Link></Button></div> : null}
        </Card>
        <div className="flex flex-col gap-4 min-w-0">
          <Card title="Vehicle & target" actions={<Link to="/inputs" className="link">edit<Icon of={ArrowRight} size="xs" /></Link>}>
            <KV pairs={[
              ["OpenRocket model", s.inputs.ork.name ? s.inputs.ork.name + (s.inputs.ork.exists ? "" : " (missing)") : "not set"],
              ["RASAero model", s.inputs.cdx1.name ? s.inputs.cdx1.name + (s.inputs.cdx1.exists ? "" : " (missing)") : "not set"],
              ["boosters", `${s.inputs.boosters.n} candidates from ${s.inputs.boosters.sources.length} source(s)`],
              ["sustainers", m ? sustainerSummary(m) : "—"],
              ["hardware mass", s.mass.hardware_mass_lb != null ? `${fmt(s.mass.hardware_mass_lb, 0)} lb dry` : ".ork masses"],
              ["target apogee", `${fmt(cfg.target.apogee_ft, 0)} ± ${fmt(cfg.target.tolerance_ft, 0)} ft`],
              ["profiles", `subsonic < M${cfg.profiles.subsonic_max_mach}, supersonic ≥ M${cfg.profiles.supersonic_min_mach} (margin ${cfg.profiles.mach_margin})`],
              ["delay windows", `separation ${fmt(cfg.profiles.separation_delay_min_s)}–${fmt(cfg.profiles.separation_delay_max_s)} s after burnout · ignition ${fmt(cfg.profiles.ignition_delay_min_s)}–${fmt(cfg.profiles.ignition_delay_max_s)} s after separation`],
              ["backend", cfg.backend],
            ]} />
          </Card>
          <EngineCard />
        </div>
      </div>

      <div className="grid gap-4 lg:grid-cols-2 lg:items-start">
        <Card title="Recent runs"><RunHistory hist={s.history} /></Card>
        <Card title="How to use this tool">
          <ol className="list-decimal pl-5 text-[13px] leading-6 text-ink-2 [&_b]:text-ink flex flex-col gap-1">
            <li><b>Step 1</b> — pick your .ork, .CDX1 and motor files (folders or single files, anywhere on disk), set the hardware mass and the target apogee, then press <b>Check</b>.</li>
            <li><b>Step 2</b> — run the optimizer as often as you like ({lr ? `the last full run took ${dur(lr.elapsed_s)}` : "seconds to minutes, depending on the grids"}). Every simulation runs on this machine with RASAero's own engine.</li>
            <li><b>Steps 3–4</b> — read the results, then re-fly the chosen designs in RASAero.</li>
            <li>The drawer at the bottom shows the live log of whatever is running. Every Run button shows the equivalent command line, so everything can also be scripted.</li>
          </ol>
        </Card>
      </div>
    </>
  );
}
