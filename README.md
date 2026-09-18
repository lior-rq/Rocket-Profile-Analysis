# Rocket Profile Analysis

Finds two-stage flight profiles that reach a target apogee without separating
in the transonic band. Give it an OpenRocket model, a RASAero II model and a
folder of candidate motors. It searches booster motor, separation delay and
sustainer ignition delay, then checks each solution against RASAero's own
flight simulation.

Prebuilt apps for macOS and Windows are on the
[Releases page](https://github.com/lior-rq/Rocket-Profile-Analysis/releases/latest),
see [docs/INSTALL.md](docs/INSTALL.md). The rest of this file is about
running from source.

## Inputs

An OpenRocket `.ork` supplies the mass distribution and CGs. A RASAero
`.CDX1` supplies geometry, the launch site and the simulation rows. Motors
are RASP `.eng` files (multi-motor files count every motor inside) or
openMotor `.ric` designs, which get simulated once with `motorlib` and cached.

Files dropped on the GUI's Inputs page are copied to `input/boosters/`,
`input/sustainers/` and `input/models/` (git-ignored). Files anywhere else
can be used in place via Browse, a pasted path or `paths:` in `config.yaml`.

`sustainer_selection` decides which sustainers fly with each booster: `best`
is the max-impulse one only, `span` spreads a few across the apogee range
they give one reference booster, `list` names them.

## Profiles

| profile      | rule |
|--------------|------|
| `subsonic`   | the attached stack stays below Mach 0.9, so separation is clear of the transonic band |
| `supersonic` | the stack passes Mach 1.2 and separates while still above it |

`profiles.mach_margin` (default 0.05) tightens both limits. A third variant,
`decel_subsonic` (`--decel-subsonic`, off by default), lets a supersonic
booster coast attached back below Mach 0.9 before separating.

Delays follow RASAero's convention. Separation delay counts from booster
burnout, ignition delay from separation, and both floor at zero, so ignition
cannot precede burnout. Every exported time history is checked for this.

## Running it

```
python -m rpa gui
```

Starts the service (local only) and opens `http://127.0.0.1:8765`. The pages
follow the workflow left to right, each with a Run button, the equivalent
command line, the step's data and a collapsed explanation. Status comes from
the files on disk plus `output/run_manifest.json`, so a step only goes stale
when something it depends on changed. A running command shows its log,
progress and a cancel button.

Results are sortable tables with CSV export, a booster by sustainer matrix,
a trade-space scatter and a starred shortlist that can be compared side by
side or sent to RASAero together (`rpa confirm --designs ...`). Clicking a
design draws the vehicle with its staging timeline. Earlier runs are
snapshotted to `output-archive/` and can be diffed against the current one.
Full command logs are under `output/gui_logs/` on the Runs & logs page.

The command line does the same work:

```
python -m rpa check                     # validate the input set
python -m rpa run                       # every stage, default backend
python -m rpa run --backend openrocket  # preview through OpenRocket headless
python -m rpa <motors|mass|characterize|search|verify|report>   # one stage
```

Outputs are cached under `output/`. The stages, in order:

1. **motors** parses the motor files into `output/motors/`, plus an
   `all_motors.eng` for RASAero's *Select Motor File* dialog.
2. **mass** picks the sustainers to search and asks OpenRocket headless for
   the loaded weight and CG of every booster and sustainer pair
   (`output/mass_table.csv`). The `.ork` only gives the distribution;
   `mass_model.hardware_mass_lb` sets the absolute dry mass and scales both
   stages to it, with `.eng` propellant on top. `null` keeps the `.ork`
   masses. There is also a `manual` mass model.
3. **characterize** flies one long-coast run per booster and reads peak Mach,
   Mach at burnout, time to fall below 1.2 and 0.9, and rail-exit velocity off
   the attached stack. That decides which profiles each booster can fly and
   its separation window (`characterization.csv`, `eligibility.csv`).
4. **search** steps through the separation delay grid for every eligible
   booster, sustainer and profile, and sweeps the ignition delay coarsely at
   each step. Apogee is not monotonic in coast time (a longer coast lets the
   sustainer burn in thinner air until gravity losses win), so the search
   finds every bracket where apogee crosses the target and refines each with
   regula falsi to `target.tolerance_ft`. Best per candidate goes to
   `designs.csv`, every simulation to `search_rows.csv`.
5. **verify** exports a full time history of each solution: Mach at
   separation, velocity, Mach and altitude at ignition, max acceleration, time
   to apogee, and pass or fail against the profile rule and the tolerance.
6. **report** writes `report.md`, `designs_ranked.csv` (by `ranking.metric`,
   velocity at ignition by default) and the plots.

Handy flags are `--target`, `--tolerance`, `--boosters 01,31,60`, `--limit 5`
and `--fresh`. `--help` has the rest.

### Backends

The default, **rasaero_native**, runs RASAero II's own flight-sim and aero
code headless in child processes. About 20 ms per flight across the cores,
and the numbers match the RASAero II GUI to 0.0003 %
([native/VALIDATION.md](native/VALIDATION.md)). `rpa aero`, `rpa reference`
and `rpa confirm` run on it as well; `rpa confirm --top 5` re-flies the best
designs and writes `output/confirm.csv`. Build it once:

```
brew install dotnet msitools
python tools/rasaero_fetch.py           # installer -> vendor/rasaero/RASAeroEngine.dll
dotnet build native/RasaeroHost -c Release
```

[native/README.md](native/README.md) explains the patch.

**python** is `rpa/flightsim.py`: RASAero's own flight loop (integration
scheme, atmosphere, thrust and mass conventions, stage and apogee rules, even
its float32 clock) in Python, fed by RASAero's exported aero tables, the
`.eng` curves and the OpenRocket masses. About 15 ms per flight. On the ten
reference flights it is within 0.01 % of RASAero's apogee (a few feet), with
the weight, thrust and Mach histories matching row for row; `validate`
measures that:

```
python -m rpa aero                       # Aero Plots tables, once per vehicle revision
python -m rpa reference --cases 10       # ten RASAero reference flights
python -m rpa validate                   # compare term by term -> output/validation/
```

`validate` checks the atmosphere, the CD lookup, the drag reconstruction,
the weight and thrust histories and the flight numbers against the
`validation.*` tolerances. Re-run it whenever the vehicle, the tables or the
integrator change. Wind is not modelled (RASAero's pitch dynamics), so the
python backend flies the site at zero wind.

**openrocket** is OpenRocket headless. Different aero, previews only.

### Aero tables

`paths.aero_dir` holds Aero Plots exports, one set per vehicle revision since
they depend on geometry alone. Files are named
`<stack|sustainer>_alt<ft>[_noz<in>].csv`: `stack` means booster attached,
`sustainer` the upper stage alone, `alt` the Mach-Alt altitude and `noz` the
nozzle exit diameter behind the power-on CD. CD varies with altitude through
the Reynolds number only, so `rpa aero` exports a table every 5000 ft (the
flight reads them at the standard-atmosphere altitude with its Reynolds
number), and power-on CD is power-off CD minus a base-drag term proportional
to the nozzle area, so one nozzle per configuration serves every motor. Each
file needs a Mach column and power-off and power-on CD columns. `rpa check`
reports coverage.

### Reference flights

`paths.reference_dir` holds pairs of `<name>.csv` (RASAero *View Data* export
at 0.01 s) and `<name>.json` (`{"row": <SimRow>, "site": <launch site>}`),
plus copies of the motors flown (`<name>.booster.eng`, `<name>.sustainer.eng`)
so a case still reproduces after the motor set changes. `rpa reference`
writes them.

## Layout

```
config.example.yaml   template; copied to config.yaml (git-ignored) on first save
rpa/                  the pipeline (python -m rpa ...); service/ = FastAPI app, gui/ = state and yaml edits
app/                  desktop app: React UI in src/, Tauri shell in src-tauri/
native/               RASAero engine host and the patch tool
worker/               legacy: drives the RASAero GUI in a Windows VM, unused since the native engine
build/                packaging: PyInstaller spec, build_service.*, publish_host.*
tests/                python -m pytest tests
input/, output/, output-archive/   generated, git-ignored
```

## Setup from source (Mac)

```
python3 -m venv .venv && .venv/bin/pip install -r requirements.txt && .venv/bin/pip install -e .
.venv/bin/python -m pytest tests
```

Then `rpa gui`, pick your files on the Inputs page and press Check. Launching
it again only opens the browser on the running service; the header has a Quit
control.

OpenRocket 24.12 is expected at `/Applications/OpenRocket.app` with its
bundled JRE (paths in `config.yaml`). The native engine needs .NET 8 and
msitools, see the build steps above.

The desktop app is built with `build/build_service.sh && cd app && npm run
tauri build`. `cd app && npx playwright test` runs the UI smoke suite against
a service started with `rpa gui --port 8799 --no-browser`.
