import { useState } from "react";
import { Link } from "@tanstack/react-router";
import { FlaskConical } from "lucide-react";
import { toast } from "sonner";
import { StepHead } from "@/components/common";
import { Badge, Button, Card, Icon, KV, LiveDot, Problem } from "@/components/ui";
import { api } from "@/lib/api";
import { fmt } from "@/lib/format";
import { useAppState, useCached, useRefresh } from "@/lib/store";

export function EnginePage() {
  const s = useAppState();
  const refresh = useRefresh();
  const eng = useCached<any>("engine", "/api/engine", undefined, 3000);
  const [test, setTest] = useState<any>(null);
  const [testing, setTesting] = useState(false);
  if (!s) return null;
  const e = eng.data || s.engine || {};
  const pool = e.pool?.pools?.[0];
  const selftest = async () => { setTesting(true); try { const r = await api("/api/setup/selftest", {}); setTest(r); if (r.ok) toast.success("self-test passed"); else toast.error("self-test failed"); refresh(); } catch (err: any) { toast.error(err.message); } finally { setTesting(false); } };
  return (
    <>
      <StepHead title="Engine" sub="RASAero II's own flight-simulation and aerodynamics code runs inside this app, in warm host processes; OpenRocket supplies the mass model through its bundled Java runtime. Nothing else is needed on this machine." />
      <div className="grid gap-4 lg:grid-cols-2 lg:items-start">
        <Card title="RASAero engine" actions={<Badge status={e.ok ? "ok" : "err"}>{e.ok ? "ready" : "missing"}</Badge>} glow={e.ok ? null : "bad"}>
          <KV pairs={[["engine", e.engine || "—"], ["host", Array.isArray(e.host) ? e.host.join(" ") : e.host || "—"], ["status", e.detail], ["warm-up", e.warmup ? `${e.warmup.engine || "…"}${e.warmup.done ? ` (${e.warmup.elapsed_s}s at launch)` : " (starting…)"}` : "—"], pool ? ["pool", `${pool.alive}/${pool.hosts} host(s) alive of ${pool.workers} · ${pool.motors} motors · ${pool.design}`] : ["pool", "no hosts yet (they start with the first flight)"], ["version", `RASAero II ${e.version || "1.0.2.0"} engine`]]} />
          {!e.ok ? <Problem tone="err">{e.detail}. On a source checkout: <code>python tools/rasaero_fetch.py</code> then <code>dotnet build native/RasaeroHost -c Release</code>. The installed app bundles both.</Problem> : null}
          <div className="flex flex-wrap items-center gap-2">
            <Button variant="primary" disabled={testing || !e.ok} onClick={selftest}>{testing ? <LiveDot tone="good" /> : <Icon of={FlaskConical} size="sm" />}{testing ? "testing…" : "Run self-test"}</Button>
          </div>
          {test ? <KV pairs={[["engine", test.engine?.ok ? `ok · one aero table in ${test.engine.elapsed_s}s · ${test.engine.hosts} host(s)` : `failed: ${test.engine?.error}`], ["OpenRocket", test.openrocket?.ok ? `ok · JVM in ${test.openrocket.elapsed_s}s · ${test.openrocket.jar}` : `failed: ${test.openrocket?.error}`]]} /> : null}
        </Card>
        <Card title="OpenRocket" actions={<Badge status={e.openrocket?.jar ? "ok" : "err"}>{e.openrocket?.jar ? "found" : "not found"}</Badge>}>
          <KV pairs={[["jar", e.openrocket?.jar || "not found"], ["JVM", e.openrocket?.jvm || "—"], ["source", e.openrocket?.source || "—"], ["JVM state", e.warmup?.openrocket || "not started"]]} />
          {!e.openrocket?.jar ? <Problem tone="warn">Install OpenRocket 24.12 (it ships its own Java), or point <code>paths.openrocket_jar</code> at the jar in <Link to="/settings" className="link">Settings</Link>.</Problem> : null}
        </Card>
      </div>
      <Card title="Platform"><KV pairs={[["app folder", e.platform?.app_dir], ["data folder", e.platform?.data_dir], ["project", s.root], ["template", e.platform?.template || "—"], ["packaged", e.platform?.frozen ? "yes (installed app)" : "no (source checkout)"]]} /></Card>
      <Card title="Numbers"><KV pairs={[["flights per second", pool ? `${fmt(pool.workers * 7)} (≈22 ms per flight over ${pool.workers} hosts)` : "—"], ["aero table", "0.11 s (Mach 0.01–25 × 3 angles of attack)"], ["fidelity", "10/10 RASAero GUI reference flights reproduced to 0.0003 % apogee (native/VALIDATION.md)"]]} /></Card>
    </>
  );
}
