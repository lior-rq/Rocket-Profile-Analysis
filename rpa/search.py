"""Hit the target apogee by choosing the staging delays.

Two knobs, both in RASAero's convention: separation delay after burnout and
ignition delay after separation (so ignition never precedes burnout).
Separation is sampled on a small grid across its window (narrowed by the
profile's Mach rule); for each, the ignition delay is swept over its window.
Apogee vs. coast time is not monotonic (a longer coast lets the sustainer
burn in thinner air until gravity losses win), so every bracket where the
apogee crosses the target is refined with regula falsi. Each round is one
batch through the backend for all candidates. Best per (booster, sustainer,
profile): solved beats unsolved, then the smallest miss, then the shortest
coast.
"""

from __future__ import annotations

import math
from dataclasses import dataclass, field

from .backends import SimBackend
from .models import Design, MassRow, ProfileEligibility, SimRow


@dataclass
class Candidate:
    booster: str
    profile: str
    sep_delay_s: float
    samples: dict[float, SimRow] = field(default_factory=dict)  # ign delay -> row
    brackets: list[tuple[float, float]] = field(default_factory=list)
    done: bool = False
    status: str = "pending"
    sustainer: str = ""

    @property
    def key(self) -> tuple[str, str, str]:
        return (self.booster, self.sustainer, self.profile)

    def sorted_samples(self) -> list[SimRow]:
        return [self.samples[k] for k in sorted(self.samples)]


def make_row(booster_label: str, profile: str | None, sep: float, ign: float, ms, mass: MassRow, cfg, rnd: int = 0) -> SimRow:
    """One RASAero row; the sustainer is the one the mass row was built for."""
    b = ms.booster(booster_label)
    s = ms.sustainer_by_label(mass.sustainer)
    fmt = cfg["rasaero"]["engine_name_format"]
    s_noz = cfg["rasaero"]["sustainer_nozzle_in"] or s.nozzle_exit_in
    b_noz = cfg["rasaero"]["booster_nozzle_in"] or b.nozzle_exit_in
    if s_noz is None or b_noz is None:
        raise ValueError("nozzle exit diameter unknown: set rasaero.sustainer_nozzle_in / booster_nozzle_in in config.yaml")
    return SimRow(
        booster=booster_label,
        profile=profile,
        sep_delay_s=round(float(sep), 2),
        ign_delay_s=round(float(ign), 2),
        sustainer_engine=s.rasaero_name(fmt),
        booster_engine=b.rasaero_name(fmt),
        sustainer_wt_lb=mass.sustainer_wt_lb,
        sustainer_cg_in=mass.sustainer_cg_in,
        sustainer_nozzle_in=float(s_noz),
        combined_wt_lb=mass.combined_wt_lb,
        combined_cg_in=mass.combined_cg_in,
        booster_nozzle_in=float(b_noz),
        round=rnd,
        sustainer=s.label,
    )


class ApogeeSearch:
    def __init__(self, cfg, backend: SimBackend, ms, mass_by_pair: dict[tuple[str, str], MassRow], eligibilities: list[ProfileEligibility], log=print):
        self.cfg = cfg
        self.backend = backend
        self.ms = ms
        self.mass = mass_by_pair  # (booster, sustainer) -> MassRow
        self.log = log
        p = cfg["profiles"]
        self.target = float(cfg["target"]["apogee_ft"])
        self.tol = float(cfg["target"]["tolerance_ft"])
        self.gap = float(p["ignition_delay_min_s"])
        self.ign_max = float(p["ignition_delay_max_s"])
        self.step = float(p["coarse_step_s"])
        self.sep_step = float(p["separation_step_s"])
        self.max_rounds = int(p["max_refine_rounds"])
        self.pilot_grid = bool(p.get("pilot_grid", True))
        self.cands = [Candidate(e.booster, e.profile, sep, sustainer=e.sustainer) for e in eligibilities if e.eligible for sep in self.separation_grid(e.sep_min_s, e.sep_max_s)]
        self.all_rows: list[SimRow] = []

    def separation_grid(self, lo: float, hi: float) -> list[float]:
        """min, min+step, ..., max at profiles.separation_step_s (both ends always included)."""
        lo, hi = float(lo), float(hi)
        if hi - lo < 1e-9:
            return [round(lo, 2)]
        n = math.floor((hi - lo) / self.sep_step + 1e-9) + 1
        pts = {round(lo + i * self.sep_step, 2) for i in range(n)} | {round(hi, 2)}
        return sorted(pts)

    # ---- rounds ----------------------------------------------------------
    def _coarse_delays(self, c: Candidate) -> list[float]:
        # ignition delays are measured from separation (RASAero convention)
        lo = self.gap
        if lo > self.ign_max:
            return [round(lo, 2)]
        n = math.floor((self.ign_max - lo) / self.step + 1e-9) + 1
        ds = [round(lo + i * self.step, 2) for i in range(n)]
        if ds[-1] < self.ign_max - 1e-6:
            ds.append(round(self.ign_max, 2))
        return ds

    def _run_rows(self, rows: list[SimRow], name: str):
        if not rows:
            return
        self.backend.run_batch(rows, name)
        self.all_rows.extend(rows)

    def run(self) -> list[Design]:
        if not self.cands:
            self.log("  no eligible (booster, sustainer, profile) candidates - nothing to search")
            return []
        keys = {c.key for c in self.cands}
        n_sus = len({c.sustainer for c in self.cands})
        self.log(f"  {len(self.cands)} candidates = {len(keys)} (booster, sustainer, profile) [{n_sus} sustainer(s)] x separation delays {sorted({c.sep_delay_s for c in self.cands})} s; ignition delays {self.gap:g}-{self.ign_max:g} s")
        self._search(self.cands, tag="search")
        # one design per key: solved > smallest miss > shortest coast
        best: dict[tuple[str, str, str], Candidate] = {}
        for c in self.cands:
            k = c.key
            if k not in best or self._rank(c) < self._rank(best[k]):
                best[k] = c
        b_order = [c.booster for c in self.cands]
        s_order = [c.sustainer for c in self.cands]
        designs = []
        for k in sorted(best, key=lambda k: (b_order.index(k[0]), s_order.index(k[1]), k[2])):
            chosen = best[k]
            d = self._design(chosen)
            siblings = [c for c in self.cands if c.key == k]
            d.n_sims = sum(len([r for r in c.samples.values() if r.max_alt_ft is not None]) for c in siblings)
            d.extra["samples"] = [(r.ign_delay_s, r.max_alt_ft, c.sep_delay_s) for c in siblings for r in c.sorted_samples() if r.max_alt_ft is not None]
            d.extra["separation_delays_tried"] = sorted({c.sep_delay_s for c in siblings})
            designs.append(d)
        return designs

    def _rank(self, c: Candidate):
        s = [r for r in c.sorted_samples() if r.max_alt_ft is not None]
        if not s:
            return (2, 0.0, 0.0)
        best = min(s, key=lambda r: abs(r.max_alt_ft - self.target))
        miss = abs(best.max_alt_ft - self.target)
        coast = c.sep_delay_s + best.ign_delay_s
        return (0 if c.status == "solved" else 1, 0.0 if c.status == "solved" else miss, coast)

    def _grid_rows(self, c: Candidate, delays, rnd: int = 0) -> list[SimRow]:
        rows = []
        for d in delays:
            d = round(float(d), 2)
            if d in c.samples:
                continue
            r = make_row(c.booster, c.profile, c.sep_delay_s, d, self.ms, self.mass[(c.booster, c.sustainer)], self.cfg, rnd=rnd)
            c.samples[r.ign_delay_s] = r
            rows.append(r)
        return rows

    def _pilots(self, cands: list[Candidate]) -> dict[int, Candidate]:
        """Neighbour candidate id -> its pilot: the middle separation delay of
        each (booster, sustainer, profile) group flies the full grid first."""
        groups: dict[tuple, list[Candidate]] = {}
        for c in cands:
            groups.setdefault(c.key, []).append(c)
        out: dict[int, Candidate] = {}
        for g in groups.values():
            if len(g) < 2:
                continue
            g = sorted(g, key=lambda c: c.sep_delay_s)
            p = g[len(g) // 2]
            for c in g:
                if c is not p:
                    out[id(c)] = p
        return out

    def _window(self, c: Candidate, pilot: Candidate) -> list[float]:
        """Coarse grid points worth flying for a neighbour of `pilot`: both
        ends, plus two steps around each of the pilot's crossings, or around
        its peak when it never crossed the target."""
        full = self._coarse_delays(c)
        s = [r for r in pilot.sorted_samples() if r.max_alt_ft is not None]
        if len(s) < 2:
            return full
        errs = [r.max_alt_ft - self.target for r in s]
        spans = [(s[i].ign_delay_s, s[i + 1].ign_delay_s) for i in range(len(s) - 1) if errs[i] * errs[i + 1] <= 0]
        if not spans:
            peak = max(s, key=lambda r: r.max_alt_ft).ign_delay_s
            spans = [(peak, peak)]
        keep = {full[0], full[-1]}
        m = 2 * self.step + 1e-6
        for lo, hi in spans:
            keep |= {d for d in full if lo - m <= d <= hi + m}
        return sorted(keep)

    def _gaps(self, c: Candidate) -> list[float]:
        """Grid points between two samples that straddle the target but are not
        adjacent on the coarse grid (a crossing outside the narrowed window)."""
        s = [r for r in c.sorted_samples() if r.max_alt_ft is not None]
        errs = [r.max_alt_ft - self.target for r in s]
        full = self._coarse_delays(c)
        out = []
        for i in range(len(s) - 1):
            lo, hi = s[i].ign_delay_s, s[i + 1].ign_delay_s
            if errs[i] * errs[i + 1] <= 0 and hi - lo > self.step + 1e-6:
                out += [d for d in full if lo < d < hi]
        return out

    def _search(self, cands: list[Candidate], tag: str):
        """Coarse ignition-delay grid, then bracket refinement, for these candidates."""
        pilots = self._pilots(cands) if self.pilot_grid else {}
        rows = []
        for c in cands:
            if id(c) not in pilots:
                rows += self._grid_rows(c, self._coarse_delays(c))
        self.log(f"  round 0: {len(rows)} rows over {len(cands) - len(pilots)} candidates (ignition delay grid)" + (f"; {len(pilots)} separation-delay neighbours follow their pilot" if pilots else ""))
        self._run_rows(rows, f"{tag}-r0")
        if pilots:
            rows = []
            for c in cands:
                p = pilots.get(id(c))
                if p is not None:
                    rows += self._grid_rows(c, self._window(c, p))
            self.log(f"  round 0b: {len(rows)} rows over {len(pilots)} neighbours (grid narrowed to the pilot's crossings)")
            self._run_rows(rows, f"{tag}-r0b")
            rows = []
            for c in cands:
                if id(c) in pilots:
                    rows += self._grid_rows(c, self._gaps(c))
            if rows:
                self.log(f"  round 0c: {len(rows)} rows filling grid gaps that straddle the target")
                self._run_rows(rows, f"{tag}-r0c")

        for rnd in range(1, self.max_rounds + 1):
            rows = []
            for c in cands:
                if c.done:
                    continue
                self._update_status(c)
                if c.done:
                    continue
                for lo, hi in c.brackets[:2]:  # refine up to two crossings per candidate
                    d = self._propose(c, lo, hi)
                    if d is None or d in c.samples:
                        continue
                    r = make_row(c.booster, c.profile, c.sep_delay_s, d, self.ms, self.mass[(c.booster, c.sustainer)], self.cfg, rnd=rnd)
                    c.samples[r.ign_delay_s] = r
                    rows.append(r)
            if not rows:
                break
            self.log(f"  round {rnd}: {len(rows)} refinement rows")
            self._run_rows(rows, f"{tag}-r{rnd}")
        for c in cands:
            if not c.done:
                self._update_status(c, final=True)

    # ---- per-candidate logic -----------------------------------------------
    def _update_status(self, c: Candidate, final: bool = False):
        s = [r for r in c.sorted_samples() if r.max_alt_ft is not None]
        if not s:
            c.status, c.done = "unsolved", True
            return
        hits = [r for r in s if abs(r.max_alt_ft - self.target) <= self.tol]
        if hits:
            c.status, c.done = "solved", True
            return
        errs = [r.max_alt_ft - self.target for r in s]
        c.brackets = [(s[i].ign_delay_s, s[i + 1].ign_delay_s) for i in range(len(s) - 1) if errs[i] * errs[i + 1] < 0]
        if not c.brackets:
            c.status = "underpowered" if max(errs) < 0 else "overpowered"
            c.done = True
            return
        c.status = "refining"
        if final:
            c.status, c.done = "unsolved", True

    def _propose(self, c: Candidate, lo: float, hi: float) -> float | None:
        a, b = c.samples[lo], c.samples[hi]
        fa, fb = a.max_alt_ft - self.target, b.max_alt_ft - self.target
        if hi - lo < 0.02:
            return None
        # regula falsi, but never closer than 10% of the bracket to an endpoint
        d = lo - fa * (hi - lo) / (fb - fa)
        margin = 0.1 * (hi - lo)
        d = min(max(d, lo + margin), hi - margin)
        return round(d, 2)

    def _design(self, c: Candidate) -> Design:
        s = [r for r in c.sorted_samples() if r.max_alt_ft is not None]
        if not s:
            return Design(c.booster, c.profile, c.sep_delay_s, float("nan"), float("nan"), "unsolved", n_sims=len(c.samples), sustainer=c.sustainer)
        best = min(s, key=lambda r: (abs(r.max_alt_ft - self.target), r.ign_delay_s))
        by_delay = c.sorted_samples()
        d = Design(
            booster=c.booster,
            profile=c.profile,
            sep_delay_s=c.sep_delay_s,
            ign_delay_s=best.ign_delay_s,
            apogee_ft=best.max_alt_ft,
            status=c.status,
            n_sims=len(s),
            apogee_min_delay_ft=by_delay[0].max_alt_ft,
            apogee_max_delay_ft=by_delay[-1].max_alt_ft,
            sustainer=c.sustainer,
        )
        d.hint = self._hint(c, s)
        d.extra["samples"] = [(r.ign_delay_s, r.max_alt_ft, c.sep_delay_s) for r in s]
        return d

    def _hint(self, c: Candidate, s: list[SimRow]) -> str:
        self.cfg["profiles"]
        if c.status == "underpowered":
            best = max(s, key=lambda r: r.max_alt_ft)
            if best is s[-1]:
                return f"apogee still rising at the longest coast (separation {c.sep_delay_s:g}s + ignition {best.ign_delay_s:g}s -> {best.max_alt_ft:.0f} ft): raise profiles.ignition_delay_max_s / separation_delay_max_s"
            return f"peak apogee {best.max_alt_ft:.0f} ft at a {best.ign_delay_s:g}s ignition delay; target not reachable with this booster (less hardware mass or more impulse needed)"
        if c.status == "overpowered":
            low = min(s, key=lambda r: r.max_alt_ft)
            if low is s[0]:
                at_floor = c.sep_delay_s <= 1e-9 and low.ign_delay_s <= 1e-9
                knobs = ([] if c.sep_delay_s <= 1e-9 else ["profiles.separation_delay_min_s"]) + ([] if low.ign_delay_s <= 1e-9 else ["profiles.ignition_delay_min_s"])
                fix = "ignition is already at burnout (both delays 0) - " if at_floor else f"lower {' / '.join(knobs)} (0 = at burnout / at separation), "
                return f"lowest apogee {low.max_alt_ft:.0f} ft is at the shortest allowed coast (separation {c.sep_delay_s:g}s + ignition {low.ign_delay_s:g}s): {fix}use a lower-impulse sustainer, more hardware mass, or trim with airbrakes/ballast"
            return f"lowest apogee {low.max_alt_ft:.0f} ft at the longest coast ({low.ign_delay_s:g}s): raise profiles.ignition_delay_max_s"
        if c.status == "unsolved":
            return "bracket found but not converged: raise profiles.max_refine_rounds"
        return ""
