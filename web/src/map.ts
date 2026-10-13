import {
  AttributionControl,
  LngLat,
  Map as MapLibreMap,
  type LayerSpecification,
  MercatorCoordinate,
  type PaddingOptions,
} from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";

import { areaFilter, type TileArea, WORLD_WIDTH_DEGREES } from "./label-filter";
import { clampAround, nearestEquivalent, panLimit } from "./pan-lock";
import { imageCorners } from "./render/mercator";
import type { Bbox } from "./types";

// OpenFreeMap: free, no API key.
const BASEMAP_STYLE = "https://tiles.openfreemap.org/styles/liberty";
export const MAX_ZOOM = 24;
// MapLibre draws the world 512 px wide at zoom 0.
const TILE_SIZE_PX = 512;
// WebGL guarantees at least this much; used when the context cannot be queried.
const GUARANTEED_TEXTURE_SIZE_PX = 4096;

export const WORLD_VIEW = { center: [0, 20] as [number, number], zoom: 1.5 };
const MAX_FIT_ZOOM = 10;
// The left side is wider because the side panel covers it.
const FIT_PADDING_PX = { top: 40, bottom: 40, left: 340, right: 40 };
// A picked area is shown with its surroundings, before a scene is built for it.
export const BROWSE_PADDING_PX = { top: 120, bottom: 120, left: 460, right: 120 };
export const BROWSE_MAX_ZOOM = 8;

const PICKED_ID = "soe-picked-area";
const PICKED_COLOR_PROPERTY = "--pick-outline";
const PICKED_LINE_WIDTH_PX = 3;

const AREA_LABEL_SUFFIX = "-in-area";

interface DrawableImage {
  updateImage(options: { image: ImageData }): void;
}

export function createMap(container: string): MapLibreMap {
  const map = new MapLibreMap({
    container,
    style: BASEMAP_STYLE,
    ...WORLD_VIEW,
    attributionControl: false,
  });

  // Bottom right belongs to the scene column.
  map.addControl(new AttributionControl({ compact: false }), "bottom-left");

  return map;
}

export function fitToBbox(
  map: MapLibreMap,
  [west, south, east, north]: Bbox,
  options: { padding?: PaddingOptions; duration?: number; maxZoom?: number } = {},
) {
  map.fitBounds(
    [[west, south], [east, north]],
    { padding: FIT_PADDING_PX, maxZoom: MAX_FIT_ZOOM, ...options },
  );
}

// The camera fitToBbox ends at, or undefined when the box cannot be fitted.
export function fitCamera(
  map: MapLibreMap,
  [west, south, east, north]: Bbox,
  padding: PaddingOptions,
) {
  const camera = map.cameraForBounds(
    [[west, south], [east, north]],
    { padding, maxZoom: MAX_FIT_ZOOM },
  );
  if (!camera?.center || camera.zoom === undefined) return undefined;

  return { center: LngLat.convert(camera.center), zoom: camera.zoom };
}

// Holds the centre inside the fitted view (not setMaxBounds, which cuts the elastic zoom short).
export function lockPan(map: MapLibreMap, fitted: { center: LngLat; zoom: number }) {
  const fittedCentre = MercatorCoordinate.fromLngLat(fitted.center);
  const fittedWorldPx = TILE_SIZE_PX * 2 ** fitted.zoom;

  const clampCentre = () => {
    const { clientWidth, clientHeight } = map.getCanvas();
    const { lng, lat } = map.getCenter();
    const centre = MercatorCoordinate.fromLngLat({
      lng: nearestEquivalent(lng, fitted.center.lng, WORLD_WIDTH_DEGREES),
      lat,
    });

    const zoom = map.getZoom();
    const limitX = panLimit(clientWidth / fittedWorldPx, fitted.zoom, zoom);
    const limitY = panLimit(clientHeight / fittedWorldPx, fitted.zoom, zoom);
    const x = clampAround(centre.x, fittedCentre.x, limitX);
    const y = clampAround(centre.y, fittedCentre.y, limitY);
    if (x === centre.x && y === centre.y) return;

    map.setCenter(new MercatorCoordinate(x, y, 0).toLngLat());
  };

  map.on("move", clampCentre);
  clampCentre();

  return () => map.off("move", clampCentre);
}

// Replaces any earlier outline; the geometry must already sit in the visible world copy.
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

export const clearPickedOutline = (map: MapLibreMap) => removeLayerAndSource(map, PICKED_ID);

// Tile failures and aborts are routine while panning, so only other map errors are reported.
export function reportMapErrors(map: MapLibreMap, report: (message: string) => void) {
  map.on("error", (event) => {
    const { error, tile } = event as typeof event & { tile?: unknown };
    const isAborted = (error as Error).name === "AbortError";
    if (tile || isAborted) return;

    report(error.message);
  });
}

// Images wider or taller than this cannot be uploaded to the GPU as textures.
export function maxTextureSize(map: MapLibreMap) {
  const canvas = map.getCanvas();
  const gl = canvas.getContext("webgl2") ?? canvas.getContext("webgl");
  if (!gl) return GUARANTEED_TEXTURE_SIZE_PX;

  return (gl.getParameter(gl.MAX_TEXTURE_SIZE) as number | null) ?? GUARANTEED_TEXTURE_SIZE_PX;
}

// The first label layer; data layers go below it so the basemap's place names stay on top.
export function firstSymbolId(map: MapLibreMap) {
  return map.getStyle().layers.find((layer) => layer.type === "symbol")?.id;
}

// The source starts empty; the image arrives later through setImage.
export function addImageLayer(
  map: MapLibreMap,
  id: string,
  bbox: Bbox,
  beforeId: string | undefined,
  paint: Record<string, string | number>,
) {
  map.addSource(id, { type: "image", coordinates: imageCorners(bbox) });
  map.addLayer(
    { id, type: "raster", source: id, paint: { "raster-fade-duration": 0, ...paint } },
    beforeId,
  );
}

export function setImage(map: MapLibreMap, id: string, image: ImageData) {
  (map.getSource(id) as unknown as DrawableImage | undefined)?.updateImage({ image });
}

export function removeLayerAndSource(map: MapLibreMap, id: string) {
  if (map.getLayer(id)) map.removeLayer(id);
  if (map.getSource(id)) map.removeSource(id);
}

// Labels are copied above the mask, limited to the area, and the originals give way; returns undo.
export function moveLabelsIntoArea(map: MapLibreMap, area: TileArea, fromZoom: number) {
  const labelLayers = map.getStyle().layers.filter((layer) => layer.type === "symbol");

  const originals = labelLayers.map((layer) => {
    const minzoom = layer.minzoom ?? 0;
    const maxzoom = layer.maxzoom ?? MAX_ZOOM;
    const switchZoom = Math.max(minzoom, fromZoom);

    map.setLayerZoomRange(layer.id, minzoom, switchZoom);

    map.addLayer({
      ...layer,
      id: `${layer.id}${AREA_LABEL_SUFFIX}`,
      filter: areaFilter(layer.filter, area, Boolean(layer.layout?.["icon-image"])),
      minzoom: switchZoom,
      maxzoom,
    } as LayerSpecification);

    return { id: layer.id, minzoom, maxzoom };
  });

  return () => {
    for (const { id, minzoom, maxzoom } of originals) {
      map.removeLayer(`${id}${AREA_LABEL_SUFFIX}`);
      map.setLayerZoomRange(id, minzoom, maxzoom);
    }
  };
}
