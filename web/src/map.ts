import { Map as MapLibreMap } from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
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
