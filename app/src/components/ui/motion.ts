/* Motion constants. Entrance, state change and live activity only; hover
   and press are CSS. Nothing here animates filter or the scale of text. */
import type { Transition, Variants } from "motion/react";

export const spring: Transition = { type: "spring", stiffness: 300, damping: 30 };
export const soft: Transition = { type: "spring", stiffness: 120, damping: 22, mass: 0.6 };
export const snappy: Transition = { type: "spring", stiffness: 500, damping: 30 };

export const stagger: Variants = {
  hidden: {},
  show: { transition: { staggerChildren: 0.055, delayChildren: 0.04 } },
};

export const rise: Variants = {
  hidden: { opacity: 0, y: 14 },
  show: { opacity: 1, y: 0, transition: { type: "spring", stiffness: 260, damping: 26 } },
};

export const fade: Variants = {
  hidden: { opacity: 0 },
  show: { opacity: 1, transition: { duration: 0.18 } },
};

export function reducedMotion(): boolean {
  return typeof window !== "undefined" && !!window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
}
