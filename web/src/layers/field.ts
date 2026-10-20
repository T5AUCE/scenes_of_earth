import { arrayDoc, cacheByIndex, decode, readArray, type Store } from "../data";
import { defaultPalette as layerDefaultPalette, rangeDecimals } from "../display-state";
import { makeHtmlElement } from "../html";
import { createFieldMarksLayer } from "../gpu/field-marks-layer";
import { keepThroughContextLoss } from "../gpu/tiled-layer";
import { DOT_INK_RGB, dotLegend, gradientLegend, isothermLegend } from "../legend";
import { addImageLayer, maxTextureSize, removeLayerAndSource, setImage } from "../map";
import { lut, paintColormap, stopsForRange } from "../render/colormap";
import { positionBytes } from "../render/lattice";
import { sampleTable } from "../render/mercator";
import { FIELD_PALETTES, fieldGradient, rgbCss } from "../render/palettes";
import { latestOnly, stepAt } from "../timeline";
import type { LayerContext, LayerDoc, LayerMenu, LayerView, TimeDoc } from "../types";
import { type Draw, layerDraws } from "./allocate";
import { createIsolineOverlay, type IsolineOverlay } from "./isolines";
import { FALLBACK_PALETTE_NOTE } from "./layer-menu";

const CACHED_STEPS = 24;
const SERIES_OPACITY = 0.8;
const SMOOTH_NOTE = "Smoothed for display; values are per cell.";

type StepReader = (step: number) => Promise<Float32Array>;

// Layers read by the blend share their cached steps with the layer's own view.
const readers = new WeakMap<Promise<Store>, Map<string, StepReader>>();

/** The cached reader of a layer's decoded steps, shared by everything that draws the layer. */
export function fieldReader(layer: LayerDoc, store: Promise<Store>): StepReader {
  const byLayer = readers.get(store) ?? new Map<string, StepReader>();
  readers.set(store, byLayer);

  const existing = byLayer.get(layer.id);
  if (existing) return existing;

  const valueArray = arrayDoc(layer, "value");
  const reader = cacheByIndex(CACHED_STEPS, async (step) => {
    const raw = await readArray(await store, valueArray.path, [step, null, null]);
    return decode(raw, valueArray);
  });
  byLayer.set(layer.id, reader);
  return reader;
}

/** Render a field time series with cached steps and a fitted colour legend. */
export function createSeriesView(context: LayerContext): LayerView {
  return new FieldView(context);
}

class FieldView implements LayerView {
  readonly parts;
  readonly options;
  readonly menu: LayerMenu;
  readonly time: TimeDoc;

  private readonly context: LayerContext;
  private readonly id: string;
  private readonly marksId: string;
  private readonly fittedStops: number[];
  private readonly legendBox = makeHtmlElement("div");
  private readonly menuUpdates = new EventTarget();
  private readonly table;
  private readonly marks: ReturnType<typeof createFieldMarksLayer> | null;
  private readonly stopKeepingMarks: (() => void) | null;
  private readonly isolines: IsolineOverlay | null;
  private readonly readStep;
  private readonly drawLatestStep;
  private palette: string;
  private range: [number, number] | null;
  private colors;
  private stops: number[];
  private draw: Draw | null = null;
  private alive = true;
  // A slow read of an older step must not overwrite the one being displayed.
  private shownStep = -1;

  constructor(context: LayerContext) {
    this.context = context;
    const { map, store, layer, shift, slots, display } = context;
    const { palette: defaultPalette, stops: fittedStops } = layer.style;
    if (!defaultPalette || !fittedStops || !layer.time) {
      throw new Error(`Layer "${layer.id}" needs a palette, stops and a time axis`);
    }

    this.id = `${layer.id}-series`;
    this.marksId = `${layer.id}-dots`;
    this.time = layer.time;
    this.fittedStops = fittedStops;
    this.palette = display?.palette ?? defaultPalette;
    this.range = display?.range ?? null;
    this.colors = lut(gradientOf(this.palette));
    this.stops = this.stopsFor(this.range);

    addImageLayer(map, this.id, layer.grid.bbox, shift, slots.fill, {
      "raster-opacity": 0,
      "raster-resampling": "nearest",
    });

    const fallback = layerDraws(layer).fallback;
    this.marks = fallback === "dots" ? this.addMarks() : null;
    this.stopKeepingMarks = this.marks
      ? keepThroughContextLoss(map, this.marks.layer, slots.marks)
      : null;
    this.isolines = fallback === "isolines" ? createIsolineOverlay(context) : null;
    this.isolines?.setVisible(false);

    this.table = sampleTable(layer.grid, maxTextureSize(map), { preserveCoverage: true });
    this.readStep = fieldReader(layer, store);
    this.drawLatestStep = latestOnly((step: number) => this.drawStep(step));

    this.showLegend();
    this.menu = this.createMenu();
    this.parts = [{
      id: layer.id,
      label: layer.title,
      layerIds: [
        this.id,
        ...(this.marks ? [this.marksId] : []),
        ...(this.isolines?.layerIds ?? []),
      ],
    }];
    this.options = [
      {
        label: "Smooth",
        note: SMOOTH_NOTE,
        set: (on: boolean) => {
          map.setPaintProperty(this.id, "raster-resampling", on ? "linear" : "nearest");
        },
      },
    ];
  }

  private stopsFor(range: [number, number] | null) {
    return stopsForRange(this.fittedStops, range);
  }

  private addMarks() {
    const { map, layer, shift, slots, report } = this.context;
    const marks = createFieldMarksLayer({
      id: this.marksId,
      grid: layer.grid,
      shift,
      ink: DOT_INK_RGB,
      onFail: (error) => report(error),
    });
    marks.setHalo(true);
    map.addLayer(marks.layer, slots.marks);
    return marks;
  }

  private createMenu(): LayerMenu {
    const view = this;
    const { layer } = this.context;
    const stats = valueStats(layer);

    return {
      title: layer.title,
      heading: "Colours",
      blocks: false,
      updates: this.menuUpdates,
      get paletteNote() {
        return view.draw === "colour" ? undefined : FALLBACK_PALETTE_NOTE;
      },
      palettes: FIELD_PALETTES.map(({ name, label }) => ({
        name,
        label,
        colors: gradientOf(name).map(rgbCss),
      })),
      defaultPalette: layerDefaultPalette(layer),
      custom: true,
      get palette() {
        return view.palette;
      },
      setPalette: (name) => {
        this.palette = name;
        this.restyle();
      },
      range: stats ? {
        fitted: [this.fittedStops[0], this.fittedStops[this.fittedStops.length - 1]],
        bounds: [stats.min, stats.max],
        decimals: rangeDecimals(layer),
        units: layer.units,
        get value() {
          return view.range;
        },
        set: (next) => {
          this.range = next;
          this.restyle();
        },
      } : undefined,
    };
  }

  // A new colour scale repaints the step on screen from the cached values.
  private restyle() {
    this.colors = lut(gradientOf(this.palette));
    this.stops = this.stopsFor(this.range);
    this.isolines?.setRange(this.range);
    this.showLegend();
    if (this.shownStep >= 0) this.drawLatestStep(this.shownStep);
  }

  private showLegend() {
    const { layer } = this.context;
    if (this.draw === "dots") {
      this.legendBox.replaceChildren(dotLegend(this.stops, layer.units, layer.grid.res));
    } else if (this.draw === "isolines") {
      this.legendBox.replaceChildren(isothermLegend(this.isolines!.interval));
    } else {
      const isBottomOpen = this.range !== null;
      this.legendBox.replaceChildren(
        gradientLegend(this.colors, this.stops, layer.units, isBottomOpen),
      );
    }
  }

  setTime(time: string) {
    this.shownStep = stepAt(this.time.values, this.time.end, time);
    if (this.shownStep < 0) this.hideStep();
    else this.drawLatestStep(this.shownStep);
  }

  show(next: Draw | null) {
    this.draw = next;
    this.hideStep();
    this.showLegend();
    this.menuUpdates.dispatchEvent(new Event("change"));
    if (this.draw && this.shownStep >= 0) this.drawLatestStep(this.shownStep);
  }

  private hideStep() {
    this.context.map.setPaintProperty(this.id, "raster-opacity", 0);
    this.marks?.setDots(false);
    this.isolines?.setVisible(false);
  }

  private async drawStep(step: number) {
    try {
      const values = await this.readStep(step);
      if (!this.alive || step !== this.shownStep) return;

      this.drawValues(values, step);

      const nextStep = step + 1;
      if (nextStep < this.time.values.length) this.readStep(nextStep).catch(() => {});
    } catch (error) {
      // An error for a step the user has already left is no longer relevant.
      if (!this.alive || step !== this.shownStep) return;

      // What the map shows still belongs to an earlier step and must not pass for this one.
      this.hideStep();
      this.context.report(error);
    }
  }

  private drawValues(values: Float32Array, step: number) {
    const { map } = this.context;
    if (this.draw === "colour") {
      const rgba = paintColormap(values, this.table, this.colors, this.stops);
      setImage(map, this.id, new ImageData(rgba, this.table.width, this.table.height));
      map.setPaintProperty(this.id, "raster-opacity", SERIES_OPACITY);
    } else if (this.draw === "dots") {
      this.marks!.setPositions(positionBytes(values, this.stops));
      this.marks!.setDots(true);
    } else if (this.draw === "isolines") {
      this.isolines!.setValues(values, step);
      this.isolines!.setVisible(true);
    }
  }

  legend() {
    return this.legendBox;
  }

  destroy() {
    this.alive = false;
    this.stopKeepingMarks?.();
    removeLayerAndSource(this.context.map, this.id);
    removeLayerAndSource(this.context.map, this.marksId);
    this.isolines?.destroy();
  }
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
