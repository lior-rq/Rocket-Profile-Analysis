# RASAero aerodynamic tables

Exported from RASAero II (*Aero Plots* → export) once per vehicle revision.
The tables depend only on the geometry in the `.CDX1`, not on the motors or
delays, so the flight-profile search never touches RASAero.

File name: `<config>_alt<ft>[_noz<in>].csv`

| part     | meaning |
|----------|---------|
| `config` | `stack` = booster attached (full two-stage vehicle); `sustainer` = sustainer alone (booster removed from the design) |
| `alt`    | the *Mach-Alt* altitude (ft) the table was exported at; export at ~3 altitudes spanning the flight (e.g. 3000, 20000, 40000) |
| `noz`    | nozzle exit diameter (in) set in the design when exporting; affects the power-on CD (base drag). Optional. Export at 2–4 values spanning the motor set (boosters ≈ 2.9–5.1 in, sustainers ≈ 2.3–2.5 in) and the tool interpolates |

Examples: `stack_alt3000_noz3.88.csv`, `sustainer_alt40000_noz2.4.csv`.

Columns are matched by name; a Mach column, a power-off CD column and a
power-on CD column are required (CN / CP are kept if present). Run
`python -m rpa check` to see what was found and whether the coverage is
sufficient.
