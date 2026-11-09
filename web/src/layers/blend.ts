/** Combine cached rainfall and temperature steps into a bivariate colour layer. */
import { rangeDecimals } from "../display-state";
import { makeHtmlElement } from "../html";
import { bivariateLegend } from "../legend";
import {
  addImagePair,
  maxTextureSize,
  removeLayerAndSource,
  setImage,
  setPairOpacities,
} from "../map";
import type { StepReader } from "../step-reader";
import { displayStops } from "../units";
import {
  type BivariateAxis,
  lut2d,
  paintBivariate,
  stopsForRange,
} from "../render/colormap";
import { crossSampleTable, type SampleTable, sampleTable } from "../render/mercator";
import { RAIN_TEMPERATURE_GRID } from "../render/palettes";
import { formatTime, latestOnly, stepAt } from "../timeline";
import type { LayerContext, LayerDoc, LayerView, TimeDoc } from "../types";
import { BLEND, type Draw, differingPeriodNote, missingStepNote } from "./allocate";
import { ImageCrossfade } from "./crossfade";
import { fieldReader } from "./field";

const BLEND_OPACITY = 0.8;
const SMOOTH_NOTE = "for display; values are per cell";

/** The title of the blended layer, as its card and the colour picker name it. */
export const BLEND_TITLE = "Rainfall + Temperature (Blended)";
const BLEND_COLORS = lut2d(RAIN_TEMPERATURE_GRID);

/** What the blend needs from the scene beyond its two layers. */
export interface BlendContext
  extends Pick<LayerContext, "map" | "store" | "shift" | "slots" | "report"> {
  /** The custom range set in a layer's menu, or null while its fitted range applies. */
  rangeOf(layerId: string): [number, number] | null;
  /** The display unit chosen in a layer's menu, or its native units. */
  unitsOf(layerId: string): string;
}

/** The blended layer, which repaints when a half's range changes. */
export interface BlendView extends LayerView {
  show(draw: Draw | null): void;
  restyle(): void;
}

/** Paint rain as saturation and ink and temperature as warmth from the two layers' own steps. */
export function createBlendView(
  pair: readonly [LayerDoc, LayerDoc],
  context: BlendContext,
): BlendView {
  return new Blend(pair, context);
}

/** A layer of the blend with the step axis and cells under each pixel of the shared image. */
interface Half {
  layer: LayerDoc;
  time: TimeDoc;
  fitted: number[];
  table: SampleTable;
  reader: StepReader;
}

class Blend implements BlendView {
  readonly parts;
  readonly options = [
    {
      label: "Smooth",
      note: SMOOTH_NOTE,
      initial: true,
      set: (on: boolean) => {
        for (const id of this.fadeIds) {
          this.context.map.setPaintProperty(id, "raster-resampling", on ? "linear" : "nearest");
        }
      },
    },
  ];
  readonly time = null;

  private readonly context: BlendContext;
  private readonly fadeIds = [`${BLEND}-series`, `${BLEND}-series-next`] as const;
  private readonly fade: ImageCrossfade<string>;
  private readonly halves: [Half, Half];
  private readonly width: number;
  private readonly height: number;
  private readonly legendBox = makeHtmlElement("div");
  private readonly noteBox = makeHtmlElement("div");
  private readonly drawLatest = latestOnly((time: string) => this.drawTime(time));
  private values: Float32Array[] | null = null;
  private isShown = false;
  private alive = true;
  // A slow read of an older step must not overwrite the one being displayed.
  private shownTime: string | null = null;
  private shownKey: string | null = null;
  private notedTime: string | null = null;

  constructor([rain, temperature]: readonly [LayerDoc, LayerDoc], context: BlendContext) {
    this.context = context;
    const { map, store, shift, slots } = context;
    this.fade = new ImageCrossfade(BLEND_OPACITY, {
      setImage: (slot, image) => setImage(map, this.fadeIds[slot], image),
      setOpacities: (opacities) => setPairOpacities(map, this.fadeIds, opacities),
    });
    const finer = rain.grid.res <= temperature.grid.res ? rain : temperature;
    const table = sampleTable(finer.grid, maxTextureSize(map), { preserveCoverage: true });
    this.width = table.width;
    this.height = table.height;

    const halfOf = (layer: LayerDoc): Half => {
      if (!layer.time || !layer.style.stops) {
        throw new Error(`Layer "${layer.id}" needs stops and a time axis for the blend`);
      }

      return {
        layer,
        time: layer.time,
        fitted: layer.style.stops,
        table: layer === finer ? table : crossSampleTable(table, finer.grid, layer.grid),
        reader: fieldReader(layer, store),
      };
    };
    this.halves = [halfOf(rain), halfOf(temperature)];

    addImagePair(map, this.fadeIds, finer.grid.bbox, shift, slots.fill, {
      "raster-resampling": "linear",
    });

    this.noteBox.className = "option-note";
    this.noteBox.hidden = true;
    this.parts = [
      {
        id: BLEND,
        label: BLEND_TITLE,
        layerIds: [...this.fadeIds],
        note: this.noteBox,
      },
    ];
    this.showLegend();
  }

  setTime(time: string) {
    this.shownTime = time;
    this.refresh();
  }

  setFrame(time: string, next: string, mix: number) {
    if (time !== this.shownTime) {
      this.setTime(time);
      return;
    }

    if (!this.isShown) return;

    const nextKey = this.keyAt(next);
    this.fade.frame(this.keyAt(time), nextKey, mix);
    const dominant = mix < 0.5 ? time : next;
    if (dominant !== this.notedTime) this.showNotes(dominant);
    if (nextKey !== null) this.fade.prepare(nextKey, () => this.loadNext(next));
  }

  isFrameReady(time: string, next: string) {
    return !this.isShown || this.fade.isReady(this.keyAt(time), this.keyAt(next));
  }

  async prepare(time: string): Promise<void> {
    const steps = this.stepsAt(time);
    if (steps[0] < 0 || steps[1] < 0) return;

    await this.readSteps(steps, false);
  }

  maxLookahead() {
    return Math.min(...this.halves.map(({ reader }) => reader.maxLookahead()));
  }

  release() {
    this.halves.forEach(({ reader }) => reader.release());
  }

  setPlaying(isPlaying: boolean) {
    this.halves.forEach(({ reader }) => reader.setPlaying(isPlaying));
  }

  show(draw: Draw | null) {
    this.isShown = draw === "colour";
    this.refresh();
  }

  restyle() {
    this.showLegend();
    this.fade.invalidate();
    if (this.values && this.shownKey !== null) this.paint(this.values, this.shownKey);
  }

  legend() {
    return this.legendBox;
  }

  destroy() {
    this.alive = false;
    this.fade.invalidate();
    for (const id of this.fadeIds) removeLayerAndSource(this.context.map, id);
  }

  private refresh() {
    if (!this.isShown || this.shownTime === null) {
      this.hide();
      return;
    }

    // A painted image shows at once, so a pause never waits on the decoded values.
    const key = this.keyAt(this.shownTime);
    if (key !== null && this.fade.select(key)) this.values = null;
    else this.hide();
    this.drawLatest(this.shownTime);
  }

  private hide() {
    this.hideImage();
    this.notedTime = null;
    this.noteBox.hidden = true;
  }

  private hideImage() {
    this.values = null;
    this.fade.hide();
  }

  private async drawTime(time: string) {
    if (!this.isCurrent(time)) return;

    if (this.showNotes(time)) {
      this.hideImage();
      return;
    }

    try {
      const steps = this.stepsAt(time);
      const values = await this.readSteps(steps);
      if (!this.isCurrent(time)) return;

      this.paint(values, this.keyAt(time)!);
      this.halves.forEach(({ reader, time: axis }, index) => {
        reader.prime(steps[index], axis.values.length - 1);
      });
    } catch (error) {
      // An error for a step the user has already left is no longer relevant.
      if (!this.isCurrent(time)) return;

      this.hide();
      this.context.report(error);
    }
  }

  /** Sets the note for a time and returns whether a half has no step there. */
  private showNotes(time: string) {
    const steps = this.stepsAt(time);
    const label = formatTime(time, this.halves.map(({ time: axis }) => axis.step));
    const missing = missingStepNote(
      this.halves.map(({ layer }, index) => ({ title: layer.title, step: steps[index] })),
      label,
    );
    const note = missing ?? differingPeriodNote(this.periodsAt(steps));
    this.notedTime = time;
    this.noteBox.textContent = note ?? "";
    this.noteBox.hidden = note === null;

    return missing !== null;
  }

  private periodsAt(steps: number[]) {
    return this.halves.map(({ layer, time: axis }, index) => ({
      title: layer.title,
      period: formatTime(axis.values[steps[index]], [axis.step]),
    }));
  }

  private isCurrent(time: string) {
    return this.alive && this.isShown && time === this.shownTime;
  }

  private paint(values: Float32Array[], key: string) {
    this.values = values;
    this.shownKey = key;
    this.fade.show(key, () => this.paintImage(values));
  }

  private paintImage(values: Float32Array[]) {
    const [rain, temperature] = this.halves.map((half, index): BivariateAxis => ({
      values: values[index],
      table: half.table,
      stops: this.nativeStops(half),
    }));
    const rgba = paintBivariate(rain, temperature, BLEND_COLORS);

    return new ImageData(rgba, this.width, this.height);
  }

  private async loadNext(time: string) {
    const values = await this.readSteps(this.stepsAt(time), false);

    return () => this.paintImage(values);
  }

  private readSteps(steps: number[], isUrgent = true) {
    return Promise.all(this.halves.map(({ reader }, index) => reader.read(steps[index], isUrgent)));
  }

  private stepsAt(time: string) {
    return this.halves.map(({ time: axis }) => stepAt(axis.values, axis.end, time));
  }

  // The blend fades only between times where both halves have a step.
  private keyAt(time: string) {
    const steps = this.stepsAt(time);

    return steps.some((step) => step < 0) ? null : steps.join(":");
  }

  private nativeStops({ layer, fitted }: Half) {
    return stopsForRange(fitted, this.context.rangeOf(layer.id));
  }

  private showLegend() {
    const [rain, temperature] = this.halves.map((half) => ({
      title: half.layer.title,
      units: this.context.unitsOf(half.layer.id),
      stops: displayStops(
        this.nativeStops(half),
        half.layer.units,
        this.context.unitsOf(half.layer.id),
        rangeDecimals(half.layer),
      ),
      isBottomOpen: this.context.rangeOf(half.layer.id) !== null,
    }));
    const isFitted = this.halves.every(({ layer }) => this.context.rangeOf(layer.id) === null);

    this.legendBox.replaceChildren(bivariateLegend(BLEND_COLORS, rain, temperature, isFitted));
  }
}
