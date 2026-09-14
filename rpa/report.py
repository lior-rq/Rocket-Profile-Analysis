"""Ranked results table, markdown summary and plots."""

from __future__ import annotations

from pathlib import Path

import pandas as pd

from .models import Design


def rank(designs: list[Design], cfg) -> pd.DataFrame:
    df = pd.DataFrame([d.to_dict() for d in designs])
    if df.empty:
        return df
    metric = cfg["ranking"]["metric"]
    desc = bool(cfg["ranking"]["descending"])
    df["feasible"] = (df["status"] == "solved") & (df["verified_ok"].fillna(True).astype(bool))
    if metric in df.columns:
        df = df.sort_values(["feasible", metric], ascending=[False, not desc], na_position="last")
    else:
        df = df.sort_values(["feasible"], ascending=[False])
    df.insert(0, "rank", range(1, len(df) + 1))
    return df.reset_index(drop=True)


def write_report(out: Path, cfg, ranked: pd.DataFrame, chars: pd.DataFrame | None, elig: pd.DataFrame | None, sustainer: dict | None) -> Path:
    t = cfg["target"]
    p = cfg["profiles"]
    lines = ["# Two-stage flight profile search", ""]
    lines.append(f"Target apogee **{t['apogee_ft']:.0f} ft** (±{t['tolerance_ft']:.0f} ft). Backend: `{cfg['backend']}`.")
    if sustainer:
        lines.append(f"Sustainer (max impulse): **{sustainer['label']}** ({sustainer['total_impulse_ns']:.0f} N·s).")
    mm = cfg.get("mass_model", {})
    if mm.get("method", "openrocket") == "openrocket":
        hw = mm.get("hardware_mass_lb")
        lines.append(f"Mass model: OpenRocket, vehicle dry (hardware) mass **{float(hw):g} lb**, propellant from the .eng files." if hw not in (None, "", "null") else "Mass model: OpenRocket masses as in the .ork.")
    else:
        lines.append("Mass model: manual (config.yaml mass_model.manual).")
    lines.append(
        f"Profiles: subsonic = stack never above Mach {p['subsonic_max_mach']} (design margin {p['mach_margin']}); "
        f"supersonic = separation at Mach ≥ {p['supersonic_min_mach']} (margin {p['mach_margin']}). "
        f"Separation delay searched between {p['separation_delay_min_s']:g} s and {p['separation_delay_max_s']:g} s after burnout (step {p['separation_step_s']:g} s); "
        f"sustainer ignition between {p['ignition_delay_min_s']:g} s and {p['ignition_delay_max_s']:g} s after separation (RASAero's SustainerIgnitionDelay; ignition is never before burnout)."
    )
    lines.append("")
    if elig is not None and not elig.empty:
        lines.append("## Booster eligibility")
        lines.append("")
        for prof in elig["profile"].unique():
            sub = elig[elig["profile"] == prof]
            lines.append(f"- **{prof}**: {int(sub['eligible'].sum())} of {len(sub)} boosters eligible")
        lines.append("")
    if chars is not None and not chars.empty:
        lines.append("## Boost-phase characterization (attached stack)")
        lines.append("")
        c = chars.copy()
        cols = ["booster", "t_burnout_s", "max_mach_boost", "t_max_mach_s", "mach_burnout", "vel_burnout_fps", "alt_burnout_ft", "rail_exit_vel_fps", "t_below_supersonic_s", "t_below_subsonic_s", "events_consistent"]
        lines.append(c[[x for x in cols if x in c.columns]].to_markdown(index=False))
        lines.append("")
    lines.append("## Designs (ranked)")
    lines.append("")
    if ranked.empty:
        lines.append("_No eligible candidates - see eligibility above._")
    else:
        cols = ["rank", "booster", "profile", "status", "sep_delay_s", "ign_delay_s", "apogee_ft", "mach_at_sep", "vel_at_ign_fps", "mach_at_ign", "alt_at_ign_ft", "max_mach", "max_accel_g", "rail_exit_vel_fps", "t_apogee_s", "apogee_min_delay_ft", "apogee_max_delay_ft", "verified_ok", "verify_note", "hint"]
        lines.append(ranked[[x for x in cols if x in ranked.columns]].to_markdown(index=False))
    lines.append("")
    lines.append("Status meanings: `solved` = an ignition delay hits the target within tolerance; `underpowered` = even the shortest coast falls short; "
                 "`overpowered` = apogee stays above target for every delay in the windows (lower the minimum delays, add hardware mass, or plan on airbrakes); `unsolved` = bracket found but not converged in the allowed rounds.")
    path = out / "report.md"
    path.write_text("\n".join(lines))
    return path


def plots(out: Path, cfg, designs: list[Design], chars: pd.DataFrame | None, hist_dir: Path) -> list[Path]:
    import matplotlib

    matplotlib.use("Agg")
    import matplotlib.pyplot as plt

    made = []
    target = cfg["target"]["apogee_ft"]
    # apogee vs ignition delay, per profile
    by_prof = {}
    for d in designs:
        s = d.extra.get("samples") or []
        if s:
            by_prof.setdefault(d.profile, []).append((d, s))
    if by_prof:
        fig, axes = plt.subplots(1, len(by_prof), figsize=(7 * len(by_prof), 5), squeeze=False)
        for ax, (prof, items) in zip(axes[0], by_prof.items(), strict=False):
            for d, s in items:
                # samples are (ignition delay, apogee[, separation delay]); plot the chosen separation delay's curve
                pts = sorted((x[0], x[1]) for x in s if len(x) < 3 or abs(x[2] - d.sep_delay_s) < 1e-9)
                if not pts:
                    continue
                xs, ys = zip(*pts, strict=False)
                ax.plot(xs, ys, marker="o", ms=3, lw=1, label=d.booster)
            ax.axhline(target, color="k", ls="--", lw=1)
            ax.set_title(f"{prof}: apogee vs sustainer ignition delay")
            ax.set_xlabel("sustainer ignition delay after separation [s]")
            ax.set_ylabel("apogee [ft]")
            if len(items) <= 12:
                ax.legend(fontsize=7)
        fig.tight_layout()
        p = out / "apogee_vs_delay.png"
        fig.savefig(p, dpi=130)
        plt.close(fig)
        made.append(p)
    # boost-phase Mach summary
    if chars is not None and not chars.empty:
        fig, ax = plt.subplots(figsize=(10, 4.5))
        x = range(len(chars))
        ax.bar(x, chars["max_mach_boost"], color="#4a7", label="peak Mach during boost")
        ax.axhline(cfg["profiles"]["subsonic_max_mach"], color="b", ls="--", lw=1, label="subsonic limit 0.9")
        ax.axhline(cfg["profiles"]["supersonic_min_mach"], color="r", ls="--", lw=1, label="supersonic floor 1.2")
        ax.set_xticks(list(x))
        ax.set_xticklabels(chars["booster"], rotation=90, fontsize=6)
        ax.set_ylabel("Mach")
        ax.legend(fontsize=8)
        ax.set_title("Attached-stack peak Mach per booster")
        fig.tight_layout()
        p = out / "boost_mach.png"
        fig.savefig(p, dpi=130)
        plt.close(fig)
        made.append(p)
    # Mach vs time for verified designs
    finals = sorted(hist_dir.glob("final-*.csv"))
    if finals:
        fig, ax = plt.subplots(figsize=(9, 5))
        for f in finals[:15]:
            h = pd.read_csv(f)
            ax.plot(h["time_s"], h["mach"], lw=1, label=f.stem.replace("final-", ""))
        ax.axhspan(cfg["profiles"]["subsonic_max_mach"], cfg["profiles"]["supersonic_min_mach"], color="orange", alpha=0.15, label="transonic band")
        ax.set_xlabel("time [s]")
        ax.set_ylabel("Mach")
        ax.set_xlim(0, 60)
        ax.legend(fontsize=7)
        ax.set_title("Mach vs time, final designs")
        fig.tight_layout()
        p = out / "final_mach_vs_time.png"
        fig.savefig(p, dpi=130)
        plt.close(fig)
        made.append(p)
    return made
