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


def write_tables(d: Path, cd_off=cd_curve, cd_on=None, alts=(3000, 20000, 40000), stack_noz=(3.0, 5.0), sus_noz=(2.4,)):
    d.mkdir(parents=True, exist_ok=True)
    mach = np.arange(0, 5.01, 0.05)
    for cfg, nozs in ((STACK, stack_noz), (SUSTAINER, sus_noz)):
        for alt in alts:
            for noz in nozs:
                on = cd_on(mach) if cd_on else cd_off(mach) - 0.05
                pd.DataFrame({"Mach Number": mach, "CD Power-Off": cd_off(mach), "CD Power-On": on}).to_csv(d / f"{cfg}_alt{alt}_noz{noz}.csv", index=False)
    return d


def const_motor(path: Path, thrust_n: float, burn_s: float, prop_kg: float) -> Motor:
    return Motor(path=path, designation="X", manufacturer="T", diameter_mm=100, length_mm=500, delays="0", prop_mass_kg=prop_kg, total_mass_kg=prop_kg * 1.5, time_s=np.array([1e-4, burn_s - 1e-4, burn_s]), thrust_n=np.array([thrust_n, thrust_n, 0.0]), nozzle_exit_in=3.5)


def test_atmosphere_standard_sea_level():
    atm = Atmosphere(0.0, 59.0, 29.92, density_model="hydrostatic")
    assert atm.density(0.0) == pytest.approx(0.002377, rel=2e-3)
    assert atm.speed_of_sound(0.0) == pytest.approx(1116.4, rel=2e-3)
    assert atm.pressure_psf(10000.0) == pytest.approx(1455.6, rel=5e-3)
    ras = Atmosphere(0.0, 59.0, 29.92)  # RASAero-calibrated density falls faster than hydrostatic
    assert ras.density(0.0) == pytest.approx(0.002377, rel=2e-3)
    assert ras.density(20000.0) < atm.density(20000.0)
    assert ras.speed_of_sound(20000.0) == pytest.approx(atm.speed_of_sound(20000.0))


def test_aero_interpolation(tmp_path):
    aero = AeroSet.load(write_tables(tmp_path / "aero", stack_noz=(3.0, 5.0)))
    # power-on differs per nozzle file only by construction here, so check the bookkeeping
    m3 = aero.model(STACK, 3.0)
    m4 = aero.model(STACK, 4.0)
    assert m3.cd(1.1, 3000, False) == pytest.approx(float(cd_curve(1.1)), rel=1e-6)
    assert m4.cd(0.5, 10000, True) == pytest.approx(float(cd_curve(0.5)) - 0.05, rel=1e-6)
    assert m3.cd(1.0, 100000, False) == pytest.approx(float(cd_curve(1.0)), rel=1e-6)  # above table: clamp
    assert not aero.coverage_problems(STACK, 4.0, 2.5, 50000)
    assert aero.coverage_problems(STACK, 7.0, 2.5, 50000)  # nozzle out of range


def test_vertical_no_drag_matches_analytic(tmp_path):
    aero = AeroSet.load(write_tables(tmp_path / "aero", cd_off=lambda m: 0.0 * np.asarray(m), cd_on=lambda m: 0.0 * np.asarray(m)))
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
    # altitude at burnout by integrating v(t) analytically
    mb = m0 - k * burn
    h_bo = (thrust_lbf / k) * (burn + (mb / k) * math.log(mb / m0)) - 0.5 * G0 * burn**2
    apogee = h_bo + v_bo**2 / (2 * G0)
    assert summ["max_alt_ft"] == pytest.approx(apogee, rel=2e-3)
    assert h.loc[h["time_s"] <= burn, "velocity_fps"].iloc[-1] == pytest.approx(v_bo, rel=2e-3)
    assert h["weight_lb"].iloc[-1] == pytest.approx(w0 - prop_lb, abs=1e-6)


def test_two_stage_events_and_columns(tmp_path):
    aero = AeroSet.load(write_tables(tmp_path / "aero"))
    sim = FlightSim(aero, SITE)
    booster = const_motor(tmp_path / "b.eng", 6000.0, 4.0, 8.0)
    sustainer = const_motor(tmp_path / "s.eng", 3000.0, 5.0, 6.0)
    veh = Vehicle(booster, sustainer, 125.0, 60.0, 6.12, 3.9, 2.4)
    summ, h = sim.run(veh, 1.0, 6.0)
    assert summ["t_sep_s"] == pytest.approx(5.0) and summ["t_ign_s"] == pytest.approx(11.0)  # ignition delay counts from separation
    assert set(RASAERO_COLUMNS.values()) - {"aoa_deg", "lift_lb", "cg_in", "cp_in", "stability_cal", "pitch_deg"} <= set(h.columns)
    w = h.set_index("time_s")["weight_lb"]
    assert w.loc[4.99] == pytest.approx(125.0 - 8.0 * KG_TO_LB, abs=1e-3)  # booster propellant gone
    assert w.loc[5.0] == pytest.approx(60.0, abs=1e-6)  # separated
    assert h.loc[h["time_s"] < 5.0, "stage"].eq(1).all() and h.loc[h["time_s"] >= 5.0, "stage"].eq(2).all()
    assert (h.loc[(h["time_s"] > 4.05) & (h["time_s"] < 10.95), "thrust_lb"] == 0).all()
    assert summ["rail_exit_vel_fps"] > 50 and summ["max_alt_ft"] > 10000 and h["altitude_ft"].iloc[-1] == pytest.approx(summ["max_alt_ft"], rel=1e-4)
    # drag column is consistent with cd and the atmosphere
    i = 300
    r = h.iloc[i]
    rho = sim.atm.density(r["altitude_ft"])
    assert r["drag_lb"] == pytest.approx(0.5 * rho * r["velocity_fps"] ** 2 * veh.ref_area_ft2 * r["cd"], rel=1e-6)


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

        pass

    cfg = load_config(root=tmp_path)
    cfg["paths"]["aero_dir"] = str(aero_dir)
    cfg["paths"]["output_dir"] = str(tmp_path / "out")
    ms = MS()
    ms.sustainer = sustainer
    be = PythonBackend(cfg, ms, SITE, 6.12)
    row = SimRow("b", None, 1.0, 6.0, "X", "X", 60.0, 50.0, 2.4, 125.0, 70.0, 3.9)
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
    assert len(h) == int(round(full["t_apogee_s"] / sim.dt)) + 1  # the run stops at apogee


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
    rows = [SimRow(b.label, None, sep, ign, "X", "X", 60.0, 50.0, 2.4, 125.0, 70.0, 3.9) for b in boosters for sep in (0.0, 1.0) for ign in (2.0, 6.0)]
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
