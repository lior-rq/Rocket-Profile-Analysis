"""GUI backend: comment-preserving config edits, the subprocess runner, the
state collector on an empty project and the HTTP API."""

from __future__ import annotations

import json
import threading
import time
import urllib.request
from http.server import ThreadingHTTPServer
from pathlib import Path

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
    with pytest.raises(RuntimeError):
        r2 = Runner(tmp_path)
        r2.start("gui", [])  # would run forever...
        r2.start("check", [])  # ...so a second start must be refused
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
