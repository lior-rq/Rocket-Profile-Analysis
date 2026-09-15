# Rocket Profile Analysis

Automates the IREC Propulsion *Flight Sim S.O.P. for Two-Stage Rockets*
(OpenRocket + RASAero II) and turns it into a search: which booster motor and
which staging delays reach a **target apogee** while keeping booster separation
**out of the transonic region**.

## What it decides

Inputs: one OpenRocket model (`.ork`), one RASAero model (`.CDX1`), and the
candidate booster motors and sustainer motors — each given as any mix of
folders and files (`paths.boosters` / `paths.sustainers` in `config.yaml`,
or ticked in the GUI's motor picker): one-motor RASP `.eng` files, a
multi-motor `.eng` holding many motors, or openMotor `.ric` designs (each
simulated once with openMotor's `motorlib` and cached, see `rpa/ric.py` and
the `ric:` section of `config.yaml`). Which sustainer candidates are flown
is `sustainer_selection` in `config.yaml`: `best` (the max-impulse one only),
`span` (a few - `count` - chosen by flying one reference booster under every
candidate and keeping the lowest, highest and evenly spaced apogees; the
sustainers here differ by ~2 % in impulse but their burn time moves apogee by
several percent, in a direction that depends on the coast) or `list`. The
search space is

    booster (90) x sustainer (1-5) x profile type x separation delay x sustainer ignition delay

Two profile types are designed:

| profile      | rule                                                                          |
|--------------|-------------------------------------------------------------------------------|
| `subsonic`   | the attached stack never exceeds Mach 0.9 during boost/coast; separation is then free of the transonic band |
| `supersonic` | the stack exceeds Mach 1.2 and the booster separates while still above Mach 1.2 |

A design margin (`profiles.mach_margin`, default 0.05) is applied to both
limits. An optional third variant, `decel_subsonic` (`--decel-subsonic`), lets a
supersonic booster coast *attached* back below Mach 0.9 and separate subsonic;
it is off by default because it is not one of the two requested profiles (the
attached stack crosses the transonic band twice).

Delays follow RASAero's convention (verified from its exports):
`Booster1SeparationDelay` is measured from booster burnout and
`SustainerIgnitionDelay` from separation. The tool re-checks this from every
exported time history and flags it if the observed events disagree.

## GUI

```
python -m rpa gui                 # or double-click "Rocket Profile Analysis.app" / "Start GUI.command"
```

opens `http://127.0.0.1:8765` (local only, no extra dependencies). Seven
step pages in workflow order, each with the same shape: a one-line summary,
an action panel (prerequisites as ✓/✗ chips, the Run button and its options,
the equivalent command line), the step's data, a collapsed "how this step
works", and previous/next buttons. Step 1 has four tabs — *Vehicle & site*,
*Motors* (a checkbox tree of every `.eng` under `input/`; inside a
multi-motor file single motors can be switched off, `paths.exclude_*`),
*Mass* and *Target & rules* (with the effective delay grids and a validity
check before Save) — and saves into `config.yaml` in place with the comments
kept. Status is derived from the files on disk plus `output/run_manifest.json`,
which records the config and inputs each stage ran with, so a step is only
"out of date" when something it depends on changed (and the page says what).
The page updates itself the moment a file changes (file watcher → server-sent
events), shows live log / progress / ETA / cancel for the running command and
a toast when it finishes; `check` and `report` may run beside a long stage.

Results: sortable, filterable tables with a column chooser and CSV export; a
booster × sustainer **matrix**; a **trade-space** scatter (apogee against Mach
at separation, velocity at ignition, coast, …); a **shortlist** (★ on any
design) compared side by side with the flights overlaid and sent to RASAero
together (`rpa confirm --designs …`); interactive versions of the report
figures; a **Previous runs** diff against the snapshots in `output-archive/`
(one is taken automatically before every fresh run). Clicking a design draws
the vehicle (CDX1 geometry, motors to scale) with a staging timeline you can
step through (space / ← → once the card has focus), and one button downloads
the booster + sustainer combo it was flown with.

The VM worker's state, the job queue (with discard / delete per job) and its
console have their own page, with **Start VM worker / Stop worker** buttons
that boot the UTM VM and start the worker inside it. **Runs & logs** keeps
every command's full log (`output/gui_logs/`) and the result snapshots. The
Optimize page shows the disk taken by histories, jobs and search rows with
one-click cleanup. Deep links (`#results/designs?sel=…`) and Back work
between pages and tabs; light/dark theme toggle in the header. Code in
`rpa/gui/` (stdlib HTTP server + ES-module front end: `core.js`,
`components.js`, `charts.js`, `player.js`, `pages/*.js`, `shell.js`).

Visual check: `node tools/gui_shots.mjs shots/ --url http://127.0.0.1:8765/`
screenshots every page in headless Chrome and fails on console errors
(`--check` skips the PNGs); `RPA_BROWSER_TESTS=1 pytest` runs the same check
against an empty project.

## Pipeline

```
python -m rpa check               # validate the input set (motors, CDX1, aero tables, reference cases)
python -m rpa run                 # everything, python backend (RASAero aero tables + rpa.flightsim, Mac only)
python -m rpa run --backend rasaero        # same pipeline through the RASAero GUI in the VM (slow; tool of record)
python -m rpa run --backend openrocket     # preview: same pipeline through OpenRocket headless
python -m rpa <motors|mass|characterize|search|verify|report>   # one stage (outputs are cached in output/)
```

### Backends

* **python** (default) – `rpa/flightsim.py`, a planar 3-DOF gravity-turn
  integrator that uses RASAero's *own* aerodynamic tables (exported once per
  vehicle revision from *Aero Plots* into `input/aero/`, see
  `input/aero/README.md`), RASAero's launch-site atmosphere conventions, the
  `.eng` curves and the OpenRocket mass numbers. ~25 ms per flight, and search
  batches are spread over the CPU cores (`python_sim.workers`, default
  cores − 1), so a full 60-booster run takes about 20 s on the Mac. It is only
  as good as its agreement with RASAero, which is measured, not assumed:

  ```
  python -m rpa aero                   # export the Aero Plots tables via the VM into input/aero/ (once per vehicle revision)
  python -m rpa reference --cases 10   # export ~10 RASAero flights via the VM into input/rasaero_reference/
  python -m rpa validate               # compare term by term; overlays + validation.csv in output/validation/
  ```
  `reference`/`validate` also recover RASAero's air-density profile from the
  exports (`input/rasaero_reference/density_calibration.csv`), which the
  python backend then uses (`python_sim.density_model: auto`). Each reference
  case keeps copies of the motors it flew, so validation survives motor-folder
  changes.
  `validate` checks the atmosphere (Mach from RASAero's own velocity/altitude),
  the CD lookup, the drag reconstruction, the weight history, and the flight
  numbers (apogee within `validation.apogee_tol_pct`, Mach at burnout within
  `validation.mach_at_burnout_tol`). Re-run it whenever the vehicle, the aero
  tables or the integrator change.
  Validation status for this vehicle (2026-09-13, 8 reference flights):
  7/8 within 0.16 % in apogee and 0.003 in Mach at burnout; the eighth is
  a degenerate case that lights the sustainer at 90 ft/s at the coast
  apogee (−1.2 %). The conventions that had to be matched to get there
  are documented in `rpa/flightsim.py` and `rpa/atmosphere.py` (ignition
  delay counted from separation, altitude thrust correction, RASAero's
  density profile, gravity not projected onto the rail, no ignition after
  apogee).
* **rasaero** – the RASAero GUI driven through the VM worker (job folder).
  Used for the aero-table exports (`rpa aero`), the reference flights
  (`rpa reference`) and the final confirmation run of the chosen designs:

  ```
  python -m rpa confirm --top 5      # re-run the designs closest to target in RASAero, compare apogees (output/confirm.csv)
  ```
* **openrocket** – OpenRocket headless; different aero, preview only.

1. **motors** – parse the `.eng` files, stage every booster and sustainer
   candidate into `output/motors/` (+ `all_motors.eng` for RASAero's *Select
   Motor File*).
2. **mass** – pick the sustainers to search (`sustainer_selection`, cached in
   `output/sustainers_selected.json`), then SOP figures 7–10: sustainer-only
   and combined loaded weight / CG for every (booster, sustainer) pair, using
   OpenRocket 24.12 headless (`output/mass_table.csv`).
   The `.ork` supplies the mass *distribution* (dry-mass split between the
   stages, CGs, motor positions); the absolute dry mass comes from
   `mass_model.hardware_mass_lb` (default **180 lb** = the whole two-stage
   vehicle without propellant): both stages' dry masses are scaled to it and
   the `.eng` propellant masses are added on top (`rpa/massmodel.py`). Set it
   to `null` to use the `.ork` masses unchanged. A `manual` mass model is also
   available in `config.yaml`. The mass table records which hardware mass it
   was built with and is recomputed when the setting changes.
3. **characterize** – one long-coast RASAero run per booster (separation and
   ignition 15 s after burnout) and a full *View Data* export. From the Mach
   history of the attached stack: peak boost Mach, Mach at burnout, how long
   after burnout the stack drops below Mach 1.2 / 0.9, rail-exit velocity →
   which profiles each booster is eligible for and the separation delay to
   use (`output/characterization.csv`, `output/eligibility.csv`).
4. **search** – for every eligible (booster, profile) and every separation
   delay on a grid across the allowed window (`profiles.separation_delay_min_s`
   … `separation_delay_max_s`, step `separation_step_s`, narrowed per booster
   by the profile's Mach rule): sweep the sustainer ignition delay on a coarse
   grid (`ignition_delay_min_s` … `ignition_delay_max_s`, one batched CDX1 per
   round; RASAero writes `MaxAltitude` back on save), find every bracket where
   apogee crosses the target and refine with regula-falsi until within
   `target.tolerance_ft`. Apogee vs. coast time is **not monotonic** here
   (longer coast → sustainer burns in thinner air → higher apogee, until
   gravity losses win), which is why brackets are used instead of a single
   bisection. The best candidate per (booster, profile) is kept — solved
   first, then the smallest miss, then the shortest coast (highest velocity at
   ignition) — into `output/designs.csv` (`output/search_rows.csv` has every
   simulation). Both delays follow RASAero's convention (separation after
   burnout, ignition after separation) and both minimums are floored at 0, so
   **ignition can never occur before burnout**.
5. **verify** – full time-history export of each solution; actual Mach at
   separation, velocity/Mach/altitude at ignition, max accel, time to apogee,
   and a pass/fail against the profile rule and the apogee tolerance.
6. **report** – `output/report.md`, `output/designs_ranked.csv` (ranked by
   `ranking.metric`, default velocity at sustainer ignition, i.e. the most
   robust ignition), and plots (`apogee_vs_delay.png`, `boost_mach.png`,
   `final_mach_vs_time.png`).

Useful flags: `--target 45000`, `--tolerance 100`, `--boosters 01,31,60`,
`--limit 5`, `--worker-mode manual`, `--fresh`, `--include-unsolved`.

## RASAero II in the Windows VM

RASAero II is Windows-only and GUI-only. The pipeline talks to it through job
folders: it writes `jobs/NNNN-name/{job.json,input.CDX1}` and waits for
`result.CDX1` (+ `export.csv` for history exports) and `done.json`. By default
the folder travels through UTM's guest agent (`worker.transport: agent` —
pushed into `C:\rpa\jobs` in the VM, results pulled back as a zip; no shared
drive involved); the `Z:` WebDAV share remains available as `transport: share`.
`worker/rasaero_worker.py` runs inside the VM, polls its jobs folder and
drives RASAero with pywinauto, keeping one RASAero session across jobs — see
`worker/README.md`. The GUI's
**Start VM worker** button boots the UTM VM and starts the worker on its
desktop from the Mac (UTM guest agent + a Windows scheduled task,
`worker/vm_task.ps1`, `rpa/gui/vm.py`); a heartbeat file tells the GUI
whether the worker is alive.

`--worker-mode manual` prints the exact clicks for each job instead and
continues when the files appear, so the pipeline is usable without the worker.

## Layout

```
config.yaml            all knobs (target, Mach limits, delays, launch site, paths, backend)
rpa/                   pipeline package (python -m rpa ...)
  eng.py               RASP .eng parsing, impulse, nozzle exit diameter
  motors.py            booster set, sustainer candidates, spanning pick
  openrocket.py        OpenRocket 24.12 via JPype: mass/CG and preview simulation
  cdx1.py              RASAero CDX1 read/write (launch site, surface, SimulationList)
  massmodel.py         hardware-mass override on top of the OpenRocket mass distribution
  history.py           time-history parsing + event detection (burnout/separation/ignition)
  profiles.py          characterization and the transonic-separation eligibility rules
  search.py            apogee targeting (grid + bracket refinement)
  atmosphere.py        launch-site anchored standard atmosphere
  aero.py              RASAero Aero Plots tables: CD(Mach, altitude, power, nozzle)
  flightsim.py         3-DOF two-stage integrator (python backend)
  validate.py          term-by-term comparison against RASAero exports
  backends.py          python, RASAero (job folder) and OpenRocket backends
  jobs.py              job-folder protocol (Mac side; share or guest-agent transport)
  vmagent.py           UTM guest-agent primitives (utmctl push / pull / exec)
  pipeline.py, report.py, cli.py
  gui/                 local web GUI: server.py (HTTP API + SSE log), runner.py (subprocess runs),
                       state.py (step status from the files on disk), design.py (a design's motors,
                       vehicle geometry and .eng downloads), vm.py (start/stop the worker
                       in the UTM VM), yamledit.py, static/ (page)
Start GUI.command      double-click launcher for the GUI (macOS)
worker/                pywinauto worker for the Windows VM (+ worker_config.json, run_worker.py launcher,
                       vm_task.ps1 guest-side start/stop helper)
tests/                 unit tests (python -m pytest tests)
input/                 .ork, .CDX1, motor files, SOP PDFs
input/aero/            RASAero Aero Plots exports (per vehicle revision)
input/rasaero_reference/   RASAero View Data exports + inputs used by `rpa validate`
output/, jobs/         generated (git-ignored); output-archive/ = older result sets kept by hand
```

## Setup (Mac)

```
python3 -m venv .venv && .venv/bin/pip install -r requirements.txt && .venv/bin/pip install -e .
.venv/bin/python -m rpa gui --make-app     # builds "Rocket Profile Analysis.app" (repo root + ~/Applications)
.venv/bin/python -m pytest tests
.venv/bin/rpa run --backend openrocket --limit 3   # smoke test, no VM needed
```

Launching afterwards: double-click **Rocket Profile Analysis.app** (drag the
copy in ~/Applications to the Dock), or `Start GUI.command`, or `rpa gui`. A
second launch just opens the browser on the GUI that is already running; the
page header has a Quit control. Rebuild the app with `--make-app` if the
project folder moves.

OpenRocket 24.12 is used from `/Applications/OpenRocket.app` (jar + bundled
JRE; paths in `config.yaml`).
