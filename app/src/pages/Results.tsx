import { useEffect, useMemo, useState, type ReactNode } from "react";
import { useNavigate, useSearch } from "@tanstack/react-router";
import { toast } from "sonner";
import { keepPreviousData, useQueries, useQuery } from "@tanstack/react-query";
import { api, downloadFile, fileUrl } from "@/lib/api";
import { dateTime, fmt, fmtFt, isNum, signed } from "@/lib/format";
import { useApp, useCached } from "@/lib/store";
import { cn } from "@/lib/utils";
import { ActionPanel, Callout, ConfirmButton, Lightbox, ReportView, RunButton, Stat, StatList, StepPage } from "@/components/common";
import { DataTable } from "@/components/DataTable";
import { EVENT_COLORS, HistoryChart, HistoryOverlay, LineChart, PALETTE, ScatterChart, sustainerBurnout, type HistoryFrame } from "@/components/charts";
import { FlightConfig, interpAt, stagingTimes, type Player } from "@/components/player";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardTitle } from "@/components/ui/card";
import { Checkbox, Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";

const STATUS_BADGE: Record<string, string> = { solved: "ok", overpowered: "warn", underpowered: "warn", unsolved: "err", infeasible: "todo" };
const STATUS_COLOR: Record<string, string> = { solved: "#16a34a", overpowered: "#d97706", underpowered: "#9333ea", unsolved: "#dc2626" };
const keyOf = (r: any) => `${r.booster}|${r.sustainer ?? ""}|${r.profile}`;
const byDev = (a: any, b: any) => Math.abs(a.dev_ft ?? 1e9) - Math.abs(b.dev_ft ?? 1e9);

function useDesigns(d: any) {
  const t = useCached<any>("t:designs", "/api/table/designs", d.mtime);
  const rows = useMemo(() => (t.data?.rows || []).map((r: any) => ({ ...r, key: keyOf(r), dev_ft: isNum(r.apogee_ft) ? r.apogee_ft - d.target_ft : null, coast_s: isNum(r.sep_delay_s) && isNum(r.ign_delay_s) ? r.sep_delay_s + r.ign_delay_s : null })), [t.data, d.target_ft]);
  return { rows, loading: t.isLoading, error: t.error as Error | null };
}
/* The verified history if verify exported one, else an on-demand estimate. */
function historyQuery(r: any, s: any, d: any) {
  const ver = `${d.mtime}|${s.inputs.inputs_mtime}|${s.mass.table ? s.mass.table.mtime : ""}`;
  const key = keyOf(r);
  return {
    queryKey: ["design-hist", key, ver],
    queryFn: async () => {
      const dz = await api(`/api/design?booster=${encodeURIComponent(r.booster)}${r.sustainer ? "&sustainer=" + encodeURIComponent(r.sustainer) : ""}${r.profile ? "&profile=" + encodeURIComponent(r.profile) : ""}`);
      if (dz.history) return { dz, hist: (await api("/api/history?path=" + encodeURIComponent(dz.history.path))) as HistoryFrame, kind: "verified" as string | null };
      if (s.mass.table && r.sustainer && isNum(r.sep_delay_s) && isNum(r.ign_delay_s)) { try { return { dz, hist: (await api(`/api/flight?booster=${encodeURIComponent(r.booster)}&sustainer=${encodeURIComponent(r.sustainer)}&profile=${encodeURIComponent(r.profile || "")}&sep=${r.sep_delay_s}&ign=${r.ign_delay_s}`)) as HistoryFrame, kind: "estimated" }; } catch { /* no estimate */ } }
      return { dz, hist: null as HistoryFrame | null, kind: null as string | null };
    },
    staleTime: Infinity,
  };
}

export function ResultsPage() {
  const { state: s, refresh } = useApp();
  const search = useSearch({ strict: false }) as any;
  const nav = useNavigate();
  const [lb, setLb] = useState<string | null>(null);
  if (!s) return null;
  const d = s.results, cfg = s.config;
  const tab = search.tab || "designs";
  const setSearch = (patch: Record<string, unknown>) => nav({ to: "/results", search: { ...search, ...patch } as any });
  if (!d.n) return <StepPage id="results" summary="Designs, eligibility, characterization, time histories, plots and the written report."><Callout kind="info">No results yet — run the optimizer (step 2).</Callout></StepPage>;
  const shortlist: string[] = d.shortlist || [];
  const nElig = d.eligibility ? Object.values(d.eligibility as Record<string, any>).reduce((a: number, v: any) => a + v.eligible, 0) : null;
  const setShortlist = async (body: any) => { try { await api("/api/shortlist", body); await refresh(); } catch (e: any) { toast.error(e.message); } };
  const bundle = (which: string, n: number, label: string, primary?: boolean) => <Button variant={primary ? "primary" : "default"} disabled={!n} title={n ? `zip: one RASAero CDX1 with the ${n} designs as rows + the motor file they need` : "nothing yet"} onClick={async () => { try { toast(`building the RASAero bundle of ${n} designs…`); const name = await downloadFile(`/download/bundle?which=${which}`); toast.success(`downloaded ${name}`); } catch (e: any) { toast.error(e.message); } }}>{label}</Button>;
  const selectDesign = (key: string) => setSearch({ tab: "designs", sel: key });
  const common = { s, d, cfg, shortlist, setShortlist, selectDesign, search, setSearch, setLb };
  return <StepPage id="results" summary="Every (booster, sustainer, profile) candidate with the delays found, its apogee and status. Star the designs worth keeping: the shortlist compares them side by side and sends them to RASAero together."
    action={<ActionPanel title="Results" buttons={<>{bundle("solved", d.n_solved, `⬇ Solved → RASAero (${d.n_solved || 0})`)}{bundle("shortlist", shortlist.length, `⬇ Shortlist → RASAero (${shortlist.length})`)}<Button onClick={() => api("/api/reveal", { path: "output" }).catch((e: any) => toast.error(e.message))}>Reveal output folder</Button><RunButton stage="report" label="Rebuild report & plots" /><ConfirmButton size="default" label="Snapshot results" armedLabel="Click again to snapshot" onClick={async () => { try { const r = await api("/api/archive", {}); toast.success(`snapshot ${r.name} (${r.files.length} files) in output-archive/`); } catch (e: any) { toast.error(e.message); } }} /></>}
      stats={<StatList grid><Stat label="target" value={fmt(d.target_ft, 0)} unit="ft" /><Stat label="designs" value={d.n} /><Stat label="solved" value={d.n_solved} cls={d.n_solved ? "ok" : "warn"} /><Stat label="shortlisted" value={shortlist.length} cls={shortlist.length ? "ok" : null} />{Object.entries((d.counts || {}) as Record<string, number>).filter(([k]) => k !== "solved").map(([k, v]) => <Stat key={k} label={k} value={v} />)}{Object.entries((d.eligibility || {}) as Record<string, any>).map(([p, v]) => <Stat key={p} label={`${p} eligible`} value={`${v.eligible}/${v.total}`} />)}{d.characterization ? <Stat label="Mach at burnout" value={`${fmt(d.characterization.mach_burnout_min, 2)}–${fmt(d.characterization.mach_burnout_max, 2)}`} /> : null}{d.sustainer?.motors ? (d.sustainer.motors.length === 1 ? <Stat label="sustainer" value={String(d.sustainer.motors[0].label)} sub={`${fmt(d.sustainer.motors[0].total_impulse_ns, 0)} N·s`} /> : <Stat label="sustainers" value={Number(d.sustainer.motors.length)} unit="searched" sub={(d.sustainer.motors as any[]).map((x: any) => x.label).join(", ")} wide />) : null}{s.mass.table && !s.mass.table.error ? <Stat label="pad weight" value={`${fmt(s.mass.table.combined_wt_lb[0], 0)}–${fmt(s.mass.table.combined_wt_lb[1], 0)}`} unit="lb" /> : null}</StatList>} />}
    how={<p><b>Status: </b>solved = an ignition delay hits the target within tolerance · overpowered = apogee stays above the target even at the shortest allowed coast · underpowered = even the best coast falls short · unsolved = a bracket was found but did not converge. <b>Δ target</b> is apogee − target. <b>Matrix</b> shows every booster against every sustainer, <b>Trade space</b> plots apogee against the staging numbers, <b>Shortlist</b> compares the starred designs and confirms them in RASAero, and <b>Customize</b> re-flies one design live with your own delays and dry mass.</p>}>
    <Card><Tabs value={tab} onValueChange={(v) => setSearch({ tab: v })}><TabsList><TabsTrigger value="designs" extra={d.n}>Designs</TabsTrigger><TabsTrigger value="matrix">Matrix</TabsTrigger><TabsTrigger value="tradespace">Trade space</TabsTrigger><TabsTrigger value="shortlist" extra={shortlist.length || null}>Shortlist</TabsTrigger><TabsTrigger value="customize">Customize</TabsTrigger><TabsTrigger value="eligibility" extra={nElig}>Eligibility</TabsTrigger><TabsTrigger value="characterization">Characterization</TabsTrigger><TabsTrigger value="plots">Plots</TabsTrigger><TabsTrigger value="previous">Previous runs</TabsTrigger><TabsTrigger value="report">Report</TabsTrigger></TabsList></Tabs>
      {tab === "designs" ? <DesignsTab {...common} /> : tab === "matrix" ? <MatrixTab {...common} /> : tab === "tradespace" ? <TradespaceTab {...common} /> : tab === "shortlist" ? <ShortlistTab {...common} /> : tab === "customize" ? <CustomizeTab {...common} /> : tab === "eligibility" ? <EligibilityTab {...common} /> : tab === "characterization" ? <CharacterizationTab {...common} /> : tab === "plots" ? <PlotsTab {...common} /> : tab === "previous" ? <PreviousTab {...common} /> : <ReportTab />}</Card>
    <Lightbox src={lb} onClose={() => setLb(null)} />
  </StepPage>;
}
type P = { s: any; d: any; cfg: any; shortlist: string[]; setShortlist: (b: any) => Promise<void>; selectDesign: (k: string) => void; search: any; setSearch: (p: Record<string, unknown>) => void; setLb: (s: string | null) => void };

function Star({ k, shortlist, setShortlist }: { k: string; shortlist: string[]; setShortlist: (b: any) => Promise<void> }) {
  const on = shortlist.includes(k);
  return <button type="button" className={cn("text-[15px] leading-none", on ? "text-warn" : "text-faint hover:text-warn")} title={on ? "remove from the shortlist" : "add to the shortlist"} onClick={(e) => { e.stopPropagation(); setShortlist(on ? { remove: k } : { add: k }); }}>{on ? "★" : "☆"}</button>;
}

type Filters = { dev: string; mach: string; g: string; vign: string };
/* Module-level so React keeps the same input mounted across keystrokes. */
function NumIn({ label, k, ph, title, f, setF }: { label: string; k: keyof Filters; ph: string; title: string; f: Filters; setF: (f: Filters) => void }) { return <label className="inline-flex items-center gap-1 text-[12px]" title={title}>{label}<Input type="number" step="any" className="h-7 w-20" value={f[k]} placeholder={ph} onChange={(e) => setF({ ...f, [k]: e.target.value })} /></label>; }

function DesignsTab(p: P) {
  const { s, d, cfg, shortlist, setShortlist, search, setSearch } = p;
  const { rows, loading, error } = useDesigns(d);
  const [f, setF] = useState<Filters>({ dev: "", mach: "", g: "", vign: "" });
  const [q, setQ] = useState("");
  const filter = search.filter || "all";
  if (loading) return <div className="text-muted">Loading designs…</div>;
  if (error) return <Callout kind="err">{error.message}</Callout>;
  const statuses = ["all", ...new Set(rows.map((r: any) => String(r.status)))] as string[];
  let filtered = filter === "all" ? rows : rows.filter((r: any) => r.status === filter);
  if (f.dev !== "") filtered = filtered.filter((r: any) => isNum(r.dev_ft) && Math.abs(r.dev_ft) <= +f.dev);
  if (f.mach !== "") filtered = filtered.filter((r: any) => isNum(r.mach_at_sep) && r.mach_at_sep >= +f.mach);
  if (f.g !== "") filtered = filtered.filter((r: any) => isNum(r.max_accel_g) && r.max_accel_g <= +f.g);
  if (f.vign !== "") filtered = filtered.filter((r: any) => isNum(r.vel_at_ign_fps) && r.vel_at_ign_fps >= +f.vign);
  if (q) { const ql = q.toLowerCase(); filtered = filtered.filter((r: any) => `${r.booster} ${r.sustainer} ${r.profile} ${r.status}`.toLowerCase().includes(ql)); }
  filtered = filtered.slice().sort(byDev);
  const sel = search.sel && rows.some((r: any) => r.key === search.sel) ? search.sel : (rows.slice().sort(byDev)[0] || {}).key;
  const selIdx = filtered.findIndex((r: any) => r.key === sel);
  const selRow = selIdx >= 0 ? filtered[selIdx] : rows.find((r: any) => r.key === sel);
  const nav = selRow && selIdx >= 0 ? { prev: selIdx > 0 ? filtered[selIdx - 1] : null, next: selIdx < filtered.length - 1 ? filtered[selIdx + 1] : null, pos: `${selIdx + 1} / ${filtered.length}` } : null;
  return <div>
    {selRow ? <DesignDetail r={selRow} nav={nav} {...p} /> : null}
    <div className="mt-4 rounded-md border border-line p-3">
      <div className="mb-2 flex flex-wrap items-center gap-2"><span className="text-[12px] text-muted">status:</span>{statuses.map((st) => <Button key={st} size="sm" variant={filter === st ? "primary" : "default"} onClick={() => setSearch({ filter: st })}>{st === "all" ? `all (${rows.length})` : `${st} (${rows.filter((r: any) => r.status === st).length})`}</Button>)}<span className="flex-1" /><NumIn f={f} setF={setF} label="|Δ target| ≤" k="dev" ph="ft" title="keep designs within this distance of the target" /><NumIn f={f} setF={setF} label="M @sep ≥" k="mach" ph="Mach" title="minimum Mach at separation" /><NumIn f={f} setF={setF} label="v @ign ≥" k="vign" ph="fps" title="minimum velocity at ignition" /><NumIn f={f} setF={setF} label="max g ≤" k="g" ph="g" title="maximum acceleration" /><Input className="h-7 w-[180px]" placeholder="filter boosters…" value={q} onChange={(e) => setQ(e.target.value)} /></div>
      <div className="mb-1 text-[12px] text-muted">sorted by distance to target · click a row for details · ★ adds it to the shortlist</div>
      <DataTable columns={["booster", "star", "sustainer", "profile", "status", "sep_delay_s", "ign_delay_s", "apogee_ft", "dev_ft", "apogee_min_delay_ft", "apogee_max_delay_ft", "mach_at_sep", "vel_at_ign_fps", "mach_at_ign", "alt_at_ign_ft", "max_mach", "max_accel_g", "t_apogee_s", "verified_ok", "n_sims"]} rows={filtered.map((r: any) => ({ ...r, star: shortlist.includes(r.key) }))}
        labels={{ star: "★", sep_delay_s: "sep [s]", ign_delay_s: "ign [s]", apogee_ft: "apogee [ft]", dev_ft: "Δ target", apogee_min_delay_ft: "apogee @min ign", apogee_max_delay_ft: "apogee @max ign", mach_at_sep: "M @sep", vel_at_ign_fps: "v @ign [fps]", mach_at_ign: "M @ign", alt_at_ign_ft: "alt @ign", max_mach: "max M", max_accel_g: "max g", t_apogee_s: "t apogee", verified_ok: "verified", n_sims: "sims" }}
        format={{ star: (_v, r) => <Star k={r.key} shortlist={shortlist} setShortlist={setShortlist} />, status: (v) => <Badge status={STATUS_BADGE[v] || "todo"}>{v}</Badge>, verified_ok: (v) => (v == null ? "—" : <Badge status={v ? "ok" : "err"}>{v ? "ok" : "fail"}</Badge>), dev_ft: (v) => signed(v), apogee_ft: (v) => fmt(v, 0), apogee_min_delay_ft: (v) => fmt(v, 0), apogee_max_delay_ft: (v) => fmt(v, 0), mach_at_sep: (v) => fmt(v, 3), mach_at_ign: (v) => fmt(v, 3) }}
        onRow={(r) => setSearch({ sel: r.key })} rowKey={(r) => r.key} selected={sel} maxHeight={420} tools={{ chooser: "results.designs", csv: "designs-filtered.csv", hiddenDefault: ["apogee_min_delay_ft", "apogee_max_delay_ft", "mach_at_ign", "n_sims"] }} />
    </div>
  </div>;
}

function DesignDetail({ r, nav, s, d, cfg, shortlist, setShortlist, setSearch }: P & { r: any; nav: any }) {
  const key = r.key || keyOf(r);
  const [mode, setMode] = useState("mach");
  const [player, setPlayer] = useState<Player | null>(null);
  const hq = useQuery(historyQuery(r, s, d));
  const devFt = isNum(r.apogee_ft) ? r.apogee_ft - d.target_ft : null;
  const NavBtn = ({ rw, dir }: { rw: any; dir: number }) => <Button size="sm" variant="ghost" disabled={!rw} title={rw ? `${rw.booster}${rw.sustainer ? " + " + rw.sustainer : ""} · ${rw.profile}` : ""} onClick={() => rw && setSearch({ sel: rw.key })}>{dir < 0 ? "‹ prev" : "next ›"}</Button>;
  return <div className="mt-2 flex flex-col gap-3">
    <div className="rounded-md border border-line p-3">
      <div className="flex flex-wrap items-center justify-between gap-2"><div className="flex flex-wrap items-baseline gap-2"><Star k={key} shortlist={shortlist} setShortlist={setShortlist} /><h3 className="text-[16px] font-semibold">{r.booster}{r.sustainer ? " + " + r.sustainer : ""}</h3><span className="text-muted">{r.profile}</span><Badge status={STATUS_BADGE[r.status] || "todo"}>{r.status}</Badge></div>{nav ? <div className="flex items-center gap-1"><NavBtn rw={nav.prev} dir={-1} /><span className="text-[12px] text-muted">{nav.pos}</span><NavBtn rw={nav.next} dir={1} /></div> : null}</div>
      <StatList grid className="mt-2"><Stat label="apogee" value={fmt(r.apogee_ft, 0)} unit="ft" cls={Math.abs((r.apogee_ft ?? 0) - d.target_ft) <= d.tolerance_ft ? "ok" : "warn"} /><Stat label="Δ target" value={signed(devFt)} unit="ft" /><Stat label="separation" value={fmt(r.sep_delay_s, 2)} unit="s after burnout" /><Stat label="ignition" value={fmt(r.ign_delay_s, 2)} unit="s after separation" /><Stat label="Mach @ sep" value={fmt(r.mach_at_sep, 3)} /><Stat label="max Mach" value={fmt(r.max_mach, 3)} /><Stat label="max accel" value={fmt(r.max_accel_g, 1)} unit="g" /></StatList>
      {r.hint ? <Callout kind="warn" className="mt-2"><b>hint: </b>{r.hint}</Callout> : null}{r.verify_note ? <Callout kind="err" className="mt-2"><b>verification: </b>{r.verify_note}</Callout> : null}
    </div>
    {hq.isLoading ? <div className="text-muted">Loading flight configuration…</div> : hq.error ? <Callout kind="err">{(hq.error as Error).message}</Callout> : hq.data ? <>
      <FlightConfig r={r} dz={hq.data.dz} hist={hq.data.hist} histKind={hq.data.kind} cfg={cfg} d={d} onPlayerChange={setPlayer} />
      {hq.data.hist ? <div className="card tight"><div className="mb-2 flex items-center justify-between border-b border-line pb-2 text-[11px] font-semibold uppercase tracking-wide text-muted"><span>{hq.data.kind === "verified" ? "Verified time history" : "Estimated time history"}</span>{hq.data.kind === "estimated" ? <span className="font-normal normal-case tracking-normal">on-demand flight, not yet verified</span> : null}</div><HistoryChart t={hq.data.hist} mode={mode} onMode={setMode} height={360} onHover={(t) => player?.preview(t)} onLeave={() => player?.clearPreview()} /></div> : <div className="card tight"><div className="text-[11px] font-semibold uppercase tracking-wide text-muted">Time history</div><div className="text-[12px] text-muted">no time history yet — run verify, or check sep/ign delays</div></div>}
      <FlightEvents r={r} dz={hq.data.dz} hist={hq.data.hist} />
    </> : null}
  </div>;
}

/* One tile per staging event: when it happens and the state of the vehicle
   there. Times come from the flown history when there is one, else from the
   nominal staging; the design row fills in what the history cannot. */
function FlightEvents({ r, dz, hist }: { r: any; dz: any; hist: HistoryFrame | null }) {
  const T = stagingTimes(r, dz);
  const sm = hist?.summary || {}, c = hist?.columns;
  const pick = (a: number | null | undefined, b: number | null) => (isNum(a) ? a : isNum(b) ? b : null);
  const evs = [
    { id: "liftoff", label: "liftoff", t: 0, color: EVENT_COLORS.liftoff, fb: { alt: 0, vel: 0, mach: 0 } },
    { id: "burnout", label: "booster burnout", t: pick(sm.t_burnout_s, T[1]), color: EVENT_COLORS.burnout, fb: {} },
    { id: "separation", label: "separation", t: pick(sm.t_sep_s, T[2]), color: EVENT_COLORS.separation, fb: { mach: r.mach_at_sep } },
    { id: "ignition", label: "ignition", t: pick(sm.t_ign_s, T[3]), color: EVENT_COLORS.ignition, fb: { alt: r.alt_at_ign_ft, vel: r.vel_at_ign_fps, mach: r.mach_at_ign } },
    { id: "sustainer_burnout", label: "sustainer burnout", t: pick(hist ? sustainerBurnout(hist) : null, T[4]), color: EVENT_COLORS.sustainer_burnout, fb: {} },
    { id: "apogee", label: "apogee", t: pick(sm.t_apogee_s, T[5]), color: EVENT_COLORS.apogee, fb: { alt: r.apogee_ft } },
  ] as { id: string; label: string; t: number | null; color: string; fb: Record<string, number | null | undefined> }[];
  const at = (col: string, t: number | null, fb: number | null | undefined) => (isNum(t) && c && c[col] ? interpAt(c.time_s, c[col], t) : isNum(fb) ? fb : null);
  const row = (k: string, v: string) => <div className="flex justify-between gap-2"><span className="text-muted">{k}</span><span className="font-mono">{v}</span></div>;
  return <div className="card tight">
    <div className="mb-2 flex items-center justify-between border-b border-line pb-2 text-[11px] font-semibold uppercase tracking-wide text-muted"><span>Flight events</span><span className="font-normal normal-case tracking-normal">{hist ? "from the flown time history" : "nominal staging; no time history yet"}</span></div>
    <div className="grid gap-2 grid-cols-[repeat(auto-fill,minmax(170px,1fr))]">{evs.map((e, i) => {
      const prev = evs[i - 1];
      const dt = isNum(e.t) && prev && isNum(prev.t) ? e.t - prev.t : null;
      const alt = at("altitude_ft", e.t, e.fb.alt), vel = at("velocity_fps", e.t, e.fb.vel), mach = at("mach", e.t, e.fb.mach);
      return <div key={e.id} className={cn("rounded-md border border-line bg-panel-2 px-3 py-2 text-[12px]", !isNum(e.t) && "opacity-50")} style={{ borderLeft: `3px solid ${e.color}` }}>
        <div className="mb-1 flex items-baseline justify-between gap-2"><span className="font-semibold text-fg">{e.label}</span><span className="font-mono text-[13px] text-fg">{isNum(e.t) ? `${fmt(e.t, e.t < 100 ? 2 : 1)} s` : "—"}</span></div>
        {row("after previous", isNum(dt) ? `+${fmt(dt, 2)} s` : "—")}{row("altitude", isNum(alt) ? `${fmt(alt, 0)} ft` : "—")}{row("velocity", isNum(vel) ? `${fmt(vel, 0)} fps` : "—")}{row("Mach", isNum(mach) ? fmt(mach, 2) : "—")}
      </div>; })}</div>
  </div>;
}

function MatrixTab({ d, shortlist, selectDesign, search }: P) {
  const { rows, loading } = useDesigns(d);
  if (loading) return <div className="text-muted">Loading…</div>;
  const sus = [...new Set(rows.map((r: any) => String(r.sustainer ?? "")))] as string[], profs = [...new Set(rows.map((r: any) => String(r.profile)))] as string[];
  const cols = sus.flatMap((su) => profs.map((p) => ({ su, p }))).filter((c) => rows.some((r: any) => (r.sustainer ?? "") === c.su && r.profile === c.p));
  const byB = new Map<string, any[]>(); for (const r of rows) { if (!byB.has(r.booster)) byB.set(r.booster, []); byB.get(r.booster)!.push(r); }
  const bestDev = (b: string) => Math.min(...byB.get(b)!.map((r) => Math.abs(r.dev_ft ?? 1e9)));
  const boosters = [...byB.keys()].sort((a, b) => bestDev(a) - bestDev(b));
  return <div><p className="mb-2 text-[12px] text-muted">Apogee [ft] of every (booster, sustainer, profile) design, boosters ordered by their closest design, Δ target under each value. Click a cell to open the design.</p>
    <div className="mb-2 flex flex-wrap gap-2 text-[12px]">{[["solved", "ok"], ["overpowered", "warn"], ["underpowered", "warn"], ["unsolved", "err"]].map(([k, c]) => <Badge key={k} status={c}>{k}</Badge>)}<span>★ shortlisted</span></div>
    <div className="max-h-[640px] overflow-auto rounded border border-line"><table className="matrix w-full border-collapse text-[12px]"><thead className="sticky top-0 bg-panel-2"><tr><th className="px-2 py-1 text-left">booster</th><th className="px-2 py-1 text-right">best |Δ|</th>{cols.map((c, i) => <th key={i} className="px-2 py-1 text-right">{c.su || "—"}<br /><span className="text-muted">{c.p}</span></th>)}</tr></thead>
      <tbody>{boosters.map((b) => { const rs = byB.get(b)!; return <tr key={b} className="border-t border-line"><td className="px-2 py-1 font-medium">{b}</td><td className="px-2 py-1 text-right font-mono">{fmt(bestDev(b), 0)}</td>{cols.map((c, i) => { const r = rs.find((x) => (x.sustainer ?? "") === c.su && x.profile === c.p); return !r ? <td key={i} className="px-2 py-1 text-right text-muted">—</td> : <td key={i} className={cn("cell px-2 py-1 font-mono", r.status, r.key === search.sel && "sel")} title={`${r.booster} + ${r.sustainer} · ${r.profile} · ${r.status}\nsep ${r.sep_delay_s} s, ign ${r.ign_delay_s} s · Δ ${signed(r.dev_ft)} ft · M@sep ${fmt(r.mach_at_sep, 2)} · click to open`} onClick={() => selectDesign(r.key)}>{shortlist.includes(r.key) ? "★ " : ""}{fmt(r.apogee_ft, 0)}<span className="d">{signed(r.dev_ft)}</span></td>; })}</tr>; })}</tbody></table></div></div>;
}

function TradespaceTab({ d, cfg, selectDesign, search, setSearch }: P) {
  const { rows, loading } = useDesigns(d);
  if (loading) return <div className="text-muted">Loading…</div>;
  const metrics: Record<string, string> = { mach_at_sep: "Mach at separation", vel_at_ign_fps: "velocity at ignition [fps]", alt_at_ign_ft: "altitude at ignition [ft]", coast_s: "coast: separation + ignition delay [s]", max_accel_g: "max acceleration [g]", t_apogee_s: "time to apogee [s]", max_mach: "max Mach" };
  const xm = metrics[search.x] ? search.x : "mach_at_sep";
  const pts = rows.filter((r: any) => isNum(r[xm]) && isNum(r.apogee_ft)).map((r: any) => ({ x: r[xm], y: r.apogee_ft, key: r.key, row: r }));
  const p = cfg.profiles;
  const xrefs = xm === "mach_at_sep" ? [{ x: p.supersonic_min_mach, label: `M ${p.supersonic_min_mach}`, color: "#dc2626" }, { x: p.subsonic_max_mach, label: `M ${p.subsonic_max_mach}`, color: "#16a34a" }] : [];
  return <div><div className="mb-1 flex flex-wrap items-center justify-between gap-2"><label className="inline-flex items-center gap-2 text-[12px]">x axis <Select className="h-7" value={xm} onChange={(e) => setSearch({ x: e.target.value })}>{Object.entries(metrics).map(([v, l]) => <option key={v} value={v}>{l}</option>)}</Select></label><div className="flex flex-wrap gap-3 text-[12px]">{Object.entries(STATUS_COLOR).filter(([k]) => rows.some((r: any) => r.status === k)).map(([k, c]) => <span key={k} className="inline-flex items-center gap-1"><span className="inline-block h-2.5 w-2.5 rounded-full" style={{ background: c }} />{k}</span>)}<span>● supersonic</span><span>■ subsonic</span><span>◆ other</span></div></div>
    <ScatterChart points={pts} xLabel={metrics[xm]} yLabel="apogee [ft]" height={380} band={{ y0: d.target_ft - d.tolerance_ft, y1: d.target_ft + d.tolerance_ft, label: `target ${fmt(d.target_ft, 0)} ± ${fmt(d.tolerance_ft, 0)} ft` }} xrefs={xrefs} color={(q) => STATUS_COLOR[q.row.status] || "#64748b"} shape={(q) => (q.row.profile === "subsonic" ? "square" : q.row.profile === "supersonic" ? "circle" : "diamond")} selectedKey={search.sel} onClick={(q) => selectDesign(q.key)} tip={(q) => [["design", `${q.row.booster} + ${q.row.sustainer}`], ["profile", `${q.row.profile} · ${q.row.status}`], [metrics[xm], fmt(q.x)], ["apogee", fmtFt(q.y)], ["Δ target", signed(q.row.dev_ft) + " ft"], ["delays", `sep ${q.row.sep_delay_s} s · ign ${q.row.ign_delay_s} s`]]} />
    <p className="mt-1 text-[12px] text-muted">{pts.length} designs · the green band is the target tolerance · click a point to open the design</p></div>;
}

function ShortlistTab(p: P) {
  const { s, d, shortlist, setShortlist, selectDesign, search, setSearch } = p;
  const { rows, loading } = useDesigns(d);
  const items = shortlist.map((k) => rows.find((r: any) => r.key === k)).filter(Boolean);
  const hqs = useQueries({ queries: items.map((r: any) => historyQuery(r, s, d)) }) as any[];
  if (loading) return <div className="text-muted">Loading designs…</div>;
  const gone = shortlist.filter((k) => !rows.some((r: any) => r.key === k));
  if (!items.length) return <Callout kind="info"><b>Nothing shortlisted yet. </b>Star designs (☆) in the Designs table or in a design's detail; they line up here side by side with their flights overlaid, and can be sent to RASAero together.{gone.length ? ` ${gone.length} starred key(s) are no longer in designs.csv.` : ""}</Callout>;
  const metrics: [string, (r: any) => ReactNode][] = [["status", (r) => <Badge status={STATUS_BADGE[r.status] || "todo"}>{r.status}</Badge>], ["apogee [ft]", (r) => fmt(r.apogee_ft, 0)], ["Δ target [ft]", (r) => signed(r.dev_ft)], ["separation delay [s]", (r) => fmt(r.sep_delay_s, 2)], ["ignition delay [s]", (r) => fmt(r.ign_delay_s, 2)], ["Mach at separation", (r) => fmt(r.mach_at_sep, 3)], ["velocity at ignition [fps]", (r) => fmt(r.vel_at_ign_fps, 0)], ["altitude at ignition [ft]", (r) => fmt(r.alt_at_ign_ft, 0)], ["max Mach", (r) => fmt(r.max_mach, 3)], ["max acceleration [g]", (r) => fmt(r.max_accel_g, 1)], ["time to apogee [s]", (r) => fmt(r.t_apogee_s, 1)], ["verified", (r) => (r.verified_ok == null ? "—" : <Badge status={r.verified_ok ? "ok" : "err"}>{r.verified_ok ? "ok" : "fail"}</Badge>)]];
  const withH = items.map((r: any, i: number) => ({ name: `${r.booster} + ${r.sustainer}`, hist: hqs[i].data?.hist, color: PALETTE[i % PALETTE.length], dash: hqs[i].data?.kind === "estimated" })).filter((x: any) => x.hist) as any[];
  const ov = search.ov || "mach";
  return <div className="flex flex-col gap-3">
    <div className="flex flex-wrap items-center justify-between gap-2"><span className="text-[12px] text-muted">{items.length} shortlisted design{items.length === 1 ? "" : "s"}{gone.length ? ` · ${gone.length} starred key(s) no longer in designs.csv` : ""} · kept in output/shortlist.json</span><div className="flex gap-2"><RunButton stage="confirm" args={["--designs", items.map((r: any) => r.key).join(",")]} label={`Confirm these ${items.length} in RASAero`} primary /><Button onClick={async () => { try { const n = await downloadFile("/download/bundle?which=shortlist"); toast.success(`downloaded ${n}`); } catch (e: any) { toast.error(e.message); } }}>⬇ RASAero bundle</Button><ConfirmButton label="Clear shortlist" armedLabel="Click again to clear" onClick={() => setShortlist({ keys: [] })} /></div></div>
    <div className="overflow-auto rounded border border-line"><table className="w-full text-[12.5px]"><thead className="bg-panel-2"><tr><th className="px-2 py-1" />{items.map((r: any, i: number) => <th key={r.key} className="px-2 py-1 text-right"><span className="mr-1 inline-block h-2.5 w-2.5 rounded-full" style={{ background: PALETTE[i % PALETTE.length] }} /><button type="button" className="text-accent" onClick={() => selectDesign(r.key)}>{r.booster}</button><br /><span className="text-muted">{r.sustainer} · {r.profile}</span> <Button size="sm" variant="ghost" title="remove from the shortlist" onClick={() => setShortlist({ remove: r.key })}>×</Button></th>)}</tr></thead><tbody>{metrics.map(([label, f]) => <tr key={label} className="border-t border-line"><td className="px-2 py-1 text-muted">{label}</td>{items.map((r: any) => <td key={r.key} className="px-2 py-1 text-right font-mono">{f(r)}</td>)}</tr>)}</tbody></table></div>
    <div className="card tight"><div className="mb-1 flex items-center gap-2 text-[11px] font-semibold uppercase tracking-wide text-muted">Flights overlaid <Select className="h-7 normal-case tracking-normal" value={ov} onChange={(e) => setSearch({ ov: e.target.value })}><option value="mach">Mach</option><option value="altitude">altitude</option><option value="velocity">velocity</option></Select>{withH.some((x) => x.dash) ? <span className="font-normal normal-case tracking-normal">dashed = on-demand estimate, not verified</span> : null}</div>{withH.length ? <HistoryOverlay items={withH} mode={ov} /> : <div className="text-[12px] text-muted">{hqs.some((q) => q.isLoading) ? "Loading flights…" : "no flight histories yet"}</div>}</div>
  </div>;
}

function useDebounced(v: string, ms = 250) { const [d, setD] = useState(v); useEffect(() => { const t = setTimeout(() => setD(v), ms); return () => clearTimeout(t); }, [v, ms]); return d; }

function ParamSlider({ label, hint, value, min, max, step, onChange, disabled, base }: { label: string; hint: ReactNode; value: number | null; min: number; max: number; step: number; onChange: (v: number) => void; disabled?: boolean; base?: ReactNode }) {
  const [text, setText] = useState(value == null ? "" : String(value));
  useEffect(() => { if (value == null ? text !== "" : Number(text) !== value) setText(value == null ? "" : String(value)); }, [value]); // eslint-disable-line react-hooks/exhaustive-deps
  const set = (v: string) => { setText(v); const n = Number(v); if (v !== "" && Number.isFinite(n) && n >= min) onChange(n); };
  return <div className={cn("rounded-md border border-line bg-panel-2 px-3 py-2", disabled && "opacity-60")}>
    <div className="flex items-center justify-between gap-2"><span className="text-[12px] font-medium">{label}</span><Input type="number" step={step} min={min} className="h-7 w-24 text-right font-mono" value={text} disabled={disabled} onChange={(e) => set(e.target.value)} /></div>
    <input type="range" className="accent-accent mt-1 w-full" min={min} max={Math.max(max, value ?? min)} step={step} value={value ?? min} disabled={disabled || value == null} onChange={(e) => set(e.target.value)} />
    <div className="flex justify-between gap-2 text-[11px] text-muted"><span>{hint}</span>{base ? <span className="whitespace-nowrap">{base}</span> : null}</div>
  </div>;
}

/* One design re-flown on the native engine with the user's delays and dry
   mass; the optimizer's own flight stays beside it for comparison. */
function CustomizeTab(p: P) {
  const { s, d, cfg, search, setSearch, selectDesign } = p;
  const { refresh } = useApp();
  const { rows, loading, error } = useDesigns(d);
  const sorted = useMemo(() => rows.slice().sort(byDev), [rows]);
  const r = (search.sel && rows.find((x: any) => x.key === search.sel)) || sorted[0];
  const mt = s.mass.table && !s.mass.table.error ? s.mass.table : null;
  const manual = cfg.mass_model?.method === "manual";
  const baseMass: number | null = manual || !mt ? null : isNum(mt.hardware_mass_lb) ? mt.hardware_mass_lb : isNum(mt.sustainer_dry_lb) && isNum(mt.booster_dry_lb) ? Math.round((mt.sustainer_dry_lb + mt.booster_dry_lb) * 10) / 10 : null;
  const init = (row: any) => ({ key: row?.key as string | undefined, sep: isNum(row?.sep_delay_s) ? row.sep_delay_s : 0.5, ign: isNum(row?.ign_delay_s) ? row.ign_delay_s : 2, mass: baseMass });
  const [q, setQ] = useState(() => init(r));
  useEffect(() => { if (r && q.key !== r.key) setQ(init(r)); }, [r?.key]); // eslint-disable-line react-hooks/exhaustive-deps
  const [mode, setMode] = useState("mach");
  const [ov, setOv] = useState("altitude");
  const [sep, ign, mass] = JSON.parse(useDebounced(JSON.stringify([q.sep, q.ign, q.mass]))) as [number, number, number | null];
  const massParam = mass != null && mass !== baseMass ? mass : null;
  const ver = `${d.mtime}|${s.inputs.inputs_mtime}|${mt ? mt.mtime : ""}`;
  const fq = useQuery({
    queryKey: ["custom-flight", r?.key, sep, ign, massParam, ver],
    queryFn: () => api(`/api/flight?booster=${encodeURIComponent(r.booster)}&sustainer=${encodeURIComponent(r.sustainer)}&profile=${encodeURIComponent(r.profile || "")}&sep=${sep}&ign=${ign}${massParam != null ? "&mass=" + massParam : ""}`) as Promise<HistoryFrame & { mass: any }>,
    enabled: !!r && !!r.sustainer && !!mt, staleTime: Infinity, placeholderData: keepPreviousData, // no mass table: nothing to fly
  });
  const bq = useQuery({ ...historyQuery(r || {}, s, d), enabled: !!r });
  if (loading) return <div className="text-muted">Loading designs…</div>;
  if (error) return <Callout kind="err">{error.message}</Callout>;
  if (!r) return <Callout kind="info">no designs to customize</Callout>;
  const pr = cfg.profiles, sm = fq.data?.summary || {}, m = fq.data?.mass;
  const dev = isNum(sm.apogee_ft) ? sm.apogee_ft - d.target_ft : null;
  const viol = r.profile === "subsonic" && isNum(sm.stack_max_mach) && sm.stack_max_mach > pr.subsonic_max_mach ? `the stack reaches Mach ${fmt(sm.stack_max_mach, 3)} before separation (> ${pr.subsonic_max_mach})`
    : r.profile === "supersonic" && isNum(sm.mach_at_sep) && sm.mach_at_sep < pr.supersonic_min_mach ? `Mach at separation ${fmt(sm.mach_at_sep, 3)} < ${pr.supersonic_min_mach}`
    : r.profile === "decel_subsonic" && isNum(sm.mach_at_sep) && sm.mach_at_sep > pr.subsonic_max_mach ? `Mach at separation ${fmt(sm.mach_at_sep, 3)} > ${pr.subsonic_max_mach}` : null;
  const changed = q.sep !== r.sep_delay_s || q.ign !== r.ign_delay_s || (q.mass != null && q.mass !== baseMass);
  const cr = { ...r, sep_delay_s: sep, ign_delay_s: ign, t_apogee_s: sm.t_apogee_s, apogee_ft: sm.apogee_ft, mach_at_sep: sm.mach_at_sep, alt_at_ign_ft: sm.alt_at_ign_ft, vel_at_ign_fps: sm.vel_at_ign_fps, mach_at_ign: sm.mach_at_ign };
  const saveMass = async () => { try { await api("/api/config", { set: { "mass_model.hardware_mass_lb": q.mass } }); toast.success(`hardware mass ${q.mass} lb saved to config.yaml — re-run mass and optimize to update the results`); await refresh(); } catch (e: any) { toast.error(e.message); } };
  return <div className="flex flex-col gap-3">
    <div className="flex flex-wrap items-center gap-2"><label className="inline-flex items-center gap-2 text-[12px]">design <Select className="h-7 max-w-[520px]" value={r.key} onChange={(e) => setSearch({ sel: e.target.value })}>{sorted.map((x: any) => <option key={x.key} value={x.key}>{x.booster} + {x.sustainer} · {x.profile} · {x.status} · Δ {signed(x.dev_ft)} ft</option>)}</Select></label><Badge status={STATUS_BADGE[r.status] || "todo"}>{r.status}</Badge><Button size="sm" variant="ghost" onClick={() => selectDesign(r.key)}>open in Designs →</Button><span className="flex-1" /><span className="text-[12px] text-muted">{fq.isFetching ? "simulating…" : fq.data ? "flown on the native engine · estimate, not verified" : ""}</span></div>
    <div className="grid gap-2 md:grid-cols-3">
      <ParamSlider label="separation delay [s]" hint="after booster burnout" value={q.sep} min={0} max={Math.max(5, pr.separation_delay_max_s)} step={0.05} base={isNum(r.sep_delay_s) ? `optimizer: ${fmt(r.sep_delay_s, 2)}` : null} onChange={(v) => setQ({ ...q, sep: v })} />
      <ParamSlider label="ignition delay [s]" hint="after separation" value={q.ign} min={0} max={Math.max(30, pr.ignition_delay_max_s)} step={0.1} base={isNum(r.ign_delay_s) ? `optimizer: ${fmt(r.ign_delay_s, 2)}` : null} onChange={(v) => setQ({ ...q, ign: v })} />
      <ParamSlider label="hardware (dry) mass [lb]" hint={manual ? "manual mass model: set the masses in config" : baseMass == null ? "no mass table yet" : "both stages scale with it"} value={q.mass} min={1} max={baseMass ? Math.round(baseMass * 1.5) : 100} step={1} base={baseMass != null ? `mass table: ${fmt(baseMass, 1)}${isNum(mt?.hardware_mass_lb) ? "" : " (.ork)"}` : null} onChange={(v) => setQ({ ...q, mass: v })} disabled={manual || baseMass == null} />
    </div>
    <div className="flex flex-wrap items-center gap-2"><Button size="sm" disabled={!changed} onClick={() => setQ(init(r))}>Reset to the optimizer's values</Button>{!manual && q.mass != null && q.mass !== baseMass ? <Button size="sm" title="sets mass_model.hardware_mass_lb; the mass and optimize stages then need a re-run" onClick={saveMass}>Save {q.mass} lb to config.yaml</Button> : null}<span className="text-[12px] text-muted">optimizer: sep {fmt(r.sep_delay_s, 2)} s · ign {fmt(r.ign_delay_s, 2)} s · apogee {fmt(r.apogee_ft, 0)} ft{baseMass != null ? ` · dry mass ${fmt(baseMass, 1)} lb` : ""}</span></div>
    {!mt ? <Callout kind="info">no mass table yet: run the mass stage (Inputs → Mass) to fly custom delays</Callout> : null}
    {fq.error ? <Callout kind="err">{(fq.error as Error).message}</Callout> : null}
    {fq.data ? <>
      <StatList grid className={cn(fq.isFetching && "opacity-60")}><Stat label="apogee" value={fmt(sm.apogee_ft, 0)} unit="ft" cls={isNum(dev) && Math.abs(dev) <= d.tolerance_ft ? "ok" : "warn"} /><Stat label="Δ target" value={signed(dev)} unit="ft" /><Stat label="Δ vs optimizer" value={isNum(sm.apogee_ft) && isNum(r.apogee_ft) ? signed(Math.round(sm.apogee_ft - r.apogee_ft) || 0) : "—"} unit="ft" /><Stat label="Mach @ sep" value={fmt(sm.mach_at_sep, 3)} cls={viol ? "err" : "ok"} /><Stat label="v @ ign" value={fmt(sm.vel_at_ign_fps, 0)} unit="fps" /><Stat label="alt @ ign" value={fmt(sm.alt_at_ign_ft, 0)} unit="ft" /><Stat label="max Mach" value={fmt(sm.max_mach, 3)} /><Stat label="max accel" value={fmt(sm.max_accel_g, 1)} unit="g" /><Stat label="t apogee" value={fmt(sm.t_apogee_s, 1)} unit="s" />{m ? <Stat label="pad weight" value={fmt(m.combined_wt_lb, 1)} unit="lb" sub={`sustainer ${fmt(m.sustainer_wt_lb, 1)} lb loaded`} /> : null}{m && isNum(m.sustainer_dry_lb) && isNum(m.booster_dry_lb) ? <Stat label="dry mass" value={fmt(m.sustainer_dry_lb + m.booster_dry_lb, 1)} unit="lb" sub={`sustainer ${fmt(m.sustainer_dry_lb, 1)} + booster ${fmt(m.booster_dry_lb, 1)}`} /> : null}</StatList>
      {viol ? <Callout kind="warn"><b>{r.profile} profile violated: </b>{viol}</Callout> : null}
      <div className="card tight"><div className="mb-2 flex items-center justify-between border-b border-line pb-2 text-[11px] font-semibold uppercase tracking-wide text-muted"><span>Custom flight</span><span className="font-normal normal-case tracking-normal">sep {fmt(sep, 2)} s · ign {fmt(ign, 2)} s{m ? ` · dry ${fmt((m.sustainer_dry_lb ?? 0) + (m.booster_dry_lb ?? 0), 1)} lb` : ""}</span></div><HistoryChart t={fq.data} mode={mode} onMode={setMode} height={340} /></div>
      {bq.data?.hist ? <div className="card tight"><div className="mb-1 flex items-center gap-2 text-[11px] font-semibold uppercase tracking-wide text-muted">Custom vs optimizer <Select className="h-7 normal-case tracking-normal" value={ov} onChange={(e) => setOv(e.target.value)}><option value="altitude">altitude</option><option value="mach">Mach</option><option value="velocity">velocity</option></Select><span className="font-normal normal-case tracking-normal">dashed = the optimizer's flight{bq.data.kind === "estimated" ? " (estimate)" : ""}</span></div><HistoryOverlay items={[{ name: "optimizer", hist: bq.data.hist, color: PALETTE[1], dash: true }, { name: "custom", hist: fq.data, color: PALETTE[0] }]} mode={ov} /></div> : null}
      {bq.data?.dz ? <FlightEvents r={cr} dz={bq.data.dz} hist={fq.data} /> : null}
    </> : fq.isLoading ? <div className="text-muted">Flying…</div> : null}
  </div>;
}

function characterizeVersion(s: any) { const st = (s.optimize.substages || []).find((x: any) => x.name === "characterize"); return st ? st.mtime : undefined; }
function EligibilityTab({ s, cfg, search, setSearch }: P) {
  const t = useCached<any>("t:eligibility", "/api/table/eligibility", characterizeVersion(s));
  if (!t.data) return <div className="text-muted">Loading…</div>;
  const eligOnly = search.all !== "1";
  const nElig = t.data.rows.filter((r: any) => r.eligible).length;
  return <div><p className="mb-2 text-[12px] text-muted">subsonic: the attached stack must stay below Mach {cfg.profiles.subsonic_max_mach} − {cfg.profiles.mach_margin} throughout boost. supersonic: separation must happen at or above Mach {cfg.profiles.supersonic_min_mach} + {cfg.profiles.mach_margin}; the physics limit is how long after burnout that is still true, and the searched separation window (sep min–max) is your window clipped to it.</p>
    <DataTable columns={t.data.columns} rows={eligOnly ? t.data.rows.filter((r: any) => r.eligible) : t.data.rows} labels={{ sep_min_s: "sep min [s]", sep_max_s: "sep max [s]", sep_window_max_s: "physics limit [s]" }} format={{ eligible: (v) => <Badge status={v ? "ok" : "todo"}>{v ? "eligible" : "no"}</Badge> }} wrap={["reason"]} rowClass={(r) => (r.eligible ? "" : "opacity-60")} maxHeight={560} tools={{ chooser: "results.eligibility", csv: "eligibility.csv", extra: <Checkbox label={`eligible only (${nElig} of ${t.data.rows.length})`} checked={eligOnly} onChange={(e) => setSearch({ all: e.target.checked ? undefined : "1" })} /> }} /></div>;
}
const CHAR_METRICS: Record<string, string> = { mach_burnout: "Mach at burnout", max_mach_boost: "peak boost Mach", t_burnout_s: "burnout time [s]", alt_burnout_ft: "altitude at burnout [ft]", vel_burnout_fps: "velocity at burnout [fps]", t_below_supersonic_s: "seconds above Mach 1.2 after burnout" };
function CharChart({ rows, cfg, metric, height = 240 }: { rows: any[]; cfg: any; metric: string; height?: number }) {
  const bySus = new Map<string, any[]>(); for (const r of rows) { const k = r.sustainer || "—"; if (!bySus.has(k)) bySus.set(k, []); bySus.get(k)!.push(r); }
  const series = [...bySus.entries()].map(([sus, rs]) => ({ name: sus, x: rs.map((_, i) => i + 1), y: rs.map((r) => r[metric]), points: true, width: 1.2 }));
  const machRefs = [{ y: cfg.profiles.supersonic_min_mach + cfg.profiles.mach_margin, label: "supersonic limit + margin", color: "#dc2626" }, { y: cfg.profiles.subsonic_max_mach - cfg.profiles.mach_margin, label: "subsonic limit − margin", color: "#16a34a" }];
  return <LineChart series={series} xLabel="booster #" yLabel={CHAR_METRICS[metric] || metric} height={height} refs={metric === "mach_burnout" || metric === "max_mach_boost" ? machRefs : []} />;
}
function CharacterizationTab({ s, cfg, search, setSearch }: P) {
  const t = useCached<any>("t:characterization", "/api/table/characterization", characterizeVersion(s));
  if (!t.data) return <div className="text-muted">Loading…</div>;
  const metric = CHAR_METRICS[search.metric] ? search.metric : "mach_burnout";
  const sus = [...new Set(t.data.rows.map((r: any) => r.sustainer || "—"))] as string[];
  const susFilter = search.sus && sus.includes(search.sus) ? search.sus : "";
  return <div><p className="mb-2 text-[12px] text-muted">One long-coast flight per (booster, sustainer) pair, stack attached. One line per sustainer, boosters in motor-file order. t_below_* = seconds after burnout until the stack drops below Mach 1.2 / 0.9.</p>
    <div className="mb-2 flex flex-wrap items-center gap-2 text-[12px]">metric: <Select className="h-7" value={metric} onChange={(e) => setSearch({ metric: e.target.value })}>{Object.entries(CHAR_METRICS).map(([v, l]) => <option key={v} value={v}>{l}</option>)}</Select> table: <Select className="h-7" value={susFilter} onChange={(e) => setSearch({ sus: e.target.value || undefined })}><option value="">all sustainers ({t.data.rows.length})</option>{sus.map((k) => <option key={k} value={k}>{k}</option>)}</Select></div>
    <CharChart rows={t.data.rows} cfg={cfg} metric={metric} />
    <DataTable columns={t.data.columns} rows={susFilter ? t.data.rows.filter((r: any) => (r.sustainer || "—") === susFilter) : t.data.rows} hide={["note"]} format={{ events_consistent: (v) => <Badge status={v ? "ok" : "err"}>{v ? "ok" : "mismatch"}</Badge> }} maxHeight={480} tools={{ chooser: "results.characterization", csv: "characterization.csv" }} /></div>;
}
function PlotsTab({ s, d, cfg, shortlist, setLb }: P) {
  const { rows, loading } = useDesigns(d);
  const chosen = shortlist.map((k) => rows.find((r: any) => r.key === k)).filter(Boolean);
  const set = chosen.length ? chosen : rows.slice().sort(byDev).slice(0, 8);
  const colorOf = (r: any) => PALETTE[set.indexOf(r) % PALETTE.length];
  const samples = useCached<any>("samples:" + set.map((r: any) => r.key).join(","), set.length ? "/api/samples?keys=" + encodeURIComponent(set.map((r: any) => r.key).join(",")) : null, d.mtime);
  const hqs = useQueries({ queries: set.map((r: any) => historyQuery(r, s, d)) }) as any[];
  const ct = useCached<any>("t:characterization", "/api/table/characterization", characterizeVersion(s));
  if (loading || !samples.data) return <div className="text-muted">Loading flights…</div>;
  const profiles = [...new Set(set.map((r: any) => r.profile))];
  const withH = set.map((r: any, i: number) => ({ name: `${r.booster} + ${r.sustainer} · ${r.profile}`, hist: hqs[i].data?.hist, color: colorOf(r), dash: hqs[i].data?.kind === "estimated" })).filter((x: any) => x.hist) as any[];
  return <div className="flex flex-col gap-3">
    <p className="text-[12px] text-muted">{chosen.length ? `The ${chosen.length} shortlisted design(s).` : "The 8 designs closest to the target — star designs to choose which appear here."}</p>
    <div className="grid gap-3 lg:grid-cols-2">{profiles.map((p) => <div key={String(p)} className="card tight"><div className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-muted">Apogee vs ignition delay · {String(p)}</div><LineChart series={set.filter((r: any) => r.profile === p).map((r: any) => { const pts = (samples.data[r.key] || []).filter((q: any) => isNum(q[1]) && (q.length < 3 || Math.abs(q[2] - r.sep_delay_s) < 1e-6)).sort((a: any, b: any) => a[0] - b[0]); return { name: `${r.booster} + ${r.sustainer}`, x: pts.map((q: any) => q[0]), y: pts.map((q: any) => q[1]), points: true, color: colorOf(r) }; })} xLabel="ignition delay after separation [s] (at each design's separation delay)" yLabel="apogee [ft]" height={260} refs={[{ y: d.target_ft, label: "target", color: "#dc2626" }]} /></div>)}</div>
    <div className="card tight"><div className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-muted">Mach vs time</div>{withH.length ? <HistoryOverlay items={withH} mode="mach" /> : <div className="text-[12px] text-muted">{hqs.some((q) => q.isLoading) ? "Loading flights…" : "no flight histories"}</div>}{withH.some((x) => x.dash) ? <div className="text-[12px] text-muted">dashed = on-demand estimate, not verified</div> : null}</div>
    {ct.data && ct.data.rows.length ? <div className="card tight"><div className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-muted">Boost characterization · Mach at burnout</div><CharChart rows={ct.data.rows} cfg={cfg} metric="mach_burnout" height={220} /></div> : null}
    {s.plots.length ? <div className="text-[12px] text-muted">Report figures (PNG, from the report stage): {s.plots.map((p: any, i: number) => <span key={p.path}>{i ? " · " : ""}<button type="button" className="text-accent" onClick={() => setLb(fileUrl(p.path, p.mtime))}>{p.name}</button></span>)}</div> : null}
  </div>;
}
function PreviousTab({ d, selectDesign, search, setSearch }: P) {
  const { rows, loading } = useDesigns(d);
  const ar = useCached<any>("archives", "/api/archives");
  const name = ar.data?.archives?.some((a: any) => a.name === search.archive) ? search.archive : ar.data?.archives?.[0]?.name;
  const arc = useCached<any>("archive:" + name, name ? "/api/archive?name=" + encodeURIComponent(name) : null, undefined, 600000);
  if (loading || !ar.data) return <div className="text-muted">Loading snapshots…</div>;
  const archives = ar.data.archives || [];
  if (!archives.length) return <Callout kind="info"><b>No result snapshots yet. </b>One is taken automatically before every fresh run; "Snapshot results" above takes one now.</Callout>;
  if (!arc.data) return <div className="text-muted">Loading…</div>;
  const old = new Map<string, any>(arc.data.rows.map((r: any) => [keyOf(r), r])), cur = new Map<string, any>(rows.map((r: any) => [r.key, r]));
  const keys = [...new Set([...old.keys(), ...cur.keys()])];
  const diff = keys.map((k) => { const a = old.get(k), b = cur.get(k), any = b || a; const moved = a && b && isNum(a.apogee_ft) && isNum(b.apogee_ft) && Math.abs(b.apogee_ft - a.apogee_ft) > 1; return { key: k, booster: any.booster, sustainer: any.sustainer, profile: any.profile, status_before: a ? a.status : null, status_after: b ? b.status : null, apogee_before: a ? a.apogee_ft : null, apogee_after: b ? b.apogee_ft : null, delta_ft: a && b && isNum(a.apogee_ft) && isNum(b.apogee_ft) ? b.apogee_ft - a.apogee_ft : null, change: !a ? "new" : !b ? "removed" : a.status !== b.status ? "status" : moved ? "apogee" : "same" }; });
  const changed = diff.filter((r) => r.change !== "same");
  const counts = (list: any[]) => { const m: Record<string, number> = {}; for (const r of list) m[r.status] = (m[r.status] || 0) + 1; return Object.entries(m).map(([k, v]) => `${v} ${k}`).join(" · ") || "—"; };
  const showSame = search.same === "1";
  return <div className="flex flex-col gap-3">
    <div className="flex flex-wrap items-center justify-between gap-2"><label className="inline-flex items-center gap-2 text-[12px]">compare with <Select className="h-7" value={name} onChange={(e) => setSearch({ archive: e.target.value })}>{archives.map((a: any) => <option key={a.name} value={a.name}>{a.name}{a.label ? " · " + a.label : ""} — {a.n_designs} designs, {dateTime(a.mtime)}</option>)}</Select></label><span className="text-[12px] text-muted">then: {counts(arc.data.rows)} · now: {counts(rows)}</span></div>
    <StatList><Stat label="changed" value={changed.length} unit={`of ${keys.length} designs`} cls={changed.length ? "warn" : "ok"} /><Stat label="status changed" value={diff.filter((r) => r.change === "status").length} /><Stat label="apogee moved" value={diff.filter((r) => r.change === "apogee").length} /><Stat label="new" value={diff.filter((r) => r.change === "new").length} /><Stat label="removed" value={diff.filter((r) => r.change === "removed").length} />{arc.data.target_ft != null && arc.data.target_ft !== d.target_ft ? <Stat label="target then" value={fmt(arc.data.target_ft, 0)} unit="ft" cls="warn" /> : null}</StatList>
    <DataTable columns={["booster", "sustainer", "profile", "change", "status_before", "status_after", "apogee_before", "apogee_after", "delta_ft"]} rows={(showSame ? diff : changed).slice().sort((a, b) => Math.abs(b.delta_ft ?? 0) - Math.abs(a.delta_ft ?? 0))} labels={{ status_before: "status then", status_after: "status now", apogee_before: "apogee then", apogee_after: "apogee now", delta_ft: "Δ apogee" }} format={{ change: (v) => <Badge status={({ same: "todo", status: "warn", apogee: "info", new: "ok", removed: "err" } as any)[v] || "todo"}>{v}</Badge>, status_before: (v) => (v ? <Badge status={STATUS_BADGE[v] || "todo"}>{v}</Badge> : "—"), status_after: (v) => (v ? <Badge status={STATUS_BADGE[v] || "todo"}>{v}</Badge> : "—"), apogee_before: (v) => fmt(v, 0), apogee_after: (v) => fmt(v, 0), delta_ft: (v) => signed(v) }} onRow={(r) => { if (cur.has(r.key)) selectDesign(r.key); }} rowKey={(r) => r.key} maxHeight={520} tools={{ csv: "run-diff.csv", extra: <Checkbox label="show unchanged designs too" checked={showSame} onChange={(e) => setSearch({ same: e.target.checked ? "1" : undefined })} /> }} />
  </div>;
}
function ReportTab() {
  const rr = useCached<any>("report", "/api/report", undefined, 5000);
  if (!rr.data) return <div className="text-muted">Loading…</div>;
  return rr.data.exists ? <ReportView text={rr.data.text} /> : <Callout kind="info">no report.md yet — run the report stage</Callout>;
}
