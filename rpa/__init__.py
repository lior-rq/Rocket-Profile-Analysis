"""Rocket Profile Analysis - two-stage flight profile optimizer.

Automates the IREC "Flight Sim S.O.P. for Two-Stage Rockets": OpenRocket for
mass properties, RASAero II for the flight simulations, and a search over
booster motors / staging delays that hits a target apogee while keeping the
booster separation out of the transonic region.
"""

__version__ = "0.1.0"
