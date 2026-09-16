import re

import numpy as np

from rpa.eng import expand_motor_sources, parse_eng, write_combined_eng
from rpa.motors import load_motor_set


def test_parse_booster_header_and_nozzle(motor_dirs):
    boosters, _ = motor_dirs
    path = expand_motor_sources(boosters)[0]
    ms = parse_eng(path)
    m = ms[0]
    if len(ms) == 1:
        idx, imp = re.match(r"^(\d+)-(\d+)[A-Z]\d+", path.stem).groups()
        assert m.designation.endswith(f"-{idx}") and m.label == path.stem and m.index == int(idx)
    else:  # multi-motor RASP file: ids are the designations
        imp, idx = re.match(r"^(\d+)[A-Z]\d+-(\d+)$", m.designation).groups()
        assert m.label == m.designation and m.index == int(idx) and m.n_in_file == len(ms)
        assert m.block_text.splitlines()[-1].split()[0] != m.designation  # ends with data, not the header
    assert m.manufacturer == "Maker"
    assert m.diameter_mm > 0 and m.length_mm > 0 and m.prop_mass_kg > 0
    assert m.nozzle_throat_in and m.nozzle_exit_in and m.nozzle_exit_in > m.nozzle_throat_in
    assert abs(m.total_impulse_ns - int(imp)) < 0.01 * int(imp)  # name encodes the impulse
    assert m.thrust_n[-1] == 0.0 and m.burn_time_s > 2
    assert m.rasaero_name() == f"{m.designation}  ({m.manufacturer})"


def test_sustainer_selection_is_max_impulse(motor_dirs):
    ms = load_motor_set(*motor_dirs)
    assert len(ms.boosters) >= 2 and len({b.label for b in ms.boosters}) == len(ms.boosters)
    best = max(ms.sustainer_candidates, key=lambda m: m.total_impulse_ns)
    assert ms.sustainer.total_impulse_ns == best.total_impulse_ns
    assert ms.sustainer.label == best.label


def test_combined_file_roundtrip(tmp_path, motor_dirs):
    from rpa.eng import load_motors

    ms = load_motors(motor_dirs[0])[:3]
    out = write_combined_eng(ms, tmp_path / "all.eng")
    back = parse_eng(out)
    assert [m.designation for m in back] == [m.designation for m in ms]  # each motor's own block only, even from a multi-motor file
    for a, b in zip(ms, back, strict=False):
        assert np.allclose(a.thrust_n, b.thrust_n)
        assert b.nozzle_exit_in == a.nozzle_exit_in


def test_multiple_sources_and_single_files(tmp_path, motor_dirs):
    from rpa.eng import load_motors

    # three one-motor files written from the fixture set
    motors = load_motors(motor_dirs[0])[:3]
    single = tmp_path / "single"
    single.mkdir()
    files = []
    for i, m in enumerate(motors):
        f = single / f"{i + 1:02d}-{m.designation.split('-')[0]}.eng"
        f.write_text(m.raw_text())
        files.append(f)
    sub = tmp_path / "extra"
    sub.mkdir()
    import shutil

    shutil.copy(files[0], sub / "99-extra.eng")
    got = expand_motor_sources([sub, files[1], files[1], str(files[2])])
    assert [p.name for p in got] == ["99-extra.eng", files[1].name, files[2].name]
    ms = load_motors([sub, files[1]])
    assert [m.label for m in ms] == ["99-extra", files[1].stem]
    # multi-motor file next to single files: ids come from its designations
    multi = tmp_path / "many.eng"
    multi.write_text("".join(m.raw_text() for m in motors))
    ms = load_motors([multi, files[0]])
    assert [m.label for m in ms][:3] == [m.designation for m in motors] and ms[-1].label == files[0].stem
    # the same file name in two folders is an error (labels are the ids)
    shutil.copy(files[1], sub / files[1].name)
    import pytest

    with pytest.raises(ValueError):
        load_motors([sub, files[1]])
    with pytest.raises(FileNotFoundError):
        load_motors([tmp_path / "nope"])
