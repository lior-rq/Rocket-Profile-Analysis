"""Hardware-mass override: dry masses scaled, propellant untouched, CGs recombined."""

from rpa.massmodel import StageMasses, mass_row

# a made-up vehicle: sustainer dry 30 lb @ 60 in, booster dry 40 lb @ 130 in,
# sustainer prop 20 lb @ 80 in, booster prop 30 lb @ 150 in
SM = StageMasses(
    sustainer_dry_lb=30.0, sustainer_dry_cg_in=60.0,
    stack_dry_lb=70.0, stack_dry_cg_in=(30 * 60 + 40 * 130) / 70,
    sustainer_loaded_lb=50.0, sustainer_loaded_cg_in=(30 * 60 + 20 * 80) / 50,
    stack_loaded_lb=120.0, stack_loaded_cg_in=(30 * 60 + 40 * 130 + 20 * 80 + 30 * 150) / 120,
)


def test_propellant_recovered_from_openrocket_pairs():
    assert abs(SM.sustainer_prop_lb - 20) < 1e-9 and abs(SM.sustainer_prop_cg_in - 80) < 1e-9
    assert abs(SM.booster_prop_lb - 30) < 1e-9 and abs(SM.booster_prop_cg_in - 150) < 1e-9
    assert abs(SM.booster_dry_lb - 40) < 1e-9


def test_no_override_reproduces_openrocket():
    r = mass_row("B", SM, 13.6, None)
    assert r.sustainer_wt_lb == 50.0 and r.combined_wt_lb == 120.0
    assert abs(r.sustainer_cg_in - SM.sustainer_loaded_cg_in) < 1e-3 and abs(r.combined_cg_in - SM.stack_loaded_cg_in) < 1e-3
    assert r.hardware_mass_lb is None and r.sustainer_dry_lb == 30.0 and r.booster_dry_lb == 40.0


def test_hardware_mass_scales_dry_only():
    r = mass_row("B", SM, 13.6, 140.0)  # twice the dry mass
    assert r.sustainer_dry_lb == 60.0 and r.booster_dry_lb == 80.0 and r.hardware_mass_lb == 140.0
    assert r.sustainer_wt_lb == 80.0 and r.combined_wt_lb == 190.0  # + 20 and + 50 lb of propellant
    assert abs(r.sustainer_cg_in - (60 * 60 + 20 * 80) / 80) < 1e-3
    assert abs(r.combined_cg_in - (60 * 60 + 80 * 130 + 20 * 80 + 30 * 150) / 190) < 1e-3
