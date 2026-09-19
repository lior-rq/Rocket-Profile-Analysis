/* Small, motion-aware primitives. Everything else is built from these. */
import * as D from "@radix-ui/react-dialog";
import { Slot } from "@radix-ui/react-slot";
import * as TabsPrimitive from "@radix-ui/react-tabs";
import * as T from "@radix-ui/react-tooltip";
import { cva, type VariantProps } from "class-variance-authority";
import { AlertOctagon, AlertTriangle, CheckCircle2, Info, type LucideIcon } from "lucide-react";
import { AnimatePresence, motion, useMotionValue, useSpring, useTransform } from "motion/react";
import * as React from "react";
import { createContext, useContext, useEffect, useId, useRef, useState, type ReactNode } from "react";
import { STATUS_TEXT } from "@/lib/types";
import { cn } from "@/lib/utils";
import { Icon } from "./icon";
import { reducedMotion, rise, snappy, soft, spring } from "./motion";

export { Icon, Mark } from "./icon";
export * from "./motion";
export const cx = cn;

export type Tone = "muted" | "accent" | "good" | "warn" | "bad" | "info";

/* -------------------------------------------------------------- card */

type CardRest = Omit<React.HTMLAttributes<HTMLElement>, "title" | "onDrag" | "onDragStart" | "onDragEnd" | "onAnimationStart">;
interface CardProps extends CardRest {
  title?: ReactNode;
  sub?: ReactNode;
  actions?: ReactNode;
  children?: ReactNode;
  className?: string;
  bodyClassName?: string;
  busy?: boolean;
  id?: string;
  glow?: Tone | null;
  /** Hosts a scrolling table or scrubber: no lift on hover. */
  static?: boolean;
  tight?: boolean;
  /** Skip the entrance variant (cards inside AnimatePresence bring their own). */
  plain?: boolean;
}

/** The pointer spotlight writes CSS variables straight to the node,
    throttled to one frame, never through React state. */
function useSpotlight() {
  const ref = useRef<HTMLElement | null>(null);
  const raf = useRef<number | null>(null);
  const pos = useRef({ x: 0, y: 0 });
  const onPointerMove = (e: React.PointerEvent<HTMLElement>) => {
    const el = ref.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    pos.current = { x: ((e.clientX - r.left) / r.width) * 100, y: ((e.clientY - r.top) / r.height) * 100 };
    if (raf.current != null) return;
    raf.current = requestAnimationFrame(() => {
      raf.current = null;
      const node = ref.current;
      if (!node) return;
      node.style.setProperty("--mx", pos.current.x.toFixed(1) + "%");
      node.style.setProperty("--my", pos.current.y.toFixed(1) + "%");
    });
  };
  useEffect(() => () => { if (raf.current != null) cancelAnimationFrame(raf.current); }, []);
  return { ref, onPointerMove };
}

export function Card({ title, sub, actions, children, className, bodyClassName, busy, id, glow, static: isStatic, tight, plain, ...rest }: CardProps) {
  const spot = useSpotlight();
  return (
    <motion.section
      id={id}
      ref={spot.ref as React.Ref<HTMLElement>}
      variants={plain ? undefined : rise}
      layout="position"
      onPointerMove={isStatic ? undefined : spot.onPointerMove}
      className={cn("glass card", tight && "tight", isStatic && "static", busy && "busy", glow && glow !== "muted" && `ring-${glow}`, className)}
      {...(rest as object)}
    >
      {(title || actions || sub) && (
        <header className="card-head">
          <div className="min-w-0">
            {title && <h2 className="card-title">{title}</h2>}
            {sub && <p className="card-sub">{sub}</p>}
          </div>
          {actions && <div className="flex items-center gap-2 shrink-0 flex-wrap justify-end">{actions}</div>}
        </header>
      )}
      <div className={cn("card-body", bodyClassName)}>{children}</div>
    </motion.section>
  );
}

/* ------------------------------------------------------------ button */

const buttonVariants = cva(
  "inline-flex items-center justify-center gap-1.5 whitespace-nowrap select-none transition-[color,border-color,background-color,box-shadow,opacity] duration-150 disabled:opacity-40 disabled:pointer-events-none [&_svg]:shrink-0",
  {
    variants: {
      variant: {
        primary: "rounded-2 px-4 h-9 text-[13.5px] font-semibold text-on-accent bg-accent shadow-glow hover:brightness-105 disabled:shadow-none",
        ghost: "rounded-2 px-3.5 h-9 text-[13px] font-medium text-ink-2 border border-line hover:text-ink hover:border-line-strong hover:bg-surface-2",
        danger: "rounded-2 px-4 h-9 text-[13.5px] font-semibold text-on-accent bg-bad shadow-[var(--glow-bad)] hover:brightness-105 disabled:shadow-none",
        chip: "chip",
        link: "link",
        icon: "icon-btn",
      },
      size: { md: "", sm: "" },
    },
    compoundVariants: [
      { variant: ["primary", "ghost", "danger"], size: "sm", className: "h-7 px-3 text-[12px]" },
      { variant: "chip", size: "sm", className: "sm" },
    ],
    defaultVariants: { variant: "ghost", size: "md" },
  },
);

export interface ButtonProps extends Omit<React.ButtonHTMLAttributes<HTMLButtonElement>, "onDrag" | "onDragStart" | "onDragEnd" | "onAnimationStart">, VariantProps<typeof buttonVariants> {
  asChild?: boolean;
  on?: boolean;
  tone?: Tone;
}

export const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(({ className, variant, size, asChild, on, tone, type = "button", children, ...rest }, ref) => {
  const v = variant ?? "ghost";
  const cls = cn(buttonVariants({ variant, size }), on && "on", tone && v === "chip" && `tone-${tone}`, on && v === "icon" && "on", className);
  if (asChild) return <Slot className={cls} ref={ref} {...(rest as object)}>{children}</Slot>;
  const still = rest.disabled || v === "link";
  return (
    <motion.button
      ref={ref}
      type={type}
      className={cls}
      whileTap={still ? undefined : { scale: 0.96 }}
      whileHover={still || v !== "primary" ? undefined : { y: -1 }}
      transition={snappy}
      {...(rest as object)}
    >
      {children}
    </motion.button>
  );
});
Button.displayName = "Button";

export function IconButton({ icon, label, className, on, dot, ...rest }: Omit<ButtonProps, "children" | "variant"> & { icon: LucideIcon; label: string; dot?: Tone | null }) {
  return (
    <Tip text={label}>
      <Button variant="icon" aria-label={label} className={className} on={on} {...rest}>
        <Icon of={icon} size="md" />
        {dot && <span className={cn("dot", `tone-${dot}`)} />}
      </Button>
    </Tip>
  );
}

/* ------------------------------------------------------------- field */

export function Field({ label, hint, readout, children, className, edited }:
  { label?: ReactNode; hint?: ReactNode; readout?: ReactNode; children: ReactNode; className?: string; edited?: boolean }) {
  return (
    <label className={cn("flex flex-col gap-1.5 min-w-0", edited && "[&_.input]:border-accent", className)}>
      {label && <span className="text-[12px] text-ink-2 font-medium">{label}</span>}
      {children}
      {readout !== undefined && readout !== null && <span className="num text-[13px] text-ink">{readout}</span>}
      {hint && <span className="text-[11.5px] text-ink-3 leading-snug">{hint}</span>}
    </label>
  );
}

/** Raw input. MUST block Backspace/Delete on an empty field: the WebView
    treats it as back-navigation. */
export const Input = React.forwardRef<HTMLInputElement, React.InputHTMLAttributes<HTMLInputElement> & { sans?: boolean; sm?: boolean; edited?: boolean }>(
  ({ className, onKeyDown, sans, sm, edited, ...p }, ref) => (
    <input
      ref={ref}
      className={cn("input", sans && "sans", sm && "sm", edited && "edited", className)}
      onKeyDown={(e) => { if ((e.key === "Backspace" || e.key === "Delete") && !e.currentTarget.value) e.preventDefault(); onKeyDown?.(e); }}
      {...p}
    />
  ));
Input.displayName = "Input";

/** A text box that commits on blur or Enter, and optionally reports every
    keystroke. Keeps its own text so the caret survives a parent re-render. */
export function TextField({ value, onCommit, onLive, placeholder, disabled, className, inputMode, align = "left", title, sans = true, sm }:
  { value: string; onCommit: (text: string) => void; onLive?: (text: string) => void; placeholder?: string; disabled?: boolean; className?: string;
    inputMode?: React.HTMLAttributes<HTMLInputElement>["inputMode"]; align?: "left" | "right"; title?: string; sans?: boolean; sm?: boolean }) {
  const [text, setText] = useState(value);
  const editing = useRef(false);
  useEffect(() => { if (!editing.current) setText(value); }, [value]);
  return (
    <Input type="text" sans={sans} sm={sm} className={cn(align === "right" && "text-right", className)} value={text} placeholder={placeholder} disabled={disabled}
      inputMode={inputMode} title={title} spellCheck={false}
      onFocus={() => { editing.current = true; }}
      onChange={(e) => { setText(e.target.value); onLive?.(e.target.value); }}
      onBlur={() => { editing.current = false; onCommit(text); if (onLive) setText(value); }}
      onKeyDown={(e) => { if (e.key === "Enter") (e.target as HTMLInputElement).blur(); }} />
  );
}

/** A number box: reports every parseable keystroke (or null when cleared),
    snaps its text to the value on blur, steps with the arrow keys. */
export function NumberField({ value, onChange, step = 1, min, max, placeholder, disabled, className, edited, onEnter, sm, align }:
  { value: number | null | undefined; onChange: (v: number | null) => void; step?: number; min?: number; max?: number; placeholder?: string;
    disabled?: boolean; className?: string; edited?: boolean; onEnter?: () => void; sm?: boolean; align?: "left" | "right" }) {
  const show = (v: number | null | undefined) => (v == null || !Number.isFinite(v) ? "" : String(v));
  const [text, setText] = useState(show(value));
  const editing = useRef(false);
  useEffect(() => { if (!editing.current) setText(show(value)); }, [value]);
  const clamp = (n: number) => Math.min(max ?? Infinity, Math.max(min ?? -Infinity, n));
  const digits = Math.max(0, -Math.floor(Math.log10(step)));
  return (
    <Input type="text" inputMode="decimal" sm={sm} edited={edited} className={cn(align === "right" && "text-right", className)} value={text} placeholder={placeholder} disabled={disabled} spellCheck={false}
      onFocus={() => { editing.current = true; }}
      onChange={(e) => {
        const t = e.target.value; setText(t);
        if (t.trim() === "") { onChange(null); return; }
        const n = Number(t); if (Number.isFinite(n)) onChange(n);
      }}
      onBlur={() => { editing.current = false; setText(show(value)); }}
      onKeyDown={(e) => {
        if (e.key === "Enter") { (e.target as HTMLInputElement).blur(); onEnter?.(); }
        if (e.key === "ArrowUp" || e.key === "ArrowDown") {
          e.preventDefault();
          const cur = Number(text) || value || 0;
          const n = +clamp(cur + (e.key === "ArrowUp" ? step : -step)).toFixed(digits);
          setText(String(n)); onChange(n);
        }
      }} />
  );
}

export function Select({ className, sm, ...p }: React.SelectHTMLAttributes<HTMLSelectElement> & { sm?: boolean }) {
  return <select className={cn("input", sm && "sm", className)} {...p} />;
}

export function Check({ checked, onChange, disabled, children, title, className, indeterminate }:
  { checked: boolean; onChange: (v: boolean) => void; disabled?: boolean; children?: ReactNode; title?: string; className?: string; indeterminate?: boolean }) {
  return (
    <label className={cn("inline-flex items-start gap-2.5 select-none", disabled ? "cursor-not-allowed opacity-70" : "cursor-pointer", className)} title={title}>
      <input type="checkbox" className="check-box mt-px" checked={checked} disabled={disabled}
             ref={(el) => { if (el) el.indeterminate = !!indeterminate && !checked; }}
             onChange={(e) => onChange(e.target.checked)} />
      {children && <span className="text-[13px] leading-snug">{children}</span>}
    </label>
  );
}

export function Radio({ checked, onChange, disabled, children, name, className }:
  { checked: boolean; onChange: () => void; disabled?: boolean; children?: ReactNode; name?: string; className?: string }) {
  return (
    <label className={cn("inline-flex items-start gap-2.5 select-none", disabled ? "cursor-not-allowed opacity-70" : "cursor-pointer", className)}>
      <input type="radio" name={name} className="radio mt-px" checked={checked} disabled={disabled} onChange={() => onChange()} />
      {children && <span className="text-[13px] leading-snug">{children}</span>}
    </label>
  );
}

export function Range({ value, min, max, step, onChange, disabled, className }:
  { value: number; min: number; max: number; step: number; onChange: (v: number) => void; disabled?: boolean; className?: string }) {
  const pct = max > min ? Math.max(0, Math.min(100, ((value - min) / (max - min)) * 100)) : 0;
  return <input type="range" className={cn("range", className)} style={{ ["--pct" as string]: pct.toFixed(2) + "%" }}
                min={min} max={max} step={step} value={value} disabled={disabled} onChange={(e) => onChange(Number(e.target.value))} />;
}

/* --------------------------------------------------------- segmented */

export function Segmented<V extends string | number>({ value, options, onChange, className, sm }:
  { value: V; options: { value: V; label: ReactNode; disabled?: boolean; title?: string }[]; onChange: (v: V) => void; className?: string; sm?: boolean }) {
  const id = useId();
  return (
    <div className={cn("seg", className)} role="tablist">
      {options.map((o) => {
        const on = o.value === value;
        return (
          <button key={String(o.value)} type="button" role="tab" aria-selected={on} disabled={o.disabled} title={o.title}
                  className={cn("seg-item", on && "on", sm && "!py-[2px] !px-2.5 !text-[12px]")} onClick={() => onChange(o.value)}>
            {on && <motion.span layoutId={`${id}-pill`} transition={spring} className="seg-pill" />}
            {o.label}
          </button>
        );
      })}
    </div>
  );
}

/* --------------------------------------------------------- labels */

export function Chip({ on, tone, sm, className, children, ...rest }: React.ButtonHTMLAttributes<HTMLButtonElement> & { on?: boolean; tone?: Tone; sm?: boolean }) {
  return <button type="button" className={cn("chip", on && "on", tone && tone !== "muted" && `tone-${tone}`, sm && "sm", className)} {...rest}>{children}</button>;
}

export function Pill({ tone = "muted", children, className, lower, title }: { tone?: Tone; children: ReactNode; className?: string; lower?: boolean; title?: string }) {
  return <span title={title} className={cn("pill", tone, lower && "lower", className)}>{children}</span>;
}

const STATUS_TONE: Record<string, Tone> = {
  ok: "good", solved: "good", done: "good", ready: "good",
  partial: "warn", warn: "warn", stale: "warn", queued: "warn",
  error: "bad", err: "bad", orphan: "bad", failed: "bad",
  running: "info", run: "info",
  info: "accent",
  todo: "muted", unchecked: "muted",
};
export const statusTone = (status: string): Tone => STATUS_TONE[status] || "muted";

export function Badge({ status, children, className, title, lower }: { status: string; children?: ReactNode; className?: string; title?: string; lower?: boolean }) {
  return <Pill tone={statusTone(status)} className={className} title={title} lower={lower}>{children ?? STATUS_TEXT[status] ?? status}</Pill>;
}

export function Dot({ tone = "muted", className }: { tone?: Tone; className?: string }) {
  return <span className={cn("dot", `tone-${tone}`, className)} />;
}

export function Kbd({ children }: { children: ReactNode }) {
  return <span className="kbd">{children}</span>;
}

export function Empty({ children, className }: { children: ReactNode; className?: string }) {
  return <p className={cn("text-ink-3 text-[12.5px]", className)}>{children}</p>;
}

export function Skeleton({ className, lines = 1, height }: { className?: string; lines?: number; height?: number }) {
  if (lines === 1) return <div className={cn("skeleton h-4", className)} style={height ? { height } : undefined} aria-hidden="true" />;
  return <div className={cn("flex flex-col gap-2", className)} aria-hidden="true">{Array.from({ length: lines }, (_, i) => <div key={i} className="skeleton h-4" style={{ width: `${100 - (i % 3) * 12}%` }} />)}</div>;
}

/* ------------------------------------------------------------ stats */

export function Stat({ label, value, unit, sub, tone, wide, text, className, title }:
  { label: string; value: ReactNode; unit?: ReactNode; sub?: ReactNode; tone?: "ok" | "warn" | "bad" | "err" | "accent" | null; wide?: boolean; text?: boolean; className?: string; title?: string }) {
  if (unit && typeof unit === "string" && unit.length > 12 && !sub) { sub = unit; unit = undefined; }
  const t = tone === "err" ? "bad" : tone;
  return (
    <div className={cn("stat", t, wide && "col-span-2", className)} title={title ?? (typeof sub === "string" ? sub : undefined)}>
      <div className="stat-label" title={label}>{label}</div>
      <div className={cn("stat-value", text && "text")}><span className="stat-num">{value}</span>{unit ? <span className="stat-unit">{unit}</span> : null}</div>
      {sub ? <div className="stat-sub">{sub}</div> : null}
    </div>
  );
}
export function StatGrid({ children, className }: { children: ReactNode; className?: string }) { return <div className={cn("stat-grid", className)}>{children}</div>; }
export function StatRow({ children, className }: { children: ReactNode; className?: string }) { return <div className={cn("stat-row", className)}>{children}</div>; }

export function KV({ pairs, className }: { pairs: (readonly [ReactNode, ReactNode] | null | false | undefined)[]; className?: string }) {
  return (
    <dl className={cn("grid grid-cols-[max-content_1fr] gap-x-5 gap-y-1.5 text-[13px] m-0", className)}>
      {pairs.filter(Boolean).map((p, i) => { const [k, v] = p as [ReactNode, ReactNode]; return <div key={i} className="contents"><dt className="text-ink-2">{k}</dt><dd className="m-0 min-w-0 break-words">{v}</dd></div>; })}
    </dl>
  );
}

/** Springs from whatever it last showed to the new value. */
export function AnimatedNumber({ value, format, className }: { value: number; format: (v: number) => string; className?: string }) {
  const mv = useMotionValue(value);
  const sprung = useSpring(mv, soft);
  const text = useTransform(sprung, (v) => format(v));
  const first = useRef(true);
  useEffect(() => {
    if (first.current || reducedMotion() || !Number.isFinite(value)) { first.current = false; mv.jump(value); return; }
    mv.set(value);
  }, [value, mv]);
  return <motion.span className={cn("num", className)}>{text}</motion.span>;
}

/** A bar whose width springs to the fraction. */
export function Bar({ fraction, tone, className, height = 7, indeterminate }:
  { fraction?: number; tone?: "accent" | "warn" | "bad" | "good" | "info"; className?: string; height?: number; indeterminate?: boolean }) {
  const pct = Math.max(0, Math.min(fraction ?? 0, 1)) * 100;
  return (
    <div className={cn("track", indeterminate && "indeterminate", className)} style={{ height }} role="progressbar" aria-valuenow={indeterminate ? undefined : Math.round(pct)}>
      {indeterminate ? <div className={cn("fill", tone && tone !== "accent" && tone)} />
        : <motion.div className={cn("fill", tone && tone !== "accent" && tone)} initial={false} animate={{ width: pct + "%" }} transition={{ type: "spring", stiffness: 120, damping: 24 }} />}
    </div>
  );
}

/** A live dot: breathes while something is happening. */
export function LiveDot({ tone = "accent", className }: { tone?: "accent" | "good" | "warn" | "info" | "bad"; className?: string }) {
  const color = `var(--${tone})`;
  return (
    <span className={cn("relative inline-flex w-2.5 h-2.5 shrink-0", className)}>
      <motion.span className="absolute inset-0 rounded-full" style={{ background: color }}
        animate={{ scale: [1, 2.2], opacity: [0.6, 0] }} transition={{ duration: 1.6, repeat: Infinity, ease: "easeOut" }} />
      <span className="relative rounded-full w-2.5 h-2.5" style={{ background: color }} />
    </span>
  );
}

/* --------------------------------------------------------- problems */

const PROBLEM_ICON: Record<string, LucideIcon> = { err: AlertOctagon, warn: AlertTriangle, ok: CheckCircle2, info: Info, note: Info };
export function Problem({ tone = "info", children, className, icon }: { tone?: "info" | "ok" | "warn" | "err" | "note"; children: ReactNode; className?: string; icon?: LucideIcon | null }) {
  const I = icon === null ? null : icon ?? PROBLEM_ICON[tone];
  return (
    <div className={cn("problem", tone, className)} role={tone === "err" ? "alert" : undefined}>
      {I && <span className="problem-icon"><Icon of={I} size="md" /></span>}
      <div className="problem-body">{children}</div>
    </div>
  );
}

/* ----------------------------------------------------------- tooltip */

export const TooltipProvider = T.Provider;
export function Tip({ text, children, side }: { text: ReactNode; children: React.ReactElement; side?: "top" | "bottom" | "left" | "right" }) {
  if (!text) return children;
  return (
    <T.Root delayDuration={300}>
      <T.Trigger asChild>{children}</T.Trigger>
      <T.Portal><T.Content side={side} sideOffset={6} className="tip glass-strong">{text}</T.Content></T.Portal>
    </T.Root>
  );
}

/* ------------------------------------------------------------ dialog */

export function Dialog({ open, onOpenChange, title, children, className }: { open: boolean; onOpenChange: (v: boolean) => void; title: string; children: ReactNode; className?: string }) {
  return (
    <D.Root open={open} onOpenChange={onOpenChange}>
      <AnimatePresence>
        {open && (
          <D.Portal forceMount>
            <D.Overlay asChild forceMount>
              <motion.div className="dialog-overlay" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={{ duration: 0.18 }} />
            </D.Overlay>
            <D.Content asChild forceMount>
              <motion.div className={cn("dialog glass-strong", className)}
                          initial={{ opacity: 0, scale: 0.96, x: "-50%", y: "-48%" }} animate={{ opacity: 1, scale: 1, x: "-50%", y: "-50%" }}
                          exit={{ opacity: 0, scale: 0.98, x: "-50%", y: "-50%" }} transition={spring}>
                <D.Title className="text-[16px] font-semibold mb-2">{title}</D.Title>
                {children}
              </motion.div>
            </D.Content>
          </D.Portal>
        )}
      </AnimatePresence>
    </D.Root>
  );
}

/** window.confirm replacement */
export function ConfirmDialog({ open, onOpenChange, title, body, okLabel = "OK", danger, onOk }:
  { open: boolean; onOpenChange: (v: boolean) => void; title: string; body: ReactNode; okLabel?: string; danger?: boolean; onOk: () => void }) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange} title={title}>
      <div className="text-[13px] text-ink-2 mb-4 leading-relaxed">{body}</div>
      <div className="flex justify-end gap-2">
        <Button variant="ghost" onClick={() => onOpenChange(false)}>Cancel</Button>
        <Button variant={danger ? "danger" : "primary"} onClick={() => { onOpenChange(false); onOk(); }}>{okLabel}</Button>
      </div>
    </Dialog>
  );
}

/* -------------------------------------------------------------- tabs */

const TabsCtx = createContext<{ id: string; value: string }>({ id: "", value: "" });

export function Tabs({ value, defaultValue, onValueChange, children, className }:
  { value?: string; defaultValue?: string; onValueChange?: (v: string) => void; children: ReactNode; className?: string }) {
  const id = useId();
  const [inner, setInner] = useState(defaultValue ?? "");
  const cur = value ?? inner;
  const change = (v: string) => { setInner(v); onValueChange?.(v); };
  return (
    <TabsCtx.Provider value={{ id, value: cur }}>
      <TabsPrimitive.Root value={cur} onValueChange={change} className={className}>{children}</TabsPrimitive.Root>
    </TabsCtx.Provider>
  );
}
export function TabsList({ className, ...p }: TabsPrimitive.TabsListProps) {
  return <TabsPrimitive.List className={cn("seg flex-wrap", className)} {...p} />;
}
export function TabsTrigger({ className, extra, children, value, ...p }: TabsPrimitive.TabsTriggerProps & { extra?: ReactNode }) {
  const { id, value: cur } = useContext(TabsCtx);
  const on = cur === value;
  return (
    <TabsPrimitive.Trigger value={value} className={cn("seg-item", on && "on", className)} {...p}>
      {on && <motion.span layoutId={`${id}-tab-pill`} transition={spring} className="seg-pill" />}
      {children}
      {extra != null && extra !== "" && extra !== 0 ? <span className={cn("pill lower", on ? "accent" : "muted")}>{extra}</span> : null}
    </TabsPrimitive.Trigger>
  );
}
export const TabsContent = TabsPrimitive.Content;

/* --------------------------------------------------------- drop zone */

export function DropZone({ over, children, className }: { over?: boolean; children: ReactNode; className?: string }) {
  return <div className={cn("drop-zone", over && "over", className)}>{children}</div>;
}
