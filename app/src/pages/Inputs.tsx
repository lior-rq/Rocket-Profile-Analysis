import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { useNavigate, useSearch } from "@tanstack/react-router";
import { Folder, FolderOpen, FolderSearch, FileBox, FileCode2, Upload, X } from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import { toast } from "sonner";
import { ActionPanel, CmdPreview, RunButton, StepPage } from "@/components/common";
import { Badge, Button, Card, Check, DropZone, Field, Icon, Input, KV, NumberField, Pill, Problem, Select, Stat, StatGrid, Tabs, TabsContent, TabsList, TabsTrigger, spring } from "@/components/ui";
import { api } from "@/lib/api";
import { ago, dateTime, fmt, isNum } from "@/lib/format";
import { gridSummary } from "@/lib/grid";
import { pickFile, pickFolder } from "@/lib/native";
import { useAppState, useBusy, useCached, useRefresh } from "@/lib/store";
import { massTable, searchedSustainers } from "@/lib/types";
import { pickFiles, uploadFiles, useDropZone, type Picked, type UploadKind } from "@/lib/upload";
import { cn } from "@/lib/utils";
import { useUi } from "@/store/ui";

type Edits = Record<string, unknown>;
type Form = { val: (dotted: string) => unknown; edits: Edits; setEdit: (dotted: string, v: unknown) => void; submit: () => void };
/* Field components MUST stay at module level: defined inside InputsPage they
   would be a new component type per render, remounting the input per keystroke. */
const FormCtx = createContext<Form>(null!);
function NumField({ label, dotted, hint, step, min, max, placeholder, clearable, clearLabel }: { label: string; dotted: string; hint?: ReactNode; step?: number; min?: number; max?: number; placeholder?: string; clearable?: boolean; clearLabel?: string }) {
  const { val, edits, setEdit, submit } = useContext(FormCtx); const v = val(dotted) as any;
  return (
    <Field label={label} hint={hint} edited={dotted in edits}>
      <div className="flex gap-1.5">
        <NumberField value={v} step={step ?? 1} min={min} max={max} placeholder={placeholder || "null"} onChange={(n) => setEdit(dotted, n)} onEnter={submit} />
        {clearable && v != null && v !== "" ? <Button size="sm" variant="chip" title="clear the override" onClick={() => setEdit(dotted, null)}><Icon of={X} size="xs" />{clearLabel || "clear"}</Button> : null}
      </div>
    </Field>
  );
}
function SelField({ label, dotted, options, hint }: { label: string; dotted: string; options: { value: string; label: string }[]; hint?: ReactNode }) {
  const { val, edits, setEdit } = useContext(FormCtx); const cur = val(dotted) as string; const opts = options.slice();
  if (cur && !opts.some((o) => o.value === cur)) opts.unshift({ value: cur, label: cur + " (not found)" });
  return <Field label={label} hint={hint} edited={dotted in edits}><Select value={cur ?? ""} onChange={(e) => setEdit(dotted, e.target.value)}>{opts.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}</Select></Field>;
}
function FileField({ label, dotted, hint, ext, saved, icon }: { label: string; dotted: string; hint?: string; ext: string; saved: any; icon: typeof FileBox }) {
  const { val, edits, setEdit } = useContext(FormCtx);
  return <ModelFileField label={label} hint={hint} ext={ext} saved={saved} icon={icon} value={(val(dotted) as string) || ""} edited={dotted in edits} onChange={(v) => setEdit(dotted, v)} />;
}
function SiteField({ site, label, k, unit }: { site: any; label: string; k: string; unit: string }) {
  return <NumField label={`${label} [${unit}]`} dotted={`launch_site.${k}`} hint={site[k] != null ? `empty = the CDX1 value (${fmt(site[k])} ${unit})` : "empty = keep the CDX1 value"} placeholder={site[k] != null ? `${fmt(site[k])} (CDX1)` : "CDX1 value"} clearable clearLabel="use CDX1 value" />;
}
const same = (a: any, b: any) => a === b || (a == null && b == null) || (isNum(a) && isNum(b) && Math.abs(a - b) < 1e-12) || (Array.isArray(a) && Array.isArray(b) && JSON.stringify(a) === JSON.stringify(b));

export function InputsPage() {
  const s = useAppState();
  const refresh = useRefresh();
  const setDrawerOpen = useUi((x) => x.setDrawerOpen);
  const busy = useBusy();
  const search = useSearch({ strict: false }) as any;
  const nav = useNavigate();
  const [edits, setEdits] = useState<Edits>({});
  const tab = search.tab || "vehicle";
  useEffect(() => { const h = (e: BeforeUnloadEvent) => { if (Object.keys(edits).length) { e.preventDefault(); e.returnValue = ""; } }; window.addEventListener("beforeunload", h); return () => window.removeEventListener("beforeunload", h); }, [edits]);
  if (!s) return null;
  const cfg = s.config, inp = s.inputs, mass = s.mass;
  const cfgVal = (dotted: string) => dotted.split(".").reduce((o: any, k) => (o == null ? undefined : o[k]), cfg);
  const val = (dotted: string) => (dotted in edits ? edits[dotted] : cfgVal(dotted));
  const setEdit = (dotted: string, v: unknown) => setEdits((e) => { const n = { ...e }; if (same(v, cfgVal(dotted))) delete n[dotted]; else n[dotted] = v; return n; });
  const dirty = Object.keys(edits).length;
  const problems = (() => { const p = (k: string) => Number(val("profiles." + k)), out: string[] = []; if (!(Number(val("target.apogee_ft")) > 0)) out.push("target apogee must be > 0"); if (!(Number(val("target.tolerance_ft")) > 0)) out.push("tolerance must be > 0"); if (p("separation_delay_min_s") > p("separation_delay_max_s")) out.push("separation delay: min is above max"); if (p("ignition_delay_min_s") > p("ignition_delay_max_s")) out.push("ignition delay: min is above max"); if (!(p("separation_step_s") > 0)) out.push("separation step must be > 0"); if (!(p("coarse_step_s") > 0)) out.push("ignition step must be > 0"); if (p("subsonic_max_mach") >= p("supersonic_min_mach")) out.push("subsonic max Mach must be below the supersonic min Mach"); if (p("mach_margin") < 0) out.push("Mach margin must be ≥ 0"); const c = val("sustainer_selection.count") as any; if (c != null && c !== "" && !(c >= 1 && c <= 20)) out.push("sustainers searched: count must be 1–20"); const hw = val("mass_model.hardware_mass_lb") as any; if (hw != null && hw !== "" && !(hw > 0)) out.push("hardware mass must be > 0, or empty for the .ork masses"); return out; })();
  const save = async (thenCheck?: boolean) => { try { await api("/api/config", { set: edits }); setEdits({}); toast.success("config.yaml saved"); if (thenCheck) await api("/api/run", { stage: "check", args: [], label: "check" }).then(() => setDrawerOpen(true)).catch((e: any) => toast.error(e.message)); await refresh(); } catch (e: any) { toast.error(e.message); } };
  const form: Form = { val, edits, setEdit, submit: () => { if (dirty && !problems.length) save(); } };
  const site = inp.site_cdx1 || inp.site || {};
  const g = gridSummary({ separation_delay_min_s: val("profiles.separation_delay_min_s") as number, separation_delay_max_s: val("profiles.separation_delay_max_s") as number, separation_step_s: val("profiles.separation_step_s") as number, ignition_delay_min_s: val("profiles.ignition_delay_min_s") as number, ignition_delay_max_s: val("profiles.ignition_delay_max_s") as number, coarse_step_s: val("profiles.coarse_step_s") as number });
  const method = (val("mass_model.method") as string) || "openrocket";
  const hw = val("mass_model.hardware_mass_lb") as number | null;
  const t = massTable(s), est = mass.estimate;
  return (
    <FormCtx.Provider value={form}>
      <StepPage id="inputs" summary="Pick the vehicle and motor files, set the hardware mass and the target apogee. Changes go to config.yaml; Check parses every input and reports what the later steps would trip over."
        action={<ActionPanel title="Check the inputs" prereqs={[{ label: ".ork", ok: inp.ork.exists, hint: "OpenRocket model file missing" }, { label: ".CDX1", ok: inp.cdx1.exists, hint: "RASAero model file missing" }, { label: `${inp.boosters.n} boosters`, ok: inp.boosters.n > 0 && !inp.boosters.problems.length, hint: "no booster files selected" }, { label: `${inp.sustainers.n} sustainers`, ok: inp.sustainers.n > 0 && !inp.sustainers.problems.length, hint: "no sustainer files selected" }, { label: "saved", ok: !dirty, hint: "save your changes first" }]}
          buttons={<RunButton stage="check" label="Check inputs" primary disabled={dirty > 0} title={dirty ? "save your changes first" : ""} />}
          notes={<>{inp.problems.length ? <Problem tone="err"><b>Problems: </b><ul className="list-disc">{inp.problems.map((p: string, i: number) => <li key={i}>{p}</li>)}</ul></Problem> : null}
            {inp.last_check ? <Problem tone={inp.last_check.exit_code === 0 ? "ok" : "warn"}><b>{inp.last_check.exit_code === 0 ? "Last check passed" : "Last check reported problems"}</b> ({dateTime(inp.last_check.finished)}{inp.status === "unchecked" ? ", but inputs changed since" : ""}). {inp.last_check.exit_code === 0 ? "" : "Open the activity log for the list."}</Problem>
              : <Problem tone="info">Not checked yet — press <b>Check inputs</b>. The output appears in the activity drawer below.</Problem>}</>}
          cmd={<CmdPreview stage="check" />} />}
        how={<div><p>Everything on this page lives in <code>config.yaml</code> (edited in place, comments kept). Files can be anywhere on disk; paths inside the project are stored relative to it.</p><ul><li><b>Vehicle & site</b> — the .ork (mass distribution) and .CDX1 (geometry, launch site); launch-site overrides.</li><li><b>Motors</b> — folders and .eng/.ric files for the booster and sustainer candidates.</li><li><b>Mass</b> — the hardware (dry) mass; the .ork only supplies the split and the CGs.</li><li><b>Target & rules</b> — target apogee, tolerance, the transonic-separation rules and the simulation backend.</li></ul><p><b>Check</b> parses the motors, reads the CDX1 and confirms the engine is available.</p></div>}>
        <AnimatePresence initial={false}>
          {dirty ? (
            <motion.div key="dirty" initial={{ opacity: 0, y: -8, height: 0 }} animate={{ opacity: 1, y: 0, height: "auto" }} exit={{ opacity: 0, y: -8, height: 0 }} transition={spring} className="sticky top-[76px] z-20">
              <div className="glass-bar flex flex-wrap items-center gap-2 px-4 py-2.5 text-[13px]" style={{ boxShadow: "var(--shadow-bar), 0 0 0 1px var(--warn)" }}>
                <b>Unsaved</b><span className="num">{dirty} change{dirty === 1 ? "" : "s"}</span><span className="text-ink-3">written to config.yaml with its comments intact</span><span className="flex-1" />
                <Button variant="primary" size="sm" disabled={problems.length > 0} onClick={() => save(false)}>Save</Button>
                <Button size="sm" disabled={problems.length > 0 || busy} onClick={() => save(true)}>Save & check</Button>
                <Button size="sm" variant="chip" onClick={() => setEdits({})}>Discard</Button>
                {problems.length ? <div className="basis-full text-bad">Fix before saving: {problems.join(" · ")}</div> : null}
              </div>
            </motion.div>
          ) : null}
        </AnimatePresence>
        <Card static>
          <Tabs value={tab} onValueChange={(v) => nav({ to: "/inputs", search: { tab: v } as any })}>
            <TabsList>
              <TabsTrigger value="vehicle">Vehicle & site</TabsTrigger>
              <TabsTrigger value="motors" extra={`${inp.boosters.n} + ${inp.sustainers.n}`}>Motors</TabsTrigger>
              <TabsTrigger value="mass" extra={mass.hardware_mass_lb != null ? `${fmt(mass.hardware_mass_lb, 0)} lb` : ".ork"}>Mass</TabsTrigger>
              <TabsTrigger value="target" extra={`${fmt(cfg.target.apogee_ft, 0)} ft`}>Target & rules</TabsTrigger>
            </TabsList>
            <TabsContent value="vehicle" className="mt-4">
              <div className="grid gap-4 lg:grid-cols-2 lg:items-start">
                <Card title="Model files" plain>
                  <FileField label="OpenRocket model" dotted="paths.ork" hint="mass distribution and CGs" ext=".ork" saved={inp.ork} icon={FileBox} />
                  <FileField label="RASAero model" dotted="paths.cdx1" hint="geometry, launch site and the simulation rows RASAero runs" ext=".CDX1" saved={inp.cdx1} icon={FileCode2} />
                  <div className="divider" />
                  {inp.site ? <KV pairs={[["reference diameter", `${fmt(inp.ref_diameter_in, 3)} in (largest body diameter in the CDX1)`], ["OpenRocket", s.engine?.openrocket?.jar ? `found: ${s.engine.openrocket.jar}` : <Badge status="err">OpenRocket not found (Settings, paths.openrocket_jar)</Badge>]]} /> : <Problem tone="warn">{inp.cdx1.path ? "CDX1 not readable" : "no CDX1 selected yet"}</Problem>}
                </Card>
                <Card title="Launch site" sub="from the CDX1; override here if needed" plain>
                  <div className="grid grid-cols-2 gap-3"><SiteField site={site} label="Altitude" k="altitude_ft" unit="ft" /><SiteField site={site} label="Pressure" k="pressure_inhg" unit="inHg" /><SiteField site={site} label="Temperature" k="temperature_f" unit="°F" /><SiteField site={site} label="Rod angle" k="rod_angle_deg" unit="deg" /><SiteField site={site} label="Rod length" k="rod_length_ft" unit="ft" /><SiteField site={site} label="Wind" k="wind_speed_mph" unit="mph" /></div>
                </Card>
              </div>
            </TabsContent>
            <TabsContent value="motors" className="mt-4"><MotorsTab s={s} val={val} setEdit={setEdit} /></TabsContent>
            <TabsContent value="mass" className="mt-4">
              <Card title="Mass model" plain actions={<RunButton stage="mass" label="Compute mass table" size="sm" disabled={dirty > 0} title={dirty ? "save first" : ""} />}>
                <div className="grid gap-3 md:grid-cols-2">
                  <SelField label="Method" dotted="mass_model.method" options={[{ value: "openrocket", label: "openrocket – the .ork gives the mass distribution" }, { value: "manual", label: "manual – type the weights and CGs" }]} />
                  {method === "openrocket" ? <NumField label="Vehicle hardware mass [lb]" dotted="mass_model.hardware_mass_lb" hint="dry mass of the whole two-stage rocket: airframe, recovery, avionics, motor cases — everything except propellant. Empty = use the .ork masses as they are." step={0.5} min={0} placeholder="use .ork masses" /> : null}
                </div>
                {method === "openrocket" ? (
                  <>
                    <KV pairs={[est ? ["propellant (from the .eng files)", `sustainer ${fmt(est.sustainer_prop_lb, 1)} lb · booster ${est.booster_prop_lb ? `${fmt(est.booster_prop_lb[0], 1)}–${fmt(est.booster_prop_lb[1], 1)}` : "—"} lb`] : null, est && hw != null && est.booster_prop_lb ? ["loaded stack on the pad", `${fmt(hw + est.sustainer_prop_lb + est.booster_prop_lb[0], 0)}–${fmt(hw + est.sustainer_prop_lb + est.booster_prop_lb[1], 0)} lb (hardware + propellant)`] : null, t ? ["mass table (computed)", <span><b className={t.stale ? "text-warn" : "text-good"}>{fmt(t.combined_wt_lb[0], 0)}–{fmt(t.combined_wt_lb[1], 0)} lb</b> stack on the pad · sustainer {fmt(t.sustainer_wt_lb, 1)} lb @ CG {fmt(t.sustainer_cg_in, 1)} in · {t.n} pairs · {ago(t.mtime)}</span>] : null, t && t.sustainer_dry_lb != null ? ["dry split used" + (t.hardware_mass_lb != null ? "" : " (.ork as-is)"), `sustainer ${fmt(t.sustainer_dry_lb, 1)} + booster ${fmt(t.booster_dry_lb, 1)} = ${fmt(t.sustainer_dry_lb + t.booster_dry_lb, 1)} lb`] : null]} />
                    {mass.table?.error ? <Problem tone="err"><b>The mass table is unreadable: </b>{mass.table.error}. Run the mass stage to recompute it.</Problem> : null}
                    {t && t.stale ? <Problem tone="warn"><b>The mass table is out of date: </b>it was computed with {t.hardware_mass_lb == null ? "the .ork masses" : t.hardware_mass_lb + " lb"}{hw == null ? " but the config now says .ork masses" : hw !== t.hardware_mass_lb ? `, the config now says ${hw} lb` : ""}. Save, then run the mass stage (the optimizer does it automatically too).</Problem> : null}
                    {!t ? <Problem tone="info">No mass table yet — it is computed by the mass stage (or by the optimizer) from the .ork with OpenRocket, using the hardware mass above.</Problem> : null}
                    <p className="text-[12px] text-ink-2 leading-relaxed">How it is applied: OpenRocket supplies each stage's dry mass, CG and motor position; both dry masses are scaled by one factor so the vehicle weighs the hardware mass empty, then the .eng propellant is added and the loaded weights / CGs RASAero needs are recombined.</p>
                  </>
                ) : <div className="grid gap-3 md:grid-cols-2"><NumField label="Sustainer loaded weight [lb]" dotted="mass_model.manual.sustainer_wt_lb" /><NumField label="Sustainer CG [in from nose]" dotted="mass_model.manual.sustainer_cg_in" /><NumField label="Combined weight with the reference booster [lb]" dotted="mass_model.manual.combined_wt_lb_ref" /><NumField label="Combined CG with the reference booster [in]" dotted="mass_model.manual.combined_cg_in_ref" /><NumField label="Reference booster propellant [kg]" dotted="mass_model.manual.ref_booster_prop_kg" /><NumField label="Booster propellant CG [in from nose]" dotted="mass_model.manual.booster_prop_cg_in" hint="other boosters are derived by adding their propellant difference at this station" /></div>}
              </Card>
            </TabsContent>
            <TabsContent value="target" className="mt-4">
              <div className="grid gap-4 lg:grid-cols-2 lg:items-start">
                <Card title="Target" plain>
                  <NumField label="Target apogee [ft]" dotted="target.apogee_ft" hint="what the search aims for" step={1} />
                  <NumField label="Tolerance [ft]" dotted="target.tolerance_ft" hint='a design is "solved" when |apogee − target| ≤ tolerance' step={1} />
                  <SelField label="Simulation backend" dotted="backend" options={[{ value: "rasaero_native", label: "rasaero_native – RASAero's own engine on this machine (exact, fast)" }, { value: "openrocket", label: "openrocket – preview only (different aero)" }]} hint="the native engine needs nothing else on this machine" />
                </Card>
                <Card title="Sustainers searched" plain>
                  <p className="text-[12px] text-ink-2 leading-relaxed">Every booster is paired with each of these sustainers. "span" flies one reference booster under every sustainer candidate and keeps the ones at the lowest, highest and evenly spaced apogee; the pick is redone whenever the candidates or this setting change.</p>
                  <SelField label="Selection" dotted="sustainer_selection.mode" options={[{ value: "best", label: "best – the max-impulse candidate only" }, { value: "span", label: "span – a few candidates spanning the apogee range" }, { value: "list", label: "list – exactly the labels in config.yaml sustainer_selection.labels" }]} hint="best = one sustainer, as before" />
                  <NumField label="How many (span)" dotted="sustainer_selection.count" hint="min, max and evenly spaced between; 5 is plenty when the candidates differ by a few percent" step={1} min={1} max={20} />
                </Card>
                <Card title="Profile rules" plain>
                  <p className="text-[12px] text-ink-2 leading-relaxed">Two staging profiles are designed so the booster never separates in the transonic band: subsonic (the attached stack stays below Mach 0.9 throughout) and supersonic (separation happens above Mach 1.2).</p>
                  <NumField label="Subsonic profile: max Mach" dotted="profiles.subsonic_max_mach" hint="the attached stack never exceeds this" step={0.01} />
                  <NumField label="Supersonic profile: min Mach at separation" dotted="profiles.supersonic_min_mach" hint="separation must happen at or above this" step={0.01} />
                  <NumField label="Design margin (Mach)" dotted="profiles.mach_margin" hint="applied to both limits" step={0.01} />
                </Card>
                <Card title="Staging delay windows" plain>
                  <p className="text-[12px] text-ink-2 leading-relaxed">The optimizer searches both delays inside these windows. Separation is counted from booster burnout, ignition from separation (RASAero's convention), so <b>ignition can never happen before burnout</b>: both minimums are floored at 0.</p>
                  <div className="grid grid-cols-2 gap-3"><NumField label="Separation delay: min [s]" dotted="profiles.separation_delay_min_s" hint="earliest booster separation after burnout" step={0.05} min={0} /><NumField label="Separation delay: max [s]" dotted="profiles.separation_delay_max_s" hint="latest booster separation after burnout" step={0.05} min={0} /><NumField label="Separation delays tried: step [s]" dotted="profiles.separation_step_s" hint="min, min+step, …, max (at most 9 points)" step={0.05} min={0.05} /><NumField label="Ignition delay: min [s]" dotted="profiles.ignition_delay_min_s" hint="earliest sustainer ignition after separation" step={0.1} min={0} /><NumField label="Ignition delay: max [s]" dotted="profiles.ignition_delay_max_s" hint="latest sustainer ignition after separation" step={0.5} min={0} /><NumField label="Ignition delays tried: step [s]" dotted="profiles.coarse_step_s" hint="coarse grid before the bracket refinement" step={0.1} min={0.05} /></div>
                  <Problem tone="info"><b>Effective grids: </b>separation {g.sep.length} point{g.sep.length === 1 ? "" : "s"} ({fmt(g.sep[0], 2)} to {fmt(g.sep[g.sep.length - 1], 2)} s{g.sep.length > 1 ? `, every ${fmt(g.sepStep, 2)} s` : ""}){g.capped ? <span className="text-warn"> — your {fmt(+(val("profiles.separation_step_s") as number), 2)} s step is coarsened: the search caps separation at 9 points</span> : ""} · ignition {g.ign.length} point{g.ign.length === 1 ? "" : "s"} ({fmt(g.ign[0], 2)} to {fmt(g.ign[g.ign.length - 1], 2)} s every {fmt(+(val("profiles.coarse_step_s") as number), 2)} s) · {fmt(g.sep.length * g.ign.length, 0)} flights per candidate before refinement.</Problem>
                </Card>
              </div>
            </TabsContent>
          </Tabs>
        </Card>
      </StepPage>
    </FormCtx.Provider>
  );
}

function MotorsTab({ s, val, setEdit }: { s: any; val: (d: string) => unknown; setEdit: (d: string, v: unknown) => void }) {
  const inp = s.inputs, m = inp.motors;
  const mt = useCached<any>("motors", "/api/motors", inp.inputs_mtime);
  const listOf = (kind: string) => { const v = val("paths." + kind) as any; return Array.isArray(v) ? v : v ? [v] : []; };
  const excl = (kind: string) => ({ get: () => (val("paths.exclude_" + kind) as string[]) || [], set: (v: string[]) => setEdit("paths.exclude_" + kind, v) });
  return (
    <div className="flex flex-col gap-4">
      <Problem tone="info">Drop motor files or folders onto a card below, or use Upload: one-motor <code>.eng</code> files, multi-motor RASP <code>.eng</code> files (every motor inside counts) and openMotor <code>.ric</code> designs (simulated once and cached). Uploads are copied into <code>input/</code>. Every ticked booster is a candidate; which sustainers fly with each booster is set under Target & rules.</Problem>
      <div className="grid gap-4 lg:grid-cols-2 lg:items-start">
        <MotorPicker kind="boosters" title="Booster candidates" get={() => listOf("boosters")} set={(v) => setEdit("paths.boosters", v)} problems={inp.boosters.problems} motors={mt.data?.boosters?.rows || []} exclude={excl("boosters")} />
        <MotorPicker kind="sustainers" title="Sustainer candidates" get={() => listOf("sustainers")} set={(v) => setEdit("paths.sustainers", v)} problems={inp.sustainers.problems} highlight={searchedSustainers(m)} motors={mt.data?.sustainers?.rows || []} exclude={excl("sustainers")} />
      </div>
      {m ? (
        <Card title="Motor set as currently saved" sub="what the pipeline will use after Save" plain>
          <StatGrid>
            <Stat label="boosters" value={m.n_boosters} />
            <Stat label="booster impulse" value={m.booster_impulse_ns ? `${fmt(m.booster_impulse_ns[0] / 1000, 1)}–${fmt(m.booster_impulse_ns[1] / 1000, 1)}` : "—"} unit="kN·s" />
            <Stat label="booster nozzle exit" value={m.booster_nozzle_in ? `${fmt(m.booster_nozzle_in[0], 2)}–${fmt(m.booster_nozzle_in[1], 2)}` : "—"} unit="in" />
            <Stat label="sustainer(s)" value={(m.sustainer_selection?.selected?.length || 1)} sub={m.sustainer_selection?.selected?.length ? m.sustainer_selection.selected.map((x: any) => x.label).join(", ") : m.sustainer.label} />
          </StatGrid>
          {m.boosters_missing_nozzle.length ? <Problem tone="warn"><b>No nozzle exit diameter in: </b>{m.boosters_missing_nozzle.join(", ")} — add a "Throat x in, exit y in" comment to the .eng or set rasaero.booster_nozzle_in.</Problem> : null}
        </Card>
      ) : <Problem tone="warn">The saved motor selection cannot be loaded — see the problems above.</Problem>}
    </div>
  );
}

export function MotorPicker({ kind, title, get, set, problems = [], highlight, motors = [], exclude }: { kind: string; title: string; get: () => string[]; set: (v: string[]) => void; problems?: string[]; highlight?: Set<string>; motors?: any[]; exclude?: { get: () => string[]; set: (v: string[]) => void } }) {
  const [tree, setTree] = useState<any>(null);
  const [extra, setExtra] = useState<string[]>([]);
  const [q, setQ] = useState("");
  const [pathBox, setPathBox] = useState("");
  const [open, setOpen] = useState<Record<string, boolean>>({});
  const [showPaths, setShowPaths] = useState(false);
  const collapse = useRef(false);  // after an upload: fold fully ticked folders into the folder path
  const entries = get();
  const entriesKey = JSON.stringify(entries) + JSON.stringify(extra);
  const storeWith = (t: any, sel: Set<string>) => { const out: string[] = []; const ex = [...extra]; for (const d of t.folders) { const inside = d.files.filter((x: any) => sel.has(x.path)); if (inside.length === d.files.length && d.files.length) out.push(d.path); else inside.forEach((x: any) => out.push(x.path)); if (!inside.length && !ex.includes(d.path)) ex.push(d.path); } setExtra(ex); set(out); };
  useEffect(() => { let alive = true; api("/api/motor_tree", { entries, extra_folders: extra }).then((t) => { if (!alive) return; setTree(t); if (collapse.current) { collapse.current = false; storeWith(t, new Set(t.selected)); } }).catch((e) => alive && setTree({ folders: [], selected: [], unknown: [], error: e.message })); return () => { alive = false; }; }, [entriesKey]); // eslint-disable-line react-hooks/exhaustive-deps
  const store = (sel: Set<string>) => storeWith(tree, sel);
  const addPaths = (paths: string[]) => { const cur = get(); const fresh = paths.map((p) => (p || "").trim()).filter((p) => p && !cur.includes(p)); if (!fresh.length) { if (paths.some((p) => p && p.trim())) toast.warning("already in the list"); return; } collapse.current = true; set([...cur, ...fresh]); };
  const took = async (list: Picked[]) => addPaths(await uploadFiles(kind as UploadKind, list));
  const drop = useDropZone(took);
  const add = async (what: "folder" | "file") => { try { const p = what === "folder" ? await pickFolder(`Choose a folder of ${kind} motor files`) : await pickFile(`Choose a ${kind} motor file (.eng or .ric)`, ".eng"); if (p) addPaths([p]); } catch (e: any) { toast.error(e.message); } };
  if (!tree) return <Card title={title} plain><div className="skeleton h-24" /></Card>;
  const sel = new Set<string>(tree.selected);
  const nFolders = tree.folders.filter((d: any) => d.files.some((x: any) => sel.has(x.path))).length;
  const nMotors = tree.folders.reduce((n: number, d: any) => n + d.files.filter((x: any) => sel.has(x.path)).reduce((mm: number, x: any) => mm + (x.n_motors || 1), 0), 0);
  const isHi = (label: string) => !!highlight && highlight.has(label);
  return (
    <Card {...drop.handlers} plain className={cn("drop-target", drop.over && "over")} title={title} sub={`${nMotors} motor${nMotors === 1 ? "" : "s"} in ${sel.size} file${sel.size === 1 ? "" : "s"} from ${nFolders} folder${nFolders === 1 ? "" : "s"}`}>
      <div className="flex flex-wrap items-center gap-1.5">
        <Button size="sm" variant="primary" title={`copy files into input/${kind}/`} onClick={async () => took(await pickFiles({ multiple: true, accept: ".eng,.ric" }))}><Icon of={Upload} size="sm" />Upload files…</Button>
        <Button size="sm" title={`copy a whole folder into input/${kind}/`} onClick={async () => took(await pickFiles({ folder: true }))}><Icon of={FolderOpen} size="sm" />Upload folder…</Button>
        <span className="text-[11px] text-ink-3">or drop files / folders on this card</span><span className="flex-1" />
        <Button size="sm" variant="chip" on={showPaths} onClick={() => setShowPaths(!showPaths)}>use a path…</Button>
      </div>
      {showPaths ? (
        <div className="flex flex-wrap items-center gap-1.5">
          <Button size="sm" title="use a folder where it is (no copy)" onClick={() => add("folder")}><Icon of={FolderSearch} size="sm" />Browse folder…</Button>
          <Button size="sm" title="use a file where it is (no copy)" onClick={() => add("file")}><Icon of={FolderSearch} size="sm" />Browse file…</Button>
          <Input sm sans className="!w-auto min-w-[220px] flex-1" placeholder="paste a path to a folder or .eng/.ric file" spellCheck={false} value={pathBox} onChange={(e) => setPathBox(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") { addPaths([pathBox]); setPathBox(""); } }} />
          <Button size="sm" variant="chip" onClick={() => { addPaths([pathBox]); setPathBox(""); }}>add</Button>
        </div>
      ) : null}
      {tree.folders.length > 1 ? <div className="flex items-center gap-2"><Input sm sans className="!w-auto max-w-[260px]" placeholder="filter by name…" value={q} onChange={(e) => setQ(e.target.value)} /><span className="flex-1" /><Button size="sm" variant="chip" onClick={() => store(new Set())}>untick all</Button></div> : null}
      {tree.error ? <Problem tone="err">{tree.error}</Problem> : null}
      {tree.unknown.length ? <Problem tone="warn"><b>Not found: </b>{tree.unknown.join(", ")} <Button size="sm" variant="chip" onClick={() => set(get().filter((e) => !tree.unknown.includes(e)))}>drop them</Button></Problem> : null}
      {problems.length ? <Problem tone="err">{problems.join(" · ")}</Problem> : null}
      {!tree.folders.length ? <DropZone over={drop.over}>Drop {kind === "boosters" ? "booster" : "sustainer"} .eng / .ric files or a folder here</DropZone> : null}
      <div className="flex flex-col gap-1.5">
        {tree.folders.map((d: any) => {
          const ql = q.toLowerCase(); const files = d.files.filter((x: any) => !ql || x.name.toLowerCase().includes(ql) || (x.designation || "").toLowerCase().includes(ql)); if (ql && !files.length) return null;
          const nSel = d.files.filter((x: any) => sel.has(x.path)).length, all = nSel === d.files.length && d.files.length > 0;
          const isOpen = d.path in open ? open[d.path] : nSel > 0 || !!ql;
          return (
            <div key={d.path} className="rounded-2 border border-line overflow-hidden">
              <div className="flex items-center gap-2 bg-surface-2 px-2.5 py-1.5">
                <Check checked={all} indeterminate={nSel > 0 && !all} onChange={() => { const next = new Set(sel); if (all) d.files.forEach((x: any) => next.delete(x.path)); else d.files.forEach((x: any) => next.add(x.path)); store(next); }} />
                <Icon of={isOpen ? FolderOpen : Folder} size="sm" className="text-ink-3" />
                <button type="button" className="min-w-0 flex-1 truncate text-left font-mono text-[12px]" title={d.path} onClick={() => setOpen({ ...open, [d.path]: !isOpen })}>{d.path}</button>
                <Pill tone={nSel ? "good" : "muted"} lower>{nSel}/{d.files.length}</Pill>
                <Button size="sm" variant="icon" className="!w-6 !h-6" title="remove this folder from the list" onClick={() => { const next = new Set(sel); d.files.forEach((x: any) => next.delete(x.path)); setExtra(extra.filter((f) => f !== d.path)); const out: string[] = []; for (const dd of tree.folders) { if (dd === d) continue; const inside = dd.files.filter((x: any) => next.has(x.path)); if (inside.length === dd.files.length && dd.files.length) out.push(dd.path); else inside.forEach((x: any) => out.push(x.path)); } set(out); }}><Icon of={X} size="sm" /></Button>
              </div>
              {isOpen ? (
                <div className="max-h-[320px] overflow-auto px-2 py-1">
                  {files.map((x: any) => {
                    const on = sel.has(x.path); const bad = !!x.error; const many = (x.n_motors || 1) > 1; const ric = x.kind === "ric"; const inner = many && on && exclude ? motors.filter((mm) => mm.file === x.path) : []; const ex = new Set(exclude?.get() || []);
                    return (
                      <div key={x.path}>
                        <label className={cn("flex flex-wrap items-center gap-2 rounded-1 px-1.5 py-1 text-[12.5px] cursor-pointer transition-colors", on && "bg-accent-2", bad && "opacity-60", isHi(x.label) && "shadow-[inset_0_0_0_1px_color-mix(in_srgb,var(--good)_40%,transparent)]")} title={x.error || x.path}>
                          <input type="checkbox" className="check-box" checked={on} disabled={bad} onChange={() => { const next = new Set(sel); if (on) next.delete(x.path); else next.add(x.path); store(next); }} />
                          <span className="font-medium">{x.label}</span>
                          {bad ? <Badge status="err">unreadable</Badge> : ric && x.pending ? <span className="text-ink-3 flex items-center gap-1.5"><Badge status="warn">openMotor design</Badge> not simulated yet — Check converts it</span> : many ? <span className="text-ink-3 flex items-center gap-1.5 num"><Badge status="info">{x.n_motors} motors in this file</Badge> first: {x.designation} · {fmt((x.total_impulse_ns || 0) / 1000, 1)} kN·s</span> : <span className="text-ink-3 num flex items-center gap-1.5">{ric ? <Badge status="info">openMotor</Badge> : null} {fmt((x.total_impulse_ns || 0) / 1000, 1)} kN·s · {fmt(x.burn_time_s, 1)} s · noz {x.nozzle_exit_in != null ? fmt(x.nozzle_exit_in, 2) + " in" : "?"}</span>}
                          {isHi(x.label) ? <Badge status="ok" title="flown with every booster by the optimizer">searched</Badge> : null}
                        </label>
                        {inner.length ? (
                          <div className="ml-6 my-1 rounded-2 border border-line bg-surface-2 px-2.5 py-1.5">
                            <div className="flex items-center gap-2 text-[12px] text-ink-3">{inner.filter((mm) => !ex.has(mm.label)).length} of {inner.length} motors in this file are candidates{inner.some((mm) => ex.has(mm.label)) ? <Button size="sm" variant="chip" onClick={() => exclude!.set([])}>use all</Button> : null}</div>
                            {inner.map((mm) => { const used = !ex.has(mm.label); return <label key={mm.label} className={cn("flex flex-wrap items-center gap-2 py-1 text-[12px] cursor-pointer", isHi(mm.label) && "text-good")}><input type="checkbox" className="check-box" checked={used} onChange={() => { const next = new Set(ex); if (used) next.add(mm.label); else next.delete(mm.label); exclude!.set([...next].sort()); }} /><span className="font-medium">{mm.label}</span><span className="text-ink-3 num">{fmt((mm.total_impulse_ns || 0) / 1000, 1)} kN·s · {fmt(mm.burn_time_s, 1)} s · {fmt(mm.avg_thrust_n, 0)} N avg · noz {mm.nozzle_exit_in != null ? fmt(mm.nozzle_exit_in, 2) + " in" : "?"}</span>{isHi(mm.label) ? <Badge status="ok">searched</Badge> : null}</label>; })}
                          </div>
                        ) : null}
                      </div>
                    );
                  })}
                </div>
              ) : null}
            </div>
          );
        })}
      </div>
    </Card>
  );
}

/* One model file (.ork / .CDX1): typed path, Upload (copy into input/models/),
   Browse (use in place) and a drop target. */
function ModelFileField({ label, hint, ext, saved, value, edited, onChange, icon }: { label: string; hint?: string; ext: string; saved: any; value: string; edited: boolean; onChange: (v: string | null) => void; icon: typeof FileBox }) {
  const status = !value ? ["warn", "not set"] : edited ? ["info", "unsaved"] : saved && saved.exists ? ["ok", "found"] : ["err", "missing"];
  const badExt = value && !value.toLowerCase().endsWith(ext.toLowerCase());
  const took = async (list: Picked[]) => { const [p] = await uploadFiles("models", list.filter((x) => x.rel.toLowerCase().endsWith(ext.toLowerCase()))); if (p) onChange(p); };
  const drop = useDropZone(took);
  return (
    <div {...drop.handlers} className={cn("flex flex-col gap-1.5 rounded-2 drop-target -m-1.5 p-1.5", drop.over && "over")}>
      <div className="text-[12px] font-medium text-ink-2 flex items-center gap-2"><Icon of={icon} size="sm" className="text-ink-3" />{label} <Badge status={badExt ? "warn" : status[0]}>{badExt ? `expected ${ext}` : status[1]}</Badge></div>
      <div className="flex gap-1.5">
        <Input value={value} placeholder={`path to the ${ext} file`} spellCheck={false} edited={edited} onChange={(e) => onChange(e.target.value.trim() || null)} />
        <Button size="sm" title="copy a file into input/models/" onClick={async () => took(await pickFiles({ accept: `${ext},${ext.toLowerCase()}` }))}><Icon of={Upload} size="sm" />Upload…</Button>
        <Button size="sm" variant="chip" title="use a file where it is (no copy)" onClick={async () => { try { const p = await pickFile(`Choose the ${label}`, ext); if (p) onChange(p); } catch (e: any) { toast.error(e.message); } }}><Icon of={FolderSearch} size="xs" />Browse…</Button>
      </div>
      <div className="text-[11px] text-ink-3">{hint ? hint + " · " : ""}drop a {ext} file here or Upload</div>
    </div>
  );
}
