"""openMotor `.ric` motor designs as a motor source.

A `.ric` is a *design* (grains, nozzle, propellant), not a thrust curve, so
each one is simulated with openMotor's own `motorlib` and written out as a
one-motor RASP block; the loader then reads those like any other `.eng`.
The simulation of a design is cached (output/motors/ric_cache/<stem>.eng +
.json with the design's hash and the timestep), so it runs once per design.

motorlib is found in this order: `ric.openmotor` in config.yaml, the
OPENMOTOR_PATH environment variable, an installed `motorlib`, or a vendored
copy in a sibling project (…/vendor/openMotor). Its compiled perimeter finder
(`mathlib`) is only needed for non-BATES grains; when it is not built for
this Python a stand-in is installed that fails loudly for those grains.
"""

from __future__ import annotations

import hashlib
import json
import os
import re
import sys
import types
from dataclasses import dataclass
from pathlib import Path

import numpy as np
import yaml

M_TO_IN = 39.3700787
DEFAULT_TIMESTEP_S = 0.002  # what the files' own designations were produced with
CURVE_POINTS = 1000  # RASAero copes with the full 0.002 s curve; thinning beyond this costs impulse (peak and burnout are always kept)
MANUFACTURER = "openMotor"


class RicPending(RuntimeError):
    """Raised when .ric designs would have to be simulated but simulation was not allowed (GUI status calls)."""

    def __init__(self, paths: list[Path]):
        super().__init__(f"{len(paths)} .ric design(s) not simulated yet - run Check (or the motors stage) to convert them")
        self.paths = paths


class _RicLoader(yaml.SafeLoader):
    """SafeLoader that tolerates the two python-specific tags openMotor writes."""


_RicLoader.add_constructor("tag:yaml.org,2002:python/tuple", lambda loader, node: tuple(loader.construct_sequence(node)))
_RicLoader.add_multi_constructor("tag:yaml.org,2002:python/object/apply:", lambda loader, suffix, node: loader.construct_sequence(node, deep=True))


def load_ric(path: str | Path) -> dict:
    with open(path, encoding="utf-8") as f:
        raw = yaml.load(f, Loader=_RicLoader)
    if not isinstance(raw, dict) or "data" not in raw:
        raise ValueError(f"{path} is not an openMotor motor file")
    return raw["data"]


# ---- finding and importing motorlib ------------------------------------------
def find_openmotor(setting: str | None = "auto", root: Path | None = None) -> Path | None:
    """Directory that contains the `motorlib` package, or None."""
    cands: list[Path] = []
    if setting and setting != "auto":
        cands.append(Path(setting).expanduser())
    if os.environ.get("OPENMOTOR_PATH"):
        cands.append(Path(os.environ["OPENMOTOR_PATH"]).expanduser())
    try:
        import motorlib  # noqa: F401 - installed copy

        return Path(motorlib.__file__).resolve().parent.parent
    except Exception:  # noqa: BLE001 - not installed or not importable here
        pass
    home = Path.home()
    if root is not None:
        cands += [root.parent / "Rocket Optimization" / "vendor" / "openMotor", root / "vendor" / "openMotor"]
    cands += [home / "Code" / "Python" / "Rocket Optimization" / "vendor" / "openMotor", home / "openMotor"]
    for base in (home / "Code", home / "Projects", home / "src"):
        if base.exists():
            cands += sorted(base.glob("*/*/vendor/openMotor")) + sorted(base.glob("*/vendor/openMotor"))
    for c in cands:
        if (c / "motorlib" / "motor.py").exists():
            return c
    return None


_MOTORLIB = None


def import_motorlib(openmotor_dir: Path):
    """`motorlib.motor` from the given openMotor checkout (cached)."""
    global _MOTORLIB
    if _MOTORLIB is not None:
        return _MOTORLIB
    d = str(openmotor_dir)
    if d not in sys.path:
        sys.path.insert(0, d)
    try:
        import mathlib  # noqa: F401 - openMotor's compiled perimeter finder, if built for this Python
    except Exception:  # noqa: BLE001 - not built: BATES grains never call it
        shim = types.ModuleType("mathlib")

        def find_perimeter(*_a, **_k):
            raise NotImplementedError("openMotor's compiled perimeter finder (mathlib) is not built for this Python; only BATES grains can be simulated - build openMotor's C extension to use other grain shapes")

        shim.find_perimeter = find_perimeter
        sys.modules["mathlib"] = shim
    from motorlib import motor as motor_mod

    _MOTORLIB = motor_mod
    return motor_mod


# ---- simulate + RASP block --------------------------------------------------------
@dataclass
class RicResult:
    designation: str
    full_designation: str
    time_s: np.ndarray
    thrust_n: np.ndarray
    prop_mass_kg: float
    diameter_mm: float
    length_mm: float
    throat_in: float | None
    exit_in: float | None
    propellant: str
    warnings: list[str]


def _designation(stem: str, full: str) -> str:
    """RASP designation: '<impulse><class><avg>-<NN>' for files named NN-…,
    else the (whitespace-free) file stem, else the simulated designation."""
    m = re.match(r"^(\d+)[-_]", stem)
    if m:
        return f"{full}-{m.group(1)}"
    safe = re.sub(r"\s+", "_", stem.strip())
    return safe or full


def simulate_ric(path: Path, motorlib_motor, timestep_s: float | None = DEFAULT_TIMESTEP_S) -> RicResult:
    data = load_ric(path)
    if timestep_s:
        data = dict(data)
        data["config"] = dict(data.get("config", {}))
        data["config"]["timestep"] = float(timestep_s)
    import warnings as _w

    with _w.catch_warnings():
        _w.simplefilter("ignore", RuntimeWarning)  # fsolve chatter on over-expanded nozzles; openMotor's alerts say the same
        res = motorlib_motor.Motor(data).runSimulation()
    t = np.asarray(res.channels["time"].getData(), dtype=float)
    f = np.asarray(res.channels["force"].getData(), dtype=float)
    if not len(t) or float(res.getImpulse()) <= 0:
        raise ValueError(f"{path.name}: openMotor produced no thrust")
    live = np.flatnonzero(f > 0)
    if not len(live):
        raise ValueError(f"{path.name}: no positive thrust")
    end = int(live[-1])
    t, f = t[: end + 2] if end + 1 < len(t) else t[: end + 1], f[: end + 2] if end + 1 < len(f) else f[: end + 1]
    if f[-1] > 0:  # RASP curves end at zero thrust
        t = np.append(t, t[-1] + (t[-1] - t[-2] if len(t) > 1 else 0.001))
        f = np.append(f, 0.0)
    keep = t > 0
    t, f = t[keep], f[keep]
    nozzle = data.get("nozzle", {})
    grains = data.get("grains", [])
    length_m = sum(float(g.get("properties", {}).get("length", 0.0)) for g in grains)
    warnings = []
    for a in getattr(res, "alerts", []):
        try:
            warnings.append(f"{getattr(a.level, 'name', a.level)}: {a.description}")
        except Exception:  # noqa: BLE001
            warnings.append(str(a))
    return RicResult(
        designation=_designation(path.stem, res.getFullDesignation()),
        full_designation=res.getFullDesignation(),
        time_s=t,
        thrust_n=f,
        prop_mass_kg=float(res.getPropellantMass()),
        diameter_mm=float(res.getMaxPropellantDiameter()) * 1000.0,
        length_mm=length_m * 1000.0,
        throat_in=float(nozzle["throat"]) * M_TO_IN if "throat" in nozzle else None,
        exit_in=float(nozzle["exit"]) * M_TO_IN if "exit" in nozzle else None,
        propellant=str(data.get("propellant", {}).get("name", "")),
        warnings=warnings,
    )


def resample(t: np.ndarray, f: np.ndarray, points: int = CURVE_POINTS) -> tuple[np.ndarray, np.ndarray]:
    """Thin a curve to about `points` samples, always keeping the peak and the last point."""
    n = len(t)
    if n <= points:
        return t, f
    idx = set(np.linspace(0, n - 1, points).round().astype(int).tolist())
    idx.add(int(np.argmax(f)))
    idx.add(n - 1)
    sel = np.array(sorted(idx))
    return t[sel], f[sel]


def rasp_block(r: RicResult, source: Path, timestep_s: float | None) -> str:
    t, f = resample(r.time_s, r.thrust_n)
    lines = [
        f"; {r.designation} -- simulated from {source.name} with openMotor (timestep {timestep_s or 'as in file'} s) by Rocket Profile Analysis",
        "; Total mass is the propellant only (openMotor does not model the case); the vehicle hardware mass is set in config.yaml.",
        f"; Propellant: {r.propellant}",
    ]
    if r.throat_in is not None and r.exit_in is not None:
        lines.append(f"; Throat {r.throat_in:.3f} in, exit {r.exit_in:.3f} in.")
    for w in r.warnings[:5]:
        lines.append(f"; openMotor {w}")
    lines.append(f"{r.designation} {r.diameter_mm:.1f} {r.length_mm:.1f} P {r.prop_mass_kg:.4f} {r.prop_mass_kg:.4f} {MANUFACTURER}")
    lines += [f"   {ti:.4f} {fi:.3f}" for ti, fi in zip(t, f, strict=True)]
    lines.append(";")
    return "\n".join(lines) + "\n"


# ---- the converter used by the motor loader ---------------------------------------
class RicConverter:
    """`.ric` files -> cached one-motor `.eng` files (callable used by rpa.eng.load_motors)."""

    def __init__(self, cache_dir: Path, openmotor: str | None = "auto", timestep_s: float | None = DEFAULT_TIMESTEP_S, root: Path | None = None, log=None, allow_simulate: bool = True):
        self.cache_dir = Path(cache_dir)
        self.openmotor_setting = openmotor
        self.root = root
        self.timestep_s = timestep_s
        self.log = log or (lambda *_: None)
        self.allow_simulate = allow_simulate
        self._openmotor: Path | None = None

    @property
    def openmotor(self) -> Path | None:
        if self._openmotor is None:
            self._openmotor = find_openmotor(self.openmotor_setting, self.root)
        return self._openmotor

    def _key(self, ric: Path) -> str:
        return hashlib.md5(ric.read_bytes()).hexdigest()

    def cached(self, ric: Path) -> Path | None:
        eng = self.cache_dir / f"{ric.stem}.eng"
        meta = eng.with_suffix(".json")
        if eng.exists() and meta.exists():
            try:
                m = json.loads(meta.read_text())
                if m.get("md5") == self._key(ric) and m.get("timestep_s") == self.timestep_s:
                    return eng
            except (OSError, ValueError):
                pass
        return None

    def pending(self, rics: list[Path]) -> list[Path]:
        return [r for r in rics if self.cached(r) is None]

    def __call__(self, rics: list[Path]) -> list[Path]:
        out = []
        todo = self.pending(rics)
        if todo:
            if not self.allow_simulate:
                raise RicPending(todo)
            om = self.openmotor
            if om is None:
                raise FileNotFoundError("openMotor's motorlib was not found (needed to simulate .ric designs): set ric.openmotor in config.yaml or OPENMOTOR_PATH")
            mm = import_motorlib(om)
            self.cache_dir.mkdir(parents=True, exist_ok=True)
            self.log(f"  simulating {len(todo)} .ric design(s) with openMotor ({om}), timestep {self.timestep_s} s")
            for i, ric in enumerate(todo):
                r = simulate_ric(ric, mm, self.timestep_s)
                eng = self.cache_dir / f"{ric.stem}.eng"
                eng.write_text(rasp_block(r, ric, self.timestep_s))
                eng.with_suffix(".json").write_text(json.dumps({"md5": self._key(ric), "timestep_s": self.timestep_s, "source": str(ric), "designation": r.designation, "impulse_ns": round(float(np.trapezoid(r.thrust_n, r.time_s)), 1), "prop_mass_kg": r.prop_mass_kg, "warnings": r.warnings}, indent=1))
                self.log(f"  [{i + 1}/{len(todo)}] {ric.name} -> {r.designation} ({r.prop_mass_kg:.3f} kg propellant{'; ' + '; '.join(r.warnings[:1]) if r.warnings else ''})")
        for ric in rics:
            out.append(self.cache_dir / f"{ric.stem}.eng")
        return out
