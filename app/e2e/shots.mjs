import { chromium } from "@playwright/test";
const out = process.argv[2];
const b = await chromium.launch(); const p = await b.newPage({ viewport: { width: 1440, height: 900 } });
for (const [name, url, dark] of [["overview", "/", false], ["results", "/results", false], ["inputs", "/inputs?tab=motors", false], ["optimize", "/optimize", true], ["engine", "/engine", true]]) {
  await p.goto("http://127.0.0.1:8799" + url); await p.waitForTimeout(1500);
  if (dark) { await p.evaluate(() => document.documentElement.classList.add("dark")); await p.waitForTimeout(300); }
  await p.screenshot({ path: `${out}/${name}.png`, fullPage: false });
}
await b.close();
