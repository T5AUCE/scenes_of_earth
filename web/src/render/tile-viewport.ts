/** Viewport-to-tiles math shared by the contour warmer and the shade prefetch. */
import type { Map as MapLibreMap } from "maplibre-gl";

import type { WarmTile } from "../contour-ladder";
import type { Bbox } from "../types";

/** Web Mercator stays finite below this latitude in degrees. */
export const WEB_MERCATOR_MAX_LAT_DEG = 85.05112878;

/** The Liberty basemap source, whose loads the readout groups as basemap. */
export const BASEMAP_SOURCE_ID = "openmaptiles";

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
  const centre = map.getCenter();

  return viewportBoundsForCenter(current, centre.lng, centre.lat, map.getZoom(), targetZoom,
    switchOffset, options?.clampLatitude === true);
}

/**
 * Project the viewport for an explicit centre, so the scheduler can score a predicted
 * destination without moving the camera. The span halves per zoom level around the given
 * centre, matching the map behaviour the target helper observes.
 */
export function viewportBoundsForCenter(
  current: { west: number; south: number; east: number; north: number },
  centreLng: number,
  centreLat: number,
  currentZoom: number,
  targetZoom: number,
  switchOffset = 0,
  clampLatitude = false,
): { west: number; south: number; east: number; north: number } {
  // The next zoom shows the same screen smaller, so its span shrinks by one doubling per level.
  const scale = 2 ** (currentZoom - (targetZoom - switchOffset));
  const span = current.east >= current.west
    ? current.east - current.west
    : current.east - current.west + 360;
  const halfSpan = span / 2 * scale;
  // The vertical midpoint follows the predicted centre, so north/south pans warm ahead too.
  const centreY = mercatorY(clampLatitude ? clampLatitudeValue(centreLat) : centreLat);
  const southY = mercatorY(clampLatitude ? clampLatitudeValue(current.south) : current.south);
  const northY = mercatorY(clampLatitude ? clampLatitudeValue(current.north) : current.north);
  const halfHeight = (southY - northY) / 2 * scale;
  return {
    west: centreLng - halfSpan,
    south: inverseMercatorY(centreY + halfHeight),
    east: centreLng + halfSpan,
    north: inverseMercatorY(centreY - halfHeight),
  };
}

/**
 * Extrapolate the centre destination from the measured pan velocity, wrapping longitude
 * and clamping latitude, so directional neighbours warm ahead of the viewport.
 */
export function predictDestinationCenter(
  lng: number,
  lat: number,
  lngVelocityPerSec: number,
  latVelocityPerSec: number,
  horizonSecs: number,
): { lng: number; lat: number } {
  return {
    lng: wrapLongitude(lng + lngVelocityPerSec * horizonSecs),
    lat: clampLatitudeValue(lat + latVelocityPerSec * horizonSecs),
  };
}

/** Shortest wrapped longitude step from one meridian to another, in degrees. */
export function longitudeDelta(fromLng: number, toLng: number): number {
  return ((toLng - fromLng + 540) % 360 + 360) % 360 - 180;
}

/**
 * The tile ranges a viewport covers at one zoom, so planning reruns only when the covered
 * tiles change and sub-tile pans keep the same key.
 */
export function tileRangeKey(
  bounds: { west: number; south: number; east: number; north: number },
  zoom: number,
): string {
  const count = 2 ** zoom;
  const firstColumn = Math.floor((bounds.west + 180) / 360 * count);
  const lastColumn = Math.floor((bounds.east + 180) / 360 * count);
  const firstRow = tileRow(bounds.north, count);
  const lastRow = tileRow(bounds.south, count);

  return `${zoom}:${firstColumn}-${lastColumn}:${firstRow}-${lastRow}`;
}

function tileRow(latitude: number, count: number): number {
  const row = Math.floor(mercatorY(clampLatitudeValue(latitude)) * count);

  return Math.min(count - 1, Math.max(0, row));
}

/** The cap the OpenFreeMap TileJSON advertises for its versioned vector tiles. */
export const BASEMAP_MAXZOOM = 14;

/** A resolved basemap source: versioned template plus its own zoom ceiling. */
export interface BasemapDescriptor {
  template: string;
  maxzoom: number;
}

/**
 * Read the basemap descriptor from the loaded source, whose TileJSON extends the instance
 * with resolved tiles, falling back to inline style tiles. Serialized style options keep
 * only the TileJSON url, so the style alone can never resolve the template in production.
 */
export function basemapDescriptor(
  map: {
    getSource?: (id: string) => unknown;
    getStyle?: () => { sources?: unknown } | undefined;
  },
): BasemapDescriptor | null {
  try {
    const live = map.getSource?.(BASEMAP_SOURCE_ID) as
      | { tiles?: unknown; maxzoom?: unknown }
      | undefined;
    if (Array.isArray(live?.tiles) && typeof live.tiles[0] === "string") {
      return {
        template: live.tiles[0] as string,
        maxzoom: typeof live.maxzoom === "number" ? live.maxzoom : BASEMAP_MAXZOOM,
      };
    }
    const sources = map.getStyle?.()?.sources as
      | Record<string, { tiles?: unknown; maxzoom?: unknown }>
      | undefined;
    const styled = sources?.[BASEMAP_SOURCE_ID];
    if (Array.isArray(styled?.tiles) && typeof styled.tiles[0] === "string") {
      return {
        template: styled.tiles[0] as string,
        maxzoom: typeof styled.maxzoom === "number" ? styled.maxzoom : BASEMAP_MAXZOOM,
      };
    }
    return null;
  } catch {
    return null;
  }
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

function clampLatitudeValue(latitude: number): number {
  return Math.min(
    Math.max(latitude, -WEB_MERCATOR_MAX_LAT_DEG),
    WEB_MERCATOR_MAX_LAT_DEG,
  );
}

/** Wrap a longitude to the map's principal range, keeping destination keys stable. */
function wrapLongitude(longitude: number): number {
  return ((longitude + 180) % 360 + 360) % 360 - 180;
}
