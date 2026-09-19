import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { api } from "@/lib/api";
import { useApp, useCached } from "@/lib/store";
import { cn } from "@/lib/utils";
import { Callout } from "@/components/common";
import { Button } from "@/components/ui/button";
import { Card, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";

/* Schema-driven form over config.yaml: every leaf of the parsed config,
   grouped by its top-level section, typed from its current value. */
type Field = { key: string; value: unknown; kind: "number" | "boolean" | "string" | "list" | "null" };
function flatten(obj: any, prefix = ""): Field[] {
  const out: Field[] = [];
  for (const [k, v] of Object.entries(obj || {})) {
    const key = prefix ? `${prefix}.${k}` : k;
    if (v !== null && typeof v === "object" && !Array.isArray(v)) out.push(...flatten(v, key));
    else out.push({ key, value: v, kind: v === null ? "null" : typeof v === "number" ? "number" : typeof v === "boolean" ? "boolean" : Array.isArray(v) ? "list" : "string" });
  }
  return out;
}
const HELP: Record<string, string> = { "backend": "rasaero_native (RASAero's engine) | openrocket (preview)", "native.workers": "engine host processes: auto = every core", "native.dt_s": "integration step [s]", "paths.openrocket_jar": "auto = the installed OpenRocket", "paths.jvm": "auto = the JRE next to the jar", "target.apogee_ft": "what the search aims for", "target.tolerance_ft": "solved when |apogee − target| ≤ tolerance", "mass_model.hardware_mass_lb": "dry mass of the whole rocket; empty = .ork masses as-is", "surface_finish": "RASAero surface finish name", "rasaero.engine_name_format": "how RASAero names motors in <Booster1Engine>" };

/* Module-level so React keeps the same input mounted across keystrokes. */
function Row({ f, edits, set }: { f: Field; edits: Record<string, unknown>; set: (f: Field, v: unknown) => void }) { const changed = f.key in edits; const v = (changed ? edits[f.key] : f.value) as any; const label = f.key.split(".").slice(1).join(".") || f.key; return <div className={cn("grid grid-cols-[minmax(160px,1fr)_minmax(0,2fr)] items-center gap-3 border-b border-line py-1.5 text-[13px]", changed && "bg-accent-bg/30")}><div><div className="font-mono text-[12px]">{label}</div>{HELP[f.key] ? <div className="text-[11px] text-muted">{HELP[f.key]}</div> : null}</div><div>{f.kind === "boolean" ? <Select className="h-7" value={String(v)} onChange={(e) => set(f, e.target.value === "true")}><option value="true">true</option><option value="false">false</option></Select> : f.kind === "number" ? <Input type="number" step="any" className="h-7" value={v ?? ""} onChange={(e) => set(f, e.target.value === "" ? null : Number(e.target.value))} /> : f.kind === "list" ? <Input className="h-7 font-mono" value={Array.isArray(v) ? v.join(", ") : String(v ?? "")} placeholder="comma separated" onChange={(e) => set(f, e.target.value.split(",").map((x) => x.trim()).filter(Boolean).map((x) => (/^-?\d+(\.\d+)?$/.test(x) ? Number(x) : x)))} /> : <Input className="h-7" value={v ?? ""} placeholder="null" onChange={(e) => set(f, e.target.value === "" ? null : (/^-?\d+(\.\d+)?$/.test(e.target.value) ? Number(e.target.value) : e.target.value))} />}</div></div>; }

export function SettingsPage() {
  const { state: s, refresh } = useApp();
  const cfg = useCached<any>("config", "/api/config", s?.config ? JSON.stringify(s.config).length : 0, 2000);
  const [edits, setEdits] = useState<Record<string, unknown>>({});
  const [text, setText] = useState<string | null>(null);
  const fields = useMemo(() => flatten(cfg.data?.parsed || {}), [cfg.data]);
  const sections = useMemo(() => [...new Set(fields.map((f) => f.key.split(".")[0]))], [fields]);
  useEffect(() => { setText(null); }, [cfg.data?.text]);
  if (!s || !cfg.data) return <div className="text-muted">Loading…</div>;
  const dirty = Object.keys(edits).length;
  const set = (f: Field, v: unknown) => setEdits((e) => { const n = { ...e }; if (JSON.stringify(v) === JSON.stringify(f.value)) delete n[f.key]; else n[f.key] = v; return n; });
  const save = async () => { try { await api("/api/config", { set: edits }); setEdits({}); toast.success("config.yaml saved"); await refresh(); } catch (e: any) { toast.error(e.message); } };
  const saveRaw = async () => { try { await api("/api/config_text", { text }); toast.success("config.yaml written"); setText(null); await refresh(); } catch (e: any) { toast.error(e.message); } };
  return <div className="flex flex-col gap-4">
    <div className="flex flex-wrap items-start justify-between gap-3"><div><h1 className="text-[22px] font-semibold">Settings</h1><div className="mt-1 max-w-[900px] text-[13px] text-muted">Every key of <code className="font-mono">config.yaml</code>, grouped by section, with its type taken from the current value; saving writes the file in place with its comments intact. The Inputs page covers the everyday ones with more guidance.</div></div>
      {dirty ? <div className="flex items-center gap-2"><span className="text-[12px] text-muted">{dirty} unsaved change{dirty === 1 ? "" : "s"}</span><Button variant="primary" onClick={save}>Save</Button><Button onClick={() => setEdits({})}>Discard</Button></div> : null}</div>
    <Card><Tabs defaultValue={sections[0]}><TabsList>{sections.map((sec) => <TabsTrigger key={sec} value={sec} extra={fields.filter((f) => f.key.split(".")[0] === sec && f.key in edits).length || null}>{sec}</TabsTrigger>)}<TabsTrigger value="__raw">raw YAML</TabsTrigger></TabsList>
      {sections.map((sec) => <TabsContent key={sec} value={sec}>{fields.filter((f) => f.key.split(".")[0] === sec).map((f) => <Row key={f.key} f={f} edits={edits} set={set} />)}</TabsContent>)}
      <TabsContent value="__raw"><Callout kind="info" className="mb-2">The file as it is on disk. Saving here replaces the whole file (comments included, as typed).</Callout><textarea className="h-[480px] w-full rounded border border-line bg-panel-2 p-2 font-mono text-[12px]" value={text ?? cfg.data.text} onChange={(e) => setText(e.target.value)} spellCheck={false} /><div className="mt-2 flex gap-2"><Button variant="primary" disabled={text === null || text === cfg.data.text} onClick={saveRaw}>Write config.yaml</Button><Button disabled={text === null} onClick={() => setText(null)}>Discard</Button></div></TabsContent></Tabs></Card>
    <Card><CardTitle>Project</CardTitle><div className="text-[13px]"><div className="font-mono text-[12px]">{s.root}</div><div className="mt-2 flex gap-2"><Button size="sm" onClick={() => api("/api/reveal", { path: "" }).catch((e: any) => toast.error(e.message))}>Reveal project folder</Button></div></div></Card>
  </div>;
}
