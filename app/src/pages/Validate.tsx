import { useState } from "react";
import { useNavigate, useSearch } from "@tanstack/react-router";
import { fileUrl } from "@/lib/api";
import { fmt, isNum } from "@/lib/format";
import { useApp } from "@/lib/store";
import { ActionPanel, Callout, CmdPreview, Lightbox, RunButton, StepPage } from "@/components/common";
import { DataTable } from "@/components/DataTable";
import { Badge } from "@/components/ui/badge";
import { Card, CardTitle } from "@/components/ui/card";

export function ValidatePage() {
  const { state: s } = useApp();
  const search = useSearch({ strict: false }) as any;
  const nav = useNavigate();
  const [lb, setLb] = useState<string | null>(null);
  if (!s) return null;
  const v = s.validate, tol = v.tolerances;
  const sel = search.sel || (v.rows[0] || {}).case;
  const selRow = v.rows.find((r: any) => r.case === sel);
  return <StepPage id="validate" summary="Optional. Flies every reference flight on the bundled RASAero engine and compares the two histories column by column. Takes seconds. It is meaningful only with exports from the RASAero GUI (step 2 with engine: vm): the bundled engine is RASAero's own code, and this step proves the headless build reproduces the GUI's numbers on this machine."
    action={<ActionPanel prereqs={[{ label: `${s.reference.n} reference flights`, ok: s.reference.n > 0, hint: "export reference flights first (step 2)" }, { label: "RASAero engine", ok: !!s.engine?.ok, hint: s.engine?.detail }]}
      buttons={<RunButton stage="validate" label="Check the engine against the references" primary disabled={!s.reference.n || !s.engine?.ok} />}
      notes={<>{v.stale ? <Callout kind="warn">The reference flights are newer than this validation — re-run it.</Callout> : null}{v.n ? <Callout kind={v.n_pass === v.n ? "ok" : "warn"}><b>{v.n_pass}/{v.n} cases pass</b> (apogee within {tol.apogee_tol_pct} %, Mach at burnout within {tol.mach_at_burnout_tol}, CD within {tol.cd_tol_pct} %, weight within {tol.weight_tol_lb} lb, Mach within {tol.mach_tol}). {v.n_pass < v.n ? "A failure means the headless engine and the GUI disagree for this vehicle: check the case's motors and launch site were the ones exported." : ""}</Callout> : null}</>} cmd={<CmdPreview stage="validate" />} />}
    how={<p>For each reference case the engine flies the same row with the case's own motor copies, and the two histories are compared at RASAero's sample times: Mach, CD, weight, thrust, altitude, velocity and drag, then burnout / separation / ignition times, apogee, time to apogee and Mach at burnout. Results go to <code>output/validation/</code> with an overlay plot per case.</p>}>
    <Card><CardTitle right="click a row to see its overlay plot">Cases</CardTitle>
      {v.n ? <DataTable columns={["pass", "case", "fail_reasons", "apogee_ref_ft", "apogee_ours_ft", "apogee_err_pct", "mach_burnout_ref", "mach_burnout_ours", "mach_burnout_err", "sep_delay_s", "ign_delay_s", "cd_median_err_pct", "altitude_max_abs_err_ft", "velocity_max_abs_err_fps", "mach_max_abs_err", "weight_max_abs_err_lb"]} rows={v.rows}
        labels={{ sep_delay_s: "sep", ign_delay_s: "ign", apogee_ref_ft: "GUI apogee", apogee_ours_ft: "engine apogee", apogee_err_pct: "apogee err %", mach_burnout_ref: "M@bo GUI", mach_burnout_ours: "M@bo engine", mach_burnout_err: "M@bo err", cd_median_err_pct: "CD med %", altitude_max_abs_err_ft: "alt err ft", velocity_max_abs_err_fps: "vel err fps", mach_max_abs_err: "Mach err", weight_max_abs_err_lb: "weight err lb", fail_reasons: "why" }}
        format={{ pass: (x) => <Badge status={x ? "ok" : "err"}>{x ? "PASS" : "FAIL"}</Badge>, apogee_ref_ft: (x) => fmt(x, 1), apogee_ours_ft: (x) => fmt(x, 1), apogee_err_pct: (x) => (isNum(x) ? (x >= 0 ? "+" : "") + x.toFixed(4) : "—"), mach_burnout_err: (x) => fmt(x, 6), mach_max_abs_err: (x) => fmt(x, 6), mach_burnout_ref: (x) => fmt(x, 4), mach_burnout_ours: (x) => fmt(x, 4), cd_median_err_pct: (x) => fmt(x, 5), altitude_max_abs_err_ft: (x) => fmt(x, 2), velocity_max_abs_err_fps: (x) => fmt(x, 3), weight_max_abs_err_lb: (x) => fmt(x, 3) }}
        cellClass={(c, x) => ((c === "apogee_err_pct" && isNum(x) && Math.abs(x) > tol.apogee_tol_pct) || (c === "mach_burnout_err" && isNum(x) && Math.abs(x) > tol.mach_at_burnout_tol) ? "bg-err-bg" : "")}
        onRow={(r) => nav({ to: "/validate", search: { sel: r.case } as any })} rowKey={(r) => r.case} selected={sel} wrap={["fail_reasons"]} /> : <div className="text-muted">no validation yet</div>}</Card>
    {selRow && selRow.png ? <Card><CardTitle right="engine (dashed) over the GUI export (solid); click to enlarge">Overlay: {selRow.case}</CardTitle><img className="max-w-full cursor-zoom-in rounded" src={fileUrl(selRow.png, v.file.mtime)} onClick={() => setLb(fileUrl(selRow.png, v.file.mtime))} /></Card> : null}
    <Lightbox src={lb} onClose={() => setLb(null)} />
  </StepPage>;
}
