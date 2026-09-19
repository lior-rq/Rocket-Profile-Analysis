import { useState } from "react";
import { Link } from "@tanstack/react-router";
import { toast } from "sonner";
import { api } from "@/lib/api";
import { fmt } from "@/lib/format";
import { useApp, useCached } from "@/lib/store";
import { Callout, KV } from "@/components/common";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardTitle } from "@/components/ui/card";

export function EnginePage() {
  const { state: s, refresh } = useApp();
  const eng = useCached<any>("engine", "/api/engine", undefined, 3000);
  const [test, setTest] = useState<any>(null);
  const [testing, setTesting] = useState(false);
  if (!s) return null;
  const e = eng.data || s.engine || {};
  const pool = e.pool?.pools?.[0];
  const selftest = async () => { setTesting(true); try { const r = await api("/api/setup/selftest", {}); setTest(r); if (r.ok) toast.success("self-test passed"); else toast.error("self-test failed"); refresh(); } catch (err: any) { toast.error(err.message); } finally { setTesting(false); } };
  return <div className="flex flex-col gap-4">
    <div><h1 className="text-[22px] font-semibold">Engine</h1><div className="mt-1 max-w-[900px] text-[13px] text-muted">RASAero II's own flight-simulation and aerodynamics code runs inside this app, in warm host processes; OpenRocket supplies the mass model through its bundled Java runtime. Nothing else is needed on this machine.</div></div>
    <div className="grid gap-4 lg:grid-cols-2">
      <Card><CardTitle right={<Badge status={e.ok ? "ok" : "err"}>{e.ok ? "ready" : "missing"}</Badge>}>RASAero engine</CardTitle>
        <KV pairs={[["engine", e.engine || "—"], ["host", Array.isArray(e.host) ? e.host.join(" ") : e.host || "—"], ["status", e.detail], ["warm-up", e.warmup ? `${e.warmup.engine || "…"}${e.warmup.done ? ` (${e.warmup.elapsed_s}s at launch)` : " (starting…)"}` : "—"], pool ? ["pool", `${pool.alive}/${pool.hosts} host(s) alive of ${pool.workers} · ${pool.motors} motors · ${pool.design}`] : ["pool", "no hosts yet (they start with the first flight)"], ["version", `RASAero II ${e.version || "1.0.2.0"} engine`]]} />
        {!e.ok ? <Callout kind="err" className="mt-3">{e.detail}. On a source checkout: <code>python tools/rasaero_fetch.py</code> then <code>dotnet build native/RasaeroHost -c Release</code>. The installed app bundles both.</Callout> : null}
        <div className="mt-3 flex flex-wrap gap-2"><Button variant="primary" disabled={testing || !e.ok} onClick={selftest}>{testing ? "testing…" : "Run self-test"}</Button></div>
        {test ? <div className="mt-3"><KV pairs={[["engine", test.engine?.ok ? `ok · one aero table in ${test.engine.elapsed_s}s · ${test.engine.hosts} host(s)` : `failed: ${test.engine?.error}`], ["OpenRocket", test.openrocket?.ok ? `ok · JVM in ${test.openrocket.elapsed_s}s · ${test.openrocket.jar}` : `failed: ${test.openrocket?.error}`]]} /></div> : null}</Card>
      <Card><CardTitle right={<Badge status={e.openrocket?.jar ? "ok" : "err"}>{e.openrocket?.jar ? "found" : "not found"}</Badge>}>OpenRocket</CardTitle>
        <KV pairs={[["jar", e.openrocket?.jar || "not found"], ["JVM", e.openrocket?.jvm || "—"], ["source", e.openrocket?.source || "—"], ["JVM state", e.warmup?.openrocket || "not started"]]} />
        {!e.openrocket?.jar ? <Callout kind="warn" className="mt-3">Install OpenRocket 24.12 (it ships its own Java), or point <code>paths.openrocket_jar</code> at the jar in <Link to="/settings" className="text-accent">Settings</Link>.</Callout> : null}</Card>
    </div>
    <Card><CardTitle>Platform</CardTitle><KV pairs={[["app folder", e.platform?.app_dir], ["data folder", e.platform?.data_dir], ["project", s.root], ["template", e.platform?.template || "—"], ["packaged", e.platform?.frozen ? "yes (installed app)" : "no (source checkout)"]]} /></Card>
    <Card><CardTitle>Numbers</CardTitle><KV pairs={[["flights per second", pool ? `${fmt(pool.workers * 7)} (≈22 ms per flight over ${pool.workers} hosts)` : "—"], ["aero table", "0.11 s (Mach 0.01–25 × 3 angles of attack)"], ["fidelity", "10/10 RASAero GUI reference flights reproduced to 0.0003 % apogee (native/VALIDATION.md)"]]} /></Card>
  </div>;
}
