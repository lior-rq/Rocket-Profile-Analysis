"""Start-up helpers: find/reuse a running service, open the browser."""

from __future__ import annotations

import json
import os
import socket
import subprocess
import sys
import time
import urllib.request
from pathlib import Path

PING_PATH = "/api/ping"
LOCK_NAME = "gui.lock"


def ping(port: int, timeout: float = 1.5) -> dict | None:
    """The running service's identity on this port, or None."""
    try:
        with urllib.request.urlopen(f"http://127.0.0.1:{port}{PING_PATH}", timeout=timeout) as r:
            d = json.loads(r.read().decode())
            return d if d.get("app") == "rpa" else None
    except Exception:  # noqa: BLE001 - refused, timeout, not JSON: not ours
        return None


def port_free(port: int) -> bool:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        try:
            s.bind(("127.0.0.1", port))
            return True
        except OSError:
            return False


def lock_path(root: Path) -> Path:
    return Path(root) / "output" / LOCK_NAME


def read_lock(root: Path) -> dict | None:
    """The service for this project per output/gui.lock, if it still answers."""
    try:
        d = json.loads(lock_path(root).read_text())
        info = ping(int(d["port"]))
    except (OSError, ValueError, KeyError, TypeError):
        return None
    if info and Path(info.get("root", "")).resolve() == Path(root).resolve():
        return {**info, "port": int(d["port"])}
    return None


def write_lock(root: Path, port: int) -> None:
    try:
        lock_path(root).parent.mkdir(parents=True, exist_ok=True)
        lock_path(root).write_text(json.dumps({"port": port, "pid": os.getpid(), "started": time.time()}))
    except OSError:
        pass


def remove_lock(root: Path) -> None:
    try:
        if json.loads(lock_path(root).read_text()).get("pid") == os.getpid():
            lock_path(root).unlink()
    except (OSError, ValueError):
        pass


def choose_port(preferred: int, root: Path, tries: int = 10) -> tuple[int, dict | None]:
    """(port to serve on, running instance to reuse instead). A service
    already serving this project wins; a foreign process on the port is
    skipped."""
    running = read_lock(root)
    if running is not None:
        return running["port"], running
    for p in range(preferred, preferred + tries):
        info = ping(p)
        if info is not None:
            if Path(info.get("root", "")).resolve() == Path(root).resolve():
                return p, info
            continue
        if port_free(p):
            return p, None
    raise OSError(f"no free port in {preferred}-{preferred + tries - 1}")


def open_url(url: str):
    if sys.platform == "darwin":
        subprocess.Popen(["open", url])
    else:
        import webbrowser

        webbrowser.open(url)


def notify(title: str, text: str):
    """A macOS notification (used when there is no Terminal to print to)."""
    if sys.platform == "darwin" and os.environ.get("TERM") is None:
        subprocess.run(["osascript", "-e", f'display notification "{text}" with title "{title}"'], check=False, capture_output=True)
