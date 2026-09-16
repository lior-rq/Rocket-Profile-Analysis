import { useState } from "react";
import { useNavigate, useSearch } from "@tanstack/react-router";
import { ago, fmt } from "@/lib/format";
import { useApp, useCached } from "@/lib/store";
import { ActionPanel, Callout, CmdPreview, KV, RunButton, StepPage } from "@/components/common";
import { DataTable } from "@/components/DataTable";
import { HistoryChart } from "@/components/charts";
import { Badge } from "@/components/ui/badge";
import { Card, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";

export function ReferencePage() {
  const { state: s } = useApp();
  const search = useSearch({ strict: false }) as any;
  const nav = useNavigate();
  const [cases, setCases] = useState(8);
  const [mode, setMode] = useState("mach");
  if (!s) return null;
  const r = s.reference;
  const pick = search.sel || (r.cases[0] || {}).name;
  const path = pick ? `${r.dir}/${pick}.csv` : null;
  const t = useCached<any>("hist:" + path, path ? "/api/history?path=" + encodeURIComponent(path) : null, undefined, 60000);
  const native = s.engine?.ok;
  return <StepPage id="reference" summary="Simulates a few complete flights in RASAero itself and stores the full View Data exports. Step 4 validates the Python simulator against them, and RASAero's air-density profile is recovered from them. Cases spread over the booster set and over short and long coasts."
    action={<ActionPanel vm prereqs={[{ label: "aero tables", ok: s.aero.n_have > 0 || s.aero.covered, hint: "export the aero tables first (step 2)" }, { label: "mass table", ok: !!(s.mass.table && !s.mass.table.error), hint: "computed on demand from the .ork" }, { label: "RASAero engine", ok: native ? true : "warn", hint: native ? "" : "engine not built: the VM worker will be used" }]}
      buttons={<RunButton stage="reference" args={["--cases", String(cases)]} label={`Export ${cases} reference flight${cases === 1 ? "" : "s"}`} primary />}
      options={<label className="inline-flex items-center gap-2 text-[13px]">cases <Input type="number" min={1} max={30} className="w-20" value={cases} onChange={(e) => setCases(Number(e.target.value) || 8)} /><span className="text-muted">(seconds each on the native engine; 8 is plenty)</span></label>}
      notes={<>{r.n && r.n < 5 ? <Callout kind="warn">{r.n} case(s) so far — at least 5 give a meaningful validation and density calibration.</Callout> : null}{r.stale ? <Callout kind="warn">The CDX1 is newer than these flights — export fresh ones if the vehicle changed.</Callout> : null}</>} cmd={<CmdPreview stage="reference" args={["--cases", String(cases)]} />} />}
    how={<p>Each case is one RASAero simulation row (booster, separation delay, ignition delay) with the masses from the mass table. The engine flies it and writes the full time history at 0.01 s; the export and the row inputs are stored side by side in <code>{r.dir}</code>. The density profile RASAero used is recovered from the coast phases of these exports (ρ = 2D / V²·S·CD) and reused by the Python simulator.</p>}>
    <Card><CardTitle>Reference cases ({r.n})</CardTitle>
      {r.n ? <DataTable columns={["name", "booster", "sustainer", "sep_delay_s", "ign_delay_s", "apogee_ft", "max_vel_fps", "mtime"]} rows={r.cases} labels={{ sep_delay_s: "sep [s]", ign_delay_s: "ign [s]", apogee_ft: "RASAero apogee [ft]", max_vel_fps: "max vel [fps]", mtime: "exported" }} format={{ mtime: (v) => ago(v), apogee_ft: (v) => fmt(v, 0), max_vel_fps: (v) => fmt(v, 0) }} onRow={(row) => nav({ to: "/reference", search: { sel: row.name } as any })} rowKey={(row) => row.name} selected={pick} /> : <div className="text-muted">none yet</div>}
      <div className="my-3 border-t border-line" />
      <KV pairs={[["density calibration", r.calibration.exists ? `${r.calibration.info ? `${r.calibration.info.bins} bins, ${fmt(r.calibration.info.alt_min_ft, 0)}–${fmt(r.calibration.info.alt_max_ft, 0)} ft` : "present"} (${ago(r.calibration.mtime)})` : <Badge status="todo">not yet — written by this step and by validate</Badge>], ["delay convention", "separation delay from burnout; ignition delay from separation (RASAero)"]]} /></Card>
    <Card><CardTitle>Flight (RASAero export)</CardTitle>{!path ? <div className="text-muted">no reference flight yet</div> : t.data ? <HistoryChart t={t.data} mode={mode} onMode={setMode} /> : <div className="text-muted">Loading…</div>}</Card>
  </StepPage>;
}
