import { cn } from "@/lib/utils";
export function Select({ className, ...p }: React.SelectHTMLAttributes<HTMLSelectElement>) {
  return <select className={cn("h-8 rounded-md border border-line bg-panel px-2 text-[13px] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40", className)} {...p} />;
}
