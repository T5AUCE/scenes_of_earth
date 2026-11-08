"""Classify regional geology ingest records using the published country name tables."""
from ..geology_age import TIMELINE, smallest_containing_class
from ..sources.lithology import GLIM_VALUES

NO_DATA_NAMES = {"", " ", "unknown", "undifferentiated"}  # blank-ish names mean no data


def family_value(family: str) -> int:
    """Return the class value of the undivided variant of the GLiM family `family`.

    The four sedimentary families have no undivided variant in GLiM, so they take the
    mixed-grain class which is each family's most generic one.
    """
    plain = {"su": "sumx", "ss": "ssmx", "sm": "smmx", "sc": "scmx"}
    return GLIM_VALUES[plain.get(family, family + "__")]


def class_value(code: str) -> int:
    """Return the class value of the GLiM level 1 + level 2 `code` (for example "ssss")."""
    return GLIM_VALUES[code]


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
    "undivided Triassic-Jurassic": ("Triassic", "Jurassic"),
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


CANADA_TYPE_NAMES: dict[str, str | None] = {
    "alkaline gabbro and syenite": "pb__",
    "alkaline intrusive rocks": "pi__",
    "alkaline volcanic rocks": "vb__",
    "anorthosite": "pb__",
    "bimodal alkaline volcanic rocks": "vi__",
    "bimodal volcanic rocks": "vi__",
    "carbonate": "scmx",
    "charnockite": "pa__",
    "coarse clastic sediments and alkaline volcanic rocks": "smss",
    "conglomerate and sandstone": "ssss",
    "evaporite": "ev__",
    "felsic and mafic intrusive rocks": "pa__",
    "felsic volcanic rocks": "va__",
    "felsic-intermediate volcanic rocks": "vi__",
    "felsite": "pa__",
    "gabbro-anorthosite": "pb__",
    "granodiorite, quartz diorite": "pi__",
    "intermediate volcanic rocks": "vi__",
    "mafic and ultramafic intrusive rocks": "pb__",
    "mafic gneiss": "mt__",
    "mafic intrusive rocks-diorite, gabbro": "pb__",
    "mafic volcanic rocks": "vb__",
    "marble": "mtpu",
    "medium-grade gneiss": "mt__",
    "melange": "mt__",
    "nonmarine sedimentary rocks": "ssmx",
    "oceanic mafic volcanic rocks": "vb__",
    "offshelf miogeoclinal rocks": "smmx",
    "orthogneiss": "mt__",
    "paragneiss": "mt__",
    "paragneiss-orthogneiss": "mt__",
    "quartz monzonite, granite": "pa__",
    "rapakivi granite": "pa__",
    "sedimentary and mafic volcanic rocks": "smmx",
    "sedimentary and volcanic gneiss": "mt__",
    "syenite, monzodiorite": "pi__",
    "syenitic gneiss": "mt__",
    "tonalite": "pa__",
    "two mica granite, diatexite": "pa__",
    "ultramafic intrusive rocks": "pb__",
    "ultramafic melange": "mt__",
    "undivided gneiss": "mt__",
    "undivided granitoid rocks": "pa__",
    "undivided sedimentary and volcanic rocks": "smmx",
    "undivided sedimentary rocks": "smmx",
    "undivided volcanic rocks": "py__",
    "volcanic gneiss": "mt__",
}

CANADA_RXTP_FALLBACK: dict[str, str | None] = {
    "intrusive rocks": None,
    "metamorphic rocks": "mt__",
    "sedimentary and volcanic rocks": "smmx",
    "sedimentary rocks": "smmx",
    "volcanic rocks": "py__",
}


def canada_type_batch(records: list[tuple[str, str]]) -> list[int | None]:
    """Return the rock-type class of each (rxtp, subrxtp) record, None where the base fills in.

    The Canadian source stores the detailed unit in SUBRXTP and the broader group in RXTP,
    so a blank detailed unit falls back to the group. Any subtype or rock type missing
    from the tables fails the whole call and lists every such name, except blank and
    unknown names which fall back or mean no data.
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
        code = CANADA_TYPE_NAMES.get(subrxtp)
        if code is None and subrxtp in NO_DATA_NAMES:
            code = CANADA_RXTP_FALLBACK.get(rxtp)
        values.append(class_value(code) if code else None)
    return values


# Orogeny names are judged from their mapped Ma ranges; Proterozoic I-III is the Harland-era split.
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
    sides = {side for agename in names for side in _normalize_igme_range(agename)}
    _fail_unmapped(
        "IGME5000 age names",
        {side for side in sides if side not in NO_DATA_NAMES and side not in IGME_AGE_SIDES},
    )
    return [_igme_age_value(agename) for agename in names]


def _split_igme_range(agename: str) -> list[str]:
    """Return the one or two side names of an AgeName range."""
    return [side.strip() for side in agename.split(" - ")]


def _normalize_igme_range(agename: str) -> list[str]:
    """Collapse "Early - Middle X" style ranges onto X, since a bare qualifier names no unit."""
    sides = _split_igme_range(agename)
    if len(sides) == 2 and all(side.split()[0] in ("Early", "Middle", "Late") for side in sides):
        first, second = sides[0].split(), sides[1].split()
        if len(first) == 1 and len(second) == 2:
            return [second[1]]
    return sides


def _igme_age_value(agename: str) -> int | None:
    if agename in NO_DATA_NAMES:
        return None
    sides = _normalize_igme_range(agename)
    if any(side in NO_DATA_NAMES for side in sides):
        return None
    reaches = [IGME_AGE_SIDES[side] for side in sides if side in IGME_AGE_SIDES]
    if not reaches:
        return None
    oldest = min((reach[0] for reach in reaches), key=TIMELINE.index)
    newest = max((reach[1] for reach in reaches), key=TIMELINE.index)
    return smallest_containing_class(*_timeline_span(oldest, newest))


# Volcanites without a petrography count as basic like Precambrian greenstones, plutonites as acid.
IGME_TYPE_NAMES: dict[str, str | None] = {
    "Ice": "ig__",
    "Qtz andesite": "vi__",
    "agglomerate/breccia group": "pyss",
    "alkali basalt": "vb__",
    "ophiolite complex": "vb__",
    "alkali granite": "pa__",
    "alkali rhyolite": "va__",
    "alkali syenite": "pi__",
    "amphibolite": "mtam",
    "andesite": "vi__",
    "andesite agglomerate": "pyss",
    "andesite group": "vi__",
    "andesite tuff": "pysh",
    "andesite tuffite": "pysh",
    "anhydrite": "evpu",
    "basalt": "vb__",
    "basalt agglomerate": "pyss",
    "basalt group": "vb__",
    "basalt tuffite": "pysh",
    "blueschist": "mt__",
    "carbonates": "scmx",
    "carbonates, consolidated": "scmx",
    "chalk": "scpu",
    "chert": "sssh",
    "clay": "sush",
    "claystone": "sssh",
    "coal": "smor",
    "conglomerate": "ssss",
    "dacite": "va__",
    "diorite": "pi__",
    "dolerite": "vb__",
    "dolomite/dolostone": "scpu",
    "dunite, harzburgite, lherzolite": "pb__",
    "eclogite": "mt__",
    "essexite-theralite group": "pi__",
    "evaporites": "ev__",
    "gabbro": "pb__",
    "gabbro group": "pb__",
    "gneiss": "mt__",
    "granite": "pa__",
    "granite group": "pa__",
    "granodiorite": "pa__",
    "granodiorite-diorite group": "pi__",
    "granulite": "mt__",
    "gravel": "suss",
    "greenschist": "mtgr",
    "gypsum": "evpu",
    "gypsum, anhydrite": "evpu",
    "hawaiite": "vb__",
    "lamprophyre": "vb__",
    "latite": "vi__",
    "latite andesite": "vi__",
    "limestone": "scpu",
    "marble": "mtpu",
    "marl": "smsh",
    "marlstone": "smsh",
    "meta-andesite": "mt__",
    "meta-basalt": "mt__",
    "meta-basalt group": "mt__",
    "meta-basalt tuff": "mt__",
    "meta-carbonate": "mt__",
    "meta-claystone": "mt__",
    "meta-conglomerate": "mt__",
    "meta-dacite": "mt__",
    "meta-dolerite": "mt__",
    "meta-gabbro": "mt__",
    "meta-gabbro group": "mt__",
    "meta-granite": "mt__",
    "meta-granite group": "mt__",
    "meta-granodiorite": "mt__",
    "meta-limestone": "mt__",
    "meta-peridotite": "mt__",
    "meta-plutonic rock group": "mt__",
    "meta-rhyodacite": "mt__",
    "meta-rhyolite": "mt__",
    "meta-rhyolite group": "mt__",
    "meta-rhyolite tuffite": "mt__",
    "meta-sandstone": "mt__",
    "meta-sediment group": "mt__",
    "meta-tonalite": "mt__",
    "meta-tuffite group": "mt__",
    "meta-volcanic rock group": "mt__",
    "mica schist": "mt__",
    "migmatite/anatexite": "mt__",
    "miscellaneous metamorphic rock group": "mt__",
    "monzodiorite": "pi__",
    "monzonite": "pi__",
    "mud": "sush",
    "mudstone": "sssh",
    "mylonite": "mt__",
    "nephelinic, leucitic and analcitic rocks": "va__",
    "olivine basalt": "vb__",
    "peridotite": "pb__",
    "phonolite": "va__",
    "phonolitic tephrite, tephritic phonolite": "vb__",
    "phyllite": "mt__",
    "plutonic alkaline group": "pi__",
    "plutonic ultramafic group": "pb__",
    "pyroxenite": "pb__",
    "quartzite": "mtpu",
    "rhyodacite": "va__",
    "rhyolite": "va__",
    "rhyolite group": "va__",
    "rhyolite tuff": "pysh",
    "rhyolite tuffite": "pysh",
    "rock salt": "evpu",
    "sand": "suss",
    "sandstone": "ssss",
    "schist group": "mt__",
    "serpentinite": "mt__",
    "shale/slate": "sssh",
    "siliclastics, consolidated": "ssmx",
    "silt": "sush",
    "siltstone": "sssh",
    "siliceous ooze": "sush",
    "syenite": "pi__",
    "syenite-monzonite group": "pi__",
    "tephrite, basanite": "vb__",
    "theralite": "pi__",
    "tholeiitic basalt": "vb__",
    "tillite": "smmx",
    "tonalite": "pa__",
    "trachyte": "va__",
    "tuff group": "pysh",
    "tuffite group": "pysh",
    "volcanic alkaline group": "vb__",
    "volcanic ultramafic group": "vb__",
    "volcano-sediments": "smpy",
}

IGME_IGNE_FALLBACK: dict[str, str | None] = {
    "ophiolite complex": "vb__",
    "plutonite Cenozoic": "pa__",
    "plutonite Mesozoic": "pa__",
    "plutonite Palaeozoic": "pa__",
    "plutonite Precambrian": "pa__",
    "plutonite undifferentiated": "pa__",
    "volcanite Cenozoic": "vb__",
    "volcanite Mesozoic": "vb__",
    "volcanite Palaeozoic": "vb__",
    "volcanite Precambrian": "vb__",
    "volcanite Quaternary": "vb__",
    "volcanite undifferentiated": "vb__",
}

IGME_MARI_FALLBACK: dict[str, str | None] = {
    "break-up related basalt flows": "vb__",
    "ocean-continent transition of various ages": "smmx",
    "oceanic crust, older": "vb__",
    "oceanic crust, younger": "vb__",
    "rifted thinned continental crust of various ages": "smmx",
}


def igme_type_batch(
    records: list[tuple[str | None, str | None, str | None, str | None]],
) -> list[int | None]:
    """Return the rock-type class of each record, None where the base map fills in.

    Records hold the main petrography with its secondary lithology and the igneous and
    marine fields as fallbacks. Ice ("Ice" in the IceO field, passed as petr) counts as ice,
    and blank names never fail, while any other name missing from the tables fails the whole
    call and lists every such name.
    """
    unmapped = {
        name
        for petr, secondary, igne, mari in records
        for name, table in (
            (petr, IGME_TYPE_NAMES),
            (secondary, IGME_TYPE_NAMES),
            (igne, IGME_IGNE_FALLBACK),
            (mari, IGME_MARI_FALLBACK),
        )
        if name and name not in NO_DATA_NAMES and name not in table
    }
    _fail_unmapped("IGME5000 rock names", unmapped)
    values = []
    for petr, secondary, igne, mari in records:
        code = IGME_TYPE_NAMES.get(petr or "")
        if code is None and (not petr or petr in NO_DATA_NAMES):
            code = IGME_TYPE_NAMES.get(secondary or "")
        if code is None and (not secondary or secondary in NO_DATA_NAMES):
            code = IGME_IGNE_FALLBACK.get(igne or "")
        if code is None and (not igne or igne in NO_DATA_NAMES):
            code = IGME_MARI_FALLBACK.get(mari or "")
        values.append(class_value(code) if code else None)
    return values


# Ages come from names and never from Ma, because the state maps use older time scales.
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

# An Early, Middle or Late prefix narrows nothing because the class is the whole period anyway.
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


# Exact archive names keep invented substrings from matching real lithologies.
SGMC_EVAPORITE_PURE_NAMES = (
    "Anhydrite",
    "Gypsum",
    "Salt",
)
SGMC_EVAPORITE_NAMES = (
    "Evaporite",
)
SGMC_CARBONATE_CLASSES = {
    "Calcarenite": "scss",
    "Carbonate": "scmx",
    "Chalk": "scpu",
    "Coquina": "scss",
    "Coral": "scmx",
    "Dolostone": "scpu",
    "Limestone": "scpu",
}
SGMC_MIXED_FINE_NAMES = (
    "Marlstone",
)
SGMC_MIXED_NAMES = (
    "Mixed-clastic",
)
SGMC_COAL_NAMES = (
    "Anthracite",
    "Bituminous",
    "Coal",
    "Lignite",
    "Peat",
    "Sub-bituminous",
)
SGMC_SILICEOUS_NAMES = (
    "Chert",
    "Diatomite",
    "Novaculite",
)
SGMC_CLASTIC_COARSE_NAMES = (
    "Arenite",
    "Arkose",
    "Conglomerate",
    "Conglomerate-sandstone",
    "Graywacke",
    "Sandstone",
    "Sedimentary-breccia",
)
SGMC_CLASTIC_FINE_NAMES = (
    "Bentonite",
    "Black-shale",
    "Claystone",
    "Mudstone",
    "Oil-shale",
    "Phosphatic-shale",
    "Shale",
    "Siltstone",
    "Siltstone-mudstone",
)
SGMC_CLASTIC_MIXED_NAMES = (
    "Clastic",
    "Conglomerate-mudstone",
    "Sandstone-mudstone",
)
SGMC_CHEMICAL_OTHER_NAMES = (
    "Banded-iron-formation",
    "Phosphorite",
)
SGMC_SEDIMENTARY_GROUP_NAMES = (
    "Chemical",
)

SGMC_BASIC_NAMES = (
    "Anorthosite",
    "Basalt",
    "Basaltic-andesite",
    "Basanite",
    "Dunite",
    "Foidite",
    "Gabbro",
    "Gabbroic",
    "Hornblendite",
    "Hypabyssal-basalt",
    "Hypabyssal-basaltic-andesite",
    "Hypabyssal-mafic-alkaline",
    "Kimberlite",
    "Komatiite",
    "Lamprophyre",
    "Mafic-hypabyssal",
    "Mafic-volcanic",
    "Norite",
    "Peridotite",
    "Picrite",
    "Pyroxenite",
    "Quartz-gabbro",
    "Troctolite",
    "Ultramafic",
)
SGMC_INTERMEDIATE_NAMES = (
    "Alkali-feldspar-syenite",
    "Andesite",
    "Diorite",
    "Dioritic",
    "Felsic-hypabyssal",
    "Foid-syenite",
    "Foidal-syenitic",
    "Granodiorite",
    "Hypabyssal-andesite",
    "Hypabyssal-dacite",
    "Hypabyssal-felsic-alkaline",
    "Hypabyssal-latite",
    "Hypabyssal-quartz-latite",
    "Hypabyssal-quartz-trachyte",
    "Hypabyssal-rhyolite",
    "Hypabyssal-trachyte",
    "Latite",
    "Monzodiorite",
    "Monzonite",
    "Nepheline-syenite",
    "Quartz-alkali-feldspar-syenite",
    "Quartz-diorite",
    "Quartz-latite",
    "Quartz-monzodiorite",
    "Quartz-monzonite",
    "Quartz-syenite",
    "Quartz-trachyte",
    "Syenite",
    "Syenitic",
    "Trachyte",
)
SGMC_ACID_NAMES = (
    "Alaskite",
    "Alkali-feldspar-granite",
    "Alkali-granite",
    "Aplite",
    "Charnockite",
    "Dacite",
    "Felsic-volcanic",
    "Granite",
    "Granitic",
    "Leucocratic-granitic",
    "Monzogranite",
    "Pegmatite",
    "Phonolite",
    "Rhyolite",
    "Syenogranite",
    "Tonalite",
    "Trondhjemite",
)
SGMC_CARBONATITE_NAMES = (
    "Intrusive-carbonatite",
)
SGMC_IGNEOUS_GROUP_NAMES = (
    "Alkalic-volcanic",
    "Hypabyssal",
    "Plutonic",
    "Volcanic",
)

SGMC_METAMORPHIC_CLASSES = {
    "Amphibolite": "mtam",
    "Argillite": "mtsh",
    "Marble": "mtpu",
    "Quartzite": "mtpu",
    "Slate": "mtsh",
}
SGMC_METAMORPHIC_NAMES = (
    "Amphibole-schist",
    "Amphibolite",
    "Biotite-gneiss",
    "Biotite-schist",
    "Calc-silicate-gneiss",
    "Calc-silicate-rock",
    "Calc-silicate-schist",
    "Eclogite",
    "Gneiss",
    "Granoblastic",
    "Granofels",
    "Granulite",
    "Greenstone",
    "Hornblende-gneiss",
    "Hornfels",
    "Hydrothermally-altered",
    "Marble",
    "Metaandesite",
    "Metaanorthosite",
    "Metabasalt",
    "Metacarbonate",
    "Metaclastic",
    "Metaconglomerate",
    "Metadacite",
    "Metadiabase",
    "Metadiorite",
    "Metadunite",
    "Metagabbro",
    "Metagranite",
    "Metagraywacke",
    "Metaigneous",
    "Metaintrusive",
    "Metaperidotite",
    "Metapyroxenite",
    "Metarhyolite",
    "Metasandstone",
    "Metasedimentary",
    "Metasiltstone",
    "Metatonalite",
    "Metatrondhjemite",
    "Metaultramafic",
    "Metavolcanic",
    "Mica-schist",
    "Migmatite",
    "Muscovite-gneiss",
    "Muscovite-schist",
    "Orthogneiss",
    "Paragneiss",
    "Pelitic-schist",
    "Phyllite",
    "Quartz-feldspar-schist",
    "Quartzite",
    "Schist",
    "Serpentinite",
    "Skarn",
    "Spilite",
)
SGMC_UNCONSOLIDATED_COARSE_NAMES = (
    "Boulders",
    "Coarse-detrital",
    "Coral",
    "Gravel",
    "Sand",
)
SGMC_UNCONSOLIDATED_FINE_NAMES = (
    "Clay",
    "Fine-detrital",
    "Silt",
)
SGMC_UNCONSOLIDATED_ORGANIC_NAMES = (
    "Peat",
)
SGMC_UNCONSOLIDATED_MIXED_NAMES = (
    "Marl",
)
SGMC_TECTONITE_NAMES = (
    "Cataclasite",
    "Melange",
    "Mylonite",
    "Phyllonite",
)
SGMC_KNOWN_NAMES = frozenset(
    (
        *SGMC_EVAPORITE_PURE_NAMES,
        *SGMC_EVAPORITE_NAMES,
        *SGMC_CARBONATE_CLASSES,
        *SGMC_MIXED_FINE_NAMES,
        *SGMC_MIXED_NAMES,
        *SGMC_COAL_NAMES,
        *SGMC_SILICEOUS_NAMES,
        *SGMC_CLASTIC_COARSE_NAMES,
        *SGMC_CLASTIC_FINE_NAMES,
        *SGMC_CLASTIC_MIXED_NAMES,
        *SGMC_CHEMICAL_OTHER_NAMES,
        *SGMC_SEDIMENTARY_GROUP_NAMES,
        *SGMC_BASIC_NAMES,
        *SGMC_INTERMEDIATE_NAMES,
        *SGMC_ACID_NAMES,
        *SGMC_CARBONATITE_NAMES,
        *SGMC_IGNEOUS_GROUP_NAMES,
        *SGMC_METAMORPHIC_CLASSES,
        *SGMC_METAMORPHIC_NAMES,
        *SGMC_UNCONSOLIDATED_COARSE_NAMES,
        *SGMC_UNCONSOLIDATED_FINE_NAMES,
        *SGMC_UNCONSOLIDATED_ORGANIC_NAMES,
        *SGMC_UNCONSOLIDATED_MIXED_NAMES,
        *SGMC_TECTONITE_NAMES,
    ),
)
SGMC_LITH1_DEFAULTS: dict[str, str] = {
    "Ice": "ig__",
    "Igneous": "vi__",
    "Metamorphic": "mt__",
    "Sedimentary": "smmx",
    "Tectonite": "mt__",
    "Unconsolidated": "sumx",
}


def sgmc_class(lith1: str, lith2: str, lith3: str, lith4: str, lith5: str) -> str:
    """Return the GLiM level 1 + level 2 code of an SGMC LITH1 to LITH5 hierarchy."""
    if lith1 not in SGMC_LITH1_DEFAULTS:
        raise ValueError(f"SGMC lithology without a class: {[lith1]}")
    if lith1 == "Ice":
        return "ig__"

    levels = (lith5, lith4, lith3, lith2)
    if lith1 == "Unconsolidated":
        return _sgmc_unconsolidated_class(set(levels))
    if lith1 in ("Metamorphic", "Tectonite"):
        return _deepest_class(levels, SGMC_METAMORPHIC_CLASSES) or "mt__"
    if lith1 == "Sedimentary":
        return _sgmc_sedimentary_class(levels)

    finer = set(levels)
    if finer & set(SGMC_CARBONATITE_NAMES):
        return "scpu"
    if finer & set(SGMC_BASIC_NAMES):
        return "vb__" if lith2 == "Volcanic" else "pb__"
    if finer & set(SGMC_INTERMEDIATE_NAMES):
        return "vi__" if lith2 == "Volcanic" else "pi__"
    if finer & set(SGMC_ACID_NAMES):
        return "va__" if lith2 == "Volcanic" else "pa__"
    return SGMC_LITH1_DEFAULTS[lith1]


def _sgmc_unconsolidated_class(finer: set[str]) -> str:
    """Return the GLiM code of loose finer names, or the mixed-grain code when none names a grain."""
    if finer & set(SGMC_UNCONSOLIDATED_COARSE_NAMES):
        return "suss"
    if finer & set(SGMC_UNCONSOLIDATED_FINE_NAMES):
        return "sush"
    if finer & set(SGMC_UNCONSOLIDATED_ORGANIC_NAMES):
        return "suor"
    return "sumx"


def _sgmc_sedimentary_class(levels: tuple[str, ...]) -> str:
    """Return the GLiM code of sedimentary finer names.

    Names that give no grain size fall back to the mixed-grain class. The levels run from the most to the least specific, so a carbonate leaf such as Coquina
    decides the class before its Limestone ancestor does.
    """
    finer = set(levels)
    if finer & set(SGMC_EVAPORITE_PURE_NAMES):
        return "evpu"
    if finer & set(SGMC_EVAPORITE_NAMES):
        return "ev__"
    carbonate_class = _deepest_class(levels, SGMC_CARBONATE_CLASSES)
    if carbonate_class:
        if finer & set(SGMC_MIXED_FINE_NAMES):
            return "smsh"
        if finer & set(SGMC_MIXED_NAMES):
            return "smmx"
        return carbonate_class
    if finer & set(SGMC_COAL_NAMES):
        return "smor"
    if finer & set(SGMC_MIXED_FINE_NAMES):
        return "smsh"
    if finer & set(SGMC_MIXED_NAMES):
        return "smmx"
    if finer & set(SGMC_SILICEOUS_NAMES):
        return "sssh"
    if finer & set(SGMC_CLASTIC_COARSE_NAMES):
        return "ssss"
    if finer & set(SGMC_CLASTIC_FINE_NAMES):
        return "sssh"
    if finer & set(SGMC_CLASTIC_MIXED_NAMES):
        return "ssmx"
    return "smmx"


def _deepest_class(levels: tuple[str, ...], classes: dict[str, str]) -> str | None:
    """Return the class of the first level named in `classes`, or None when none is."""
    return next((classes[name] for name in levels if name in classes), None)


def sgmc_type_batch(records: list[tuple[str, str, str, str, str]]) -> list[int | None]:
    """Return the rock-type class of each SGMC hierarchy.

    Every nonblank finer name must belong to the verified archive vocabulary, so a new
    spelling fails the whole call and lists every such name.
    """
    unmapped = set()
    for lith1, *finer in records:
        if lith1 not in SGMC_LITH1_DEFAULTS:
            unmapped.add(lith1)
        else:
            unmapped.update(name for name in finer if name and name not in SGMC_KNOWN_NAMES)
    _fail_unmapped("SGMC lithology", unmapped)
    return [class_value(sgmc_class(*record)) for record in records]


# INSPIRE lithology classes of the EGDI raster by cell value; None leaves the cell to the base.
EGDI_TYPE_NAMES: dict[int, str | None] = {
    1: "vb__",  # alkaliOlivineBasalt
    2: "mtam",  # amphibolite
    3: "vi__",  # andesite
    4: "pb__",  # anorthositicRock
    5: "ssss",  # arenite
    6: "pymx",  # ashBrecciaBombOrBlockTephra
    7: "pymx",  # ashTuffLapillistoneAndLapilliTuff
    8: "vb__",  # basalt
    9: "vb__",  # basanite
    10: "sssh",  # biogenicSilicaSedimentaryRock
    11: "ssss",  # breccia
    12: "mt__",  # brecciaGougeSeries
    13: "sush",  # carbonateMud
    14: "sush",  # carbonateOoze
    15: "scmx",  # carbonateSedimentaryRock
    16: None,  # carbonatite
    17: "scpu",  # chalk
    18: "mtgr",  # chloriteActinoliteEpidoteMetamorphicRock
    19: "ssss",  # clasticSandstone
    20: "sumx",  # clasticSediment
    21: "smmx",  # clasticSedimentaryMaterial
    22: "ssmx",  # clasticSedimentaryRock
    23: "sush",  # clay
    24: "sssh",  # claystone
    25: "ssss",  # conglomerate
    26: "va__",  # dacite
    27: "smmx",  # diamictite
    28: "sumx",  # diamicton
    29: "pi__",  # diorite
    30: "pi__",  # dioriticRock
    31: "vb__",  # doleriticRock
    32: "scpu",  # dolomite
    33: "scmx",  # dolomiticOrMagnesianSedimentaryRock
    34: "mt__",  # eclogite
    35: None,  # exoticCompositionIgneousRock
    36: None,  # fineGrainedIgneousRock
    37: "pi__",  # foidBearingSyenite
    38: "pi__",  # foidSyenitoid
    39: "mt__",  # foliatedMetamorphicRock
    40: "pymx",  # fragmentalIgneousMaterial
    41: "pb__",  # gabbro
    42: "pb__",  # gabbroicRock
    43: "pb__",  # gabbroid
    44: "mt__",  # glaucophaneLawsoniteEpidoteMetamorphicRock
    45: "mt__",  # gneiss
    46: "pa__",  # granite
    47: "pa__",  # granitoid
    48: "pa__",  # granodiorite
    49: "mt__",  # granulite
    50: "suss",  # gravel
    51: "evpu",  # gypsumOrAnhydrite
    52: "mt__",  # hornfels
    53: None,  # igneousMaterial
    54: None,  # igneousRock
    55: None,  # impactGeneratedMaterial
    56: "sumx",  # impureCarbonateSediment
    57: "smmx",  # impureCarbonateSedimentaryRock
    58: "smmx",  # impureDolomite
    59: "smmx",  # impureLimestone
    60: "vb__",  # komatiiticRock
    61: "scpu",  # limestone
    62: "mtpu",  # marble
    63: "mt__",  # metamorphicRock
    64: "mt__",  # metasomaticRock
    65: "mt__",  # micaSchist
    66: "mt__",  # migmatite
    67: "pa__",  # monzogranite
    68: "pi__",  # monzonite
    69: "sush",  # mud
    70: "sssh",  # mudstone
    71: "mt__",  # myloniticRock
    72: "sssh",  # nonClasticSiliceousSedimentaryRock
    73: "sssh",  # organicBearingMudstone
    74: "suor",  # organicRichSediment
    75: "smor",  # organicRichSedimentaryMaterial
    76: "mt__",  # orthogneiss
    77: "mt__",  # paragneiss
    78: "suor",  # peat
    79: "pb__",  # peridotite
    80: None,  # phaneriticIgneousRock
    81: "va__",  # phonolite
    82: "mt__",  # phyllite
    83: "mt__",  # phyllonite
    84: None,  # porphyry
    85: "pymx",  # pyroclasticMaterial
    86: "pymx",  # pyroclasticRock
    87: "pb__",  # pyroxenite
    88: "pi__",  # quartzDiorite
    89: "mtpu",  # quartzite
    90: "sumx",  # residualMaterial
    91: "va__",  # rhyolite
    92: "va__",  # rhyolitoid
    93: None,  # rock
    94: "suss",  # sand
    95: "ssss",  # sandstone
    96: "mt__",  # schist
    97: "sumx",  # sediment
    98: "smmx",  # sedimentaryMaterial
    99: "smmx",  # sedimentaryRock
    100: "mt__",  # serpentinite
    101: "sssh",  # shale
    102: "sush",  # silicateMud
    103: "sush",  # silt
    104: "sssh",  # siltstone
    105: "mt__",  # skarn
    106: "mtsh",  # slate
    107: "vb__",  # spilite
    108: "pi__",  # syenite
    109: "pi__",  # syeniticRock
    110: "pa__",  # syenogranite
    111: "vb__",  # tephrite
    112: "vb__",  # tholeiiticBasalt
    113: "pa__",  # tonalite
    114: "va__",  # trachyte
    115: "va__",  # trachyticRock
    116: "va__",  # trachytoid
    117: "scpu",  # travertine
    118: "pymx",  # tuffBrecciaAgglomerateOrPyroclasticBreccia
    119: "pb__",  # ultramaficIgneousRock
    120: "ssss",  # wacke
    121: None,  # waste
    122: None,  # Unknown
    123: None,  # Unpopulated
}


def egdi_type_batch(values: list[int]) -> list[int | None]:
    """Return the rock-type class of each EGDI raster value, None where the base map fills in.

    A value missing from the legend table fails the whole call and lists every such value.
    """
    unmapped = {value for value in values if value not in EGDI_TYPE_NAMES}
    _fail_unmapped("EGDI lithology values", {str(value) for value in sorted(unmapped)})
    return [
        class_value(EGDI_TYPE_NAMES[value]) if EGDI_TYPE_NAMES[value] else None
        for value in values
    ]

