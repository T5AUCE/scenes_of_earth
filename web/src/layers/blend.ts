/** Combine cached rainfall and temperature steps into a bivariate colour layer. */
import { rangeDecimals } from "../display-state";
import { makeHtmlElement } from "../html";
import { bivariateLegend } from "../legend";
import { addImageLayer, maxTextureSize, removeLayerAndSource, setImage } from "../map";
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
import { fieldReader } from "./field";

const BLEND_OPACITY = 0.8;
const SMOOTH_NOTE = "Smoothed for display; values are per cell.";

/** The title of the blended layer, as its card and the colour picker name it. */
export const BLEND_TITLE = "Rainfall + temperature (blended)";
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
  read(step: number): Promise<Float32Array>;
}

class Blend implements BlendView {
  readonly parts;
  readonly options = [
    {
      label: "Smooth",
      note: SMOOTH_NOTE,
      initial: true,
      set: (on: boolean) => {
        this.context.map.setPaintProperty(this.id, "raster-resampling", on ? "linear" : "nearest");
      },
    },
  ];
  readonly time = null;

  private readonly context: BlendContext;
  private readonly id = `${BLEND}-series`;
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

  constructor([rain, temperature]: readonly [LayerDoc, LayerDoc], context: BlendContext) {
    this.context = context;
    const { map, store, shift, slots } = context;
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
        read: fieldReader(layer, store),
      };
    };
    this.halves = [halfOf(rain), halfOf(temperature)];

    addImageLayer(map, this.id, finer.grid.bbox, shift, slots.fill, {
      "raster-opacity": 0,
      "raster-resampling": "linear",
    });

    this.noteBox.className = "option-note";
    this.noteBox.hidden = true;
    this.parts = [
      {
        id: BLEND,
        label: BLEND_TITLE,
        layerIds: [this.id],
        note: this.noteBox,
      },
    ];
    this.showLegend();
  }

  setTime(time: string) {
    this.shownTime = time;
    this.refresh();
  }

  show(draw: Draw | null) {
    this.isShown = draw === "colour";
    this.refresh();
  }

  restyle() {
    this.showLegend();
    if (this.values) this.paint(this.values);
  }

  legend() {
    return this.legendBox;
  }

  destroy() {
    this.alive = false;
    removeLayerAndSource(this.context.map, this.id);
  }

  private refresh() {
    this.hide();
    if (this.isShown && this.shownTime !== null) this.drawLatest(this.shownTime);
  }

  private hide() {
    this.values = null;
    this.noteBox.hidden = true;
    this.context.map.setPaintProperty(this.id, "raster-opacity", 0);
  }

  private async drawTime(time: string) {
    if (!this.isCurrent(time)) return;

    const steps = this.halves.map(({ time: axis }) => stepAt(axis.values, axis.end, time));
    const label = formatTime(time, this.halves.map(({ time: axis }) => axis.step));
    const note = missingStepNote(
      this.halves.map(({ layer }, index) => ({ title: layer.title, step: steps[index] })),
      label,
    );
    if (note) {
      this.noteBox.textContent = note;
      this.noteBox.hidden = false;
      return;
    }

    try {
      const [rain, temperature] = this.halves;
      const values = await Promise.all([rain.read(steps[0]), temperature.read(steps[1])]);
      if (!this.isCurrent(time)) return;

      this.paint(values);
      this.showPeriodNote(steps);
    } catch (error) {
      // An error for a step the user has already left is no longer relevant.
      if (!this.isCurrent(time)) return;

      this.hide();
      this.context.report(error);
    }
  }

  private showPeriodNote(steps: number[]) {
    const periods = this.halves.map(({ layer, time: axis }, index) => ({
      title: layer.title,
      period: formatTime(axis.values[steps[index]], [axis.step]),
    }));
    const note = differingPeriodNote(periods);
    if (!note) return;

    this.noteBox.textContent = note;
    this.noteBox.hidden = false;
  }

  private isCurrent(time: string) {
    return this.alive && this.isShown && time === this.shownTime;
  }

  private paint(values: Float32Array[]) {
    const [rain, temperature] = this.halves.map((half, index): BivariateAxis => ({
      values: values[index],
      table: half.table,
      stops: this.nativeStops(half),
    }));
    const rgba = paintBivariate(rain, temperature, BLEND_COLORS);

    this.values = values;
    setImage(this.context.map, this.id, new ImageData(rgba, this.width, this.height));
    this.context.map.setPaintProperty(this.id, "raster-opacity", BLEND_OPACITY);
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
