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
  type ContourLadder,
  type LadderTier,
} from "../contour-ladder";
import { setPrefetchDisabled } from "../dev-stats";
import {
  addressSearch,
  contourMaxZoomSetting,
  gestureFlags,
  isGestureActive,
  prefetchEnabled,
  subscribeGesture,
} from "../gesture-quality";
import { makeHtmlElement } from "../html";
import { contourLegendText } from "../legend";
import { labelFadeDurationMs } from "../reduced-motion";
import { contourColor, DEFAULT_CONTOUR_COLOR } from "../render/palettes";
import { BASEMAP_SOURCE_ID, basemapDescriptor } from "../render/tile-viewport";
import { convertValue, displayUnitFor, isUnitFor } from "../units";
import type { LayerContext, Part, TerrainStats, TerrainTiles } from "../types";
import {
  TilePrefetchScheduler,
  type DemFetcher,
  type HttpWarmer,
  type TilePrefetchMap,
  type TilePrefetchWiring,
} from "./tile-prefetch";

export { levelsForZoom } from "../contour-ladder";

const CONTOUR_OPACITY = 0.55;
const MINOR_LINE_WIDTH_PX = 0.5;
const BOLD_LINE_WIDTH_PX = 1.1;

const LABEL_SIZE_PX = 10;
const LABEL_SPACING_PX = 350;
const LABEL_HALO_WIDTH_PX = 1;
const LABEL_MAX_ANGLE_DEG = 120;
const PAGE_BACKGROUND_PROPERTY = "--page-background";

// Version 0.1.1 materializes only one pixel of padding before tracing contours.
const CONTOUR_BUFFER_PX = 1;
// Workers rebuild maplibre-contour errors from strings, so messages keep an "Error: " prefix.
const WORKER_ERROR_PREFIX = "Error: ";
// A zoom step keeps its neighbours cached so sweeping zooms stop evicting them.
const DEM_CACHE_TILES = 120;
// Ocean tiles stay missing, so the per-source memo caps how many 404 tiles it remembers.
export const MAX_MISSING_DEM_TILES = 2000;
const MAX_CONTOUR_ZOOM = 12;

type DemSource = InstanceType<typeof mlcontour.DemSource>;

// The plugin has no manager disposal API, so visits reuse page-lifetime workers and caches.
const demSources = new Map<string, DemSource>();

/** Reuse a DEM cache and its protocols for relief and contours across scene visits. */
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
 * Remember 404 DEM and contour tiles so coastal scenes stop re-requesting ocean tiles on
 * every zoom. The memo is per source and bounded, and its keys hold only tile coordinates
 * because a missing DEM stays missing for every contour threshold set. Only 404s are
 * memoized because they stay missing, while other failures keep retrying. Exported for tests.
 */
export function memoizeMissingDemTiles(dem: DemSource): void {
  const manager = (dem as unknown as { manager?: DemManager }).manager;
  if (!manager) return;
  const missingTiles = new Map<string, true>();
  if (typeof manager.fetchTile === "function") {
    const fetchTile = manager.fetchTile.bind(manager);
    manager.fetchTile = ((z: number, x: number, y: number, ...rest: unknown[]) => {
      const key = `dem:${z}/${x}/${y}`;
      if (missingTiles.has(key)) return Promise.reject(missingTileError(key));
      return (fetchTile(z, x, y, ...rest) as Promise<unknown>).catch((error: unknown) => {
        if (isDem404(error)) rememberMissingTile(missingTiles, key);
        throw error;
      });
    }) as DemManager["fetchTile"];
  }
  if (typeof manager.fetchContourTile === "function") {
    const fetchContourTile = manager.fetchContourTile.bind(manager);
    const fetchWithMemo = (
      z: number,
      x: number,
      y: number,
      options: unknown,
      ...rest: unknown[]
    ) => {
      const key = `contours:${z}/${x}/${y}`;
      if (missingTiles.has(key)) return Promise.reject(missingTileError(key));
      return (fetchContourTile(z, x, y, options, ...rest) as Promise<unknown>)
        .catch((error: unknown) => {
          if (isDem404(error)) rememberMissingTile(missingTiles, key);
          throw error;
        });
    };
    manager.fetchContourTile = fetchWithMemo as DemManager["fetchContourTile"];
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

function isDem404(error: unknown): boolean {
  const message = (error as Error)?.message ?? "";
  const withoutPrefix = message.startsWith(WORKER_ERROR_PREFIX)
    ? message.slice(WORKER_ERROR_PREFIX.length)
    : message;
  return withoutPrefix.startsWith("Bad response: 404");
}

function missingTileError(key: string): Error {
  return new Error(`Bad response: 404 for memoized tile ${key}`);
}

/**
 * Cap native tiling zooms at the crisp contour ceiling, with the measurement-only
 * contourMaxZoom flag lowering it further. Deeper zooms overzoom the last tiles instead
 * of re-tiling, so the lines stay identical while tile churn stops past the cap.
 */
export function cappedDemMaxZoom(nativeMaxzoom: number): number {
  const cap = contourMaxZoomSetting(addressSearch()) ?? MAX_CONTOUR_ZOOM;
  return Math.min(nativeMaxzoom, cap);
}

/** Own stable, elevation-filtered contour tiers and labels for one scene. */
export class ContourOverlay {
  readonly legend = makeHtmlElement("div");
  readonly part: Part;
  /** Both contour sources, so terrain watches line and label tiles for failures. */
  readonly contourSourceIds: readonly string[];
  private readonly map: MapLibreMap;
  private readonly lineSourceId: string;
  private readonly labelSourceId: string;
  private readonly dem: DemSource;
  private readonly stats: TerrainStats;
  private readonly bbox: LayerContext["layer"]["grid"]["bbox"];
  private readonly beforeId: string | undefined;
  private readonly maxzoom: number;
  private ladder!: ContourLadder;
  private elevationUnit: string;
  private isOn = true;
  private color: string;
  private halo = "";
  private labelId?: string;
  private labelsFrozen = false;
  private labelFadeZeroed = false;
  private readonly prefetch: TilePrefetchScheduler;
  // Captured here because scene entry replaces the address and drops trial flags.
  private readonly freezeAllowed = gestureFlags(addressSearch()).freezeLabels;
  private readonly prefetchAllowed = prefetchEnabled(addressSearch());
  private readonly stopGesture: () => void;

  constructor(
    context: LayerContext,
    dem: DemSource,
    tiles: TerrainTiles,
    stats: TerrainStats,
    clock: () => number = () => performance.now(),
    wiring?: TilePrefetchWiring,
    httpWarmer: HttpWarmer = warmHttp,
  ) {
    const { map, layer, beforeId, display } = context;
    // The interval note shares the isotherm note's style so both legend lines read alike.
    this.legend.className = "legend-contour";
    this.map = map;
    this.dem = dem;
    this.stats = stats;
    this.bbox = layer.grid.bbox;
    this.beforeId = beforeId;
    this.color = contourColor(display?.palette ?? DEFAULT_CONTOUR_COLOR)!;
    this.lineSourceId = `${layer.id}-contours`;
    // A separate label source keeps gesture invalidation off the cached line buckets.
    this.labelSourceId = `${layer.id}-labels-contours`;
    this.contourSourceIds = [this.lineSourceId, this.labelSourceId];
    this.elevationUnit = displayUnitFor(layer.units, display?.units);
    this.maxzoom = Math.min(MAX_CONTOUR_ZOOM, cappedDemMaxZoom(tiles.maxzoom + CONTOUR_OVERZOOM));
    this.part = {
      id: `${layer.id}.contours`,
      label: "Contours",
      layerIds: [],
      onToggle: (visible) => {
        this.isOn = visible;
        if (!visible) this.prefetch.cancelAll();
        // drawView shows every part layer first, so the freeze state decides the labels.
        if (this.freezeAllowed) this.updateLabelVisibility();
        this.updateLegend();
      },
    };
    const prefetchWiring = wiring ?? {
      reliefSourceId: `${layer.id}-relief`,
      basemapSourceId: BASEMAP_SOURCE_ID,
    };
    this.prefetch = new TilePrefetchScheduler(
      map as unknown as TilePrefetchMap,
      () => ({
        sourceId: this.lineSourceId,
        ladder: this.ladder,
        maxzoom: this.maxzoom,
        reliefMaxzoom: cappedDemMaxZoom(tiles.maxzoom),
        elevationUnit: this.elevationUnit,
        enabled: this.isOn && this.prefetchAllowed,
        bbox: this.bbox,
      }),
      { tileTemplate: tiles.url, fetcher: traceFetcherFor(dem) },
      prefetchWiring,
      () => basemapDescriptor(map),
      httpWarmer,
      clock,
    );

    this.build();
    map.on("zoomend", this.updateLegend);
    this.updateLegend();
    setPrefetchDisabled(!this.prefetchAllowed);
    // Hidden labels skip placement and collision, so a gesture freezes them until moveend.
    this.stopGesture = subscribeGesture(map, {
      onStart: () => {
        this.prefetch.reset();
        this.setLabelsFrozen(true);
      },
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
      thresholds: this.ladder.thresholds,
      overzoom: CONTOUR_OVERZOOM,
      buffer: CONTOUR_BUFFER_PX,
      ...elevationMultiplier(this.elevationUnit),
    };
    this.map.addSource(this.lineSourceId, {
      type: "vector",
      tiles: [this.dem.contourProtocolUrl({ ...protocolOptions })],
      // Vector tiles stay at the fixed 512 grid, matching the 512 DEM tiles they trace.
      maxzoom: this.maxzoom,
      ...terrainTileBounds(this.bbox),
    });
    this.map.addSource(this.labelSourceId, {
      type: "vector",
      tiles: [this.dem.contourProtocolUrl({ ...protocolOptions })],
      maxzoom: this.maxzoom,
      ...terrainTileBounds(this.bbox),
    });
    for (const [index, tier] of this.ladder.tiers.entries()) {
      this.addLine(tier, this.ladder.tiers[index - 1], this.beforeId);
    }
    this.addLabels(this.beforeId);
  }

  private rebuild() {
    for (const id of this.part.layerIds) this.map.removeLayer(id);
    this.map.removeSource(this.lineSourceId);
    this.map.removeSource(this.labelSourceId);
    this.part.layerIds.length = 0;
    this.labelId = undefined;
    this.prefetch.reset();
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

  private addLine(tier: LadderTier, coarser: LadderTier | undefined, beforeId?: string) {
    const id = `${this.lineSourceId}-${tier.interval}`;
    const filter: FilterSpecification = coarser
      ? ["all", multipleOf(tier.interval), ["!", multipleOf(coarser.interval)]]
      : multipleOf(tier.interval);
    this.map.addLayer(
      {
        id,
        type: "line",
        source: this.lineSourceId,
        "source-layer": "contours",
        minzoom: tier.entryZoom,
        filter,
        paint: {
          "line-color": this.color,
          "line-width": tier.interval >= this.ladder.boldInterval
            ? BOLD_LINE_WIDTH_PX
            : MINOR_LINE_WIDTH_PX,
          "line-opacity": tierFade(tier.entryZoom, CONTOUR_OPACITY),
        },
      },
      beforeId,
    );
    this.part.layerIds.push(id);
  }

  private addLabels(beforeId?: string) {
    const tiers = labelledTiers(this.ladder);
    if (tiers.length === 0) return;

    const id = `${this.lineSourceId}-labels`;
    this.labelId = id;
    this.halo = getComputedStyle(document.documentElement)
      .getPropertyValue(PAGE_BACKGROUND_PROPERTY).trim();
    const font = this.map.getStyle().layers.find(
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

  /** Recolour the lines and their labels. */
  setColor(color: string) {
    this.color = color;
    for (const id of this.part.layerIds) {
      const property = id === this.labelId ? "text-color" : "line-color";
      this.map.setPaintProperty(id, property, color);
    }
    if (this.labelId !== undefined) {
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
    this.prefetch.destroy();
    setPrefetchDisabled(false);
    this.map.off("zoomend", this.updateLegend);
    for (const id of this.part.layerIds) this.map.removeLayer(id);
    this.map.removeSource(this.lineSourceId);
    this.map.removeSource(this.labelSourceId);
  }
}

/** Read the DEM manager both warmers share with the visible sources. */
function traceFetcherFor(dem: { manager?: unknown }): DemFetcher | null {
  const manager = dem as { manager?: DemFetcher };
  if (!manager.manager) return null;
  if (typeof manager.manager.fetchContourTile !== "function") return null;
  return manager.manager;
}

/**
 * Warm one versioned basemap URL so later visible reads hit the HTTP cache. The resolved
 * body is measured against the speculative budget by the scheduler.
 */
function warmHttp(url: string, signal: AbortSignal): Promise<unknown> {
  return fetch(url, { signal }).then((response) => {
    if (!response.ok) throw new Error(`Bad response: ${response.status} for ${url}`);
    return response.arrayBuffer();
  });
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
  const expanded = digits.length === 3
    ? [...digits].map((digit) => digit + digit).join("")
    : digits;
  const red = parseInt(expanded.slice(0, 2), 16);
  const green = parseInt(expanded.slice(2, 4), 16);
  const blue = parseInt(expanded.slice(4, 6), 16);
  return `rgba(${red}, ${green}, ${blue}, 0)`;
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
  const conditions = [...chain].reverse()
    .flatMap((interval) => [multipleOf(interval), -interval]);
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

function multipleOf(interval: number): ExpressionSpecification {
  return ["==", ["%", ["get", "ele"], interval], 0];
}

function tierFade(entryZoom: number, opacity: number): ExpressionSpecification {
  return ["interpolate", ["linear"], ["zoom"], entryZoom, 0, entryZoom + FADE_SPAN_ZOOM, opacity];
}

function tierFades(
  tiers: ContourLadder["labelTiers"],
  maxOpacity: number,
): ExpressionSpecification {
  const opacity: ExpressionSpecification = ["interpolate", ["linear"], ["zoom"]];
  const fadeStops = tiers.flatMap((tier) => [
    tier.entryZoom,
    tier.entryZoom + FADE_SPAN_ZOOM,
  ]);
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

/** MapLibre source bounds cannot express an unwrapped antimeridian bbox. */
export function terrainTileBounds(bbox: LayerContext["layer"]["grid"]["bbox"]) {
  const [west, , east] = bbox;
  return west >= -180 && east <= 180 ? { bounds: bbox } : {};
}
