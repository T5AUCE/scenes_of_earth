/** Draw field time series as colour fills or fallback marks with shared cached values. */
import {
  arrayDoc,
  decodeInSlices,
  isCancel,
  readArray,
  readMask,
  readSteps,
  type Store,
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
  createDotLegend,
  createZoomWatch,
  dotLegendKey,
  gradientLegend,
  hatchLegend,
  isothermLegend,
  type DotLegendHandle,
} from "../legend";
import {
  addImagePair,
  maxTextureSize,
  removeLayerAndSource,
  setImage,
  setPairOpacities,
  warmHiddenRaster,
} from "../map";
import { prefersReducedMotion } from "../reduced-motion";
import { createStepReader, type StepReader } from "../step-reader";
import { displayStops, displayUnitFor, isUnitFor, unitOptions } from "../units";
import { lut, paintColormapInSlices, stopsForRange } from "../render/colormap";
import {
  DEFAULT_DENSITY_RATIO,
  hasHatchedCells,
  positionBytes,
  quantiseDensity,
} from "../render/lattice";
import { sampleTable } from "../render/mercator";
import {
  FIELD_PALETTES,
  fieldStops,
  INK_COLORS,
  inkPaint,
  rgbCss,
  type GradientStop,
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
import { ImageCrossfade } from "./crossfade";
import { MarksFade, type MarksState } from "./field-marks-fade";
import { createIsolineOverlay, type IsolineOverlay } from "./isolines";
import { FALLBACK_PALETTE_NOTE } from "./layer-menu";

const SERIES_OPACITY = 0.8;
const SMOOTH_NOTE = "for display; values are per cell";

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
  private lastLegendKey: string | null = null;
  private dotSwatches: DotLegendHandle | null = null;
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
  private activePaint: AbortController | null = null;
  private marksStep: number | null = null;
  private readonly marksFade = new MarksFade({
    read: (step) => Promise.all([this.readStep.read(step, false), this.mask]),
    toMarks: (values, mask) => (
      this.alive && this.draw === "dots" ? this.marksOf(values, mask) : null
    ),
    isUploaded: (positions) => this.marks!.isReady(positions),
  });
  private readonly isolineInflight = new Set<number>();
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
      (step) => this.marksFade.delete(step),
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

    this.dotsZoomWatch = createZoomWatch(map, () => this.repaintDotSwatches());
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
    const key = this.legendKey();
    if (key !== this.lastLegendKey) {
      this.lastLegendKey = key;
      const element = this.legendOf();
      if (this.hasHatched) element.append(hatchLegend());
      this.legendBox.replaceChildren(element);
    }
    this.repaintDotSwatches();
  }

  // The key holds the style and label inputs, so a skipped rebuild keeps the retained canvases.
  // The zoom and densities only repaint those canvases and stay out of the key.
  private legendKey(): string {
    const { layer } = this.context;
    if (this.draw === "dots") {
      const stops = displayStops(this.stops, layer.units, this.units, rangeDecimals(layer));
      return `dots:${dotLegendKey(
        stops,
        this.units,
        layer.grid,
        inkPaint(this.ink),
        this.hasHatched,
      )}`;
    }
    if (this.draw === "isolines") {
      return `isolines:${this.isolines!.interval}:${this.units}:${this.ink}`;
    }
    const rangeNote = this.range !== null ? "fitted" : "custom";
    return `colour:${this.palette}:${this.stops}:${this.units}:${rangeNote}:${this.hasHatched}`;
  }

  private legendOf() {
    const { layer, map } = this.context;
    const stops = displayStops(this.stops, layer.units, this.units, rangeDecimals(layer));
    if (this.draw === "dots") {
      const handle = createDotLegend(
        stops,
        this.units,
        layer.grid,
        map.getZoom(),
        this.renderedDensity(),
        inkPaint(this.ink),
        map.getPixelRatio(),
      );
      this.dotSwatches = handle;
      return handle.element;
    }
    this.dotSwatches = null;
    if (this.draw === "isolines") {
      return isothermLegend(this.isolines!.interval, inkPaint(this.ink), this.units);
    }

    return gradientLegend(this.colors, stops, this.units, this.range !== null);
  }

  /** The density the dots draw now, which eases toward the saved target after a slider change. */
  private renderedDensity(): number {
    return this.marks ? this.marks.renderedDensity() : this.density;
  }

  // Repaint the retained swatches from the live camera and density without another map frame.
  private repaintDotSwatches() {
    if (this.draw !== "dots" || !this.dotSwatches || !this.marks) return;

    const { map } = this.context;
    this.dotSwatches.repaint(map.getZoom(), this.marks.renderedDensity(), map.getPixelRatio());
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
        colors: gradientOf(name).map(stopCss),
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
    this.activePaint?.abort();
    this.activePaint = null;
    this.fade.invalidate();
    this.marksFade.clear();
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
    } else if (this.draw === "dots" && this.marksFade.has(this.shownStep)) {
      this.showMarks(this.marksFade.get(this.shownStep)!);
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
    const isolines = this.isolines!;
    const isSettled = nextStep < 0 || isolines.holds(nextStep) || isolines.hasFailed(nextStep);
    if (isSettled || this.isolineInflight.has(nextStep)) return;

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

    this.marksFade.keepOnly(step, nextStep);
    this.marksFade.arm(nextStep);
    const from = this.marksFade.get(step) ?? null;
    const to = this.marksFade.get(nextStep) ?? null;
    const isMissing = (step >= 0 && !from) || (nextStep >= 0 && !to);
    if (isMissing) return;

    this.showFade(from, to, mix);
  }

  // A layer that draws nothing yet still follows the label's step.
  private cutTo(time: string) {
    const step = stepAt(this.time.values, this.time.end, time);
    if (step !== this.shownStep) this.setTime(time);
  }

  private async loadNext(step: number) {
    const [values, mask] = await Promise.all([this.readStep.read(step, false), this.mask]);
    const image = await this.paintStepImage(values, undefined);

    return () => {
      if (this.marks) this.marksFade.cache(step, this.marksOf(values, mask));
      return image;
    };
  }

  // The hatch follows the step that shows more, so it switches at the fade midpoint and not later.
  private followDominant(step: number) {
    if (!this.marks || step === this.marksStep) return;

    if (step < 0) {
      this.marks.setHatch(false);
      this.setHatched(false);
    } else {
      const state = this.marksFade.get(step);
      if (!state) return;

      this.showMarks(state);
    }
    this.marksStep = step;
  }

  isFrameReady(time: string, next: string) {
    const step = stepAt(this.time.values, this.time.end, time);
    const nextStep = stepAt(this.time.values, this.time.end, next);
    if (this.draw === "isolines") return this.isolines!.isReady(step, nextStep);
    if (this.draw === "dots") return this.marksFade.isReady(nextStep);
    if (this.draw !== "colour") return true;

    return this.fade.isReady(keyOf(step), keyOf(nextStep));
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

  /**
   * Warm the opening time on the map context so the flight never pays for it.
   * Playback keeps using prepare, so this never changes its contract.
   */
  async prepareEntry(time: string | null, signal?: AbortSignal): Promise<void> {
    if (time === null || signal?.aborted) return;
    const step = stepAt(this.time.values, this.time.end, time);
    if (step < 0 || !this.alive || !this.draw || signal?.aborted) return;

    const draw = this.draw;
    const colors = this.colors;
    const stops = this.stops;
    const values = await this.readStep.read(step, false);
    if (!this.alive || signal?.aborted || this.draw !== draw) return;
    if (this.colors !== colors || this.stops !== stops || step !== this.shownStep) return;

    if (draw === "colour") {
      await this.warmColour(values, step, signal, draw, colors, stops);
    } else if (draw === "dots") {
      await this.warmDots(values, step, signal, draw);
    } else if (draw === "isolines") {
      await this.warmIsolines(values, step, signal, draw);
    }
    if (!this.alive || signal?.aborted) return;

    await nextEntryFrame(signal);
  }

  private async warmColour(
    values: Float32Array,
    step: number,
    signal: AbortSignal | undefined,
    draw: Draw | null,
    colors: Uint8ClampedArray,
    stops: number[],
  ) {
    // A held CPU image still needs its native upload, so warm the real sources instead of skipping.
    if (this.fade.holds(step)) {
      for (const id of this.fadeIds) await warmHiddenRaster(this.context.map, id, signal);
      return;
    }

    this.activePaint?.abort();
    this.activePaint = null;
    const image = await this.paintStepImage(values, signal);
    if (!this.alive || signal?.aborted || this.draw !== draw) return;
    if (this.colors !== colors || this.stops !== stops || step !== this.shownStep) return;

    this.fade.show(step, () => image);
    // The hidden sources prepare under the zoom gate, so the first visible render skips them.
    for (const id of this.fadeIds) await warmHiddenRaster(this.context.map, id, signal);
    if (!this.alive || signal?.aborted || this.draw !== draw) return;
    if (this.colors !== colors || this.stops !== stops || step !== this.shownStep) return;

    if (this.marks) {
      const [, mask] = await Promise.all([Promise.resolve(), this.mask]);
      if (!this.alive || signal?.aborted || this.draw !== draw) return;

      const state = this.marksFade.get(step) ?? this.marksOf(values, mask);
      this.marksFade.cache(step, state);
      this.marksStep = step;
    }
  }

  private async warmDots(
    values: Float32Array,
    step: number,
    signal: AbortSignal | undefined,
    draw: Draw | null,
  ) {
    const [, mask] = await Promise.all([Promise.resolve(), this.mask]);
    if (!this.alive || signal?.aborted || this.draw !== draw) return;

    const state = this.marksFade.get(step) ?? this.marksOf(values, mask);
    if (!this.alive || signal?.aborted || this.draw !== draw) return;
    if (step !== this.shownStep) return;

    this.marksFade.cache(step, state);
    this.showMarks(state);
    this.marksStep = step;
    if (!this.marks) return;

    try {
      await this.marks.warmUp(signal);
    } catch (error) {
      if (signal?.aborted) return;

      throw error;
    }
  }

  private async warmIsolines(
    values: Float32Array,
    step: number,
    signal: AbortSignal | undefined,
    draw: Draw | null,
  ) {
    if (!this.isolines || !this.alive || signal?.aborted || this.draw !== draw) return;

    // Tracing stays synchronous because its helper lives outside the entry scope.
    this.isolines.prepareStep(step, values);
    if (!this.alive || signal?.aborted || this.draw !== draw) return;
    if (step !== this.shownStep) return;

    this.isolines.setValues(values, step);
    this.isolines.setVisible(true);
    await waitForIsolines(this.isolines, step, signal);
  }

  maxLookahead() {
    return this.readStep.maxLookahead();
  }

  release() {
    this.readStep.release();
  }

  setPlaying(isPlaying: boolean) {
    this.readStep.setPlaying(isPlaying);
    this.isolines?.setPlaying(isPlaying);
  }

  show(next: Draw | null) {
    this.draw = next;
    this.activePaint?.abort();
    this.activePaint = null;
    this.dotsZoomWatch.setActive(next === "dots");
    this.hideStep();
    this.showLegend();
    this.menuUpdates.dispatchEvent(new Event("change"));
    if (this.draw && this.shownStep >= 0) this.drawLatestStep(this.shownStep);
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

      await this.drawValues(values, step, mask);

      this.readStep.prime(step, this.time.values.length - 1);
    } catch (error) {
      if (isCancel(error)) return;
      // An error for a step the user has already left is no longer relevant.
      if (!this.alive || step !== this.shownStep) return;

      // What the map shows still belongs to an earlier step and must not pass for this one.
      this.hideStep();
      this.context.report(error);
    }
  }

  private async drawValues(
    values: Float32Array,
    step: number,
    mask: ArrayLike<number> | null,
  ) {
    if (this.marks) {
      const isCached = this.draw === "colour" || this.draw === "dots";
      const state = this.marksFade.get(step) ?? this.marksOf(values, mask);
      this.showMarks(state);
      if (isCached) this.marksFade.cache(step, state);
      if (this.draw === "colour") this.marksStep = step;
    }
    if (this.draw === "colour") {
      const draw = this.draw;
      const colors = this.colors;
      const stops = this.stops;
      this.activePaint?.abort();
      const controller = new AbortController();
      this.activePaint = controller;
      let image: ImageData;
      try {
        image = await this.paintStepImage(values, controller.signal);
      } finally {
        if (this.activePaint === controller) this.activePaint = null;
      }
      if (controller.signal.aborted) return;
      if (!this.alive || step !== this.shownStep || this.draw !== draw) return;
      if (this.colors !== colors || this.stops !== stops) return;

      this.fade.show(step, () => image);
    } else if (this.draw === "isolines") {
      this.isolines!.setValues(values, step);
      this.isolines!.setVisible(true);
    }
  }

  /** Paint one step through the shared sliced painter the entry warm-up uses. */
  private paintStepImage(values: Float32Array, signal?: AbortSignal): Promise<ImageData> {
    return paintColormapInSlices(values, this.table, this.colors, this.stops, signal).then(
      (rgba) => new ImageData(rgba, this.table.width, this.table.height),
    );
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
    this.activePaint?.abort();
    this.activePaint = null;
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
      return decodeInSlices(raw, valueArray);
    },
    async (first, count) => {
      const steps = await readSteps(await store, valueArray.path, first, count);
      const decoded: Float32Array[] = [];
      for (const raw of steps) {
        decoded.push(await decodeInSlices(raw, valueArray));
      }
      return decoded;
    },
  );
  byLayer.set(layer.id, reader);
  return reader;
}

/** Wait a frame so the preparing note paints before heavy work continues. */
function nextEntryFrame(signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.reject(cancelError());
  return new Promise((done, fail) => {
    const onFrame = () => {
      signal?.removeEventListener("abort", onAbort);
      done();
    };
    const onAbort = () => fail(cancelError());
    signal?.addEventListener("abort", onAbort, { once: true });
    if (typeof requestAnimationFrame === "function") {
      requestAnimationFrame(onFrame);
      return;
    }
    setTimeout(onFrame, 0);
  });
}

function cancelError(): Error {
  const error = new Error("Entry preparation was cancelled");
  error.name = "AbortError";
  return error;
}

/** Wait for the overlay to hold the warmed step, so the flight never traces mid-flight. */
function waitForIsolines(
  isolines: IsolineOverlay,
  step: number,
  signal?: AbortSignal,
): Promise<void> {
  if (signal?.aborted) return Promise.reject(cancelError());
  if (isolines.isReady(step, step)) return Promise.resolve();
  return new Promise((done, fail) => {
    let isSettled = false;
    let frame: number | ReturnType<typeof setTimeout> | undefined;
    // Stalled frames must not fail the entry, so the lines may paint a moment late instead.
    const timer = setTimeout(() => {
      if (isSettled) return;
      isSettled = true;
      cancelFrame(frame);
      signal?.removeEventListener("abort", onAbort);
      done();
    }, 2000);
    const check = () => {
      if (isSettled) return;
      if (signal?.aborted) {
        isSettled = true;
        cancelFrame(frame);
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
        fail(cancelError());
        return;
      }
      try {
        if (isolines.isReady(step, step)) {
          isSettled = true;
          cancelFrame(frame);
          clearTimeout(timer);
          signal?.removeEventListener("abort", onAbort);
          done();
          return;
        }
      } catch (error) {
        isSettled = true;
        cancelFrame(frame);
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
        fail(error);
        return;
      }
      frame = nextFrame(check);
    };
    const onAbort = () => {
      if (isSettled) return;
      isSettled = true;
      cancelFrame(frame);
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      fail(cancelError());
    };
    signal?.addEventListener("abort", onAbort, { once: true });
    check();
  });
}

function nextFrame(task: () => void): number | ReturnType<typeof setTimeout> {
  try {
    if (typeof requestAnimationFrame === "function") {
      return requestAnimationFrame(() => task());
    }
  } catch {
    // A missing frame scheduler falls through to the timer below.
  }
  return setTimeout(task, 16);
}

function cancelFrame(frame: number | ReturnType<typeof setTimeout> | undefined): void {
  if (frame === undefined) return;
  try {
    if (typeof cancelAnimationFrame === "function" && typeof frame === "number") {
      cancelAnimationFrame(frame);
      return;
    }
  } catch {
    // A missing canceller falls through to clearing the timer.
  }
  clearTimeout(frame as ReturnType<typeof setTimeout>);
}

function keyOf(step: number) {
  return step < 0 ? null : step;
}

function gradientOf(palette: string) {
  const stops = fieldStops(palette);
  if (!stops) throw new Error(`Unknown palette "${palette}"`);

  return stops;
}

/** A tile colour with its gradient position, so custom pins show where they sit. */
function stopCss(stop: GradientStop) {
  return `${rgbCss(stop.rgb)} ${stop.at * 100}%`;
}

function valueStats({ stats }: LayerContext["layer"]) {
  const { min, max } = (stats ?? {}) as Record<string, unknown>;
  return typeof min === "number" && typeof max === "number" ? { min, max } : null;
}
