/** Cache traced isotherms and crossfade them between two sources with dominant labels. */
import type {
  ExpressionSpecification,
  GeoJSONSource,
  Map as MapLibreMap,
  SymbolLayerSpecification,
} from "maplibre-gl";

import { labelIndexFor, prefersReducedMotion } from "../playback";
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
import { convertValue, displayUnitFor, isUnitFor } from "../units";
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
  /** The spacing of the lines in display units, which follows the display range. */
  readonly interval: number;
  setValues(values: ArrayLike<number>, step: number): void;
  /** Traces the step into the cache, so the hold paints it without tracing. */
  prepareStep(step: number, values: ArrayLike<number>): void;
  /**
   * Drives one frame of the fade from one step to the next by its weight. A step of -1 stands
   * for empty, which fades to or from transparent. Returns false without changing anything while
   * the outgoing setData has not painted, so the clock stalls instead of showing a stale set.
   * Later reloads keep drawing the same data, so they never stall it.
   */
  frame(fromStep: number, toStep: number, mix: number): boolean;
  /** Whether the fade can start now, waiting only for each setData paint. */
  isReady(fromStep: number, toStep: number): boolean;
  /** Shows the held step alone at full opacity without tracing, else false. */
  select(step: number): boolean;
  /** Whether one of the two sources already shows the step. */
  holds(step: number): boolean;
  /** Whether the step failed to trace, so the fade moves on without waiting for it. */
  hasFailed(step: number): boolean;
  /** Lets a fade proceed once after a read failed, with the draw reporting the failure later. */
  markFailed(step: number): void;
  setSmooth(smooth: boolean): void;
  setRange(range: [number, number] | null): void;
  setUnits(unit: string): void;
  setInk(ink: InkPaint): void;
  setVisible(visible: boolean): void;
  /** Shows both label sets with overlap only while playing, so paused labels cull as before. */
  setPlaying(isPlaying: boolean): void;
  destroy(): void;
}

/** Add two empty isotherm sources for a layer; values arrive one time step at a time. */
export function createIsolineOverlay(
  { map, layer, shift, beforeId, display }: LayerContext,
  ink: InkPaint,
): IsolineOverlay {
  const stops = layer.style.stops;
  if (!stops) throw new Error(`Layer "${layer.id}" needs stops for isotherms`);

  const nativeUnits = layer.units;
  let displayUnit = displayUnitFor(nativeUnits, display?.units);
  let currentRange = display?.range ?? undefined;
  let { interval, levels } = isothermScale(stops, currentRange, nativeUnits, displayUnit);
  const sourceIds = [`${layer.id}-isotherms-a`, `${layer.id}-isotherms-b`] as const;
  const groups = sourceIds.map((sourceId) => ({
    casingId: `${sourceId}-casing`,
    lineId: `${sourceId}-lines`,
    labelId: `${sourceId}-labels`,
  }));
  const tracedSteps = new Map<string, Isoline[]>();
  let smooth = true;
  let front: 0 | 1 = 0;
  let keys: [number | null, number | null] = [null, null];
  const painted = [false, false];
  const failed = new Set<number>();
  let overallVisible = true;
  let dominantStep: number | null = null;
  let playing = false;
  const labelShown: [boolean | null, boolean | null] = [null, null];

  for (const [index, sourceId] of sourceIds.entries()) {
    map.addSource(sourceId, { type: "geojson", data: EMPTY_LINES });
    addIsothermLayers(map, sourceId, groups[index], beforeId);
    paintInk(map, groups[index], ink);
    setSlotFactor(groups[index], 0);
  }
  const layerIds = groups.flatMap((group) => Object.values(group));

  return {
    layerIds,

    get interval() {
      return interval;
    },

    setValues(values, step) {
      if (step < 0) {
        setSlotFactor(groups[0], 0);
        setSlotFactor(groups[1], 0);
        dominantStep = null;
        updateLabelVisibility();
        return;
      }

      if (holdsStep(step)) {
        front = slotOfStep(step)!;
        failed.delete(step);
        showSingle();
        return;
      }

      const traced = cachedTrace(
        tracedSteps,
        traceKey(step, smooth),
        () => traceIsolines(values, layer.grid.nx, layer.grid.ny, levels, smooth),
      );
      setSourceData(front, traced);
      keys[front] = step;
      failed.delete(step);
      showSingle();
    },

    prepareStep(step, values) {
      if (step < 0 || holdsStep(step) || failed.has(step)) return;

      cachedTrace(
        tracedSteps,
        traceKey(step, smooth),
        () => traceIsolines(values, layer.grid.nx, layer.grid.ny, levels, smooth),
      );
    },

    frame(fromStep, toStep, mix) {
      if (prefersReducedMotion()) mix = 0;
      if (fromStep === toStep) return true;

      if (mix <= 0) {
        if (fromStep < 0) {
          paintHidden(toStep);
          setSlotFactor(groups[0], 0);
          setSlotFactor(groups[1], 0);
          dominantStep = null;
          updateLabelVisibility();
          return true;
        }

        if (!isSettled(fromStep)) return false;

        front = slotOfStep(fromStep)!;
        paintHidden(toStep);
        showSingle();
        return true;
      }

      if (fromStep < 0) paintHidden(toStep);
      if (!isSettled(fromStep) || !isSettled(toStep)) return false;

      const outgoingFactor = 1 - mix;
      const incomingFactor = mix;
      const outgoingSlot = fromStep < 0 ? null : slotOfStep(fromStep);
      const incomingSlot = toStep < 0 ? null : slotOfStep(toStep);
      for (const [slot, group] of groups.entries()) {
        if (slot === outgoingSlot) setSlotFactor(group, outgoingFactor);
        else if (slot === incomingSlot) setSlotFactor(group, incomingFactor);
        else setSlotFactor(group, 0);
      }
      dominantStep = labelIndexFor({ index: fromStep, next: toStep, mix });
      if (dominantStep < 0) dominantStep = null;
      updateLabelVisibility();
      if (mix >= 1 && toStep >= 0) front = slotOfStep(toStep)!;

      return true;
    },

    isReady(fromStep, toStep) {
      if (fromStep === toStep) return true;

      return isSettled(fromStep) && isSettled(toStep);
    },

    select(step) {
      if (!holdsStep(step)) return false;

      front = slotOfStep(step)!;
      failed.delete(step);
      showSingle();
      return true;
    },

    holds(step) {
      return holdsStep(step);
    },

    hasFailed(step) {
      return failed.has(step);
    },

    markFailed(step) {
      failed.add(step);
    },

    setSmooth(next) {
      if (next === smooth) return;

      smooth = next;
      clearSources();
    },

    setRange(range) {
      currentRange = range ?? undefined;
      const next = isothermScale(stops, currentRange, nativeUnits, displayUnit);
      interval = next.interval;
      if (sameLevels(next.levels, levels)) return;
      levels = next.levels;
      tracedSteps.clear();
      failed.clear();
      clearSources();
    },

    setUnits(unit) {
      if (!isUnitFor(nativeUnits, unit) || unit === displayUnit) return;
      displayUnit = unit;
      const next = isothermScale(stops, currentRange, nativeUnits, displayUnit);
      interval = next.interval;
      levels = next.levels;
      tracedSteps.clear();
      failed.clear();
      clearSources();
    },

    setInk(next) {
      for (const group of groups) paintInk(map, group, next);
    },

    setVisible(visible) {
      overallVisible = visible;
      for (const group of groups) {
        map.setLayoutProperty(group.casingId, "visibility", visible ? "visible" : "none");
        map.setLayoutProperty(group.lineId, "visibility", visible ? "visible" : "none");
      }
      if (!visible) clearSources();
      else updateLabelVisibility();
    },

    setPlaying(isPlaying) {
      if (isPlaying === playing) return;

      playing = isPlaying;
      // Both sets show at once while playing so the hidden set cannot block the fade.
      for (const group of groups) {
        map.setLayoutProperty(group.labelId, "text-allow-overlap", isPlaying);
        map.setLayoutProperty(group.labelId, "text-ignore-placement", isPlaying);
      }
      updateLabelVisibility();
    },

    destroy() {
      for (const group of groups) {
        for (const id of Object.values(group)) {
          if (map.getLayer(id)) map.removeLayer(id);
        }
      }
      for (const sourceId of sourceIds) {
        if (map.getSource(sourceId)) map.removeSource(sourceId);
      }
    },
  };

  function holdsStep(step: number): boolean {
    return step >= 0 && keys.includes(step);
  }

  function slotOfStep(step: number): 0 | 1 | null {
    if (step < 0) return null;
    if (keys[0] === step) return 0;
    if (keys[1] === step) return 1;

    return null;
  }

  function isLoaded(sourceId: string): boolean {
    const isSourceLoaded = (map as { isSourceLoaded?: (id: string) => boolean }).isSourceLoaded;

    return isSourceLoaded?.call(map, sourceId) ?? true;
  }

  function isSettled(step: number): boolean {
    if (step < 0) return true;
    if (failed.has(step)) return true;

    const slot = slotOfStep(step);
    // A reload keeps drawing the same data so only the slot's own setData waits.
    return slot !== null && (painted[slot] ||= isLoaded(sourceIds[slot]));
  }

  function paintHidden(toStep: number): void {
    // Only the hold paints the hidden slot, so the lookahead never replaces a fading set.
    if (toStep < 0 || holdsStep(toStep)) return;
    const cached = tracedSteps.get(traceKey(toStep, smooth));
    if (!cached) return;

    const hidden = otherSlot(front);
    setSourceData(hidden, cached);
    keys[hidden] = toStep;
  }

  function setSourceData(slot: 0 | 1, traced: Isoline[]) {
    // A fresh setData needs one loaded report before the slot counts as settled.
    painted[slot] = false;
    const features = traced.map(
      (line) => lineFeature(line, interval, layer.grid, shift, nativeUnits, displayUnit),
    );
    (map.getSource(sourceIds[slot]) as GeoJSONSource).setData({
      type: "FeatureCollection",
      features,
    });
  }

  function showSingle() {
    const shown = keys[front];
    for (const [slot, group] of groups.entries()) {
      setSlotFactor(group, slot === front ? 1 : 0);
    }
    dominantStep = shown;
    updateLabelVisibility();
  }

  function clearSources() {
    for (const sourceId of sourceIds) {
      (map.getSource(sourceId) as GeoJSONSource).setData(EMPTY_LINES);
    }
    keys = [null, null];
    front = 0;
    dominantStep = null;
    failed.clear();
    for (const group of groups) setSlotFactor(group, 0);
    updateLabelVisibility();
  }

  function updateLabelVisibility() {
    for (const [slot, group] of groups.entries()) {
      const showsDominant = overallVisible && dominantStep !== null && keys[slot] === dominantStep;
      // Opacity flips labels without a reload, and paused visibility keeps culling exact.
      map.setPaintProperty(group.labelId, "text-opacity", showsDominant ? 1 : 0);
      const shouldShow = overallVisible && (playing || showsDominant);
      if (labelShown[slot] !== shouldShow) {
        labelShown[slot] = shouldShow;
        map.setLayoutProperty(group.labelId, "visibility", shouldShow ? "visible" : "none");
      }
    }
  }

  function setSlotFactor(group: IsothermLayerIds, factor: number) {
    map.setPaintProperty(group.casingId, "line-opacity", CASING_OPACITY * factor);
    map.setPaintProperty(group.lineId, "line-opacity", scaledZoomStops(factor));
  }
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
  // Transitions stay at zero so the per-frame crossfade values apply directly.
  map.addLayer(
    {
      id: casingId,
      type: "line",
      source: sourceId,
      layout: { "line-cap": "butt", "line-join": "round", visibility: "visible" },
      paint: {
        "line-dasharray": CASING_DASH_PATTERN,
        "line-opacity": 0,
        "line-opacity-transition": { duration: 0 },
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
      layout: { "line-cap": "butt", "line-join": "round", visibility: "visible" },
      paint: {
        "line-dasharray": ISOTHERM_DASH_PATTERN,
        "line-opacity": zoomStops(LINE_OPACITY_STOPS),
        "line-opacity-transition": { duration: 0 },
        "line-width": isothermWidth(1),
      },
    },
    beforeId,
  );

  const font = textFont(map);
  // Culling stays on while paused so labels never cover place names.
  map.addLayer(
    {
      id: labelId,
      type: "symbol",
      source: sourceId,
      layout: {
        "symbol-placement": "line",
        "symbol-spacing": LABEL_SPACING_PX,
        "text-allow-overlap": false,
        "text-field": ["get", "label"] as ExpressionSpecification,
        "text-ignore-placement": false,
        "text-max-angle": LABEL_MAX_ANGLE_DEG,
        "text-size": LABEL_SIZE_PX,
        visibility: "visible",
        ...(font ? { "text-font": font } : {}),
      },
      paint: {
        "text-halo-width": LABEL_HALO_WIDTH_PX,
        "text-opacity": 0,
        "text-opacity-transition": { duration: 0 },
      },
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

/** Rebuilds the zoom stops scaled by the fade weight, keeping zoom the top-level input. */
function scaledZoomStops(factor: number): ExpressionSpecification {
  const scaled: (readonly [number, number])[] = LINE_OPACITY_STOPS.map(([zoom, opacity]) => [
    zoom,
    opacity * factor,
  ]);

  return zoomStops(scaled);
}

function textFont(map: MapLibreMap) {
  return map.getStyle().layers.find(
    (layer): layer is SymbolLayerSpecification =>
      layer.type === "symbol" && layer.layout?.["text-font"] !== undefined,
  )?.layout?.["text-font"];
}

function otherSlot(slot: 0 | 1): 0 | 1 {
  return slot === 0 ? 1 : 0;
}

function isothermScale(
  stops: readonly number[],
  range: [number, number] | undefined,
  nativeUnits: string,
  displayUnit: string,
): { interval: number; levels: number[] } {
  // Geometry stays in native units while the interval stays round in the display unit.
  const effectiveStops = range ? evenStops(...range, stops.length) : stops;
  // Full precision keeps label rounding out of level selection.
  const shownStops = effectiveStops.map(
    (stop) => convertValue(stop, nativeUnits, displayUnit),
  );
  const interval = isolineInterval(shownStops);
  const shownLevels = isolineLevels(
    shownStops[0],
    shownStops[shownStops.length - 1],
    interval,
  );

  const levels = shownLevels.map((level) => convertValue(level, displayUnit, nativeUnits));

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

function lineFeature(
  line: Isoline,
  interval: number,
  grid: GridDoc,
  shift: number,
  nativeUnits: string,
  displayUnit: string,
) {
  // Boldness and labels use display values so a Fahrenheit interval stays round.
  const shown = convertValue(line.value, nativeUnits, displayUnit);
  return {
    type: "Feature" as const,
    properties: {
      bold: isBoldLevel(shown, interval),
      label: `${formatLevel(shown)}°`,
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
