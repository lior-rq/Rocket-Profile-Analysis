"""Make the GUI easy to start.

* `python -m rpa gui` (and Start GUI.command) now: reuses a GUI that is
  already running (just opens the browser), picks the next free port when
  the default one is taken by something else, and can quit from the page.
* `python -m rpa gui --make-app` builds a double-clickable macOS app,
  "Rocket Profile Analysis.app", in the repo root (and optionally in
  ~/Applications) that does the same without a Terminal window.
"""

from __future__ import annotations

import json
import os
import plistlib
import shutil
import socket
import stat
import subprocess
import sys
import time
import urllib.request
from pathlib import Path

APP_NAME = "Rocket Profile Analysis"
PING_PATH = "/api/ping"


def ping(port: int, timeout: float = 1.5) -> dict | None:
    """The running GUI's identity on this port, or None (nothing / something else)."""
    try:
        with urllib.request.urlopen(f"http://127.0.0.1:{port}{PING_PATH}", timeout=timeout) as r:
            d = json.loads(r.read().decode())
            return d if d.get("app") == "rpa" else None
    except Exception:  # noqa: BLE001 - connection refused, timeout, not JSON: not ours
        return None


def port_free(port: int) -> bool:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        try:
            s.bind(("127.0.0.1", port))
            return True
        except OSError:
            return False


LOCK_NAME = "gui.lock"


def lock_path(root: Path) -> Path:
    return Path(root) / "output" / LOCK_NAME


def read_lock(root: Path) -> dict | None:
    """The GUI serving this repo per output/gui.lock, if it still answers."""
    try:
        d = json.loads(lock_path(root).read_text())
        info = ping(int(d["port"]))
    except (OSError, ValueError, KeyError, TypeError):
        return None
    if info and Path(info.get("root", "")).resolve() == Path(root).resolve():
        return {**info, "port": int(d["port"])}
    return None


def write_lock(root: Path, port: int) -> None:
    try:
        lock_path(root).parent.mkdir(parents=True, exist_ok=True)
        lock_path(root).write_text(json.dumps({"port": port, "pid": os.getpid(), "started": time.time()}))
    except OSError:
        pass


def remove_lock(root: Path) -> None:
    try:
        if json.loads(lock_path(root).read_text()).get("pid") == os.getpid():
            lock_path(root).unlink()
    except (OSError, ValueError):
        pass


def choose_port(preferred: int, root: Path, tries: int = 10) -> tuple[int, dict | None]:
    """(port to serve on, running instance to reuse instead). A GUI already
    serving this repo wins (on any port, via output/gui.lock); a foreign
    process on the port is skipped."""
    running = read_lock(root)
    if running is not None:
        return running["port"], running
    for p in range(preferred, preferred + tries):
        info = ping(p)
        if info is not None:
            if Path(info.get("root", "")).resolve() == root.resolve():
                return p, info
            continue  # our GUI, but for another project: leave it alone
        if port_free(p):
            return p, None
    raise OSError(f"no free port in {preferred}-{preferred + tries - 1}")


# ---- macOS app bundle ----
LAUNCH_SH = """#!/bin/bash
# double-clickable launcher (built by `python -m rpa gui --make-app`)
ROOT="__ROOT__"
if [ ! -d "$ROOT" ]; then
  osascript -e 'display alert "Rocket Profile Analysis" message "The project folder was not found:\\n__ROOT__\\n\\nRebuild the app from its new location with:  python -m rpa gui --make-app"'
  exit 1
fi
cd "$ROOT" || exit 1
if [ ! -x .venv/bin/python ]; then
  osascript -e 'display notification "Setting up the Python environment (first launch only)…" with title "Rocket Profile Analysis"'
  python3 -m venv .venv && .venv/bin/pip install -q -r requirements.txt || {
    osascript -e 'display alert "Rocket Profile Analysis" message "Could not create the Python environment. Open Terminal in the project folder and run:  python3 -m venv .venv && .venv/bin/pip install -r requirements.txt"'
    exit 1
  }
fi
exec .venv/bin/python -m rpa gui --quiet
"""


def _render_icon(png_path: Path, size: int = 1024) -> bool:
    """A rocket on a rounded blue tile, via Pillow (Apple Color Emoji when available)."""
    try:
        from PIL import Image, ImageDraw, ImageFont
    except ImportError:
        return False
    img = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    m = int(size * 0.06)
    d.rounded_rectangle((m, m, size - m, size - m), radius=int(size * 0.22), fill=(30, 64, 175, 255))
    d.rounded_rectangle((m, m, size - m, int(size * 0.55)), radius=int(size * 0.22), fill=(37, 99, 235, 255))
    d.rectangle((m, int(size * 0.35), size - m, int(size * 0.55)), fill=(37, 99, 235, 255))
    drawn = False
    emoji_font = Path("/System/Library/Fonts/Apple Color Emoji.ttc")
    if emoji_font.exists():
        try:
            f = ImageFont.truetype(str(emoji_font), 160)  # the only bitmap size Pillow accepts for this font
            glyph = Image.new("RGBA", (200, 200), (0, 0, 0, 0))
            ImageDraw.Draw(glyph).text((20, 10), "🚀", font=f, embedded_color=True)
            glyph = glyph.crop(glyph.getbbox()).resize((int(size * 0.62), int(size * 0.62)), Image.LANCZOS)
            img.alpha_composite(glyph, (int((size - glyph.width) / 2), int((size - glyph.height) / 2)))
            drawn = True
        except Exception:  # noqa: BLE001 - fall back to a drawn rocket
            drawn = False
    if not drawn:
        cx = size / 2
        d.polygon([(cx, size * 0.17), (cx + size * 0.14, size * 0.55), (cx - size * 0.14, size * 0.55)], fill=(255, 255, 255, 255))
        d.rectangle((cx - size * 0.14, size * 0.55, cx + size * 0.14, size * 0.72), fill=(255, 255, 255, 255))
        d.ellipse((cx - size * 0.06, size * 0.40, cx + size * 0.06, size * 0.52), fill=(37, 99, 235, 255))
        d.polygon([(cx - size * 0.14, size * 0.62), (cx - size * 0.26, size * 0.80), (cx - size * 0.14, size * 0.74)], fill=(249, 115, 22, 255))
        d.polygon([(cx + size * 0.14, size * 0.62), (cx + size * 0.26, size * 0.80), (cx + size * 0.14, size * 0.74)], fill=(249, 115, 22, 255))
        d.polygon([(cx - size * 0.08, size * 0.72), (cx + size * 0.08, size * 0.72), (cx, size * 0.88)], fill=(251, 191, 36, 255))
    img.save(png_path)
    return True


def _make_icns(png: Path, icns: Path) -> bool:
    iconset = icns.with_suffix(".iconset")
    if iconset.exists():
        shutil.rmtree(iconset)
    iconset.mkdir()
    ok = True
    for pt in (16, 32, 128, 256, 512):
        for scale in (1, 2):
            px = pt * scale
            name = f"icon_{pt}x{pt}{'@2x' if scale == 2 else ''}.png"
            r = subprocess.run(["sips", "-z", str(px), str(px), str(png), "--out", str(iconset / name)], capture_output=True, check=False)
            ok = ok and r.returncode == 0
    r = subprocess.run(["iconutil", "-c", "icns", str(iconset), "-o", str(icns)], capture_output=True, check=False)
    shutil.rmtree(iconset, ignore_errors=True)
    return ok and r.returncode == 0 and icns.exists()


def make_app(root: Path, install: bool = True) -> list[Path]:
    """Build '<APP_NAME>.app' in the repo root; also copy it to ~/Applications."""
    if sys.platform != "darwin":
        raise RuntimeError("--make-app builds a macOS application bundle; on other systems use `python -m rpa gui`")
    app = root / f"{APP_NAME}.app"
    contents = app / "Contents"
    if app.exists():
        shutil.rmtree(app)
    (contents / "MacOS").mkdir(parents=True)
    (contents / "Resources").mkdir()
    launch = contents / "MacOS" / "launch"
    launch.write_text(LAUNCH_SH.replace("__ROOT__", str(root)))
    launch.chmod(launch.stat().st_mode | stat.S_IEXEC | stat.S_IXGRP | stat.S_IXOTH)
    png = contents / "Resources" / "icon.png"
    icns = contents / "Resources" / "icon.icns"
    has_icon = _render_icon(png) and _make_icns(png, icns)
    if png.exists():
        png.unlink()
    info = {
        "CFBundleName": APP_NAME,
        "CFBundleDisplayName": APP_NAME,
        "CFBundleIdentifier": "local.rocket-profile-analysis.gui",
        "CFBundleVersion": "1.0",
        "CFBundleShortVersionString": "1.0",
        "CFBundlePackageType": "APPL",
        "CFBundleExecutable": "launch",
        "LSUIElement": True,  # no Dock icon: the GUI lives in the browser; quit from its header
        "LSMinimumSystemVersion": "12.0",
        "NSHighResolutionCapable": True,
    }
    if has_icon:
        info["CFBundleIconFile"] = "icon"
    with open(contents / "Info.plist", "wb") as f:
        plistlib.dump(info, f)
    made = [app]
    if install:
        dest_dir = Path.home() / "Applications"
        dest_dir.mkdir(exist_ok=True)
        dest = dest_dir / app.name
        if dest.exists():
            shutil.rmtree(dest)
        shutil.copytree(app, dest, symlinks=True)
        made.append(dest)
    for p in made:  # let Finder pick up the new icon
        subprocess.run(["touch", str(p)], check=False)
    return made


def write_command_file(root: Path) -> Path:
    """Start GUI.command (Terminal-based fallback launcher)."""
    p = root / "Start GUI.command"
    p.write_text(
        "#!/bin/bash\n"
        "# Double-click to open the GUI. Prefer the .app: `python -m rpa gui --make-app`.\n"
        'cd "$(dirname "$0")"\n'
        "if [ ! -x .venv/bin/python ]; then\n"
        '  echo "No .venv yet - creating it (python3 -m venv .venv && pip install -r requirements.txt)"\n'
        '  python3 -m venv .venv && .venv/bin/pip install -r requirements.txt || { echo "setup failed"; read -r -p "press return"; exit 1; }\n'
        "fi\n"
        'exec .venv/bin/python -m rpa gui "$@"\n'
    )
    p.chmod(p.stat().st_mode | stat.S_IEXEC)
    return p


def open_url(url: str):
    if sys.platform == "darwin":
        subprocess.Popen(["open", url])
    else:
        import webbrowser

        webbrowser.open(url)


def notify(title: str, text: str):
    """A macOS notification (used when there is no Terminal to print to)."""
    if sys.platform == "darwin" and os.environ.get("TERM") is None:
        subprocess.run(["osascript", "-e", f'display notification "{text}" with title "{title}"'], check=False, capture_output=True)
