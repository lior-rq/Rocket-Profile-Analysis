"""Runs pipeline commands as subprocesses (python -m rpa ...) and streams
their output to the browser.

A subprocess rather than an in-process call so a run can be cancelled, so a
crash cannot take the GUI down, and because OpenRocket's JVM can only be
started once per process. One long stage at a time; a light stage (check,
report) may run beside it. Every run's output is also written to
output/gui_logs/<started>-<stage>.log and summarised in gui_runs.json.
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
LIGHT_STAGES = {"check", "report"}  # may run beside a long stage
MAX_LINES = 8000
MAX_HISTORY = 200


class Runner:
    def __init__(self, root: Path, history_file: Path | None = None, log_dir: Path | None = None):
        self.root = Path(root)
        self.history_file = history_file
        self.log_dir = Path(log_dir) if log_dir else None
        self.lock = threading.Lock()
        self.proc: subprocess.Popen | None = None
        self.side_proc: subprocess.Popen | None = None
        self.lines: deque = deque(maxlen=MAX_LINES)
        self.seq = 0
        self.subs: set[queue.Queue] = set()
        self.status = {"running": False, "stage": None, "args": [], "started": None, "finished": None, "exit_code": None, "substage": None, "progress": None, "round": None, "elapsed_s": 0.0, "pid": None, "cancelled": False, "error_lines": 0, "last_error": None, "log": None, "side": None}
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

    def _record_line(self, text: str, logf) -> dict:
        self.seq += 1
        rec = {"seq": self.seq, "t": time.time(), "text": text}
        self.lines.append(rec)
        if logf is not None:
            try:
                logf.write(text + "\n")
                logf.flush()
            except OSError:
                pass
        return rec

    def _add_line(self, text: str, logf=None):
        rec = self._record_line(text, logf)
        st = self.status
        before = (st["substage"], json.dumps(st["progress"]), json.dumps(st["round"]))
        m = _SUBSTAGE_RE.match(text.strip())
        if m:
            st["substage"] = m.group(1)
            st["progress"] = None
            st["round"] = None
        m = _PROGRESS_RE.search(text)
        if m:
            st["progress"] = {"done": int(m.group(1)), "total": int(m.group(2))}
        m = _ROUND_RE.match(text)
        if m:  # a search round: batch progress restarts inside it
            st["round"] = {"round": int(m.group(1)), "rows": int(m.group(2))}
            st["progress"] = None
        if _is_error(text):
            st["error_lines"] += 1
            st["last_error"] = text.strip()
        self._emit("log", rec)
        if st["running"] and (st["substage"], json.dumps(st["progress"]), json.dumps(st["round"])) != before:
            self._emit("state", self.current())

    def note(self, text: str):
        """Append a line that did not come from a subprocess (VM control etc.)."""
        with self.lock:
            rec = self._record_line(text, None)
        self._emit("log", rec)

    def lines_after(self, seq: int) -> list[dict]:
        return [r for r in self.lines if r["seq"] > seq]

    # ---- control ----------------------------------------------------------
    def current(self) -> dict:
        st = dict(self.status)
        if st["running"] and st["started"]:
            st["elapsed_s"] = round(time.time() - st["started"], 1)
        if st["side"]:
            st["side"] = {**st["side"], "elapsed_s": round(time.time() - st["side"]["started"], 1)}
        return st

    def _open_log(self, stage: str) -> tuple[str | None, object]:
        if not self.log_dir:
            return None, None
        try:
            self.log_dir.mkdir(parents=True, exist_ok=True)
            p = self.log_dir / f"{time.strftime('%Y%m%d-%H%M%S')}-{stage}.log"
            return str(p.relative_to(self.root)) if self.root in p.parents else str(p), open(p, "w", encoding="utf-8")
        except OSError:
            return None, None

    def _spawn(self, stage: str, args: list[str]) -> subprocess.Popen:
        cmd = [sys.executable, "-m", "rpa", stage, *args]
        env = dict(os.environ, PYTHONUNBUFFERED="1", RPA_GUI="1")
        return subprocess.Popen(cmd, cwd=str(self.root), stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, bufsize=1, env=env)

    def start(self, stage: str, args: list[str], label: str | None = None) -> dict:
        """Start a stage. A light stage (check, report) may run beside a long
        one; anything else is refused while a run is going. Events are
        emitted after the lock is released (_emit takes it too)."""
        with self.lock:
            main_running = self.proc is not None and self.proc.poll() is None
            side = False
            if main_running:
                side_running = self.side_proc is not None and self.side_proc.poll() is None
                if stage not in LIGHT_STAGES or side_running:
                    raise RuntimeError(f"already running: {self.status['stage']}" + (f" (and {self.status['side']['stage']} beside it)" if side_running and self.status["side"] else ""))
                side = True
                log_rel, logf = self._open_log(stage)
                proc = self.side_proc = self._spawn(stage, args)
                self.status["side"] = {"stage": stage, "args": list(args), "label": label or stage, "started": time.time(), "pid": proc.pid, "log": log_rel}
                rec = self._record_line(f"[{stage}] $ python -m rpa " + " ".join([stage, *args]), logf)
            else:
                log_rel, logf = self._open_log(stage)
                proc = self.proc = self._spawn(stage, args)
                self.status.update({"running": True, "stage": stage, "args": list(args), "label": label or stage, "started": time.time(), "finished": None, "exit_code": None, "substage": None if stage != "run" else "motors", "progress": None, "round": None, "elapsed_s": 0.0, "pid": proc.pid, "cancelled": False, "error_lines": 0, "last_error": None, "log": log_rel, "first_seq": self.seq + 1})
        if side:
            self._emit("log", rec)
            threading.Thread(target=self._pump_side, args=(proc, stage, logf), daemon=True).start()
        else:
            self._add_line("$ python -m rpa " + " ".join([stage, *args]), logf)
            threading.Thread(target=self._pump, args=(proc, logf), daemon=True).start()
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

    def _record_history(self, rec: dict):
        self.history.append(rec)
        self.history = self.history[-MAX_HISTORY:]
        if self.history_file:
            try:
                self.history_file.parent.mkdir(parents=True, exist_ok=True)
                self.history_file.write_text(json.dumps(self.history, indent=1))
            except OSError:
                pass

    def _pump(self, p: subprocess.Popen, logf):
        assert p.stdout is not None
        for raw in p.stdout:
            self._add_line(raw.rstrip("\n"), logf)
        code = p.wait()
        with self.lock:
            st = self.status
            st.update({"running": False, "finished": time.time(), "exit_code": code, "elapsed_s": round(time.time() - (st["started"] or time.time()), 1), "pid": None})
            rec = {"stage": st["stage"], "args": st["args"], "label": st.get("label"), "started": st["started"], "finished": st["finished"], "elapsed_s": st["elapsed_s"], "exit_code": code, "cancelled": st["cancelled"], "error_lines": st["error_lines"], "last_error": st["last_error"], "log": st["log"]}
            self._record_history(rec)
        outcome = "cancelled" if st["cancelled"] else ("finished" if code == 0 else "finished with findings (exit code 1)" if (code == 1 and st["stage"] in FINDINGS_STAGES) else f"failed (exit code {code})")
        self._add_line(f"--- {st['stage']} {outcome} after {st['elapsed_s']:.0f}s ---", logf)
        if logf is not None:
            try:
                logf.close()
            except OSError:
                pass
        self._emit("state", self.current())

    def _pump_side(self, p: subprocess.Popen, stage: str, logf):
        assert p.stdout is not None
        last_error, n_err = None, 0
        for raw in p.stdout:
            text = raw.rstrip("\n")
            if _is_error(text):
                n_err += 1
                last_error = text.strip()
            rec = self._record_line(f"[{stage}] {text}", logf)
            self._emit("log", rec)
        code = p.wait()
        with self.lock:
            side = self.status["side"] or {}
            finished = time.time()
            rec = {"stage": stage, "args": side.get("args", []), "label": side.get("label"), "started": side.get("started"), "finished": finished, "elapsed_s": round(finished - side.get("started", finished), 1), "exit_code": code, "cancelled": False, "error_lines": n_err, "last_error": last_error, "log": side.get("log"), "side": True}
            self._record_history(rec)
            self.status["side"] = None
        outcome = "finished" if code == 0 else "finished with findings (exit code 1)" if (code == 1 and stage in FINDINGS_STAGES) else f"failed (exit code {code})"
        line = self._record_line(f"[{stage}] --- {stage} {outcome} after {rec['elapsed_s']:.0f}s ---", logf)
        if logf is not None:
            try:
                logf.close()
            except OSError:
                pass
        self._emit("log", line)
        self._emit("state", self.current())

    def last_run(self, stage: str) -> dict | None:
        for rec in reversed(self.history):
            if rec["stage"] == stage:
                return rec
        return None


def _is_error(text: str) -> bool:
    return bool(_ERROR_RE.match(text)) or "!!" in text or text.startswith("worker reported failure")
