#!/usr/bin/env python3
"""Fetch RASAero II 1.0.2.0, extract its MSI and build the patched engine.

Steps: download zip -> unzip MSI -> msiextract -> copy payload into
vendor/rasaero/ -> CHECKSUMS -> RasaeroPatch (flag, publicize, shim) ->
verify. Needs `brew install msitools dotnet`.
"""
from __future__ import annotations

import argparse
import hashlib
import shutil
import subprocess
import sys
import tempfile
import urllib.request
import zipfile
from pathlib import Path

URL = "https://www.rasaero.com/dloads/RASAero_II_Setup_Version_1.0.2.0.zip"
ROOT = Path(__file__).resolve().parents[1]
VENDOR = ROOT / "vendor" / "rasaero"
PATCH_PROJECT = ROOT / "native" / "RasaeroPatch"
PAYLOAD = ["RASAero II.exe", "FarPoint.Win.Input.dll", "LineControls.dll", "MACTrackBarLib.dll", "ZedGraph.dll"]
DATA = "User's Personal Data Folder/RASAero II"


def sha256(p: Path) -> str:
    h = hashlib.sha256()
    with p.open("rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def download(zip_path: Path) -> None:
    if zip_path.exists():
        print(f"have {zip_path.name}")
        return
    print(f"downloading {URL}")
    with urllib.request.urlopen(URL, timeout=60) as r, zip_path.open("wb") as f:
        shutil.copyfileobj(r, f)


def unzip_msi(zip_path: Path) -> Path:
    with zipfile.ZipFile(zip_path) as z:
        names = [n for n in z.namelist() if n.lower().endswith(".msi")]
        if not names:
            sys.exit(f"{zip_path.name}: no .msi inside")
        target = VENDOR / Path(names[0]).name
        if not target.exists():
            target.write_bytes(z.read(names[0]))
    return target


def _find(root: Path, name: str) -> Path:
    hits = [p for p in root.rglob(name) if p.is_file()]
    if not hits:
        sys.exit(f"{name} not found in the extracted MSI")
    return hits[0]


def extract(msi: Path) -> None:
    """msiextract (msitools) on Mac/Linux; an administrative install
    (`msiexec /a`) on Windows. File names are searched, since the two lay
    the payload out differently."""
    with tempfile.TemporaryDirectory() as td:
        if sys.platform.startswith("win"):
            subprocess.run(["msiexec", "/a", str(msi), "/qn", f"TARGETDIR={td}"], check=True)
        else:
            if shutil.which("msiextract") is None:
                sys.exit("msiextract not found: brew install msitools")
            subprocess.run(["msiextract", "-C", td, str(msi)], check=True, capture_output=True)
        src = Path(td)
        for name in PAYLOAD + ["rasp.eng", "LSD.xml"]:
            shutil.copy2(_find(src, name), VENDOR / name)
        ex = VENDOR / "examples"
        ex.mkdir(exist_ok=True)
        for p in _find(src, "rasp.eng").parent.joinpath("Examples").iterdir():
            shutil.copy2(p, ex / p.name)
    print(f"extracted {len(PAYLOAD)} binaries, rasp.eng, {len(list((VENDOR / 'examples').iterdir()))} examples")


def checksums() -> None:
    lines = [f"{sha256(VENDOR / n)}  {n}" for n in PAYLOAD + ["rasp.eng"]]
    (VENDOR / "CHECKSUMS").write_text("\n".join(lines) + "\n", encoding="utf-8")
    print("\n".join(lines))


def patch(verify: bool) -> None:
    if shutil.which("dotnet") is None:
        sys.exit("dotnet not found: brew install dotnet")
    out = VENDOR / "RASAeroEngine.dll"
    cmd = ["dotnet", "run", "--project", str(PATCH_PROJECT), "-c", "Release", "--", "patch", str(VENDOR / "RASAero II.exe"), str(out)]
    if verify:
        cmd.append("--verify")
    subprocess.run(cmd, check=True)
    print(f"engine: {out} ({sha256(out)[:16]})")


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--no-patch", action="store_true", help="stop after extraction")
    ap.add_argument("--no-verify", action="store_true", help="skip the JIT self-test after patching")
    a = ap.parse_args()
    VENDOR.mkdir(parents=True, exist_ok=True)
    zip_path = VENDOR / Path(URL).name
    download(zip_path)
    msi = unzip_msi(zip_path)
    extract(msi)
    checksums()
    if not a.no_patch:
        patch(verify=not a.no_verify)


if __name__ == "__main__":
    main()
