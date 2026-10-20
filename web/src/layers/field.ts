import { arrayDoc, cacheByIndex, decode, readArray } from "../data";
import { defaultPalette as layerDefaultPalette, rangeDecimals } from "../display-state";
import { makeHtmlElement } from "../html";
import { createFieldMarksLayer } from "../gpu/field-marks-layer";
import { DOT_INK_RGB, dotLegend, gradientLegend, isothermLegend } from "../legend";
import { addImageLayer, maxTextureSize, removeLayerAndSource, setImage } from "../map";
import { evenStops, lut, paintColormap } from "../render/colormap";
import { positionBytes } from "../render/lattice";
import { sampleTable } from "../render/mercator";
import { FIELD_PALETTES, fieldGradient, rgbCss } from "../render/palettes";
import { latestOnly, stepAt } from "../timeline";
import type { LayerContext, LayerMenu, LayerView } from "../types";
import { type Draw, layerDraws } from "./allocate";
import { createIsolineOverlay } from "./isolines";
import { FALLBACK_PALETTE_NOTE } from "./layer-menu";

const CACHED_STEPS = 24;
const SERIES_OPACITY = 0.8;
const SMOOTH_NOTE = "Smoothed for display; values are per cell.";

/** Render a field time series with cached steps and a fitted colour legend. */
export function createSeriesView(context: LayerContext): LayerView {
  const { map, store, layer, shift, slots, display, report } = context;
  const id = `${layer.id}-series`;
  const { palette: defaultPalette, stops: fittedStops } = layer.style;
  const { time: timeAxis } = layer;
  if (!defaultPalette || !fittedStops || !timeAxis) {
    throw new Error(`Layer "${layer.id}" needs a palette, stops and a time axis`);
  }

  const valueArray = arrayDoc(layer, "value");
  const legendBox = makeHtmlElement("div");
  const stats = valueStats(layer);
  let palette = display?.palette ?? defaultPalette;
  let range = display?.range ?? null;
  let colors = lut(gradientOf(palette));
  let stops = range ? evenStops(...range, fittedStops.length) : fittedStops;
  let draw: Draw | null = null;
  let alive = true;
  // A slow read of an older step must not overwrite the one being displayed.
  let shownStep = -1;

  addImageLayer(map, id, layer.grid.bbox, shift, slots.fill, {
    "raster-opacity": 0,
    "raster-resampling": "nearest",
  });

  const fallback = layerDraws(layer).fallback;
  const marksId = `${layer.id}-dots`;
  const marks = fallback === "dots" ? addMarks(context, marksId) : null;
  const isolines = fallback === "isolines" ? createIsolineOverlay(context) : null;
  isolines?.setVisible(false);

  const table = sampleTable(layer.grid, maxTextureSize(map), { preserveCoverage: true });

  const readStep = cacheByIndex(CACHED_STEPS, async (step) => {
    const openedStore = await store;
    const raw = await readArray(openedStore, valueArray.path, [step, null, null]);
    return decode(raw, valueArray);
  });

  const hideStep = () => {
    map.setPaintProperty(id, "raster-opacity", 0);
    marks?.setDots(false);
    isolines?.setVisible(false);
  };

  const drawValues = (values: Float32Array, step: number) => {
    if (draw === "colour") {
      const rgba = paintColormap(values, table, colors, stops);
      setImage(map, id, new ImageData(rgba, table.width, table.height));
      map.setPaintProperty(id, "raster-opacity", SERIES_OPACITY);
    } else if (draw === "dots") {
      marks!.setPositions(positionBytes(values, stops));
      marks!.setDots(true);
    } else if (draw === "isolines") {
      isolines!.setValues(values, step);
      isolines!.setVisible(true);
    }
  };

  const drawStep = async (step: number) => {
    try {
      const values = await readStep(step);
      if (!alive || step !== shownStep) return;

      drawValues(values, step);

      const nextStep = step + 1;
      if (nextStep < timeAxis.values.length) readStep(nextStep).catch(() => {});
    } catch (error) {
      // An error for a step the user has already left is no longer relevant.
      if (!alive || step !== shownStep) return;

      // What the map shows still belongs to an earlier step and must not pass for this one.
      hideStep();
      report(error);
    }
  };

  const drawLatestStep = latestOnly(drawStep);

  const showLegend = () => {
    const isBottomOpen = range !== null;
    if (draw === "dots") {
      legendBox.replaceChildren(dotLegend(stops, layer.units, layer.grid.res));
    } else if (draw === "isolines") {
      legendBox.replaceChildren(isothermLegend(isolines!.interval));
    } else {
      legendBox.replaceChildren(gradientLegend(colors, stops, layer.units, isBottomOpen));
    }
  };

  // A new colour scale repaints the step on screen from the cached values.
  const restyle = () => {
    colors = lut(gradientOf(palette));
    stops = range ? evenStops(...range, fittedStops.length) : fittedStops;
    isolines?.setRange(range);
    showLegend();
    if (shownStep >= 0) drawLatestStep(shownStep);
  };

  showLegend();

  const menuUpdates = new EventTarget();
  const menu: LayerMenu = {
    title: layer.title,
    heading: "Colours",
    blocks: false,
    updates: menuUpdates,
    get paletteNote() {
      return draw === "colour" ? undefined : FALLBACK_PALETTE_NOTE;
    },
    palettes: FIELD_PALETTES.map(({ name, label }) => ({
      name,
      label,
      colors: gradientOf(name).map(rgbCss),
    })),
    defaultPalette: layerDefaultPalette(layer),
    custom: true,
    get palette() {
      return palette;
    },
    setPalette(name) {
      palette = name;
      restyle();
    },
    range: stats ? {
      fitted: [fittedStops[0], fittedStops[fittedStops.length - 1]],
      bounds: [stats.min, stats.max],
      decimals: rangeDecimals(layer),
      units: layer.units,
      get value() {
        return range;
      },
      set(next) {
        range = next;
        restyle();
      },
    } : undefined,
  };

  return {
    parts: [{
      id: layer.id,
      label: layer.title,
      layerIds: [id, ...(marks ? [marksId] : []), ...(isolines?.layerIds ?? [])],
    }],
    options: [
      {
        label: "Smooth",
        note: SMOOTH_NOTE,
        set: (on) => map.setPaintProperty(id, "raster-resampling", on ? "linear" : "nearest"),
      },
    ],
    menu,
    time: timeAxis,
    setTime(time) {
      shownStep = stepAt(timeAxis.values, timeAxis.end, time);
      if (shownStep < 0) hideStep();
      else drawLatestStep(shownStep);
    },
    show(next) {
      draw = next;
      hideStep();
      showLegend();
      menuUpdates.dispatchEvent(new Event("change"));
      if (draw && shownStep >= 0) drawLatestStep(shownStep);
    },
    legend: () => legendBox,
    destroy() {
      alive = false;
      removeLayerAndSource(map, id);
      removeLayerAndSource(map, marksId);
      isolines?.destroy();
    },
  };
}

function addMarks({ map, layer, shift, slots, report }: LayerContext, id: string) {
  const marks = createFieldMarksLayer({
    id,
    grid: layer.grid,
    shift,
    ink: DOT_INK_RGB,
    onFail: (error) => report(error),
  });
  marks.setHalo(true);
  map.addLayer(marks.layer, slots.marks);
  return marks;
}

function gradientOf(palette: string) {
  const gradient = fieldGradient(palette);
  if (!gradient) throw new Error(`Unknown palette "${palette}"`);

  return gradient;
}

function valueStats({ stats }: LayerContext["layer"]) {
  const { min, max } = (stats ?? {}) as Record<string, unknown>;
  return typeof min === "number" && typeof max === "number" ? { min, max } : null;
}
