#!/usr/bin/env python3
"""A small project for the Playwright smoke in CI: the test-suite's motor
files and CDX1 plus a one-row results set, so every page has something to
show. Usage: python build/fixture_project.py <dir>"""

from __future__ import annotations

import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "tests"))


def main() -> None:
    from test_gui import CDX1, ENG_BOOSTERS, ENG_SUSTAINER

    root = Path(sys.argv[1] if len(sys.argv) > 1 else ROOT / "build" / "fixture").resolve()
    (root / "input" / "motors" / "sus").mkdir(parents=True, exist_ok=True)
    (root / "output").mkdir(exist_ok=True)
    bfile = root / "input" / "motors" / "boosters.eng"
    sfile = root / "input" / "motors" / "sus" / "01-S1.eng"
    bfile.write_text(ENG_BOOSTERS)
    sfile.write_text(ENG_SUSTAINER)
    (root / "input" / "x.CDX1").write_text(CDX1)
    (root / "config.yaml").write_text(
        "paths:\n  ork: null\n  cdx1: input/x.CDX1\n  boosters: [input/motors/boosters.eng]\n  sustainers: [input/motors/sus]\n"
        "target:\n  apogee_ft: 45000\n  tolerance_ft: 100\nbackend: rasaero_native\nnative:\n  warm_start: false\nworker:\n  mode: manual\n"
    )
    (root / "output" / "boosters.csv").write_text(f"label,designation,file\nB2-02,B2-02,{bfile}\nB1-01,B1-01,{bfile}\n")
    (root / "output" / "sustainers.csv").write_text(f"label,designation,file\n01-S1,S1-01,{sfile}\n")
    (root / "output" / "designs.csv").write_text("booster,profile,sep_delay_s,ign_delay_s,apogee_ft,status,sustainer,t_apogee_s\nB2-02,supersonic,0.5,1.0,45050.0,solved,01-S1,52.0\n")
    print(root)


if __name__ == "__main__":
    main()
