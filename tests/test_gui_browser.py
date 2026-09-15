"""Every GUI page in headless Chrome, failing on console errors
(tools/gui_shots.mjs --check). Opt-in: RPA_BROWSER_TESTS=1, needs node and
Google Chrome; about a minute."""

from __future__ import annotations

import os
import shutil
import subprocess
import threading
from http.server import ThreadingHTTPServer
from pathlib import Path

import pytest

from rpa.gui.server import App, Handler

CHROME = os.environ.get("CHROME", "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome")
pytestmark = pytest.mark.skipif(not os.environ.get("RPA_BROWSER_TESTS") or not shutil.which("node") or not Path(CHROME).exists(), reason="set RPA_BROWSER_TESTS=1 (needs node and Google Chrome)")


def test_pages_load_without_console_errors(tmp_path):
    (tmp_path / "config.yaml").write_text("target:\n  apogee_ft: 45000\n")
    (tmp_path / "output").mkdir()
    app = App(tmp_path, watch=False)
    handler = type("H", (Handler,), {"app": app})
    httpd = ThreadingHTTPServer(("127.0.0.1", 0), handler)
    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    url = f"http://127.0.0.1:{httpd.server_address[1]}/"
    script = Path(__file__).resolve().parents[1] / "tools" / "gui_shots.mjs"
    try:
        r = subprocess.run(["node", str(script), "--check", "--url", url], capture_output=True, text=True, timeout=900, env={**os.environ, "CHROME": CHROME})
    finally:
        httpd.shutdown()
    assert r.returncode == 0, r.stdout + r.stderr
