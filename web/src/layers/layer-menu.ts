import { makeHtmlElement } from "../html";
import type { LayerControl } from "../types";

/** Builds the sliders shown directly under a part's checkbox, labelled for screen readers only. */
export function partControls(controls: LayerControl[]) {
  const box = makeHtmlElement("div");
  box.className = "part-controls";
  for (const control of controls) {
    if (control.hint) makeHtmlElement("div", control.hint, box).className = "control-hint";
    box.append(slider(control));
  }
  return box;
}

function slider({ label, min, max, step, value, set }: LayerControl) {
  const input = document.createElement("input");
  input.type = "range";
  input.ariaLabel = label;
  input.title = label;
  input.min = String(min);
  input.max = String(max);
  input.step = String(step);
  input.value = String(value);
  input.oninput = () => set(Number(input.value));
  return input;
}
