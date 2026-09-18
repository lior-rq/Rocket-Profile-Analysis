"""What the API serves: the state snapshot, runs, files, config edits, the
shortlist, archives, cleanup, setup and self-test. The HTTP layer is app.py."""

from __future__ import annotations

import json
import math
import os
import subprocess
import sys
import threading
import time
from pathlib import Path
from urllib.parse import unquote

import pandas as pd

from .. import platform as PL
from ..gui.design import DesignAssets
from ..gui.state import TABLES, StateCollector, records
from ..gui.yamledit import set_many
from .runner import Runner
from .stages import FLAGS, STAGES

RESULT_FILES = ["designs.csv", "designs_ranked.csv", "designs_samples.json", "report.md", "characterization.csv", "eligibility.csv", "mass_table.csv", "run_manifest.json", "sustainers_selected.json", "selected_sustainer.json", "confirm.csv", "boosters.csv", "sustainers.csv", "apogee_vs_delay.png", "boost_mach.png", "final_mach_vs_time.png", "shortlist.json"]


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
        t_sep, t_ign = H.separation_time(df, after=max(0.0, t_bo - 0.05)), H.ignition_time(df, after=t_bo)
        summary = {"apogee_ft": float(df["altitude_ft"].max()), "t_apogee_s": float(df.loc[df["altitude_ft"].idxmax(), "time_s"]), "max_mach": float(df["mach"].max()), "max_vel_fps": float(df["velocity_fps"].max()), "t_burnout_s": t_bo, "t_sep_s": t_sep, "t_ign_s": t_ign}
        if "accel_fps2" in df:
            summary["max_accel_g"] = float(df["accel_fps2"].max()) / 32.174
        if t_sep is not None:
            summary["mach_at_sep"] = H.value_at(df, "mach", t_sep)
            summary["stack_max_mach"] = float(df.loc[df["time_s"] <= t_sep, "mach"].max())
        if t_ign is not None:
            summary.update({"vel_at_ign_fps": H.value_at(df, "velocity_fps", t_ign), "mach_at_ign": H.value_at(df, "mach", t_ign), "alt_at_ign_ft": H.value_at(df, "altitude_ft", t_ign)})
    except Exception:
        pass
    return {"n": n, "stride": stride, "columns": cols, "summary": summary}


def json_default(o):
    if isinstance(o, Path):
        return str(o)
    if hasattr(o, "item"):
        return o.item()
    return str(o)


class Service:
    def __init__(self, root: Path, watch: bool = True, warm: bool = True):
        self.root = Path(root).resolve()
        self.state = StateCollector(self.root)
        self.runner = Runner(self.root, self.root / "output" / "gui_runs.json", log_dir=self.root / "output" / "gui_logs")
        self.design = DesignAssets(self.state, self.root)
        self.allowed_roots = [self.root / "output", self.root / "jobs", self.root / "input"]
        self.on_quit = None
        self._sig = None
        self._snapshot = None  # (key, dict)
        self._samples = None  # (mtime_ns, parsed designs_samples.json)
        self._or = None  # ((ork path, mtime_ns), OpenRocket) for on-demand mass rows
        self._or_lock = threading.Lock()
        self._stage_masses: dict[tuple, object] = {}
        self.vm = None
        self.warmup = {"engine": None, "openrocket": None, "started": time.time(), "done": False}
        try:
            from ..gui.vm import VMControl

            cfg = self.state.config()
            if str((cfg.get("rasaero") or {}).get("engine", "auto")) == "vm" or (cfg.get("vm") or {}).get("utmctl") not in (None, "", "auto"):
                self.vm = VMControl(cfg.get("vm"), self.root, log=self.runner.note, transport="share")
        except Exception:
            self.vm = None
        if watch:
            threading.Thread(target=self._watch, daemon=True, name="rpa-watch").start()
        if warm:
            threading.Thread(target=self.warm_up, daemon=True, name="rpa-warmup").start()

    # ---- lifecycle ----------------------------------------------------------
    def warm_up(self):
        """Start the RASAero host pool and the JVM once, in the background, so
        the first click does not pay for them."""
        from .. import native
        from ..pipeline import Pipeline

        try:
            cfg = self.state.config()
        except Exception as e:
            self.warmup.update({"engine": f"config: {e}", "done": True})
            return
        if cfg["native"].get("warm_start", True):
            try:
                st = native.engine_status(cfg)
                if st["ok"] and cfg.file("cdx1") and cfg.file("cdx1").exists():
                    be = Pipeline(cfg).native_backend(log=lambda *_: None)
                    self.warmup["engine"] = f"ready: {be.workers} host(s), engine {be.engine}"
                else:
                    self.warmup["engine"] = st["detail"] if not st["ok"] else "no CDX1 selected"
            except Exception as e:  # noqa: BLE001 - warm-up is best effort
                self.warmup["engine"] = f"{type(e).__name__}: {e}"
            try:
                jar, jvm = cfg.openrocket()
                if jar and Path(jar).exists():
                    from ..openrocket import OpenRocket

                    OpenRocket(jar, jvm).__enter__()
                    self.warmup["openrocket"] = f"JVM started ({Path(jar).name})"
                else:
                    self.warmup["openrocket"] = "OpenRocket not found"
            except Exception as e:  # noqa: BLE001
                self.warmup["openrocket"] = f"{type(e).__name__}: {e}"
        self.warmup["done"] = True
        self.warmup["elapsed_s"] = round(time.time() - self.warmup["started"], 1)
        self.runner._emit("changed", {"t": time.time()})

    def shutdown(self):
        """Stop a running command and the server (from /api/quit)."""
        time.sleep(0.3)  # let the quit response go out
        self.runner.cancel()
        self.close()
        if self.on_quit:
            self.on_quit()

    def close(self):
        from .. import native

        native.shutdown_all()

    def _watch(self):
        """Tell the browsers when any input/output/job file changes."""
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

    # ---- state ---------------------------------------------------------------
    def snapshot(self) -> dict:
        """The dashboard state, recomputed only when a file it reads or the
        runner changed."""
        cur = self.runner.current()
        key = (self.state.signature(), cur["running"], cur["stage"], cur["substage"], json.dumps(cur["progress"]), json.dumps(cur["round"]), cur["finished"], json.dumps(cur["side"], default=str), self.warmup["done"])
        if self._snapshot and self._snapshot[0] == key:
            st = dict(self._snapshot[1])
            st["now"] = time.time()
            st["runner"] = cur
            return st
        st = self.state.collect(self.runner, self.vm)
        st["disk"] = self.disk_usage()
        st["engine"] = self.engine_info()
        self._snapshot = (key, st)
        return dict(st)

    def engine_info(self) -> dict:
        from .. import native

        cfg = self.state.config()
        st = native.engine_status(cfg)
        pool = native.pool_status()
        return {**st, "pool": pool, "warmup": self.warmup, "openrocket": PL.find_openrocket() if cfg["paths"].get("openrocket_jar") in (None, "", "auto") else {"jar": str(cfg.file("openrocket_jar")), "jvm": str(cfg.file("jvm")) if cfg.file("jvm") else None, "source": "config.yaml"}, "platform": PL.summary()}

    def setup_info(self) -> dict:
        cfg = self.state.config()
        jar, jvm = cfg.openrocket()
        return {"project": str(self.root), "projects_dir": str(PL.projects_dir()), "template": str(PL.template_dir()) if PL.template_dir() else None, "openrocket": {"jar": str(jar) if jar else None, "jvm": str(jvm) if jvm else None, "ok": bool(jar and Path(jar).exists())}, "engine": self.engine_info(), "inputs_ok": bool(cfg.file("cdx1") and cfg.file("cdx1").exists() and cfg.file("ork") and cfg.file("ork").exists()), "frozen": PL.frozen()}

    def selftest(self) -> dict:
        """One aero table through the native engine and a JVM start: proves
        both dependencies in under a second."""
        import tempfile

        from ..pipeline import Pipeline

        cfg = self.state.config()
        out = {"engine": None, "openrocket": None, "ok": False}
        t0 = time.time()
        try:
            be = Pipeline(cfg).native_backend(log=lambda *_: None)
            with tempfile.TemporaryDirectory() as td:
                be.aero_table("stack" if be.stages > 1 else "sustainer", 20000.0, None, Path(td) / "selftest.csv", mach_max=1.0)
            out["engine"] = {"ok": True, "version": be.version, "engine": be.engine, "hosts": be.workers, "elapsed_s": round(time.time() - t0, 2)}
        except Exception as e:  # noqa: BLE001
            out["engine"] = {"ok": False, "error": f"{type(e).__name__}: {e}"}
        t1 = time.time()
        try:
            jar, jvm = cfg.openrocket()
            if not jar:
                raise FileNotFoundError("OpenRocket not found (paths.openrocket_jar)")
            from ..openrocket import OpenRocket

            OpenRocket(jar, jvm).__enter__()
            out["openrocket"] = {"ok": True, "jar": str(jar), "elapsed_s": round(time.time() - t1, 2)}
        except Exception as e:  # noqa: BLE001
            out["openrocket"] = {"ok": False, "error": f"{type(e).__name__}: {e}"}
        out["ok"] = bool(out["engine"]["ok"] and out["openrocket"]["ok"])
        return out

    def new_project(self, name: str) -> dict:
        p = PL.new_project(name)
        return {"path": str(p), "name": p.name}

    # ---- result snapshots (output-archive/<stamp>/) ----------------------------
    def archive_dir(self) -> Path:
        return self.root / "output-archive"

    def snapshot_outputs(self, label: str | None = None) -> dict | None:
        import shutil

        out = self.root / "output"
        if not (out / "designs.csv").exists():
            return None
        safe = "".join(ch for ch in str(label or "") if ch.isalnum() or ch in "_-")[:40]
        name = time.strftime("%Y%m%d-%H%M%S") + (f"-{safe}" if safe else "")
        dst = self.archive_dir() / name
        dst.mkdir(parents=True, exist_ok=True)
        copied = []
        for f in RESULT_FILES:
            p = out / f
            if p.exists():
                shutil.copy2(p, dst / f)
                copied.append(f)
        (dst / "snapshot.json").write_text(json.dumps({"name": name, "label": label, "created": time.time(), "files": copied}, indent=1), encoding="utf-8")
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
                    with open(p / "designs.csv", encoding="utf-8") as f:
                        n = sum(1 for _ in f) - 1
                except OSError:
                    pass
                meta = {}
                try:
                    meta = json.loads((p / "snapshot.json").read_text(encoding="utf-8"))
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
            man = json.loads((self.archive_dir() / name / "run_manifest.json").read_text(encoding="utf-8"))
        except (OSError, ValueError):
            pass
        target = (man.get("search") or {}).get("config", {}).get("target.apogee_ft")
        return {"name": name, "columns": list(df.columns), "rows": records(df), "target_ft": target}

    def job_action(self, name: str, action: str) -> dict:
        import shutil

        if "/" in name or "\\" in name or name.startswith("."):
            raise PermissionError(name)
        jobs_dir = self.state.config().path("jobs_dir")
        d = jobs_dir / name
        if not d.is_dir():
            raise FileNotFoundError(name)
        if action == "reveal":
            self.reveal(d.relative_to(self.root).as_posix() if self.root in d.parents else str(d))
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
            "jobs": {"files": jobs[0], "bytes": jobs[1], "folders": sum(1 for e in os.scandir(jobs_dir) if e.is_dir()) if jobs_dir.exists() else 0, "path": jobs_dir.relative_to(self.root).as_posix() if self.root in jobs_dir.parents else str(jobs_dir)},
            "search_rows": {"files": int(sr.exists()), "bytes": sr.stat().st_size if sr.exists() else 0, "path": "output/search_rows.csv"},
        }

    def cleanup(self, what: str, older_days: float = 7.0) -> dict:
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
        cfg = self.state.config()
        roots = [r.resolve() for r in [*self.allowed_roots, cfg.path("reference_dir")]]  # input/ may be a symlink
        if not any(p == r or r in p.parents for r in roots):
            raise PermissionError(rel)
        return p

    # ---- data endpoints -----------------------------------------------------
    def start_run(self, stage: str, args: list[str], label: str | None) -> dict:
        if stage not in STAGES:
            raise ValueError(f"unknown stage {stage!r}")
        for a in args:
            if a.startswith("-") and a not in FLAGS:
                raise ValueError(f"flag not allowed: {a}")
        if stage == "run" and "--fresh" in args and not self.runner.current()["running"]:
            try:
                self.snapshot_outputs("before-fresh")  # the previous answer survives the fresh run
            except OSError as e:
                self.runner.note(f"gui: could not snapshot the results before the fresh run: {e}")
        return self.runner.start(stage, args, label)

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

    def simulate(self, booster: str, sustainer: str, profile: str, sep: float, ign: float, hardware_mass_lb: float | None = None, max_points: int = 1500) -> dict:
        """On-demand flight for a design that has not gone through verify yet,
        on the native engine. `hardware_mass_lb` overrides the mass table's dry
        mass (OpenRocket mass model only)."""
        from dataclasses import asdict

        from ..pipeline import Pipeline
        from ..search import make_row

        cfg = self.state.config()
        ms, err = self.state.motor_set(cfg)
        if ms is None:
            raise ValueError(f"motor set unavailable: {err}")
        pl = Pipeline(cfg)
        pl._ms = ms  # the GUI's tolerant loader (run tables / staged motors), not paths.boosters
        mass = pl.load_mass().get((booster, sustainer))
        if mass is None:
            raise ValueError(f"no mass row for {booster} + {sustainer} (run the mass stage first)")
        if hardware_mass_lb is not None and hardware_mass_lb != mass.hardware_mass_lb:
            mass = self._rescaled_mass(pl, mass, hardware_mass_lb)
        row = make_row(booster, profile, sep, ign, pl.ms, mass, pl.cfg)
        df = pl.native_backend(log=lambda *_: None).history(row, "on-demand")
        return {"path": None, "mass": asdict(mass), **history_frame_payload(df, max_points)}

    def _rescaled_mass(self, pl, mass, hardware_mass_lb: float):
        """The mass row at another dry mass, from OpenRocket's stage masses
        (cached per .ork version and motor pair; one JVM call per pair)."""
        from ..massmodel import mass_row

        if pl.cfg["mass_model"]["method"] != "openrocket":
            raise ValueError("a hardware mass override needs mass_model.method = openrocket")
        if hardware_mass_lb <= 0:
            raise ValueError("hardware mass must be positive")
        b, s = pl.ms.booster(mass.booster), pl.ms.sustainer_by_label(mass.sustainer)
        ork = pl.cfg.path("ork")
        key = (str(ork), ork.stat().st_mtime_ns, b.label, s.label)
        with self._or_lock:
            sm = self._stage_masses.get(key)
            if sm is None:
                if self._or is None or self._or[0] != key[:2]:
                    self._or = (key[:2], pl.openrocket())
                sm = self._stage_masses[key] = self._or[1].stage_masses(s, b)
        return mass_row(b.label, sm, b.prop_mass_kg, hardware_mass_lb, s.label)

    def motors(self) -> dict:
        from ..eng import load_motors
        from ..gui.state import _rel

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
        p = self.root / "output" / "designs_samples.json"
        if not p.exists():
            return {}
        mt = p.stat().st_mtime_ns
        if not self._samples or self._samples[0] != mt:
            self._samples = (mt, json.loads(p.read_text(encoding="utf-8")))
        data = self._samples[1]
        if key is None:
            return data
        keys = [k for k in key.split(",") if k] if "," in key else [key]
        return {k: data.get(k, []) for k in keys}

    def shortlist(self) -> dict:
        p = self.root / "output" / "shortlist.json"
        try:
            d = json.loads(p.read_text(encoding="utf-8"))
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
        (self.root / "output").mkdir(exist_ok=True)
        (self.root / "output" / "shortlist.json").write_text(json.dumps({"keys": keys, "updated": time.time()}, indent=1), encoding="utf-8")
        return self.shortlist()

    def config_payload(self) -> dict:
        p = self.root / "config.yaml"
        text = p.read_text(encoding="utf-8") if p.exists() else ""
        return {"text": text, "parsed": dict(self.state.config())}

    def update_config(self, updates: dict) -> dict:
        p = self.root / "config.yaml"
        example = self.root / "config.example.yaml"
        text = p.read_text(encoding="utf-8") if p.exists() else example.read_text(encoding="utf-8") if example.exists() else ""
        new = set_many(text, updates)
        p.write_text(new, encoding="utf-8")
        self._snapshot = None
        return self.config_payload()

    def browse(self, kind: str, prompt: str) -> dict:
        """Native file/folder picker (macOS only here; the app shell has its
        own dialogs and calls /api/config directly)."""
        if sys.platform != "darwin":
            return {"error": "no native file dialog on this platform - type or paste the path"}
        what = "choose folder" if kind == "folder" else "choose file"
        script = "\n".join(["with timeout of 86400 seconds", 'tell application "System Events"', "activate", f'set f to {what} with prompt "{prompt}"', "end tell", "end timeout", "POSIX path of f"])
        r = subprocess.run(["osascript", "-e", script], capture_output=True, text=True)
        if r.returncode != 0:
            if "-128" in r.stderr:
                return {"cancelled": True}
            return {"error": r.stderr.strip() or "file dialog failed"}
        return {"path": self.store_path(r.stdout.strip().rstrip("/"))}

    def store_path(self, p: str) -> str:
        from ..gui.state import _rel

        return _rel(Path(p), self.root)

    UPLOAD_KINDS = {"boosters": (".eng", ".ric"), "sustainers": (".eng", ".ric"), "models": (".ork", ".cdx1")}

    def upload(self, kind: str, name: str, data: bytes) -> dict:
        """Save a browser upload under input/<kind>/<name>; `name` may keep
        the sub-folders of a dropped folder. Returns the path as config stores it."""
        if kind not in self.UPLOAD_KINDS:
            raise ValueError(f"unknown upload kind {kind!r}")
        parts = [x for x in name.replace("\\", "/").split("/") if x not in ("", ".")]
        if not parts or any(x == ".." or x.startswith(".") for x in parts):
            raise ValueError(f"bad file name {name!r}")
        if not parts[-1].lower().endswith(self.UPLOAD_KINDS[kind]):
            raise ValueError(f"{parts[-1]}: expected {' or '.join(self.UPLOAD_KINDS[kind])}")
        dest = self.root / "input" / kind
        for x in parts:
            dest = dest / x
        replaced = dest.exists()
        dest.parent.mkdir(parents=True, exist_ok=True)
        dest.write_bytes(data)
        return {"path": self.store_path(str(dest)), "replaced": replaced, "size": len(data)}

    def reveal(self, rel: str):
        p = self.resolve(rel) if rel else self.root
        if sys.platform == "darwin":
            subprocess.Popen(["open", "-R", str(p)] if p.is_file() else ["open", str(p)])
        elif sys.platform.startswith("win"):
            subprocess.Popen(["explorer", "/select," + str(p)] if p.is_file() else ["explorer", str(p)])
        else:
            subprocess.Popen(["xdg-open", str(p if p.is_dir() else p.parent)])
