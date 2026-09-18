#!/usr/bin/env python3
"""Start a built service (build/dist/rpa-service), wait for its port, check
the page, /api/ping, /api/setup and the engine self-test, then quit it.
Uses a throw-away data dir, so the template project gets created fresh.
A generic template (CI: no inputs) is seeded like a first run: RASAero's
two-stage example design and the test-suite's motors go in through the
upload API, so the self-test still proves the bundled engine.
Usage: smoke_service.py [dist-dir] | --url http://127.0.0.1:<port>"""

from __future__ import annotations

import json
import os
import subprocess
import sys
import tempfile
import time
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
EXAMPLE = ROOT / "vendor" / "rasaero" / "examples" / "AeroPac104KStageOne&Two-2.CDX1"


class Api:
    def __init__(self, base: str):
        self.base = base

    def get(self, path):
        with urllib.request.urlopen(self.base + path, timeout=60) as r:
            body = r.read()
            return json.loads(body) if r.headers.get_content_type() == "application/json" else body.decode()

    def post(self, path, body=None):
        return self.raw(path, json.dumps(body or {}).encode(), "application/json")

    def raw(self, path, data: bytes, ctype: str = "application/octet-stream"):
        req = urllib.request.Request(self.base + path, data=data, headers={"Content-Type": ctype})
        with urllib.request.urlopen(req, timeout=300) as r:
            return json.loads(r.read())


def seed_inputs(api: Api) -> None:
    sys.path.insert(0, str(ROOT / "tests"))
    from conftest import ENG_BOOSTERS, ENG_SUSTAINERS

    cdx1 = api.raw("/api/upload?kind=models&name=AeroPac104K.CDX1", EXAMPLE.read_bytes())["path"]
    boosters = api.raw("/api/upload?kind=boosters&name=boosters.eng", ENG_BOOSTERS.encode())["path"]
    name, text = next(iter(ENG_SUSTAINERS.items()))
    sustainer = api.raw(f"/api/upload?kind=sustainers&name={name}", text.encode())["path"]
    api.post("/api/config", {"set": {"paths.cdx1": cdx1, "paths.boosters": [boosters], "paths.sustainers": [sustainer]}})


def check(api: Api, frozen: bool) -> bool:
    ok = True
    ping = api.get("/api/ping")
    ok &= ping.get("app") == "rpa"
    page = api.get("/")
    ok &= "<div id=\"root\"" in page or "id=root" in page
    setup = api.get("/api/setup")
    ok &= setup.get("frozen") is frozen
    st = api.get("/api/state")
    seeded = False
    if st["inputs"]["boosters"]["n"] == 0 and EXAMPLE.exists():
        seed_inputs(api)
        st = api.get("/api/state")
        seeded = True
    ok &= st["inputs"]["boosters"]["n"] > 0
    t1 = time.time()
    test = api.post("/api/setup/selftest")
    eng = test.get("engine") or {}
    print(f"  project    {ping.get('root')}{' (seeded)' if seeded else ''}")
    print(f"  inputs     ok={setup.get('inputs_ok')} boosters={st['inputs']['boosters']['n']}")
    print(f"  openrocket {setup['openrocket']}")
    print(f"  engine     {eng.get('ok')} {eng.get('error', '')} ({time.time() - t1:.1f}s)")
    print(f"  selftest   {test.get('ok')}")
    ok &= bool(eng.get("ok"))
    return ok


def main() -> int:
    args = sys.argv[1:]
    if args[:1] == ["--url"]:
        api = Api(args[1].rstrip("/"))
        try:
            ok = check(api, frozen=False)
        except Exception as e:  # noqa: BLE001
            print(f"FAIL: {type(e).__name__}: {e}")
            ok = False
        print("ok" if ok else "FAIL")
        return 0 if ok else 1
    d = Path(args[0] if args else "build/dist/rpa-service").resolve()
    exe = d / ("rpa-service.exe" if sys.platform.startswith("win") else "rpa-service")
    if not exe.exists():
        print(f"missing: {exe}")
        return 2
    with tempfile.TemporaryDirectory() as tmp:
        env = {**os.environ, "RPA_DATA_DIR": tmp, "PYTHONUTF8": "1"}
        t0 = time.time()
        p = subprocess.Popen([str(exe), "service", "--port", "0"], stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, encoding="utf-8", errors="replace", env=env)
        port = None
        assert p.stdout is not None
        for line in p.stdout:
            if line.startswith("RPA_SERVICE_PORT="):
                port = int(line.split("=", 1)[1])
                break
            print("  " + line.rstrip())
            if time.time() - t0 > 120:
                break
        if port is None:
            p.kill()
            print("FAIL: no port announced")
            return 1
        ready = time.time() - t0
        api = Api(f"http://127.0.0.1:{port}")
        try:
            ok = check(api, frozen=True)
        except Exception as e:  # noqa: BLE001
            print(f"FAIL: {type(e).__name__}: {e}")
            ok = False
        finally:
            try:
                api.post("/api/quit")
            except Exception:  # noqa: BLE001
                p.kill()
            try:
                p.wait(20)
            except subprocess.TimeoutExpired:
                p.kill()
        print(f"{'ok' if ok else 'FAIL'}: {exe.name} ready in {ready:.1f}s on port {port}")
        return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
