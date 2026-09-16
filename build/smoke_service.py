#!/usr/bin/env python3
"""Start a built service (build/dist/rpa-service), wait for its port, check
the page, /api/ping, /api/setup and the engine self-test, then quit it.
Uses a throw-away data dir, so the template project gets created fresh."""

from __future__ import annotations

import json
import os
import subprocess
import sys
import tempfile
import time
import urllib.request
from pathlib import Path


def main() -> int:
    d = Path(sys.argv[1] if len(sys.argv) > 1 else "build/dist/rpa-service").resolve()
    exe = d / ("rpa-service.exe" if sys.platform.startswith("win") else "rpa-service")
    if not exe.exists():
        print(f"missing: {exe}")
        return 2
    with tempfile.TemporaryDirectory() as tmp:
        env = {**os.environ, "RPA_DATA_DIR": tmp, "PYTHONUTF8": "1"}
        t0 = time.time()
        p = subprocess.Popen([str(exe), "service", "--port", "0"], stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, env=env)
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
        base = f"http://127.0.0.1:{port}"

        def get(path):
            with urllib.request.urlopen(base + path, timeout=60) as r:
                body = r.read()
                return json.loads(body) if r.headers.get_content_type() == "application/json" else body.decode()

        def post(path, body=None):
            req = urllib.request.Request(base + path, data=json.dumps(body or {}).encode(), headers={"Content-Type": "application/json"})
            with urllib.request.urlopen(req, timeout=300) as r:
                return json.loads(r.read())

        ok = True
        try:
            ping = get("/api/ping")
            ok &= ping.get("app") == "rpa"
            page = get("/")
            ok &= "<div id=\"root\"" in page or "id=root" in page
            setup = get("/api/setup")
            ok &= setup.get("frozen") is True and setup.get("inputs_ok") is True
            st = get("/api/state")
            ok &= st["inputs"]["boosters"]["n"] > 0
            t1 = time.time()
            test = post("/api/setup/selftest")
            print(f"  project    {ping.get('root')}")
            print(f"  openrocket {setup['openrocket']}")
            print(f"  engine     {(test.get('engine') or {}).get('ok')} {(test.get('engine') or {}).get('error', '')} ({time.time() - t1:.1f}s)")
            print(f"  selftest   {test.get('ok')}")
            ok &= bool((test.get("engine") or {}).get("ok"))
        except Exception as e:  # noqa: BLE001
            print(f"FAIL: {type(e).__name__}: {e}")
            ok = False
        finally:
            try:
                post("/api/quit")
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
