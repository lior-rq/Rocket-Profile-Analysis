"""What each pipeline stage was run with: the config keys and input files it
depends on. Written to output/run_manifest.json after every stage so the
GUI can say *what* changed instead of guessing from file mtimes.
"""

from __future__ import annotations

import hashlib
import json
import time
from pathlib import Path

_MOTORS = ["paths.boosters", "paths.sustainers", "paths.exclude_boosters", "paths.exclude_sustainers", "ric"]
_MASS = _MOTORS + ["paths.ork", "paths.cdx1", "mass_model", "sustainer_selection", "characterization", "launch_site", "python_sim", "rasaero.sustainer_nozzle_in", "rasaero.booster_nozzle_in", "surface_finish"]
_CHAR = _MASS + ["profiles.subsonic_max_mach", "profiles.supersonic_min_mach", "profiles.mach_margin", "backend", "paths.aero_dir"]
_SEARCH = _CHAR + ["target", "profiles"]
STAGE_KEYS: dict[str, list[str]] = {
    "check": _CHAR,
    "motors": _MOTORS,
    "mass": _MASS,
    "characterize": _CHAR,
    "search": _SEARCH,
    "verify": _SEARCH,
    "report": _SEARCH + ["ranking"],
}
FILE = "run_manifest.json"


def _get(cfg, dotted: str):
    cur = cfg
    for k in dotted.split("."):
        if not isinstance(cur, dict) or k not in cur:
            return None
        cur = cur[k]
    return cur


def _flatten(prefix: str, v, out: dict):
    if isinstance(v, dict):
        for k, x in v.items():
            _flatten(f"{prefix}.{k}", x, out)
    else:
        out[prefix] = v


def config_view(cfg, stage: str) -> dict:
    """The stage's config keys, flattened to dotted leaves."""
    out: dict = {}
    for key in STAGE_KEYS.get(stage, _SEARCH):
        _flatten(key, _get(cfg, key), out)
    return out


def input_files(cfg, stage: str) -> list[Path]:
    files: list[Path] = []
    for kind in ("boosters", "sustainers"):
        for src in cfg.motor_sources(kind):
            if src.is_dir():
                files += sorted(src.glob("*.eng")) + sorted(src.glob("*.ric"))
            else:
                files.append(src)
    if stage != "motors":
        files += [p for k in ("ork", "cdx1") if (p := cfg.file(k))]
    if stage not in ("motors", "mass"):
        aero = cfg.path("aero_dir")
        if aero.exists():
            files += sorted(aero.glob("*.csv"))
        files.append(cfg.path("reference_dir") / "density_calibration.csv")
    return files


_DIGESTS: dict[str, tuple[tuple, str]] = {}  # path -> ((mtime_ns, size), md5)


def digest(p: Path) -> str | None:
    """Content hash (cached by mtime+size): a rewrite of identical content,
    e.g. validate re-saving the density calibration, is not a change."""
    try:
        st = p.stat()
    except OSError:
        return None
    key = (st.st_mtime_ns, st.st_size)
    hit = _DIGESTS.get(str(p))
    if hit and hit[0] == key:
        return hit[1]
    h = hashlib.md5()
    with open(p, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    _DIGESTS[str(p)] = (key, h.hexdigest())
    return _DIGESTS[str(p)][1]


def snapshot(cfg, stage: str) -> dict:
    inputs = {_rel(p, cfg.root): digest(p) for p in input_files(cfg, stage)}
    return {"config": config_view(cfg, stage), "inputs": inputs}


def _rel(p: Path, root: Path) -> str:
    try:
        return str(Path(p).resolve().relative_to(Path(root).resolve()))
    except ValueError:
        return str(p)


def read(cfg) -> dict:
    p = cfg.output_dir / FILE
    try:
        return json.loads(p.read_text())
    except (OSError, ValueError):
        return {}


def write(cfg, stage: str, **extra) -> dict:
    man = read(cfg)
    man[stage] = {**snapshot(cfg, stage), "finished": time.time(), **extra}
    (cfg.output_dir / FILE).write_text(json.dumps(man, indent=1, default=str))
    return man


def diff(entry: dict, current: dict) -> list[str]:
    """Human-readable differences between a manifest entry and now."""
    out = []
    a, b = entry.get("config") or {}, current.get("config") or {}
    for k in sorted(set(a) | set(b)):
        if a.get(k) != b.get(k):
            out.append(f"{k}: {_short(a.get(k))} → {_short(b.get(k))}")
    ia, ib = entry.get("inputs") or {}, current.get("inputs") or {}
    changed = [k for k in ib if k in ia and ia[k] != ib[k]]
    added = [k for k in ib if k not in ia]
    removed = [k for k in ia if k not in ib]
    if changed:
        out.append(f"{len(changed)} input file(s) changed: " + _names(changed))
    if added:
        out.append(f"{len(added)} input file(s) added: " + _names(added))
    if removed:
        out.append(f"{len(removed)} input file(s) removed: " + _names(removed))
    return out


def _names(paths: list[str], n: int = 3) -> str:
    names = [Path(p).name for p in paths]
    return ", ".join(names[:n]) + (f" +{len(names) - n} more" if len(names) > n else "")


def _short(v) -> str:
    s = json.dumps(v, default=str) if isinstance(v, (list, dict)) else str(v)
    return s if len(s) <= 40 else s[:37] + "…"
