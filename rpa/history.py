"""Flight time-history analysis (RASAero 'View Data' export or the OpenRocket
preview). Everything downstream works on the normalized column names below."""

from __future__ import annotations

from pathlib import Path

import numpy as np
import pandas as pd

# RASAero export header -> normalized name (from the RASAero II 'View Data' CSV)
RASAERO_COLUMNS = {
    "Time (sec)": "time_s",
    "Stage": "stage",
    "Stage Time (sec)": "stage_time_s",
    "Mach Number": "mach",
    "Angle of Attack (deg)": "aoa_deg",
    "CD": "cd",
    "Thrust (lb)": "thrust_lb",
    "Weight (lb)": "weight_lb",
    "Drag (lb)": "drag_lb",
    "Lift (lb)": "lift_lb",
    "CG (in)": "cg_in",
    "CP (in)": "cp_in",
    "Stability Margin (cal)": "stability_cal",
    "Accel (ft/sec^2)": "accel_fps2",
    "Accel-V (ft/sec^2)": "accel_v_fps2",
    "Accel-H (ft/sec^2)": "accel_h_fps2",
    "Velocity (ft/sec)": "velocity_fps",
    "Vel-V (ft/sec)": "vel_v_fps",
    "Vel-H (ft/sec)": "vel_h_fps",
    "Pitch Attitude (deg)": "pitch_deg",
    "Flight Path Angle (deg)": "fpa_deg",
    "Altitude (ft)": "altitude_ft",
    "Distance (ft)": "distance_ft",
}
REQUIRED = ("time_s", "mach", "thrust_lb", "weight_lb", "velocity_fps", "altitude_ft")


def read_rasaero_export(path: str | Path) -> pd.DataFrame:
    df = pd.read_csv(path)
    df.columns = [c.strip() for c in df.columns]
    norm = {}
    lowered = {k.lower(): v for k, v in RASAERO_COLUMNS.items()}
    for c in df.columns:
        if c in RASAERO_COLUMNS:
            norm[c] = RASAERO_COLUMNS[c]
        elif c.lower() in lowered:
            norm[c] = lowered[c.lower()]
        else:
            # tolerate small header variations: match on the leading word(s)
            key = c.lower().split("(")[0].strip()
            for k, v in RASAERO_COLUMNS.items():
                if k.lower().split("(")[0].strip() == key:
                    norm[c] = v
                    break
    df = df.rename(columns=norm)
    missing = [c for c in REQUIRED if c not in df.columns]
    if missing:
        raise ValueError(f"{path}: export is missing columns {missing}; found {list(df.columns)}")
    for c in df.columns:
        if c != "stage":
            df[c] = pd.to_numeric(df[c], errors="coerce")
    return df.dropna(subset=["time_s"]).reset_index(drop=True)


# ---- event detection -------------------------------------------------------

def burnout_time(h: pd.DataFrame, thrust_eps: float = 0.5) -> float:
    """First time the (booster) thrust goes to ~zero after having been positive."""
    thr = h["thrust_lb"].to_numpy()
    t = h["time_s"].to_numpy()
    on = np.flatnonzero(thr > thrust_eps)
    if len(on) == 0:
        raise ValueError("no thrust in history")
    first = on[0]
    off = np.flatnonzero(thr[first:] <= thrust_eps)
    if len(off) == 0:
        raise ValueError("booster never burns out in history")
    return float(t[first + off[0]])


def ignition_time(h: pd.DataFrame, after: float, thrust_eps: float = 0.5) -> float | None:
    """First time thrust reappears after `after` (sustainer ignition)."""
    m = (h["time_s"] > after) & (h["thrust_lb"] > thrust_eps)
    idx = np.flatnonzero(m.to_numpy())
    return float(h["time_s"].iloc[idx[0]]) if len(idx) else None


def separation_time(h: pd.DataFrame, after: float) -> float | None:
    """Separation = the Stage column changing, else a step drop in weight."""
    t = h["time_s"].to_numpy()
    if "stage" in h.columns:
        st = h["stage"].astype(str).str.strip().to_numpy()
        start = st[np.searchsorted(t, after, side="left") - 1] if after > t[0] else st[0]
        changed = np.flatnonzero((t >= after * 0.999) & (st != start))
        if len(changed):
            return float(t[changed[0]])
    w = h["weight_lb"].to_numpy()
    dw = np.diff(w)
    # propellant burn is smooth; a stage drop is a large single-step decrease
    big = np.flatnonzero((dw < -0.05 * w[0]) & (t[1:] >= after))
    return float(t[big[0] + 1]) if len(big) else None


def value_at(h: pd.DataFrame, col: str, t: float) -> float:
    return float(np.interp(t, h["time_s"].to_numpy(), h[col].to_numpy()))


def first_time_below(h: pd.DataFrame, col: str, level: float, after: float) -> float | None:
    """First time after `after` where the series drops below `level`."""
    t = h["time_s"].to_numpy()
    v = h[col].to_numpy()
    m = np.flatnonzero((t >= after) & (v < level))
    if len(m) == 0:
        return None
    i = m[0]
    if i == 0 or t[i - 1] < after:
        return float(t[i])
    # linear interpolation for the crossing
    t0, t1, v0, v1 = t[i - 1], t[i], v[i - 1], v[i]
    return float(t0 + (level - v0) * (t1 - t0) / (v1 - v0)) if v1 != v0 else float(t[i])


def rail_exit_velocity(h: pd.DataFrame, rod_length_ft: float | None) -> float | None:
    if not rod_length_ft:
        return None
    dist = np.hypot(h["altitude_ft"].to_numpy(), h.get("distance_ft", pd.Series(np.zeros(len(h)))).to_numpy())
    idx = np.flatnonzero(dist >= rod_length_ft)
    return float(h["velocity_fps"].iloc[idx[0]]) if len(idx) else None


def apogee(h: pd.DataFrame) -> tuple[float, float]:
    alt = h["altitude_ft"].to_numpy()
    i = int(np.argmax(alt))
    return float(alt[i]), float(h["time_s"].to_numpy()[i])
