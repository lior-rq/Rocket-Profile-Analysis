"""rpa.service: the FastAPI app over a fixture project - routes, an
in-process stage run with its log, SSE, config edits, the shortlist."""

import pytest
from fastapi.testclient import TestClient

from rpa.service.app import create_app
from rpa.service.core import Service


@pytest.fixture
def project(tmp_path, motor_dirs, cdx1_file):
    boosters, sustainers = motor_dirs
    (tmp_path / "input").mkdir(exist_ok=True)
    cfg = {
        "paths": {"ork": None, "cdx1": str(cdx1_file), "boosters": [str(p) for p in boosters], "sustainers": [str(p) for p in sustainers], "openrocket_jar": "auto", "jvm": "auto"},
        "backend": "rasaero_native",
        "rasaero": {"engine": "vm"},
        "native": {"warm_start": False},
        "worker": {"mode": "manual"},
    }
    import yaml

    (tmp_path / "config.yaml").write_text(yaml.safe_dump(cfg), encoding="utf-8")
    return tmp_path


@pytest.fixture
def client(project):
    svc = Service(project, watch=False, warm=False)
    with TestClient(create_app(svc)) as c:
        yield c, svc
    svc.close()


def test_ping_state_config(client):
    c, svc = client
    r = c.get("/api/ping")
    assert r.status_code == 200 and r.json()["app"] == "rpa" and r.json()["running"] is False
    st = c.get("/api/state").json()
    assert {"inputs", "optimize", "results", "worker", "runner", "engine", "disk"} <= set(st)
    assert st["inputs"]["boosters"]["n"] == 3
    assert c.get("/api/config").json()["parsed"]["backend"] == "rasaero_native"
    assert c.get("/api/table/designs").json()["missing"] is True
    assert c.get("/api/nope").status_code == 404
    assert c.get("/results").status_code == 200  # SPA fallback serves the page
    assert c.get("/api/history").status_code == 400  # missing query parameter


def test_run_check_in_process_and_log(client):
    c, svc = client
    r = c.post("/api/run", json={"stage": "check", "args": []})
    assert r.status_code == 200 and r.json()["running"] is True
    assert c.post("/api/run", json={"stage": "run", "args": []}).status_code == 409
    assert svc.runner.wait(60)
    lines = [ln["text"] for ln in c.get("/api/log").json()["lines"]]
    assert lines[0].startswith("$ rpa check")
    assert any("check:" in ln or "!!" in ln for ln in lines)
    assert any(ln.startswith("--- check finished") for ln in lines)
    runs = c.get("/api/runs").json()["history"]
    assert runs[-1]["stage"] == "check" and runs[-1]["exit_code"] in (0, 1)
    assert c.post("/api/run", json={"stage": "check", "args": ["--rm-rf"]}).status_code == 400


def test_events_stream_first_event_is_state(client):
    c, svc = client
    with c.stream("GET", "/api/events?once=1") as r:
        assert r.headers["content-type"].startswith("text/event-stream")
        lines = list(r.iter_lines())
        assert lines[0] == "event: state"


def test_config_edit_and_shortlist(client):
    c, svc = client
    r = c.post("/api/config", json={"set": {"target.apogee_ft": 40000}})
    assert r.status_code == 200 and r.json()["parsed"]["target"]["apogee_ft"] == 40000
    assert c.post("/api/config", json={"set": "x"}).status_code == 400
    assert c.post("/api/shortlist", json={"add": "a|b|c"}).json()["keys"] == ["a|b|c"]
    assert c.post("/api/shortlist", json={"remove": "a|b|c"}).json()["keys"] == []
    assert c.get("/api/engine").json()["pool"] == {"pools": []}
    assert c.get("/api/setup").json()["inputs_ok"] is False


def test_upload_saves_under_input(client):
    """Browser uploads land in input/<kind>/, sub-folders kept; bad names and types are refused."""
    from conftest import CDX1, ENG_SUSTAINERS

    c, svc = client
    eng = next(iter(ENG_SUSTAINERS.values())).encode()
    r = c.post("/api/upload?kind=sustainers&name=pack/03-S3.eng", content=eng)
    assert r.status_code == 200 and r.json() == {"path": "input/sustainers/pack/03-S3.eng", "replaced": False, "size": len(eng)}
    assert (svc.root / "input/sustainers/pack/03-S3.eng").read_bytes() == eng
    assert c.post("/api/upload?kind=sustainers&name=pack/03-S3.eng", content=eng).json()["replaced"] is True
    assert c.post("/api/upload?kind=models&name=v2.CDX1", content=CDX1.encode()).json()["path"] == "input/models/v2.CDX1"
    for bad in ("kind=boosters&name=../evil.eng", "kind=boosters&name=notes.txt", "kind=nope&name=a.eng", "kind=boosters&name="):
        assert c.post("/api/upload?" + bad, content=b"x").status_code == 400
    tree = c.post("/api/motor_tree", json={"entries": ["input/sustainers/pack"]}).json()
    assert tree["selected"] == ["input/sustainers/pack/03-S3.eng"]


def test_cancel_flag_stops_a_batch(project):
    from rpa import pipeline as P

    ev = __import__("threading").Event()
    P.set_cancel(ev)
    P.check_cancel()
    ev.set()
    with pytest.raises(P.Cancelled):
        P.check_cancel()
    P.set_cancel(None)
