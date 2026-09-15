/* Rocket Profile Analysis - local GUI entry point. Talks to rpa/gui/server.py.
   core.js (helpers, state) <- components.js <- charts.js <- player.js <- pages/*.js;
   shell.js owns the sidebar, topbar, activity panel and the render loop. */
import { App, go, render, renderActivity, refresh } from './core.js';
import { applyTheme, init } from './shell.js';
import './pages/overview.js';
import './pages/inputs.js';
import './pages/aero.js';
import './pages/reference.js';
import './pages/validate.js';
import './pages/optimize.js';
import './pages/results.js';
import './pages/confirm.js';
import './pages/worker.js';
import './pages/runs.js';

// for the browser console and tools/gui_shots.mjs
Object.assign(window, { App, go, render, renderActivity, refresh, applyTheme });
init();
