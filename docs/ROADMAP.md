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

- Bundles are built on demand on one small machine and uploaded to Cloudflare R2
  (`scenes/{id}/`, `scene.json` last). The browser reads them from a Cloudflare domain and
  never builds scenes itself.
- From the second time-varying dataset on, builds read from global cubes on R2 instead of
  the source servers.
- Estimated cost: $8–21 a month at 1k–10k scenes, mostly the build machine.
- Before deploy: R2 upload, a "Cache Everything" rule (Zarr chunks have no file extension),
  CORS on the bucket, lifecycle eviction, uint16 rain encoding.

## Next

1. **Frontend contract:** render layers by `style.kind`, resolve every URL relative to
   `bundle_url`, apply scale/offset; every layer can be turned on and off.
2. **Contract generalisation (M3 remainder):** each layer has its own mask, grid and time axis
   (monthly rain, 16-day NDVI, 5-year population; static layers have none). Check that rasters
   past 180°E draw in the next world copy. Monthly series also get yearly totals or means.
3. **Scene view B:** app UI moves to React (MapLibre stays outside React's control). A panel at
   the bottom right, under the legend, expands to full screen with Charts and About tabs. Charts:
   area-mean rain and climatology, hypsometry; per-step area means in `scene.json`.
4. **Credits and notices (M4):** credits, limits and clipping notices in the About tab; basemap
   attribution.
5. **Land cover (M5):** ESA WorldCover as a static categorical layer.

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
- More data layers come first: TerraClimate (monthly, CC0, no login: temperature, wind, drought)
  may replace ERA5-Land; population and vegetation over time.
- Daily data (CHIRPS daily, other daily layers) once there is funding: it needs global cubes on
  R2 and adds about $2–5 a month per daily layer at 10k scenes.
- Latitudes beyond 60°.
