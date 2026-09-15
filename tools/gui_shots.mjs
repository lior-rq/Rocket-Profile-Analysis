#!/usr/bin/env node
// Visual + console check of the GUI in headless Chrome (DevTools protocol).
//
//   node tools/gui_shots.mjs [outdir] [--url http://127.0.0.1:8799/] [--check]
//                            [--only name,name] [--width 1440]
//
// Every page and tab is opened, console errors are collected and, unless
// --check, a PNG per page lands in outdir. Exit code 1 when any page logged
// an error or exception. Needs Google Chrome on this Mac and a running GUI.
import fs from 'node:fs';
import { spawn } from 'node:child_process';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';

const args = process.argv.slice(2);
const opt = (name, dflt) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : dflt; };
const CHECK = args.includes('--check');
const OUT = args.find(a => !a.startsWith('--') && args[args.indexOf(a) - 1] !== '--url' && args[args.indexOf(a) - 1] !== '--only' && args[args.indexOf(a) - 1] !== '--width') || 'shots';
const BASE = opt('--url', 'http://127.0.0.1:8799/');
const ONLY = (opt('--only', '') || '').split(',').filter(Boolean);
const WIDTH = Number(opt('--width', 1440));
const CHROME = process.env.CHROME || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const sleep = ms => new Promise(r => setTimeout(r, ms));

const freePort = () => new Promise(res => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); }); });
const port = await freePort();
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'rpa-shots-'));
const chrome = spawn(CHROME, ['--headless=new', `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`, '--window-size=1440,1000', '--no-first-run', 'about:blank'], { stdio: 'ignore' });
let ver = null;
for (let i = 0; i < 50 && !ver; i++) { try { ver = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json(); } catch (e) { await sleep(200); } }
if (!ver) { chrome.kill(); throw new Error('Chrome did not start (set CHROME=/path/to/chrome)'); }

const ws = new WebSocket(ver.webSocketDebuggerUrl);
try {
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = () => rej(new Error('DevTools websocket failed')); setTimeout(() => rej(new Error('DevTools websocket did not open within 15 s')), 15000); });
} catch (e) { chrome.kill(); throw e; }
process.on('uncaughtException', e => { console.log('harness error: ' + e.message); chrome.kill(); process.exit(2); });
let id = 0; const pending = new Map(); const listeners = [];
ws.onmessage = ev => {
  const m = JSON.parse(ev.data);
  if (m.id && pending.has(m.id)) { const { res, rej } = pending.get(m.id); pending.delete(m.id); m.error ? rej(new Error(JSON.stringify(m.error))) : res(m.result); }
  else listeners.forEach(fn => fn(m));
};
const send = (method, params = {}, sessionId) => new Promise((res, rej) => { const i = ++id; pending.set(i, { res, rej }); ws.send(JSON.stringify({ id: i, method, params, sessionId })); });
const { targetId } = await send('Target.createTarget', { url: 'about:blank' });
const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true });
const S = (m, p) => send(m, p, sessionId);
await S('Page.enable'); await S('Runtime.enable'); await S('Log.enable');
const errors = [];
let current = '';
listeners.push(m => {
  if (m.sessionId !== sessionId) return;
  if (m.method === 'Runtime.consoleAPICalled' && ['error', 'warning'].includes(m.params.type)) errors.push({ page: current, type: m.params.type, text: m.params.args.map(a => a.value ?? a.description ?? '').join(' ') });
  if (m.method === 'Runtime.exceptionThrown') errors.push({ page: current, type: 'exception', text: m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text });
  if (m.method === 'Log.entryAdded' && ['error', 'warning'].includes(m.params.entry.level)) errors.push({ page: current, type: 'log-' + m.params.entry.level, text: `${m.params.entry.text} ${m.params.entry.url || ''}` });
});
const evalJs = async expr => (await S('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true })).result.value;

async function shot({ name, hash, setup, theme = 'light', width = WIDTH, maxH = 6000, wait = 4000 }) {
  current = name;
  await S('Emulation.setDeviceMetricsOverride', { width, height: 1000, deviceScaleFactor: 1, mobile: width < 700 });
  await S('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: theme }] });
  await S('Page.navigate', { url: BASE + '#' + hash });
  await sleep(wait);
  await evalJs(`(()=>{try{localStorage.setItem('rpa-theme','auto')}catch(e){};if(window.App){App.theme='auto';applyTheme();}})()`);
  if (setup) { await evalJs(setup); await sleep(2500); }
  const h = await evalJs(`(()=>{const m=document.querySelector('.main');return Math.min(${maxH}, 56 + (m ? m.scrollHeight : 800) + 48)})()`);
  const overflow = await evalJs(`document.documentElement.scrollWidth > document.documentElement.clientWidth`);
  if (overflow) errors.push({ page: name, type: 'layout', text: 'horizontal page overflow' });
  if (!CHECK) {
    await S('Emulation.setDeviceMetricsOverride', { width, height: Math.max(700, h), deviceScaleFactor: 1, mobile: width < 700 });
    await sleep(1000);
    const { data } = await S('Page.captureScreenshot', { format: 'png' });
    fs.mkdirSync(OUT, { recursive: true });
    fs.writeFileSync(`${OUT}/${name}.png`, Buffer.from(data, 'base64'));
  }
  process.stdout.write(`${name}\n`);
}

const SHOTS = [
  { name: 'overview', hash: 'overview' },
  { name: 'overview-dark', hash: 'overview', theme: 'dark' },
  { name: 'inputs-vehicle', hash: 'inputs' },
  { name: 'inputs-motors', hash: 'inputs', setup: `App.ps.inputs.tab='motors'; render(true)` },
  { name: 'inputs-mass', hash: 'inputs', setup: `App.ps.inputs.tab='mass'; render(true)` },
  { name: 'inputs-target', hash: 'inputs', setup: `App.ps.inputs.tab='target'; render(true)` },
  { name: 'aero', hash: 'aero' },
  { name: 'reference', hash: 'reference' },
  { name: 'validate', hash: 'validate' },
  { name: 'optimize', hash: 'optimize' },
  { name: 'results-designs', hash: 'results', wait: 7000 },
  { name: 'results-designs-dark', hash: 'results', theme: 'dark', wait: 7000 },
  { name: 'results-matrix', hash: 'results', setup: `App.ps.results.tab='matrix'; render(true)` },
  { name: 'results-tradespace', hash: 'results', setup: `App.ps.results.tab='tradespace'; render(true)` },
  { name: 'results-shortlist', hash: 'results', setup: `App.ps.results.tab='shortlist'; render(true)`, wait: 5000 },
  { name: 'results-previous', hash: 'results', setup: `App.ps.results.tab='previous'; render(true)` },
  { name: 'results-eligibility', hash: 'results', setup: `App.ps.results.tab='eligibility'; render(true)` },
  { name: 'results-characterization', hash: 'results', setup: `App.ps.results.tab='characterization'; render(true)` },
  { name: 'results-plots', hash: 'results', setup: `App.ps.results.tab='plots'; render(true)` },
  { name: 'results-report', hash: 'results', setup: `App.ps.results.tab='report'; render(true)`, maxH: 4000 },
  { name: 'confirm', hash: 'confirm' },
  { name: 'worker', hash: 'worker' },
  { name: 'runs', hash: 'runs' },
  { name: 'activity-open', hash: 'overview', setup: `App.collapsed=false; renderActivity()` },
  { name: 'overview-narrow', hash: 'overview', width: 860 },
  { name: 'overview-phone', hash: 'overview', width: 400 },
];
const PAGE_TIMEOUT = Number(opt('--timeout', 60000));
for (const s of SHOTS) {
  if (ONLY.length && !ONLY.includes(s.name)) continue;
  try {
    await Promise.race([shot(s), new Promise((_, rej) => setTimeout(() => rej(new Error(`no answer from the page within ${PAGE_TIMEOUT / 1000} s`)), PAGE_TIMEOUT))]);
  } catch (e) { errors.push({ page: s.name, type: 'harness', text: e.message }); process.stdout.write(`${s.name} FAILED: ${e.message}\n`); }
}
try { await send('Target.closeTarget', { targetId }); } catch (e) { /* closing */ }
ws.close();
const exited = new Promise(r => chrome.on('exit', r));
chrome.kill();
await Promise.race([exited, sleep(5000)]);
try { fs.rmSync(profile, { recursive: true, force: true }); } catch (e) { /* Chrome may still hold it */ }
if (errors.length) {
  console.log(`\n${errors.length} problem(s):`);
  for (const e of errors) console.log(`  [${e.page}] ${e.type}: ${e.text}`);
  process.exit(1);
}
console.log('\nno console errors');
