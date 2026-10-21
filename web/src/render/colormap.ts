/** Map sampled field values and class ids to univariate or bivariate colours. */
import type { SampleTable } from "./mercator";

const LUT_ENTRIES = 256;
/** Entries per side of the blended layer's colour table. */
export const LUT2D_SIZE = 64;
const LEGEND_TICK_COUNT = 5;
const STOP_DIGITS = 6;
/** Index of the last colormap entry. */
export const LAST_ENTRY = LUT_ENTRIES - 1;

export const COLOR_CHANNELS = 3;
export const RGBA_CHANNELS = 4;

const OPAQUE = 255;

/** A lookup table of 256 opaque RGBA entries blended through the gradient's RGB stops. */
export function lut(stops: number[][]) {
  const table = new Uint8ClampedArray(LUT_ENTRIES * RGBA_CHANNELS);
  for (let entry = 0; entry < LUT_ENTRIES; entry++) {
    const position = (entry / LAST_ENTRY) * (stops.length - 1);
    const lowStop = Math.min(Math.floor(position), stops.length - 2);
    const fraction = position - lowStop;

    for (let channel = 0; channel < COLOR_CHANNELS; channel++) {
      const low = stops[lowStop][channel];
      const high = stops[lowStop + 1][channel];
      table[entry * RGBA_CHANNELS + channel] = low + (high - low) * fraction;
    }

    table[entry * RGBA_CHANNELS + COLOR_CHANNELS] = OPAQUE;
  }
  return table;
}

/** The fitted stops of a layer's scale, or an even spread over its custom range. */
export function stopsForRange(fitted: number[], range: [number, number] | null) {
  return range ? evenStops(...range, fitted.length) : fitted;
}

/** Colour nearest values by class; NaN and values without a colour stay transparent. */
export function paintClasses(
  values: Float32Array,
  table: SampleTable,
  colorsByValue: Map<number, number[]>,
) {
  const rgba = new Uint8ClampedArray(table.src.length * RGBA_CHANNELS);
  for (let pixel = 0; pixel < table.src.length; pixel++) {
    const color = colorsByValue.get(values[table.src[pixel]]);
    if (!color) continue;

    rgba.set(color, pixel * RGBA_CHANNELS);
    rgba[pixel * RGBA_CHANNELS + COLOR_CHANNELS] = OPAQUE;
  }
  return rgba;
}

/**
 * A square table of opaque RGBA entries, row-major with the first axis as rows. It interpolates
 * the colour grid bilinearly in OKLab, so the steps between its colours look even.
 */
export function lut2d(grid: number[][][]) {
  const table = new Uint8ClampedArray(LUT2D_SIZE * LUT2D_SIZE * RGBA_CHANNELS);
  const labs = grid.map((row) => row.map(rgbToOklab));
  const cellCount = grid.length - 1;

  for (let row = 0; row < LUT2D_SIZE; row++) {
    const rowCell = cellOf((row / (LUT2D_SIZE - 1)) * cellCount, cellCount);
    for (let column = 0; column < LUT2D_SIZE; column++) {
      const columnCell = cellOf((column / (LUT2D_SIZE - 1)) * cellCount, cellCount);
      const lab = Array.from({ length: COLOR_CHANNELS }, (_, axis) =>
        bilinear(labs, rowCell, columnCell, axis),
      );
      const start = (row * LUT2D_SIZE + column) * RGBA_CHANNELS;
      table.set(oklabToRgb(lab), start);
      table[start + COLOR_CHANNELS] = OPAQUE;
    }
  }
  return table;
}

function cellOf(position: number, cellCount: number) {
  const low = Math.min(Math.floor(position), cellCount - 1);
  return { low, fraction: position - low };
}

function bilinear(
  labs: number[][][],
  row: { low: number; fraction: number },
  column: { low: number; fraction: number },
  axis: number,
) {
  const along = (rowIndex: number) => {
    const first = labs[rowIndex][column.low][axis];
    const second = labs[rowIndex][column.low + 1][axis];
    return first + (second - first) * column.fraction;
  };
  const low = along(row.low);
  return low + (along(row.low + 1) - low) * row.fraction;
}

/** Convert sRGB channels from 0 to 255 using Björn Ottosson's OKLab transform. */
function rgbToOklab([red, green, blue]: number[]) {
  const [r, g, b] = [red, green, blue].map((channel) => srgbToLinear(channel / OPAQUE));
  const long = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const medium = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const short = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);

  return [
    0.2104542553 * long + 0.793617785 * medium - 0.0040720468 * short,
    1.9779984951 * long - 2.428592205 * medium + 0.4505937099 * short,
    0.0259040371 * long + 0.7827717662 * medium - 0.808675766 * short,
  ];
}

function oklabToRgb([lightness, a, b]: number[]) {
  const long = (lightness + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const medium = (lightness - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const short = (lightness - 0.0894841775 * a - 1.291485548 * b) ** 3;

  return [
    4.0767416621 * long - 3.3077115913 * medium + 0.2309699292 * short,
    -1.2684380046 * long + 2.6097574011 * medium - 0.3413193965 * short,
    -0.0041960863 * long - 0.7034186147 * medium + 1.707614701 * short,
  ].map((channel) => linearToSrgb(channel) * OPAQUE);
}

function srgbToLinear(channel: number) {
  return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
}

function linearToSrgb(channel: number) {
  const clamped = Math.max(0, channel);
  return clamped <= 0.0031308 ? 12.92 * clamped : 1.055 * clamped ** (1 / 2.4) - 0.055;
}

/** A scaled input grid with sample locations for the blended layer. */
export interface BivariateAxis {
  values: Float32Array;
  /** The cells of `values` under each output pixel, with -1 where the layer has none. */
  table: SampleTable;
  stops: number[];
}

/**
 * Colour each pixel by both inputs through a lut2d table. An input whose nearest cell is empty
 * takes the nearest finite cell its footprint overlaps.
 * Pixels still missing either input stay clear.
 */
export function paintBivariate(
  rows: BivariateAxis,
  columns: BivariateAxis,
  colors: Uint8ClampedArray,
) {
  const rgba = new Uint8ClampedArray(rows.table.src.length * RGBA_CHANNELS);
  for (let pixel = 0; pixel < rows.table.src.length; pixel++) {
    const rowValue = valueAt(rows, pixel);
    const columnValue = valueAt(columns, pixel);
    if (Number.isNaN(rowValue) || Number.isNaN(columnValue)) continue;

    const row = Math.round(stopPosition(rowValue, rows.stops) * (LUT2D_SIZE - 1));
    const column = Math.round(stopPosition(columnValue, columns.stops) * (LUT2D_SIZE - 1));
    const colorStart = (row * LUT2D_SIZE + column) * RGBA_CHANNELS;
    rgba.set(colors.subarray(colorStart, colorStart + RGBA_CHANNELS), pixel * RGBA_CHANNELS);
  }
  return rgba;
}

function valueAt({ values, table }: BivariateAxis, pixel: number) {
  const cell = table.src[pixel];
  const nearest = cell < 0 ? NaN : values[cell];
  return Number.isNaN(nearest) ? overlappingValue(values, table, pixel) : nearest;
}

/** Paint one-based class IDs with colorsById[id - 1] and leave zero transparent. */
export function paintClassIds(ids: Uint8Array, colorsById: number[][]) {
  const rgba = new Uint8ClampedArray(ids.length * RGBA_CHANNELS);
  const palette = Uint8ClampedArray.of(
    0,
    0,
    0,
    0,
    ...colorsById.flatMap((color) => [...color, OPAQUE]),
  );
  for (let pixel = 0; pixel < ids.length; pixel++) {
    const entry = ids[pixel] * RGBA_CHANNELS;
    const start = pixel * RGBA_CHANNELS;
    rgba[start] = palette[entry];
    rgba[start + 1] = palette[entry + 1];
    rgba[start + 2] = palette[entry + 2];
    rgba[start + 3] = palette[entry + 3];
  }
  return rgba;
}

/** Where a value falls on the palette from 0 to 1, with the stops evenly spaced along it. */
export function stopPosition(value: number, stops: number[]) {
  const last = stops.length - 1;
  if (value <= stops[0]) return 0;
  if (value >= stops[last]) return 1;

  let upper = 1;
  while (stops[upper] < value) upper++;

  const lower = upper - 1;
  return (lower + (value - stops[lower]) / (stops[upper] - stops[lower])) / last;
}

/** `count` evenly spaced values from low to high, rounded so legend labels stay short. */
export function evenStops(low: number, high: number, count: number) {
  return Array.from({ length: count }, (_, index) =>
    Number((low + ((high - low) * index) / (count - 1)).toPrecision(STOP_DIGITS)),
  );
}

/** Up to LEGEND_TICK_COUNT stops to label, each with its position on the palette from 0 to 1. */
export function legendTicks(stops: number[]) {
  const last = stops.length - 1;
  const indexes = new Set(
    Array.from({ length: LEGEND_TICK_COUNT }, (_, tick) =>
      Math.round((tick / (LEGEND_TICK_COUNT - 1)) * last),
    ),
  );

  return [...indexes].map((index) => ({ position: index / last, value: stops[index] }));
}

/** Colour nearest values, using finite footprint overlaps only when opted in and nearest is NaN. */
export function paintColormap(
  values: Float32Array,
  table: SampleTable,
  colors: Uint8ClampedArray,
  stops: number[],
) {
  const rgba = new Uint8ClampedArray(table.src.length * RGBA_CHANNELS);
  for (let pixel = 0; pixel < table.src.length; pixel++) {
    const cell = table.src[pixel];
    const nearest = values[cell];
    const value = Number.isNaN(nearest) ? overlappingValue(values, table, pixel) : nearest;
    if (Number.isNaN(value)) continue;

    const position = stopPosition(value, stops);
    const colorStart = Math.round(position * LAST_ENTRY) * RGBA_CHANNELS;
    rgba.set(colors.subarray(colorStart, colorStart + RGBA_CHANNELS), pixel * RGBA_CHANNELS);
  }
  return rgba;
}

function overlappingValue(values: Float32Array, table: SampleTable, pixel: number) {
  if (!table.footprint) return NaN;

  const { sourceWidth, rowEdges, rowCenters, columnEdges, columnCenters } = table.footprint;
  const pixelRow = Math.floor(pixel / table.width);
  const pixelColumn = pixel % table.width;
  const columnStart = columnEdges[pixelColumn];
  const columnEnd = columnEdges[pixelColumn + 1];
  const centerColumn = columnCenters[pixelColumn];
  const centerRow = rowCenters[pixelRow];
  let nearestDistance = Infinity;
  let nearestValue = NaN;
  for (let row = Math.floor(rowEdges[pixelRow]); row < Math.ceil(rowEdges[pixelRow + 1]); row++) {
    for (let column = Math.floor(columnStart); column < Math.ceil(columnEnd); column++) {
      const value = values[row * sourceWidth + column];
      if (!Number.isFinite(value)) continue;

      const rowDistance = row + 0.5 - centerRow;
      const columnDistance = column + 0.5 - centerColumn;
      const distance = rowDistance ** 2 + columnDistance ** 2;
      if (distance < nearestDistance) {
        nearestDistance = distance;
        nearestValue = value;
      }
    }
  }
  return nearestValue;
}
