import { AttributionControl, Map as MapLibreMap, type PaddingOptions } from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
import { imageCorners } from "./render/mercator";
import type { Bbox } from "./types";

// OpenFreeMap: free, no API key.
const BASEMAP_STYLE = "https://tiles.openfreemap.org/styles/liberty";
export const WORLD_VIEW = { center: [0, 20] as [number, number], zoom: 1.5 };
const MAX_FIT_ZOOM = 10;
// WebGL guarantees at least this much; used when the context cannot be queried.
const GUARANTEED_TEXTURE_SIZE_PX = 4096;
// The left side is wider because the side panel covers it.
const FIT_PADDING_PX = { top: 40, bottom: 40, left: 340, right: 40 };

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
  options: { padding?: PaddingOptions; duration?: number } = {},
) {
  map.fitBounds(
    [[west, south], [east, north]],
    { padding: FIT_PADDING_PX, ...options, maxZoom: MAX_FIT_ZOOM },
  );
}

// The zoom fitToBbox ends at, or undefined when the box cannot be fitted.
export function fitZoom(
  map: MapLibreMap,
  [west, south, east, north]: Bbox,
  padding: PaddingOptions,
) {
  const camera = map.cameraForBounds(
    [[west, south], [east, north]],
    { padding, maxZoom: MAX_FIT_ZOOM },
  );

  return camera?.zoom;
}

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
