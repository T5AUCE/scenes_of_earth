"""Shared test shapes, synthetic datasets and a planning shortcut."""
from shapely.geometry import MultiPolygon, box

from soe.areas import Area
from soe.plan import Plan, plan
from soe.sources import Dataset, SyntheticSource, make_registry

NAIROBI = box(36.5, -1.5, 37.5, -0.5)
FIJI = MultiPolygon([box(178, -19, 180, -17), box(-180, -19, -178, -17)])

SYNTHETIC_REGISTRY = make_registry(SyntheticSource())
RAIN, TERRAIN = SYNTHETIC_REGISTRY["chirps_monthly"], SYNTHETIC_REGISTRY["glo90_terrain"]


def plan_months(area: Area, datasets: list[Dataset], months: int = 12) -> Plan:
    """plan() for a period of `months` months starting 1990-01."""
    end = f"{1990 + (months - 1) // 12}-{(months - 1) % 12 + 1:02d}"
    return plan(area, datasets, "1990-01", end)
