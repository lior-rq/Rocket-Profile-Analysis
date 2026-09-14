60 RASP .eng files, one per design on the trade-off curve.

Each is a real openMotor simulation at a 0.002 s timestep, so the
numbers agree with this run's report.

Before flying any of these in OpenRocket or RockSim: the total mass
in an .eng file is the propellant mass alone. This application never
models the case, nozzle or closures, so the hardware mass has to be
added by hand. Diameter and length are the grain outer diameter and
the grain stack length for the same reason.

To use one, drop the file into OpenRocket's user motor directory, or
load it from the motor selection dialog.
