import { Map as MapLibreMap } from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";

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
