"""Planar 3-DOF (point mass, gravity turn) two-stage trajectory integrator.

Replaces the RASAero GUI inside the search loop. Uses RASAero's own aero
tables (rpa.aero), its launch-site atmosphere conventions (rpa.atmosphere),
the .eng thrust curves and the OpenRocket mass numbers. rpa.validate checks
it term by term against RASAero exports.

Model
  * zero wind, zero angle of attack: thrust and drag act along the velocity
    vector; gravity turns the flight path (RASAero at WindSpeed=0 does the same)
  * launch rail: while the distance travelled is less than RodLength, thrust
    and drag act along the rod (RodAngle from vertical) but gravity acts
    fully vertically - RASAero's model, verified from its exports: the
    velocity vector leaves the rail ~0.3 deg below the rod angle, which
    shows up as ~8 % more downrange velocity for the rest of the flight
  * thrust: the .eng curve (sea-level) plus RASAero's altitude correction
    (p_sea_level - p_ambient) * nozzle exit area, verified against exports
  * mass: launch weight minus propellant consumed in proportion to impulse
    delivered (the RASAero 'Weight' column convention)
  * events: booster burnout = end of the booster thrust curve; separation is
    a delay after burnout and sustainer ignition a delay after *separation*
    (RASAero's convention, verified from its exports)
  * drag: CD(Mach, altitude, power-on/off) from the tables of the current
    configuration (stack until separation, sustainer alone afterwards)
  * fixed-step RK4; the run stops at apogee
"""

from __future__ import annotations

import math
from dataclasses import dataclass

import numpy as np
import pandas as pd

from .aero import STACK, SUSTAINER, AeroModel, AeroSet
from .atmosphere import G0, STD_P0_PSF, Atmosphere
from .eng import Motor

N_TO_LBF = 0.2248089
KG_TO_LB = 2.2046226
MAX_TABLE_MACH = 8.0  # CD grid cutoff; vehicle never gets near it (RASAero exports to Mach 25)


def ref_area_ft2(diameter_in: float) -> float:
    """Reference area from the body diameter (RASAero convention)."""
    return math.pi * (diameter_in / 12.0) ** 2 / 4.0


@dataclass
class Vehicle:
    booster: Motor
    sustainer: Motor
    combined_wt_lb: float  # liftoff weight, both stages, all propellant
    sustainer_wt_lb: float  # sustainer alone with its propellant
    ref_diameter_in: float
    booster_nozzle_in: float | None = None
    sustainer_nozzle_in: float | None = None

    @property
    def ref_area_ft2(self) -> float:
        return ref_area_ft2(self.ref_diameter_in)


class _Curve:
    """Thrust [lbf] and delivered-impulse fraction of a motor sampled on a
    uniform time grid (t = 0, dt/2, dt, ...) for O(1) lookups."""

    def __init__(self, m: Motor, half_dt: float):
        t = np.concatenate([[0.0], m.time_s])
        f = np.concatenate([[0.0], m.thrust_n]) * N_TO_LBF
        imp = np.concatenate([[0.0], np.cumsum(0.5 * (f[1:] + f[:-1]) * np.diff(t))])
        total = imp[-1] if imp[-1] > 0 else 1.0
        n = math.ceil(t[-1] / half_dt) + 2
        grid = np.arange(n) * half_dt
        self.n = n
        self.burn_time = float(t[-1])
        self.thrust = np.interp(grid, t, f, right=0.0).tolist()
        self.frac = np.interp(grid, t, imp / total, right=1.0).tolist()


class _AtmLookup:
    """Density, speed of sound and pressure on the atmosphere's uniform
    altitude grid, interpolated together in pure Python (one index
    computation per call; called four times per integration step)."""

    def __init__(self, dx: float, rho: np.ndarray, a: np.ndarray, p: np.ndarray):
        self.dx = float(dx)
        self.rho, self.a, self.p = rho.tolist(), a.tolist(), p.tolist()
        self.n = len(self.rho)

    def __call__(self, h: float) -> tuple[float, float, float]:
        q = h / self.dx
        if q <= 0.0:
            return self.rho[0], self.a[0], self.p[0]
        i = int(q)
        if i >= self.n - 1:
            return self.rho[-1], self.a[-1], self.p[-1]
        w = q - i
        rho, a, p = self.rho, self.a, self.p
        return rho[i] + w * (rho[i + 1] - rho[i]), a[i] + w * (a[i + 1] - a[i]), p[i] + w * (p[i + 1] - p[i])


class _CdLookup:
    """CD on a uniform (Mach, altitude) grid for one configuration."""

    def __init__(self, model: AeroModel, dmach: float = 0.005, dalt: float = 1000.0, max_alt: float = 150_000.0):
        self.dm, self.da = dmach, dalt
        self.m_max = min(model.mach_max, MAX_TABLE_MACH)
        machs = np.arange(0.0, self.m_max + dmach, dmach)
        alts = np.arange(0.0, max_alt + dalt, dalt)
        self.nm, self.na = len(machs), len(alts)
        self.off = [model.cd_row(machs, a, False).tolist() for a in alts]
        self.on = [model.cd_row(machs, a, True).tolist() for a in alts]

    def __call__(self, mach: float, alt: float, power_on: bool) -> float:
        g = self.on if power_on else self.off
        pm = mach / self.dm
        i = int(pm)
        if i >= self.nm - 1:
            i, wm = self.nm - 1, 0.0
        else:
            wm = pm - i
        pa = alt / self.da
        if pa <= 0:
            j, wa = 0, 0.0
        else:
            j = int(pa)
            if j >= self.na - 1:
                j, wa = self.na - 1, 0.0
            else:
                wa = pa - j
        r0 = g[j]
        c0 = r0[i] + wm * (r0[i + 1] - r0[i]) if wm else r0[i]
        if not wa:
            return c0
        r1 = g[j + 1]
        c1 = r1[i] + wm * (r1[i + 1] - r1[i]) if wm else r1[i]
        return c0 + wa * (c1 - c0)


class FlightSim:
    def __init__(self, aero: AeroSet, site: dict, pressure_is_sea_level: bool = True, dt: float = 0.01, max_time_s: float = 400.0, density_model: str = "rasaero", density_exponent: float = 5.05, calibration=None):
        self.aero = aero
        self.site = site
        self.dt = float(dt)
        self.max_time_s = float(max_time_s)
        self.atm = Atmosphere.from_site(site, pressure_is_sea_level=pressure_is_sea_level, density_model=density_model, density_exponent=density_exponent, calibration=calibration)
        self.atm_lookup = _AtmLookup(self.atm.step_ft, self.atm.rho_table, self.atm.a_table, self.atm.p_table)
        self.rod_len = float(site.get("rod_length_ft") or 0.0)
        self.rod_angle = math.radians(float(site.get("rod_angle_deg") or 0.0))
        self._cd_cache: dict[tuple[str, float | None], _CdLookup] = {}

    def _cd(self, config: str, nozzle_in: float | None) -> _CdLookup:
        key = (config, None if nozzle_in is None else round(nozzle_in, 3))
        if key not in self._cd_cache:
            self._cd_cache[key] = _CdLookup(self.aero.model(config, nozzle_in))
        return self._cd_cache[key]

    def run(self, veh: Vehicle, sep_delay_s: float, ign_delay_s: float, history: bool = True) -> tuple[dict, pd.DataFrame | None]:
        """Fly one two-stage trajectory. `history=False` skips the per-step
        record (the search only needs the summary)."""
        dt = self.dt
        hdt = 0.5 * dt
        S = veh.ref_area_ft2
        bc = _Curve(veh.booster, hdt)
        sc = _Curve(veh.sustainer, hdt)
        t_bo = bc.burn_time
        # events snapped to the step grid
        k_sep = round((t_bo + sep_delay_s) / dt)
        k_ign = round((t_bo + sep_delay_s + ign_delay_s) / dt)
        cd_stack = self._cd(STACK, veh.booster_nozzle_in)
        cd_sus = self._cd(SUSTAINER, veh.sustainer_nozzle_in)
        w_bprop = veh.booster.prop_mass_kg * KG_TO_LB
        w_sprop = veh.sustainer.prop_mass_kg * KG_TO_LB
        w0 = veh.combined_wt_lb
        w_sus = veh.sustainer_wt_lb
        atm = self.atm_lookup
        a_exit_b = math.pi * ((veh.booster_nozzle_in or 0.0) / 12.0) ** 2 / 4.0
        a_exit_s = math.pi * ((veh.sustainer_nozzle_in or 0.0) / 12.0) ** 2 / 4.0
        rod_len, rod_ang = self.rod_len, self.rod_angle
        ux, uh = math.sin(rod_ang), math.cos(rod_ang)

        def thrust_weight(k2: int, pa: float):
            """thrust [lbf] at ambient pressure pa, weight [lb] at half-step index k2 (t = k2*dt/2)."""
            dp = STD_P0_PSF - pa  # altitude thrust correction
            thr = bc.thrust[k2] if k2 < bc.n else 0.0
            if thr > 0.0:
                thr += dp * a_exit_b
            if k2 >= 2 * k_ign:
                j = k2 - 2 * k_ign
                ts = sc.thrust[j] if j < sc.n else 0.0
                thr += ts + (dp * a_exit_s if ts > 0.0 else 0.0)
                fs = sc.frac[j] if j < sc.n else 1.0
            else:
                fs = 0.0
            fb = bc.frac[k2] if k2 < bc.n else 1.0
            if k2 >= 2 * k_sep:
                w = w_sus - w_sprop * fs
            else:
                w = w0 - w_bprop * fb - w_sprop * fs
            return thr, w

        def accel(k2: int, x: float, h: float, vx: float, vh: float, on_rail: bool):
            hh = h if h > 0.0 else 0.0
            r, a_s, pa = atm(hh)
            thr, w = thrust_weight(k2, pa)
            m = w / G0
            v = math.hypot(vx, vh)
            mach = v / a_s
            cfg = cd_stack if k2 < 2 * k_sep else cd_sus
            cd = cfg(mach, hh, thr > 0.0)
            drag = 0.5 * r * v * v * S * cd
            if on_rail:
                a = (thr - drag) / m  # along the rod; gravity is not projected onto it (RASAero)
                if a * uh - G0 < 0.0 and v <= 0.0:
                    return 0.0, 0.0, thr, w, drag, cd, mach  # held down on the pad
                return a * ux, a * uh - G0, thr, w, drag, cd, mach
            if v > 1e-9:
                ex, eh = vx / v, vh / v
            else:
                ex, eh = ux, uh
            f = (thr - drag) / m
            ah = f * eh - G0
            if h <= 0.0 and v <= 1e-9 and ah < 0.0:
                return 0.0, 0.0, thr, w, drag, cd, mach  # sitting on the pad (no rod)
            return f * ex, ah, thr, w, drag, cd, mach

        # ---- integrate -----------------------------------------------------
        n_max = int(self.max_time_s / dt)
        rec_t, rec_stage, rec_mach, rec_cd, rec_thr, rec_w, rec_drag = [], [], [], [], [], [], []
        rec_ax, rec_ah, rec_vx, rec_vh, rec_x, rec_h = [], [], [], [], [], []
        x = h = vx = vh = 0.0
        max_h = t_max_h = max_v = max_mach = 0.0
        on_rail = rod_len > 0.0
        rail_exit_v = None
        ignition_suppressed = False
        k = 0
        while k <= n_max:
            k2 = 2 * k
            if k == k_ign and vh < 0.0 and not on_rail:
                # RASAero does not light the sustainer once the vehicle is
                # already descending (verified: ref06); the flight just ends at apogee
                k_ign = n_max + 10
                ignition_suppressed = True
            ax, ah, thr, w, drag, cd, mach = accel(k2, x, h, vx, vh, on_rail)
            if history:
                rec_t.append(k * dt)
                rec_stage.append(1 if k < k_sep else 2)
                rec_mach.append(mach)
                rec_cd.append(cd)
                rec_thr.append(thr)
                rec_w.append(w)
                rec_drag.append(drag)
                rec_ax.append(ax)
                rec_ah.append(ah)
                rec_vx.append(vx)
                rec_vh.append(vh)
                rec_x.append(x)
                rec_h.append(h)
            else:
                if h > max_h:
                    max_h, t_max_h = h, k * dt
                v_now = math.hypot(vx, vh)
                if v_now > max_v:
                    max_v = v_now
                if mach > max_mach:
                    max_mach = mach
            if not on_rail and vh < 0.0 and h > 0.0 and (ignition_suppressed or k >= k_ign + sc.n // 2):
                break  # apogee after the sustainer burn (RASAero ignites even on the way down)
            if h < 0.0 and k > 10:
                break  # ground impact before the sustainer ever lit
            # RK4
            k1 = (vx, vh, ax, ah)
            s2 = (x + hdt * k1[0], h + hdt * k1[1], vx + hdt * k1[2], vh + hdt * k1[3])
            a2 = accel(k2 + 1, *s2, on_rail)
            k2v = (s2[2], s2[3], a2[0], a2[1])
            s3 = (x + hdt * k2v[0], h + hdt * k2v[1], vx + hdt * k2v[2], vh + hdt * k2v[3])
            a3 = accel(k2 + 1, *s3, on_rail)
            k3v = (s3[2], s3[3], a3[0], a3[1])
            s4 = (x + dt * k3v[0], h + dt * k3v[1], vx + dt * k3v[2], vh + dt * k3v[3])
            a4 = accel(k2 + 2, *s4, on_rail)
            k4v = (s4[2], s4[3], a4[0], a4[1])
            x += dt / 6.0 * (k1[0] + 2 * k2v[0] + 2 * k3v[0] + k4v[0])
            h += dt / 6.0 * (k1[1] + 2 * k2v[1] + 2 * k3v[1] + k4v[1])
            vx += dt / 6.0 * (k1[2] + 2 * k2v[2] + 2 * k3v[2] + k4v[2])
            vh += dt / 6.0 * (k1[3] + 2 * k2v[3] + 2 * k3v[3] + k4v[3])
            if on_rail:
                if vh < 0.0 and h <= 0.0:
                    x = h = vx = vh = 0.0  # still held on the pad
                if math.hypot(x, h) >= rod_len:
                    on_rail = False
                    rail_exit_v = math.hypot(vx, vh)
            k += 1

        if not history:
            return {
                "max_alt_ft": max_h,
                "t_apogee_s": t_max_h,
                "max_vel_fps": max_v,
                "max_mach": max_mach,
                "rail_exit_vel_fps": rail_exit_v,
                "t_burnout_s": t_bo,
                "t_sep_s": k_sep * dt,
                "t_ign_s": None if ignition_suppressed else k_ign * dt,
                "ignition_suppressed": ignition_suppressed,
            }, None
        t = np.array(rec_t)
        vxa, vha = np.array(rec_vx), np.array(rec_vh)
        v = np.hypot(vxa, vha)
        axa, aha = np.array(rec_ax), np.array(rec_ah)
        stage = np.array(rec_stage)
        hist = pd.DataFrame(
            {
                "time_s": t,
                "stage": stage,
                "stage_time_s": np.where(stage == 1, t, t - k_sep * dt),
                "mach": rec_mach,
                "cd": rec_cd,
                "thrust_lb": rec_thr,
                "weight_lb": rec_w,
                "drag_lb": rec_drag,
                "accel_fps2": np.hypot(axa, aha),
                "accel_v_fps2": aha,
                "accel_h_fps2": axa,
                "velocity_fps": v,
                "vel_v_fps": vha,
                "vel_h_fps": vxa,
                "fpa_deg": np.degrees(np.arctan2(vha, np.where(v > 0, vxa, 1e-9))),
                "altitude_ft": rec_h,
                "distance_ft": rec_x,
            }
        )
        i_ap = int(np.argmax(hist["altitude_ft"].to_numpy()))
        summary = {
            "max_alt_ft": float(hist["altitude_ft"].iloc[i_ap]),
            "t_apogee_s": float(t[i_ap]),
            "max_vel_fps": float(v.max()),
            "max_mach": float(max(rec_mach)),
            "rail_exit_vel_fps": rail_exit_v,
            "t_burnout_s": t_bo,
            "t_sep_s": k_sep * dt,
            "t_ign_s": None if ignition_suppressed else k_ign * dt,
            "ignition_suppressed": ignition_suppressed,
        }
        return summary, hist
