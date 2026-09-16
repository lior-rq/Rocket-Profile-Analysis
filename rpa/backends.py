"""Simulation backends: the Python integrator on RASAero aero tables (what
the search runs on), RASAero II itself via the VM worker (table exports and
final confirmation) and OpenRocket headless (preview)."""

from __future__ import annotations

import json
import shutil
from pathlib import Path

import pandas as pd

from . import cdx1
from . import history as H
from .jobs import EXPORT, EXPORT_BATCH, RERUN_SAVE, JobClient
from .models import SimRow


class ExportRowMismatch(RuntimeError):
    """A View Data export is not the flight it was taken for (RASAero exports
    the grid row that is selected, so a mis-selected row hands back another
    flight's history)."""


def export_mismatch(row: SimRow, h: pd.DataFrame, weight_tol_lb: float = 0.1, apogee_tol_pct: float = 1.0) -> str | None:
    """Why `h` cannot be `row`'s flight, or None. Checks the two numbers the
    export shares with the row: liftoff weight (from the CDX1 we wrote) and
    apogee (from result.CDX1). Both MUST already be on the same altitude
    reference, i.e. called after _apply_offset."""
    w0 = float(h["weight_lb"].iloc[0])
    if abs(w0 - row.combined_wt_lb) > weight_tol_lb:
        return f"export lifts off at {w0:.3f} lb, the row flew {row.combined_wt_lb:.3f} lb"
    if row.max_alt_ft:
        ap = H.apogee(h)[0]
        if abs(ap - row.max_alt_ft) > apogee_tol_pct / 100.0 * row.max_alt_ft:
            return f"export apogees at {ap:.0f} ft, RASAero reported {row.max_alt_ft:.0f} ft for the row"
    return None


class SimBackend:
    name = "base"

    def run_batch(self, rows: list[SimRow], name: str) -> None:
        """Fill max_alt_ft / max_vel_fps / t_apogee_s on each row in place."""
        raise NotImplementedError

    def export(self, row: SimRow, name: str) -> pd.DataFrame:
        """Full time history for one row (normalized columns, see history.py)."""
        raise NotImplementedError

    def history(self, row: SimRow, name: str) -> pd.DataFrame:
        """Like export() but nothing has to land on disk (characterization
        runs hundreds of these); backends that can, skip the file."""
        return self.export(row, name)

    def histories(self, rows: list[SimRow], names: list[str]):
        """history() for many rows, yielded in order; backends with a pool
        overlap the flights. Frames are dropped as soon as they are consumed."""
        for row, name in zip(rows, names, strict=True):
            yield self.history(row, name)


class RASAeroBackend(SimBackend):
    name = "rasaero"

    def __init__(self, cfg, template_tree, motor_file: Path, motor_dir: Path, jobs: JobClient, log=print):
        self.cfg = cfg
        self.template = template_tree
        self.motor_file = motor_file
        self.motor_dir = motor_dir
        self.jobs = jobs
        self.log = log
        self.rows_per_batch = int(cfg["rasaero"]["rows_per_batch"])
        self.site = {k: v for k, v in cfg["launch_site"].items() if v is not None}
        self.surface = cfg["surface_finish"]
        self.max_retries = int(cfg["worker"]["max_retries"])
        self.history_dir = cfg.output_dir / "histories"
        self.history_dir.mkdir(parents=True, exist_ok=True)
        # RASAero altitudes may be MSL or AGL; detected from the first export
        # (altitude at t=0) and remembered across runs.
        self._offset_file = cfg.output_dir / "rasaero_altitude_offset.json"
        ref = cfg["rasaero"].get("altitude_reference", "auto")
        self.alt_offset_ft: float | None = 0.0 if ref == "agl" else None
        if ref == "msl":
            self.alt_offset_ft = float(self.site.get("altitude_ft") or cdx1.launch_site(template_tree).get("altitude_ft") or 0.0)
        if self.alt_offset_ft is None and self._offset_file.exists():
            self.alt_offset_ft = float(json.loads(self._offset_file.read_text())["offset_ft"])

    def _apply_offset(self, rows):
        if self.alt_offset_ft:
            for r in rows:
                if r.max_alt_ft is not None:
                    r.max_alt_ft -= self.alt_offset_ft

    def _write(self, rows, path):
        cdx1.write_batch(self.template, rows, path, launch_site_overrides=self.site, surface=self.surface)

    def run_batch(self, rows: list[SimRow], name: str) -> None:
        chunks = [rows[i : i + self.rows_per_batch] for i in range(0, len(rows), self.rows_per_batch)]
        for ci, chunk in enumerate(chunks):
            pending = chunk
            for attempt in range(self.max_retries + 1):
                job = self.jobs.create(f"{name}-p{ci + 1}" + (f"-retry{attempt}" if attempt else ""), RERUN_SAVE, motor_file=self.motor_file, motor_dir=self.motor_dir, n_rows=len(pending), wait_hint_s=None if attempt == 0 else 2.0 ** attempt)
                self._write(pending, job.input_cdx1)
                self.jobs.submit(job)
                self.jobs.wait(job)
                problems = cdx1.merge_results(pending, cdx1.read_results(job.result_cdx1))
                self._apply_offset([r for r in pending if r.max_alt_ft is not None])
                if not problems:
                    break
                self.log(f"  {len(problems)} problem(s) in {job.dir.name}: " + "; ".join(problems[:3]) + (" ..." if len(problems) > 3 else ""))
                pending = [r for r in pending if r.max_alt_ft is None]
                if not pending:
                    break
                if attempt == self.max_retries:
                    raise RuntimeError(f"{len(pending)} row(s) still have no result after {attempt + 1} attempts; first: {pending[0].tag}. If every row is empty RASAero probably did not find the motor names - check <Booster1Engine> strings vs the names RASAero shows.")

    def _finish_export(self, name: str, export_csv: Path) -> pd.DataFrame:
        """Read one flight's View Data export, detect/apply the altitude
        reference offset (once, cached to disk) and keep a copy under
        output/histories/. Shared by export() and export_batch()."""
        h = H.read_rasaero_export(export_csv)
        if self.alt_offset_ft is None:
            a0 = float(h["altitude_ft"].iloc[0])
            self.alt_offset_ft = a0 if a0 > 50.0 else 0.0
            self._offset_file.write_text(json.dumps({"offset_ft": self.alt_offset_ft, "detected_from": name}))
            self.log(f"  RASAero altitude reference: {'MSL (subtracting %.0f ft)' % a0 if self.alt_offset_ft else 'AGL'}")
        if self.alt_offset_ft:
            h["altitude_ft"] = h["altitude_ft"] - self.alt_offset_ft
        keep = self.history_dir / (safe_name(name) + ".csv")
        shutil.copy2(export_csv, keep)
        return h

    def export(self, row: SimRow, name: str) -> pd.DataFrame:
        job = self.jobs.create(name, EXPORT, motor_file=self.motor_file, motor_dir=self.motor_dir, n_rows=1, export=True, time_base_s=float(self.cfg["rasaero"]["export_time_base_s"]))
        self._write([row], job.input_cdx1)
        self.jobs.submit(job)
        self.jobs.wait(job)
        if not job.export_csv.exists():
            raise RuntimeError(f"worker finished {job.dir.name} but {job.export_csv.name} is missing")
        h = self._finish_export(name, job.export_csv)
        problems = cdx1.merge_results([row], cdx1.read_results(job.result_cdx1)) if job.result_cdx1.exists() else ["no result.CDX1"]
        self._apply_offset([row] if not problems else [])
        if problems:
            # fall back to the history itself for the summary numbers
            row.max_alt_ft, row.t_apogee_s = H.apogee(h)
            row.max_vel_fps = float(h["velocity_fps"].max())
        why = export_mismatch(row, h)
        if why:
            raise ExportRowMismatch(f"{name}: {why}")
        return h

    def export_batch(self, rows: list[SimRow], names: list[str]) -> list[pd.DataFrame | None]:
        """All `rows` as one Flight Simulation batch (one Rerun All, one
        RASAero session) with a per-row View Data export - one job's worth of
        start/open/save overhead instead of one job per flight. Opt-in
        (worker.batch_reference_export): a new worker job type, needs a live
        check on the VM before it replaces the per-row path by default."""
        csv_names = [f"row{i:02d}.csv" for i in range(len(rows))]
        job = self.jobs.create("reference-batch", EXPORT_BATCH, motor_file=self.motor_file, motor_dir=self.motor_dir, n_rows=len(rows), time_base_s=float(self.cfg["rasaero"]["export_time_base_s"]), extra={"export_csvs": csv_names})
        self._write(rows, job.input_cdx1)
        self.jobs.submit(job)
        self.jobs.wait(job)
        problems = cdx1.merge_results(rows, cdx1.read_results(job.result_cdx1)) if job.result_cdx1.exists() else [f"row {i}: no result.CDX1" for i in range(len(rows))]
        if problems:
            self.log(f"  {len(problems)} problem(s) in {job.dir.name}: " + "; ".join(problems[:3]) + (" ..." if len(problems) > 3 else ""))
        # histories first: the first export detects the altitude offset
        histories: list[pd.DataFrame | None] = []
        for name, csv_name in zip(names, csv_names, strict=True):
            src = job.dir / csv_name
            if not src.exists():
                self.log(f"  {name}: no export - RASAero may not have recognised the motor names")
                histories.append(None)
                continue
            histories.append(self._finish_export(name, src))
        self._apply_offset([r for r in rows if r.max_alt_ft is not None])
        for row, h in zip(rows, histories, strict=True):
            if h is not None and row.max_alt_ft is None:  # result.CDX1 entry did not merge cleanly
                row.max_alt_ft, row.t_apogee_s = H.apogee(h)
                row.max_vel_fps = float(h["velocity_fps"].max())
        # every export MUST be its own row's flight: one mis-selected grid
        # row turns the whole batch into copies of one flight
        bad = [f"{name}: {why}" for row, name, h in zip(rows, names, histories, strict=True) if h is not None and (why := export_mismatch(row, h))]
        if bad:
            raise ExportRowMismatch(f"{len(bad)} of {len(rows)} batched exports are not the flight they were taken for ({bad[0]}" + (f"; +{len(bad) - 1} more)" if len(bad) > 1 else ")"))
        return histories


class OpenRocketBackend(SimBackend):
    """Runs the same pipeline through OpenRocket's own 6-DOF simulator. Aero
    (especially transonic/supersonic drag) differs from RASAero, so treat the
    numbers as a preview."""

    name = "openrocket"

    def __init__(self, cfg, openrocket, motorset, log=print):
        self.cfg = cfg
        self.orr = openrocket
        self.ms = motorset
        self.log = log
        self.site = dict(cfg["launch_site"])
        self.history_dir = cfg.output_dir / "histories"
        self.history_dir.mkdir(parents=True, exist_ok=True)

    def set_site_defaults(self, site: dict):
        for k, v in site.items():
            if self.site.get(k) is None:
                self.site[k] = v

    def _sim(self, row: SimRow):
        s, h = self.orr.simulate(self.ms.sustainer_by_label(row.sustainer), self.ms.booster(row.booster), row.sep_delay_s, row.ign_delay_s, self.site)
        row.max_alt_ft = round(s["max_alt_ft"], 1)
        row.max_vel_fps = round(s["max_vel_fps"], 1)
        row.t_apogee_s = round(s["t_apogee_s"], 2)
        return h

    def run_batch(self, rows: list[SimRow], name: str) -> None:
        self.log(f"  [openrocket] {name}: simulating {len(rows)} rows")
        for i, r in enumerate(rows):
            self._sim(r)
            if (i + 1) % 25 == 0:
                self.log(f"    {i + 1}/{len(rows)}")

    def export(self, row: SimRow, name: str) -> pd.DataFrame:
        h = self._sim(row)
        h.to_csv(self.history_dir / (safe_name(name) + ".csv"), index=False)
        return h


# ---- run_batch pool workers (module level: must pickle by name) ----
_POOL_BACKEND = None


def _pool_init(cfg, motorset, site, ref_diameter_in):
    global _POOL_BACKEND
    _POOL_BACKEND = PythonBackend(cfg, motorset, site, ref_diameter_in, log=lambda *_: None, workers=1)


def _pool_sim(rows: list[SimRow]) -> list[tuple[float, float, float]]:
    out = []
    for r in rows:
        s, _ = _POOL_BACKEND.sim.run(_POOL_BACKEND.vehicle(r), r.sep_delay_s, r.ign_delay_s, history=False)
        out.append((s["max_alt_ft"], s["max_vel_fps"], s["t_apogee_s"]))
    return out


class PythonBackend(SimBackend):
    """rpa.flightsim on RASAero aero tables: tens of milliseconds per flight,
    no VM. Batches are spread over the CPU cores (python_sim.workers)."""

    name = "python"

    def __init__(self, cfg, motorset, site: dict, ref_diameter_in: float, log=print, workers: int | str | None = None):
        import os

        from .aero import AeroSet
        from .flightsim import FlightSim

        self.cfg = cfg
        self.ms = motorset
        self.site = site
        self.log = log
        ps = cfg["python_sim"]
        w = ps.get("workers", "auto") if workers is None else workers
        self.workers = max(1, (os.cpu_count() or 2) - 1) if w in (None, "auto") else max(1, int(w))
        self._pool = None
        self.aero = AeroSet.load(cfg.path("aero_dir"))
        model = str(ps.get("density_model", "auto"))
        calibration = None
        cal_file = cfg.path("reference_dir") / "density_calibration.csv"
        if model in ("auto", "calibrated") and cal_file.exists():
            tab = pd.read_csv(cal_file)
            calibration = (tab["altitude_ft"].to_numpy(float), tab["density_slug_ft3"].to_numpy(float))
            model = "calibrated"
            log(f"  [python] density profile calibrated from RASAero exports ({cal_file.name}, {len(tab)} bins to {tab['altitude_ft'].max():.0f} ft)")
        elif model == "auto":
            model = "rasaero"
        self.sim = FlightSim(self.aero, site, pressure_is_sea_level=bool(ps["pressure_is_sea_level"]), dt=float(ps["dt_s"]), max_time_s=float(ps["max_time_s"]), density_model=model, density_exponent=float(ps.get("density_exponent", 5.05)), calibration=calibration)
        self.ref_diameter_in = float(ref_diameter_in)
        self.history_dir = cfg.output_dir / "histories"
        self.history_dir.mkdir(parents=True, exist_ok=True)

    def vehicle(self, row: SimRow):
        from .flightsim import Vehicle

        return Vehicle(self.ms.booster(row.booster), self.ms.sustainer_by_label(row.sustainer), row.combined_wt_lb, row.sustainer_wt_lb, self.ref_diameter_in, row.booster_nozzle_in, row.sustainer_nozzle_in)

    def _sim(self, row: SimRow, history: bool = True):
        from .pipeline import check_cancel

        check_cancel()
        s, h = self.sim.run(self.vehicle(row), row.sep_delay_s, row.ign_delay_s, history=history)
        row.max_alt_ft = round(s["max_alt_ft"], 1)
        row.max_vel_fps = round(s["max_vel_fps"], 1)
        row.t_apogee_s = round(s["t_apogee_s"], 2)
        return h

    def _get_pool(self):
        if self._pool is None:
            import multiprocessing
            from concurrent.futures import ProcessPoolExecutor

            self._pool = ProcessPoolExecutor(max_workers=self.workers, mp_context=multiprocessing.get_context("spawn"), initializer=_pool_init, initargs=(self.cfg, self.ms, self.site, self.ref_diameter_in))
        return self._pool

    def close(self):
        if self._pool is not None:
            self._pool.shutdown(wait=False, cancel_futures=True)
            self._pool = None

    def run_batch(self, rows: list[SimRow], name: str) -> None:
        n = len(rows)
        if self.workers > 1 and n >= 4 * self.workers:
            try:
                self._run_batch_parallel(rows, name)
                return
            except Exception as e:  # noqa: BLE001 - a pool problem must not kill the search
                self.log(f"  [python] process pool failed ({type(e).__name__}: {e}); running {name} serially")
                self.close()
        every = max(1, n // 10)
        for i, r in enumerate(rows):
            self._sim(r, history=False)
            if n >= 40 and ((i + 1) % every == 0 or i + 1 == n):
                self.log(f"  [{i + 1}/{n}] {name}")

    def _run_batch_parallel(self, rows: list[SimRow], name: str) -> None:
        from concurrent.futures import as_completed

        n = len(rows)
        chunk = max(1, min(25, n // (self.workers * 4)))
        chunks = [rows[i : i + chunk] for i in range(0, n, chunk)]
        pool = self._get_pool()
        futures = {pool.submit(_pool_sim, c): c for c in chunks}
        done = 0
        every = max(1, n // 10)
        next_mark = every
        # generous: flight ~0.05s, cold start ~10s; a stuck pool falls back to serial
        from .pipeline import check_cancel

        for fut in as_completed(futures, timeout=120.0 + 2.0 * n / self.workers):
            check_cancel()
            rows_chunk = futures[fut]
            for r, (alt, vel, t_ap) in zip(rows_chunk, fut.result(), strict=True):
                r.max_alt_ft, r.max_vel_fps, r.t_apogee_s = round(alt, 1), round(vel, 1), round(t_ap, 2)
            done += len(rows_chunk)
            if n >= 40 and (done >= next_mark or done == n):
                self.log(f"  [{done}/{n}] {name} ({self.workers} workers)")
                while next_mark <= done:
                    next_mark += every

    def export(self, row: SimRow, name: str) -> pd.DataFrame:
        h = self._sim(row)
        h.to_csv(self.history_dir / (safe_name(name) + ".csv"), index=False)
        return h

    def history(self, row: SimRow, name: str) -> pd.DataFrame:
        return self._sim(row)


def safe_name(s: str) -> str:
    """History file stem; '+' joins a booster and a sustainer label."""
    return "".join(c if c.isalnum() or c in "-_.+" else "_" for c in s)
