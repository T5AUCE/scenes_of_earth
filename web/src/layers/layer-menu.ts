import { makeHtmlElement } from "../html";
import {
  customColors,
  customPalette,
  fieldGradient,
  MAX_CUSTOM_COLORS,
  MIN_CUSTOM_COLORS,
  rgbToHex,
} from "../render/palettes";
import type { LayerControl, LayerMenu, RangeMenu } from "../types";

const MENU_GAP_PX = 8;

/** What a menu change touched, so the caller can remember a palette but not a range. */
export type MenuChange = "palette" | "range";

let menuCount = 0;

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
 * An Edit button and the popover it opens. The popover is filled each time it opens, applies every
 * change at once and calls onChange so the caller can record it.
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

function menuSections(
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

  const reset = makeHtmlElement("button", "Reset layer");
  reset.type = "button";
  reset.className = "menu-reset";
  const resetLayer = () => {
    menu.setPalette(menu.defaultPalette);
    menu.range?.set(null);
    onChange("palette");
    refill();
  };
  reset.onclick = () => {
    const isDefault = menu.palette === menu.defaultPalette && !menu.range?.value;
    if (isDefault) return resetLayer();

    askBeforeReset(
      reset,
      "This layer's colours and range return to their defaults.",
      resetLayer,
    );
  };

  return [
    head,
    paletteSection(menu, group, onChange),
    ...rangeSection(menu.range, onChange),
    reset,
  ];
}

function paletteSection(
  menu: LayerMenu,
  group: string,
  onChange: (changed: MenuChange) => void,
) {
  const section = makeHtmlElement("fieldset");
  makeHtmlElement("legend", menu.heading, section);

  for (const { name, label, colors } of menu.palettes) {
    const suffix = name === menu.defaultPalette ? " (default)" : "";
    const choice = paletteRadio(group, name, label + suffix, menu.palette === name);
    choice.input.onchange = () => {
      menu.setPalette(name);
      onChange("palette");
      editor?.refresh();
    };
    choice.input.after(swatch(colors, menu.blocks));
    section.append(choice.row);
  }

  const editor = menu.custom ? customEditor(menu, group, onChange) : null;
  if (editor) section.append(editor.row, editor.box);
  return section;
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

function gradientCss(colors: string[]) {
  return `linear-gradient(to right, ${colors.join(", ")})`;
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

function customEditor(
  menu: LayerMenu,
  group: string,
  onChange: (changed: MenuChange) => void,
) {
  const colors = customColors(menu.palette) ?? seedColors(menu.palette);
  const choice = paletteRadio(group, "custom", "Custom", customColors(menu.palette) !== null);
  const preview = swatch(colors, false);
  choice.input.after(preview);
  const box = makeHtmlElement("div");
  box.className = "custom-colors";

  const apply = () => {
    menu.setPalette(customPalette(colors));
    preview.style.background = gradientCss(colors);
    onChange("palette");
  };
  const refresh = () => {
    box.hidden = !choice.input.checked;
    box.replaceChildren(...colorInputs(colors, apply, refresh));
  };
  choice.input.onchange = () => {
    // Starting from the gradient on screen keeps the first custom colours familiar.
    if (customColors(menu.palette) === null) {
      colors.splice(0, colors.length, ...seedColors(menu.palette));
    }
    apply();
    refresh();
  };
  refresh();

  return { row: choice.row, box, refresh };
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
  makeHtmlElement("legend", `Display range (${range.units})`, section);
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

  const fitted = makeHtmlElement("button", "Reset to area's range");
  fitted.type = "button";
  fitted.disabled = !range.value;
  fitted.onclick = () => {
    range.set(null);
    show(range.fitted);
    fitted.disabled = true;
    onChange("range");
  };

  const note = makeHtmlElement("div", "Values outside the range take the end colour.");
  note.className = "option-note";
  section.append(labelled("Low", low), labelled("High", high), fitted, note);
  return [section];
}

/** Shows a warning after the trigger until the user resets or cancels. */
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
