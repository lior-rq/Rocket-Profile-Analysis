import { cn } from "@/lib/utils";
import { STATUS_TEXT } from "@/lib/types";

const CLS: Record<string, string> = {
  ok: "bg-ok-bg text-ok", partial: "bg-warn-bg text-warn", warn: "bg-warn-bg text-warn", stale: "bg-warn-bg text-warn", todo: "bg-panel-2 text-muted", unchecked: "bg-panel-2 text-muted",
  error: "bg-err-bg text-err", err: "bg-err-bg text-err", running: "bg-run-bg text-run", run: "bg-run-bg text-run", info: "bg-info-bg text-info", queued: "bg-warn-bg text-warn", orphan: "bg-err-bg text-err",
};
export function Badge({ status, children, className, title }: { status: string; children?: React.ReactNode; className?: string; title?: string }) {
  return <span title={title} className={cn("inline-flex items-center rounded-full px-2 py-[1px] text-[11px] font-semibold leading-4 whitespace-nowrap", CLS[status] || CLS.todo, className)}>{children ?? STATUS_TEXT[status] ?? status}</span>;
}
