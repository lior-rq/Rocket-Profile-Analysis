"""GUI backend: comment-preserving config edits, the subprocess runner, the
state collector on an empty project and the HTTP API."""

from __future__ import annotations

import json
import threading
import time
import urllib.request
from http.server import ThreadingHTTPServer
from pathlib import Path

import numpy as np
import pandas as pd
import pytest
import yaml

from rpa.gui.runner import Runner
from rpa.gui.server import App, Handler
from rpa.gui.state import StateCollector
from rpa.gui.yamledit import set_many, set_scalar

CONFIG = """# top comment
paths:
  ork: "input/a b.ork"     # the model
  cdx1: input/x.CDX1

target:
  apogee_ft: 45000
  tolerance_ft: 100       # keep

launch_site:
  altitude_ft: null       # null = CDX1
backend: python   # python | rasaero
"""


def test_yamledit_preserves_comments_and_round_trips():
    out = set_many(CONFIG, {"target.apogee_ft": 44000, "paths.ork": "input/new (1).ork", "launch_site.altitude_ft": 2782, "backend": "rasaero", "target.newkey": [1, 2.5]})
    d = yaml.safe_load(out)
    assert d["target"]["apogee_ft"] == 44000
    assert d["target"]["newkey"] == [1, 2.5]
    assert d["paths"]["ork"] == "input/new (1).ork"
    assert d["paths"]["cdx1"] == "input/x.CDX1"
    assert d["launch_site"]["altitude_ft"] == 2782
    assert d["backend"] == "rasaero"
    assert "# top comment" in out and "# the model" in out and "# keep" in out and "# null = CDX1" in out and "# python | rasaero" in out
    # a new top-level section is appended
    out2 = set_scalar(out, ["worker", "mode"], "manual")
    assert yaml.safe_load(out2)["worker"]["mode"] == "manual"


def test_yamledit_rejects_bad_round_trip():
    with pytest.raises(ValueError):
        set_scalar("a: 1\n", ["a", "b"], 2)  # 'a' is a scalar, cannot nest


def test_runner_runs_and_records_history(tmp_path):
    r = Runner(tmp_path, tmp_path / "runs.json")
    q = r.subscribe()
    r.start("check", [])  # no inputs in tmp_path -> exits non-zero quickly
    for _ in range(300):
        if not r.current()["running"]:
            break
        time.sleep(0.05)
    st = r.current()
    assert st["running"] is False and st["exit_code"] not in (None, 0)
    texts = [x["text"] for x in r.lines]
    assert texts[0].startswith("$ python -m rpa check") and texts[-1].startswith("--- check")
    assert r.history[-1]["stage"] == "check" and json.loads((tmp_path / "runs.json").read_text())[-1]["exit_code"] == st["exit_code"]
    events = []
    while not q.empty():
        events.append(q.get_nowait()[0])
    assert "log" in events and "state" in events
    r2 = Runner(tmp_path)
    r2.start("gui", [])  # would run forever...
    with pytest.raises(RuntimeError):
        r2.start("search", [])  # ...so a second long stage must be refused
    r2.cancel()


def test_state_collector_on_empty_project(tmp_path):
    sc = StateCollector(tmp_path)
    s = sc.collect(Runner(tmp_path))
    assert s["inputs"]["status"] == "error" and s["inputs"]["problems"]
    for k in ("aero", "reference", "validate", "optimize", "results", "confirm"):
        assert s[k]["status"] == "todo"
    assert s["worker"]["state"] == "offline"
    assert sc.options() == {"ork": [], "cdx1": [], "motor_dirs": []}
    s2 = sc.collect(Runner(tmp_path))
    assert s2["inputs"]["boosters"]["n"] == 0 and s2["inputs"]["boosters"]["problems"]


_SERVER_ROOTS: dict[str, str] = {}


def server_root(url: str) -> str:
    return _SERVER_ROOTS[url]


@pytest.fixture
def server(tmp_path):
    (tmp_path / "config.yaml").write_text(CONFIG)
    (tmp_path / "output").mkdir()
    (tmp_path / "output" / "designs.csv").write_text("booster,profile,sep_delay_s,ign_delay_s,apogee_ft,status\nb1,supersonic,1.0,2.0,45050.0,solved\n")
    app = App(tmp_path, watch=False)
    handler = type("H", (Handler,), {"app": app})
    httpd = ThreadingHTTPServer(("127.0.0.1", 0), handler)
    t = threading.Thread(target=httpd.serve_forever, daemon=True)
    t.start()
    url = f"http://127.0.0.1:{httpd.server_address[1]}"
    _SERVER_ROOTS[url] = str(tmp_path)
    yield url
    httpd.shutdown()


def _get(url):
    with urllib.request.urlopen(url, timeout=5) as r:
        return r.status, json.loads(r.read() or b"{}") if r.headers.get_content_type() == "application/json" else r.read()


def _post(url, body):
    req = urllib.request.Request(url, data=json.dumps(body).encode(), headers={"Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=5) as r:
            return r.status, json.loads(r.read())
    except urllib.error.HTTPError as e:
        return e.code, json.loads(e.read())


def test_http_api(server):
    status, page = _get(server + "/")
    assert status == 200 and b"Rocket Profile Analysis" in page
    status, ping = _get(server + "/api/ping")
    assert status == 200 and ping["app"] == "rpa" and Path(ping["root"]).name == Path(server_root(server)).name
    status, st = _get(server + "/api/state")
    assert status == 200 and st["results"]["n"] == 1 and st["results"]["best"]["booster"] == "b1"
    status, t = _get(server + "/api/table/designs")
    assert t["rows"][0]["apogee_ft"] == 45050.0
    # config edit through the API keeps comments
    status, c = _post(server + "/api/config", {"set": {"target.apogee_ft": 40000}})
    assert status == 200 and c["parsed"]["target"]["apogee_ft"] == 40000 and "# keep" in c["text"]
    # path guard
    status, _ = _post(server + "/api/run", {"stage": "rm", "args": []})
    assert status == 400
    status, _ = _post(server + "/api/run", {"stage": "check", "args": ["--evil"]})
    assert status == 400
    with pytest.raises(urllib.error.HTTPError) as ei:
        _get(server + "/api/history?path=../../etc/passwd")
    assert ei.value.code in (403, 404)
    with pytest.raises(urllib.error.HTTPError) as ei:
        _get(server + "/files/../config.yaml")
    assert ei.value.code in (403, 404)


def test_launcher_port_choice_and_app_bundle(server, tmp_path):
    import sys

    from rpa.gui.launcher import choose_port, ping

    port = int(server.rsplit(":", 1)[1])
    assert ping(port)["app"] == "rpa"
    # same repo -> reuse the running instance
    p, running = choose_port(port, Path(server_root(server)))
    assert p == port and running is not None
    # another repo -> that port is skipped, a free one is chosen
    p2, running2 = choose_port(port, tmp_path / "other")
    assert p2 != port and running2 is None
    if sys.platform == "darwin":
        from rpa.gui.launcher import make_app

        root = tmp_path / "proj"
        (root / "worker").mkdir(parents=True)
        (made,) = make_app(root, install=False)
        assert made.name.endswith(".app") and (made / "Contents" / "MacOS" / "launch").exists() and (made / "Contents" / "Info.plist").exists()
        assert str(root) in (made / "Contents" / "MacOS" / "launch").read_text()


ENG_BOOSTERS = """; Throat 1.500 in, exit 3.000 in.
B1-01 127 1016 0 13.7 13.7 Maker
0.1 6000
4.0 6100
4.1 0
; Throat 1.400 in, exit 2.900 in.
B2-02 127 1016 0 14.0 14.0 Maker
0.1 6500
4.3 0
"""
ENG_SUSTAINER = """; Throat 1.400 in, exit 2.450 in.
S1-01 79 1219 0 8.5 8.5 Maker
0.1 2400
9.0 0
"""
CDX1 = """<RASAeroDocument><FileVersion>2</FileVersion><RocketDesign>
<NoseCone><PartType>NoseCone</PartType><Length>40</Length><Diameter>6</Diameter><Shape>LV-Haack</Shape><Location>0</Location></NoseCone>
<BodyTube><PartType>BodyTube</PartType><Length>80</Length><Diameter>6</Diameter><Location>40</Location><BoattailLength>0</BoattailLength><BoattailRearDiameter>0</BoattailRearDiameter>
<Fin><Count>4</Count><Chord>10</Chord><Span>5</Span><SweepDistance>4</SweepDistance><TipChord>6</TipChord><Location>14</Location></Fin></BodyTube>
<Booster><PartType>Booster</PartType><Length>55</Length><Diameter>6</Diameter><Location>120</Location><BoattailLength>0</BoattailLength><BoattailRearDiameter>0</BoattailRearDiameter>
<Fin><Count>4</Count><Chord>10</Chord><Span>5</Span><SweepDistance>4</SweepDistance><TipChord>6</TipChord><Location>11</Location></Fin></Booster>
</RocketDesign><LaunchSite><Altitude>0</Altitude></LaunchSite><SimulationList/></RASAeroDocument>
"""


@pytest.fixture
def design_project(tmp_path):
    (tmp_path / "input" / "motors" / "sus").mkdir(parents=True)
    (tmp_path / "input" / "motors" / "boosters.eng").write_text(ENG_BOOSTERS)
    (tmp_path / "input" / "motors" / "sus" / "01-S1.eng").write_text(ENG_SUSTAINER)
    (tmp_path / "input" / "x.CDX1").write_text(CDX1)
    (tmp_path / "config.yaml").write_text(CONFIG)
    # the run's motor tables point at the files the designs were flown with
    out = tmp_path / "output"
    out.mkdir()
    bfile = tmp_path / "input" / "motors" / "boosters.eng"
    (out / "boosters.csv").write_text(f"label,designation,file\nB2-02,B2-02,{bfile}\nB1-01,B1-01,{bfile}\n")
    (out / "sustainers.csv").write_text(f"label,designation,file\n01-S1,S1-01,{tmp_path / 'input' / 'motors' / 'sus' / '01-S1.eng'}\n")
    (out / "designs.csv").write_text("booster,profile,sep_delay_s,ign_delay_s,apogee_ft,status,sustainer,t_apogee_s\nB2-02,supersonic,0.5,1.0,45050.0,solved,01-S1,52.0\n")
    return tmp_path


def test_design_assets_lookup_geometry_and_downloads(design_project):
    import io
    import zipfile

    from rpa.gui.design import DesignAssets

    da = DesignAssets(StateCollector(design_project), design_project)
    d = da.design("B2-02", "01-S1")
    assert d["booster"]["designation"] == "B2-02" and d["booster"]["n_in_file"] == 2 and d["booster"]["nozzle_exit_in"] == 2.9
    assert d["sustainer"]["label"] == "01-S1" and d["sustainer"]["designation"] == "S1-01" and d["sustainer"]["impulse_class"] == "S"
    assert d["booster"]["curve"]["t"][-1] == 4.3 and d["booster"]["file"] == "input/motors/boosters.eng"
    geo = d["vehicle"]
    assert geo["total_length_in"] == 175 and geo["sustainer_length_in"] == 120 and geo["booster_length_in"] == 55
    assert geo["parts"][0]["shape"] == "LV-Haack" and geo["parts"][2]["type"] == "Booster" and geo["parts"][2]["fins"]["location_in"] == 11
    # a motor missing from the run is reported, not a crash
    d2 = da.design("nope", "01-S1")
    assert d2["booster"] is None and "nope" in d2["booster_error"]
    # one motor's own RASP block, terminated
    name, text = da.eng_download("booster", "B2-02")
    assert name == "B2-02.eng" and text.decode().startswith("; Throat 1.400") and "B1-01" not in text.decode() and text.decode().rstrip().endswith(";")
    # the combo zip
    name, data = da.combo_download("B2-02", "01-S1", "supersonic")
    assert name == "B2-02+01-S1-supersonic.zip"
    z = zipfile.ZipFile(io.BytesIO(data))
    assert sorted(z.namelist()) == sorted(["booster-B2-02.eng", "sustainer-01-S1.eng", "B2-02+01-S1.eng", "design.json", "README.txt"])
    combined = z.read("B2-02+01-S1.eng").decode()
    assert combined.index("B2-02 127") < combined.index("S1-01 79") and "B1-01" not in combined
    summary = json.loads(z.read("design.json"))
    assert summary["design"]["sep_delay_s"] == 0.5 and summary["design"]["ign_delay_s"] == 1.0 and summary["booster"]["label"] == "B2-02"
    assert "separation : 0.5 s" in z.read("README.txt").decode()
    with pytest.raises(FileNotFoundError):
        da.combo_download("B2-02", "missing")


def test_design_http_routes(design_project):
    hist_dir = design_project / "output" / "histories"
    hist_dir.mkdir()
    (hist_dir / "final-B2-02+01-S1-supersonic.csv").write_text("time_s,mach\n0.0,0.0\n")
    app = App(design_project, watch=False)
    handler = type("H", (Handler,), {"app": app})
    httpd = ThreadingHTTPServer(("127.0.0.1", 0), handler)
    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    url = f"http://127.0.0.1:{httpd.server_address[1]}"
    try:
        status, d = _get(url + "/api/design?booster=B2-02&sustainer=01-S1")
        assert status == 200 and d["booster"]["label"] == "B2-02" and d["vehicle"]["total_length_in"] == 175
        assert d["history"] is None  # no profile given -> no lookup
        _, d2 = _get(url + "/api/design?booster=B2-02&sustainer=01-S1&profile=supersonic")
        assert d2["history"]["path"] == "output/histories/final-B2-02+01-S1-supersonic.csv"
        _, d3 = _get(url + "/api/design?booster=B2-02&sustainer=01-S1&profile=subsonic")
        assert d3["history"] is None  # no history for that profile yet
        with urllib.request.urlopen(url + "/download/combo?booster=B2-02&sustainer=01-S1&profile=supersonic", timeout=5) as r:
            assert r.headers["Content-Type"] == "application/zip" and 'filename="B2-02+01-S1-supersonic.zip"' in r.headers["Content-Disposition"]
            assert r.read()[:2] == b"PK"
        with urllib.request.urlopen(url + "/download/eng?kind=sustainer&label=01-S1", timeout=5) as r:
            assert 'filename="01-S1.eng"' in r.headers["Content-Disposition"] and b"S1-01 79 1219" in r.read()
        for bad in ("/download/eng?kind=evil&label=01-S1", "/download/eng?kind=booster", "/download/combo?booster=B2-02"):
            with pytest.raises(urllib.error.HTTPError) as ei:
                _get(url + bad)
            assert ei.value.code == 400
        with pytest.raises(urllib.error.HTTPError) as ei:
            _get(url + "/download/eng?kind=booster&label=nope")
        assert ei.value.code == 404
    finally:
        httpd.shutdown()


def _write_aero_tables(d: Path):
    """Minimal stack/sustainer CD tables covering the fixture's flight."""
    d.mkdir(parents=True, exist_ok=True)
    mach = np.arange(0, 6.01, 0.05)
    cd = 0.4 + 0.3 * np.exp(-(((mach - 1.1) / 0.3) ** 2))
    for cfg, noz in (("stack", 3.0), ("sustainer", 2.45)):
        for alt in (0.0, 60000.0):
            pd.DataFrame({"Mach Number": mach, "CD Power-Off": cd, "CD Power-On": cd - 0.05}).to_csv(d / f"{cfg}_alt{alt:g}_noz{noz:g}.csv", index=False)


def test_flight_simulation_endpoint(design_project):
    """/api/flight: on-demand python-backend flight for a design that has
    not gone through the verify stage yet (no output/histories/final-*.csv)."""
    _write_aero_tables(design_project / "input" / "aero")
    bfile = design_project / "input" / "motors" / "boosters.eng"
    sfile = design_project / "input" / "motors" / "sus" / "01-S1.eng"
    (design_project / "config.yaml").write_text(f"""paths:
  ork: "input/a b.ork"
  cdx1: input/x.CDX1
  boosters: {bfile}
  sustainers: {sfile}
target:
  apogee_ft: 45000
  tolerance_ft: 100
launch_site:
  altitude_ft: null
backend: python
mass_model:
  method: manual
  manual:
    sustainer_wt_lb: 55
    sustainer_cg_in: 75
    combined_wt_lb_ref: 120
    combined_cg_in_ref: 110
    ref_booster_prop_kg: 13.7
    booster_prop_cg_in: 130
""")
    app = App(design_project, watch=False)
    handler = type("H", (Handler,), {"app": app})
    httpd = ThreadingHTTPServer(("127.0.0.1", 0), handler)
    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    url = f"http://127.0.0.1:{httpd.server_address[1]}"
    try:
        status, d = _get(url + "/api/flight?booster=B2-02&sustainer=01-S1&profile=supersonic&sep=0.5&ign=1.0")
        assert status == 200 and d["path"] is None and d["n"] > 1
        assert set(["time_s", "mach", "altitude_ft", "velocity_fps"]).issubset(d["columns"])
        assert d["summary"]["apogee_ft"] > 0 and d["summary"]["t_burnout_s"] > 0
        with pytest.raises(urllib.error.HTTPError) as ei:
            _get(url + "/api/flight?booster=nope&sustainer=01-S1&profile=supersonic&sep=0.5&ign=1.0")
        assert ei.value.code == 500
    finally:
        httpd.shutdown()


def test_runner_side_stage_and_per_run_logs(tmp_path):
    """A light stage (check) runs beside a long one; every run gets a log file."""
    r = Runner(tmp_path, tmp_path / "runs.json", log_dir=tmp_path / "logs")
    r.start("gui", ["--no-browser"])  # long-lived main stage
    st = r.start("check", [])
    assert st["side"] and st["side"]["stage"] == "check" and st["running"]
    for _ in range(400):
        if r.current()["side"] is None:
            break
        time.sleep(0.05)
    assert r.current()["side"] is None
    rec = r.history[-1]
    assert rec["stage"] == "check" and rec.get("side") is True and rec["log"] and (tmp_path / rec["log"]).exists()
    with pytest.raises(RuntimeError):
        r.start("search", [])  # a second long stage is still refused
    assert r.cancel()


def test_manifest_diff_ignores_unrelated_config(tmp_path):
    from rpa import manifest
    from rpa.config import load_config

    (tmp_path / "config.yaml").write_text(CONFIG)
    cfg = load_config(root=tmp_path)
    manifest.write(cfg, "search")
    entry = manifest.read(cfg)["search"]
    assert manifest.diff(entry, manifest.snapshot(cfg, "search")) == []
    cfg2 = load_config(root=tmp_path, overrides={"target": {"apogee_ft": 40000}, "vm": {"name": "Other"}})
    changes = manifest.diff(entry, manifest.snapshot(cfg2, "search"))
    assert any("target.apogee_ft" in c and "40000" in c for c in changes)
    assert not any("vm.name" in c for c in changes)
    # a rewrite with identical content is not a change (digests, not mtimes)
    p = tmp_path / "input" / "a b.ork"
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text("ork")
    manifest.write(cfg, "mass")
    time.sleep(0.02)
    p.write_text("ork")
    assert manifest.diff(manifest.read(cfg)["mass"], manifest.snapshot(cfg, "mass")) == []
    p.write_text("changed")
    assert any("a b.ork" in c for c in manifest.diff(manifest.read(cfg)["mass"], manifest.snapshot(cfg, "mass")))


def test_results_shortlist_samples_archives_cleanup_jobs(server):
    root = Path(server_root(server))
    (root / "output" / "designs_samples.json").write_text(json.dumps({"b1|s|supersonic": [[1.0, 45000.0, 1.0]], "other": [[2.0, 1.0, 1.0]]}))
    _, d = _get(server + "/api/samples?key=b1%7Cs%7Csupersonic")
    assert list(d) == ["b1|s|supersonic"]
    _, d = _get(server + "/api/samples?keys=b1%7Cs%7Csupersonic,other")
    assert set(d) == {"b1|s|supersonic", "other"}
    # shortlist round trip, visible in the state
    _, d = _post(server + "/api/shortlist", {"add": "b1|s|supersonic"})
    assert d["keys"] == ["b1|s|supersonic"]
    _, st = _get(server + "/api/state")
    assert st["results"]["shortlist"] == ["b1|s|supersonic"] and "disk" in st and st["worker"]["n_orphan"] == 0
    _, d = _post(server + "/api/shortlist", {"remove": "b1|s|supersonic"})
    assert d["keys"] == []
    _, w = _get(server + "/api/worker")
    assert "jobs" in w and "current_job" in w
    _, r = _get(server + "/api/runs")
    assert "history" in r and "runner" in r
    # snapshot of the results and its diff source
    status, snap = _post(server + "/api/archive", {"label": "t"})
    assert status == 200 and "designs.csv" in snap["files"] and snap["name"].endswith("-t")
    _, ar = _get(server + "/api/archives")
    assert ar["archives"][0]["n_designs"] == 1 and ar["archives"][0]["label"] == "t"
    _, a = _get(server + "/api/archive?name=" + snap["name"])
    assert a["rows"][0]["booster"] == "b1"
    # bulky outputs can be cleared
    hd = root / "output" / "histories"
    hd.mkdir()
    (hd / "final-x.csv").write_text("a\n")
    _, c = _post(server + "/api/cleanup", {"what": "histories"})
    assert c["removed"] == 1 and not (hd / "final-x.csv").exists()
    status, _ = _post(server + "/api/cleanup", {"what": "nope"})
    assert status == 400
    # search_rows is no longer served
    with pytest.raises(urllib.error.HTTPError) as ei:
        _get(server + "/api/table/search_rows")
    assert ei.value.code == 404
    # job actions on a waiting job
    jd = root / "jobs" / "0001-fake"
    jd.mkdir(parents=True)
    (jd / "job.json").write_text('{"name": "fake", "type": "export", "n_rows": 1}')
    _, w = _get(server + "/api/worker")
    assert w["jobs"][0]["state"] == "queued"
    status, j = _post(server + "/api/job/0001-fake", {"action": "discard"})
    assert status == 200 and (root / "jobs" / "_discarded" / "0001-fake").exists()
    status, _ = _post(server + "/api/job/0001-fake", {"action": "delete"})
    assert status == 404
    # a run with --designs is accepted by the runner's flag guard
    status, _ = _post(server + "/api/run", {"stage": "confirm", "args": ["--designs", "b1|s|supersonic"]})
    assert status in (200, 409)


def test_motors_endpoint_and_exclusions(design_project):
    (design_project / "config.yaml").write_text("paths:\n  ork: input/a.ork\n  cdx1: input/x.CDX1\n  boosters: [input/motors/boosters.eng]\n  sustainers: [input/motors/sus]\n  exclude_boosters: [B1-01]\n")
    app = App(design_project, watch=False)
    handler = type("H", (Handler,), {"app": app})
    httpd = ThreadingHTTPServer(("127.0.0.1", 0), handler)
    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    url = f"http://127.0.0.1:{httpd.server_address[1]}"
    try:
        _, m = _get(url + "/api/motors")
        assert {r["label"]: r["excluded"] for r in m["boosters"]["rows"]} == {"B1-01": True, "B2-02": False}
        assert m["boosters"]["rows"][0]["file"] == "input/motors/boosters.eng" and m["boosters"]["excluded"] == ["B1-01"]
        _, st = _get(url + "/api/state")
        assert st["inputs"]["boosters"]["n"] == 1 and st["inputs"]["motors"]["n_boosters"] == 1
        _, o = _get(url + "/api/options")
        assert [d["path"] for d in o["motor_dirs"]] == ["input/motors", "input/motors/sus"]
    finally:
        httpd.shutdown()
