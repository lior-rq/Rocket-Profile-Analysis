import { cn } from "@/lib/utils";
export function Progress({ value, indeterminate, className }: { value?: number; indeterminate?: boolean; className?: string }) {
  return <div className={cn("h-2 w-full overflow-hidden rounded-full bg-panel-2 border border-line", className)}><div className={cn("h-full bg-run transition-[width] duration-300", indeterminate && "animate-pulse")} style={{ width: `${indeterminate ? 30 : Math.max(0, Math.min(100, value ?? 0))}%` }} /></div>;
}
