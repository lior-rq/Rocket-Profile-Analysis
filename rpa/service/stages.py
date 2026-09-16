"""One pipeline stage, in this process, through the same code path as the
command line (rpa.cli.run), so flags and behaviour cannot drift."""

from __future__ import annotations

from pathlib import Path

STAGES = {"check", "aero", "reference", "validate", "run", "motors", "mass", "characterize", "search", "verify", "report", "confirm", "inspect"}
FLAGS = {"--backend", "--engine", "--target", "--tolerance", "--worker-mode", "--boosters", "--limit", "--include-unsolved", "--decel-subsonic", "--fresh", "--cases", "--top", "--designs"}


def run_stage(stage: str, args: list[str], root: Path) -> int:
    from .. import cli

    argv = [stage, *args]
    if "--root" not in args:
        argv += ["--root", str(root)]
    try:
        return int(cli.run(argv) or 0)
    except SystemExit as e:  # argparse
        return int(e.code or 0) if isinstance(e.code, int) else 2
