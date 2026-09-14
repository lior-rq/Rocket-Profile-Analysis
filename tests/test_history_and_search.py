import numpy as np
import pandas as pd

from rpa import history as H
from rpa.config import load_config
from rpa.models import MassRow, ProfileEligibility
from rpa.profiles import characterize, eligibility
from rpa.search import ApogeeSearch


def synthetic_history(t_bo=6.0, sep=1.0, ign=3.0, m_bo=1.1, peak=1.25):
    t = np.arange(0, 40, 0.01)
    mach = np.where(t < 4.5, peak * t / 4.5, np.where(t <= t_bo, peak - (peak - m_bo) * (t - 4.5) / (t_bo - 4.5), m_bo - 0.08 * (t - t_bo)))
    mach = np.clip(mach, 0.05, None)
    thrust = np.where(t < t_bo, 5000 - 600 * t, 0.0)
    thrust = np.where((t >= t_bo + sep + ign) & (t < t_bo + sep + ign + 9), 300.0, thrust)  # ignition delay counts from separation
    weight = np.where(t < t_bo + sep, 124 - 3 * t, 54.0)
    stage = np.where(t < t_bo + sep, 1, 2)
    alt = np.cumsum(mach * 11) * 0.5
    return pd.DataFrame({"time_s": t, "stage": stage, "mach": mach, "thrust_lb": thrust, "weight_lb": weight, "velocity_fps": mach * 1100, "altitude_ft": alt, "distance_ft": 0 * t})


def test_event_detection():
    h = synthetic_history()
    assert abs(H.burnout_time(h) - 6.0) < 0.02
    assert abs(H.separation_time(h, after=6.0) - 7.0) < 0.02
    assert abs(H.ignition_time(h, after=6.0) - 10.0) < 0.02
    assert abs(H.first_time_below(h, "mach", 0.9, after=6.0) - (6.0 + 0.2 / 0.08)) < 0.05


def test_characterize_and_eligibility_transonic_booster():
    cfg = load_config(root=".")
    cfg["profiles"]["include_decel_subsonic"] = True
    cfg["profiles"]["separation_delay_max_s"] = 15.0  # the decel variant needs a late separation
    h = synthetic_history(sep=15, ign=15)
    c = characterize("b", h, cfg, 15, 15, rod_length_ft=None)
    assert c.events_consistent and abs(c.max_mach_boost - 1.25) < 0.01
    el = {e.profile: e for e in eligibility(c, h, cfg)}
    assert not el["subsonic"].eligible  # peaked at 1.25
    assert not el["supersonic"].eligible  # only 1.1 at burnout
    assert el["decel_subsonic"].eligible and el["decel_subsonic"].sep_min_s >= 3.1


def test_eligibility_supersonic_window_is_clipped_by_physics():
    cfg = load_config(root=".")
    cfg["profiles"].update({"separation_delay_min_s": 0.0, "separation_delay_max_s": 1.0})
    h = synthetic_history(m_bo=1.3, peak=1.4)  # 1.3 at burnout, falls below 1.25 after 0.625 s
    c = characterize("b", h, cfg, 1.0, 3.0, rod_length_ft=None)
    el = {e.profile: e for e in eligibility(c, h, cfg)}
    assert el["supersonic"].eligible and el["supersonic"].sep_min_s == 0.0 and abs(el["supersonic"].sep_max_s - 0.625) < 0.02
    # an earliest separation later than the window closes -> not eligible
    cfg["profiles"].update({"separation_delay_min_s": 0.8, "separation_delay_max_s": 1.0})
    el = {e.profile: e for e in eligibility(c, h, cfg)}
    assert not el["supersonic"].eligible and "separation_delay_min_s" in el["supersonic"].reason


def test_legacy_delay_keys_and_hard_floors(tmp_path):
    (tmp_path / "config.yaml").write_text("profiles:\n  separation_delay_s: 1.0\n  separation_delay_fallbacks: [0.5, -2.0]\n  ignition_gap_min_s: -1.0\n")
    cfg = load_config(root=tmp_path)
    p = cfg["profiles"]
    assert p["separation_delay_max_s"] == 1.0 and p["separation_delay_min_s"] == 0.0  # floor at burnout
    assert p["ignition_delay_min_s"] == 0.0  # floor at separation: ignition never before burnout
    assert "separation_delay_s" not in p and "ignition_gap_min_s" not in p
    (tmp_path / "config.yaml").write_text("profiles:\n  ignition_delay_min_s: 5\n  ignition_delay_max_s: 2\n")
    import pytest

    with pytest.raises(ValueError):
        load_config(root=tmp_path)


class FakeBackend:
    """apogee = peak - k*(delay - d_peak)^2, like the real curve."""

    name = "fake"

    def __init__(self, peak=46000, d_peak=12.0, k=60.0):
        self.peak, self.d_peak, self.k = peak, d_peak, k
        self.calls = 0

    def run_batch(self, rows, name):
        self.calls += 1
        for r in rows:
            r.max_alt_ft = self.peak - self.k * (r.ign_delay_s - self.d_peak) ** 2
            r.max_vel_fps, r.t_apogee_s = 1500.0, 50.0


class FakeMotor:
    def __init__(self, label):
        self.label, self.designation, self.manufacturer, self.nozzle_exit_in = label, label, "M", 3.0

    def rasaero_name(self, fmt):
        return fmt.format(designation=self.designation, manufacturer=self.manufacturer)


class FakeMotorSet:
    sustainer = FakeMotor("S")

    def booster(self, label):
        return FakeMotor(label)


def test_search_brackets_and_refines():
    cfg = load_config(root=".")
    cfg["target"] = {"apogee_ft": 45000.0, "tolerance_ft": 10.0}
    mass = {"B": MassRow("B", 54.0, 75.0, 124.0, 115.0, 15.0)}
    elig = [ProfileEligibility("B", "supersonic", True, 1.0, 1.0), ProfileEligibility("B", "subsonic", False, 1.0, 1.0)]
    be = FakeBackend()
    designs = ApogeeSearch(cfg, be, FakeMotorSet(), mass, elig, log=lambda *_: None).run()
    assert len(designs) == 1
    d = designs[0]
    assert d.status == "solved" and abs(d.apogee_ft - 45000) <= 10 and d.sep_delay_s == 1.0
    # the curve crosses 45000 at 12 - sqrt(1000/60) = 7.92 s (and again at 16.08, outside range)
    assert abs(d.ign_delay_s - 7.92) < 0.1
    assert be.calls <= 1 + cfg["profiles"]["max_refine_rounds"]


def test_search_separation_grid_prefers_shortest_coast():
    cfg = load_config(root=".")
    cfg["target"] = {"apogee_ft": 45000.0, "tolerance_ft": 10.0}
    cfg["profiles"].update({"separation_step_s": 0.5, "ignition_delay_min_s": 1.0, "ignition_delay_max_s": 15.0})
    mass = {"B": MassRow("B", 54.0, 75.0, 124.0, 115.0, 15.0)}
    elig = [ProfileEligibility("B", "supersonic", True, 0.0, 1.0)]  # window 0..1 s -> grid 0, 0.5, 1.0
    srch = ApogeeSearch(cfg, FakeBackend(), FakeMotorSet(), mass, elig, log=lambda *_: None)
    assert sorted({c.sep_delay_s for c in srch.cands}) == [0.0, 0.5, 1.0]
    designs = srch.run()
    assert len(designs) == 1
    d = designs[0]
    assert d.status == "solved"
    # the fake apogee does not depend on separation, so every grid point solves at ign 7.92 -> the shortest coast (sep 0) wins
    assert d.sep_delay_s == 0.0 and abs(d.ign_delay_s - 7.92) < 0.1
    assert d.extra["separation_delays_tried"] == [0.0, 0.5, 1.0] and all(len(x) == 3 for x in d.extra["samples"])


def test_search_reports_overpowered_hint():
    cfg = load_config(root=".")
    cfg["target"] = {"apogee_ft": 35000.0, "tolerance_ft": 10.0}
    mass = {"B": MassRow("B", 54.0, 75.0, 124.0, 115.0, 15.0)}
    elig = [ProfileEligibility("B", "supersonic", True, 1.0, 1.0)]
    designs = ApogeeSearch(cfg, FakeBackend(), FakeMotorSet(), mass, elig, log=lambda *_: None).run()
    assert designs[0].status == "overpowered" and "shortest allowed coast" in designs[0].hint and "separation_delay_min_s" in designs[0].hint
