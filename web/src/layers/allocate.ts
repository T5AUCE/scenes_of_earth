/** Allocate colour ownership and non-conflicting fallback channels to visible scene units. */
import type { LayerDoc } from "../types";

/** The link unit of the virtual rainfall + temperature blend. */
export const BLEND = "blend";

/** A channel a visible layer or part can draw through. */
export type Draw = "colour" | "dots" | "isolines" | "contours" | "shade";

/** A unit that cannot draw, with the reason the viewer is shown. */
export interface Hidden {
  hidden: string;
}

/** What one layer offers to the allocation, independent of whether it is on. */
export interface LayerDraws {
  colour: boolean;
  fallback: Draw | null;
  blend: "chroma" | "warmth" | null;
}

/** The two layers whose encodings make the blended layer possible, in card order. */
export type BlendPair = readonly [string, string];

/** Who holds colour and what every visible unit draws instead. */
export interface ColourAllocation {
  owner: string | null;
  draws: Map<string, Draw | Hidden>;
}

type Claim = "colour" | "dots" | "line.dashed" | "line.solid";

/** The resources each draw needs. */
const CLAIMS: Record<Draw, Claim[]> = {
  colour: ["colour"],
  dots: ["dots"],
  isolines: ["line.dashed"],
  contours: ["line.solid"],
  shade: [],
};

const COLOUR_ENCODINGS = ["ramp", "fill"];
const FALLBACKS = new Set<Draw>(["dots", "isolines"]);
const FIXED_DRAWS: Draw[] = ["shade", "contours"];
const CLAIM_LABELS: Partial<Record<Draw, string>> = {
  dots: "dots",
  isolines: "isotherms",
  contours: "contours",
  shade: "relief",
};
const ONLY_IN_COLOUR = "Shown only in colour";

/** Describe a layer's colour support and fallback, following its encodings first. */
export function layerDraws({ style }: LayerDoc): LayerDraws {
  const encodings = new Set(style.encodings);

  return {
    colour: COLOUR_ENCODINGS.some((name) => encodings.has(name)),
    fallback: fallbackOf(style.encodings),
    blend: blendRole(encodings),
  };
}

function fallbackOf(encodings: string[]): Draw | null {
  return encodings.find((name): name is Draw => FALLBACKS.has(name as Draw)) ?? null;
}

function blendRole(encodings: Set<string>): LayerDraws["blend"] {
  if (encodings.has("chroma")) return "chroma";
  if (encodings.has("warmth")) return "warmth";

  return null;
}

/** The first layer with chroma and the first with warmth; the blend exists only when both do. */
export function blendPair(layers: readonly LayerDoc[]): BlendPair | null {
  const chroma = layers.find(({ style }) => style.encodings.includes("chroma"));
  const warmth = layers.find(({ style }) => style.encodings.includes("warmth"));

  return chroma && warmth ? [chroma.id, warmth.id] : null;
}

/**
 * The note for a scrubber step where a half of the blend has no data, or null when both halves
 * have a step. `time` is the step as the scrubber labels it.
 */
export function missingStepNote(
  halves: readonly { title: string; step: number }[],
  time: string,
) {
  const missing = halves.filter(({ step }) => step < 0).map(({ title }) => title.toLowerCase());
  if (missing.length === 0) return null;

  return `No ${missing.join(" or ")} for ${time}; the blend shows steps where both exist.`;
}

/**
 * The note for a scrubber step where the halves of the blend show different periods, such as a
 * daily and a monthly layer, or null when they show the same one.
 */
export function differingPeriodNote(halves: readonly { title: string; period: string }[]) {
  if (new Set(halves.map(({ period }) => period)).size === 1) return null;

  const shown = halves.map(({ title, period }) => `${title.toLowerCase()} for ${period}`);
  return `The blend pairs ${shown.join(" with ")}.`;
}

/**
 * Give colour to the picked unit when it is a candidate, else to the best-ranked candidate.
 * Every other visible unit takes its fallback's first free channel or is hidden with a reason.
 * A unit named in `blocked` cannot draw its fallback and is hidden with the given reason.
 */
export function allocate(
  layers: readonly LayerDoc[],
  on: ReadonlySet<string>,
  pick: string | null,
  blocked: ReadonlyMap<string, string> = new Map(),
): ColourAllocation {
  const pair = blendPair(layers);
  const mains = layers.map(layerUnit);
  const parts = layers.flatMap(partUnits);
  const visible = [...mains, ...parts].filter((unit) => on.has(unit.id));
  const blendOn = pair !== null && (on.has(BLEND) || pick === BLEND);
  const blend = blendOn ? [blendUnit()] : [];

  const candidates = [...visible, ...blend].filter((unit) => unit.colour);
  const owner = colourOwner(candidates, pick);
  const draws = new Map<string, Draw | Hidden>();
  const claimed = new Map<Claim, string>();

  for (const unit of visible) {
    if (unit.id === owner) draws.set(unit.id, claim(unit, "colour", claimed));
    else drawFallbackOrFixed(unit, draws, claimed, blocked);
  }
  if (owner === BLEND) draws.set(BLEND, claim(blendUnit(), "colour", claimed));
  else if (blendOn) draws.set(BLEND, { hidden: ONLY_IN_COLOUR });

  return { owner, draws };
}

interface Unit {
  id: string;
  kind: string;
  encodings: string[];
  colour: boolean;
  fallback: Draw | null;
  order: number;
}

function layerUnit(layer: LayerDoc, order: number): Unit {
  const draws = layerDraws(layer);

  return {
    id: layer.id,
    kind: layer.style.kind,
    encodings: layer.style.encodings,
    colour: draws.colour,
    fallback: draws.fallback,
    order,
  };
}

function partUnits(layer: LayerDoc): Unit[] {
  return (layer.style.parts ?? []).map((part) => ({
    id: `${layer.id}.${part}`,
    kind: "part",
    encodings: [part],
    colour: false,
    fallback: null,
    order: 0,
  }));
}

function blendUnit(): Unit {
  return {
    id: BLEND,
    kind: "blend",
    encodings: ["ramp"],
    colour: true,
    fallback: null,
    order: 0,
  };
}

function colourOwner(candidates: Unit[], pick: string | null): string | null {
  if (pick !== null && candidates.some(({ id }) => id === pick)) return pick;

  const auto = candidates
    .filter(({ id }) => id !== BLEND)
    .sort((first, second) => rank(first) - rank(second) || first.order - second.order);

  return auto[0]?.id ?? null;
}

// Temperature needs colour most because its fallback is isotherms rather than rain's dots.
function rank(unit: Unit): number {
  if (unit.kind === "categorical") return 3;
  if (unit.kind === "field" && unit.fallback === "isolines") return 0;
  if (unit.kind === "field" && unit.fallback === "dots") return 1;

  return 2;
}

function drawFallbackOrFixed(
  unit: Unit,
  draws: Map<string, Draw | Hidden>,
  claimed: Map<Claim, string>,
  blocked: ReadonlyMap<string, string>,
) {
  const fixed = FIXED_DRAWS.find((draw) => unit.encodings.includes(draw));
  if (fixed) {
    draws.set(unit.id, claim(unit, fixed, claimed));
    return;
  }

  if (!unit.fallback) {
    if (unit.colour) draws.set(unit.id, { hidden: ONLY_IN_COLOUR });
    return;
  }

  const reason = blocked.get(unit.id);
  if (reason) draws.set(unit.id, { hidden: reason });
  else draws.set(unit.id, claim(unit, unit.fallback, claimed));
}

function claim(unit: Unit, draw: Draw, claimed: Map<Claim, string>): Draw | Hidden {
  const claims = CLAIMS[draw];
  if (claims.length === 0) return draw;

  const free = claims.find((name) => !claimed.has(name));
  if (!free) return { hidden: hiddenReason(draw, claimed) };

  claimed.set(free, CLAIM_LABELS[draw] ?? draw);
  return draw;
}

function hiddenReason(draw: Draw, claimed: Map<Claim, string>) {
  if (draw === "isolines") {
    return `Hidden: the dashed line is in use (${claimed.get("line.dashed")})`;
  }

  if (draw === "contours") {
    return `Hidden: the solid line is in use (${claimed.get("line.solid")})`;
  }

  return `Hidden: ${draw} already in use`;
}
