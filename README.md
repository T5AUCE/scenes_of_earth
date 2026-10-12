# Scenes of Earth backend

A small FastAPI + SQLite service that turns an area (a country, state, county or large city, or a drawn polygon) and a
month range into a static scene bundle: `scene.json`, `area.geojson` and a Zarr v3 store (`data.zarr`, gzip) with monthly
rain and a hillshaded terrain. The browser reads the finished bundle directly. Bundles live at
`data/scenes/{id}/`, where `{id}` is a content hash, so a finished bundle never changes and is served as immutable.

**The devcontainer (Linux) is the supported environment.** The code also runs on Windows, but deep checkouts can hit the
260-character path limit.

## Setup

Open the folder in the devcontainer (Python 3.12, Node LTS, GitHub CLI, Claude Code). It runs
`pip install -e '.[import,dev]'` once. Without the devcontainer: `pip install -e '.[import,dev]'` in a Python >= 3.11 venv.

## Run

```
uvicorn main:app --reload --port 8000
```

For the frontend (`npm run dev`, port 5173), set the Vite dev server to proxy `/api` and `/scenes` to
`http://localhost:8000`, so the browser uses the same relative URLs as in production and needs no CORS setup.

Frontend (`web/`): `npm install`, then `npm run dev` (port 5173), `npm run build` (typecheck plus bundle) and `npm test`
(Node's built-in runner, no framework). A built scene opens by id with `http://localhost:5173/?scene=<id>`, which is also
how to share it. The page draws terrain hillshade and the rain series from the bundle's Zarr store, each toggleable,
with a time slider and a blocky or smooth rain look.

API: `GET /api/health`, `GET /api/layers` (per layer: id, title, kind, units, coverage, time step with first and latest month,
and the default set),
`GET /api/areas/search?q=&level=&limit=`, `GET /api/areas/{id}`, `POST /api/scenes`,
`GET /api/scenes/{id}`, and the static files under `/scenes/{id}/`. `POST /api/scenes` takes
`{"area": {"type": "boundary", "id": ...} | {"type": "polygon", "geometry": GeoJSON}, "start": "YYYY-MM",
"end": "YYYY-MM", "layers": ["chirps_monthly", "glo90_terrain"], "title": ...}` and returns 202 (queued or running),
200 (already built), 422 (refused, with a reason), 413, or 503 (queue full or data server unreachable; `Retry-After`).

With `SOE_SYNTHETIC=1` and an empty boundaries table, five sample areas (Kenya, Fiji, Nairobi, Cusco, Burkina Faso) are
loaded from `soe/data/sample_areas.geojson`, so search works without the boundaries import. They are real
geoBoundaries gbOpen outlines simplified to about 0.01 degrees; each feature carries its own licence and source.

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

## Terrain tile index

`soe/data/glo90_tiles.bin` lists which GLO-90 tiles exist (ocean tiles do not), so planning stays offline.
Rebuild it only if the bucket's tile list changes:

```
python -m soe.cli glo90-index
```

## Area contract notes

- `area.bbox` is `[W, S, E, N]` with W < E always. A shape across the antimeridian is unwrapped into one frame, so E may be
  above 180 (up to 360) and `lon` arrays rise past 180, as MapLibre's `LngLatBounds` does. `area.geojson` is in the same frame.
- `scene.json` is version 0.2. Each layer has its own `grid` (crs, bbox, res, nx, ny; `aggregation` for series), `mask`,
  `coverage`, `time` (`step` as an ISO 8601 duration, `count`, explicit `values`, or `null` for static layers) and
  `arrays` keyed by role (`value`, `elevation`, `hillshade`) with `dtype`, `scale_factor`, `add_offset` and `fill`.
  The viewer's colour domain is `style.domain`. Stored value = (real value - add_offset) / scale_factor.
- Rain is stored as uint16 at 0.1 mm (fill 65535, values above 6553.4 mm are clipped). Series are chunked one step per
  chunk and sharded 12 steps per shard; static arrays are one chunk each. The root `zarr.json` has consolidated metadata.
- Budgets: the raw size of all layers' arrays together is capped at 50 MB, and the source cells x steps read for all
  time-varying layers together at 100M. Terrain is planned first; all time-varying layers then share one aggregation factor.
- In v1 every layer is anchored to the 60S-60N grid of 0.05 degree cells that starts at 180W. `area.geojson` is the area
  clipped to the coverage of all selected layers, so one layer's mask can reach slightly beyond the outline.
- Large areas get coarser terrain (cell size 0.05/k degrees, about 4.2 Mpx at most) and a notice
  "Terrain resampled to N m cells (source 90 m)." Terrain is refused above 2500 existing source tiles.

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

## Tests

```
pytest
```

All tests run offline with synthetic data.

## Code style

Adapted from the MIT CommLab guide on coding and comment style
(https://mitcommlab.mit.edu/broad/commkit/coding-and-comment-style/). Clear code first, comments second.

- **Names:** descriptive and pronounceable; nouns for variables and classes, verbs for functions. No unexplained
  abbreviations (domain terms like `bbox`, `res` are fine). Length scales with scope. Use context to avoid redundancy.
- **Layout:** structure vertically. One statement per line, 4-space indents in Python, 2 in TypeScript.
  Aim for 80 columns, hard limit 100. When breaking at an operator, start the new line with it. Consistent spacing
  around operators and after commas.
- **Comments:** only explain **why** something confusing exists (a workaround, a data quirk, a non-obvious constraint),
  never **what** the code does. If a comment restates the code, delete it or rename until the code says it. Comments are
  complete sentences. A TODO names the problem and the work needed. Update or delete comments when the code changes.
  Exception: short trailing notes on constants and fields (units, shapes, what a key means) may be fragments.
- **Docstrings:** public modules and functions get a short PEP 257 docstring (purpose, plus inputs and outputs when not
  obvious from the signature).
- **Consistency:** follow the existing style of the file you edit.

## Data sources, licences and attribution

Every bundle carries these in `scene.json` (`layers[].source`, `area.boundary`, `credits`) and in the Zarr root attributes.
The data providers do not endorse Scenes of Earth. Reuse of a bundle's data is subject to each source's licence.

- **Rain: CHIRPS v3** (Climate Hazards Center, UC Santa Barbara), CC BY 4.0. Funk, C. et al. (2026) The Climate Hazards
  Center Infrared Precipitation with Stations, Version 3. Scientific Data 13, 718, doi:10.1038/s41597-026-07096-4;
  dataset doi:10.15780/G2JQ0P. https://www.chc.ucsb.edu/data/chirps3
- **Terrain: Copernicus DEM GLO-90** (Copernicus WorldDEM-90 licence, "Full, Free & Open"). Hillshade and resampled
  elevation are adapted data, so the notice is required: "produced using Copernicus WorldDEM™-90 © DLR e.V.
  2010-2014 and © Airbus Defence and Space GmbH 2014-2018 provided under COPERNICUS by the European Union and ESA; all
  rights reserved". Art. 6(c) disclaimer: "The organisations in charge of the Copernicus programme by law or by
  delegation do not incur any liability for any use of the Copernicus WorldDEM™-90". Citation: doi:10.5270/ESA-c5d3d65.
  Subsequent users of a bundle receive the same obligations. The same text is in `soe/sources.py`.
- **Boundaries: geoBoundaries CGAZ**, CC BY 4.0. Runfola, D. et al. (2020) geoBoundaries: A global database of political
  administrative boundaries. PLoS ONE 15(4): e0231866. https://www.geoboundaries.org. Simplified to 0.01 degrees and
  clipped to 60S-60N. CC BY 4.0 for CGAZ itself is the repository-wide licence for geoBoundaries derivatives, not a
  statement naming CGAZ.
- **Sample areas: geoBoundaries gbOpen** (offline mode only), per-feature licence: Kenya, Nairobi and Cusco Public Domain;
  Fiji ODbL 1.0 (OpenStreetMap, share-alike and attribution: "© OpenStreetMap contributors"); Burkina Faso CC BY 4.0
  (World Bank). Same citation as above; simplified.
- **Cities: GHSL Urban Centre Database R2024A**, CC BY 4.0, © European Union, 1995-2026. Reprojected from Mollweide
  and simplified.
