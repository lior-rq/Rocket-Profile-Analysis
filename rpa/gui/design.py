"""One design's motors + vehicle geometry for the results infographic, and
the .eng / .zip downloads of the motor combo a design was flown with."""

from __future__ import annotations

import io
import json
import re
import time
import zipfile
from pathlib import Path

import pandas as pd

from ..backends import safe_name as _hist_safe_name
from ..eng import Motor, combined_eng_text, parse_eng

_CLASS_RE = re.compile(r"^\d*([A-Z])")
_SAFE_RE = re.compile(r"[^A-Za-z0-9._+-]+")
MAX_CURVE_POINTS = 160
_ROW_KEYS = ["booster", "sustainer", "profile", "status", "sep_delay_s", "ign_delay_s", "apogee_ft", "mach_at_sep", "vel_at_ign_fps", "alt_at_ign_ft", "max_mach", "max_accel_g", "t_apogee_s", "verified_ok"]


def safe_name(s: str) -> str:
    return _SAFE_RE.sub("_", str(s)).strip("_") or "motor"


def motor_payload(m: Motor, root: Path) -> dict:
    """Header numbers + a thinned thrust curve for the browser."""
    n = len(m.time_s)
    stride = max(1, -(-n // MAX_CURVE_POINTS))
    idx = list(range(0, n, stride))
    if idx and idx[-1] != n - 1:
        idx.append(n - 1)
    try:
        rel = str(m.path.resolve().relative_to(root.resolve()))
    except ValueError:
        rel = str(m.path)
    cls = _CLASS_RE.match(m.designation)
    return {
        "label": m.label,
        "designation": m.designation,
        "manufacturer": m.manufacturer,
        "impulse_class": cls.group(1) if cls else None,
        "diameter_mm": m.diameter_mm,
        "length_mm": m.length_mm,
        "prop_mass_kg": m.prop_mass_kg,
        "total_mass_kg": m.total_mass_kg,
        "total_impulse_ns": round(m.total_impulse_ns, 1),
        "burn_time_s": round(m.burn_time_s, 3),
        "avg_thrust_n": round(m.avg_thrust_n, 1),
        "peak_thrust_n": round(m.peak_thrust_n, 1),
        "nozzle_throat_in": m.nozzle_throat_in,
        "nozzle_exit_in": m.nozzle_exit_in,
        "file": rel,
        "n_in_file": m.n_in_file,
        "curve": {"t": [round(float(m.time_s[i]), 4) for i in idx], "f": [round(float(m.thrust_n[i]), 2) for i in idx]},
    }


def vehicle_geometry(cdx1_path: Path) -> dict:
    """RocketDesign parts of the CDX1 (inches, nose tip = 0). A fin's
    location_in is measured forward from its part's aft end to the root
    leading edge (RASAero's convention)."""
    from .. import cdx1 as C

    rd = C.load(cdx1_path).getroot().find("RocketDesign")
    parts = []

    def num(el, tag):
        t = el.findtext(tag)
        try:
            return float(t) if t not in (None, "") else None
        except ValueError:
            return None

    for part in rd if rd is not None else []:
        ptype = part.findtext("PartType")
        if not ptype:
            continue
        g = {"type": ptype, "length_in": num(part, "Length") or 0.0, "diameter_in": num(part, "Diameter") or 0.0, "location_in": num(part, "Location") or 0.0}
        if ptype == "NoseCone":
            g["shape"] = part.findtext("Shape")
        if ptype == "Transition":
            g["front_diameter_in"] = num(part, "FrontDiameter")
            g["rear_diameter_in"] = num(part, "RearDiameter")
        if ptype in ("BodyTube", "Booster"):
            g["boattail_length_in"] = num(part, "BoattailLength") or 0.0
            g["boattail_rear_diameter_in"] = num(part, "BoattailRearDiameter") or 0.0
        fin = part.find("Fin")
        if fin is not None and (num(fin, "Chord") or 0) > 0:
            g["fins"] = {"count": int(num(fin, "Count") or 0), "root_chord_in": num(fin, "Chord"), "tip_chord_in": num(fin, "TipChord") or 0.0, "span_in": num(fin, "Span") or 0.0, "sweep_in": num(fin, "SweepDistance") or 0.0, "location_in": num(fin, "Location") or 0.0}
        parts.append(g)
    total = max((p["location_in"] + p["length_in"] for p in parts), default=0.0)
    sus = [p for p in parts if p["type"] != "Booster"]
    boo = [p for p in parts if p["type"] == "Booster"]
    return {
        "parts": parts,
        "total_length_in": total,
        "max_diameter_in": max((p["diameter_in"] for p in parts), default=0.0),
        "sustainer_length_in": sum(p["length_in"] for p in sus),
        "booster_length_in": sum(p["length_in"] for p in boo),
        "file": cdx1_path.name,
    }


class DesignAssets:
    def __init__(self, state, root: Path):
        self.state = state
        self.root = Path(root)
        self._files: dict[str, tuple[tuple, list[Motor]]] = {}
        self._geo: tuple[tuple, dict] | None = None

    # ---- motor lookup -------------------------------------------------------
    def _parse(self, p: Path) -> list[Motor]:
        st = p.stat()
        key = (st.st_mtime_ns, st.st_size)
        hit = self._files.get(str(p))
        if hit and hit[0] == key:
            return hit[1]
        ms = parse_eng(p)
        self._files[str(p)] = (key, ms)
        return ms

    def _from_run_table(self, kind: str, label: str) -> Motor | None:
        """The file the motors stage recorded for this label (the set the
        designs were actually flown with), or its staged copy."""
        table = self.root / "output" / ("boosters.csv" if kind == "booster" else "sustainers.csv")
        if not table.exists():
            return None
        try:
            df = pd.read_csv(table)
        except Exception:
            return None
        rows = df[df["label"].astype(str) == label] if "label" in df else df.iloc[0:0]
        if rows.empty or "file" not in rows:
            return None
        src = Path(str(rows.iloc[0]["file"]))
        for cand in (src, self.root / "output" / "motors" / src.name):
            if cand.exists():
                for m in self._parse(cand):
                    if m.label == label:
                        return m
        return None

    def _from_staged(self, label: str) -> Motor | None:
        d = self.root / "output" / "motors"
        for p in sorted(d.glob("*.eng")) if d.exists() else []:
            if p.name == "all_motors.eng":
                continue
            try:
                for m in self._parse(p):
                    if m.label == label:
                        return m
            except ValueError:
                continue
        return None

    def motor(self, kind: str, label: str) -> Motor:
        m = self._from_run_table(kind, label)
        if m is None:
            ms, _ = self.state.motor_set(self.state.config())
            if ms is not None:
                try:
                    m = ms.booster(label) if kind == "booster" else ms.sustainer_by_label(label)
                except KeyError:
                    m = None
        if m is None:
            m = self._from_staged(label)
        if m is None:
            raise FileNotFoundError(f"{kind} {label!r} is not in the run's motor set")
        return m

    def vehicle(self) -> dict | None:
        cfg = self.state.config()
        p = cfg.path("cdx1")
        try:
            st = p.stat()
        except OSError:
            return None
        key = (str(p), st.st_mtime_ns, st.st_size)
        if self._geo and self._geo[0] == key:
            return self._geo[1]
        try:
            geo = vehicle_geometry(p)
        except Exception as e:
            geo = {"error": f"{type(e).__name__}: {e}", "parts": []}
        self._geo = (key, geo)
        return geo

    def design_row(self, booster: str, sustainer: str | None, profile: str | None) -> dict | None:
        p = self.root / "output" / "designs.csv"
        if not p.exists():
            return None
        try:
            df = pd.read_csv(p)
        except Exception:
            return None
        sel = df["booster"].astype(str) == booster
        if sustainer and "sustainer" in df:
            sel &= df["sustainer"].astype(str) == sustainer
        if profile and "profile" in df:
            sel &= df["profile"].astype(str) == profile
        rows = df[sel]
        if rows.empty:
            return None
        from .state import records

        return records(rows.iloc[[0]])[0]

    # ---- payloads -----------------------------------------------------------
    def design(self, booster: str, sustainer: str | None, profile: str | None = None) -> dict:
        out: dict = {"vehicle": self.vehicle()}
        try:
            out["booster"] = motor_payload(self.motor("booster", booster), self.root)
        except (FileNotFoundError, ValueError) as e:
            out["booster"] = None
            out["booster_error"] = str(e)
        if not sustainer:
            ms, _ = self.state.motor_set(self.state.config())
            sustainer = ms.sustainer.label if ms is not None else None
        try:
            out["sustainer"] = motor_payload(self.motor("sustainer", sustainer), self.root) if sustainer else None
        except (FileNotFoundError, ValueError) as e:
            out["sustainer"] = None
            out["sustainer_error"] = str(e)
        out["history"] = self._history_ref(booster, sustainer, profile) if sustainer and profile else None
        return out

    def _history_ref(self, booster: str, sustainer: str, profile: str) -> dict | None:
        """Pointer to this design's verified time history, if verify has run."""
        stem = _hist_safe_name(f"final-{booster}+{sustainer}-{profile}")
        p = self.root / "output" / "histories" / f"{stem}.csv"
        try:
            st = p.stat()
        except OSError:
            return None
        return {"path": str(p.relative_to(self.root)), "mtime": st.st_mtime}

    def eng_download(self, kind: str, label: str) -> tuple[str, bytes]:
        m = self.motor(kind, label)
        return f"{safe_name(m.label)}.eng", _eng_text(m).encode()

    def combo_download(self, booster: str, sustainer: str, profile: str | None = None) -> tuple[str, bytes]:
        """A zip with each motor's own .eng, both in one multi-motor .eng
        (what RASAero's motor file picker wants) and a design summary."""
        b = self.motor("booster", booster)
        s = self.motor("sustainer", sustainer)
        combined_name = f"{safe_name(b.label)}+{safe_name(s.label)}.eng"
        row = self.design_row(booster, sustainer, profile)
        summary = {
            "booster": {"label": b.label, "designation": b.designation, "file": str(b.path), "total_impulse_ns": round(b.total_impulse_ns, 1), "burn_time_s": round(b.burn_time_s, 3), "nozzle_exit_in": b.nozzle_exit_in},
            "sustainer": {"label": s.label, "designation": s.designation, "file": str(s.path), "total_impulse_ns": round(s.total_impulse_ns, 1), "burn_time_s": round(s.burn_time_s, 3), "nozzle_exit_in": s.nozzle_exit_in},
            "design": {k: row.get(k) for k in _ROW_KEYS if k in row} if row else None,
            "exported": time.strftime("%Y-%m-%d %H:%M:%S"),
        }
        buf = io.BytesIO()
        with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as z:
            z.writestr(f"booster-{safe_name(b.label)}.eng", _eng_text(b))
            z.writestr(f"sustainer-{safe_name(s.label)}.eng", _eng_text(s))
            z.writestr(combined_name, combined_eng_text([b, s]))
            z.writestr("design.json", json.dumps(summary, indent=1))
            z.writestr("README.txt", _readme(summary, combined_name))
        name = f"{safe_name(b.label)}+{safe_name(s.label)}" + (f"-{safe_name(profile)}" if profile else "") + ".zip"
        return name, buf.getvalue()


def _eng_text(m: Motor) -> str:
    text = m.raw_text().rstrip("\n") + "\n"
    return text if text.rstrip().endswith(";") else text + ";\n"


def _readme(summary: dict, combined_name: str) -> str:
    d = summary.get("design") or {}
    lines = [
        "Rocket Profile Analysis - motor combo",
        "",
        f"booster    : {summary['booster']['designation']}  ({summary['booster']['total_impulse_ns']:.0f} N·s, {summary['booster']['burn_time_s']:.2f} s burn)",
        f"sustainer  : {summary['sustainer']['designation']}  ({summary['sustainer']['total_impulse_ns']:.0f} N·s, {summary['sustainer']['burn_time_s']:.2f} s burn)",
    ]
    if d:
        lines += [
            f"profile    : {d.get('profile')}  [{d.get('status')}]",
            f"separation : {d.get('sep_delay_s')} s after booster burnout",
            f"ignition   : {d.get('ign_delay_s')} s after separation",
            f"apogee     : {d.get('apogee_ft')} ft",
        ]
    lines += [
        "",
        "files:",
        "  booster-*.eng / sustainer-*.eng  one motor each (OpenRocket, RASAero)",
        f"  {combined_name}  both motors in one RASP file (RASAero 'Select Motor File')",
        "  design.json  the designs.csv row this combo was flown as",
        f"exported {summary['exported']}",
        "",
    ]
    return "\n".join(lines)
