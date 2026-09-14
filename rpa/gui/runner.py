"""Runs one pipeline command at a time as a subprocess (python -m rpa ...)
and streams its output to the browser.

A subprocess rather than an in-process call so a run can be cancelled, so a
crash cannot take the GUI down, and because OpenRocket's JVM can only be
started once per process.
"""

from __future__ import annotations

import json
import os
import queue
import re
import subprocess
import sys
import threading
import time
from collections import deque
from pathlib import Path

_PROGRESS_RE = re.compile(r"\[\s*(\d+)\s*/\s*(\d+)\]")
_SUBSTAGE_RE = re.compile(r"^=== (\w+) ===$")
_ROUND_RE = re.compile(r"^\s*round (\d+): (\d+) (?:rows|refinement rows)")
_ERROR_RE = re.compile(r"^(Traceback|\w*Error:|\w*Exception:)")

FINDINGS_STAGES = {"check", "validate"}  # exit code 1 = "reported problems", not a crash
MAX_LINES = 8000
MAX_HISTORY = 200


class Runner:
    def __init__(self, root: Path, history_file: Path | None = None):
        self.root = Path(root)
        self.history_file = history_file
        self.lock = threading.Lock()
        self.proc: subprocess.Popen | None = None
        self.lines: deque = deque(maxlen=MAX_LINES)
        self.seq = 0
        self.subs: set[queue.Queue] = set()
        self.status = {"running": False, "stage": None, "args": [], "started": None, "finished": None, "exit_code": None, "substage": None, "progress": None, "elapsed_s": 0.0, "pid": None, "cancelled": False, "error_lines": 0}
        self.history: list[dict] = []
        if history_file and history_file.exists():
            try:
                self.history = json.loads(history_file.read_text())[-MAX_HISTORY:]
            except (OSError, ValueError):
                self.history = []

    # ---- pub/sub ----------------------------------------------------------
    def subscribe(self) -> queue.Queue:
        q: queue.Queue = queue.Queue(maxsize=10000)
        with self.lock:
            self.subs.add(q)
        return q

    def unsubscribe(self, q: queue.Queue):
        with self.lock:
            self.subs.discard(q)

    def _emit(self, event: str, data: dict):
        with self.lock:
            subs = list(self.subs)
        for q in subs:
            try:
                q.put_nowait((event, data))
            except queue.Full:
                pass

    def _add_line(self, text: str):
        self.seq += 1
        rec = {"seq": self.seq, "t": time.time(), "text": text}
        self.lines.append(rec)
        st = self.status
        before = (st["substage"], json.dumps(st["progress"]))
        m = _SUBSTAGE_RE.match(text.strip())
        if m:
            st["substage"] = m.group(1)
            st["progress"] = None
        m = _PROGRESS_RE.search(text)
        if m:
            st["progress"] = {"done": int(m.group(1)), "total": int(m.group(2))}
        m = _ROUND_RE.match(text)
        if m:
            st["progress"] = {"round": int(m.group(1)), "rows": int(m.group(2))}
        if _ERROR_RE.match(text) or "!!" in text or text.startswith("worker reported failure"):
            st["error_lines"] += 1
        self._emit("log", rec)
        if st["running"] and (st["substage"], json.dumps(st["progress"])) != before:
            self._emit("state", self.current())

    def note(self, text: str):
        """Append a line that did not come from the subprocess (VM control etc.)."""
        with self.lock:
            self.seq += 1
            rec = {"seq": self.seq, "t": time.time(), "text": text}
            self.lines.append(rec)
        self._emit("log", rec)

    def lines_after(self, seq: int) -> list[dict]:
        return [r for r in self.lines if r["seq"] > seq]

    # ---- control ----------------------------------------------------------
    def current(self) -> dict:
        st = dict(self.status)
        if st["running"] and st["started"]:
            st["elapsed_s"] = round(time.time() - st["started"], 1)
        return st

    def start(self, stage: str, args: list[str], label: str | None = None) -> dict:
        with self.lock:
            if self.proc is not None and self.proc.poll() is None:
                raise RuntimeError(f"already running: {self.status['stage']}")
            cmd = [sys.executable, "-m", "rpa", stage, *args]
            env = dict(os.environ, PYTHONUNBUFFERED="1", RPA_GUI="1")
            self.proc = subprocess.Popen(cmd, cwd=str(self.root), stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, bufsize=1, env=env)
            self.status.update({"running": True, "stage": stage, "args": list(args), "label": label or stage, "started": time.time(), "finished": None, "exit_code": None, "substage": None if stage != "run" else "motors", "progress": None, "elapsed_s": 0.0, "pid": self.proc.pid, "cancelled": False, "error_lines": 0, "first_seq": self.seq + 1})
        self._add_line("$ python -m rpa " + " ".join([stage, *args]))
        threading.Thread(target=self._pump, args=(self.proc,), daemon=True).start()
        self._emit("state", self.current())
        return self.current()

    def cancel(self) -> bool:
        with self.lock:
            p = self.proc
            if p is None or p.poll() is not None:
                return False
            self.status["cancelled"] = True
        p.terminate()
        for _ in range(50):
            if p.poll() is not None:
                break
            time.sleep(0.1)
        else:
            p.kill()
        return True

    def _pump(self, p: subprocess.Popen):
        assert p.stdout is not None
        for raw in p.stdout:
            self._add_line(raw.rstrip("\n"))
        code = p.wait()
        with self.lock:
            st = self.status
            st.update({"running": False, "finished": time.time(), "exit_code": code, "elapsed_s": round(time.time() - (st["started"] or time.time()), 1), "pid": None})
            rec = {"stage": st["stage"], "args": st["args"], "label": st.get("label"), "started": st["started"], "finished": st["finished"], "elapsed_s": st["elapsed_s"], "exit_code": code, "cancelled": st["cancelled"], "error_lines": st["error_lines"]}
            self.history.append(rec)
            self.history = self.history[-MAX_HISTORY:]
            if self.history_file:
                try:
                    self.history_file.parent.mkdir(parents=True, exist_ok=True)
                    self.history_file.write_text(json.dumps(self.history, indent=1))
                except OSError:
                    pass
        outcome = "cancelled" if st["cancelled"] else ("finished" if code == 0 else "finished with findings (exit code 1)" if (code == 1 and st["stage"] in FINDINGS_STAGES) else f"failed (exit code {code})")
        self._add_line(f"--- {st['stage']} {outcome} after {st['elapsed_s']:.0f}s ---")
        self._emit("state", self.current())

    def last_run(self, stage: str) -> dict | None:
        for rec in reversed(self.history):
            if rec["stage"] == stage:
                return rec
        return None
