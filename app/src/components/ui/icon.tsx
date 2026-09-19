/* One icon set, one stroke width. Never an emoji or a text glyph. */
import type { LucideIcon, LucideProps } from "lucide-react";
import { cn } from "@/lib/utils";

const SIZE = { xs: 12, sm: 14, md: 16, lg: 20, xl: 24 } as const;
export type IconSize = keyof typeof SIZE;

export function Icon({ of: Of, size = "md", className, ...rest }: { of: LucideIcon; size?: IconSize; className?: string } & Omit<LucideProps, "size" | "ref">) {
  return <Of size={SIZE[size]} strokeWidth={1.75} absoluteStrokeWidth aria-hidden="true" className={cn("shrink-0", className)} {...rest} />;
}

/* The brand: a two-stage rocket on an accent-to-warn gradient tile. */
export function Mark({ size = 36, className }: { size?: number; className?: string }) {
  return (
    <span className={cn("relative grid place-items-center shrink-0 rounded-xl", className)}
          style={{ width: size, height: size, background: "linear-gradient(135deg, var(--accent) 0%, var(--accent) 45%, var(--warn) 150%)", boxShadow: "var(--glow-accent)" }}>
      <svg viewBox="0 0 64 64" width={size * 0.6} height={size * 0.6} fill="none" stroke="var(--on-accent)" strokeWidth="4.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <path d="M32 10c6 6 8 14 8 24l-8 8-8-8c0-10 2-18 8-24z" />
        <path d="M24 34l-6 6M40 34l6 6" />
        <path d="M32 42v6M26 50h12" />
      </svg>
    </span>
  );
}
