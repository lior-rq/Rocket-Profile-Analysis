import { chromium } from "@playwright/test";
const out = process.argv[2];
const b = await chromium.launch(); const p = await b.newPage({ viewport: { width: 1440, height: 900 } });
await p.goto("http://127.0.0.1:8799/results"); await p.waitForTimeout(2500);
const hs = [];
for (let i = 0; i < 8; i++) { hs.push(await p.evaluate(() => { const fc = document.querySelector(".flight-config"); const asc = document.querySelector(".ascent-svg"); const svg = asc && asc.querySelector("svg"); return fc ? [Math.round(fc.getBoundingClientRect().height), asc ? Math.round(asc.getBoundingClientRect().height) : -1, svg ? svg.getAttribute("height") : "-", asc ? Math.round(asc.getBoundingClientRect().width) : -1] : null; })); await p.waitForTimeout(250); }
console.log("flight-config heights over 2 s [card, ascent div, svg height attr, ascent width]:", JSON.stringify(hs));
await p.locator("main").evaluate((el) => { el.scrollTop = 900; }); await p.waitForTimeout(500);
await p.screenshot({ path: `${out}/player.png` });
await p.locator("main").evaluate((el) => { el.scrollTop = 1500; }); await p.waitForTimeout(500);
await p.screenshot({ path: `${out}/player2.png` });
await b.close();
