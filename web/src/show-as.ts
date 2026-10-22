/**
 * Hold per-unit Show as choices, carry them in links and remember them per dataset.
 * The module is pure apart from the browser storage helpers, so a later editor can reuse the
 * actions and parsing without a DOM.
 */
import {
  BLEND,
  blendPair,
  type BlendPair,
  type ColourAllocation,
  type Draw,
  drawOptions,
} from "./layers/allocate";
import type { LayerDoc } from "./types";

const SHOW_AS_STORAGE_KEY = "soe.showas.v1";
const OLD_COLOUR_STORAGE_KEY = "soe.colour.v1";
const STORED_DRAWS = new Set<Draw>(["colour", "dots", "isolines"]);

/** A scene's explicit Show as choices and the units switched off. */
export interface ShowAsState {
  showAs: Record<string, Draw>;
  off: ReadonlySet<string>;
}

/** A request to choose, clear or toggle a unit's drawing. */
export type ShowAsAction =
  | { kind: "choose"; unit: string; draw: Draw }
  | { kind: "clear"; unit: string }
  | { kind: "toggle"; unit: string; on: boolean }
  | { kind: "toggleMany"; units: string[]; on: boolean };

/** The Show as choices a unit offers; parts and terrain have none. */
export function showAsOptions(unit: string, layers: readonly LayerDoc[]): Draw[] {
  if (unit === BLEND) return blendPair(layers) === null ? [] : ["colour"];

  const layer = layers.find(({ id }) => id === unit);
  return layer ? drawOptions(layer) : [];
}

/** Apply an explicit Show as choice, moving colour off any other unit when needed. */
export function choose(
  state: ShowAsState,
  unit: string,
  draw: Draw,
  layers: readonly LayerDoc[],
): ShowAsState {
  if (draw === "colour") return chooseColour(state, unit, layers);
  if (unit === BLEND) return state;

  return {
    showAs: { ...state.showAs, [unit]: draw },
    off: state.off,
  };
}

function chooseColour(
  state: ShowAsState,
  unit: string,
  layers: readonly LayerDoc[],
): ShowAsState {
  const pair = blendPair(layers);
  if (unit === BLEND && pair === null) return state;

  const showAs = withoutColours(state.showAs);
  showAs[unit] = "colour";

  const off = new Set(state.off);
  if (state.showAs[BLEND] === "colour") restoreBlendHalves(off, pair);
  off.delete(unit);
  if (unit === BLEND) addBlendHalves(off, pair);

  return { showAs, off };
}

/** Forget a unit's explicit choice so the allocation decides its draw again. */
export function clear(state: ShowAsState, unit: string): ShowAsState {
  const showAs = { ...state.showAs };
  delete showAs[unit];

  return { showAs, off: state.off };
}

/** Switch several units together, keeping each unit's toggle meaning. */
export function toggleMany(
  state: ShowAsState,
  units: readonly string[],
  on: boolean,
  layers: readonly LayerDoc[],
): ShowAsState {
  return units.reduce((current, unit) => toggle(current, unit, on, layers), state);
}

/** Switch a unit on or off, keeping an explicit colour choice sticky while it is off. */
export function toggle(
  state: ShowAsState,
  unit: string,
  on: boolean,
  layers: readonly LayerDoc[],
): ShowAsState {
  const pair = blendPair(layers);
  if (unit === BLEND) {
    if (on) return choose(state, BLEND, "colour", layers);

    const off = new Set(state.off);
    restoreBlendHalves(off, pair);

    return { showAs: clear(state, BLEND).showAs, off };
  }

  const isBlendHalf = pair !== null && pair.includes(unit);
  const restoresColour = state.off.has(unit) && state.showAs[unit] === "colour";
  const leavesBlend = isBlendHalf && state.showAs[BLEND] === "colour";
  if (on && (restoresColour || leavesBlend)) {
    return choose(state, unit, "colour", layers);
  }

  const off = new Set(state.off);
  if (on) off.delete(unit);
  else off.add(unit);

  return { showAs: state.showAs, off };
}

/**
 * The unit that held colour before a colour choice and no longer holds it afterwards.
 * Choosing the blend is ignored when it switches that owner off as a half, because the owner
 * is not hidden behind the blend.
 */
export function displacedOwner(
  before: ColourAllocation,
  after: ColourAllocation,
  action: ShowAsAction,
): string | null {
  if (action.kind !== "choose" || action.draw !== "colour") return null;
  if (before.owner === null || before.owner === after.owner) return null;
  if (action.unit === BLEND && !after.draws.has(before.owner)) return null;

  return before.owner;
}

/**
 * Read the linked Show as entries, dropping unknown units and draws outside a unit's options.
 * An off unit's colour is a sticky choice, so only on units compete for colour ownership.
 */
export function parseShowAs(
  text: string,
  layers: readonly LayerDoc[],
  off: ReadonlySet<string> = new Set(),
): { showAs: Record<string, Draw>; dropped: boolean } {
  const showAs: Record<string, Draw> = {};
  let dropped = false;
  let colourOwner: string | null = null;

  for (const token of text.split(",").filter(Boolean)) {
    const fields = token.split(":");
    const [unit, draw] = fields;
    const isKnown = fields.length === 2
      && showAsOptions(unit, layers).includes(draw as Draw);
    if (!isKnown) {
      dropped = true;
      continue;
    }

    if (draw === "colour" && !off.has(unit)) {
      if (colourOwner !== null && showAs[colourOwner] === "colour") {
        delete showAs[colourOwner];
      }
      colourOwner = unit;
    } else if (draw !== "colour" && colourOwner === unit) {
      colourOwner = null;
    }
    showAs[unit] = draw as Draw;
  }

  return { showAs, dropped };
}

/**
 * The `as` entries for a link. Every on unit with options names its effective draw and an off
 * unit names its sticky explicit choice. The blend names colour while it is on.
 */
export function formatShowAs(
  state: ShowAsState,
  layers: readonly LayerDoc[],
  allocation: ColourAllocation,
): string[] {
  const entries: string[] = [];

  for (const layer of layers) {
    const options = showAsOptions(layer.id, layers);
    if (options.length === 0) continue;

    if (state.off.has(layer.id)) {
      const explicit = state.showAs[layer.id];
      if (explicit && options.includes(explicit)) entries.push(`${layer.id}:${explicit}`);
      continue;
    }

    const draw = allocation.as.get(layer.id);
    if (draw && options.includes(draw)) entries.push(`${layer.id}:${draw}`);
  }
  if (allocation.as.get(BLEND) === "colour") entries.push(`${BLEND}:colour`);

  return entries;
}

/** The explicit Show as choices this browser remembers, oldest first. */
export function loadStoredShowAs(): Record<string, Draw> {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(SHOW_AS_STORAGE_KEY) ?? "{}");
    if (!isRecord(parsed)) return {};

    return Object.fromEntries(
      Object.entries(parsed).filter((entry): entry is [string, Draw] =>
        typeof entry[1] === "string" && STORED_DRAWS.has(entry[1] as Draw),
      ),
    );
  } catch {
    return {};
  }
}

/** Remember a unit's explicit choice, or forget it when draw is null. */
export function storeShowAs(unit: string, draw: Draw | null) {
  try {
    const stored = loadStoredShowAs();
    // Re-inserting the unit keeps object order equal to recency because ids are not integer-like.
    delete stored[unit];
    if (draw !== null) stored[unit] = draw;

    localStorage.setItem(SHOW_AS_STORAGE_KEY, JSON.stringify(stored));
    localStorage.removeItem(OLD_COLOUR_STORAGE_KEY);
  } catch {
    // The choice still applies to this visit. A blocked store is not worth reporting.
  }
}

function withoutColours(showAs: Readonly<Record<string, Draw>>): Record<string, Draw> {
  return Object.fromEntries(
    Object.entries(showAs).filter(([, draw]) => draw !== "colour"),
  );
}

function addBlendHalves(off: Set<string>, pair: BlendPair | null) {
  if (pair) off.add(pair[0]).add(pair[1]);
}

function restoreBlendHalves(off: Set<string>, pair: BlendPair | null) {
  if (!pair) return;

  off.delete(pair[0]);
  off.delete(pair[1]);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
