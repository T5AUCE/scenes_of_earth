/** Define built-in palettes and encode custom gradients for menus and shared links. */
import type { ClassDoc } from "../types";

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
const CUSTOM_PREFIX = "custom";
const CUSTOM_PATTERN = new RegExp(
  `^${CUSTOM_PREFIX}(-[0-9a-f]{6}){${MIN_CUSTOM_COLORS},${MAX_CUSTOM_COLORS}}$`,
);

/** Nine-class ColorBrewer Blues palette. */
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

// Matching the bivariate palette's wet row keeps temperature colours consistent across views.
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

const BIVARIATE_GREEN_HEX = [
  ["#b4d0f5", "#a6dfe9", "#b5e6cf", "#e4e2b4", "#ffdccd"],
  ["#98bbe9", "#81ccd9", "#95d4b7", "#d0cd93", "#fac0a6"],
  ["#7ca7dd", "#5ab9c9", "#73c2a0", "#bdb871", "#eca788"],
  ["#6092d1", "#23a7ba", "#4eaf89", "#aaa34d", "#de8e6a"],
  ["#447dc4", "#0791a3", "#189d73", "#978f20", "#cf764c"],
];

/**
 * The rain by temperature colour grid of the blended layer, as RGB triples. Rows run from dry to
 * wet and columns from cool to warm along the colour study's green path.
 */
export const BIVARIATE_GREEN = BIVARIATE_GREEN_HEX.map((row) => row.map(hexToRgb));

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
