# Roadmap

Scenes of Earth shows several Earth datasets for areas anywhere in the world, from hosting that
stays cheap and simple. Each feature is checked for extensibility before users get more control.

## Constraints

- Hosting budget: up to $10 a month for now; it scales with users and funding.
- Fast load times come first, while staying cheap. Bundles may be evicted and rebuilt on request.
- v1 covers 60°S to 60°N (no high latitudes). Elevation is land only (no seafloor).
- Countries that cross the antimeridian must work. Large countries get coarser terrain, never
  none.

## Hosting (release)

- One small VPS in Europe (near the Copernicus terrain and ERA5-Land sources) runs the API,
  the database, daily updates and builds; a large hourly machine is rented only to load a daily
  layer's full history.
- Bundles are built on demand on that machine and uploaded to Cloudflare R2
  (`scenes/{id}/`, `scene.json` last). The browser reads them from a Cloudflare domain and
  never builds scenes itself.
- From the second time-varying dataset on, builds read from global cubes on R2 instead of
  the source servers.
- Estimated cost: $8–21 a month at 1k–10k scenes, mostly the build machine.
- Before deploy: R2 upload, a "Cache Everything" rule (Zarr chunks have no file extension),
  CORS on the bucket, lifecycle eviction, uint16 rain encoding, terrain cache eviction.
- After deploy: time a real build on the VPS (Kenya: about 40 s of terrain from the
  devcontainer), then pre-warm the terrain cache for every country and region in the boundary
  list, so only drawn shapes pay the first full terrain read.

## Next

1. **Frontend contract:** render layers by `style.kind`, resolve every URL relative to
   `bundle_url`, apply scale/offset; every layer can be turned on and off.
2. **Contract generalisation (M3 remainder):** each layer has its own mask, grid and time axis
   (monthly rain, 16-day NDVI, 5-year population; static layers have none). Check that rasters
   past 180°E draw in the next world copy. Monthly series also get yearly totals or means.
3. **Temperature:** ERA5-Land monthly 2 m air temperature (0.1°), the first layer that shares the
   scrubber with rain. The reader, cube writer, CDS ingest and frontend are in. Next come the
   first real ingest (`python -m soe.cli ingest-era5land-temperature --from 2016-01`, which needs
   a CDS key) and the checks on Kenya and Fiji. The layer is opt-in until isolines and the
   bivariate display land. The backfill on the VPS at deploy starts at 2016-01 and is followed by
   a monthly refresh; older history is deferred.
4. **Land cover (M5):** ESA WorldCover (10 m) as a static categorical layer, resampled by the most
   common class in each cell, with fixed class colours and a legend.
5. **Scene view B:** app UI moves to React (MapLibre stays outside React's control). A panel at
   the bottom right, under the legend, expands to full screen with Charts and About tabs. Charts:
   area-mean rain and temperature, climatology, hypsometry; per-step area means in `scene.json`.
6. **Credits and notices (M4):** credits, limits and clipping notices in the About tab; basemap
   attribution.

## Later

### Selection modes

- **Boundary:** pick a country or region (today's mode).
- **Single point:** type a coordinate or click the map to get elevation plus rain and other
  series for that one place. It is shown as a small point card (locator map, headline numbers,
  series charts with the scrubber), not a near-empty map. Results are cached per grid cell.
  Fast point series need global cubes chunked along time.
- **Drawn polygon:** the user draws an area. The backend normalises drawn shapes, and the full
  request is stored per scene id and checked on reuse.

### In-scene tools

A toolbar with three tools; Esc returns to Pointer.

- **Pointer** (default): pan and zoom only, no data readout.
- **Inspect:** a magnifying lens follows the cursor and shows every visible layer's value at that
  spot, with units. On touch screens: press and drag.
- **Marker:** click to pin a labelled marker. Each marker has a window that can be moved, resized
  and collapsed; it shows that point's values at the scrubber's step and updates as the scrubber
  moves. Later: a small chart of the full series.

### Data

- GLO-30 terrain under 90 m cells, GLO-90 otherwise. Height tint maybe later.
- After temperature: ERA5-Land monthly 10 m wind (direction, speed and steadiness) as arrows;
  daily wind with the other daily layers.
- After temperature and land cover: TerraClimate drought and water deficit, and its +2 °C / +4 °C
  scenarios (monthly, CC0, no login); ERA5-Land snow and soil moisture; population and vegetation
  over time.
- Daily data (CHIRPS daily, AgERA5 or ERA5-Land daily statistics) once there is funding: it needs global cubes on
  R2 and adds about $2–5 a month per daily layer at 10k scenes.
- Latitudes beyond 60°.
