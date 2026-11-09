"""Classify regional geology ingest records using the published country name tables."""
from ..geology_age import TIMELINE, smallest_containing_class
from ..geology_type import GLIM_VALUES
from .geology_names import (
    CANADA_EPOCH_NAMES,
    CANADA_ERA_NAMES,
    CANADA_PERIOD_NAMES,
    CANADA_RXTP_FALLBACK,
    CANADA_TYPE_NAMES,
    EGDI_TYPE_NAMES,
    GMNA_AGE_ALIASES,
    GMNA_PRE_RANGES,
    GMNA_TYPE_HIERARCHIES,
    IGME_AGE_SIDES,
    IGME_IGNE_FALLBACK,
    IGME_MARI_FALLBACK,
    IGME_TYPE_NAMES,
    NO_DATA_NAMES,
    SGMC_ACID_NAMES,
    SGMC_BASE_NAMES,
    SGMC_BASIC_NAMES,
    SGMC_CARBONATE_CLASSES,
    SGMC_CARBONATITE_NAMES,
    SGMC_CHEMICAL_OTHER_NAMES,
    SGMC_CLASTIC_COARSE_NAMES,
    SGMC_CLASTIC_FINE_NAMES,
    SGMC_CLASTIC_MIXED_NAMES,
    SGMC_COAL_NAMES,
    SGMC_EVAPORITE_NAMES,
    SGMC_EVAPORITE_PURE_NAMES,
    SGMC_IGNEOUS_GROUP_NAMES,
    SGMC_INTERMEDIATE_NAMES,
    SGMC_KNOWN_NAMES,
    SGMC_LITH1_DEFAULTS,
    SGMC_METAMORPHIC_CLASSES,
    SGMC_METAMORPHIC_NAMES,
    SGMC_MIXED_FINE_NAMES,
    SGMC_MIXED_NAMES,
    SGMC_SEDIMENTARY_GROUP_NAMES,
    SGMC_SILICEOUS_NAMES,
    SGMC_STAGE_PERIODS,
    SGMC_TECTONITE_NAMES,
    SGMC_UNCONSOLIDATED_COARSE_NAMES,
    SGMC_UNCONSOLIDATED_FINE_NAMES,
    SGMC_UNCONSOLIDATED_MIXED_NAMES,
    SGMC_UNCONSOLIDATED_ORGANIC_NAMES,
    SIM3340_AGE_ALIASES,
    SIM3340_LITHOLOGY_ALIASES,
)


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


def _normalize_igme_range(agename: str) -> list[str]:
    """Collapse "Early - Middle X" style ranges onto X, since a bare qualifier names no unit."""
    sides = _split_igme_range(agename)
    if len(sides) == 2 and all(side.split()[0] in ("Early", "Middle", "Late") for side in sides):
        first, second = sides[0].split(), sides[1].split()
        if len(first) == 1 and len(second) == 2:
            return [second[1]]
    return sides


def _split_igme_range(agename: str) -> list[str]:
    """Return the one or two side names of an AgeName range."""
    return [side.strip() for side in agename.split(" - ")]


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


def _sgmc_age_value(age_min: str, age_max: str) -> int | None:
    young = _sgmc_base(_sgmc_leaf(age_min))
    old = _sgmc_base(_sgmc_leaf(age_max))
    if young is None and old is None:
        return None
    oldest = (old or young)[0]
    newest = (young or old)[1]
    return smallest_containing_class(*_timeline_span(oldest, newest))


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

    Names that give no grain size fall back to the mixed-grain class. The levels run from the
    most to the least specific, so a carbonate leaf such as Coquina decides the class before
    its Limestone ancestor does.
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


def sim3340_age_batch(records: list[tuple[str, str]]) -> list[int | None]:
    """Return the age class of each (full_min, full_max) pair of Alaska age paths.

    The paths run from the eon down to the finest name, separated by semicolons, and the finest
    name decides like an SGMC leaf. A name missing from the SGMC and alias tables fails the whole
    call and lists every such name.
    """
    leaves = [(_sim3340_leaf(young), _sim3340_leaf(old)) for young, old in records]
    return sgmc_age_batch(leaves)


def _sim3340_leaf(path: str) -> str:
    leaf = path.split(";")[-1].strip()
    return SIM3340_AGE_ALIASES.get(leaf, leaf)


def sim3340_type_batch(records: list[tuple[str, str, str, str, str]]) -> list[int | None]:
    """Return the rock-type class of each Alaska LITH1 to LITH5 hierarchy, None for water.

    Alaska spellings that differ from SGMC are aliased first, and any other name missing from
    the SGMC vocabulary fails the whole call and lists every such name.
    """
    land = [_aliased_hierarchy(record) for record in records if record[0] != "Water"]
    values = iter(sgmc_type_batch(land))
    return [None if record[0] == "Water" else next(values) for record in records]


def _aliased_hierarchy(record: tuple[str, str, str, str, str]) -> tuple[str, str, str, str, str]:
    lith1, *finer = record
    lith2, lith3, lith4, lith5 = (SIM3340_LITHOLOGY_ALIASES.get(name, name) for name in finer)
    return lith1, lith2, lith3, lith4, lith5


def gmna_age_batch(records: list[tuple[str, str]]) -> list[int | None]:
    """Return the age class of each (min_age, max_age) pair of GMNA names, None for no age.

    MIN_AGE names the younger bound and MAX_AGE the older one like SGMC. Bounds that share
    one Pre- name expand to its whole span, and any other name missing from the SGMC and
    alias tables fails the whole call and lists every such name.
    """
    expanded = [_gmna_expanded(young, old) for young, old in records]
    leaves = [(_gmna_leaf(young), _gmna_leaf(old)) for young, old in expanded]
    return sgmc_age_batch(leaves)


def _gmna_expanded(young: str, old: str) -> tuple[str, str]:
    if young == old and young in GMNA_PRE_RANGES:
        return GMNA_PRE_RANGES[young]
    return young, old


def _gmna_leaf(name: str) -> str:
    return GMNA_AGE_ALIASES.get(name, name)


def gmna_type_batch(records: list[tuple[str, str]]) -> list[int | None]:
    """Return the rock-type class of each (rocktype, lithology) pair of GMNA units.

    Every pair must belong to the verified archive vocabulary, so a new spelling fails the
    whole call and lists every such pair before any COG is published.
    """
    unmapped = {
        f"{rocktype} with {lithology or 'no lithology'}"
        for rocktype, lithology in records
        if (rocktype, lithology or "") not in GMNA_TYPE_HIERARCHIES
    }
    _fail_unmapped("GMNA rock names", unmapped)
    hierarchies = [
        (*GMNA_TYPE_HIERARCHIES[(rocktype, lithology or "")], "", "")
        for rocktype, lithology in records
    ]
    return sgmc_type_batch(hierarchies)


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


def _timeline_span(oldest: str, newest: str) -> tuple[str, str]:
    """Return the span ordered oldest to newest, whatever order the names come in."""
    if TIMELINE.index(oldest) <= TIMELINE.index(newest):
        return oldest, newest
    return newest, oldest


def _fail_unmapped(what: str, unmapped: set[str]) -> None:
    if unmapped:
        raise ValueError(f"{what} without a class: {sorted(unmapped)}")
