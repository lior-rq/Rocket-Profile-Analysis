"""Command line: python -m rpa <stage> [options]"""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

import pandas as pd

from .config import load_config
from .pipeline import Pipeline, log

STAGES = ["motors", "mass", "characterize", "search", "verify", "report"]


def build_parser():
    ap = argparse.ArgumentParser(prog="rpa", description="Two-stage flight profile optimizer (OpenRocket + RASAero II SOP automation)")
    ap.add_argument("stage", choices=[*STAGES, "run", "check", "aero", "reference", "validate", "confirm", "inspect", "gui"], help="pipeline stage; 'run' = all stages in order; 'check' = validate the input set; 'reference' = export RASAero reference flights (VM); 'validate' = compare the python backend against them; 'inspect' = map RASAero's GUI via the VM worker; 'gui' = open the local web GUI")
    ap.add_argument("--config", default=None, help="config.yaml path (default: ./config.yaml)")
    ap.add_argument("--root", default=None, help="repo root (default: cwd)")
    ap.add_argument("--backend", choices=["python", "rasaero", "openrocket"], default=None, help="override backend")
    ap.add_argument("--target", type=float, default=None, help="target apogee [ft]")
    ap.add_argument("--tolerance", type=float, default=None, help="apogee tolerance [ft]")
    ap.add_argument("--worker-mode", choices=["auto", "manual"], default=None)
    ap.add_argument("--boosters", default=None, help="comma-separated booster labels or 1-based indices to restrict to (testing)")
    ap.add_argument("--limit", type=int, default=None, help="only the first N boosters (testing)")
    ap.add_argument("--include-unsolved", action="store_true", help="verify: also export unsolved/over/underpowered designs")
    ap.add_argument("--decel-subsonic", action="store_true", help="also consider the optional 'coast attached below Mach 0.9, then separate' variant")
    ap.add_argument("--fresh", action="store_true", help="ignore cached stage outputs (re-runs everything for 'run')")
    ap.add_argument("--cases", type=int, default=10, help="reference: number of RASAero reference flights to export")
    ap.add_argument("--top", type=int, default=5, help="confirm: how many designs (closest to target) to re-run in RASAero")
    ap.add_argument("--port", type=int, default=8765, help="gui: local port (default 8765)")
    ap.add_argument("--no-browser", action="store_true", help="gui: do not open the browser automatically")
    ap.add_argument("--make-app", action="store_true", help="gui: build the double-clickable 'Rocket Profile Analysis.app' (macOS) and exit")
    ap.add_argument("--quiet", action="store_true", help="gui: no console output (used by the .app launcher)")
    return ap


def main(argv=None):
    args = build_parser().parse_args(argv)
    if args.stage == "gui":
        root = Path(args.root or Path.cwd()).resolve()
        if args.make_app:
            from .gui.launcher import make_app, write_command_file

            made = make_app(root)
            write_command_file(root)
            print("built: " + ", ".join(str(m) for m in made) + "\nDouble-click it (or drag the one in ~/Applications to the Dock); 'Start GUI.command' is the Terminal fallback.")
            return
        from .gui.server import serve

        serve(root, port=args.port, open_browser=not args.no_browser, quiet=args.quiet)
        return
    over = {}
    if args.backend:
        over["backend"] = args.backend
    if args.target is not None or args.tolerance is not None:
        over["target"] = {k: v for k, v in [("apogee_ft", args.target), ("tolerance_ft", args.tolerance)] if v is not None}
    if args.worker_mode:
        over["worker"] = {"mode": args.worker_mode}
    if args.decel_subsonic:
        over["profiles"] = {"include_decel_subsonic": True}
    cfg = load_config(args.config, root=args.root, overrides=over)
    if args.fresh:
        for f in ["mass_table.csv", "characterization.csv", "eligibility.csv", "designs.csv", "designs_samples.json", "search_rows.csv"]:
            p = cfg.output_dir / f
            if p.exists():
                p.unlink()
    pipe = Pipeline(cfg)
    if args.boosters or args.limit:
        ms = pipe.ms
        if args.boosters:
            keys = [k.strip() for k in args.boosters.split(",")]
            sel = [b for b in ms.boosters if b.label in keys or str(b.index) in keys or f"{b.index:02d}" in keys]
        else:
            sel = ms.boosters[: args.limit]
        if not sel:
            sys.exit(f"no boosters matched {args.boosters!r}")
        ms.boosters = sel
        log(f"restricted to {len(sel)} booster(s): {', '.join(b.label for b in sel)}")

    if args.stage == "inspect":
        pipe.inspect_rasaero()
        return
    if args.stage == "check":
        sys.exit(1 if pipe.check() else 0)
    if args.stage == "aero":
        pipe.stage_aero(force=args.fresh)
        return
    if args.stage == "confirm":
        pipe.stage_confirm(top_n=args.top, include_unsolved=args.include_unsolved)
        return
    if args.stage == "reference":
        pipe.stage_reference(args.cases)
        return
    if args.stage == "validate":
        df = pipe.stage_validate()
        sys.exit(0 if bool(df["pass"].all()) else 1)
    stages = STAGES if args.stage == "run" else [args.stage]
    try:
        run_stages(pipe, cfg, stages, args)
    finally:
        pipe.close()


def run_stages(pipe, cfg, stages, args):
    for st in stages:
        log(f"=== {st} ===")
        if st == "motors":
            pipe.stage_motors()
        elif st == "mass":
            pipe.stage_mass()
        elif st == "characterize":
            pipe.stage_characterize()
        elif st == "search":
            pipe.stage_search()
        elif st == "verify":
            pipe.stage_verify(include_unsolved=args.include_unsolved)
        elif st == "report":
            ranked = pipe.stage_report()
            if not ranked.empty:
                cols = [c for c in ["rank", "booster", "profile", "status", "sep_delay_s", "ign_delay_s", "apogee_ft", "mach_at_sep", "vel_at_ign_fps", "verified_ok"] if c in ranked.columns]
                with pd.option_context("display.width", 200, "display.max_rows", 200):
                    print(ranked[cols].head(30).to_string(index=False))


if __name__ == "__main__":
    main()
