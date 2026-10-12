import type { SampleTable } from "./mercator";

const LUT_ENTRIES = 256;
export const LAST_ENTRY = LUT_ENTRIES - 1;
export const COLOR_CHANNELS = 3;
export const RGBA_CHANNELS = 4;
const OPAQUE = 255;
const WHITE = 255;
const BLACK = 0;
const FLAT_GROUND_HILLSHADE = 180;

// ColorBrewer Blues, 9 classes.
const BLUES = [
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

const COLORMAPS: Record<string, number[][]> = { Blues: BLUES };

// Returns 256 opaque RGBA entries.
export function lut(name: string) {
  const stops = COLORMAPS[name];
  if (!stops) throw new Error(`Unknown colormap "${name}"`);

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

export function paintColormap(
  values: Float32Array,
  table: SampleTable,
  colors: Uint8ClampedArray,
  [low, high]: [number, number],
) {
  const rgba = new Uint8ClampedArray(table.src.length * RGBA_CHANNELS);
  const span = high - low;

  for (let pixel = 0; pixel < table.src.length; pixel++) {
    const cell = table.src[pixel];
    const value = values[cell];
    if (Number.isNaN(value)) continue;

    const position = span > 0 ? Math.min(1, Math.max(0, (value - low) / span)) : 0;
    const colorStart = Math.round(position * LAST_ENTRY) * RGBA_CHANNELS;
    rgba.set(colors.subarray(colorStart, colorStart + RGBA_CHANNELS), pixel * RGBA_CHANNELS);
  }

  return rgba;
}

// Neutral is transparent so flat ground shows the basemap; slopes darken or lighten from it.
export function paintHillshade(
  shade: ArrayLike<number>,
  table: SampleTable,
  neutral = FLAT_GROUND_HILLSHADE,
) {
  const rgba = new Uint8ClampedArray(table.src.length * RGBA_CHANNELS);

  for (let pixel = 0; pixel < table.src.length; pixel++) {
    const cell = table.src[pixel];
    const value = shade[cell];
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
