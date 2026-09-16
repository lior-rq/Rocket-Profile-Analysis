# Performance

Measured on the built app (`build/dist/rpa-service` + the published
`rasaero-host`), Apple M-series laptop, 14 cores, macOS 26.5, on a copy of a
real project: 141 boosters x 10 sustainer candidates, 1410 (booster,
sustainer) pairs, 7146 search candidates. `python build/bench.py` prints
the first table; the others come from the probes described under each.

## The app, end to end

| measure | value |
|---|---|
| service ready (port announced) | 0.6 s |
| /api/state (avg of 5) | 220 ms |
| warm-up done (hosts + JVM), after ready | 1.0 s |
| mass stage, fresh (OpenRocket) | 5.2 s |
| mass stage again (OpenRocket warm) | 2.54 s |
| run --fresh, total | 1160.8 s |
|   substage motors | 0.0 s |
|   substage mass | 5.3 s |
|   substage characterize | 41.2 s |
|   substage search | 1085.8 s |
|   substage verify | 4.3 s |
|   substage report | 23.9 s |
| search flights | 47634 |
| search wall time / flight | 22.8 ms |
| characterize: click -> first flight analysed | 8.53 s |
| characterize flights | 1410 |
| characterize wall time / flight (full history each) | 29 ms |
| engine hosts | 14 |
| cpu cores | 14 |
| second launch, ready | 0.6 s |

[exited with code 0]

The same run before this pass: 4712 s, of which characterization 2046 s
and the search 2661 s (and the report then crashed in the frozen build).
The run is the engine: every flight is RASAero's own integrator at
`native.dt_s` = 0.01 s over a ~300 s two-stage flight, so a search of this
size is minutes, not seconds. Everything around it is now near zero: the
click-to-first-flight figure is the mass stage (OpenRocket, 5 s) plus the
first engine flight. The 22.8 ms per search flight was measured after two
hours of back-to-back runs on a warm laptop; a cold one did the same round
at 16.8 ms.

## What changed, and what it bought

| item | before | after |
|---|---|---|
| service start (second launch) | 3-4 s (`rpa gui` subprocess, static server) | 0.6 s to the port, UI usable in ~1 s |
| first launch after install | - | ~20 s once (macOS scans the new binaries), then 0.6 s |
| per-stage restarts (JVM, engine hosts, motor set) | ~10 s per stage | none: one process, hosts and JVM warm 1.7 s after the port is up |
| characterization, 1410 pairs (full history each) | 2046 s (serial, CSV round trip per flight) | 29-41 s: histories inline as one float64 block, flown over the whole pool (`SimBackend.histories`) |
| one full history to Python | 0.42-0.50 s (CSV write + read) | 0.18-0.29 s (float64 block, `numpy.frombuffer`) |
| search dispatch | chunks pinned to hosts by index: when a chunk finished out of order the next one waited on a busy host while others idled (7 rows/s in a refinement round) | free-host queue, chunks of n/(4 x hosts): every host busy to the end of the batch |
| host replies | `HostProcess.request` was not thread-safe; two chunks on one host lost replies and stalled 600 s | one lock per host |
| host pool | cores - 1 | every core when the engine is the simulator (throughput table below) |
| rows on the wire | JSON objects | arrays in field order, results as arrays |
| verify exports | host wrote a RASAero-layout CSV, Python read it back | inline block, Python writes the normalized CSV every backend writes |
| search grid | every separation delay flies the whole ignition grid | one pilot per (booster, sustainer, profile), neighbours fly the points around its crossings (`profiles.pilot_grid`): 47.6k rows instead of 136k for this project |
| mass table | recomputed whenever the pair set changed | cached by `.ork` digest + mass model; only missing pairs go through OpenRocket |
| dashboard state | polled every second, recomputed each time | snapshot cache keyed on file mtimes, pushed over SSE |
| host binary | JIT `dotnet rasaero-host.dll` | self-contained, ReadyToRun + TieredPGO |

## Engine throughput vs host count

280 flights of the validation reference (112 s of flight time each), free-host
dispatch, published host. `native.workers: auto` = 14 here.

| hosts | flights/s | wall per flight | per host-flight |
|---|---|---|---|
| 4 | 36.1 | 27.7 ms | 111 ms |
| 7 | 62.2 | 16.1 ms | 113 ms |
| 10 | 73.9 | 13.5 ms | 135 ms |
| 14 | 85.5 | 11.7 ms | 164 ms |

The efficiency cores are slower per flight but still add throughput, so
the default is every core. The project's own flights are longer (45 kft
apogee, ~300 s), which is why the search table above shows ~17 ms wall per
flight rather than 12.

## Where the time goes now

For a project of this size: characterization 30-40 s, search round 0 (the
pilots' ignition grids, 24 130 flights) and round 0b (the neighbours'
narrowed grids, 23 504 flights) 400-550 s each, then the bracket
refinement rounds (none here: the coarse grid already lands inside the
project's 2500 ft tolerance), verify 4 s, report 24 s.
To make a run shorter, cut the candidate set (`sustainer_selection.count`,
`profiles.separation_step_s`, the booster list) rather than the engine
settings; `native.dt_s` changes the physics RASAero was validated against.
