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
import { makeHtmlElement } from "../html";
import { contourLegendText } from "../legend";
import { contourColor, DEFAULT_CONTOUR_COLOR } from "../render/palettes";
import { convertValue, displayUnitFor, isUnitFor } from "../units";
import type { LayerContext, Part, TerrainStats, TerrainTiles } from "../types";

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
  private readonly dem: DemSource;
  private readonly stats: TerrainStats;
  private readonly bbox: LayerContext["layer"]["grid"]["bbox"];
  private readonly beforeId: string | undefined;
  private readonly maxzoom: number;
  private ladder!: ContourLadder;
  private elevationUnit: string;
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
    // The card would set the interval in card type, so it takes the legend caption style.
    this.legend.className = "legend-contour";
    this.map = map;
    this.dem = dem;
    this.stats = stats;
    this.bbox = layer.grid.bbox;
    this.beforeId = beforeId;
    this.color = contourColor(display?.palette ?? DEFAULT_CONTOUR_COLOR)!;
    this.sourceId = `${layer.id}-contours`;
    this.elevationUnit = displayUnitFor(layer.units, display?.units);
    this.maxzoom = Math.min(MAX_CONTOUR_ZOOM, tiles.maxzoom + CONTOUR_OVERZOOM);
    this.part = {
      id: `${layer.id}.contours`,
      label: "Contours",
      layerIds: [],
      onToggle: (visible) => {
        this.isOn = visible;
        this.updateLegend();
      },
    };

    this.build();
    map.on("zoomend", this.updateLegend);
    this.updateLegend();
  }

  /** Switch the tiers, labels and legend to metres or feet, keeping the map colours. */
  setUnits(unit: string) {
    if (!isUnitFor("m", unit) || unit === this.elevationUnit) return;

    this.elevationUnit = unit;
    this.rebuild();
  }

  private build() {
    this.ladder = contourLadder(this.stats, centreLatitude(this.bbox), {
      maxZoom: this.maxzoom,
      elevationUnit: this.elevationUnit,
    });
    this.map.addSource(this.sourceId, {
      type: "vector",
      tiles: [
        this.dem.contourProtocolUrl({
          thresholds: this.ladder.thresholds,
          overzoom: CONTOUR_OVERZOOM,
          buffer: CONTOUR_BUFFER_PX,
          ...elevationMultiplier(this.elevationUnit),
        }),
      ],
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
    this.map.removeSource(this.sourceId);
    this.part.layerIds.length = 0;
    this.labelId = undefined;
    this.build();
    if (!this.isOn) {
      for (const id of this.part.layerIds) {
        this.map.setLayoutProperty(id, "visibility", "none");
      }
    }
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
          "symbol-sort-key": labelPriority(this.elevationUnit),
          "text-size": LABEL_SIZE_PX,
          "text-max-angle": LABEL_MAX_ANGLE_DEG,
          "text-field": labelField(tiers, this.elevationUnit),
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
      ? contourLegendText(interval, this.ladder.boldInterval, this.elevationUnit)
      : "";
    this.legend.hidden = !this.isOn || !interval;
  };

  destroy() {
    this.map.off("zoomend", this.updateLegend);
    for (const id of this.part.layerIds) this.map.removeLayer(id);
    this.map.removeSource(this.sourceId);
  }
}

function labelledTiers(ladder: ContourLadder): ContourLadder["labelTiers"] {
  const bold = ladder.tiers.filter((tier) => tier.interval >= ladder.boldInterval);
  const sparse = ladder.labelTiers.filter((tier) => tier.interval < ladder.boldInterval);
  return [...bold, ...sparse];
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

function centreLatitude(bbox: LayerContext["layer"]["grid"]["bbox"]) {
  const [, south, , north] = bbox;
  return (south + north) / 2;
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
