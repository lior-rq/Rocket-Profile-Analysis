import { useState } from "react";
import { ago, fmt, isNum } from "@/lib/format";
import { useApp } from "@/lib/store";
import { ActionPanel, Callout, CmdPreview, RunButton, Stat, StatList, StepPage } from "@/components/common";
import { DataTable } from "@/components/DataTable";
import { Card, CardTitle } from "@/components/ui/card";
import { Checkbox, Input, Radio } from "@/components/ui/input";

export function ConfirmPage() {
  const { state: s } = useApp();
  const [top, setTop] = useState(3);
  const [unsolved, setUnsolved] = useState(true);
  const [modeSel, setModeSel] = useState("top");
  if (!s) return null;
  const c = s.confirm, d = s.results;
  const shortlist: string[] = d.shortlist || [];
  const mode = modeSel === "shortlist" && shortlist.length ? "shortlist" : "top";
  const args = mode === "shortlist" ? ["--designs", shortlist.join(",")] : ["--top", String(top), ...(unsolved ? ["--include-unsolved"] : [])];
  const maxDiff = c.rows.length ? Math.max(...c.rows.map((r: any) => Math.abs(r.diff_pct || 0))) : 0;
  return <StepPage id="confirm" summary="Re-flies the chosen designs through RASAero's engine as one batch and compares its apogees with the optimizer's."
    action={<ActionPanel engine prereqs={[{ label: `${d.n || 0} designs`, ok: d.n > 0, hint: "run the optimizer first (step 2)" }, { label: "RASAero engine", ok: !!s.engine?.ok, hint: s.engine?.ok ? "" : s.engine?.detail }]}
      buttons={<RunButton stage="confirm" args={args} label={mode === "shortlist" ? `Confirm the ${shortlist.length} shortlisted in RASAero` : `Confirm the top ${top} in RASAero`} primary disabled={!d.n} />}
      options={<div className="flex flex-col gap-2 text-[13px]"><div className="flex flex-wrap items-center gap-3"><Radio name="confirm-mode" checked={mode === "top"} onChange={() => setModeSel("top")} label={<span className="inline-flex items-center gap-1">the <Input type="number" min={1} max={100} className="h-7 w-16" value={top} onChange={(e) => { setTop(Number(e.target.value) || 3); setModeSel("top"); }} /> designs closest to the target</span>} />{mode === "top" ? <Checkbox label="include unsolved designs (the closest ones when nothing is solved)" checked={unsolved} onChange={(e) => setUnsolved(e.target.checked)} /> : null}</div><Radio name="confirm-mode" disabled={!shortlist.length} checked={mode === "shortlist"} onChange={() => setModeSel("shortlist")} label={shortlist.length ? `the ${shortlist.length} shortlisted design${shortlist.length === 1 ? "" : "s"}` : "the shortlist (empty — star designs on the Results page)"} /></div>}
      notes={<>{d.n && !d.n_solved && !unsolved && mode === "top" ? <Callout kind="warn">There are no solved designs; tick "include unsolved" to confirm the closest ones.</Callout> : null}{c.stale ? <Callout kind="warn">designs.csv is newer than this confirmation — re-run it.</Callout> : null}</>} cmd={<CmdPreview stage="confirm" args={args} />} />}
    how={<p>The chosen rows are flown as one batch by RASAero's engine, straight from the search's own inputs; its apogee per row and the comparison are stored in <code>output/confirm.csv</code>. With the shortlist the exact starred designs are sent (<code>rpa confirm --designs …</code>).</p>}>
    <Card><CardTitle right={c.file.exists ? ago(c.file.mtime) : ""}>RASAero vs the optimizer</CardTitle>
      {c.rows.length ? <div><StatList className="mb-3"><Stat label="designs confirmed" value={c.rows.length} /><Stat label="max |difference|" value={fmt(maxDiff, 2)} unit="%" cls={maxDiff < 1 ? "ok" : "warn"} /><Stat label="mean difference" value={fmt(c.rows.reduce((a: number, r: any) => a + (r.diff_pct || 0), 0) / c.rows.length, 2)} unit="%" /></StatList>
        <DataTable columns={["booster", "sustainer", "profile", "sep_delay_s", "ign_delay_s", "apogee_search_ft", "apogee_rasaero_ft", "diff_ft", "diff_pct", "max_vel_rasaero_fps", "t_apogee_rasaero_s"]} rows={c.rows} labels={{ sep_delay_s: "sep [s]", ign_delay_s: "ign [s]", apogee_search_ft: "optimizer apogee", apogee_rasaero_ft: "RASAero apogee", diff_ft: "Δ ft", diff_pct: "Δ %", max_vel_rasaero_fps: "RASAero max vel", t_apogee_rasaero_s: "RASAero t apogee" }} format={{ apogee_search_ft: (v) => fmt(v, 0), apogee_rasaero_ft: (v) => fmt(v, 0), diff_ft: (v) => (isNum(v) ? (v > 0 ? "+" : "") + fmt(v, 0) : "—"), diff_pct: (v) => (isNum(v) ? (v > 0 ? "+" : "") + v.toFixed(2) : "—") }} tools={{ csv: "confirm.csv" }} /></div> : <div className="text-muted">nothing confirmed yet</div>}</Card>
  </StepPage>;
}
