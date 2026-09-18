import * as React from "react";
import { cn } from "@/lib/utils";
export const Input = React.forwardRef<HTMLInputElement, React.InputHTMLAttributes<HTMLInputElement>>(({ className, onKeyDown, ...p }, ref) => (
  <input
    ref={ref}
    className={cn("h-8 w-full rounded-md border border-line bg-panel px-2 text-[13px] placeholder:text-faint focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 disabled:opacity-50", className)}
    /* MUST block Backspace/Delete on an empty field: WebView treats it as back-nav. */
    onKeyDown={(e) => { if ((e.key === "Backspace" || e.key === "Delete") && !e.currentTarget.value) e.preventDefault(); onKeyDown?.(e); }}
    {...p}
  />
));
Input.displayName = "Input";
export function Checkbox({ label, className, ...p }: React.InputHTMLAttributes<HTMLInputElement> & { label?: React.ReactNode }) {
  return <label className={cn("inline-flex items-center gap-1.5 text-[13px] cursor-pointer", className)}><input type="checkbox" className="accent-accent" {...p} />{label}</label>;
}
export function Radio({ label, className, ...p }: React.InputHTMLAttributes<HTMLInputElement> & { label?: React.ReactNode }) {
  return <label className={cn("inline-flex items-center gap-1.5 text-[13px] cursor-pointer", className)}><input type="radio" className="accent-accent" {...p} />{label}</label>;
}
