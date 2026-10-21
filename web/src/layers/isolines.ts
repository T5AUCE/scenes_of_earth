/** Cache traced isotherms and display their dashed lines with temperature labels. */
import type {
  ExpressionSpecification,
  GeoJSONSource,
  Map as MapLibreMap,
  SymbolLayerSpecification,
} from "maplibre-gl";

import { evenStops } from "../render/colormap";
import {
  BOLD_ISOTHERM_MULTIPLE,
  type Isoline,
  ISOTHERM_COLOR,
  isolineInterval,
  isolineLevels,
  toLngLat,
  traceIsolines,
} from "../render/isolines";
import type { GridDoc, LayerContext } from "../types";

const CACHED_STEPS = 24;
const MINOR_LINE_WIDTH_PX = 0.9;
const BOLD_LINE_WIDTH_PX = 1.5;
const LINE_OPACITY = 0.85;
const DASH_PATTERN = [3, 2];

const LABEL_SIZE_PX = 10;
const LABEL_SPACING_PX = 300;
const LABEL_MAX_ANGLE_DEG = 120;
const LABEL_HALO_WIDTH_PX = 1;
const LABEL_DIGITS = 6;
const BOLD_TOLERANCE = 1e-6;
const PAGE_BACKGROUND_PROPERTY = "--page-background";

type GeoJsonData = Parameters<GeoJSONSource["setData"]>[0];

const EMPTY_LINES: GeoJsonData = { type: "FeatureCollection", features: [] };

/** The dashed isotherm lines and labels drawn as a temperature layer's fallback. */
export interface IsolineOverlay {
  readonly layerIds: readonly string[];
  /** The spacing of the lines in degrees, which follows the display range. */
  readonly interval: number;
  setValues(values: ArrayLike<number>, step: number): void;
  setRange(range: [number, number] | null): void;
  setVisible(visible: boolean): void;
  destroy(): void;
}

/** Add an empty isotherm source for a layer; values arrive one time step at a time. */
export function createIsolineOverlay(
  { map, layer, shift, beforeId, display }: LayerContext,
): IsolineOverlay {
  const stops = layer.style.stops;
  if (!stops) throw new Error(`Layer "${layer.id}" needs stops for isotherms`);

  let { interval, levels } = isothermScale(stops, display?.range);
  const sourceId = `${layer.id}-isotherms`;
  const lineId = `${sourceId}-lines`;
  const labelId = `${sourceId}-labels`;
  const tracedSteps = new Map<number, Isoline[]>();

  map.addSource(sourceId, { type: "geojson", data: EMPTY_LINES });
  addIsothermLayers(map, sourceId, lineId, labelId, beforeId);

  return {
    layerIds: [lineId, labelId],

    get interval() {
      return interval;
    },

    setValues(values, step) {
      const traced = cachedTrace(
        tracedSteps,
        step,
        () => traceIsolines(values, layer.grid.nx, layer.grid.ny, levels),
      );
      const features = traced.map((line) => lineFeature(line, interval, layer.grid, shift));
      (map.getSource(sourceId) as GeoJSONSource).setData({
        type: "FeatureCollection",
        features,
      });
    },

    setRange(range) {
      const next = isothermScale(stops, range ?? undefined);
      interval = next.interval;
      if (sameLevels(next.levels, levels)) return;
      levels = next.levels;
      tracedSteps.clear();
    },

    setVisible(visible) {
      const visibility = visible ? "visible" : "none";
      for (const id of [lineId, labelId]) {
        map.setLayoutProperty(id, "visibility", visibility);
      }
    },

    destroy() {
      for (const id of [lineId, labelId]) {
        if (map.getLayer(id)) map.removeLayer(id);
      }
      if (map.getSource(sourceId)) map.removeSource(sourceId);
    },
  };
}

function addIsothermLayers(
  map: MapLibreMap,
  sourceId: string,
  lineId: string,
  labelId: string,
  beforeId: string | undefined,
) {
  const width: ExpressionSpecification = [
    "case",
    ["get", "bold"],
    BOLD_LINE_WIDTH_PX,
    MINOR_LINE_WIDTH_PX,
  ];
  map.addLayer(
    {
      id: lineId,
      type: "line",
      source: sourceId,
      layout: { "line-cap": "butt", "line-join": "round" },
      paint: {
        "line-color": ISOTHERM_COLOR,
        "line-dasharray": DASH_PATTERN,
        "line-opacity": LINE_OPACITY,
        "line-width": width,
      },
    },
    beforeId,
  );

  const font = textFont(map);
  const haloColor = getComputedStyle(document.documentElement)
    .getPropertyValue(PAGE_BACKGROUND_PROPERTY)
    .trim();
  map.addLayer(
    {
      id: labelId,
      type: "symbol",
      source: sourceId,
      layout: {
        "symbol-placement": "line",
        "symbol-spacing": LABEL_SPACING_PX,
        "text-field": ["get", "label"] as ExpressionSpecification,
        "text-max-angle": LABEL_MAX_ANGLE_DEG,
        "text-size": LABEL_SIZE_PX,
        ...(font ? { "text-font": font } : {}),
      },
      paint: {
        "text-color": ISOTHERM_COLOR,
        "text-halo-color": haloColor,
        "text-halo-width": LABEL_HALO_WIDTH_PX,
      },
    },
    beforeId,
  );
}

function textFont(map: MapLibreMap) {
  return map.getStyle().layers.find(
    (layer): layer is SymbolLayerSpecification =>
      layer.type === "symbol" && layer.layout?.["text-font"] !== undefined,
  )?.layout?.["text-font"];
}

function isothermScale(
  stops: readonly number[],
  range: [number, number] | undefined,
): { interval: number; levels: number[] } {
  const effectiveStops = range ? evenStops(...range, stops.length) : stops;
  const interval = isolineInterval(effectiveStops);
  const levels = isolineLevels(
    effectiveStops[0],
    effectiveStops[effectiveStops.length - 1],
    interval,
  );

  return { interval, levels };
}

function sameLevels(left: readonly number[], right: readonly number[]) {
  return left.length === right.length
    && left.every((level, index) => level === right[index]);
}

function cachedTrace(
  cache: Map<number, Isoline[]>,
  step: number,
  trace: () => Isoline[],
): Isoline[] {
  const traced = cache.get(step);
  if (traced) {
    cache.delete(step);
    cache.set(step, traced);
    return traced;
  }

  const next = trace();
  cache.set(step, next);
  if (cache.size > CACHED_STEPS) cache.delete(cache.keys().next().value!);
  return next;
}

function lineFeature(line: Isoline, interval: number, grid: GridDoc, shift: number) {
  return {
    type: "Feature" as const,
    properties: {
      bold: isBoldLevel(line.value, interval),
      label: `${formatLevel(line.value)}°`,
    },
    geometry: {
      type: "LineString" as const,
      coordinates: toLngLat(line.coordinates, grid, shift),
    },
  };
}

function isBoldLevel(value: number, interval: number) {
  const multiple = value / (interval * BOLD_ISOTHERM_MULTIPLE);
  return Math.abs(multiple - Math.round(multiple)) < BOLD_TOLERANCE;
}

function formatLevel(value: number) {
  return String(Number(value.toPrecision(LABEL_DIGITS)));
}
