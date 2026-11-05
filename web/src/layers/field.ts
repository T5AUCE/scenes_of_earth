/** Draw field time series as colour fills or fallback marks with shared cached values. */
import {
  arrayDoc,
  createStepReader,
  decode,
  readArray,
  readMask,
  readSteps,
  type Store,
  type StepReader,
} from "../data";
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
import {
  addImagePair,
  maxTextureSize,
  removeLayerAndSource,
  setImage,
  setPairOpacities,
} from "../map";
import { ImageCrossfade, prefersReducedMotion } from "../playback";
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

const SERIES_OPACITY = 0.8;
const SMOOTH_NOTE = "Smoothed for display; values are per cell.";

// Layers read by the blend share their cached steps with the layer's own view.
const readers = new WeakMap<Promise<Store>, Map<string, StepReader>>();

/** Render a field time series with cached steps and a fitted colour legend. */
export function createSeriesView(context: LayerContext): LayerView {
  return new FieldView(context);
}

/** Kept for each painted image so the hatch can switch at the fade midpoint without rereading. */
interface MarksState {
  positions: Uint8Array;
  mask: ArrayLike<number> | null;
  hasHatch: boolean;
}

class FieldView implements LayerView {
  readonly parts;
  readonly options;
  readonly menu: LayerMenu;
  readonly time: TimeDoc;

  private readonly context: LayerContext;
  private readonly id: string;
  private readonly fadeIds: readonly [string, string];
  private readonly fade: ImageCrossfade<number>;
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
  private marksStep: number | null = null;
  private readonly marksByStep = new Map<number, MarksState>();
  private readonly isolineInflight = new Set<number>();
  private armingStep: number | null = null;
  private readonly failedMarks = new Set<number>();
  // Without an area mask every cell counts, and one array keeps the layer's blocks cached.
  private solidMask: Uint8Array | null = null;

  constructor(context: LayerContext) {
    this.context = context;
    const { map, store, layer, shift, slots, display } = context;
    const { palette: defaultPalette, stops: fittedStops } = layer.style;
    if (!defaultPalette || !fittedStops || !layer.time) {
      throw new Error(`Layer "${layer.id}" needs a palette, stops and a time axis`);
    }

    this.id = `${layer.id}-series`;
    this.fadeIds = [this.id, `${this.id}-next`];
    this.fade = new ImageCrossfade(
      SERIES_OPACITY,
      {
        setImage: (slot, image) => setImage(map, this.fadeIds[slot], image),
        setOpacities: (opacities) => setPairOpacities(map, this.fadeIds, opacities),
      },
      (step) => this.marksByStep.delete(step),
    );
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

    addImagePair(map, this.fadeIds, layer.grid.bbox, shift, slots.fill, {
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
          ...this.fadeIds,
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
          for (const id of this.fadeIds) {
            map.setPaintProperty(id, "raster-resampling", on ? "linear" : "nearest");
          }
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
    this.fade.invalidate();
    this.marksByStep.clear();
    this.failedMarks.clear();
    this.marksStep = null;
    this.isolines?.setRange(this.range);
    this.showLegend();
    if (this.shownStep >= 0) this.drawLatestStep(this.shownStep);
  }

  setTime(time: string) {
    this.shownStep = stepAt(this.time.values, this.time.end, time);
    if (this.shownStep < 0) {
      this.hideStep();
      return;
    }

    // A painted image shows at once, so a pause never waits on the decoded values.
    if (this.draw === "colour" && this.fade.select(this.shownStep)) {
      this.followDominant(this.shownStep);
    } else if (this.draw === "isolines" && this.isolines?.holds(this.shownStep)) {
      this.isolines.select(this.shownStep);
    } else if (this.draw === "dots" && this.marksByStep.has(this.shownStep)) {
      this.showMarks(this.marksByStep.get(this.shownStep)!);
    }
    this.drawLatestStep(this.shownStep);
  }

  setFrame(time: string, next: string, mix: number) {
    const step = stepAt(this.time.values, this.time.end, time);
    const nextStep = stepAt(this.time.values, this.time.end, next);
    if (this.draw === "isolines") {
      if (step !== this.shownStep) {
        this.setTime(time);
        return;
      }

      // Equal steps hold a single set, so the map is never touched mid-play.
      if (step === nextStep) return;

      if (step < 0 && nextStep >= 0) this.isolines!.setVisible(true);
      this.isolines!.frame(step, nextStep, mix);
      this.refillIsolines(next, nextStep);
      return;
    }
    if (this.draw === "dots") {
      this.frameDots(time, step, nextStep, prefersReducedMotion() ? 0 : mix);
      return;
    }
    if (this.draw !== "colour") {
      this.cutTo(mix < 0.5 ? time : next);
      return;
    }

    if (step !== this.shownStep) {
      this.setTime(time);
      return;
    }

    this.fade.frame(keyOf(step), keyOf(nextStep), mix);
    this.followDominant(mix < 0.5 ? step : nextStep);
    if (nextStep >= 0) this.fade.prepare(nextStep, () => this.loadNext(nextStep));
  }

  private refillIsolines(next: string, nextStep: number) {
    if (nextStep < 0) return;
    if (this.isolines!.holds(nextStep)) return;
    if (this.isolines!.hasFailed(nextStep)) return;
    if (this.isolineInflight.has(nextStep)) return;

    this.isolineInflight.add(nextStep);
    void this.prepare(next)
      .catch(() => {})
      .finally(() => this.isolineInflight.delete(nextStep));
  }

  private frameDots(time: string, step: number, nextStep: number, mix: number) {
    if (step !== this.shownStep) {
      this.setTime(time);
      return;
    }

    // Equal steps hold what the shown step drew, so the layer is not touched mid-play.
    if (step === nextStep) return;

    this.keepMarksOf(step, nextStep);
    this.armMarks(nextStep);
    const from = this.marksByStep.get(step) ?? null;
    const to = this.marksByStep.get(nextStep) ?? null;
    const isMissing = (step >= 0 && !from) || (nextStep >= 0 && !to);
    if (isMissing) return;

    this.showFade(from, to, mix);
  }

  // Only the two steps in use stay, however far play looks ahead.
  private keepMarksOf(step: number, nextStep: number) {
    for (const cached of this.marksByStep.keys()) {
      if (cached !== step && cached !== nextStep) this.marksByStep.delete(cached);
    }
  }

  private armMarks(step: number) {
    const isArmed = step < 0 || this.marksByStep.has(step) || this.failedMarks.has(step);
    if (isArmed || this.armingStep === step) return;

    this.armingStep = step;
    void this.loadMarks(step);
  }

  private async loadMarks(step: number) {
    try {
      const [values, mask] = await Promise.all([this.readStep.read(step, false), this.mask]);
      if (this.alive && this.draw === "dots") this.cacheMarks(step, this.marksOf(values, mask));
    } catch {
      // The draw of that step reports the failure when the viewer reaches it.
      this.failedMarks.add(step);
    } finally {
      if (this.armingStep === step) this.armingStep = null;
    }
  }

  isFrameReady(time: string, next: string) {
    const step = stepAt(this.time.values, this.time.end, time);
    const nextStep = stepAt(this.time.values, this.time.end, next);
    if (this.draw === "isolines") return this.isolines!.isReady(step, nextStep);
    if (this.draw === "dots") return this.areMarksReady(nextStep);
    if (this.draw !== "colour") return true;

    return this.fade.isReady(keyOf(step), keyOf(nextStep));
  }

  // A fade can start once the next step's bytes are uploaded, or when it failed to load.
  private areMarksReady(nextStep: number) {
    if (nextStep < 0 || this.failedMarks.has(nextStep)) return true;

    const state = this.marksByStep.get(nextStep);
    return state !== undefined && this.marks!.isReady(state.positions);
  }

  async prepare(time: string): Promise<void> {
    const step = stepAt(this.time.values, this.time.end, time);
    if (step < 0) return;

    if (this.draw !== "isolines") {
      await this.readStep.read(step, false);
      return;
    }

    // A failed read marks the step so the fade moves on and the draw reports it later.
    try {
      const values = await this.readStep.read(step, false);
      if (!this.alive || this.draw !== "isolines") return;

      this.isolines!.prepareStep(step, values);
    } catch (error) {
      this.isolines?.markFailed(step);
      throw error;
    }
  }

  maxLookahead() {
    return this.readStep.maxLookahead();
  }

  release() {
    this.readStep.release();
  }

  setPlaying(isPlaying: boolean) {
    this.readStep.setPlaying(isPlaying);
  }

  show(next: Draw | null) {
    this.draw = next;
    this.dotsZoomWatch.setActive(next === "dots");
    this.hideStep();
    this.showLegend();
    this.menuUpdates.dispatchEvent(new Event("change"));
    if (this.draw && this.shownStep >= 0) this.drawLatestStep(this.shownStep);
  }

  // A layer that draws nothing yet still follows the label's step.
  private cutTo(time: string) {
    const step = stepAt(this.time.values, this.time.end, time);
    if (step !== this.shownStep) this.setTime(time);
  }

  private async loadNext(step: number) {
    const [values, mask] = await Promise.all([this.readStep.read(step, false), this.mask]);

    return () => {
      if (this.marks) this.cacheMarks(step, this.marksOf(values, mask));
      return this.paintImage(values);
    };
  }

  // The hatch follows the step that shows more, so it switches at the fade midpoint and not later.
  private followDominant(step: number) {
    if (!this.marks || step === this.marksStep) return;

    if (step < 0) {
      this.marks.setHatch(false);
      this.setHatched(false);
    } else {
      const state = this.marksByStep.get(step);
      if (!state) return;

      this.showMarks(state);
    }
    this.marksStep = step;
  }

  private cacheMarks(step: number, state: MarksState) {
    this.failedMarks.delete(step);
    this.marksByStep.set(step, state);
  }

  private hideStep() {
    this.fade.hide();
    this.marks?.setDots(false);
    this.marks?.setHatch(false);
    this.isolines?.setVisible(false);
    this.setHatched(false);
    this.marksStep = null;
  }

  private setHatched(hasHatched: boolean) {
    if (hasHatched === this.hasHatched) return;

    this.hasHatched = hasHatched;
    this.showLegend();
  }

  private async drawStep(step: number) {
    try {
      const [values, mask] = await Promise.all([this.readStep.read(step), this.mask]);
      if (!this.alive || step !== this.shownStep) return;

      this.drawValues(values, step, mask);

      this.readStep.prime(step, this.time.values.length - 1);
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
    if (this.marks) {
      const isCached = this.draw === "colour" || this.draw === "dots";
      const state = this.marksByStep.get(step) ?? this.marksOf(values, mask);
      this.showMarks(state);
      if (isCached) this.cacheMarks(step, state);
      if (this.draw === "colour") this.marksStep = step;
    }
    if (this.draw === "colour") {
      this.fade.show(step, () => this.paintImage(values));
    } else if (this.draw === "isolines") {
      this.isolines!.setValues(values, step);
      this.isolines!.setVisible(true);
    }
  }

  private paintImage(values: Float32Array) {
    const rgba = paintColormap(values, this.table, this.colors, this.stops);

    return new ImageData(rgba, this.table.width, this.table.height);
  }

  private marksOf(values: Float32Array, mask: ArrayLike<number> | null): MarksState {
    const positions = positionBytes(values, this.stops);
    const hasHatch = mask !== null && this.draw !== null && hasHatchedCells(positions, mask);

    return { positions, mask, hasHatch };
  }

  private showMarks(state: MarksState) {
    this.showFade(state, null, 0);
  }

  // Either end may be null, which stands for a step outside the axis and draws nothing.
  private showFade(from: MarksState | null, to: MarksState | null, mix: number) {
    const { positions, mask } = (from ?? to)!;
    this.solidMask ??= new Uint8Array(positions.length).fill(1);
    this.marks!.setMask(mask ?? this.solidMask);
    this.marks!.setFade(from?.positions ?? null, to?.positions ?? null, mix);
    this.marks!.setDots(this.draw === "dots");
    this.marks!.setHatch(Boolean(from?.hasHatch || to?.hasHatch));
    this.setHatched(Boolean((mix < 0.5 ? from : to)?.hasHatch));
  }

  legend() {
    return this.legendBox;
  }

  destroy() {
    this.alive = false;
    this.dotsZoomWatch.setActive(false);
    this.stopKeepingMarks?.();
    this.fade.invalidate();
    for (const id of this.fadeIds) removeLayerAndSource(this.context.map, id);
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
  const reader = createStepReader(
    layer.grid,
    async (step) => {
      const raw = await readArray(await store, valueArray.path, [step, null, null]);
      return decode(raw, valueArray);
    },
    async (first, count) => {
      const steps = await readSteps(await store, valueArray.path, first, count);
      return steps.map((raw) => decode(raw, valueArray));
    },
  );
  byLayer.set(layer.id, reader);
  return reader;
}

function keyOf(step: number) {
  return step < 0 ? null : step;
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
