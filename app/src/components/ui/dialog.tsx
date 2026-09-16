import * as D from "@radix-ui/react-dialog";
import { cn } from "@/lib/utils";
import { Button } from "./button";
export const Dialog = D.Root; export const DialogTrigger = D.Trigger;
export function DialogContent({ className, title, children, ...p }: D.DialogContentProps & { title: string }) {
  return <D.Portal><D.Overlay className="fixed inset-0 z-40 bg-black/40" /><D.Content className={cn("fixed left-1/2 top-1/2 z-50 w-[min(92vw,520px)] -translate-x-1/2 -translate-y-1/2 rounded-lg border border-line bg-panel p-5 shadow-xl", className)} {...p}><D.Title className="text-base font-semibold mb-2">{title}</D.Title>{children}</D.Content></D.Portal>;
}
/* window.confirm replacement */
export function ConfirmDialog({ open, onOpenChange, title, body, okLabel = "OK", danger, onOk }: { open: boolean; onOpenChange: (v: boolean) => void; title: string; body: React.ReactNode; okLabel?: string; danger?: boolean; onOk: () => void }) {
  return <Dialog open={open} onOpenChange={onOpenChange}><DialogContent title={title}><div className="text-[13px] text-muted mb-4">{body}</div><div className="flex justify-end gap-2"><Button onClick={() => onOpenChange(false)}>Cancel</Button><Button variant={danger ? "danger" : "primary"} onClick={() => { onOpenChange(false); onOk(); }}>{okLabel}</Button></div></DialogContent></Dialog>;
}
