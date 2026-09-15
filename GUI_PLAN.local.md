# GUI review and improvement plan

**Status (2026-09-15): implemented, phases 0-8.** Where the implementation
differs from the text below: G5 needed no new pipeline logging (the python
backend already prints `[i/N]` per batch; the runner now keeps the search
round and the batch progress together); G6 has reveal / discard / delete but
no retry (re-run the step instead - a job's results only matter to the stage
that created it); B3 uses a `worker/worker_status.json` written by the worker
rather than a field inside the launcher's heartbeat; Phase 8's smoke test
runs real headless Chrome (`tests/test_gui_browser.py`, opt-in with
`RPA_BROWSER_TESTS=1`) instead of jsdom. The worker change (v42) reaches the
VM the next time the worker files are pushed (Start VM worker).

Review date: 2026-09-15. Scope: `rpa/gui/` (server, state collector, runner, VM
control, design assets, launcher, yamledit, ~4.9k lines incl. the 2,056-line
`static/app.js`). Method: full code read; 28 headless-Chrome captures of every
page and tab at 1440 / 860 / 400 px in light and dark; browser console
collected; API endpoints timed against the real `output/` (380 designs, 450
pairs, 128 job folders); `tests/test_gui.py` (9 pass) and ruff (clean).

## 1. What already works well

Keep these; the plan builds on them, not around them.

- The step-page shape (summary → action panel with prerequisite chips → data →
  "how it works" → prev/next) is consistent and makes a seven-stage pipeline
  readable to a newcomer.
- Status is derived from files on disk, and the watcher → SSE `changed` event
  keeps every open tab current without a reload.
- `yamledit` edits `config.yaml` in place with comments kept; the sticky
  unsaved-changes bar and dirty-field highlighting are right.
- The results flight player (vehicle drawing, staging timeline with zoom lens,
  ascent track, thrust lanes, verified/estimated time history) is the best part
  of the app and works in both themes.
- Light/dark theming is complete; charts are token-based and legible in both.
- `/api/flight` (on-demand python flight, ~30 ms) means a history exists for
  any design even without `verify` - this unlocks several items below.

## 2. Findings

Severity: **bug** (wrong or misleading), **perf** (slow or wasteful), **gap**
(something the workflow needs and cannot do), **polish** (layout, copy, a11y).

### 2.1 Bugs and misleading information

| # | Finding | Where | Evidence |
|---|---------|-------|----------|
| B1 | Vehicle drawing emits an invalid `<polygon>` (NaN points) at some widths. `t = x / L` can exceed 1 by float error, then `Math.acos(1 - 2t)` is NaN for Haack noses; the nose base point is dropped. | `app.js` `noseProfile()` L1293 | Console: `<polygon> attribute points: Expected number, "…144.8,NaN 144.8,NaN"`. 431 of 35,000 sampled lengths reproduce it. |
| B2 | Motor picker marks the max-impulse sustainer as **used**, but in `span` mode five other sustainers are flown (59-, 20-, 04-, 21-, 50-) and the marked one is not among them. | `pages.inputs` motorsTab L638 (`highlight: m.sustainer.label`) | Inputs › Motors capture |
| B3 | Worker state is wrong with the agent transport. State is derived from `claimed`/`done.json` in the Mac's `jobs/`, but the claim marker is written in `C:\rpa\jobs` only, so a running job shows as *queued* and *0 running*; orphan folders never pushed (e.g. `0120-aero-stack_alt20000_noz2.77`) count as waiting forever and tip the state to *unresponsive* whenever the heartbeat pull is late. | `state.py` `worker_status()` L596-655, `job_info()` L656 | Console showed the worker inside job 0129 while the page said "0 running, 2 waiting"; earlier the same page said "unresponsive · 2 jobs waiting 45,466 s". |
| B4 | The separation step the user types is silently overridden. `separation_grid()` caps the grid at 9 points, so the configured 0.1 s step over 0.5-5 s becomes 0.5625 s. The GUI shows the field and hint ("at most 9 points") but not the effective grid, and the run summary claims the configured step. | `search.py` `separation_grid()` L91; Inputs › Target & rules; `pages.optimize` summary | config.yaml `separation_step_s: 0.1`, window 0.5-5 |
| B5 | Staleness is over-eager. `inputs_mtime` includes `config.yaml`'s mtime, so saving any key (`vm.*`, `worker.*`, `ranking.*`, a comment) flags motors/characterize/search as *out of date* and the overview says "inputs changed since it last ran". Nothing tells the user *what* changed. | `state.py` `collect()` L201 | Overview shows step 5 out of date right after a check/mass run |
| B6 | Copy contradicts measurements: overview "How to use" says the optimizer takes "about a minute for 60 boosters"; the last full run took 18 m 30 s (90 boosters × 5 sustainers, 0.1 s steps) and the optimize page itself shows that. | `pages.overview` L473 | Recent runs list |
| B7 | `designs.csv` appears twice in Optimize › Output files (listed under both `search` and `verify`). | `state.py` `RUN_SUBSTAGES` L21 | Optimize capture |
| B8 | Characterization chart x-axis is "booster #" 1…450; since the sustainer became a search dimension the points are (booster, sustainer) pairs, so the chart reads as noise. | `pages.results` characterization tab | Results › Characterization capture |
| B9 | Two GUI processes on the same repo do not know about each other's runs (`choose_port` only reuses the *preferred* port). A second instance shows *idle* while the first runs a 20-minute optimize. | `launcher.py` `choose_port()` | Observed during this review (8765 running, 8799 idle) |
| B10 | Header breaks at phone width: the brand title truncates to "Analysis", pills wrap under it. Low priority for a desktop tool but a two-line CSS fix. | `app.css` `.brand` L118 | 400 px captures |

### 2.2 Performance and data volume

Measured against the current `output/`:

| Endpoint / file | Size | Time | Used by |
|-----------------|------|------|---------|
| `/api/samples` | 6.5 MB | 0.23 s | every design detail (one key of ~380 needed) |
| `/api/table/search_rows` | 168 MB JSON (70 MB CSV) | 2.5 s | nothing in the UI |
| `/api/report` | 341 KB markdown | - | Results › Report, rendered to a 23,000 px page |
| `/api/state` | 57 KB (24.5 KB is `worker`) | 0.02 s | every poll and every `changed` event |
| `output/histories/` | 571 MB, 391 files | - | flight player (`--include-unsolved` default on) |
| `jobs/` | 346 MB, 128 folders | - | worker page (60 shown) |

- P1 `designDetail` fetches the whole 6.5 MB `designs_samples.json` for one
  chart, and `refresh()` clears `App.cache` on *any* state change (L1990), so
  while a run is going and files change every few seconds the file is
  re-downloaded on each change.
- P2 `search_rows` is exposed in `TABLES` and would serialise 168 MB if hit.
- P3 The report is a 450-row and a 380-row table inline; the regex markdown
  renderer builds one 23,000 px DOM.
- P4 "Keep a full history of the closest design of every booster" is on by
  default in the Optimize page (`unsolved: true`, L927) → 380 histories,
  571 MB. `/api/flight` already simulates any design on demand, so the default
  is no longer needed. No disk-usage indicator or cleanup exists for
  histories, jobs, or search_rows.
- P5 `App._watch` runs the VM heartbeat/console pull (utmctl exec, 15 s + 30 s
  timeouts) in the same loop as the file-signature check, so file-change events
  can stall for up to ~45 s while a pull hangs.
- P6 `worker.console_tail` (60 lines) and 60 job rows ride along in every
  `/api/state` even on pages that do not show them.

### 2.3 Workflow gaps

- G1 **Results are for deciding, and the table is the wrong shape for it.**
  380 rows of (booster, sustainer, profile); every booster appears five times.
  There is no booster × sustainer view, no scatter of the trade space (apogee
  vs Mach at separation / velocity at ignition), no numeric filters, no column
  chooser (19 columns need horizontal scrolling with the booster name off
  screen), and no CSV export of the filtered view.
- G2 **No shortlist or comparison.** You can look at one design at a time.
  Nothing lets you pin a few, compare them side by side (stats + overlaid
  histories), or send *those* to RASAero: `confirm` only takes `--top N`.
- G3 **A fresh run erases the previous results for the whole run.** Observed
  mid-review: Results said "No results yet - run the optimizer" for ~20
  minutes. The previous run is gone unless archived by hand (which the user
  already does into `output-archive/`).
- G4 **Run logs are not persisted.** The activity log lives in the server
  process; `gui_runs.json` keeps only exit codes, so a "failed (exit 1)" `rpa
  aero --fresh` in Recent runs has no log after a restart.
- G5 **No ETA for the long stage.** The runner parses `[i/N]` and "round N: M
  rows"; `search` only prints rounds, so the 15-minute stage shows an
  indeterminate bar.
- G6 **Worker page has no job actions.** No discard/retry/reveal per job, no
  bulk cleanup of 128 folders, the failure reason in `done.json` is not shown
  in the table, the console tail is a fixed 60 lines with no follow indicator.
- G7 **Deep links stop at the page.** `#results` loses the tab, the selected
  design and the selected validation case on reload and on Back.
- G8 **No `beforeunload` guard.** Unsaved config edits survive page switches
  (kept in `App.ps`) but not closing the tab.
- G9 **Motor picker cannot see inside a multi-motor file.** The 90-booster
  file is one checkbox; `/api/motors` (impulse, burn time, nozzle per motor)
  exists and is unused. `input/rasaero_reference` (per-case `.eng` copies)
  shows up as a selectable source.
- G10 **No input validation or cost preview.** Windows accept min > max, step
  0, tolerance 0; nothing shows the search size (separation points × ignition
  points × pairs) before Run.
- G11 **Launch-site overrides show `null`** as placeholder; the CDX1 value is
  only in the hint text.
- G12 **A running optimize blocks `check`** for 20 minutes (single subprocess,
  needed for the JVM). Read-only stages could run alongside.

### 2.4 Layout, copy and accessibility

- L1 Tables inside `.split` clip their most important columns at 1440 px:
  Aero (exported), Reference (sep/ign/apogee/max vel), Worker jobs (the state
  badge is cut mid-word), Validate (`pass` and `why` need scrolling).
- L2 Mass tab stat tiles clip their values ("18.9 + 11.9–3…").
- L3 Design-detail stat row: 7 tiles → 6 + 1 orphan.
- L4 Search-samples chart: the "chosen" label collides with the y-axis when
  the chosen delay is the window minimum (true for all 370 overpowered rows).
- L5 Target & rules: 3 + 1 cards; the tall delay-windows card sits alone.
- L6 Overview "How to use" is permanent and long.
- L7 Plots tab: matplotlib PNGs on white in dark mode; `apogee_vs_delay.png`
  is 375 overlapping lines and unreadable at any size.
- L8 Activity panel: fixed 300 px, no resize, no error filter, no copy.
- A1 Nav items, tabs, table rows, step-strip cards and phase chips are `div`s
  with `onclick`: not focusable, no Enter/Space, no `role`/`aria-selected`,
  no visible focus state.
- A2 Lightbox has no Escape; toasts have no `aria-live`; four `window.confirm`
  dialogs (fresh run, stop worker, quit ×2, re-export).
- A3 Flight-player shortcuts (space, ←/→, Home/End) require focusing the card
  and nothing says so.

### 2.5 Code health

- `app.js` is one 2,056-line file (helpers, components, charts, player, nine
  pages, shell, render loop). ES modules would split it with no build step.
- Unused endpoints: `/api/histories`, `/api/text`, `/api/motors`,
  `designs_ranked`; unused-by-UI table `search_rows`.
- ~20 inline `style: { marginTop: … }` objects where utility classes would do.
- The jsdom smoke test exists only in a scratchpad; the CDP screenshot script
  that produced this review is not in the repo either.

## 3. Plan

Phases are ordered by value per hour. Each task names the files, the change,
and how to tell it is done. Effort: S ≤ 1 h, M ≤ half a day, L ≥ a day.

### Phase 0 - quick fixes (one sitting, all S)

- [x] B1 `noseProfile`: use `t = i / n` (never `x / L`) - no NaN at any width.
      Done when the console is clean on Results across 600-1440 px.
- [x] B2 Picker highlight = `inputs.motors.sustainer_selection.selected`
      labels (fallback `ms.sustainer.label` in `best` mode); badge text
      "searched" not "used".
- [x] B7 Dedupe file rows in Optimize › Output files.
- [x] B6 Overview copy: replace "about a minute" with the measured
      `optimize.last_run.elapsed_s` and the pair count.
- [x] B10 `.brand { min-width: 0 }`, hide `.brand-sub` below 700 px, title
      ellipsis.
- [x] G8 `beforeunload` when `pages.inputs` has dirty edits.
- [x] A2 Escape closes the lightbox; `#toasts` gets `aria-live="polite"`.
- [x] G11 Launch-site placeholders show the CDX1 value; overridden fields get
      a "override" chip and a clear (×) button.
- [x] L2 Mass tab: replace the three stat tiles with a `kv` list.
- [x] L3 Design-detail stats: `grid-template-columns: repeat(auto-fit,
      minmax(120px, 1fr))` with a 4-column minimum so 7 tiles sit 4 + 3.
- [x] L4 Marker labels: when `x` is within one label width of the left plot
      edge, anchor the label to the right of the line (same flip rule as the
      right edge).
- [x] L5 Target & rules: two-column card grid.
- [x] L6 Overview "How to use": `<details>` collapsed by default, state in
      `localStorage`.
- [x] G9 Exclude `paths.reference_dir` and `output/` from `options()`'s
      motor tree.

### Phase 1 - truthful status (M each)

- [x] B5 **Config hash instead of mtime.** Pipeline writes
      `output/run_manifest.json` = sha of the physics subset of config
      (`paths.ork/cdx1/boosters/sustainers`, `target`, `profiles`,
      `characterization`, `sustainer_selection`, `launch_site`,
      `surface_finish`, `mass_model`, `python_sim`, `backend`) + input file
      digests, per stage. `collect()` compares hashes and reports the diff
      ("target.apogee_ft 45000 → 44000; 2 booster files changed"). The
      overview "Next" line and the optimize note show the diff.
- [x] B3 **Worker truth from the worker.** `run_worker.py heartbeat()` gains
      `job` `{name, started, step}` (rasaero_worker updates it at each logged
      step). `worker_status()` marks *busy* from the heartbeat; job rows for
      the agent transport take *running* from the heartbeat and *done* from
      `done.zip`/`done.json`. A queued folder older than 10 min with no
      matching push record → state `orphan` (grey badge, not counted as
      waiting, not able to make the worker *unresponsive*).
- [x] B4 **Effective grid preview.** Under the delay-window fields show
      "separation: 9 points, 0.5 → 5.0 s every 0.56 s (your 0.1 s step is
      capped)"; ignition: "96 points". Same numbers in the optimize summary,
      plus a flight count (pairs × profiles × sep points × ign points) and an
      estimate from the last run's rate.
- [x] G5 **Search progress.** `stage_search` logs `[i/N]` per (booster,
      sustainer, profile) group; the runner's existing regex picks it up and
      `eta()` works. Round lines stay as detail.
- [x] B8 Characterization chart: colour by sustainer, x = booster index
      (1…90), one series per sustainer; table gets a sustainer filter.
- [x] B9 `output/gui.lock` `{port, pid, started}` written by `serve()`; a
      second instance for the same root (any port) opens the browser on the
      running one and exits. Remove on shutdown.

### Phase 2 - data volume (S/M)

- [x] P1 `/api/samples?key=…` returns one design's points; server caches the
      parsed file keyed by mtime. Client cache entries carry the mtime from
      `/api/state` (`results.mtime`, `design.history.mtime`) and are only
      dropped when that changes, not on every `changed` event.
- [x] P2 Remove `search_rows` from `TABLES` (or require `limit`).
- [x] P3 Report tab: render headings as a sticky TOC, collapse any table over
      50 rows behind "show all", add "Open report.md" (reveal).
- [x] P4 Default "Keep a full history…" off; when a design has no
      `final-*.csv` the player already uses `/api/flight` (badge
      *estimated*). Add a **Disk** line to the Optimize output-files card:
      histories / jobs / search_rows sizes with "Clear histories" and
      "Delete finished jobs older than 7 days" buttons (`/api/cleanup`,
      confirm inline).
- [x] P5 Move `pull_worker_files` into its own thread with its own interval;
      `_watch` only fingerprints files.
- [x] P6 `/api/state` sends `console_tail` (20 lines) and 20 jobs; the worker
      page fetches `/api/worker` for the full 60/60.

### Phase 3 - results as a decision tool (L)

- [x] G1a **Matrix view** tab on Results: rows = boosters (90), columns =
      sustainers (5) × profile; cell = apogee coloured by status with Δ target
      on hover; click → design detail. Sort rows by best |Δ|.
- [x] G1b **Trade-space scatter**: x = Mach at separation (or velocity at
      ignition, selectable), y = apogee, colour = status, shape = profile,
      target band shaded; hover shows the key; click selects. Built on the
      existing `lineChart` primitives plus a point layer.
- [x] G1c Table upgrades in `dataTable`: sticky first column, column
      chooser (persisted), numeric filters (|Δ target| ≤, Mach@sep ≥,
      max g ≤), "Export CSV" of the filtered rows, row count.
- [x] G2 **Shortlist.** Star button on the detail card and table rows;
      `output/shortlist.json` (shared with the CLI). Compare view: up to
      three designs side by side (stat rows aligned) with overlaid Mach /
      altitude histories from `/api/history` or `/api/flight`. "Confirm
      shortlist in RASAero" → new CLI flag `confirm --designs key,key`
      (`Pipeline.stage_confirm` accepts explicit keys); the Confirm page
      offers *top N* or *shortlist*.
- [x] L7 Replace the Plots tab thumbnails with the interactive charts
      (apogee-vs-delay per profile as small multiples, boost Mach by booster
      coloured by sustainer, final Mach-vs-time for the shortlist); keep PNGs
      as downloads. If PNGs stay: save with `transparent=True` and a
      theme-neutral palette.
- [x] Eligibility tab: "eligible only" toggle and per-profile counts in the
      tab label.

### Phase 4 - runs, logs and history (M)

- [x] G4 Runner writes `output/gui_logs/<started>-<stage>.log`; history rows
      carry the path and the last error line. Recent runs → click opens the
      log in the activity panel (`/api/log?file=`); failed rows show the
      error line inline.
- [x] G3 **Snapshot before fresh.** `--fresh` from the GUI first copies the
      current results (`designs*.csv/json`, `report.md`, plots,
      `characterization.csv`, `eligibility.csv`, `mass_table.csv`,
      `run_manifest.json`) to `output-archive/<started>/`. Results page gets a
      *previous run* selector and a diff card: per booster, status change and
      apogee delta vs the selected archive.
- [x] L8 Activity panel: drag handle for height (persisted), "errors only"
      filter, copy-to-clipboard, per-run separators.
- [x] G7 Route state in the hash: `#results/designs?sel=<key>`,
      `#validate?case=…`, `#inputs/motors`; `go()` and `hashchange` read and
      write it; Back works between tabs.
- [x] G12 Allow `check` (and `report`) while another stage runs: Runner keeps
      a small set of concurrent-safe stages with their own log stream; the
      button title explains the rule.

### Phase 5 - worker and jobs (M)

- [x] G6 Job row actions (menu at the row end): reveal folder, discard
      (queued/orphan → moves the folder to `jobs/_discarded/`), retry failed
      (re-submit the same `job.json`), delete finished. `done.json.message`
      shown as a "why" column for failed jobs; `state` and `why` first,
      `created` last.
- [x] Console: follow toggle, "jump to latest", full log on demand
      (`/api/text?path=worker/console.log` exists), error lines highlighted
      with the same rules as the activity log.
- [x] Worker card shows the current job and its elapsed time (from Phase 1
      heartbeat).

### Phase 6 - accessibility and keyboard (M)

- [x] A1 Nav items, tabs, step-strip cards, phase chips → `<button>` (or
      `role="tab"` + `aria-selected`); table rows get `tabindex="0"` and
      Enter/Space; `:focus-visible` outline using `--accent`.
- [x] A2 Replace `window.confirm` with an inline two-step button ("Re-export
      all 10 tables?" → "Yes, re-export") in the action panel; keep the quit
      confirm as a small modal with focus trap.
- [x] A3 Show the player shortcuts as a `kbd` hint next to the play button;
      focus the card when a design is selected from the table.
- [x] Sortable headers: `<button>` inside `th`, `aria-sort`.

### Phase 7 - layout fixes and code health (S/M)

- [x] L1 `.split` → single column below 1300 px; on Aero/Reference/Validate
      put the chart under the table; Validate shows `pass` and `why` first;
      jobs table drops `rows` and shortens `type`.
- [x] Split `app.js` into ES modules: `core.js` (h, fmt, api, toast),
      `components.js` (stat, kv, dataTable, tabs), `charts.js`,
      `player.js` (flight config), `pages/*.js`, `app.js` (shell, render
      loop). `index.html` loads `app.js` as `type="module"`. No bundler.
- [x] Utility classes (`.mt-2`, `.mb-3`, `.gap-2`) replacing inline style
      objects.
- [x] Drop `/api/histories`, `/api/text` (or wire them), keep `/api/motors`
      for G9.
- [x] G9 Picker: expandable per-file motor table (label, impulse, burn,
      nozzle) from `/api/motors`; optional `paths.exclude_boosters` list so
      single motors inside a multi-motor file can be deselected.
- [x] G10 Field validation (min ≤ max, step > 0, tolerance > 0, count 1-20)
      with inline messages; Save disabled while invalid.

### Phase 8 - tests (S/M)

- [x] Move the jsdom smoke test into `tests/gui_smoke.mjs`; `tests/test_gui.py`
      runs it via `node` when available (skip otherwise). It renders every
      page against a recorded `/api/state` fixture and asserts zero console
      errors.
- [x] Add `tools/gui_shots.mjs` (the CDP capture script used for this review)
      so visual checks are one command: `node tools/gui_shots.mjs shots/`.
- [x] API tests for the new endpoints (`samples?key`, `cleanup`, `worker`,
      `confirm --designs`) and for `run_manifest` staleness.

## 4. Not recommended

- Rewriting the front end in a framework. The hand-rolled `h()` + render loop
  is 2k lines, has no build step, and the problems above are information and
  workflow problems, not framework problems.
- A markdown library for the report; restructuring the report (TOC, collapsed
  tables) is the fix.
- Mobile layouts beyond the header fix; this is a desktop tool next to a VM.
- Any auth, CSRF or hardening work: the server binds to localhost for a
  hobby team.

## 5. Suggested order and rough total

| Phase | Effort | Value |
|-------|--------|-------|
| 0 quick fixes | ~half a day | removes every visible wrong thing |
| 1 truthful status | ~2 days | the GUI stops crying wolf about staleness and the worker |
| 2 data volume | ~1 day | results page stays fast during runs; disk under control |
| 3 results as a decision tool | ~3-4 days | the reason the tool exists |
| 4 runs, logs, history | ~2 days | never lose a run again |
| 5 worker and jobs | ~1 day | |
| 6 accessibility | ~1 day | |
| 7 layout + code health | ~2 days | pays for itself before phase 3 if done first |
| 8 tests | ~1 day | |

Phases 0, 1 and 2 first; then 7's module split before 3 so the new results
views land in their own file.

## Appendix - capture index

Captures were taken from a second server on port 8799 with headless Chrome
driven over CDP (`Emulation.setEmulatedMedia` for the theme, a viewport tall
enough for `.main`'s internal scroll). Pages: overview (light, dark, 860 px,
400 px), inputs (vehicle, motors, mass, target, target-dirty, 400 px), aero
(light, dark), reference, validate, optimize (light, dark), results (designs
light/dark/playing, eligibility, characterization, plots, report, 860 px),
confirm, worker, worker-job, activity-open. One console error (B1); no
horizontal page overflow at any width.
