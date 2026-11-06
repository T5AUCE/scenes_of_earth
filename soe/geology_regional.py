"""Regional geology overrides that patch the global rock-age and rock-type maps.

Each regional source is ingested once to its own uint8 class COGs on the existing geology grids
(age at 1/120 degrees, type at 1/480 degrees), with 0 for no data. At build time the geology
layers read the regional COGs in priority order and fill the remaining cells from the global base
(age from GSC Open File 5529, type from GLiM else OpenLandMap). Every cell keeps the code of the
source that gave its value, so notices and attribution list only the sources actually used.
Sources missing on disk are skipped silently, so the base maps still work on their own.
"""
from collections.abc import Callable

import numpy as np
from rasterio.transform import Affine

from .geology_age import TIMELINE, smallest_containing_class
from .sources.lithology import GLIM_VALUES

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
        "representation": "surface geology",
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
        "representation": "surface geology",
    },
)

SOURCE_IDS = tuple(source["id"] for source in REGIONAL_SOURCES)
SOURCE_CODES = {
    "europe_igme5000": IGME_CODE,
    "canada_5m": CANADA_CODE,
    "europe_egdi": EGDI_CODE,
    "us_sgmc": SGMC_CODE,
}

NO_DATA_NAMES = {"", " ", "unknown", "undifferentiated"}  # blank-ish names mean no data


def sources_for_kind(kind: str) -> tuple[dict, ...]:
    """Return the regional sources that supply `kind` ("age" or "type"), lowest priority first."""
    key = "age_file" if kind == "age" else "type_file"
    return tuple(source for source in REGIONAL_SOURCES if source[key] is not None)


def footprint_intersects(source: dict, bbox: tuple[float, ...]) -> bool:
    """Return whether the bbox (W, S, E, N) overlaps the source footprint."""
    west, south, east, north = source["footprint"]
    return bbox[0] < east and bbox[2] > west and bbox[1] < north and bbox[3] > south


def candidates_for(kind: str, bbox: tuple[float, ...], present: Callable[[str], bool]) -> list[dict]:
    """Return the sources supplying `kind` whose footprint meets bbox and whose COG is present."""
    key = "age_file" if kind == "age" else "type_file"
    return [
        source
        for source in sources_for_kind(kind)
        if footprint_intersects(source, bbox) and present(source[key])  # type: ignore[arg-type]
    ]


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


def used_in(codes: np.ndarray, weights: np.ndarray) -> tuple[str, ...]:
    """Return the ids of the sources behind the weighted cells, base first, then by priority."""
    present = set(np.unique(codes[(weights > 0) & (codes > 0)]).tolist())
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


def family_value(family: str) -> int:
    """Return the class value of the undivided variant of the GLiM family `family`.

    The four sedimentary families have no undivided variant in GLiM, so they take the
    mixed-grain class which is each family's most generic one.
    """
    plain = {"su": "sumx", "ss": "ssmx", "sm": "smmx", "sc": "scmx"}
    return GLIM_VALUES[plain.get(family, family + "__")]


def _timeline_span(oldest: str, newest: str) -> tuple[str, str]:
    """Return the span ordered oldest to newest, whatever order the names come in."""
    if TIMELINE.index(oldest) <= TIMELINE.index(newest):
        return oldest, newest
    return newest, oldest


def _fail_unmapped(what: str, unmapped: set[str]) -> None:
    if unmapped:
        raise ValueError(f"{what} without a class: {sorted(unmapped)}")


CANADA_ERA_NAMES: dict[str, tuple[str, str] | None] = {
    "Cenozoic": ("Paleogene", "Quaternary"),
    "Mesozoic": ("Triassic", "Cretaceous"),
    "Mesozoic-Cenozoic": ("Triassic", "Quaternary"),
    "Paleozoic": ("Cambrian", "Permian"),
    "Paleozoic-Mesozoic": ("Cambrian", "Cretaceous"),
    "Precambrian": ("Archean", "Neoproterozoic"),
    "Precambrian-Mesozoic": ("Archean", "Cretaceous"),
    "Precambrian-Paleozoic": ("Archean", "Permian"),
}

CANADA_PERIOD_NAMES: dict[str, tuple[str, str] | None] = {
    "Archean": ("Archean", "Archean"),
    "Archean-Proterozoic": ("Archean", "Neoproterozoic"),
    "Cambrian": ("Cambrian", "Cambrian"),
    "Cambrian-Devonian": ("Cambrian", "Devonian"),
    "Cambrian-Ordovician": ("Cambrian", "Ordovician"),
    "Cambrian-Silurian": ("Cambrian", "Silurian"),
    "Carboniferous": ("Carboniferous", "Carboniferous"),
    "Carboniferous-Jurassic": ("Carboniferous", "Jurassic"),
    "Carboniferous-Permian": ("Carboniferous", "Permian"),
    "Cretaceous": ("Cretaceous", "Cretaceous"),
    "Cretaceous-Tertiary": ("Cretaceous", "Neogene"),
    "Devonian": ("Devonian", "Devonian"),
    "Devonian-Carboniferous": ("Devonian", "Carboniferous"),
    "Devonian-Cretaceous": ("Devonian", "Cretaceous"),
    "Devonian-Mississippian": ("Devonian", "Carboniferous"),
    "Devonian-Permian": ("Devonian", "Permian"),
    "Devonian-Triassic": ("Devonian", "Triassic"),
    "Jurassic": ("Jurassic", "Jurassic"),
    "Jurassic-Cretaceous": ("Jurassic", "Cretaceous"),
    "Mesoarchean": ("Archean", "Archean"),
    "Mesoarchean-Neoarchean": ("Archean", "Archean"),
    "Mesoproterozoic": ("Mesoproterozoic", "Mesoproterozoic"),
    "Mesoproterozoic-Neoproterozoic": ("Mesoproterozoic", "Neoproterozoic"),
    "Mississippian": ("Carboniferous", "Carboniferous"),
    "Mississippian-Jurassic": ("Carboniferous", "Jurassic"),
    "Mississippian-Permian": ("Carboniferous", "Permian"),
    "Mississippian-Triassic": ("Carboniferous", "Triassic"),
    "Neoarchean": ("Archean", "Archean"),
    "Neoarchean-Paleoproterozoic": ("Archean", "Paleoproterozoic"),
    "Neogene-Quaternary": ("Neogene", "Quaternary"),
    "Neoproterozoic": ("Neoproterozoic", "Neoproterozoic"),
    "Neoproterozoic-Cambrian": ("Neoproterozoic", "Cambrian"),
    "Neoproterozoic-Ordovician": ("Neoproterozoic", "Ordovician"),
    "Neoproterozoic-Paleozoic": ("Neoproterozoic", "Permian"),
    "Neoproterozoic-Silurian": ("Neoproterozoic", "Silurian"),
    "Neoproterozoic-Triassic": ("Neoproterozoic", "Triassic"),
    "Ordovician": ("Ordovician", "Ordovician"),
    "Ordovician-Devonian": ("Ordovician", "Devonian"),
    "Ordovician-Silurian": ("Ordovician", "Silurian"),
    "Ordovician-Triassic": ("Ordovician", "Triassic"),
    "Paleoarchean": ("Archean", "Archean"),
    "Paleoarchean-Neoarchean": ("Archean", "Archean"),
    "Paleoproterozoic": ("Paleoproterozoic", "Paleoproterozoic"),
    "Paleoproterozoic-Cambrian": ("Paleoproterozoic", "Cambrian"),
    "Paleoproterozoic-Mesoproterozoic": ("Paleoproterozoic", "Mesoproterozoic"),
    "Pennsylvanian": ("Carboniferous", "Carboniferous"),
    "Pennsylvanian-Permian": ("Carboniferous", "Permian"),
    "Permian": ("Permian", "Permian"),
    "Permian-Cretaceous": ("Permian", "Cretaceous"),
    "Permian-Jurassic": ("Permian", "Jurassic"),
    "Permian-Triassic": ("Permian", "Triassic"),
    "Quaternary": ("Quaternary", "Quaternary"),
    "Silurian": ("Silurian", "Silurian"),
    "Silurian-Devonian": ("Silurian", "Devonian"),
    "Tertiary": ("Paleogene", "Neogene"),
    "Triassic": ("Triassic", "Triassic"),
    "Triassic-Cretaceous": ("Triassic", "Cretaceous"),
    "Triassic-Jurassic": ("Triassic", "Jurassic"),
    "undivided Cenozoic": ("Paleogene", "Quaternary"),
    "undivided Paleozoic": ("Cambrian", "Permian"),
    "undivided Paleozoic-Mesozoic": ("Cambrian", "Cretaceous"),
    "undivided Precambrian": ("Archean", "Neoproterozoic"),
}

CANADA_EPOCH_NAMES: dict[str, tuple[str, str] | None] = {
    "Cenomanian-Santonian": ("Cretaceous", "Cretaceous"),
    "Maastrichtian-Campanian": ("Cretaceous", "Cretaceous"),
    "Miocene": ("Neogene", "Neogene"),
    "Neogene": ("Neogene", "Neogene"),
    "Oligocene": ("Paleogene", "Paleogene"),
    "Paleocene": ("Paleogene", "Paleogene"),
    "Paleogene": ("Paleogene", "Paleogene"),
    "Paleoproterozoic-early Cambrian": ("Paleoproterozoic", "Cambrian"),
    "Pleistocene": ("Quaternary", "Quaternary"),
    "Pliocene": ("Neogene", "Neogene"),
    "early Mesoproterozoic": ("Mesoproterozoic", "Mesoproterozoic"),
    "early Paleoproterozoic": ("Paleoproterozoic", "Paleoproterozoic"),
    "early-middle Mesoproterozoic": ("Mesoproterozoic", "Mesoproterozoic"),
    "early-middle Paleoproterozoic": ("Paleoproterozoic", "Paleoproterozoic"),
    "late Cretaceous": ("Cretaceous", "Cretaceous"),
    "late Jurassic": ("Jurassic", "Jurassic"),
    "late Mesoproterozoic": ("Mesoproterozoic", "Mesoproterozoic"),
    "late Mesoproterozoic-Neoproterozoic": ("Mesoproterozoic", "Neoproterozoic"),
    "late Paleoproterozoic": ("Paleoproterozoic", "Paleoproterozoic"),
    "late Paleoproterozoic-Mesoproterozoic": ("Paleoproterozoic", "Mesoproterozoic"),
    "late Paleoproterozoic-early Mesoproterozoic": ("Paleoproterozoic", "Mesoproterozoic"),
    "late Paleoproterozoic-middle Mesoproterozoic": ("Paleoproterozoic", "Mesoproterozoic"),
    "lower Cretaceous": ("Cretaceous", "Cretaceous"),
    "lower Devonian": ("Devonian", "Devonian"),
    "lower Jurassic": ("Jurassic", "Jurassic"),
    "lower Mississippian": ("Carboniferous", "Carboniferous"),
    "lower Ordovician": ("Ordovician", "Ordovician"),
    "lower Silurian": ("Silurian", "Silurian"),
    "lower-middle Devonian": ("Devonian", "Devonian"),
    "lower-middle Jurassic": ("Jurassic", "Jurassic"),
    "middle Cretaceous": ("Cretaceous", "Cretaceous"),
    "middle Devonian": ("Devonian", "Devonian"),
    "middle Jurassic": ("Jurassic", "Jurassic"),
    "middle Mesoproterozoic": ("Mesoproterozoic", "Mesoproterozoic"),
    "middle Ordovician": ("Ordovician", "Ordovician"),
    "middle Paleoproterozoic": ("Paleoproterozoic", "Paleoproterozoic"),
    "middle-late Jurassic": ("Jurassic", "Jurassic"),
    "middle-late Mesoproterozoic": ("Mesoproterozoic", "Mesoproterozoic"),
    "middle-late Paleoproterozoic": ("Paleoproterozoic", "Paleoproterozoic"),
    "middle-upper Devonian": ("Devonian", "Devonian"),
    "middle-upper Jurassic": ("Jurassic", "Jurassic"),
    "pre-Campanian": ("Cretaceous", "Cretaceous"),
    "undivided Archean": ("Archean", "Archean"),
    "undivided Archean-Proterozoic": ("Archean", "Neoproterozoic"),
    "undivided Cambrian": ("Cambrian", "Cambrian"),
    "undivided Cambrian-Devonian": ("Cambrian", "Devonian"),
    "undivided Cambrian-Ordovician": ("Cambrian", "Ordovician"),
    "undivided Cambrian-Silurian": ("Cambrian", "Silurian"),
    "undivided Carboniferous": ("Carboniferous", "Carboniferous"),
    "undivided Carboniferous-Permian": ("Carboniferous", "Permian"),
    "undivided Cenozoic": ("Paleogene", "Quaternary"),
    "undivided Cretaceous": ("Cretaceous", "Cretaceous"),
    "undivided Cretaceous-Tertiary": ("Cretaceous", "Neogene"),
    "undivided Devonian": ("Devonian", "Devonian"),
    "undivided Devonian-Carboniferous": ("Devonian", "Carboniferous"),
    "undivided Devonian-Cretaceous": ("Devonian", "Cretaceous"),
    "undivided Devonian-Mississippian": ("Devonian", "Carboniferous"),
    "undivided Devonian-Permian": ("Devonian", "Permian"),
    "undivided Devonian-Triassic": ("Devonian", "Triassic"),
    "undivided Jurassic": ("Jurassic", "Jurassic"),
    "undivided Jurassic-Cretaceous": ("Jurassic", "Cretaceous"),
    "undivided Mesoarchean": ("Archean", "Archean"),
    "undivided Mesoarchean-Neoarchean": ("Archean", "Archean"),
    "undivided Mesoproterozoic": ("Mesoproterozoic", "Mesoproterozoic"),
    "undivided Mesoproterozoic-Neoproterozoic": ("Mesoproterozoic", "Neoproterozoic"),
    "undivided Mesozoic": ("Triassic", "Cretaceous"),
    "undivided Mississippian": ("Carboniferous", "Carboniferous"),
    "undivided Mississippian-Jurassic": ("Carboniferous", "Jurassic"),
    "undivided Mississippian-Permian": ("Carboniferous", "Permian"),
    "undivided Mississippian-Triassic": ("Carboniferous", "Triassic"),
    "undivided Neoarchean": ("Archean", "Archean"),
    "undivided Neoarchean-Paleoproterozoic": ("Archean", "Paleoproterozoic"),
    "undivided Neogene-Quaternary": ("Neogene", "Quaternary"),
    "undivided Neoproterozoic": ("Neoproterozoic", "Neoproterozoic"),
    "undivided Neoproterozoic-Cambrian": ("Neoproterozoic", "Cambrian"),
    "undivided Neoproterozoic-Ordovician": ("Neoproterozoic", "Ordovician"),
    "undivided Neoproterozoic-Paleozoic": ("Neoproterozoic", "Permian"),
    "undivided Neoproterozoic-Silurian": ("Neoproterozoic", "Silurian"),
    "undivided Neoproterozoic-Triassic": ("Neoproterozoic", "Triassic"),
    "undivided Ordovician": ("Ordovician", "Ordovician"),
    "undivided Ordovician-Devonian": ("Ordovician", "Devonian"),
    "undivided Ordovician-Silurian": ("Ordovician", "Silurian"),
    "undivided Ordovician-Triassic": ("Ordovician", "Triassic"),
    "undivided Paleoarchean": ("Archean", "Archean"),
    "undivided Paleoarchean-Neoarchean": ("Archean", "Archean"),
    "undivided Paleoproterozoic": ("Paleoproterozoic", "Paleoproterozoic"),
    "undivided Paleoproterozoic-Mesoproterozoic": ("Paleoproterozoic", "Mesoproterozoic"),
    "undivided Paleoproterozoic-early Mesoproterozoic": (
        "Paleoproterozoic",
        "Mesoproterozoic",
    ),
    "undivided Paleozoic": ("Cambrian", "Permian"),
    "undivided Paleozoic-Mesozoic": ("Cambrian", "Cretaceous"),
    "undivided Pennsylvanian": ("Carboniferous", "Carboniferous"),
    "undivided Pennsylvanian-Permian": ("Carboniferous", "Permian"),
    "undivided Permian": ("Permian", "Permian"),
    "undivided Permian-Cretaceous": ("Permian", "Cretaceous"),
    "undivided Permian-Jurassic": ("Permian", "Jurassic"),
    "undivided Permian-Triassic": ("Permian", "Triassic"),
    "undivided Precambrian": ("Archean", "Neoproterozoic"),
    "undivided Quaternary": ("Quaternary", "Quaternary"),
    "undivided Silurian": ("Silurian", "Silurian"),
    "undivided Silurian-Devonian": ("Silurian", "Devonian"),
    "undivided Tertiary": ("Paleogene", "Neogene"),
    "undivided Triassic": ("Triassic", "Triassic"),
    "undivided Triassic-Jurassic": ("Triassic", "Triassic"),
    "upper Cambrian": ("Cambrian", "Cambrian"),
    "upper Carboniferous-Jurassic": ("Carboniferous", "Jurassic"),
    "upper Cretaceous": ("Cretaceous", "Cretaceous"),
    "upper Devonian": ("Devonian", "Devonian"),
    "upper Jurassic": ("Jurassic", "Jurassic"),
    "upper Mississippian": ("Carboniferous", "Carboniferous"),
    "upper Ordovician": ("Ordovician", "Ordovician"),
    "upper Silurian": ("Silurian", "Silurian"),
}


def canada_age_batch(records: list[tuple[str, str, str]]) -> list[int | None]:
    """Return the age class of each (era, period, epoch) record, None where it has no age.

    A blank or unknown period falls back to the era, and a blank or unknown epoch never narrows
    the range. Any other name missing from the tables fails the whole call and lists every such
    name, so a new spelling can never slip into the base map silently.
    """
    unmapped = {
        name
        for era, period, epoch in records
        for name, table in (
            (era, CANADA_ERA_NAMES),
            (period, CANADA_PERIOD_NAMES),
            (epoch, CANADA_EPOCH_NAMES),
        )
        if name not in NO_DATA_NAMES and name not in table
    }
    _fail_unmapped("Canada age names", unmapped)
    return [_canada_age_value(era, period, epoch) for era, period, epoch in records]


def _canada_age_value(era: str, period: str, epoch: str) -> int | None:
    span = CANADA_PERIOD_NAMES.get(period)
    if span is None:
        span = CANADA_ERA_NAMES.get(era)
    if span is None:
        return None
    narrow = CANADA_EPOCH_NAMES.get(epoch)
    if narrow is not None:
        outer = _timeline_span(*span)
        inner = _timeline_span(*narrow)
        oldest = max(outer[0], inner[0], key=TIMELINE.index)
        newest = min(outer[1], inner[1], key=TIMELINE.index)
        if TIMELINE.index(oldest) <= TIMELINE.index(newest):
            span = (oldest, newest)
    return smallest_containing_class(*_timeline_span(*span))


# Rock types map to the undivided variant of their GLiM family, keyed by SUBRXTP with an
# RXTP fallback for units whose subtype is blank. A missing entry means the base map fills in.
CANADA_TYPE_NAMES: dict[str, str | None] = {
    "alkaline gabbro and syenite": "pb",
    "alkaline intrusive rocks": "pi",
    "alkaline volcanic rocks": "vb",
    "anorthosite": "pb",
    "bimodal alkaline volcanic rocks": "vi",
    "bimodal volcanic rocks": "vi",
    "carbonate": "sc",
    "charnockite": "pa",
    "coarse clastic sediments and alkaline volcanic rocks": "sm",
    "conglomerate and sandstone": "ss",
    "evaporite": "ev",
    "felsic and mafic intrusive rocks": "pa",
    "felsic volcanic rocks": "va",
    "felsic-intermediate volcanic rocks": "vi",
    "felsite": "pa",
    "gabbro-anorthosite": "pb",
    "granodiorite, quartz diorite": "pi",
    "intermediate volcanic rocks": "vi",
    "mafic and ultramafic intrusive rocks": "pb",
    "mafic gneiss": "mt",
    "mafic intrusive rocks-diorite, gabbro": "pb",
    "mafic volcanic rocks": "vb",
    "marble": "mt",
    "medium-grade gneiss": "mt",
    "melange": "mt",
    "nonmarine sedimentary rocks": "ss",
    "oceanic mafic volcanic rocks": "vb",
    "offshelf miogeoclinal rocks": "sm",
    "orthogneiss": "mt",
    "paragneiss": "mt",
    "paragneiss-orthogneiss": "mt",
    "quartz monzonite, granite": "pa",
    "rapakivi granite": "pa",
    "sedimentary and mafic volcanic rocks": "sm",
    "sedimentary and volcanic gneiss": "mt",
    "syenite, monzodiorite": "pi",
    "syenitic gneiss": "mt",
    "tonalite": "pa",
    "two mica granite, diatexite": "pa",
    "ultramafic intrusive rocks": "pb",
    "ultramafic melange": "mt",
    "undivided gneiss": "mt",
    "undivided granitoid rocks": "pa",
    "undivided sedimentary and volcanic rocks": "sm",
    "undivided sedimentary rocks": "sm",
    "undivided volcanic rocks": "py",
    "volcanic gneiss": "mt",
}

CANADA_RXTP_FALLBACK: dict[str, str | None] = {
    "intrusive rocks": None,
    "metamorphic rocks": "mt",
    "sedimentary and volcanic rocks": "sm",
    "sedimentary rocks": "sm",
    "volcanic rocks": "py",
}


def canada_type_batch(records: list[tuple[str, str]]) -> list[int | None]:
    """Return the rock-type class of each (rxtp, subrxtp) record, None where the base fills in.

    Any subtype or rock type missing from the tables fails the whole call and lists every such
    name, except blank and unknown names which fall back or mean no data.
    """
    unmapped = {
        name
        for rxtp, subrxtp in records
        for name, table in ((rxtp, CANADA_RXTP_FALLBACK), (subrxtp, CANADA_TYPE_NAMES))
        if name not in NO_DATA_NAMES and name not in table
    }
    _fail_unmapped("Canada rock names", unmapped)
    values = []
    for rxtp, subrxtp in records:
        family = CANADA_TYPE_NAMES.get(subrxtp)
        if family is None and subrxtp in NO_DATA_NAMES:
            family = CANADA_RXTP_FALLBACK.get(rxtp)
        values.append(family_value(family) if family else None)
    return values


# Each side of an IGME5000 AgeName range (names around " - ") maps to one TIMELINE unit. The
# Proterozoic I-III scheme is the older Harland-era split into Paleo, Meso and Neoproterozoic.
# Orogeny names are judgements from their mapped Ma ranges: Alpine units span Triassic to
# Quaternary, Cadomian ones are Neoproterozoic to earliest Cambrian, Caledonian ones are
# Ordovician to Devonian by convention, and Variscan ones are Devonian to Permian.
IGME_AGE_SIDES: dict[str, tuple[str, str] | None] = {
    "Alpine": ("Cretaceous", "Quaternary"),
    "Archean": ("Archean", "Archean"),
    "Cadomian": ("Neoproterozoic", "Cambrian"),
    "Caledonian": ("Ordovician", "Devonian"),
    "Cambrian": ("Cambrian", "Cambrian"),
    "Carboniferous": ("Carboniferous", "Carboniferous"),
    "Cenozoic": ("Paleogene", "Quaternary"),
    "Cretaceous": ("Cretaceous", "Cretaceous"),
    "Devonian": ("Devonian", "Devonian"),
    "Early Cambrian": ("Cambrian", "Cambrian"),
    "Early Carboniferous": ("Carboniferous", "Carboniferous"),
    "Early Cretaceous": ("Cretaceous", "Cretaceous"),
    "Early Devonian": ("Devonian", "Devonian"),
    "Early Jurassic": ("Jurassic", "Jurassic"),
    "Early Ordovician": ("Ordovician", "Ordovician"),
    "Early Silurian": ("Silurian", "Silurian"),
    "Early Triassic": ("Triassic", "Triassic"),
    "Eocene": ("Paleogene", "Paleogene"),
    "Holocene": ("Quaternary", "Quaternary"),
    "Jurassic": ("Jurassic", "Jurassic"),
    "Late Cambrian": ("Cambrian", "Cambrian"),
    "Late Carboniferous": ("Carboniferous", "Carboniferous"),
    "Late Cretaceous": ("Cretaceous", "Cretaceous"),
    "Late Devonian": ("Devonian", "Devonian"),
    "Late Jurassic": ("Jurassic", "Jurassic"),
    "Late Ordovician": ("Ordovician", "Ordovician"),
    "Late Permian": ("Permian", "Permian"),
    "Late Silurian": ("Silurian", "Silurian"),
    "Late Triassic": ("Triassic", "Triassic"),
    "Llandovery": ("Silurian", "Silurian"),
    "Mesozoic": ("Triassic", "Cretaceous"),
    "Middle Cambrian": ("Cambrian", "Cambrian"),
    "Middle Devonian": ("Devonian", "Devonian"),
    "Middle Jurassic": ("Jurassic", "Jurassic"),
    "Middle Ordovician": ("Ordovician", "Ordovician"),
    "Middle Permian": ("Permian", "Permian"),
    "Middle Triassic": ("Triassic", "Triassic"),
    "Miocene": ("Neogene", "Neogene"),
    "Neogene": ("Neogene", "Neogene"),
    "Oligocene": ("Paleogene", "Paleogene"),
    "Ordovician": ("Ordovician", "Ordovician"),
    "Palaeocene": ("Paleogene", "Paleogene"),
    "Palaeogene": ("Paleogene", "Paleogene"),
    "Palaeozoic": ("Cambrian", "Permian"),
    "Paleocene": ("Paleogene", "Paleogene"),
    "Permian": ("Permian", "Permian"),
    "Phanerozoic": ("Cambrian", "Quaternary"),
    "Pleistocene": ("Quaternary", "Quaternary"),
    "Pliocene": ("Neogene", "Neogene"),
    "Precambrian": ("Archean", "Neoproterozoic"),
    "Proterozoic": ("Paleoproterozoic", "Neoproterozoic"),
    "Proterozoic I": ("Paleoproterozoic", "Paleoproterozoic"),
    "Proterozoic II": ("Mesoproterozoic", "Mesoproterozoic"),
    "Proterozoic III": ("Neoproterozoic", "Neoproterozoic"),
    "Quaternary": ("Quaternary", "Quaternary"),
    "Silurian": ("Silurian", "Silurian"),
    "Triassic": ("Triassic", "Triassic"),
    "Variscan": ("Devonian", "Permian"),
    "Wenlock": ("Silurian", "Silurian"),
}


def igme_age_batch(names: list[str]) -> list[int | None]:
    """Return the age class of each IGME5000 AgeName, None where it has no age.

    A range runs from the older reach of one side to the newer reach of the other, whatever
    order they come in. "Early - Middle X" style ranges collapse to X itself, since a bare
    Early or Middle carries no period on its own. Any other name missing from the side table
    fails the whole call and lists every such name.
    """
    sides = {side for agename in names for side in _split_igme_range(agename)}
    _fail_unmapped("IGME5000 age names", {side for side in sides if side not in IGME_AGE_SIDES})
    return [_igme_age_value(agename) for agename in names]


def _split_igme_range(agename: str) -> list[str]:
    """Return the one or two side names of an AgeName range."""
    return [side.strip() for side in agename.split(" - ")]


def _igme_age_value(agename: str) -> int | None:
    if agename in NO_DATA_NAMES:
        return None
    sides = _split_igme_range(agename)
    if len(sides) == 2 and all(side.split()[0] in ("Early", "Middle", "Late") for side in sides):
        first_words = sides[0].split()
        if len(first_words) == 1 and len(sides[1].split()) == 2:
            sides = [sides[1].split()[1]]
    if any(side in NO_DATA_NAMES for side in sides):
        return None
    reaches = [IGME_AGE_SIDES[side] for side in sides if side in IGME_AGE_SIDES]
    if not reaches:
        return None
    oldest = min((reach[0] for reach in reaches), key=TIMELINE.index)
    newest = max((reach[1] for reach in reaches), key=TIMELINE.index)
    return smallest_containing_class(*_timeline_span(oldest, newest))


# Main petrography (Portr_Petr) maps to GLiM families; meta-prefixed rocks all count as
# metamorphic. A missing entry leaves the cell to the base map, as do the fallbacks for the
# few hundred units whose main petrography is blank (volcanites count as basic like the
# Precambrian greenstones that dominate them, plutonites as acid granitoids).
IGME_TYPE_NAMES: dict[str, str | None] = {
    "Ice": "ig",
    "alkali basalt": "vb",
    "alkali granite": "pa",
    "alkali rhyolite": "va",
    "alkali syenite": "pi",
    "amphibolite": "mt",
    "andesite": "vi",
    "andesite agglomerate": "vi",
    "andesite group": "vi",
    "andesite tuffite": "py",
    "basalt": "vb",
    "basalt group": "vb",
    "blueschist": "mt",
    "carbonates": "sc",
    "carbonates, consolidated": "sc",
    "chalk": "sc",
    "chert": "ss",
    "clay": "ss",
    "claystone": "ss",
    "coal": "sm",
    "conglomerate": "ss",
    "dacite": "va",
    "diorite": "pi",
    "dolerite": "vb",
    "dolomite/dolostone": "sc",
    "dunite, harzburgite, lherzolite": "pb",
    "eclogite": "mt",
    "essexite-theralite group": "pi",
    "evaporites": "ev",
    "gabbro": "pb",
    "gabbro group": "pb",
    "gneiss": "mt",
    "granite": "pa",
    "granite group": "pa",
    "granodiorite": "pa",
    "granodiorite-diorite group": "pi",
    "granulite": "mt",
    "gravel": "ss",
    "greenschist": "mt",
    "gypsum": "ev",
    "lamprophyre": "vb",
    "latite": "vi",
    "limestone": "sc",
    "marble": "mt",
    "marl": "sm",
    "marlstone": "sm",
    "meta-andesite": "mt",
    "meta-basalt": "mt",
    "meta-basalt group": "mt",
    "meta-carbonate": "mt",
    "meta-claystone": "mt",
    "meta-gabbro": "mt",
    "meta-gabbro group": "mt",
    "meta-granite": "mt",
    "meta-granite group": "mt",
    "meta-granodiorite": "mt",
    "meta-limestone": "mt",
    "meta-peridotite": "mt",
    "meta-plutonic rock group": "mt",
    "meta-rhyodacite": "mt",
    "meta-rhyolite": "mt",
    "meta-rhyolite group": "mt",
    "meta-sandstone": "mt",
    "meta-sediment group": "mt",
    "meta-volcanic rock group": "mt",
    "mica schist": "mt",
    "migmatite/anatexite": "mt",
    "miscellaneous metamorphic rock group": "mt",
    "mud": "ss",
    "mudstone": "ss",
    "peridotite": "pb",
    "phonolite": "va",
    "phyllite": "mt",
    "plutonic alkaline group": "pi",
    "plutonic ultramafic group": "pb",
    "quartzite": "mt",
    "rhyodacite": "va",
    "rhyolite": "va",
    "rhyolite group": "va",
    "rock salt": "ev",
    "sand": "ss",
    "sandstone": "ss",
    "schist group": "mt",
    "serpentinite": "mt",
    "shale/slate": "ss",
    "siliclastics, consolidated": "ss",
    "silt": "ss",
    "siltstone": "ss",
    "syenite": "pi",
    "syenite-monzonite group": "pi",
    "tephrite, basanite": "vb",
    "theralite": "pi",
    "tholeiitic basalt": "vb",
    "tillite": "sm",
    "tonalite": "pa",
    "trachyte": "va",
    "tuff group": "py",
    "tuffite group": "py",
    "volcanic alkaline group": "vb",
    "volcanic ultramafic group": "vb",
    "volcano-sediments": "sm",
}

IGME_IGNE_FALLBACK: dict[str, str | None] = {
    "ophiolite complex": "vb",
    "plutonite Cenozoic": "pa",
    "plutonite Mesozoic": "pa",
    "plutonite Palaeozoic": "pa",
    "plutonite Precambrian": "pa",
    "plutonite undifferentiated": "pa",
    "volcanite Cenozoic": "vb",
    "volcanite Mesozoic": "vb",
    "volcanite Palaeozoic": "vb",
    "volcanite Precambrian": "vb",
    "volcanite Quaternary": "vb",
    "volcanite undifferentiated": "vb",
}

IGME_MARI_FALLBACK: dict[str, str | None] = {
    "break-up related basalt flows": "vb",
    "ocean-continent transition of various ages": "sm",
    "oceanic crust, older": "vb",
    "oceanic crust, younger": "vb",
    "rifted thinned continental crust of various ages": "sm",
}


def igme_type_batch(records: list[tuple[str | None, str | None, str | None]]) -> list[int | None]:
    """Return the rock-type class of each (petr, igne, mari) record, None for the base map.

    The main petrography wins; blank units fall back to the igneous then marine fields, and
    ice ("Ice" in the IceO field, passed as petr) counts as ice. Ice and blank names never
    fail, while any other name missing from the tables fails the whole call with every one.
    """
    unmapped = {
        name
        for petr, igne, mari in records
        for name, table in (
            (petr, IGME_TYPE_NAMES),
            (igne, IGME_IGNE_FALLBACK),
            (mari, IGME_MARI_FALLBACK),
        )
        if name and name not in NO_DATA_NAMES and name not in table
    }
    _fail_unmapped("IGME5000 rock names", unmapped)
    values = []
    for petr, igne, mari in records:
        family = IGME_TYPE_NAMES.get(petr or "")
        if family is None and (not petr or petr in NO_DATA_NAMES):
            family = IGME_IGNE_FALLBACK.get(igne or "")
        if family is None and (not igne or igne in NO_DATA_NAMES):
            family = IGME_MARI_FALLBACK.get(mari or "")
        values.append(family_value(family) if family else None)
    return values


# SGMC age leaves (the last name of an AGE_MIN or AGE_MAX path) map to TIMELINE spans. Ages
# come from names and never from Ma, because the state maps use older time scales. Note that
# in the tables MIN names the younger bound (smaller Ma) and MAX the older one.
SGMC_BASE_NAMES: dict[str, tuple[str, str] | None] = {
    "Archean": ("Archean", "Archean"),
    "Cambrian": ("Cambrian", "Cambrian"),
    "Carboniferous": ("Carboniferous", "Carboniferous"),
    "Cenozoic": ("Paleogene", "Quaternary"),
    "Cretaceous": ("Cretaceous", "Cretaceous"),
    "Devonian": ("Devonian", "Devonian"),
    "Eocene": ("Paleogene", "Paleogene"),
    "Holocene": ("Quaternary", "Quaternary"),
    "Jurassic": ("Jurassic", "Jurassic"),
    "Mesoarchean": ("Archean", "Archean"),
    "Mesoproterozoic": ("Mesoproterozoic", "Mesoproterozoic"),
    "Mesozoic": ("Triassic", "Cretaceous"),
    "Miocene": ("Neogene", "Neogene"),
    "Mississippian": ("Carboniferous", "Carboniferous"),
    "Neoarchean": ("Archean", "Archean"),
    "Neogene": ("Neogene", "Neogene"),
    "Neoproterozoic": ("Neoproterozoic", "Neoproterozoic"),
    "Oligocene": ("Paleogene", "Paleogene"),
    "Ordovician": ("Ordovician", "Ordovician"),
    "Paleoarchean": ("Archean", "Archean"),
    "Paleocene": ("Paleogene", "Paleogene"),
    "Paleogene": ("Paleogene", "Paleogene"),
    "Paleoproterozoic": ("Paleoproterozoic", "Paleoproterozoic"),
    "Paleozoic": ("Cambrian", "Permian"),
    "Pennsylvanian": ("Carboniferous", "Carboniferous"),
    "Permian": ("Permian", "Permian"),
    "Phanerozoic": ("Cambrian", "Quaternary"),
    "Pleistocene": ("Quaternary", "Quaternary"),
    "Pliocene": ("Neogene", "Neogene"),
    "Proterozoic": ("Paleoproterozoic", "Neoproterozoic"),
    "Quaternary": ("Quaternary", "Quaternary"),
    "Silurian": ("Silurian", "Silurian"),
    "Tertiary": ("Paleogene", "Neogene"),
    "Tertiary-Neogene": ("Neogene", "Neogene"),
    "Tertiary-Paleogene": ("Paleogene", "Paleogene"),
    "Triassic": ("Triassic", "Triassic"),
    "preCambrian": ("Archean", "Neoproterozoic"),
    "preCambrian-Archean": ("Archean", "Archean"),
    "preCambrian-Proterozoic": ("Archean", "Neoproterozoic"),
}

# ICS stages to their periods; an Early, Middle or Late prefix narrows nothing because the
# class is the whole period anyway.
SGMC_STAGE_PERIODS: dict[str, str] = {
    "Aeronian": "Silurian",
    "Albian": "Cretaceous",
    "Anisian": "Triassic",
    "Aptian": "Cretaceous",
    "Aquitanian": "Neogene",
    "Artinskian": "Permian",
    "Asselian": "Permian",
    "Bajocian": "Jurassic",
    "Barremian": "Cretaceous",
    "Bartonian": "Paleogene",
    "Bashkirian": "Carboniferous",
    "Bathonian": "Jurassic",
    "Berriasian": "Cretaceous",
    "Burdigalian": "Neogene",
    "Calabrian": "Quaternary",
    "Callovian": "Jurassic",
    "Calymmian": "Mesoproterozoic",
    "Campanian": "Cretaceous",
    "Capitanian": "Permian",
    "Carnian": "Triassic",
    "Cenomanian": "Cretaceous",
    "Changhsingian": "Permian",
    "Chattian": "Paleogene",
    "Cisuralian": "Permian",
    "Coniacian": "Cretaceous",
    "Cryogenian": "Neoproterozoic",
    "Danian": "Paleogene",
    "Dapingian": "Ordovician",
    "Darriwillian": "Ordovician",
    "Ectasian": "Mesoproterozoic",
    "Ediacaran": "Neoproterozoic",
    "Eifelian": "Devonian",
    "Emsian": "Devonian",
    "Famennian": "Devonian",
    "Floian": "Ordovician",
    "Frasnian": "Devonian",
    "Furongian": "Cambrian",
    "Gelasian": "Quaternary",
    "Givetian": "Devonian",
    "Guadalupian": "Permian",
    "Gzhelian": "Carboniferous",
    "Hauterivian": "Cretaceous",
    "Hettangian": "Jurassic",
    "Hirnantian": "Ordovician",
    "Homerian": "Silurian",
    "Kasimovian": "Carboniferous",
    "Katian": "Ordovician",
    "Kimmeridgian": "Jurassic",
    "Kungurian": "Permian",
    "Ladinian": "Triassic",
    "Langhian": "Neogene",
    "Llandovery": "Silurian",
    "Lockhovian": "Devonian",
    "Lopingian": "Permian",
    "Ludlow": "Silurian",
    "Lutetian": "Paleogene",
    "Maastrichtian": "Cretaceous",
    "Messinian": "Neogene",
    "Moscovian": "Carboniferous",
    "Norian": "Triassic",
    "Olenikian": "Triassic",
    "Orosirian": "Paleoproterozoic",
    "Oxfordian": "Jurassic",
    "Piacenzian": "Neogene",
    "Pliensbachian": "Jurassic",
    "Pragian": "Devonian",
    "Priabonian": "Paleogene",
    "Pridoli": "Silurian",
    "Rhaetian": "Triassic",
    "Rhuddanian": "Silurian",
    "Roadian": "Permian",
    "Rupelian": "Paleogene",
    "Sakmarian": "Permian",
    "Sandbian": "Ordovician",
    "Santonian": "Cretaceous",
    "Selandian": "Paleogene",
    "Serpukhovian": "Carboniferous",
    "Serravallian": "Neogene",
    "Sheinwoodian": "Silurian",
    "Siderian": "Paleoproterozoic",
    "Sinemurian": "Jurassic",
    "Statherian": "Paleoproterozoic",
    "Stenian": "Mesoproterozoic",
    "Telychian": "Silurian",
    "Thanetian": "Paleogene",
    "Tithonian": "Jurassic",
    "Toarcian": "Jurassic",
    "Tonian": "Neoproterozoic",
    "Tortonian": "Neogene",
    "Tournaisian": "Carboniferous",
    "Tremadocian": "Ordovician",
    "Turonian": "Cretaceous",
    "Visean": "Carboniferous",
    "Wenlock": "Silurian",
    "Wordian": "Permian",
    "Wuchiapingian": "Permian",
    "Ypresian": "Paleogene",
    "Zanclean": "Neogene",
}


def sgmc_age_batch(records: list[tuple[str, str]]) -> list[int | None]:
    """Return the age class of each (age_min, age_max) path pair, None where neither names one.

    AGE_MIN names the younger bound and AGE_MAX the older one; each contributes its leaf name
    and an empty bound collapses the range onto the other side. A leaf missing from the tables
    fails the whole call and lists every such leaf.
    """
    leaves = {
        _sgmc_leaf(path) for age_min, age_max in records for path in (age_min, age_max)
    } - {"", "Undetermined"}
    unmapped = {leaf for leaf in leaves if _sgmc_base(leaf) is None}
    _fail_unmapped("SGMC age names", unmapped)
    return [_sgmc_age_value(age_min, age_max) for age_min, age_max in records]


def _sgmc_leaf(path: str) -> str:
    """Return the most specific name of an SGMC age path."""
    return path.split(" - ")[-1].strip()


def _sgmc_base(leaf: str) -> tuple[str, str] | None:
    """Return the TIMELINE span of an SGMC leaf name, None for undetermined ones."""
    if leaf in ("", "Undetermined"):
        return None
    if leaf in SGMC_BASE_NAMES:
        return SGMC_BASE_NAMES[leaf]
    base = leaf
    for prefix in ("Early-", "Middle-", "Late-"):
        if base.startswith(prefix):
            base = base.removeprefix(prefix)
    if base in SGMC_BASE_NAMES:
        return SGMC_BASE_NAMES[base]
    period = SGMC_STAGE_PERIODS.get(base)
    return SGMC_BASE_NAMES[period] if period else None


def _sgmc_age_value(age_min: str, age_max: str) -> int | None:
    young = _sgmc_base(_sgmc_leaf(age_min))
    old = _sgmc_base(_sgmc_leaf(age_max))
    if young is None and old is None:
        return None
    oldest = (old or young)[0]
    newest = (young or old)[1]
    return smallest_containing_class(*_timeline_span(oldest, newest))


# SGMC lithology walks the LITH1 to LITH5 hierarchy of the first Major row of each unit.
# Families are judged by composition: felsic plutonic and volcanic rocks count as acid,
# intermediate ones (diorite, syenite, andesite, trachyte) as intermediate, and mafic ones
# (basalt, gabbro, ultramafic) as basic. Anything the rules below do not reach falls back to
# its LITH1 default, and an unknown LITH1 fails loudly.
SGMC_ACID_KEYWORDS = (
    "granite",
    "granitic",
    "rhyolit",
    "felsic",
    "aplite",
    "alaskite",
    "tonalite",
    "trondhjemite",
    "dacite",
    "trachyte",
    "phonolite",
    "quartz",
)
SGMC_INTERMEDIATE_KEYWORDS = (
    "andesite",
    "diorit",
    "syenite",
    "monzonite",
    "trachy",
    "latite",
    "hypabyssal",
)
SGMC_BASIC_KEYWORDS = (
    "basalt",
    "gabbro",
    "mafic",
    "ultramafic",
    "dunite",
    "peridotite",
    "pyroxenite",
    "norite",
    "troctolite",
    "anorthosite",
    "diabase",
    "dolerite",
    "kimberlite",
    "hornblendite",
)
SGMC_CARBONATE_KEYWORDS = (
    "carbonate",
    "limestone",
    "dolostone",
    "dolomite",
    "chalk",
    "marble",
    "calcarenite",
    "coquina",
    "coral",
)
SGMC_CLASTIC_KEYWORDS = (
    "sandstone",
    "siltstone",
    "shale",
    "claystone",
    "mudstone",
    "argillite",
    "arkose",
    "arenite",
    "graywacke",
    "metagraywacke",
    "conglomerate",
    "breccia",
    "boulders",
    "gravel",
    "till",
)
SGMC_LITH1_DEFAULTS: dict[str, str] = {
    "Ice": "ig",
    "Igneous": "vi",
    "Metamorphic": "mt",
    "Sedimentary": "sm",
    "Tectonite": "mt",
    "Unconsolidated": "su",
}


def sgmc_family(lith1: str, lith2: str, lith3: str, lith4: str, lith5: str) -> str:
    """Return the GLiM family of an SGMC LITH1 to LITH5 hierarchy, failing on unknown LITH1."""
    if lith1 not in SGMC_LITH1_DEFAULTS:
        raise ValueError(f"SGMC lithology without a class: {[lith1]}")
    if lith1 == "Ice":
        return "ig"
    if lith1 == "Unconsolidated":
        return "su"
    if lith1 == "Tectonite":
        return "mt"
    names = " ".join((lith2, lith3, lith4, lith5)).lower()
    if lith1 == "Sedimentary":
        if "evaporite" in names or "gypsum" in names or "anhydrite" in names or "salt" in names:
            return "ev"
        if any(word in names for word in SGMC_CARBONATE_KEYWORDS):
            if "marl" in names or "mixed" in names or "turbidite" in names or "flysch" in names:
                return "sm"
            return "sc"
        if "coal" in names or "peat" in names or "organic" in names:
            return "sm"
        if any(word in names for word in SGMC_CLASTIC_KEYWORDS):
            return "ss"
        return "sm"
    if lith1 == "Metamorphic":
        return "mt"
    lowered = names
    if any(word in lowered for word in SGMC_BASIC_KEYWORDS):
        return "vb" if "volcanic" in lith2.lower() else "pb"
    if any(word in lowered for word in SGMC_INTERMEDIATE_KEYWORDS):
        return "vi" if "volcanic" in lith2.lower() else "pi"
    if any(word in lowered for word in SGMC_ACID_KEYWORDS):
        return "va" if "volcanic" in lith2.lower() else "pa"
    if "pyroclastic" in lowered or "tuff" in lowered or "ash" in lowered:
        return "py"
    return SGMC_LITH1_DEFAULTS[lith1]


def sgmc_type_batch(records: list[tuple[str, str, str, str, str]]) -> list[int | None]:
    """Return the rock-type class of each SGMC hierarchy, failing loudly on unknown LITH1."""
    unmapped = {lith1 for lith1, *_ in records if lith1 not in SGMC_LITH1_DEFAULTS}
    _fail_unmapped("SGMC lithology", unmapped)
    return [family_value(sgmc_family(*record)) for record in records]


# INSPIRE lithology values of the EGDI raster to GLiM families, filled from the raster legend.
# The legend maps integer cells to INSPIRE URIs, so this table is keyed by cell value.
EGDI_TYPE_NAMES: dict[int, str] = {}


def egdi_type_batch(values: list[int]) -> list[int | None]:
    """Return the rock-type class of each EGDI raster value, None for no data (0).

    A value missing from the legend table fails the whole call and lists every such value.
    """
    unmapped = {value for value in values if value != 0 and value not in EGDI_TYPE_NAMES}
    _fail_unmapped("EGDI lithology values", {str(value) for value in unmapped})
    return [family_value(EGDI_TYPE_NAMES[value]) if value != 0 else None for value in values]


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
    order.     Regional COGs missing on disk are skipped silently, while an unreadable one still
    fails. Codes are 0 where no map has a value, 1 for the base and one per regional source.
    """
    base, transform = backend.lithology(bounds, res, on_block or (lambda: None), base_file)  # type: ignore[union-attr]
    overlays = []
    for source in candidates_for(kind, bounds, backend.has_lithology):  # type: ignore[union-attr]
        key = "age_file" if kind == "age" else "type_file"
        regional, _ = backend.lithology(bounds, res, lambda: None, source[key])  # type: ignore[union-attr]
        overlays.append((SOURCE_CODES[source["id"]], regional))
    value, codes = composite_values(base, overlays)
    return value, codes, transform
