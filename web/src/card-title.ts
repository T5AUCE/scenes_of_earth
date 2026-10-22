/** Describe a layer card's title from the draw the allocation gives it. */
import type { Draw, Hidden } from "./layers/allocate";
import type { LayerDoc } from "./types";

const ONLY_IN_COLOUR = "Shown only in colour";

/** What a card title needs to know about a unit's current place in the scene. */
export interface CardTitleState {
  /** The draw the allocation gives the unit, or a reason it cannot draw. */
  draw: Draw | Hidden | undefined;
  /** Whether the card's own switch is off. */
  off: boolean;
  /** Whether the Smooth option applies to this layer, which only marks dots. */
  smoothed?: boolean;
  /** The on parts of a multi-part layer with no draw, already lowercase. */
  parts?: readonly string[];
}

/** The fields a title or tab label reads, so tests can use a small stub. */
export type TitledLayer = Pick<LayerDoc, "title" | "units">;

const SHOW_AS_LABELS: Record<Draw, string> = {
  colour: "Colour",
  dots: "Dots",
  isolines: "Lines",
  contours: "Contours",
  shade: "Relief",
};

/** The capitalised tab label for a draw, saying Isotherms for temperature isolines. */
export function showAsLabel(draw: Draw, layer: TitledLayer): string {
  if (draw === "isolines") return isTemperature(layer) ? "Isotherms" : "Lines";

  return SHOW_AS_LABELS[draw];
}

/** The word a card title uses for a draw. */
export function drawLabel(draw: Draw, layer: TitledLayer): string {
  if (draw === "isolines") return isTemperature(layer) ? "isotherms" : "lines";

  return draw === "shade" ? "relief" : draw;
}

/** A card title such as "Rainfall · Dots, Smoothed" or "Terrain · Relief, Contours". */
export function cardTitle(
  layer: TitledLayer,
  { draw, off, smoothed, parts }: CardTitleState,
): string {
  if (off) return titled(layer, ["off"]);
  if (typeof draw === "object") return titled(layer, [hiddenTitle(draw)]);
  if (draw === undefined) return partTitle(layer, parts);

  const label = drawLabel(draw, layer);
  const smooth = smoothed === true && draw === "dots";

  return titled(layer, smooth ? [label, "smoothed"] : [label]);
}

function partTitle(layer: TitledLayer, parts: readonly string[] | undefined): string {
  if (parts === undefined) return layer.title;

  return titled(layer, parts.length === 0 ? ["off"] : parts);
}

/** Join a layer title and its states, each state starting with a capital as titles always do. */
function titled(layer: TitledLayer, states: readonly string[]): string {
  const capitalised = states.map((state) => state.charAt(0).toUpperCase() + state.slice(1));

  return `${layer.title} · ${capitalised.join(", ")}`;
}

function hiddenTitle({ hidden }: Hidden): string {
  return hidden === ONLY_IN_COLOUR ? "hidden" : `hidden (${hidden})`;
}

function isTemperature({ title, units }: TitledLayer): boolean {
  return /temperature/i.test(title) || /°c|degc/i.test(units);
}
