"""Vehicle mass model: the OpenRocket model supplies the *shape* of the mass
distribution (how the dry mass splits between stages, where the CGs are,
where the propellant sits) and the .eng files the propellant masses. The
absolute dry mass can be overridden with `mass_model.hardware_mass_lb`
(default 180 lb): the OpenRocket dry masses of both stages are scaled by one
factor so that the whole two-stage vehicle weighs that much without
propellant, and the loaded weights / CGs RASAero needs are recombined from
the scaled structure and the unscaled propellant. `null` keeps the .ork
masses as they are.

Pure arithmetic, no JVM: everything OpenRocket-specific lives in
rpa.openrocket, which just hands over the four mass/CG pairs.
"""

from __future__ import annotations

from dataclasses import dataclass

from .models import MassRow


@dataclass
class StageMasses:
    """Mass/CG pairs from OpenRocket (lb, inches from the nose tip)."""

    sustainer_dry_lb: float
    sustainer_dry_cg_in: float
    stack_dry_lb: float          # both stages, no propellant
    stack_dry_cg_in: float
    sustainer_loaded_lb: float   # sustainer + its propellant
    sustainer_loaded_cg_in: float
    stack_loaded_lb: float       # everything, both motors loaded
    stack_loaded_cg_in: float

    @property
    def sustainer_prop_lb(self) -> float:
        return self.sustainer_loaded_lb - self.sustainer_dry_lb

    @property
    def sustainer_prop_cg_in(self) -> float:
        return _cg_of_difference(self.sustainer_loaded_lb, self.sustainer_loaded_cg_in, self.sustainer_dry_lb, self.sustainer_dry_cg_in)

    @property
    def booster_prop_lb(self) -> float:
        return self.stack_loaded_lb - self.stack_dry_lb - self.sustainer_prop_lb

    @property
    def booster_prop_cg_in(self) -> float:
        # stack loaded = stack dry + sustainer prop + booster prop
        m_rest = self.stack_dry_lb + self.sustainer_prop_lb
        x_rest = (self.stack_dry_lb * self.stack_dry_cg_in + self.sustainer_prop_lb * self.sustainer_prop_cg_in) / m_rest
        return _cg_of_difference(self.stack_loaded_lb, self.stack_loaded_cg_in, m_rest, x_rest)

    @property
    def booster_dry_lb(self) -> float:
        return self.stack_dry_lb - self.sustainer_dry_lb


def _cg_of_difference(m_total: float, x_total: float, m_part: float, x_part: float) -> float:
    """CG of (total - part)."""
    m = m_total - m_part
    if m <= 1e-9:
        return x_total
    return (m_total * x_total - m_part * x_part) / m


def mass_row(booster_label: str, sm: StageMasses, booster_prop_kg: float, hardware_mass_lb: float | None, sustainer_label: str) -> MassRow:
    """The RASAero row masses for one (booster, sustainer) pair, with the dry
    mass optionally forced to `hardware_mass_lb` (both stages scaled by the
    same factor)."""
    f = 1.0 if hardware_mass_lb is None else float(hardware_mass_lb) / sm.stack_dry_lb
    s_dry, b_dry = f * sm.sustainer_dry_lb, f * sm.booster_dry_lb
    s_wt = s_dry + sm.sustainer_prop_lb
    s_cg = (s_dry * sm.sustainer_dry_cg_in + sm.sustainer_prop_lb * sm.sustainer_prop_cg_in) / s_wt
    c_wt = f * sm.stack_dry_lb + sm.sustainer_prop_lb + sm.booster_prop_lb
    c_cg = (f * sm.stack_dry_lb * sm.stack_dry_cg_in + sm.sustainer_prop_lb * sm.sustainer_prop_cg_in + sm.booster_prop_lb * sm.booster_prop_cg_in) / c_wt
    return MassRow(
        booster=booster_label,
        sustainer_wt_lb=round(s_wt, 3),
        sustainer_cg_in=round(s_cg, 3),
        combined_wt_lb=round(c_wt, 3),
        combined_cg_in=round(c_cg, 3),
        booster_prop_kg=booster_prop_kg,
        sustainer_dry_lb=round(s_dry, 3),
        booster_dry_lb=round(b_dry, 3),
        hardware_mass_lb=None if hardware_mass_lb is None else float(hardware_mass_lb),
        sustainer=sustainer_label,
    )
