import { useState } from "react";
import { Link } from "@tanstack/react-router";
import { toast } from "sonner";
import { api } from "@/lib/api";
import { useApp, useCached } from "@/lib/store";
import { Callout, KV } from "@/components/common";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { pickFile } from "@/lib/native";

export function SetupPage() {
  const { refresh } = useApp();
  const su = useCached<any>("setup", "/api/setup", undefined, 3000);
  const [test, setTest] = useState<any>(null);
  const [testing, setTesting] = useState(false);
  const [name, setName] = useState("");
  if (!su.data) return <div className="text-muted">Loading…</div>;
  const d = su.data;
  const selftest = async () => { setTesting(true); try { const r = await api("/api/setup/selftest", {}); setTest(r); su.refetch(); refresh(); } catch (e: any) { toast.error(e.message); } finally { setTesting(false); } };
  const setJar = async () => { try { const p = await pickFile("Choose OpenRocket-*.jar", ".jar"); if (!p) return; await api("/api/config", { set: { "paths.openrocket_jar": p, "paths.jvm": "auto" } }); toast.success("OpenRocket path saved"); su.refetch(); refresh(); } catch (e: any) { toast.error(e.message); } };
  const Step = ({ n, title, ok, children }: { n: number; title: string; ok: boolean | null; children: React.ReactNode }) => <Card><CardTitle right={ok === null ? null : <Badge status={ok ? "ok" : "err"}>{ok ? "ready" : "attention"}</Badge>}>{n}. {title}</CardTitle>{children}</Card>;
  return <div className="mx-auto flex max-w-[860px] flex-col gap-4">
    <div><h1 className="text-[22px] font-semibold">Setup</h1><div className="mt-1 text-[13px] text-muted">Three checks, then the project is ready. Everything runs on this machine.</div></div>
    <Step n={1} title="OpenRocket" ok={d.openrocket.ok}><KV pairs={[["jar", d.openrocket.jar || "not found"], ["JVM", d.openrocket.jvm || "—"]]} />{!d.openrocket.ok ? <Callout kind="warn" className="mt-2">Install <a className="text-accent" href="https://openrocket.info/downloads.html" target="_blank" rel="noreferrer">OpenRocket 24.12</a> (it brings its own Java), or point the app at an existing jar.</Callout> : null}<div className="mt-2"><Button size="sm" onClick={setJar}>Choose OpenRocket jar…</Button></div></Step>
    <Step n={2} title="RASAero engine" ok={d.engine.ok}><KV pairs={[["engine", d.engine.engine || "missing"], ["host", Array.isArray(d.engine.host) ? d.engine.host.join(" ") : "missing"], ["status", d.engine.detail]]} /><div className="mt-2 flex items-center gap-2"><Button size="sm" variant="primary" disabled={testing} onClick={selftest}>{testing ? "testing…" : "Run self-test (one flight table + one JVM start)"}</Button>{test ? <span className="text-[12px]">{test.ok ? <Badge status="ok">passed</Badge> : <Badge status="err">failed</Badge>} engine {test.engine?.ok ? `ok in ${test.engine.elapsed_s}s` : test.engine?.error} · OpenRocket {test.openrocket?.ok ? `ok in ${test.openrocket.elapsed_s}s` : test.openrocket?.error}</span> : null}</div></Step>
    <Step n={3} title="Project" ok={d.inputs_ok}><KV pairs={[["current project", d.project], ["projects folder", d.projects_dir], ["template", d.template || "none bundled"]]} />{!d.inputs_ok ? <Callout kind="warn" className="mt-2">The project has no vehicle files yet. Pick them on the <Link to="/inputs" className="text-accent">Inputs</Link> page, or create a new project from the bundled template.</Callout> : null}<div className="mt-2 flex items-center gap-2"><Input className="h-8 w-[240px]" placeholder="new project name" value={name} onChange={(e) => setName(e.target.value)} /><Button size="sm" disabled={!d.template || !name.trim()} onClick={async () => { try { const r = await api("/api/project/new", { name }); toast.success(`created ${r.path}. Restart the app to open it.`); setName(""); } catch (e: any) { toast.error(e.message); } }}>Create from template</Button></div></Step>
    <div className="flex justify-end"><Button asChild variant="primary"><Link to="/">Go to the Overview →</Link></Button></div>
  </div>;
}
