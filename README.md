# Rocket Profile Analysis

Two-stage flight profile optimizer built on OpenRocket and RASAero II. Given a
vehicle and a set of candidate motors it searches booster motor, separation
delay and sustainer ignition delay for combinations that reach a target apogee
while the booster separates outside the transonic band.

## Inputs

* one OpenRocket model (`.ork`) – mass distribution and CGs
* one RASAero model (`.CDX1`) – geometry, launch site, and the simulation
  rows RASAero runs
* booster and sustainer motor files: one-motor RASP `.eng`, multi-motor
  `.eng` (every motor inside counts), or openMotor `.ric` designs (simulated
  once with `motorlib` and cached)

On the GUI's Inputs page, drop files or folders onto the motor cards / model
fields or press Upload; copies land in `input/boosters/`, `input/sustainers/`
and `input/models/` (git-ignored). Files elsewhere on disk can be used in
place (Browse… or a pasted path), or set `paths:` in `config.yaml`. Paths
inside the project are stored relative to it.

Which sustainers fly with each booster is `sustainer_selection`: `best`
(max impulse only), `span` (a few spread over the apogee they give one
reference booster) or `list`.

## Profiles

| profile      | rule                                                                 |
|--------------|----------------------------------------------------------------------|
| `subsonic`   | the attached stack never exceeds Mach 0.9; separation is free of the transonic band |
| `supersonic` | the stack exceeds Mach 1.2 and separates while still above Mach 1.2   |

`profiles.mach_margin` (default 0.05) is applied to both limits. A third
variant, `decel_subsonic` (`--decel-subsonic`, off by default), lets a
supersonic booster coast attached back below Mach 0.9 before separating.

Delays follow RASAero's convention: `Booster1SeparationDelay` counts from
booster burnout, `SustainerIgnitionDelay` from separation. Both floors are 0,
so ignition can never precede burnout. Every exported time history is
re-checked against this and a mismatch is flagged.

## GUI

```
python -m rpa gui      # dev: service + browser. Desktop app: see docs/INSTALL.md
```

Opens `http://127.0.0.1:8765` (FastAPI + uvicorn, local only). Seven step pages in workflow order: each has a summary, an
action panel (prerequisites, Run button, equivalent command line), the step's
data and a collapsed "how this step works". Step 1 edits `config.yaml` in
place with its comments kept. Status comes from the files on disk plus
`output/run_manifest.json`, so a step is only "out of date" when something
it depends on changed. A file watcher pushes changes to the page; the running
command shows live log, progress and cancel.

Results: sortable, filterable tables with CSV export; a booster × sustainer
matrix; a trade-space scatter; a shortlist (★) compared side by side and sent
to RASAero together (`rpa confirm --designs …`); interactive report figures;
diffs against earlier runs (`output-archive/`, snapshotted before every fresh
run). Clicking a design draws the vehicle with a staging timeline and offers
the motor combo as a download.

The VM worker, its job queue and console have their own page with Start /
Stop buttons. Runs & logs keeps every command's full log
(`output/gui_logs/`). Code: `rpa/service/` (FastAPI app, in-process
runner), `app/` (React front end + Tauri shell), `rpa/gui/` (state, design
assets, VM control, yaml edits).

Visual check: `cd app && npx playwright test` runs the smoke suite against a
service on port 8799 (`app/playwright.config.ts`).

## Pipeline

```
python -m rpa check                     # validate the input set
python -m rpa run                       # all stages, python backend
python -m rpa run --backend rasaero     # same through the RASAero GUI in the VM (slow)
python -m rpa run --backend openrocket  # preview through OpenRocket headless
python -m rpa <motors|mass|characterize|search|verify|report>   # one stage
```

Stages (outputs cached under `output/`):

1. **motors** – parse the motor files, stage every candidate into
   `output/motors/` (+ `all_motors.eng` for RASAero's *Select Motor File*).
2. **mass** – pick the sustainers to search, then sustainer-only and combined
   loaded weight / CG for every (booster, sustainer) pair via OpenRocket
   headless (`output/mass_table.csv`). The `.ork` gives the mass
   *distribution*; `mass_model.hardware_mass_lb` sets the absolute dry mass
   (both stages scaled to it, `.eng` propellant added on top). `null` keeps
   the `.ork` masses. A `manual` mass model is also available.
3. **characterize** – one long-coast run per booster. From the attached
   stack's Mach history: peak Mach, Mach at burnout, time to drop below
   1.2 / 0.9, rail-exit velocity → which profiles each booster can fly and its
   separation window (`characterization.csv`, `eligibility.csv`).
4. **search** – for every eligible (booster, sustainer, profile) and every
   separation delay on the grid, sweep the ignition delay on a coarse grid,
   find every bracket where apogee crosses the target and refine with
   regula-falsi to `target.tolerance_ft`. Apogee vs. coast is not monotonic
   (a longer coast lets the sustainer burn in thinner air until gravity
   losses win), hence brackets rather than a single bisection. Best per
   candidate → `designs.csv`; every simulation → `search_rows.csv`.
5. **verify** – full time-history export of each solution: Mach at
   separation, velocity / Mach / altitude at ignition, max accel, time to
   apogee, pass/fail against the profile rule and the tolerance.
6. **report** – `report.md`, `designs_ranked.csv` (by `ranking.metric`,
   default velocity at ignition) and plots.

Useful flags: `--target 45000`, `--tolerance 100`, `--boosters 01,31,60`,
`--limit 5`, `--worker-mode manual`, `--fresh`, `--include-unsolved`.

### Backends

* **rasaero_native** (default) – RASAero II's own flight-sim and aero code,
  headless, in child processes (`rpa/native.py` + `native/`, see
  `native/README.md`). No VM: ~20 ms per flight over the cores, and the
  numbers are the VM's to 0.0003 % (`native/VALIDATION.md`). Also what
  `rpa aero`, `rpa reference` and `rpa confirm` use when it is built
  (`rasaero.engine: auto`). Build once:

  ```
  brew install dotnet msitools
  python tools/rasaero_fetch.py           # installer -> vendor/rasaero/RASAeroEngine.dll
  dotnet build native/RasaeroHost -c Release
  ```
* **python** – `rpa/flightsim.py`, a planar 3-DOF gravity-turn
  integrator using RASAero's own aero tables, its launch-site atmosphere
  conventions, the `.eng` curves and the OpenRocket mass numbers. ~25 ms per
  flight, batches spread over the CPU cores. It is only as good as its
  agreement with RASAero, which is measured:

  ```
  python -m rpa aero                  # Aero Plots tables (native engine, or the VM) once per vehicle revision
  python -m rpa reference --cases 10  # ~10 RASAero reference flights (native engine, or the VM)
  python -m rpa validate              # compare term by term -> output/validation/
  python -m rpa validate --engine native   # the native engine itself vs VM exports -> output/validation_native/
  ```
  `validate` checks the atmosphere, the CD lookup, the drag reconstruction,
  the weight history and the flight numbers (`validation.*` tolerances). It
  also recovers RASAero's density profile from the exports
  (`density_calibration.csv`), which the python backend then uses. Re-run it
  whenever the vehicle, the tables or the integrator change.
* **rasaero** – the RASAero GUI driven through the VM worker; the fallback
  for table exports, reference flights and the final confirmation
  (`python -m rpa confirm --top 5` → `output/confirm.csv`) when the native
  engine is not built (`rasaero.engine: vm` forces it).
* **openrocket** – OpenRocket headless; different aero, preview only.

### Aero tables (`paths.aero_dir`)

Exported from RASAero's *Aero Plots* once per vehicle revision; they depend
on the geometry only. File name `<stack|sustainer>_alt<ft>[_noz<in>].csv`:
`stack` = booster attached, `sustainer` = sustainer alone; `alt` = the
Mach-Alt altitude; `noz` = nozzle exit diameter used for the power-on CD.
Export at 2–3 altitudes and 2–4 nozzle sizes spanning the motor set; the
tool interpolates. A Mach column and power-off / power-on CD columns are
required. `rpa check` reports coverage.

### Reference flights (`paths.reference_dir`)

Pairs of `<name>.csv` (RASAero *View Data* export at 0.01 s) and
`<name>.json` (`{"row": <SimRow>, "site": <launch site>}`), plus copies of
the motors flown (`<name>.booster.eng` / `.sustainer.eng`) so a case stays
reproducible when the motor set changes. `rpa reference` writes them.

## RASAero II in the Windows VM

Fallback only since the native engine (`native/`): everything below is
what `rasaero.engine: vm` or an unbuilt engine falls back to.

RASAero II is Windows-only and GUI-only. The pipeline writes job folders
(`jobs/NNNN-name/{job.json,input.CDX1}`) and waits for `result.CDX1`
(+ `export.csv`) and `done.json`. Jobs travel through UTM's guest agent by
default (`worker.transport: agent`); a `Z:` share is the fallback.
`worker/rasaero_worker.py` runs inside the VM and drives RASAero with
pywinauto — see `worker/README.md`. The GUI's **Start VM worker** button boots
the VM and starts the worker. `--worker-mode manual` prints the clicks for
each job instead and continues when the files appear.

## Layout

```
config.example.yaml    template; copied to config.yaml (git-ignored) on first save
rpa/                   pipeline package (python -m rpa ...)
  eng.py               RASP .eng parsing, impulse, nozzle exit diameter
  ric.py               openMotor .ric designs -> cached .eng
  motors.py            booster set, sustainer candidates, spanning pick
  openrocket.py        OpenRocket via JPype: mass/CG and preview simulation
  cdx1.py              RASAero CDX1 read/write
  massmodel.py         hardware-mass override on the OpenRocket distribution
  history.py           time-history parsing + event detection
  profiles.py          characterization and the transonic-separation rules
  search.py            apogee targeting (grid + bracket refinement)
  atmosphere.py        launch-site anchored standard atmosphere
  aero.py              Aero Plots tables: CD(Mach, altitude, power, nozzle)
  flightsim.py         3-DOF two-stage integrator (python backend)
  validate.py          comparison against RASAero exports
  backends.py          python, RASAero (job folder) and OpenRocket backends
  jobs.py, vmagent.py  job-folder protocol and UTM guest-agent primitives
  pipeline.py, report.py, cli.py
  service/             FastAPI app, in-process runner, start-up helpers
  gui/                 state.py, design.py, vm.py, yamledit.py (used by service/)
  platform.py          installed-app paths, OpenRocket / engine discovery
app/                   desktop app: React UI (src/), Tauri shell (src-tauri/)
build/                 packaging: rpa-service.spec, build_service.*, publish_host.*
worker/                pywinauto worker for the Windows VM
tests/                 unit tests (python -m pytest tests)
input/                 aero tables and reference flights written by the tool (git-ignored)
output/, jobs/         generated (git-ignored); output-archive/ = older result sets
```

## Setup (Mac)

```
python3 -m venv .venv && .venv/bin/pip install -r requirements.txt && .venv/bin/pip install -e .
.venv/bin/python -m pytest tests
```

Then `rpa gui`, pick your files on the Inputs page and press Check. A
second launch just opens the browser on the running service; the header has
a Quit control. The installable desktop app is built with
`build/build_service.sh && cd app && npm run tauri build` (docs/INSTALL.md).

OpenRocket 24.12 is expected at `/Applications/OpenRocket.app` (jar + bundled
JRE; paths in `config.yaml`). The RASAero engine needs .NET 8 and msitools
once (`brew install dotnet msitools`), then `python tools/rasaero_fetch.py`
and `dotnet build native/RasaeroHost -c Release`.
