"""Where things live when the tool runs as an installed app: the app's own
folder (bundled service, engine, template), the per-user data folder
(projects), and the installed OpenRocket. A source checkout keeps working:
every lookup falls back to the repo."""

from __future__ import annotations

import os
import shutil
import sys
from pathlib import Path

APP_NAME = "Rocket Profile Analysis"
REPO = Path(__file__).resolve().parents[1]


def frozen() -> bool:
    return bool(getattr(sys, "frozen", False))


def app_dir() -> Path:
    """The folder that holds the bundled resources.

    Installed: <app>/resources/rpa-service/ (PyInstaller onedir) sits next to
    resources/rasaero/ and resources/template/, so two levels up from the
    executable. Source checkout: the repo."""
    if frozen():
        return Path(sys.executable).resolve().parent.parent
    env = os.environ.get("RPA_APP_DIR")
    return Path(env) if env else REPO


def resource(*parts: str) -> Path:
    return app_dir().joinpath(*parts)


def data_dir() -> Path:
    env = os.environ.get("RPA_DATA_DIR")
    if env:
        return Path(env)
    if sys.platform == "darwin":
        return Path.home() / "Library" / "Application Support" / APP_NAME
    if sys.platform.startswith("win"):
        return Path(os.environ.get("LOCALAPPDATA") or (Path.home() / "AppData" / "Local")) / APP_NAME
    return Path(os.environ.get("XDG_DATA_HOME") or (Path.home() / ".local" / "share")) / APP_NAME


def projects_dir() -> Path:
    return data_dir() / "projects"


def template_dir() -> Path | None:
    for p in (resource("template"), REPO / "build" / "template"):
        if (p / "config.yaml").exists():
            return p
    return None


def default_project() -> Path:
    """The project the app opens: the last one used, else 'Project' created
    from the template, else the repo itself (source checkout)."""
    last = data_dir() / "last_project.txt"
    try:
        p = Path(last.read_text(encoding="utf-8").strip())
        if (p / "config.yaml").exists():
            return p
    except OSError:
        pass
    if not frozen() and (REPO / "config.yaml").exists():
        return REPO
    return projects_dir() / "Project"


def remember_project(p: Path) -> None:
    data_dir().mkdir(parents=True, exist_ok=True)
    (data_dir() / "last_project.txt").write_text(str(Path(p).resolve()), encoding="utf-8")


def new_project(name: str, template: Path | None = None) -> Path:
    """Create projects/<name> from the template (config.yaml + input/)."""
    src = template or template_dir()
    if src is None:
        raise FileNotFoundError("no project template bundled (build/make_template.py)")
    safe = "".join(c for c in name.strip() if c.isalnum() or c in " _-").strip() or "Project"
    dst = projects_dir() / safe
    if dst.exists():
        raise FileExistsError(str(dst))
    shutil.copytree(src, dst)
    for d in ("output", "jobs"):
        (dst / d).mkdir(exist_ok=True)
    remember_project(dst)
    return dst


# ---- OpenRocket ---------------------------------------------------------------

def _first(paths):
    for p in paths:
        if p and Path(p).exists():
            return Path(p)
    return None


def find_openrocket() -> dict:
    """{'jar': path|None, 'jvm': path|None, 'source': str}. The jar and the
    JRE that ships next to it (both installers bundle one); an explicit
    config path still wins in rpa.config."""
    cands: list[tuple[Path, Path | None, str]] = []
    if sys.platform == "darwin":
        for app in [Path("/Applications/OpenRocket.app"), Path.home() / "Applications" / "OpenRocket.app"]:
            jars = sorted((app / "Contents/Resources/app/jar").glob("OpenRocket-*.jar"), reverse=True) if app.exists() else []
            if jars:
                cands.append((jars[0], _first([app / "Contents/Resources/jre.bundle/Contents/Home/lib/server/libjvm.dylib"]), str(app)))
    elif sys.platform.startswith("win"):
        for base in [Path(os.environ.get("ProgramFiles", r"C:\Program Files")) / "OpenRocket", Path(os.environ.get("LOCALAPPDATA", "")) / "Programs" / "OpenRocket", Path(os.environ.get("ProgramFiles(x86)", r"C:\Program Files (x86)")) / "OpenRocket"]:
            jars = sorted(base.glob("OpenRocket*.jar"), reverse=True) + sorted((base / "app").glob("OpenRocket*.jar"), reverse=True) if base.exists() else []
            if jars:
                cands.append((jars[0], _first([base / "jre" / "bin" / "server" / "jvm.dll", base / "runtime" / "bin" / "server" / "jvm.dll"]), str(base)))
    else:
        for base in [Path("/opt/openrocket"), Path.home() / "OpenRocket"]:
            jars = sorted(base.glob("OpenRocket*.jar"), reverse=True) if base.exists() else []
            if jars:
                cands.append((jars[0], _first([base / "jre" / "lib" / "server" / "libjvm.so"]), str(base)))
    if cands:
        jar, jvm, src = cands[0]
        return {"jar": str(jar), "jvm": str(jvm) if jvm else None, "source": src}
    return {"jar": None, "jvm": None, "source": None}


# ---- RASAero engine + host -------------------------------------------------------

def find_host() -> list[str] | None:
    """The bundled self-contained host first, then the repo's build."""
    exe = "rasaero-host.exe" if sys.platform.startswith("win") else "rasaero-host"
    bundled = resource("rasaero", exe)
    if bundled.exists():
        return [str(bundled)]
    dll = REPO / "native" / "RasaeroHost" / "bin" / "Release" / "net8.0" / "rasaero-host.dll"
    if dll.exists() and shutil.which("dotnet"):
        return ["dotnet", str(dll)]
    return None


def find_engine() -> Path | None:
    for p in (resource("rasaero", "RASAeroEngine.dll"), REPO / "vendor" / "rasaero" / "RASAeroEngine.dll"):
        if p.exists():
            return p
    return None


def summary() -> dict:
    orr = find_openrocket()
    host = find_host()
    eng = find_engine()
    return {"frozen": frozen(), "app_dir": str(app_dir()), "data_dir": str(data_dir()), "projects_dir": str(projects_dir()), "template": str(template_dir()) if template_dir() else None, "openrocket": orr, "host": host, "engine": str(eng) if eng else None, "platform": sys.platform}
