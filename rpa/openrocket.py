"""Headless OpenRocket 24.12 via JPype.

Sustainer / combined loaded weight and CG for every booster, and optionally
a preview simulation backend so the pipeline runs without the RASAero VM.
"""

from __future__ import annotations

import math
from pathlib import Path

import numpy as np
import pandas as pd

from .eng import Motor
from .massmodel import StageMasses, mass_row
from .models import MassRow

KG_TO_LB = 2.20462262
M_TO_IN = 39.3700787
M_TO_FT = 3.2808399
FT_TO_M = 0.3048
IN_TO_M = 0.0254
INHG_TO_PA = 3386.389
MPH_TO_MS = 0.44704
N_TO_LBF = 0.2248089


class OpenRocket:
    """Context manager owning the JVM. Only one instance per process (JPype limit)."""

    def __init__(self, jar: str | Path, jvm: str | Path | None = None):
        self.jar = Path(jar)
        if not self.jar.exists():
            raise FileNotFoundError(f"OpenRocket jar not found: {self.jar}")
        self.jvm = Path(jvm) if jvm and Path(jvm).exists() else None
        self.core = None
        self._doc = None
        self._motor_cache: dict[tuple, object] = {}

    # ---- lifecycle -----------------------------------------------------
    def __enter__(self):
        import jpype
        import jpype.imports

        if not jpype.isJVMStarted():
            jvm = str(self.jvm) if self.jvm else jpype.getDefaultJVMPath()
            jpype.startJVM(jvm, "-Djava.awt.headless=true", f"-Djava.class.path={self.jar}", convertStrings=True)
        self.core = jpype.JPackage("info").openrocket.core
        self._quiet_logging()  # before initialize(): its loader threads log otherwise
        if not self.core.startup.OpenRocketCore.isInitialized():
            self.core.startup.OpenRocketCore.initialize(self.core.plugin.PluginModule())
        return self

    def __exit__(self, *exc):
        import jpype

        try:
            for w in jpype.java.awt.Window.getWindows():
                w.dispose()
        except Exception:
            pass
        # Leave the JVM running: JPype cannot restart it in the same process.
        return False

    def _quiet_logging(self):
        import jpype

        try:
            LoggerFactory = jpype.JPackage("org").slf4j.LoggerFactory
            Logger = jpype.JPackage("ch").qos.logback.classic.Logger
            Level = jpype.JPackage("ch").qos.logback.classic.Level
            LoggerFactory.getLogger(Logger.ROOT_LOGGER_NAME).setLevel(Level.OFF)
        except Exception:
            pass

    # ---- loading -------------------------------------------------------
    def load_rocket(self, ork: str | Path):
        from java.io import File

        loader = self.core.file.GeneralRocketLoader(File(str(ork)))
        self._doc = loader.load()
        self.warnings = [str(w) for w in loader.getWarnings()]
        self.rocket = self._doc.getRocket()
        self.fcid = self.rocket.getSelectedConfiguration().getId()
        stages = list(self.rocket.getStageList())
        if len(stages) != 2:
            raise ValueError(f"expected a two-stage rocket, found {len(stages)} stages")
        self.sustainer_stage, self.booster_stage = stages[0], stages[1]
        mounts = {}
        for c in self.rocket.iterator(True):
            if isinstance(c, self.core.rocketcomponent.MotorMount) and c.isMotorMount():
                stage = c.getStage()
                key = "sustainer" if stage.equals(self.sustainer_stage) else "booster"
                if key in mounts:
                    raise ValueError(f"more than one motor mount in the {key} stage; not supported")
                mounts[key] = c
        if set(mounts) != {"sustainer", "booster"}:
            raise ValueError(f"need one motor mount per stage, found: {sorted(mounts)}")
        self.mounts = mounts
        return self.rocket

    def load_motor(self, eng: Motor | str | Path):
        """A Motor is loaded from its own RASP block (it may come from a
        multi-motor file); a path MUST hold exactly one motor."""
        from java.io import ByteArrayInputStream

        if isinstance(eng, Motor):
            key, text, name = (eng.path, eng.designation), eng.raw_text(), eng.path.name
        else:
            key, text, name = (Path(eng), None), Path(eng).read_text(), Path(eng).name
        if key in self._motor_cache:
            return self._motor_cache[key]
        builders = self.core.file.motor.GeneralMotorLoader().load(ByteArrayInputStream(text.encode("utf-8")), name)
        if builders.size() != 1:
            raise ValueError(f"{key[0]}: expected one motor, found {builders.size()}")
        m = builders.get(0).build()
        self._motor_cache[key] = m
        return m

    def set_motors(self, sustainer: Motor, booster: Motor):
        self.mounts["sustainer"].getMotorConfig(self.fcid).setMotor(self.load_motor(sustainer))
        self.mounts["booster"].getMotorConfig(self.fcid).setMotor(self.load_motor(booster))
        CCE = self.core.rocketcomponent.ComponentChangeEvent
        self.rocket.fireComponentChangeEvent(CCE.MOTOR_CHANGE)

    # ---- mass properties ------------------------------------------------
    def stage_masses(self, sustainer: Motor, booster: Motor) -> StageMasses:
        """Dry and loaded mass/CG of the sustainer alone and of the whole stack."""
        MC = self.core.masscalc.MassCalculator
        self.set_motors(sustainer, booster)
        cfg = self.rocket.getFlightConfiguration(self.fcid)
        cfg.setOnlyStage(0)
        s_dry, s_launch = MC.calculateStructure(cfg), MC.calculateLaunch(cfg)
        cfg.setAllStages()
        c_dry, c_launch = MC.calculateStructure(cfg), MC.calculateLaunch(cfg)
        return StageMasses(
            sustainer_dry_lb=s_dry.getMass() * KG_TO_LB,
            sustainer_dry_cg_in=s_dry.getCM().x * M_TO_IN,
            stack_dry_lb=c_dry.getMass() * KG_TO_LB,
            stack_dry_cg_in=c_dry.getCM().x * M_TO_IN,
            sustainer_loaded_lb=s_launch.getMass() * KG_TO_LB,
            sustainer_loaded_cg_in=s_launch.getCM().x * M_TO_IN,
            stack_loaded_lb=c_launch.getMass() * KG_TO_LB,
            stack_loaded_cg_in=c_launch.getCM().x * M_TO_IN,
        )

    def mass_row(self, sustainer: Motor, booster: Motor, hardware_mass_lb: float | None = None) -> MassRow:
        return mass_row(booster.label, self.stage_masses(sustainer, booster), booster.prop_mass_kg, hardware_mass_lb, sustainer.label)

    def mass_table(self, sustainer: Motor, boosters: list[Motor], hardware_mass_lb: float | None = None) -> list[MassRow]:
        return [self.mass_row(sustainer, b, hardware_mass_lb) for b in boosters]

    # ---- preview simulation backend ------------------------------------
    def simulate(self, sustainer: Motor, booster: Motor, sep_delay_s: float, ign_delay_s: float, site: dict, time_step: float = 0.01) -> tuple[dict, pd.DataFrame]:
        """Two-stage flight: separation `sep_delay_s` after booster burnout,
        sustainer ignition `ign_delay_s` after separation (the RASAero
        convention). Returns (summary, history)."""
        core = self.core
        self.set_motors(sustainer, booster)
        cfg = self.rocket.getFlightConfiguration(self.fcid)
        cfg.setAllStages()

        SepEvent = core.rocketcomponent.StageSeparationConfiguration.SeparationEvent
        sep = self.booster_stage.getSeparationConfigurations().get(self.fcid)
        sep.setSeparationEvent(SepEvent.BURNOUT)
        sep.setSeparationDelay(float(sep_delay_s))

        IgnitionEvent = core.motor.IgnitionEvent
        smc = self.mounts["sustainer"].getMotorConfig(self.fcid)
        smc.setIgnitionEvent(IgnitionEvent.BURNOUT)
        smc.setIgnitionDelay(float(sep_delay_s) + float(ign_delay_s))  # OpenRocket counts from burnout
        bmc = self.mounts["booster"].getMotorConfig(self.fcid)
        bmc.setIgnitionEvent(IgnitionEvent.LAUNCH)
        bmc.setIgnitionDelay(0.0)

        sim = core.document.Simulation(self._doc, self.rocket)
        sim.setFlightConfigurationId(self.fcid)
        opt = sim.getOptions()
        opt.setTimeStep(float(time_step))
        if site.get("altitude_ft") is not None:
            opt.setLaunchAltitude(site["altitude_ft"] * FT_TO_M)
        if site.get("rod_length_ft") is not None:
            opt.setLaunchRodLength(site["rod_length_ft"] * FT_TO_M)
        if site.get("rod_angle_deg") is not None:
            opt.setLaunchRodAngle(math.radians(site["rod_angle_deg"]))
        if site.get("temperature_f") is not None or site.get("pressure_inhg") is not None:
            opt.setISAAtmosphere(False)
            if site.get("temperature_f") is not None:
                opt.setLaunchTemperature((site["temperature_f"] - 32.0) * 5.0 / 9.0 + 273.15)
            if site.get("pressure_inhg") is not None:
                opt.setLaunchPressure(site["pressure_inhg"] * INHG_TO_PA)
        if site.get("wind_speed_mph") is not None:
            opt.setWindSpeedAverage(site["wind_speed_mph"] * MPH_TO_MS)
            opt.setWindSpeedDeviation(0.0)
        sim.simulate()
        data = sim.getSimulatedData()
        br = data.getBranch(0)
        T = core.simulation.FlightDataType

        def col(t):
            return np.array([float("nan") if v is None else float(v) for v in br.get(t)])

        time = col(T.TYPE_TIME)
        ev = {}
        for e in br.getEvents():
            ev.setdefault(str(e.getType().name()), []).append(float(e.getTime()))
        t_sep = min(ev.get("STAGE_SEPARATION", [float("inf")]))
        hist = pd.DataFrame(
            {
                "time_s": time,
                "stage": np.where(time < t_sep, 1, 2),
                "mach": col(T.TYPE_MACH_NUMBER),
                "thrust_lb": col(T.TYPE_THRUST_FORCE) * N_TO_LBF,
                "weight_lb": col(T.TYPE_MASS) * KG_TO_LB,
                "velocity_fps": col(T.TYPE_VELOCITY_TOTAL) * M_TO_FT,
                "altitude_ft": col(T.TYPE_ALTITUDE) * M_TO_FT,
                "accel_fps2": col(T.TYPE_ACCELERATION_TOTAL) * M_TO_FT,
                "distance_ft": np.hypot(col(T.TYPE_POSITION_X), col(T.TYPE_POSITION_Y)) * M_TO_FT,
                "cg_in": col(T.TYPE_CG_LOCATION) * M_TO_IN,
                "cp_in": col(T.TYPE_CP_LOCATION) * M_TO_IN,
                "stability_cal": col(T.TYPE_STABILITY),
            }
        )
        summary = {
            "max_alt_ft": float(data.getMaxAltitude()) * M_TO_FT,
            "t_apogee_s": float(data.getTimeToApogee()),
            "max_vel_fps": float(np.nanmax(hist["velocity_fps"])),
            "rail_exit_vel_fps": float(data.getLaunchRodVelocity()) * M_TO_FT,
            "events": ev,
            "warnings": [str(w) for w in sim.getSimulatedWarnings()],
        }
        return summary, hist
