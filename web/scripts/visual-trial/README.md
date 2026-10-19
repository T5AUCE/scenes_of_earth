# Visual trial

Measures the map of built scenes in headless Chromium, so a browser check takes a few minutes.

```
cd web
npm run trial -- contours --start
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
      "enable": ["Smooth"]
    }
  ]
}
```

`area` is a boundary id or a name the area search accepts. `layers` are the backend layers to
build (default `["terrain"]`; `start` and `end` may be added for time-varying layers). `enable`
lists checkbox labels in the scene panel to switch on. Presets live in `places/`.

Scenes come from `POST /api/scenes`, so a bundle that matches the request is reused and nothing is
ever deleted.

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

Contour layer ids are matched by the patterns at the top of `measure.mjs`.

## Caching and pitfalls

- Successful public responses from tiles.mapterhorn.com and tiles.openfreemap.org are stored in
  `web/.trial-cache/http`. Fresh entries can be reused within a run. Mutable entries are
  revalidated on later runs with ETag or Last-Modified when available. Only explicitly immutable
  entries can skip revalidation across runs, and their freshness lifetime still applies.
- Missing resources and responses marked `no-store` or `private` are not cached. Entries with no
  freshness lifetime are revalidated before reuse. Old two-file entries and corrupt entries are
  treated as misses. Each new entry is atomically published with its body and integrity digest.
- `--start` always starts a fresh Vite because its file watcher misses edits on this mount. With
  `--app`, restart Vite yourself after editing source.
- A view is settled only after the scene mask has revealed the data and the requested layer views
  have initialized. Two successive MapLibre `idle` samples must then agree with every tile loaded.
  There are no fixed sleeps. Readiness is part of every success check, so early idle events do not
  settle a scene whose mask geometry is still loading.
- Startup HTTP failures and JavaScript diagnostics belong to the first view. Later views contain
  diagnostics collected since the preceding view. The tool instruments development modules in
  browser responses without editing application files and rejects hooks that no longer match.
