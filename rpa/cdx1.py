"""RASAero II .CDX1 (XML) reading/writing.

The RocketDesign section is left alone. Launch site and surface finish are
set, and <SimulationList> is replaced with a batch of <Simulation> rows.
RASAero writes MaxAltitude / MaxVelocity / TimetoApogee back into each row
when the file is saved after "Rerun All Simulations"; that is how results
come back.
"""

from __future__ import annotations

import copy
import xml.etree.ElementTree as ET
from pathlib import Path

from .models import SimRow

LAUNCH_SITE_TAGS = {
    "altitude_ft": "Altitude",
    "pressure_inhg": "Pressure",
    "rod_angle_deg": "RodAngle",
    "rod_length_ft": "RodLength",
    "temperature_f": "Temperature",
    "wind_speed_mph": "WindSpeed",
}


def _fmt(v) -> str:
    if isinstance(v, bool):
        return "True" if v else "False"
    if isinstance(v, float):
        s = f"{v:.6f}".rstrip("0").rstrip(".")
        return s if s not in ("", "-0") else "0"
    return str(v)


def load(path: str | Path) -> ET.ElementTree:
    return ET.parse(str(path))


def to_bytes(tree: ET.ElementTree) -> bytes:
    ET.indent(tree, space="  ")
    # RASAero's own files have no XML declaration and use CRLF; be conservative.
    body = ET.tostring(tree.getroot(), encoding="unicode")
    return body.replace("\r\n", "\n").replace("\n", "\r\n").encode("utf-8")


def save(tree: ET.ElementTree, path: str | Path) -> Path:
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(to_bytes(tree))
    return path


def launch_site(tree: ET.ElementTree) -> dict:
    ls = tree.getroot().find("LaunchSite")
    out = {}
    for key, tag in LAUNCH_SITE_TAGS.items():
        el = ls.find(tag) if ls is not None else None
        out[key] = float(el.text) if el is not None and el.text else None
    return out


def apply_launch_site(tree: ET.ElementTree, overrides: dict) -> None:
    root = tree.getroot()
    ls = root.find("LaunchSite")
    if ls is None:
        ls = ET.SubElement(root, "LaunchSite")
    for key, tag in LAUNCH_SITE_TAGS.items():
        v = overrides.get(key)
        if v is None:
            continue
        el = ls.find(tag)
        if el is None:
            el = ET.SubElement(ls, tag)
        el.text = _fmt(float(v))


def apply_nozzles(tree: ET.ElementTree, sustainer_in: float | None, booster_in: float | None) -> None:
    """Design-level nozzle exit diameters (RocketDesign/SustainerNozzle,
    Booster1Nozzle and the Booster part's NozzleExitDiameter) - what Aero
    Plots uses for the power-on base drag."""
    rd = tree.getroot().find("RocketDesign")
    if rd is None:
        raise ValueError("CDX1 has no <RocketDesign> section")
    for tag, v in (("SustainerNozzle", sustainer_in), ("Booster1Nozzle", booster_in)):
        if v is None:
            continue
        el = rd.find(tag)
        if el is None:
            el = ET.SubElement(rd, tag)
        el.text = _fmt(float(v))
    if booster_in is not None:
        for part in rd:
            if part.tag == "Booster":
                el = part.find("NozzleExitDiameter")
                if el is None:
                    el = ET.SubElement(part, "NozzleExitDiameter")
                el.text = _fmt(float(booster_in))
    # the simulation rows carry nozzle diameters too; keep them consistent
    for sim in tree.getroot().iter("Simulation"):
        for tag, v in (("SustainerNozzleDiameter", sustainer_in), ("Booster1NozzleDiameter", booster_in)):
            if v is None:
                continue
            el = sim.find(tag)
            if el is None:
                el = ET.SubElement(sim, tag)
            el.text = _fmt(float(v))


def apply_mach_alt(tree: ET.ElementTree, points: list[list[float]]) -> None:
    """Options -> Mach-Alt points (mach, altitude ft), written straight into
    the file instead of the dialog (rasaero.mach_alt_via_cdx1 - opt-in,
    needs a live check that RASAero actually loads a pre-set <MachAlt> on
    File->Open before this replaces the dialog by default). Schema and
    number formatting verified against a worker-produced result.CDX1:
    <MachAlt><Item>0, 20000</Item><Item>25, 20000</Item></MachAlt>."""
    root = tree.getroot()
    el = root.find("MachAlt")
    if el is None:
        el = ET.Element("MachAlt")
        sl = root.find("SimulationList")
        root.insert(list(root).index(sl) if sl is not None else len(root), el)
    for child in list(el):
        el.remove(child)
    for mach, alt in points:
        ET.SubElement(el, "Item").text = f"{_fmt(float(mach))}, {_fmt(float(alt))}"


def reference_diameter_in(tree: ET.ElementTree) -> float:
    """Largest body diameter in the RocketDesign (RASAero's reference for CD)."""
    rd = tree.getroot().find("RocketDesign")
    dias = []
    for part in rd if rd is not None else []:
        el = part.find("Diameter")
        if el is not None and el.text:
            try:
                dias.append(float(el.text))
            except ValueError:
                pass
    if not dias:
        raise ValueError("no <Diameter> found in the CDX1 RocketDesign")
    return max(dias)


def apply_surface(tree: ET.ElementTree, finish: str) -> None:
    rd = tree.getroot().find("RocketDesign")
    if rd is None:
        raise ValueError("CDX1 has no <RocketDesign> section")
    el = rd.find("Surface")
    if el is None:
        el = ET.SubElement(rd, "Surface")
    el.text = finish


def simulation_element(row: SimRow) -> ET.Element:
    sim = ET.Element("Simulation")
    fields = [
        ("SustainerEngine", row.sustainer_engine),
        ("SustainerLaunchWt", row.sustainer_wt_lb),
        ("SustainerNozzleDiameter", row.sustainer_nozzle_in),
        ("SustainerCG", row.sustainer_cg_in),
        ("SustainerIgnitionDelay", row.ign_delay_s),
        ("Booster1Engine", row.booster_engine),
        ("Booster1LaunchWt", row.combined_wt_lb),
        ("Booster1SeparationDelay", row.sep_delay_s),
        ("Booster1IgnitionDelay", 0.0),
        ("Booster1CG", row.combined_cg_in),
        ("Booster1NozzleDiameter", row.booster_nozzle_in),
        ("IncludeBooster1", True),
        ("Booster2LaunchWt", 0.0),
        ("Booster2Delay", 0.0),
        ("Booster2CG", 0.0),
        ("Booster2NozzleDiameter", 0.0),
        ("IncludeBooster2", False),
        ("FlightTime", 0.0),
        ("TimetoApogee", 0.0),
        ("MaxAltitude", 0.0),
        ("MaxVelocity", 0.0),
        ("OptimumWt", 0.0),
        ("OptimumMaxAlt", 0.0),
    ]
    for tag, val in fields:
        ET.SubElement(sim, tag).text = _fmt(val)
    return sim


def write_batch(template: ET.ElementTree, rows: list[SimRow], out_path: str | Path, *, launch_site_overrides: dict | None = None, surface: str | None = None) -> Path:
    return save(build_batch(template, rows, launch_site_overrides=launch_site_overrides, surface=surface), out_path)


def build_batch(template: ET.ElementTree, rows: list[SimRow], *, launch_site_overrides: dict | None = None, surface: str | None = None) -> ET.ElementTree:
    """The template with its SimulationList replaced by `rows`."""
    tree = copy.deepcopy(template)
    root = tree.getroot()
    if launch_site_overrides:
        apply_launch_site(tree, launch_site_overrides)
    if surface:
        apply_surface(tree, surface)
    sl = root.find("SimulationList")
    if sl is None:
        sl = ET.SubElement(root, "SimulationList")
    for child in list(sl):
        sl.remove(child)
    for r in rows:
        sl.append(simulation_element(r))
    return tree


def read_results(path: str | Path) -> list[dict]:
    """The <Simulation> rows of a saved file, inputs and results, in order."""
    root = load(path).getroot()
    out = []
    for sim in root.findall("SimulationList/Simulation"):
        d = {child.tag: (child.text or "").strip() for child in sim}
        out.append(
            {
                "sustainer_engine": d.get("SustainerEngine", ""),
                "booster_engine": d.get("Booster1Engine", ""),
                "sep_delay_s": float(d.get("Booster1SeparationDelay", "nan") or "nan"),
                "ign_delay_s": float(d.get("SustainerIgnitionDelay", "nan") or "nan"),
                "combined_wt_lb": float(d.get("Booster1LaunchWt", "nan") or "nan"),
                "max_alt_ft": float(d.get("MaxAltitude", "0") or "0"),
                "max_vel_fps": float(d.get("MaxVelocity", "0") or "0"),
                "t_apogee_s": float(d.get("TimetoApogee", "0") or "0"),
            }
        )
    return out


def merge_results(rows: list[SimRow], results: list[dict], *, tol: float = 1e-3) -> list[str]:
    """Copy results back onto rows by position, checking the inputs still line
    up. Returns a list of problems (empty when everything matched)."""
    problems = []
    if len(rows) != len(results):
        problems.append(f"row count mismatch: sent {len(rows)}, file has {len(results)}")
    for i, (r, res) in enumerate(zip(rows, results, strict=False)):
        if res["booster_engine"] != r.booster_engine or abs(res["sep_delay_s"] - r.sep_delay_s) > tol or abs(res["ign_delay_s"] - r.ign_delay_s) > tol:
            problems.append(f"row {i}: inputs differ ({res['booster_engine']!r}, sep {res['sep_delay_s']}, ign {res['ign_delay_s']}) vs ({r.booster_engine!r}, {r.sep_delay_s}, {r.ign_delay_s})")
            continue
        if res["max_alt_ft"] <= 0:
            problems.append(f"row {i} ({r.tag}): no result (MaxAltitude=0) - simulation not run, or motor name not found by RASAero")
            continue
        r.max_alt_ft = res["max_alt_ft"]
        r.max_vel_fps = res["max_vel_fps"]
        r.t_apogee_s = res["t_apogee_s"]
    return problems
