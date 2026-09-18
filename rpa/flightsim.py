"""Two-stage trajectory integrator: RASAero II's flight loop (class `y` of
the decompiled engine, zero wind) in Python, fed by RASAero's exported
aero tables (rpa.aero), its atmosphere (rpa.atmosphere), the .eng thrust
curves and the OpenRocket masses. rpa.validate checks it term by term
against RASAero exports; rpa.native runs the real engine.

What RASAero does, and this port reproduces
  * time: the stage clock is a float32 accumulation of dt (0.01 -> 4.700013
    at step 470); every event lands on that grid
  * one step: atmosphere, Mach, CD and drag from the state at the START of
    the step; thrust at the END time; weight = liftoff weight minus the
    propellant burned up to the PREVIOUS step (the Weight column lags)
  * on the rail (max altitude so far <= rod length * cos(rod angle)):
    forward Euler; thrust and drag act along the rod, gravity fully
    vertical; altitude and distance by the trapezoid rule; held down while
    the vertical acceleration is negative
  * off the rail: RK4 on the velocity with altitude, density, CD and thrust
    frozen over the step and the drag recomputed from the substep speed;
    then altitude += new vertical velocity * dt and distance by trapezoid;
    gravity falls off as (R/(R + site + h))^2 and vx^2/(R + site + h) is
    added to the vertical acceleration
  * thrust: .eng curve (linear, (0,0) prepended) + (14.6958 - p_ambient[psi])
    * nozzle exit area [in^2] while the curve is positive; power-on CD when
    the curve is positive and the stage has a nozzle diameter
  * mass: propellant leaves in proportion to the impulse delivered
  * booster stage ends at the first step whose clock exceeds
    separation delay + burn time; the sustainer clock restarts at 0, its
    thrust starts at the ignition delay and its stage ends at the first
    step that is below the stage's maximum altitude while the raw thrust
    curve at the stage clock is zero (so a sustainer whose burn time is
    shorter than its ignition delay never lights after apogee)
  * CD depends on altitude only through the Reynolds number. The Aero
    Plots tables were computed in the standard atmosphere while the flight
    uses the site's, so a table is read at the standard-atmosphere altitude
    whose Reynolds number equals the flight's (rpa.atmosphere)
  * the run stops at apogee (RASAero goes on to the ground)
Not reproduced: wind (RASAero's pitch dynamics need CNalpha, inertia and
CG/CP; the site wind is ignored) and the "Rocket was Unstable" abort.
"""

from __future__ import annotations

import math
import warnings
from dataclasses import dataclass

import numpy as np
import pandas as pd

from .aero import STACK, SUSTAINER, AeroModel, AeroSet
from .atmosphere import G0, R_EARTH_FT, STD_P0_PSI, Atmosphere
from .eng import Motor

N_TO_LBF = 0.22480902  # RASAero's own constants
KG_TO_LB = 2.2046225
MACH_MIN, MACH_MAX = 0.01, 25.0
MAX_TABLE_MACH = 8.0  # CD grid cutoff; vehicle never gets near it
RAD = 180.0 / math.pi


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


class _Motor:
    """A motor as RASAero's loop samples it: float32 point times, thrust
    in lbf, propellant burned in proportion to the impulse delivered."""

    def __init__(self, m: Motor):
        t = np.concatenate([[0.0], m.time_s]).astype(np.float32).astype(np.float64)
        f = np.concatenate([[0.0], m.thrust_n]).astype(np.float32).astype(np.float64) * N_TO_LBF
        self.t, self.f = t, f
        self.burn32 = np.float32(t.max())
        self.imp = np.concatenate([[0.0], np.cumsum(0.5 * (f[1:] + f[:-1]) * np.diff(t))])
        self.total = self.imp[-1] if self.imp[-1] > 0 else 1.0
        self.prop_lb = m.prop_mass_kg * KG_TO_LB

    def sample(self, t32: np.ndarray, delay32: np.float32):
        """(thrust curve lbf, propellant fraction, raw curve at the stage
        clock) at each stage time; the first two offset by the delay."""
        arg = (t32 - delay32).astype(np.float64)
        curve = np.interp(arg, self.t, self.f, left=0.0, right=0.0)
        i = np.clip(np.searchsorted(self.t, arg, side="right") - 1, 0, len(self.t) - 2)
        imp = self.imp[i] + 0.5 * (self.f[i] + curve) * (arg - self.t[i])
        frac = np.where(arg <= 0.0, 0.0, np.where(arg >= self.t[-1], 1.0, imp / self.total))
        raw = np.interp(t32.astype(np.float64), self.t, self.f, left=0.0, right=0.0)
        return curve, frac, raw


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


class _Flight:
    """State carried across stages plus the summary counters."""

    __slots__ = ("h", "x", "vx", "vy", "v", "max_h", "t_max", "max_v", "max_mach", "rail_exit_v", "t_ign", "rec")

    def __init__(self, rec: dict | None):
        self.h = self.x = self.vx = self.vy = self.v = 0.0
        self.max_h = self.t_max = self.max_v = self.max_mach = 0.0
        self.rail_exit_v = None
        self.t_ign = None
        self.rec = rec


_COLS = ("time_s", "stage", "stage_time_s", "mach", "cd", "thrust_lb", "weight_lb", "drag_lb", "accel_fps2", "accel_v_fps2", "accel_h_fps2", "velocity_fps", "vel_v_fps", "vel_h_fps", "pitch_deg", "fpa_deg", "altitude_ft", "distance_ft")


class FlightSim:
    def __init__(self, aero: AeroSet, site: dict, dt: float = 0.01, max_time_s: float = 400.0):
        self.aero = aero
        self.site = site
        self.dt = float(dt)
        self.max_time_s = float(max_time_s)
        self.atm = Atmosphere.from_site(site)
        self.rod_len = float(site.get("rod_length_ft") or 0.0)
        self.rod_angle = (float(site.get("rod_angle_deg") or 0.0) or 0.0001) * math.pi / 180.0  # the GUI flies 0 as 0.0001 deg
        wind = float(site.get("wind_speed_mph") or 0.0)
        if wind:
            warnings.warn(f"python backend flies at zero wind (site wind {wind:g} mph ignored)", stacklevel=2)
        # t32[k] = k accumulations of float32(dt): RASAero's stage clock
        n = int(round(self.max_time_s / self.dt))
        self._t32 = np.concatenate([np.zeros(1, np.float32), np.cumsum(np.full(n, np.float32(self.dt), dtype=np.float32), dtype=np.float32)])
        self._cd_cache: dict[tuple[str, float | None], _CdLookup] = {}
        # AGL altitude -> the standard-atmosphere altitude with the same
        # Reynolds number (what the aero tables are indexed by), on a grid
        std = Atmosphere.standard()
        a_std = np.arange(0.0, 300_001.0, 100.0)
        f_std = np.array([std.reynolds_factor(a) for a in a_std])  # decreasing
        self._ae_step = 50.0
        h = np.arange(0.0, 200_001.0, self._ae_step)
        f_site = np.array([self.atm.reynolds_factor(x) for x in h])
        self._ae = np.interp(-f_site, -f_std, a_std).tolist()

    def aero_altitude(self, h_agl_ft: float) -> float:
        """Altitude to read the aero tables at for a flight altitude."""
        q = h_agl_ft / self._ae_step
        if q <= 0.0:
            return self._ae[0]
        i = int(q)
        if i >= len(self._ae) - 1:
            return self._ae[-1]
        return self._ae[i] + (q - i) * (self._ae[i + 1] - self._ae[i])

    def _cd(self, config: str, nozzle_in: float | None) -> _CdLookup:
        key = (config, None if nozzle_in is None else round(nozzle_in, 3))
        if key not in self._cd_cache:
            self._cd_cache[key] = _CdLookup(self.aero.model(config, nozzle_in))
        return self._cd_cache[key]

    def run(self, veh: Vehicle, sep_delay_s: float, ign_delay_s: float, history: bool = True) -> tuple[dict, pd.DataFrame | None]:
        """Fly one two-stage trajectory. `history=False` skips the per-step
        record (the search only needs the summary)."""
        rec = {c: [] for c in _COLS} if history else None
        fl = _Flight(rec)
        t32 = self._t32
        bm, sm = _Motor(veh.booster), _Motor(veh.sustainer)
        if rec:
            fpa0 = (math.pi / 2.0 - self.rod_angle) * RAD
            for c, val in zip(_COLS, (0.0, 1, 0.0, 0.0, 0.0, 0.0, veh.combined_wt_lb, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, fpa0, fpa0, 0.0, 0.0), strict=True):
                rec[c].append(val)
        # booster stage: runs until the stage clock exceeds separation delay + burn time
        t_end = np.float32(np.float32(sep_delay_s) + bm.burn32)
        past = np.flatnonzero(t32 > t_end)
        n_b = int(past[0]) if len(past) else len(t32) - 1
        tb = t32[1 : n_b + 1]
        curve, frac, raw = bm.sample(tb, np.float32(0.0))
        apogee = self._stage(fl, veh, 1, tb, np.float32(0.0), veh.combined_wt_lb, bm.prop_lb, curve, frac, raw, veh.booster_nozzle_in, self._cd(STACK, veh.booster_nozzle_in))
        t_sep = None
        if not apogee:
            ts = t32[1:]
            t_off = t32[n_b]
            t_sep = float(np.float32(ts[0] + t_off))
            curve, frac, raw = sm.sample(ts, np.float32(ign_delay_s))
            self._stage(fl, veh, 2, ts, t_off, veh.sustainer_wt_lb, sm.prop_lb, curve, frac, raw, veh.sustainer_nozzle_in, self._cd(SUSTAINER, veh.sustainer_nozzle_in))
        summary = {
            "max_alt_ft": fl.max_h,
            "t_apogee_s": fl.t_max,
            "max_vel_fps": fl.max_v,
            "max_mach": fl.max_mach,
            "rail_exit_vel_fps": fl.rail_exit_v,
            "t_burnout_s": float(bm.burn32),
            "t_sep_s": t_sep,
            "t_ign_s": fl.t_ign,
            "ignition_suppressed": fl.t_ign is None,
        }
        if rec is None:
            return summary, None
        hist = pd.DataFrame(rec)
        hist["stage"] = hist["stage"].astype(int)
        return summary, hist

    def _stage(self, fl: _Flight, veh: Vehicle, stage: int, t32: np.ndarray, t_off: np.float32, w0: float, prop_lb: float, curve: np.ndarray, frac: np.ndarray, raw: np.ndarray, nozzle_in: float | None, cd_tab: _CdLookup) -> bool:
        """One stage of RASAero's loop. Returns True when the stage ended at
        apogee (so no later stage flies)."""
        dt = self.dt
        hdt = 0.5 * dt
        sixth = dt / 6.0
        S = veh.ref_area_ft2
        atm = self.atm.state
        site_alt = self.atm.site_alt_ft
        rail_h = self.rod_len * math.cos(self.rod_angle)
        cos_u, sin_u = math.cos(self.rod_angle), math.sin(self.rod_angle)
        fpa_rail = math.pi / 2.0 - self.rod_angle
        a_exit = math.pi * ((nozzle_in or 0.0) / 2.0) ** 2  # in^2
        power_ok = bool(nozzle_in)
        ae, ae_step, n_ae = self._ae, self._ae_step, len(self._ae) - 1
        t_abs = (t32 + t_off).astype(np.float64).tolist()
        t_st = t32.astype(np.float64).tolist()
        curve, frac, raw = curve.tolist(), frac.tolist(), raw.tolist()
        rec = fl.rec
        h, x, vx, vy, v = fl.h, fl.x, fl.vx, fl.vy, fl.v
        max_h = h  # RASAero restarts the stage maximum at the handover altitude
        w_prev = 0.0
        for k in range(len(t_st)):
            rho, a_s, p = atm(h)
            mach = (v if v != 0.0 else 1e-7) / a_s
            if mach < MACH_MIN:
                mach = MACH_MIN
            elif mach > MACH_MAX:
                mach = MACH_MAX
            tc = curve[k]
            on = tc > 0.0
            q = h / ae_step
            i = int(q)
            alt_t = ae[i] + (q - i) * (ae[i + 1] - ae[i]) if 0 <= i < n_ae else ae[-1 if i >= n_ae else 0]
            cd = cd_tab(mach, alt_t, on and power_ok)
            kd = 0.5 * rho * S * cd
            drag0 = kd * v * v
            thr = tc + (STD_P0_PSI - p) * a_exit if on else 0.0
            w = w0 - prop_lb * w_prev
            w_prev = frac[k]
            m = w / G0
            on_rail = max_h <= rail_h
            if on_rail:
                f = thr - drag0
                ay = (f * cos_u - w) / m
                ax = f * sin_u / m
                if ay < 0.0:
                    ax = ay = 0.0  # held down on the pad
                nvx, nvy = vx + ax * dt, vy + ay * dt
                h += (vy + nvy) * hdt
                if h < 0.0:
                    h = 0.0
                x += (vx + nvx) * hdt
                fpa = pitch = fpa_rail
            else:
                g = 32.17399978637695 * (R_EARTH_FT / (h + R_EARTH_FT + site_alt)) ** 2
                rl = R_EARTH_FT + site_alt + h
                # RK4 on the velocity, everything else frozen over the step
                ux, uy = vx, vy
                if uy == 0.0:
                    uy = vg = 1e-7
                else:
                    vg = math.hypot(ux, uy)
                f = (thr - kd * (ux * ux + uy * uy)) / (m * vg)
                ax1, ay1 = f * ux, f * uy - g + ux * ux / rl
                ux, uy = vx + hdt * ax1, vy + hdt * ay1
                if uy == 0.0:
                    uy = vg = 1e-7
                else:
                    vg = math.hypot(ux, uy)
                f = (thr - kd * (ux * ux + uy * uy)) / (m * vg)
                ax2, ay2 = f * ux, f * uy - g + ux * ux / rl
                ux, uy = vx + hdt * ax2, vy + hdt * ay2
                if uy == 0.0:
                    uy = vg = 1e-7
                else:
                    vg = math.hypot(ux, uy)
                f = (thr - kd * (ux * ux + uy * uy)) / (m * vg)
                ax3, ay3 = f * ux, f * uy - g + ux * ux / rl
                ux, uy = vx + dt * ax3, vy + dt * ay3
                if uy == 0.0:
                    uy = vg = 1e-7
                else:
                    vg = math.hypot(ux, uy)
                f = (thr - kd * (ux * ux + uy * uy)) / (m * vg)
                ax4, ay4 = f * ux, f * uy - g + ux * ux / rl
                dvx = sixth * (ax1 + 2.0 * ax2 + 2.0 * ax3 + ax4)
                dvy = sixth * (ay1 + 2.0 * ay2 + 2.0 * ay3 + ay4)
                nvx, nvy = vx + dvx, vy + dvy
                x += (vx + nvx) * hdt
                h += nvy * dt
                ax, ay = dvx / dt, dvy / dt
                if nvx == 0.0:
                    fpa = pitch = math.pi / 2.0 if nvy >= 0.0 else -math.pi / 2.0
                elif nvx > 0.0:
                    fpa = pitch = math.atan(nvy / nvx)
                else:
                    fpa = math.atan(nvy / nvx)
                    pitch = fpa + math.pi if nvy >= 0.0 else fpa - math.pi
            vx, vy = nvx, nvy
            v = math.hypot(vx, vy)
            if rec is not None:
                a_tot = math.hypot(ax, ay)
                for c, val in zip(_COLS, (t_abs[k], stage, t_st[k], mach, cd, thr, w, drag0, -a_tot if ay < 0.0 else a_tot, ay, ax, v, vy, vx, pitch * RAD, fpa * RAD, h, x), strict=True):
                    rec[c].append(val)
            if h > max_h:
                max_h = h
                fl.max_h, fl.t_max = h, t_abs[k]
            if on_rail and max_h > rail_h:
                fl.rail_exit_v = v
            if v > fl.max_v:
                fl.max_v = v
            if mach > fl.max_mach:
                fl.max_mach = mach
            if stage == 2 and on and fl.t_ign is None:
                fl.t_ign = t_abs[k]
            if (h < max_h or max_h == 0.0) and raw[k] == 0.0:
                fl.h, fl.x, fl.vx, fl.vy, fl.v = h, x, vx, vy, v
                return True
        fl.h, fl.x, fl.vx, fl.vy, fl.v = h, x, vx, vy, v
        return stage != 1  # a sustainer stage that runs out of time is over too
