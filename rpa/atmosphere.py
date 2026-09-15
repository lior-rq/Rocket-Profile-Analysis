"""Atmosphere for the Python flight simulator.

US Standard Atmosphere 1976 shape, anchored to the launch site the way the
RASAero launch-site inputs describe it: the site temperature is the
temperature at the pad, the standard lapse rate applies above it, and the
site pressure is the barometric (sea-level reduced) reading unless
`pressure_is_sea_level` is false, in which case it is the station pressure.
Everything is in English engineering units (ft, lbf, slug, deg R).

The exact anchoring convention RASAero uses is confirmed by the validation
stage (Mach column at equal velocity/altitude), not assumed here.
"""

from __future__ import annotations

from dataclasses import dataclass

import numpy as np

G0 = 32.174  # ft/s^2
R_AIR = 1716.49  # ft*lbf/(slug*degR)
GAMMA = 1.4
LAPSE_R_PER_FT = 0.00356616  # degR per ft, troposphere
TROPOPAUSE_FT = 36089.24
STD_T0_R = 518.67
STD_P0_PSF = 2116.22
INHG_TO_PSF = 70.7262


def _std_pressure_ratio(h_ft: float) -> float:
    """p(h)/p(0) for the 1976 standard atmosphere (first two layers)."""
    if h_ft <= TROPOPAUSE_FT:
        return (1.0 - LAPSE_R_PER_FT * h_ft / STD_T0_R) ** (G0 / (LAPSE_R_PER_FT * R_AIR))
    p11 = (1.0 - LAPSE_R_PER_FT * TROPOPAUSE_FT / STD_T0_R) ** (G0 / (LAPSE_R_PER_FT * R_AIR))
    t11 = STD_T0_R - LAPSE_R_PER_FT * TROPOPAUSE_FT
    return p11 * np.exp(-G0 * (h_ft - TROPOPAUSE_FT) / (R_AIR * t11))


@dataclass
class Atmosphere:
    """density_model:
        'rasaero'     - density falls as (T/T_pad)^density_exponent, which is
                        what RASAero II's exports show (exponent ~5.05 fitted
                        from the Drag/CD/velocity columns; the hydrostatic
                        value would be g/(L R) - 1 = 4.26). Default.
        'hydrostatic' - textbook hydrostatic integration of the local profile.
    """

    site_alt_ft: float  # MSL elevation of the pad
    site_temp_f: float
    site_pressure_inhg: float
    pressure_is_sea_level: bool = True
    density_model: str = "rasaero"
    density_exponent: float = 5.05
    calibration: tuple | None = None  # (altitude_agl_ft[], density[]) for density_model='calibrated'
    max_alt_agl_ft: float = 200_000.0
    step_ft: float = 50.0

    def __post_init__(self):
        t_site = self.site_temp_f + 459.67
        p_site = self.site_pressure_inhg * INHG_TO_PSF
        if self.pressure_is_sea_level:
            p_site *= _std_pressure_ratio(self.site_alt_ft)
        h = np.arange(0.0, self.max_alt_agl_ft + self.step_ft, self.step_ft)
        # temperature: site value with the standard lapse. RASAero keeps the
        # lapse going past the standard tropopause on a hot day (verified to
        # 36 000 ft AGL / 39 000 ft MSL at 110 F), so the profile only goes
        # isothermal once it reaches the standard stratosphere temperature.
        t_trop = STD_T0_R - LAPSE_R_PER_FT * TROPOPAUSE_FT  # 389.97 R
        t = np.maximum(t_site - LAPSE_R_PER_FT * h, t_trop)
        rho_site = p_site / (R_AIR * t_site)

        def rasaero_profile() -> np.ndarray:
            """rho_site * (T/T_site)^n in the lapse layer, exponential (local scale height) above it."""
            rho = rho_site * (t / t_site) ** self.density_exponent
            above = t <= t_trop + 1e-9
            if above.any() and not above[0]:
                i0 = int(np.argmax(above))
                rho[above] = rho[i0 - 1] * np.exp(-G0 * (h[above] - h[i0 - 1]) / (R_AIR * t_trop))
            return rho

        if self.density_model == "hydrostatic":
            tm = 0.5 * (t[1:] + t[:-1])
            p = p_site * np.concatenate([[1.0], np.exp(np.cumsum(-G0 * self.step_ft / (R_AIR * tm)))])
            rho = p / (R_AIR * t)
        elif self.density_model == "calibrated":
            # density profile measured from RASAero exports (see calibrate_density);
            # below/above the measured range fall back to the 'rasaero' form
            rho = rasaero_profile()
            if self.calibration is not None:
                hc, rc = self.calibration
                inside = (h >= hc[0]) & (h <= hc[-1])
                rho[inside] = np.exp(np.interp(h[inside], hc, np.log(rc)))
                # above the measured range: use the last bins' local scale height
                if (h > hc[-1]).any():
                    hi = h > hc[-1]
                    H = (hc[-1] - hc[-2]) / np.log(rc[-2] / rc[-1]) if rc[-1] < rc[-2] else R_AIR * t_trop / G0
                    rho[hi] = rc[-1] * np.exp(-(h[hi] - hc[-1]) / H)
            p = rho * R_AIR * t
        elif self.density_model == "rasaero":
            rho = rasaero_profile()
            p = rho * R_AIR * t
        else:
            raise ValueError(f"unknown density_model {self.density_model!r}")
        self._h, self._t, self._p = h, t, p
        self._rho = rho
        self._a = np.sqrt(GAMMA * R_AIR * t)

    # the tabulated profile (uniform grid from 0 ft AGL in step_ft) for fast lookups
    @property
    def rho_table(self) -> np.ndarray:
        return self._rho

    @property
    def a_table(self) -> np.ndarray:
        return self._a

    @property
    def p_table(self) -> np.ndarray:
        return self._p

    def temperature_r(self, h_agl_ft: float) -> float:
        return float(np.interp(h_agl_ft, self._h, self._t))

    def pressure_psf(self, h_agl_ft: float) -> float:
        return float(np.interp(h_agl_ft, self._h, self._p))

    def density(self, h_agl_ft: float) -> float:
        """slug/ft^3"""
        return float(np.interp(h_agl_ft, self._h, self._rho))

    def speed_of_sound(self, h_agl_ft: float) -> float:
        """ft/s"""
        return float(np.interp(h_agl_ft, self._h, self._a))

    def rho_and_a(self, h_agl_ft: float) -> tuple[float, float]:
        return self.density(h_agl_ft), self.speed_of_sound(h_agl_ft)

    @classmethod
    def from_site(cls, site: dict, pressure_is_sea_level: bool = True, density_model: str = "rasaero", density_exponent: float = 5.05, calibration=None) -> Atmosphere:
        return cls(
            site_alt_ft=float(site.get("altitude_ft") or 0.0),
            site_temp_f=float(site.get("temperature_f") if site.get("temperature_f") is not None else 59.0),
            site_pressure_inhg=float(site.get("pressure_inhg") if site.get("pressure_inhg") is not None else 29.92),
            pressure_is_sea_level=pressure_is_sea_level,
            density_model=density_model,
            density_exponent=density_exponent,
            calibration=calibration,
        )


def calibrate_density(histories, ref_area_ft2: float, bin_ft: float = 500.0, min_samples: int = 5):
    """Air density vs altitude AGL as RASAero actually used it, recovered from
    exported time histories: rho = 2 D / (V^2 S CD) on coasting samples
    (no thrust, V > 150 ft/s, D > 0.2 lbf). Returns (alt_ft[], rho[]) binned,
    or None if there is not enough data. RASAero's density model could not be
    matched by any textbook formula to better than ~3 %, but it is a smooth
    function of altitude that depends only on the launch-site inputs, so it
    is measured once per site and interpolated."""
    alts, rhos = [], []
    for h in histories:
        m = (h["thrust_lb"] <= 0.5) & (h["velocity_fps"] > 150.0) & (h["drag_lb"] > 0.2) & (h["cd"] > 0.05) & (h["altitude_ft"] > 0)
        if not m.any():
            continue
        sub = h[m]
        alts.append(sub["altitude_ft"].to_numpy(float))
        rhos.append(2.0 * sub["drag_lb"].to_numpy(float) / (sub["velocity_fps"].to_numpy(float) ** 2 * ref_area_ft2 * sub["cd"].to_numpy(float)))
    if not alts:
        return None
    a = np.concatenate(alts)
    r = np.concatenate(rhos)
    bins = np.floor(a / bin_ft).astype(int)
    out_h, out_r = [], []
    for b in np.unique(bins):
        sel = bins == b
        if sel.sum() >= min_samples:
            out_h.append(float(np.median(a[sel])))
            out_r.append(float(np.median(r[sel])))
    if len(out_h) < 3:
        return None
    return np.array(out_h), np.array(out_r)
