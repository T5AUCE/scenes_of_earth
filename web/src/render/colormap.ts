import type { SampleTable } from "./mercator";

// ColorBrewer Blues, 9 classes.
const BLUES = [
  [247, 251, 255], [222, 235, 247], [198, 219, 239], [158, 202, 225], [107, 174, 214],
  [66, 146, 198], [33, 113, 181], [8, 81, 156], [8, 48, 107],
];

const COLORMAPS: Record<string, number[][]> = { Blues: BLUES };

// 256 opaque RGBA entries.
export function lut(name: string) {
  const stops = COLORMAPS[name];
  if (!stops) throw new Error(`Unknown colormap "${name}"`);

  const table = new Uint8ClampedArray(256 * 4);
  for (let i = 0; i < 256; i++) {
    const position = (i / 255) * (stops.length - 1);
    const low = Math.min(Math.floor(position), stops.length - 2);
    const fraction = position - low;
    for (let c = 0; c < 3; c++) {
      table[i * 4 + c] = stops[low][c] + (stops[low + 1][c] - stops[low][c]) * fraction;
    }
    table[i * 4 + 3] = 255;
  }
  return table;
}

export function paintColormap(
  values: Float32Array,
  table: SampleTable,
  colors: Uint8ClampedArray,
  [low, high]: [number, number],
) {
  const rgba = new Uint8ClampedArray(table.src.length * 4);
  const span = high - low;
  for (let p = 0; p < table.src.length; p++) {
    const cell = table.src[p];
    const value = cell < 0 ? NaN : values[cell];
    if (Number.isNaN(value)) continue;

    const t = span > 0 ? Math.min(1, Math.max(0, (value - low) / span)) : 0;
    const entry = Math.round(t * 255) * 4;
    rgba.set(colors.subarray(entry, entry + 4), p * 4);
  }
  return rgba;
}

// Values below neutral darken (black, more opaque the darker), values above lighten (white), and
// neutral is transparent so flat ground shows the basemap.
export function paintHillshade(shade: ArrayLike<number>, table: SampleTable, neutral = 180) {
  const rgba = new Uint8ClampedArray(table.src.length * 4);
  for (let p = 0; p < table.src.length; p++) {
    const cell = table.src[p];
    if (cell < 0) continue;

    const value = shade[cell];
    const lighter = value > neutral;
    const strength = lighter ? (value - neutral) / (255 - neutral) : (neutral - value) / neutral;
    rgba[p * 4] = rgba[p * 4 + 1] = rgba[p * 4 + 2] = lighter ? 255 : 0;
    rgba[p * 4 + 3] = Math.round(strength * 255);
  }
  return rgba;
}
