# Visual trial

Measures the map of built scenes in headless Chromium, so a browser check takes a few minutes.

```
cd web
npm run trial -- contours --start            # real backend and Vite on free ports, stopped afterwards
npm run trial -- places.json --app http://127.0.0.1:5173 --screens --out /tmp/x
```

One JSON line per spot and zoom goes to stdout and to `<out>/results.jsonl`; the default `<out>` is
`web/.trial-cache/runs/<timestamp>`. Screenshots (`--screens`) are one per view. `--parallel n`
sets how many spots run at once (default 3).

## Browser setup

Run `web/scripts/visual-trial/setup.sh` once per container. It downloads Chromium
headless shell and the missing system libraries into `~/.cache/soe-visual-trial` (override with
`SOE_TRIAL_BROWSER_DIR`) and needs no root. An existing `/tmp/opencode/m5-visual-tools` is used as
is. The cache is lost when the container is rebuilt; adding the packages of `LIB_PACKAGES` to the
devcontainer image would make the libraries permanent.

## Places file

```json
{"spots": [{"name": "Nairobi", "area": "sample:kenya", "centre": [36.82, -1.29],
            "zooms": ["fitted", 9, 12], "layers": ["terrain"], "enable": ["Smooth"]}]}
```

`area` is a boundary id or a name the area search accepts. `layers` are the backend layers to
build (default `["terrain"]`; `start` and `end` may be added for time-varying layers). `enable`
lists checkbox labels in the scene panel to switch on. Presets live in `places/`.

Scenes come from `POST /api/scenes`, so a bundle that matches the request is reused and nothing is
ever deleted.

## Result fields

- `label_features`: contour label features MapLibre renders.
- `nearest_label_px`: distance from the map centre to the nearest labelled contour line. The label
  sits somewhere on that line, so this is a lower bound.
- `line_features`: rendered contour line features.
- `tiles_loaded`, `timed_out`: whether the view settled within 60 s.
- `failed_requests`: HTTP errors other than the two below. `dem_404` (Mapterhorn has no ocean tiles)
  and `glyph_404` (a known basemap font gap) are normal and counted apart.
- `errors`, `error_samples`: console and MapLibre errors and warnings.
- `legend`: the contour line of the legend.

Contour layer ids are matched by the patterns at the top of `measure.mjs`.

## Caching and pitfalls

- Responses from tiles.mapterhorn.com and tiles.openfreemap.org are stored in
  `web/.trial-cache/http` and served from disk on later runs. Delete that folder to refresh.
- `--start` always starts a fresh Vite because its file watcher misses edits on this mount. With
  `--app`, restart Vite yourself after editing source.
- A view is settled when two successive MapLibre `idle` samples agree; there are no fixed sleeps.
