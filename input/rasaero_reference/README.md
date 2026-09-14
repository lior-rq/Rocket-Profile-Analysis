# RASAero reference flights

Pairs of `<name>.csv` (RASAero *View Data* export at 0.01 s) and
`<name>.json` (`{"row": <SimRow>, "site": <launch site>}`) used by
`python -m rpa validate` to check the python backend against RASAero.
`python -m rpa reference` produces them through the VM worker;
`altitude_offset.json` records whether RASAero's altitudes were MSL.
`<name>.booster.eng` / `<name>.sustainer.eng` are copies of the motors that
were flown, so a case stays reproducible after the motor folders change (a
case without them falls back to the current motor set by label and is
skipped with a reason if that motor is gone). `density_calibration.csv` is
RASAero's air-density profile recovered from these exports.
