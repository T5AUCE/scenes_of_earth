"""What every reader of a remote server shares."""

GDAL_OPTS = {
    "GDAL_HTTP_MAX_RETRY": "5",
    "GDAL_HTTP_RETRY_DELAY": "1",
    "GDAL_DISABLE_READDIR_ON_OPEN": "EMPTY_DIR",
    "CPL_VSIL_CURL_ALLOWED_EXTENSIONS": ".cog,.tif",
    "CPL_VSIL_CURL_CACHE_SIZE": "200000000",  # bytes; blocks of one tile share fetched ranges
}


class SourceUnavailable(RuntimeError):
    """The remote data server could not be reached; the API turns this into a 503."""
