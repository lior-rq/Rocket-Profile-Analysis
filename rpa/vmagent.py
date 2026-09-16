"""UTM guest-agent primitives (`utmctl` file push / pull / exec), used by
the job transport (rpa.jobs) and the GUI's VM control.

Facts about utmctl (measured on UTM 4.x):
  * `file push` / `file pull` are byte-exact, ~0.5 MB/s; a missing file or
    directory is reported on stderr with exit code 0.
  * `exec` runs the command as SYSTEM in session 0, returns almost at once,
    and does not reliably return output - fire-and-forget only.
  * quotes inside an exec command line are mangled: never pass arguments
    that contain spaces.
"""

from __future__ import annotations

import os
import shutil
import subprocess
import time
from pathlib import Path

UTMCTL_CANDIDATES = ["/Applications/UTM.app/Contents/MacOS/utmctl", os.path.expanduser("~/Applications/UTM.app/Contents/MacOS/utmctl")]
DEFAULT_GUEST_ROOT = r"C:\rpa"  # worker files in <root>\worker, jobs in <root>\jobs


def find_utmctl(setting: str | None = "auto") -> str | None:
    if setting and setting != "auto":
        return setting if Path(setting).exists() else None
    for c in UTMCTL_CANDIDATES:
        if Path(c).exists():
            return c
    return shutil.which("utmctl")


class GuestAgent:
    def __init__(self, vm_name: str, utmctl: str | None = "auto"):
        self.vm = vm_name
        self.utmctl = find_utmctl(utmctl)
        self._status_cache: tuple[float, str | None] = (0.0, None)

    @property
    def available(self) -> bool:
        return bool(self.utmctl)

    def run(self, args: list[str], timeout: float = 30.0, stdin: bytes | None = None) -> tuple[int, bytes, str]:
        """(exit code, stdout bytes, stderr text)."""
        if not self.utmctl:
            raise RuntimeError("utmctl not found - is UTM installed? (vm.utmctl in config.yaml)")
        p = subprocess.run([self.utmctl, *args], input=stdin, capture_output=True, timeout=timeout, check=False)
        return p.returncode, p.stdout or b"", (p.stderr or b"").decode("utf-8", "replace")

    # ---- VM ---------------------------------------------------------------
    def status(self, max_age: float = 5.0) -> str | None:
        """started | stopped | paused | ... (None when unknown / not registered)."""
        t, v = self._status_cache
        if time.time() - t < max_age:
            return v
        try:
            rc, out, _ = self.run(["status", self.vm], timeout=10)
            txt = out.decode("utf-8", "replace").strip()
            v = txt.splitlines()[0].strip() if rc == 0 and txt else None
        except Exception:  # noqa: BLE001 - any utmctl trouble reads as unknown
            v = None
        self._status_cache = (time.time(), v)
        return v

    def start_vm(self):
        rc, _, err = self.run(["start", self.vm], timeout=60)
        self._status_cache = (0.0, None)
        if rc != 0:
            raise RuntimeError(f"utmctl start failed: {err.strip()}")

    # ---- files --------------------------------------------------------------
    def push(self, data: bytes | Path, guest_path: str, attempts: int = 3) -> None:
        """Copy bytes (or a local file) to a path in the guest (parent must exist)."""
        blob = data.read_bytes() if isinstance(data, Path) else data
        last = ""
        for i in range(attempts):
            rc, _, err = self.run(["file", "push", self.vm, guest_path], timeout=60 + len(blob) / 100_000, stdin=blob)
            if rc == 0 and "failed to open" not in err and "Error" not in err:
                return
            last = err.strip()
            time.sleep(1.0 + i)
        raise OSError(f"push to {guest_path} failed: {last}")

    def pull(self, guest_path: str, timeout: float = 60.0) -> bytes | None:
        """File content from the guest, or None when it does not exist."""
        try:
            rc, out, err = self.run(["file", "pull", self.vm, guest_path], timeout=timeout)
        except subprocess.TimeoutExpired:
            return None
        if rc != 0 or "failed to open" in err or (not out and "Error" in err):
            return None
        return out

    def pull_text(self, guest_path: str) -> str | None:
        b = self.pull(guest_path)
        return None if b is None else b.decode("utf-8", "replace")

    # ---- commands -----------------------------------------------------------
    def exec(self, cmdline: str, timeout: float = 30.0) -> None:
        """Run `cmd.exe /c <cmdline>` in the guest (SYSTEM, session 0); returns
        without waiting for it to finish."""
        self.run(["exec", self.vm, "--cmd", "cmd.exe", "/c", cmdline], timeout=timeout)

    def mkdir(self, *guest_dirs: str) -> None:
        for d in guest_dirs:
            self.exec(f"if not exist {d} mkdir {d}")
