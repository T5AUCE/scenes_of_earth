import {
  CLASS_PALETTE_OPTIONS,
  CONTOUR_COLORS,
  DEFAULT_CONTOUR_COLOR,
  fieldGradient,
} from "./render/palettes";
import { allocate, BLEND, blendPair, layerDraws, type BlendPair } from "./layers/allocate";
import type { DisplayTokens, EdgeSettings, LayerDisplay, LayerDoc } from "./types";

const STORAGE_KEY = "soe.display.v1";
const EDGES_STORAGE_KEY = "soe.edges.v1";
const COLOUR_STORAGE_KEY = "soe.colour.v1";
const PALETTE_FIELDS = 2;
const RANGE_FIELDS = 3;
const SIGNIFICANT_DIGITS = 3;
// log10 of an exact power of ten can land a hair above the integer and add a spurious decimal.
const LOG_ROUNDING_TOLERANCE = 1e-9;

/** The note shown when a link carries settings that this scene cannot use. */
export const DROPPED_NOTE = "Some display settings in this link don't apply to this scene.";

/** The tokens of a link without display settings. */
export const NO_TOKENS: DisplayTokens = { pal: "", range: "", off: "", colour: "" };

/** Default class edges keep a one-pixel anti-aliased border and preserve isolated cells. */
export const DEFAULT_EDGES: Readonly<EdgeSettings> = {
  rounding: 0.25,
  softnessCells: 0,
  outline: false,
};

/** The strongest rounding that retains small class patches. */
export const MAX_ROUNDING = 0.6;
/** The widest optional blend between class colours, in grid cells. */
export const MAX_SOFTNESS_CELLS = 1;
const MAX_LEGACY_SOFTNESS_PX = 1.5; // old storage measured softness in screen pixels

interface StoredEdges {
  rounding?: unknown;
  softnessCells?: unknown;
  softnessPx?: unknown; // legacy field, in screen pixels
  outline?: unknown;
}

/** Read valid edge choices for one dataset without changing its shared-link display. */
export function loadStoredEdges(datasetId: string): EdgeSettings {
  const value = storedEdges()[datasetId];
  if (!value || !isStoredRounding(value.rounding) || typeof value.outline !== "boolean") {
    return { ...DEFAULT_EDGES };
  }

  const softnessCells = storedSoftness(value);
  if (softnessCells === null) return { ...DEFAULT_EDGES };

  return { rounding: value.rounding, softnessCells, outline: value.outline };
}

function storedEdges(): Record<string, StoredEdges> {
  try {
    const parsed = JSON.parse(localStorage.getItem(EDGES_STORAGE_KEY) ?? "{}");
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function isStoredRounding(value: unknown): value is number {
  return typeof value === "number"
    && Number.isFinite(value)
    && value >= 0
    && value <= MAX_ROUNDING;
}

function storedSoftness(value: StoredEdges) {
  if (value.softnessCells !== undefined) {
    return isSoftness(value.softnessCells) ? value.softnessCells : null;
  }

  // Screen pixels and cells differ too much at zoom, so reset only the softness choice.
  return isLegacySoftness(value.softnessPx) ? 0 : null;
}

function isLegacySoftness(value: unknown): value is number {
  return typeof value === "number"
    && Number.isFinite(value)
    && value >= 0
    && value <= MAX_LEGACY_SOFTNESS_PX;
}

function isSoftness(value: unknown): value is number {
  return typeof value === "number"
    && Number.isFinite(value)
    && value >= 0
    && value <= MAX_SOFTNESS_CELLS;
}

/** Remember edge choices per dataset, leaving palette storage and share links untouched. */
export function storeEdges(datasetId: string, edges: EdgeSettings) {
  try {
    const stored = storedEdges();
    stored[datasetId] = edges;
    localStorage.setItem(EDGES_STORAGE_KEY, JSON.stringify(stored));
  } catch {
    // Blocked storage must not prevent this visit's display changes.
  }
}

/** The display choices of one scene that differ from the bundle's defaults. */
export interface SceneDisplay {
  layers: Record<string, LayerDisplay>;
  /** Parts switched off, named by their link unit. */
  off: Set<string>;
  /** The sticky colour pick, or null while the auto rank chooses the owner. */
  colour: string | null;
}

/** A scene's sticky colour pick and off parts, which together decide who owns colour. */
export interface ColourState {
  pick: string | null;
  off: ReadonlySet<string>;
}

/** A request to change the colour pick or switch a unit on or off. */
export type ColourAction =
  | { kind: "pick"; unit: string }
  | { kind: "toggle"; unit: string; on: boolean };

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
 * Combine the link, the palettes and colour pick this browser remembers, and the bundle's
 * defaults, in that order of precedence. Tokens that name nothing in the scene are dropped.
 */
export function resolveDisplay(
  layers: LayerDoc[],
  tokens: DisplayTokens,
  stored: Record<string, string>,
  storedPick: string | null = null,
): ResolvedDisplay {
  const display: SceneDisplay = { layers: {}, off: new Set(), colour: null };
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

  const linkPick = lastToken(tokens.colour);
  const linkedColour = linkPick !== null && isColourUnit(layers, linkPick) ? linkPick : null;
  if (linkPick !== null && linkedColour === null) dropped = true;

  const remembered = storedPick !== null && isAvailablePick(layers, storedPick, display.off)
    ? storedPick
    : null;
  const pick = linkedColour ?? remembered;
  if (pick !== null) {
    display.colour = pick;
    if (pick === BLEND) addBlendHalves(display.off, blendPair(layers));
    else if (pick === linkedColour) display.off.delete(pick);
  }

  return { display, dropped };
}

function lastToken(value: string) {
  return value.split(",").filter(Boolean).at(-1) ?? null;
}

function isColourUnit(layers: readonly LayerDoc[], unit: string) {
  if (unit === BLEND) return blendPair(layers) !== null;

  const layer = layers.find(({ id }) => id === unit);
  return layer !== undefined && layerDraws(layer).colour;
}

/** A remembered pick applies only while the link leaves its units visible. */
function isAvailablePick(
  layers: readonly LayerDoc[],
  pick: string,
  off: ReadonlySet<string>,
) {
  if (!isColourUnit(layers, pick)) return false;
  if (pick !== BLEND) return !off.has(pick);

  const pair = blendPair(layers);
  return pair !== null && !off.has(pair[0]) && !off.has(pair[1]);
}

function addBlendHalves(off: Set<string>, pair: BlendPair | null) {
  if (pair) off.add(pair[0]).add(pair[1]);
}

/**
 * The link parameters, each starting with `&`. Every layer with a menu names its palette so that
 * the receiver sees the sender's colours whatever palettes their browser remembers. Ranges and
 * off parts appear only when they differ from the defaults.
 */
export function formatDisplayParams(display: SceneDisplay, layers: LayerDoc[]) {
  const units = layers.flatMap(layerUnits);
  const on = new Set(units.filter((unit) => !display.off.has(unit)));
  const owner = allocate(layers, on, display.colour).owner;
  const pair = blendPair(layers);
  const off = units.filter((unit) => display.off.has(unit)
    && !(owner === BLEND && pair?.includes(unit)));

  const parameters = {
    pal: layers.flatMap((layer) => {
      const palette = display.layers[layer.id]?.palette ?? defaultPalette(layer);
      return hasMenu(layer) && palette ? [`${layer.id}:${palette}`] : [];
    }),
    range: layers.flatMap(({ id }) => {
      const range = display.layers[id]?.range;
      return range ? [`${id}:${range[0]}:${range[1]}`] : [];
    }),
    off,
    colour: owner && colourCandidateCount(layers) >= 2 ? [owner] : [],
  };

  return Object.entries(parameters)
    .filter(([, entries]) => entries.length > 0)
    .map(([key, entries]) => `&${key}=${entries.join(",")}`)
    .join("");
}

// Count off layers too, because a receiver may have a different one on and lose the sender's owner.
function colourCandidateCount(layers: readonly LayerDoc[]) {
  const layersWithColour = layers.filter((layer) => layerDraws(layer).colour).length;
  return layersWithColour + (blendPair(layers) === null ? 0 : 1);
}

/**
 * Apply a pick or toggle without changing the scene order. Picking colour switches the unit on,
 * while the pick stays sticky after the owner is switched off.
 */
export function applyColourAction(
  state: ColourState,
  action: ColourAction,
  layers: readonly LayerDoc[],
): ColourState {
  const pair = blendPair(layers);
  const off = new Set(state.off);

  return action.kind === "pick"
    ? pickColour(state.pick, off, action.unit, pair)
    : toggleColour(state.pick, off, action, pair);
}

function pickColour(
  current: string | null,
  off: Set<string>,
  unit: string,
  pair: BlendPair | null,
): ColourState {
  if (unit === BLEND) {
    if (!pair) return { pick: current, off };

    addBlendHalves(off, pair);
    return { pick: BLEND, off };
  }

  off.delete(unit);
  if (current === BLEND) restoreBlendHalves(off, pair);

  return { pick: unit, off };
}

function toggleColour(
  current: string | null,
  off: Set<string>,
  action: { unit: string; on: boolean },
  pair: BlendPair | null,
): ColourState {
  if (action.unit === BLEND) {
    if (action.on) return pickColour(current, off, BLEND, pair);

    restoreBlendHalves(off, pair);
    return { pick: null, off };
  }

  const isHalf = pair?.includes(action.unit) ?? false;
  if (current === BLEND && isHalf && action.on) {
    off.delete(action.unit);
    return { pick: action.unit, off };
  }

  if (action.on) off.delete(action.unit);
  else off.add(action.unit);
  return { pick: current, off };
}

function restoreBlendHalves(off: Set<string>, pair: BlendPair | null) {
  if (!pair) return;

  off.delete(pair[0]);
  off.delete(pair[1]);
}

/** The colour pick this browser remembers, or null when it has none. */
export function loadStoredPick(): string | null {
  try {
    const parsed = JSON.parse(localStorage.getItem(COLOUR_STORAGE_KEY) ?? "null");
    const pick = parsed && typeof parsed === "object" ? parsed.pick : null;
    return typeof pick === "string" && pick ? pick : null;
  } catch {
    return null;
  }
}

/** Remember the viewer's colour pick, or forget it when pick is null. */
export function storePick(pick: string | null) {
  try {
    if (pick === null) localStorage.removeItem(COLOUR_STORAGE_KEY);
    else localStorage.setItem(COLOUR_STORAGE_KEY, JSON.stringify({ pick }));
  } catch {
    // The pick still applies to this visit. A blocked store is not worth reporting.
  }
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

function hasMenu(layer: LayerDoc) {
  return ["field", "categorical", "terrain"].includes(layer.style.kind);
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
