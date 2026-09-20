import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { RevealButton, StepHead, UnsavedBar } from "@/components/common";
import { Button, Card, Input, NumberField, Problem, Select, Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui";
import { api } from "@/lib/api";
import { useAppState, useCached, useRefresh } from "@/lib/store";
import { cn } from "@/lib/utils";

/* Schema-driven form over config.yaml: every leaf of the parsed config,
   grouped by its top-level section, typed from its current value. */
type Field = { key: string; value: unknown; kind: "number" | "boolean" | "string" | "list" | "null" };
function flatten(obj: any, prefix = ""): Field[] {
  const out: Field[] = [];
  for (const [k, val] of Object.entries(obj || {})) {
    const key = prefix ? `${prefix}.${k}` : k;
    if (val !== null && typeof val === "object" && !Array.isArray(val)) out.push(...flatten(val, key));
    else out.push({ key, value: val, kind: val === null ? "null" : typeof val === "number" ? "number" : typeof val === "boolean" ? "boolean" : Array.isArray(val) ? "list" : "string" });
  }
  return out;
}
const HELP: Record<string, string> = { "backend": "rasaero_native (RASAero's engine) | openrocket (preview)", "native.workers": "engine host processes: auto = every core", "native.dt_s": "integration step [s]", "paths.openrocket_jar": "auto = the installed OpenRocket", "paths.jvm": "auto = the JRE next to the jar", "target.apogee_ft": "what the search aims for", "target.tolerance_ft": "solved when |apogee − target| ≤ tolerance", "mass_model.hardware_mass_lb": "dry mass of the whole rocket; empty = .ork masses as-is", "surface_finish": "RASAero surface finish name", "rasaero.engine_name_format": "how RASAero names motors in <Booster1Engine>" };

/* Module-level so React keeps the same input mounted across keystrokes. */
function Row({ f, edits, set }: { f: Field; edits: Record<string, unknown>; set: (f: Field, v: unknown) => void }) {
  const changed = f.key in edits; const val = (changed ? edits[f.key] : f.value) as any; const label = f.key.split(".").slice(1).join(".") || f.key;
  const num = (t: string) => (/^-?\d+(\.\d+)?$/.test(t) ? Number(t) : t);
  return (
    <div className={cn("grid grid-cols-[minmax(160px,1fr)_minmax(0,2fr)] items-center gap-3 border-b border-line-2 py-2 text-[13px] -mx-2 px-2 rounded-1 transition-colors", changed && "bg-accent-2")}>
      <div><div className="font-mono text-[12px]">{label}</div>{HELP[f.key] ? <div className="text-[11px] text-ink-3 leading-snug">{HELP[f.key]}</div> : null}</div>
      <div>
        {f.kind === "boolean" ? <Select sm value={String(val)} onChange={(e) => set(f, e.target.value === "true")}><option value="true">true</option><option value="false">false</option></Select>
          : f.kind === "number" ? <NumberField sm value={val} step={1} onChange={(n) => set(f, n)} />
          : f.kind === "list" ? <Input sm value={Array.isArray(val) ? val.join(", ") : String(val ?? "")} placeholder="comma separated" onChange={(e) => set(f, e.target.value.split(",").map((x) => x.trim()).filter(Boolean).map(num))} />
          : <Input sm sans value={val ?? ""} placeholder="null" onChange={(e) => set(f, e.target.value === "" ? null : num(e.target.value))} />}
      </div>
    </div>
  );
}

export function SettingsPage() {
  const s = useAppState();
  const refresh = useRefresh();
  const cfg = useCached<any>("config", "/api/config", s?.config ? JSON.stringify(s.config).length : 0, 2000);
  const [edits, setEdits] = useState<Record<string, unknown>>({});
  const [text, setText] = useState<string | null>(null);
  const fields = useMemo(() => flatten(cfg.data?.parsed || {}), [cfg.data]);
  const sections = useMemo(() => [...new Set(fields.map((f) => f.key.split(".")[0]))], [fields]);
  useEffect(() => { setText(null); }, [cfg.data?.text]);
  if (!s || !cfg.data) return <><StepHead title="Settings" /><Card><div className="skeleton h-40" /></Card></>;
  const dirty = Object.keys(edits).length;
  const set = (f: Field, val: unknown) => setEdits((e) => { const n = { ...e }; if (JSON.stringify(val) === JSON.stringify(f.value)) delete n[f.key]; else n[f.key] = val; return n; });
  const save = async () => { try { await api("/api/config", { set: edits }); setEdits({}); toast.success("config.yaml saved"); await refresh(); } catch (e: any) { toast.error(e.message); } };
  const saveRaw = async () => { try { await api("/api/config_text", { text }); toast.success("config.yaml written"); setText(null); await refresh(); } catch (e: any) { toast.error(e.message); } };
  return (
    <>
      <StepHead title="Settings" sub={<>Every key of <code>config.yaml</code>, grouped by section, with its type taken from the current value; saving writes the file in place with its comments intact. The Inputs page covers the everyday ones with more guidance.</>} />
      <UnsavedBar count={dirty}>
        <Button variant="primary" size="sm" onClick={save}>Save</Button><Button size="sm" onClick={() => setEdits({})}>Discard</Button>
      </UnsavedBar>
      <Card static>
        <Tabs defaultValue={sections[0]}>
          <TabsList>{sections.map((sec) => <TabsTrigger key={sec} value={sec} extra={fields.filter((f) => f.key.split(".")[0] === sec && f.key in edits).length || null}>{sec}</TabsTrigger>)}<TabsTrigger value="__raw">raw YAML</TabsTrigger></TabsList>
          {sections.map((sec) => <TabsContent key={sec} value={sec} className="mt-2">{fields.filter((f) => f.key.split(".")[0] === sec).map((f) => <Row key={f.key} f={f} edits={edits} set={set} />)}</TabsContent>)}
          <TabsContent value="__raw" className="mt-3 flex flex-col gap-3">
            <Problem tone="info">The file as it is on disk. Saving here replaces the whole file (comments included, as typed).</Problem>
            <textarea className="input h-[480px] !text-[12px]" value={text ?? cfg.data.text} onChange={(e) => setText(e.target.value)} spellCheck={false} />
            <div className="flex gap-2"><Button variant="primary" disabled={text === null || text === cfg.data.text} onClick={saveRaw}>Write config.yaml</Button><Button disabled={text === null} onClick={() => setText(null)}>Discard</Button></div>
          </TabsContent>
        </Tabs>
      </Card>
      <Card title="Project">
        <div className="font-mono text-[12px] text-ink-2 break-all">{s.root}</div>
        <div className="flex gap-2"><RevealButton path="">Reveal project folder</RevealButton></div>
      </Card>
    </>
  );
}
