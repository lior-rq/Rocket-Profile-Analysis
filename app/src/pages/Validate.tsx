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
  return <StepPage id="validate" summary="Runs every reference flight through the Python simulator and compares it with RASAero term by term. Takes seconds. Re-run it whenever the vehicle, the aero tables or the simulator change; don't trust the python backend while this fails. (The native engine needs no validation: it is RASAero.)"
    action={<ActionPanel prereqs={[{ label: `${s.reference.n} reference flights`, ok: s.reference.n > 0, hint: "export reference flights first (step 3)" }, { label: "aero tables", ok: s.aero.n_have > 0 || s.aero.covered, hint: "export the aero tables first (step 2)" }]}
      buttons={<><RunButton stage="validate" label="Run validation" primary disabled={!s.reference.n || !(s.aero.n_have || s.aero.covered)} /><RunButton stage="validate" args={["--engine", "native"]} label="Check the native engine vs the references" disabled={!s.reference.n || !s.engine?.ok} /></>}
      notes={<>{v.stale ? <Callout kind="warn">The reference flights or aero tables are newer than this validation — re-run it.</Callout> : null}{v.n ? <Callout kind={v.n_pass === v.n ? "ok" : "warn"}><b>{v.n_pass}/{v.n} cases pass</b> (apogee within {tol.apogee_tol_pct} %, Mach at burnout within {tol.mach_at_burnout_tol}, CD within {tol.cd_tol_pct} %, weight within {tol.weight_tol_lb} lb, atmosphere/Mach within {tol.mach_tol}). {v.n_pass < v.n ? "A failure means the simulator does not match this vehicle: check the aero tables cover the flight's altitudes." : ""}</Callout> : null}</>} cmd={<CmdPreview stage="validate" />} />}
    how={<p>For each reference case the Python simulator flies the same row and the two histories are compared: the atmosphere (Mach recomputed from RASAero's own velocity and altitude), the CD lookup at RASAero's Mach and Reynolds number, the reconstructed drag, the weight and thrust histories (row for row, on RASAero's own time grid), then apogee, time to apogee and Mach at burnout. Results go to <code>output/validation/</code> with an overlay plot per case.</p>}>
    <Card><CardTitle right="click a row to see its overlay plot">Cases</CardTitle>
      {v.n ? <DataTable columns={["pass", "case", "fail_reasons", "apogee_ref_ft", "apogee_ours_ft", "apogee_err_pct", "mach_burnout_ref", "mach_burnout_ours", "mach_burnout_err", "sep_delay_s", "ign_delay_s", "cd_median_err_pct", "cd_p95_err_pct", "mach_max_abs_err", "weight_max_abs_err_lb"]} rows={v.rows}
        labels={{ sep_delay_s: "sep", ign_delay_s: "ign", apogee_ref_ft: "RASAero apogee", apogee_ours_ft: "python apogee", apogee_err_pct: "apogee err %", mach_burnout_ref: "M@bo RAS", mach_burnout_ours: "M@bo py", mach_burnout_err: "M@bo err", cd_median_err_pct: "CD med %", cd_p95_err_pct: "CD p95 %", mach_max_abs_err: "atm Mach err", weight_max_abs_err_lb: "weight err lb", fail_reasons: "why" }}
        format={{ pass: (x) => <Badge status={x ? "ok" : "err"}>{x ? "PASS" : "FAIL"}</Badge>, apogee_ref_ft: (x) => fmt(x, 0), apogee_ours_ft: (x) => fmt(x, 0), apogee_err_pct: (x) => (isNum(x) ? (x >= 0 ? "+" : "") + x.toFixed(2) : "—"), mach_burnout_err: (x) => fmt(x, 4), mach_max_abs_err: (x) => fmt(x, 4), mach_burnout_ref: (x) => fmt(x, 3), mach_burnout_ours: (x) => fmt(x, 3) }}
        cellClass={(c, x) => ((c === "apogee_err_pct" && isNum(x) && Math.abs(x) > tol.apogee_tol_pct) || (c === "mach_burnout_err" && isNum(x) && Math.abs(x) > tol.mach_at_burnout_tol) ? "bg-err-bg" : "")}
        onRow={(r) => nav({ to: "/validate", search: { sel: r.case } as any })} rowKey={(r) => r.case} selected={sel} wrap={["fail_reasons"]} /> : <div className="text-muted">no validation yet</div>}</Card>
    {selRow && selRow.png ? <Card><CardTitle right="python (dashed) over RASAero (solid); click to enlarge">Overlay: {selRow.case}</CardTitle><img className="max-w-full cursor-zoom-in rounded" src={fileUrl(selRow.png, v.file.mtime)} onClick={() => setLb(fileUrl(selRow.png, v.file.mtime))} /></Card> : null}
    <Lightbox src={lb} onClose={() => setLb(null)} />
  </StepPage>;
}
