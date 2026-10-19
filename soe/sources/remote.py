"""What every reader of a remote server shares."""
import time
from collections.abc import Callable
from typing import TypeVar

from rasterio.errors import RasterioIOError, WarpOperationError

T = TypeVar("T")

BLOCK_READ_ATTEMPTS = 3
BLOCK_RETRY_DELAY_SECS = 1

GDAL_OPTS = {
    "GDAL_HTTP_MAX_RETRY": "5",
    "GDAL_HTTP_RETRY_DELAY": "1",
    "GDAL_DISABLE_READDIR_ON_OPEN": "EMPTY_DIR",
    "CPL_VSIL_CURL_ALLOWED_EXTENSIONS": ".cog,.tif",
    "CPL_VSIL_CURL_CACHE_SIZE": "200000000",  # bytes; blocks of one tile share fetched ranges
}


class SourceUnavailable(RuntimeError):
    """The remote data server could not be reached; the API turns this into a 503."""


def read_with_retries(read: Callable[[], T], unavailable: str) -> T:
    """The result of read(), tried again when the server drops the connection.

    Raises SourceUnavailable(unavailable) when every attempt fails.
    """
    for attempt in range(BLOCK_READ_ATTEMPTS):
        try:
            return read()
        # GDAL reports a tile download that fails inside the warp as WarpOperationError.
        except (RasterioIOError, WarpOperationError) as error:
            if attempt == BLOCK_READ_ATTEMPTS - 1:
                raise SourceUnavailable(unavailable) from error

            # The bucket drops connections now and then.
            time.sleep(BLOCK_RETRY_DELAY_SECS)
