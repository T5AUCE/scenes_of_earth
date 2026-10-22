/** Resolve scene display choices and persist browser preferences independently of links. */
import {
  DEFAULT_DENSITY_RATIO,
  DENSITY_STEP_LOG2,
  MAX_DENSITY_LOG2,
  MIN_DENSITY_LOG2,
  quantiseDensity,
} from "./render/lattice";
import {
  CLASS_PALETTE_OPTIONS,
  CONTOUR_COLORS,
  DEFAULT_CONTOUR_COLOR,
  DEFAULT_DOT_INK,
  DEFAULT_ISOTHERM_INK,
  fieldGradient,
  inkColor,
  inkFromLink,
  inkToLink,
} from "./render/palettes";
import {
  allocate,
  BLEND,
  blendPair,
  type BlendPair,
  type Draw,
  layerDraws,
} from "./layers/allocate";
import { formatShowAs, parseShowAs, showAsOptions } from "./show-as";
import { displayUnitFor, isUnitFor, unitOptions } from "./units";
import type {
  DisplayTokens,
  EdgeSettings,
  LayerControl,
  LayerDisplay,
  LayerDoc,
} from "./types";

const STORAGE_KEY = "soe.display.v1";
const EDGES_STORAGE_KEY = "soe.edges.v1";
const INK_STORAGE_KEY = "soe.ink.v1";
const DENSITY_STORAGE_KEY = "soe.density.v1";
const UNITS_STORAGE_KEY = "soe.units.v1";

const PALETTE_FIELDS = 2;
const INK_FIELDS = 2;
const DENSITY_FIELDS = 2;
const RANGE_FIELDS = 3;
const UNITS_FIELDS = 2;
const SIGNIFICANT_DIGITS = 3;
// log10 of an exact power of ten can land a hair above the integer and add a spurious decimal.
const LOG_ROUNDING_TOLERANCE = 1e-9;

/** The note shown when a link carries settings that this scene cannot use. */
export const DROPPED_NOTE = "Some display settings in this link don't apply to this scene.";

/** The tokens of a link without display settings. */
export const NO_TOKENS: DisplayTokens = {
  pal: "",
  range: "",
  off: "",
  as: "",
  ink: "",
  dens: "",
  units: "",
};

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
  /** Explicit Show as choices; a missing key means the auto rank decides. */
  showAs: Record<string, Draw>;
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

/** The ink a layer's dots or isotherms take until the viewer chooses another, if it has any. */
export function defaultInk(layer: LayerDoc) {
  const { fallback } = layerDraws(layer);
  if (fallback === "dots") return DEFAULT_DOT_INK;

  return fallback === "isolines" ? DEFAULT_ISOTHERM_INK : undefined;
}

/** A dot-density slider whose value uses the same normalisation as a density in a link. */
export function densityControl(
  readDensity: () => number,
  set: (density: number) => void,
): LayerControl {
  return {
    label: "Dot density",
    hint: "Change dot density using slider",
    min: MIN_DENSITY_LOG2,
    max: MAX_DENSITY_LOG2,
    step: DENSITY_STEP_LOG2,
    get value() {
      const steps = Math.round(Math.log2(quantiseDensity(readDensity())) / DENSITY_STEP_LOG2);
      return steps * DENSITY_STEP_LOG2;
    },
    set: (value) => set(quantiseDensity(2 ** value)),
  };
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

/** Return link units for the layer itself and each extra part. */
export function layerUnits(layer: LayerDoc) {
  return [layer.id, ...(layer.style.parts ?? []).map((part) => `${layer.id}.${part}`)];
}

/**
 * Resolve linked choices before browser preferences and bundle defaults.
 * A link with `as` is a complete Show as snapshot, so stored Show as choices are ignored for that
 * visit. Drop tokens that name nothing in the scene.
 */
export function resolveDisplay(
  layers: LayerDoc[],
  tokens: DisplayTokens,
  stored: Record<string, string>,
  storedShowAs: Record<string, Draw> = {},
  storedInks: Record<string, string> = {},
  storedDensities: Record<string, number> = {},
  storedUnits: Record<string, string> = {},
): ResolvedDisplay {
  const display: SceneDisplay = { layers: {}, off: new Set(), showAs: {} };
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

  const linkedInks = new Map<string, string>();
  for (const fields of tokenFields(tokens.ink)) {
    const [id, value] = fields;
    const ink = fields.length === INK_FIELDS ? inkFromLink(value) : undefined;
    if (ink && hasInk(byId.get(id))) linkedInks.set(id, ink);
    else dropped = true;
  }

  for (const layer of layers) {
    const remembered = storedInks[layer.id];
    const chosen = linkedInks.get(layer.id)
      ?? (hasInk(layer) && inkColor(remembered ?? "") ? remembered : null);
    if (chosen && chosen !== defaultInk(layer)) {
      setLayerDisplay(display, layer.id, { ...display.layers[layer.id], ink: chosen });
    }
  }

  const linkedDensities = new Map<string, number>();
  for (const fields of tokenFields(tokens.dens)) {
    const [id, text] = fields;
    const density = fields.length === DENSITY_FIELDS ? densityOf(byId.get(id), text) : null;
    if (density === null) dropped = true;
    else linkedDensities.set(id, density);
  }

  for (const layer of layers) {
    const remembered = storedDensities[layer.id];
    const linked = linkedDensities.get(layer.id);
    const density = linked ?? (hasDots(layer) && remembered !== undefined
      ? quantiseDensity(remembered)
      : null);
    if (density !== null && density !== DEFAULT_DENSITY_RATIO) {
      setLayerDisplay(display, layer.id, { ...display.layers[layer.id], density });
    }
  }

  for (const fields of tokenFields(tokens.range)) {
    const [id, low, high] = fields;
    const range = fields.length === RANGE_FIELDS ? rangeOf(byId.get(id), low, high) : null;
    if (range) setLayerDisplay(display, id, { ...display.layers[id], range });
    else dropped = true;
  }

  const linkedUnits = new Map<string, string>();
  for (const fields of tokenFields(tokens.units ?? "")) {
    const [id, unit] = fields;
    if (fields.length === UNITS_FIELDS && isUnitFor(byId.get(id)?.units ?? "", unit)) {
      linkedUnits.set(id, unit);
    } else {
      dropped = true;
    }
  }

  for (const layer of layers) {
    const linked = linkedUnits.get(layer.id);
    const remembered = storedUnits[layer.id];
    const validRemembered = remembered !== undefined && isUnitFor(layer.units, remembered)
      ? remembered
      : null;
    const chosen = linked ?? validRemembered;
    if (chosen && chosen !== displayUnitFor(layer.units, undefined)) {
      setLayerDisplay(display, layer.id, { ...display.layers[layer.id], units: chosen });
    }
  }

  const units = new Set(layers.flatMap(layerUnits));
  for (const unit of tokens.off.split(",").filter(Boolean)) {
    if (units.has(unit)) display.off.add(unit);
    else dropped = true;
  }

  const linkedShowAs = parseShowAs(tokens.as, layers, display.off);
  if (linkedShowAs.dropped) dropped = true;

  const pair = blendPair(layers);
  display.showAs = tokens.as === ""
    ? storedChoices(storedShowAs, layers, display.off)
    : linkedShowAs.showAs;
  if (display.showAs[BLEND] === "colour") addBlendHalves(display.off, pair);

  return { display, dropped };
}

/** Stored choices of a link without `as`, with the latest stored colour winning. */
function storedChoices(
  stored: Readonly<Record<string, Draw>>,
  layers: readonly LayerDoc[],
  off: ReadonlySet<string>,
): Record<string, Draw> {
  const showAs: Record<string, Draw> = {};
  const pair = blendPair(layers);

  for (const [unit, draw] of Object.entries(stored)) {
    if (!showAsOptions(unit, layers).includes(draw)) continue;
    // A link that switches off a blend half leaves the blend unusable for this visit.
    if (unit === BLEND && pair?.some((half) => off.has(half))) continue;

    setChoice(showAs, unit, draw);
  }

  return showAs;
}

function setChoice(showAs: Record<string, Draw>, unit: string, draw: Draw) {
  if (draw === "colour") {
    for (const [chosenUnit, chosenDraw] of Object.entries(showAs)) {
      if (chosenDraw === "colour" && chosenUnit !== unit) delete showAs[chosenUnit];
    }
  }
  showAs[unit] = draw;
}

function hasInk(layer: LayerDoc | undefined) {
  return layer !== undefined && defaultInk(layer) !== undefined;
}

function hasDots(layer: LayerDoc | undefined) {
  return layer !== undefined && layerDraws(layer).fallback === "dots";
}

function densityOf(layer: LayerDoc | undefined, text: string | undefined) {
  if (!hasDots(layer) || !text) return null;

  const density = Number(text);
  if (!Number.isFinite(density)) return null;

  return quantiseDensity(density);
}

function addBlendHalves(off: Set<string>, pair: BlendPair | null) {
  if (pair) off.add(pair[0]).add(pair[1]);
}

/**
 * The link parameters, each starting with `&`. Every layer with a menu names its palette so that
 * the receiver sees the sender's colours whatever palettes their browser remembers. Ranges, inks
 * and off parts appear only when they differ from the defaults. Every dot layer names its effective
 * density and every convertible layer names its effective units, because an omitted default would
 * let the receiver's stored choice win.
 */
export function formatDisplayParams(display: SceneDisplay, layers: LayerDoc[]) {
  const units = layers.flatMap(layerUnits);
  const on = new Set(units.filter((unit) => !display.off.has(unit)));
  const allocation = allocate(layers, on, display.showAs);
  const pair = blendPair(layers);
  const off = units.filter((unit) =>
    display.off.has(unit) && !(allocation.owner === BLEND && pair?.includes(unit)),
  );

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
    as: formatShowAs(display, layers, allocation),
    ink: layers.flatMap(({ id }) => {
      const ink = display.layers[id]?.ink;
      return ink ? [`${id}:${inkToLink(ink)}`] : [];
    }),
    dens: layers.flatMap((layer) => {
      if (!hasDots(layer)) return [];

      const density = quantiseDensity(display.layers[layer.id]?.density ?? DEFAULT_DENSITY_RATIO);
      return [`${layer.id}:${density}`];
    }),
    units: layers.flatMap(({ id, units: native }) => {
      if (!unitOptions(native)) return [];

      const effective = display.layers[id]?.units ?? native;
      return [`${id}:${effective}`];
    }),
  };

  return Object.entries(parameters)
    .filter(([, entries]) => entries.length > 0)
    .map(([key, entries]) => `&${key}=${entries.join(",")}`)
    .join("");
}

/** Replace a layer's overrides or remove its entry when no overrides remain. */
export function setLayerDisplay(display: SceneDisplay, layerId: string, layer: LayerDisplay) {
  const { palette, range, ink, density, units } = layer;
  if (!palette && !range && !ink && !density && !units) {
    delete display.layers[layerId];
    return;
  }

  display.layers[layerId] = {
    ...(palette && { palette }),
    ...(range && { range }),
    ...(ink && { ink }),
    ...(density && { density }),
    ...(units && { units }),
  };
}

/**
 * Record a menu change in the scene's display. Palette, ink and unit choices are remembered by
 * this browser, because a range belongs to the link and the visit.
 */
export function recordMenuChange(
  display: SceneDisplay,
  layerId: string,
  menu: {
    palette: string;
    defaultPalette: string;
    range?: { value: [number, number] | null };
    ink?: { value: string; defaultInk: string };
    units?: { value: string; defaultUnit: string };
  },
  changed: "palette" | "range" | "ink" | "units",
) {
  const palette = menu.palette === menu.defaultPalette ? undefined : menu.palette;
  const ink = menu.ink && menu.ink.value !== menu.ink.defaultInk ? menu.ink.value : undefined;
  const units = menu.units && menu.units.value !== menu.units.defaultUnit
    ? menu.units.value
    : undefined;
  setLayerDisplay(display, layerId, {
    ...display.layers[layerId],
    palette,
    range: menu.range?.value ?? undefined,
    ink,
    units: units ?? (menu.units ? undefined : display.layers[layerId]?.units),
  });
  if (changed === "palette") storePalette(layerId, palette ?? null);
  if (changed === "ink") storeInk(layerId, ink ?? null);
  if (changed === "units") storeUnits(layerId, units ?? null);
}

/** The palette names this browser remembers by layer id; empty when storage is unavailable. */
export function loadStoredPalettes(): Record<string, string> {
  return loadStoredNames(STORAGE_KEY);
}

/** Remember a layer's palette in this browser, or forget it when name is null. */
export function storePalette(layerId: string, name: string | null) {
  storeName(STORAGE_KEY, layerId, name);
}

/** The inks this browser remembers by layer id; empty when storage is unavailable. */
export function loadStoredInks(): Record<string, string> {
  return loadStoredNames(INK_STORAGE_KEY);
}

/** Remember a layer's ink in this browser, or forget it when ink is null. */
export function storeInk(layerId: string, ink: string | null) {
  storeName(INK_STORAGE_KEY, layerId, ink);
}

/** The display units this browser remembers by layer id; empty when storage is unavailable. */
export function loadStoredUnits(): Record<string, string> {
  return loadStoredNames(UNITS_STORAGE_KEY);
}

/** Remember a layer's display unit in this browser, or forget it when unit is null. */
export function storeUnits(layerId: string, unit: string | null) {
  storeName(UNITS_STORAGE_KEY, layerId, unit);
}

/** The dot densities this browser remembers by layer id; empty when storage is unavailable. */
export function loadStoredDensities(): Record<string, number> {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(DENSITY_STORAGE_KEY) ?? "{}");
    if (!isRecord(parsed)) return {};

    return Object.fromEntries(
      Object.entries(parsed)
        .filter((entry): entry is [string, number] => isStoredDensity(entry[1]))
        .map(([layerId, density]) => [layerId, quantiseDensity(density)]),
    );
  } catch {
    return {};
  }
}

/** Remember a layer's dot density in this browser, or forget it when density is null. */
export function storeDensity(layerId: string, density: number | null) {
  try {
    const stored = loadStoredDensities();
    if (density === null) delete stored[layerId];
    else stored[layerId] = quantiseDensity(density);

    localStorage.setItem(DENSITY_STORAGE_KEY, JSON.stringify(stored));
  } catch {
    // The density still applies to this visit. A blocked store is not worth reporting.
  }
}

function isStoredDensity(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function loadStoredNames(key: string): Record<string, string> {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(key) ?? "{}");
    if (!isRecord(parsed)) return {};

    return Object.fromEntries(
      Object.entries(parsed).filter((entry): entry is [string, string] =>
        typeof entry[1] === "string",
      ),
    );
  } catch {
    return {};
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function storeName(key: string, layerId: string, name: string | null) {
  try {
    const stored = loadStoredNames(key);
    if (name) stored[layerId] = name;
    else delete stored[layerId];

    localStorage.setItem(key, JSON.stringify(stored));
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

// Link ranges keep their full precision, so a display-unit edit round trips exactly.
function rangeOf(layer: LayerDoc | undefined, lowText: string, highText: string) {
  if (layer?.style.kind !== "field" || !lowText || !highText) return null;

  const low = Number(lowText);
  const high = Number(highText);
  if (!Number.isFinite(low) || !Number.isFinite(high) || low >= high) return null;

  return [low, high] as [number, number];
}
