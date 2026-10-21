/** Combine terrain shading with contours and adapt relief strength to colour fills. */
import type { Map as MapLibreMap } from "maplibre-gl";

import { removeLayerAndSource } from "../map";
import { CONTOUR_COLORS, contourColor, DEFAULT_CONTOUR_COLOR } from "../render/palettes";
import type {
  LayerContext,
  LayerControl,
  LayerMenu,
  LayerView,
  TerrainStats,
} from "../types";
import { ContourOverlay, sharedDemSource, terrainTileBounds } from "./contour-overlay";
import { RELIEF_STRENGTH, reliefPaint } from "./relief";

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

/** Terrain shading from Mapterhorn tiles and contour lines for one terrain layer. */
export function createTerrainView(context: LayerContext): LayerView {
  const { map, layer, slots, report } = context;
  const { tiles, stats } = layer;
  if (!tiles || !stats) throw new Error("Terrain needs tile metadata and summary statistics");

  const dem = sharedDemSource(tiles);
  const id = `${layer.id}-relief`;
  // Separate translucent hillshades would darken loaded areas while other tiles are pending.
  map.addSource(id, {
    type: "raster-dem",
    tiles: [dem.sharedDemProtocolUrl],
    encoding: tiles.encoding,
    tileSize: tiles.tile_size,
    maxzoom: tiles.maxzoom,
    attribution: tiles.source.attribution,
    ...terrainTileBounds(layer.grid.bbox),
  });
  map.addLayer(
    { id, type: "hillshade", source: id, paint: reliefPaint(RELIEF_STRENGTH.initial) },
    slots.shade,
  );

  let strengthValue = RELIEF_STRENGTH.initial;
  let isUnderColour = false;
  const applyStrength = () => {
    const effective = strengthValue * (isUnderColour ? COLOUR_UNDER_FACTOR : 1);
    const exaggeration = reliefPaint(effective)["hillshade-exaggeration"];
    map.setPaintProperty(id, "hillshade-exaggeration", exaggeration);
  };

  const strength: LayerControl = {
    label: "Relief strength",
    hint: "Change intensity using slider",
    min: RELIEF_STRENGTH.min,
    max: RELIEF_STRENGTH.max,
    step: RELIEF_STRENGTH.step,
    value: RELIEF_STRENGTH.initial,
    set: (value) => {
      strengthValue = value;
      applyStrength();
    },
  };

  const contourOverlay = new ContourOverlay(context, dem, tiles, stats as TerrainStats);
  const stopWatchingTiles = watchTerrainTiles(
    map,
    [id, `${layer.id}-contours`],
    report,
  );

  let palette = context.display?.palette ?? DEFAULT_CONTOUR_COLOR;
  const menu: LayerMenu = {
    title: layer.title,
    heading: "Contour colour",
    blocks: true,
    palettes: CONTOUR_COLORS.map(({ name, label, color }) => ({ name, label, colors: [color] })),
    defaultPalette: DEFAULT_CONTOUR_COLOR,
    custom: false,
    get palette() {
      return palette;
    },
    setPalette(name) {
      palette = name;
      contourOverlay.setColor(contourColor(name)!);
    },
  };

  return {
    parts: [
      { id: layer.id, label: "Relief", layerIds: [id], controls: [strength] },
      contourOverlay.part,
    ],
    options: [],
    menu,
    time: null,
    setTime: () => {},
    setColourUnder: (isUnder) => {
      isUnderColour = isUnder;
      applyStrength();
    },
    legend: () => null,
    destroy: () => {
      stopWatchingTiles();
      contourOverlay.destroy();
      removeLayerAndSource(map, id);
    },
  };
}

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

    console.warn("Terrain tile failed", {
      source: sourceId,
      tile: tileLabel(tile),
      message: error.message,
    });
    if (isBenignTileError(error)) return;

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
