"""Configuration: config.yaml merged over built-in defaults."""

from __future__ import annotations

import copy
from pathlib import Path
from typing import Any

import yaml

DEFAULTS: dict[str, Any] = {
    "paths": {
        "ork": None,  # OpenRocket model; set from the GUI or here
        "cdx1": None,  # RASAero model
        "boosters": [],  # folders and/or .eng/.ric files, anywhere on disk
        "sustainers": [],
        "exclude_boosters": [],  # motor labels dropped after loading (single motors inside a multi-motor file)
        "exclude_sustainers": [],
        "output_dir": "output",
        "jobs_dir": "jobs",
        "aero_dir": "input/aero",
        "reference_dir": "input/rasaero_reference",
        "rasaero_host": "auto",  # rasaero-host (native/RasaeroHost build); auto = the repo's Release build
        "rasaero_engine": "vendor/rasaero/RASAeroEngine.dll",  # patched RASAero II engine (tools/rasaero_fetch.py)
        "openrocket_jar": "auto",  # auto = the installed OpenRocket (rpa.platform.find_openrocket)
        "jvm": "auto",
    },
    "target": {"apogee_ft": 45000.0, "tolerance_ft": 100.0},
    "profiles": {
        "subsonic_max_mach": 0.9,
        "supersonic_min_mach": 1.2,
        "mach_margin": 0.05,
        # booster separation, seconds after booster burnout (window searched)
        "separation_delay_min_s": 0.0,
        "separation_delay_max_s": 1.0,
        "separation_step_s": 0.5,
        # sustainer ignition, seconds after separation (window searched).
        # Floors are hard-coded at 0: ignition MUST NOT precede burnout.
        "ignition_delay_min_s": 1.0,
        "ignition_delay_max_s": 15.0,
        "coarse_step_s": 1.0,
        "max_refine_rounds": 4,
        # with several separation delays per (booster, sustainer, profile): fly the
        # middle one on the full ignition grid first, the others only around its
        # crossings (plus both ends; gaps with a sign change are filled in)
        "pilot_grid": True,
        "min_ignition_velocity_fps": 0.0,
    },
    "characterization": {"separation_delay_s": 15.0, "ignition_delay_s": 15.0},
    # which sustainer candidates the optimizer flies with every booster:
    #   best  - the max-impulse one only (one sustainer, as before)
    #   span  - `count` candidates spread over the apogee they give a reference
    #           booster (min, max, evenly spaced between; python backend)
    #   list  - exactly `labels`
    "sustainer_selection": {"mode": "best", "count": 5, "labels": []},
    # null -> keep whatever the CDX1 template has
    "launch_site": {
        "altitude_ft": None,
        "pressure_inhg": None,
        "rod_angle_deg": None,
        "rod_length_ft": None,
        "temperature_f": None,
        "wind_speed_mph": None,
    },
    "surface_finish": "Rough Camouflage Paint",
    "rasaero": {
        "engine_name_format": "{designation}  ({manufacturer})",
        "rows_per_batch": 100,
        "export_time_base_s": 0.01,
        "altitude_reference": "auto",  # auto | agl | msl - what RASAero's Altitude / MaxAltitude are relative to
        "sustainer_nozzle_in": None,  # null -> from the .eng comment header
        "booster_nozzle_in": None,
        "mach_alt_via_cdx1": False,  # opt-in: pre-write <MachAlt> instead of the dialog - verify on the VM
        "engine": "auto",  # where RASAero runs for aero tables, references and confirm: auto (native if built) | native | vm
    },
    "native": {  # RASAero's engine in-process (rpa.native): backend rasaero_native / rasaero.engine native
        "dt_s": 0.01,
        "timeout_s": 600.0,
        "rows_per_batch": 200,
        "workers": "auto",  # host processes for search batches: auto = every core (cores - 1 with backend: python), 1 = serial
        "shared": True,  # keep the host pool alive across stages / runs (one per process)
        "warm_start": True,  # the app starts the hosts and the JVM at launch, in the background
    },
    "mass_model": {
        "method": "openrocket",  # openrocket | manual
        "hardware_mass_lb": 180.0,  # dry mass; .ork dry masses scale to it. null = use .ork masses as-is
        "manual": {
            "sustainer_wt_lb": None,
            "sustainer_cg_in": None,
            "combined_wt_lb_ref": None,
            "combined_cg_in_ref": None,
            "ref_booster_prop_kg": None,
            "booster_prop_cg_in": None,
        },
    },
    "backend": "python",  # python (RASAero tables) | rasaero_native (RASAero's engine, no VM) | rasaero (VM GUI) | openrocket (preview)
    "python_sim": {  # RASAero's flight loop in Python (rpa.flightsim); atmosphere and site handling are RASAero's own
        "dt_s": 0.01,
        "max_time_s": 400.0,
        "ref_diameter_in": None,  # null -> largest body diameter in the CDX1
        "workers": "auto",  # CPU processes for search batches: auto = cores - 1, 1 = serial
    },
    "aero_tables": {  # what `rpa aero` exports from RASAero's Aero Plots
        # CD depends on altitude through the Reynolds number; a table every
        # 5000 ft keeps the python backend within ~0.01 % of RASAero's apogee
        "altitudes_ft": [float(a) for a in range(0, 100_001, 5000)],
        "stack_nozzles_in": "auto",  # auto = the largest booster nozzle (power-on CD scales exactly to any other)
        "sustainer_nozzles_in": "auto",  # auto = the largest sustainer candidate nozzle
        "plot_range": "Mach 5",
        "batch_altitudes": False,  # opt-in: all altitudes of one nozzle in one worker job - verify on the VM first
    },
    "validation": {"apogee_tol_pct": 0.1, "mach_tol": 0.001, "cd_tol_pct": 0.5, "weight_tol_lb": 0.01, "mach_at_burnout_tol": 0.002},
    "worker": {
        "mode": "auto",  # auto (VM worker polls jobs/) | manual (you run RASAero by hand)
        "transport": "auto",  # agent (guest agent) | share (Z: WebDAV); auto picks agent if utmctl found
        "poll_s": 1.5,
        "timeout_s": 3600.0,
        "max_retries": 2,
        "batch_reference_export": False,  # opt-in: one job for every `rpa reference` flight - verify on the VM first
    },
    "ranking": {"metric": "vel_at_ign_fps", "descending": True},
    "ric": {  # openMotor .ric designs as motor input (cached under output/motors/ric_cache)
        "openmotor": "auto",  # motorlib folder; auto: install, OPENMOTOR_PATH, or sibling vendor/openMotor
        "timestep_s": 0.002,  # openMotor simulation timestep for the thrust curves
    },
    "vm": {  # the GUI's "Start VM worker" button (UTM on this Mac: utmctl + guest agent)
        "name": "Windows",  # UTM virtual machine name
        "utmctl": "auto",  # path to utmctl, auto = inside /Applications/UTM.app
        "share_drive": "Z:",  # drive letter of this repo inside the VM
        "task_name": "RPAWorker",  # name of the Windows task that runs the worker on the desktop (no spaces)
        "python": "auto",  # python.exe in the VM, auto = the logged-on user's python.org install
        "boot_timeout_s": 240,
    },
}


def _merge(base: dict, over: dict) -> dict:
    out = copy.deepcopy(base)
    for k, v in (over or {}).items():
        if isinstance(v, dict) and isinstance(out.get(k), dict):
            out[k] = _merge(out[k], v)
        else:
            out[k] = v
    return out


class Config(dict):
    root: Path

    def resolve(self, p: str | Path) -> Path:
        p = Path(p).expanduser()
        return p if p.is_absolute() else self.root / p

    def file(self, key: str) -> Path | None:
        """paths.<key>, resolved; None when not set."""
        v = self["paths"].get(key)
        return self.resolve(v) if v not in (None, "") else None

    def path(self, key: str) -> Path:
        p = self.file(key)
        if p is None:
            raise FileNotFoundError(f"paths.{key} is not set (config.yaml or the GUI's Inputs page)")
        return p

    def motor_sources(self, kind: str) -> list[Path]:
        """kind: 'boosters' | 'sustainers' -> the folders/files to load, resolved."""
        lst = self["paths"].get(kind) or []
        if isinstance(lst, (str, Path)):
            lst = [lst]
        return [self.resolve(x) for x in lst]

    def excluded(self, kind: str) -> set[str]:
        """Motor labels dropped after loading (paths.exclude_<kind>)."""
        lst = self["paths"].get(f"exclude_{kind}") or []
        return {str(x) for x in ([lst] if isinstance(lst, str) else lst)}

    @property
    def output_dir(self) -> Path:
        d = self.path("output_dir")
        d.mkdir(parents=True, exist_ok=True)
        return d

    def openrocket(self) -> tuple[Path | None, Path | None]:
        """(jar, jvm): config paths when set, else the installed OpenRocket."""
        from . import platform as PL

        jar, jvm = self["paths"].get("openrocket_jar"), self["paths"].get("jvm")
        found = None
        if jar in (None, "", "auto") or jvm in (None, "", "auto"):
            found = PL.find_openrocket()
        jar_p = self.resolve(jar) if jar not in (None, "", "auto") else (Path(found["jar"]) if found and found["jar"] else None)
        jvm_p = self.resolve(jvm) if jvm not in (None, "", "auto") else (Path(found["jvm"]) if found and found["jvm"] else None)
        return jar_p, jvm_p

    def hardware_mass_lb(self) -> float | None:
        """mass_model.hardware_mass_lb; null / "" = use the .ork masses as-is."""
        hw = self["mass_model"].get("hardware_mass_lb")
        return None if hw in (None, "", "null") else float(hw)


def load_config(path: str | Path | None = None, root: str | Path | None = None, overrides: dict | None = None) -> Config:
    root = Path(root or Path.cwd()).resolve()
    data = {}
    cfg_path = Path(path) if path else root / "config.yaml"
    if not path and not cfg_path.exists():
        cfg_path = root / "config.example.yaml"  # fresh checkout
    if cfg_path.exists():
        data = yaml.safe_load(cfg_path.read_text()) or {}
    if isinstance(data.get("profiles"), dict):
        _legacy_profiles(data["profiles"])
    cfg = Config(_merge(_merge(DEFAULTS, data), overrides or {}))
    cfg.root = root
    _normalize_profiles(cfg["profiles"])
    return cfg


def _legacy_profiles(p: dict) -> None:
    """Older config.yaml keys (one separation delay + fallbacks, ignition_gap_min_s) -> windows."""
    if "separation_delay_s" in p:
        sep = float(p.pop("separation_delay_s"))
        fallbacks = [float(x) for x in p.pop("separation_delay_fallbacks", [])]
        p.setdefault("separation_delay_max_s", sep)
        p.setdefault("separation_delay_min_s", min([sep, *fallbacks]))
    p.pop("separation_delay_fallbacks", None)
    if "ignition_gap_min_s" in p:
        p.setdefault("ignition_delay_min_s", float(p.pop("ignition_gap_min_s")))


def _normalize_profiles(p: dict) -> None:
    """Enforce the physical floors and sane windows."""
    _legacy_profiles(p)
    for key in ("separation_delay_min_s", "separation_delay_max_s", "ignition_delay_min_s", "ignition_delay_max_s", "separation_step_s", "coarse_step_s"):
        p[key] = float(p[key])
    # ignition MUST NOT precede burnout: both delays floor at 0
    p["separation_delay_min_s"] = max(0.0, p["separation_delay_min_s"])
    p["ignition_delay_min_s"] = max(0.0, p["ignition_delay_min_s"])
    for lo, hi in (("separation_delay_min_s", "separation_delay_max_s"), ("ignition_delay_min_s", "ignition_delay_max_s")):
        if p[hi] < p[lo]:
            raise ValueError(f"profiles.{hi} ({p[hi]:g}) is below profiles.{lo} ({p[lo]:g})")
    for key in ("separation_step_s", "coarse_step_s"):
        if p[key] <= 0:
            raise ValueError(f"profiles.{key} must be > 0")
