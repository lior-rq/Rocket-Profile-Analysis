"""The stages of the SOP automation, each reading/writing files under output/
so a run can be resumed or a single stage re-done."""

from __future__ import annotations

import json
import math
from dataclasses import fields
from pathlib import Path

import pandas as pd

from . import cdx1, history as H
from .backends import OpenRocketBackend, PythonBackend, RASAeroBackend, SimBackend
from .jobs import AERO_EXPORT, INSPECT, JobClient
from .models import SUBSONIC, SUPERSONIC, Characterization, Design, MassRow, ProfileEligibility, SimRow
from .motors import MotorSet, load_motor_set, motor_table, stage_motor_files, staged_motors_current
from .openrocket import KG_TO_LB, OpenRocket
from .profiles import DECEL_SUBSONIC, characterize, eligibility
from .search import ApogeeSearch, make_row

G_FPS2 = 32.174


def log(msg: str):
    print(msg, flush=True)


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
            self._ms = load_motor_set(self.cfg.motor_sources("boosters"), self.cfg.motor_sources("sustainers"), ric=self.ric_converter())
        return self._ms

    @property
    def template(self):
        if self._template is None:
            self._template = cdx1.load(self.cfg.path("cdx1"))
        return self._template

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
            self._or = OpenRocket(self.cfg.path("openrocket_jar"), self.cfg.path("jvm")).__enter__()
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
            else:
                self._backend = RASAeroBackend(self.cfg, self.template, motor_file, motor_dir, self.jobs(), log=log)
        return self._backend

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
        cdx1.write_batch(self.template, [make_row(self.ms.boosters[0].label, None, 15.0, 15.0, self.ms, self.load_mass()[self.ms.boosters[0].label], self.cfg)], job.input_cdx1, launch_site_overrides={k: v for k, v in self.cfg["launch_site"].items() if v is not None}, surface=self.cfg["surface_finish"])
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
        ms = self.ms
        log(f"check: {len(ms.boosters)} boosters, sustainer {ms.sustainer.label}, CDX1 {self.cfg.path('cdx1').name}, ORK {self.cfg.path('ork').name}")
        for b in [*ms.boosters, ms.sustainer]:
            if b.nozzle_exit_in is None and not (self.cfg["rasaero"]["booster_nozzle_in"] and self.cfg["rasaero"]["sustainer_nozzle_in"]):
                problems.append(f"{b.label}: no 'Throat x in, exit y in' comment in the .eng and no nozzle override in config.yaml")
        try:
            log(f"  reference diameter {self.ref_diameter_in:.3f} in; launch site {self.site}")
        except Exception as e:
            problems.append(f"CDX1: {e}")
        aero_dir = self.cfg.path("aero_dir")
        if self.cfg["backend"] == "python":
            try:
                aero = AeroSet.load(aero_dir)
                log("  aero tables:\n    " + aero.describe().replace("\n", "\n    "))
                nozs = [b.nozzle_exit_in for b in ms.boosters if b.nozzle_exit_in]
                for noz in (min(nozs), max(nozs)) if nozs else (None,):
                    problems += aero.coverage_problems(STACK, noz, 2.5, 50000.0)
                problems += aero.coverage_problems(SUSTAINER, ms.sustainer.nozzle_exit_in, 3.0, 50000.0)
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
    def aero_export(self, config: str, nozzle_in: float | None, altitude_ft: float | None, plot_range: str = "Mach 5", mach_alt: list | None = None, name: str | None = None) -> Path:
        """One Aero Plots CSV export. Writes a CDX1 with the design-level
        nozzle set, runs the job, copies the CSV into input/aero/ under the
        naming convention rpa.aero expects."""
        import copy
        import shutil

        from .aero import STACK

        motor_dir, motor_file = self.motor_paths()
        jobs = self.jobs()
        alt = float(altitude_ft if altitude_ft is not None else (self.site.get("altitude_ft") or 0.0))
        fname = f"{config}_alt{alt:g}" + (f"_noz{nozzle_in:g}" if nozzle_in is not None else "") + ".csv"
        job = jobs.create(name or f"aero-{fname[:-4]}", AERO_EXPORT, motor_file=motor_file, motor_dir=motor_dir, n_rows=1, export=True, extra={"config": config, "plot_range": plot_range, "mach_alt": mach_alt})
        tree = copy.deepcopy(self.template)
        cdx1.apply_launch_site(tree, {k: v for k, v in self.cfg["launch_site"].items() if v is not None})
        cdx1.apply_surface(tree, self.cfg["surface_finish"])
        if nozzle_in is not None:
            cdx1.apply_nozzles(tree, nozzle_in if config != STACK else None, nozzle_in if config == STACK else None)
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

    def stage_aero(self, force: bool = False) -> list[Path]:
        """Export the full set of aero tables the python backend needs."""
        a = self.cfg["aero_tables"]
        plan = self.aero_plan()
        log(f"aero: {len(plan)} table(s): stack nozzles {sorted({n for c, n, _, _ in plan if c == 'stack'})} in, sustainer nozzles {sorted({n for c, n, _, _ in plan if c == 'sustainer'})} in, altitudes {a['altitudes_ft']} ft")
        made = []
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
        """A spread of (booster, delays) covering short and long coasts."""
        ms = self.ms
        mass = self.load_mass()
        c = self.cfg["characterization"]
        delays = [(c["separation_delay_s"], c["ignition_delay_s"]), (1.0, 3.0), (0.0, 8.0), (1.0, 12.0), (0.5, 5.0)]
        rows = []
        i = 0
        while len(rows) < n_cases:
            b = ms.boosters[(i * max(1, len(ms.boosters) // max(1, min(n_cases, len(ms.boosters))))) % len(ms.boosters)]
            sep, ign = delays[i % len(delays)]
            rows.append(make_row(b.label, None, sep, ign, ms, mass[b.label], self.cfg))
            i += 1
        return rows

    def stage_reference(self, n_cases: int = 10) -> list[Path]:
        """Export reference flights through the RASAero backend (VM worker)."""
        from .validate import save_case

        motor_dir, motor_file = self.motor_paths()
        jobs = self.jobs()
        be = RASAeroBackend(self.cfg, self.template, motor_file, motor_dir, jobs, log=log)
        ref_dir = self.cfg.path("reference_dir")
        made = []
        rows = self.reference_rows(n_cases)
        log(f"reference: exporting {len(rows)} RASAero flights into {ref_dir}")
        for i, row in enumerate(rows):
            name = f"ref{i + 1:02d}-{row.booster}-sep{row.sep_delay_s:g}-ign{row.ign_delay_s:g}"
            be.export(row, name)
            job_csv = be.history_dir / (name + ".csv")
            made.append(save_case(ref_dir, name, job_csv, row, self.site, booster_eng=self.ms.booster(row.booster).path, sustainer_eng=self.ms.sustainer.path))
            log(f"  [{i + 1}/{len(rows)}] {name}: apogee {row.max_alt_ft:.0f} ft")
        (ref_dir / "altitude_offset.json").write_text(json.dumps({"offset_ft": be.alt_offset_ft or 0.0}))
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

    def stage_validate(self) -> pd.DataFrame:
        from .validate import load_cases, run_validation

        ref_dir = self.cfg.path("reference_dir")
        cases = load_cases(ref_dir)
        if not cases:
            raise FileNotFoundError(f"no reference cases (<name>.csv + <name>.json) in {ref_dir}")
        self.write_density_calibration(cases)
        offset = 0.0
        if (ref_dir / "altitude_offset.json").exists():
            offset = float(json.loads((ref_dir / "altitude_offset.json").read_text())["offset_ft"])
        be = PythonBackend(self.cfg, self.ms, self.site, self.ref_diameter_in, log=log)
        log(f"validate: {len(cases)} case(s) vs python backend; tolerances {self.cfg['validation']}")
        df = run_validation(cases, be, self.cfg["validation"], self.out / "validation", alt_offset_ft=offset, log=log)
        n_ok = int(df["pass"].sum())
        log(f"  {n_ok}/{len(df)} passed; details in {self.out / 'validation'}")
        return df

    # ---- final confirmation of chosen designs in RASAero itself ------------
    def stage_confirm(self, top_n: int = 5, include_unsolved: bool = False) -> pd.DataFrame:
        """Re-run the chosen designs through RASAero (one batched CDX1 via the
        VM worker) and compare its apogee with the python backend's."""
        designs = self.load_designs()
        mass = self.load_mass()
        todo = [d for d in designs if d.status == "solved"] or (list(designs) if include_unsolved else [])
        if not todo:
            log("confirm: no solved designs (use --include-unsolved to confirm the best available rows)")
            return pd.DataFrame()
        todo = sorted(todo, key=lambda d: abs(d.apogee_ft - self.cfg["target"]["apogee_ft"]))[:top_n]
        rows = [make_row(d.booster, d.profile, d.sep_delay_s, d.ign_delay_s, self.ms, mass[d.booster], self.cfg) for d in todo]
        motor_dir, motor_file = self.motor_paths()
        jobs = self.jobs()
        be = RASAeroBackend(self.cfg, self.template, motor_file, motor_dir, jobs, log=log)
        log(f"confirm: {len(rows)} design(s) through RASAero")
        be.run_batch(rows, "confirm")
        recs = []
        for d, r in zip(todo, rows, strict=False):
            recs.append({"booster": d.booster, "profile": d.profile, "sep_delay_s": d.sep_delay_s, "ign_delay_s": d.ign_delay_s, "apogee_python_ft": d.apogee_ft, "apogee_rasaero_ft": r.max_alt_ft, "diff_ft": (r.max_alt_ft - d.apogee_ft) if r.max_alt_ft is not None else None, "diff_pct": (100.0 * (r.max_alt_ft - d.apogee_ft) / d.apogee_ft) if r.max_alt_ft is not None else None, "max_vel_rasaero_fps": r.max_vel_fps, "t_apogee_rasaero_s": r.t_apogee_s})
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
        log(f"motors: {len(ms.boosters)} boosters; sustainer = {ms.sustainer.label} ({ms.sustainer.total_impulse_ns:.0f} N·s, highest of {len(ms.sustainer_candidates)}); staged in {d}")
        return d, f

    # ---- stage 2: mass properties (SOP figs 7-10) --------------------------
    def stage_mass(self) -> list[MassRow]:
        method = self.cfg["mass_model"]["method"]
        ms = self.ms
        if method == "manual":
            m = self.cfg["mass_model"]["manual"]
            need = ["sustainer_wt_lb", "sustainer_cg_in", "combined_wt_lb_ref", "combined_cg_in_ref", "ref_booster_prop_kg", "booster_prop_cg_in"]
            missing = [k for k in need if m.get(k) is None]
            if missing:
                raise ValueError(f"mass_model.manual is missing {missing}")
            rows = []
            for b in ms.boosters:
                dm = (b.prop_mass_kg - m["ref_booster_prop_kg"]) * KG_TO_LB
                wt = m["combined_wt_lb_ref"] + dm
                cg = (m["combined_wt_lb_ref"] * m["combined_cg_in_ref"] + dm * m["booster_prop_cg_in"]) / wt
                rows.append(MassRow(b.label, m["sustainer_wt_lb"], m["sustainer_cg_in"], round(wt, 3), round(cg, 3), b.prop_mass_kg))
            log(f"mass: manual model, {len(rows)} boosters")
        else:
            orr = self.openrocket()
            hw = self.cfg["mass_model"].get("hardware_mass_lb")
            hw = None if hw in (None, "", "null") else float(hw)
            rows = orr.mass_table(ms.sustainer, ms.boosters, hw)
            r0 = rows[0]
            log(f"mass: OpenRocket {self.cfg.path('ork').name}, dry mass " + (f"forced to {hw:g} lb (sustainer {r0.sustainer_dry_lb} + booster {r0.booster_dry_lb} lb; .ork scaled)" if hw is not None else f"{r0.sustainer_dry_lb + r0.booster_dry_lb:.1f} lb from the .ork") + f"; loaded: sustainer {r0.sustainer_wt_lb} lb @ CG {r0.sustainer_cg_in} in; stack {min(r.combined_wt_lb for r in rows):.1f}-{max(r.combined_wt_lb for r in rows):.1f} lb")
        pd.DataFrame([r.__dict__ for r in rows]).to_csv(self.out / "mass_table.csv", index=False)
        return rows

    def load_mass(self) -> dict[str, MassRow]:
        p = self.out / "mass_table.csv"
        if not p.exists():
            rows = self.stage_mass()
        else:
            names = {f.name for f in fields(MassRow)}
            rows = [MassRow(**{k: (str(v) if k == "booster" else None if pd.isna(v) else float(v)) for k, v in rec.items() if k in names}) for rec in pd.read_csv(p).to_dict("records")]
            hw = self.cfg["mass_model"].get("hardware_mass_lb")
            hw = None if hw in (None, "", "null") else float(hw)
            if self.cfg["mass_model"]["method"] == "openrocket" and rows and rows[0].hardware_mass_lb != hw:
                log(f"mass: cached mass_table.csv was built with hardware_mass_lb={rows[0].hardware_mass_lb} (config now {hw}) - recomputing")
                rows = self.stage_mass()
            have = {r.booster for r in rows}
            if any(b.label not in have for b in self.ms.boosters):
                log("mass: cached mass_table.csv does not cover every booster - recomputing")
                rows = self.stage_mass()
        return {r.booster: r for r in rows}

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
        log(f"characterize: {len(ms.boosters)} boosters, one long-coast run each (sep={sep}s after burnout, ign={ign}s after separation) via {be.name}")
        for i, b in enumerate(ms.boosters):
            row = make_row(b.label, None, sep, ign, ms, mass[b.label], self.cfg)
            h = be.export(row, f"char-{b.label}")
            ch = characterize(b.label, h, self.cfg, sep, ign, rod)
            chars.append(ch)
            elig.extend(eligibility(ch, h, self.cfg))
            if not ch.events_consistent:
                log(f"  !! {b.label}: staging events do not match the expected delay convention (sep from burnout, ignition from separation): {ch.note}")
            log(f"  [{i + 1:2d}/{len(ms.boosters)}] {b.label}: burnout {ch.t_burnout_s:.2f}s, peak boost Mach {ch.max_mach_boost:.3f} @ {ch.t_max_mach_s:.2f}s, Mach@burnout {ch.mach_burnout:.3f}, apogee(long coast) {row.max_alt_ft:.0f} ft")
        pd.DataFrame([x.to_dict() for x in chars]).to_csv(self.out / "characterization.csv", index=False)
        pd.DataFrame([x.to_dict() for x in elig]).to_csv(self.out / "eligibility.csv", index=False)
        self._summarize_eligibility(elig)
        return chars, elig

    def _summarize_eligibility(self, elig):
        for prof in (SUBSONIC, SUPERSONIC, DECEL_SUBSONIC):
            rows = [e for e in elig if e.profile == prof]
            if rows:
                n = sum(e.eligible for e in rows)
                log(f"  {prof}: {n}/{len(rows)} boosters eligible")

    def load_eligibility(self) -> list[ProfileEligibility]:
        p = self.out / "eligibility.csv"
        if not p.exists():
            return self.stage_characterize()[1]
        df = pd.read_csv(p)
        out = []
        for rec in df.to_dict("records"):
            if "sep_min_s" not in rec:
                log("eligibility.csv is from an older version (single separation delay) - re-running characterize")
                return self.stage_characterize()[1]
            out.append(ProfileEligibility(rec["booster"], rec["profile"], bool(rec["eligible"]), float(rec["sep_min_s"]), float(rec["sep_max_s"]), None if pd.isna(rec["sep_window_max_s"]) else float(rec["sep_window_max_s"]), str(rec.get("reason", "") if not pd.isna(rec.get("reason", "")) else "")))
        return out

    # ---- stage 4: apogee search --------------------------------------------
    def stage_search(self) -> list[Design]:
        elig = self.load_eligibility()
        mass = self.load_mass()
        n = sum(e.eligible for e in elig)
        log(f"search: target {self.cfg['target']['apogee_ft']:.0f} ft ± {self.cfg['target']['tolerance_ft']:.0f}; {n} eligible (booster, profile) candidates")
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
        (self.out / "designs_samples.json").write_text(json.dumps({f"{d.booster}|{d.profile}": d.extra.get("samples", []) for d in designs}, indent=1))

    def load_designs(self) -> list[Design]:
        p = self.out / "designs.csv"
        if not p.exists():
            return self.stage_search()
        names = {f.name for f in fields(Design)}
        out = []
        if p.stat().st_size == 0:
            return out
        for rec in pd.read_csv(p).to_dict("records"):
            d = {k: (None if (isinstance(v, float) and math.isnan(v)) else v) for k, v in rec.items() if k in names}
            out.append(Design(**d))
        samples = self.out / "designs_samples.json"
        if samples.exists():
            js = json.loads(samples.read_text())
            for d in out:
                d.extra["samples"] = js.get(f"{d.booster}|{d.profile}", [])
        return out

    # ---- stage 5: verification of the solutions ----------------------------
    def stage_verify(self, include_unsolved: bool = False) -> list[Design]:
        designs = self.load_designs()
        mass = self.load_mass()
        be = self.backend()
        p = self.cfg["profiles"]
        todo = [d for d in designs if d.status == "solved" or include_unsolved]
        log(f"verify: exporting full time histories for {len(todo)} design(s) via {be.name}")
        rod = self.site.get("rod_length_ft")
        for d in todo:
            if d.ign_delay_s is None or math.isnan(d.ign_delay_s):
                continue
            row = make_row(d.booster, d.profile, d.sep_delay_s, d.ign_delay_s, self.ms, mass[d.booster], self.cfg)
            h = be.export(row, f"final-{d.booster}-{d.profile}")
            self._verify_design(d, h, row, p, rod)
            log(f"  {d.booster} {d.profile}: sep@M{d.mach_at_sep:.3f}, ign {d.ign_delay_s}s @ {d.vel_at_ign_fps:.0f} fps (M{d.mach_at_ign:.2f}, {d.alt_at_ign_ft:.0f} ft), apogee {d.apogee_ft:.0f} ft -> {'OK' if d.verified_ok else 'FAIL: ' + d.verify_note}")
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
        sust = json.loads((out / "selected_sustainer.json").read_text()) if (out / "selected_sustainer.json").exists() else None
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
