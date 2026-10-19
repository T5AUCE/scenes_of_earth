import { makeHtmlElement } from "../html";
import type { LayerControl } from "../types";

/** A collapsed "Display" section with one slider per control. */
export function layerMenu(controls: LayerControl[]) {
  const menu = makeHtmlElement("details");
  menu.className = "layer-menu";
  makeHtmlElement("summary", "Display", menu);

  for (const control of controls) menu.append(sliderRow(control));
  return menu;
}

function sliderRow({ label, min, max, step, value, set }: LayerControl) {
  const row = makeHtmlElement("label", `${label} `);
  const slider = document.createElement("input");
  slider.type = "range";
  slider.min = String(min);
  slider.max = String(max);
  slider.step = String(step);
  slider.value = String(value);
  slider.oninput = () => set(Number(slider.value));

  row.append(slider);
  return row;
}
