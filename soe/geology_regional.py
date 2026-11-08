"""Composite regional geology overrides with the global rock-age and rock-type maps.

Regional COGs are read in priority order and remaining cells use the global base map.
Every cell keeps its source code so notices and attribution list only the sources used.
Sources missing on disk are skipped silently so the base maps still work on their own.
"""
from collections.abc import Callable

import numpy as np
from rasterio.transform import Affine

from .areas import WORLD_WIDTH_DEG
from .sources.lithology import GEOLOGY_CLASSES, OPENLANDMAP_SOURCE

BASE_CODE = 1  # the global base map (GSC for age, GLiM or OpenLandMap for type)
CANADA_CODE = 3
EGDI_CODE = 4
IGME_CODE = 2
SGMC_CODE = 5

CODE_MEANINGS = ("global_base", "europe_igme5000", "canada_5m", "europe_egdi", "us_sgmc")
CODE_VALUES = (BASE_CODE, IGME_CODE, CANADA_CODE, EGDI_CODE, SGMC_CODE)

CANADA_AGE_FILE = "geology_age_canada.tif"
CANADA_TYPE_FILE = "geology_type_canada.tif"
EGDI_TYPE_FILE = "geology_type_egdi.tif"
IGME_AGE_FILE = "geology_age_igme5000.tif"
IGME_TYPE_FILE = "geology_type_igme5000.tif"
SGMC_AGE_FILE = "geology_age_sgmc.tif"
SGMC_TYPE_FILE = "geology_type_sgmc.tif"

# Priority rises down the table, so a later source wins where footprints overlap.
REGIONAL_SOURCES = (
    {
        "id": "europe_igme5000",
        "title": "Europe, Turkey and the Caucasus (IGME5000)",
        "licence": "europe_igme5000",
        "footprint": (-13.0, 32.0, 52.0, 73.0),
        "age_file": IGME_AGE_FILE,
        "type_file": IGME_TYPE_FILE,
        "scale": "1:5,000,000",
        "representation": "pre-Quaternary bedrock",
    },
    {
        "id": "canada_5m",
        "title": "Canada (GSC 1:5M, Map 1860A)",
        "licence": "canada_5m",
        "footprint": (-170.0, 38.0, -50.0, 74.0),
        "age_file": CANADA_AGE_FILE,
        "type_file": CANADA_TYPE_FILE,
        "scale": "1:5,000,000",
        "representation": "bedrock geology",
    },
    {
        "id": "europe_egdi",
        "title": "Europe (EGDI surface lithology raster)",
        "licence": "europe_egdi",
        "footprint": (-12.0, 34.0, 45.0, 72.0),
        "age_file": None,
        "type_file": EGDI_TYPE_FILE,
        "scale": "1:1,000,000 (250 m raster)",
        "representation": "surface geology",
    },
    {
        "id": "us_sgmc",
        "title": "Conterminous US (USGS SGMC)",
        "licence": "us_sgmc",
        "footprint": (-127.0, 22.0, -66.0, 51.0),
        "age_file": SGMC_AGE_FILE,
        "type_file": SGMC_TYPE_FILE,
        "scale": "1:50,000-1:1,000,000",
        "representation": "bedrock or surface geology depending on the state",
    },
)

SOURCE_IDS = tuple(source["id"] for source in REGIONAL_SOURCES)
SOURCE_CODES = {
    "europe_igme5000": IGME_CODE,
    "canada_5m": CANADA_CODE,
    "europe_egdi": EGDI_CODE,
    "us_sgmc": SGMC_CODE,
}

# The OpenLandMap class value of each GLiM family, for type layers whose base is OpenLandMap.
OPENLANDMAP_FAMILY_VALUES = {
    "ev": 6,
    "ig": 7,
    "mt": 10,
    "pa": 1,
    "pb": 3,
    "pi": 8,
    "py": 12,
    "sc": 5,
    "sm": 11,
    "ss": 13,
    "su": 14,
    "va": 2,
    "vb": 4,
    "vi": 9,
}


def read_composited(
    backend: object,
    kind: str,
    base_file: str,
    bounds: tuple[float, float, float, float],
    res: float,
    on_block: Callable[[], None] | None = None,
) -> tuple[np.ndarray, np.ndarray, Affine]:
    """Return the composited classes, their source codes and the transform over bounds at res.

    The base COG fills every cell first and each present regional COG overrides it in priority
    order. Regional COGs missing on disk are skipped silently, while an unreadable one still
    fails. Codes are 0 where no map has a value, 1 for the base and one per regional source.
    Regional types hold GLiM values, so an OpenLandMap base takes them as its own classes.
    """
    base, transform = backend.lithology(bounds, res, on_block or (lambda: None), base_file)
    translate = kind == "type" and backend.lithology_source(base_file) == OPENLANDMAP_SOURCE
    overlays = []
    for source in candidates_for(kind, bounds, backend.has_lithology):
        key = "age_file" if kind == "age" else "type_file"
        regional, _ = backend.lithology(bounds, res, lambda: None, source[key])
        if translate:
            regional = _glim_to_openlandmap(regional)
        overlays.append((SOURCE_CODES[source["id"]], regional))
    value, codes = composite_values(base, overlays)
    return value, codes, transform


def _glim_to_openlandmap(classes: np.ndarray) -> np.ndarray:
    """Return GLiM class values as the OpenLandMap class of their family, 0 staying 0."""
    lookup = np.zeros(256, "uint8")
    for entry in GEOLOGY_CLASSES:
        lookup[entry["value"]] = OPENLANDMAP_FAMILY_VALUES[entry["parent"]]
    return lookup[classes]


def candidates_for(
    kind: str,
    bbox: tuple[float, ...],
    present: Callable[[str], bool],
) -> list[dict]:
    """Return the sources supplying `kind` whose footprint meets bbox and whose COG is present."""
    key = "age_file" if kind == "age" else "type_file"
    return [
        source
        for source in sources_for_kind(kind)
        if footprint_intersects(source, bbox) and present(source[key])  # type: ignore[arg-type]
    ]


def sources_for_kind(kind: str) -> tuple[dict, ...]:
    """Return the regional sources that supply `kind` ("age" or "type"), lowest priority first."""
    key = "age_file" if kind == "age" else "type_file"
    return tuple(source for source in REGIONAL_SOURCES if source[key] is not None)


def footprint_intersects(source: dict, bbox: tuple[float, ...]) -> bool:
    """Return whether the bbox (W, S, E, N) overlaps the source footprint.

    Scene bboxes may run 0 to 360 past the antimeridian while footprints stay
    within -180 to 180, so each footprint is also tried one world width away.
    """
    west, south, east, north = source["footprint"]
    latitudes_overlap = bbox[1] < north and bbox[3] > south
    return latitudes_overlap and any(
        bbox[0] < east + shift and bbox[2] > west + shift
        for shift in (-WORLD_WIDTH_DEG, 0, WORLD_WIDTH_DEG)
    )


def composite_values(
    base: np.ndarray,
    overlays: list[tuple[int, np.ndarray]],
) -> tuple[np.ndarray, np.ndarray]:
    """Return the composited classes and the code of the source behind each cell.

    Overlays come in priority order, so a later nonzero cell wins over every earlier one.
    Cells with no value anywhere stay 0 in both arrays.
    """
    value = base.copy()
    codes = np.where(base != 0, BASE_CODE, 0).astype("uint8")
    for code, overlay in overlays:
        covered = overlay != 0
        value[covered] = overlay[covered]
        codes[covered] = code
    return value, codes


def used_in(codes: np.ndarray) -> tuple[str, ...]:
    """Return the ids of the sources behind the nonzero codes, base first, then by priority."""
    present = set(np.unique(codes[codes > 0]).tolist())
    ids = ["global_base"] if BASE_CODE in present else []
    ids += [source["id"] for source in REGIONAL_SOURCES if SOURCE_CODES[source["id"]] in present]
    return tuple(ids)


def regional_notices(used_ids: tuple[str, ...], kind: str) -> list[str]:
    """Return one notice per regional source used, naming its scale and representation."""
    notices = []
    for source in REGIONAL_SOURCES:
        if source["id"] not in used_ids:
            continue
        notices.append(
            f"{source['title']}: rock {kind} comes from {source['title'].split(' (')[0]} "
            f"at {source['scale']}, {source['representation']}.",
        )
    return notices
