import { useState } from "react";
import { Link } from "@tanstack/react-router";
import { toast } from "sonner";
import { api } from "@/lib/api";
import { ago, dur, fmt } from "@/lib/format";
import { useApp, useCached } from "@/lib/store";
import { Callout, KV, RunButton } from "@/components/common";
import { DataTable } from "@/components/DataTable";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardTitle } from "@/components/ui/card";

export function EnginePage() {
  const { state: s, refresh } = useApp();
  const eng = useCached<any>("engine", "/api/engine", undefined, 3000);
  const [test, setTest] = useState<any>(null);
  const [testing, setTesting] = useState(false);
  const w = useCached<any>("worker", "/api/worker", undefined, 5000);
  if (!s) return null;
  const e = eng.data || s.engine || {};
  const pool = e.pool?.pools?.[0];
  const vmVisible = !!(s.config?.vm?.utmctl && s.config.vm.utmctl !== "auto") || s.config?.rasaero?.engine === "vm" || (w.data && w.data.vm && w.data.vm.available);
  const selftest = async () => { setTesting(true); try { const r = await api("/api/setup/selftest", {}); setTest(r); if (r.ok) toast.success("self-test passed"); else toast.error("self-test failed"); refresh(); } catch (err: any) { toast.error(err.message); } finally { setTesting(false); } };
  return <div className="flex flex-col gap-4">
    <div><h1 className="text-[22px] font-semibold">Engine</h1><div className="mt-1 max-w-[900px] text-[13px] text-muted">RASAero II's own flight-simulation and aerodynamics code runs inside this app, in warm host processes; OpenRocket supplies the mass model through its bundled Java runtime. Nothing else is needed on this machine.</div></div>
    <div className="grid gap-4 lg:grid-cols-2">
      <Card><CardTitle right={<Badge status={e.ok ? "ok" : "err"}>{e.ok ? "ready" : "missing"}</Badge>}>RASAero engine</CardTitle>
        <KV pairs={[["engine", e.engine || "—"], ["host", Array.isArray(e.host) ? e.host.join(" ") : e.host || "—"], ["status", e.detail], ["warm-up", e.warmup ? `${e.warmup.engine || "…"}${e.warmup.done ? ` (${e.warmup.elapsed_s}s at launch)` : " (starting…)"}` : "—"], pool ? ["pool", `${pool.alive}/${pool.hosts} host(s) alive of ${pool.workers} · ${pool.motors} motors · ${pool.design}`] : ["pool", "no hosts yet (they start with the first flight)"], ["version", `RASAero II ${e.version || "1.0.2.0"} engine`]]} />
        {!e.ok ? <Callout kind="err" className="mt-3">{e.detail}. On a source checkout: <code>python tools/rasaero_fetch.py</code> then <code>dotnet build native/RasaeroHost -c Release</code>. The installed app bundles both.</Callout> : null}
        <div className="mt-3 flex flex-wrap gap-2"><Button variant="primary" disabled={testing || !e.ok} onClick={selftest}>{testing ? "testing…" : "Run self-test"}</Button><RunButton stage="validate" args={["--engine", "native"]} label="Validate the engine vs reference flights" disabled={!s.reference?.n || !e.ok} /></div>
        {test ? <div className="mt-3"><KV pairs={[["engine", test.engine?.ok ? `ok · one aero table in ${test.engine.elapsed_s}s · ${test.engine.hosts} host(s)` : `failed: ${test.engine?.error}`], ["OpenRocket", test.openrocket?.ok ? `ok · JVM in ${test.openrocket.elapsed_s}s · ${test.openrocket.jar}` : `failed: ${test.openrocket?.error}`]]} /></div> : null}</Card>
      <Card><CardTitle right={<Badge status={e.openrocket?.jar ? "ok" : "err"}>{e.openrocket?.jar ? "found" : "not found"}</Badge>}>OpenRocket</CardTitle>
        <KV pairs={[["jar", e.openrocket?.jar || "not found"], ["JVM", e.openrocket?.jvm || "—"], ["source", e.openrocket?.source || "—"], ["JVM state", e.warmup?.openrocket || "not started"]]} />
        {!e.openrocket?.jar ? <Callout kind="warn" className="mt-3">Install OpenRocket 24.12 (it ships its own Java), or point <code>paths.openrocket_jar</code> at the jar in <Link to="/settings" className="text-accent">Settings</Link>.</Callout> : null}</Card>
    </div>
    <Card><CardTitle>Platform</CardTitle><KV pairs={[["app folder", e.platform?.app_dir], ["data folder", e.platform?.data_dir], ["project", s.root], ["template", e.platform?.template || "—"], ["packaged", e.platform?.frozen ? "yes (installed app)" : "no (source checkout)"]]} /></Card>
    {vmVisible && w.data ? <details className="card"><summary className="cursor-pointer text-[13px] font-semibold">Advanced: VM worker (fallback){" "}<Badge status={({ busy: "run", online: "ok", queued: "warn", unresponsive: "err", offline: "err" } as any)[w.data.state] || "todo"}>{w.data.state}</Badge></summary>
      <div className="mt-3 flex flex-col gap-3"><KV pairs={[["detail", w.data.detail], ["UTM virtual machine", w.data.vm?.available ? `${w.data.vm.name}: ${w.data.vm.status || "not found"}` : "utmctl not found"], ["heartbeat", w.data.heartbeat ? `${w.data.heartbeat.status}, ${ago(w.data.heartbeat.epoch)}` : "none"], ["queue", `${w.data.n_active} running, ${w.data.n_queued} waiting${w.data.n_orphan ? `, ${w.data.n_orphan} orphan` : ""}`]]} />
        <div className="flex gap-2"><Button size="sm" disabled={!w.data.vm?.available} onClick={() => api("/api/vm/start", {}).then(() => toast("starting the VM worker")).catch((e2: any) => toast.error(e2.message))}>▶ Start VM worker</Button><Button size="sm" disabled={!w.data.vm?.available} onClick={() => api("/api/vm/stop", {}).then(() => toast("stopping the worker")).catch((e2: any) => toast.error(e2.message))}>■ Stop worker</Button><RunButton stage="inspect" label="Inspect RASAero GUI (debug)" size="sm" /></div>
        {w.data.jobs?.length ? <DataTable columns={["name", "state", "type", "done", "created"]} rows={w.data.jobs} format={{ state: (v) => <Badge status={({ ok: "ok", failed: "err", running: "running", queued: "queued", orphan: "orphan", empty: "todo" } as any)[v] || "todo"}>{v}</Badge>, done: (v) => (v ? dur(v.elapsed_s) : "—") }} maxHeight={300} /> : null}
        {w.data.console_tail?.length ? <pre className="console max-h-[240px]">{w.data.console_tail.join("\n")}</pre> : null}</div></details> : null}
    <Card><CardTitle>Numbers</CardTitle><KV pairs={[["flights per second", pool ? `${fmt(pool.workers * 7)} (≈22 ms per flight over ${pool.workers} hosts)` : "—"], ["aero table", "0.11 s (Mach 0.01–25 × 3 angles of attack)"], ["fidelity", "10/10 VM reference flights reproduced to 0.0003 % apogee (native/VALIDATION.md)"]]} /></Card>
  </div>;
}
