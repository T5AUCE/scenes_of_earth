# Visual trial

Measures the map of built scenes in headless Chromium, so a browser check takes a few minutes.

```
cd web
npm run trial -- contours --start
SOE_TRIAL_EXISTING_ONLY=1 npm run trial -- landcover --start --screens
npm run trial -- colour --start --screens
npm run trial -- places.json --app http://127.0.0.1:5173 --screens --out /tmp/x
```

One JSON line per spot and zoom goes to stdout and to `<out>/results.jsonl`; the default `<out>` is
`web/.trial-cache/runs/<timestamp>`. Screenshots (`--screens`) are one per view. `--parallel n`
sets how many spots run at once (default 3).

`--start` launches the real backend and Vite on free ports and stops those processes afterwards.
Repeated shutdown signals wait for the same cleanup before exiting.

## Browser setup

Run `web/scripts/visual-trial/setup.sh` once per container. It downloads Chromium
headless shell and the missing system libraries into `~/.cache/soe-visual-trial` (override with
`SOE_TRIAL_BROWSER_DIR`) and needs no root. An existing `/tmp/opencode/m5-visual-tools` is used as
is. The cache is lost when the container is rebuilt; adding the packages of `LIB_PACKAGES` to the
devcontainer image would make the libraries permanent.

The setup resolves the cache root to an absolute path. Browser download staging stays in its
`tmp/` subdirectory, so Playwright does not use the system temporary directory.

## Places file

```json
{
  "spots": [
    {
      "name": "Nairobi",
      "area": "sample:kenya",
      "centre": [36.82, -1.29],
      "zooms": ["fitted", 9, 12],
      "layers": ["terrain"],
      "enable": ["Smooth"],
      "colour": "era5land_temperature"
    }
  ]
}
```

`area` is a boundary id or a name the area search accepts. `layers` are the backend layers to
build (default `["terrain"]`; `start` and `end` may be added for time-varying layers). `enable`
lists editor options to switch on: a `"Smooth"` label uses the first editor offering it,
while a `{"layer": "Land cover", "option": "Smooth"}` object pins the layer down.
Several editors offer Smooth, so prefer the object form. Presets live in `places/`.

`colour` names the layer that holds the map's colour through the link's `as=<layer>:colour`
entry, so the trial never has to click the picker. A layer id holds that layer's colours, while
`blend` picks the combined rainfall and temperature layer and switches its halves off through
`off=` when they are present. The `colour` preset opens Kenya and Fiji with all four layers.
Each spot picks temperature or rainfall, land cover or the blend. A `landcover` spot without an
explicit `colour` requests `esa_worldcover`, so Land cover owns the map's colour while its repaint
checks run. A view whose sampled owner differs from the requested one fails its record, as does
any false repaint check.

`landcover: true` runs each spot twice in isolated browser contexts, first with the GPU enabled
and then with `soe.debug.gpu=off`. Screenshots have `-gpu` and `-image` suffixes. The GPU also
gets a `-gpu-rounding-0` screenshot for comparing its bilinear edges with the image fallback.
The landcover preset covers Nairobi through z18, Taveuni at 180° and the Kenya coast.

Scenes come from `POST /api/scenes`, so a bundle that matches the request is reused and nothing is
ever deleted.

Set `SOE_TRIAL_EXISTING_ONLY=1` to use local bundles without any scene POST or build. The tool
chooses a bundle containing the requested layers for each area and requested period, preferring
the fewest extra layers and then the newest creation time.
It reads `SOE_SCENES_DIR` or the repository's `data/scenes` directory. A missing match stops the
trial rather than building or downloading data. This mode is intended for `--start` against
those same local bundles, not a remote app with a different bundle collection.

Scene POST retries and build polling share a ten-minute deadline. Requests are aborted when
their remaining budget expires, and `Retry-After` waits cannot extend the deadline.

## Result fields

- `label_features` counts the contour label features MapLibre renders.
- `nearest_label_px` measures the distance from the map centre to the nearest labelled contour line.
  The label sits somewhere on that line, so this is a lower bound.
- `line_features` counts the rendered contour line features.
- `tiles_loaded` reports whether MapLibre loaded every tile. `timed_out` reports whether the view
  failed to settle within 60 s.
- `failed_requests` counts HTTP errors other than DEM and glyph errors. `dem_404` and `glyph_404`
  count failed DEM and glyph requests separately, including statuses other than 404. Mapterhorn
  has no ocean tiles and the basemap has a known font gap, so some of these failures are expected.
- `errors` counts distinct console and MapLibre diagnostics. `error_samples` lists up to five.
- `legend` contains the contour legend line when one is present.
- `legend_classes` lists the visible categorical legend labels in panel order for each view.
  It is empty when no class labels are shown or the view has no sample.
- `landcover_renderer` is the actual `gpu` or `image` renderer for landcover trials.
- `colour_owner` is the layer that held the map's colour in that view, or `blend`, and is null when
  the view had no colour picker.
- `frame_ms_p50` and `frame_ms_p95` summarise rAF deltas during a scripted two-second pan and
  include browser scheduling and the rest of the map, not just GPU draw time. They are null for
  other trials. A 60 Hz browser normally has a 16.7 ms floor, so these values cannot establish
  an 8 ms GPU draw budget. The current headless browser also uses SwiftShader, not hardware GL.
- `marks_frame_ms_p50` and `marks_frame_ms_p95` summarise the same pan for colour spots, where the
  dots layer is usually the heaviest draw, and carry the same caveats as `frame_ms_*`.
- `gl_errors` lists nonzero errors observed through WebGL2 `getError`, including upload checks.
- `display_checks` reports visibility and palette repaint checks from frame readbacks. It also
  reports whether Edges are available and repaint, or whether the image fallback has its single
  explanatory line and no Edges sliders. Readbacks are visual smoke checks, not pixel oracles.
- `context_restored` checks one `WEBGL_lose_context` loss/restore cycle at the first GPU view of
  each spot. It is true when the renderer stays GPU and the frame readback is unchanged, false
  on a mismatch, `"unsupported"` if the extension is missing, or null when not exercised.

Contour layer ids are matched by the patterns at the top of `measure.mjs`.

## Caching and pitfalls

- Successful public responses from tiles.mapterhorn.com and tiles.openfreemap.org are stored in
  `web/.trial-cache/http`. Fresh entries can be reused within a run. Mutable entries are
  revalidated on later runs with ETag or Last-Modified when available. Only explicitly immutable
  entries can skip revalidation across runs, and their freshness lifetime still applies. When the
  network is down, a revalidation that cannot reach the host serves the stale cached response
  instead of ending the trial.
- Missing resources and responses marked `no-store` or `private` are not cached. Entries with no
  freshness lifetime are revalidated before reuse. Old two-file entries and corrupt entries are
  treated as misses. Each new entry is atomically published with its body and integrity digest.
- `--start` always starts a fresh Vite because its file watcher misses edits on this mount. With
  `--app`, restart Vite yourself after editing source.
- A view is settled only after the scene mask has revealed the data and the requested layer views
  have initialised. Two successive MapLibre `idle` samples must then agree with every tile loaded.
  There are no fixed sleeps. Readiness is part of every success check, so early idle events do not
  settle a scene whose mask geometry is still loading.
- Startup HTTP failures and JavaScript diagnostics belong to the first view. Later views contain
  diagnostics collected since the preceding view. The tool instruments development modules in
  browser responses without editing application files and rejects hooks that no longer match.
