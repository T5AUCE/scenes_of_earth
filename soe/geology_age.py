"""Name the rock-age classes of the Geology age layer and classify age ranges into them.

A unit's class is the smallest ICS unit that contains its whole age range: a period when the
range lies in one, else its era marked undivided, else an eon or "several eras" class. Ranges
come from age names and never from Ma, because the source maps use older time scales than the
ICS one (GSC puts the Cambrian at 570-510 Ma, which would land in the Ediacaran today). Each
source maps its own age names to the periods below, so later sources share these classes.
Some historical names span eras, so their entries name both reaches. Colours follow the ICS
chart via Macrostrat (CC BY 4.0); undivided classes take their era colour.
"""
from collections.abc import Iterable

GEOLOGY_AGE_FILE = "geology_age.tif"  # in the cubes folder
GEOLOGY_AGE_RES_DEG = 1 / 120
GSC_SOURCE = "gsc-of5529"  # the COG tag value of the world map

# Oldest to newest, so index order is age order.
TIMELINE = [
    "Archean",
    "Paleoproterozoic",
    "Mesoproterozoic",
    "Neoproterozoic",
    "Cambrian",
    "Ordovician",
    "Silurian",
    "Devonian",
    "Carboniferous",
    "Permian",
    "Triassic",
    "Jurassic",
    "Cretaceous",
    "Paleogene",
    "Neogene",
    "Quaternary",
]

# Legend order fixes class values, so only append to it.
_AGE_UNITS = [
    {"label": "Quaternary", "color": "#f9f97f", "group": "Cenozoic"},
    {"label": "Neogene", "color": "#ffe619", "group": "Cenozoic"},
    {"label": "Paleogene", "color": "#fd9a52", "group": "Cenozoic"},
    {"label": "Cenozoic undivided", "color": "#f2f91d", "group": "Cenozoic"},
    {"label": "Cretaceous", "color": "#7fc64e", "group": "Mesozoic"},
    {"label": "Jurassic", "color": "#34b2c9", "group": "Mesozoic"},
    {"label": "Triassic", "color": "#812b92", "group": "Mesozoic"},
    {"label": "Mesozoic undivided", "color": "#67c5ca", "group": "Mesozoic"},
    {"label": "Permian", "color": "#f04028", "group": "Paleozoic"},
    {"label": "Carboniferous", "color": "#67a599", "group": "Paleozoic"},
    {"label": "Devonian", "color": "#cb8c37", "group": "Paleozoic"},
    {"label": "Silurian", "color": "#b3e1b6", "group": "Paleozoic"},
    {"label": "Ordovician", "color": "#009270", "group": "Paleozoic"},
    {"label": "Cambrian", "color": "#7fa056", "group": "Paleozoic"},
    {"label": "Paleozoic undivided", "color": "#99c08d", "group": "Paleozoic"},
    {"label": "Neoproterozoic", "color": "#ff9bcd", "group": "Precambrian"},
    {"label": "Mesoproterozoic", "color": "#ff7ebf", "group": "Precambrian"},
    {"label": "Paleoproterozoic", "color": "#e665a6", "group": "Precambrian"},
    {"label": "Proterozoic undivided", "color": "#FF70B8", "group": "Precambrian"},
    {"label": "Archean", "color": "#FF3399", "group": "Precambrian"},
    {"label": "Precambrian undivided", "color": "#f04370", "group": "Precambrian"},
    {"label": "Phanerozoic undivided", "color": "#9ad9dd", "group": "Several eras"},
    # Grey stands in for white, which would vanish on the map.
    {"label": "Precambrian to Phanerozoic", "color": "#b8b8b8", "group": "Several eras"},
]
AGE_CLASSES = [{"value": value, **unit} for value, unit in enumerate(_AGE_UNITS, start=1)]
AGE_VALUES = {entry["label"]: entry["value"] for entry in AGE_CLASSES}

# Narrowest first, so the first match is the smallest class.
_UNDIVIDED_SPANS = [
    ("Proterozoic undivided", "Paleoproterozoic", "Neoproterozoic"),
    ("Cenozoic undivided", "Paleogene", "Quaternary"),
    ("Mesozoic undivided", "Triassic", "Cretaceous"),
    ("Paleozoic undivided", "Cambrian", "Permian"),
    ("Precambrian undivided", "Archean", "Neoproterozoic"),
    ("Phanerozoic undivided", "Cambrian", "Quaternary"),
]
SEVERAL_ERAS = "Precambrian to Phanerozoic"

AgeNames = dict[str, tuple[str, str]]  # age name to its oldest and newest TIMELINE unit

GSC_AGE_NAMES: AgeNames = {
    "ARCHEAN": ("Archean", "Archean"),
    "EOARCHEAN": ("Archean", "Archean"),
    "PALEOARCHEAN": ("Archean", "Archean"),
    "MESOARCHEAN": ("Archean", "Archean"),
    "NEOARCHEAN": ("Archean", "Archean"),
    "LATE ARCHEAN": ("Archean", "Archean"),
    "PALEOPROTEROZOIC": ("Paleoproterozoic", "Paleoproterozoic"),
    "EARLY PALEOPROTEROZOIC": ("Paleoproterozoic", "Paleoproterozoic"),
    "MIDDLE PALEOPROTEROZOIC": ("Paleoproterozoic", "Paleoproterozoic"),
    "LATE PALEOPROTEROZOIC": ("Paleoproterozoic", "Paleoproterozoic"),
    "MESOPROTEROZOIC": ("Mesoproterozoic", "Mesoproterozoic"),
    "EARLY MESOPROTEROZOIC": ("Mesoproterozoic", "Mesoproterozoic"),
    "MIDDLE MESOPROTEROZOIC": ("Mesoproterozoic", "Mesoproterozoic"),
    "LATE MESOPROTEROZOIC": ("Mesoproterozoic", "Mesoproterozoic"),
    "NEOPROTEROZOIC": ("Neoproterozoic", "Neoproterozoic"),
    "VENDIAN": ("Neoproterozoic", "Neoproterozoic"),
    "EARLY RIPHEAN": ("Paleoproterozoic", "Mesoproterozoic"),
    "MIDDLE RIPHEAN": ("Mesoproterozoic", "Mesoproterozoic"),
    "LATE RIPHEAN": ("Mesoproterozoic", "Neoproterozoic"),
    "MIDDLE PROTEROZOIC": ("Mesoproterozoic", "Neoproterozoic"),
    "LATE PROTEROZOIC": ("Neoproterozoic", "Neoproterozoic"),
    "PROTEROZOIC": ("Paleoproterozoic", "Neoproterozoic"),
    "PRECAMBRIAN": ("Archean", "Neoproterozoic"),
    "CAMBRIAN": ("Cambrian", "Cambrian"),
    "EARLY CAMBRIAN": ("Cambrian", "Cambrian"),
    "MIDDLE CAMBRIAN": ("Cambrian", "Cambrian"),
    "LATE CAMBRIAN": ("Cambrian", "Cambrian"),
    "ORDOVICIAN": ("Ordovician", "Ordovician"),
    "EARLY ORDOVICIAN": ("Ordovician", "Ordovician"),
    "MIDDLE ORDOVICIAN": ("Ordovician", "Ordovician"),
    "LATE ORDOVICIAN": ("Ordovician", "Ordovician"),
    "SILURIAN": ("Silurian", "Silurian"),
    "EARLY SILURIAN": ("Silurian", "Silurian"),
    "MIDDLE SILURIAN": ("Silurian", "Silurian"),
    "LATE SILURIAN": ("Silurian", "Silurian"),
    "DEVONIAN": ("Devonian", "Devonian"),
    "EARLY DEVONIAN": ("Devonian", "Devonian"),
    "MIDDLE DEVONIAN": ("Devonian", "Devonian"),
    "LATE DEVONIAN": ("Devonian", "Devonian"),
    "CARBONIFEROUS": ("Carboniferous", "Carboniferous"),
    "EARLY CARBONIFEROUS": ("Carboniferous", "Carboniferous"),
    "LATE CARBONIFEROUS": ("Carboniferous", "Carboniferous"),
    "MISSISSIPPIAN": ("Carboniferous", "Carboniferous"),
    "EARLY MISSISSIPPIAN": ("Carboniferous", "Carboniferous"),
    "MIDDLE MISSISSIPPIAN": ("Carboniferous", "Carboniferous"),
    "LATE MISSISSIPPIAN": ("Carboniferous", "Carboniferous"),
    "PENNSYLVANIAN": ("Carboniferous", "Carboniferous"),
    "EARLY PENNSYLVANIAN": ("Carboniferous", "Carboniferous"),
    "MIDDLE PENNSYLVANIAN": ("Carboniferous", "Carboniferous"),
    "LATE PENNSYLVANIAN": ("Carboniferous", "Carboniferous"),
    "PERMIAN": ("Permian", "Permian"),
    "EARLY PERMIAN": ("Permian", "Permian"),
    "LATE PERMIAN": ("Permian", "Permian"),
    "EARLY PALEOZOIC": ("Cambrian", "Silurian"),
    "MIDDLE PALEOZOIC": ("Silurian", "Devonian"),
    "LATE PALEOZOIC": ("Carboniferous", "Permian"),
    "PALEOZOIC": ("Cambrian", "Permian"),
    "TRIASSIC": ("Triassic", "Triassic"),
    "EARLY TRIASSIC": ("Triassic", "Triassic"),
    "MIDDLE TRIASSIC": ("Triassic", "Triassic"),
    "LATE TRIASSIC": ("Triassic", "Triassic"),
    "JURASSIC": ("Jurassic", "Jurassic"),
    "EARLY JURASSIC": ("Jurassic", "Jurassic"),
    "MIDDLE JURASSIC": ("Jurassic", "Jurassic"),
    "MIDDLE JURRASSIC": ("Jurassic", "Jurassic"),  # a typo in the source table
    "LATE JURASSIC": ("Jurassic", "Jurassic"),
    "CRETACEOUS": ("Cretaceous", "Cretaceous"),
    "EARLY CRETACEOUS": ("Cretaceous", "Cretaceous"),
    "LATE CRETACEOUS": ("Cretaceous", "Cretaceous"),
    "HAUTERIVIAN": ("Cretaceous", "Cretaceous"),
    "ALBIAN": ("Cretaceous", "Cretaceous"),
    "CENOMANIAN": ("Cretaceous", "Cretaceous"),
    "TURONIAN": ("Cretaceous", "Cretaceous"),
    "CONIACIAN": ("Cretaceous", "Cretaceous"),
    "SANTONIAN": ("Cretaceous", "Cretaceous"),
    "CAMPANIAN": ("Cretaceous", "Cretaceous"),
    "MAASTRICHTIAN": ("Cretaceous", "Cretaceous"),
    "EARLY MESOZOIC": ("Triassic", "Triassic"),
    "MIDDLE MESOZOIC": ("Jurassic", "Jurassic"),
    "LATE MESOZOIC": ("Cretaceous", "Cretaceous"),
    "MESOZOIC": ("Triassic", "Cretaceous"),
    "DANIAN": ("Paleogene", "Paleogene"),
    "PALEOCENE": ("Paleogene", "Paleogene"),
    "EOCENE": ("Paleogene", "Paleogene"),
    "LATE EOCENE": ("Paleogene", "Paleogene"),
    "OLIGOCENE": ("Paleogene", "Paleogene"),
    "PALEOGENE": ("Paleogene", "Paleogene"),
    "MIOCENE": ("Neogene", "Neogene"),
    "PLIOCENE": ("Neogene", "Neogene"),
    "NEOGENE": ("Neogene", "Neogene"),
    "PLEISTOCENE": ("Quaternary", "Quaternary"),
    "HOLOCENE": ("Quaternary", "Quaternary"),
    "RECENT": ("Quaternary", "Quaternary"),
    "QUATERNARY": ("Quaternary", "Quaternary"),
    "EARLY TERTIARY": ("Paleogene", "Paleogene"),
    "LATE TERTIARY": ("Neogene", "Neogene"),
    "TERTIARY": ("Paleogene", "Neogene"),
    "EARLY CENOZOIC": ("Paleogene", "Paleogene"),
    "MIDDLE CENOZOIC": ("Neogene", "Neogene"),
    "LATE CENOZOIC": ("Quaternary", "Quaternary"),
    "CENOZOIC": ("Paleogene", "Quaternary"),
    "PHANEROZOIC": ("Cambrian", "Quaternary"),
}


def smallest_containing_class(oldest: str, newest: str) -> int:
    """Return the class value of the smallest unit containing oldest to newest, TIMELINE units."""
    first, last = TIMELINE.index(oldest), TIMELINE.index(newest)
    if first == last:
        return AGE_VALUES[oldest]

    for label, span_first, span_last in _UNDIVIDED_SPANS:
        if TIMELINE.index(span_first) <= first and last <= TIMELINE.index(span_last):
            return AGE_VALUES[label]

    return AGE_VALUES[SEVERAL_ERAS]


def classify_age_ranges(
    ranges: Iterable[tuple[str, str]],
    names: AgeNames,
) -> dict[tuple[str, str], int]:
    """Return the class value of each (start name, end name) range, by the age names alone.

    The range runs from the older reach of one name to the newer reach of the other, whichever
    order they come in. A name missing from `names` fails the whole call and lists every such name.
    """
    ranges = set(ranges)
    unmapped = {name for pair in ranges for name in pair if name not in names}
    if unmapped:
        raise ValueError(f"Age names without a class: {sorted(unmapped)}")

    return {pair: _range_class(pair, names) for pair in ranges}


def _range_class(pair: tuple[str, str], names: AgeNames) -> int:
    reaches = [names[name] for name in pair]
    oldest = min((reach[0] for reach in reaches), key=TIMELINE.index)
    newest = max((reach[1] for reach in reaches), key=TIMELINE.index)
    return smallest_containing_class(oldest, newest)
