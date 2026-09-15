"""Booster characterization and the transonic-separation rules.

Two requested profile types:
  subsonic    - the booster (stack) never exceeds Mach 0.9; separation is then
                free of the transonic band by construction.
  supersonic  - the stack exceeds Mach 1.2 and separation happens while still
                above Mach 1.2.
Optional, off by default (not one of the two requested profiles):
  decel_subsonic - the stack goes supersonic during boost, coasts *attached*
                back down through the transonic band, and separates once below
                Mach 0.9.

RASAero measures Booster1SeparationDelay from booster burnout and
SustainerIgnitionDelay from *separation* (verified from its exports); the
characterization run re-checks that from the exported history (Stage column /
thrust reappearing) so a change of convention is caught.
"""

from __future__ import annotations

import math

import pandas as pd

from . import history as H
from .models import SUBSONIC, SUPERSONIC, Characterization, ProfileEligibility

DECEL_SUBSONIC = "decel_subsonic"


def characterize(booster: str, h: pd.DataFrame, cfg: dict, expected_sep_delay: float, expected_ign_delay: float, rod_length_ft: float | None, sustainer: str = "") -> Characterization:
    p = cfg["profiles"]
    m_super = p["supersonic_min_mach"] + p["mach_margin"]
    m_sub = p["subsonic_max_mach"] - p["mach_margin"]

    t_bo = H.burnout_time(h)
    boost = h[h["time_s"] <= t_bo]
    i_max = int(boost["mach"].idxmax())
    t_sep = H.separation_time(h, after=t_bo)
    t_ign = H.ignition_time(h, after=t_bo)

    # Only the *attached-stack* coast tells us about separation Mach, so stop at
    # the observed separation if RASAero separated earlier than we asked.
    t_end = t_sep if t_sep is not None else float(h["time_s"].iloc[-1])
    stack = h[h["time_s"] <= t_end]

    consistent = True
    notes = []
    if t_sep is not None and abs(t_sep - (t_bo + expected_sep_delay)) > 0.15:
        consistent = False
        notes.append(f"separation observed at {t_sep:.2f}s, expected burnout {t_bo:.2f}+{expected_sep_delay}={t_bo + expected_sep_delay:.2f}s")
    t_ign_expected = t_bo + expected_sep_delay + expected_ign_delay
    if t_ign is not None and abs(t_ign - t_ign_expected) > 0.15:
        consistent = False
        notes.append(f"sustainer ignition observed at {t_ign:.2f}s, expected separation+{expected_ign_delay}={t_ign_expected:.2f}s")

    return Characterization(
        booster=booster,
        t_burnout_s=round(t_bo, 3),
        max_mach_boost=round(float(h["mach"].loc[i_max]), 4),
        t_max_mach_s=round(float(h["time_s"].loc[i_max]), 3),
        mach_burnout=round(H.value_at(h, "mach", t_bo), 4),
        alt_burnout_ft=round(H.value_at(h, "altitude_ft", t_bo), 1),
        vel_burnout_fps=round(H.value_at(h, "velocity_fps", t_bo), 1),
        rail_exit_vel_fps=(round(v, 1) if (v := H.rail_exit_velocity(h, rod_length_ft)) is not None else None),
        t_below_supersonic_s=(round(x, 3) if (x := H.first_time_below(stack, "mach", m_super, after=t_bo)) is not None else None),
        t_below_subsonic_s=(round(x, 3) if (x := H.first_time_below(stack, "mach", m_sub, after=t_bo)) is not None else None),
        sep_time_observed_s=(round(t_sep, 3) if t_sep is not None else None),
        ign_time_observed_s=(round(t_ign, 3) if t_ign is not None else None),
        events_consistent=consistent,
        note="; ".join(notes),
        sustainer=sustainer,
    )


def mach_at_burnout(h: pd.DataFrame) -> float:
    return H.value_at(h, "mach", H.burnout_time(h))


def eligibility(c: Characterization, h: pd.DataFrame, cfg: dict) -> list[ProfileEligibility]:
    """Which profiles this booster can fly, and the separation-delay window
    (user range intersected with the physics of the boost phase) to search."""
    p = cfg["profiles"]
    margin = p["mach_margin"]
    m_super = p["supersonic_min_mach"] + margin
    m_sub = p["subsonic_max_mach"] - margin
    lo, hi = float(p["separation_delay_min_s"]), float(p["separation_delay_max_s"])
    m_bo = mach_at_burnout(h)
    out = []

    # --- subsonic: whole boost below 0.9 -> any separation delay in the window ---
    if c.max_mach_boost <= m_sub:
        out.append(ProfileEligibility(c.booster, SUBSONIC, True, lo, hi, None, f"peak boost Mach {c.max_mach_boost:.3f} <= {m_sub:.2f}; separation {lo:g}-{hi:g}s after burnout"))
    else:
        out.append(ProfileEligibility(c.booster, SUBSONIC, False, lo, hi, None, f"peak boost Mach {c.max_mach_boost:.3f} > {m_sub:.2f} (stack goes transonic/supersonic during boost)"))

    # supersonic: separate while still above 1.2, no later than the window closes
    if c.max_mach_boost < m_super:
        out.append(ProfileEligibility(c.booster, SUPERSONIC, False, lo, hi, None, f"peak boost Mach {c.max_mach_boost:.3f} < {m_super:.2f} (never clearly supersonic)"))
    elif m_bo < m_super:
        out.append(ProfileEligibility(c.booster, SUPERSONIC, False, lo, hi, None, f"peaks at Mach {c.max_mach_boost:.3f} at t={c.t_max_mach_s}s but already down to Mach {m_bo:.3f} at burnout ({c.t_burnout_s}s); separation after burnout would be transonic"))
    else:
        window = (c.t_below_supersonic_s - c.t_burnout_s) if c.t_below_supersonic_s is not None else math.inf
        w = round(window, 3) if math.isfinite(window) else None
        if lo > window:
            out.append(ProfileEligibility(c.booster, SUPERSONIC, False, lo, hi, w, f"Mach falls below {m_super:.2f} only {window:.2f}s after burnout, before the earliest allowed separation ({lo:g}s): lower profiles.separation_delay_min_s"))
        else:
            top = min(hi, window)
            out.append(ProfileEligibility(c.booster, SUPERSONIC, True, lo, round(top, 3), w, f"Mach at burnout {m_bo:.3f}; separation must be within {window:.2f}s of burnout -> window {lo:g}-{top:g}s"))

    # --- optional third variant: coast attached until subsonic, then separate ---
    if p.get("include_decel_subsonic", False):
        if c.max_mach_boost <= m_sub:
            out.append(ProfileEligibility(c.booster, DECEL_SUBSONIC, False, lo, hi, None, "stack is subsonic anyway - use the subsonic profile"))
        elif c.t_below_subsonic_s is None:
            out.append(ProfileEligibility(c.booster, DECEL_SUBSONIC, False, lo, hi, None, f"stack never decelerates below Mach {m_sub:.2f} before the characterization separation"))
        else:
            need = c.t_below_subsonic_s - c.t_burnout_s
            earliest = max(lo, math.ceil(need * 10.0) / 10.0)
            if earliest > hi:
                out.append(ProfileEligibility(c.booster, DECEL_SUBSONIC, False, lo, hi, round(need, 3), f"stack drops below Mach {m_sub:.2f} only {need:.2f}s after burnout, after the latest allowed separation ({hi:g}s): raise profiles.separation_delay_max_s"))
            else:
                out.append(ProfileEligibility(c.booster, DECEL_SUBSONIC, True, earliest, hi, round(need, 3), f"stack drops below Mach {m_sub:.2f} {need:.2f}s after burnout -> separation window {earliest:g}-{hi:g}s (attached stack crosses the transonic band twice)"))
    for e in out:
        e.sustainer = c.sustainer
    return out
