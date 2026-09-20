/* Screenshot matrix.
   node e2e/shots.mjs <outdir> [--theme dark|light] [--width 1440] [--reduced]
   [--routes a,b,c] [--port 8799] [--hover] [--drawer] [--delay 60] [--scroll 900] */
import { chromium } from "@playwright/test";
import { mkdirSync } from "node:fs";

const args = process.argv.slice(2);
const out = args.find((a) => !a.startsWith("--")) || "shots";
const opt = (k, d) => { const i = args.indexOf("--" + k); return i >= 0 ? args[i + 1] : d; };
const flag = (k) => args.includes("--" + k);
const theme = opt("theme", "dark"), width = Number(opt("width", 1440)), port = opt("port", process.env.RPA_PORT || "8799");
const delay = Number(opt("delay", 1500)); const host = opt("host", "127.0.0.1");
const ROUTES = (opt("routes", "") || "/,/inputs,/inputs?tab=motors,/inputs?tab=mass,/inputs?tab=target,/optimize,/results,/results?tab=matrix,/results?tab=tradespace,/results?tab=shortlist,/results?tab=customize,/results?tab=eligibility,/results?tab=characterization,/results?tab=plots,/results?tab=previous,/results?tab=report,/confirm,/runs,/engine,/settings,/setup").split(",");
mkdirSync(out, { recursive: true });

const b = await chromium.launch();
const ctx = await b.newContext({ viewport: { width, height: 900 }, colorScheme: theme, reducedMotion: flag("reduced") ? "reduce" : "no-preference" });
await ctx.addInitScript((t) => { try { localStorage.setItem("rpa-theme", t); } catch {} }, theme);
const p = await ctx.newPage();
for (const url of ROUTES) {
  const name = url.replace(/^\//, "").replace(/[/?=&]+/g, "_") || "overview";
  await p.goto(`http://${host}:${port}${url}`);
  await p.waitForTimeout(delay);
  if (flag("drawer")) { const t = p.locator("[data-drawer-toggle]").last(); if (await t.count()) { await t.click(); await p.waitForTimeout(400); } }
  const scroll = Number(opt("scroll", 0));
  if (scroll) { await p.evaluate((y) => window.scrollTo(0, y), scroll); await p.waitForTimeout(400); }
  if (flag("hover")) { const c = p.locator(".card").first(); if (await c.count()) { await c.hover(); await p.waitForTimeout(300); } }
  await p.screenshot({ path: `${out}/${name}-${theme}-${width}${flag("reduced") ? "-reduced" : ""}${scroll ? "-s" + scroll : ""}.png`, fullPage: false });
}
await b.close();
console.log(`wrote ${ROUTES.length} screenshots to ${out}`);
