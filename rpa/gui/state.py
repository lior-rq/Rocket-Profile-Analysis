"""Everything the browser needs to draw the dashboard, computed from the
files on disk (config.yaml, the configured inputs, output/, jobs/,
worker/console.log). Only the motor set is cached; a call takes tens of ms."""

from __future__ import annotations

import json
import math
import os
import re
import time
from pathlib import Path

import pandas as pd

from .. import manifest
from ..config import load_config
from ..eng import expand_motor_sources, parse_eng
from ..motors import load_motor_set

STEPS = ["inputs", "reference", "validate", "optimize", "results", "confirm"]
RUN_SUBSTAGES = [
    ("motors", ["boosters.csv", "sustainers.csv", "selected_sustainer.json", "motors/all_motors.eng"]),
    ("mass", ["mass_table.csv"]),
    ("characterize", ["characterization.csv", "eligibility.csv"]),
    ("search", ["designs.csv", "search_rows.csv", "designs_samples.json"]),
    ("verify", ["designs.csv"]),
    ("report", ["report.md", "designs_ranked.csv", "apogee_vs_delay.png", "boost_mach.png", "final_mach_vs_time.png"]),
]
TABLES = {
    "designs": "designs.csv",
    "designs_ranked": "designs_ranked.csv",
    "characterization": "characterization.csv",
    "eligibility": "eligibility.csv",
    "confirm": "confirm.csv",
    "boosters": "boosters.csv",
    "sustainers": "sustainers.csv",
    "mass_table": "mass_table.csv",
    "validation": "validation/validation.csv",
}  # search_rows.csv is deliberately absent: tens of MB, nothing shows it


def file_info(p: Path | None, root: Path | None = None) -> dict:
    if p is None:
        return {"name": None, "path": None, "exists": False, "mtime": None, "size": None}
    rel = _rel(p, root) if root else str(p)
    try:
        st = p.stat()
        return {"name": p.name, "path": rel, "exists": True, "mtime": st.st_mtime, "size": st.st_size}
    except OSError:
        return {"name": p.name, "path": rel, "exists": False, "mtime": None, "size": None}


def ago_text(seconds: float) -> str:
    seconds = max(0.0, float(seconds))
    if seconds < 90:
        return f"{seconds:.0f}s ago"
    if seconds < 5400:
        return f"{seconds / 60:.0f} min ago"
    return f"{seconds / 3600:.1f} h ago"


def _rel(p: Path, root: Path) -> str:
    """Path relative to the project root; the unresolved form first so a
    symlinked input/ still maps to 'input/...'."""
    for a, b in ((Path(p), Path(root)), (Path(p).resolve(), Path(root).resolve())):
        try:
            return a.relative_to(b).as_posix()
        except ValueError:
            continue
    return str(p)


def _mtime(p: Path | None) -> float | None:
    try:
        return p.stat().st_mtime if p is not None else None
    except OSError:
        return None


def _newest(paths) -> float | None:
    ts = [m for p in paths if (m := _mtime(p)) is not None]
    return max(ts) if ts else None


def _nan_to_none(v):
    if isinstance(v, float) and math.isnan(v):
        return None
    if hasattr(v, "item"):
        v = v.item()
        if isinstance(v, float) and math.isnan(v):
            return None
    return v


def records(df: pd.DataFrame) -> list[dict]:
    return [{k: _nan_to_none(v) for k, v in rec.items()} for rec in df.to_dict("records")]


class StateCollector:
    def __init__(self, root: Path):
        self.root = Path(root)
        self._ms_key = None
        self._ms = None
        self._ms_error = None
        self._eng_cache: dict[str, tuple[tuple, dict]] = {}

    def ric_converter(self, cfg):
        from ..ric import RicConverter

        r = cfg.get("ric") or {}
        return RicConverter(cfg.output_dir / "motors" / "ric_cache", r.get("openmotor", "auto"), r.get("timestep_s", 0.002), root=cfg.root, allow_simulate=False)

    def motor_files(self, cfg, kind: str) -> tuple[list[Path], list[str]]:
        """(files, problems) for the configured booster/sustainer sources.
        .ric designs are only used from the cache here (simulating them is
        the Check / motors stage's job); missing ones are reported."""
        from ..ric import RicPending

        files, problems = [], []
        conv = self.ric_converter(cfg)
        if not cfg.motor_sources(kind):
            problems.append("no motor files selected")
        for src in cfg.motor_sources(kind):
            try:
                got = expand_motor_sources([src], ric=conv)
                if not got:
                    problems.append(f"no .eng or .ric files in {src}")
                files += [f for f in got if f not in files]
            except RicPending as e:
                problems.append(f"{kind}: {e}")
            except (FileNotFoundError, ValueError) as e:
                problems.append(str(e))
        return files, problems

    def eng_info(self, path: Path) -> dict:
        """Header numbers of one .eng file (cached by mtime) for the picker."""
        try:
            st = path.stat()
            key = (st.st_mtime_ns, st.st_size)
        except OSError:
            return {"error": "missing"}
        hit = self._eng_cache.get(str(path))
        if hit and hit[0] == key:
            return hit[1]
        try:
            ms = parse_eng(path)
            m = ms[0]
            info = {"designation": m.designation, "total_impulse_ns": round(m.total_impulse_ns, 1), "burn_time_s": round(m.burn_time_s, 2), "avg_thrust_n": round(m.avg_thrust_n, 1), "prop_mass_kg": m.prop_mass_kg, "nozzle_exit_in": m.nozzle_exit_in, "n_motors": len(ms)}
        except Exception as e:
            info = {"error": f"{type(e).__name__}: {e}"}
        self._eng_cache[str(path)] = (key, info)
        return info

    # ---- helpers ------------------------------------------------------------
    def config(self):
        return load_config(self.root / "config.yaml", root=self.root)

    def motor_set(self, cfg):
        bf, _ = self.motor_files(cfg, "boosters")
        sf, _ = self.motor_files(cfg, "sustainers")
        key = tuple((str(f), _mtime(f)) for f in bf), tuple((str(f), _mtime(f)) for f in sf), tuple(sorted(cfg.excluded("boosters"))), tuple(sorted(cfg.excluded("sustainers")))
        if key != self._ms_key:
            self._ms_key = key
            try:
                self._ms = load_motor_set(cfg.motor_sources("boosters"), cfg.motor_sources("sustainers"), ric=self.ric_converter(cfg), exclude_boosters=cfg.excluded("boosters"), exclude_sustainers=cfg.excluded("sustainers"))
                self._ms_error = None
            except Exception as e:
                self._ms = None
                self._ms_error = f"{type(e).__name__}: {e}"
        return self._ms, self._ms_error

    def motor_tree(self, entries: list, extra_folders: list | None = None) -> dict:
        """Folder groups for the motor picker. `entries` is a config list
        (folders and/or files); `extra_folders` are folders shown with
        nothing ticked yet. Paths come back in the form config.yaml stores
        them: relative when under the project, absolute otherwise."""
        cfg = self.config()
        folders: dict[Path, Path] = {}  # resolved -> as given
        selected: set[str] = set()
        unknown: list[str] = []
        for entry in [*(entries or []), *(extra_folders or [])]:
            if entry in (None, ""):
                continue
            p = cfg.resolve(entry)
            if p.is_dir():
                folders.setdefault(p.resolve(), p)
                if entry in (entries or []):
                    for f in list(p.glob("*.eng")) + list(p.glob("*.ric")):
                        selected.add(_rel(f, self.root))
            elif p.is_file():
                folders.setdefault(p.resolve().parent, p.parent)
                selected.add(_rel(p, self.root))
            else:
                unknown.append(str(entry))
        conv = self.ric_converter(cfg)
        out = []
        for p in sorted(folders.values(), key=lambda d: _rel(d, self.root)):
            files = []
            for f in sorted(list(p.glob("*.eng")) + list(p.glob("*.ric"))):
                if f.suffix.lower() == ".ric":
                    cached = conv.cached(f)
                    info = self.eng_info(cached) if cached else {"n_motors": 1, "pending": True}
                    files.append({"name": f.name, "label": f.stem, "path": _rel(f, self.root), "kind": "ric", **info})
                else:
                    files.append({"name": f.name, "label": f.stem, "path": _rel(f, self.root), "kind": "eng", **self.eng_info(f)})
            out.append({"path": _rel(p, self.root), "n": len(files), "files": files})
        return {"folders": out, "selected": sorted(selected), "unknown": unknown}

    # ---- the big one --------------------------------------------------------
    def collect(self, runner, vm=None) -> dict:
        root = self.root
        cfg = self.config()
        out = cfg.output_dir
        ms, ms_err = self.motor_set(cfg)

        # inputs --------------------------------------------------------------
        ork, cdx1 = cfg.file("ork"), cfg.file("cdx1")
        b_files, b_problems = self.motor_files(cfg, "boosters")
        s_files, s_problems = self.motor_files(cfg, "sustainers")
        motor_files = b_files + s_files
        inputs_mtime = _newest([root / "config.yaml", ork, cdx1, *motor_files]) or 0.0
        site, site_cdx1, ref_dia, cdx_err = None, None, None, None
        try:
            from .. import cdx1 as C

            tree = C.load(cfg.path("cdx1"))
            site_cdx1 = C.launch_site(tree)
            site = dict(site_cdx1)
            site.update({k: v for k, v in cfg["launch_site"].items() if v is not None})
            ref_dia = C.reference_diameter_in(tree)
        except Exception as e:
            cdx_err = f"{type(e).__name__}: {e}"
        motors = None
        if ms is not None:
            nozs = [b.nozzle_exit_in for b in ms.boosters if b.nozzle_exit_in]
            imps = [b.total_impulse_ns for b in ms.boosters]
            motors = {
                "n_boosters": len(ms.boosters),
                "booster_impulse_ns": [min(imps), max(imps)] if imps else None,
                "booster_nozzle_in": [min(nozs), max(nozs)] if nozs else None,
                "boosters_missing_nozzle": [b.label for b in ms.boosters if b.nozzle_exit_in is None],
                "sustainer": {"label": ms.sustainer.label, "designation": ms.sustainer.designation, "total_impulse_ns": round(ms.sustainer.total_impulse_ns, 1), "burn_time_s": round(ms.sustainer.burn_time_s, 3), "nozzle_exit_in": ms.sustainer.nozzle_exit_in, "avg_thrust_n": round(ms.sustainer.avg_thrust_n, 1), "prop_mass_kg": ms.sustainer.prop_mass_kg},
                "n_sustainer_candidates": len(ms.sustainer_candidates),
                "sustainer_impulse_ns": [min(m.total_impulse_ns for m in ms.sustainer_candidates), max(m.total_impulse_ns for m in ms.sustainer_candidates)],
                "sustainer_selection": self._sustainer_selection(cfg),
            }
        last_check = runner.last_run("check")
        problems = []
        if ork is None:
            problems.append("no OpenRocket model (.ork) selected")
        elif not ork.exists():
            problems.append(f"OpenRocket file not found: {cfg['paths']['ork']}")
        if cdx1 is None:
            problems.append("no RASAero model (.CDX1) selected")
        elif not cdx1.exists():
            problems.append(f"RASAero file not found: {cfg['paths']['cdx1']}")
        for pr in b_problems:
            problems.append(f"boosters: {pr}")
        for pr in s_problems:
            problems.append(f"sustainers: {pr}")
        if ms_err and not (b_problems or s_problems):
            problems.append(f"motor set: {ms_err}")
        if cdx_err:
            problems.append(f"CDX1: {cdx_err}")
        if motors and motors["boosters_missing_nozzle"] and not cfg["rasaero"]["booster_nozzle_in"]:
            problems.append(f"{len(motors['boosters_missing_nozzle'])} booster .eng file(s) without a nozzle exit diameter comment")
        man = manifest.read(cfg)
        if last_check is None and man.get("check"):  # `rpa check` from a terminal
            c = man["check"]
            last_check = {"stage": "check", "args": [], "started": c["finished"], "finished": c["finished"], "elapsed_s": 0, "exit_code": 1 if c.get("problems") else 0, "cancelled": False, "error_lines": 0, "source": "cli"}
        check_stale, check_changes = self._stale_since(man, "check", cfg, last_check["finished"] if last_check else None, inputs_mtime)
        if problems:
            inputs_status = "error"
        elif last_check and last_check["finished"] and not check_stale:
            inputs_status = "ok" if last_check["exit_code"] == 0 else "warn"
        else:
            inputs_status = "unchecked"
        inputs = {
            "status": inputs_status,
            "problems": problems,
            "ork": file_info(ork, root),
            "cdx1": file_info(cdx1, root),
            "boosters": {"sources": [_rel(p, root) for p in cfg.motor_sources("boosters")], "n": len(ms.boosters) if ms is not None else len(b_files), "n_files": len(b_files), "problems": b_problems},
            "sustainers": {"sources": [_rel(p, root) for p in cfg.motor_sources("sustainers")], "n": len(ms.sustainer_candidates) if ms is not None else len(s_files), "n_files": len(s_files), "problems": s_problems},
            "motors": motors,
            "site": site,
            "site_cdx1": site_cdx1,
            "ref_diameter_in": ref_dia,
            "last_check": last_check,
            "changes": check_changes,
            "inputs_mtime": inputs_mtime,
            "openrocket_jar": file_info(cfg.file("openrocket_jar")),
        }

        # mass model ----------------------------------------------------------
        mm = cfg["mass_model"]
        hw = cfg.hardware_mass_lb()
        mass = {"method": mm.get("method", "openrocket"), "hardware_mass_lb": hw, "table": None, "estimate": None}
        if ms is not None:
            sp = ms.sustainer.prop_mass_kg * 2.20462262
            bp = [b.prop_mass_kg * 2.20462262 for b in ms.boosters]
            mass["estimate"] = {"sustainer_prop_lb": round(sp, 2), "booster_prop_lb": [round(min(bp), 2), round(max(bp), 2)] if bp else None, "stack_loaded_lb": [round(hw + sp + min(bp), 1), round(hw + sp + max(bp), 1)] if (hw is not None and bp) else None}
        mt = out / "mass_table.csv"
        if mt.exists():
            try:
                mdf = pd.read_csv(mt)
                used = mdf["hardware_mass_lb"].iloc[0] if "hardware_mass_lb" in mdf.columns else None
                used = None if used is None or (isinstance(used, float) and math.isnan(used)) else float(used)
                mass["table"] = {
                    "n": len(mdf),
                    "mtime": _mtime(mt),
                    "hardware_mass_lb": used,
                    "sustainer_wt_lb": float(mdf["sustainer_wt_lb"].iloc[0]),
                    "sustainer_cg_in": float(mdf["sustainer_cg_in"].iloc[0]),
                    "sustainer_dry_lb": float(mdf["sustainer_dry_lb"].iloc[0]) if "sustainer_dry_lb" in mdf.columns and not pd.isna(mdf["sustainer_dry_lb"].iloc[0]) else None,
                    "booster_dry_lb": float(mdf["booster_dry_lb"].iloc[0]) if "booster_dry_lb" in mdf.columns and not pd.isna(mdf["booster_dry_lb"].iloc[0]) else None,
                    "combined_wt_lb": [float(mdf["combined_wt_lb"].min()), float(mdf["combined_wt_lb"].max())],
                    "combined_cg_in": [float(mdf["combined_cg_in"].min()), float(mdf["combined_cg_in"].max())],
                    "stale": (mm.get("method", "openrocket") == "openrocket" and used != hw) or (_mtime(mt) or 0) < (_mtime(ork) or 0),
                }
            except Exception as e:
                mass["table"] = {"error": str(e)}

        # reference flights ---------------------------------------------------
        ref_dir = cfg.path("reference_dir")
        cases = []
        if ref_dir.exists():
            for js in sorted(ref_dir.glob("*.json")):
                if js.name in ("altitude_offset.json",):
                    continue
                csv = js.with_suffix(".csv")
                if not csv.exists():
                    continue
                try:
                    d = json.loads(js.read_text())
                    row = d.get("row", {})
                    cases.append({"name": js.stem, "booster": row.get("booster"), "sustainer": row.get("sustainer"), "sep_delay_s": row.get("sep_delay_s"), "ign_delay_s": row.get("ign_delay_s"), "apogee_ft": row.get("max_alt_ft"), "max_vel_fps": row.get("max_vel_fps"), "mtime": _mtime(csv), "site": d.get("site")})
                except (OSError, ValueError):
                    cases.append({"name": js.stem, "error": "unreadable"})
        ref_mtime = _newest([ref_dir / (c["name"] + ".csv") for c in cases])
        reference = {
            "status": "ok" if len(cases) >= 5 else "partial" if cases else "todo",
            "cases": cases,
            "n": len(cases),
            "dir": ref_dir.relative_to(root).as_posix() if root in ref_dir.parents else str(ref_dir),
            "stale": bool(ref_mtime and (ref_mtime < (_mtime(cdx1) or 0))),
        }

        # validation ----------------------------------------------------------
        vfile = out / "validation" / "validation.csv"
        vinfo = file_info(vfile, root)
        vrows, n_pass = [], 0
        if vinfo["exists"]:
            try:
                vdf = pd.read_csv(vfile)
                n_pass = int(vdf["pass"].sum())
                keep = [c for c in ["case", "booster", "sep_delay_s", "ign_delay_s", "apogee_ref_ft", "apogee_ours_ft", "apogee_err_pct", "mach_burnout_ref", "mach_burnout_ours", "mach_burnout_err", "cd_median_err_pct", "cd_max_abs_err", "altitude_max_abs_err_ft", "velocity_max_abs_err_fps", "mach_max_abs_err", "weight_max_abs_err_lb", "thrust_max_abs_err_lb", "pass", "fail_reasons"] if c in vdf.columns]
                vrows = records(vdf[keep])
                for r in vrows:
                    r["png"] = f"output/validation/{r['case']}.png" if (out / "validation" / f"{r['case']}.png").exists() else None
            except Exception as e:
                vrows = [{"error": str(e)}]
        v_stale = bool(vinfo["exists"] and ref_mtime and vinfo["mtime"] < ref_mtime)
        validate = {
            "status": ("stale" if v_stale else "ok" if vrows and n_pass == len(vrows) else "warn" if vrows else "todo") if vinfo["exists"] else "todo",
            "file": vinfo,
            "rows": vrows,
            "n_pass": n_pass,
            "n": len(vrows),
            "tolerances": cfg["validation"],
            "stale": v_stale,
            "last_run": runner.last_run("validate"),
        }

        # optimize ------------------------------------------------------------
        substages = []
        opt_stale = False
        opt_changes: list[str] = []
        for name, files in RUN_SUBSTAGES:
            infos = [file_info(out / f, root) for f in files]
            done = all(i["exists"] for i in infos)
            mt = min((i["mtime"] for i in infos if i["exists"]), default=None)
            stale, changes = self._stale_since(man, name, cfg, mt, inputs_mtime)
            stale = bool(done and stale)
            if name == "verify" and done:
                # verify only exports solved designs; nothing to verify if none solved
                try:
                    ddf = pd.read_csv(out / "designs.csv")
                    done = ("verified_ok" in ddf.columns and ddf["verified_ok"].notna().any()) or not (ddf["status"] == "solved").any()
                except Exception:
                    done = False
            opt_stale = opt_stale or stale
            if stale:
                opt_changes += [c for c in changes if c not in opt_changes]
            substages.append({"name": name, "done": done, "mtime": mt, "stale": stale, "changes": changes if stale else [], "files": infos})
        designs_summary = self._designs_summary(out, cfg)
        n_done = sum(s["done"] for s in substages)
        optimize = {
            "status": "ok" if n_done == len(substages) and not opt_stale else "stale" if opt_stale and n_done else "partial" if n_done else "todo",
            "substages": substages,
            "stale": opt_stale,
            "changes": opt_changes,
            "designs": designs_summary,
            "last_run": runner.last_run("run"),
            "backend": cfg["backend"],
        }

        # confirm -------------------------------------------------------------
        cfile = out / "confirm.csv"
        cinfo = file_info(cfile, root)
        crows = []
        if cinfo["exists"]:
            try:
                crows = records(pd.read_csv(cfile))
            except Exception:
                crows = []
        c_stale = bool(cinfo["exists"] and designs_summary.get("mtime") and cinfo["mtime"] < designs_summary["mtime"])
        confirm = {"status": ("stale" if c_stale else "ok") if crows else "todo", "file": cinfo, "rows": crows, "stale": c_stale, "last_run": runner.last_run("confirm")}

        # worker / jobs (trimmed: the worker page fetches /api/worker) -----------
        worker = self.worker_status(cfg, vm, n_jobs=20, n_tail=20)

        return {
            "now": time.time(),
            "root": str(root),
            "config": dict(cfg),
            "inputs": inputs,
            "mass": mass,
            "reference": reference,
            "validate": validate,
            "optimize": optimize,
            "results": {"status": "ok" if designs_summary.get("n") else "todo", **designs_summary},
            "confirm": confirm,
            "worker": worker,
            "runner": runner.current(),
            "history": runner.history[-30:],
            "plots": [file_info(out / p, root) for p in ["apogee_vs_delay.png", "boost_mach.png", "final_mach_vs_time.png"] if (out / p).exists()],
        }

    @staticmethod
    def _stale_since(man: dict, stage: str, cfg, output_mtime, inputs_mtime: float) -> tuple[bool, list[str]]:
        """(stale, what changed) for a stage: the run manifest's config and
        input snapshot when the stage wrote one, else the older mtime rule."""
        entry = man.get(stage)
        if entry and output_mtime is not None and output_mtime <= float(entry.get("finished", 0)) + 5:
            changes = manifest.diff(entry, manifest.snapshot(cfg, stage))
            return bool(changes), changes
        stale = bool(output_mtime is not None and output_mtime < inputs_mtime)
        return stale, (["inputs or config.yaml changed since this stage ran (no run manifest yet)"] if stale else [])

    def _sustainer_selection(self, cfg) -> dict:
        """config.yaml sustainer_selection + the cached pick (output/sustainers_selected.json), if any."""
        sel = dict(cfg.get("sustainer_selection") or {})
        info = {"mode": sel.get("mode", "best"), "count": sel.get("count", 5), "labels": sel.get("labels") or [], "selected": None}
        p = cfg.output_dir / "sustainers_selected.json"
        if p.exists():
            try:
                d = json.loads(p.read_text())
                info["selected"] = d.get("motors") or []
                info["reference_booster"] = d.get("reference_booster")
                sweep = d.get("sweep") or []
                if sweep:
                    info["sweep_apogee_ft"] = [sweep[0]["apogee_ft"], sweep[-1]["apogee_ft"]]
                info["stale"] = d.get("key", {}).get("mode") != info["mode"] or d.get("key", {}).get("count") != info["count"]
                info["mtime"] = _mtime(p)
            except (OSError, ValueError):
                pass
        return info

    def _designs_summary(self, out: Path, cfg) -> dict:
        p = out / "designs.csv"
        if not p.exists() or p.stat().st_size == 0:
            return {"n": 0}
        try:
            df = pd.read_csv(p)
        except Exception as e:
            return {"n": 0, "error": str(e)}
        target = float(cfg["target"]["apogee_ft"])
        tol = float(cfg["target"]["tolerance_ft"])
        counts = {k: int(v) for k, v in df["status"].value_counts().items()} if "status" in df else {}
        elig = {}
        ef = out / "eligibility.csv"
        if ef.exists():
            try:
                edf = pd.read_csv(ef)
                for prof, g in edf.groupby("profile"):
                    elig[prof] = {"eligible": int(g["eligible"].sum()), "total": len(g)}
            except Exception:
                pass
        best = None
        if "apogee_ft" in df and df["apogee_ft"].notna().any():
            d = df[df["apogee_ft"].notna()].copy()
            d["dev"] = (d["apogee_ft"] - target).abs()
            solved = d[d["status"] == "solved"]
            pick = (solved if not solved.empty else d).sort_values("dev").iloc[0]
            best = {k: _nan_to_none(v) for k, v in pick.to_dict().items()}
        chars = None
        cf = out / "characterization.csv"
        if cf.exists():
            try:
                cdf = pd.read_csv(cf)
                chars = {"n": len(cdf), "mach_burnout_min": float(cdf["mach_burnout"].min()), "mach_burnout_max": float(cdf["mach_burnout"].max()), "t_burnout_min": float(cdf["t_burnout_s"].min()), "t_burnout_max": float(cdf["t_burnout_s"].max()), "events_inconsistent": int((~cdf["events_consistent"].astype(bool)).sum())}
            except Exception:
                chars = None
        sust = None
        sf = out / "sustainers_selected.json"
        if sf.exists():
            try:
                sust = json.loads(sf.read_text())
                sust = {"mode": (sust.get("key") or {}).get("mode"), "motors": sust.get("motors") or [], "n_candidates": len((sust.get("key") or {}).get("candidates") or [])}
            except Exception:
                sust = None
        return {
            "n": len(df),
            "mtime": _mtime(p),
            "counts": counts,
            "n_solved": counts.get("solved", 0),
            "n_verified_ok": int(df["verified_ok"].fillna(False).astype(bool).sum()) if "verified_ok" in df else 0,
            "target_ft": target,
            "tolerance_ft": tol,
            "best": best,
            "eligibility": elig,
            "characterization": chars,
            "sustainer": sust,
            "apogee_min_ft": float(df["apogee_ft"].min()) if "apogee_ft" in df and df["apogee_ft"].notna().any() else None,
            "apogee_max_ft": float(df["apogee_ft"].max()) if "apogee_ft" in df and df["apogee_ft"].notna().any() else None,
            "report": file_info(out / "report.md", self.root),
            "shortlist": self._shortlist(out),
        }

    @staticmethod
    def _shortlist(out: Path) -> list[str]:
        try:
            return [str(k) for k in (json.loads((out / "shortlist.json").read_text()).get("keys") or [])]
        except (OSError, ValueError, AttributeError):
            return []

    # ---- change detection ----------------------------------------------------
    def signature(self) -> int:
        """Cheap fingerprint of every file the dashboard is derived from."""
        root = self.root
        parts = []

        def add(p: Path):
            try:
                st = p.stat()
                parts.append((str(p), st.st_mtime_ns, st.st_size))
            except OSError:
                parts.append((str(p), None, None))

        def scan(d: Path, suffixes=None, depth=0):
            try:
                with os.scandir(d) as it:
                    for e in it:
                        if e.is_dir(follow_symlinks=False):
                            if depth < 1 and e.name in ("validation", "histories", "motors"):
                                scan(Path(e.path), suffixes, depth + 1)
                        elif suffixes is None or e.name.rsplit(".", 1)[-1].lower() in suffixes:
                            try:
                                st = e.stat()
                                parts.append((e.path, st.st_mtime_ns, st.st_size))
                            except OSError:
                                pass
            except OSError:
                pass

        add(root / "config.yaml")
        add(root / "worker" / "console.log")
        add(root / "worker" / "heartbeat.json")
        try:
            cfg = self.config()
            for k in ("ork", "cdx1"):
                if (p := cfg.file(k)) is not None:
                    add(p)
            for kind in ("boosters", "sustainers"):
                for src in cfg.motor_sources(kind):
                    if src.is_dir():
                        scan(src, {"eng"})
                    else:
                        add(src)
            scan(cfg.path("reference_dir"), {"csv", "json"})
            scan(cfg.output_dir, {"csv", "json", "md", "png"})
            jobs = cfg.path("jobs_dir")
            if jobs.exists():
                for d in sorted(jobs.iterdir(), reverse=True)[:60]:
                    for f in ("job.json", "claimed", "done.json"):
                        add(d / f)
        except Exception as e:
            parts.append(("config-error", str(e), None))
        return hash(tuple(parts))

    # ---- VM worker ----------------------------------------------------------
    _TS_RE = re.compile(r"^(?:(\d{4}-\d{2}-\d{2}) )?(\d{2}):(\d{2}):(\d{2}) (.*)$")

    def worker_status(self, cfg, vm=None, n_jobs: int = 60, n_tail: int = 60) -> dict:
        root = self.root
        log = root / "worker" / "console.log"
        tail: list[str] = []
        last_seen = _mtime(log)
        version = None
        hb = None
        try:
            hb = json.loads((root / "worker" / "heartbeat.json").read_text())
            hb["age_s"] = round(time.time() - float(hb.get("epoch", 0)), 1)
        except (OSError, ValueError, TypeError):
            hb = None
        alive = bool(hb and hb.get("status") == "running" and hb["age_s"] < 90)  # heartbeat every 15 s; the share is flaky
        if log.exists():
            try:
                with open(log, "rb") as f:
                    f.seek(0, os.SEEK_END)
                    size = f.tell()
                    f.seek(max(0, size - 20000))
                    tail = f.read().decode("utf-8", "replace").split("\n")[-120:]
            except OSError:
                tail = []
            for ln in reversed(tail):
                m = re.search(r"worker v(\d+)", ln)
                if m:
                    version = int(m.group(1))
                    break
        jobs_dir = cfg.path("jobs_dir")
        # the worker's own view: with the agent transport the claim marker
        # lives on the VM's disk, so the job in progress comes from here
        try:
            ws = json.loads((root / "worker" / "worker_status.json").read_text())
        except (OSError, ValueError, TypeError):
            ws = {}
        current = ws.get("job") if alive and isinstance(ws, dict) else None
        transport = vm.transport if vm is not None else "share"
        now = time.time()
        jobs = []
        if jobs_dir.exists():
            for d in sorted(jobs_dir.iterdir(), reverse=True)[:60]:
                if not d.is_dir() or not re.match(r"^\d{4}-", d.name):
                    continue
                j = self.job_info(d, brief=True)
                age = now - (j["mtime"] or now)
                if j["state"] == "queued":
                    if j["name"] == current:
                        j["state"] = "running"
                    elif (transport == "agent" and not j["pushed"] and age > 120) or (alive and age > 600):
                        j["state"] = "orphan"  # nobody will ever claim it
                jobs.append(j)
        active = [j for j in jobs if j["state"] == "running"]
        queued = [j for j in jobs if j["state"] == "queued"]
        orphans = [j for j in jobs if j["state"] == "orphan"]
        oldest_queued_age = max((now - (j["mtime"] or now) for j in queued), default=0.0)
        vm_info = vm.snapshot() if vm is not None else None
        vm_state = vm_info["status"] if vm_info else None
        current_job = None
        if current:
            started = ws.get("started")
            current_job = {"name": current, "type": ws.get("type"), "started": started, "elapsed_s": round(now - float(started), 1) if started else None}
        if active:
            state, detail = "busy", f"working on {active[0]['name']}" + (f" for {ago_text(current_job['elapsed_s'])[:-4]}" if current_job and current_job["elapsed_s"] is not None else "")
        elif queued and oldest_queued_age > 45 and not alive:
            state, detail = "unresponsive", f"{len(queued)} job(s) waiting {oldest_queued_age:.0f}s unclaimed and no heartbeat - the worker is not running"
        elif queued:
            state, detail = "queued", f"{len(queued)} job(s) waiting to be claimed"
        elif alive:
            state, detail = "online", f"idle, heartbeat {hb['age_s']:.0f}s ago" + (f" (v{version})" if version else "")
        elif vm_state and vm_state != "started":
            state, detail = "offline", f"the VM is {vm_state}"
        elif hb and hb.get("status") == "stopped":
            state, detail = "offline", f"worker stopped {ago_text(now - float(hb.get('epoch', now)))}"
        elif hb:
            state, detail = "offline", f"no heartbeat for {ago_text(hb['age_s'])}"
        elif last_seen and now - last_seen < 120:
            state, detail = "online", f"activity {ago_text(now - last_seen)} (older launcher without heartbeat)"
        else:
            state, detail = "offline", ("no heartbeat - start the worker" if last_seen else "never started")
        engine = None
        if cfg["backend"] == "rasaero_native" or str(cfg["rasaero"].get("engine", "auto")) != "vm":
            from .. import native

            engine = native.engine_status(cfg)
            if engine["ok"] and (cfg["backend"] == "rasaero_native" or not active and not queued):
                state, detail = "online", "RASAero engine (native, no VM needed)"
            elif not engine["ok"] and cfg["backend"] == "rasaero_native":
                state, detail = "offline", "RASAero native engine: " + engine["detail"]
        return {"state": state, "detail": detail, "last_seen": last_seen, "version": version, "heartbeat": hb, "alive": alive, "vm": vm_info, "transport": transport, "current_job": current_job, "console_tail": tail[-n_tail:], "jobs": jobs[:n_jobs], "n_jobs": len(jobs), "n_queued": len(queued), "n_active": len(active), "n_orphan": len(orphans), "jobs_dir": jobs_dir.relative_to(root).as_posix() if root in jobs_dir.parents else str(jobs_dir), "mode": cfg["worker"]["mode"], "engine": engine}

    def job_info(self, d: Path, brief: bool = False) -> dict:
        spec, done = {}, None
        try:
            spec = json.loads((d / "job.json").read_text())
        except (OSError, ValueError):
            pass
        try:
            done = json.loads((d / "done.json").read_text()) if (d / "done.json").exists() else None
        except (OSError, ValueError):
            done = {"status": "unreadable"}
        claimed = (d / "claimed").exists()
        if done:
            state = "ok" if done.get("status") == "ok" else "failed"
        elif claimed:
            state = "running"
        elif spec:
            state = "queued"
        else:
            state = "empty"
        claimed_at = None
        if claimed:
            try:
                claimed_at = (d / "claimed").read_text().strip()
            except OSError:
                pass
        info = {
            "name": d.name,
            "type": spec.get("type"),
            "n_rows": spec.get("n_rows"),
            "created": spec.get("created"),
            "state": state,
            "claimed_at": claimed_at,
            "pushed": (d / "pushed").exists(),
            "done": done,
            "mtime": _mtime(d / "job.json"),
            "has_result": (d / spec.get("result_cdx1", "result.CDX1")).exists() if spec else False,
            "has_export": bool(spec.get("export_csv")) and (d / spec["export_csv"]).exists() if spec else False,
            "n_png": len(list(d.glob("*.png"))),
        }
        if not brief:
            info["spec"] = spec
            info["files"] = [file_info(p, self.root) for p in sorted(d.iterdir())]
            wl = d / "worker.log"
            info["worker_log"] = wl.read_text(errors="replace").split("\n")[-400:] if wl.exists() else []
            info["images"] = [p.relative_to(self.root).as_posix() for p in sorted(d.glob("*.png"))]
        return info
