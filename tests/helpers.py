"""Shared test shapes, synthetic datasets, boundary rows and plan and build shortcuts."""
import json
from dataclasses import replace
from pathlib import Path

import numpy as np
import zarr
from shapely.geometry import MultiPolygon, box

from soe import db
from soe.areas import Area
from soe.build import build_scene
from soe.bundle import JsonObject
from soe.cube_ingest import INGEST_SPECS, write_months
from soe.plan import Plan, plan
from soe.sources import CellWindow, CubeSpec, Dataset, Grid, SyntheticSource, make_registry

NAIROBI = box(36.5, -1.5, 37.5, -0.5)
FIJI = MultiPolygon([box(178, -19, 180, -17), box(-180, -19, -178, -17)])

SYNTHETIC_REGISTRY = make_registry(SyntheticSource())
RAIN, TERRAIN = SYNTHETIC_REGISTRY["chirps_monthly"], SYNTHETIC_REGISTRY["copdem_terrain"]
COARSE = replace(
    RAIN,
    id="coarse_monthly",
    resolution_deg=0.1,
    grid=Grid(-180, 60, 0.1, 3600, 1200),
)

BOUNDARY = {
    "id": "cgaz:ADM1:TEST",
    "name": "Testland",
    "level": "state",
    "iso3": "KEN",
    "source": "geoBoundaries CGAZ",
    "licence": "CC BY 4.0",
}

HASH_A, HASH_B, HASH_C = "a" * 20, "b" * 20, "c" * 20


def write_cube(
    cubes_dir: Path,
    name: str,
    values: float | np.ndarray,
    month: str = "2016-01",
    expver: str = "0001",
) -> None:
    """Store one month in the named cube; a number fills every cell of the cube's grid."""
    grid = INGEST_SPECS[name].cube.grid
    field = np.full((grid.rows, grid.columns), values, "float32")
    write_months(cubes_dir, INGEST_SPECS[name], [(month, field, expver)])


def plan_months(area: Area, datasets: list[Dataset], months: int = 12) -> Plan:
    """Plan `months` months starting in 1990-01."""
    end = f"{1990 + (months - 1) // 12}-{(months - 1) % 12 + 1:02d}"
    return plan(area, datasets, "1990-01", end)


def build_nairobi(
    tmp_path: Path,
    months: tuple[str, str] = ("2015-01", "2016-02"),
) -> tuple[JsonObject, zarr.Group]:
    """Build a Nairobi terrain and rain scene; return its scene.json and opened Zarr store."""
    build_scene(
        HASH_A,
        Area(NAIROBI, BOUNDARY),
        months[0],
        months[1],
        [TERRAIN, RAIN],
        "Test",
        tmp_path,
    )
    scene_dir = tmp_path / HASH_A
    document = json.loads((scene_dir / "scene.json").read_text(encoding="utf-8"))
    return document, zarr.open_group(scene_dir / "data.zarr", mode="r")


def boundary_row(
    boundary_id: str,
    level: str,
    name: str,
    parent_name: str | None = None,
    iso3: str | None = None,
    bbox: tuple[float, float, float, float] = (0, 0, 1, 1),
    cells: int = 400,
    geometry: str = "{}",
    source: str = "geoBoundaries CGAZ",
    licence: str = "CC BY 4.0",
) -> db.BoundaryValues:
    """One boundaries row in the column order of db.INSERT_BOUNDARY."""
    return (boundary_id, level, name, parent_name, iso3, *bbox, cells, geometry, source, licence)


class ReingestedSource(SyntheticSource):
    """Simulate cube re-ingestion after a configured number of reads by changing every marker."""

    def __init__(self, reads_before_reingest: int | None = None) -> None:
        super().__init__()
        self.reads_before_reingest = reads_before_reingest
        self.reingested = False

    def reingest(self) -> None:
        self.reingested = True

    def cube_months(self, spec: CubeSpec) -> dict[str, str]:
        months = super().cube_months(spec)
        if not self.reingested:
            return months

        return {month: marker + ":again" for month, marker in months.items()}

    def read_cube(self, spec: CubeSpec, month: str, window: CellWindow) -> np.ndarray:
        values = super().read_cube(spec, month, window)
        if self.reads_before_reingest is not None and self.reads >= self.reads_before_reingest:
            self.reingest()

        return values
