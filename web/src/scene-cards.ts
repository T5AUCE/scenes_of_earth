/**
 * Build the scene's control cards and coordinate which unit owns the colour.
 * Each card lets the viewer toggle a layer's parts and change its options, while
 * the colour picker follows the same colour actions so the cards, the blend and the map stay
 * in step. Scene mounting and teardown remain in the view module.
 */
import type { Map as MapLibreMap } from "maplibre-gl";

import {
  applyColourAction,
  type ColourAction,
  layerUnits,
  recordMenuChange,
  shouldStorePick,
  storePick,
  type SceneDisplay,
} from "./display-state";
import { makeHtmlElement } from "./html";
import {
  allocate,
  BLEND,
  type Draw,
  type Hidden,
  layerDraws,
} from "./layers/allocate";
import { BLEND_TITLE, type BlendView } from "./layers/blend";
import { layerMenu, partControls, type MenuChange } from "./layers/layer-menu";
import type { LayerDoc, LayerView, Part } from "./types";

/** A layer's view with the layer it draws. */
export interface MountedLayer {
  layer: LayerDoc;
  view: LayerView;
}

type Draws = Map<string, Draw | Hidden>;

interface LayerCard {
  element: HTMLElement;
  show(draws: Draws, on: ReadonlySet<string>): void;
}

/** Build the scene's cards and keep their colour choices applied to the map. */
export function mountCards(
  map: MapLibreMap,
  mounted: MountedLayer[],
  display: SceneDisplay,
  box: HTMLElement,
  changed: () => void,
  blend: BlendView | null,
) {
  const layerDocs = mounted.map(({ layer }) => layer);
  const units = layerDocs.flatMap(layerUnits);
  const colourDocs = layerDocs.filter((layer) => layerDraws(layer).colour);
  const hasChoice = colourDocs.length >= 2;
  const picker = colourPicker(colourDocs, blend !== null, (unit) => act({ kind: "pick", unit }));
  const menuChanged = () => {
    blend?.restyle();
    changed();
  };
  const cards = mounted.map((layer) => layerCard(layer, display, act, menuChanged));
  const blendCard = blend && blendCardFor(blend, (on) => act({ kind: "toggle", unit: BLEND, on }));
  const shown = new Map<LayerView, Draw | null>();
  let isUnderColour: boolean | null = null;

  box.append(picker.row, ...cards.map(({ element }) => element));
  if (blendCard) cards[lastFieldIndex(mounted)].element.after(blendCard.element);
  mounted.forEach(({ view }) => view.blocked?.changes.addEventListener("change", refresh));
  refresh();

  function act(action: ColourAction) {
    const state = { pick: display.colour, off: display.off };
    const next = applyColourAction(state, action, layerDocs);
    if (shouldStorePick(display.colour, action, next.pick)) storePick(next.pick);
    display.colour = next.pick;
    display.off = new Set(next.off);
    refresh();
    changed();
  }

  function refresh() {
    const on = new Set(units.filter((unit) => !display.off.has(unit)));
    const { owner, draws } = allocate(layerDocs, on, display.colour, blockedFallbacks(mounted));

    picker.show(owner, hasChoice);
    cards.forEach((card) => card.show(draws, on));
    mounted.forEach(({ view }) => drawView(map, view, on, draws, shown));
    if (blend && blendCard) {
      blendCard.show(owner === BLEND);
      drawBlend(blend, draws, shown);
    }

    const isUnder = owner !== null;
    if (isUnder === isUnderColour) return;

    isUnderColour = isUnder;
    mounted.forEach(({ view }) => view.setColourUnder?.(isUnder));
  }
}

function colourPicker(layers: LayerDoc[], hasBlend: boolean, onPick: (unit: string) => void) {
  const row = makeHtmlElement("label");
  row.className = "colour-picker";
  makeHtmlElement("span", "Colour layer", row);
  const select = document.createElement("select");
  for (const { id, title } of layers) {
    const option = makeHtmlElement("option", title, select) as HTMLOptionElement;
    option.value = id;
  }
  if (hasBlend) {
    const option = makeHtmlElement("option", BLEND_TITLE, select) as HTMLOptionElement;
    option.value = BLEND;
  }
  select.onchange = () => onPick(select.value);
  row.append(select);

  return {
    row,
    show(owner: string | null, isVisible: boolean) {
      row.hidden = !isVisible;
      select.value = owner ?? "";
    },
  };
}

function layerCard(
  { layer, view }: MountedLayer,
  display: SceneDisplay,
  act: (action: ColourAction) => void,
  changed: () => void,
): LayerCard {
  const card = makeHtmlElement("section");
  card.className = "card";
  card.setAttribute("aria-label", layer.title);
  const checks = new Map<string, HTMLInputElement>();
  const slidersByPart = new Map<string, HTMLElement>();
  const reasons = new Map<string, HTMLElement>();
  view.parts.forEach(addPart);
  const legend = view.legend();
  if (legend) card.append(legend);

  return {
    element: card,
    show(draws, on) {
      for (const part of view.parts) {
        const isOn = on.has(part.id);
        checks.get(part.id)!.checked = isOn;
        const sliders = slidersByPart.get(part.id);
        if (sliders) sliders.hidden = !isOn;
        const reason = reasons.get(part.id);
        if (reason) reason.textContent = isOn ? hiddenReason(draws.get(part.id)) : "";
      }
    },
  };

  function addPart(part: Part, index: number) {
    const sliders = part.controls ? partControls(part.controls) : null;
    const row = makeHtmlElement("div", "", card);
    row.className = "check-row";
    const label = checkbox(part.label, !display.off.has(part.id), (isOn) => {
      act({ kind: "toggle", unit: part.id, on: isOn });
    });
    checks.set(part.id, label.querySelector("input")!);
    row.append(label);
    const reason = makeHtmlElement("div", "", card);
    reason.className = "option-note";
    reasons.set(part.id, reason);
    if (index === 0) {
      addFirstPartExtras(view, row, card, display, changed);
    }
    if (sliders) {
      slidersByPart.set(part.id, sliders);
      card.append(sliders);
    }
    if (part.note) {
      part.note.classList.add("option-note");
      card.append(part.note);
    }
  }
}

function lastFieldIndex(mounted: MountedLayer[]) {
  return mounted.map(({ layer }) => layer.style.kind).lastIndexOf("field");
}

function blendCardFor(blend: BlendView, onToggle: (on: boolean) => void) {
  const card = makeHtmlElement("section");
  card.className = "card";
  card.setAttribute("aria-label", BLEND_TITLE);
  const [part] = blend.parts;
  const row = makeHtmlElement("div", "", card);
  row.className = "check-row";
  const label = checkbox(part.label, false, onToggle);
  const check = label.querySelector("input")!;
  row.append(label);
  addOptions(blend, row, card);
  card.append(part.note!, blend.legend()!);

  return {
    element: card,
    show(isOwner: boolean) {
      check.checked = isOwner;
      blend.legend()!.hidden = !isOwner;
    },
  };
}

function hiddenReason(draw: Draw | Hidden | undefined) {
  return typeof draw === "object" ? draw.hidden : "";
}

function addFirstPartExtras(
  view: LayerView,
  row: HTMLElement,
  card: HTMLElement,
  display: SceneDisplay,
  changed: () => void,
) {
  addOptions(view, row, card);

  if (view.menu) {
    const { button, popover } = layerMenu(
      view.menu,
      (change) => menuChanged(view, display, change, changed),
    );
    row.append(button);
    card.append(popover);
  }
}

function addOptions(view: LayerView, row: HTMLElement, card: HTMLElement) {
  if (view.options.length === 0) return;

  if (!view.time) row.classList.add("inline-options");
  const options = makeHtmlElement("span", "", row);
  options.className = "option-checks";
  for (const { label, initial, set } of view.options) {
    options.append(checkbox(label, initial ?? false, set));
  }
  for (const { note } of view.options) {
    if (note) makeHtmlElement("div", note, card).className = "option-note";
  }
}

function menuChanged(
  view: LayerView,
  display: SceneDisplay,
  change: MenuChange,
  changed: () => void,
) {
  recordMenuChange(display, view.parts[0].id, view.menu!, change);
  changed();
}

function blockedFallbacks(mounted: MountedLayer[]) {
  const reasons = mounted.map(({ layer, view }) => [layer.id, view.blocked?.reason] as const);
  return new Map(reasons.filter((entry): entry is [string, string] => Boolean(entry[1])));
}

function drawView(
  map: MapLibreMap,
  view: LayerView,
  on: ReadonlySet<string>,
  draws: Draws,
  shown: Map<LayerView, Draw | null>,
) {
  const [main, ...rest] = view.parts;
  const parts = view.show ? rest : view.parts;
  if (view.show) {
    const draw = drawOf(draws.get(main.id));
    if (shown.get(view) !== draw) view.show(draw);
    shown.set(view, draw);
  }
  for (const part of parts) {
    const isVisible = on.has(part.id) && drawOf(draws.get(part.id)) !== null;
    setVisible(map, part.layerIds, isVisible);
    part.onToggle?.(isVisible);
  }
}

function drawBlend(blend: BlendView, draws: Draws, shown: Map<LayerView, Draw | null>) {
  const draw = drawOf(draws.get(BLEND));
  if (shown.get(blend) !== draw) blend.show(draw);
  shown.set(blend, draw);
}

function drawOf(draw: Draw | Hidden | undefined) {
  return typeof draw === "string" ? draw : null;
}

/** Build the card that toggles the scene's area outline. */
export function outlineCard(map: MapLibreMap, layerId: string) {
  const card = makeHtmlElement("section");
  card.className = "card";
  card.append(checkbox("Area outline", true, (on) => setVisible(map, [layerId], on)));
  return card;
}

function setVisible(map: MapLibreMap, layerIds: string[], visible: boolean) {
  for (const id of layerIds) {
    map.setLayoutProperty(id, "visibility", visible ? "visible" : "none");
  }
}

function checkbox(label: string, checked: boolean, onChange: (on: boolean) => void) {
  const row = makeHtmlElement("label");
  const box = document.createElement("input");
  box.type = "checkbox";
  box.checked = checked;
  box.onchange = () => onChange(box.checked);
  row.append(box, ` ${label}`);
  return row;
}
