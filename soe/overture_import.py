"""Load one Overture Maps divisions release into SQLite as boundary rows at five levels.

Countries and dependencies become `country`, regions `state`, counties `county`, and local
administrative units `municipality`. Towns, cities, and large villages that are not municipalities
become `city`, which a separate pass can replace without redoing the rest. A DuckDB fetch layer
reads the release from S3, and the rest turns plain records into rows, so it runs without a
network.
"""

import http.client
import json
import math
import re
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from collections import Counter, defaultdict
from collections.abc import Callable, Iterable, Iterator
from dataclasses import dataclass
from itertools import islice, zip_longest
from pathlib import Path
from typing import Protocol

import shapely
from shapely.errors import GEOSException
from shapely.geometry import shape
from shapely.geometry.base import BaseGeometry

from . import db
from .boundary_import import (
    OSM_LEVELS_SCHEMA,
    DisputedRow,
    PartRow,
    _add_overture_columns,
    _row,
    relabel_ucdb_as_urban,
    store_overture,
)
from .country_codes import ALPHA3_BY_ALPHA2
from .sources.licences import SOURCES

OVERTURE_SOURCE = "Overture Maps divisions"
OVERTURE_LICENCE = "ODbL 1.0"

RELEASE_PATTERN = re.compile(r"\d{4}-\d{2}-\d{2}\.\d+")
RELEASE_URL = "s3://overturemaps-us-west-2/release"
S3_REGION = "us-west-2"
DUCKDB_MEMORY_LIMIT = "6GB"
AREA_FETCH_ROWS = 1000

LEVEL_ORDER = ("country", "state", "county", "municipality")
CITY_LEVEL = "city"
LEVEL_BY_SUBTYPE = {
    "country": "country",
    "dependency": "country",
    "region": "state",
    "county": "county",
    "localadmin": "municipality",
}
COUNTRY_SUBTYPES = ("country", "dependency")
RELATION_PARENT_SUBTYPES = ("county", "region")
DISPUTED_LEVEL_BY_SUBTYPE = {"country": "country", "region": "state"}

# About 5 m, under a pixel at zoom 14, and equal for neighbours so their edges stay shared.
SIMPLIFY_TOLERANCE_DEG = 5e-5

# A parent's municipalities count as tiling it when at least two of them cover about all of it.
MIN_TILING_CHILDREN = 2
MIN_TILING_AREA_RATIO = 0.9
MAX_TILING_AREA_RATIO = 1.1

# Villages this size serve as towns, so the city pass keeps them.
CITY_LOCAL_TYPES = ("city", "town")
VILLAGE_LOCAL_TYPE = "village"
MIN_VILLAGE_POPULATION = 5_000
MIN_CITY_AREA_KM2 = 1
MAX_DUPLICATE_IOU = 0.9  # shared share of the union that makes a city a municipality's twin
KM_PER_DEGREE = 111.32

# One scene grid has one longitude window, and the country itself must fill most of the grid.
COMBINED_MAX_WIDTH_DEG = 180
COMBINED_MIN_MAIN_SHARE = 0.5
COMBINED_ID_SUFFIX = "+overseas"
MAX_NAMED_DEPENDENCIES = 3

# Overture lists one source entry per property, so a division can have dozens from the same dataset.
CREDITS = "list_transform(sources, lambda s: s.dataset || '|' || coalesce(s.license, ''))"
OSM_RELATIONS = (
    "list_filter(sources, lambda s: s.dataset = 'OpenStreetMap' AND s.record_id LIKE 'r%')"
)

OVERPASS_URL = "https://overpass-api.de/api/interpreter"
OVERPASS_STATUS_URL = OVERPASS_URL.removesuffix("interpreter") + "status"
OVERPASS_USER_AGENT = "scenes-of-earth/0.1 (boundary import)"
OVERPASS_BATCH_IDS = 500
OVERPASS_PAUSE_SECS = 5
OVERPASS_TIMEOUT_SECS = 180
OVERPASS_MAX_TRIES = 8
OVERPASS_RETRY_DELAY_SECS = 30
OVERPASS_RETRY_MAX_DELAY_SECS = 5 * 60
OVERPASS_STATUS_TIMEOUT_SECS = 15
OVERPASS_SLOT_FREE_WAIT_SECS = 5
OVERPASS_SLOT_MARGIN_SECS = 2
OVERPASS_RETRY_STATUS_CODES = frozenset({429, 502, 503, 504})

# Relations of one kind in one country nearly always share an admin level, so a sample stands in.
LEVEL_SAMPLE_SIZE = 10

Bounds = tuple[float, float, float, float]  # west, south, east, north
Credit = tuple[str, str]  # contributing dataset name, its licence as Overture names it
LevelGroup = tuple[str, str, str | None]  # country, our level, local unit kind


@dataclass(frozen=True)
class Division:
    """One Overture division, without geometry."""

    id: str
    country: str | None  # ISO 3166-1 alpha-2, a dependency's own code
    subtype: str
    parent_id: str | None
    region_code: str | None  # ISO 3166-2
    primary_name: str | None
    common_names: dict[str, str]
    local_type: str | None
    record_id: str | None  # OpenStreetMap relation record from any source entry, such as r123@45
    credits: frozenset[Credit] = frozenset()
    population: int | None = None


@dataclass(frozen=True)
class DivisionArea:
    """One area row of a division, which has a land row and often a maritime row."""

    division_id: str
    is_maritime: bool
    geometry: BaseGeometry
    credits: frozenset[Credit] = frozenset()


@dataclass(frozen=True)
class DisputedLine:
    """A boundary line that two countries or regions both claim."""

    id: str
    subtype: str
    geometry: BaseGeometry


class DivisionSource(Protocol):
    """Where divisions come from; the DuckDB source reads a release and tests build their own."""

    def divisions(self) -> list[Division]: ...

    def cities(self) -> list[Division]: ...

    def divisions_by_id(self, ids: list[str]) -> list[Division]: ...

    def areas(self, country: str, subtypes: tuple[str, ...]) -> Iterator[DivisionArea]: ...

    def disputed_lines(self) -> list[DisputedLine]: ...


def import_overture(
    db_path: Path | str,
    source: DivisionSource,
    fetch_levels: Callable[[list[int]], dict[int, int | None]] | None = None,
) -> Counter[str]:
    """Replace the Overture boundaries with the divisions of `source`.

    The OpenStreetMap admin levels of a sample of each group of relations are fetched in a
    background thread while the geometry is read, and the rest of each group takes the sample's
    level. When fetching fails, the rows without a level keep none and `update_overture_levels`
    fills them later. `fetch_levels` stands in for Overpass in tests. Returns the number of rows
    stored per level.
    """
    catalog = Catalog(source.divisions())
    levels = _BackgroundLevels(db_path, catalog, fetch_levels or _fetch_overpass_levels)

    try:
        rows = _RowBuilder(source, catalog).rows()
        disputed = [_disputed_row(line) for line in source.disputed_lines()]
        stored = store_overture(
            db_path, OVERTURE_SOURCE, rows, catalog.parts(), disputed, levels.wait
        )
    finally:
        levels.stop()

    fill_levels(db_path, catalog)
    if levels.error:
        print(
            f"{levels.error}\nResume the admin levels with import-boundaries --overture-levels "
            "<release>"
        )

    cities = _replace_cities(db_path, source, catalog, _stored_division_ids(db_path), fetch_levels)
    if cities:
        stored[CITY_LEVEL] = sum(cities.values())

    return stored


def import_overture_cities(
    db_path: Path | str,
    source: DivisionSource,
    fetch_levels: Callable[[list[int]], dict[int, int | None]] | None = None,
) -> Counter[str]:
    """Replace the Overture city rows, leaving every other level as it is.

    A city is a locality of any record type that is a city or town, or a village of at least
    MIN_VILLAGE_POPULATION people. It is left out when it is already stored as a municipality,
    when it covers the same place as one, or when it is under MIN_CITY_AREA_KM2. The admin levels of
    the relations are fetched before any geometry, so a failed fetch costs little. Moves the UCDB
    rows from `city` to `urban` first. Returns the rows stored per country and prints a summary.
    """
    stored_ids = _stored_division_ids(db_path)
    if not stored_ids:
        raise SystemExit("Import the Overture divisions with --overture before the cities")

    catalog = Catalog(source.divisions())
    return _replace_cities(db_path, source, catalog, stored_ids, fetch_levels)


def _replace_cities(
    db_path: Path | str,
    source: DivisionSource,
    catalog: "Catalog",
    stored_ids: set[str],
    fetch_levels: Callable[[list[int]], dict[int, int | None]] | None,
) -> Counter[str]:
    relabel_ucdb_as_urban(db_path)
    candidates = source.cities()
    catalog = catalog.with_ancestors(_missing_ancestors(source, catalog, candidates))
    cities = [
        city
        for city in candidates
        if is_city(city) and city.country and catalog.row_id(city) not in stored_ids
    ]
    record_ids = [city.record_id for city in cities if city.record_id]
    cached_admin_levels(db_path, record_ids, fetch_levels or _fetch_overpass_levels)

    builder = _CityRows(source, catalog, db_path, stored_ids)
    store_overture(
        db_path, OVERTURE_SOURCE, builder.rows(cities), [], [], lambda: None, levels=(CITY_LEVEL,)
    )
    print(builder.summary())

    return builder.per_country


def _missing_ancestors(
    source: DivisionSource, catalog: "Catalog", candidates: list[Division]
) -> list[Division]:
    """The ancestors of the candidates that the catalog lacks, following parent links.

    The divisions feed only holds relation localities, so a city under a way-sourced locality
    would otherwise lose its parent and state. Each missing id is requested at most once, even
    when the source never returns it, so an absent ancestor ends the walk instead of the import.
    """
    found: dict[str, Division] = {}
    requested: set[str] = set()
    while wanted := _parents_to_fetch(catalog, candidates, found, requested):
        requested.update(wanted)
        for division in source.divisions_by_id(sorted(wanted)):
            if not catalog.has(division.id):
                found.setdefault(division.id, division)

    return list(found.values())


def _parents_to_fetch(
    catalog: "Catalog", candidates: list[Division], found: dict[str, Division], requested: set[str]
) -> set[str]:
    """Parent ids along the candidates' chains that are neither known nor already requested.

    Each chain is followed through the catalog and the fetched entries until it ends, reaches
    an id the source never returned, or meets a parent that is still unfetched.
    """
    missing: set[str] = set()
    for candidate in candidates:
        current: Division | None = candidate
        seen = {candidate.id}
        while current is not None and current.parent_id and current.parent_id not in seen:
            seen.add(current.parent_id)
            parent_id = current.parent_id
            if catalog.has(parent_id):
                current = catalog.parent(current)
            elif parent_id in found:
                current = found[parent_id]
            else:
                if parent_id not in requested:
                    missing.add(parent_id)

                break

    return missing


def is_city(division: Division) -> bool:
    """Whether a locality is a city, a town, or a village big enough to count as one."""
    if division.subtype != "locality":
        return False
    if division.local_type in CITY_LOCAL_TYPES:
        return True

    return division.local_type == VILLAGE_LOCAL_TYPE and (
        (division.population or 0) >= MIN_VILLAGE_POPULATION
    )


def _stored_division_ids(db_path: Path | str) -> set[str]:
    """Ids of the stored Overture rows above the city level, which a city must not repeat."""
    with db.connect(db_path) as connection:
        return {
            row["id"]
            for row in connection.execute(
                "SELECT id FROM boundaries WHERE source = ? AND level != ?",
                (OVERTURE_SOURCE, CITY_LEVEL),
            )
        }


def update_overture_levels(
    db_path: Path | str,
    source: DivisionSource,
    fetch_levels: Callable[[list[int]], dict[int, int | None]] | None = None,
    full: bool = False,
) -> int:
    """Fill the empty or sampled border_level of the stored Overture rows, without geometry.

    Without `full` only a sample of each group is fetched. With it every such row gets its own
    relation's level and loses the sampled mark. Only levels not cached yet are fetched, in
    batches that are kept as they arrive, so a failed run resumes where it stopped. Returns the
    number of rows that got a level.
    """
    catalog = Catalog(source.divisions())
    fetch = fetch_levels or _fetch_overpass_levels
    # An import from before the sampled mark existed lacks its column.
    with db.connect(db_path) as connection:
        _add_overture_columns(connection)

    if full:
        open_rows = _open_row_ids(db_path)
        record_ids = [
            division.record_id
            for divisions in catalog.relation_groups().values()
            for division in divisions
            if open_rows.intersection(catalog.row_ids(division))
        ]
        cached_admin_levels(db_path, record_ids, fetch)
    else:
        fetch_sampled_levels(db_path, catalog, fetch)

    return fill_levels(db_path, catalog, exact=full)


def fetch_sampled_levels(
    db_path: Path | str,
    catalog: "Catalog",
    fetch_levels: Callable[[list[int]], dict[int, int | None]],
    stop: threading.Event | None = None,
) -> None:
    """Cache the levels of a sample of each group.

    A group whose sample mixes is split by state and sampled again per state. Only a state whose
    own sample mixes is fetched whole.
    """
    groups = catalog.relation_groups()
    _cache_samples(db_path, list(groups.values()), fetch_levels, stop)

    cached = _read_cached_levels(db_path)
    states: list[tuple[str, list[Division]]] = []
    for key, divisions in groups.items():
        if len(_known_levels(divisions, cached)) < 2:
            continue

        label = " ".join(part for part in key if part)
        parts = _state_subgroups(catalog, divisions)
        print(f"{label}: mixed, splitting into {len(parts):,} states")
        states += [(f"{label} {name}", members) for name, members in parts]

    _cache_samples(db_path, [members for _, members in states], fetch_levels, stop)

    cached = _read_cached_levels(db_path)
    record_ids: list[str] = []
    mixed_states = 0
    for name, members in states:
        if len(_known_levels(members, cached)) < 2:
            continue

        ids = [division.record_id for division in members]
        missing = len(set(ids) - cached.keys())
        print(f"{name}: mixed sample, fetching {missing:,}")
        record_ids += ids
        mixed_states += 1

    if not mixed_states:
        return

    total = len(set(record_ids) - cached.keys())
    print(f"Fetching {total:,} relations for {mixed_states:,} mixed states")
    cached_admin_levels(db_path, record_ids, fetch_levels, stop)


def _cache_samples(
    db_path: Path | str,
    groups: list[list[Division]],
    fetch_levels: Callable[[list[int]], dict[int, int | None]],
    stop: threading.Event | None,
) -> None:
    records = [division.record_id for group in groups for division in _spread_sample(group)]
    cached_admin_levels(db_path, records, fetch_levels, stop)


def _state_subgroups(
    catalog: "Catalog", divisions: list[Division]
) -> list[tuple[str, list[Division]]]:
    """The divisions split by their state, with those that have none in a group of their own."""
    by_state: dict[str, list[Division]] = {}
    names: dict[str, str] = {}
    for division in divisions:
        state = catalog.state(division)
        state_id = state.id if state else ""
        names[state_id] = catalog.name(state) if state else "without state"
        by_state.setdefault(state_id, []).append(division)

    return [(names[state_id], members) for state_id, members in by_state.items()]


def fill_levels(db_path: Path | str, catalog: "Catalog", exact: bool = False) -> int:
    """Set border_level on the rows that have none or a sampled one, from the cached levels.

    A row takes its own relation's level when cached. Otherwise it takes the group's level when
    the sample of its group, or of its state when the group's sample mixes, agrees on one, marked
    as sampled. With `exact` only own levels count. Returns the number of rows that got a level
    and prints totals.
    """
    cached = _read_cached_levels(db_path)
    open_rows = _open_row_ids(db_path)
    groups = catalog.relation_groups()
    updates: list[tuple[int | None, int, str]] = []
    sampled = mixed = units = 0
    for group in groups.values():
        for divisions in _level_units(catalog, group, cached):
            sample = _spread_sample(divisions)
            sample_levels = _known_levels(divisions, cached)
            units += 1
            sampled += len(sample)
            mixed += len(sample_levels) > 1
            shared = next(iter(sample_levels)) if len(sample_levels) == 1 else None
            for division in divisions:
                own = cached.get(division.record_id)
                use_shared = own is None and not exact and shared is not None
                level = shared if use_shared else own
                updates += [
                    (level, int(use_shared), row_id)
                    for row_id in catalog.row_ids(division)
                    if row_id in open_rows
                ]

    with db.connect(db_path) as connection:
        connection.execute("BEGIN")
        connection.executemany(
            "UPDATE boundaries SET border_level = ?, border_level_sampled = ? WHERE id = ?", updates
        )
        connection.execute("COMMIT")

    filled = sum(level is not None for level, _, _ in updates)
    print(
        f"Admin levels: {units:,} groups, {sampled:,} relations sampled, {mixed:,} mixed, "
        f"{filled:,} rows filled, {len(updates) - filled:,} rows without a level"
    )

    return filled


def _level_units(
    catalog: "Catalog", divisions: list[Division], cached: dict[str, int | None]
) -> list[list[Division]]:
    """The group itself when its known levels agree, else its states."""
    if len(_known_levels(divisions, cached)) < 2:
        return [divisions]

    return [members for _, members in _state_subgroups(catalog, divisions)]


def _open_row_ids(db_path: Path | str) -> set[str]:
    """Ids of the Overture rows whose border_level is empty or copied from a sample."""
    with db.connect(db_path) as connection:
        return {
            row["id"]
            for row in connection.execute(
                "SELECT id FROM boundaries WHERE source = ? "
                "AND (border_level IS NULL OR border_level_sampled = 1)",
                (OVERTURE_SOURCE,),
            )
        }


def _spread_sample(divisions: list[Division]) -> list[Division]:
    """Up to LEVEL_SAMPLE_SIZE divisions, using every parent once before any parent twice."""
    by_parent: defaultdict[str, list[Division]] = defaultdict(list)
    for division in divisions:
        by_parent[division.parent_id or ""].append(division)

    rounds = zip_longest(*(by_parent[parent_id] for parent_id in sorted(by_parent)))
    spread = (division for one_round in rounds for division in one_round if division)

    return list(islice(spread, LEVEL_SAMPLE_SIZE))


def _known_levels(divisions: list[Division], cached: dict[str, int | None]) -> set[int]:
    """Every cached level of the group, so an agreeing sample can't hide a mix."""
    return {
        level for division in divisions if (level := cached.get(division.record_id)) is not None
    }


def open_release(release: str) -> DivisionSource:
    """The source of `release`, such as '2026-10-21.0'.

    A malformed release, an absent release, or one that differs from the release credited in
    the licence table exits. Callers open the release before writing anything, so a bad name
    leaves the database alone.
    """
    if not RELEASE_PATTERN.fullmatch(release):
        raise SystemExit(f"Overture release '{release}' must look like 2026-10-21.0")

    credited = SOURCES[OVERTURE_SOURCE]["version"]
    if release != credited:
        # Bundles credit this release, so a new release updates the licence table first.
        raise SystemExit(
            f"Overture release '{release}' differs from the credited release '{credited}'. "
            "Bump the SOURCES entry in soe/sources/licences.py together with the import."
        )

    return DuckDbSource(release)


class Catalog:
    """Levels, ids, names and parents of all divisions, which fit in memory without geometry."""

    def __init__(self, divisions: Iterable[Division]) -> None:
        self._by_id = {division.id: division for division in divisions}
        self._localadmin_countries = {
            division.country
            for division in self._by_id.values()
            if division.subtype == "localadmin"
        }
        self._region_code_counts = Counter(
            division.region_code
            for division in self._by_id.values()
            if division.subtype == "region" and division.region_code
        )
        self._levels: dict[str, str] = {}
        self._by_country_level: defaultdict[tuple[str, str], list[Division]] = defaultdict(list)
        for division in sorted(self._by_id.values(), key=lambda division: division.id):
            level = self._level(division)
            # A few Overture divisions have no country, so no area can be fetched for them.
            if level and division.country:
                self._levels[division.id] = level
                self._by_country_level[(division.country, level)].append(division)

    def _level(self, division: Division) -> str | None:
        if division.subtype in LEVEL_BY_SUBTYPE:
            return LEVEL_BY_SUBTYPE[division.subtype]

        # Localities stand in for municipalities only where no country-wide localadmin layer exists.
        parent = self._by_id.get(division.parent_id or "")
        is_relation = (division.record_id or "").startswith("r")
        if (
            division.subtype == "locality"
            and is_relation
            and parent is not None
            and parent.subtype in RELATION_PARENT_SUBTYPES
            and division.country not in self._localadmin_countries
        ):
            return "municipality"

        return None

    def with_ancestors(self, divisions: list[Division]) -> "Catalog":
        """A catalog that also holds these divisions, such as a city's missing ancestors."""
        if not divisions:
            return self

        return Catalog([*self._by_id.values(), *divisions])

    def country_codes(self) -> list[str]:
        """Alpha-2 codes that have at least one division to import, in order."""
        return sorted({code for code, _ in self._by_country_level})

    def divisions_at(self, country: str, level: str) -> list[Division]:
        """The divisions of one country and level, municipalities before the tiling filter."""
        return self._by_country_level[(country, level)]

    def relation_groups(self) -> dict[LevelGroup, list[Division]]:
        """The divisions with an OpenStreetMap relation per country, level, and local unit kind."""
        groups: defaultdict[LevelGroup, list[Division]] = defaultdict(list)
        for division in sorted(self._relation_divisions(), key=lambda division: division.id):
            groups[(division.country, self._levels[division.id], self.kind(division))].append(
                division
            )

        return groups

    def row_ids(self, division: Division) -> list[str]:
        """The ids of the rows of `division`, with a merged country area using its country's."""
        row_id = self.row_id(division)
        if division.subtype == "country":
            return [row_id, f"{row_id}{COMBINED_ID_SUFFIX}"]

        return [row_id]

    def _relation_divisions(self) -> list[Division]:
        return [
            division
            for division_id, division in self._by_id.items()
            if division_id in self._levels and (division.record_id or "").startswith("r")
        ]

    def row_id(self, division: Division) -> str:
        """`ovt:FR` for a country, `ovt:FR-BRE` for a region with a unique code, else GERS id."""
        if division.subtype in COUNTRY_SUBTYPES:
            return f"ovt:{division.country}"

        code = division.region_code
        if division.subtype == "region" and code and self._region_code_counts[code] == 1:
            return f"ovt:{code}"

        return f"ovt:{division.id}"

    def name(self, division: Division) -> str:
        """The English name, else the name in the local language."""
        return division.common_names.get("en") or division.primary_name or ""

    def parent(self, division: Division) -> Division | None:
        return self._by_id.get(division.parent_id or "")

    def has(self, division_id: str) -> bool:
        """Whether the catalog holds the division with this id."""
        return division_id in self._by_id

    def state(self, division: Division) -> Division | None:
        """The nearest region above `division`."""
        ancestor = self.parent(division)
        while ancestor is not None and ancestor.subtype != "region":
            ancestor = self.parent(ancestor)

        return ancestor

    def kind(self, division: Division) -> str | None:
        """The local unit type, such as 'Civil parish', or None when it only repeats the subtype."""
        if division.subtype == "locality":
            return "Municipality"
        if not division.local_type or division.local_type == division.subtype:
            return None

        return division.local_type.replace("_", " ").capitalize()

    def sovereigns(self) -> list[tuple[Division, list[Division]]]:
        """Each country that has dependencies with them, ordered by code."""
        dependencies: defaultdict[str, list[Division]] = defaultdict(list)
        for division in self._by_id.values():
            parent = self.parent(division)
            if division.subtype == "dependency" and parent is not None:
                dependencies[parent.id].append(division)

        return [
            (self._by_id[sovereign_id], sorted(parts, key=lambda part: part.country))
            for sovereign_id, parts in sorted(
                dependencies.items(), key=lambda item: self._by_id[item[0]].country
            )
        ]

    def parts(self) -> list[PartRow]:
        """Per country with dependencies, its own area first and then each dependency's."""
        return [
            (self.row_id(sovereign), position, self.row_id(part))
            for sovereign, dependencies in self.sovereigns()
            for position, part in enumerate([sovereign, *dependencies])
        ]


@dataclass(frozen=True)
class _Part:
    """What a merged area needs from one member after its own row is built."""

    geometry: BaseGeometry
    has_maritime: bool
    credits: frozenset[Credit]


class _RowBuilder:
    """Builds the rows country by country, so only one country's geometry is in memory."""

    def __init__(self, source: DivisionSource, catalog: Catalog) -> None:
        self._source = source
        self._catalog = catalog
        self._sovereigns = catalog.sovereigns()
        self._part_ids = {
            member.id for sovereign, parts in self._sovereigns for member in (sovereign, *parts)
        }
        self._parts: dict[str, _Part] = {}

    def rows(self) -> Iterator[db.BoundaryValues | None]:
        for code in self._catalog.country_codes():
            # A municipality's tiling filter compares it with its county or region, loaded earlier.
            land_areas: dict[str, float] = {}
            for level in LEVEL_ORDER:
                yield from self._level_rows(code, level, land_areas)

        yield from self._combined_rows()

    def _level_rows(
        self, code: str, level: str, land_areas: dict[str, float]
    ) -> Iterator[db.BoundaryValues | None]:
        divisions = self._catalog.divisions_at(code, level)
        if not divisions:
            return

        areas = self._load_areas(code, divisions, land_areas)
        if level == "municipality":
            divisions = self._tiling_divisions(code, divisions, land_areas)

        divisions = [division for division in divisions if division.id in areas]
        geometries = _simplified([areas[division.id].geometry for division in divisions])
        for division, geometry in zip(divisions, geometries, strict=True):
            area = areas[division.id]
            credits = division.credits | area.credits
            if division.id in self._part_ids:
                self._parts[division.id] = _Part(geometry, area.is_maritime, credits)

            yield _overture_row(
                self._catalog,
                division,
                level,
                geometry,
                area,
                credits,
                parent=self._catalog.parent(division),
                kind=self._catalog.kind(division),
                aliases=sorted(set(division.common_names.values())),
            )

    def _load_areas(
        self, code: str, divisions: list[Division], land_areas: dict[str, float]
    ) -> dict[str, DivisionArea]:
        """The area to store per division, noting its land area for the tiling filter."""
        wanted = {division.id for division in divisions}
        subtypes = tuple({division.subtype for division in divisions})
        rows: defaultdict[str, list[DivisionArea]] = defaultdict(list)
        for area in self._source.areas(code, subtypes):
            if area.division_id in wanted:
                rows[area.division_id].append(area)

        for division_id, division_rows in rows.items():
            land_areas[division_id] = _land_row(division_rows).geometry.area

        return {
            division_id: _preferred_area(division_rows)
            for division_id, division_rows in rows.items()
        }

    def _tiling_divisions(
        self, code: str, divisions: list[Division], land_areas: dict[str, float]
    ) -> list[Division]:
        kept, dropped_parents = tiling_municipalities(divisions, land_areas)
        if dropped_parents == 1:
            print(f"{code}: 1 parent dropped, its municipalities do not tile it")
        elif dropped_parents:
            print(
                f"{code}: {dropped_parents} parents dropped, their municipalities do not tile them"
            )

        return kept

    def _combined_rows(self) -> Iterator[db.BoundaryValues | None]:
        """One merged area for each country whose dependencies sit close to it."""
        for sovereign, dependencies in self._sovereigns:
            members = [sovereign, *dependencies]
            if any(member.id not in self._parts for member in members):
                continue

            parts = [self._parts[member.id] for member in members]
            if not is_compact([part.geometry.bounds for part in parts]):
                continue

            row_id = f"{self._catalog.row_id(sovereign)}{COMBINED_ID_SUFFIX}"
            yield self._combined_row(row_id, sovereign, dependencies, parts)

    def _combined_row(
        self, row_id: str, sovereign: Division, dependencies: list[Division], parts: list[_Part]
    ) -> db.BoundaryValues | None:
        credits = frozenset().union(*(part.credits for part in parts))
        name = _with_dependencies(
            self._catalog.name(sovereign), [self._catalog.name(part) for part in dependencies]
        )
        row = _row(
            row_id,
            level="country",
            name=name,
            parent="",
            iso3=ALPHA3_BY_ALPHA2.get(sovereign.country),
            geometry=shapely.union_all([part.geometry for part in parts]),
            source=OVERTURE_SOURCE,
            licence=_licence_text(credits),
        )
        if row is None:
            return None

        local_name = _with_dependencies(
            sovereign.primary_name or "",
            [part.primary_name or self._catalog.name(part) for part in dependencies],
        )
        return (
            *row,
            local_name,
            None,
            None,
            None,
            int(all(part.has_maritime for part in parts)),
            None,
            json.dumps([]),
            _contributors_text(credits),
            0,
            sovereign.record_id,
        )


class _CityRows:
    """Builds the city rows country by country, counting the localities it leaves out."""

    def __init__(
        self, source: DivisionSource, catalog: Catalog, db_path: Path | str, stored_ids: set[str]
    ) -> None:
        self.per_country: Counter[str] = Counter()
        self._source = source
        self._catalog = catalog
        self._db_path = db_path
        self._stored_ids = stored_ids
        self._too_small = 0
        self._duplicates = 0

    def rows(self, cities: list[Division]) -> Iterator[db.BoundaryValues | None]:
        by_country: defaultdict[str, list[Division]] = defaultdict(list)
        for city in cities:
            by_country[city.country].append(city)

        for code in sorted(by_country):
            yield from self._country_rows(code, {city.id: city for city in by_country[code]})

    def summary(self) -> str:
        countries = ", ".join(f"{code} {count:,}" for code, count in self.per_country.most_common())
        return (
            f"Cities per country: {countries or 'none'}\n"
            f"Left out: {self._too_small:,} under {MIN_CITY_AREA_KM2} km2, "
            f"{self._duplicates:,} repeating a municipality"
        )

    def _country_rows(
        self, code: str, cities: dict[str, Division]
    ) -> Iterator[db.BoundaryValues | None]:
        municipalities = self._stored_municipalities(code)
        for area in self._source.areas(code, ("locality",)):
            city = cities.get(area.division_id)
            if city is None:
                continue

            geometry = area.geometry.simplify(SIMPLIFY_TOLERANCE_DEG)
            if _area_km2(geometry) < MIN_CITY_AREA_KM2:
                self._too_small += 1
                continue

            if _repeats_a_shape(geometry, municipalities):
                self._duplicates += 1
                continue

            row = self._city_row(city, geometry, area)
            if row is not None:
                self.per_country[code] += 1

            yield row

    def _stored_municipalities(self, code: str) -> shapely.STRtree:
        iso3 = ALPHA3_BY_ALPHA2.get(code)
        with db.connect(self._db_path) as connection:
            texts = connection.execute(
                "SELECT geom_geojson FROM boundaries WHERE source = ? AND level = 'municipality' "
                "AND iso3 = ?",
                (OVERTURE_SOURCE, iso3),
            )
            return shapely.STRtree([shape(json.loads(text[0])) for text in texts])

    def _city_row(
        self, city: Division, geometry: BaseGeometry, area: DivisionArea
    ) -> db.BoundaryValues | None:
        names = {city.primary_name, city.common_names.get("en")}
        return _overture_row(
            self._catalog,
            city,
            CITY_LEVEL,
            geometry,
            area,
            city.credits | area.credits,
            parent=self._parent(city),
            kind=(city.local_type or "").capitalize() or None,
            aliases=sorted(name for name in names if name),
            state_fallback=True,
        )

    def _parent(self, city: Division) -> Division | None:
        """The nearest stored division above the city, skipping one that only repeats its name."""
        name = self._catalog.name(city).casefold()
        ancestor = self._catalog.parent(city)
        while ancestor is not None:
            stored = self._catalog.row_id(ancestor) in self._stored_ids
            if stored and self._catalog.name(ancestor).casefold() != name:
                return ancestor

            ancestor = self._catalog.parent(ancestor)

        return None


def _overture_row(
    catalog: Catalog,
    division: Division,
    level: str,
    geometry: BaseGeometry,
    area: DivisionArea,
    credits: frozenset[Credit],
    parent: Division | None,
    kind: str | None,
    aliases: list[str],
    state_fallback: bool = False,
) -> db.BoundaryValues | None:
    state = catalog.state(division)
    state_name = catalog.name(state) if state else None
    if state_name is None and state_fallback:
        state_name = division.region_code
    row = _row(
        catalog.row_id(division),
        level=level,
        name=catalog.name(division),
        parent=catalog.name(parent) if parent else "",
        iso3=ALPHA3_BY_ALPHA2.get(division.country),
        geometry=geometry,
        source=OVERTURE_SOURCE,
        licence=_licence_text(credits),
    )
    if row is None:
        return None

    return (
        *row,
        division.primary_name,
        parent.primary_name if parent else None,
        state_name,
        kind,
        int(area.is_maritime),
        None,
        json.dumps(aliases, ensure_ascii=False),
        _contributors_text(credits),
        0,
        division.record_id,
    )


def _area_km2(geometry: BaseGeometry) -> float:
    """The area in square kilometres, scaling the degrees by the latitude of the shape."""
    return geometry.area * KM_PER_DEGREE**2 * math.cos(math.radians(geometry.centroid.y))


def _repeats_a_shape(geometry: BaseGeometry, shapes: shapely.STRtree) -> bool:
    """Whether a stored shape covers about the same place, by intersection over union."""
    try:
        for other in shapes.geometries.take(shapes.query(geometry, predicate="intersects")):
            union_area = geometry.union(other).area
            if union_area and geometry.intersection(other).area / union_area >= MAX_DUPLICATE_IOU:
                return True
    except GEOSException:
        # A shape GEOS cannot intersect is kept rather than ending a long import.
        return False

    return False


def tiling_municipalities(
    candidates: list[Division], land_areas: dict[str, float]
) -> tuple[list[Division], int]:
    """The candidates whose siblings tile their parent, and how many parents were dropped.

    A parent keeps its children when there are at least two and their land area adds up to
    about the parent's, which sets real municipalities apart from scattered villages.
    """
    children: defaultdict[str, list[Division]] = defaultdict(list)
    for candidate in candidates:
        if candidate.parent_id and candidate.id in land_areas:
            children[candidate.parent_id].append(candidate)

    kept: list[Division] = []
    dropped_parents = 0
    for parent_id, siblings in children.items():
        parent_area = land_areas.get(parent_id, 0.0)
        children_area = sum(land_areas[sibling.id] for sibling in siblings)
        tiles_parent = parent_area > 0 and (
            MIN_TILING_AREA_RATIO <= children_area / parent_area <= MAX_TILING_AREA_RATIO
        )
        if len(siblings) >= MIN_TILING_CHILDREN and tiles_parent:
            kept += siblings
        else:
            dropped_parents += 1

    return sorted(kept, key=lambda division: division.id), dropped_parents


def is_compact(bounds: list[Bounds]) -> bool:
    """Whether a country and its dependencies make one sensible scene grid.

    The first bounds are the country's. All parts must fit in 180 degrees of longitude and the
    country's own box must fill at least half of the combined box, so the grid is not mostly sea.
    """
    west = min(bound[0] for bound in bounds)
    south = min(bound[1] for bound in bounds)
    east = max(bound[2] for bound in bounds)
    north = max(bound[3] for bound in bounds)
    main_west, main_south, main_east, main_north = bounds[0]
    combined_box_deg2 = (east - west) * (north - south)
    main_box_deg2 = (main_east - main_west) * (main_north - main_south)

    return east - west <= COMBINED_MAX_WIDTH_DEG and main_box_deg2 >= (
        COMBINED_MIN_MAIN_SHARE * combined_box_deg2
    )


def _with_dependencies(name: str, dependencies: list[str]) -> str:
    """'France with Guyane and Mayotte', or '... with overseas territories' past three."""
    if len(dependencies) > MAX_NAMED_DEPENDENCIES:
        return f"{name} with overseas territories"
    if len(dependencies) == 1:
        return f"{name} with {dependencies[0]}"

    return f"{name} with {', '.join(dependencies[:-1])} and {dependencies[-1]}"


def _licence_text(credits: frozenset[Credit]) -> str:
    """The licences of all contributing datasets, such as 'CC BY 4.0; ODbL 1.0'."""
    licences = {licence.replace("-", " ") for _, licence in credits if licence}

    return "; ".join(sorted(licences)) or OVERTURE_LICENCE


def _contributors_text(credits: frozenset[Credit]) -> str:
    """The contributing dataset names as a JSON list, for attribution."""
    return json.dumps(sorted({dataset for dataset, _ in credits}), ensure_ascii=False)


def _land_row(rows: list[DivisionArea]) -> DivisionArea:
    return next((row for row in rows if not row.is_maritime), rows[0])


def _preferred_area(rows: list[DivisionArea]) -> DivisionArea:
    """The maritime row when there is one, since it reaches the neighbours' sea limits."""
    return next((row for row in rows if row.is_maritime), rows[0])


def _simplified(geometries: list[BaseGeometry]) -> list[BaseGeometry]:
    """Simplify a group of neighbours so that shared edges stay identical."""
    if not geometries:
        return []

    try:
        if shapely.coverage_is_valid(geometries).all():
            return list(shapely.coverage_simplify(geometries, SIMPLIFY_TOLERANCE_DEG))
    except GEOSException:
        pass

    # Overlaps or gaps make a coverage invalid, so each shape is simplified on its own.
    return [geometry.simplify(SIMPLIFY_TOLERANCE_DEG) for geometry in geometries]


def _disputed_row(line: DisputedLine) -> DisputedRow:
    west, south, east, north = line.geometry.bounds
    return (
        line.id,
        DISPUTED_LEVEL_BY_SUBTYPE[line.subtype],
        west,
        south,
        east,
        north,
        line.geometry.wkb,
    )


class _BackgroundLevels:
    """Fetches the admin levels in a thread, so Overpass waits overlap the geometry work."""

    def __init__(
        self,
        db_path: Path | str,
        catalog: Catalog,
        fetch_levels: Callable[[list[int]], dict[int, int | None]],
    ) -> None:
        self.error: str | None = None
        self._stopped = threading.Event()
        # A daemon thread lets Ctrl+C end the process even in the middle of a request.
        self._thread = threading.Thread(
            target=self._run, args=(db_path, catalog, fetch_levels), daemon=True
        )
        self._thread.start()

    def wait(self) -> None:
        self._thread.join()

    def stop(self) -> None:
        self._stopped.set()

    def _run(
        self,
        db_path: Path | str,
        catalog: Catalog,
        fetch_levels: Callable[[list[int]], dict[int, int | None]],
    ) -> None:
        # Fetchers end with SystemExit, which would otherwise vanish with the thread.
        try:
            fetch_sampled_levels(db_path, catalog, fetch_levels, self._stopped)
        except (Exception, SystemExit) as error:  # noqa: BLE001 - any failure leaves the levels for later.
            self.error = str(error) or type(error).__name__


def cached_admin_levels(
    db_path: Path | str,
    record_ids: Iterable[str],
    fetch_levels: Callable[[list[int]], dict[int, int | None]],
    stop: threading.Event | None = None,
) -> dict[str, int | None]:
    """OpenStreetMap admin_level per relation record, asking Overpass only for new versions.

    A record id carries the relation version (r123@45), so an edited relation is fetched
    again while the rest comes from the cache. A relation without the tag gets None. Each batch
    is fetched before anything is written, so a failed request leaves the database untouched.
    Once `stop` is set no further batch is fetched, and the records left over read as None.
    """
    wanted = set(record_ids)
    cached = _read_cached_levels(db_path)
    missing = sorted(wanted - cached.keys())
    total = len(missing)
    done = 0
    for start in range(0, len(missing), OVERPASS_BATCH_IDS):
        if stop is not None and stop.is_set():
            break

        batch = missing[start : start + OVERPASS_BATCH_IDS]
        levels = fetch_levels([_relation_id(record_id) for record_id in batch])
        fetched = {record_id: levels.get(_relation_id(record_id)) for record_id in batch}
        _store_levels(db_path, fetched)
        cached.update(fetched)
        done += len(batch)
        print(f"Overpass levels {done:,}/{total:,}")

    return {record_id: cached.get(record_id) for record_id in wanted}


def _read_cached_levels(db_path: Path | str) -> dict[str, int | None]:
    with db.connect(db_path) as connection:
        exists = connection.execute(
            "SELECT 1 FROM sqlite_master WHERE name = 'osm_levels'"
        ).fetchone()
        if not exists:
            return {}

        return {
            row["record_id"]: row["admin_level"]
            for row in connection.execute("SELECT record_id, admin_level FROM osm_levels")
        }


def _store_levels(db_path: Path | str, levels: dict[str, int | None]) -> None:
    with db.connect(db_path) as connection:
        connection.execute(OSM_LEVELS_SCHEMA)
        connection.execute("BEGIN")
        connection.executemany("INSERT OR REPLACE INTO osm_levels VALUES (?, ?)", levels.items())
        connection.execute("COMMIT")


def _relation_id(record_id: str) -> int:
    return int(record_id.removeprefix("r").split("@")[0])


def _fetch_overpass_levels(
    relation_ids: list[int],
    sleep: Callable[[float], None] = time.sleep,
    fetch_status: Callable[[], str] | None = None,
) -> dict[int, int | None]:
    """admin_level per relation id from Overpass, trying again while the server is overloaded.

    Each batch gets several tries, waiting until the server reports a free slot (or, when it
    cannot be asked, a growing wait), so one slow run can still finish. A batch that never answers
    exits with the resume message and is never cached halfway.
    """
    fetch_status = fetch_status or _fetch_overpass_status
    ids = ",".join(str(relation_id) for relation_id in relation_ids)
    query = f"[out:json][timeout:{OVERPASS_TIMEOUT_SECS}];rel(id:{ids});out tags;"
    request = urllib.request.Request(
        OVERPASS_URL,
        data=urllib.parse.urlencode({"data": query}).encode(),
        headers={"User-Agent": OVERPASS_USER_AGENT},
    )
    delay = OVERPASS_RETRY_DELAY_SECS
    for attempt in range(1, OVERPASS_MAX_TRIES + 1):
        try:
            with urllib.request.urlopen(request, timeout=OVERPASS_TIMEOUT_SECS + 30) as response:
                text = response.read().decode()
        except urllib.error.HTTPError as error:
            if error.code not in OVERPASS_RETRY_STATUS_CODES or attempt == OVERPASS_MAX_TRIES:
                raise SystemExit(
                    f"Overpass request failed ({error}); run again to resume"
                ) from error
            wait = _retry_wait(delay, fetch_status)
            print(
                f"Overpass request failed ({error}). "
                f"Retrying in {wait:g} s (attempt {attempt}/{OVERPASS_MAX_TRIES})."
            )
            sleep(wait)
            delay = min(delay * 2, OVERPASS_RETRY_MAX_DELAY_SECS)
            continue
        # A connection cut mid-answer raises IncompleteRead, which is not an OSError.
        except (OSError, http.client.HTTPException) as error:
            if attempt == OVERPASS_MAX_TRIES:
                raise SystemExit(
                    f"Overpass request failed ({error}); run again to resume"
                ) from error
            wait = _retry_wait(delay, fetch_status)
            print(
                f"Overpass request failed ({error}). "
                f"Retrying in {wait:g} s (attempt {attempt}/{OVERPASS_MAX_TRIES})."
            )
            sleep(wait)
            delay = min(delay * 2, OVERPASS_RETRY_MAX_DELAY_SECS)
            continue

        remark = _overpass_runtime_remark(text)
        if remark is not None:
            if attempt == OVERPASS_MAX_TRIES:
                break
            wait = _retry_wait(delay, fetch_status)
            print(
                f"Overpass could not finish the query ({remark}). "
                f"Retrying in {wait:g} s (attempt {attempt}/{OVERPASS_MAX_TRIES})."
            )
            sleep(wait)
            delay = min(delay * 2, OVERPASS_RETRY_MAX_DELAY_SECS)
            continue

        levels = parse_overpass_levels(text)
        sleep(OVERPASS_PAUSE_SECS)

        return levels

    return parse_overpass_levels(text)


def _retry_wait(fallback_secs: float, fetch_status: Callable[[], str]) -> float:
    """Seconds until Overpass has a free slot, or the fallback when its status cannot be read."""
    try:
        status = fetch_status()
    except (OSError, http.client.HTTPException):
        return fallback_secs

    if re.search(r"[1-9]\d* slots? available now", status):
        return OVERPASS_SLOT_FREE_WAIT_SECS

    seconds_until_free = [
        int(secs) for secs in re.findall(r"Slot available after: .*?, in (\d+) seconds", status)
    ]
    if not seconds_until_free:
        return fallback_secs

    return min(min(seconds_until_free) + OVERPASS_SLOT_MARGIN_SECS, OVERPASS_RETRY_MAX_DELAY_SECS)


def _fetch_overpass_status() -> str:
    request = urllib.request.Request(
        OVERPASS_STATUS_URL, headers={"User-Agent": OVERPASS_USER_AGENT}
    )
    with urllib.request.urlopen(request, timeout=OVERPASS_STATUS_TIMEOUT_SECS) as response:
        return response.read().decode()


def _overpass_runtime_remark(text: str) -> str | None:
    """The runtime remark when Overpass answers that it is too busy, else None."""
    try:
        answer = json.loads(text)
    except json.JSONDecodeError:
        return None

    if not isinstance(answer, dict):
        return None

    remark = answer.get("remark", "")
    return remark if isinstance(remark, str) and "runtime error" in remark else None


def parse_overpass_levels(text: str) -> dict[int, int | None]:
    """Parse an Overpass JSON answer into admin_level per relation id.

    A relation without a numeric level gets None. An answer that is cut off or reports a runtime
    error exits, because its missing relations would otherwise count as having no level.
    """
    try:
        answer = json.loads(text)
    except json.JSONDecodeError as error:
        raise SystemExit(f"Overpass answer is incomplete ({error}); run again to resume") from error

    remark = answer.get("remark", "")
    if "runtime error" in remark or "elements" not in answer:
        raise SystemExit(f"Overpass could not finish the query ({remark}); run again to resume")

    return {element["id"]: _admin_level(element.get("tags", {})) for element in answer["elements"]}


def _admin_level(tags: dict[str, str]) -> int | None:
    level = tags.get("admin_level", "")
    return int(level) if level.isdigit() else None


class DuckDbSource:
    """Reads a release from the public Overture bucket through DuckDB."""

    def __init__(self, release: str) -> None:
        import duckdb

        base = f"{RELEASE_URL}/{release}/theme=divisions"
        self._connection = duckdb.connect()
        self._connection.execute("INSTALL httpfs")
        self._connection.execute("LOAD httpfs")
        self._connection.execute(f"SET s3_region='{S3_REGION}'")
        self._connection.execute(f"SET memory_limit='{DUCKDB_MEMORY_LIMIT}'")
        listed = self._connection.execute(
            "SELECT count(*) FROM glob(?)", [f"{base}/type=division_area/*.parquet"]
        )
        if not listed.fetchone()[0]:
            raise SystemExit(f"Overture release {release} not found at {base}")

        for table in ("division", "division_area", "division_boundary"):
            files = f"{base}/type={table}/*.parquet"
            self._connection.execute(
                f"CREATE VIEW {table} AS SELECT * FROM read_parquet('{files}')"  # noqa: S608 - the names are fixed here.
            )

    def divisions(self) -> list[Division]:
        """Countries, dependencies, regions, counties, localadmins and relation localities."""
        cursor = self._connection.execute(
            "SELECT id, country, subtype, parent_division_id, region, names.primary, "  # noqa: S608 - only module constants are joined in.
            f"names.common, local_type['en'], {OSM_RELATIONS}[1].record_id, {CREDITS} "
            "FROM division "
            "WHERE subtype IN ('country', 'dependency', 'region', 'county', 'localadmin') "
            f"OR (subtype = 'locality' AND len({OSM_RELATIONS}) > 0)"
        )
        return [
            Division(*record[:6], dict(record[6] or {}), *record[7:9], _credits(record[9]))
            for record in cursor.fetchall()
        ]

    def cities(self) -> list[Division]:
        """Localities of any record type that may be cities, with the population for villages.

        The query only narrows the rows; `is_city` decides.
        """
        cursor = self._connection.execute(
            "SELECT id, country, subtype, parent_division_id, region, names.primary, "  # noqa: S608 - only module constants are joined in.
            f"names.common, local_type['en'], {OSM_RELATIONS}[1].record_id, {CREDITS}, population "
            "FROM division WHERE subtype = 'locality' AND (list_contains(?, local_type['en']) "
            "OR (local_type['en'] = ? AND population >= ?))",
            [list(CITY_LOCAL_TYPES), VILLAGE_LOCAL_TYPE, MIN_VILLAGE_POPULATION],
        )
        return [
            Division(
                *record[:6], dict(record[6] or {}), *record[7:9], _credits(record[9]), record[10]
            )
            for record in cursor.fetchall()
        ]

    def divisions_by_id(self, ids: list[str]) -> list[Division]:
        """The division rows for these ids, of any subtype; unknown ids are skipped."""
        if not ids:
            return []

        cursor = self._connection.execute(
            "SELECT id, country, subtype, parent_division_id, region, names.primary, "  # noqa: S608 - only module constants are joined in.
            f"names.common, local_type['en'], {OSM_RELATIONS}[1].record_id, {CREDITS}, population "
            "FROM division WHERE list_contains(?, id)",
            [ids],
        )
        return [
            Division(
                *record[:6], dict(record[6] or {}), *record[7:9], _credits(record[9]), record[10]
            )
            for record in cursor.fetchall()
        ]

    def areas(self, country: str, subtypes: tuple[str, ...]) -> Iterator[DivisionArea]:
        cursor = self._connection.execute(
            f"SELECT division_id, class, st_aswkb(geometry), {CREDITS} FROM division_area "  # noqa: S608 - only module constants are joined in.
            "WHERE country = ? AND list_contains(?, subtype)",
            [country, list(subtypes)],
        )
        while rows := cursor.fetchmany(AREA_FETCH_ROWS):
            for division_id, area_class, wkb, credits in rows:
                geometry = shapely.from_wkb(bytes(wkb))
                yield DivisionArea(
                    division_id, area_class == "maritime", geometry, _credits(credits)
                )

    def disputed_lines(self) -> list[DisputedLine]:
        cursor = self._connection.execute(
            "SELECT id, subtype, st_aswkb(geometry) FROM division_boundary "
            "WHERE is_disputed AND subtype IN ('country', 'region')"
        )
        return [
            DisputedLine(line_id, subtype, shapely.from_wkb(bytes(wkb)))
            for line_id, subtype, wkb in cursor.fetchall()
        ]


def _credits(encoded: list[str] | None) -> frozenset[Credit]:
    """The distinct datasets and licences of a DuckDB `dataset|licence` list."""
    pairs = (item.rpartition("|") for item in encoded or [])
    return frozenset((dataset, licence) for dataset, _, licence in pairs)
