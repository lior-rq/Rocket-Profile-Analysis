"""Job protocol between this (Mac) side and the RASAero worker in the
Windows VM.

    jobs/0007-search-r1-b2/
        job.json        what to do (written here)
        input.CDX1      the batch (written here)
        result.CDX1     saved by RASAero after Rerun All (written by the worker)
        export.csv      'View Data' export, export jobs only (worker)
        done.json       status (worker); worker.log / *.png for debugging

Transports:
  share  the repo is mounted in the VM (Z:) and both sides use the folder
         directly (the WebDAV share drops out and caches, hence the retries);
  agent  no shared folder: inputs are pushed into C:/rpa/jobs/<name> with
         UTM's guest agent and the results come back as done.zip (rpa.vmagent).
Manual mode prints what to do in RASAero and waits for the result files.
"""

from __future__ import annotations

import hashlib
import io
import json
import re
import time
import zipfile
from dataclasses import dataclass
from pathlib import Path

RERUN_SAVE = "rerun_save"
EXPORT = "export"
EXPORT_BATCH = "export_batch"  # spec.export_csvs: one View Data export per row
INSPECT = "inspect"
AERO_EXPORT = "aero_export"


@dataclass
class Job:
    dir: Path
    spec: dict

    @property
    def input_cdx1(self) -> Path:
        return self.dir / self.spec["cdx1"]

    @property
    def result_cdx1(self) -> Path:
        return self.dir / self.spec["result_cdx1"]

    @property
    def export_csv(self) -> Path | None:
        return self.dir / self.spec["export_csv"] if self.spec.get("export_csv") else None

    @property
    def export_csvs(self) -> list[Path]:
        """Every View Data export the job must produce (export + export_batch)."""
        names = [self.spec["export_csv"]] if self.spec.get("export_csv") else []
        return [self.dir / n for n in names + list(self.spec.get("export_csvs") or [])]

    @property
    def done_file(self) -> Path:
        return self.dir / "done.json"


class JobClient:
    def __init__(self, jobs_dir: Path, repo_root: Path, *, mode: str = "auto", poll_s: float = 3.0, timeout_s: float = 3600.0, log=print, transport: str = "share", agent=None, guest_root: str = r"C:\rpa"):
        self.jobs_dir = Path(jobs_dir)
        self.repo_root = Path(repo_root)
        self.mode = mode
        self.poll_s = poll_s
        self.timeout_s = timeout_s
        self.log = log
        self.transport = transport if mode == "auto" else "share"
        self.agent = agent
        self.guest_root = guest_root.rstrip("\\")
        if self.transport == "agent" and agent is None:
            raise ValueError("agent transport needs a GuestAgent")
        self._pushed_motor_hashes: set[str] = set()
        self.jobs_dir.mkdir(parents=True, exist_ok=True)

    def guest_dir(self, job: Job) -> str:
        return f"{self.guest_root}\\jobs\\{job.dir.name}"

    def _next_dir(self, name: str) -> Path:
        nums = [int(m.group(1)) for p in self.jobs_dir.iterdir() if (m := re.match(r"^(\d{4})-", p.name))]
        n = (max(nums) + 1) if nums else 1
        safe = re.sub(r"[^A-Za-z0-9_.-]+", "_", name)[:60]
        d = self.jobs_dir / f"{n:04d}-{safe}"
        d.mkdir(parents=True, exist_ok=False)
        return d

    def create(self, name: str, job_type: str, *, motor_file: Path, motor_dir: Path, n_rows: int, export: bool = False, time_base_s: float = 0.01, wait_hint_s: float | None = None, extra: dict | None = None) -> Job:
        d = self._next_dir(name)
        spec = {
            "name": name,
            "type": job_type,
            "cdx1": "input.CDX1",
            "result_cdx1": "result.CDX1",
            "export_csv": "export.csv" if export else None,
            "time_base_s": time_base_s,
            "motor_file": str(Path(motor_file).resolve().relative_to(self.repo_root.resolve())).replace("\\", "/"),
            "motor_dir": str(Path(motor_dir).resolve().relative_to(self.repo_root.resolve())).replace("\\", "/"),
            "n_rows": n_rows,
            "wait_hint_s": wait_hint_s,
            "created": time.strftime("%Y-%m-%dT%H:%M:%S"),
        }
        spec.update(extra or {})
        return Job(d, spec)

    def submit(self, job: Job) -> Job:
        motor = self.repo_root / job.spec["motor_file"]
        job.spec["motor_hash"] = hashlib.md5(motor.read_bytes()).hexdigest() if motor.exists() else None  # the worker re-selects the motor file only when this changes
        if self.transport == "agent":
            self._push_job(job)
            (job.dir / "pushed").write_text(time.strftime("%Y-%m-%dT%H:%M:%S"))  # GUI: not an orphan
        # write job.json last so the worker never sees a half-written job
        (job.dir / "job.json").write_text(json.dumps(job.spec, indent=2))
        if self.mode == "manual":
            self._print_manual_instructions(job)
        else:
            self.log(f"  submitted {job.dir.name} ({job.spec['type']}, {job.spec['n_rows']} rows, {self.transport}) - waiting for the VM worker")
        return job

    def _push_job(self, job: Job) -> None:
        """agent transport: inputs into C:\\rpa\\jobs\\<name> (job.json last)."""
        gd = self.guest_dir(job)
        self.agent.mkdir(f"{self.guest_root}\\jobs", gd, f"{gd}\\motors")
        spec = dict(job.spec)
        motor = self.repo_root / job.spec["motor_file"]
        spec["transport"] = "agent"
        spec["motor_file"] = f"motors/{motor.name}"
        spec["motor_dir"] = "motors"
        deadline = time.time() + 20
        while True:  # the mkdir above is asynchronous
            try:
                self.agent.push(job.input_cdx1, f"{gd}\\{job.spec['cdx1']}")
                break
            except OSError:
                if time.time() > deadline:
                    raise
                time.sleep(1.0)
        if motor.exists():
            self.agent.push(motor, f"{gd}\\motors\\{motor.name}")
        self.agent.push(json.dumps(spec, indent=2).encode(), f"{gd}\\job.json")

    def wait(self, job: Job) -> dict:
        t0 = time.time()
        last_msg = 0.0
        while True:
            if self.transport == "agent" and not job.done_file.exists():
                self._pull_if_done(job)
            if job.done_file.exists():
                try:
                    status = json.loads(job.done_file.read_text())
                except json.JSONDecodeError:
                    time.sleep(0.5)
                    continue
                if status.get("status") != "ok":
                    raise RuntimeError(f"worker reported failure for {job.dir.name}: {status.get('message')} (see {job.dir / 'worker.log'})")
                return status
            if self.mode == "manual" and self._manual_outputs_ready(job):
                return {"status": "ok", "message": "manual"}
            if time.time() - t0 > self.timeout_s:
                raise TimeoutError(f"no result for {job.dir.name} after {self.timeout_s:.0f}s (is the worker running in the VM? jobs dir: {self.jobs_dir})")
            if time.time() - last_msg > 60:
                self.log(f"  ... still waiting on {job.dir.name} ({time.time() - t0:.0f}s)")
                last_msg = time.time()
            time.sleep(self.poll_s)

    def _pull_if_done(self, job: Job) -> bool:
        """agent transport: when the worker has written done.zip, unpack it
        into the local job folder (done.json comes out of the zip last)."""
        gd = self.guest_dir(job)
        blob = self.agent.pull(f"{gd}\\done.zip", timeout=120)
        if not blob:
            return False
        try:
            zf = zipfile.ZipFile(io.BytesIO(blob))
            names = zf.namelist()
        except zipfile.BadZipFile:
            return False  # still being written
        for n in names:
            if n == "done.json" or "/" in n or "\\" in n:
                continue
            (job.dir / n).write_bytes(zf.read(n))
        if "done.json" in names:
            (job.dir / "done.json").write_bytes(zf.read("done.json"))
        return True

    def _manual_outputs_ready(self, job: Job) -> bool:
        if not job.result_cdx1.exists():
            return False
        if not all(_file_settled(p) for p in job.export_csvs):
            return False
        return _file_settled(job.result_cdx1)

    def _print_manual_instructions(self, job: Job):
        vm = job.dir.relative_to(self.repo_root)
        exports = job.export_csvs
        if len(exports) == 1:
            step4 = f"    4. Row 1: View Data > File > Export (0.01 s) -> save as {exports[0].name} in the same folder\n"
        elif exports:
            step4 = f"    4. Every row i (1-{len(exports)}): View Data > File > Export (0.01 s) -> save as {exports[0].name} .. {exports[-1].name} in the same folder\n"
        else:
            step4 = ""
        self.log(
            "\n  MANUAL STEP in RASAero II (VM path Z:\\" + str(vm).replace("/", "\\") + "):\n"
            f"    1. File > Select Motor File: Z:\\{job.spec['motor_file'].replace('/', chr(92))}\n"
            f"    2. File > Open: input.CDX1 from the folder above\n"
            "    3. Flight Simulation > Simulations > Rerun All Simulations\n"
            + step4
            + "    5. File > Save As -> result.CDX1 in the same folder\n"
            "  (this program continues automatically once the files appear)"
        )


def _file_settled(p: Path, quiet_s: float = 2.0) -> bool:
    try:
        st = p.stat()
    except FileNotFoundError:
        return False
    return st.st_size > 0 and (time.time() - st.st_mtime) > quiet_s
