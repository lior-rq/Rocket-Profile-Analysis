#!/usr/bin/env python3
"""Assemble build/template/ (the first project a fresh install gets) from the
repo's config.yaml and input/: motor files, the .ork and .CDX1; with --full
also the reference flights (regenerable in the app).
Paths in the copied config.yaml stay relative, so the template works
wherever it is copied. Without a config.yaml (CI, a fresh checkout) the
template is config.example.yaml with an empty input/: the user picks files."""
from __future__ import annotations

import shutil
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
DST = ROOT / "build" / "template"
SKIP_SUFFIXES = {".pyc", ".DS_Store"}
SKIP_NAMES = {"Debugfile.txt", "__pycache__"}


def copy_tree(src: Path, dst: Path) -> int:
    n = 0
    for p in src.rglob("*"):
        if p.is_dir() or p.name in SKIP_NAMES or p.suffix in SKIP_SUFFIXES or any(part in SKIP_NAMES for part in p.parts):
            continue
        rel = p.relative_to(src)
        (dst / rel).parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(p, dst / rel)
        n += 1
    return n


def main() -> None:
    sys.path.insert(0, str(ROOT))
    from rpa.config import load_config

    if DST.exists():
        shutil.rmtree(DST)
    DST.mkdir(parents=True)
    if not (ROOT / "config.yaml").exists() or "--generic" in sys.argv[1:]:
        shutil.copy2(ROOT / "config.example.yaml", DST / "config.yaml")
        for d in ("input", "output", "jobs"):
            (DST / d).mkdir()
        print(f"template: generic (config.example.yaml, no inputs) -> {DST}")
        return
    cfg = load_config(ROOT / "config.yaml", root=ROOT)
    shutil.copy2(ROOT / "config.yaml", DST / "config.yaml")
    n = 0
    for key in ("ork", "cdx1"):
        p = cfg.file(key)
        if p and p.exists():
            rel = p.relative_to(ROOT) if ROOT in p.parents else Path("input") / p.name
            (DST / rel).parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(p, DST / rel)
            n += 1
    for kind in ("boosters", "sustainers"):
        for src in cfg.motor_sources(kind):
            if not src.exists():
                continue
            rel = src.relative_to(ROOT) if ROOT in src.parents else Path("input") / src.name
            n += copy_tree(src, DST / rel) if src.is_dir() else (shutil.copy2(src, (DST / rel).parent.mkdir(parents=True, exist_ok=True) or DST / rel) and 1)
    if "--full" in sys.argv[1:]:
        d = cfg.path("reference_dir")
        if d.exists():
            n += copy_tree(d, DST / d.relative_to(ROOT))
    (DST / "output").mkdir()
    (DST / "jobs").mkdir()
    size = sum(p.stat().st_size for p in DST.rglob("*") if p.is_file())
    print(f"template: {n} files, {size / 1048576:.1f} MB -> {DST}")


if __name__ == "__main__":
    main()
