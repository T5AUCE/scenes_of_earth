/** Gate categorical colour on parsed basemap water tiles so a pan never flashes land. */
import type { Map as MapLibreMap } from "maplibre-gl";

import { warmTilesForZoom } from "../contour-ladder";
import {
  BASEMAP_MAXZOOM,
  BASEMAP_SOURCE_ID,
  basemapDescriptor,
  clipViewportToBbox,
  inverseMercatorY,
} from "../render/tile-viewport";
import type { Bbox } from "../types";

/** One ideal basemap tile that has parsed, with its world copy. */
export interface ReadyWaterTile {
  z: number;
  x: number;
  y: number;
  wrap: number;
}

/** The parsed footprint set with a key for its tile list. */
export interface WaterCoverage {
  key: string;
  tiles: ReadyWaterTile[];
}

/** One tile footprint as four screen points in clockwise order. */
export interface WaterScreenQuad {
  points: [
    { x: number; y: number },
    { x: number; y: number },
    { x: number; y: number },
    { x: number; y: number },
  ];
}

/** List the ideal basemap tiles that have parsed, including dry tiles without water. */
export function readyWaterCoverage(map: MapLibreMap): WaterCoverage | null {
  const manager = basemapTileManager(map);
  if (!manager) return null;

  try {
    const zoom = Math.floor(map.getZoom());
    const keys = manager.getRenderableIds?.() ?? [];
    const tiles: ReadyWaterTile[] = [];

    for (const key of keys) {
      const tile = manager.getTileById?.(key);
      const id = tile?.tileID;
      // Ideal tiles carry the current zoom as their overscaled zoom.
      if (!id || id.overscaledZ !== zoom) continue;
      // Loaded state proves the parse finished, so dry tiles need no bucket.
      if (tile?.state !== "loaded") continue;

      const canonical = id.canonical;
      if (!canonical) continue;

      tiles.push({ z: canonical.z, x: canonical.x, y: canonical.y, wrap: id.wrap ?? 0 });
    }

    const key = [
      zoom,
      tiles
        .map(({ z, x, y, wrap }) => `${wrap}:${z}/${x}/${y}`)
        .sort()
        .join(","),
    ].join("|");

    return { key, tiles };
  } catch {
    return null;
  }
}

/** Project the ready tiles as screen quads so rotation and pitch keep their shape. */
export function waterScreenQuads(map: MapLibreMap, coverage: WaterCoverage): WaterScreenQuad[] {
  try {
    const projector = (
      map as unknown as { project?: (point: [number, number]) => { x: number; y: number } }
    ).project;
    const canvas = map.getCanvas?.() as { clientWidth?: number; clientHeight?: number } | undefined;

    if (typeof projector !== "function") return [];
    if (!canvas || !canvas.clientWidth || !canvas.clientHeight) return [];

    const quads: WaterScreenQuad[] = [];

    for (const tile of coverage.tiles) {
      const bounds = waterTileBounds(tile);
      const west = bounds.west + tile.wrap * 360;
      const east = bounds.east + tile.wrap * 360;
      // Four corners survive bearing and pitch while two corners cannot.
      const northwest = projector.call(map, [west, bounds.north]);
      const northeast = projector.call(map, [east, bounds.north]);
      const southeast = projector.call(map, [east, bounds.south]);
      const southwest = projector.call(map, [west, bounds.south]);

      if (!northwest || !northeast || !southeast || !southwest) continue;

      quads.push({ points: [northwest, northeast, southeast, southwest] });
    }

    return quads;
  } catch {
    return [];
  }
}

/** Whether every viewed scene tile has parsed, using overzoomed canonical tiles above z14. */
export function isWaterCoverageComplete(
  map: MapLibreMap,
  coverage: WaterCoverage,
  bbox: Bbox,
  shift = 0,
): boolean {
  try {
    const zoomOf = (map as unknown as { getZoom?: () => number }).getZoom;

    if (typeof zoomOf !== "function") return true;

    const zoom = Math.floor(zoomOf.call(map));
    if (!Number.isFinite(zoom)) return true;

    const shifted: Bbox = [bbox[0] + shift, bbox[1], bbox[2] + shift, bbox[3]];
    let west = shifted[0];
    let south = shifted[1];
    let east = shifted[2];
    let north = shifted[3];

    const boundsOf = (map as unknown as { getBounds?: () => unknown }).getBounds;

    if (typeof boundsOf === "function") {
      const bounds = boundsOf.call(map) as {
        getWest: () => number;
        getSouth: () => number;
        getEast: () => number;
        getNorth: () => number;
      };
      const clipped = clipViewportToBbox(
        {
          west: bounds.getWest(),
          south: bounds.getSouth(),
          east: bounds.getEast(),
          north: bounds.getNorth(),
        },
        shifted,
      );

      // Nothing viewed means nothing can flash, so the hidden layer may show.
      if (!clipped) return true;

      west = clipped.west;
      south = clipped.south;
      east = clipped.east;
      north = clipped.north;
    }

    // Above the basemap ceiling the source serves overzoomed parents of the ideal tiles.
    const effective = Math.min(zoom, basemapMaxZoom(map));
    const expected = warmTilesForZoom(west, south, east, north, effective, 512);
    if (expected.length === 0) return true;

    const ready = new Set(coverage.tiles.map((tile) => `${tile.z}/${tile.x}/${tile.y}`));

    return expected.every((tile) => ready.has(`${tile.z}/${tile.x}/${tile.y}`));
  } catch {
    // An unreadable viewport must not flash land, so it reads as incomplete.
    return false;
  }
}

/** Whether the style provably has no water fill, so the gate may stay open. */
export function isBasemapWaterAbsent(map: MapLibreMap): boolean {
  try {
    const getter = (map as unknown as { getStyle?: () => unknown }).getStyle;

    if (typeof getter === "function") {
      const style = getter.call(map) as { layers?: { type?: string; ["source-layer"]?: string }[] };
      const layers = style?.layers;

      if (!layers) return false;

      return !layers.some((layer) => layer.type === "fill" && layer["source-layer"] === "water");
    }

    // Test doubles carry managers without a style getter, so their presence proves water.
    const managers = (map as unknown as { style?: unknown }).style as
      | { tileManagers?: Record<string, unknown> }
      | undefined;

    if (managers?.tileManagers?.[BASEMAP_SOURCE_ID]) return false;

    return true;
  } catch {
    return false;
  }
}

/** The basemap source ceiling, falling back to the TileJSON default. */
export function basemapMaxZoom(map: MapLibreMap): number {
  try {
    return basemapDescriptor(map)?.maxzoom ?? BASEMAP_MAXZOOM;
  } catch {
    return BASEMAP_MAXZOOM;
  }
}

let warnedUnknown = false;

/** Warn once when coverage cannot be established, so a broken accessor stays visible. */
export function noteWaterReadinessUnknown(): void {
  if (warnedUnknown) return;
  warnedUnknown = true;

  try {
    console.warn("Basemap water readiness is unknown, so categorical colour stays hidden.");
  } catch {
    // Logging must not hide the diagnostic it reports.
  }
}

/** Reset the once-only warning, which tests use between cases. */
export function resetWaterReadinessWarningsForTests(): void {
  warnedUnknown = false;
}

/** Slippy math gives the tile edges without a map query. */
function waterTileBounds(tile: ReadyWaterTile) {
  const count = 2 ** tile.z;

  return {
    west: (tile.x / count) * 360 - 180,
    east: ((tile.x + 1) / count) * 360 - 180,
    north: inverseMercatorY(tile.y / count),
    south: inverseMercatorY((tile.y + 1) / count),
  };
}

/** Read the private tile manager because MapLibre exposes no parsed-state accessor. */
function basemapTileManager(map: MapLibreMap): TileManagerPrivate | null {
  try {
    const style = (map as unknown as { style?: unknown }).style as
      | { tileManagers?: Record<string, TileManagerPrivate> }
      | undefined;
    const direct = style?.tileManagers?.[BASEMAP_SOURCE_ID];
    if (direct) return direct;

    const getter = (map as unknown as { getStyle?: () => unknown }).getStyle?.() as
      | { tileManagers?: Record<string, TileManagerPrivate> }
      | undefined;

    return getter?.tileManagers?.[BASEMAP_SOURCE_ID] ?? null;
  } catch {
    return null;
  }
}

interface TileManagerPrivate {
  getTileById?: (key: string) => TilePrivate | undefined;
  getRenderableIds?: () => string[];
}

/** A vector tile with the parse state the coverage check needs. */
interface TilePrivate {
  tileID?: { overscaledZ?: number; wrap?: number; canonical?: { z: number; x: number; y: number } };
  state?: string;
}
