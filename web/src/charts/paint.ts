/** Keep chart marks readable on the white chart surface without moving map colour. */
import { rgbToHex } from "../render/palettes";

/** The white surface every chart mark is drawn against. */
export const CHART_SURFACE_HEX = "#ffffff";

/** Marks below this contrast against the surface get a dark edge so they stay visible. */
export const MIN_PAINT_CONTRAST = 3;

/** The navy ink new series fall back to when no palette stop stays readable. */
export const FALLBACK_CHART_INK = "#1a3658";

/** The dark edge that keeps an explicit light ink visible without rewriting it. */
export const CONTRAST_EDGE_INK = "#1a3658";

const HEX_PATTERN = /^#[0-9a-fA-F]{6}$/;
const CHANNEL_STARTS = [1, 3, 5];

const SRGB_THRESHOLD = 0.03928;
const SRGB_LOW_DIVISOR = 12.92;
const SRGB_OFFSET = 0.055;
const SRGB_DIVISOR = 1.055;
const SRGB_EXPONENT = 2.4;

const LUMINANCE_RED = 0.2126;
const LUMINANCE_GREEN = 0.7152;
const LUMINANCE_BLUE = 0.0722;

const CONTRAST_OFFSET = 0.05;

/** The resolved paint of one mark with its optional dark edge. */
export interface ChartPaint {
  ink: string;
  edge: string | null;
}

/**
 * Pick the gradient stop nearest the middle that keeps 3:1 contrast on white.
 * Equidistant ties prefer the earlier stop so choices stay deterministic.
 */
export function paletteInkFor(
  stops: readonly (readonly number[])[] | null | undefined,
  fallback: string = FALLBACK_CHART_INK,
): string {
  if (!stops || stops.length === 0) return fallback;
  const middle = (stops.length - 1) / 2;
  const order = stops.map((_, index) => index).sort((
    first,
    second,
  ) =>
    Math.abs(first - middle) - Math.abs(second - middle) || first - second
  );
  for (const index of order) {
    const candidate = rgbToHex([...stops[index]]);
    if (contrastRatio(candidate, CHART_SURFACE_HEX) >= MIN_PAINT_CONTRAST) return candidate;
  }

  return fallback;
}

/**
 * Keep the resolved ink while adding a dark edge only when it would vanish on
 * white. Unknown CSS values keep no edge so ordinary dark marks stay unchanged.
 */
export function chartPaintFor(ink: string): ChartPaint {
  if (!HEX_PATTERN.test(ink)) return { ink, edge: null };
  if (contrastRatio(ink, CHART_SURFACE_HEX) >= MIN_PAINT_CONTRAST) return { ink, edge: null };

  return { ink, edge: CONTRAST_EDGE_INK };
}

/** The WCAG-style contrast of two hex colours, from 1 to 21. */
export function contrastRatio(first: string, second: string): number {
  const firstLuminance = relativeLuminance(hexToRgb(first));
  const secondLuminance = relativeLuminance(hexToRgb(second));
  const high = Math.max(firstLuminance, secondLuminance);
  const low = Math.min(firstLuminance, secondLuminance);

  return (high + CONTRAST_OFFSET) / (low + CONTRAST_OFFSET);
}

function hexToRgb(hex: string): [number, number, number] {
  const channels = CHANNEL_STARTS.map((start) => parseInt(hex.slice(start, start + 2), 16));

  return [channels[0], channels[1], channels[2]];
}

function relativeLuminance(rgb: readonly number[]): number {
  const linear = rgb.map((channel) => {
    const fraction = channel / 255;
    if (fraction <= SRGB_THRESHOLD) return fraction / SRGB_LOW_DIVISOR;

    return ((fraction + SRGB_OFFSET) / SRGB_DIVISOR) ** SRGB_EXPONENT;
  });

  return LUMINANCE_RED * linear[0] + LUMINANCE_GREEN * linear[1] + LUMINANCE_BLUE * linear[2];
}
