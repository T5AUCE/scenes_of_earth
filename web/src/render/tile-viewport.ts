/** Viewport and scene-to-tiles math shared by the scene preload and the shade prefetch. */
import type { Map as MapLibreMap } from "maplibre-gl";

import { warmTilesForZoom, type WarmTile } from "../contour-ladder";
import type { Bbox } from "../types";

/** Web Mercator stays finite below this latitude in degrees. */
export const WEB_MERCATOR_MAX_LAT_DEG = 85.05112878;

/** The Liberty basemap source, whose loads the readout groups as basemap. */
export const BASEMAP_SOURCE_ID = "openmaptiles";

/** The map surface the viewport math reads: zoom, centre, bounds and canvas size. */
export type ViewportMap = Pick<MapLibreMap, "getZoom" | "getCenter" | "getBounds" | "getCanvas">;

/** Switches for the viewport projection. */
export interface ViewportOptions {
  clampLatitude?: boolean;
}

/**
 * The viewport as it will be when MapLibre switches to the target zoom's tiles, with the same
 * centre and a span halved per level. Raster tiles round the zoom, so the shade prefetch looks
 * half a level ahead through the switch offset. A missing or zero-size canvas yields null so
 * the prefetch never starts without a visible map.
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
 * Project the viewport for an explicit centre without moving the camera. The span halves
 * per zoom level around the given centre, matching the map behaviour the target helper observes.
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

/**
 * The tiles that cover a scene bbox from one zoom down to the deepest zoom whose whole level
 * still fits the tile budget, coarsest zoom first and nearest the centre first within a zoom.
 * A level that would overflow the budget is left out entirely, because a partial deeper level
 * would only help the middle of the scene.
 */
export function scenePyramidTiles(
  bbox: Bbox,
  firstZoom: number,
  lastZoom: number,
  maxTiles: number,
): WarmTile[] {
  const tiles: WarmTile[] = [];
  for (let zoom = Math.max(0, firstZoom); zoom <= lastZoom; zoom += 1) {
    const remaining = maxTiles - tiles.length;
    // One tile past the remaining budget is enough to tell that the level does not fit.
    const level = warmTilesForZoom(bbox[0], bbox[1], bbox[2], bbox[3], zoom, remaining + 1)
      .filter((tile) => tileInScene(tile, bbox));
    if (level.length > remaining) break;
    tiles.push(...level);
  }
  return tiles;
}

/** Ancestor tiles warmed per zoom level on each dwell, so fallback stays covered. */
export const DWELL_ANCESTOR_TILES_PER_LEVEL = 12;
/** Next-level tiles warmed around the viewport on each dwell. */
export const DWELL_CHILD_TILES = 48;
/** Tiles warmed two levels down around the viewport centre on each dwell. */
export const DWELL_GRANDCHILD_TILES = 16;
/** Total tile requests a single dwell may issue across all levels. */
export const DWELL_REQUEST_CAP = 64;

/** The viewport a dwell warms, in degrees. */
export interface DwellViewport {
  west: number;
  south: number;
  east: number;
  north: number;
}

/**
 * Intersect a dwell viewport with a scene bbox, or null when they do not overlap.
 * Longitudes wrap past the antimeridian so crossing scenes still clip.
 */
export function clipViewportToBbox(
  viewport: DwellViewport,
  bbox: Bbox,
): DwellViewport | null {
  const south = Math.max(viewport.south, bbox[1]);
  const north = Math.min(viewport.north, bbox[3]);
  if (south > north) return null;
  const viewportWest = toLongitude360(viewport.west);
  const viewportWidth = viewport.east >= viewport.west
    ? viewport.east - viewport.west
    : viewport.east - viewport.west + 360;
  const boxWest = toLongitude360(bbox[0]);
  const boxWidth = bbox[2] - bbox[0];
  const shiftedWest = viewportWest + Math.round((boxWest - viewportWest) / 360) * 360;
  const overlapWest = Math.max(shiftedWest, boxWest);
  const overlapEast = Math.min(shiftedWest + viewportWidth, boxWest + boxWidth);
  if (overlapWest > overlapEast) return null;
  let west = overlapWest;
  let east = overlapEast;
  while (west > 180) {
    west -= 360;
    east -= 360;
  }
  while (west <= -180) {
    west += 360;
    east += 360;
  }

  return {
    west,
    south,
    east,
    north,
  };
}

/**
 * The tiles a dwell warms after the camera rests: the viewport's ancestors from the fitted
 * zoom to just below the current integer zoom, then the next level down and a smaller ring
 * two levels down. Ancestors come first so fallback coverage wins when the cap truncates,
 * and the centre-first order of each level keeps the middle warm while edges can wait.
 */
export function dwellWarmTiles(
  viewport: DwellViewport,
  fittedZoom: number,
  currentZoom: number,
): WarmTile[] {
  const current = Math.floor(currentZoom);
  const first = Math.max(0, Math.floor(fittedZoom));
  const warmed: WarmTile[] = [];
  const collect = (zoom: number, limit: number): void => {
    warmed.push(...warmTilesForZoom(
      viewport.west,
      viewport.south,
      viewport.east,
      viewport.north,
      zoom,
      limit,
    ));
  };
  for (let zoom = first; zoom < current; zoom += 1) {
    collect(zoom, DWELL_ANCESTOR_TILES_PER_LEVEL);
  }
  collect(current + 1, DWELL_CHILD_TILES);
  collect(current + 2, DWELL_GRANDCHILD_TILES);
  return warmed.slice(0, DWELL_REQUEST_CAP);
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

function toLongitude360(longitude: number): number {
  return ((longitude % 360) + 360) % 360;
}
