# Scenes of Earth

A small FastAPI + SQLite service that turns an area (a country, state, county or large city, or a drawn polygon) and a
month range into a static scene bundle: `scene.json`, `area.geojson` and a Zarr v3 store (`data.zarr`, gzip) with monthly
rain and a hillshaded terrain. The browser reads the finished bundle directly. Bundles live at
`data/scenes/{id}/`, where `{id}` is a content hash, so a finished bundle never changes and is served as immutable.

Planned features and hosting: [docs/ROADMAP.md](docs/ROADMAP.md).

**The devcontainer (Linux) is the supported environment.** The code also runs on Windows, but deep checkouts can hit the
260-character path limit.

## Setup

Open the folder in the devcontainer (Python 3.12, Node LTS, GitHub CLI, Claude Code). It runs
`pip install -e '.[import,dev]'` once. Without the devcontainer: `pip install -e '.[import,dev]'` in a Python >= 3.11 venv.

## Run

```
uvicorn main:app --reload --port 8000
```

Without `SOE_SYNTHETIC=1`, the first start probes CHIRPS online (a few HEAD requests, in the background) for the latest
month, so it needs network access.

For the frontend (`npm run dev`, port 5173), set the Vite dev server to proxy `/api` and `/scenes` to
`http://localhost:8000`, so the browser uses the same relative URLs as in production and needs no CORS setup.

Frontend (`web/`): `npm install`, then `npm run dev` (port 5173), `npm run build` (typecheck plus bundle) and `npm test`
(Node's built-in runner, no framework). A built scene opens by id with `http://localhost:5173/?scene=<id>`, which is also
how to share it. The page draws terrain hillshade, contour lines (computed in a browser worker, interval chosen
automatically) and the rain series from the bundle's Zarr store, each toggleable, with a time slider and a blocky or smooth rain look.

API: `GET /api/health`, `GET /api/layers` (per layer: id, title, kind, units, coverage, time step with the first and last request period,
`request_step`, and the default set),
`GET /api/areas/search?q=&level=&limit=`, `GET /api/areas/{id}`, `POST /api/scenes`,
`GET /api/scenes/{id}`, and the static files under `/scenes/{id}/`. `POST /api/scenes` takes
`{"area": {"type": "boundary", "id": ...} | {"type": "polygon", "geometry": GeoJSON}, "start": "YYYY-MM",
"end": "YYYY-MM", "layers": ["chirps_monthly", "copdem_terrain"], "title": ...}` and returns 202 (queued or running),
200 (already built), 422 (refused, with a reason), 413, or 503 (queue full or data server unreachable; `Retry-After`).

With `SOE_SYNTHETIC=1`, five sample areas (Kenya, Fiji, Nairobi, Cusco, Burkina Faso) are
loaded from `soe/data/sample_areas.geojson`, so search works without the boundaries import. They are real
geoBoundaries gbOpen outlines simplified to about 0.01 degrees; each feature carries its own licence and source. They
reload on every synthetic start, unless real boundaries are imported.

## Import boundaries (once)

Download and unzip into a folder, then:

```
python -m soe.cli import-boundaries --cgaz <folder> --ucdb <GHS_UCDB file or zip>
```

- geoBoundaries CGAZ (ADM0, ADM1, ADM2 GeoPackages): https://www.geoboundaries.org/globalDownloads.html
  (files are in https://github.com/wmgeolab/geoBoundaries/tree/main/releaseData/CGAZ; use the media.githubusercontent.com
  links, the raw links return Git LFS pointers).
- GHS-UCDB R2024A: https://human-settlement.emergency.copernicus.eu/ghs_ucdb_2024.php (only cities of 1,000,000 or
  more people are imported).

The import is large (several hundred MB of input). CGAZ draws disputed borders to US State Department definitions.

## Cubes (once, then monthly)

Builds read three monthly Zarr cubes from local disk (`SOE_CUBES_DIR`). Reading the cubes makes no network calls, while Rainfall still reads CHIRPS over HTTP:

| Cube | Folder | Used for |
|---|---|---|
| ERA5-Land 2 m temperature | `era5land_temperature.zarr` | Temperature (main source) |
| ERA5 2 m temperature | `era5_temperature.zarr` | Temperature cells where ERA5-Land has no land value |
| ERA5 total precipitation | `era5_precipitation.zarr` | Rainfall cells where CHIRPS has no value |

Rainfall and Temperature are listed only when their cubes exist, so no layer lacks the data that fills its gaps. The fill
is automatic. ERA5-Land and CHIRPS values are never changed. ERA5 is sampled at the centre of each native layer cell,
and a scene that is averaged over blocks of cells averages these samples the same way as the main source. Only an output
cell with no main-source value takes the ERA5 value (about 28 km, over land and sea). A filled bundle carries a `source`
array (1 main source, 2 fallback, 3 both, 0 outside the area or no value), lists ERA5 under `fallback_sources`, and states
the number of filled cells in its notices. Nothing is marked on the map.

The cubes are filled from the Copernicus Climate Data Store (CDS), one request per year. Needs a CDS account, the key in
`~/.cdsapirc` (https://cds.climate.copernicus.eu/how-to-api), and the licences accepted on the dataset pages
(https://cds.climate.copernicus.eu/datasets/reanalysis-era5-land-monthly-means and
https://cds.climate.copernicus.eu/datasets/reanalysis-era5-single-levels-monthly-means).

```
python -m soe.cli ingest-cube era5land_temperature --from 1981-01
python -m soe.cli ingest-cube era5_temperature --from 1981-01
python -m soe.cli ingest-cube era5_precipitation --from 1981-01
```

All three cubes start at CHIRPS' first month (1981-01), so both layers offer 1981-01 onward. Each layer offers only the months
that all of its cubes hold. The first run of a cube starts at `--from`; later runs continue after the last stored month and fetch
again every month still marked preliminary (final data replaces it about two months later, and the scene then gets a new
id). The newest month may be skipped when the CDS has not published it yet. Restart the server after the first ingests, so
the layers are listed. Builds that need a cube get 503 while an ingest is publishing (seconds per month); if an ingest fails
in that step, the layer stays unavailable until the next run, which refetches the affected months. Run all three monthly,
around the 8th. A `--from` before a cube's first stored month adds the earlier months, newest year first, so a cube
that started later can be extended backwards without a rebuild. An ERA5 month with a missing cell, or values that its cube cannot hold, is refused and nothing is stored.

## Terrain tile index

`soe/data/glo30_tiles.bin` and `soe/data/glo90_tiles.bin` list which GLO-30 and GLO-90 tiles exist (ocean tiles do
not), so planning stays offline. GLO-30 lacks 25 tiles in the Caucasus (N38-41, E043-050); GLO-90 fills them.
Rebuild them only if a bucket's tile list changes:

```
python -m soe.cli terrain-index
```

## Area contract notes

- `area.bbox` is `[W, S, E, N]` with W < E always. A shape across the antimeridian is unwrapped into one frame, so E may be
  above 180 (up to 360) and `lon` arrays rise past 180, as MapLibre's `LngLatBounds` does. `area.geojson` is in the same frame.
- `scene.json` is version 0.4. The top-level `period` (`start`, `end` exclusive, `step`; ISO dates) is the requested range,
  or `null` for a scene without series. Each layer has its own `grid` (crs, bbox, res, nx, ny; `aggregation` for series), `mask`,
  `coverage`, `time` (`step` as an ISO 8601 duration, `end` = the day after the last step's period, `method` = how a step summarises
  its period (`sum`, `mean`, `point`, `max`), `count`, explicit `values`, or `null` for static layers) and
  `arrays` keyed by role (`value`, `elevation`, `hillshade`) with `dtype`, `scale_factor`, `add_offset` and `fill`.
  Each layer's `style` has `kind` (`field` for a continuous grid, `categorical` with `style.classes` `[{value, label, color}]`, `terrain`), `encodings` (the display types it offers, best
  first; a viewer skips names it does not know) and optional `parts` (extra display types drawn alongside, e.g. terrain's
  `contours`). A series layer also has `palette` (default colours) and `style.stops`: 2-9 increasing values fitted to the
  area over all steps (half an even stretch, half quantiles, rounded to two significant digits of the span so a 288-300
  field keeps whole degrees; rain starts at 0; a constant field has equal ends), evenly spaced along the palette.
  Stored value = (real value - add_offset) / scale_factor; every array also carries `scale_factor`, `add_offset` and, when
  set, the Zarr `fill_value`. Cells outside the area's `mask` hold the fill value in every array of every layer (terrain's
  hillshade is computed first, so its edge is not darkened); the viewer reads them as no data.
- Rain is stored as uint16 at 0.1 mm (fill 65535, values above 6553.4 mm are clipped). Series are chunked one step per
  chunk and sharded 12 steps per shard; static arrays are one chunk each. The root `zarr.json` has consolidated metadata.
- Budgets: the raw size of all layers' arrays together is capped at 50 MB, and the source cells x steps read for all
  time-varying layers together at 100M. Terrain is planned first; each time-varying layer then gets its own aggregation
  factor (the finest output coarsened first, never beyond 0.4 degrees).
- Temperature is stored as int16 at 0.1 °C (fill -32768), `time.method` `mean`, on its own 0.1 degree grid whose cell
  centres lie on 0.1 degree multiples (half a cell off the rain grid). It is listed only when the cube below exists.
- Rain and terrain are anchored to the 60S-60N grid of 0.05 degree cells that starts at 180W. `area.geojson` is the area
  clipped to the coverage of all selected layers, so one layer's mask can reach slightly beyond the outline.
- Terrain cells are 0.05/k degrees (k up to 180, about 4.2 Mpx at most). Cells finer than 90 m are read from GLO-30 (with
  average resampling), others from GLO-90; tiles GLO-30 lacks come from GLO-90 as `layers[].fallback_sources`. Coarser
  cells than the source give the notice "Terrain resampled to N m cells (source 30 m)." Terrain is refused above 2500
  existing source tiles.
- Terrain reads are cached in `SCENES_DIR/.cache/` (keyed by dataset, source versions, bbox, res and soe version), so
  rebuilding an area with other layers or dates does not read the tiles again. Deleting the folder is always safe.

## Environment variables

| Name | Default | Meaning |
|---|---|---|
| `SOE_DB` | `./data/soe.db` | SQLite file |
| `SOE_SCENES_DIR` | `./data/scenes` | Where bundles are written and served from |
| `SOE_PUBLIC_BASE` | `/scenes` | Public URL prefix of bundles (set to the R2 URL in production) |
| `SOE_MAX_BUILDS` | `1` | Concurrent builds |
| `SOE_MAX_QUEUE` | `20` | Queued plus running jobs before new ones get 503 |
| `SOE_SYNTHETIC` | `0` | `1` uses fake offline data |
| `SOE_LATEST` | probed | Fix the latest CHIRPS month (`YYYY-MM`) and skip the probe |
| `SOE_CUBES_DIR` | `./data/cubes` | Where the ERA5-Land and ERA5 cubes are read from and written to |

## Tests

```
pytest
```

All tests run offline with synthetic data.

## Data sources, licences and attribution

Every bundle carries these in `scene.json` (`layers[].source`, `area.boundary`, `credits`) and in the Zarr root attributes.
The data providers do not endorse Scenes of Earth. Reuse of a bundle's data is subject to each source's licence.

- **Rain: CHIRPS v3** (Climate Hazards Center, UC Santa Barbara), CC BY 4.0. Funk, C. et al. (2026) The Climate Hazards
  Center Infrared Precipitation with Stations, Version 3. Scientific Data 13, 718, doi:10.1038/s41597-026-07096-4;
  dataset doi:10.15780/G2JQ0P. https://www.chc.ucsb.edu/data/chirps3
- **Temperature: ERA5-Land monthly averaged data from 1950 to present** (ECMWF, Copernicus Climate Change Service),
  CC BY 4.0. Required attribution: "contains modified Copernicus Climate Change Service information 2026
  (ERA5-Land)". Disclaimer: "Neither the European Commission nor ECMWF is responsible for any use that may be made of
  the Copernicus information or data it contains." Citation: Muñoz Sabater, J. (2019): ERA5-Land monthly averaged data
  from 1950 to present. Copernicus Climate Change Service (C3S) Climate Data Store (CDS), doi:10.24381/cds.68d2bb30;
  Muñoz-Sabater, J. et al. (2021) Earth Syst. Sci. Data 13, 4349-4383, doi:10.5194/essd-13-4349-2021. Converted from K to
  °C and cropped to 60S-60N; preliminary (ERA5-Land-T) months carry a notice. The same text is in `soe/sources/licences.py`.
- **Gap fill for temperature and rain: ERA5 monthly averaged data on single levels from 1940 to present** (ECMWF,
  Copernicus Climate Change Service), CC BY 4.0. Required attribution: "contains modified Copernicus Climate Change
  Service information 2026 (ERA5)". The disclaimer is the one given for ERA5-Land. Citation: Hersbach, H. et al. (2023):
  ERA5 monthly averaged data on single levels from 1940 to present. Copernicus Climate Change Service (C3S) Climate Data
  Store (CDS), doi:10.24381/cds.f17050d7; Hersbach, H. et al. (2020) Q. J. R. Meteorol. Soc. 146, 1999-2049,
  doi:10.1002/qj.3803. Converted from K to °C or from m per day to mm per month, cropped to 60S-60N and sampled at the
  centre of each native layer cell where the main source has no value. Rainfall carries a notice for preliminary (ERA5T)
  months only where ERA5 filled an in-area cell. Temperature flags requested months that are preliminary in either cube.
  The credit appears in a bundle only when it holds filled cells. The same text is in `soe/sources/licences.py`.
- **Terrain: Copernicus DEM GLO-30 Public and GLO-90** (Copernicus WorldDEM-30 / -90 licences, free and open; GLO-90 is
  the fallback where GLO-30 has no tile). Hillshade and resampled elevation are adapted data, so the notice is
  required: "produced using Copernicus WorldDEM™-90 © DLR e.V.
  2010-2014 and © Airbus Defence and Space GmbH 2014-2018 provided under COPERNICUS by the European Union and ESA; all
  rights reserved" (with "-30" for GLO-30). Art. 6(c) disclaimer: "The organisations in charge of the Copernicus
  programme by law or by delegation do not incur any liability for any use of the Copernicus WorldDEM™-90" (likewise
  "-30"). Citation: doi:10.5270/ESA-c5d3d65.
  Subsequent users of a bundle receive the same obligations. The same text is in `soe/sources/licences.py`.
- **Boundaries: geoBoundaries CGAZ**, CC BY 4.0. Runfola, D. et al. (2020) geoBoundaries: A global database of political
  administrative boundaries. PLoS ONE 15(4): e0231866. https://www.geoboundaries.org. Simplified to 0.01 degrees and
  clipped to 60S-60N. CC BY 4.0 for CGAZ itself is the repository-wide licence for geoBoundaries derivatives, not a
  statement naming CGAZ.
- **Sample areas: geoBoundaries gbOpen** (offline mode only), per-feature licence: Kenya, Nairobi and Cusco Public Domain;
  Fiji ODbL 1.0 (OpenStreetMap, share-alike and attribution: "© OpenStreetMap contributors"); Burkina Faso CC BY 4.0
  (World Bank). Same citation as above; simplified.
- **Cities: GHSL Urban Centre Database R2024A**, CC BY 4.0, © European Union, 1995-2026. Reprojected from Mollweide
  and simplified.
