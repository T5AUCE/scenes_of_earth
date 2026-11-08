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
        family = CANADA_TYPE_NAMES.get(subrxtp)
        if family is None and subrxtp in NO_DATA_NAMES:
            family = CANADA_RXTP_FALLBACK.get(rxtp)
        values.append(family_value(family) if family else None)
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
    "Ice": "ig",
    "Qtz andesite": "vi",
    "agglomerate/breccia group": "py",
    "alkali basalt": "vb",
    "ophiolite complex": "vb",
    "alkali granite": "pa",
    "alkali rhyolite": "va",
    "alkali syenite": "pi",
    "amphibolite": "mt",
    "andesite": "vi",
    "andesite agglomerate": "vi",
    "andesite group": "vi",
    "andesite tuff": "py",
    "andesite tuffite": "py",
    "anhydrite": "ev",
    "basalt": "vb",
    "basalt agglomerate": "py",
    "basalt group": "vb",
    "basalt tuffite": "py",
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
    "gypsum, anhydrite": "ev",
    "hawaiite": "vb",
    "lamprophyre": "vb",
    "latite": "vi",
    "latite andesite": "vi",
    "limestone": "sc",
    "marble": "mt",
    "marl": "sm",
    "marlstone": "sm",
    "meta-andesite": "mt",
    "meta-basalt": "mt",
    "meta-basalt group": "mt",
    "meta-basalt tuff": "mt",
    "meta-carbonate": "mt",
    "meta-claystone": "mt",
    "meta-conglomerate": "mt",
    "meta-dacite": "mt",
    "meta-dolerite": "mt",
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
    "meta-rhyolite tuffite": "mt",
    "meta-sandstone": "mt",
    "meta-sediment group": "mt",
    "meta-tonalite": "mt",
    "meta-tuffite group": "mt",
    "meta-volcanic rock group": "mt",
    "mica schist": "mt",
    "migmatite/anatexite": "mt",
    "miscellaneous metamorphic rock group": "mt",
    "monzodiorite": "pi",
    "monzonite": "pi",
    "mud": "ss",
    "mudstone": "ss",
    "mylonite": "mt",
    "nephelinic, leucitic and analcitic rocks": "va",
    "olivine basalt": "vb",
    "peridotite": "pb",
    "phonolite": "va",
    "phonolitic tephrite, tephritic phonolite": "vb",
    "phyllite": "mt",
    "plutonic alkaline group": "pi",
    "plutonic ultramafic group": "pb",
    "pyroxenite": "pb",
    "quartzite": "mt",
    "rhyodacite": "va",
    "rhyolite": "va",
    "rhyolite group": "va",
    "rhyolite tuff": "py",
    "rhyolite tuffite": "py",
    "rock salt": "ev",
    "sand": "ss",
    "sandstone": "ss",
    "schist group": "mt",
    "serpentinite": "mt",
    "shale/slate": "ss",
    "siliclastics, consolidated": "ss",
    "silt": "ss",
    "siltstone": "ss",
    "siliceous ooze": "ss",
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
        family = IGME_TYPE_NAMES.get(petr or "")
        if family is None and (not petr or petr in NO_DATA_NAMES):
            family = IGME_TYPE_NAMES.get(secondary or "")
        if family is None and (not secondary or secondary in NO_DATA_NAMES):
            family = IGME_IGNE_FALLBACK.get(igne or "")
        if family is None and (not igne or igne in NO_DATA_NAMES):
            family = IGME_MARI_FALLBACK.get(mari or "")
        values.append(family_value(family) if family else None)
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
SGMC_EVAPORITE_NAMES = (
    "Anhydrite",
    "Evaporite",
    "Gypsum",
    "Salt",
)
SGMC_CARBONATE_NAMES = (
    "Calcarenite",
    "Carbonate",
    "Chalk",
    "Coquina",
    "Coral",
    "Dolostone",
    "Limestone",
)
SGMC_MIXED_NAMES = (
    "Marlstone",
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
SGMC_CLASTIC_NAMES = (
    "Arenite",
    "Arkose",
    "Bentonite",
    "Black-shale",
    "Clastic",
    "Claystone",
    "Conglomerate",
    "Conglomerate-mudstone",
    "Conglomerate-sandstone",
    "Graywacke",
    "Mudstone",
    "Oil-shale",
    "Phosphatic-shale",
    "Sandstone",
    "Sandstone-mudstone",
    "Sedimentary-breccia",
    "Shale",
    "Siltstone",
    "Siltstone-mudstone",
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

SGMC_METAMORPHIC_NAMES = (
    "Amphibole-schist",
    "Amphibolite",
    "Argillite",
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
    "Slate",
    "Spilite",
)
SGMC_UNCONSOLIDATED_NAMES = (
    "Boulders",
    "Clay",
    "Coarse-detrital",
    "Coral",
    "Fine-detrital",
    "Gravel",
    "Marl",
    "Peat",
    "Sand",
    "Silt",
)
SGMC_TECTONITE_NAMES = (
    "Cataclasite",
    "Melange",
    "Mylonite",
    "Phyllonite",
)
SGMC_KNOWN_NAMES = frozenset(
    (
        *SGMC_EVAPORITE_NAMES,
        *SGMC_CARBONATE_NAMES,
        *SGMC_MIXED_NAMES,
        *SGMC_COAL_NAMES,
        *SGMC_SILICEOUS_NAMES,
        *SGMC_CLASTIC_NAMES,
        *SGMC_CHEMICAL_OTHER_NAMES,
        *SGMC_SEDIMENTARY_GROUP_NAMES,
        *SGMC_BASIC_NAMES,
        *SGMC_INTERMEDIATE_NAMES,
        *SGMC_ACID_NAMES,
        *SGMC_CARBONATITE_NAMES,
        *SGMC_IGNEOUS_GROUP_NAMES,
        *SGMC_METAMORPHIC_NAMES,
        *SGMC_UNCONSOLIDATED_NAMES,
        *SGMC_TECTONITE_NAMES,
    ),
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
    if lith1 in ("Metamorphic", "Tectonite"):
        return "mt"
    finer = {lith2, lith3, lith4, lith5}
    if lith1 == "Sedimentary":
        if finer & set(SGMC_EVAPORITE_NAMES):
            return "ev"
        if finer & set(SGMC_CARBONATE_NAMES):
            if finer & set(SGMC_MIXED_NAMES):
                return "sm"
            return "sc"
        if finer & set(SGMC_COAL_NAMES):
            return "sm"
        if finer & (set(SGMC_SILICEOUS_NAMES) | set(SGMC_CLASTIC_NAMES)):
            return "ss"
        return "sm"
    if finer & set(SGMC_CARBONATITE_NAMES):
        return "sc"
    if finer & set(SGMC_BASIC_NAMES):
        return "vb" if lith2 == "Volcanic" else "pb"
    if finer & set(SGMC_INTERMEDIATE_NAMES):
        return "vi" if lith2 == "Volcanic" else "pi"
    if finer & set(SGMC_ACID_NAMES):
        return "va" if lith2 == "Volcanic" else "pa"
    return SGMC_LITH1_DEFAULTS[lith1]


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
    return [family_value(sgmc_family(*record)) for record in records]


# INSPIRE lithology classes of the EGDI raster by cell value; None leaves the cell to the base.
EGDI_TYPE_NAMES: dict[int, str | None] = {
    1: "vb",  # alkaliOlivineBasalt
    2: "mt",  # amphibolite
    3: "vi",  # andesite
    4: "pb",  # anorthositicRock
    5: "ss",  # arenite
    6: "py",  # ashBrecciaBombOrBlockTephra
    7: "py",  # ashTuffLapillistoneAndLapilliTuff
    8: "vb",  # basalt
    9: "vb",  # basanite
    10: "ss",  # biogenicSilicaSedimentaryRock
    11: "ss",  # breccia
    12: "mt",  # brecciaGougeSeries
    13: "su",  # carbonateMud
    14: "su",  # carbonateOoze
    15: "sc",  # carbonateSedimentaryRock
    16: None,  # carbonatite
    17: "sc",  # chalk
    18: "mt",  # chloriteActinoliteEpidoteMetamorphicRock
    19: "ss",  # clasticSandstone
    20: "su",  # clasticSediment
    21: "sm",  # clasticSedimentaryMaterial
    22: "ss",  # clasticSedimentaryRock
    23: "su",  # clay
    24: "ss",  # claystone
    25: "ss",  # conglomerate
    26: "va",  # dacite
    27: "sm",  # diamictite
    28: "su",  # diamicton
    29: "pi",  # diorite
    30: "pi",  # dioriticRock
    31: "vb",  # doleriticRock
    32: "sc",  # dolomite
    33: "sc",  # dolomiticOrMagnesianSedimentaryRock
    34: "mt",  # eclogite
    35: None,  # exoticCompositionIgneousRock
    36: None,  # fineGrainedIgneousRock
    37: "pi",  # foidBearingSyenite
    38: "pi",  # foidSyenitoid
    39: "mt",  # foliatedMetamorphicRock
    40: "py",  # fragmentalIgneousMaterial
    41: "pb",  # gabbro
    42: "pb",  # gabbroicRock
    43: "pb",  # gabbroid
    44: "mt",  # glaucophaneLawsoniteEpidoteMetamorphicRock
    45: "mt",  # gneiss
    46: "pa",  # granite
    47: "pa",  # granitoid
    48: "pa",  # granodiorite
    49: "mt",  # granulite
    50: "su",  # gravel
    51: "ev",  # gypsumOrAnhydrite
    52: "mt",  # hornfels
    53: None,  # igneousMaterial
    54: None,  # igneousRock
    55: None,  # impactGeneratedMaterial
    56: "su",  # impureCarbonateSediment
    57: "sm",  # impureCarbonateSedimentaryRock
    58: "sm",  # impureDolomite
    59: "sm",  # impureLimestone
    60: "vb",  # komatiiticRock
    61: "sc",  # limestone
    62: "mt",  # marble
    63: "mt",  # metamorphicRock
    64: "mt",  # metasomaticRock
    65: "mt",  # micaSchist
    66: "mt",  # migmatite
    67: "pa",  # monzogranite
    68: "pi",  # monzonite
    69: "su",  # mud
    70: "ss",  # mudstone
    71: "mt",  # myloniticRock
    72: "ss",  # nonClasticSiliceousSedimentaryRock
    73: "ss",  # organicBearingMudstone
    74: "su",  # organicRichSediment
    75: "sm",  # organicRichSedimentaryMaterial
    76: "mt",  # orthogneiss
    77: "mt",  # paragneiss
    78: "su",  # peat
    79: "pb",  # peridotite
    80: None,  # phaneriticIgneousRock
    81: "va",  # phonolite
    82: "mt",  # phyllite
    83: "mt",  # phyllonite
    84: None,  # porphyry
    85: "py",  # pyroclasticMaterial
    86: "py",  # pyroclasticRock
    87: "pb",  # pyroxenite
    88: "pi",  # quartzDiorite
    89: "mt",  # quartzite
    90: "su",  # residualMaterial
    91: "va",  # rhyolite
    92: "va",  # rhyolitoid
    93: None,  # rock
    94: "su",  # sand
    95: "ss",  # sandstone
    96: "mt",  # schist
    97: "su",  # sediment
    98: "sm",  # sedimentaryMaterial
    99: "sm",  # sedimentaryRock
    100: "mt",  # serpentinite
    101: "ss",  # shale
    102: "su",  # silicateMud
    103: "su",  # silt
    104: "ss",  # siltstone
    105: "mt",  # skarn
    106: "mt",  # slate
    107: "vb",  # spilite
    108: "pi",  # syenite
    109: "pi",  # syeniticRock
    110: "pa",  # syenogranite
    111: "vb",  # tephrite
    112: "vb",  # tholeiiticBasalt
    113: "pa",  # tonalite
    114: "va",  # trachyte
    115: "va",  # trachyticRock
    116: "va",  # trachytoid
    117: "sc",  # travertine
    118: "py",  # tuffBrecciaAgglomerateOrPyroclasticBreccia
    119: "pb",  # ultramaficIgneousRock
    120: "ss",  # wacke
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
        family_value(EGDI_TYPE_NAMES[value]) if EGDI_TYPE_NAMES[value] else None
        for value in values
    ]

