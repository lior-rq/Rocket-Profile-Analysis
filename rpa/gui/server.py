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

from .design import DesignAssets
from .runner import Runner
from .state import TABLES, StateCollector, records
from .vm import VMControl
from .yamledit import set_many

STATIC = Path(__file__).parent / "static"
STAGES = {"check", "aero", "reference", "validate", "run", "motors", "mass", "characterize", "search", "verify", "report", "confirm", "inspect"}
FLAGS = {"--backend", "--target", "--tolerance", "--worker-mode", "--boosters", "--limit", "--include-unsolved", "--decel-subsonic", "--fresh", "--cases", "--top", "--designs"}


def history_frame_payload(df: pd.DataFrame, max_points: int) -> dict:
    """Downsample a time-history frame for the browser + its flight summary
    (burnout/separation/ignition/apogee). Shared by history() and simulate()."""
    from .. import history as H

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
    return {"n": n, "stride": stride, "columns": cols, "summary": summary}


class App:
    def __init__(self, root: Path, watch: bool = True):
        self.root = Path(root).resolve()
        self.state = StateCollector(self.root)
        self.runner = Runner(self.root, self.root / "output" / "gui_runs.json", log_dir=self.root / "output" / "gui_logs")
        self.design = DesignAssets(self.state, self.root)
        self.allowed_roots = [self.root / "output", self.root / "jobs", self.root / "input"]
        cfg = self.state.config()
        self.vm = VMControl(cfg.get("vm"), self.root, log=self.runner.note, transport=self.transport_for(cfg))
        self._sig = None
        self._last_pull = 0.0
        self._sim_backend = None  # (config.yaml mtime, PythonBackend) - see simulate()
        self.httpd = None
        self._samples = None  # (mtime_ns, parsed designs_samples.json)
        if watch:
            threading.Thread(target=self._watch, daemon=True).start()
            threading.Thread(target=self._pull_loop, daemon=True).start()

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
        results, a run finishing, the user editing config.yaml by hand)."""
        while True:
            try:
                sig = self.state.signature()
                if sig != self._sig:
                    first = self._sig is None
                    self._sig = sig
                    if not first:
                        self.runner._emit("changed", {"t": time.time()})
            except Exception:
                pass
            time.sleep(1.5 if self.runner.current()["running"] else 2.5)

    def _pull_loop(self):
        """Agent transport: the worker's heartbeat, status and console live
        on the VM's disk; pull them every 12 s. Its own thread, so a slow
        utmctl call never delays the file watcher."""
        while True:
            try:
                if self.vm.transport == "agent" and self.vm.available and not self.vm.op["running"] and self.vm.vm_status() == "started":
                    self._last_pull = time.time()
                    self.vm.pull_worker_files(self.root / "worker")
            except Exception:
                pass
            time.sleep(12)

    # ---- result snapshots (output-archive/<stamp>/) ----------------------------
    RESULT_FILES = ["designs.csv", "designs_ranked.csv", "designs_samples.json", "report.md", "characterization.csv", "eligibility.csv", "mass_table.csv", "run_manifest.json", "sustainers_selected.json", "selected_sustainer.json", "confirm.csv", "boosters.csv", "sustainers.csv", "shortlist.json", "apogee_vs_delay.png", "boost_mach.png", "final_mach_vs_time.png"]

    def archive_dir(self) -> Path:
        return self.root / "output-archive"

    def snapshot_outputs(self, label: str | None = None) -> dict | None:
        """Copy the current results to output-archive/<stamp>[-label]/ so a
        fresh run never loses the previous answer. None when there are no
        designs to keep."""
        import shutil

        out = self.root / "output"
        if not (out / "designs.csv").exists():
            return None
        safe = "".join(ch for ch in str(label or "") if ch.isalnum() or ch in "_-")[:40]
        name = time.strftime("%Y%m%d-%H%M%S") + (f"-{safe}" if safe else "")
        dst = self.archive_dir() / name
        dst.mkdir(parents=True, exist_ok=True)
        copied = []
        for f in self.RESULT_FILES:
            p = out / f
            if p.exists():
                shutil.copy2(p, dst / f)
                copied.append(f)
        (dst / "snapshot.json").write_text(json.dumps({"name": name, "label": label, "created": time.time(), "files": copied}, indent=1))
        self.runner.note(f"gui: results snapshot -> output-archive/{name} ({len(copied)} files)")
        return {"name": name, "files": copied}

    def archives(self) -> dict:
        out = []
        d = self.archive_dir()
        if d.exists():
            for p in sorted(d.iterdir(), reverse=True):
                if not p.is_dir() or not (p / "designs.csv").exists():
                    continue
                n = None
                try:
                    with open(p / "designs.csv") as f:
                        n = sum(1 for _ in f) - 1
                except OSError:
                    pass
                meta = {}
                try:
                    meta = json.loads((p / "snapshot.json").read_text())
                except (OSError, ValueError):
                    pass
                out.append({"name": p.name, "mtime": (p / "designs.csv").stat().st_mtime, "n_designs": n, "label": meta.get("label"), "bytes": sum(f.stat().st_size for f in p.iterdir() if f.is_file())})
        return {"archives": out}

    def archive_designs(self, name: str) -> dict:
        if "/" in name or "\\" in name or name.startswith("."):
            raise PermissionError(name)
        p = self.archive_dir() / name / "designs.csv"
        if not p.exists():
            raise FileNotFoundError(name)
        df = pd.read_csv(p)
        man = {}
        try:
            man = json.loads((self.archive_dir() / name / "run_manifest.json").read_text())
        except (OSError, ValueError):
            pass
        target = (man.get("search") or {}).get("config", {}).get("target.apogee_ft")
        return {"name": name, "columns": list(df.columns), "rows": records(df), "target_ft": target}

    def job_action(self, name: str, action: str) -> dict:
        """reveal | discard (queued or orphan folders -> jobs/_discarded/) |
        delete (finished folders)."""
        import shutil

        if "/" in name or "\\" in name or name.startswith("."):
            raise PermissionError(name)
        jobs_dir = self.state.config().path("jobs_dir")
        d = jobs_dir / name
        if not d.is_dir():
            raise FileNotFoundError(name)
        if action == "reveal":
            self.reveal(str(d.relative_to(self.root)) if self.root in d.parents else str(d))
            return {"ok": True}
        info = self.state.job_info(d, brief=True)
        if action == "discard":
            if info["state"] not in ("queued", "orphan", "empty"):
                raise ValueError(f"{name} is {info['state']}; only waiting or orphan jobs can be discarded")
            dst = jobs_dir / "_discarded" / name
            dst.parent.mkdir(exist_ok=True)
            shutil.move(str(d), str(dst))
            self.runner.note(f"gui: job {name} discarded -> {dst.relative_to(self.root) if self.root in dst.parents else dst}")
            return {"ok": True, "moved_to": str(dst)}
        if action == "delete":
            if info["state"] == "running":
                raise ValueError(f"{name} is running")
            shutil.rmtree(d)
            self.runner.note(f"gui: job {name} deleted")
            return {"ok": True}
        raise ValueError(f"unknown job action {action!r}")

    def disk_usage(self) -> dict:
        """Sizes of the bulky outputs (histories, jobs, search rows)."""
        out = self.root / "output"

        def tree(p: Path) -> tuple[int, int]:
            n = size = 0
            try:
                for e in os.scandir(p):
                    if e.is_dir(follow_symlinks=False):
                        k, s = tree(Path(e.path))
                        n += k
                        size += s
                    elif e.is_file(follow_symlinks=False):
                        n += 1
                        size += e.stat().st_size
            except OSError:
                pass
            return n, size

        hist = tree(out / "histories")
        jobs_dir = self.state.config().path("jobs_dir")
        jobs = tree(jobs_dir)
        sr = out / "search_rows.csv"
        return {
            "histories": {"files": hist[0], "bytes": hist[1], "path": "output/histories"},
            "jobs": {"files": jobs[0], "bytes": jobs[1], "folders": sum(1 for e in os.scandir(jobs_dir) if e.is_dir()) if jobs_dir.exists() else 0, "path": str(jobs_dir.relative_to(self.root)) if self.root in jobs_dir.parents else str(jobs_dir)},
            "search_rows": {"files": int(sr.exists()), "bytes": sr.stat().st_size if sr.exists() else 0, "path": "output/search_rows.csv"},
        }

    def cleanup(self, what: str, older_days: float = 7.0) -> dict:
        """Delete bulky outputs: flight histories, finished job folders older
        than `older_days`, or the search rows dump. Returns what went."""
        import shutil

        out = self.root / "output"
        freed = n = 0
        if what == "histories":
            for p in (out / "histories").glob("*.csv") if (out / "histories").exists() else []:
                freed += p.stat().st_size
                p.unlink()
                n += 1
        elif what == "jobs":
            jobs_dir = self.state.config().path("jobs_dir")
            cutoff = time.time() - float(older_days) * 86400
            for d in sorted(jobs_dir.iterdir()) if jobs_dir.exists() else []:
                if not d.is_dir() or not (d / "done.json").exists() or d.stat().st_mtime > cutoff:
                    continue
                freed += sum(f.stat().st_size for f in d.rglob("*") if f.is_file())
                shutil.rmtree(d, ignore_errors=True)
                n += 1
        elif what == "search_rows":
            p = out / "search_rows.csv"
            if p.exists():
                freed, n = p.stat().st_size, 1
                p.unlink()
        else:
            raise ValueError(f"unknown cleanup target {what!r}")
        self.runner.note(f"gui: cleanup {what}: removed {n} item(s), {freed / 1048576:.1f} MB")
        return {"what": what, "removed": n, "bytes": freed, "disk": self.disk_usage()}

    # ---- safe paths ---------------------------------------------------------
    def resolve(self, rel: str) -> Path:
        p = (self.root / unquote(rel)).resolve()
        roots = [r.resolve() for r in self.allowed_roots]  # input/ may be a symlink
        if not any(p == r or r in p.parents for r in roots):
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

    def history(self, rel: str, max_points: int = 1500) -> dict:
        p = self.resolve(rel)
        from .. import history as H

        df = pd.read_csv(p, nrows=1)
        df = H.read_rasaero_export(p) if "Time (sec)" in df.columns else pd.read_csv(p)
        return {"path": rel, **history_frame_payload(df, max_points)}

    def simulate(self, booster: str, sustainer: str, profile: str, sep: float, ign: float, max_points: int = 1500) -> dict:
        """On-demand python-backend flight for a design that has not gone
        through the verify stage yet (no output/histories/final-*.csv)."""
        from ..pipeline import Pipeline
        from ..search import make_row

        cfg = self.state.config()
        ms, err = self.state.motor_set(cfg)
        if ms is None:
            raise ValueError(f"motor set unavailable: {err}")
        pl = Pipeline(cfg)
        pl._ms = ms  # the GUI's tolerant loader (run tables / staged motors), not paths.boosters
        be = self._python_backend(pl, ms)
        mass = pl.load_mass().get((booster, sustainer))
        if mass is None:
            raise ValueError(f"no mass row for {booster} + {sustainer} (run the mass stage first)")
        row = make_row(booster, profile, sep, ign, pl.ms, mass, pl.cfg)
        df = be.history(row, "on-demand")
        return {"path": None, **history_frame_payload(df, max_points)}

    def _python_backend(self, pl, ms):
        """One PythonBackend per config.yaml mtime + motor set; aero tables
        (the slow part) load once and are reused across designs."""
        from ..backends import PythonBackend

        try:
            cfg_mtime = (self.root / "config.yaml").stat().st_mtime_ns
        except OSError:
            cfg_mtime = None
        key = (cfg_mtime, id(ms))
        cached = self._sim_backend
        if cached and cached[0] == key:
            return cached[1]
        be = PythonBackend(pl.cfg, pl.ms, pl.site, pl.ref_diameter_in, log=lambda *_: None, workers=1)
        self._sim_backend = (key, be)
        return be

    def aero_table(self, rel: str) -> dict:
        p = self.resolve(rel)
        from ..aero import AeroTable

        t = AeroTable.read(p)
        return {"path": rel, "mach": t.mach.tolist(), "cd_off": t.cd_off.tolist(), "cd_on": t.cd_on.tolist()}

    def motors(self) -> dict:
        """Every motor in the configured sources, excluded ones flagged (the
        picker's per-motor list inside multi-motor files)."""
        from ..eng import load_motors
        from .state import _rel

        cfg = self.state.config()
        conv = self.state.ric_converter(cfg)
        out = {}
        for kind in ("boosters", "sustainers"):
            try:
                motors = load_motors(cfg.motor_sources(kind), ric=conv)
            except Exception as e:  # noqa: BLE001 - reported in the payload
                out[kind] = {"rows": [], "excluded": sorted(cfg.excluded(kind)), "error": f"{type(e).__name__}: {e}"}
                continue
            ex = cfg.excluded(kind)
            rows = [{"label": m.label, "designation": m.designation, "total_impulse_ns": round(m.total_impulse_ns, 1), "burn_time_s": round(m.burn_time_s, 2), "avg_thrust_n": round(m.avg_thrust_n, 1), "peak_thrust_n": round(m.peak_thrust_n, 1), "prop_mass_kg": m.prop_mass_kg, "nozzle_exit_in": m.nozzle_exit_in, "file": _rel(m.path, self.root), "n_in_file": m.n_in_file, "excluded": m.label in ex} for m in motors]
            out[kind] = {"rows": rows, "excluded": sorted(ex)}
        return out

    def samples(self, key: str | None = None) -> dict:
        """Search samples per design; parsed once per file version, one key
        at a time for the browser (the whole file is megabytes)."""
        p = self.root / "output" / "designs_samples.json"
        if not p.exists():
            return {}
        mt = p.stat().st_mtime_ns
        if not self._samples or self._samples[0] != mt:
            self._samples = (mt, json.loads(p.read_text()))
        data = self._samples[1]
        if key is None:
            return data
        keys = [k for k in key.split(",") if k] if "," in key else [key]
        return {k: data.get(k, []) for k in keys}

    # ---- shortlist (output/shortlist.json, shared with `rpa confirm --designs`) ----
    def shortlist(self) -> dict:
        p = self.root / "output" / "shortlist.json"
        try:
            d = json.loads(p.read_text())
            return {"keys": [str(k) for k in d.get("keys") or []], "updated": d.get("updated")}
        except (OSError, ValueError, AttributeError):
            return {"keys": [], "updated": None}

    def set_shortlist(self, body: dict) -> dict:
        keys = self.shortlist()["keys"]
        if isinstance(body.get("keys"), list):
            keys = [str(k) for k in body["keys"]]
        if body.get("add"):
            keys = [*keys, str(body["add"])] if str(body["add"]) not in keys else keys
        if body.get("remove"):
            keys = [k for k in keys if k != str(body["remove"])]
        (self.root / "output" / "shortlist.json").write_text(json.dumps({"keys": keys, "updated": time.time()}, indent=1))
        return self.shortlist()

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

    def send_download(self, name: str, data: bytes, ctype: str = "application/octet-stream"):
        self.send_response(HTTPStatus.OK)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Content-Disposition", f'attachment; filename="{name}"')
        self.send_header("Cache-Control", "no-store")
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
                st = app.state.collect(app.runner, app.vm)
                st["disk"] = app.disk_usage()
                return self.send_json(st)
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
            if path == "/api/history":
                return self.send_json(app.history(qs["path"][0], int(qs.get("max", ["1500"])[0])))
            if path == "/api/aero":
                return self.send_json(app.aero_table(qs["path"][0]))
            if path == "/api/motors":
                return self.send_json(app.motors())
            if path == "/api/samples":
                return self.send_json(app.samples(qs.get("keys", qs.get("key", [None]))[0]))
            if path == "/api/shortlist":
                return self.send_json(app.shortlist())
            if path == "/api/runs":
                return self.send_json({"history": app.runner.history, "runner": app.runner.current()})
            if path == "/api/archives":
                return self.send_json(app.archives())
            if path == "/api/archive":
                return self.send_json(app.archive_designs(qs["name"][0]))
            if path == "/api/worker":
                return self.send_json(app.state.worker_status(app.state.config(), app.vm))
            if path == "/api/disk":
                return self.send_json(app.disk_usage())
            if path == "/api/design":
                return self.send_json(app.design.design(qs["booster"][0], qs.get("sustainer", [None])[0], qs.get("profile", [None])[0]))
            if path == "/api/flight":
                return self.send_json(app.simulate(qs["booster"][0], qs["sustainer"][0], qs.get("profile", [""])[0], float(qs["sep"][0]), float(qs["ign"][0])))
            if path == "/download/eng":
                kind = qs.get("kind", ["booster"])[0]
                if kind not in ("booster", "sustainer"):
                    return self.send_json({"error": "kind must be booster or sustainer"}, HTTPStatus.BAD_REQUEST)
                name, data = app.design.eng_download(kind, qs["label"][0])
                return self.send_download(name, data, "text/plain; charset=utf-8")
            if path == "/download/combo":
                name, data = app.design.combo_download(qs["booster"][0], qs["sustainer"][0], qs.get("profile", [None])[0])
                return self.send_download(name, data, "application/zip")
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
        except KeyError as e:
            return self.send_json({"error": f"missing query parameter {e}"}, HTTPStatus.BAD_REQUEST)
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
                if stage == "run" and "--fresh" in args and not app.runner.current()["running"]:
                    try:
                        app.snapshot_outputs("before-fresh")  # the previous answer survives the fresh run
                    except OSError as e:
                        app.runner.note(f"gui: could not snapshot the results before the fresh run: {e}")
                try:
                    return self.send_json(app.runner.start(stage, args, body.get("label")))
                except RuntimeError as e:
                    return self.send_json({"error": str(e)}, HTTPStatus.CONFLICT)
            if u.path == "/api/archive":
                snap = app.snapshot_outputs(body.get("label"))
                return self.send_json(snap or {"error": "nothing to snapshot: no designs.csv"}, HTTPStatus.OK if snap else HTTPStatus.BAD_REQUEST)
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
            if u.path == "/api/shortlist":
                return self.send_json(app.set_shortlist(body))
            if u.path.startswith("/api/job/"):
                try:
                    return self.send_json(app.job_action(unquote(u.path.split("/")[3]), str(body.get("action"))))
                except ValueError as e:
                    return self.send_json({"error": str(e)}, HTTPStatus.BAD_REQUEST)
                except FileNotFoundError as e:
                    return self.send_json({"error": f"not found: {e}"}, HTTPStatus.NOT_FOUND)
            if u.path == "/api/cleanup":
                try:
                    return self.send_json(app.cleanup(str(body.get("what")), float(body.get("older_days", 7))))
                except ValueError as e:
                    return self.send_json({"error": str(e)}, HTTPStatus.BAD_REQUEST)
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
    from .launcher import choose_port, notify, open_url, remove_lock, write_lock

    root = Path(root).resolve()
    port, running = choose_port(port, root)
    url = f"http://127.0.0.1:{port}/"
    if running is not None:
        msg = f"already running at {url} (pid {running.get('pid')}) - opening the browser"
        print(f"Rocket Profile Analysis GUI: {msg}", flush=True)
        notify("Rocket Profile Analysis", "The GUI is already running - opening it")
        if open_browser:
            open_url(url)
            # macOS shows "the application is not open anymore" if the .app's
            # own process exits before Finder finishes activating it - give
            # that handshake time before this short-lived reuse path returns.
            time.sleep(2.0)
        return
    app = App(root)
    handler = type("BoundHandler", (Handler,), {"app": app})
    httpd = ThreadingHTTPServer(("127.0.0.1", port), handler)
    httpd.daemon_threads = True
    app.httpd = httpd
    write_lock(root, port)
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
        remove_lock(root)
