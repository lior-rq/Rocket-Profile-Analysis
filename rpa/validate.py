"""Check the native RASAero engine against RASAero II time-history exports.

A reference case is a pair of files under paths.reference_dir:
    <name>.csv   RASAero 'View Data' export of the flight
    <name>.json  {"row": <SimRow dict>, "site": <launch site dict>}
plus the two motors' own .eng blocks. `rpa reference --engine vm` produces
them through the VM worker (RASAero's GUI); any RASAero run with known
inputs works too. References flown by the native engine itself only prove
the engine is deterministic.

The native engine flies each case with the case's own motors and the two
histories are compared column by column at RASAero's sample times (Mach,
CD, weight, thrust, altitude, velocity, drag), then the event times and
the whole-flight numbers.
"""

from __future__ import annotations

import hashlib
import json
from dataclasses import dataclass, field
from pathlib import Path

import numpy as np
import pandas as pd

from . import history as H
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
    case fails as if the engine were wrong."""
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


def compare_history(case: RefCase, ours: pd.DataFrame, alt_offset_ft: float = 0.0) -> dict:
    """Compare the native engine's full time history with the case's export,
    column by column at RASAero's sample times. One flat record of metrics."""
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
        fails.append(f"CD median err {rec['cd_median_err_pct']:.1f}%")
    if rec.get("weight_max_abs_err_lb", 99) > tol["weight_tol_lb"]:
        fails.append(f"weight err {rec['weight_max_abs_err_lb']:.2f} lb")
    return (not fails), "; ".join(fails)


def overlay_plot(case: RefCase, ours: pd.DataFrame, path: Path, alt_offset_ft: float = 0.0, label: str = "RASAero native"):
    import matplotlib

    matplotlib.use("Agg")
    import matplotlib.pyplot as plt

    ref = case.history
    fig, axs = plt.subplots(2, 2, figsize=(12, 8))
    pairs = [("mach", "Mach"), ("altitude_ft", "Altitude [ft]"), ("cd", "CD"), ("weight_lb", "Weight [lb]")]
    for ax, (col, ylabel) in zip(axs.ravel(), pairs, strict=False):
        if col in ref:
            y = ref[col] - (alt_offset_ft if col == "altitude_ft" else 0.0)
            ax.plot(ref["time_s"], y, label="RASAero (export)", lw=1.8)
        if col in ours:
            ax.plot(ours["time_s"], ours[col], label=label, lw=1.2, ls="--")
        ax.set_xlabel("time [s]")
        ax.set_ylabel(ylabel)
        ax.grid(alpha=0.3)
        ax.legend()
    fig.suptitle(f"{case.name}: {case.row.booster} sep={case.row.sep_delay_s}s ign={case.row.ign_delay_s}s")
    fig.tight_layout()
    fig.savefig(path, dpi=110)
    plt.close(fig)


def run_validation(cases: list[RefCase], be, tol: dict, out_dir: Path, alt_offset_ft: float = 0.0, log=print) -> pd.DataFrame:
    """`be`: a NativeRASAeroBackend; each case flies with its own .eng copies."""
    out_dir.mkdir(parents=True, exist_ok=True)
    for group in duplicate_exports(cases):
        log(f"  {len(group)} cases share one export ({group[0]} .. {group[-1]}) - RASAero exported the same flight for each; re-run `rpa reference`")
    recs = []
    for c in cases:
        skip = case_problem(c, alt_offset_ft)
        if skip is None and (c.booster_eng is None or c.sustainer_eng is None):
            skip = "no .booster.eng / .sustainer.eng copy beside the case - re-export the reference flights"
        if skip:
            recs.append({"case": c.name, "booster": c.row.booster, "sep_delay_s": c.row.sep_delay_s, "ign_delay_s": c.row.ign_delay_s, "apogee_ref_ft": float(c.history["altitude_ft"].max()), "pass": False, "fail_reasons": skip})
            log(f"  {c.name}: BAD REFERENCE - {skip}")
            continue
        be.load_motors([c.booster_eng, c.sustainer_eng])
        rec = compare_history(c, be.history(c.row, c.name, site=c.site), alt_offset_ft)
        ours = rec.pop("_ours")
        ok, why = judge(rec, tol)
        rec["pass"], rec["fail_reasons"] = ok, why
        overlay_plot(c, ours, out_dir / f"{c.name}.png", alt_offset_ft)
        recs.append(rec)
        log(f"  {c.name}: apogee {rec['apogee_ours_ft']:.0f} vs {rec['apogee_ref_ft']:.0f} ft ({rec['apogee_err_pct']:+.4f}%), Mach@burnout {rec['mach_burnout_ours']:.3f} vs {rec['mach_burnout_ref']:.3f}, CD med err {rec.get('cd_median_err_pct', float('nan')):.4f}%, weight err {rec['weight_max_abs_err_lb']:.3f} lb -> {'PASS' if ok else 'FAIL: ' + why}")
    df = pd.DataFrame(recs)
    df.to_csv(out_dir / "validation.csv", index=False)
    return df
