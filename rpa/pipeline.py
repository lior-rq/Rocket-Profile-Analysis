"""Pipeline stages. Each reads/writes files under output/ so a run can be
resumed or a single stage re-done."""

from __future__ import annotations

import json
import math
import threading
from dataclasses import fields
from pathlib import Path

import pandas as pd

from . import cdx1, manifest
from . import history as H
from .backends import OpenRocketBackend, PythonBackend, RASAeroBackend, SimBackend
from .jobs import AERO_EXPORT, INSPECT, JobClient
from .models import SUBSONIC, SUPERSONIC, Characterization, Design, MassRow, ProfileEligibility, SimRow
from .motors import MotorSet, load_motor_set, motor_table, pick_spanning, stage_motor_files, staged_motors, staged_motors_current
from .openrocket import KG_TO_LB, OpenRocket
from .profiles import DECEL_SUBSONIC, characterize, eligibility
from .search import ApogeeSearch, make_row

G_FPS2 = 32.174

# ---- log routing + cooperative cancel (the in-process service runs stages
# in threads; the CLI keeps printing) -----------------------------------------
_SINKS: dict[int, object] = {}
_MAIN: dict = {"sink": None, "cancel": None}
_CANCELS: dict[int, threading.Event] = {}


class Cancelled(Exception):
    """The run was cancelled between two flights."""


def current_sink():
    return _SINKS.get(threading.get_ident()) or _MAIN["sink"]


def set_log_sink(fn, main: bool = False) -> None:
    _SINKS[threading.get_ident()] = fn
    if main:
        _MAIN["sink"] = fn


def clear_log_sink(main: bool = False) -> None:
    _SINKS.pop(threading.get_ident(), None)
    if main:
        _MAIN["sink"] = None


def set_cancel(event, main: bool = False) -> None:
    if event is None:
        _CANCELS.pop(threading.get_ident(), None)
    else:
        _CANCELS[threading.get_ident()] = event
    if main:
        _MAIN["cancel"] = event


def check_cancel() -> None:
    ev = _CANCELS.get(threading.get_ident()) or _MAIN["cancel"]
    if ev is not None and ev.is_set():
        raise Cancelled()


def log(msg: str):
    sink = current_sink()
    if sink is not None:
        sink(msg)
    else:
        print(msg, flush=True)


def progress(done: int, total: int, what: str) -> None:
    """Batch progress in the line format the runners parse."""
    log(f"  [{done}/{total}] {what}")


class Pipeline:
    def __init__(self, cfg):
        self.cfg = cfg
        self.out = cfg.output_dir
        self._or: OpenRocket | None = None
        self._ms: MotorSet | None = None
        self._backend: SimBackend | None = None
        self._template = None

    # ---- shared objects ----------------------------------------------------
    def ric_converter(self, allow_simulate: bool = True):
        from .ric import RicConverter

        r = self.cfg.get("ric") or {}
        return RicConverter(self.out / "motors" / "ric_cache", r.get("openmotor", "auto"), r.get("timestep_s", 0.002), root=self.cfg.root, log=log, allow_simulate=allow_simulate)

    @property
    def ms(self) -> MotorSet:
        if self._ms is None:
            self._ms = load_motor_set(self.cfg.motor_sources("boosters"), self.cfg.motor_sources("sustainers"), ric=self.ric_converter(), exclude_boosters=self.cfg.excluded("boosters"), exclude_sustainers=self.cfg.excluded("sustainers"))
        return self._ms

    @property
    def template(self):
        if self._template is None:
            self._template = cdx1.load(self.cfg.path("cdx1"))
        return self._template

    # ---- which sustainers the optimizer flies -------------------------------
    @property
    def sustainers(self) -> list:
        """The sustainer motors every booster is paired with, per config.yaml
        `sustainer_selection` (cached in output/sustainers_selected.json)."""
        if getattr(self, "_sustainers", None) is None:
            self._sustainers = [self.ms.sustainer_by_label(x) for x in self.load_sustainer_selection()["selected"]]
        return self._sustainers

    def _sustainer_selection_key(self) -> dict:
        sel = self.cfg["sustainer_selection"]
        c = self.cfg["characterization"]
        count = sel.get("count")
        count = 5 if count in (None, "") else int(count)
        if count < 1:
            raise ValueError(f"sustainer_selection.count must be >= 1, not {count}")
        return {"mode": str(sel.get("mode", "best")), "count": count, "labels": list(sel.get("labels") or []), "candidates": sorted(m.label for m in self.ms.sustainer_candidates), "delays": [float(c["separation_delay_s"]), float(c["ignition_delay_s"])], "hardware_mass_lb": self.cfg.hardware_mass_lb()}

    def load_sustainer_selection(self) -> dict:
        p = self.out / "sustainers_selected.json"
        key = self._sustainer_selection_key()
        if p.exists():
            try:
                d = json.loads(p.read_text())
                if d.get("key") == key:
                    return d
                log("sustainers: config or candidates changed since the last selection - reselecting")
            except (OSError, ValueError):
                pass
        return self.select_sustainers()

    def select_sustainers(self) -> dict:
        """Pick the sustainers to search and write output/sustainers_selected.json.
        `span` flies one reference booster (median impulse, characterization
        delays) under every candidate on the python backend and keeps the
        candidates at the min / max / evenly spaced apogee."""
        ms = self.ms
        key = self._sustainer_selection_key()
        mode, k = key["mode"], key["count"]
        cands = ms.sustainer_candidates
        sweep = None
        ref_booster = None
        if mode == "best" or len(cands) <= 1:
            chosen = [ms.sustainer]
        elif mode == "list":
            chosen = [ms.sustainer_by_label(x) for x in key["labels"]]
            if not chosen:
                raise ValueError("sustainer_selection.mode is 'list' but sustainer_selection.labels is empty")
        elif mode == "span":
            sweep, ref_booster = self._sustainer_sweep()
            chosen = [ms.sustainer_by_label(r["label"]) for r in pick_spanning(sweep, k)]
        else:
            raise ValueError(f"sustainer_selection.mode must be best | span | list, not {mode!r}")
        if len(chosen) > 1 and self.cfg["mass_model"]["method"] == "manual":
            raise ValueError("mass_model.method: manual has one sustainer weight; set sustainer_selection.mode: best (or list one label)")
        d = {"key": key, "selected": [m.label for m in chosen], "reference_booster": ref_booster, "sweep": sweep, "motors": [{"label": m.label, "designation": m.designation, "total_impulse_ns": round(m.total_impulse_ns, 1), "burn_time_s": round(m.burn_time_s, 2), "avg_thrust_n": round(m.avg_thrust_n, 1), "nozzle_exit_in": m.nozzle_exit_in, "prop_mass_kg": m.prop_mass_kg} for m in chosen]}
        (self.out / "sustainers_selected.json").write_text(json.dumps(d, indent=1))
        self._sustainers = None
        if sweep:
            lo, hi = sweep[0], sweep[-1]
            log(f"sustainers: {mode} -> {len(chosen)} of {len(cands)} (reference booster {ref_booster}: apogee {lo['apogee_ft']:.0f} ft with {lo['label']} .. {hi['apogee_ft']:.0f} ft with {hi['label']}, {100 * (hi['apogee_ft'] - lo['apogee_ft']) / lo['apogee_ft']:.1f}% spread)")
            for m in d["motors"]:
                a = next(r["apogee_ft"] for r in sweep if r["label"] == m["label"])
                log(f"  {m['label']}: {m['total_impulse_ns']:.0f} N·s, burn {m['burn_time_s']:.1f} s, nozzle {m['nozzle_exit_in']} in -> {a:.0f} ft")
        else:
            log(f"sustainers: {mode} -> {', '.join(m.label for m in chosen)}")
        return d

    def _sustainer_sweep(self) -> tuple[list[dict], str]:
        """Apogee of one reference booster under every sustainer candidate,
        sorted ascending. Python backend only: needs the aero tables."""
        ms = self.ms
        if self.cfg["mass_model"]["method"] != "openrocket":
            raise ValueError("sustainer_selection.mode 'span' needs mass_model.method: openrocket (the manual mass model has one sustainer weight)")
        try:
            be = PythonBackend(self.cfg, ms, self.site, self.ref_diameter_in, log=lambda *_: None, workers=1)
        except (FileNotFoundError, ValueError) as e:
            raise RuntimeError(f"sustainer_selection.mode 'span' flies the candidates on the python backend and needs the aero tables (`rpa aero`): {e}") from e
        ref = sorted(ms.boosters, key=lambda b: b.total_impulse_ns)[len(ms.boosters) // 2]
        c = self.cfg["characterization"]
        mass = self.load_mass()
        # the same rows the search flies (nozzle overrides, mass model)
        rows = [make_row(ref.label, None, c["separation_delay_s"], c["ignition_delay_s"], ms, mass[(ref.label, s.label)], self.cfg) for s in ms.sustainer_candidates]
        be.run_batch(rows, "sustainer-sweep")
        out = [{"label": s.label, "apogee_ft": r.max_alt_ft, "max_vel_fps": r.max_vel_fps, "total_impulse_ns": round(s.total_impulse_ns, 1), "burn_time_s": round(s.burn_time_s, 2), "nozzle_exit_in": s.nozzle_exit_in} for s, r in zip(ms.sustainer_candidates, rows, strict=True)]
        out.sort(key=lambda r: r["apogee_ft"])
        return out, ref.label

    @property
    def site(self) -> dict:
        """Launch site actually used: CDX1 values with config overrides."""
        s = cdx1.launch_site(self.template)
        s.update({k: v for k, v in self.cfg["launch_site"].items() if v is not None})
        return s

    @property
    def ref_diameter_in(self) -> float:
        v = self.cfg["python_sim"].get("ref_diameter_in")
        return float(v) if v else cdx1.reference_diameter_in(self.template)

    def openrocket(self) -> OpenRocket:
        if self._or is None:
            jar, jvm = self.cfg.openrocket()
            if jar is None:
                raise FileNotFoundError("OpenRocket not found: install it, or set paths.openrocket_jar in config.yaml")
            self._or = OpenRocket(jar, jvm).__enter__()
            self._or.load_rocket(self.cfg.path("ork"))
            for w in self._or.warnings:
                log(f"  OpenRocket warning: {w}")
        return self._or

    def backend(self) -> SimBackend:
        if self._backend is None:
            motor_dir, motor_file = self.motor_paths()
            if self.cfg["backend"] == "openrocket":
                b = OpenRocketBackend(self.cfg, self.openrocket(), self.ms, log=log)
                b.set_site_defaults(self.site)
                self._backend = b
            elif self.cfg["backend"] == "python":
                b = PythonBackend(self.cfg, self.ms, self.site, self.ref_diameter_in, log=log)
                log(f"  [python] aero tables from {self.cfg.path('aero_dir')}:\n    " + b.aero.describe().replace("\n", "\n    "))
                self._backend = b
            elif self.cfg["backend"] == "rasaero_native":
                self._backend = self.native_backend()
            else:
                self._backend = RASAeroBackend(self.cfg, self.template, motor_file, motor_dir, self.jobs(), log=log)
        return self._backend

    def rasaero_engine(self) -> str:
        """'native' or 'vm': where RASAero itself runs (rasaero.engine)."""
        from .native import engine_status

        want = str(self.cfg["rasaero"].get("engine", "auto"))
        if want == "vm":
            return "vm"
        st = engine_status(self.cfg)
        if want == "native" and not st["ok"]:
            raise FileNotFoundError("rasaero.engine is 'native' but " + st["detail"])
        return "native" if st["ok"] else "vm"

    def native_backend(self, motor_files=None, log=log):
        """RASAero's engine in a child process, flying this CDX1 with the
        staged motor set (or `motor_files`)."""
        from .native import NativeRASAeroBackend, shared_backend

        if motor_files is None:
            _, motor_file = self.motor_paths()
            motor_files = [motor_file]
        if self.cfg["native"].get("shared", True):
            return shared_backend(self.cfg, self.cfg.path("cdx1"), motor_files, self.site, self.cfg["surface_finish"], log=log)
        return NativeRASAeroBackend(self.cfg, self.cfg.path("cdx1"), motor_files, self.site, self.cfg["surface_finish"], log=log)

    def rasaero_backend(self, log=log):
        """The backend that runs RASAero for references and confirm: native
        when available, else the VM worker."""
        if self.rasaero_engine() == "native":
            return self.native_backend(log=log)
        motor_dir, motor_file = self.motor_paths()
        return RASAeroBackend(self.cfg, self.template, motor_file, motor_dir, self.jobs(), log=log)

    def close(self):
        """Release the python backend's worker processes (no-op otherwise)."""
        be = self._backend
        if be is not None and hasattr(be, "close"):
            be.close()

    def jobs(self) -> JobClient:
        """The job client for the VM worker, with the configured transport."""
        if getattr(self, "_jobs", None) is None:
            w = self.cfg["worker"]
            transport = str(w.get("transport", "auto"))
            agent = None
            if transport in ("auto", "agent") and w["mode"] == "auto":
                from .vmagent import GuestAgent

                vm = self.cfg.get("vm") or {}
                cand = GuestAgent(vm.get("name", "Windows"), vm.get("utmctl", "auto"))
                if cand.available and (transport == "agent" or cand.status(0) is not None):
                    agent, transport = cand, "agent"
                elif transport == "agent":
                    raise RuntimeError("worker.transport is 'agent' but utmctl / the VM was not found (config vm.name / vm.utmctl)")
                else:
                    transport = "share"
            elif transport == "auto":
                transport = "share"
            self._jobs = JobClient(self.cfg.path("jobs_dir"), self.cfg.root, mode=w["mode"], poll_s=w["poll_s"], timeout_s=w["timeout_s"], log=log, transport=transport, agent=agent, guest_root=(self.cfg.get("vm") or {}).get("guest_root") or r"C:\rpa")
            if w["mode"] == "auto":
                log(f"  VM jobs via the {self._jobs.transport} transport" + (f" (UTM '{agent.vm}', jobs in {self._jobs.guest_root}\\jobs)" if agent else " (Z: share)"))
        return self._jobs

    def motor_paths(self) -> tuple[Path, Path]:
        d = self.out / "motors"
        f = d / "all_motors.eng"
        if not staged_motors_current(self.ms, d):
            if f.exists():
                log("motors: input motor set changed since the last staging - re-staging")
            self.stage_motors()
        return d, f

    # ---- VM GUI inspection (bring-up aid) ----------------------------------
    def inspect_rasaero(self, try_view_data: bool = True) -> Path:
        """Ask the VM worker to photograph RASAero's windows and menus and dump
        their control trees into a job folder, so the GUI automation can be
        mapped without touching the VM."""
        motor_dir, motor_file = self.motor_paths()
        jobs = self.jobs()
        job = jobs.create("inspect", INSPECT, motor_file=motor_file, motor_dir=motor_dir, n_rows=1, extra={"try_view_data": try_view_data})
        b0 = self.ms.boosters[0]
        cdx1.write_batch(self.template, [make_row(b0.label, None, 15.0, 15.0, self.ms, self.load_mass()[(b0.label, self.sustainers[0].label)], self.cfg)], job.input_cdx1, launch_site_overrides={k: v for k, v in self.cfg["launch_site"].items() if v is not None}, surface=self.cfg["surface_finish"])
        jobs.submit(job)
        try:
            jobs.wait(job)
        except RuntimeError as e:
            log(f"  inspection ended with an error (partial output is still useful): {e}")
        log(f"inspection output in {job.dir}: " + ", ".join(sorted(p.name for p in job.dir.iterdir())))
        return job.dir

    # ---- input check (python backend) --------------------------------------
    def check(self) -> list[str]:
        """Validate the input set up front. Returns the list of problems."""
        from .aero import STACK, SUSTAINER, AeroSet

        problems = []
        for key, what in (("ork", "OpenRocket model (.ork)"), ("cdx1", "RASAero model (.CDX1)")):
            f = self.cfg.file(key)
            if f is None:
                problems.append(f"no {what} selected (paths.{key})")
            elif not f.exists():
                problems.append(f"{what} not found: {f}")
        if not self.cfg.motor_sources("boosters"):
            problems.append("no booster motor files selected (paths.boosters)")
        if not self.cfg.motor_sources("sustainers"):
            problems.append("no sustainer motor files selected (paths.sustainers)")
        if problems:
            for pr in problems:
                log(f"  !! {pr}")
            return problems
        ms = self.ms
        sel = self.cfg["sustainer_selection"]
        log(f"check: {len(ms.boosters)} boosters, {len(ms.sustainer_candidates)} sustainer candidate(s) (selection: {sel.get('mode', 'best')}; max impulse {ms.sustainer.label}), CDX1 {self.cfg.path('cdx1').name}, ORK {self.cfg.path('ork').name}")
        for b in staged_motors(ms):
            if b.nozzle_exit_in is None and not (self.cfg["rasaero"]["booster_nozzle_in"] and self.cfg["rasaero"]["sustainer_nozzle_in"]):
                problems.append(f"{b.label}: no 'Throat x in, exit y in' comment in the .eng and no nozzle override in config.yaml")
        try:
            log(f"  reference diameter {self.ref_diameter_in:.3f} in; launch site {self.site}")
        except Exception as e:
            problems.append(f"CDX1: {e}")
        aero_dir = self.cfg.path("aero_dir")
        from .native import engine_status

        st = engine_status(self.cfg)
        log(f"  RASAero engine: {'native (' + str(st['engine']) + ')' if st['ok'] else 'VM (' + st['detail'] + ')'}")
        if self.cfg["backend"] == "rasaero_native" and not st["ok"]:
            problems.append("backend rasaero_native: " + st["detail"])
        if self.cfg["backend"] == "python":
            try:
                aero = AeroSet.load(aero_dir)
                log("  aero tables:\n    " + aero.describe().replace("\n", "\n    "))
                nozs = [b.nozzle_exit_in for b in ms.boosters if b.nozzle_exit_in]
                for noz in (min(nozs), max(nozs)) if nozs else (None,):
                    problems += aero.coverage_problems(STACK, noz, 2.5, 50000.0)
                snozs = [m.nozzle_exit_in for m in ms.sustainer_candidates if m.nozzle_exit_in]
                for noz in (min(snozs), max(snozs)) if snozs else (None,):
                    problems += aero.coverage_problems(SUSTAINER, noz, 3.0, 50000.0)
            except (FileNotFoundError, ValueError) as e:
                problems.append(f"aero tables: {e}")
            refs = [p for p in self.cfg.path("reference_dir").glob("*.json") if p.with_suffix(".csv").exists()] if self.cfg.path("reference_dir").exists() else []
            if not refs:
                problems.append(f"no RASAero reference cases in {self.cfg.path('reference_dir')} - the python backend is unvalidated for this vehicle (run `rpa reference` then `rpa validate`)")
            else:
                log(f"  {len(refs)} RASAero reference case(s)")
        for pr in problems:
            log(f"  !! {pr}")
        if not problems:
            log("  OK")
        return problems

    # ---- aero tables from RASAero's Aero Plots (VM worker) -----------------
    def _aero_cdx1(self, config: str, nozzle_in: float | None):
        """The template with the site, surface and one design-level nozzle
        set, for an Aero Plots export of `config` (stack | sustainer)."""
        import copy

        from .aero import STACK

        tree = copy.deepcopy(self.template)
        cdx1.apply_launch_site(tree, {k: v for k, v in self.cfg["launch_site"].items() if v is not None})
        cdx1.apply_surface(tree, self.cfg["surface_finish"])
        if nozzle_in is not None:
            cdx1.apply_nozzles(tree, nozzle_in if config != STACK else None, nozzle_in if config == STACK else None)
        return tree

    def aero_export(self, config: str, nozzle_in: float | None, altitude_ft: float | None, plot_range: str = "Mach 5", mach_alt: list | None = None, name: str | None = None) -> Path:
        """One Aero Plots CSV export. Writes a CDX1 with the design-level
        nozzle set, runs the job, copies the CSV into input/aero/ under the
        naming convention rpa.aero expects."""
        import shutil

        motor_dir, motor_file = self.motor_paths()
        jobs = self.jobs()
        alt = float(altitude_ft if altitude_ft is not None else (self.site.get("altitude_ft") or 0.0))
        fname = f"{config}_alt{alt:g}" + (f"_noz{nozzle_in:g}" if nozzle_in is not None else "") + ".csv"
        # opt-in: skip the Options->Mach-Alt dialog by writing the points into
        # the CDX1 up front (needs a live check that RASAero loads them on
        # File->Open - see config.yaml rasaero.mach_alt_via_cdx1)
        via_cdx1 = bool(mach_alt) and bool(self.cfg["rasaero"].get("mach_alt_via_cdx1"))
        job = jobs.create(name or f"aero-{fname[:-4]}", AERO_EXPORT, motor_file=motor_file, motor_dir=motor_dir, n_rows=1, export=True, extra={"config": config, "plot_range": plot_range, "mach_alt": None if via_cdx1 else mach_alt})
        tree = self._aero_cdx1(config, nozzle_in)
        if via_cdx1:
            cdx1.apply_mach_alt(tree, mach_alt)
        cdx1.save(tree, job.input_cdx1)
        jobs.submit(job)
        jobs.wait(job)
        if not job.export_csv.exists():
            raise RuntimeError(f"worker finished {job.dir.name} but {job.export_csv.name} is missing")
        dst = self.cfg.path("aero_dir") / fname
        dst.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(job.export_csv, dst)
        log(f"  aero table -> {dst}")
        return dst

    def aero_export_batch(self, config: str, nozzle_in: float | None, items: list[tuple[float, Path]], plot_range: str = "Mach 5", name: str | None = None) -> list[Path]:
        """Several Aero Plots tables that share a config+nozzle (one CDX1,
        one open document) across altitudes, in one worker job - opt-in
        (aero_tables.batch_altitudes), needs a live check on the VM before
        it replaces the per-table path by default."""
        import shutil

        motor_dir, motor_file = self.motor_paths()
        jobs = self.jobs()
        spec_items = [{"export_csv": f"table{i}.csv", "points": [[0, alt], [25, alt]]} for i, (alt, _dst) in enumerate(items)]
        job = jobs.create(name or f"aero-batch-{config}-noz{nozzle_in}", AERO_EXPORT, motor_file=motor_file, motor_dir=motor_dir, n_rows=1, export=False, extra={"config": config, "plot_range": plot_range, "mach_alt_items": spec_items})
        cdx1.save(self._aero_cdx1(config, nozzle_in), job.input_cdx1)
        jobs.submit(job)
        jobs.wait(job)
        made = []
        for item, (_alt, dst) in zip(spec_items, items, strict=True):
            src = job.dir / item["export_csv"]
            if not src.exists():
                raise RuntimeError(f"worker finished {job.dir.name} but {item['export_csv']} is missing")
            dst.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(src, dst)
            log(f"  aero table -> {dst}")
            made.append(dst)
        return made

    def aero_plan(self) -> list[tuple[str, float | None, float, Path]]:
        """The (config, nozzle, altitude, file) tables `rpa aero` exports for
        this motor set, per config.yaml `aero_tables`."""
        from .aero import STACK, SUSTAINER

        a = self.cfg["aero_tables"]
        ms = self.ms
        bn = sorted({b.nozzle_exit_in for b in ms.boosters if b.nozzle_exit_in})
        sn = sorted({m.nozzle_exit_in for m in ms.sustainer_candidates if m.nozzle_exit_in})
        stack_noz = a["stack_nozzles_in"]
        if stack_noz == "auto":
            stack_noz = sorted({bn[0], bn[len(bn) // 2], bn[-1]}) if bn else [None]
        sus_noz = a["sustainer_nozzles_in"]
        if sus_noz == "auto":
            sus_noz = sorted({sn[0], sn[-1]}) if sn else [None]
        plan = [(STACK, n, alt) for alt in a["altitudes_ft"] for n in stack_noz] + [(SUSTAINER, n, alt) for alt in a["altitudes_ft"] for n in sus_noz]
        out = []
        for cfg_name, noz, alt in plan:
            fname = f"{cfg_name}_alt{float(alt):g}" + (f"_noz{noz:g}" if noz is not None else "") + ".csv"
            out.append((cfg_name, noz, float(alt), self.cfg.path("aero_dir") / fname))
        return out

    def stage_aero(self, force: bool = False, clear_stale: bool = True) -> list[Path]:
        """Export the full set of aero tables the python backend needs.
        Once every table is in place, clears any stack_*/sustainer_* table
        no longer in the plan (a motor or nozzle-set swap) so a stale table
        can't linger and get counted as coverage - files still wanted are
        left alone regardless of `force`. `clear_stale` MUST be false when
        the motor set is restricted (--limit / --boosters): the plan then
        covers only part of the set."""
        a = self.cfg["aero_tables"]
        plan = self.aero_plan()
        log(f"aero: {len(plan)} table(s): stack nozzles {sorted({n for c, n, _, _ in plan if c == 'stack'})} in, sustainer nozzles {sorted({n for c, n, _, _ in plan if c == 'sustainer'})} in, altitudes {a['altitudes_ft']} ft")
        made = self._export_aero_plan(plan, force)
        if clear_stale:
            aero_dir = self.cfg.path("aero_dir")
            wanted = {dst for _, _, _, dst in plan}
            stale = [p for pat in ("stack_*.csv", "sustainer_*.csv") for p in aero_dir.glob(pat) if p not in wanted] if aero_dir.exists() else []
            for p in stale:
                p.unlink()
            if stale:
                log(f"aero: cleared {len(stale)} stale table(s) no longer in the plan")
        return made

    def _export_aero_plan(self, plan, force: bool) -> list[Path]:
        a = self.cfg["aero_tables"]
        made = []
        if self.rasaero_engine() == "native":
            be = self.native_backend()
            try:
                for cfg_name, noz, alt, dst in plan:
                    if dst.exists() and not force:
                        log(f"  {dst.name}: exists, skipping")
                    else:
                        be.aero_table(cfg_name, alt, noz, dst, mach_max=float(a.get("mach_max", 25.0)))
                        log(f"  aero table -> {dst}")
                    made.append(dst)
            finally:
                be.close()
            return made
        if a.get("batch_altitudes") and len(a["altitudes_ft"]) > 1:
            # one open CDX1 per (config, nozzle) covers every altitude - see
            # aero_export_batch. Still opt-in: needs a live VM check first.
            groups: dict[tuple[str, float | None], list[tuple[float, Path]]] = {}
            for cfg_name, noz, alt, dst in plan:
                groups.setdefault((cfg_name, noz), []).append((alt, dst))
            for (cfg_name, noz), items in groups.items():
                todo = []
                for alt, dst in items:
                    if dst.exists() and not force:
                        log(f"  {dst.name}: exists, skipping")
                        made.append(dst)
                    else:
                        todo.append((alt, dst))
                if todo:
                    made += self.aero_export_batch(cfg_name, noz, todo, plot_range=a["plot_range"])
            return made
        for cfg_name, noz, alt, dst in plan:
            fname = dst.name
            if dst.exists() and not force:
                log(f"  {fname}: exists, skipping")
                made.append(dst)
                continue
            made.append(self.aero_export(cfg_name, noz, alt, plot_range=a["plot_range"], mach_alt=[[0, alt], [25, alt]]))
        return made

    # ---- RASAero reference cases + validation of the python backend --------
    def reference_rows(self, n_cases: int) -> list[SimRow]:
        """A spread of (booster, sustainer, delays) covering short and long
        coasts and every searched sustainer."""
        ms = self.ms
        mass = self.load_mass()
        sus = self.sustainers
        c = self.cfg["characterization"]
        delays = [(c["separation_delay_s"], c["ignition_delay_s"]), (1.0, 3.0), (0.0, 8.0), (1.0, 12.0), (0.5, 5.0)]
        rows = []
        i = 0
        while len(rows) < n_cases:
            b = ms.boosters[(i * max(1, len(ms.boosters) // max(1, min(n_cases, len(ms.boosters))))) % len(ms.boosters)]
            s = sus[(i + i // len(delays)) % len(sus)]  # offset so a sustainer is not always paired with the same delays
            sep, ign = delays[i % len(delays)]
            rows.append(make_row(b.label, None, sep, ign, ms, mass[(b.label, s.label)], self.cfg))
            i += 1
        return rows

    def stage_reference(self, n_cases: int = 10) -> list[Path]:
        """Export reference flights through the RASAero backend (VM worker).
        Clears every ref* case from a previous run first - a stale case left
        over from an earlier --cases N or motor-set swap would otherwise sit
        alongside the new ones and get picked up by `rpa validate`."""
        from .validate import save_case

        be = self.rasaero_backend()
        ref_dir = self.cfg.path("reference_dir")
        old = [p for d in (ref_dir, be.history_dir) if d.exists() for p in d.glob("ref[0-9]*")]
        for p in old:
            p.unlink()
        if old:
            log(f"reference: cleared {len(old)} file(s) from previous case(s)")
        made = []
        rows = self.reference_rows(n_cases)
        many = len(self.sustainers) > 1
        names = [f"ref{i + 1:02d}-{row.booster}" + (f"+{row.sustainer}" if many else "") + f"-sep{row.sep_delay_s:g}-ign{row.ign_delay_s:g}" for i, row in enumerate(rows)]

        def keep(row, name):
            job_csv = be.history_dir / (name + ".csv")
            made.append(save_case(ref_dir, name, job_csv, row, self.site, booster=self.ms.booster(row.booster), sustainer=self.ms.sustainer_by_label(row.sustainer)))

        # opt-in (worker.batch_reference_export): one Rerun All for every row
        # instead of one job per flight - needs a live check on the VM
        # before it replaces the per-flight path by default.
        batched = bool(self.cfg["worker"].get("batch_reference_export")) and len(rows) > 1 and isinstance(be, RASAeroBackend)
        if batched:
            log(f"reference: exporting {len(rows)} RASAero flights (batched) into {ref_dir}")
            try:
                histories = be.export_batch(rows, names)
            except Exception as e:  # noqa: BLE001 - any batch failure falls back to the per-flight path
                log(f"reference: batched export failed: {e}")
                log("reference: falling back to one job per flight (set worker.batch_reference_export: false to skip the batched attempt)")
                batched = False
            else:
                for row, name, h in zip(rows, names, histories, strict=True):
                    if h is None or row.max_alt_ft is None:
                        log(f"  {name}: skipped (no result)")
                        continue
                    keep(row, name)
                    log(f"  {name}: apogee {row.max_alt_ft:.0f} ft")
        if not batched:
            log(f"reference: exporting {len(rows)} RASAero flights into {ref_dir}")
            for i, (row, name) in enumerate(zip(rows, names, strict=True)):
                be.export(row, name)
                keep(row, name)
                log(f"  [{i + 1}/{len(rows)}] {name}: apogee {row.max_alt_ft:.0f} ft")
        (ref_dir / "altitude_offset.json").write_text(json.dumps({"offset_ft": be.alt_offset_ft or 0.0}))
        if hasattr(be, "close"):
            be.close()
        from .validate import load_cases

        self.write_density_calibration(load_cases(ref_dir))
        return made

    def write_density_calibration(self, cases) -> Path | None:
        """Recover RASAero's density-vs-altitude from the reference exports."""
        from .atmosphere import calibrate_density
        from .flightsim import ref_area_ft2

        ref_dir = self.cfg.path("reference_dir")
        cal = calibrate_density([c.history for c in cases], ref_area_ft2(self.ref_diameter_in))
        if cal is None:
            return None
        out = ref_dir / "density_calibration.csv"
        pd.DataFrame({"altitude_ft": cal[0], "density_slug_ft3": cal[1]}).to_csv(out, index=False)
        log(f"  density calibration: {len(cal[0])} bins, {cal[0][0]:.0f}-{cal[0][-1]:.0f} ft -> {out.name}")
        return out

    def stage_validate(self, engine: str | None = None) -> pd.DataFrame:
        """Compare a backend against the RASAero reference exports: the
        python backend (default), or `engine="native"` for RASAero's own
        engine on this machine vs the VM exports (native/VALIDATION.md)."""
        from .validate import load_cases, run_validation

        ref_dir = self.cfg.path("reference_dir")
        cases = load_cases(ref_dir)
        if not cases:
            raise FileNotFoundError(f"no reference cases (<name>.csv + <name>.json) in {ref_dir}")
        self.write_density_calibration(cases)
        offset = 0.0
        if (ref_dir / "altitude_offset.json").exists():
            offset = float(json.loads((ref_dir / "altitude_offset.json").read_text())["offset_ft"])
        if engine == "native":
            be = self.native_backend(motor_files=[])
            out_dir = self.out / "validation_native"
            log(f"validate: {len(cases)} case(s) vs RASAero native engine; tolerances {self.cfg['validation']}")
        else:
            be = PythonBackend(self.cfg, self.ms, self.site, self.ref_diameter_in, log=log)
            out_dir = self.out / "validation"
            log(f"validate: {len(cases)} case(s) vs python backend; tolerances {self.cfg['validation']}")
        try:
            df = run_validation(cases, be, self.cfg["validation"], out_dir, alt_offset_ft=offset, log=log)
        finally:
            if hasattr(be, "close"):
                be.close()
        n_ok = int(df["pass"].sum())
        log(f"  {n_ok}/{len(df)} passed; details in {out_dir}")
        return df

    # ---- final confirmation of chosen designs in RASAero itself ------------
    def stage_confirm(self, top_n: int = 5, include_unsolved: bool = False, designs: list[str] | None = None) -> pd.DataFrame:
        """Re-run the chosen designs through RASAero (one batched CDX1 via the
        VM worker) and compare its apogee with the python backend's. `designs`:
        explicit keys (booster|sustainer|profile, e.g. the GUI shortlist)
        instead of the `top_n` closest to the target."""
        all_designs = self.load_designs()
        mass = self.load_mass()
        if designs:
            want = set(designs)
            todo = [d for d in all_designs if d.key in want]
            missing = sorted(want - {d.key for d in todo})
            if missing:
                log(f"confirm: {len(missing)} requested design(s) are not in designs.csv: {', '.join(missing[:5])}")
            if not todo:
                return pd.DataFrame()
        else:
            todo = [d for d in all_designs if d.status == "solved"] or (list(all_designs) if include_unsolved else [])
            if not todo:
                log("confirm: no solved designs (use --include-unsolved to confirm the best available rows)")
                return pd.DataFrame()
            todo = sorted(todo, key=lambda d: abs(d.apogee_ft - self.cfg["target"]["apogee_ft"]))[:top_n]
        rows = [make_row(d.booster, d.profile, d.sep_delay_s, d.ign_delay_s, self.ms, mass[(d.booster, d.sustainer)], self.cfg) for d in todo]
        be = self.rasaero_backend()
        log(f"confirm: {len(rows)} design(s) through RASAero ({be.name})")
        be.run_batch(rows, "confirm")
        if hasattr(be, "close"):
            be.close()
        recs = []
        for d, r in zip(todo, rows, strict=False):
            recs.append({"booster": d.booster, "sustainer": d.sustainer, "profile": d.profile, "sep_delay_s": d.sep_delay_s, "ign_delay_s": d.ign_delay_s, "apogee_python_ft": d.apogee_ft, "apogee_rasaero_ft": r.max_alt_ft, "diff_ft": (r.max_alt_ft - d.apogee_ft) if r.max_alt_ft is not None else None, "diff_pct": (100.0 * (r.max_alt_ft - d.apogee_ft) / d.apogee_ft) if r.max_alt_ft is not None else None, "max_vel_rasaero_fps": r.max_vel_fps, "t_apogee_rasaero_s": r.t_apogee_s})
            log(f"  {d.booster} {d.profile} sep={d.sep_delay_s} ign={d.ign_delay_s}: python {d.apogee_ft:.0f} ft, RASAero {r.max_alt_ft if r.max_alt_ft is None else round(r.max_alt_ft)} ft ({recs[-1]['diff_pct']:+.2f}%)" if r.max_alt_ft is not None else f"  {d.booster}: no RASAero result")
        df = pd.DataFrame(recs)
        df.to_csv(self.out / "confirm.csv", index=False)
        return df

    # ---- stage 1: motors ---------------------------------------------------
    def stage_motors(self):
        ms = self.ms
        motor_table(ms.boosters).to_csv(self.out / "boosters.csv", index=False)
        motor_table(ms.sustainer_candidates).to_csv(self.out / "sustainers.csv", index=False)
        d, f = stage_motor_files(ms, self.out / "motors")
        (self.out / "selected_sustainer.json").write_text(
            json.dumps({"label": ms.sustainer.label, "designation": ms.sustainer.designation, "total_impulse_ns": ms.sustainer.total_impulse_ns, "rasaero_name": ms.sustainer.rasaero_name(self.cfg["rasaero"]["engine_name_format"]), "n_candidates": len(ms.sustainer_candidates)}, indent=2)
        )
        log(f"motors: {len(ms.boosters)} boosters; {len(ms.sustainer_candidates)} sustainer candidate(s), max impulse {ms.sustainer.label} ({ms.sustainer.total_impulse_ns:.0f} N·s); staged in {d}")
        return d, f

    # ---- stage 2: mass properties ------------------------------------------
    def _mass_signature(self) -> dict:
        """What the cached mass table depends on besides the motor set."""
        ork = self.cfg.file("ork")
        return {"method": self.cfg["mass_model"]["method"], "hardware_mass_lb": self.cfg.hardware_mass_lb(), "ork": manifest.digest(ork) if ork and ork.exists() else None}

    def stage_mass(self, keep: list[MassRow] | None = None) -> list[MassRow]:
        """Mass rows for every (booster, candidate) pair; `keep` skips cached ones."""
        method = self.cfg["mass_model"]["method"]
        ms = self.ms
        sus = ms.sustainer_candidates
        if method == "manual":
            m = self.cfg["mass_model"]["manual"]
            need = ["sustainer_wt_lb", "sustainer_cg_in", "combined_wt_lb_ref", "combined_cg_in_ref", "ref_booster_prop_kg", "booster_prop_cg_in"]
            missing = [k for k in need if m.get(k) is None]
            if missing:
                raise ValueError(f"mass_model.manual is missing {missing}")

            def row(b, s):
                dm = (b.prop_mass_kg - m["ref_booster_prop_kg"]) * KG_TO_LB
                wt = m["combined_wt_lb_ref"] + dm
                cg = (m["combined_wt_lb_ref"] * m["combined_cg_in_ref"] + dm * m["booster_prop_cg_in"]) / wt
                return MassRow(b.label, m["sustainer_wt_lb"], m["sustainer_cg_in"], round(wt, 3), round(cg, 3), b.prop_mass_kg, sustainer=s.label)

            rows = [row(b, s) for s in sus for b in ms.boosters]
            log(f"mass: manual model, {len(ms.boosters)} boosters x {len(sus)} sustainer candidate(s)")
        else:
            hw = self.cfg.hardware_mass_lb()
            have = {r.key: r for r in keep or []}
            todo = [(s, [b for b in ms.boosters if (b.label, s.label) not in have]) for s in sus]
            new = []
            if any(bs for _, bs in todo):
                orr = self.openrocket()
                new = [r for s, bs in todo for r in orr.mass_table(s, bs, hw)]
            by = {**have, **{r.key: r for r in new}}
            rows = [by[(b.label, s.label)] for s in sus for b in ms.boosters]
            r0 = rows[0]
            log(f"mass: OpenRocket {self.cfg.path('ork').name}, {len(ms.boosters)} boosters x {len(sus)} sustainer candidate(s)" + (f" ({len(new)} pair(s) computed, {len(rows) - len(new)} cached)" if have else "") + ", dry mass " + (f"forced to {hw:g} lb (sustainer {r0.sustainer_dry_lb} + booster {r0.booster_dry_lb} lb; .ork scaled)" if hw is not None else f"{r0.sustainer_dry_lb + r0.booster_dry_lb:.1f} lb from the .ork") + f"; loaded: sustainer {min(r.sustainer_wt_lb for r in rows):.1f}-{max(r.sustainer_wt_lb for r in rows):.1f} lb; stack {min(r.combined_wt_lb for r in rows):.1f}-{max(r.combined_wt_lb for r in rows):.1f} lb")
        pd.DataFrame([r.__dict__ for r in rows]).to_csv(self.out / "mass_table.csv", index=False)
        (self.out / "mass_table.json").write_text(json.dumps(self._mass_signature(), indent=1))
        return rows

    def load_mass(self) -> dict[tuple[str, str], MassRow]:
        """(booster, sustainer) labels -> MassRow; cached rows kept, gaps filled."""
        p = self.out / "mass_table.csv"
        rows: list[MassRow] = []
        if p.exists():
            df = pd.read_csv(p, dtype={"booster": str, "sustainer": str}, keep_default_na=False)
            try:
                sig = json.loads((self.out / "mass_table.json").read_text())
            except (OSError, ValueError):
                sig = None
            if "sustainer" not in df.columns or sig != self._mass_signature():
                log("mass: cached mass_table.csv is stale (older version, or the .ork / mass model changed) - recomputing")
            else:
                names = {f.name for f in fields(MassRow)}
                rows = [MassRow(**{k: (str(v) if k in ("booster", "sustainer") else None if v == "" or pd.isna(v) else float(v)) for k, v in rec.items() if k in names}) for rec in df.to_dict("records")]
        have = {r.key for r in rows}
        if any((b.label, s.label) not in have for s in self.ms.sustainer_candidates for b in self.ms.boosters):
            if rows:
                log("mass: cached mass_table.csv does not cover every (booster, sustainer candidate) pair - computing the missing ones")
            rows = self.stage_mass(keep=rows)
        return {r.key: r for r in rows}

    # ---- stage 3: characterization -----------------------------------------
    def stage_characterize(self) -> tuple[list[Characterization], list[ProfileEligibility]]:
        ms = self.ms
        mass = self.load_mass()
        be = self.backend()
        c = self.cfg["characterization"]
        sep, ign = float(c["separation_delay_s"]), float(c["ignition_delay_s"])
        rod = self.site.get("rod_length_ft")
        chars, elig = [], []
        hist_dir = self.out / "histories"
        hist_dir.mkdir(exist_ok=True)
        for old in hist_dir.glob("char-*.csv"):  # older versions kept one history per run
            old.unlink()
        sus = self.sustainers
        pairs = [(b, s) for s in sus for b in ms.boosters]
        log(f"characterize: {len(ms.boosters)} boosters x {len(sus)} sustainer(s) = {len(pairs)} long-coast runs (sep={sep}s after burnout, ign={ign}s after separation) via {be.name}")
        rows = [make_row(b.label, None, sep, ign, ms, mass[(b.label, s.label)], self.cfg) for b, s in pairs]
        names = [f"char-{b.label}+{s.label}" for b, s in pairs]
        for i, ((b, s), row, h) in enumerate(zip(pairs, rows, be.histories(rows, names), strict=True)):
            ch = characterize(b.label, h, self.cfg, sep, ign, rod, sustainer=s.label)
            chars.append(ch)
            elig.extend(eligibility(ch, h, self.cfg))
            who = f"{b.label}+{s.label}" if len(sus) > 1 else b.label
            if not ch.events_consistent:
                log(f"  !! {who}: staging events do not match the expected delay convention (sep from burnout, ignition from separation): {ch.note}")
            log(f"  [{i + 1:3d}/{len(pairs)}] {who}: burnout {ch.t_burnout_s:.2f}s, peak boost Mach {ch.max_mach_boost:.3f} @ {ch.t_max_mach_s:.2f}s, Mach@burnout {ch.mach_burnout:.3f}, apogee(long coast) {row.max_alt_ft:.0f} ft")
        pd.DataFrame([x.to_dict() for x in chars]).to_csv(self.out / "characterization.csv", index=False)
        pd.DataFrame([x.to_dict() for x in elig]).to_csv(self.out / "eligibility.csv", index=False)
        self._summarize_eligibility(elig)
        return chars, elig

    def _summarize_eligibility(self, elig):
        for prof in (SUBSONIC, SUPERSONIC, DECEL_SUBSONIC):
            rows = [e for e in elig if e.profile == prof]
            if rows:
                n = sum(e.eligible for e in rows)
                log(f"  {prof}: {n}/{len(rows)} (booster, sustainer) pairs eligible")

    def load_eligibility(self) -> list[ProfileEligibility]:
        p = self.out / "eligibility.csv"
        if not p.exists():
            return self.stage_characterize()[1]
        df = pd.read_csv(p, dtype={"booster": str, "sustainer": str}, keep_default_na=False)
        if "sep_min_s" not in df.columns or "sustainer" not in df.columns:
            log("eligibility.csv is from an older version - re-running characterize")
            return self.stage_characterize()[1]
        out = [ProfileEligibility(rec["booster"], rec["profile"], str(rec["eligible"]).lower() == "true", float(rec["sep_min_s"]), float(rec["sep_max_s"]), None if rec["sep_window_max_s"] == "" else float(rec["sep_window_max_s"]), str(rec.get("reason", "")), sustainer=str(rec["sustainer"])) for rec in df.to_dict("records")]
        want = {(b.label, s.label) for s in self.sustainers for b in self.ms.boosters}
        if {(e.booster, e.sustainer) for e in out} != want:
            log("eligibility.csv does not match the current (booster, sustainer) pairs - re-running characterize")
            return self.stage_characterize()[1]
        return out

    # ---- stage 4: apogee search --------------------------------------------
    def stage_search(self) -> list[Design]:
        elig = self.load_eligibility()
        mass = self.load_mass()
        n = sum(e.eligible for e in elig)
        log(f"search: target {self.cfg['target']['apogee_ft']:.0f} ft ± {self.cfg['target']['tolerance_ft']:.0f}; {n} eligible (booster, sustainer, profile) candidates")
        srch = ApogeeSearch(self.cfg, self.backend(), self.ms, mass, elig, log=log)
        designs = srch.run()
        pd.DataFrame([r.to_dict() for r in srch.all_rows]).to_csv(self.out / "search_rows.csv", index=False)
        self._write_designs(designs)
        for st in ("solved", "unsolved", "underpowered", "overpowered"):
            k = sum(d.status == st for d in designs)
            if k:
                log(f"  {st}: {k}")
        return designs

    def _write_designs(self, designs: list[Design]):
        cols = [f.name for f in fields(Design) if f.name != "extra"]
        pd.DataFrame([d.to_dict() for d in designs], columns=cols).to_csv(self.out / "designs.csv", index=False)
        (self.out / "designs_samples.json").write_text(json.dumps({d.key: d.extra.get("samples", []) for d in designs}, indent=1))

    def load_designs(self) -> list[Design]:
        p = self.out / "designs.csv"
        if not p.exists():
            return self.stage_search()
        names = {f.name for f in fields(Design)}
        out = []
        if p.stat().st_size == 0:
            return out
        df = pd.read_csv(p, dtype={"booster": str, "sustainer": str, "profile": str})
        if "sustainer" not in df.columns or df["sustainer"].isna().any():
            log("designs.csv is from an older version (no sustainer labels) - re-running search")
            return self.stage_search()
        for rec in df.to_dict("records"):
            d = {k: (None if (isinstance(v, float) and math.isnan(v)) else v) for k, v in rec.items() if k in names}
            out.append(Design(**d))
        # the search writes one design per eligible (booster, sustainer, profile)
        want = {(e.booster, e.sustainer, e.profile) for e in self.load_eligibility() if e.eligible}
        if {(d.booster, d.sustainer, d.profile) for d in out} != want:
            log("designs.csv does not match the current eligible (booster, sustainer, profile) candidates - re-running search")
            return self.stage_search()
        samples = self.out / "designs_samples.json"
        if samples.exists():
            js = json.loads(samples.read_text())
            for d in out:
                d.extra["samples"] = js.get(d.key, [])
        return out

    # ---- stage 5: verification of the solutions ----------------------------
    def stage_verify(self, include_unsolved: bool = False) -> list[Design]:
        designs = self.load_designs()
        mass = self.load_mass()
        be = self.backend()
        p = self.cfg["profiles"]
        todo = [d for d in designs if d.status == "solved" or include_unsolved]
        for old in (self.out / "histories").glob("final-*.csv"):  # a stale final-* would still be plotted
            old.unlink()
        log(f"verify: exporting full time histories for {len(todo)} design(s) via {be.name}")
        rod = self.site.get("rod_length_ft")
        for d in todo:
            if d.ign_delay_s is None or math.isnan(d.ign_delay_s):
                continue
            row = make_row(d.booster, d.profile, d.sep_delay_s, d.ign_delay_s, self.ms, mass[(d.booster, d.sustainer)], self.cfg)
            h = be.export(row, f"final-{d.booster}+{d.sustainer}-{d.profile}")
            self._verify_design(d, h, row, p, rod)
            log(f"  {d.booster}+{d.sustainer} {d.profile}: sep@M{d.mach_at_sep:.3f}, ign {d.ign_delay_s}s @ {d.vel_at_ign_fps:.0f} fps (M{d.mach_at_ign:.2f}, {d.alt_at_ign_ft:.0f} ft), apogee {d.apogee_ft:.0f} ft -> {'OK' if d.verified_ok else 'FAIL: ' + d.verify_note}")
        self._write_designs(designs)
        return designs

    # ---- stage 6: report ---------------------------------------------------
    def stage_report(self) -> pd.DataFrame:
        from .report import plots, rank, write_report

        designs = self.load_designs()
        out = self.out
        ranked = rank(designs, self.cfg)
        ranked.to_csv(out / "designs_ranked.csv", index=False)
        chars = pd.read_csv(out / "characterization.csv") if (out / "characterization.csv").exists() else None
        elig = pd.read_csv(out / "eligibility.csv") if (out / "eligibility.csv").exists() else None
        sf = out / "sustainers_selected.json"
        sust = json.loads(sf.read_text()) if sf.exists() else None
        rp = write_report(out, self.cfg, ranked, chars, elig, sust)
        made = plots(out, self.cfg, designs, chars, out / "histories")
        log(f"report: {rp}" + (f"; plots: {', '.join(p.name for p in made)}" if made else ""))
        return ranked

    def _verify_design(self, d: Design, h: pd.DataFrame, row: SimRow, p: dict, rod):
        t_bo = H.burnout_time(h)
        t_sep = H.separation_time(h, after=max(0.0, t_bo - 0.05))  # a 0 s delay separates on the burnout sample itself
        t_ign = H.ignition_time(h, after=t_bo)
        notes = []
        if t_sep is None:
            t_sep = t_bo + d.sep_delay_s
            notes.append("separation not detected in history; assumed burnout+delay")
        if t_ign is None:
            t_ign = t_sep + d.ign_delay_s
            notes.append("ignition not detected in history; assumed separation+delay")
        d.mach_at_sep = round(H.value_at(h, "mach", t_sep), 4)
        d.vel_at_ign_fps = round(H.value_at(h, "velocity_fps", t_ign), 1)
        d.mach_at_ign = round(H.value_at(h, "mach", t_ign), 4)
        d.alt_at_ign_ft = round(H.value_at(h, "altitude_ft", t_ign), 1)
        d.max_vel_fps = round(float(h["velocity_fps"].max()), 1)
        d.max_mach = round(float(h["mach"].max()), 4)
        if "accel_fps2" in h:
            d.max_accel_g = round(float(h["accel_fps2"].max()) / G_FPS2, 2)
        d.apogee_ft, d.t_apogee_s = (round(x, 1) for x in H.apogee(h))
        d.rail_exit_vel_fps = (round(v, 1) if (v := H.rail_exit_velocity(h, rod)) is not None else None)
        stack_max = float(h.loc[h["time_s"] <= t_sep, "mach"].max())
        ok = True
        if d.profile == SUBSONIC and stack_max > p["subsonic_max_mach"]:
            ok, _ = False, notes.append(f"stack reached Mach {stack_max:.3f} before separation (> {p['subsonic_max_mach']})")
        if d.profile == SUPERSONIC and d.mach_at_sep < p["supersonic_min_mach"]:
            ok, _ = False, notes.append(f"Mach at separation {d.mach_at_sep:.3f} < {p['supersonic_min_mach']}")
        if d.profile == DECEL_SUBSONIC and d.mach_at_sep > p["subsonic_max_mach"]:
            ok, _ = False, notes.append(f"Mach at separation {d.mach_at_sep:.3f} > {p['subsonic_max_mach']}")
        if d.status == "solved" and abs(d.apogee_ft - self.cfg["target"]["apogee_ft"]) > self.cfg["target"]["tolerance_ft"]:
            ok, _ = False, notes.append(f"apogee {d.apogee_ft:.0f} ft outside tolerance")
        if d.vel_at_ign_fps < p.get("min_ignition_velocity_fps", 0):
            ok, _ = False, notes.append(f"ignition velocity {d.vel_at_ign_fps:.0f} fps below minimum")
        d.verified_ok = ok
        d.verify_note = "; ".join(notes)
