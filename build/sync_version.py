#!/usr/bin/env python3
"""One version, from pyproject.toml, into app/package.json and
app/src-tauri/tauri.conf.json (semver: 1.0 -> 1.0.0, 1.1b2 -> 1.1.0-beta.2).
A pre-release tag (`-beta.N`) publishes as a GitHub prerelease, so the
updater's `latest` never points at it."""
from __future__ import annotations

import json
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def version() -> str:
    m = re.search(r'^version\s*=\s*"([^"]+)"', (ROOT / "pyproject.toml").read_text(encoding="utf-8"), re.M)
    if not m:
        sys.exit("pyproject.toml: no version")
    pep = re.fullmatch(r"(\d+(?:\.\d+){0,2})(?:(a|b|rc)(\d+))?", m.group(1))
    if not pep:
        sys.exit(f"pyproject.toml: version {m.group(1)!r} is not N.N[.N][a|b|rcN]")
    parts = pep.group(1).split(".")
    while len(parts) < 3:
        parts.append("0")
    v = ".".join(parts)
    if pep.group(2):
        v += "-" + {"a": "alpha", "b": "beta", "rc": "rc"}[pep.group(2)] + "." + pep.group(3)
    return v


def set_json(path: Path, v: str) -> None:
    d = json.loads(path.read_text(encoding="utf-8"))
    d["version"] = v
    path.write_text(json.dumps(d, indent=2) + "\n", encoding="utf-8")


def set_init(path: Path, v: str) -> None:
    s = path.read_text(encoding="utf-8")
    new = re.sub(r'^__version__ = "[^"]*"', f'__version__ = "{v}"', s, count=1, flags=re.M)
    if new != s:
        path.write_text(new, encoding="utf-8")


def main() -> None:
    v = version()
    set_json(ROOT / "app" / "package.json", v)
    set_json(ROOT / "app" / "src-tauri" / "tauri.conf.json", v)
    set_init(ROOT / "rpa" / "__init__.py", v)
    print(v)


if __name__ == "__main__":
    main()
