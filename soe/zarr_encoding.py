"""Share deterministic gzip compression and integer packing for scenes and ingested cubes."""
import gzip
import io
from functools import cached_property

import numpy as np
from numcodecs.compat import ensure_contiguous_ndarray
from numcodecs.gzip import GZip
from zarr.codecs import GzipCodec


class DeterministicGzipCodec(GzipCodec):
    """GzipCodec with a zeroed header timestamp; its zarr.json codec name stays "gzip"."""

    # Overrides a private zarr attribute (checked with zarr 3.4.2); if a zarr upgrade renames it,
    # test_rebuilding_a_scene_writes_byte_identical_bundles fails instead of builds drifting.
    @cached_property
    def _gzip_codec(self) -> GZip:
        return _DeterministicGZip(self.level)


class _DeterministicGZip(GZip):
    """GZip with a zeroed header timestamp, so rebuilding a scene writes identical bytes."""

    def encode(self, buf: np.ndarray) -> bytes:
        normalized = ensure_contiguous_ndarray(buf)
        compressed = io.BytesIO()
        with gzip.GzipFile(
            fileobj=compressed,
            mode="wb",
            compresslevel=self.level,
            mtime=0,
        ) as member:
            member.write(normalized)
        return compressed.getvalue()


COMPRESSION = DeterministicGzipCodec(level=5)


def encode_values(
    values: np.ndarray,
    dtype: str,
    scale: float,
    offset: float,
    fill_value: int,
) -> np.ndarray:
    """Quantize floats to integers, using fill_value for NaN values.

    fill_value is the dtype's minimum or maximum, and no real value is encoded onto it.
    """
    limits = np.iinfo(dtype)
    lowest = limits.min + (fill_value == limits.min)
    highest = limits.max - (fill_value == limits.max)
    quantized = np.rint((values - offset) / scale).clip(lowest, highest)
    encoded = np.where(np.isnan(values), fill_value, quantized)
    return encoded.astype(dtype)
