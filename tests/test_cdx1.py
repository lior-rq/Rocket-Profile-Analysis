from pathlib import Path

from rpa import cdx1
from rpa.models import SimRow

ROOT = Path(__file__).resolve().parents[1]
TEMPLATE = ROOT / "input/RASAero (.CDX1)/RAS_v1.3.CDX1"


def row(ign, sep=1.0):
    return SimRow("01-x", "supersonic", sep, ign, "S  (M)", "B  (M)", 54.5, 75.7, 2.39, 124.0, 115.5, 3.88, "S")


def test_launch_site_read():
    site = cdx1.launch_site(cdx1.load(TEMPLATE))
    assert site["altitude_ft"] == 2782 and site["rod_length_ft"] == 22 and site["temperature_f"] == 110


def test_write_batch_and_read_back(tmp_path):
    t = cdx1.load(TEMPLATE)
    rows = [row(3.0), row(4.5)]
    out = cdx1.write_batch(t, rows, tmp_path / "b.CDX1", launch_site_overrides={"wind_speed_mph": 5}, surface="Rough Camouflage Paint")
    text = out.read_text()
    assert "<Surface>Rough Camouflage Paint</Surface>" in text
    assert "<WindSpeed>5</WindSpeed>" in text
    assert text.count("<Simulation>") == 2
    res = cdx1.read_results(out)
    assert [r["ign_delay_s"] for r in res] == [3.0, 4.5]
    assert res[0]["booster_engine"] == "B  (M)"
    # untouched template still has its original single simulation
    assert len(t.getroot().findall("SimulationList/Simulation")) == 1


def test_merge_results_detects_unrun_rows(tmp_path):
    rows = [row(3.0), row(4.5)]
    results = cdx1.read_results(cdx1.write_batch(cdx1.load(TEMPLATE), rows, tmp_path / "b.CDX1"))
    results[0]["max_alt_ft"] = 45000.0
    problems = cdx1.merge_results(rows, results)
    assert rows[0].max_alt_ft == 45000.0 and rows[1].max_alt_ft is None
    assert len(problems) == 1 and "row 1" in problems[0]
