"""RASAero II's own flight-sim and aero code, headless.

`rasaero-host` (native/RasaeroHost) loads the patched engine
(vendor/rasaero/RASAeroEngine.dll, made by tools/rasaero_fetch.py) and answers
JSON-lines requests on stdin/stdout. This module drives one host process and
wraps it as a SimBackend. No VM, no GUI: a flight takes tens of milliseconds
and reproduces the VM's numbers (see native/VALIDATION.md)."""

from __future__ import annotations

import atexit
import base64
import json
import os
import queue
import shutil
import subprocess
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import numpy as np
import pandas as pd

from . import history as H
from . import platform as PL
from .backends import SimBackend, safe_name
from .models import SimRow

HOST_REL = Path("native/RasaeroHost/bin/Release/net8.0/rasaero-host.dll")
ENGINE_REL = Path("vendor/rasaero/RASAeroEngine.dll")
ROW_FIELDS = ("sustainer_engine", "booster_engine", "sustainer_wt_lb", "sustainer_cg_in", "sustainer_nozzle_in", "combined_wt_lb", "combined_cg_in", "booster_nozzle_in", "sep_delay_s", "ign_delay_s")
REQUEST_FIELDS = (*ROW_FIELDS, "name")
RESULT_FIELDS = ("max_alt_ft", "max_vel_fps", "t_apogee_s", "t_max_vel_s", "t_flight_s", "steps", "history", "error", "history_block")


def auto_workers(cfg) -> int:
    return os.cpu_count() or 2


class HostError(RuntimeError):
    """The host refused a request, died, or did not answer in time."""


def host_command(cfg) -> list[str] | None:
    """How to start the host: the bundled self-contained host, the repo's
    build (needs dotnet), or paths.rasaero_host."""
    v = cfg["paths"].get("rasaero_host", "auto")
    if v in (None, "", "auto"):
        found = PL.find_host()
        if found:
            return found
        p = cfg.root / HOST_REL
        return ["dotnet", str(p)] if p.exists() and shutil.which("dotnet") else None
    p = cfg.resolve(v)
    if not p.exists():
        return None
    return ["dotnet", str(p)] if p.suffix == ".dll" else [str(p)]


def engine_path(cfg) -> Path | None:
    v = cfg["paths"].get("rasaero_engine")
    if v in (None, "", "auto"):
        return PL.find_engine()
    p = cfg.resolve(v)
    return p if p.exists() else PL.find_engine()


def engine_status(cfg) -> dict:
    cmd = host_command(cfg)
    eng = engine_path(cfg)
    problems = []
    if cmd is None:
        problems.append("rasaero-host not found (bundled with the app, or dotnet build native/RasaeroHost -c Release)")
    elif cmd[0] == "dotnet" and shutil.which("dotnet") is None:
        problems.append("dotnet not found (brew install dotnet)")
    if eng is None:
        problems.append("engine missing: RASAeroEngine.dll (bundled with the app, or python tools/rasaero_fetch.py)")
    elif cmd and cmd[0] != "dotnet" and not (Path(cmd[0]).parent / "RASAeroEngine.dll").exists():
        problems.append(f"engine DLL missing next to the bundled host: {Path(cmd[0]).parent}")
    return {"ok": not problems, "host": cmd, "engine": str(eng) if eng else None, "detail": "; ".join(problems) or "ready"}


class HostProcess:
    """One rasaero-host child: JSON request line in, JSON reply line out."""

    def __init__(self, cmd: list[str], cwd: Path, timeout_s: float = 600.0, log=print):
        self.cmd = cmd
        self.cwd = Path(cwd)
        self.timeout_s = timeout_s
        self.log = log
        self._proc: subprocess.Popen | None = None
        self._out: queue.Queue = queue.Queue()
        self._err: list[str] = []
        self._n = 0
        self._lock = threading.Lock()  # one request at a time: replies are matched by id

    def start(self) -> None:
        self._out = queue.Queue()
        self._err = []
        # CREATE_NO_WINDOW: no console per host under the windowed service exe
        self._proc = subprocess.Popen(self.cmd, cwd=str(self.cwd), stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, encoding="utf-8", bufsize=1, creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
        threading.Thread(target=self._pump, args=(self._proc.stdout, self._out), daemon=True).start()
        threading.Thread(target=self._pump_err, args=(self._proc.stderr,), daemon=True).start()

    @staticmethod
    def _pump(stream, q):
        for line in stream:
            q.put(line)
        q.put(None)

    def _pump_err(self, stream):
        for line in stream:
            self._err.append(line.rstrip())
            del self._err[:-50]

    @property
    def alive(self) -> bool:
        return self._proc is not None and self._proc.poll() is None

    def request(self, op: str, timeout_s: float | None = None, **fields) -> dict:
        with self._lock:
            return self._request(op, timeout_s, fields)

    def _request(self, op: str, timeout_s: float | None, fields: dict) -> dict:
        if not self.alive:
            self.start()
        self._n += 1
        rid = str(self._n)
        self._proc.stdin.write(json.dumps({"id": rid, "op": op, **fields}) + "\n")
        self._proc.stdin.flush()
        deadline = time.monotonic() + (timeout_s or self.timeout_s)
        while True:
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                self.kill()
                raise HostError(f"rasaero-host: no reply to {op!r} within {timeout_s or self.timeout_s:.0f} s")
            try:
                line = self._out.get(timeout=min(remaining, 1.0))
            except queue.Empty:
                if not self.alive:
                    raise HostError(f"rasaero-host exited ({self._proc.returncode}): " + " | ".join(self._err[-5:])) from None
                continue
            if line is None:
                raise HostError("rasaero-host closed its output: " + " | ".join(self._err[-5:]))
            try:
                reply = json.loads(line)
            except ValueError:
                continue
            if str(reply.get("id")) != rid:
                continue
            if not reply.get("ok", False):
                raise HostError(f"{op}: {reply.get('error')}")
            return reply

    def kill(self) -> None:
        if self._proc is not None and self._proc.poll() is None:
            self._proc.kill()
            self._proc.wait(timeout=5)

    def close(self) -> None:
        if self._proc is not None and self._proc.poll() is None:
            try:
                self._proc.stdin.close()
                self._proc.wait(timeout=5)
            except (OSError, subprocess.TimeoutExpired):
                self.kill()
        self._proc = None


class NativeRASAeroBackend(SimBackend):
    """RASAero II's engine in child processes. One design (the CDX1) and one
    motor set per backend; the launch site and surface finish are applied
    per request, like the CDX1 edits the VM path makes. Batches are spread
    over `native.workers` hosts (each a full engine); exports, histories and
    aero tables use the first."""

    name = "rasaero_native"

    def __init__(self, cfg, cdx1_path: Path, motor_files: list[Path], site: dict, surface: str, log=print, cmd: list[str] | None = None, workers: int | str | None = None):
        cmd = cmd or host_command(cfg)
        if cmd is None:
            raise FileNotFoundError("RASAero native engine: " + engine_status(cfg)["detail"])
        n = cfg["native"]
        self.cfg = cfg
        self.log = log
        w = n.get("workers", "auto") if workers is None else workers
        self.workers = auto_workers(cfg) if w in (None, "auto") else max(1, int(w))
        self.cmd = cmd
        self.timeout_s = float(n["timeout_s"])
        self.cdx1_path = Path(cdx1_path)
        self.motor_files: list[str] = []
        self.motor_mtimes: dict[str, float | None] = {}
        self.hosts: list[HostProcess] = [HostProcess(cmd, cfg.root, timeout_s=self.timeout_s, log=log)]
        self.dt = float(n["dt_s"])
        self.rows_per_batch = int(n["rows_per_batch"])
        self.time_base = float(cfg["rasaero"]["export_time_base_s"])
        self.site = {k: v for k, v in site.items() if v is not None}
        self.surface = surface
        self.history_dir = cfg.output_dir / "histories"
        self.history_dir.mkdir(parents=True, exist_ok=True)
        # the engine's altitudes are above the launch site, like the VM exports
        self.alt_offset_ft = 0.0
        info = self.host.request("ping")
        self.engine = info.get("engine")
        self.version = info.get("version")
        self.n_motors = 0
        self.load_motors(motor_files)
        d = self._load_design(self.host)
        self.stages = int(d["stages"])
        log(f"  [native] RASAero {self.version} engine {self.engine}: {self.cdx1_path.name} ({d['parts']} parts, {self.stages} stage(s)), {self.n_motors} motors, {self.workers} worker(s)")

    shared = False  # set by shared_backend(): close() keeps it alive, dispose() ends it

    @property
    def host(self) -> HostProcess:
        return self.hosts[0]

    def _load_design(self, host: HostProcess) -> dict:
        d = host.request("design", cdx1=str(self.cdx1_path))
        self.design = d["design"]
        return d

    def _ready(self, host: HostProcess) -> None:
        """Bring a (re)started host up to date: motors + design."""
        if self.motor_files:
            host.request("motors", files=self.motor_files)
        self._load_design(host)

    def load_motors(self, files) -> None:
        files = [str(f) for f in files if f]
        if files:
            self.motor_files = list(dict.fromkeys([*self.motor_files, *files]))
            for f in files:
                self.motor_mtimes[f] = _mtime(f)
            for h in self.hosts:
                if h.alive:
                    self.n_motors = len(h.request("motors", files=files)["names"])

    def _pool(self, need: int | None = None) -> list[HostProcess]:
        """Worker hosts (at most `need`), started and loaded on first use."""
        want = self.workers if need is None else max(1, min(self.workers, need))
        while len(self.hosts) < want:
            h = HostProcess(self.cmd, self.cfg.root, timeout_s=self.timeout_s, log=self.log)
            self._ready(h)
            self.hosts.append(h)
        return self.hosts[:want]

    @staticmethod
    def _payload(rows: list[SimRow], names: list[str] | None) -> list[list]:
        """Rows as arrays in REQUEST_FIELDS order (a fraction of the JSON)."""
        return [[*(getattr(r, f) for f in ROW_FIELDS), names[k] if names else f"row{k:02d}"] for k, r in enumerate(rows)]

    def _fly(self, rows: list[SimRow], names: list[str] | None = None, history_dir: Path | None = None, site: dict | None = None, host: HostProcess | None = None, inline: bool = False) -> list[dict]:
        from .pipeline import check_cancel

        check_cancel()
        host = host or self.host
        if not host.alive:
            self._ready(host)
        req = {"design": self.design, "fields": list(REQUEST_FIELDS), "rows": self._payload(rows, names), "compact": True, "dt": self.dt, "time_base_s": self.time_base, "site": site or self.site, "surface_finish": self.surface}
        if history_dir is not None:
            req["history_dir"] = str(history_dir)
        if inline:
            req["inline_history"] = True
        reply = host.request("fly", **req)
        out = [dict(zip(RESULT_FIELDS, a, strict=False)) if isinstance(a, list) else a for a in reply["rows"]]
        if inline:
            for res in out:
                res["history_cols"] = reply.get("history_cols")
        for r, res in zip(rows, out, strict=True):
            if res.get("error"):
                r.max_alt_ft = r.max_vel_fps = r.t_apogee_s = None
            else:
                r.max_alt_ft = round(float(res["max_alt_ft"]), 2)
                r.max_vel_fps = round(float(res["max_vel_fps"]), 3)
                r.t_apogee_s = round(float(res["t_apogee_s"]), 5)
        return out

    def _free_hosts(self, hosts: list[HostProcess]) -> queue.Queue:
        """Hosts as a queue: a chunk takes whichever host is idle, so a slow
        chunk never leaves the others waiting on a pinned host."""
        q: queue.Queue = queue.Queue()
        for h in hosts:
            q.put(h)
        return q

    def _fly_on_free(self, free: queue.Queue, *args, **kw):
        host = free.get()
        try:
            return self._fly(*args, host=host, **kw)
        finally:
            free.put(host)

    def run_batch(self, rows: list[SimRow], name: str) -> None:
        n = len(rows)
        hosts = self._pool() if (self.workers > 1 and n >= 2 * self.workers) else [self.host]
        # small chunks keep every host busy to the end of the batch
        chunk = max(1, min(self.rows_per_batch, -(-n // (4 * len(hosts)))))
        chunks = [rows[i : i + chunk] for i in range(0, n, chunk)]
        free = self._free_hosts(hosts)
        failed: list[str] = []
        done = 0

        def fly(c):
            return c, self._fly_on_free(free, c)

        with ThreadPoolExecutor(max_workers=len(hosts)) as ex:
            for c, out in ex.map(fly, chunks):
                for r, res in zip(c, out, strict=True):
                    if res.get("error"):
                        failed.append(f"{r.tag}: {res['error']}")
                done += len(c)
                if n >= 40 and len(chunks) > 1 and (done == n or done // 200 != (done - len(c)) // 200):
                    self.log(f"  [{done}/{n}] {name} ({len(hosts)} host(s))")
        if failed:
            self.log(f"  [native] {len(failed)} of {n} flight(s) gave no result: " + "; ".join(failed[:3]) + (" ..." if len(failed) > 3 else ""))

    def _save(self, h: pd.DataFrame, name: str) -> pd.DataFrame:
        """histories/<name>.csv in the normalized layout every backend writes."""
        h.to_csv(self.history_dir / (safe_name(name) + ".csv"), index=False)
        return h

    def export(self, row: SimRow, name: str, site: dict | None = None) -> pd.DataFrame:
        return self._save(self.history(row, name, site), name)

    def export_batch(self, rows: list[SimRow], names: list[str]) -> list[pd.DataFrame | None]:
        out = self._fly(rows, [safe_name(n) for n in names], inline=True)
        hist = []
        for name, res in zip(names, out, strict=True):
            if res.get("error"):
                self.log(f"  {name}: no result - {res['error']}")
                hist.append(None)
            else:
                hist.append(self._save(self._frame(res, name), name))
        return hist

    @staticmethod
    def _frame(res: dict, name: str) -> pd.DataFrame:
        """An inline history (float64 block, base64) as the normalized frame."""
        cols = res["history_cols"]
        block = np.frombuffer(base64.b64decode(res["history_block"]), dtype="<f8").reshape(-1, len(cols))
        df = pd.DataFrame(block, columns=cols)
        if "Stage" in df.columns:  # the block codes B=1, S=2 (see Csv.StageCode)
            df["Stage"] = df["Stage"].map({1.0: "B", 2.0: "S"}).fillna("")
        return H.normalize_export(df, name)

    def history(self, row: SimRow, name: str, site: dict | None = None) -> pd.DataFrame:
        """One flight's time history, returned inline (no CSV round trip)."""
        res = self._fly([row], [safe_name(name)], site=site, inline=True)[0]
        if res.get("error"):
            raise RuntimeError(f"{name}: {res['error']}")
        return self._frame(res, name)

    def histories(self, rows: list[SimRow], names: list[str], site: dict | None = None):
        """history() for many rows across the host pool, yielded in order
        with a bounded number of chunks in flight (histories are big)."""
        from concurrent.futures import ThreadPoolExecutor

        n = len(rows)
        chunk = 2
        chunks = [(rows[i : i + chunk], [safe_name(x) for x in names[i : i + chunk]]) for i in range(0, n, chunk)]
        hosts = self._pool(len(chunks)) if (self.workers > 1 and n >= 2) else [self.host]
        free = self._free_hosts(hosts)
        ahead = 2 * len(hosts)

        def fly(k: int):
            c, nm = chunks[k]
            return self._fly_on_free(free, c, nm, site=site, inline=True)

        with ThreadPoolExecutor(max_workers=len(hosts)) as ex:
            pending = [ex.submit(fly, k) for k in range(min(ahead, len(chunks)))]
            nxt = len(pending)
            for k in range(len(chunks)):
                out = pending[k].result()
                pending[k] = None  # release the payload
                if nxt < len(chunks):
                    pending.append(ex.submit(fly, nxt))
                    nxt += 1
                for name, res in zip(chunks[k][1], out, strict=True):
                    if res.get("error"):
                        raise RuntimeError(f"{name}: {res['error']}")
                    yield self._frame(res, name)

    def aero_table(self, config: str, altitude_ft: float, nozzle_in: float | None, dst: Path, mach_max: float = 25.0, site: dict | None = None) -> Path:
        """One Aero Plots table (CD etc. vs Mach at three angles of attack) in
        RASAero's export layout (the app's engine self-test)."""
        from .pipeline import check_cancel

        check_cancel()
        dst = Path(dst)
        dst.parent.mkdir(parents=True, exist_ok=True)
        req = {"design": self.design, "config": config, "altitude_ft": float(altitude_ft), "mach_max": float(mach_max), "csv": str(dst), "site": site or self.site, "surface_finish": self.surface}
        if nozzle_in is not None:
            req["nozzle_in"] = float(nozzle_in)
        self.host.request("aero", **req)
        return dst

    def close(self) -> None:
        """Stage code calls this when done; a shared backend stays warm."""
        if not self.shared:
            self.dispose()

    def dispose(self) -> None:
        for h in self.hosts:
            h.close()
        del self.hosts[1:]


# ---- one warm engine per process --------------------------------------------------
_SHARED: dict[tuple, NativeRASAeroBackend] = {}
_SHARED_LOCK = threading.Lock()


def _mtime(p) -> float | None:
    try:
        return Path(p).stat().st_mtime
    except OSError:
        return None


def shared_backend(cfg, cdx1_path, motor_files, site: dict, surface: str, log=print) -> NativeRASAeroBackend:
    """The engine pool for this design + motor set + site, created once and
    reused across stages and runs (native.shared). Motor files only ever
    accumulate (RASAero resolves by name), so a superset key still hits."""
    n = cfg["native"]
    files = [str(f) for f in motor_files if f]
    site_key = json.dumps({k: v for k, v in site.items() if v is not None}, sort_keys=True)
    key = (str(cdx1_path), _mtime(cdx1_path), site_key, surface, float(n["dt_s"]), str(n.get("workers", "auto")), float(cfg["rasaero"]["export_time_base_s"]))
    with _SHARED_LOCK:
        be = _SHARED.get(key)
        if be is not None and be.host.alive:
            be.log = log
            new = [f for f in files if f not in be.motor_files or _mtime(f) != be.motor_mtimes.get(f)]
            if new:
                be.load_motors(new)
            return be
        for old in _SHARED.values():
            old.dispose()
        _SHARED.clear()
        be = NativeRASAeroBackend(cfg, cdx1_path, files, site, surface, log=log)
        be.shared = True
        _SHARED[key] = be
        return be


def pool_status() -> dict:
    with _SHARED_LOCK:
        pools = [{"design": be.cdx1_path.name, "hosts": len(be.hosts), "alive": sum(h.alive for h in be.hosts), "workers": be.workers, "motors": be.n_motors, "engine": be.engine} for be in _SHARED.values()]
    return {"pools": pools}


def shutdown_all() -> None:
    with _SHARED_LOCK:
        for be in _SHARED.values():
            be.dispose()
        _SHARED.clear()


atexit.register(shutdown_all)
