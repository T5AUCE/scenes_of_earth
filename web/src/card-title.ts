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
}

type TitledLayer = Pick<LayerDoc, "title" | "units">;

const SHOW_AS_LABELS: Record<Draw, string> = {
  colour: "Colour",
  dots: "Dots",
  isolines: "Lines",
  contours: "Contours",
  shade: "Relief",
};

/** The label of a Show as radio, which stays layer-agnostic while the title says isotherms. */
export function showAsLabel(draw: Draw): string {
  return SHOW_AS_LABELS[draw];
}

/** The word a card title uses for a draw. */
export function drawLabel(draw: Draw, layer: TitledLayer): string {
  if (draw === "isolines") return isTemperature(layer) ? "isotherms" : "lines";

  return draw === "shade" ? "relief" : draw;
}

/** A card title such as "Rainfall · dots, smoothed" or "Land cover · hidden while...". */
export function cardTitle(layer: TitledLayer, { draw, off, smoothed }: CardTitleState): string {
  if (off) return `${layer.title} · off`;
  if (typeof draw === "object") return `${layer.title} · ${hiddenTitle(draw)}`;
  if (draw === undefined) return layer.title;

  const label = drawLabel(draw, layer);
  const suffix = smoothed === true && draw === "dots" ? ", smoothed" : "";

  return `${layer.title} · ${label}${suffix}`;
}

function hiddenTitle({ hidden }: Hidden): string {
  return hidden === ONLY_IN_COLOUR
    ? "hidden while another layer uses colour"
    : `hidden (${hidden})`;
}

function isTemperature({ title, units }: TitledLayer): boolean {
  return /temperature/i.test(title) || /°c|degc/i.test(units);
}
