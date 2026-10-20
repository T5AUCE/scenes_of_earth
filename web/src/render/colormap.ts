import type { SampleTable } from "./mercator";

const LUT_ENTRIES = 256;
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

  const { sourceWidth, rowEdges, rowCenters } = table.footprint;
  const pixelRow = Math.floor(pixel / table.width);
  const pixelColumn = pixel % table.width;
  const columnStart = (pixelColumn * sourceWidth) / table.width;
  const columnEnd = ((pixelColumn + 1) * sourceWidth) / table.width;
  const centerColumn = (columnStart + columnEnd) / 2;
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
