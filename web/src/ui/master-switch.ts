/** Decide what one master switch shows and which link units it changes. */
import { layerUnits } from "../display-state";
import type { LayerDoc } from "../types";

/** Whether any part of the layer is still on, which is what the switch shows. */
export function isMasterOn(layer: LayerDoc, off: ReadonlySet<string>): boolean {
  return layerUnits(layer).some((unit) => !off.has(unit));
}

/**
 * List the units a master switch turns on or off.
 * Turning off changes every unit that is still on, while turning on restores
 * the parts the switch itself switched off, or the main part when it kept none.
 */
export function masterChangedUnits(
  layer: LayerDoc,
  off: ReadonlySet<string>,
  remembered: readonly string[] | undefined,
  on: boolean,
): string[] {
  if (on) return [...(remembered ?? [layer.id])];

  return layerUnits(layer).filter((unit) => !off.has(unit));
}
