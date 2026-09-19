/* The only file allowed to name colours. Everything drawn on a canvas
   resolves a token here; CSS and SVG use var(--name) directly. */

export const css = (name: string): string =>
  (typeof document !== "undefined" ? getComputedStyle(document.documentElement).getPropertyValue(name).trim() : "") || "";

/** A token for a canvas: the computed colour. */
export const tok = (name: string): string => css(name);
/** A token for CSS or SVG: the variable reference. */
export const v = (name: string): string => `var(${name})`;

export const SERIES = ["--series-1", "--series-2", "--series-3", "--series-4", "--series-5", "--series-6", "--series-7", "--series-8"] as const;
export const series = (i: number) => SERIES[i % SERIES.length];

export const STATUS_TOKENS: Record<string, string> = {
  solved: "--status-solved", overpowered: "--status-over", underpowered: "--status-under", unsolved: "--status-unsolved", infeasible: "--status-none",
};
export const statusToken = (status: string) => STATUS_TOKENS[status] || "--status-none";

export const EVENT_TOKENS = {
  liftoff: "--ev-liftoff", burnout: "--ev-burnout", separation: "--ev-sep", ignition: "--ev-ign", sustainer_burnout: "--ev-sus-burnout", apogee: "--ev-apogee",
} as const;

export const PHASE_TOKENS: Record<string, string> = {
  boost: "--phase-boost", sep_delay: "--phase-sep", ign_delay: "--phase-ign", sustain: "--phase-sustain", coast: "--phase-coast",
};

/** Bumps when the theme flips, so canvases re-read their tokens. */
export function onThemeChange(fn: () => void): () => void {
  const mo = new MutationObserver((ms) => { if (ms.some((m) => m.attributeName === "data-theme")) fn(); });
  mo.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
  return () => mo.disconnect();
}
