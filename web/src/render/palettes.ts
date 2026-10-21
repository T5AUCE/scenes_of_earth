/** Define built-in palettes and encode custom gradients for menus and shared links. */
import type { ClassDoc } from "../types";
// @ts-expect-error Node needs the explicit extension, while the bundler resolves either form.
import { inSrgbGamut, oklchToRgb, rgbToOklch } from "./colormap.ts";

/** A palette the menu can offer, by the name that is stored and written to links. */
export interface PaletteOption {
  name: string;
  label: string;
}

const HEX_DIGITS = 2;
const HEX_CHANNEL_STARTS = [1, 3, 5];
/** The fewest colour stops a custom gradient may have. */
export const MIN_CUSTOM_COLORS = 2;
/** The most colour stops a custom gradient may have. */
export const MAX_CUSTOM_COLORS = 5;
const INK_PATTERN = /^#[0-9a-f]{6}$/;
const LINK_INK_PATTERN = /^[0-9a-f]{6}$/;
// Inks lighter than this take a dark halo, because a light halo would vanish around them.
const LIGHT_INK_LIGHTNESS = 0.6;
const HALO_LIGHT_RGB = [246, 239, 227];
const HALO_DARK_RGB = [31, 31, 31];
const CUSTOM_PREFIX = "custom";
const CUSTOM_PATTERN = new RegExp(
  `^${CUSTOM_PREFIX}(-[0-9a-f]{6}){${MIN_CUSTOM_COLORS},${MAX_CUSTOM_COLORS}}$`,
);

const RGB_MAX = 255;
const MAX_CHROMA = 0.4;
const CHROMA_SEARCH_STEPS = 16;
const CHROMA_CURVE = 0.8;
const GRID_ROWS = 5;
const FIELD_STOP_COUNT = 9;

// Blues' chroma dips at the wet end, so this ramp keeps rising with depth instead.
const INK_BLUE = oklchRamp(
  { lightness: 0.96, chroma: 0.02, hueDeg: 245 },
  { lightness: 0.36, chroma: 0.13, hueDeg: 262 },
  FIELD_STOP_COUNT,
);

/** sRGB triples evenly spaced between two OKLCH points. */
function oklchRamp(from: OklchPoint, to: OklchPoint, count: number) {
  return Array.from({ length: count }, (_, index) => {
    const position = index / (count - 1);
    return oklchRgb(
      from.lightness + (to.lightness - from.lightness) * position,
      from.chroma + (to.chroma - from.chroma) * position,
      from.hueDeg + (to.hueDeg - from.hueDeg) * position,
    );
  });
}

interface OklchPoint {
  lightness: number;
  chroma: number;
  hueDeg: number;
}

// Frozen so a darker blend wet row cannot darken temperature alone.
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

/** Crameri batlow sampled at nine even positions (MIT, cmcrameri 1.10). */
const BATLOW = [
  [1, 25, 89],
  [17, 67, 96],
  [34, 96, 97],
  [77, 115, 77],
  [130, 130, 49],
  [190, 144, 53],
  [241, 157, 107],
  [253, 180, 180],
  [250, 204, 250],
];

/**
 * The rain by temperature colour grid of the blended layer, as RGB triples. Rows run from dry to
 * wet, while columns run from cool to warm along the blue-green-terracotta path.
 */
export const RAIN_TEMPERATURE_GRID = oklchGrid({
  dry: { lightness: 0.9, chroma: 0.045 },
  wet: { lightness: 0.5, chroma: 0.12, gamutShare: 0.92 },
  hues: [255, 210, 165, 105, 45],
  warmLift: 0.03,
});

/** Options for a grid whose lightness falls and chroma rises from dry to wet. */
export interface OklchGridOptions {
  dry: { lightness: number; chroma: number };
  wet: {
    lightness: number;
    chroma: number;
    /** Share of the hue's sRGB gamut the wet end may use, from 0 to 1. */
    gamutShare?: number;
  };
  /** Hue in degrees of each column, from cool to warm. */
  hues: number[];
  /** Lightness added to the warmest column, increasing linearly from zero at the coolest. */
  warmLift: number;
}

/**
 * A grid of sRGB triples whose lightness falls linearly and chroma follows a 0.8 power from dry
 * to wet, with one hue path per column and every colour clamped into the sRGB gamut.
 */
export function oklchGrid({ dry, wet, hues, warmLift }: OklchGridOptions) {
  const gamutShare = wet.gamutShare ?? 1;
  const liftStep = warmLift / Math.max(1, hues.length - 1);
  const lifts = hues.map((_, column) => liftStep * column);
  const wetChromas = hues.map((hue, column) =>
    Math.min(wet.chroma, gamutShare * gamutChroma(wet.lightness + lifts[column], hue)),
  );
  return Array.from({ length: GRID_ROWS }, (_, row) => {
    const wetness = row / (GRID_ROWS - 1);
    const lightness = dry.lightness + (wet.lightness - dry.lightness) * wetness;
    const chromaPosition = wetness ** CHROMA_CURVE;
    return hues.map((hue, column) =>
      oklchRgb(
        lightness + lifts[column],
        dry.chroma + (wetChromas[column] - dry.chroma) * chromaPosition,
        hue,
      ),
    );
  });
}

/** Cividis sampled at nine even positions (Nuñez et al. 2018, CC0, matplotlib 3.11). */
const CIVIDIS = [
  [0, 34, 78],
  [26, 56, 111],
  [67, 78, 108],
  [97, 101, 111],
  [125, 124, 120],
  [154, 147, 118],
  [187, 173, 109],
  [221, 200, 88],
  [254, 232, 56],
];

// Reversing the nine-class ColorBrewer RdBu palette makes low values blue.
const BLUE_RED = [
  [33, 102, 172],
  [67, 147, 195],
  [146, 197, 222],
  [209, 229, 240],
  [247, 247, 247],
  [253, 219, 199],
  [244, 165, 130],
  [214, 96, 77],
  [178, 24, 43],
];

const FIELD_GRADIENTS = new Map([
  ["ink-blue", INK_BLUE],
  ["climate", CLIMATE],
  ["batlow", BATLOW],
  ["cividis", CIVIDIS],
  ["blue-red", BLUE_RED],
]);

/** The gradients offered to every field layer, in menu order. */
export const FIELD_PALETTES: PaletteOption[] = [
  { name: "ink-blue", label: "Ink blue" },
  { name: "climate", label: "Climate" },
  { name: "batlow", label: "Batlow" },
  { name: "cividis", label: "Cividis" },
  { name: "blue-red", label: "Blue-red" },
];

/**
 * Softened colours of land cover classes, by palette name. Classes or palettes that are missing
 * here use the layer's own colours.
 */
export const CLASS_PALETTES: Record<string, Record<number, string>> = {
  painted: {
    10: "#456d3b",
    20: "#cd9242",
    30: "#dfd77e",
    40: "#d099d0",
    50: "#c55d4c",
    60: "#c3baaf",
    70: "#eaf2f4",
    80: "#447ab0",
    90: "#49a0a1",
    95: "#75c399",
    100: "#f6e7c2",
  },
};

/** The class palettes offered to a categorical layer; esa is the colours in the bundle. */
export const CLASS_PALETTE_OPTIONS: PaletteOption[] = [
  { name: "painted", label: "Softened" },
  { name: "esa", label: "ESA official" },
];

/** The colour of the contour lines and their labels, by palette name. */
export const CONTOUR_COLORS = [
  { name: "brown", label: "Brown", color: "#5b4636" },
  { name: "grey", label: "Grey", color: "#6e6e6e" },
  { name: "black", label: "Black", color: "#1f1f1f" },
];

/** The contour colour a scene has before the viewer chooses one. */
export const DEFAULT_CONTOUR_COLOR = CONTOUR_COLORS[0].name;

/** The inks offered for dots and isotherms, in menu order. */
export const INK_COLORS = [
  { name: "navy", label: "Navy", color: "#1a3658" },
  { name: "charcoal", label: "Charcoal", color: "#313f4d" },
  { name: "black", label: "Black", color: "#1f1f1f" },
  { name: "brown", label: "Brown", color: "#5b4636" },
  { name: "deep-red", label: "Deep red", color: "#7a2430" },
  { name: "white", label: "White", color: "#ffffff" },
];

/** An ink with the halo that keeps it readable, as RGB triples. */
export interface InkPaint {
  ink: number[];
  halo: number[];
}

/** The ink dots take until the viewer chooses another. */
export const DEFAULT_DOT_INK = "navy";

/** The ink isotherms take until the viewer chooses another. */
export const DEFAULT_ISOTHERM_INK = "charcoal";

/** The #rrggbb colour of an ink preset name or custom #rrggbb ink, else undefined. */
export function inkColor(ink: string) {
  const preset = INK_COLORS.find(({ name }) => name === ink);
  return preset?.color ?? (INK_PATTERN.test(ink) ? ink : undefined);
}

/** The ink for a link value, a preset name or six hex digits, or undefined when it is neither. */
export function inkFromLink(value: string | undefined) {
  if (value === undefined) return undefined;
  if (LINK_INK_PATTERN.test(value)) return `#${value}`;

  return INK_COLORS.some(({ name }) => name === value) ? value : undefined;
}

/** The link value of an ink, which writes a custom colour as hex without the `#`. */
export function inkToLink(ink: string) {
  return ink.replace("#", "");
}

/** The ink's RGB with a light halo around a dark ink and a dark one around a light ink. */
export function inkPaint(ink: string): InkPaint {
  const rgb = hexToRgb(inkColor(ink)!);
  const isLight = rgbToOklch(rgb).lightness > LIGHT_INK_LIGHTNESS;
  return { ink: rgb, halo: isLight ? HALO_DARK_RGB : HALO_LIGHT_RGB };
}

/** The RGB stops of a built-in or custom field gradient, or undefined for an unknown name. */
export function fieldGradient(name: string) {
  return FIELD_GRADIENTS.get(name) ?? customColors(name)?.map(hexToRgb);
}

/** The palette name of a custom gradient made from #rrggbb colours. */
export function customPalette(colors: string[]) {
  return CUSTOM_PREFIX + colors.map((color) => `-${color.slice(1)}`).join("");
}

/** The #rrggbb colours of a custom palette name, or null unless it has 2-5 lowercase hex values. */
export function customColors(name: string) {
  if (!CUSTOM_PATTERN.test(name)) return null;

  return name.split("-").slice(1).map((hex) => `#${hex}`);
}

/** The colour of a contour palette name, or undefined for an unknown name. */
export function contourColor(name: string) {
  return CONTOUR_COLORS.find((entry) => entry.name === name)?.color;
}

/** Hex colours of the named class palette, or undefined when the layer's own colours apply. */
export function classPalette(name?: string) {
  return name && Object.hasOwn(CLASS_PALETTES, name) ? CLASS_PALETTES[name] : undefined;
}

/** The RGB of each class value from the named palette, else from the class's own colour. */
export function classColors(classes: ClassDoc[], palette?: string) {
  const named = classPalette(palette);
  return new Map(
    classes.map(({ value, color }) => [value, hexToRgb(named?.[value] ?? color)]),
  );
}

/** A CSS colour for an RGB triple. */
export function rgbCss(color: number[]) {
  return `rgb(${color.join(", ")})`;
}

/** The #rrggbb form of an RGB triple. */
export function rgbToHex(color: number[]) {
  const digits = color.map((channel) => Math.round(channel).toString(16).padStart(HEX_DIGITS, "0"));
  return `#${digits.join("")}`;
}

function hexToRgb(hex: string) {
  return HEX_CHANNEL_STARTS.map((start) => parseInt(hex.slice(start, start + HEX_DIGITS), 16));
}

function oklchRgb(lightness: number, chroma: number, hue: number) {
  const cappedChroma = Math.min(chroma, gamutChroma(lightness, hue));
  return oklchToRgb(lightness, cappedChroma, hue).map((channel) => {
    const inside = Math.max(0, Math.min(RGB_MAX, channel));
    return Math.round(inside);
  });
}

/** The largest chroma at a lightness and hue that still maps into the sRGB gamut. */
function gamutChroma(lightness: number, hue: number) {
  let lowChroma = 0;
  let highChroma = MAX_CHROMA;
  for (let step = 0; step < CHROMA_SEARCH_STEPS; step++) {
    const middle = (lowChroma + highChroma) / 2;
    if (inSrgbGamut(lightness, middle, hue)) lowChroma = middle;
    else highChroma = middle;
  }
  return lowChroma;
}
