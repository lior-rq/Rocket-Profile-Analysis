import { cn } from "@/lib/utils";
export function ScrollArea({ className, children, style }: { className?: string; children: React.ReactNode; style?: React.CSSProperties }) {
  return <div className={cn("overflow-auto", className)} style={style}>{children}</div>;
}
