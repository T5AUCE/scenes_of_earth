/** Build the layer controls that the editor panel mounts around the colour section. */
import { makeHtmlElement } from "../html";
import type { LayerControl, LayerMenu } from "../types";

/** The note a menu shows while its layer draws a fallback, since the palette is not visible. */
export const FALLBACK_PALETTE_NOTE = "Colours apply while this layer holds colour.";

/** What a menu change touched; the caller remembers a palette, ink or unit, not a range. */
export type MenuChange = "palette" | "range" | "ink" | "units" | "reset";

/** The sliders for one part and the teardown that drops their menu listeners. */
export interface PartControls {
  element: HTMLElement;
  dispose(): void;
}

/**
 * Build the sliders shown directly under a part's checkbox, labelled for screen readers only.
 * A slider hides while its control reports that it does not apply.
 */
export function partControls(controls: LayerControl[]): PartControls {
  const box = makeHtmlElement("div");
  box.className = "part-controls";
  const cleanups: Array<() => void> = [];
  for (const control of controls) {
    const hint = control.hint ? makeHtmlElement("div", control.hint, box) : null;
    if (hint) hint.className = "control-hint";
    const input = slider(control);
    box.append(input);
    cleanups.push(keepInSync(control, [hint, input], input));
  }

  return {
    element: box,
    dispose: () => {
      for (const cleanup of cleanups) cleanup();
    },
  };
}

function keepInSync(
  control: LayerControl,
  elements: (HTMLElement | null)[],
  input: HTMLInputElement,
): () => void {
  const sync = () => {
    for (const element of elements) {
      if (element) element.hidden = control.isShown === false;
    }
    input.value = String(control.value);
  };
  control.updates?.addEventListener("change", sync);
  sync();

  return () => {
    control.updates?.removeEventListener("change", sync);
  };
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

/** The edge sections, while colours live in a React section above them. */
export function menuMainSections(menu: LayerMenu) {
  return [...edgesSection(menu)];
}

/** The reset control, kept separate so the React range can sit before it. */
export function menuResetButton(
  menu: LayerMenu,
  onChange: (changed: MenuChange) => void,
  refill: () => void,
) {
  const reset = makeHtmlElement("button", "Reset layer");
  reset.type = "button";
  reset.className = "menu-reset";
  const resetLayer = () => {
    menu.setPalette(menu.defaultPalette);
    menu.range?.set(null);
    menu.edges?.reset();
    if (menu.ink) menu.ink.set(menu.ink.defaultInk);
    if (menu.units) menu.units.set(menu.units.defaultUnit);
    menu.resetDensity?.();
    onChange("palette");
    if (menu.ink) onChange("ink");
    if (menu.units) onChange("units");
    onChange("reset");
    refill();
  };
  reset.onclick = () => {
    const isDefault = menu.palette === menu.defaultPalette
      && !menu.range?.value
      && (menu.edges?.isDefault ?? true)
      && (menu.ink === undefined || menu.ink.value === menu.ink.defaultInk)
      && (menu.units === undefined || menu.units.value === menu.units.defaultUnit)
      && (menu.isDensityDefault ?? true);
    if (isDefault) return resetLayer();

    askBeforeReset(
      reset,
      "This layer's display settings will return to their defaults.",
      resetLayer,
    );
  };

  return reset;
}

function edgesSection(menu: LayerMenu) {
  if (menu.edgesNote) {
    const note = makeHtmlElement("div", menu.edgesNote);
    note.className = "option-note";
    return [note];
  }
  const edges = menu.edges;
  if (!edges) return [];

  const section = makeHtmlElement("fieldset");
  makeHtmlElement("legend", "Edges", section);
  for (const control of edges.controls) section.append(edgeSlider(control));
  const outline = document.createElement("input");
  outline.type = "checkbox";
  outline.checked = edges.outline.value;
  outline.onchange = () => edges.outline.set(outline.checked);
  section.append(labelled("Faint outline", outline));
  return [section];
}

function edgeSlider(control: LayerControl) {
  const row = makeHtmlElement("label");
  row.className = "edge-control";
  makeHtmlElement("span", control.label, row);
  const value = makeHtmlElement("output", "", row);
  const show = (number: number) => {
    value.value = `${number}${control.unit ? ` ${control.unit}` : ""}`;
  };
  const input = slider(control);
  input.oninput = () => {
    const number = Number(input.value);
    control.set(number);
    show(number);
  };
  show(control.value);
  row.append(input);
  return row;
}

function askBeforeReset(trigger: HTMLButtonElement, message: string, reset: () => void) {
  const panel = trigger.closest(".layer-editor");
  panel?.querySelector(".reset-warning")?.remove();

  const warning = makeHtmlElement("div");
  warning.className = "reset-warning";
  warning.role = "alertdialog";
  warning.ariaLabel = "Confirm reset";
  makeHtmlElement("div", message, warning);

  const confirm = makeHtmlElement("button", "Reset", warning);
  confirm.type = "button";
  const cancel = makeHtmlElement("button", "Cancel", warning);
  cancel.type = "button";

  const close = () => {
    warning.remove();
    if (trigger.isConnected && !trigger.disabled) trigger.focus();
  };
  confirm.onclick = () => {
    reset();
    close();
  };
  cancel.onclick = close;

  trigger.after(warning);
  cancel.focus();
}

function labelled(text: string, input: HTMLInputElement) {
  const row = makeHtmlElement("label", `${text} `);
  row.append(input);
  return row;
}
