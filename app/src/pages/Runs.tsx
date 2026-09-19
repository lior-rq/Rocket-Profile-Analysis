import { useNavigate, useSearch } from "@tanstack/react-router";
import { Camera } from "lucide-react";
import { toast } from "sonner";
import { ConfirmButton, StepHead } from "@/components/common";
import { DataTable } from "@/components/DataTable";
import { Badge, Card, Icon, Problem } from "@/components/ui";
import { api } from "@/lib/api";
import { dateTime, dur, sizeFmt } from "@/lib/format";
import { useAppState, useCached, useRefresh } from "@/lib/store";
import { FINDINGS_STAGES, outcomeText } from "@/lib/types";

const outcomeClass = (r: any) => (r.cancelled ? "todo" : r.exit_code === 0 ? "ok" : r.exit_code === 1 && FINDINGS_STAGES.includes(r.stage) ? "warn" : "err");
export function RunsPage() {
  const s = useAppState();
  const refresh = useRefresh();
  const search = useSearch({ strict: false }) as any;
  const nav = useNavigate();
  const rr = useCached<any>("runs", "/api/runs", s?.history?.length, 2000);
  const ar = useCached<any>("archives", "/api/archives", undefined, 5000);
  const hist = (rr.data?.history || []).slice().reverse();
  const rows = hist.map((r: any) => ({ ...r, id: String(r.started), cmd: ["rpa", r.stage, ...(r.args || [])].join(" "), outcome: outcomeText(r) + (r.side ? " · beside a run" : "") }));
  const sel = rows.find((r: any) => r.id === String(search.sel)) || null;
  const log = useCached<any>("log:" + (sel?.log || ""), sel?.log ? "/api/text?path=" + encodeURIComponent(sel.log) : null, sel?.finished);
  const archives = ar.data?.archives || [];
  return (
    <>
      <StepHead title="Runs & logs" sub="Every command started from this app with its outcome and full log (output/gui_logs/), and the result snapshots kept in output-archive/ — one is taken automatically before every fresh run, so the previous answer is never lost.">
        <ConfirmButton size="md" label={<><Icon of={Camera} size="sm" />Snapshot current results</>} armedLabel="Click again to snapshot" onClick={async () => { try { const r = await api("/api/archive", {}); toast.success(`snapshot ${r.name} (${r.files.length} files)`); refresh(); } catch (e: any) { toast.error(e.message); } }} />
      </StepHead>
      <Card title={`Runs (${rows.length})`} sub="click a row for its log" static>
        {rows.length ? <DataTable loading={rr.isLoading} columns={["finished", "cmd", "outcome", "elapsed_s", "last_error", "log"]} rows={rows} labels={{ cmd: "command", elapsed_s: "took", last_error: "last error line" }}
          format={{ finished: (v) => dateTime(v), elapsed_s: (v) => dur(v), outcome: (v, r) => <Badge status={outcomeClass(r)} lower>{v}</Badge>, log: (v) => (v ? "view" : "—"), last_error: (v) => v || "—", cmd: (v) => <span className="font-mono text-[12px]">{v}</span> }}
          onRow={(r) => nav({ to: "/runs", search: { sel: r.id } as any })} rowKey={(r) => r.id} selected={sel ? sel.id : null} wrap={["last_error"]} tools={{ csv: "runs.csv" }} /> : <p className="text-[12.5px] text-ink-3">nothing has been run from this app yet</p>}
      </Card>
      <Card title={sel ? `Log · rpa ${[sel.stage, ...(sel.args || [])].join(" ")} · ${dateTime(sel.finished)}` : "Log"} sub={sel?.log ? <span className="font-mono">{sel.log}</span> : undefined} static>
        {sel && sel.log ? (log.data ? <pre className="console max-h-[520px]">{log.data.text || "(empty)"}</pre> : <div className="skeleton h-32" />) : <p className="text-[12.5px] text-ink-3">{sel ? "no log file for this run" : "select a run above to read its log"}</p>}
      </Card>
      <Card title={`Result snapshots (${archives.length})`} sub="compared on Results, Previous runs" static>
        {archives.length ? <DataTable columns={["name", "label", "n_designs", "mtime", "bytes"]} rows={archives} labels={{ n_designs: "designs", mtime: "taken", bytes: "size" }} format={{ mtime: (v) => dateTime(v), bytes: (v) => sizeFmt(v), label: (v) => v || "—" }} onRow={(r) => nav({ to: "/results", search: { tab: "previous", archive: r.name } as any })} rowKey={(r) => r.name} maxHeight={320} />
          : <Problem tone="info">none yet — one is taken automatically before every fresh run, or press Snapshot current results</Problem>}
      </Card>
    </>
  );
}
