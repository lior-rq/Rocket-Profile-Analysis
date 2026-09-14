"""Booster candidate set + sustainer selection."""

from __future__ import annotations

import json
import shutil
from dataclasses import dataclass
from pathlib import Path

import pandas as pd

from .eng import Motor, load_motors, write_combined_eng


@dataclass
class MotorSet:
    boosters: list[Motor]
    sustainer: Motor
    sustainer_candidates: list[Motor]

    def booster(self, label: str) -> Motor:
        idx = self.__dict__.get("_by_label")
        if idx is None or idx[0] is not self.boosters or len(idx[1]) != len(self.boosters):
            idx = (self.boosters, {b.label: b for b in self.boosters})
            self.__dict__["_by_label"] = idx
        try:
            return idx[1][label]
        except KeyError:
            raise KeyError(f"booster {label!r} is not in the current motor set") from None


def select_sustainer(cands: list[Motor]) -> Motor:
    """Highest total impulse wins; ties go to the lowest file index (first file)."""
    return max(cands, key=lambda m: (round(m.total_impulse_ns, 1), -(m.index or 0)))


def load_motor_set(boosters, sustainers, ric=None) -> MotorSet:
    """`boosters` / `sustainers`: a folder, a file, or a list of folders and
    files (.eng with one or many motors, or openMotor .ric designs converted
    through `ric`, see rpa.ric.RicConverter)."""
    boosters = load_motors(boosters, ric)
    sust_cands = load_motors(sustainers, ric)
    names = [b.designation for b in boosters]
    dupes = {n for n in names if names.count(n) > 1}
    if dupes:
        raise ValueError(f"duplicate booster designations (RASAero needs unique names): {sorted(dupes)}")
    return MotorSet(boosters=boosters, sustainer=select_sustainer(sust_cands), sustainer_candidates=sust_cands)


def motor_table(motors: list[Motor]) -> pd.DataFrame:
    return pd.DataFrame(
        {
            "label": m.label,
            "designation": m.designation,
            "manufacturer": m.manufacturer,
            "total_impulse_ns": round(m.total_impulse_ns, 1),
            "burn_time_s": round(m.burn_time_s, 4),
            "avg_thrust_n": round(m.avg_thrust_n, 1),
            "peak_thrust_n": round(m.peak_thrust_n, 1),
            "prop_mass_kg": m.prop_mass_kg,
            "diameter_mm": m.diameter_mm,
            "length_mm": m.length_mm,
            "nozzle_exit_in": m.nozzle_exit_in,
            "file": str(m.path),
        }
        for m in motors
    )


def stage_motor_files(ms: MotorSet, out_dir) -> tuple[Path, Path]:
    """Copy the booster files + chosen sustainer into out_dir and also write a
    combined multi-motor file. Returns (directory, combined_file)."""
    out_dir = Path(out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)
    for old in out_dir.glob("*.eng"):
        old.unlink()
    for src in dict.fromkeys(m.path for m in [*ms.boosters, ms.sustainer]):  # a multi-motor file is copied once
        shutil.copy2(src, out_dir / src.name)
    combined = write_combined_eng([*ms.boosters, ms.sustainer], out_dir / "all_motors.eng")
    (out_dir / "manifest.json").write_text(json.dumps(motor_manifest(ms), indent=1))
    return out_dir, combined


def motor_manifest(ms: MotorSet) -> dict:
    """Fingerprint of the input motor set, so stale staged files are detected
    when the user swaps a motor folder."""
    return {str(p): [p.stat().st_size, int(p.stat().st_mtime)] for p in dict.fromkeys(m.path for m in [*ms.boosters, ms.sustainer])}


def staged_motors_current(ms: MotorSet, out_dir) -> bool:
    p = Path(out_dir) / "manifest.json"
    if not p.exists() or not (Path(out_dir) / "all_motors.eng").exists():
        return False
    try:
        return json.loads(p.read_text()) == motor_manifest(ms)
    except (OSError, ValueError):
        return False
