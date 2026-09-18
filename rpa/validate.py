"""Validate the Python flight simulator against RASAero II time-history exports.

A reference case is a pair of files under paths.reference_dir:
    <name>.csv   RASAero 'View Data' export of the flight
    <name>.json  {"row": <SimRow dict>, "site": <launch site dict>}
`python -m rpa reference` produces them through the native engine or the
VM worker; any RASAero run with known inputs works too.

The comparison is term by term so a disagreement points at its cause. An
export row holds Mach, CD and drag from the state at the start of its step,
the weight from the step before and the velocity and altitude after it
(rpa.flightsim), and the checks use RASAero's own columns that way:
    mach     v/a from the previous row's velocity and altitude vs its Mach -> atmosphere
    cd       our CD lookup at its Mach, altitude and power state vs its CD  -> aero tables
    drag     q*S*CD with its CD vs its Drag column                          -> density / reference area
    weight   our weight and thrust rows vs its rows, on the same time grid  -> mass model / motor
    flight   apogee, Mach at burnout, max Mach, time to apogee from our run -> the integrator as a whole
"""

from __future__ import annotations

import hashlib
import json
from dataclasses import dataclass, field
from pathlib import Path

import numpy as np
import pandas as pd

from . import history as H
from .aero import STACK, SUSTAINER
from .backends import PythonBackend
from .eng import Motor
from .models import SimRow


@dataclass
class RefCase:
    name: str
    csv: Path
    row: SimRow
    site: dict
    history: pd.DataFrame = field(repr=False)
    booster_eng: Path | None = None  # copies of the motors flown, so the case survives motor-set changes
    sustainer_eng: Path | None = None

    @classmethod
    def load(cls, csv: Path) -> RefCase:
        meta = json.loads(csv.with_suffix(".json").read_text())
        row = {"sustainer": "", **meta["row"]}  # older cases: the .sustainer.eng copy identifies the motor
        b = csv.with_name(csv.stem + ".booster.eng")
        su = csv.with_name(csv.stem + ".sustainer.eng")
        return cls(csv.stem, csv, SimRow.from_dict(row), meta.get("site", {}), H.read_rasaero_export(csv), b if b.exists() else None, su if su.exists() else None)

    def vehicle(self, be: PythonBackend):
        """The Vehicle for this case: the case's own .eng copies when present,
        else the motors of the current set (by label)."""
        from .flightsim import Vehicle

        r = self.row
        booster = _motor_from_copy(self.booster_eng, r.booster, r.booster_engine) if self.booster_eng else be.ms.booster(r.booster)
        if self.sustainer_eng:
            sustainer = _motor_from_copy(self.sustainer_eng, None, r.sustainer_engine)
        elif r.sustainer:
            sustainer = be.ms.sustainer_by_label(r.sustainer)
        else:
            raise ValueError(f"{self.name}: no .sustainer.eng copy and no sustainer label - re-export the reference flights")
        self.note = ""
        if self.sustainer_eng is None and sustainer.designation not in r.sustainer_engine:
            self.note = f"sustainer {r.sustainer_engine!r} of the case is not the current one ({sustainer.designation}); no .sustainer.eng copy - re-export the reference flights"
        return Vehicle(booster, sustainer, r.combined_wt_lb, r.sustainer_wt_lb, be.ref_diameter_in, r.booster_nozzle_in, r.sustainer_nozzle_in)


def _motor_from_copy(path: Path, label: str | None, engine_name: str):
    """The motor a case's .eng copy holds. New copies hold one block; a copy
    of a whole multi-motor file is resolved by label / RASAero engine name."""
    from .eng import parse_eng

    motors = parse_eng(path)
    if len(motors) == 1:
        return motors[0]
    hits = [m for m in motors if m.label == label or engine_name.startswith(m.designation + " ")]
    if len(hits) != 1:
        raise ValueError(f"{path.name}: {len(motors)} motors and {len(hits)} match {label or engine_name!r}")
    return hits[0]


def load_cases(directory: Path) -> list[RefCase]:
    cases = []
    for csv in sorted(directory.glob("*.csv")):
        if csv.with_suffix(".json").exists():
            cases.append(RefCase.load(csv))
    return cases


def save_case(directory: Path, name: str, export_csv: Path, row: SimRow, site: dict, booster: Motor | None = None, sustainer: Motor | None = None) -> Path:
    """Store the export, the row and the two motors' own RASP blocks (never
    the whole source file: it may hold every booster of the set)."""
    directory.mkdir(parents=True, exist_ok=True)
    dst = directory / f"{name}.csv"
    dst.write_bytes(Path(export_csv).read_bytes())
    dst.with_suffix(".json").write_text(json.dumps({"row": row.to_dict(), "site": site}, indent=2))
    for m, suffix in ((booster, ".booster.eng"), (sustainer, ".sustainer.eng")):
        if m is not None:
            dst.with_name(f"{name}{suffix}").write_text(m.raw_text())
    return dst


def case_problem(case: RefCase, alt_offset_ft: float = 0.0) -> str | None:
    """Why the stored .csv cannot be this case's flight, or None. RASAero
    exports the grid row that is selected, so a mis-selected row stores
    another flight's history under this case's name - without this check the
    case fails as if the python backend were wrong."""
    h = case.history
    w0 = float(h["weight_lb"].iloc[0])
    if abs(w0 - case.row.combined_wt_lb) > 0.1:
        return f"export lifts off at {w0:.3f} lb but the case flew {case.row.combined_wt_lb:.3f} lb - the .csv is another flight's; re-run `rpa reference`"
    if case.row.max_alt_ft:
        ap = H.apogee(h)[0] - alt_offset_ft
        if abs(ap - case.row.max_alt_ft) > 0.01 * case.row.max_alt_ft:
            return f"export apogees at {ap:.0f} ft but RASAero reported {case.row.max_alt_ft:.0f} ft for the case - the .csv is another flight's; re-run `rpa reference`"
    return None


def duplicate_exports(cases: list[RefCase]) -> list[list[str]]:
    """Groups of cases whose .csv files are byte-identical."""
    by_hash: dict[str, list[str]] = {}
    for c in cases:
        by_hash.setdefault(hashlib.md5(c.csv.read_bytes()).hexdigest(), []).append(c.name)
    return [names for names in by_hash.values() if len(names) > 1]


def _pct(a: np.ndarray, b: np.ndarray, floor: float = 1e-9) -> np.ndarray:
    return 100.0 * np.abs(a - b) / np.maximum(np.abs(b), floor)


def compare(case: RefCase, be: PythonBackend, alt_offset_ft: float = 0.0) -> dict:
    """Run our sim for the case and compare. Returns one flat record of metrics."""
    ref = case.history.copy()
    if alt_offset_ft:
        ref["altitude_ft"] = ref["altitude_ft"] - alt_offset_ft
    sim = be.sim
    veh = case.vehicle(be)
    summ, ours = sim.run(veh, case.row.sep_delay_s, case.row.ign_delay_s)

    rec = {"case": case.name, "booster": case.row.booster, "sep_delay_s": case.row.sep_delay_s, "ign_delay_s": case.row.ign_delay_s, "note": getattr(case, "note", "")}
    t_bo_ref = H.burnout_time(ref)
    t_sep_ref = H.separation_time(ref, after=t_bo_ref) or (t_bo_ref + case.row.sep_delay_s)
    t = ref["time_s"].to_numpy()
    n = min(len(t), len(ours))  # our run stops at apogee; RASAero's descent rows use another loop
    thrust_on = ref["thrust_lb"].to_numpy() > 0.0
    alt = np.clip(ref["altitude_ft"].to_numpy(), 0.0, None)
    vel = ref["velocity_fps"].to_numpy()
    # the state each row's Mach / CD / drag were computed from
    alt_prev = np.concatenate([[0.0], alt[:-1]])
    vel_prev = np.concatenate([[0.0], vel[:-1]])
    flying = (vel_prev > 150.0) & (np.arange(len(t)) < n)  # skip rail/near-apogee samples, where Mach is two small numbers' ratio

    # -- atmosphere: Mach from RASAero's own velocity and altitude
    a = np.array([sim.atm.speed_of_sound(h) for h in alt_prev])
    mach_ours = vel_prev / a
    rec["mach_max_abs_err"] = float(np.max(np.abs(mach_ours - ref["mach"].to_numpy())[flying])) if flying.any() else np.nan

    # -- aero tables: CD lookup at RASAero's operating point
    if "cd" in ref:
        cd_ours = np.empty(len(ref))
        stack_cd = sim._cd(STACK, veh.booster_nozzle_in)
        sus_cd = sim._cd(SUSTAINER, veh.sustainer_nozzle_in)
        m = ref["mach"].to_numpy()
        for i in range(n):
            cfg, noz = (stack_cd, veh.booster_nozzle_in) if t[i] < t_sep_ref else (sus_cd, veh.sustainer_nozzle_in)
            cd_ours[i] = cfg(m[i], sim.aero_altitude(alt_prev[i]), bool(thrust_on[i]) and bool(noz))
        cd_ours[n:] = ref["cd"].to_numpy()[n:]
        e = _pct(cd_ours, ref["cd"].to_numpy(), 0.05)[flying]
        rec["cd_median_err_pct"] = float(np.median(e)) if len(e) else np.nan
        rec["cd_p95_err_pct"] = float(np.percentile(e, 95)) if len(e) else np.nan
    # -- density / reference area: drag reconstructed with RASAero's own CD
    if "drag_lb" in ref and "cd" in ref:
        rho = np.array([sim.atm.density(h) for h in alt_prev])
        drag_ours = 0.5 * rho * vel_prev**2 * veh.ref_area_ft2 * ref["cd"].to_numpy()
        e = _pct(drag_ours, ref["drag_lb"].to_numpy(), 1.0)[flying]
        rec["drag_median_err_pct"] = float(np.median(e)) if len(e) else np.nan
    # -- mass model / thrust: row for row (both sides use RASAero's float32
    #    clock, so the rows line up until our run stops at apogee)
    rec["time_max_abs_err_s"] = float(np.max(np.abs(ours["time_s"].to_numpy()[:n] - t[:n])))
    rec["weight_max_abs_err_lb"] = float(np.max(np.abs(ours["weight_lb"].to_numpy()[:n] - ref["weight_lb"].to_numpy()[:n])))
    rec["thrust_max_abs_err_lb"] = float(np.max(np.abs(ours["thrust_lb"].to_numpy()[:n] - ref["thrust_lb"].to_numpy()[:n])))
    rec["t_burnout_ref_s"], rec["t_burnout_ours_s"] = t_bo_ref, summ["t_burnout_s"]
    rec["t_sep_ref_s"], rec["t_sep_ours_s"] = t_sep_ref, summ["t_sep_s"]
    rec["t_ign_ref_s"], rec["t_ign_ours_s"] = H.ignition_time(ref, after=t_bo_ref), summ["t_ign_s"]
    # -- whole-flight numbers
    ap_ref, tap_ref = H.apogee(ref)
    rec["apogee_ref_ft"], rec["apogee_ours_ft"] = ap_ref, summ["max_alt_ft"]
    rec["apogee_err_pct"] = 100.0 * (summ["max_alt_ft"] - ap_ref) / ap_ref
    rec["t_apogee_ref_s"], rec["t_apogee_ours_s"] = tap_ref, summ["t_apogee_s"]
    rec["mach_burnout_ref"] = H.value_at(ref, "mach", t_bo_ref)
    rec["mach_burnout_ours"] = H.value_at(ours, "mach", t_bo_ref)
    rec["mach_burnout_err"] = rec["mach_burnout_ours"] - rec["mach_burnout_ref"]
    rec["max_mach_ref"], rec["max_mach_ours"] = float(ref["mach"].max()), summ["max_mach"]
    rec["max_vel_ref_fps"], rec["max_vel_ours_fps"] = float(ref["velocity_fps"].max()), summ["max_vel_fps"]
    rec["altitude_max_abs_err_ft"] = float(np.max(np.abs(ours["altitude_ft"].to_numpy()[:n] - ref["altitude_ft"].to_numpy()[:n])))
    # Mach-vs-time agreement while attached (what the profile rules look at)
    tt = t[(t <= t_sep_ref) & flying]
    if len(tt):
        rec["stack_mach_max_abs_err"] = float(np.max(np.abs(np.interp(tt, ours["time_s"], ours["mach"]) - np.interp(tt, t, ref["mach"].to_numpy()))))
    rec["_ours"] = ours
    return rec


def compare_history(case: RefCase, ours: pd.DataFrame, alt_offset_ft: float = 0.0) -> dict:
    """Compare a full time history (the native engine's export) with the
    case's VM export, column by column at RASAero's sample times. Same record
    keys as compare() where they apply, so judge() and the report work."""
    ref = case.history.copy()
    if alt_offset_ft:
        ref["altitude_ft"] = ref["altitude_ft"] - alt_offset_ft
    rec = {"case": case.name, "booster": case.row.booster, "sep_delay_s": case.row.sep_delay_s, "ign_delay_s": case.row.ign_delay_s, "note": ""}
    t = ref["time_s"].to_numpy()
    to = ours["time_s"].to_numpy()
    n = min(len(t), int(np.searchsorted(t, to[-1], side="right")))
    vel = ref["velocity_fps"].to_numpy()
    flying = (vel > 150.0)[:n]

    def at_ref(col: str) -> np.ndarray:
        return np.interp(t[:n], to, ours[col].to_numpy())

    for col, key in (("mach", "mach"), ("cd", "cd"), ("weight_lb", "weight"), ("thrust_lb", "thrust"), ("altitude_ft", "altitude"), ("velocity_fps", "velocity"), ("drag_lb", "drag")):
        if col not in ref or col not in ours:
            continue
        d = np.abs(at_ref(col) - ref[col].to_numpy()[:n])
        rec[f"{key}_max_abs_err" + ("_lb" if key in ("weight", "thrust", "drag") else "_ft" if key == "altitude" else "_fps" if key == "velocity" else "")] = float(np.nanmax(d)) if n else np.nan
        if key in ("cd", "drag"):
            e = _pct(at_ref(col), ref[col].to_numpy()[:n], 0.05 if key == "cd" else 1.0)[flying]
            rec[f"{key}_median_err_pct"] = float(np.median(e)) if len(e) else np.nan
    t_bo_ref = H.burnout_time(ref)
    t_bo_ours = H.burnout_time(ours)
    rec["t_burnout_ref_s"], rec["t_burnout_ours_s"] = t_bo_ref, t_bo_ours
    rec["t_sep_ref_s"], rec["t_sep_ours_s"] = H.separation_time(ref, after=t_bo_ref), H.separation_time(ours, after=t_bo_ours)
    rec["t_ign_ref_s"], rec["t_ign_ours_s"] = H.ignition_time(ref, after=t_bo_ref), H.ignition_time(ours, after=t_bo_ours)
    ap_ref, tap_ref = H.apogee(ref)
    ap_ours, tap_ours = H.apogee(ours)
    rec["apogee_ref_ft"], rec["apogee_ours_ft"] = ap_ref, ap_ours
    rec["apogee_err_pct"] = 100.0 * (ap_ours - ap_ref) / ap_ref
    rec["t_apogee_ref_s"], rec["t_apogee_ours_s"] = tap_ref, tap_ours
    rec["mach_burnout_ref"] = H.value_at(ref, "mach", t_bo_ref)
    rec["mach_burnout_ours"] = H.value_at(ours, "mach", t_bo_ours)
    rec["mach_burnout_err"] = rec["mach_burnout_ours"] - rec["mach_burnout_ref"]
    rec["max_mach_ref"], rec["max_mach_ours"] = float(ref["mach"].max()), float(ours["mach"].max())
    rec["max_vel_ref_fps"], rec["max_vel_ours_fps"] = float(ref["velocity_fps"].max()), float(ours["velocity_fps"].max())
    rec["_ours"] = ours
    return rec


def judge(rec: dict, tol: dict) -> tuple[bool, str]:
    fails = []
    if abs(rec.get("apogee_err_pct", 99)) > tol["apogee_tol_pct"]:
        fails.append(f"apogee {rec['apogee_err_pct']:+.2f}%")
    if abs(rec.get("mach_burnout_err", 99)) > tol["mach_at_burnout_tol"]:
        fails.append(f"Mach@burnout {rec['mach_burnout_err']:+.3f}")
    if rec.get("mach_max_abs_err", 99) > tol["mach_tol"]:
        fails.append(f"atmosphere: Mach err {rec['mach_max_abs_err']:.3f}")
    if rec.get("cd_median_err_pct", 0) > tol["cd_tol_pct"]:
        fails.append(f"CD lookup median err {rec['cd_median_err_pct']:.1f}%")
    if rec.get("weight_max_abs_err_lb", 99) > tol["weight_tol_lb"]:
        fails.append(f"weight err {rec['weight_max_abs_err_lb']:.2f} lb")
    return (not fails), "; ".join(fails)


def overlay_plot(case: RefCase, ours: pd.DataFrame, path: Path, alt_offset_ft: float = 0.0, label: str = "rpa python"):
    import matplotlib

    matplotlib.use("Agg")
    import matplotlib.pyplot as plt

    ref = case.history
    fig, axs = plt.subplots(2, 2, figsize=(12, 8))
    pairs = [("mach", "Mach"), ("altitude_ft", "Altitude [ft]"), ("cd", "CD"), ("weight_lb", "Weight [lb]")]
    for ax, (col, label) in zip(axs.ravel(), pairs, strict=False):
        if col in ref:
            y = ref[col] - (alt_offset_ft if col == "altitude_ft" else 0.0)
            ax.plot(ref["time_s"], y, label="RASAero", lw=1.8)
        if col in ours:
            ax.plot(ours["time_s"], ours[col], label=label, lw=1.2, ls="--")
        ax.set_xlabel("time [s]")
        ax.set_ylabel(label)
        ax.grid(alpha=0.3)
        ax.legend()
    fig.suptitle(f"{case.name}: {case.row.booster} sep={case.row.sep_delay_s}s ign={case.row.ign_delay_s}s")
    fig.tight_layout()
    fig.savefig(path, dpi=110)
    plt.close(fig)


def run_validation(cases: list[RefCase], be, tol: dict, out_dir: Path, alt_offset_ft: float = 0.0, log=print) -> pd.DataFrame:
    """`be`: a PythonBackend (term-by-term comparison) or a
    NativeRASAeroBackend (history vs history, the case's own motors)."""
    from .native import NativeRASAeroBackend

    native = isinstance(be, NativeRASAeroBackend)
    label = "RASAero native" if native else "rpa python"
    out_dir.mkdir(parents=True, exist_ok=True)
    for group in duplicate_exports(cases):
        log(f"  {len(group)} cases share one export ({group[0]} .. {group[-1]}) - RASAero exported the same flight for each; re-run `rpa reference`")
    recs = []
    for c in cases:
        bad_ref = case_problem(c, alt_offset_ft)
        if bad_ref:
            recs.append({"case": c.name, "booster": c.row.booster, "sep_delay_s": c.row.sep_delay_s, "ign_delay_s": c.row.ign_delay_s, "apogee_ref_ft": float(c.history["altitude_ft"].max()), "pass": False, "fail_reasons": bad_ref})
            log(f"  {c.name}: BAD REFERENCE - {bad_ref}")
            continue
        try:
            if native:
                be.load_motors([c.booster_eng, c.sustainer_eng])
                rec = compare_history(c, be.history(c.row, c.name, site=c.site), alt_offset_ft)
            else:
                rec = compare(c, be, alt_offset_ft)
        except KeyError as e:
            # case's motors are not in the current set, and it has no .eng copies
            why = f"motor not available: {e} (the motor set changed; re-export the reference flights)"
            recs.append({"case": c.name, "booster": c.row.booster, "sep_delay_s": c.row.sep_delay_s, "ign_delay_s": c.row.ign_delay_s, "apogee_ref_ft": float(c.history["altitude_ft"].max()), "pass": False, "fail_reasons": why})
            log(f"  {c.name}: SKIPPED - {why}")
            continue
        ours = rec.pop("_ours")
        ok, why = judge(rec, tol)
        rec["pass"], rec["fail_reasons"] = ok, why
        overlay_plot(c, ours, out_dir / f"{c.name}.png", alt_offset_ft, label=label)
        recs.append(rec)
        log(f"  {c.name}: apogee {rec['apogee_ours_ft']:.0f} vs {rec['apogee_ref_ft']:.0f} ft ({rec['apogee_err_pct']:+.3f}%), Mach@burnout {rec['mach_burnout_ours']:.3f} vs {rec['mach_burnout_ref']:.3f}, CD med err {rec.get('cd_median_err_pct', float('nan')):.2f}%, Mach err {rec['mach_max_abs_err']:.4f}, weight err {rec['weight_max_abs_err_lb']:.3f} lb -> {'PASS' if ok else 'FAIL: ' + why}")
    df = pd.DataFrame(recs)
    df.to_csv(out_dir / "validation.csv", index=False)
    return df
