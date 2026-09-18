"""RASAero II's atmosphere, ported from its engine (class `ab` in the
decompiled exe) so the Python flight simulator sees the same air.

Site inputs anchor three altitude offsets: the launch-site Pressure is
treated as a barometric reading (its pressure altitude is added to the
pad elevation), the site Temperature sets a temperature-altitude offset
and, with the pressure, the pad density and a density-altitude offset.
Density, pressure and temperature then follow RASAero's own piecewise
curves of (offset + altitude AGL). Density never depends on the
temperature except through the pad value; the temperature only sets the
speed of sound. English engineering units: ft, psi, slug/ft^3, deg R.
"""

from __future__ import annotations

import math
from dataclasses import dataclass

G0 = 32.174  # ft/s^2, the rail / weight constant
R_EARTH_FT = 20925738.0  # RASAero's earth radius for the gravity fall-off
STD_P0_PSI = 14.6958
INHG_TO_PSI = 0.49117


def gravity(alt_agl_ft: float, site_alt_ft: float) -> float:
    """RASAero's g(h) once off the rail: inverse square from the site."""
    return 32.17399978637695 * (R_EARTH_FT / (alt_agl_ft + R_EARTH_FT + site_alt_ft)) ** 2


def temperature_r(x: float) -> float:
    """deg R at temperature altitude x (offset + AGL)."""
    if x < 36000.0:
        return 518.69 * (1.0 - x * 6.944e-06)
    if x <= 65800.0:
        return 389.97
    if x < 105000.0:
        return 389.97 + 0.000543852 * (x - 65800.0)
    if x < 155500.0:
        return 411.289 + 0.001502594 * (x - 105000.0)
    if x <= 172000.0:
        return 487.17
    if x < 200000.0:
        return 487.17 - 0.0010775 * (x - 172000.0)
    if x < 262500.0:
        return 457.0 - 0.00210928 * (x - 200000.0)
    if x <= 295000.0:
        return 325.17
    if x >= 300000.0:
        return 332.9
    return 325.17 + 0.001546 * (x - 295000.0)


def density(y: float) -> float:
    """slug/ft^3 at density altitude y (offset + AGL). Piecewise, with the
    small jumps RASAero has at 16 000 and 36 000 ft."""
    if y <= 16000.0:
        return 0.002378 * (1.0 - y * 2.5e-05)
    if y <= 36000.0:
        return 0.002378 * (1.0 - y * 6.944e-06) ** 4.2561
    if y < 46000.0:
        return 0.002378 * (0.3 - 1.1579e-05 * (y - 36000.0))
    return 0.00046227 * math.exp(-4.7823e-05 * (y - 45000.0))


def viscosity(y: float) -> float:
    """Kinematic viscosity ft^2/s at density altitude y (offset + AGL)."""
    if y <= 29500.0:
        return 0.00015723 + 5.7908e-09 * y
    if y < 80000.0:
        return 8.2492e-05 * 10.0 ** (2.0265e-05 * y)
    if y < 146000.0:
        return 7.4809e-05 * 10.0 ** (2.0971e-05 * y)
    return 0.00039234 * 10.0 ** (1.6057e-05 * y)


def pressure_psi(z: float) -> float:
    """psi at pressure altitude z (offset + AGL)."""
    if z <= 36089.0:
        return STD_P0_PSI * (1.0 - 6.8735e-06 * z) ** 5.2561
    if z <= 82021.0:
        return 3.2824244964 * math.exp(-4.80634e-05 * (z - 36089.24))
    if z <= 160000.0:
        return 3.2824244964 * math.exp(-4.80634e-05 * (z - 36089.24 - 0.128239654 * (z - 82021.0)))
    return 3.2824244964 * math.exp(-4.80634e-05 * (z - 46098.24))


@dataclass
class Atmosphere:
    site_alt_ft: float
    site_temp_f: float
    site_pressure_inhg: float

    def __post_init__(self):
        p = self.site_pressure_inhg * INHG_TO_PSI
        if p == 0.0:
            p = STD_P0_PSI * (1.0 - 6.8753e-06 * self.site_alt_ft) ** 5.2561
            z0 = self.site_alt_ft
        else:
            z0 = self.site_alt_ft + ((p / STD_P0_PSI) ** 0.19026 - 1.0) / -6.87535e-06
            p = STD_P0_PSI * (1.0 - 6.87535e-06 * z0) ** 5.2561
        t = self.site_temp_f + 459.69
        rho = 1.0 / (1716.4829 * t / (p * 144.0))
        self.pad_pressure_psi = p
        self.pad_density = rho
        self.density_offset_ft = (rho / 0.002378 - 1.0) * -40000.0
        self.temperature_offset_ft = (t / 518.69 - 1.0) * -144000.0
        self.pressure_offset_ft = z0

    def state(self, h_agl_ft: float) -> tuple[float, float, float]:
        """(density slug/ft^3, speed of sound ft/s, pressure psi) at h."""
        t = temperature_r(self.temperature_offset_ft + h_agl_ft)
        return density(self.density_offset_ft + h_agl_ft), math.sqrt(2403.07606 * t), pressure_psi(self.pressure_offset_ft + h_agl_ft)

    def temperature_r(self, h_agl_ft: float) -> float:
        return temperature_r(self.temperature_offset_ft + h_agl_ft)

    def pressure_psi(self, h_agl_ft: float) -> float:
        return pressure_psi(self.pressure_offset_ft + h_agl_ft)

    def pressure_psf(self, h_agl_ft: float) -> float:
        return 144.0 * self.pressure_psi(h_agl_ft)

    def density(self, h_agl_ft: float) -> float:
        return density(self.density_offset_ft + h_agl_ft)

    def speed_of_sound(self, h_agl_ft: float) -> float:
        return math.sqrt(2403.07606 * self.temperature_r(h_agl_ft))

    def rho_and_a(self, h_agl_ft: float) -> tuple[float, float]:
        return self.density(h_agl_ft), self.speed_of_sound(h_agl_ft)

    def gravity(self, h_agl_ft: float) -> float:
        return gravity(h_agl_ft, self.site_alt_ft)

    def viscosity(self, h_agl_ft: float) -> float:
        return viscosity(self.density_offset_ft + h_agl_ft)

    def reynolds_factor(self, h_agl_ft: float) -> float:
        """Re / (Mach * length[ft]) = speed of sound / kinematic viscosity."""
        return self.speed_of_sound(h_agl_ft) / self.viscosity(h_agl_ft)

    @classmethod
    def standard(cls) -> Atmosphere:
        """The atmosphere RASAero's Aero Plots use: no site, every offset 0."""
        a = cls(0.0, 59.0, 0.0)
        a.density_offset_ft = a.temperature_offset_ft = a.pressure_offset_ft = 0.0
        return a

    @classmethod
    def from_site(cls, site: dict) -> Atmosphere:
        return cls(
            site_alt_ft=float(site.get("altitude_ft") or 0.0),
            site_temp_f=float(site.get("temperature_f") if site.get("temperature_f") is not None else 59.0),
            site_pressure_inhg=float(site.get("pressure_inhg") if site.get("pressure_inhg") is not None else 29.92),
        )
