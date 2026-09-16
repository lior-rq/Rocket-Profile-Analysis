"""RASP (.eng) thrust-curve file parsing."""

from __future__ import annotations

import re
from dataclasses import dataclass, field
from functools import cached_property
from pathlib import Path

import numpy as np

# nozzle sizes come from a header comment: "; Throat 1.860 in, exit 3.880 in."
_NOZZLE_RE = re.compile(r"throat\s+([\d.]+)\s*in.*?exit\s+([\d.]+)\s*in", re.IGNORECASE)
_INDEX_RE = re.compile(r"^(\d+)[-_]")
_SUFFIX_RE = re.compile(r"-(\d+)$")


@dataclass
class Motor:
    path: Path
    designation: str
    manufacturer: str
    diameter_mm: float
    length_mm: float
    delays: str
    prop_mass_kg: float
    total_mass_kg: float
    time_s: np.ndarray = field(repr=False)
    thrust_n: np.ndarray = field(repr=False)
    comments: list[str] = field(default_factory=list, repr=False)
    nozzle_throat_in: float | None = None
    nozzle_exit_in: float | None = None
    block_text: str = field(default="", repr=False)  # this motor's own RASP block (comments + header + data)
    n_in_file: int = 1  # motors in the file this one came from

    @property
    def label(self) -> str:
        """The id used everywhere in outputs: the file stem for one-motor
        files (e.g. '01-27801O4192'), the designation for a motor out of a
        multi-motor file (e.g. '27801O4192-01')."""
        return self.path.stem if self.n_in_file == 1 else self.designation

    @property
    def index(self) -> int | None:
        m = _INDEX_RE.match(self.path.name) if self.n_in_file == 1 else _SUFFIX_RE.search(self.designation)
        return int(m.group(1)) if m else None

    @cached_property
    def total_impulse_ns(self) -> float:
        # RASP convention: the curve starts at (0, 0) even if not listed
        t = np.concatenate([[0.0], self.time_s])
        f = np.concatenate([[0.0], self.thrust_n])
        return float(np.trapezoid(f, t))

    @property
    def burn_time_s(self) -> float:
        """Time of the last data point - RASAero references staging delays to this."""
        return float(self.time_s[-1])

    @cached_property
    def peak_thrust_n(self) -> float:
        return float(self.thrust_n.max())

    @property
    def avg_thrust_n(self) -> float:
        return self.total_impulse_ns / self.burn_time_s

    def rasaero_name(self, fmt: str = "{designation}  ({manufacturer})") -> str:
        """The string RASAero II stores in <SustainerEngine>/<Booster1Engine>."""
        return fmt.format(designation=self.designation, manufacturer=self.manufacturer)

    def raw_text(self) -> str:
        """This motor's RASP block as text."""
        return self.block_text or self.path.read_text()


def parse_eng(path: str | Path) -> list[Motor]:
    """Parse a RASP file. Returns one Motor per motor block in the file."""
    path = Path(path)
    motors: list[Motor] = []
    comments: list[str] = []
    block: list[str] = []
    header: list[str] | None = None
    times: list[float] = []
    thrusts: list[float] = []

    def flush():
        nonlocal header, times, thrusts, comments, block
        if header is None:
            return
        name, dia, length, delays, prop, total, manu = header[:7]
        throat = exit_ = None
        for c in comments:
            m = _NOZZLE_RE.search(c)
            if m:
                throat, exit_ = float(m.group(1)), float(m.group(2))
        motors.append(
            Motor(
                path=path,
                designation=name,
                manufacturer=manu,
                diameter_mm=float(dia),
                length_mm=float(length),
                delays=delays,
                prop_mass_kg=float(prop),
                total_mass_kg=float(total),
                time_s=np.asarray(times, dtype=float),
                thrust_n=np.asarray(thrusts, dtype=float),
                comments=list(comments),
                nozzle_throat_in=throat,
                nozzle_exit_in=exit_,
                block_text="\n".join(block) + "\n",
            )
        )
        header, times, thrusts, comments, block = None, [], [], [], []

    for raw in path.read_text().splitlines():
        line = raw.strip()
        if not line:
            continue
        if line.startswith(";"):
            # A comment after data lines starts the next motor block.
            if header is not None and times:
                flush()
            comments.append(line[1:].strip())
            block.append(raw.rstrip())
            continue
        block.append(raw.rstrip())
        parts = line.split()
        if header is None:
            if len(parts) < 7:
                raise ValueError(f"{path}: malformed RASP header line: {raw!r}")
            header = parts
            continue
        if len(parts) != 2:
            raise ValueError(f"{path}: malformed data line: {raw!r}")
        times.append(float(parts[0]))
        thrusts.append(float(parts[1]))
    flush()
    if not motors:
        raise ValueError(f"{path}: no motors found")
    for m in motors:
        m.n_in_file = len(motors)
    return motors


def expand_motor_sources(sources, ric=None) -> list[Path]:
    """Folders and/or motor files -> the list of .eng files to parse. A
    folder contributes its *.eng (one motor or many per file) and, when a
    converter is given, its *.ric openMotor designs, each simulated once
    into a cached .eng (rpa.ric.RicConverter). Sorted by name, duplicates
    dropped, order kept."""
    if isinstance(sources, (str, Path)):
        sources = [sources]
    files: list[Path] = []
    rics: list[Path] = []
    seen = set()
    missing = []
    for src in sources:
        src = Path(src)
        if src.is_dir():
            found = sorted(src.glob("*.eng"))
            found_ric = sorted(src.glob("*.ric"))
            if not found and not found_ric:
                missing.append(f"no .eng or .ric files in {src}")
        elif src.is_file():
            found, found_ric = ([src], []) if src.suffix.lower() != ".ric" else ([], [src])
        else:
            missing.append(f"not found: {src}")
            continue
        for f in found:
            key = f.resolve()
            if key not in seen:
                seen.add(key)
                files.append(f)
        for f in found_ric:
            key = f.resolve()
            if key not in seen:
                seen.add(key)
                rics.append(f)
    if rics:
        if ric is None:
            raise ValueError(f"{len(rics)} .ric design(s) selected but no openMotor converter is available (rpa.ric)")
        files += ric(rics)
    if missing and not files:
        raise FileNotFoundError("; ".join(missing))
    return files


def load_motors(sources, ric=None) -> list[Motor]:
    """Every motor in a list of folders and/or motor files: one-motor .eng,
    multi-motor RASP .eng, and openMotor .ric designs (via `ric`)."""
    files = expand_motor_sources(sources, ric)
    motors = []
    for p in files:
        motors.extend(parse_eng(p))
    if not motors:
        raise FileNotFoundError(f"no .eng files in {sources}")
    labels = [m.label for m in motors]
    dupes = sorted({x for x in labels if labels.count(x) > 1})
    if dupes:
        raise ValueError(f"motor ids must be unique (file name for one-motor files, designation inside multi-motor files); duplicated: {dupes[:5]}{' ...' if len(dupes) > 5 else ''}")
    return motors


def load_motor_dir(directory: str | Path) -> list[Motor]:
    """All single-motor .eng files in a directory, sorted by file name."""
    return load_motors([directory])


def combined_eng_text(motors: list[Motor]) -> str:
    """Motor blocks concatenated into one multi-motor RASP file."""
    chunks = []
    for m in motors:
        text = m.raw_text().rstrip("\n")
        # Drop a trailing bare ';' terminator so blocks concatenate cleanly.
        lines = text.splitlines()
        while lines and lines[-1].strip() == ";":
            lines.pop()
        chunks.append("\n".join(lines))
    return "\n".join(chunks) + "\n"


def write_combined_eng(motors: list[Motor], out_path: str | Path) -> Path:
    """Concatenate motor files into one multi-motor RASP file (what RASAero's
    'Select Motor File' expects when it wants a single file)."""
    out_path = Path(out_path)
    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_path.write_text(combined_eng_text(motors))
    return out_path
