"""Runs pipeline stages in a worker thread of this process and streams their
log to the browser. Same status / log / history contract as the old
subprocess runner (rpa/gui/runner.py), so the front end does not change.

One long stage at a time; check / report may run beside it. Output also goes
to output/gui_logs/<started>-<stage>.log, summarised in gui_runs.json.
Cancel is cooperative: the batch loops check a flag between flights."""

from __future__ import annotations

import io
import json
import queue
import re
import sys
import threading
import time
import traceback
from collections import deque
from pathlib import Path

from .. import pipeline as P
from . import stages

_PROGRESS_RE = re.compile(r"\[\s*(\d+)\s*/\s*(\d+)\]")
_SUBSTAGE_RE = re.compile(r"^=== (\w+) ===$")
_ROUND_RE = re.compile(r"^\s*round (\w+): (\d+) (?:rows|refinement rows)")
_ERROR_RE = re.compile(r"^(Traceback|\w*Error:|\w*Exception:)")

FINDINGS_STAGES = {"check", "validate"}  # exit code 1 = "reported problems", not a crash
LIGHT_STAGES = {"check", "report"}  # may run beside a long stage
MAX_LINES = 8000
MAX_HISTORY = 200
CANCELLED_CODE = -15  # what SIGTERM gave the old subprocess runner


class StdoutRouter(io.TextIOBase):
    """sys.stdout replacement: a thread with a registered log sink gets its
    prints there (line-buffered); everything else goes to the real stdout."""

    def __init__(self, real):
        self.real = real
        self._buf: dict[int, str] = {}

    def write(self, s):
        sink = P.current_sink()
        if sink is None:
            return self.real.write(s)
        tid = threading.get_ident()
        buf = self._buf.get(tid, "") + s
        *lines, rest = buf.split("\n")
        self._buf[tid] = rest
        for ln in lines:
            sink(ln)
        return len(s)

    def flush(self):
        tid = threading.get_ident()
        rest = self._buf.pop(tid, "")
        sink = P.current_sink()
        if rest and sink is not None:
            sink(rest)
        self.real.flush()

    def isatty(self):
        return False

    @property
    def encoding(self):
        return getattr(self.real, "encoding", "utf-8")


def install_stdout_router():
    if not isinstance(sys.stdout, StdoutRouter):
        sys.stdout = StdoutRouter(sys.stdout)


class Runner:
    def __init__(self, root: Path, history_file: Path | None = None, log_dir: Path | None = None):
        self.root = Path(root)
        self.history_file = history_file
        self.log_dir = Path(log_dir) if log_dir else None
        self.lock = threading.Lock()
        self.thread: threading.Thread | None = None
        self.side_thread: threading.Thread | None = None
        self.cancel_event: threading.Event | None = None
        self.lines: deque = deque(maxlen=MAX_LINES)
        self.seq = 0
        self.subs: set[queue.Queue] = set()
        self.status = {"running": False, "stage": None, "args": [], "started": None, "finished": None, "exit_code": None, "substage": None, "progress": None, "round": None, "elapsed_s": 0.0, "pid": None, "cancelled": False, "error_lines": 0, "last_error": None, "log": None, "side": None}
        self.history: list[dict] = []
        if history_file and history_file.exists():
            try:
                self.history = json.loads(history_file.read_text(encoding="utf-8"))[-MAX_HISTORY:]
            except (OSError, ValueError):
                self.history = []
        install_stdout_router()

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
        with self.lock:
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
                st["round"] = {"round": m.group(1), "rows": int(m.group(2))}
                st["progress"] = None
            if _is_error(text):
                st["error_lines"] += 1
                st["last_error"] = text.strip()
            changed = st["running"] and (st["substage"], json.dumps(st["progress"]), json.dumps(st["round"])) != before
        self._emit("log", rec)
        if changed:
            self._emit("state", self.current())

    def note(self, text: str):
        """Append a line that did not come from a stage (VM control etc.)."""
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

    @property
    def main_running(self) -> bool:
        return self.thread is not None and self.thread.is_alive()

    def start(self, stage: str, args: list[str], label: str | None = None) -> dict:
        """Start a stage. A light stage (check, report) may run beside a long
        one; anything else is refused while a run is going."""
        with self.lock:
            main_running = self.main_running
            side = False
            if main_running:
                side_running = self.side_thread is not None and self.side_thread.is_alive()
                if stage not in LIGHT_STAGES or side_running:
                    raise RuntimeError(f"already running: {self.status['stage']}" + (f" (and {self.status['side']['stage']} beside it)" if side_running and self.status["side"] else ""))
                side = True
                log_rel, logf = self._open_log(stage)
                t = self.side_thread = threading.Thread(target=self._run_side, args=(stage, args, logf), name=f"rpa-side-{stage}", daemon=True)
                self.status["side"] = {"stage": stage, "args": list(args), "label": label or stage, "started": time.time(), "pid": None, "log": log_rel}
                rec = self._record_line(f"[{stage}] $ rpa " + " ".join([stage, *args]), logf)
            else:
                log_rel, logf = self._open_log(stage)
                self.cancel_event = threading.Event()
                t = self.thread = threading.Thread(target=self._run_main, args=(stage, args, logf, self.cancel_event), name=f"rpa-{stage}", daemon=True)
                self.status.update({"running": True, "stage": stage, "args": list(args), "label": label or stage, "started": time.time(), "finished": None, "exit_code": None, "substage": None if stage != "run" else "motors", "progress": None, "round": None, "elapsed_s": 0.0, "pid": None, "cancelled": False, "error_lines": 0, "last_error": None, "log": log_rel, "first_seq": self.seq + 1})
        if side:
            self._emit("log", rec)
        else:
            self._add_line("$ rpa " + " ".join([stage, *args]), logf)
        t.start()
        self._emit("state", self.current())
        return self.current()

    def cancel(self) -> bool:
        with self.lock:
            if not self.main_running or self.cancel_event is None:
                return False
            self.status["cancelled"] = True
            self.cancel_event.set()
        return True

    def wait(self, timeout: float | None = None) -> bool:
        """Block until the main stage (if any) finishes."""
        t = self.thread
        if t is not None:
            t.join(timeout)
            return not t.is_alive()
        return True

    def _record_history(self, rec: dict):
        self.history.append(rec)
        self.history = self.history[-MAX_HISTORY:]
        if self.history_file:
            try:
                self.history_file.parent.mkdir(parents=True, exist_ok=True)
                self.history_file.write_text(json.dumps(self.history, indent=1), encoding="utf-8")
            except OSError:
                pass

    def _run_main(self, stage: str, args: list[str], logf, cancel: threading.Event):
        P.set_log_sink(lambda text: self._add_line(text, logf), main=True)
        P.set_cancel(cancel, main=True)
        try:
            code = stages.run_stage(stage, args, self.root)
        except P.Cancelled:
            code = CANCELLED_CODE
        except BaseException:  # noqa: BLE001 - a crash inside a stage must not take the service down
            for ln in traceback.format_exc().rstrip().split("\n"):
                self._add_line(ln, logf)
            code = 2
        finally:
            sys.stdout.flush()
            P.clear_log_sink(main=True)
            P.set_cancel(None, main=True)
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

    def _run_side(self, stage: str, args: list[str], logf):
        last_error, n_err = None, 0

        def sink(text: str):
            nonlocal last_error, n_err
            if _is_error(text):
                n_err += 1
                last_error = text.strip()
            with self.lock:
                rec = self._record_line(f"[{stage}] {text}", logf)
            self._emit("log", rec)

        P.set_log_sink(sink)
        try:
            code = stages.run_stage(stage, args, self.root)
        except BaseException:  # noqa: BLE001
            for ln in traceback.format_exc().rstrip().split("\n"):
                sink(ln)
            code = 2
        finally:
            sys.stdout.flush()
            P.clear_log_sink()
        with self.lock:
            side = self.status["side"] or {}
            finished = time.time()
            rec = {"stage": stage, "args": side.get("args", []), "label": side.get("label"), "started": side.get("started"), "finished": finished, "elapsed_s": round(finished - side.get("started", finished), 1), "exit_code": code, "cancelled": False, "error_lines": n_err, "last_error": last_error, "log": side.get("log"), "side": True}
            self._record_history(rec)
            self.status["side"] = None
        outcome = "finished" if code == 0 else "finished with findings (exit code 1)" if (code == 1 and stage in FINDINGS_STAGES) else f"failed (exit code {code})"
        with self.lock:
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
