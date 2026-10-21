/** Build layer controls and popovers for palette choices and display settings. */
import { makeHtmlElement } from "../html";
import {
  customColors,
  customPalette,
  fieldGradient,
  MAX_CUSTOM_COLORS,
  MIN_CUSTOM_COLORS,
  rgbToHex,
} from "../render/palettes";
import type { InkMenu, LayerControl, LayerMenu, PaletteChoice, RangeMenu } from "../types";

const MENU_GAP_PX = 8;

/** The note a menu shows while its layer draws a fallback, since the palette is not visible. */
export const FALLBACK_PALETTE_NOTE = "Colours apply while this layer holds colour.";
/** The note shown when Presets is open while the map still uses a custom palette. */
export const CUSTOM_PALETTE_NOTE = "The map currently shows custom colours.";
/** The note shown when Presets is open while the map still uses a custom ink. */
export const CUSTOM_INK_NOTE = "The map currently shows a custom ink.";

/** What a menu change touched, so the caller can remember a palette or ink but not a range. */
export type MenuChange = "palette" | "range" | "ink";

interface MenuModes {
  customPalette: boolean;
  customInk: boolean;
}

let menuCount = 0;
const menuModes = new WeakMap<LayerMenu, MenuModes>();

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

/**
 * Build an Edit button and a popover that refreshes whenever it opens.
 * Apply changes immediately and notify the caller through onChange.
 */
export function layerMenu(menu: LayerMenu, onChange: (changed: MenuChange) => void) {
  const popover = makeHtmlElement("div");
  popover.className = "layer-menu";
  popover.popover = "auto";
  popover.role = "dialog";
  popover.ariaLabel = menu.title;

  const button = makeHtmlElement("button", "Edit");
  button.className = "edit-button";
  button.type = "button";
  button.ariaLabel = `Edit ${menu.title} display`;
  button.ariaHasPopup = "dialog";
  button.ariaExpanded = "false";
  button.popoverTargetElement = popover;

  const group = `palette-${menuCount++}`;
  const fill = () => {
    popover.replaceChildren(...menuSections(menu, group, onChange, fill, popover));
  };
  menu.updates?.addEventListener("change", () => {
    if (popover.matches(":popover-open")) fill();
  });
  const place = () => placeBesideColumn(popover, button);
  // The custom colour editor changes the menu's height while it is open.
  const resizeObserver = new ResizeObserver(place);

  popover.addEventListener("beforetoggle", (event) => {
    if ((event as ToggleEvent).newState !== "open") return;

    fill();
    place();
  });
  popover.addEventListener("toggle", (event) => {
    const isOpen = (event as ToggleEvent).newState === "open";
    button.ariaExpanded = String(isOpen);
    if (!isOpen) {
      resizeObserver.disconnect();
      window.removeEventListener("resize", place);
      return;
    }

    place();
    resizeObserver.observe(popover);
    window.addEventListener("resize", place);
    popover.querySelector("input")?.focus();
  });

  return { button, popover };
}

/** The menu's head, one colour section chosen by how the layer is drawn, and its other controls. */
export function menuSections(
  menu: LayerMenu,
  group: string,
  onChange: (changed: MenuChange) => void,
  refill: () => void,
  popover: HTMLElement,
) {
  const head = makeHtmlElement("div");
  head.className = "menu-head";
  makeHtmlElement("strong", menu.title, head);
  const close = makeHtmlElement("button", "✕", head);
  close.type = "button";
  close.ariaLabel = "Close";
  close.onclick = () => popover.hidePopover();
  const reset = resetButton(menu, onChange, refill);

  return [
    head,
    menu.ink?.inUse ? inkSection(menu, group, onChange) : paletteSection(menu, group, onChange),
    ...edgesSection(menu),
    ...rangeSection(menu.range, onChange),
    reset,
  ];
}

function resetButton(menu: LayerMenu, onChange: (changed: MenuChange) => void, refill: () => void) {
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
    onChange("palette");
    if (menu.ink) onChange("ink");
    refill();
  };
  reset.onclick = () => {
    const isDefault = menu.palette === menu.defaultPalette
      && !menu.range?.value
      && (menu.edges?.isDefault ?? true)
      && (menu.ink === undefined || menu.ink.value === menu.ink.defaultInk);
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

function rangeSection(range: RangeMenu | undefined, onChange: (changed: MenuChange) => void) {
  if (!range) return [];

  const section = makeHtmlElement("fieldset");
  const legend = makeHtmlElement("legend", `Display range (${range.units})`, section);
  const low = numberInput("Low", range);
  const high = numberInput("High", range);
  const show = ([first, second]: [number, number]) => {
    low.value = String(first);
    high.value = String(second);
  };
  show(range.value ?? range.fitted);

  const apply = () => {
    const next = typedRange(low, high, range);
    if (!next) return show(range.value ?? range.fitted);

    range.set(next);
    show(next);
    fitted.disabled = false;
    onChange("range");
  };
  low.onchange = apply;
  high.onchange = apply;

  const fitted = makeHtmlElement("button", "Reset", legend);
  fitted.type = "button";
  fitted.className = "range-reset";
  fitted.ariaLabel = "Reset to this area's range";
  fitted.disabled = !range.value;
  fitted.onclick = () => {
    range.set(null);
    show(range.fitted);
    fitted.disabled = true;
    onChange("range");
  };

  const note = makeHtmlElement("div", "Values outside the range take the end colour.");
  note.className = "option-note";
  section.append(labelled("Low", low), labelled("High", high), note);
  return [section];
}

function askBeforeReset(trigger: HTMLButtonElement, message: string, reset: () => void) {
  const popover = trigger.closest(".layer-menu");
  popover?.querySelector(".reset-warning")?.remove();

  const panel = makeHtmlElement("div");
  panel.className = "reset-warning";
  panel.role = "alertdialog";
  panel.ariaLabel = "Confirm reset";
  makeHtmlElement("div", message, panel);

  const confirm = makeHtmlElement("button", "Reset", panel);
  confirm.type = "button";
  const cancel = makeHtmlElement("button", "Cancel", panel);
  cancel.type = "button";

  const close = () => {
    panel.remove();
    if (trigger.isConnected && !trigger.disabled) trigger.focus();
  };
  confirm.onclick = () => {
    reset();
    close();
  };
  cancel.onclick = close;

  trigger.after(panel);
  cancel.focus();
}

function numberInput(label: string, { decimals }: RangeMenu) {
  const input = document.createElement("input");
  input.type = "number";
  input.ariaLabel = label;
  input.step = String(10 ** -decimals);
  return input;
}

function labelled(text: string, input: HTMLInputElement) {
  const row = makeHtmlElement("label", `${text} `);
  row.append(input);
  return row;
}

function gradientCss(colors: string[]) {
  return `linear-gradient(to right, ${colors.join(", ")})`;
}

function typedRange(low: HTMLInputElement, high: HTMLInputElement, range: RangeMenu) {
  const rounded = (text: string) => Number(Number(text).toFixed(range.decimals));
  if (!low.value || !high.value) return null;

  const next: [number, number] = [rounded(low.value), rounded(high.value)];
  return Number.isFinite(next[0]) && Number.isFinite(next[1]) && next[0] < next[1] ? next : null;
}

// The menu sits beside the column so it never covers the layers it edits.
function placeBesideColumn(popover: HTMLElement, button: HTMLElement) {
  const column = button.closest("#scene-column")?.getBoundingClientRect();
  const anchor = button.getBoundingClientRect();
  const room = window.innerHeight - popover.offsetHeight - MENU_GAP_PX;

  popover.style.right = `${window.innerWidth - (column?.left ?? anchor.left) + MENU_GAP_PX}px`;
  popover.style.top = `${Math.max(MENU_GAP_PX, Math.min(anchor.top, room))}px`;
}
