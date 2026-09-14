"""Aerodynamic coefficient tables exported from RASAero II ("Aero Plots" ->
export), used by the Python flight simulator.

The tables depend only on the vehicle geometry, so they are produced once per
vehicle revision and stored under input/aero/. RASAero evaluates them at a
fixed altitude (the <MachAlt> field) and, for power-on drag, at the nozzle
exit diameter of the configuration - so a set of files at several altitudes
and nozzle diameters is exported and we interpolate between them.

File naming (case-insensitive):   <config>_alt<ft>[_noz<in>].csv
    config : stack      (booster attached, i.e. the full two-stage vehicle)
             sustainer  (sustainer alone)
    alt    : the MachAlt altitude the table was exported at, feet
    noz    : nozzle exit diameter used for the power-on columns, inches
             (optional; a file without it is used for every nozzle size)
e.g.  stack_alt3000_noz3.88.csv   sustainer_alt40000_noz2.4.csv

Columns are matched by name, tolerant of RASAero's exact wording: a Mach
column, a power-off CD column and a power-on CD column are required; CN
and CP columns are kept when present.
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field
from pathlib import Path

import numpy as np
import pandas as pd

STACK = "stack"
SUSTAINER = "sustainer"
CONFIGS = (STACK, SUSTAINER)

_NAME_RE = re.compile(r"^(?P<config>stack|sustainer)[_-]alt(?P<alt>[\d.]+)(?:[_-]noz(?P<noz>[\d.]+))?.*\.csv$", re.IGNORECASE)


def _find_col(cols: list[str], *needles: str, exclude: tuple[str, ...] = ()) -> str | None:
    for c in cols:
        lc = c.lower().replace("_", " ").replace("-", " ")
        if all(n in lc for n in needles) and not any(x in lc for x in exclude):
            return c
    return None


@dataclass
class AeroTable:
    config: str
    altitude_ft: float
    nozzle_in: float | None
    mach: np.ndarray
    cd_off: np.ndarray
    cd_on: np.ndarray
    cn: np.ndarray | None = None
    cp_in: np.ndarray | None = None
    reynolds: np.ndarray | None = None
    path: Path | None = None

    @classmethod
    def read(cls, path: str | Path, config: str | None = None, altitude_ft: float | None = None, nozzle_in: float | None = None) -> AeroTable:
        path = Path(path)
        m = _NAME_RE.match(path.name)
        if m:
            config = config or m.group("config").lower()
            altitude_ft = float(m.group("alt")) if altitude_ft is None else altitude_ft
            nozzle_in = float(m.group("noz")) if (nozzle_in is None and m.group("noz")) else nozzle_in
        if config not in CONFIGS or altitude_ft is None:
            raise ValueError(f"{path.name}: cannot tell config/altitude from the file name; expected <stack|sustainer>_alt<ft>[_noz<in>].csv")
        df = pd.read_csv(path)
        df.columns = [str(c).strip() for c in df.columns]
        cols = list(df.columns)
        c_mach = _find_col(cols, "mach")
        c_off = _find_col(cols, "cd", "off") or _find_col(cols, "cd", exclude=("on",))
        c_on = _find_col(cols, "cd", "on", exclude=("off",))
        if not (c_mach and c_off and c_on):
            raise ValueError(f"{path.name}: need Mach, CD power-off and CD power-on columns; found {cols}")
        c_cn = _find_col(cols, "cn", exclude=("cnalpha",)) or _find_col(cols, "cn")
        c_cp = _find_col(cols, "cp")
        df = df[pd.to_numeric(df[c_mach], errors="coerce").notna()].copy()
        c_alpha = _find_col(cols, "alpha", exclude=("cnalpha",))
        if c_alpha:
            # RASAero exports every Mach at several angles of attack; the
            # trajectory model flies at zero AoA
            a = pd.to_numeric(df[c_alpha], errors="coerce")
            df = df[a == a.min()].copy()
        c_re = _find_col(cols, "reynolds")
        for c in (c_mach, c_off, c_on, c_cn, c_cp):
            if c:
                df[c] = pd.to_numeric(df[c], errors="coerce")
        df = df.sort_values(c_mach).drop_duplicates(c_mach)
        return cls(
            config=config,
            altitude_ft=float(altitude_ft),
            nozzle_in=nozzle_in,
            mach=df[c_mach].to_numpy(float),
            cd_off=df[c_off].to_numpy(float),
            cd_on=df[c_on].to_numpy(float),
            cn=df[c_cn].to_numpy(float) if c_cn else None,
            cp_in=df[c_cp].to_numpy(float) if c_cp else None,
            reynolds=pd.to_numeric(df[c_re], errors="coerce").to_numpy(float) if c_re else None,
            path=path,
        )

    def cd(self, mach: float, power_on: bool) -> float:
        return float(np.interp(mach, self.mach, self.cd_on if power_on else self.cd_off))


class AeroModel:
    """CD(Mach, altitude, power state) for one configuration and one nozzle
    exit diameter, prepared for fast lookups inside the integrator."""

    def __init__(self, tables: list[AeroTable], nozzle_in: float | None):
        if not tables:
            raise ValueError("no aero tables")
        self.config = tables[0].config
        self.nozzle_in = nozzle_in
        # group by altitude; within each altitude interpolate/select on nozzle
        by_alt: dict[float, list[AeroTable]] = {}
        for t in tables:
            by_alt.setdefault(t.altitude_ft, []).append(t)
        self.alts = np.array(sorted(by_alt))
        self._mach = np.unique(np.concatenate([t.mach for t in tables]))
        self._off = np.empty((len(self.alts), len(self._mach)))
        self._on = np.empty_like(self._off)
        for i, a in enumerate(self.alts):
            self._off[i], self._on[i] = self._nozzle_blend(by_alt[a], nozzle_in)

    @property
    def mach_max(self) -> float:
        return float(self._mach.max())

    def _nozzle_blend(self, tabs: list[AeroTable], noz: float | None):
        def resample(t: AeroTable):
            return np.interp(self._mach, t.mach, t.cd_off), np.interp(self._mach, t.mach, t.cd_on)

        generic = [t for t in tabs if t.nozzle_in is None]
        sized = sorted([t for t in tabs if t.nozzle_in is not None], key=lambda t: t.nozzle_in)
        if noz is None or not sized:
            return resample((generic or sized)[0])
        if len(sized) == 1 or noz <= sized[0].nozzle_in:
            return resample(sized[0])
        if noz >= sized[-1].nozzle_in:
            return resample(sized[-1])
        for lo, hi in zip(sized, sized[1:], strict=False):
            if lo.nozzle_in <= noz <= hi.nozzle_in:
                w = (noz - lo.nozzle_in) / (hi.nozzle_in - lo.nozzle_in)
                (o0, n0), (o1, n1) = resample(lo), resample(hi)
                return o0 + w * (o1 - o0), n0 + w * (n1 - n0)
        raise AssertionError

    def cd_row(self, mach, alt_ft: float, power_on: bool) -> np.ndarray:
        """CD at one altitude for an array of Mach numbers."""
        grid = self._on if power_on else self._off
        mach = np.asarray(mach, dtype=float)
        if len(self.alts) == 1:
            return np.interp(mach, self._mach, grid[0])
        j = int(np.searchsorted(self.alts, alt_ft))
        if j == 0:
            return np.interp(mach, self._mach, grid[0])
        if j >= len(self.alts):
            return np.interp(mach, self._mach, grid[-1])
        w = (alt_ft - self.alts[j - 1]) / (self.alts[j] - self.alts[j - 1])
        c0 = np.interp(mach, self._mach, grid[j - 1])
        c1 = np.interp(mach, self._mach, grid[j])
        return c0 + w * (c1 - c0)

    def cd(self, mach: float, alt_ft: float, power_on: bool) -> float:
        return float(self.cd_row(np.array([mach]), alt_ft, power_on)[0])


@dataclass
class AeroSet:
    """Every table found under input/aero/."""

    tables: list[AeroTable] = field(default_factory=list)

    @classmethod
    def load(cls, directory: str | Path) -> AeroSet:
        directory = Path(directory)
        tabs = []
        for p in sorted(directory.glob("*.csv")):
            if _NAME_RE.match(p.name):
                tabs.append(AeroTable.read(p))
        if not tabs:
            raise FileNotFoundError(f"no aero tables named <stack|sustainer>_alt<ft>[_noz<in>].csv in {directory}")
        return cls(tabs)

    def model(self, config: str, nozzle_in: float | None) -> AeroModel:
        tabs = [t for t in self.tables if t.config == config]
        if not tabs:
            raise ValueError(f"no aero tables for configuration '{config}'")
        return AeroModel(tabs, nozzle_in)

    def describe(self) -> str:
        lines = []
        for c in CONFIGS:
            ts = [t for t in self.tables if t.config == c]
            if ts:
                alts = sorted({t.altitude_ft for t in ts})
                nozs = sorted({t.nozzle_in for t in ts if t.nozzle_in is not None})
                lines.append(f"{c}: {len(ts)} table(s), altitudes {alts} ft, nozzles {nozs or 'generic'} in, Mach {min(t.mach.min() for t in ts):.2f}-{max(t.mach.max() for t in ts):.2f}")
        return "\n".join(lines)

    def coverage_problems(self, config: str, nozzle_in: float | None, max_mach: float, max_alt_ft: float) -> list[str]:
        ts = [t for t in self.tables if t.config == config]
        out = []
        if not ts:
            return [f"{config}: no tables"]
        if max(t.mach.max() for t in ts) < max_mach:
            out.append(f"{config}: tables stop at Mach {max(t.mach.max() for t in ts):.2f} < needed {max_mach:.2f}")
        if max(t.altitude_ft for t in ts) < 0.5 * max_alt_ft:
            out.append(f"{config}: highest table altitude {max(t.altitude_ft for t in ts):.0f} ft is far below the flight ceiling ~{max_alt_ft:.0f} ft")
        nozs = [t.nozzle_in for t in ts if t.nozzle_in is not None]
        if nozzle_in is not None and nozs and not (min(nozs) - 0.3 <= nozzle_in <= max(nozs) + 0.3):
            out.append(f"{config}: nozzle {nozzle_in:.2f} in is outside the exported range {min(nozs):.2f}-{max(nozs):.2f} in")
        return out
