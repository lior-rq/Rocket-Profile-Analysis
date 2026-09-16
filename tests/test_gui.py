"""GUI back end: comment-preserving config edits, the in-process runner, the
state collector on an empty project and the HTTP API of rpa.service."""

from __future__ import annotations

import json
import socket
import threading
import time
from pathlib import Path

import numpy as np
import pandas as pd
import pytest
import yaml
from fastapi.testclient import TestClient

from rpa.gui.state import StateCollector
from rpa.gui.yamledit import set_many, set_scalar
from rpa.service import stages
from rpa.service.app import create_app
from rpa.service.core import Service
from rpa.service.runner import CANCELLED_CODE, Runner

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


def _blocking_stage(monkeypatch):
    """Make `search` block until cancelled, so runner tests need no real run."""
    from rpa import pipeline as P

    real = stages.run_stage

    def fake(stage, args, root):
        if stage != "search":
            return real(stage, args, root)
        while True:
            P.check_cancel()
            time.sleep(0.02)

    monkeypatch.setattr(stages, "run_stage", fake)


def test_runner_runs_and_records_history(tmp_path, monkeypatch):
    r = Runner(tmp_path, tmp_path / "runs.json")
    q = r.subscribe()
    r.start("check", [])  # no inputs in tmp_path -> exits non-zero quickly
    assert r.wait(60)
    st = r.current()
    assert st["running"] is False and st["exit_code"] not in (None, 0)
    texts = [x["text"] for x in r.lines]
    assert texts[0].startswith("$ rpa check") and texts[-1].startswith("--- check")
    assert r.history[-1]["stage"] == "check" and json.loads((tmp_path / "runs.json").read_text())[-1]["exit_code"] == st["exit_code"]
    events = []
    while not q.empty():
        events.append(q.get_nowait()[0])
    assert "log" in events and "state" in events
    _blocking_stage(monkeypatch)
    r2 = Runner(tmp_path)
    r2.start("search", [])  # would run forever...
    with pytest.raises(RuntimeError):
        r2.start("search", [])  # ...so a second long stage must be refused
    assert r2.cancel() and r2.wait(10)
    assert r2.current()["cancelled"] is True and r2.current()["exit_code"] == CANCELLED_CODE


def test_runner_side_stage_and_per_run_logs(tmp_path, monkeypatch):
    """A light stage (check) runs beside a long one; every run gets a log file."""
    _blocking_stage(monkeypatch)
    r = Runner(tmp_path, tmp_path / "runs.json", log_dir=tmp_path / "logs")
    r.start("search", [])  # long-lived main stage
    st = r.start("check", [])
    assert st["side"] and st["side"]["stage"] == "check" and st["running"]
    for _ in range(2400):  # a loaded machine can take a while over `check`
        if r.current()["side"] is None:
            break
        time.sleep(0.05)
    assert r.current()["side"] is None
    rec = r.history[-1]
    assert rec["stage"] == "check" and rec.get("side") is True and rec["log"] and (tmp_path / rec["log"]).exists()
    with pytest.raises(RuntimeError):
        r.start("search", [])  # a second long stage is still refused
    assert r.cancel() and r.wait(10)


def test_state_collector_on_empty_project(tmp_path):
    sc = StateCollector(tmp_path)
    s = sc.collect(Runner(tmp_path))
    assert s["inputs"]["status"] == "error" and s["inputs"]["problems"]
    for k in ("aero", "reference", "validate", "optimize", "results", "confirm"):
        assert s[k]["status"] == "todo"
    from rpa.native import engine_status

    # no VM worker; "online" only when the native engine is built on this machine
    assert s["worker"]["state"] == ("online" if engine_status(sc.config())["ok"] else "offline")
    assert sc.motor_tree([], []) == {"folders": [], "selected": [], "unknown": []}
    s2 = sc.collect(Runner(tmp_path))
    assert s2["inputs"]["boosters"]["n"] == 0 and s2["inputs"]["boosters"]["problems"]


def _client(root: Path):
    svc = Service(root, watch=False, warm=False)
    return TestClient(create_app(svc)), svc


@pytest.fixture
def server(tmp_path):
    (tmp_path / "config.yaml").write_text(CONFIG)
    (tmp_path / "output").mkdir()
    (tmp_path / "output" / "designs.csv").write_text("booster,profile,sep_delay_s,ign_delay_s,apogee_ft,status\nb1,supersonic,1.0,2.0,45050.0,solved\n")
    c, svc = _client(tmp_path)
    with c:
        yield c, tmp_path
    svc.close()


def test_http_api(server):
    c, root = server
    r = c.get("/")
    assert r.status_code == 200 and "Rocket Profile Analysis" in r.text
    ping = c.get("/api/ping").json()
    assert ping["app"] == "rpa" and Path(ping["root"]).name == root.name
    st = c.get("/api/state").json()
    assert st["results"]["n"] == 1 and st["results"]["best"]["booster"] == "b1"
    assert c.get("/api/table/designs").json()["rows"][0]["apogee_ft"] == 45050.0
    # config edit through the API keeps comments
    r = c.post("/api/config", json={"set": {"target.apogee_ft": 40000}})
    assert r.status_code == 200 and r.json()["parsed"]["target"]["apogee_ft"] == 40000 and "# keep" in r.json()["text"]
    # path guard
    assert c.post("/api/run", json={"stage": "rm", "args": []}).status_code == 400
    assert c.post("/api/run", json={"stage": "check", "args": ["--evil"]}).status_code == 400
    assert c.get("/api/history?path=../../etc/passwd").status_code in (400, 403, 404)
    assert c.get("/files/%2e%2e/config.yaml").status_code in (403, 404)  # httpx folds a literal ..


def test_launcher_port_choice(tmp_path):
    """choose_port reuses a service for the same project and skips one for another."""
    import uvicorn

    from rpa.service.launch import choose_port, ping

    (tmp_path / "config.yaml").write_text(CONFIG)
    svc = Service(tmp_path, watch=False, warm=False)
    sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    sock.bind(("127.0.0.1", 0))
    sock.listen(8)
    port = sock.getsockname()[1]
    server = uvicorn.Server(uvicorn.Config(create_app(svc), log_level="error", access_log=False))
    t = threading.Thread(target=server.run, kwargs={"sockets": [sock]}, daemon=True)
    t.start()
    try:
        for _ in range(100):
            if ping(port):
                break
            time.sleep(0.05)
        assert ping(port)["app"] == "rpa"
        p, running = choose_port(port, tmp_path)
        assert p == port and running is not None
        p2, running2 = choose_port(port, tmp_path / "other")
        assert p2 != port and running2 is None
    finally:
        server.should_exit = True
        t.join(5)
        svc.close()


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
    c, svc = _client(design_project)
    with c:
        d = c.get("/api/design?booster=B2-02&sustainer=01-S1").json()
        assert d["booster"]["label"] == "B2-02" and d["vehicle"]["total_length_in"] == 175
        assert d["history"] is None  # no profile given -> no lookup
        d2 = c.get("/api/design?booster=B2-02&sustainer=01-S1&profile=supersonic").json()
        assert d2["history"]["path"] == "output/histories/final-B2-02+01-S1-supersonic.csv"
        d3 = c.get("/api/design?booster=B2-02&sustainer=01-S1&profile=subsonic").json()
        assert d3["history"] is None  # no history for that profile yet
        r = c.get("/download/combo?booster=B2-02&sustainer=01-S1&profile=supersonic")
        assert r.headers["content-type"] == "application/zip" and 'filename="B2-02+01-S1-supersonic.zip"' in r.headers["content-disposition"]
        assert r.content[:2] == b"PK"
        r = c.get("/download/eng?kind=sustainer&label=01-S1")
        assert 'filename="01-S1.eng"' in r.headers["content-disposition"] and b"S1-01 79 1219" in r.content
        for bad in ("/download/eng?kind=evil&label=01-S1", "/download/eng?kind=booster", "/download/combo?booster=B2-02"):
            assert c.get(bad).status_code == 400
        assert c.get("/download/eng?kind=booster&label=nope").status_code == 404
    svc.close()


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
    c, svc = _client(design_project)
    with c:
        r = c.get("/api/flight?booster=B2-02&sustainer=01-S1&profile=supersonic&sep=0.5&ign=1.0")
        d = r.json()
        assert r.status_code == 200 and d["path"] is None and d["n"] > 1
        assert set(["time_s", "mach", "altitude_ft", "velocity_fps"]).issubset(d["columns"])
        assert d["summary"]["apogee_ft"] > 0 and d["summary"]["t_burnout_s"] > 0
        assert c.get("/api/flight?booster=nope&sustainer=01-S1&profile=supersonic&sep=0.5&ign=1.0").status_code >= 400
    svc.close()


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
    c, root = server
    (root / "output" / "designs_samples.json").write_text(json.dumps({"b1|s|supersonic": [[1.0, 45000.0, 1.0]], "other": [[2.0, 1.0, 1.0]]}))
    assert list(c.get("/api/samples?key=b1%7Cs%7Csupersonic").json()) == ["b1|s|supersonic"]
    assert set(c.get("/api/samples?keys=b1%7Cs%7Csupersonic,other").json()) == {"b1|s|supersonic", "other"}
    # shortlist round trip, visible in the state
    assert c.post("/api/shortlist", json={"add": "b1|s|supersonic"}).json()["keys"] == ["b1|s|supersonic"]
    st = c.get("/api/state").json()
    assert st["results"]["shortlist"] == ["b1|s|supersonic"] and "disk" in st and st["worker"]["n_orphan"] == 0
    assert c.post("/api/shortlist", json={"remove": "b1|s|supersonic"}).json()["keys"] == []
    w = c.get("/api/worker").json()
    assert "jobs" in w and "current_job" in w
    r = c.get("/api/runs").json()
    assert "history" in r and "runner" in r
    # snapshot of the results and its diff source
    r = c.post("/api/archive", json={"label": "t"})
    snap = r.json()
    assert r.status_code == 200 and "designs.csv" in snap["files"] and snap["name"].endswith("-t")
    ar = c.get("/api/archives").json()
    assert ar["archives"][0]["n_designs"] == 1 and ar["archives"][0]["label"] == "t"
    assert c.get("/api/archive?name=" + snap["name"]).json()["rows"][0]["booster"] == "b1"
    # bulky outputs can be cleared
    hd = root / "output" / "histories"
    hd.mkdir()
    (hd / "final-x.csv").write_text("a\n")
    cl = c.post("/api/cleanup", json={"what": "histories"}).json()
    assert cl["removed"] == 1 and not (hd / "final-x.csv").exists()
    assert c.post("/api/cleanup", json={"what": "nope"}).status_code == 400
    # search_rows is no longer served
    assert c.get("/api/table/search_rows").status_code == 404
    # job actions on a waiting job
    jd = root / "jobs" / "0001-fake"
    jd.mkdir(parents=True)
    (jd / "job.json").write_text('{"name": "fake", "type": "export", "n_rows": 1}')
    assert c.get("/api/worker").json()["jobs"][0]["state"] == "queued"
    r = c.post("/api/job/0001-fake", json={"action": "discard"})
    assert r.status_code == 200 and (root / "jobs" / "_discarded" / "0001-fake").exists()
    assert c.post("/api/job/0001-fake", json={"action": "delete"}).status_code == 404
    # a run with --designs is accepted by the runner's flag guard
    assert c.post("/api/run", json={"stage": "confirm", "args": ["--designs", "b1|s|supersonic"]}).status_code in (200, 409)


def test_motors_endpoint_and_exclusions(design_project):
    (design_project / "config.yaml").write_text("paths:\n  ork: input/a.ork\n  cdx1: input/x.CDX1\n  boosters: [input/motors/boosters.eng]\n  sustainers: [input/motors/sus]\n  exclude_boosters: [B1-01]\n")
    c, svc = _client(design_project)
    with c:
        m = c.get("/api/motors").json()
        assert {r["label"]: r["excluded"] for r in m["boosters"]["rows"]} == {"B1-01": True, "B2-02": False}
        assert m["boosters"]["rows"][0]["file"] == "input/motors/boosters.eng" and m["boosters"]["excluded"] == ["B1-01"]
        st = c.get("/api/state").json()
        assert st["inputs"]["boosters"]["n"] == 1 and st["inputs"]["motors"]["n_boosters"] == 1
        # motor tree: a file entry shows its folder, a folder entry all its files
        o = c.post("/api/motor_tree", json={"entries": ["input/motors/boosters.eng", "input/motors/sus"], "extra_folders": []}).json()
        assert [d["path"] for d in o["folders"]] == ["input/motors", "input/motors/sus"]
        assert o["selected"] == ["input/motors/boosters.eng", "input/motors/sus/01-S1.eng"] and o["unknown"] == []
        # absolute paths outside the project stay absolute
        outside = design_project.parent / "elsewhere"
        outside.mkdir(exist_ok=True)
        (outside / "z.eng").write_text(ENG_SUSTAINER)
        o = c.post("/api/motor_tree", json={"entries": [str(outside / "z.eng"), "nope/missing.eng"]}).json()
        assert o["folders"][0]["path"] == str(outside) and o["selected"] == [str(outside / "z.eng")] and o["unknown"] == ["nope/missing.eng"]
    svc.close()
