"""Shared data records passed between pipeline stages."""

from __future__ import annotations

from dataclasses import asdict, dataclass, field, fields
from typing import Any

SUBSONIC = "subsonic"
SUPERSONIC = "supersonic"
PROFILES = (SUBSONIC, SUPERSONIC)


@dataclass
class MassRow:
    """Mass properties RASAero needs, per (booster, sustainer) pair."""

    booster: str
    sustainer_wt_lb: float
    sustainer_cg_in: float
    combined_wt_lb: float
    combined_cg_in: float
    booster_prop_kg: float
    sustainer: str  # label
    # how the loaded weights were built (informational)
    sustainer_dry_lb: float | None = None
    booster_dry_lb: float | None = None
    hardware_mass_lb: float | None = None  # mass_model.hardware_mass_lb used, None = .ork masses as-is

    @property
    def key(self) -> tuple[str, str]:
        return (self.booster, self.sustainer)


@dataclass
class SimRow:
    """One RASAero <Simulation> row: inputs plus (after the run) summary results."""

    booster: str
    profile: str | None
    sep_delay_s: float
    ign_delay_s: float
    sustainer_engine: str
    booster_engine: str
    sustainer_wt_lb: float
    sustainer_cg_in: float
    sustainer_nozzle_in: float
    combined_wt_lb: float
    combined_cg_in: float
    booster_nozzle_in: float
    sustainer: str  # label of the sustainer motor flown
    # results
    max_alt_ft: float | None = None
    max_vel_fps: float | None = None
    t_apogee_s: float | None = None
    round: int = 0
    tag: str = ""

    def __post_init__(self):
        if not self.tag:
            prof = self.profile or "char"
            self.tag = f"{self.booster}+{self.sustainer}|{prof}|sep={self.sep_delay_s:.2f}|ign={self.ign_delay_s:.2f}"

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)

    @classmethod
    def from_dict(cls, d: dict[str, Any]) -> SimRow:
        names = {f.name for f in fields(cls)}
        return cls(**{k: v for k, v in d.items() if k in names})


@dataclass
class Characterization:
    """What one long-coast run tells us about a (booster, sustainer) stack."""

    booster: str
    t_burnout_s: float
    max_mach_boost: float
    t_max_mach_s: float
    mach_burnout: float
    alt_burnout_ft: float
    vel_burnout_fps: float
    rail_exit_vel_fps: float | None
    # first time after burnout the stack drops below each level (None = never above)
    t_below_supersonic_s: float | None
    t_below_subsonic_s: float | None
    sep_time_observed_s: float | None
    ign_time_observed_s: float | None
    events_consistent: bool
    note: str = ""
    sustainer: str = ""

    def to_dict(self):
        return asdict(self)


@dataclass
class ProfileEligibility:
    booster: str
    profile: str
    eligible: bool
    sep_min_s: float  # allowed separation delay: user range intersected with physics
    sep_max_s: float
    sep_window_max_s: float | None = None  # physics limit: latest supersonic sep, or earliest decel
    reason: str = ""
    sustainer: str = ""

    def to_dict(self):
        return asdict(self)


@dataclass
class Design:
    """A (booster, sustainer, profile, delays) solution that hits the target apogee."""

    booster: str
    profile: str
    sep_delay_s: float
    ign_delay_s: float
    apogee_ft: float
    status: str  # solved | underpowered | overpowered | unsolved | infeasible
    sustainer: str
    n_sims: int = 0
    apogee_min_delay_ft: float | None = None
    apogee_max_delay_ft: float | None = None
    # verification (from the time-history export)
    mach_at_sep: float | None = None
    vel_at_ign_fps: float | None = None
    mach_at_ign: float | None = None
    alt_at_ign_ft: float | None = None
    max_vel_fps: float | None = None
    max_mach: float | None = None
    max_accel_g: float | None = None
    t_apogee_s: float | None = None
    rail_exit_vel_fps: float | None = None
    verified_ok: bool | None = None
    verify_note: str = ""
    hint: str = ""
    extra: dict = field(default_factory=dict)

    @property
    def key(self) -> str:
        return f"{self.booster}|{self.sustainer}|{self.profile}"

    def to_dict(self):
        d = asdict(self)
        d.pop("extra")
        return d
