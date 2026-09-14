"""openMotor .ric designs as motor inputs (needs openMotor's motorlib; skipped otherwise)."""

from pathlib import Path

import numpy as np
import pytest

from rpa import ric as R

RIC_DIR = Path.home() / "Code" / "Python" / "Rocket Optimization" / "outputs" / "motors"


def test_rasp_block_and_resample(tmp_path):
    t = np.linspace(0.002, 6.0, 3000)
    f = 6000.0 * np.ones_like(t)
    f[-1] = 0.0
    r = R.RicResult("30176O4949-71", "30176O4949", t, f, 15.93, 127.0, 1016.0, 1.74, 3.78, "Blue", ["WARNING: x"])
    block = R.rasp_block(r, Path("71-30176O4949.ric"), 0.002)
    from rpa.eng import parse_eng

    p = tmp_path / "m.eng"
    p.write_text(block)
    (m,) = parse_eng(p)
    assert m.designation == "30176O4949-71" and m.nozzle_exit_in == 3.78 and m.nozzle_throat_in == 1.74 and m.prop_mass_kg == 15.93
    assert m.thrust_n[-1] == 0.0 and len(m.time_s) <= R.CURVE_POINTS + 2
    assert m.total_impulse_ns == pytest.approx(6000.0 * 6.0, rel=2e-3)  # thinning keeps the impulse
    assert R._designation("MainBooster", "30176O4949") == "MainBooster" and R._designation("07-x", "1234M99") == "1234M99-07"


@pytest.mark.skipif(R.find_openmotor() is None or not RIC_DIR.exists(), reason="openMotor / sample .ric designs not on this machine")
def test_convert_ric_folder(tmp_path):
    from rpa.eng import load_motors

    src = tmp_path / "rics"
    src.mkdir()
    for f in sorted(RIC_DIR.glob("*.ric"))[:2]:
        (src / f.name).write_bytes(f.read_bytes())
    conv = R.RicConverter(tmp_path / "cache", "auto", 0.01, log=lambda *_: None)
    motors = load_motors([src], ric=conv)
    assert len(motors) == 2 and all(m.nozzle_exit_in and m.total_impulse_ns > 1000 for m in motors)
    assert conv.pending(sorted(src.glob("*.ric"))) == []  # cached now
    strict = R.RicConverter(tmp_path / "cache", "auto", 0.01, allow_simulate=False)
    assert load_motors([src], ric=strict)  # served from the cache without simulating
    (src / "new.ric").write_bytes(sorted(RIC_DIR.glob("*.ric"))[2].read_bytes())
    with pytest.raises(R.RicPending):
        load_motors([src], ric=strict)
