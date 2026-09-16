import { cn } from "@/lib/utils";
export function Card({ className, children, tight, ...rest }: React.HTMLAttributes<HTMLDivElement> & { tight?: boolean }) {
  return <div className={cn("card", tight && "tight", className)} {...rest}>{children}</div>;
}
export function CardTitle({ children, right, className }: { children: React.ReactNode; right?: React.ReactNode; className?: string }) {
  return <div className={cn("mb-3 flex items-baseline justify-between gap-3", className)}><h2 className="text-[15px] font-semibold">{children}</h2>{right ? <div className="text-[12px] text-muted flex items-center gap-2">{right}</div> : null}</div>;
}
