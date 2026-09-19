"""Simulation backends: the base class and OpenRocket headless (preview).
The default, RASAero's own engine in-process, is rpa.native."""

from __future__ import annotations

import pandas as pd

from .models import SimRow


class SimBackend:
    name = "base"

    def run_batch(self, rows: list[SimRow], name: str) -> None:
        """Fill max_alt_ft / max_vel_fps / t_apogee_s on each row in place."""
        raise NotImplementedError

    def export(self, row: SimRow, name: str) -> pd.DataFrame:
        """Full time history for one row (normalized columns, see history.py)."""
        raise NotImplementedError

    def history(self, row: SimRow, name: str) -> pd.DataFrame:
        """Like export() but nothing has to land on disk (characterization
        runs hundreds of these); backends that can, skip the file."""
        return self.export(row, name)

    def histories(self, rows: list[SimRow], names: list[str]):
        """history() for many rows, yielded in order; backends with a pool
        overlap the flights. Frames are dropped as soon as they are consumed."""
        for row, name in zip(rows, names, strict=True):
            yield self.history(row, name)


class OpenRocketBackend(SimBackend):
    """Runs the same pipeline through OpenRocket's own 6-DOF simulator. Aero
    (especially transonic/supersonic drag) differs from RASAero, so treat the
    numbers as a preview."""

    name = "openrocket"

    def __init__(self, cfg, openrocket, motorset, log=print):
        self.cfg = cfg
        self.orr = openrocket
        self.ms = motorset
        self.log = log
        self.site = dict(cfg["launch_site"])
        self.history_dir = cfg.output_dir / "histories"
        self.history_dir.mkdir(parents=True, exist_ok=True)

    def set_site_defaults(self, site: dict):
        for k, v in site.items():
            if self.site.get(k) is None:
                self.site[k] = v

    def _sim(self, row: SimRow):
        s, h = self.orr.simulate(self.ms.sustainer_by_label(row.sustainer), self.ms.booster(row.booster), row.sep_delay_s, row.ign_delay_s, self.site)
        row.max_alt_ft = round(s["max_alt_ft"], 1)
        row.max_vel_fps = round(s["max_vel_fps"], 1)
        row.t_apogee_s = round(s["t_apogee_s"], 2)
        return h

    def run_batch(self, rows: list[SimRow], name: str) -> None:
        self.log(f"  [openrocket] {name}: simulating {len(rows)} rows")
        for i, r in enumerate(rows):
            self._sim(r)
            if (i + 1) % 25 == 0:
                self.log(f"    {i + 1}/{len(rows)}")

    def export(self, row: SimRow, name: str) -> pd.DataFrame:
        h = self._sim(row)
        h.to_csv(self.history_dir / (safe_name(name) + ".csv"), index=False)
        return h


def safe_name(s: str) -> str:
    """History file stem; '+' joins a booster and a sustainer label."""
    return "".join(c if c.isalnum() or c in "-_.+" else "_" for c in s)
