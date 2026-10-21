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
  ISOTHERM_CASING_RATIO,
  ISOTHERM_DASH_PATTERN,
  type Isoline,
  isolineInterval,
  isolineLevels,
  toLngLat,
  traceIsolines,
} from "../render/isolines";
import { type InkPaint, rgbCss } from "../render/palettes";
import type { GridDoc, LayerContext } from "../types";

const CACHED_STEPS = 24;
const LINE_WIDTH_STOPS_PX: readonly (readonly [number, number, number])[] = [
  [0, 1.5, 0.9], // zoom, bold width, regular width
  [8, 1.8, 1.1],
  [14, 2.6, 1.8],
  [22, 3.8, 2.8],
];
const LINE_OPACITY_STOPS: readonly (readonly [number, number])[] = [
  [0, 0.85],
  [16, 1],
];
const CASING_DASH_PATTERN = ISOTHERM_DASH_PATTERN.map(
  (length) => length / ISOTHERM_CASING_RATIO,
);
const CASING_OPACITY = 0.55;

const LABEL_SIZE_PX = 10;
const LABEL_SPACING_PX = 300;
const LABEL_MAX_ANGLE_DEG = 120;
const LABEL_HALO_WIDTH_PX = 1;
const LABEL_DIGITS = 6;
const BOLD_TOLERANCE = 1e-6;

type GeoJsonData = Parameters<GeoJSONSource["setData"]>[0];

const EMPTY_LINES: GeoJsonData = { type: "FeatureCollection", features: [] };

/** The dashed isotherm lines and labels drawn as a temperature layer's fallback. */
export interface IsolineOverlay {
  readonly layerIds: readonly string[];
  /** The spacing of the lines in degrees, which follows the display range. */
  readonly interval: number;
  setValues(values: ArrayLike<number>, step: number): void;
  setSmooth(smooth: boolean): void;
  setRange(range: [number, number] | null): void;
  setInk(ink: InkPaint): void;
  setVisible(visible: boolean): void;
  destroy(): void;
}

/** Add an empty isotherm source for a layer; values arrive one time step at a time. */
export function createIsolineOverlay(
  { map, layer, shift, beforeId, display }: LayerContext,
  ink: InkPaint,
): IsolineOverlay {
  const stops = layer.style.stops;
  if (!stops) throw new Error(`Layer "${layer.id}" needs stops for isotherms`);

  let { interval, levels } = isothermScale(stops, display?.range);
  const sourceId = `${layer.id}-isotherms`;
  const ids = {
    casingId: `${sourceId}-casing`,
    lineId: `${sourceId}-lines`,
    labelId: `${sourceId}-labels`,
  };
  const tracedSteps = new Map<string, Isoline[]>();
  let smooth = true;

  map.addSource(sourceId, { type: "geojson", data: EMPTY_LINES });
  addIsothermLayers(map, sourceId, ids, beforeId);
  paintInk(map, ids, ink);
  const layerIds = Object.values(ids);

  return {
    layerIds,

    get interval() {
      return interval;
    },

    setValues(values, step) {
      const traced = cachedTrace(
        tracedSteps,
        traceKey(step, smooth),
        () => traceIsolines(values, layer.grid.nx, layer.grid.ny, levels, smooth),
      );
      const features = traced.map((line) => lineFeature(line, interval, layer.grid, shift));
      (map.getSource(sourceId) as GeoJSONSource).setData({
        type: "FeatureCollection",
        features,
      });
    },

    setSmooth(next) {
      smooth = next;
    },

    setRange(range) {
      const next = isothermScale(stops, range ?? undefined);
      interval = next.interval;
      if (sameLevels(next.levels, levels)) return;
      levels = next.levels;
      tracedSteps.clear();
    },

    setInk(next) {
      paintInk(map, ids, next);
    },

    setVisible(visible) {
      const visibility = visible ? "visible" : "none";
      for (const id of layerIds) {
        map.setLayoutProperty(id, "visibility", visibility);
      }
    },

    destroy() {
      for (const id of layerIds) {
        if (map.getLayer(id)) map.removeLayer(id);
      }
      if (map.getSource(sourceId)) map.removeSource(sourceId);
    },
  };
}

interface IsothermLayerIds {
  casingId: string;
  lineId: string;
  labelId: string;
}

function addIsothermLayers(
  map: MapLibreMap,
  sourceId: string,
  { casingId, lineId, labelId }: IsothermLayerIds,
  beforeId: string | undefined,
) {
  // The casing repeats the line's dashes scaled to its width, so both line up in screen pixels.
  map.addLayer(
    {
      id: casingId,
      type: "line",
      source: sourceId,
      layout: { "line-cap": "butt", "line-join": "round" },
      paint: {
        "line-dasharray": CASING_DASH_PATTERN,
        "line-opacity": CASING_OPACITY,
        "line-width": isothermWidth(ISOTHERM_CASING_RATIO),
      },
    },
    beforeId,
  );
  map.addLayer(
    {
      id: lineId,
      type: "line",
      source: sourceId,
      layout: { "line-cap": "butt", "line-join": "round" },
      paint: {
        "line-dasharray": ISOTHERM_DASH_PATTERN,
        "line-opacity": zoomStops(LINE_OPACITY_STOPS),
        "line-width": isothermWidth(1),
      },
    },
    beforeId,
  );

  const font = textFont(map);
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
      paint: { "text-halo-width": LABEL_HALO_WIDTH_PX },
    },
    beforeId,
  );
}

function paintInk(
  map: MapLibreMap,
  { casingId, lineId, labelId }: IsothermLayerIds,
  { ink, halo }: InkPaint,
) {
  map.setPaintProperty(casingId, "line-color", rgbCss(halo));
  map.setPaintProperty(lineId, "line-color", rgbCss(ink));
  map.setPaintProperty(labelId, "text-color", rgbCss(ink));
  map.setPaintProperty(labelId, "text-halo-color", rgbCss(halo));
}

function isothermWidth(widthScale: number): ExpressionSpecification {
  const stops = LINE_WIDTH_STOPS_PX.flatMap(([zoom, bold, regular]) => [
    zoom,
    ["case", ["get", "bold"], bold * widthScale, regular * widthScale],
  ]);
  return ["interpolate", ["linear"], ["zoom"], ...stops] as ExpressionSpecification;
}

function zoomStops(stops: readonly (readonly [number, number])[]): ExpressionSpecification {
  return ["interpolate", ["linear"], ["zoom"], ...stops.flat()] as ExpressionSpecification;
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

function traceKey(step: number, smooth: boolean): string {
  return `${step}:${smooth ? "smooth" : "raw"}`;
}

function cachedTrace(
  cache: Map<string, Isoline[]>,
  key: string,
  trace: () => Isoline[],
): Isoline[] {
  const traced = cache.get(key);
  if (traced) {
    cache.delete(key);
    cache.set(key, traced);
    return traced;
  }

  const next = trace();
  cache.set(key, next);
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
