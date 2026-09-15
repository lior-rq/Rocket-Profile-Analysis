"""Start / stop the RASAero worker inside the UTM Windows VM from the Mac.

Built on rpa.vmagent (utmctl push / pull / exec through the guest agent).
`exec` runs as SYSTEM in session 0, where nothing can touch the desktop, so
the worker itself is started through a Windows scheduled task bound to the
interactive user; that logic lives in worker/vm_task.ps1, which is pushed
into the guest before every action (the WebDAV share caches file contents)
and answers through a base64 result file matched by a nonce.

With the `agent` job transport the worker files themselves are pushed into
C:\\rpa\\worker and the worker runs entirely from local disk; its heartbeat
and console log are pulled back here for the GUI.
"""

from __future__ import annotations

import base64
import json
import threading
import time
import uuid
from pathlib import Path

from ..vmagent import DEFAULT_GUEST_ROOT, GuestAgent

DEFAULTS = {"name": "Windows", "utmctl": "auto", "share_drive": "Z:", "task_name": "RPAWorker", "python": "auto", "boot_timeout_s": 240, "action_timeout_s": 90, "heartbeat_wait_s": 90, "poll_s": 1.5, "guest_root": DEFAULT_GUEST_ROOT}
GUEST_SCRIPT = r"C:\Windows\Temp\rpa_vm_task.ps1"
GUEST_RESULT = r"C:\Windows\Temp\rpa_vm_result.json"
GUEST_LOG = r"C:\Windows\Temp\rpa_vm_task.log"
POWERSHELL = r"C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe"
WORKER_FILES = ["run_worker.py", "rasaero_worker.py", "worker_config.json", "vm_task.ps1"]


class VMControl:
    def __init__(self, cfg: dict | None, root: Path, log=print, transport: str = "share"):
        c = dict(DEFAULTS)
        c.update({k: v for k, v in (cfg or {}).items() if v is not None})
        # the guest agent mangles quotes on the command line: no spaces allowed
        c["task_name"] = "".join(ch for ch in str(c["task_name"]) if ch.isalnum() or ch in "_-") or "RPAWorker"
        self.cfg = c
        self.root = Path(root)
        self.log = log
        self.transport = transport
        self.agent = GuestAgent(c["name"], c.get("utmctl", "auto"))
        self.script = self.root / "worker" / "vm_task.ps1"
        self.lock = threading.Lock()
        self.op: dict = {"running": False, "op": None, "started": None, "finished": None, "ok": None, "message": ""}

    # ---- utmctl primitives ---------------------------------------------------
    @property
    def available(self) -> bool:
        return self.agent.available

    @property
    def utmctl(self) -> str | None:
        return self.agent.utmctl

    def vm_status(self, max_age: float = 5.0) -> str | None:
        return self.agent.status(max_age) if self.agent.available else None

    def start_vm(self):
        self.agent.start_vm()

    def push_script(self):
        self.agent.push(self.script, GUEST_SCRIPT)

    def push_worker_files(self) -> list[str]:
        """The worker's own files into <guest_root>\\worker (agent transport)."""
        root = self.cfg["guest_root"]
        self.agent.mkdir(root, f"{root}\\worker", f"{root}\\jobs")
        pushed = []
        deadline = time.time() + 20
        for name in WORKER_FILES:
            src = self.root / "worker" / name
            if not src.exists():
                continue
            while True:  # mkdir above is asynchronous
                try:
                    self.agent.push(src, f"{root}\\worker\\{name}")
                    break
                except OSError:
                    if time.time() > deadline:
                        raise
                    time.sleep(1.0)
            pushed.append(name)
        return pushed

    def run_action(self, action: str, timeout: float | None = None, push: bool = True) -> dict:
        """Run one vm_task.ps1 action in the guest and return its JSON result."""
        timeout = timeout or float(self.cfg["action_timeout_s"])
        if push:
            self.push_script()
        nonce = uuid.uuid4().hex[:10]
        c = self.cfg
        ps_args = f"{POWERSHELL} -NoProfile -ExecutionPolicy Bypass -File {GUEST_SCRIPT} {action} -Nonce {nonce} -TaskName {c['task_name']} -Share {c['share_drive']} -Python {c['python']} -Transport {self.transport} -Root {c['guest_root']}"
        self.agent.exec(f"{ps_args} > {GUEST_LOG} 2>&1")
        t0 = time.time()
        while time.time() - t0 < timeout:
            time.sleep(float(self.cfg["poll_s"]))
            raw = self.agent.pull(GUEST_RESULT, timeout=20)
            if not raw:
                continue
            try:
                data = json.loads(base64.b64decode(raw.strip()).decode("utf-8"))
            except Exception:  # noqa: BLE001 - half-written file; keep polling
                continue
            if data.get("nonce") == nonce:
                return data
        raise TimeoutError(f"no answer from the guest for '{action}' within {timeout:.0f}s (is the guest agent running? VM status: {self.vm_status(0)})")

    # ---- worker liveness (agent transport) ------------------------------------
    def pull_worker_files(self, dest_dir: Path) -> bool:
        """heartbeat.json and console.log from the guest into dest_dir; True when the heartbeat came back."""
        root = self.cfg["guest_root"]
        ok = False
        hb = self.agent.pull(f"{root}\\worker\\heartbeat.json", timeout=15)
        if hb:
            (dest_dir / "heartbeat.json").write_bytes(hb)
            ok = True
        log = self.agent.pull(f"{root}\\worker\\console.log", timeout=30)
        if log:
            (dest_dir / "console.log").write_bytes(log)
        status = self.agent.pull(f"{root}\\worker\\worker_status.json", timeout=15)
        if status:
            (dest_dir / "worker_status.json").write_bytes(status)
        return ok

    # ---- orchestration ---------------------------------------------------------
    def _begin(self, op: str) -> bool:
        with self.lock:
            if self.op["running"]:
                return False
            self.op = {"running": True, "op": op, "started": time.time(), "finished": None, "ok": None, "message": ""}
            return True

    def _end(self, ok: bool, message: str):
        with self.lock:
            self.op.update({"running": False, "finished": time.time(), "ok": ok, "message": message})

    def start_worker_async(self, on_change=None) -> bool:
        if not self._begin("start"):
            return False
        threading.Thread(target=self._guard, args=(self._start_worker, on_change), daemon=True).start()
        return True

    def stop_worker_async(self, on_change=None) -> bool:
        if not self._begin("stop"):
            return False
        threading.Thread(target=self._guard, args=(self._stop_worker, on_change), daemon=True).start()
        return True

    def _guard(self, fn, on_change):
        try:
            msg = fn()
            self._end(True, msg)
            self.log(f"vm: {msg}")
        except Exception as e:  # noqa: BLE001 - reported to the GUI, never raised into the server
            self._end(False, str(e))
            self.log(f"vm: FAILED - {e}")
        if on_change:
            on_change()

    def _wait_guest(self) -> dict:
        """Wait for utmctl to report the VM started and the guest agent to answer."""
        deadline = time.time() + float(self.cfg["boot_timeout_s"])
        last = None
        while time.time() < deadline:
            st = self.vm_status(0)
            if st != last:
                self.log(f"vm: {self.cfg['name']} is {st or 'unknown'}")
                last = st
            if st == "started":
                try:
                    return self.run_action("status", timeout=20)
                except (TimeoutError, RuntimeError, OSError):
                    pass
            time.sleep(3)
        raise TimeoutError(f"the VM did not come up within {self.cfg['boot_timeout_s']} s (UTM status: {self.vm_status(0)})")

    def _read_heartbeat(self) -> dict | None:
        p = self.root / "worker" / "heartbeat.json"
        if self.transport == "agent":
            self.pull_worker_files(self.root / "worker")
        try:
            return json.loads(p.read_text())
        except (OSError, ValueError):
            return None

    def _start_worker(self) -> str:
        if not self.available:
            raise RuntimeError("utmctl not found - is UTM installed? (set vm.utmctl in config.yaml)")
        name = self.cfg["name"]
        st = self.vm_status(0)
        if st != "started":
            self.log(f"vm: {name} is {st or 'not registered'} - starting it")
            self.start_vm()
        self.log("vm: waiting for the guest agent")
        status = self._wait_guest()
        if self.transport == "agent":
            pushed = self.push_worker_files()
            self.log(f"vm: worker files pushed to {self.cfg['guest_root']}\\worker ({', '.join(pushed)})")
        if status.get("workers"):
            pids = ", ".join(str(w.get("pid")) for w in status["workers"])
            return f"worker already running in the VM (pid {pids})"
        deadline = time.time() + 180
        while not status.get("user"):
            self.log("vm: Windows is up but nobody is logged on - log in to the VM window (the worker starts by itself at logon once registered)")
            if time.time() > deadline:
                raise RuntimeError("nobody logged on to Windows within 3 minutes - log in, then press Start again")
            time.sleep(10)
            status = self.run_action("status", timeout=30, push=False)
        self.log(f"vm: logged-on user {status['user']}; registering the scheduled task '{self.cfg['task_name']}' ({self.transport} transport) and starting it")
        res = self.run_action("start")
        if not res.get("ok"):
            raise RuntimeError(res.get("error") or "start failed")
        self.log(f"vm: {res.get('message')} ({res.get('command') or res.get('python') or '?'}); waiting for the worker's heartbeat")
        t0 = time.time()
        while time.time() - t0 < float(self.cfg["heartbeat_wait_s"]):
            d = self._read_heartbeat()
            if d and time.time() - float(d.get("epoch", 0)) < 60 and d.get("status") == "running":
                return f"worker started (launcher pid {d.get('launcher_pid')}, worker pid {d.get('worker_pid')}, {d.get('host')})"
            time.sleep(min(3.0, float(self.cfg["heartbeat_wait_s"])))
        return "task started; the worker's heartbeat has not shown up yet - check the worker console"

    def _stop_worker(self) -> str:
        if self.vm_status(0) != "started":
            return "VM is not running - nothing to stop"
        res = self.run_action("stop")
        if not res.get("ok"):
            raise RuntimeError(res.get("error") or "stop failed")
        killed = res.get("killed") or []
        return f"worker stopped ({len(killed)} process(es) ended)" if killed else "no worker process was running"

    def guest_status(self) -> dict:
        if self.vm_status(0) != "started":
            return {"ok": False, "error": f"VM is {self.vm_status(0) or 'not registered'}"}
        return self.run_action("status")

    def snapshot(self) -> dict:
        with self.lock:
            op = dict(self.op)
        if op["running"] and op["started"]:
            op["elapsed_s"] = round(time.time() - op["started"], 1)
        # utmctl status is a subprocess (~100 ms): fine every 20 s for a status pill
        return {"available": self.available, "utmctl": self.utmctl, "name": self.cfg["name"], "status": self.vm_status(20.0) if self.available else None, "transport": self.transport, "op": op}
