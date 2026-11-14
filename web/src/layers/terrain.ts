/** Combine terrain shading with contours and adapt relief strength to colour fills. */
import type { Map as MapLibreMap } from "maplibre-gl";

import { CONTOUR_COLORS, contourColor, DEFAULT_CONTOUR_COLOR } from "../render/palettes";
import { displayUnitFor, isUnitFor, unitOptions } from "../units";
import type {
  LayerContext,
  LayerControl,
  LayerMenu,
  LayerView,
  TerrainStats,
  UnitsMenu,
} from "../types";
import {
  cappedDemMaxZoom,
  ContourOverlay,
  sharedDemSource,
  terrainTileBounds,
} from "./contour-overlay";
import { RELIEF_STRENGTH } from "./relief";
import { DEM_PRELOAD_ID, demFetcherFor, demPreloadSource } from "./scene-preload";
import { ShadeRaster } from "./shade-raster";
import { currentScenePreload } from "./tile-prefetch";

// Shade over a colour fill is eased so the colour stays readable.
const COLOUR_UNDER_FACTOR = 0.75;
// One transient or missing tile must not warn while the rest of the terrain can still draw.
const TILE_FAILURES_BEFORE_WARNING = 3;
const MISSING_TILE_MESSAGE_PREFIX = "Bad response: 404";
// Workers rebuild maplibre-contour errors from strings, so messages keep an "Error: " prefix.
const WORKER_ERROR_PREFIX = "Error: ";

type TileCoordinates = { z: number; x: number; y: number };

type TerrainTileEvent = {
  sourceId?: string;
  tile?: { tileID?: { canonical?: TileCoordinates } };
  error?: { name?: string; message?: string; status?: number };
};

type TerrainSourceState = {
  failures: number;
  hasLoadedTile: boolean;
};

/**
 * A terrain view with its relief base refit. The scene refits the pinned base once entry
 * lands, because the shading only sees the mount-time zoom while the camera still flies.
 */
export interface TerrainView extends LayerView {
  /** Refit the pinned relief base to the fitted zoom, warming its levels. */
  setBaseZoom(zoom: number): void;
}

const liveTerrainBases = new Map<ShadeRaster, MapLibreMap>();

/** Terrain shading from Mapterhorn tiles and contour lines for one terrain layer. */
export function createTerrainView(context: LayerContext): TerrainView {
  const { map, layer, slots, report } = context;
  const { tiles, stats } = layer;
  if (!tiles || !stats) throw new Error("Terrain needs tile metadata and summary statistics");

  const dem = sharedDemSource(tiles);
  const id = `${layer.id}-relief`;
  // Worker-shaded raster tiles fade in natively, so relief never pops in.
  const shading = new ShadeRaster(map, {
    id,
    tiles,
    maxzoom: cappedDemMaxZoom(tiles.maxzoom),
    bounds: terrainTileBounds(layer.grid.bbox),
    bbox: layer.grid.bbox,
    strength: RELIEF_STRENGTH.initial,
    beforeId: slots.shade,
  });
  const preload = currentScenePreload();
  let contourOverlay: ContourOverlay | undefined;
  let stopWatchingTiles: (() => void) | undefined;
  try {
    let strengthValue = RELIEF_STRENGTH.initial;
    let isUnderColour = false;
    const applyStrength = () => {
      shading.setStrength(strengthValue * (isUnderColour ? COLOUR_UNDER_FACTOR : 1));
    };

    const strength: LayerControl = {
      label: "Relief strength",
      hint: "Change intensity using slider",
      min: RELIEF_STRENGTH.min,
      max: RELIEF_STRENGTH.max,
      step: RELIEF_STRENGTH.step,
      get value() {
        return strengthValue;
      },
      set: (value) => {
        strengthValue = value;
        applyStrength();
      },
    };

    // The contour traces wait for the elevation tiles, so the DEM registers first.
    preload?.add(demPreloadSource({
      template: tiles.url,
      maxzoom: cappedDemMaxZoom(tiles.maxzoom),
      bbox: layer.grid.bbox,
      fetcher: demFetcherFor(dem),
    }));
    contourOverlay = new ContourOverlay(context, dem, tiles, stats as TerrainStats, preload);
    const overlay = contourOverlay;
    stopWatchingTiles = watchTerrainTiles(
      map,
      [id, ...overlay.contourSourceIds],
      report,
    );
    const stop = stopWatchingTiles;

    let palette = context.display?.palette ?? DEFAULT_CONTOUR_COLOR;
    let elevationUnit = displayUnitFor(layer.units, context.display?.units);
    const menuUpdates = new EventTarget();
    const menu: LayerMenu = {
      title: layer.title,
      heading: "Contour colour",
      blocks: true,
      palettes: CONTOUR_COLORS.map(({ name, label, color }) => ({ name, label, colors: [color] })),
      defaultPalette: DEFAULT_CONTOUR_COLOR,
      custom: false,
      updates: menuUpdates,
      get palette() {
        return palette;
      },
      setPalette(name) {
        palette = name;
        overlay.setColor(contourColor(name)!);
      },
      units: createUnitsMenu(),
    };

    function createUnitsMenu(): UnitsMenu | undefined {
      const options = unitOptions(layer.units);
      if (!options) return undefined;

      return {
        options,
        defaultUnit: layer.units,
        get value() {
          return elevationUnit;
        },
        set: (unit) => {
          if (!isUnitFor(layer.units, unit) || unit === elevationUnit) return;

          elevationUnit = unit;
          overlay.setUnits(unit);
          menuUpdates.dispatchEvent(new Event("change"));
        },
      };
    }

    // The registry fills only after the terrain mounts, so a failed setup never forwards zooms.
    liveTerrainBases.set(shading, map);
    return {
      parts: [
        { id: layer.id, label: "Relief", layerIds: [id], controls: [strength] },
        overlay.part,
      ],
      options: [],
      menu,
      time: null,
      setTime: () => {},
      setColourUnder: (isUnder) => {
        isUnderColour = isUnder;
        applyStrength();
      },
      setBaseZoom: (zoom) => {
        shading.setBaseZoom(zoom);
      },
      legend: () => overlay.legend,
      destroy: () => {
        try {
          stop();
          preload?.remove(DEM_PRELOAD_ID);
          overlay.destroy();
        } finally {
          liveTerrainBases.delete(shading);
          shading.destroy();
        }
      },
    };
  } catch (error) {
    // A failed mount leaves no view to destroy, so the shading rolls back here.
    try {
      stopWatchingTiles?.();
      contourOverlay?.destroy();
      preload?.remove(DEM_PRELOAD_ID);
    } finally {
      liveTerrainBases.delete(shading);
      shading.destroy();
    }
    throw error;
  }
}

/**
 * Refit every live terrain base on one map to the fitted zoom. Entry calls this after
 * landing and on every refit, so the mount-time zoom never pins the wrong levels.
 */
export function setTerrainBaseZoom(map: MapLibreMap, zoom: number): void {
  for (const [shading, owner] of liveTerrainBases) {
    if (owner === map) shading.setBaseZoom(zoom);
  }
}

// Missing ocean tiles stay missing, so a bounded memo warns once per tile instead of every zoom.
export const MAX_MISSING_TILES = 2000;
const missingTiles = new Map<string, true>();

/** Warn after one terrain source repeatedly fails before it has loaded a tile. */
export function watchTerrainTiles(
  map: MapLibreMap,
  sourceIds: readonly string[],
  report: LayerContext["report"],
): () => void {
  const sources = new Map<string, TerrainSourceState>();
  for (const sourceId of sourceIds) {
    sources.set(sourceId, { failures: 0, hasLoadedTile: false });
  }
  let withdrawWarning: (() => void) | null = null;

  const sourceState = (sourceId: string | undefined): TerrainSourceState | undefined => {
    if (sourceId === undefined) return undefined;
    return sources.get(sourceId);
  };

  const onError = (event: object) => {
    const { sourceId, tile, error = {} } = event as TerrainTileEvent;
    const source = sourceState(sourceId);
    if (!source) return;
    if (isBenignTileError(error)) {
      warnOnceForMissingTile(sourceId, tile, error);
      return;
    }

    console.warn("Terrain tile failed", {
      source: sourceId,
      tile: tileLabel(tile),
      message: error.message,
    });
    source.failures += 1;
    if (withdrawWarning || !hasUnhealthySource(sources)) return;

    withdrawWarning = report(new Error("Terrain shading or contour tiles could not be loaded"));
  };

  const onSourceData = (event: object) => {
    const { sourceId, tile } = event as TerrainTileEvent;
    const source = sourceState(sourceId);
    if (!source || !tile) return;

    source.hasLoadedTile = true;
    if (!withdrawWarning || hasUnhealthySource(sources)) return;

    withdrawWarning();
    withdrawWarning = null;
  };

  map.on("error", onError);
  map.on("sourcedata", onSourceData);

  return () => {
    map.off("error", onError);
    map.off("sourcedata", onSourceData);
    withdrawWarning?.();
  };
}

function isBenignTileError(error: NonNullable<TerrainTileEvent["error"]>): boolean {
  if (error.name === "AbortError" || error.status === 404) return true;

  const message = stripWorkerErrorPrefix(error.message);
  return message === "aborted" || message?.startsWith(MISSING_TILE_MESSAGE_PREFIX) === true;
}

/** Warn once per missing tile key; aborts are routine while panning and stay silent. */
function warnOnceForMissingTile(
  sourceId: string | undefined,
  tile: TerrainTileEvent["tile"],
  error: NonNullable<TerrainTileEvent["error"]>,
): void {
  if (!isMissingTile(error)) return;
  const key = `${sourceId}:${tileLabel(tile)}`;
  if (missingTiles.has(key)) return;
  if (missingTiles.size >= MAX_MISSING_TILES) {
    const oldest = missingTiles.keys().next().value;
    if (oldest !== undefined) missingTiles.delete(oldest);
  }
  missingTiles.set(key, true);
  console.warn("Terrain tile failed", {
    source: sourceId,
    tile: tileLabel(tile),
    message: error.message,
  });
}

function isMissingTile(error: NonNullable<TerrainTileEvent["error"]>): boolean {
  if (error.status === 404) return true;

  const message = stripWorkerErrorPrefix(error.message);
  return message?.startsWith(MISSING_TILE_MESSAGE_PREFIX) === true;
}

function stripWorkerErrorPrefix(message: string | undefined): string | undefined {
  if (!message?.startsWith(WORKER_ERROR_PREFIX)) return message;
  return message.slice(WORKER_ERROR_PREFIX.length);
}

function hasUnhealthySource(sources: ReadonlyMap<string, TerrainSourceState>): boolean {
  return [...sources.values()].some(isUnhealthySource);
}

function isUnhealthySource(source: TerrainSourceState): boolean {
  return source.failures >= TILE_FAILURES_BEFORE_WARNING && !source.hasLoadedTile;
}

function tileLabel(tile: TerrainTileEvent["tile"]): string {
  const { z, x, y } = tile?.tileID?.canonical ?? {};
  if (z === undefined || x === undefined || y === undefined) return "unknown";

  return `${z}/${x}/${y}`;
}
