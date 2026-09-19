import { useState } from "react";
import { Link } from "@tanstack/react-router";
import { ArrowRight, FolderSearch } from "lucide-react";
import { toast } from "sonner";
import { StepHead } from "@/components/common";
import { Badge, Button, Card, Icon, Input, KV, LiveDot, Problem } from "@/components/ui";
import { api } from "@/lib/api";
import { pickFile } from "@/lib/native";
import { useCached, useRefresh } from "@/lib/store";
import { cn } from "@/lib/utils";

export function SetupPage() {
  const refresh = useRefresh();
  const su = useCached<any>("setup", "/api/setup", undefined, 3000);
  const [test, setTest] = useState<any>(null);
  const [testing, setTesting] = useState(false);
  const [name, setName] = useState("");
  if (!su.data) return <div className="mx-auto flex max-w-[860px] flex-col gap-4"><StepHead title="Setup" /><Card><div className="skeleton h-24" /></Card></div>;
  const d = su.data;
  const selftest = async () => { setTesting(true); try { const r = await api("/api/setup/selftest", {}); setTest(r); su.refetch(); refresh(); } catch (e: any) { toast.error(e.message); } finally { setTesting(false); } };
  const setJar = async () => { try { const p = await pickFile("Choose OpenRocket-*.jar", ".jar"); if (!p) return; await api("/api/config", { set: { "paths.openrocket_jar": p, "paths.jvm": "auto" } }); toast.success("OpenRocket path saved"); su.refetch(); refresh(); } catch (e: any) { toast.error(e.message); } };
  const Step = ({ n, title, ok, children }: { n: number; title: string; ok: boolean | null; children: React.ReactNode }) => (
    <Card title={<span className="flex items-center gap-2.5"><span className={cn("step-ring", ok === null ? "" : ok ? "done" : "bad")}>{n}</span>{title}</span>}
          actions={ok === null ? null : <Badge status={ok ? "ok" : "err"}>{ok ? "ready" : "attention"}</Badge>} glow={ok === false ? "bad" : null}>
      {children}
    </Card>
  );
  return (
    <div className="mx-auto flex w-full max-w-[860px] flex-col gap-4">
      <StepHead title="Setup" sub="Three checks, then the project is ready. Everything runs on this machine." />
      <Step n={1} title="OpenRocket" ok={d.openrocket.ok}>
        <KV pairs={[["jar", d.openrocket.jar || "not found"], ["JVM", d.openrocket.jvm || "—"]]} />
        {!d.openrocket.ok ? <Problem tone="warn">Install <a href="https://openrocket.info/downloads.html" target="_blank" rel="noreferrer">OpenRocket 24.12</a> (it brings its own Java), or point the app at an existing jar.</Problem> : null}
        <div><Button size="sm" onClick={setJar}><Icon of={FolderSearch} size="sm" />Choose OpenRocket jar…</Button></div>
      </Step>
      <Step n={2} title="RASAero engine" ok={d.engine.ok}>
        <KV pairs={[["engine", d.engine.engine || "missing"], ["host", Array.isArray(d.engine.host) ? d.engine.host.join(" ") : "missing"], ["status", d.engine.detail]]} />
        <div className="flex flex-wrap items-center gap-2">
          <Button size="sm" variant="primary" disabled={testing} onClick={selftest}>{testing ? <LiveDot tone="good" /> : null}{testing ? "testing…" : "Run self-test (one flight table + one JVM start)"}</Button>
          {test ? <span className="text-[12px] flex items-center gap-2">{test.ok ? <Badge status="ok">passed</Badge> : <Badge status="err">failed</Badge>} <span className="text-ink-2">engine {test.engine?.ok ? `ok in ${test.engine.elapsed_s}s` : test.engine?.error} · OpenRocket {test.openrocket?.ok ? `ok in ${test.openrocket.elapsed_s}s` : test.openrocket?.error}</span></span> : null}
        </div>
      </Step>
      <Step n={3} title="Project" ok={d.inputs_ok}>
        <KV pairs={[["current project", d.project], ["projects folder", d.projects_dir], ["template", d.template || "none bundled"]]} />
        {!d.inputs_ok ? <Problem tone="warn">The project has no vehicle files yet. Pick them on the <Link to="/inputs" className="link">Inputs</Link> page, or create a new project from the bundled template.</Problem> : null}
        <div className="flex flex-wrap items-center gap-2">
          <Input sans className="!w-[240px]" placeholder="new project name" value={name} onChange={(e) => setName(e.target.value)} />
          <Button size="sm" disabled={!d.template || !name.trim()} onClick={async () => { try { const r = await api("/api/project/new", { name }); toast.success(`created ${r.path}. Restart the app to open it.`); setName(""); } catch (e: any) { toast.error(e.message); } }}>Create from template</Button>
        </div>
      </Step>
      <div className="flex justify-end"><Button asChild variant="primary"><Link to="/">Go to the Overview<Icon of={ArrowRight} size="sm" /></Link></Button></div>
    </div>
  );
}
