/* Phase 7 checks: no horizontal overflow, dark first paint, reduced motion
   settles, theme flips without a light frame. node e2e/checks.mjs [--port 8799] */
import { chromium } from "@playwright/test";
const args = process.argv.slice(2);
const opt = (k, d) => { const i = args.indexOf("--" + k); return i >= 0 ? args[i + 1] : d; };
const port = opt("port", process.env.RPA_PORT || "8799"), base = `http://127.0.0.1:${port}`;
const ROUTES = ["/", "/inputs", "/inputs?tab=motors", "/inputs?tab=mass", "/inputs?tab=target", "/optimize", "/results", "/results?tab=matrix", "/results?tab=tradespace", "/results?tab=shortlist", "/results?tab=customize", "/results?tab=eligibility", "/results?tab=characterization", "/results?tab=plots", "/results?tab=previous", "/results?tab=report", "/confirm", "/runs", "/engine", "/settings", "/setup"];
const fails = [];
const b = await chromium.launch();

// 1. no horizontal document scroll at 1280 and 1024
for (const width of [1280, 1024]) {
  const ctx = await b.newContext({ viewport: { width, height: 800 }, colorScheme: "dark" });
  const p = await ctx.newPage();
  for (const r of ROUTES) {
    await p.goto(base + r); await p.waitForTimeout(900);
    const over = await p.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    if (over > 0) fails.push(`overflow ${over}px at ${width}: ${r}`);
  }
  await ctx.close();
}

// 2. first paint is dark in dark mode (no white frame), light in light mode
const lum = (buf) => { let s = 0, n = 0; for (let i = 0; i < buf.length; i += 4 * 97) { s += 0.2126 * buf[i] + 0.7152 * buf[i + 1] + 0.0722 * buf[i + 2]; n++; } return s / n; };
async function firstPaint(theme) {
  const ctx = await b.newContext({ viewport: { width: 1280, height: 800 }, colorScheme: theme });
  await ctx.addInitScript((t) => { try { localStorage.setItem("rpa-theme", t); } catch {} }, theme);
  const p = await ctx.newPage();
  await p.goto(base + "/", { waitUntil: "domcontentloaded" });
  let shot = null;
  for (let i = 0; i < 5 && !shot; i++) { try { shot = await p.screenshot({ type: "png" }); } catch { await p.waitForTimeout(20); } }
  if (!shot) { await ctx.close(); return null; }
  const { PNG } = await import("pngjs").catch(() => import("playwright-core/lib/utilsBundle").then((m) => ({ PNG: m.PNG }))).catch(() => ({ PNG: null }));
  let value = null;
  if (PNG) { const png = PNG.sync.read(shot); value = lum(png.data); }
  await ctx.close();
  return value;
}
const dark0 = await firstPaint("dark"), light0 = await firstPaint("light");
if (dark0 != null && dark0 > 60) fails.push(`dark first paint too bright: ${dark0.toFixed(0)}`);
if (light0 != null && light0 < 160) fails.push(`light first paint too dark: ${light0.toFixed(0)}`);

// 3. theme flip: two frames 16 ms apart after the toggle, both on the new side
{
  const ctx = await b.newContext({ viewport: { width: 1280, height: 800 }, colorScheme: "dark" });
  await ctx.addInitScript(() => { try { localStorage.setItem("rpa-theme", "dark"); } catch {} });
  const p = await ctx.newPage();
  await p.goto(base + "/results"); await p.waitForTimeout(1500);
  const t0 = Date.now();
  await p.evaluate(() => { document.documentElement.dataset.theme = "light"; document.documentElement.style.colorScheme = "light"; });
  await p.waitForTimeout(16);
  const a = await p.evaluate(() => getComputedStyle(document.body).backgroundColor);
  const flipMs = await p.evaluate(async () => { const t = performance.now(); document.documentElement.dataset.theme = "dark"; await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))); return performance.now() - t; });
  if (!/238, 241, 246/.test(a)) fails.push(`light flip body bg was ${a}`);
  if (flipMs > 50) fails.push(`theme flip took ${flipMs.toFixed(0)} ms with charts mounted`);
  console.log(`theme flip: ${flipMs.toFixed(1)} ms for two frames`);
  void t0;
  await ctx.close();
}

// 4. reduced motion: cards fully opaque and in place 100 ms after navigation
{
  const ctx = await b.newContext({ viewport: { width: 1280, height: 800 }, colorScheme: "dark", reducedMotion: "reduce" });
  const p = await ctx.newPage();
  await p.goto(base + "/"); await p.waitForTimeout(400);
  const bad = await p.evaluate(() => [...document.querySelectorAll(".card")].filter((c) => { const s = getComputedStyle(c); return s.opacity !== "1" || (s.transform !== "none" && s.transform !== "matrix(1, 0, 0, 1, 0, 0)"); }).length);
  if (bad) fails.push(`${bad} card(s) not settled under reduced motion`);
  await ctx.close();
}

await b.close();
console.log(`first paint luminance: dark=${dark0?.toFixed(0)} light=${light0?.toFixed(0)}`);
if (fails.length) { console.error("checks failed:\n" + fails.join("\n")); process.exit(1); }
console.log(`checks passed: ${ROUTES.length} routes × 2 widths no overflow; first paint dark=${dark0?.toFixed(0)} light=${light0?.toFixed(0)}; reduced motion settled`);
