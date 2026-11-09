/** Viewport-to-tiles math shared by the contour warmer and the shade prefetch. */
import type { Map as MapLibreMap } from "maplibre-gl";

import type { WarmTile } from "../contour-ladder";
import type { Bbox } from "../types";

/** Web Mercator stays finite below this latitude in degrees. */
export const WEB_MERCATOR_MAX_LAT_DEG = 85.05112878;

/** The map surface the viewport math reads: zoom, centre, bounds and canvas size. */
export type ViewportMap = Pick<MapLibreMap, "getZoom" | "getCenter" | "getBounds" | "getCanvas">;

/** Switches for the viewport projection that only the shade prefetch uses today. */
export interface ViewportOptions {
  clampLatitude?: boolean;
}

/**
 * The viewport as it will be when MapLibre switches to the target zoom's tiles, with the same
 * centre and a span halved per level. Raster tiles round the zoom, so the shade prefetch looks
 * half a level ahead through the switch offset while the contour warmer passes none. A missing
 * or zero-size canvas yields null so neither warmer starts without a visible map. Only the
 * shade caller clamps latitudes because the contour math keeps its earlier unclamped span.
 */
export function targetViewportBounds(
  map: ViewportMap,
  targetZoom: number,
  switchOffset = 0,
  options?: ViewportOptions,
): { west: number; south: number; east: number; north: number } | null {
  if (typeof map.getCenter !== "function" || typeof map.getCanvas !== "function") return null;
  const canvas = map.getCanvas();
  if (!canvas || !canvas.clientWidth || !canvas.clientHeight) return null;
  const current = viewportBounds(map);
  if (!current) return null;
  // The next zoom shows the same screen smaller, so its span shrinks by one doubling per level.
  const scale = 2 ** (map.getZoom() - (targetZoom - switchOffset));
  const centre = map.getCenter();
  const span = current.east >= current.west
    ? current.east - current.west
    : current.east - current.west + 360;
  const halfSpan = span / 2 * scale;
  const southLat = options?.clampLatitude ? clampLatitude(current.south) : current.south;
  const northLat = options?.clampLatitude ? clampLatitude(current.north) : current.north;
  const southY = mercatorY(southLat);
  const northY = mercatorY(northLat);
  const centreY = (southY + northY) / 2;
  const halfHeight = (southY - northY) / 2 * scale;
  return {
    west: centre.lng - halfSpan,
    south: inverseMercatorY(centreY + halfHeight),
    east: centre.lng + halfSpan,
    north: inverseMercatorY(centreY - halfHeight),
  };
}

/** Whether a slippy-map tile overlaps a scene bbox, checking the wrapped world copies too. */
export function tileInScene(tile: WarmTile, bbox: Bbox): boolean {
  const count = 2 ** tile.z;
  const width = 360 / count;
  const west = tile.x / count * 360 - 180;
  const north = inverseMercatorY(tile.y / count);
  const south = inverseMercatorY((tile.y + 1) / count);
  if (south > bbox[3] || north < bbox[1]) return false;

  return [west - 360, west, west + 360].some(
    (shifted) => shifted <= bbox[2] && shifted + width >= bbox[0],
  );
}

/** Web Mercator y of a latitude in degrees. */
export function mercatorY(latitude: number): number {
  const radians = latitude * Math.PI / 180;
  return (1 - Math.log(Math.tan(radians) + 1 / Math.cos(radians)) / Math.PI) / 2;
}

/** Latitude in degrees of a Web Mercator y. */
export function inverseMercatorY(fraction: number): number {
  return Math.atan(Math.sinh(Math.PI * (1 - 2 * fraction))) * 180 / Math.PI;
}

/** The current visible edges, or null when the map hides its bounds. */
function viewportBounds(map: ViewportMap): {
  west: number;
  south: number;
  east: number;
  north: number;
} | null {
  if (typeof map.getBounds !== "function") return null;
  const bounds = map.getBounds();
  return {
    west: bounds.getWest(),
    south: bounds.getSouth(),
    east: bounds.getEast(),
    north: bounds.getNorth(),
  };
}

function clampLatitude(latitude: number): number {
  return Math.min(
    Math.max(latitude, -WEB_MERCATOR_MAX_LAT_DEG),
    WEB_MERCATOR_MAX_LAT_DEG,
  );
}
