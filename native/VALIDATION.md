# Native engine vs the VM (verified 2026-09-16)

Same inputs on both sides: `input/RASAero (.CDX1)/RAS_v1.3.CDX1`, the
staged motor set, config.yaml's launch site and surface finish. The VM side
is RASAero II 1.0.2.0 driven by the worker (32-bit .NET Framework on Windows
11 ARM64); the native side is `RASAeroEngine.dll` on .NET 8 arm64 macOS.

## Flights: 10 reference exports (`rpa validate --engine native`)

| Case | Apogee VM (ft) | Apogee native (ft) | Diff | Max Mach diff | Max alt diff (ft) | Max vel diff (fps) | Weight diff (lb) |
|------|---------------:|-------------------:|-----:|--------------:|------------------:|-------------------:|-----------------:|
| ref01 sep15 ign15 | 30242.11 | 30242.18 | +0.0002 % | 3e-6 | 0.16 | 0.003 | 0.011 |
| ref02 sep1 ign3 | 57191.07 | 57191.13 | +0.0001 % | 3e-6 | 0.16 | 0.002 | 0.001 |
| ref03 sep0 ign8 | 52148.11 | 52148.17 | +0.0001 % | 3e-6 | 0.14 | 0.003 | 0.001 |
| ref04 sep1 ign12 | 52169.53 | 52169.57 | +0.0001 % | 3e-6 | 0.11 | 0.002 | 0.000 |
| ref05 sep0.5 ign5 | 64454.87 | 64454.86 | -0.0000 % | 2e-6 | 0.07 | 0.001 | 0.001 |
| ref06 sep15 ign15 | 37008.35 | 37008.45 | +0.0003 % | 3e-6 | 0.19 | 0.003 | 0.007 |
| ref07 sep1 ign3 | 67777.15 | 67777.13 | -0.0000 % | 3e-6 | 0.09 | 0.003 | 0.000 |
| ref08 sep0 ign8 | 70451.04 | 70451.12 | +0.0001 % | 5e-6 | 0.19 | 0.004 | 0.000 |
| ref09 sep1 ign12 | 73744.48 | 73744.46 | -0.0000 % | 4e-6 | 0.11 | 0.002 | 0.000 |
| ref10 sep0.5 ign5 | 60856.04 | 60856.08 | +0.0001 % | 3e-6 | 0.11 | 0.002 | 0.001 |

Time to apogee agrees to the 0.01 s step in every case; CD along the flight
agrees to 2e-5 % (median); burnout, separation and ignition land on the same
samples. The residual (0.2 ft over a 70,000 ft flight) is the x87-vs-IEEE
float rounding expected from the plan, three orders of magnitude below the
python backend's 1 % criterion.

RASAero's own two-stage example (`vendor/rasaero/examples/AeroPac104K...`)
carries results saved by the GUI: 113786.4 ft / 3125.964 fps / 98.33942 s.
Native: 113786.0 ft / 3125.958 fps / 98.33942 s.

## Aero tables: 10 tables (`aero_plan`), Mach 0.01..25, alpha 0/2/4

Worst relative difference over all rows at alpha 0:

| Column | Worst diff |
|--------|-----------:|
| CD Power-Off | 7e-6 % |
| CD Power-On | 8e-6 % |
| CP | 9e-5 % |
| CNalpha (0 to 4 deg) | 2e-5 % |
| CN | 0 |
| Reynolds Number | 1e-4 % |

That is the rounding of the VM's exported decimals.

## Speed (14-core Apple Silicon)

| What | VM worker | Native |
|------|-----------|--------|
| One aero table (7500 rows) | minutes (GUI, screenshots, waits) | 0.11 s |
| 10 reference flights with histories | ~10 jobs, tens of minutes | 4.4 s total |
| Search batch, 200 flights | n/a (python backend) | 27 s serial, 4.3 s with 13 hosts (22 ms/flight) |

## Open points

- The "exceeded Mach 3" stop is gated on the demo flag RASAero's main form
  initialises to false; the host passes the same value. The AeroPac example
  (3126 fps) runs through on both sides. No reference flight exceeds
  3300 fps, so the gate has not been exercised on the VM.
- Wind: RASAero refuses a flight it finds unstable ("Rocket was Unstable"
  dialog). With the config launch site (wind 0) none of the references
  trigger it; the native engine reports it as a row error, the GUI as a
  dialog with no result.
