/* Motion constants. Entrance, state change and live activity only; hover
   and press are CSS. Nothing here animates filter or the scale of text.
   Under prefers-reduced-motion every entrance is instant. */
import type { Transition, Variants } from "motion/react";

export function reducedMotion(): boolean {
  return typeof window !== "undefined" && !!window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
}
export const RM = reducedMotion();
const instant: Transition = { duration: 0 };

export const spring: Transition = RM ? instant : { type: "spring", stiffness: 300, damping: 30 };
export const soft: Transition = RM ? instant : { type: "spring", stiffness: 120, damping: 22, mass: 0.6 };
export const snappy: Transition = RM ? instant : { type: "spring", stiffness: 500, damping: 30 };

export const stagger: Variants = {
  hidden: {},
  show: { transition: RM ? { staggerChildren: 0, delayChildren: 0 } : { staggerChildren: 0.055, delayChildren: 0.04 } },
};

export const rise: Variants = {
  hidden: RM ? { opacity: 1, y: 0 } : { opacity: 0, y: 14 },
  show: { opacity: 1, y: 0, transition: RM ? instant : { type: "spring", stiffness: 260, damping: 26 } },
};

export const fade: Variants = {
  hidden: RM ? { opacity: 1 } : { opacity: 0 },
  show: { opacity: 1, transition: RM ? instant : { duration: 0.18 } },
};
