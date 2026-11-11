/** Create the basemap and manage scene imagery with camera and label-placement helpers. */
import {
  AttributionControl,
  LngLat,
  Map as MapLibreMap,
  MercatorCoordinate,
  type PaddingOptions,
  ScaleControl,
  setWorkerCount,
} from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";

import { maxPixelRatioSetting } from "./gesture-quality";
import { WORLD_WIDTH_DEG } from "./label-filter";
import { clampAround, nearestEquivalent, panLimit } from "./pan-lock";
import { imageCorners } from "./render/mercator";
import type { Bbox } from "./types";
import { scaleUnitForElevation } from "./units";

// OpenFreeMap needs no API key.
const BASEMAP_STYLE = "https://tiles.openfreemap.org/styles/liberty";
/** The map's highest zoom, used as the open upper end of layer zoom ranges. */
export const MAX_ZOOM = 24;
// MapLibre draws the world 512 px wide at zoom 0. Exported for the cache-bound test.
export const TILE_SIZE_PX = 512;
// Extra workers let basemap, hillshade and contour tiles settle in parallel.
const MAP_WORKER_COUNT = 3;
let workersConfigured = false;

// Zooming back after panning deep reuses tiles instead of reloading them.
export const MAX_TILE_CACHE_ZOOM_LEVELS = 8;
// MapLibre sizes each source out-of-view cache as its in-view count times the levels:
// 1280x800 at 512 px tiles holds (3+1)*(2+1)*8 = 96 slots, while 1920x1080 holds
// (4+1)*(3+1)*8 = 160. The cap covers both desktop viewports and bounds larger ones.
export const MAX_TILE_CACHE_SIZE = 160;

// WebGL guarantees at least this much; used when the context cannot be queried.
const GUARANTEED_TEXTURE_SIZE_PX = 4096;

/** The camera of the world view. */
export const WORLD_VIEW = { center: [0, 20] as [number, number], zoom: 1.5 };
const MAX_FIT_ZOOM = 10;
// The left side is wider because the side panel covers it.
const FIT_PADDING_PX = { top: 40, bottom: 40, left: 340, right: 40 };
/** Padding that shows a picked area with its surroundings, before a scene is built for it. */
export const BROWSE_PADDING_PX = { top: 120, bottom: 120, left: 460, right: 120 };
/** Highest zoom when showing a picked area. */
export const BROWSE_MAX_ZOOM = 8;

const PICKED_ID = "soe-picked-area";
const PICKED_COLOR_PROPERTY = "--pick-outline";
const PICKED_LINE_WIDTH_PX = 3;

// An imageless source never reports loaded, so dormant renderers seed this pixel.
const PLACEHOLDER_SIZE_PX = 1;

// The trial-only pixel ratio stays within normal device ratios.
const MIN_TRIAL_PIXEL_RATIO = 0.5;
const MAX_TRIAL_PIXEL_RATIO = 3;

// Projection round-off must not trigger another synchronous move event at the pan limit.
const CENTRE_TOLERANCE_WORLDS = 1e-12;

interface DrawableImage {
  updateImage(options: { image: ImageData }): void;
}

/** Creates the basemap, with its attribution at the bottom left. */
export function createMap(container: string): MapLibreMap {
  ensureWorkerCount();
  const ratio = cappedPixelRatio(location.search, devicePixelRatio());
  const map = new MapLibreMap({
    container,
    style: BASEMAP_STYLE,
    ...WORLD_VIEW,
    ...(ratio === undefined ? {} : { pixelRatio: ratio }),
    maxTileCacheZoomLevels: MAX_TILE_CACHE_ZOOM_LEVELS,
    maxTileCacheSize: MAX_TILE_CACHE_SIZE,
    attributionControl: false,
  });

  // Bottom right belongs to the scene column.
  map.addControl(new AttributionControl({ compact: false }), "bottom-left");
  return map;
}

/**
 * Reads the trial-only pixel-ratio override from the address bar, so the zoom
 * trial compares device ratios without a new build. Returns undefined when absent.
 */
export function trialPixelRatio(search: string): number | undefined {
  const value = new URLSearchParams(search).get("pixelRatio");
  if (value === null) return undefined;
  const ratio = Number(value);
  if (!Number.isFinite(ratio) || ratio < MIN_TRIAL_PIXEL_RATIO || ratio > MAX_TRIAL_PIXEL_RATIO) {
    return undefined;
  }
  return ratio;
}

/**
 * Combine the trial-only override with the measurement-only cap. The cap never changes
 * the default: without `maxPixelRatio` the override behaves as before, and with it the
 * map uses the lower of the override or device ratio and the cap. Exported for tests.
 */
export function cappedPixelRatio(search: string, deviceRatio: number): number | undefined {
  const override = trialPixelRatio(search);
  const cap = maxPixelRatioSetting(search);
  if (cap === undefined) return override;
  const base = override ?? (Number.isFinite(deviceRatio) && deviceRatio > 0 ? deviceRatio : 1);
  return Math.min(base, cap);
}

function devicePixelRatio(): number {
  return typeof window === "undefined" ? 1 : window.devicePixelRatio;
}

/** Set the worker count once, before the first map starts its workers. */
function ensureWorkerCount(): void {
  if (workersConfigured) return;
  workersConfigured = true;
  setWorkerCount(MAP_WORKER_COUNT);
}

/** Add a scale bar for reading dot spacing and return its removal callback. */
export function showScaleBar(map: MapLibreMap, elevationUnit = "m") {
  const control = new ScaleControl({ unit: scaleUnitForElevation(elevationUnit) });
  map.addControl(control, "bottom-left");
  return () => map.removeControl(control);
}

/** Moves the camera to fit the bbox, leaving room for the side panel. */
export function fitToBbox(
  map: MapLibreMap,
  [west, south, east, north]: Bbox,
  options: {
    padding?: PaddingOptions;
    duration?: number;
    maxZoom?: number;
  } = {},
) {
  map.fitBounds(
    [
      [west, south],
      [east, north],
    ],
    { padding: FIT_PADDING_PX, maxZoom: MAX_FIT_ZOOM, ...options },
  );
}

/** The camera fitToBbox ends at, or undefined when the box cannot be fitted. */
export function fitCamera(
  map: MapLibreMap,
  [west, south, east, north]: Bbox,
  padding: PaddingOptions,
) {
  const camera = map.cameraForBounds(
    [
      [west, south],
      [east, north],
    ],
    { padding, maxZoom: MAX_FIT_ZOOM },
  );
  if (!camera?.center || camera.zoom === undefined) return undefined;

  return { center: LngLat.convert(camera.center), zoom: camera.zoom };
}

/** Holds the centre inside the fitted view; setMaxBounds would cut the elastic zoom short. */
export function lockPan(map: MapLibreMap, fitted: { center: LngLat; zoom: number }) {
  const fittedCentre = MercatorCoordinate.fromLngLat(fitted.center);
  const fittedWorldPx = TILE_SIZE_PX * 2 ** fitted.zoom;

  const clampCentre = () => {
    const { clientWidth, clientHeight } = map.getCanvas();
    const { lng, lat } = map.getCenter();
    const centre = MercatorCoordinate.fromLngLat({
      lng: nearestEquivalent(lng, fitted.center.lng, WORLD_WIDTH_DEG),
      lat,
    });

    const zoom = map.getZoom();
    const limitX = panLimit(clientWidth / fittedWorldPx, fitted.zoom, zoom);
    const limitY = panLimit(clientHeight / fittedWorldPx, fitted.zoom, zoom);
    const x = clampAround(centre.x, fittedCentre.x, limitX);
    const y = clampAround(centre.y, fittedCentre.y, limitY);
    if (
      Math.abs(x - centre.x) <= CENTRE_TOLERANCE_WORLDS
      && Math.abs(y - centre.y) <= CENTRE_TOLERANCE_WORLDS
    ) return;

    map.setCenter(new MercatorCoordinate(x, y, 0).toLngLat());
  };

  map.on("move", clampCentre);
  clampCentre();

  return () => map.off("move", clampCentre);
}

/** Replaces any earlier outline; the geometry must already sit in the visible world copy. */
export function showPickedOutline(map: MapLibreMap, geometry: GeoJSON.Geometry) {
  clearPickedOutline(map);

  const color = getComputedStyle(document.documentElement).getPropertyValue(PICKED_COLOR_PROPERTY);
  map.addSource(PICKED_ID, { type: "geojson", data: geometry });

  map.addLayer({
    id: PICKED_ID,
    type: "line",
    source: PICKED_ID,
    paint: { "line-color": color.trim(), "line-width": PICKED_LINE_WIDTH_PX },
  });
}

/** Removes the picked area's outline, if any. */
export const clearPickedOutline = (map: MapLibreMap) => removeLayerAndSource(map, PICKED_ID);

/** Tile failures and aborts are routine while panning, so only other map errors are reported. */
export function reportMapErrors(map: MapLibreMap, report: (message: string) => void) {
  map.on("error", (event) => {
    const { error, tile } = event as typeof event & { tile?: unknown };
    const isAborted = (error as Error).name === "AbortError";
    if (tile || isAborted) return;

    report(error.message);
  });
}

/** Images wider or taller than this cannot be uploaded to the GPU as textures. */
export function maxTextureSize(map: MapLibreMap) {
  const canvas = map.getCanvas();
  const gl = canvas.getContext("webgl2") ?? canvas.getContext("webgl");
  if (!gl) return GUARANTEED_TEXTURE_SIZE_PX;

  return (gl.getParameter(gl.MAX_TEXTURE_SIZE) as number | null) ?? GUARANTEED_TEXTURE_SIZE_PX;
}

/** The first label layer; data layers go below it so the basemap's place names stay on top. */
export function firstSymbolId(map: MapLibreMap) {
  return map.getStyle().layers.find((layer) => layer.type === "symbol")?.id;
}

/** Adds an image layer over the bbox moved east by `shift`, seeded transparent until setImage. */
export function addImageLayer(
  map: MapLibreMap,
  id: string,
  bbox: Bbox,
  shift: number,
  beforeId: string | undefined,
  paint: Record<string, string | number | { duration: number }>,
) {
  map.addSource(id, { type: "image", coordinates: imageCorners(bbox, shift) });
  setImage(map, id, new ImageData(PLACEHOLDER_SIZE_PX, PLACEHOLDER_SIZE_PX));
  map.addLayer(
    { id, type: "raster", source: id, paint: { "raster-fade-duration": 0, ...paint } },
    beforeId,
  );
}

/**
 * Adds two image layers in one slot, the second above the first, whose opacity changes apply at
 * once so a crossfade can drive them every frame.
 */
export function addImagePair(
  map: MapLibreMap,
  ids: readonly [string, string],
  bbox: Bbox,
  shift: number,
  beforeId: string | undefined,
  paint: Record<string, string | number>,
) {
  for (const id of ids) {
    addImageLayer(map, id, bbox, shift, beforeId, {
      "raster-opacity": 0,
      "raster-opacity-transition": { duration: 0 },
      ...paint,
    });
  }
}

/** Sets the opacity of both layers of an image pair. */
export function setPairOpacities(
  map: MapLibreMap,
  ids: readonly [string, string],
  opacities: readonly [number, number],
) {
  ids.forEach((id, index) => map.setPaintProperty(id, "raster-opacity", opacities[index]));
}

/** Replaces the picture of a layer added with addImageLayer. */
export function setImage(map: MapLibreMap, id: string, image: ImageData) {
  (map.getSource(id) as unknown as DrawableImage | undefined)?.updateImage({ image });
}

function cancelError(): Error {
  const error = new Error("Entry preparation was cancelled");
  error.name = "AbortError";
  return error;
}

/**
 * Warm a hidden raster through its real source so the first visible render skips the upload.
 * The layer is made used with zero opacity, so nothing shows while the source prepares.
 * Polling only runs while the layer is made used, so a zoom-hidden source cannot deadlock it.
 * A loaded flag alone never certifies new bytes, so one frame runs before the flag is read.
 */
export async function warmHiddenRaster(
  map: MapLibreMap,
  id: string,
  signal?: AbortSignal,
): Promise<void> {
  if (signal?.aborted) throw cancelError();
  if (typeof map.getLayer !== "function" || !map.getLayer(id)) return;
  if (typeof map.isSourceLoaded !== "function") return;

  const layer = map.getLayer(id) as { minzoom?: number; maxzoom?: number } | undefined;
  const minzoom = layer?.minzoom ?? 0;
  const maxzoom = layer?.maxzoom ?? MAX_ZOOM;
  let opacity: unknown;
  try {
    opacity = map.getPaintProperty(id, "raster-opacity");
  } catch {
    opacity = undefined;
  }
  try {
    map.setLayerZoomRange(id, 0, MAX_ZOOM);
    map.setPaintProperty(id, "raster-opacity", 0);
    map.triggerRepaint();
    await frameOnce(signal);
    await waitForSource(map, id, signal);
  } finally {
    try {
      map.setLayerZoomRange(id, minzoom, maxzoom);
      if (typeof opacity === "number") map.setPaintProperty(id, "raster-opacity", opacity);
    } catch {
      // A torn-down map must not hide the warm-up result the caller already holds.
    }
  }
  if (signal?.aborted) throw cancelError();
}

function waitForSource(map: MapLibreMap, id: string, signal?: AbortSignal): Promise<void> {
  return new Promise((done, fail) => {
    if (signal?.aborted) {
      fail(cancelError());
      return;
    }
    let isSettled = false;
    let frame: number | ReturnType<typeof setTimeout> | undefined;
    const timer = setTimeout(() => {
      if (isSettled) return;
      isSettled = true;
      cancelFrame(frame);
      signal?.removeEventListener("abort", onAbort);
      fail(new Error(`Entry image ${id} never became ready`));
    }, 2000);
    const check = () => {
      if (isSettled) return;
      if (signal?.aborted) {
        isSettled = true;
        cancelFrame(frame);
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
        fail(cancelError());
        return;
      }
      try {
        if (map.isSourceLoaded(id)) {
          isSettled = true;
          cancelFrame(frame);
          clearTimeout(timer);
          signal?.removeEventListener("abort", onAbort);
          done();
          return;
        }
      } catch (error) {
        isSettled = true;
        cancelFrame(frame);
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
        fail(error);
        return;
      }
      map.triggerRepaint();
      frame = requestFrame(check);
    };
    const onAbort = () => {
      if (isSettled) return;
      isSettled = true;
      cancelFrame(frame);
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      fail(cancelError());
    };
    signal?.addEventListener("abort", onAbort, { once: true });
    check();
  });
}

/** Wait one frame so a hidden source prepares its current image before the flag is read. */
function frameOnce(signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.reject(cancelError());
  return new Promise((done, fail) => {
    const onAbort = () => {
      cancelFrame(frame);
      fail(cancelError());
    };
    const frame = requestFrame(() => {
      signal?.removeEventListener("abort", onAbort);
      done();
    });
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

function requestFrame(task: () => void): number | ReturnType<typeof setTimeout> {
  try {
    if (typeof requestAnimationFrame === "function") {
      return requestAnimationFrame(() => task());
    }
  } catch {
    // A missing frame scheduler falls through to the timer below.
  }
  return setTimeout(task, 16);
}

function cancelFrame(frame: number | ReturnType<typeof setTimeout> | undefined): void {
  if (frame === undefined) return;
  try {
    if (typeof cancelAnimationFrame === "function" && typeof frame === "number") {
      cancelAnimationFrame(frame);
      return;
    }
  } catch {
    // A missing canceller falls through to clearing the timer.
  }
  clearTimeout(frame as ReturnType<typeof setTimeout>);
}

/** Removes a layer and its source, whichever of them exist. */
export function removeLayerAndSource(map: MapLibreMap, id: string) {
  if (map.getLayer(id)) map.removeLayer(id);
  if (map.getSource(id)) map.removeSource(id);
}
