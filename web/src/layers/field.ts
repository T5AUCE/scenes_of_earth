/** Draw field time series as colour fills or fallback marks with shared cached values. */
import { arrayDoc, cacheByIndex, decode, readArray, readMask, type Store } from "../data";
import {
  defaultInk,
  defaultPalette as layerDefaultPalette,
  densityControl,
  rangeDecimals,
  storeDensity,
} from "../display-state";
import { makeHtmlElement } from "../html";
import { createFieldMarksLayer } from "../gpu/field-marks-layer";
import { keepThroughContextLoss } from "../gpu/tiled-layer";
import {
  createZoomWatch,
  dotLegend,
  gradientLegend,
  hatchLegend,
  isothermLegend,
} from "../legend";
import { addImageLayer, maxTextureSize, removeLayerAndSource, setImage } from "../map";
import { displayStops, displayUnitFor, isUnitFor, unitOptions } from "../units";
import { lut, paintColormap, stopsForRange } from "../render/colormap";
import {
  DEFAULT_DENSITY_RATIO,
  hasHatchedCells,
  positionBytes,
  quantiseDensity,
} from "../render/lattice";
import { sampleTable } from "../render/mercator";
import {
  FIELD_PALETTES,
  fieldGradient,
  INK_COLORS,
  inkPaint,
  rgbCss,
} from "../render/palettes";
import { latestOnly, stepAt } from "../timeline";
import type {
  InkMenu,
  LayerContext,
  LayerControl,
  LayerDoc,
  LayerMenu,
  LayerView,
  TimeDoc,
  UnitsMenu,
} from "../types";
import { type Draw, layerDraws } from "./allocate";
import { createIsolineOverlay, type IsolineOverlay } from "./isolines";
import { FALLBACK_PALETTE_NOTE } from "./layer-menu";

const CACHED_STEPS = 24;
const SERIES_OPACITY = 0.8;
const SMOOTH_NOTE = "Smoothed for display; values are per cell.";

type StepReader = (step: number) => Promise<Float32Array>;

// Layers read by the blend share their cached steps with the layer's own view.
const readers = new WeakMap<Promise<Store>, Map<string, StepReader>>();

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
  private readonly mask: Promise<ArrayLike<number> | null> | null;
  private readonly readStep;
  private readonly drawLatestStep;
  private readonly dotsZoomWatch;
  private palette: string;
  // Only a layer with dots or isotherms draws its ink, so the empty default is never painted.
  private ink: string;
  private density: number;
  private range: [number, number] | null;
  private units: string;
  private colors;
  private stops: number[];
  private draw: Draw | null = null;
  private hasHatched = false;
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
    this.ink = display?.ink ?? defaultInk(layer) ?? "";
    this.density = display?.density ?? DEFAULT_DENSITY_RATIO;
    this.range = display?.range ?? null;
    this.units = displayUnitFor(layer.units, display?.units);
    this.colors = lut(gradientOf(this.palette));
    this.stops = stopsForRange(this.fittedStops, this.range);

    addImageLayer(map, this.id, layer.grid.bbox, shift, slots.fill, {
      "raster-opacity": 0,
      "raster-resampling": "linear",
    });

    const fallback = layerDraws(layer).fallback;
    this.marks = fallback === "dots" ? this.addMarks() : null;
    this.stopKeepingMarks = this.marks
      ? keepThroughContextLoss(map, this.marks.layer, slots.marks)
      : null;
    // A failed static mask read drops the hatch without preventing dots from drawing.
    this.mask = this.marks
      ? store.then((opened) => readMask(opened, layer)).catch(() => null)
      : null;
    this.isolines = fallback === "isolines"
      ? createIsolineOverlay(context, inkPaint(this.ink))
      : null;
    this.isolines?.setVisible(false);

    this.table = sampleTable(layer.grid, maxTextureSize(map), { preserveCoverage: true });
    this.readStep = fieldReader(layer, store);
    this.drawLatestStep = latestOnly((step: number) => this.drawStep(step));

    this.dotsZoomWatch = createZoomWatch(map, () => this.showLegend());
    this.showLegend();
    this.menu = this.createMenu();
    this.parts = [
      {
        id: layer.id,
        label: layer.title,
        layerIds: [
          this.id,
          ...(this.marks ? [this.marksId] : []),
          ...(this.isolines?.layerIds ?? []),
        ],
        controls: this.marks ? [this.createDensityControl()] : undefined,
      },
    ];
    this.options = [
      {
        label: "Smooth",
        note: SMOOTH_NOTE,
        initial: true,
        set: (on: boolean) => {
          map.setPaintProperty(this.id, "raster-resampling", on ? "linear" : "nearest");
          this.isolines?.setSmooth(on);
          if (this.draw === "isolines" && this.shownStep >= 0) {
            this.drawLatestStep(this.shownStep);
          }
        },
      },
    ];
  }

  private addMarks() {
    const { map, layer, shift, slots, report } = this.context;
    const marks = createFieldMarksLayer({
      id: this.marksId,
      grid: layer.grid,
      shift,
      ink: inkPaint(this.ink),
      onFail: (error) => report(error),
    });
    marks.setHalo(true);
    marks.setDensity(this.density);
    map.addLayer(marks.layer, slots.marks);
    return marks;
  }

  private showLegend() {
    const element = this.legendOf();
    if (this.hasHatched) element.append(hatchLegend());
    this.legendBox.replaceChildren(element);
  }

  private legendOf() {
    const { layer, map } = this.context;
    const stops = displayStops(this.stops, layer.units, this.units, rangeDecimals(layer));
    if (this.draw === "dots") {
      return dotLegend(
        stops,
        this.units,
        layer.grid,
        map.getZoom(),
        this.density,
        inkPaint(this.ink),
      );
    }
    if (this.draw === "isolines") {
      return isothermLegend(this.isolines!.interval, inkPaint(this.ink), this.units);
    }

    return gradientLegend(this.colors, stops, this.units, this.range !== null);
  }

  private createDensityControl(): LayerControl {
    const view = this;

    return {
      ...densityControl(() => view.density, (density) => this.setDensity(density)),
      get isShown() {
        return view.draw === "dots";
      },
      updates: this.menuUpdates,
    };
  }

  private setDensity(density: number) {
    this.density = quantiseDensity(density);
    this.marks?.setDensity(this.density);
    this.showLegend();
    const stored = this.density === DEFAULT_DENSITY_RATIO ? null : this.density;
    storeDensity(this.context.layer.id, stored);
    this.context.changeDisplay({ density: stored ?? undefined });
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
      resetDensity: () => {
        view.setDensity(DEFAULT_DENSITY_RATIO);
        view.menuUpdates.dispatchEvent(new Event("change"));
      },
      get isDensityDefault() {
        return view.density === DEFAULT_DENSITY_RATIO;
      },
      palettes: FIELD_PALETTES.map(({ name, label }) => ({
        name,
        label,
        colors: gradientOf(name).map(rgbCss),
      })),
      defaultPalette: layerDefaultPalette(layer),
      custom: true,
      ink: this.createInkMenu(),
      units: this.createUnitsMenu(),
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
        get displayUnit() {
          return view.units;
        },
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

  private createUnitsMenu(): UnitsMenu | undefined {
    const view = this;
    const { layer } = this.context;
    const options = unitOptions(layer.units);
    if (!options) return undefined;

    return {
      options,
      defaultUnit: layer.units,
      get value() {
        return view.units;
      },
      set: (unit) => {
        if (!isUnitFor(layer.units, unit) || unit === view.units) return;
        this.units = unit;
        this.isolines?.setUnits(unit);
        this.showLegend();
        this.menuUpdates.dispatchEvent(new Event("change"));
        if (view.draw === "isolines" && this.shownStep >= 0) {
          this.drawLatestStep(this.shownStep);
        }
      },
    };
  }

  private createInkMenu(): InkMenu | undefined {
    const view = this;
    if (!this.marks && !this.isolines) return undefined;

    return {
      heading: this.marks ? "Dot ink" : "Isotherm ink",
      presets: INK_COLORS.map(({ name, label, color }) => ({ name, label, colors: [color] })),
      defaultInk: defaultInk(this.context.layer)!,
      get inUse() {
        return view.draw === "dots" || view.draw === "isolines";
      },
      get value() {
        return view.ink;
      },
      set: (ink) => {
        this.ink = ink;
        this.marks?.setInk(inkPaint(ink));
        this.isolines?.setInk(inkPaint(ink));
        this.showLegend();
      },
    };
  }

  private restyle() {
    this.colors = lut(gradientOf(this.palette));
    this.stops = stopsForRange(this.fittedStops, this.range);
    this.isolines?.setRange(this.range);
    this.showLegend();
    if (this.shownStep >= 0) this.drawLatestStep(this.shownStep);
  }

  setTime(time: string) {
    this.shownStep = stepAt(this.time.values, this.time.end, time);
    if (this.shownStep < 0) this.hideStep();
    else this.drawLatestStep(this.shownStep);
  }

  show(next: Draw | null) {
    this.draw = next;
    this.dotsZoomWatch.setActive(next === "dots");
    this.hideStep();
    this.showLegend();
    this.menuUpdates.dispatchEvent(new Event("change"));
    if (this.draw && this.shownStep >= 0) this.drawLatestStep(this.shownStep);
  }

  private hideStep() {
    this.context.map.setPaintProperty(this.id, "raster-opacity", 0);
    this.marks?.setDots(false);
    this.marks?.setHatch(false);
    this.isolines?.setVisible(false);
    this.setHatched(false);
  }

  private setHatched(hasHatched: boolean) {
    if (hasHatched === this.hasHatched) return;

    this.hasHatched = hasHatched;
    this.showLegend();
  }

  private async drawStep(step: number) {
    try {
      const [values, mask] = await Promise.all([this.readStep(step), this.mask]);
      if (!this.alive || step !== this.shownStep) return;

      this.drawValues(values, step, mask);

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

  private drawValues(
    values: Float32Array,
    step: number,
    mask: ArrayLike<number> | null,
  ) {
    const { map } = this.context;
    this.updateMarks(values, mask);
    if (this.draw === "colour") {
      const rgba = paintColormap(values, this.table, this.colors, this.stops);
      setImage(map, this.id, new ImageData(rgba, this.table.width, this.table.height));
      map.setPaintProperty(this.id, "raster-opacity", SERIES_OPACITY);
    } else if (this.draw === "isolines") {
      this.isolines!.setValues(values, step);
      this.isolines!.setVisible(true);
    }
  }

  private updateMarks(values: Float32Array, mask: ArrayLike<number> | null) {
    if (!this.marks) return;

    const positions = positionBytes(values, this.stops);
    const hasHatch = mask !== null && this.draw !== null && hasHatchedCells(positions, mask);
    this.marks.setMask(mask ?? new Uint8Array(positions.length).fill(1));
    this.marks.setPositions(positions);
    this.marks.setDots(this.draw === "dots");
    this.marks.setHatch(hasHatch);
    this.setHatched(hasHatch);
  }

  legend() {
    return this.legendBox;
  }

  destroy() {
    this.alive = false;
    this.dotsZoomWatch.setActive(false);
    this.stopKeepingMarks?.();
    removeLayerAndSource(this.context.map, this.id);
    removeLayerAndSource(this.context.map, this.marksId);
    this.isolines?.destroy();
  }
}

/** Read decoded steps from a cache shared by every renderer of the layer. */
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

function gradientOf(palette: string) {
  const gradient = fieldGradient(palette);
  if (!gradient) throw new Error(`Unknown palette "${palette}"`);

  return gradient;
}

function valueStats({ stats }: LayerContext["layer"]) {
  const { min, max } = (stats ?? {}) as Record<string, unknown>;
  return typeof min === "number" && typeof max === "number" ? { min, max } : null;
}
