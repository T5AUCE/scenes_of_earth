/** Place elevation labels using a shared DEM source while GPU layers draw the contour lines. */
import mlcontour from "maplibre-contour";
import * as maplibregl from "maplibre-gl";
import type {
  ExpressionSpecification,
  FilterSpecification,
  Map as MapLibreMap,
  SymbolLayerSpecification,
} from "maplibre-gl";

import {
  CONTOUR_OVERZOOM,
  contourLadder,
  FADE_SPAN_ZOOM,
  finestIntervalAt,
  INTERVAL_CHAIN_FT,
  INTERVAL_CHAIN_M,
  MAX_CONTOUR_ZOOM,
  type ContourLadder,
} from "../contour-ladder";
import {
  addressSearch,
  contourMaxZoomSetting,
  gestureFlags,
  isGestureActive,
  subscribeGesture,
} from "../gesture-quality";
import { makeHtmlElement } from "../html";
import { contourLegendText } from "../legend";
import { labelFadeDurationMs } from "../reduced-motion";
import { contourColor, DEFAULT_CONTOUR_COLOR } from "../render/palettes";
import type { LayerContext, Part, TerrainStats, TerrainTiles } from "../types";
import { convertValue, displayUnitFor, isUnitFor } from "../units";

const LABEL_SIZE_PX = 10;
const LABEL_SPACING_PX = 350;
const LABEL_HALO_WIDTH_PX = 1;
const LABEL_MAX_ANGLE_DEG = 45;
const PAGE_BACKGROUND_PROPERTY = "--page-background";

// Version 0.1.1 materialises only one pixel of padding before tracing contours.
const CONTOUR_BUFFER_PX = 1;
// Workers rebuild maplibre-contour errors from strings, so messages keep an "Error: " prefix.
const WORKER_ERROR_PREFIX = "Error: ";
// Labels trace fewer heights, so the shared DEM cache stays small.
const DEM_CACHE_TILES = 60;
// Ocean tiles stay missing, so the per-source memo caps how many 404 tiles it remembers.
export const MAX_MISSING_DEM_TILES = 2000;

type DemSource = InstanceType<typeof mlcontour.DemSource>;

// The plugin has no manager disposal API, so visits reuse page-lifetime workers and caches.
const demSources = new Map<string, DemSource>();

/**
 * Reuse the DEM cache and protocols for contour labels across scene visits.
 */
export function sharedDemSource(tiles: TerrainTiles): DemSource {
  const key = JSON.stringify([tiles.url, tiles.encoding, tiles.maxzoom]);
  const existing = demSources.get(key);
  if (existing) return existing;

  const source = new mlcontour.DemSource({
    url: tiles.url,
    encoding: tiles.encoding,
    maxzoom: tiles.maxzoom,
    worker: true,
    cacheSize: DEM_CACHE_TILES,
  });
  source.setupMaplibre(maplibregl);
  memoizeMissingDemTiles(source);
  demSources.set(key, source);

  return source;
}

/**
 * Remember missing DEM and contour tiles so coastal scenes stop requesting ocean tiles on
 * every zoom. The bounded memo uses tile coordinates because a missing DEM stays missing
 * for every contour threshold set. Other failures keep retrying.
 */
export function memoizeMissingDemTiles(dem: DemSource): void {
  const manager = (dem as unknown as { manager?: DemManager }).manager;
  if (!manager) return;

  const missingTiles = new Map<string, true>();

  if (typeof manager.fetchTile === "function") {
    manager.fetchTile = withMissingMemo("dem", manager.fetchTile.bind(manager));
  }

  if (typeof manager.fetchContourTile === "function") {
    manager.fetchContourTile = withMissingMemo("contours", manager.fetchContourTile.bind(manager));
  }

  function withMissingMemo<Rest extends unknown[]>(
    prefix: string,
    fetch: (z: number, x: number, y: number, ...rest: Rest) => Promise<unknown>,
  ) {
    return (z: number, x: number, y: number, ...rest: Rest) => {
      const key = `${prefix}:${z}/${x}/${y}`;
      if (missingTiles.has(key)) return Promise.reject(missingTileError(key));

      return fetch(z, x, y, ...rest).catch((error: unknown) => {
        if (isDem404(error)) rememberMissingTile(missingTiles, key);
        throw error;
      });
    };
  }
}

/** Remember a missing tile, dropping the oldest entry once the memo is full. */
function rememberMissingTile(missingTiles: Map<string, true>, key: string) {
  if (missingTiles.has(key)) return;

  if (missingTiles.size >= MAX_MISSING_DEM_TILES) {
    const oldest = missingTiles.keys().next().value;
    if (oldest !== undefined) missingTiles.delete(oldest);
  }

  missingTiles.set(key, true);
}

interface DemManager {
  fetchTile(z: number, x: number, y: number, ...rest: unknown[]): Promise<unknown>;
  fetchContourTile(
    z: number,
    x: number,
    y: number,
    options: unknown,
    ...rest: unknown[]
  ): Promise<unknown>;
}

/** Recognise missing DEM tiles from either direct or worker-rebuilt error messages. */
export function isDem404(error: unknown): boolean {
  return (
    stripWorkerErrorPrefix((error as Error)?.message)?.startsWith("Bad response: 404") === true
  );
}

/** Remove the prefix added when the contour worker rebuilds an error from its string. */
export function stripWorkerErrorPrefix(message: string | undefined): string | undefined {
  if (!message?.startsWith(WORKER_ERROR_PREFIX)) return message;
  return message.slice(WORKER_ERROR_PREFIX.length);
}

function missingTileError(key: string): Error {
  return new Error(`Bad response: 404 for memoized tile ${key}`);
}

/**
 * Cap native tiling zooms at the contour ceiling, with the measurement-only contourMaxZoom
 * flag lowering it further. Deeper zooms reuse the last tiles to avoid new requests.
 */
export function cappedDemMaxZoom(nativeMaxzoom: number): number {
  const cap = contourMaxZoomSetting(addressSearch()) ?? MAX_CONTOUR_ZOOM;
  return Math.min(nativeMaxzoom, cap);
}

/**
 * Own stable, elevation-filtered contour labels for one scene. The GPU contour layer draws
 * the lines, so this class traces only the heights that carry labels.
 */
export class ContourLabels {
  readonly legend = makeHtmlElement("div");
  readonly part: Part;
  /** The contour source, so terrain watches label tiles for failures. */
  readonly labelSourceId: string;
  /** The contour plan, replaced when the unit changes. */
  ladder!: ContourLadder;
  private readonly map: MapLibreMap;
  private readonly labelBaseId: string;
  private readonly dem: DemSource;
  private readonly stats: TerrainStats;
  private readonly bbox: LayerContext["layer"]["grid"]["bbox"];
  private readonly beforeId: string | undefined;
  private readonly maxzoom: number;
  private elevationUnit: string;
  private isOn = true;
  private color: string;
  private halo = "";
  private labelId?: string;
  private labelsFrozen = false;
  private labelFadeZeroed = false;
  // Captured here because scene entry replaces the address and drops trial flags.
  private readonly freezeAllowed = gestureFlags(addressSearch()).freezeLabels;
  private readonly stopGesture: () => void;

  constructor(context: LayerContext, dem: DemSource, tiles: TerrainTiles, stats: TerrainStats) {
    const { map, layer, beforeId, display } = context;

    // The interval note shares the isotherm note's style so both legend lines read alike.
    this.legend.className = "legend-contour";
    this.map = map;
    this.dem = dem;
    this.stats = stats;
    this.bbox = layer.grid.bbox;
    this.beforeId = beforeId;
    this.color = contourColor(display?.palette ?? DEFAULT_CONTOUR_COLOR)!;

    this.labelSourceId = `${layer.id}-labels-contours`;
    this.labelBaseId = `${layer.id}-contours`;
    this.elevationUnit = displayUnitFor(layer.units, display?.units);
    this.maxzoom = Math.min(MAX_CONTOUR_ZOOM, cappedDemMaxZoom(tiles.maxzoom + CONTOUR_OVERZOOM));

    this.part = {
      id: `${layer.id}.contours`,
      label: "Contours",
      layerIds: [],
      onToggle: (visible) => {
        this.isOn = visible;
        // drawView shows every part layer first, so the freeze state decides the labels.
        if (this.freezeAllowed) this.updateLabelVisibility();
        this.updateLegend();
      },
    };

    this.build();
    map.on("zoomend", this.updateLegend);
    this.updateLegend();
    // Hidden labels skip placement and collision, so a gesture freezes them until moveend.
    this.stopGesture = subscribeGesture(map, {
      onStart: () => this.setLabelsFrozen(true),
      onEnd: () => this.setLabelsFrozen(false),
    });

    if (isGestureActive(map)) this.setLabelsFrozen(true);
  }

  /** Switch the tiers, labels and legend to metres or feet, keeping the map colours. */
  setUnits(unit: string) {
    if (!isUnitFor("m", unit) || unit === this.elevationUnit) return;

    this.elevationUnit = unit;
    this.rebuild();
  }

  private build() {
    this.ladder = contourLadder(this.stats, {
      maxZoom: this.maxzoom,
      elevationUnit: this.elevationUnit,
    });
    this.labelFadeZeroed = false;

    const protocolOptions = {
      thresholds: labelThresholds(this.ladder),
      overzoom: CONTOUR_OVERZOOM,
      buffer: CONTOUR_BUFFER_PX,
      ...elevationMultiplier(this.elevationUnit),
    };
    this.map.addSource(this.labelSourceId, {
      type: "vector",
      tiles: [this.dem.contourProtocolUrl({ ...protocolOptions })],
      maxzoom: this.maxzoom,
      ...terrainTileBounds(this.bbox),
    });
    this.addLabels(this.beforeId);
  }

  private rebuild() {
    for (const id of this.part.layerIds) this.map.removeLayer(id);

    this.map.removeSource(this.labelSourceId);
    this.part.layerIds.length = 0;
    this.labelId = undefined;
    this.build();

    if (!this.isOn) {
      for (const id of this.part.layerIds) {
        this.map.setLayoutProperty(id, "visibility", "none");
      }
    }

    if (isGestureActive(this.map)) this.setLabelsFrozen(true);
    else if (this.freezeAllowed) this.updateLabelVisibility();

    this.updateLegend();
  }

  private addLabels(beforeId?: string) {
    const tiers = labelledTiers(this.ladder);
    if (tiers.length === 0) return;

    const id = `${this.labelBaseId}-labels`;
    this.labelId = id;
    this.halo = getComputedStyle(document.documentElement)
      .getPropertyValue(PAGE_BACKGROUND_PROPERTY)
      .trim();

    const font = this.map
      .getStyle()
      .layers.find(
        (layer): layer is SymbolLayerSpecification =>
          layer.type === "symbol" && layer.layout?.["text-font"] !== undefined,
      )?.layout?.["text-font"];
    this.map.addLayer(
      {
        id,
        type: "symbol",
        source: this.labelSourceId,
        "source-layer": "contours",
        minzoom: tiers[0].entryZoom,
        filter: labelFilter(tiers, this.ladder.boldInterval),
        layout: {
          "symbol-placement": "line",
          "symbol-spacing": LABEL_SPACING_PX,
          "symbol-sort-key": labelPriority(this.elevationUnit),
          "text-size": LABEL_SIZE_PX,
          "text-max-angle": LABEL_MAX_ANGLE_DEG,
          "text-field": labelField(tiers, this.elevationUnit),
          ...(font ? { "text-font": font } : {}),
        },
        paint: {
          "text-color": this.color,
          "text-halo-color": this.halo,
          "text-color-transition": { duration: 0 },
          "text-halo-color-transition": { duration: 0 },
          "text-halo-width": LABEL_HALO_WIDTH_PX,
          "text-opacity": tierFades(tiers, 1),
          // Data-driven values snap instead of transitioning, so the fade runs on the colours.
          "text-opacity-transition": { duration: 0 },
        },
      },
      beforeId,
    );
    this.part.layerIds.push(id);
  }

  /** Recolour the contour labels. */
  setColor(color: string) {
    this.color = color;

    if (this.labelId !== undefined) {
      this.map.setPaintProperty(this.labelId, "text-color", color);
      // A recolour during the restore would otherwise inherit its remaining fade duration.
      const instant = { duration: 0 };
      this.map.setPaintProperty(this.labelId, "text-color-transition", instant);
      this.map.setPaintProperty(this.labelId, "text-halo-color-transition", instant);
    }
  }

  // Placement runs once per gesture instead of every zoom frame while frozen.
  private setLabelsFrozen(frozen: boolean) {
    if (!this.freezeAllowed) return;

    this.labelsFrozen = frozen;
    this.updateLabelVisibility();
  }

  /** Hide the labels while frozen and fade them back through their colours. */
  private updateLabelVisibility() {
    if (this.labelId === undefined || !this.map.getLayer(this.labelId)) return;
    if (typeof this.map.setLayoutProperty !== "function") return;

    const id = this.labelId;
    // The user toggle wins over the gesture, so off stays off through moveend.
    const show = this.isOn && !this.labelsFrozen;
    this.map.setLayoutProperty(id, "visibility", show ? "visible" : "none");

    if (show && this.labelFadeZeroed) {
      this.labelFadeZeroed = false;
      // Restart from transparent so a recolour or a half-run fade cannot skip the start.
      this.snapLabelFadeStart(id);

      const fade = { duration: labelFadeDurationMs() };
      this.map.setPaintProperty(id, "text-color-transition", fade);
      this.map.setPaintProperty(id, "text-halo-color-transition", fade);
      this.map.setPaintProperty(id, "text-color", this.color);
      this.map.setPaintProperty(id, "text-halo-color", this.halo);
    } else if (!show && !this.labelFadeZeroed) {
      this.labelFadeZeroed = true;
      this.snapLabelFadeStart(id);
    }
  }

  // Transparent colours hide the labels while visibility stays off, ready for the fade.
  private snapLabelFadeStart(id: string) {
    const instant = { duration: 0 };
    this.map.setPaintProperty(id, "text-color-transition", instant);
    this.map.setPaintProperty(id, "text-halo-color-transition", instant);
    this.map.setPaintProperty(id, "text-color", transparentColor(this.color));
    this.map.setPaintProperty(id, "text-halo-color", transparentColor(this.halo));
  }

  private readonly updateLegend = () => {
    const interval = finestIntervalAt(this.ladder, this.map.getZoom());
    this.legend.textContent = interval
      ? contourLegendText(interval, this.ladder.boldInterval, this.elevationUnit)
      : "";
    this.legend.hidden = !this.isOn || !interval;
  };

  destroy() {
    this.stopGesture();
    this.map.off("zoomend", this.updateLegend);

    for (const id of this.part.layerIds) this.map.removeLayer(id);

    this.map.removeSource(this.labelSourceId);
  }
}

function transparentColor(color: string): string {
  const trimmed = color.trim();
  const hex = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(trimmed);
  if (hex) return transparentHex(hex[1]);

  const rgb = /^rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/.exec(trimmed);
  if (rgb) return `rgba(${rgb[1]}, ${rgb[2]}, ${rgb[3]}, 0)`;

  // An unknown format still fades from transparent black instead of popping in.
  return "rgba(0, 0, 0, 0)";
}

function transparentHex(digits: string): string {
  const expanded =
    digits.length === 3
      ? digits
          .split("")
          .map((digit) => digit + digit)
          .join("")
      : digits;
  const red = parseInt(expanded.slice(0, 2), 16);
  const green = parseInt(expanded.slice(2, 4), 16);
  const blue = parseInt(expanded.slice(4, 6), 16);

  return `rgba(${red}, ${green}, ${blue}, 0)`;
}

/**
 * Trace each label height from the tile zoom where its labels start to fade in, because the
 * finer heights are the expensive traces and the labels hide them until then.
 */
function labelThresholds(ladder: ContourLadder): Record<number, number> {
  return Object.fromEntries(labelledTiers(ladder).map((tier) => [tier.entryZoom, tier.interval]));
}

function labelledTiers(ladder: ContourLadder): ContourLadder["labelTiers"] {
  const bold = ladder.tiers.filter((tier) => tier.interval >= ladder.boldInterval);
  const sparse = ladder.labelTiers.filter((tier) => tier.interval < ladder.boldInterval);

  return [...bold, ...sparse];
}

/**
 * Keep only bold lines in placement until the finer tier shows, so low zooms skip anchors
 * the text field would hide anyway while the visible labels stay identical.
 */
function labelFilter(
  tiers: ContourLadder["labelTiers"],
  boldInterval: number,
): FilterSpecification {
  const finest = tiers.at(-1)!;
  if (tiers.length < 2 || finest.interval === boldInterval) return multipleOf(boldInterval);

  return [
    "any",
    multipleOf(boldInterval),
    ["all", [">=", ["zoom"], finest.entryZoom], multipleOf(finest.interval)],
  ] as FilterSpecification;
}

function labelPriority(elevationUnit: string): ExpressionSpecification {
  const chain = elevationUnit === "ft" ? INTERVAL_CHAIN_FT : INTERVAL_CHAIN_M;
  const conditions = [...chain].reverse().flatMap((interval) => [multipleOf(interval), -interval]);

  return ["case", ...conditions, 0] as ExpressionSpecification;
}

function labelField(
  tiers: ContourLadder["labelTiers"],
  elevationUnit: string,
): ExpressionSpecification {
  const field: ExpressionSpecification = ["step", ["zoom"], ""];
  const intervalsByZoom = new Map(tiers.map((tier) => [tier.entryZoom, tier.interval]));

  for (const [zoom, interval] of intervalsByZoom) {
    const label: ExpressionSpecification = ["concat", ["get", "ele"], ` ${elevationUnit}`];
    field.push(zoom, ["case", multipleOf(interval), label, ""]);
  }

  return field;
}

function elevationMultiplier(elevationUnit: string) {
  if (elevationUnit !== "ft") return {};

  // The DEM holds metres, so feet contours scale elevations before tracing them.
  return { multiplier: convertValue(1, "m", "ft") };
}

function tierFades(
  tiers: ContourLadder["labelTiers"],
  maxOpacity: number,
): ExpressionSpecification {
  const opacity: ExpressionSpecification = ["interpolate", ["linear"], ["zoom"]];
  const fadeStops = tiers.flatMap((tier) => [tier.entryZoom, tier.entryZoom + FADE_SPAN_ZOOM]);
  const stops = [...new Set(fadeStops)].sort((first, second) => first - second);

  for (const zoom of stops) {
    const conditions = tiers.flatMap((tier) => {
      const alpha = Math.max(0, Math.min(1, (zoom - tier.entryZoom) / FADE_SPAN_ZOOM));
      return [multipleOf(tier.interval), alpha * maxOpacity];
    });
    const value = ["case", ...conditions, 0] as ExpressionSpecification;
    opacity.push(zoom, value);
  }

  return opacity;
}

function multipleOf(interval: number): ExpressionSpecification {
  return ["==", ["%", ["get", "ele"], interval], 0];
}

/** MapLibre source bounds cannot express an unwrapped antimeridian bbox. */
export function terrainTileBounds(bbox: LayerContext["layer"]["grid"]["bbox"]) {
  const [west, , east] = bbox;
  return west >= -180 && east <= 180 ? { bounds: bbox } : {};
}
