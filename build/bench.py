#!/usr/bin/env python3
"""Timings of the built service on a copy of a real project (default: this
repo's config.yaml + input/). Prints a table for docs/PERFORMANCE.md.
Usage: python build/bench.py [build/dist/rpa-service] [project]"""

from __future__ import annotations

import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import time
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


class Svc:
    def __init__(self, exe: Path, project: Path, data: Path):
        env = {**os.environ, "RPA_DATA_DIR": str(data), "PYTHONUTF8": "1"}
        self.t0 = time.time()
        self.p = subprocess.Popen([str(exe), "service", "--project", str(project), "--port", "0"], stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, text=True, env=env)
        for line in self.p.stdout:
            if line.startswith("RPA_SERVICE_PORT="):
                self.port = int(line.split("=", 1)[1])
                break
        else:
            raise SystemExit("no port announced")
        self.ready_s = time.time() - self.t0
        self.base = f"http://127.0.0.1:{self.port}"

    def get(self, path):
        with urllib.request.urlopen(self.base + path, timeout=120) as r:
            return json.loads(r.read())

    def post(self, path, body=None):
        req = urllib.request.Request(self.base + path, data=json.dumps(body or {}).encode(), headers={"Content-Type": "application/json"})
        with urllib.request.urlopen(req, timeout=600) as r:
            return json.loads(r.read())

    def wait_warm(self, timeout=120):
        t = time.time()
        while time.time() - t < timeout:
            e = self.get("/api/engine")
            w = e.get("warmup") or {}
            if w.get("done") or w.get("state") in ("ready", "done", "failed"):
                return time.time() - t, w
            time.sleep(0.5)
        return time.time() - t, {}

    def run(self, stage: str, args: list[str]) -> tuple[float, list[dict]]:
        seq = (self.get("/api/log")["lines"] or [{"seq": 0}])[-1]["seq"]
        t = time.time()
        self.post("/api/run", {"stage": stage, "args": args})
        while self.get("/api/ping")["running"]:
            time.sleep(0.2)
        el = time.time() - t
        code = self.get("/api/runs")["runner"].get("exit_code")
        lines = self.get("/api/log")["lines"]
        if code not in (0, 1):
            print("\n".join(ln["text"] for ln in lines[-30:]))
            raise SystemExit(f"{stage} failed with exit code {code}")
        return el, [ln for ln in lines if ln["seq"] > seq]

    def quit(self):
        try:
            self.post("/api/quit")
            self.p.wait(20)
        except Exception:  # noqa: BLE001
            self.p.kill()


def first(lines, needle):
    for ln in lines:
        if needle in ln["text"]:
            return ln
    return None


def main() -> int:
    exe_dir = Path(sys.argv[1] if len(sys.argv) > 1 else ROOT / "build" / "dist" / "rpa-service")
    exe = exe_dir / ("rpa-service.exe" if sys.platform.startswith("win") else "rpa-service")
    src = Path(sys.argv[2] if len(sys.argv) > 2 else ROOT)
    with tempfile.TemporaryDirectory(prefix="rpa-bench-") as td:
        proj = Path(td) / "project"
        proj.mkdir()
        shutil.copy2(src / "config.yaml", proj / "config.yaml")
        shutil.copytree(src / "input", proj / "input", ignore=shutil.ignore_patterns("__pycache__"))
        data = Path(td) / "data"
        out = {}
        s = Svc(exe, proj, data)
        try:
            bench(s, exe, proj, data, out)
        finally:
            s.quit()
    print("| measure | value |\n|---|---|")
    for k, v in out.items():
        print(f"| {k} | {v} |")
    return 0


def bench(s: Svc, exe: Path, proj: Path, data: Path, out: dict) -> None:
    if True:
        out["service ready (port announced)"] = f"{s.ready_s:.1f} s"
        t = time.time()
        for _ in range(5):
            s.get("/api/state")
        out["/api/state (avg of 5)"] = f"{(time.time() - t) / 5 * 1000:.0f} ms"
        warm_s, w = s.wait_warm()
        out["warm-up done (hosts + JVM), after ready"] = f"{warm_s:.1f} s"
        # first click: the mass stage (OpenRocket) fresh, then cached
        el, lines = s.run("mass", ["--fresh"])
        out["mass stage, fresh (OpenRocket)"] = f"{el:.1f} s"
        el, lines = s.run("mass", [])
        out["mass stage again (OpenRocket warm)"] = f"{el:.2f} s"
        # a full run: click -> first flight, search rows / time, whole run
        el, lines = s.run("run", ["--fresh"])
        t_click = lines[0]["t"]
        fl = first(lines, "[native] RASAero")
        out["run --fresh, total"] = f"{el:.1f} s"
        if fl:
            out["click -> engine flying (first [native] line)"] = f"{fl['t'] - t_click:.2f} s"
        marks = [ln for ln in lines if ln["text"].startswith("=== ")]
        for a, b in zip(marks, marks[1:] + [lines[-1]], strict=False):
            out[f"  substage {a['text'].strip('= ')}"] = f"{b['t'] - a['t']:.1f} s"
        n = sum(int(m.group(1)) for ln in lines for m in [re.search(r"round \w+: (\d+) (?:rows|refinement rows)", ln["text"])] if m)
        srch = [m for m in marks if "search" in m["text"]]
        if srch and n:
            nxt = next((m for m in marks if m["t"] > srch[0]["t"]), lines[-1])
            out["search flights"] = str(n)
            out["search wall time / flight"] = f"{(nxt['t'] - srch[0]['t']) / n * 1000:.1f} ms"
        char = [m for m in marks if "characterize" in m["text"]]
        first_char = next((ln for ln in lines if re.match(r"\s*\[\s*1/\d+\] ", ln["text"])), None)
        if char and first_char:
            out["characterize: click -> first flight analysed"] = f"{first_char['t'] - t_click:.2f} s"
            nchar = sum(1 for ln in lines if re.match(r"\s*\[\s*\d+/\d+\] \S+: burnout", ln["text"]))
            nxt = next((m for m in marks if m["t"] > char[0]["t"]), lines[-1])
            if nchar:
                out["characterize flights"] = str(nchar)
                out["characterize wall time / flight (full history each)"] = f"{(nxt['t'] - char[0]['t']) / nchar * 1000:.0f} ms"
        eng = s.get("/api/engine")
        out["engine hosts"] = str((eng.get("pool") or {}).get("pools", [{}])[0].get("hosts", "?") if (eng.get("pool") or {}).get("pools") else "?")
        out["cpu cores"] = str(os.cpu_count())
        s.quit()
        # a second launch: the OS has the binary cached; the project already has outputs
        s2 = Svc(exe, proj, data)
        out["second launch, ready"] = f"{s2.ready_s:.1f} s"
        s2.quit()


if __name__ == "__main__":
    sys.exit(main())
