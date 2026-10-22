/** Build the layer controls that the editor panel mounts around the Show as section. */
import { makeHtmlElement } from "../html";
import {
  customColors,
  customPalette,
  fieldGradient,
  MAX_CUSTOM_COLORS,
  MIN_CUSTOM_COLORS,
  rgbToHex,
} from "../render/palettes";
import type { InkMenu, LayerControl, LayerMenu, PaletteChoice } from "../types";

/** The note a menu shows while its layer draws a fallback, since the palette is not visible. */
export const FALLBACK_PALETTE_NOTE = "Colours apply while this layer holds colour.";
/** The note shown when Presets is open while the map still uses a custom palette. */
export const CUSTOM_PALETTE_NOTE = "The map currently shows custom colours.";
/** The note shown when Presets is open while the map still uses a custom ink. */
export const CUSTOM_INK_NOTE = "The map currently shows a custom ink.";

/** What a menu change touched, so the caller can remember a palette or ink but not a range. */
export type MenuChange = "palette" | "range" | "ink" | "reset";

interface MenuModes {
  customPalette: boolean;
  customInk: boolean;
}

const menuModes = new WeakMap<LayerMenu, MenuModes>();

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

/** The colour and edge sections, while the display range lives in a React component. */
export function menuMainSections(
  menu: LayerMenu,
  group: string,
  onChange: (changed: MenuChange) => void,
) {
  return [
    menu.ink?.inUse ? inkSection(menu, group, onChange) : paletteSection(menu, group, onChange),
    ...edgesSection(menu),
  ];
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
    const modes = modesOf(menu);
    modes.customPalette = false;
    modes.customInk = false;
    menu.setPalette(menu.defaultPalette);
    menu.range?.set(null);
    menu.edges?.reset();
    if (menu.ink) menu.ink.set(menu.ink.defaultInk);
    menu.resetDensity?.();
    onChange("palette");
    if (menu.ink) onChange("ink");
    onChange("reset");
    refill();
  };
  reset.onclick = () => {
    const isDefault = menu.palette === menu.defaultPalette
      && !menu.range?.value
      && (menu.edges?.isDefault ?? true)
      && (menu.ink === undefined || menu.ink.value === menu.ink.defaultInk)
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

function paletteSection(
  menu: LayerMenu,
  group: string,
  onChange: (changed: MenuChange) => void,
) {
  const section = makeHtmlElement("fieldset");
  makeHtmlElement("legend", menu.heading, section);
  if (menu.paletteNote) makeHtmlElement("div", menu.paletteNote, section).className = "option-note";

  if (!menu.custom) {
    section.append(...palettePresets(menu, group, onChange));
    return section;
  }

  const modes = modesOf(menu);
  const body = makeHtmlElement("div");
  const note = optionNote("");
  const updateNote = () => {
    note.textContent = !modes.customPalette && customColors(menu.palette) !== null
      ? CUSTOM_PALETTE_NOTE
      : "";
    note.hidden = !note.textContent;
  };
  const show = (isCustom: boolean) => {
    const choices = isCustom
      ? [customColorsBox(menu, onChange)]
      : palettePresets(menu, group, onChange, updateNote);
    body.replaceChildren(...choices, note);
    updateNote();
  };
  const choose = (isCustom: boolean) => {
    modes.customPalette = isCustom;
    // Starting from the gradient on screen keeps the first custom colours familiar.
    if (isCustom && customColors(menu.palette) === null) {
      menu.setPalette(customPalette(seedColors(menu.palette)));
      onChange("palette");
    }
    show(isCustom);
  };
  show(modes.customPalette);
  section.append(modeSwitch(group, modes.customPalette, choose), body);
  return section;
}

function palettePresets(
  menu: LayerMenu,
  group: string,
  onChange: (changed: MenuChange) => void,
  onPicked?: () => void,
) {
  return presetRows(
    group,
    menu.palettes,
    { current: menu.palette, fallback: menu.defaultPalette, blocks: menu.blocks },
    (name) => {
      menu.setPalette(name);
      onChange("palette");
      onPicked?.();
    },
  );
}

function inkSection(menu: LayerMenu, group: string, onChange: (changed: MenuChange) => void) {
  const ink = menu.ink!;
  const section = makeHtmlElement("fieldset");
  makeHtmlElement("legend", ink.heading, section);

  const modes = modesOf(menu);
  const body = makeHtmlElement("div");
  const note = optionNote("");
  const updateNote = () => {
    note.textContent = !modes.customInk && isCustomInk(ink) ? CUSTOM_INK_NOTE : "";
    note.hidden = !note.textContent;
  };
  const show = (isCustom: boolean) => {
    const choices = isCustom
      ? [inkInput(ink, onChange)]
      : inkPresets(ink, group, onChange, updateNote);
    body.replaceChildren(...choices, note);
    updateNote();
  };
  const choose = (isCustom: boolean) => {
    modes.customInk = isCustom;
    if (isCustom && !isCustomInk(ink)) {
      ink.set(ink.presets.find(({ name }) => name === ink.value)!.colors[0]);
      onChange("ink");
    }
    show(isCustom);
  };
  show(modes.customInk);
  section.append(modeSwitch(group, modes.customInk, choose), body);
  return section;
}

function inkPresets(
  ink: InkMenu,
  group: string,
  onChange: (changed: MenuChange) => void,
  onPicked?: () => void,
) {
  return presetRows(
    group,
    ink.presets,
    { current: ink.value, fallback: ink.defaultInk, blocks: true },
    (name) => {
      ink.set(name);
      onChange("ink");
      onPicked?.();
    },
  );
}

function inkInput(ink: InkMenu, onChange: (changed: MenuChange) => void) {
  const input = document.createElement("input");
  input.type = "color";
  input.value = ink.value;
  input.ariaLabel = "Ink colour";
  // The picker fires input continuously while dragging, which would repaint and save each time.
  input.onchange = () => {
    ink.set(input.value);
    onChange("ink");
  };
  return input;
}

function isCustomInk(ink: InkMenu) {
  return ink.value.startsWith("#");
}

function modesOf(menu: LayerMenu): MenuModes {
  const existing = menuModes.get(menu);
  if (existing) return existing;

  const modes = {
    customPalette: customColors(menu.palette) !== null,
    customInk: menu.ink !== undefined && isCustomInk(menu.ink),
  };
  menuModes.set(menu, modes);
  return modes;
}

function optionNote(text: string) {
  const note = makeHtmlElement("div", text);
  note.className = "option-note";
  return note;
}

/** The Presets and Custom switch above a menu section's choices. */
function modeSwitch(group: string, isCustom: boolean, onMode: (isCustom: boolean) => void) {
  const row = makeHtmlElement("div");
  row.className = "mode-switch";
  for (const [label, mode] of [["Presets", false], ["Custom", true]] as const) {
    const choice = paletteRadio(`${group}-mode`, label, label, mode === isCustom);
    choice.input.onchange = () => onMode(mode);
    row.append(choice.row);
  }
  return row;
}

function presetRows(
  group: string,
  choices: PaletteChoice[],
  { current, fallback, blocks }: { current: string; fallback: string; blocks: boolean },
  pick: (name: string) => void,
) {
  return choices.map(({ name, label, colors }) => {
    const suffix = name === fallback ? " (default)" : "";
    const choice = paletteRadio(group, name, label + suffix, current === name);
    choice.input.onchange = () => pick(name);
    choice.input.after(swatch(colors, blocks));
    return choice.row;
  });
}

function paletteRadio(group: string, name: string, label: string, isChecked: boolean) {
  const row = makeHtmlElement("label");
  row.className = "palette-choice";
  const input = document.createElement("input");
  input.type = "radio";
  input.name = group;
  input.value = name;
  input.checked = isChecked;
  row.append(input, label);
  return { row, input };
}

function swatch(colors: string[], blocks: boolean) {
  const element = makeHtmlElement("span");
  element.className = blocks ? "swatch swatch-blocks" : "swatch";
  if (!blocks) {
    element.style.background = gradientCss(colors);
    return element;
  }

  for (const color of colors) {
    makeHtmlElement("span", "", element).style.background = color;
  }
  return element;
}

function customColorsBox(menu: LayerMenu, onChange: (changed: MenuChange) => void) {
  const colors = customColors(menu.palette)!;
  const preview = swatch(colors, false);
  const box = makeHtmlElement("div");
  box.className = "custom-colors";

  const apply = () => {
    menu.setPalette(customPalette(colors));
    preview.style.background = gradientCss(colors);
    onChange("palette");
  };
  const refresh = () => box.replaceChildren(preview, ...colorInputs(colors, apply, refresh));
  refresh();

  return box;
}

function seedColors(palette: string) {
  const gradient = fieldGradient(palette) ?? [[0, 0, 0], [255, 255, 255]];
  const middle = Math.floor((gradient.length - 1) / 2);
  return [gradient[0], gradient[middle], gradient[gradient.length - 1]].map(rgbToHex);
}

// The colours are edited in place so that every input handler sees the others' latest values.
function colorInputs(colors: string[], changed: () => void, rebuild: () => void) {
  const rows: HTMLElement[] = colors.map((color, index) => {
    const row = makeHtmlElement("div");
    const input = document.createElement("input");
    input.type = "color";
    input.value = color;
    input.ariaLabel = `Colour ${index + 1}`;
    // The picker fires input continuously while dragging, which would repaint and save each time.
    input.onchange = () => {
      colors[index] = input.value;
      changed();
    };
    row.append(input);

    if (colors.length > MIN_CUSTOM_COLORS) {
      const remove = makeHtmlElement("button", "✕", row);
      remove.type = "button";
      remove.ariaLabel = `Remove colour ${index + 1}`;
      remove.onclick = () => {
        colors.splice(index, 1);
        changed();
        rebuild();
      };
    }
    return row;
  });

  if (colors.length < MAX_CUSTOM_COLORS) {
    const add = makeHtmlElement("button", "Add colour");
    add.type = "button";
    add.onclick = () => {
      colors.push(colors[colors.length - 1]);
      changed();
      rebuild();
    };
    rows.push(add);
  }
  return rows;
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

function gradientCss(colors: string[]) {
  return `linear-gradient(to right, ${colors.join(", ")})`;
}
