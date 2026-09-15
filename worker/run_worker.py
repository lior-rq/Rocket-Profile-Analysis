"""Launcher for rasaero_worker.py inside the VM.

    python Z:\\worker\\run_worker.py

The WebDAV share (Z:) drops out for seconds at a time, so the worker script
and its config are copied to a local folder and run from there; only the job
folders live on the share (the worker copies each job locally too). The
launcher re-copies and restarts the worker when the files change on the
share, restarts it if it dies, and mirrors its console output to
worker\\console.log on the share (best effort) and %TEMP%\\rpa_worker_console.log.
"""

from __future__ import annotations

import hashlib
import json
import os
import platform
import subprocess
import sys
import threading
import time
import traceback
from pathlib import Path

HERE = Path(__file__).resolve().parent  # on the share
FILES = ["rasaero_worker.py", "worker_config.json"]
LOCAL = Path(os.environ.get("LOCALAPPDATA", os.environ.get("TEMP", "."))) / "rpa_worker"
LOG = HERE / "console.log"
LOCAL_LOG = Path(os.environ.get("TEMP", ".")) / "rpa_worker_console.log"
RELOAD_EXIT_CODE = 3
RELOAD_FLAG = LOCAL / "RELOAD"
HEARTBEAT = HERE / "heartbeat.json"  # on the share: lets the Mac GUI see that the worker is alive while idle
HEARTBEAT_S = 15.0
_child_pid = None


def heartbeat(status: str = "running"):
    """Best-effort liveness file on the share (the WebDAV share drops out)."""
    body = json.dumps({"epoch": time.time(), "time": time.strftime("%Y-%m-%dT%H:%M:%S"), "status": status, "launcher_pid": os.getpid(), "worker_pid": _child_pid, "host": platform.node(), "user": os.environ.get("USERNAME"), "python": sys.version.split()[0]})
    try:
        HEARTBEAT.write_text(body)
    except OSError:
        pass


def log_line(line: str):
    sys.stdout.write(line)
    sys.stdout.flush()
    if not line.endswith("\n"):
        line += "\n"
    try:
        with open(LOCAL_LOG, "a", encoding="utf-8") as f:
            f.write(line)
    except OSError:
        pass
    for _ in range(3):
        try:
            with open(LOG, "a", encoding="utf-8") as f:
                f.write(line)
            return
        except OSError:
            time.sleep(0.5)


def read_share(name: str, attempts: int = 30) -> bytes | None:
    for _ in range(attempts):
        try:
            return (HERE / name).read_bytes()
        except OSError:
            time.sleep(2.0)
    return None


def sync_local() -> dict[str, str]:
    """Copy the worker files from the share to LOCAL. Returns their hashes."""
    LOCAL.mkdir(parents=True, exist_ok=True)
    hashes = {}
    for name in FILES:
        data = read_share(name)
        if data is None:
            raise OSError(f"cannot read {name} from the share")
        (LOCAL / name).write_bytes(data)
        hashes[name] = hashlib.md5(data).hexdigest()
    return hashes


def share_hashes() -> dict[str, str] | None:
    out = {}
    for name in FILES:
        data = read_share(name, attempts=1)
        if data is None:
            return None
        out[name] = hashlib.md5(data).hexdigest()
    return out


def watch_for_changes(current: dict[str, str], stop: threading.Event):
    """Poll the share; when the files change, copy them and ask the worker
    to restart at its next job boundary (flag file), else leave it alone.
    Also writes the heartbeat."""
    n = 0
    while not stop.wait(HEARTBEAT_S):
        heartbeat()
        n += 1
        if n % 2:
            continue  # check for new files every other tick (30 s)
        try:
            new = share_hashes()
        except Exception:
            new = None
        if new and new != current:
            log_line(f"{time.strftime('%Y-%m-%d %H:%M:%S')} launcher: worker files changed on the share - reloading\n")
            try:
                sync_local()
                RELOAD_FLAG.write_text("reload")
            except OSError as e:
                log_line(f"launcher: could not copy new files yet: {e}\n")
            current = new


def run_once(args: list[str], hashes: dict[str, str]) -> int:
    log_line(f"\n{time.strftime('%Y-%m-%d %H:%M:%S')} launcher: starting {LOCAL / FILES[0]} {' '.join(args)}\n")
    if RELOAD_FLAG.exists():
        RELOAD_FLAG.unlink()
    proc = subprocess.Popen([sys.executable, "-u", str(LOCAL / FILES[0]), "--config", str(LOCAL / FILES[1]), *args], stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, encoding="utf-8", errors="replace")
    global _child_pid
    _child_pid = proc.pid
    heartbeat()
    stop = threading.Event()
    watcher = threading.Thread(target=watch_for_changes, args=(hashes, stop), daemon=True)
    watcher.start()
    for line in proc.stdout:
        # forward every line at once: batching would delay it until the next arrives
        log_line(line)
    code = proc.wait()
    stop.set()
    log_line(f"{time.strftime('%Y-%m-%d %H:%M:%S')} launcher: worker exited with code {code}\n")
    return code


def main():
    args = sys.argv[1:] or ["--jobs", str(HERE.parent / "jobs"), "--repo", str(HERE.parent)]
    backoff = 5.0
    while True:
        try:
            hashes = sync_local()
            code = run_once(args, hashes)
        except Exception:
            log_line("launcher: " + traceback.format_exc())
            code = -1
        if code == RELOAD_EXIT_CODE:
            time.sleep(1.0)
            backoff = 5.0
            continue
        if code == 0:
            return
        log_line(f"launcher: restarting in {backoff:.0f}s\n")
        time.sleep(backoff)
        backoff = min(backoff * 2, 60.0)


if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        pass
    finally:
        heartbeat("stopped")
