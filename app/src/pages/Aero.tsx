import { useNavigate, useSearch } from "@tanstack/react-router";
import { ago, fmt } from "@/lib/format";
import { useApp, useCached } from "@/lib/store";
import { ActionPanel, Callout, CmdPreview, RunButton, StepPage } from "@/components/common";
import { DataTable } from "@/components/DataTable";
import { LineChart } from "@/components/charts";
import { Badge } from "@/components/ui/badge";
import { Card, CardTitle } from "@/components/ui/card";
import { Select } from "@/components/ui/select";

export function AeroPage() {
  const { state: s } = useApp();
  const search = useSearch({ strict: false }) as any;
  const nav = useNavigate();
  if (!s) return null;
  const a = s.aero;
  const rows = a.plan.map((r: any) => ({ ...r, status: r.exists ? (a.stale ? "stale" : "ok") : "todo" }));
  const pick = search.sel || (rows.find((r: any) => r.exists) || (a.extra[0] ? { path: a.extra[0].path } : {})).path;
  const t = useCached<any>("aero:" + pick, pick ? "/api/aero?path=" + encodeURIComponent(pick) : null, undefined, 60000);
  const choices = rows.filter((r: any) => r.exists).map((r: any) => [r.path, r.name]).concat(a.extra.map((e: any) => [e.path, e.name]));
  const lim = t.data ? t.data.mach.findIndex((m: number) => m > 5.05) : -1;
  const cut = (arr: number[]) => (lim > 0 ? arr.slice(0, lim) : arr);
  const native = s.engine?.ok;
  return <StepPage id="aero" summary="The fast Python simulator flies on RASAero's own drag curves. This exports them once per vehicle revision: RASAero's Aero Plots for the full stack and for the sustainer alone, at the nozzle sizes and altitudes below, computed by the native engine in seconds."
    action={<ActionPanel vm prereqs={[{ label: "CDX1", ok: s.inputs.cdx1.exists, hint: "the RASAero model file is missing" }, { label: "motors selected", ok: s.inputs.boosters.n > 0, hint: "select booster files in step 1" }, { label: "RASAero engine", ok: native ? true : "warn", hint: native ? "" : "engine not built: the VM worker will be used" }]}
      buttons={<><RunButton stage="aero" label={a.n_have < a.n_plan ? `Export the ${a.n_plan - a.n_have} missing table(s)` : "All planned tables present"} primary disabled={a.n_have === a.n_plan} /><RunButton stage="aero" args={["--fresh"]} label="Re-export everything" confirmText={`Re-export all ${a.n_plan} aero tables, overwriting the existing files?`} /></>}
      notes={<>{a.error ? <Callout kind="err">{a.error}</Callout> : null}{a.stale ? <Callout kind="warn">The CDX1 is newer than these tables — re-export them if the geometry changed.</Callout> : null}{a.covered && a.n_have < a.n_plan ? <Callout kind="ok"><b>Coverage OK. </b>The tables present already cover the current motor set, so the simulator can run; the {a.n_plan - a.n_have} planned table(s) would only refine the altitude interpolation.</Callout> : null}{!a.covered && a.coverage_problems && a.coverage_problems.length ? <Callout kind="warn"><b>Coverage problems: </b><ul className="list-disc pl-5">{a.coverage_problems.map((x: string, i: number) => <li key={i}>{x}</li>)}</ul></Callout> : null}</>} cmd={<CmdPreview stage="aero" />} />}
    how={<ol><li>The stage's nozzle diameter is written into the design (power-on CD depends on it).</li><li><b>Mach-Alt</b> is set to the table altitude so the Reynolds number matches the flight regime.</li><li><b>Aero Plots</b> is computed for "Sustainer + Booster" (stack) or "Sustainer" and written as CSV (Mach 0.01–25, three angles of attack).</li><li>The CSV lands in <code>{a.dir}</code> as <code>&lt;stack|sustainer&gt;_alt&lt;ft&gt;_noz&lt;in&gt;.csv</code>; the simulator interpolates between altitudes (by Reynolds number) and scales the power-on CD to each motor's nozzle exactly (base drag is proportional to the nozzle area), so one nozzle per configuration is enough. Tables depend only on the geometry, so they survive motor changes.</li></ol>}>
    <Card><CardTitle right={`altitudes ${a.settings.altitudes_ft.join(", ")} ft · nozzles: ${a.settings.stack_nozzles_in === "auto" ? "largest of the booster set" : a.settings.stack_nozzles_in}`}>Planned tables ({a.n_have}/{a.n_plan} present)</CardTitle>
      <DataTable columns={["config", "nozzle_in", "altitude_ft", "name", "status", "mtime"]} rows={rows} labels={{ nozzle_in: "nozzle exit [in]", altitude_ft: "altitude [ft]", name: "file", mtime: "exported" }} format={{ status: (v) => <Badge status={v} />, mtime: (v) => (v ? ago(v) : "—"), altitude_ft: (v) => fmt(v, 0) }} onRow={(r) => { if (r.exists) nav({ to: "/aero", search: { sel: r.path } as any }); }} rowKey={(r) => r.path} selected={pick} />
      {a.extra.length ? <div className="mt-2 text-[12px] text-muted">{a.extra.length} other table(s) in {a.dir} are also loaded and interpolated: {a.extra.map((e: any) => e.name).join(", ")}</div> : null}</Card>
    <Card><CardTitle>Drag curve</CardTitle>{!pick ? <div className="text-muted">no table to plot yet</div> : t.isLoading ? <div className="text-muted">Loading…</div> : t.error ? <Callout kind="err">{String((t.error as Error).message)}</Callout> : t.data ? <div><div className="mb-1 flex items-center gap-2 text-[12px] text-muted">table: <Select className="h-7" value={pick} onChange={(e) => nav({ to: "/aero", search: { sel: e.target.value } as any })}>{choices.map(([p, n]: any) => <option key={p} value={p}>{n}</option>)}</Select></div><LineChart series={[{ name: "CD power-off", x: cut(t.data.mach), y: cut(t.data.cd_off) }, { name: "CD power-on", x: cut(t.data.mach), y: cut(t.data.cd_on) }]} xLabel="Mach" yLabel="CD (ref. area from body diameter)" height={260} /></div> : null}</Card>
  </StepPage>;
}
