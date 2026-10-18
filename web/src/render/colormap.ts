import type { SampleTable } from "./mercator";

const LUT_ENTRIES = 256;
const LEGEND_TICK_COUNT = 5;
/** Index of the last colormap entry. */
export const LAST_ENTRY = LUT_ENTRIES - 1;

export const COLOR_CHANNELS = 3;
export const RGBA_CHANNELS = 4;

const OPAQUE = 255;
const WHITE = 255;
const BLACK = 0;
const FLAT_GROUND_HILLSHADE = 180;

// ColorBrewer Blues, 9 classes.
const INK_BLUE = [
  [247, 251, 255],
  [222, 235, 247],
  [198, 219, 239],
  [158, 202, 225],
  [107, 174, 214],
  [66, 146, 198],
  [33, 113, 181],
  [8, 81, 156],
  [8, 48, 107],
];

// OKLCH hue path 255→165→45 at C 0.125, the bivariate's wet row.
const CLIMATE = [
  [0x44, 0x7d, 0xc4],
  [0x00, 0x89, 0xba],
  [0x07, 0x91, 0xa3],
  [0x02, 0x98, 0x8f],
  [0x18, 0x9d, 0x73],
  [0x67, 0x99, 0x48],
  [0x97, 0x8f, 0x20],
  [0xba, 0x81, 0x22],
  [0xcf, 0x76, 0x4c],
];

const PALETTES: Record<string, number[][]> = { "ink-blue": INK_BLUE, climate: CLIMATE };

/** A lookup table of 256 opaque RGBA entries for a named palette. */
export function lut(name: string) {
  const stops = PALETTES[name];
  if (!stops) throw new Error(`Unknown palette "${name}"`);

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

/** Where a value falls on the palette, 0-1: the stops are evenly spaced along it. */
export function stopPosition(value: number, stops: number[]) {
  const last = stops.length - 1;
  if (value <= stops[0]) return 0;
  if (value >= stops[last]) return 1;

  let upper = 1;
  while (stops[upper] < value) upper++;

  const lower = upper - 1;
  return (lower + (value - stops[lower]) / (stops[upper] - stops[lower])) / last;
}

/** Up to LEGEND_TICK_COUNT stops to label: each with its position on the palette, 0-1. */
export function legendTicks(stops: number[]) {
  const last = stops.length - 1;
  const indexes = new Set(
    Array.from({ length: LEGEND_TICK_COUNT }, (_, tick) =>
      Math.round((tick / (LEGEND_TICK_COUNT - 1)) * last),
    ),
  );

  return [...indexes].map((index) => ({ position: index / last, value: stops[index] }));
}

/** RGBA pixels coloured by value across the stops; NaN cells stay transparent. */
export function paintColormap(
  values: Float32Array,
  table: SampleTable,
  colors: Uint8ClampedArray,
  stops: number[],
) {
  const rgba = new Uint8ClampedArray(table.src.length * RGBA_CHANNELS);
  for (let pixel = 0; pixel < table.src.length; pixel++) {
    const cell = table.src[pixel];
    const value = values[cell];
    if (Number.isNaN(value)) continue;

    const position = stopPosition(value, stops);
    const colorStart = Math.round(position * LAST_ENTRY) * RGBA_CHANNELS;
    rgba.set(colors.subarray(colorStart, colorStart + RGBA_CHANNELS), pixel * RGBA_CHANNELS);
  }
  return rgba;
}

/**
 * Neutral is transparent so flat ground shows the basemap; slopes darken or lighten from it.
 * NaN cells (no data) stay transparent.
 */
export function paintHillshade(
  shade: ArrayLike<number>,
  table: SampleTable,
  neutral = FLAT_GROUND_HILLSHADE,
) {
  const rgba = new Uint8ClampedArray(table.src.length * RGBA_CHANNELS);
  for (let pixel = 0; pixel < table.src.length; pixel++) {
    const cell = table.src[pixel];
    const value = shade[cell];
    if (Number.isNaN(value)) continue;

    const isLighter = value > neutral;
    const strength = isLighter
      ? (value - neutral) / (OPAQUE - neutral)
      : (neutral - value) / neutral;
    const start = pixel * RGBA_CHANNELS;

    rgba[start] = rgba[start + 1] = rgba[start + 2] = isLighter ? WHITE : BLACK;
    rgba[start + COLOR_CHANNELS] = Math.round(strength * OPAQUE);
  }
  return rgba;
}
