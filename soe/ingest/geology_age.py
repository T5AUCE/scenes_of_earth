"""Build the rock-age COG that the Geology age layer reads, from the GSC world geology map.

The map is Geological Survey of Canada Open File 5529 (Chorlton 2007), a 577 MB zip of which
the build needs only five small members. They are fetched by HTTP range reads, or taken from a
zip that is already on disk. Each map unit gets the class of its age range (see
`soe.geology_age`) and the polygons are rasterised onto the 1/120° grid between 60°S and 60°N.
"""
import io
import logging
import os
import urllib.request
import zipfile
from collections.abc import Iterator
from contextlib import contextmanager
from functools import partial
from pathlib import Path
from typing import TYPE_CHECKING, Any

import numpy as np
from rasterio.features import rasterize
from rasterio.transform import Affine
from shapely.geometry import box

from ..geology_age import (
    GEOLOGY_AGE_FILE,
    GEOLOGY_AGE_RES_DEG,
    GSC_AGE_NAMES,
    GSC_SOURCE,
    classify_age_ranges,
)
from ..sources.grid import Bbox
from .cubes import DOWNLOADS_DIR
from .cog import publish_cog, write_tiled_raster

if TYPE_CHECKING:
    import geopandas as gpd

GSC_URL = (
    "https://ostr-backend-prod.azure.cloud.nrcan-rncan.gc.ca/server/api/core/bitstreams/"
    "a2141be1-5afb-41c7-9588-a135734c0f8a/content"
)
GSC_DIR = "gsc-of5529"  # in the downloads folder
POLYGONS_FILE = "gen.shp"
AGES_FILE = "ruagedt.dbf"
GSC_MEMBERS = {
    "data/ArcMap9_ArcReader9/AllThemesMerged/gen.shp": POLYGONS_FILE,
    "data/ArcMap9_ArcReader9/AllThemesMerged/gen.shx": "gen.shx",
    "data/ArcMap9_ArcReader9/AllThemesMerged/gen.dbf": "gen.dbf",
    "data/ArcMap9_ArcReader9/AllThemesMerged/gen.prj": "gen.prj",
    "data/DBase_Files/rudbf/ruagedt.dbf": AGES_FILE,
}
REQUEST_TIMEOUT_SECS = 60
READ_BUFFER_BYTES = 1 << 20

log = logging.getLogger(__name__)


def ingest_geology_age(cubes_dir: Path | str, archive_path: Path | str | None = None) -> Path:
    """Publish the rock-age COG, taking the map from archive_path or else fetching it."""
    folder = Path(cubes_dir) / DOWNLOADS_DIR / GSC_DIR
    if not all((folder / name).exists() for name in GSC_MEMBERS.values()):
        folder.mkdir(parents=True, exist_ok=True)
        log.info("Fetching the GSC map members")
        with _open_archive(archive_path) as archive:
            _extract_members(archive, folder)

    published = Path(cubes_dir) / GEOLOGY_AGE_FILE
    log.info("Building the rock-age COG")
    build_geology_age_cog(folder / POLYGONS_FILE, folder / AGES_FILE, published)
    return published


@contextmanager
def _open_archive(archive_path: Path | str | None) -> Iterator[zipfile.ZipFile]:
    if archive_path is not None:
        with zipfile.ZipFile(archive_path) as archive:
            yield archive
        return

    with io.BufferedReader(_RangeReader(GSC_URL), READ_BUFFER_BYTES) as remote:
        with zipfile.ZipFile(remote) as archive:
            yield archive


def _extract_members(archive: zipfile.ZipFile, folder: Path) -> None:
    """Copy the GSC_MEMBERS into folder, leaving no partial file when one fails."""
    for member, name in GSC_MEMBERS.items():
        partial_path = folder / f"{name}.partial"
        try:
            partial_path.write_bytes(archive.read(member))
            os.replace(partial_path, folder / name)
        finally:
            partial_path.unlink(missing_ok=True)


class _RangeReader(io.RawIOBase):
    """A seekable read-only view of a URL that fetches the byte ranges it is asked for."""

    def __init__(self, url: str) -> None:
        self._url = url
        self._position = 0
        head = urllib.request.Request(url, method="HEAD")
        with urllib.request.urlopen(head, timeout=REQUEST_TIMEOUT_SECS) as response:
            self._size = int(response.headers["Content-Length"])

    def readable(self) -> bool:
        return True

    def seekable(self) -> bool:
        return True

    def tell(self) -> int:
        return self._position

    def seek(self, offset: int, whence: int = os.SEEK_SET) -> int:
        base = {os.SEEK_SET: 0, os.SEEK_CUR: self._position, os.SEEK_END: self._size}[whence]
        self._position = base + offset
        return self._position

    def readinto(self, buffer: bytearray) -> int:
        end = min(self._position + len(buffer), self._size)
        if end <= self._position:
            return 0

        request = urllib.request.Request(
            self._url,
            headers={"Range": f"bytes={self._position}-{end - 1}"},
        )
        with urllib.request.urlopen(request, timeout=REQUEST_TIMEOUT_SECS) as response:
            _check_range_response(response, self._position, end, self._size)
            data = response.read(end - self._position)
        buffer[:len(data)] = data
        self._position += len(data)
        return len(data)


def _check_range_response(response: Any, first: int, end: int, size: int) -> None:
    """Raise OSError unless the response carries exactly the requested bytes.

    A server that ignores Range would otherwise have its whole archive read into memory.
    """
    if response.status != 206:
        raise OSError(f"Range read failed with HTTP status {response.status}")
    expected = f"bytes {first}-{end - 1}/{size}"
    if response.headers.get("Content-Range") != expected:
        raise OSError(f"Range reply Content-Range is not {expected}")


def build_geology_age_cog(
    polygons_path: Path | str,
    ages_path: Path | str,
    cog_path: Path | str,
) -> None:
    """Write the COG of age classes, replacing cog_path only when complete.

    Raises ValueError, writing nothing, when the ages use a name that has no class.
    """
    polygons = _read_classified_polygons(polygons_path, ages_path)
    publish_cog(
        lambda raster: write_tiled_raster(
            raster,
            GEOLOGY_AGE_RES_DEG,
            partial(_rasterize_tile, polygons),
        ),
        GSC_SOURCE,
        Path(cog_path),
    )


def _read_classified_polygons(
    polygons_path: Path | str,
    ages_path: Path | str,
) -> "gpd.GeoDataFrame":
    """Read the map units with the class value of their age range in `value`.

    Units without an age row stay out, so they become no data.
    """
    import pyogrio

    polygons = pyogrio.read_dataframe(polygons_path, columns=["RUNO_ID2"])
    ages = pyogrio.read_dataframe(
        ages_path,
        columns=["RUNO_ID2", "STARTCAT", "ENDCAT"],
        read_geometry=False,
    ).dropna(subset=["STARTCAT"])
    # A few units name only their start, so their range is that one name.
    ages["ENDCAT"] = ages["ENDCAT"].fillna(ages["STARTCAT"])
    ranges = list(zip(ages["STARTCAT"], ages["ENDCAT"]))
    values = classify_age_ranges(ranges, GSC_AGE_NAMES)
    ages["value"] = [values[pair] for pair in ranges]
    return polygons.merge(ages[["RUNO_ID2", "value"]], on="RUNO_ID2")


def _rasterize_tile(
    polygons: "gpd.GeoDataFrame",
    bounds: Bbox,
    transform: Affine,
    shape: tuple[int, int],
) -> np.ndarray:
    """Return the class of each cell of the tile, 0 where no unit covers it."""
    nearby = polygons.iloc[polygons.sindex.query(box(*bounds), predicate="intersects")]
    if nearby.empty:
        return np.zeros(shape, "uint8")

    return rasterize(
        zip(nearby.geometry, nearby["value"]),
        out_shape=shape,
        transform=transform,
        dtype="uint8",
    )
