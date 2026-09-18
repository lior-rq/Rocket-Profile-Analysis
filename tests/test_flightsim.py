import math
from pathlib import Path

import numpy as np
import pandas as pd
import pytest

from rpa.aero import STACK, SUSTAINER, AeroSet
from rpa.atmosphere import G0, Atmosphere
from rpa.eng import Motor
from rpa.flightsim import KG_TO_LB, N_TO_LBF, FlightSim, Vehicle
from rpa.history import RASAERO_COLUMNS
from rpa.models import SimRow

SITE = {"altitude_ft": 2782.0, "pressure_inhg": 29.9, "rod_angle_deg": 3.0, "rod_length_ft": 22.0, "temperature_f": 110.0, "wind_speed_mph": 0.0}


def cd_curve(m):
    m = np.asarray(m, float)
    return 0.35 + 0.45 * np.exp(-(((m - 1.1) / 0.25) ** 2)) * (m > 0.8) + 0.2 * (m > 1.2) / np.maximum(m, 1.2)


def base_k(m):
    """Base-drag coefficient per in^2 of nozzle, as RASAero's power-on law needs."""
    return 0.004 + 0.002 * np.exp(-((np.asarray(m, float) - 1.0) ** 2))


def write_tables(d: Path, cd_off=cd_curve, alts=(0, 20000, 40000, 60000), stack_noz=(3.0,), sus_noz=(2.4,)):
    d.mkdir(parents=True, exist_ok=True)
    mach = np.arange(0, 5.01, 0.05)
    for cfg, nozs in ((STACK, stack_noz), (SUSTAINER, sus_noz)):
        for alt in alts:
            for noz in nozs:
                pd.DataFrame({"Mach Number": mach, "CD Power-Off": cd_off(mach), "CD Power-On": cd_off(mach) - base_k(mach) * noz**2}).to_csv(d / f"{cfg}_alt{alt}_noz{noz}.csv", index=False)
    return d


def const_motor(path: Path, thrust_n: float, burn_s: float, prop_kg: float) -> Motor:
    return Motor(path=path, designation="X", manufacturer="T", diameter_mm=100, length_mm=500, delays="0", prop_mass_kg=prop_kg, total_mass_kg=prop_kg * 1.5, time_s=np.array([1e-4, burn_s - 1e-4, burn_s]), thrust_n=np.array([thrust_n, thrust_n, 0.0]), nozzle_exit_in=3.5)


def test_atmosphere_is_rasaeros():
    std = Atmosphere(0.0, 59.0, 0.0)  # pressure 0: RASAero's 'no site' path
    assert std.pressure_psi(0.0) == pytest.approx(14.6958)
    assert std.density(0.0) == pytest.approx(0.0023769, rel=1e-4)
    assert std.speed_of_sound(0.0) == pytest.approx(1116.45, rel=1e-4)
    assert std.speed_of_sound(40000.0) == pytest.approx(math.sqrt(2403.07606 * 389.97))  # isothermal layer
    site = Atmosphere.from_site(SITE)
    # pad density recovered from a RASAero export of this site (drag = q S CD at t = 0.02 s)
    assert site.density(0.0) == pytest.approx(2 * 0.001125636 / (3.35888**2 * math.pi * (6.12 / 12) ** 2 / 4 * 0.4999309), rel=1e-3)
    assert site.temperature_r(0.0) == pytest.approx(110.0 + 459.69, rel=1e-4)  # RASAero's offset round trip loses 0.003 R
    assert site.temperature_r(60000.0) == pytest.approx(389.97)  # the hot day keeps lapsing past 36 000 ft
    assert site.density(20000.0) < std.density(20000.0)
    assert site.gravity(50000.0) < site.gravity(0.0) < G0 + 1e-9
    exp = Atmosphere.standard()
    assert exp.density_offset_ft == exp.temperature_offset_ft == exp.pressure_offset_ft == 0.0
    # a hot, high site has a lower Reynolds number at the same altitude
    assert site.reynolds_factor(30000.0) < exp.reynolds_factor(30000.0)


def test_aero_nozzle_law_and_interpolation(tmp_path):
    aero = AeroSet.load(write_tables(tmp_path / "aero", stack_noz=(3.0,)))
    m4 = aero.model(STACK, 4.0)
    assert m4.cd(1.1, 3000, False) == pytest.approx(float(cd_curve(1.1)), rel=1e-6)
    assert m4.cd(0.5, 10000, True) == pytest.approx(float(cd_curve(0.5) - base_k(0.5) * 16.0), rel=1e-6)  # scaled from the 3.0 in table
    assert aero.model(STACK, None).cd(0.5, 10000, True) == pytest.approx(float(cd_curve(0.5)), rel=1e-6)  # no nozzle: power-off
    assert m4.cd(1.0, 100000, False) == pytest.approx(float(cd_curve(1.0)), rel=1e-6)  # above the tables: clamp
    assert not aero.coverage_problems(STACK, 7.0, 2.5, 50000)
    assert aero.coverage_problems(SUSTAINER, 2.0, 6.0, 50000)  # Mach range too short


def test_vertical_no_drag_matches_analytic(tmp_path):
    aero = AeroSet.load(write_tables(tmp_path / "aero", cd_off=lambda m: 0.0 * np.asarray(m)))
    site = dict(SITE, rod_angle_deg=0.0, rod_length_ft=0.0)
    sim = FlightSim(aero, site, dt=0.005)
    thrust_lbf, burn, w0, prop_lb = 400.0, 4.0, 100.0, 20.0
    booster = const_motor(tmp_path / "b.eng", thrust_lbf / N_TO_LBF, burn, prop_lb / KG_TO_LB)
    sustainer = const_motor(tmp_path / "s.eng", 1.0 / N_TO_LBF, 0.5, 0.001)  # negligible
    veh = Vehicle(booster, sustainer, w0, 40.0, 6.0)
    summ, h = sim.run(veh, 100.0, 100.0)  # never separates / ignites before apogee
    # analytic: constant thrust, linearly decreasing mass m(t) = m0 - k t
    m0, k = w0 / G0, (prop_lb / G0) / burn
    v_bo = (thrust_lbf / k) * math.log(m0 / (m0 - k * burn)) - G0 * burn
    mb = m0 - k * burn
    h_bo = (thrust_lbf / k) * (burn + (mb / k) * math.log(mb / m0)) - 0.5 * G0 * burn**2
    apogee = h_bo + v_bo**2 / (2 * G0)
    # RASAero samples the thrust at the end of each step, so the last step of
    # the burn delivers nothing: 0.125 % less impulse here, 0.25 % less apogee
    assert summ["max_alt_ft"] == pytest.approx(apogee * (1 - 0.0025), rel=1e-3)
    assert h.loc[h["time_s"] <= burn, "velocity_fps"].iloc[-1] == pytest.approx(v_bo * (1 - 0.00125), rel=1e-3)
    assert h["weight_lb"].iloc[-1] == pytest.approx(w0 - prop_lb, abs=1e-6)
    assert summ["ignition_suppressed"] and summ["t_sep_s"] is None  # apogee inside the booster stage ends the flight


def test_two_stage_events_and_columns(tmp_path):
    aero = AeroSet.load(write_tables(tmp_path / "aero"))
    sim = FlightSim(aero, SITE)
    booster = const_motor(tmp_path / "b.eng", 6000.0, 4.0, 8.0)
    sustainer = const_motor(tmp_path / "s.eng", 3000.0, 5.0, 6.0)
    veh = Vehicle(booster, sustainer, 125.0, 60.0, 6.12, 3.9, 2.4)
    summ, h = sim.run(veh, 1.0, 6.0)
    # RASAero's float32 stage clock and its event rules
    assert h["time_s"].iloc[470] == pytest.approx(4.700012683868408, abs=1e-9)
    assert summ["t_sep_s"] == pytest.approx(5.0, abs=0.011)  # first step past burnout + separation delay
    assert summ["t_ign_s"] == pytest.approx(11.0, abs=0.011)  # ignition delay counts from separation
    assert set(RASAERO_COLUMNS.values()) - {"aoa_deg", "lift_lb", "cg_in", "cp_in", "stability_cal"} <= set(h.columns)
    st = h["stage"].to_numpy()
    k_sep = int(np.argmax(st == 2))
    assert h["time_s"].iloc[k_sep] == pytest.approx(summ["t_sep_s"]) and h["stage_time_s"].iloc[k_sep] == pytest.approx(0.01)
    assert (st[:k_sep] == 1).all() and (st[k_sep:] == 2).all()
    w = h["weight_lb"].to_numpy()
    assert w[1] == 125.0 and w[2] < 125.0  # the weight column lags the burn by one step
    assert w[k_sep - 1] == pytest.approx(125.0 - 8.0 * KG_TO_LB, abs=1e-3)  # booster propellant gone
    assert w[k_sep] == pytest.approx(60.0, abs=1e-6)  # separated
    thr = h["thrust_lb"].to_numpy()
    assert (thr[(h["time_s"] > 4.05) & (h["time_s"] < 10.95)] == 0).all()
    assert summ["rail_exit_vel_fps"] > 50 and summ["max_alt_ft"] > 10000
    assert h["altitude_ft"].idxmax() == len(h) - 2  # the run stops one step past apogee
    # drag / Mach / CD of a row come from the state at the start of its step
    i = 300
    r, prev = h.iloc[i], h.iloc[i - 1]
    rho, a = sim.atm.rho_and_a(prev["altitude_ft"])
    assert r["mach"] == pytest.approx(prev["velocity_fps"] / a, rel=1e-9)
    assert r["drag_lb"] == pytest.approx(0.5 * rho * prev["velocity_fps"] ** 2 * veh.ref_area_ft2 * r["cd"], rel=1e-9)


def test_sustainer_never_lights_after_apogee(tmp_path):
    """RASAero ends a sustainer stage at the first descending step once the
    stage clock is past the motor's burn time, whether or not it has lit."""
    aero = AeroSet.load(write_tables(tmp_path / "aero"))
    sim = FlightSim(aero, SITE)
    booster = const_motor(tmp_path / "b.eng", 6000.0, 4.0, 8.0)
    sustainer = const_motor(tmp_path / "s.eng", 3000.0, 5.0, 6.0)
    veh = Vehicle(booster, sustainer, 125.0, 60.0, 6.12, 3.9, 2.4)
    coast, _ = sim.run(veh, 1.0, 100.0)
    assert coast["ignition_suppressed"] and coast["t_ign_s"] is None and coast["max_alt_ft"] < 20000
    lit, _ = sim.run(veh, 1.0, 6.0)
    assert not lit["ignition_suppressed"] and lit["max_alt_ft"] > coast["max_alt_ft"]


def test_validation_harness_passes_on_own_output(tmp_path):
    """The harness must at least pass when the 'RASAero export' IS our output."""
    from rpa.backends import PythonBackend
    from rpa.config import load_config
    from rpa.validate import load_cases, run_validation, save_case

    aero_dir = write_tables(tmp_path / "aero")
    booster = const_motor(tmp_path / "b.eng", 6000.0, 4.0, 8.0)
    sustainer = const_motor(tmp_path / "s.eng", 3000.0, 5.0, 6.0)

    class MS:
        sustainer = None

        def booster(self, label):
            return booster

        def sustainer_by_label(self, label):
            return self.sustainer

    cfg = load_config(root=tmp_path)
    cfg["paths"]["aero_dir"] = str(aero_dir)
    cfg["paths"]["output_dir"] = str(tmp_path / "out")
    ms = MS()
    ms.sustainer = sustainer
    be = PythonBackend(cfg, ms, SITE, 6.12)
    row = SimRow("b", None, 1.0, 6.0, "X", "X", 60.0, 50.0, 2.4, 125.0, 70.0, 3.9, "s")
    h = be.export(row, "case")
    inv = {v: k for k, v in RASAERO_COLUMNS.items()}
    export = h.rename(columns=inv)
    export.to_csv(tmp_path / "export.csv", index=False)
    save_case(tmp_path / "ref", "case1", tmp_path / "export.csv", row, SITE)
    cases = load_cases(tmp_path / "ref")
    df = run_validation(cases, be, cfg["validation"], tmp_path / "val", log=lambda *_: None)
    assert bool(df["pass"].all()), df["fail_reasons"].tolist()
    assert (tmp_path / "val" / "case1.png").exists()


def test_summary_only_run_matches_full_run(tmp_path):
    from rpa.flightsim import FlightSim, Vehicle

    sim = FlightSim(AeroSet.load(write_tables(tmp_path / "aero")), SITE)
    veh = Vehicle(const_motor(tmp_path / "b.eng", 6000.0, 4.0, 8.0), const_motor(tmp_path / "s.eng", 3000.0, 5.0, 6.0), 125.0, 60.0, 6.12, 3.9, 2.4)
    full, h = sim.run(veh, 1.0, 6.0)
    fast, none = sim.run(veh, 1.0, 6.0, history=False)
    assert none is None
    for k in ("max_alt_ft", "t_apogee_s", "max_vel_fps", "max_mach", "rail_exit_vel_fps", "t_sep_s", "t_ign_s"):
        assert fast[k] == pytest.approx(full[k], abs=1e-9), k
    assert h["altitude_ft"].max() == full["max_alt_ft"] and h["time_s"].iloc[h["altitude_ft"].idxmax()] == full["t_apogee_s"]


def test_parallel_batch_matches_serial(tmp_path):
    """The process pool (spawn) must reproduce the serial integrator exactly."""
    import copy

    from rpa.backends import PythonBackend
    from rpa.config import load_config
    from rpa.motors import MotorSet

    aero_dir = write_tables(tmp_path / "aero")
    boosters = [const_motor(tmp_path / f"b{i}.eng", 5000.0 + 500 * i, 4.0, 8.0) for i in range(3)]
    sustainer = const_motor(tmp_path / "s.eng", 3000.0, 5.0, 6.0)
    ms = MotorSet(boosters=boosters, sustainer=sustainer, sustainer_candidates=[sustainer])
    cfg = load_config(root=tmp_path)
    cfg["paths"]["aero_dir"] = str(aero_dir)
    cfg["paths"]["output_dir"] = str(tmp_path / "out")
    rows = [SimRow(b.label, None, sep, ign, "X", "X", 60.0, 50.0, 2.4, 125.0, 70.0, 3.9, sustainer.label) for b in boosters for sep in (0.0, 1.0) for ign in (2.0, 6.0)]
    serial = PythonBackend(cfg, ms, SITE, 6.12, log=lambda *_: None, workers=1)
    rows_s = copy.deepcopy(rows)
    serial.run_batch(rows_s, "s")
    msgs = []
    par = PythonBackend(cfg, ms, SITE, 6.12, log=msgs.append, workers=2)
    try:
        par.run_batch(rows, "p")
        assert par._pool is not None and not any("pool failed" in m for m in msgs), msgs  # really ran in the pool
    finally:
        par.close()
    assert par.workers == 2 and len(rows) >= 4 * par.workers
    for a, b in zip(rows_s, rows, strict=True):
        assert a.max_alt_ft == b.max_alt_ft and a.max_vel_fps == b.max_vel_fps and a.t_apogee_s == b.t_apogee_s
