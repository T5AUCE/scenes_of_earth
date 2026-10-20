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
  INTERVAL_CHAIN_M,
  type ContourLadder,
  type LadderTier,
} from "../contour-ladder";
import { makeHtmlElement } from "../html";
import { contourLegendText } from "../legend";
import { contourColor, DEFAULT_CONTOUR_COLOR } from "../render/palettes";
import type { LayerContext, Part, TerrainStats, TerrainTiles } from "../types";
import { backdropMaxZoom } from "./relief";

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
const DEM_CACHE_TILES = 50;
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
  demSources.set(key, source);
  return source;
}

/** Own stable, elevation-filtered contour tiers and labels for one scene. */
export class ContourOverlay {
  readonly legend = makeHtmlElement("div");
  readonly part: Part;
  private readonly map: MapLibreMap;
  private readonly sourceId: string;
  private readonly backdropId: string;
  private readonly bbox: LayerContext["layer"]["grid"]["bbox"];
  private backdropFade?: ExpressionSpecification;
  private readonly ladder: ContourLadder;
  private isOn = true;
  private color: string;
  private labelId?: string;

  constructor(
    context: LayerContext,
    dem: DemSource,
    tiles: TerrainTiles,
    stats: TerrainStats,
  ) {
    const { map, layer, beforeId, display } = context;
    this.map = map;
    this.color = contourColor(display?.palette ?? DEFAULT_CONTOUR_COLOR)!;
    this.sourceId = `${layer.id}-contours`;
    this.backdropId = `${this.sourceId}-backdrop`;
    this.bbox = layer.grid.bbox;
    const [, south, , north] = layer.grid.bbox;
    const maxzoom = Math.min(MAX_CONTOUR_ZOOM, tiles.maxzoom + CONTOUR_OVERZOOM);
    this.ladder = contourLadder(stats, (south + north) / 2, { maxZoom: maxzoom });
    this.part = {
      id: `${layer.id}.contours`,
      label: "Contours",
      layerIds: [],
      note: this.legend,
      onToggle: (visible) => {
        this.isOn = visible;
        this.updateLegend();
      },
    };

    map.addSource(this.sourceId, {
      type: "vector",
      tiles: [
        dem.contourProtocolUrl({
          thresholds: this.ladder.thresholds,
          overzoom: CONTOUR_OVERZOOM,
          buffer: CONTOUR_BUFFER_PX,
        }),
      ],
      maxzoom,
      ...terrainTileBounds(layer.grid.bbox),
    });
    for (const [index, tier] of this.ladder.tiers.entries()) {
      this.addLine(tier, this.ladder.tiers[index - 1], beforeId);
    }
    this.addBackdrop(dem, tiles, beforeId);
    this.addLabels(beforeId);
    map.on("zoomend", this.updateLegend);
    this.updateLegend();
  }

  private addLine(tier: LadderTier, coarser: LadderTier | undefined, beforeId?: string) {
    const id = `${this.sourceId}-${tier.interval}`;
    const filter: FilterSpecification = coarser
      ? ["all", multipleOf(tier.interval), ["!", multipleOf(coarser.interval)]]
      : multipleOf(tier.interval);
    this.map.addLayer(
      {
        id,
        type: "line",
        source: this.sourceId,
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

  /** Keep coarse bold lines available while main tiles load so zooming out is not blank. */
  private addBackdrop(dem: DemSource, tiles: TerrainTiles, beforeId?: string) {
    const bold = this.ladder.tiers.filter((tier) => tier.interval >= this.ladder.boldInterval);
    if (bold.length === 0) return;

    const [west, , east] = this.bbox;
    const maxzoom = backdropMaxZoom(
      east - west,
      this.map.getCanvas().clientWidth,
      tiles.tile_size,
      tiles.maxzoom,
    );
    this.map.addSource(this.backdropId, {
      type: "vector",
      tiles: [
        dem.contourProtocolUrl({
          thresholds: { 0: this.ladder.boldInterval },
          overzoom: CONTOUR_OVERZOOM,
          buffer: CONTOUR_BUFFER_PX,
        }),
      ],
      maxzoom,
      ...terrainTileBounds(this.bbox),
    });
    this.backdropFade = tierFades(bold, CONTOUR_OPACITY);
    this.map.addLayer(
      {
        id: this.backdropId,
        type: "line",
        source: this.backdropId,
        "source-layer": "contours",
        minzoom: bold[0].entryZoom,
        filter: multipleOf(this.ladder.boldInterval),
        paint: {
          "line-color": this.color,
          "line-width": BOLD_LINE_WIDTH_PX,
          "line-opacity": 0,
          "line-opacity-transition": { duration: 0 },
        },
      },
      beforeId,
    );
    this.part.layerIds.push(this.backdropId);
    this.map.on("sourcedata", this.updateBackdrop);
    this.map.on("dataloading", this.updateBackdrop);
    this.map.on("zoomstart", this.updateBackdrop);
    this.map.on("zoomend", this.updateBackdrop);
  }

  private readonly updateBackdrop = () => {
    if (!this.map.getLayer(this.backdropId)) return;

    const isMainReady = this.map.isSourceLoaded(this.sourceId);
    const opacity = isMainReady ? 0 : this.backdropFade!;
    this.map.setPaintProperty(this.backdropId, "line-opacity", opacity);
  };

  private addLabels(beforeId?: string) {
    const tiers = labelledTiers(this.ladder);
    if (tiers.length === 0) return;

    const id = `${this.sourceId}-labels`;
    this.labelId = id;
    const font = this.map.getStyle().layers.find(
      (layer): layer is SymbolLayerSpecification =>
        layer.type === "symbol" && layer.layout?.["text-font"] !== undefined,
    )?.layout?.["text-font"];
    const finest = tiers.at(-1)!;
    this.map.addLayer(
      {
        id,
        type: "symbol",
        source: this.sourceId,
        "source-layer": "contours",
        minzoom: tiers[0].entryZoom,
        filter: multipleOf(finest.interval),
        layout: {
          "symbol-placement": "line",
          "symbol-spacing": LABEL_SPACING_PX,
          "symbol-sort-key": labelPriority(),
          "text-size": LABEL_SIZE_PX,
          "text-max-angle": LABEL_MAX_ANGLE_DEG,
          "text-field": labelField(tiers),
          ...(font ? { "text-font": font } : {}),
        },
        paint: {
          "text-color": this.color,
          "text-halo-color": getComputedStyle(document.documentElement)
            .getPropertyValue(PAGE_BACKGROUND_PROPERTY).trim(),
          "text-halo-width": LABEL_HALO_WIDTH_PX,
          "text-opacity": tierFades(tiers, 1),
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
  }

  private readonly updateLegend = () => {
    const interval = finestIntervalAt(this.ladder, this.map.getZoom());
    this.legend.textContent = interval
      ? contourLegendText(interval, this.ladder.boldInterval)
      : "";
    this.legend.hidden = !this.isOn || !interval;
  };

  destroy() {
    this.map.off("zoomend", this.updateLegend);
    this.map.off("sourcedata", this.updateBackdrop);
    this.map.off("dataloading", this.updateBackdrop);
    this.map.off("zoomstart", this.updateBackdrop);
    this.map.off("zoomend", this.updateBackdrop);
    for (const id of this.part.layerIds) this.map.removeLayer(id);
    this.map.removeSource(this.sourceId);
    if (this.map.getSource(this.backdropId)) this.map.removeSource(this.backdropId);
  }
}

function labelledTiers(ladder: ContourLadder): ContourLadder["labelTiers"] {
  const bold = ladder.tiers.filter((tier) => tier.interval >= ladder.boldInterval);
  const sparse = ladder.labelTiers.filter((tier) => tier.interval < ladder.boldInterval);
  return [...bold, ...sparse];
}

function labelPriority(): ExpressionSpecification {
  const conditions = [...INTERVAL_CHAIN_M].reverse()
    .flatMap((interval) => [multipleOf(interval), -interval]);
  return ["case", ...conditions, 0] as ExpressionSpecification;
}

function labelField(tiers: ContourLadder["labelTiers"]): ExpressionSpecification {
  const field: ExpressionSpecification = ["step", ["zoom"], ""];
  const intervalsByZoom = new Map(tiers.map((tier) => [tier.entryZoom, tier.interval]));
  for (const [zoom, interval] of intervalsByZoom) {
    const label: ExpressionSpecification = ["concat", ["get", "ele"], " m"];
    field.push(zoom, ["case", multipleOf(interval), label, ""]);
  }
  return field;
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
