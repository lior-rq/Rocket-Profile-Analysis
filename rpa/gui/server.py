"""python -m rpa gui  ->  http://127.0.0.1:8765

Standard-library HTTP server (no extra dependencies): a JSON API over the
files the pipeline reads and writes, a subprocess runner for the pipeline
commands with a server-sent-events log stream, and the static single-page
front end in rpa/gui/static/. Binds to localhost only.
"""

from __future__ import annotations

import json
import math
import mimetypes
import os
import queue
import subprocess
import sys
import threading
import time
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, unquote, urlparse

import pandas as pd
import yaml

from .runner import Runner
from .state import TABLES, StateCollector, records
from .vm import VMControl
from .yamledit import set_many

STATIC = Path(__file__).parent / "static"
STAGES = {"check", "aero", "reference", "validate", "run", "motors", "mass", "characterize", "search", "verify", "report", "confirm", "inspect"}
FLAGS = {"--backend", "--target", "--tolerance", "--worker-mode", "--boosters", "--limit", "--include-unsolved", "--decel-subsonic", "--fresh", "--cases", "--top"}


class App:
    def __init__(self, root: Path, watch: bool = True):
        self.root = Path(root).resolve()
        self.state = StateCollector(self.root)
        self.runner = Runner(self.root, self.root / "output" / "gui_runs.json")
        self.allowed_roots = [self.root / "output", self.root / "jobs", self.root / "input"]
        cfg = self.state.config()
        self.vm = VMControl(cfg.get("vm"), self.root, log=self.runner.note, transport=self.transport_for(cfg))
        self._sig = None
        self._last_pull = 0.0
        self.httpd = None
        if watch:
            threading.Thread(target=self._watch, daemon=True).start()

    @staticmethod
    def transport_for(cfg) -> str:
        """The job transport the pipeline will use (mirrors Pipeline.jobs)."""
        from ..vmagent import GuestAgent

        t = str((cfg.get("worker") or {}).get("transport", "auto"))
        if t == "share":
            return "share"
        vm = cfg.get("vm") or {}
        agent = GuestAgent(vm.get("name", "Windows"), vm.get("utmctl", "auto"))
        return "agent" if agent.available and (t == "agent" or agent.status(0) is not None) else "share"

    def vm_changed(self):
        self.runner._emit("changed", {"t": time.time()})

    def shutdown(self):
        """Stop a running command and the HTTP server (from /api/quit)."""
        time.sleep(0.3)  # let the quit response go out
        self.runner.cancel()
        if self.httpd is not None:
            self.httpd.shutdown()

    def _watch(self):
        """Tell the browsers when any input/output/job file changes (worker
        results, a run finishing, the user editing config.yaml by hand). With
        the agent transport also pull the worker's heartbeat and console."""
        while True:
            try:
                if self.vm.transport == "agent" and self.vm.available and time.time() - self._last_pull > 12 and not self.vm.op["running"] and self.vm.vm_status() == "started":
                    self._last_pull = time.time()
                    self.vm.pull_worker_files(self.root / "worker")
                sig = self.state.signature()
                if sig != self._sig:
                    first = self._sig is None
                    self._sig = sig
                    if not first:
                        self.runner._emit("changed", {"t": time.time()})
            except Exception:
                pass
            time.sleep(1.5 if self.runner.current()["running"] else 2.5)

    # ---- safe paths ---------------------------------------------------------
    def resolve(self, rel: str) -> Path:
        p = (self.root / unquote(rel)).resolve()
        if not any(p == r or r in p.parents for r in self.allowed_roots):
            raise PermissionError(rel)
        return p

    # ---- data endpoints -----------------------------------------------------
    def table(self, name: str, limit: int | None) -> dict:
        if name not in TABLES:
            raise FileNotFoundError(name)
        p = self.root / "output" / TABLES[name]
        if not p.exists() or p.stat().st_size == 0:
            return {"columns": [], "rows": [], "missing": True}
        df = pd.read_csv(p)
        if limit:
            df = df.head(limit)
        return {"columns": list(df.columns), "rows": records(df), "mtime": p.stat().st_mtime, "n": len(df)}

    def histories(self) -> dict:
        out = []
        hd = self.root / "output" / "histories"
        if hd.exists():
            for p in sorted(hd.glob("*.csv")):
                kind = "final" if p.name.startswith("final-") else "characterization" if p.name.startswith("char-") else "other"
                out.append({"name": p.stem, "path": str(p.relative_to(self.root)), "kind": kind, "mtime": p.stat().st_mtime})
        rd = self.root / "input" / "rasaero_reference"
        if rd.exists():
            for p in sorted(rd.glob("*.csv")):
                if p.name == "density_calibration.csv":
                    continue
                out.append({"name": p.stem, "path": str(p.relative_to(self.root)), "kind": "rasaero_reference", "mtime": p.stat().st_mtime})
        return {"histories": out}

    def history(self, rel: str, max_points: int = 1500) -> dict:
        p = self.resolve(rel)
        from .. import history as H

        df = pd.read_csv(p, nrows=1)
        df = H.read_rasaero_export(p) if "Time (sec)" in df.columns else pd.read_csv(p)
        n = len(df)
        stride = max(1, math.ceil(n / max_points))
        sub = df.iloc[::stride]
        if n and (n - 1) % stride:
            sub = pd.concat([sub, df.iloc[[-1]]])
        cols = {}
        for c in sub.columns:
            s = sub[c]
            if pd.api.types.is_numeric_dtype(s):
                cols[c] = [None if (isinstance(v, float) and math.isnan(v)) else float(v) for v in s.tolist()]
            else:
                cols[c] = [str(v) for v in s.tolist()]
        summary = {}
        try:
            t_bo = H.burnout_time(df)
            summary = {"apogee_ft": float(df["altitude_ft"].max()), "t_apogee_s": float(df.loc[df["altitude_ft"].idxmax(), "time_s"]), "max_mach": float(df["mach"].max()), "max_vel_fps": float(df["velocity_fps"].max()), "t_burnout_s": t_bo, "t_sep_s": H.separation_time(df, after=t_bo), "t_ign_s": H.ignition_time(df, after=t_bo)}
        except Exception:
            pass
        return {"path": rel, "n": n, "stride": stride, "columns": cols, "summary": summary}

    def aero_table(self, rel: str) -> dict:
        p = self.resolve(rel)
        from ..aero import AeroTable

        t = AeroTable.read(p)
        return {"path": rel, "mach": t.mach.tolist(), "cd_off": t.cd_off.tolist(), "cd_on": t.cd_on.tolist()}

    def motors(self) -> dict:
        """The motor set as currently configured (no pipeline stage needed)."""
        from ..motors import motor_table

        cfg = self.state.config()
        ms, err = self.state.motor_set(cfg)
        if ms is None:
            return {"columns": [], "rows": [], "error": err}
        df = motor_table(ms.boosters)
        df = df.drop(columns=["file", "manufacturer", "diameter_mm", "length_mm"], errors="ignore")
        sus = motor_table(ms.sustainer_candidates).drop(columns=["file", "manufacturer", "diameter_mm", "length_mm"], errors="ignore")
        sus["selected"] = sus["label"] == ms.sustainer.label
        return {"columns": list(df.columns), "rows": records(df), "sustainers": records(sus)}

    def samples(self) -> dict:
        p = self.root / "output" / "designs_samples.json"
        return json.loads(p.read_text()) if p.exists() else {}

    def config_payload(self) -> dict:
        p = self.root / "config.yaml"
        text = p.read_text() if p.exists() else ""
        return {"text": text, "parsed": dict(self.state.config())}

    def update_config(self, updates: dict) -> dict:
        p = self.root / "config.yaml"
        text = p.read_text() if p.exists() else ""
        new = set_many(text, updates)
        p.write_text(new)
        return self.config_payload()

    def reveal(self, rel: str):
        p = self.resolve(rel) if rel else self.root
        if sys.platform == "darwin":
            subprocess.Popen(["open", "-R", str(p)] if p.is_file() else ["open", str(p)])
        elif sys.platform.startswith("win"):
            subprocess.Popen(["explorer", "/select," + str(p)] if p.is_file() else ["explorer", str(p)])
        else:
            subprocess.Popen(["xdg-open", str(p if p.is_dir() else p.parent)])


class Handler(BaseHTTPRequestHandler):
    app: App
    protocol_version = "HTTP/1.1"

    def log_message(self, fmt, *args):  # quiet
        if "/api/events" in (args[0] if args else ""):
            return

    # ---- helpers ------------------------------------------------------------
    def send_json(self, obj, status=HTTPStatus.OK):
        body = json.dumps(obj, default=_json_default).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def send_file(self, p: Path, ctype: str | None = None):
        if not p.exists() or not p.is_file():
            return self.send_json({"error": f"not found: {p.name}"}, HTTPStatus.NOT_FOUND)
        ctype = ctype or mimetypes.guess_type(str(p))[0] or "application/octet-stream"
        if ctype.startswith("text/") and "charset" not in ctype:
            ctype += "; charset=utf-8"
        data = p.read_bytes()
        self.send_response(HTTPStatus.OK)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", "no-store" if p.suffix in (".csv", ".json", ".md", ".log", ".txt") else "max-age=5")
        self.end_headers()
        self.wfile.write(data)

    def read_body(self) -> dict:
        n = int(self.headers.get("Content-Length") or 0)
        raw = self.rfile.read(n) if n else b""
        return json.loads(raw.decode() or "{}")

    # ---- routing ------------------------------------------------------------
    def do_GET(self):
        u = urlparse(self.path)
        path, qs = u.path, parse_qs(u.query)
        app = self.app
        try:
            if path in ("/", "/index.html"):
                return self.send_file(STATIC / "index.html", "text/html")
            if path.startswith("/static/"):
                p = (STATIC / path[len("/static/") :]).resolve()
                if STATIC.resolve() not in p.parents:
                    return self.send_json({"error": "forbidden"}, HTTPStatus.FORBIDDEN)
                return self.send_file(p)
            if path == "/api/ping":
                return self.send_json({"app": "rpa", "root": str(app.root), "pid": os.getpid(), "running": app.runner.current()["running"]})
            if path == "/api/state":
                return self.send_json(app.state.collect(app.runner, app.vm))
            if path == "/api/vm/guest":
                return self.send_json(app.vm.guest_status())
            if path == "/api/options":
                return self.send_json(app.state.options())
            if path == "/api/config":
                return self.send_json(app.config_payload())
            if path == "/api/log":
                after = int(qs.get("after", ["0"])[0])
                return self.send_json({"lines": app.runner.lines_after(after), "runner": app.runner.current()})
            if path == "/api/events":
                return self.sse()
            if path.startswith("/api/table/"):
                return self.send_json(app.table(path.split("/")[3], int(qs["limit"][0]) if "limit" in qs else None))
            if path == "/api/histories":
                return self.send_json(app.histories())
            if path == "/api/history":
                return self.send_json(app.history(qs["path"][0], int(qs.get("max", ["1500"])[0])))
            if path == "/api/aero":
                return self.send_json(app.aero_table(qs["path"][0]))
            if path == "/api/motors":
                return self.send_json(app.motors())
            if path == "/api/samples":
                return self.send_json(app.samples())
            if path.startswith("/api/job/"):
                d = app.resolve("jobs/" + path.split("/")[3])
                return self.send_json(app.state.job_info(d))
            if path == "/api/report":
                p = app.root / "output" / "report.md"
                return self.send_json({"text": p.read_text() if p.exists() else "", "exists": p.exists()})
            if path == "/api/text":
                p = app.resolve(qs["path"][0])
                txt = p.read_text(errors="replace")
                return self.send_json({"path": qs["path"][0], "text": txt[-200000:]})
            if path.startswith("/files/"):
                return self.send_file(app.resolve(path[len("/files/") :]))
            return self.send_json({"error": "not found"}, HTTPStatus.NOT_FOUND)
        except PermissionError as e:
            return self.send_json({"error": f"forbidden: {e}"}, HTTPStatus.FORBIDDEN)
        except FileNotFoundError as e:
            return self.send_json({"error": f"not found: {e}"}, HTTPStatus.NOT_FOUND)
        except (BrokenPipeError, ConnectionResetError):
            return None
        except Exception as e:
            import traceback

            traceback.print_exc()
            return self.send_json({"error": f"{type(e).__name__}: {e}"}, HTTPStatus.INTERNAL_SERVER_ERROR)

    def do_POST(self):
        u = urlparse(self.path)
        app = self.app
        try:
            body = self.read_body()
            if u.path == "/api/run":
                stage = body.get("stage")
                args = [str(a) for a in body.get("args", [])]
                if stage not in STAGES:
                    return self.send_json({"error": f"unknown stage {stage!r}"}, HTTPStatus.BAD_REQUEST)
                for a in args:
                    if a.startswith("-") and a not in FLAGS:
                        return self.send_json({"error": f"flag not allowed: {a}"}, HTTPStatus.BAD_REQUEST)
                try:
                    return self.send_json(app.runner.start(stage, args, body.get("label")))
                except RuntimeError as e:
                    return self.send_json({"error": str(e)}, HTTPStatus.CONFLICT)
            if u.path == "/api/quit":
                app.runner.note("gui: quitting - the server stops now; close this tab")
                self.send_json({"ok": True})
                threading.Thread(target=app.shutdown, daemon=True).start()
                return None
            if u.path == "/api/cancel":
                return self.send_json({"cancelled": app.runner.cancel()})
            if u.path == "/api/config":
                updates = body.get("set") or {}
                if not isinstance(updates, dict):
                    return self.send_json({"error": "set must be an object"}, HTTPStatus.BAD_REQUEST)
                try:
                    return self.send_json(app.update_config(updates))
                except (ValueError, yaml.YAMLError) as e:
                    return self.send_json({"error": str(e)}, HTTPStatus.BAD_REQUEST)
            if u.path in ("/api/vm/start", "/api/vm/stop"):
                if not app.vm.available:
                    return self.send_json({"error": "utmctl not found - is UTM installed? (vm.utmctl in config.yaml)"}, HTTPStatus.BAD_REQUEST)
                app.vm.cfg.update({k: v for k, v in (app.state.config().get("vm") or {}).items() if v is not None})
                starting = u.path.endswith("start")
                launched = (app.vm.start_worker_async if starting else app.vm.stop_worker_async)(app.vm_changed)
                if not launched:
                    return self.send_json({"error": f"a VM operation is already in progress ({app.vm.op['op']})"}, HTTPStatus.CONFLICT)
                app.runner.note(f"vm: {'starting' if starting else 'stopping'} the RASAero worker in '{app.vm.cfg['name']}'")
                app.vm_changed()
                return self.send_json(app.vm.snapshot())
            if u.path == "/api/reveal":
                app.reveal(body.get("path", ""))
                return self.send_json({"ok": True})
            return self.send_json({"error": "not found"}, HTTPStatus.NOT_FOUND)
        except PermissionError as e:
            return self.send_json({"error": f"forbidden: {e}"}, HTTPStatus.FORBIDDEN)
        except Exception as e:
            import traceback

            traceback.print_exc()
            return self.send_json({"error": f"{type(e).__name__}: {e}"}, HTTPStatus.INTERNAL_SERVER_ERROR)

    # ---- server-sent events -------------------------------------------------
    def sse(self):
        app = self.app
        self.send_response(HTTPStatus.OK)
        self.send_header("Content-Type", "text/event-stream")
        self.send_header("Cache-Control", "no-store")
        self.send_header("Connection", "keep-alive")
        self.end_headers()
        q = app.runner.subscribe()
        try:
            self._sse_write("state", app.runner.current())
            while True:
                try:
                    event, data = q.get(timeout=15)
                    self._sse_write(event, data)
                except queue.Empty:
                    self.wfile.write(b": ping\n\n")
                    self.wfile.flush()
        except (BrokenPipeError, ConnectionResetError, OSError):
            pass
        finally:
            app.runner.unsubscribe(q)

    def _sse_write(self, event: str, data):
        self.wfile.write(f"event: {event}\ndata: {json.dumps(data, default=_json_default)}\n\n".encode())
        self.wfile.flush()


def _json_default(o):
    if isinstance(o, Path):
        return str(o)
    if hasattr(o, "item"):
        return o.item()
    return str(o)


def serve(root: Path, port: int = 8765, open_browser: bool = True, quiet: bool = False):
    """Serve the GUI. If one is already running for this repo, open the
    browser on it instead of starting a second server; if the port is taken
    by something else, use the next free one."""
    from .launcher import choose_port, notify, open_url

    root = Path(root).resolve()
    port, running = choose_port(port, root)
    url = f"http://127.0.0.1:{port}/"
    if running is not None:
        msg = f"already running at {url} (pid {running.get('pid')}) - opening the browser"
        print(f"Rocket Profile Analysis GUI: {msg}", flush=True)
        notify("Rocket Profile Analysis", "The GUI is already running - opening it")
        if open_browser:
            open_url(url)
        return
    app = App(root)
    handler = type("BoundHandler", (Handler,), {"app": app})
    httpd = ThreadingHTTPServer(("127.0.0.1", port), handler)
    httpd.daemon_threads = True
    app.httpd = httpd
    if not quiet:
        print(f"Rocket Profile Analysis GUI: {url}  (Ctrl-C to stop, or Quit in the page header)", flush=True)
    if open_browser:
        threading.Timer(0.6, lambda: open_url(url)).start()
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        app.runner.cancel()
        httpd.server_close()
