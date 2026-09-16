"""Entry point of the frozen service (see build/rpa-service.spec).

argv is what the desktop shell passes: `service --port 0`."""

from __future__ import annotations

import multiprocessing
import os
import sys


def _streams() -> None:
    """A windowed exe MAY have no stdio; the port announce needs stdout."""
    if sys.stdout is None:
        sys.stdout = open(os.devnull, "w", encoding="utf-8")
    if sys.stderr is None:
        from rpa import platform as PL

        log = PL.data_dir() / "service.log"
        log.parent.mkdir(parents=True, exist_ok=True)
        sys.stderr = open(log, "a", encoding="utf-8", buffering=1)
    for s in (sys.stdout, sys.stderr):
        try:
            s.reconfigure(encoding="utf-8", errors="replace")
        except (AttributeError, ValueError):
            pass


if __name__ == "__main__":
    multiprocessing.freeze_support()
    os.environ.setdefault("PYTHONUTF8", "1")
    os.environ.setdefault("MPLBACKEND", "Agg")
    _streams()
    from rpa.cli import main

    main()
