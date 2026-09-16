import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

# Synthetic inputs so the tests need no real vehicle or motor files.
ENG_BOOSTERS = """; Throat 1.500 in, exit 3.000 in.
24000O6000-01 152 2032 0 40.0 55.0 Maker
0.1 6000
4.0 6000
4.1 0
; Throat 1.400 in, exit 2.900 in.
27300O6500-02 152 2032 0 41.0 56.0 Maker
0.1 6500
4.2 6500
4.3 0
; Throat 1.600 in, exit 3.200 in.
23560O6200-03 152 2032 0 39.0 54.0 Maker
0.1 6200
3.8 6200
3.9 0
"""
ENG_SUSTAINERS = {
    "01-13800N1500.eng": """; Throat 1.400 in, exit 2.450 in.
13800N1500-01 152 1500 0 20.0 30.0 Maker
0.1 1500
9.2 1500
9.3 0
""",
    "02-13708N1490.eng": """; Throat 1.400 in, exit 2.450 in.
13708N1490-02 152 1500 0 19.8 29.8 Maker
0.1 1490
9.2 1490
9.3 0
""",
}
CDX1 = """<RASAeroDocument><FileVersion>2</FileVersion><RocketDesign>
<NoseCone><PartType>NoseCone</PartType><Length>40</Length><Diameter>6</Diameter><Shape>LV-Haack</Shape><Location>0</Location></NoseCone>
<BodyTube><PartType>BodyTube</PartType><Length>80</Length><Diameter>6</Diameter><Location>40</Location><BoattailLength>0</BoattailLength><BoattailRearDiameter>0</BoattailRearDiameter>
<Fin><Count>4</Count><Chord>10</Chord><Span>5</Span><SweepDistance>4</SweepDistance><TipChord>6</TipChord><Location>14</Location></Fin></BodyTube>
<Booster><PartType>Booster</PartType><Length>55</Length><Diameter>6</Diameter><Location>120</Location><BoattailLength>0</BoattailLength><BoattailRearDiameter>0</BoattailRearDiameter>
<Fin><Count>4</Count><Chord>10</Chord><Span>5</Span><SweepDistance>4</SweepDistance><TipChord>6</TipChord><Location>11</Location></Fin></Booster>
</RocketDesign><LaunchSite><Altitude>2782</Altitude><Pressure>27.1</Pressure><RodAngle>0</RodAngle><RodLength>22</RodLength><Temperature>110</Temperature><WindSpeed>0</WindSpeed></LaunchSite>
<SimulationList><Simulation><SustainerEngine>x</SustainerEngine><MaxAltitude>0</MaxAltitude></Simulation></SimulationList></RASAeroDocument>
"""


@pytest.fixture
def motor_dirs(tmp_path):
    """(boosters, sustainers) sources: one multi-motor file + a folder."""
    b = tmp_path / "boosters.eng"
    b.write_text(ENG_BOOSTERS)
    s = tmp_path / "sustainers"
    s.mkdir()
    for name, text in ENG_SUSTAINERS.items():
        (s / name).write_text(text)
    return [b], [s]


@pytest.fixture
def cdx1_file(tmp_path):
    p = tmp_path / "vehicle.CDX1"
    p.write_text(CDX1)
    return p
