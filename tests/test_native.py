"""rpa.native: the host protocol (fake host) and, when the engine is built,
RASAero's own numbers on this machine."""

import json
import sys
import textwrap
from pathlib import Path

import numpy as np
import pandas as pd
import pytest

from rpa.config import load_config
from rpa.models import SimRow
from rpa.native import HostError, HostProcess, NativeRASAeroBackend, engine_status

ROOT = Path(__file__).resolve().parents[1]
REF = ROOT / "input/rasaero_reference/ref01-27236O6601-01+59-13892N1513-sep15-ign15"
CDX1 = ROOT / "input/RASAero (.CDX1)/RAS_v1.3.CDX1"

FAKE_HOST = textwrap.dedent(
    """
    import json, sys, time
    for line in sys.stdin:
        req = json.loads(line)
        if req["op"] == "sleep":
            time.sleep(float(req["s"]))
        if req["op"] == "bad":
            print(json.dumps({"id": req["id"], "ok": False, "error": "nope"}), flush=True)
            continue
        if req["op"] == "die":
            sys.exit(3)
        print("noise line", flush=True)
        print(json.dumps({"id": req["id"], "ok": True, "echo": req}), flush=True)
    """
)


@pytest.fixture
def fake_host(tmp_path):
    p = tmp_path / "fake_host.py"
    p.write_text(FAKE_HOST)
    return HostProcess([sys.executable, str(p)], tmp_path, timeout_s=5.0, log=lambda *_: None)


def test_host_roundtrip_ignores_noise_and_matches_ids(fake_host):
    r1 = fake_host.request("ping")
    r2 = fake_host.request("design", cdx1="x.CDX1")
    assert r1["echo"]["op"] == "ping" and r2["echo"]["cdx1"] == "x.CDX1"
    assert r1["id"] != r2["id"]
    fake_host.close()


def test_host_errors_timeout_and_restart(fake_host):
    with pytest.raises(HostError, match="nope"):
        fake_host.request("bad")
    with pytest.raises(HostError, match="within"):
        fake_host.request("sleep", s=3.0, timeout_s=0.5)
    assert not fake_host.alive
    assert fake_host.request("ping")["ok"]  # restarted on demand
    with pytest.raises(HostError, match="exited|closed"):
        fake_host.request("die")
    fake_host.close()


def _cfg():
    return load_config(ROOT / "config.yaml", root=ROOT)


engine_ready = engine_status(_cfg())["ok"] and REF.with_suffix(".json").exists() and CDX1.exists()


@pytest.mark.skipif(not engine_ready, reason="RASAero native engine not built, or the reference inputs are missing")
def test_native_engine_reproduces_the_gui_reference_flight(tmp_path):
    cfg = _cfg()
    cfg["paths"]["output_dir"] = str(tmp_path / "out")
    meta = json.loads(REF.with_suffix(".json").read_text())
    row = SimRow.from_dict(meta["row"])
    expect = dict(meta["row"])
    row.max_alt_ft = row.max_vel_fps = row.t_apogee_s = None
    be = NativeRASAeroBackend(cfg, CDX1, [REF.with_name(REF.name + ".booster.eng"), REF.with_name(REF.name + ".sustainer.eng")], meta["site"], cfg["surface_finish"], log=lambda *_: None)
    try:
        be.run_batch([row], "golden")
        assert row.max_alt_ft == pytest.approx(expect["max_alt_ft"], rel=1e-4)
        assert row.max_vel_fps == pytest.approx(expect["max_vel_fps"], rel=1e-4)
        assert row.t_apogee_s == pytest.approx(expect["t_apogee_s"], abs=0.02)
        h = be.export(row, "golden")
        assert {"time_s", "mach", "thrust_lb", "weight_lb", "velocity_fps", "altitude_ft", "stage"} <= set(h.columns)
        assert (be.history_dir / "golden.csv").exists()
        assert abs(float(h["altitude_ft"].max()) - expect["max_alt_ft"]) < 1.0
        # inline history (float64 block) equals the CSV export; the batch form keeps order
        hi = be.history(row, "golden-inline")
        assert list(hi.columns) == list(h.columns) and len(hi) == len(h)
        for c in ("time_s", "mach", "altitude_ft", "velocity_fps", "weight_lb", "cg_in"):
            assert np.allclose(hi[c].to_numpy(), h[c].to_numpy(), rtol=1e-6, atol=1e-6), c
        assert hi["stage"].iloc[0] == "B" and set(hi["stage"]) <= {"B", "S"} and (hi["stage"] == h["stage"]).all()
        row2 = SimRow.from_dict(meta["row"])
        row2.ign_delay_s = row2.ign_delay_s + 1.0
        hs = list(be.histories([row, row2], ["a", "b"]))
        assert len(hs) == 2 and float(hs[0]["altitude_ft"].max()) == float(hi["altitude_ft"].max()) and float(hs[1]["altitude_ft"].max()) != float(hi["altitude_ft"].max())
        # aero table in RASAero's export layout (the app's engine self-test)
        t = be.aero_table("stack", 20000.0, 3.46, tmp_path / "stack_alt20000_noz3.46.csv", mach_max=0.5)
        tab = pd.read_csv(t)
        assert {"Mach", "Alpha", "CD Power-Off", "CD Power-On"} <= set(tab.columns)
        assert float(tab["Mach"].iloc[0]) == pytest.approx(0.01) and set(tab["Alpha"]) == {0, 2, 4}
    finally:
        be.close()
