"""Define shared rock-type identities and class tables in their stable value order."""

LITHOLOGY_FILE = "lithology.tif"  # in the cubes folder
LITHOLOGY_RES_DEG = 1 / 480

OPENLANDMAP_SOURCE = "openlandmap"
GLIM_SOURCE = "glim"
LITHOLOGY_SOURCE_TAG = "LITHOLOGY_SOURCE"  # in the COG; a COG without it came from OpenLandMap

# OpenLandMap values 1 to 15 are the source classes in file-name order with water and undefined
# as no data.
OPENLANDMAP_CLASSES = [
    {"value": 14, "label": "Unconsolidated sediment", "color": "#fdf0a8", "group": "Sediments"},
    {"value": 13, "label": "Siliciclastic sedimentary", "color": "#e8c33c", "group": "Sediments"},
    {"value": 11, "label": "Mixed sedimentary", "color": "#c2ab5a", "group": "Sediments"},
    {"value": 5, "label": "Carbonate sedimentary", "color": "#6fa8d6", "group": "Sediments"},
    {"value": 6, "label": "Evaporite", "color": "#c5a3d6", "group": "Sediments"},
    {"value": 12, "label": "Pyroclastic", "color": "#d9753b", "group": "Volcanic"},
    {"value": 2, "label": "Acid volcanic", "color": "#e57373", "group": "Volcanic"},
    {"value": 9, "label": "Intermediate volcanic", "color": "#c0392b", "group": "Volcanic"},
    {"value": 4, "label": "Basic volcanic", "color": "#6c3483", "group": "Volcanic"},
    {"value": 1, "label": "Acid plutonic", "color": "#f194b4", "group": "Plutonic"},
    {"value": 8, "label": "Intermediate plutonic", "color": "#d65d8a", "group": "Plutonic"},
    {"value": 3, "label": "Basic plutonic", "color": "#8e2f5c", "group": "Plutonic"},
    {"value": 10, "label": "Metamorphic", "color": "#8a9a7b", "group": "Metamorphic"},
    {"value": 7, "label": "Ice and glaciers", "color": "#f2f6f8", "group": "Ice"},
]
UNDEFINED_CLASS = 15
WATER_CLASS = 255

# Each family lists its level 2 codes in value order, with "__" for no level 2 code.
GLIM_FAMILIES = [
    (
        "su",
        "Unconsolidated",
        "Sediments",
        "#fdf0a8",
        "mx ss sh pu py ad ds la lo or",
    ),
    (
        "ss",
        "Siliciclastic",
        "Sediments",
        "#e8c33c",
        "mx ss sh py am la lo",
    ),
    (
        "sm",
        "Mixed",
        "Sediments",
        "#c2ab5a",
        "mx ss sh py ad ds la lo or am gr",
    ),
    (
        "sc",
        "Carbonate",
        "Sediments",
        "#6fa8d6",
        "mx ss sh pu py ad la lo am",
    ),
    (
        "ev",
        "Evaporites",
        "Sediments",
        "#c5a3d6",
        "__ mx ss sh pu",
    ),
    (
        "py",
        "Pyroclastics",
        "Volcanic",
        "#d9753b",
        "__ mx ss sh pu or am",
    ),
    (
        "va",
        "Acid",
        "Volcanic",
        "#e57373",
        "__ pu py am",
    ),
    (
        "vi",
        "Intermediate",
        "Volcanic",
        "#c0392b",
        "__ mx pu py am",
    ),
    (
        "vb",
        "Basic",
        "Volcanic",
        "#6c3483",
        "__ mx pu py la am gr",
    ),
    (
        "pa",
        "Acid",
        "Plutonic",
        "#f194b4",
        "__ pu py am gr",
    ),
    (
        "pi",
        "Intermediate",
        "Plutonic",
        "#d65d8a",
        "__ pu py am gr",
    ),
    (
        "pb",
        "Basic",
        "Plutonic",
        "#8e2f5c",
        "__ pu py am",
    ),
    (
        "mt",
        "Metamorphic",
        "Metamorphic",
        "#8a9a7b",
        "__ mx sh pu py la am gr",
    ),
    (
        "ig",
        "Ice and glaciers",
        "Ice/other",
        "#f2f4f5",
        "__",
    ),
]
GLIM_LEVEL2_NAMES = {
    "__": "",
    "mx": "mixed grain",
    "ss": "coarse grain",
    "sh": "fine grain",
    "pu": "pure",
    "py": "with pyroclasts",
    "ad": "alluvial",
    "ds": "dunes",
    "la": "lateritic",
    "lo": "loess",
    "or": "organic",
    "am": "amphibolite",
    "gr": "greenschist",
}


def _glim_class_table() -> list[tuple[str, dict]]:
    """Return (level 1 + level 2 code, class) for each GLiM class, valued in table order."""
    table = []
    for code, name, group, color, level2_codes in GLIM_FAMILIES:
        for variant, level2 in enumerate(level2_codes.split()):
            suffix = GLIM_LEVEL2_NAMES[level2]
            entry = {
                "value": len(table) + 1,
                "label": f"{name}, {suffix}" if suffix else name,
                "color": color,
                "group": group,
                "parent": code,
                "variant": variant,
            }
            table.append((code + level2, entry))
    return table


_GLIM_TABLE = _glim_class_table()
GEOLOGY_CLASSES = [entry for _, entry in _GLIM_TABLE]  # the classes of the GLiM COG
# Water bodies (wb) and no data (nd) have no value, so the COG stores them as 0.
GLIM_VALUES = {code: entry["value"] for code, entry in _GLIM_TABLE}

