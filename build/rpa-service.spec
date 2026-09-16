# -*- mode: python ; coding: utf-8 -*-
"""PyInstaller onedir of the service -> <distpath>/rpa-service/.
Run through build/build_service.sh (.ps1): it copies app/dist into
rpa/service/ui first, which this spec bundles."""

import sys
from pathlib import Path

import jpype

ROOT = Path(SPECPATH).resolve().parent
UI = ROOT / "rpa" / "service" / "ui"
if not (UI / "index.html").exists():
    raise SystemExit("rpa/service/ui/index.html missing: run build/build_service.sh")
JPYPE_JAR = Path(jpype.__file__).resolve().parent.parent / "org.jpype.jar"

from PyInstaller.utils.hooks import copy_metadata

datas = [(str(UI), "rpa/service/ui"), (str(JPYPE_JAR), ".")]
datas += copy_metadata("tabulate")  # pandas.to_markdown checks its version
hidden = [
    "rpa.service.app", "rpa.service.core", "rpa.service.launch", "rpa.ric",
    "uvicorn.logging", "uvicorn.loops.auto", "uvicorn.loops.asyncio",
    "uvicorn.protocols.http.auto", "uvicorn.protocols.http.h11_impl",
    "uvicorn.protocols.websockets.auto",
    "uvicorn.lifespan.on", "uvicorn.lifespan.off", "anyio._backends._asyncio",
    "matplotlib.backends.backend_agg", "tabulate",  # pandas.to_markdown imports it lazily
]
excludes = [
    "tkinter", "_tkinter", "PyQt5", "PyQt6", "PySide2", "PySide6", "wx",
    "IPython", "jupyter", "notebook", "pytest", "matplotlib.backends.backend_tkagg",
    "matplotlib.backends.backend_qtagg", "matplotlib.backends.backend_qt5agg",
    "matplotlib.backends.backend_macosx", "matplotlib.backends.backend_webagg",
    "pywinauto", "playwright",
]

a = Analysis([str(ROOT / "build" / "rpa_service_entry.py")], pathex=[str(ROOT)], datas=datas, hiddenimports=hidden, excludes=excludes, noarchive=False)
pyz = PYZ(a.pure)
exe = EXE(pyz, a.scripts, exclude_binaries=True, name="rpa-service", console=not sys.platform.startswith("win"), upx=False)
coll = COLLECT(exe, a.binaries, a.datas, name="rpa-service", upx=False)
