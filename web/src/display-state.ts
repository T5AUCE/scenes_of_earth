import {
  CLASS_PALETTE_OPTIONS,
  CONTOUR_COLORS,
  DEFAULT_CONTOUR_COLOR,
  fieldGradient,
} from "./render/palettes";
import type { DisplayTokens, LayerDisplay, LayerDoc } from "./types";

const STORAGE_KEY = "soe.display.v1";
const PALETTE_FIELDS = 2;
const RANGE_FIELDS = 3;
const SIGNIFICANT_DIGITS = 3;
// log10 of an exact power of ten can land a hair above the integer and add a spurious decimal.
const LOG_ROUNDING_TOLERANCE = 1e-9;

/** The note shown when a link carries settings that this scene cannot use. */
export const DROPPED_NOTE = "Some display settings in this link don't apply to this scene.";

/** The tokens of a link without display settings. */
export const NO_TOKENS: DisplayTokens = { pal: "", range: "", off: "" };

/** The display choices of one scene that differ from the bundle's defaults. */
export interface SceneDisplay {
  layers: Record<string, LayerDisplay>;
  /** Parts switched off, named by their link unit. */
  off: Set<string>;
}

/** A scene's display state and whether part of the link had to be dropped. */
export interface ResolvedDisplay {
  display: SceneDisplay;
  dropped: boolean;
}

/** The palette a layer shows until the viewer chooses another. */
export function defaultPalette(layer: LayerDoc) {
  if (layer.style.kind === "terrain") return DEFAULT_CONTOUR_COLOR;
  if (layer.style.kind === "categorical") return layer.style.palette ?? "esa";

  // A field layer without a palette cannot be built, so the empty name only satisfies the type.
  return layer.style.palette ?? "";
}

/**
 * The decimals a custom range keeps. They match the precision of scaled integer values and
 * otherwise give the area's value span about three significant figures.
 */
export function rangeDecimals(layer: LayerDoc) {
  const scale = layer.arrays.value?.scale_factor;
  const resolution = scale ?? spanResolution(layer);
  return Math.max(0, Math.ceil(-Math.log10(resolution) - LOG_ROUNDING_TOLERANCE));
}

function spanResolution({ stats }: LayerDoc) {
  const { min, max } = (stats ?? {}) as Record<string, unknown>;
  const span = typeof min === "number" && typeof max === "number" ? max - min : 0;

  return span > 0 ? span / 10 ** (SIGNIFICANT_DIGITS - 1) : 1;
}

/** The link units of a layer: the layer itself and each of its extra parts. */
export function layerUnits(layer: LayerDoc) {
  return [layer.id, ...(layer.style.parts ?? []).map((part) => `${layer.id}.${part}`)];
}

/**
 * Combine the link, the palettes this browser remembers and the bundle's defaults, in that order
 * of precedence. Tokens that name nothing in the scene are dropped and never throw.
 */
export function resolveDisplay(
  layers: LayerDoc[],
  tokens: DisplayTokens,
  stored: Record<string, string>,
): ResolvedDisplay {
  const display: SceneDisplay = { layers: {}, off: new Set() };
  const byId = new Map(layers.map((layer) => [layer.id, layer]));
  let dropped = false;

  const linked = new Map<string, string>();
  for (const fields of tokenFields(tokens.pal)) {
    const [id, palette] = fields;
    if (fields.length === PALETTE_FIELDS && isPaletteOf(byId.get(id), palette)) {
      linked.set(id, palette);
    } else {
      dropped = true;
    }
  }

  for (const layer of layers) {
    const remembered = stored[layer.id];
    const chosen = linked.get(layer.id) ?? (isPaletteOf(layer, remembered) ? remembered : null);
    if (chosen && chosen !== defaultPalette(layer)) {
      setLayerDisplay(display, layer.id, { palette: chosen });
    }
  }

  for (const fields of tokenFields(tokens.range)) {
    const [id, low, high] = fields;
    const range = fields.length === RANGE_FIELDS ? rangeOf(byId.get(id), low, high) : null;
    if (range) setLayerDisplay(display, id, { ...display.layers[id], range });
    else dropped = true;
  }

  const units = new Set(layers.flatMap(layerUnits));
  for (const unit of tokens.off.split(",").filter(Boolean)) {
    if (units.has(unit)) display.off.add(unit);
    else dropped = true;
  }

  return { display, dropped };
}

/** The link parameters for everything that differs from the defaults, each starting with `&`. */
export function formatDisplayParams(display: SceneDisplay, layers: LayerDoc[]) {
  const parameters = {
    pal: layers.flatMap(({ id }) => {
      const palette = display.layers[id]?.palette;
      return palette ? [`${id}:${palette}`] : [];
    }),
    range: layers.flatMap(({ id }) => {
      const range = display.layers[id]?.range;
      return range ? [`${id}:${range[0]}:${range[1]}`] : [];
    }),
    off: layers.flatMap(layerUnits).filter((unit) => display.off.has(unit)),
  };

  return Object.entries(parameters)
    .filter(([, entries]) => entries.length > 0)
    .map(([key, entries]) => `&${key}=${entries.join(",")}`)
    .join("");
}

/** Replace what a layer overrides; a layer that overrides nothing is removed. */
export function setLayerDisplay(display: SceneDisplay, layerId: string, layer: LayerDisplay) {
  const { palette, range } = layer;
  if (!palette && !range) {
    delete display.layers[layerId];
    return;
  }

  display.layers[layerId] = { ...(palette && { palette }), ...(range && { range }) };
}

/**
 * Record a menu change in the scene's display. Only a palette choice is remembered by this
 * browser, because a range belongs to the link and the visit.
 */
export function recordMenuChange(
  display: SceneDisplay,
  layerId: string,
  menu: { palette: string; defaultPalette: string; range?: { value: [number, number] | null } },
  changed: "palette" | "range",
) {
  const palette = menu.palette === menu.defaultPalette ? undefined : menu.palette;
  setLayerDisplay(display, layerId, { palette, range: menu.range?.value ?? undefined });
  if (changed === "palette") storePalette(layerId, palette ?? null);
}

/** The palette names this browser remembers by layer id; empty when storage is unavailable. */
export function loadStoredPalettes(): Record<string, string> {
  try {
    const parsed = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "{}");
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

/** Remember a layer's palette in this browser, or forget it when name is null. */
export function storePalette(layerId: string, name: string | null) {
  try {
    const stored = loadStoredPalettes();
    if (name) stored[layerId] = name;
    else delete stored[layerId];

    localStorage.setItem(STORAGE_KEY, JSON.stringify(stored));
  } catch {
    // The choice still applies to this visit. A blocked store is not worth reporting.
  }
}

function tokenFields(list: string) {
  return list.split(",").filter(Boolean).map((token) => token.split(":"));
}

function isPaletteOf(layer: LayerDoc | undefined, palette: string | undefined) {
  if (!layer || !palette) return false;

  switch (layer.style.kind) {
    case "field":
      return fieldGradient(palette) !== undefined;
    case "categorical":
      return CLASS_PALETTE_OPTIONS.some(({ name }) => name === palette);
    case "terrain":
      return CONTOUR_COLORS.some(({ name }) => name === palette);
    default:
      return false;
  }
}

// Only field layers have a range, and the numbers are rounded to keep links short.
function rangeOf(layer: LayerDoc | undefined, lowText: string, highText: string) {
  if (layer?.style.kind !== "field" || !lowText || !highText) return null;

  const decimals = rangeDecimals(layer);
  const low = Number(Number(lowText).toFixed(decimals));
  const high = Number(Number(highText).toFixed(decimals));
  if (!Number.isFinite(low) || !Number.isFinite(high) || low >= high) return null;

  return [low, high] as [number, number];
}
