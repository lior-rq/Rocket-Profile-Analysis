# RASAero II native engine

RASAero II's own flight-simulation and aerodynamics code, running headless
on this machine (macOS arm64, .NET 8; the same files run on Windows x64).
No VM, no GUI automation: a flight takes ~20-130 ms, an aero table ~0.1 s,
and the numbers are RASAero's (see `VALIDATION.md`).

```
tools/rasaero_fetch.py      download the 1.0.2.0 installer, extract, patch, verify
RasaeroPatch/               Mono.Cecil tool: makes RASAero II.exe loadable and headless
RasaeroHost/                net8.0 console: JSON lines on stdin/stdout -> rasaero-host.dll
vendor/rasaero/             git-ignored: installer, RASAero II.exe, RASAeroEngine.dll, rasp.eng, examples/
rpa/native.py               HostProcess + NativeRASAeroBackend (backend rasaero_native)
```

## Build

```
brew install dotnet msitools
.venv/bin/python tools/rasaero_fetch.py          # -> vendor/rasaero/RASAeroEngine.dll (+ JIT self-test)
dotnet build native/RasaeroHost -c Release       # -> native/RasaeroHost/bin/Release/net8.0/rasaero-host.dll
.venv/bin/python -m rpa check                    # "RASAero engine: native (...)"
```

## What the patch does (RasaeroPatch)

RASAero II is a .NET 2.0 VB.NET WinForms exe, Dotfuscator-renamed (names
only). The patch never touches the numerics:

1. clears the `32BITREQUIRED` header flag so a 64-bit runtime loads it;
2. makes every type and member public (the host binds to the obfuscated
   names at compile time);
3. injects `RasaeroShim` and rewrites the few GUI touches inside the engine:
   `Interaction.MsgBox` calls become `Shim.Fail3` (throws, with VB's `Err`
   exception as InnerException), the "Unstable" dialog becomes a throw, the
   two `Debugfile.txt` paths read from the main form become `Shim.DebugDir()`
   (temp dir), one `ComboBox` local in the .eng parser becomes `object`;
4. renames the assembly `RASAeroEngine` (a DLL) and verifies by JIT-compiling
   every engine method on this machine (351 ok; the 24 skipped are
   System.Drawing part painters and the top-level CDX1 writer/reader).

## Class map (RASAero's obfuscated names)

| Name | What | Used by the host |
|------|------|------------------|
| `i` | aero model: parts, CD/CN/CP, atmosphere (`m_b`) | `a(mach, -1m, ref ae)` per Mach; `n(alpha)`; `h(nozzle)`; `a(List<bn>)` Mach-Alt; `e(1049)` unlock Mach 25 |
| `y` | flight sim; `e()` integrates one stage; `av` = history rows | site setters `f o t c m`, recovery `a(...)`, per stage `l k s a n d`, handover `y m q r x u d i`, results `g v s` |
| `f` | motor: `.eng` parser `a(ref object, StreamReader)`, `h()` = "designation  (manufacturer)" | motor lookup by the name RASAero shows |
| `t` | CDX1 reader pieces: `ExtractNC/BT/FC/Boost/Boat/Trans`, `GetLaunchSite/Recovery/MachAlt` | the host walks the XML itself and calls these |
| `a6.a(ref i, a4)` | loads a stage's parts into the aero model | per stage / per table |
| `a4` | stage: `Stage` S/B, `StageParts`, `TotalWeight`, `NozzleDiameter`, `CGLoc`, delays, flags, `StageEngine` | built like the GUI's `a6.a(ref List<a4>)` |
| `a5` + `a0 au a1 a2 ai a8` | parts (nose, tube, fin can, booster, boattail, transition); fins in `au.f` / `ai.e` | post-load pass (below) |
| `d`, `bn`, `ae`, `LaunchSiteClass` | recovery, Mach-Alt point, aero result struct, site | |

**Post-load pass.** After `ReadXMLFile` the GUI's main form runs over the
parts (`ar.j / ar.i / ar.b`): body diameters flow down the stack, boattail
fields are reset and re-derived, fin overhang and the fin root diameters
(fin fields `l`, `m`) are computed. The aero model reads those fields, so
`Design.PostLoad` in the host repeats that pass. Without it CP is off by
~9 in and CNalpha by ~40 %.

Flight sequence (from the Flight Simulation form): stage list, booster
first; site + recovery on a fresh `y`; per stage `a6.a(ref y.g, stage)`,
`i.n(0)`, `i.e(1049)`, `i.e(0,0)`, previous end state in, `y.e()`, end state
out. Results `y.g()` MaxAlt (AGL), `y.v()` MaxVel, `y.s()` time to apogee,
history `y.av` (24 columns, written in the View Data export layout).

Aero table (from the Aero Plots form): the stage's nozzle diameter from the
row, Mach-Alt = `[(0, alt), (25, alt)]`, alpha 0 / 2 / 4 deg, Mach 0.01..25
step 0.01, written in the Aero Plots export layout (15 columns).

## Protocol

One JSON object per line; the reply echoes `id`.

```
{"op":"ping"}                                              -> {"ok":true,"version":"1.0.2.0","engine":"<sha256[:16]>","motors":N}
{"op":"motors","files":["a.eng", ...]}                     -> {"ok":true,"added":N,"names":[...]}
{"op":"design","cdx1":"path","design":"id"}                -> {"ok":true,"design":"id","stages":2,"parts":4,"site":{...},"sims":[...]}
{"op":"fly","design":"id","rows":[{sustainer_engine,booster_engine,sustainer_wt_lb,sustainer_cg_in,sustainer_nozzle_in,
      combined_wt_lb,combined_cg_in,booster_nozzle_in,sep_delay_s,ign_delay_s,name}],
      "dt":0.01,"time_base_s":0.01,"history_dir":"dir"|null,"site":{altitude_ft,...},"surface_finish":"..."}
                                                           -> {"ok":true,"rows":[{"max_alt_ft","max_vel_fps","t_apogee_s","t_max_vel_s","t_flight_s","steps","history","error"}]}
{"op":"aero","design":"id","config":"stack|sustainer","altitude_ft":20000,"nozzle_in":3.46,"mach_max":25,"csv":"path",
      "site":{...},"surface_finish":"..."}                 -> {"ok":true,"rows":7500,"csv":"path"}
```

`fly` options: `"fields":[...]` lets `rows` be arrays in that order;
`"compact":true` answers with arrays in the result order above (plus a
last `history_block` element); `"inline_history":true` returns each
history as `history_block`, a base64 little-endian float64 block, row-major
over `history_cols` (the View Data columns; Stage is coded B=1, S=2),
sampled every `time_base_s`. `rpa.native` uses all three.

`fly` without `rows` flies the CDX1's own `<SimulationList>`. `site`,
`surface_finish`, `barrowman`, `turbulence` override the file for that
request (the pipeline's launch-site / finish overrides). A flight that
RASAero would refuse (motor missing, weight below the motor, "Rocket was
Unstable") comes back as `error` on that row; the process never exits.
