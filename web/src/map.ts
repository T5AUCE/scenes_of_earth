import { Map as MapLibreMap } from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
import { imageCorners } from "./render/mercator";
import type { Bbox } from "./types";

// OpenFreeMap: free, no API key.
const BASEMAP_STYLE = "https://tiles.openfreemap.org/styles/liberty";

export function createMap(container: string): MapLibreMap {
  return new MapLibreMap({
    container,
    style: BASEMAP_STYLE,
    center: [0, 20],
    zoom: 1.5,
    attributionControl: { compact: false },
  });
}

export function fitToBbox(map: MapLibreMap, [w, s, e, n]: Bbox) {
  map.fitBounds([[w, s], [e, n]], { padding: { top: 40, bottom: 40, left: 340, right: 40 }, maxZoom: 10 });
}

// The first label layer; data layers go below it so the basemap's place names stay on top.
export function firstSymbolId(map: MapLibreMap) {
  return map.getStyle().layers.find((layer) => layer.type === "symbol")?.id;
}

interface DrawableImage {
  updateImage(options: { image: ImageData }): void;
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
