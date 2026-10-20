import type { GeoJSONSource, Map as MapLibreMap } from "maplibre-gl";

import { loadAreaFeature } from "./api";
import { openStore, type Store } from "./data";
import {
  applyColourAction,
  type ColourAction,
  DROPPED_NOTE,
  formatDisplayParams,
  layerUnits,
  loadStoredPalettes,
  loadStoredPick,
  NO_TOKENS,
  resolveDisplay,
  recordMenuChange,
  type SceneDisplay,
  storePick,
} from "./display-state";
import { makeHtmlElement } from "./html";
import { allocate, type Draw, type Hidden, layerDraws } from "./layers/allocate";
import { layerMenu, partControls, type MenuChange } from "./layers/layer-menu";
import { LAYER_KINDS } from "./layers/registry";
import { firstSymbolId, removeLayerAndSource, showScaleBar } from "./map";
import { shiftLongitudes, worldShift } from "./render/mercator";
import { createTimeline, formatTime, scrubberTimes } from "./timeline";
import type { DisplayTokens, DrawSlots, LayerDoc, LayerView, Scene } from "./types";

type GeoJsonData = Parameters<GeoJSONSource["setData"]>[0];

/** Map layer and source id of the scene's area outline. */
export const OUTLINE_ID = "soe-area-outline";
const OUTLINE_COLOR = "#333";
const OUTLINE_WIDTH_PX = 1.5;
const EMPTY_FEATURES: GeoJsonData = { type: "FeatureCollection", features: [] };

// Hidden layers from bottom to top, so each kind of drawing can be put in its own band.
const SLOTS: DrawSlots = {
  fill: "soe-slot-fill",
  shade: "soe-slot-shade",
  marks: "soe-slot-marks",
  lines: "soe-slot-lines",
};

const CHIP_TEXT: Partial<Record<Draw, string>> = {
  colour: "Colour",
  dots: "As dots",
  isolines: "As isotherms",
  edges: "As outlines",
};

/** A layer's view with the layer it draws. */
interface MountedLayer {
  layer: LayerDoc;
  view: LayerView;
}

/** Where a scene puts its pieces; the caller owns the containers. */
export interface SceneSlots {
  cards: HTMLElement;
  timeBar: HTMLElement;
  onTime(time: string, label: string): void;
  /** The display settings of the link the scene was opened from, if any. */
  display?: DisplayTokens;
  /** Receives the link parameters for the scene's display choices whenever they change. */
  onDisplay(params: string): void;
}

/** Draws a scene's layers, outline, cards and timeline; a failure partway removes all of it. */
export function mountScene(
  map: MapLibreMap,
  scene: Scene,
  { cards, timeBar, onTime, display: linked = NO_TOKENS, onDisplay }: SceneSlots,
) {
  const box = makeHtmlElement("div", "", cards);
  const mounted: MountedLayer[] = [];
  const views: LayerView[] = [];
  let timeline: ReturnType<typeof createSceneTimeline> = null;
  let isMounted = true;

  const notes = makeHtmlElement("div", "", box);
  const addNote = (text: string) => {
    makeHtmlElement("div", text, notes).className = "notice";
  };

  const removeScaleBar = showScaleBar(map);

  const unmount = () => {
    isMounted = false;
    removeScaleBar();
    timeline?.destroy();
    views.forEach((view) => view.destroy());
    Object.values(SLOTS).forEach((id) => removeLayerAndSource(map, id));
    removeLayerAndSource(map, OUTLINE_ID);
    timeline?.element.remove();
    box.remove();
  };

  const { display, dropped } = resolveDisplay(
    scene.layers,
    linked,
    loadStoredPalettes(),
    loadStoredPick(),
  );
  if (dropped) addNote(DROPPED_NOTE);
  const changed = () => {
    onDisplay(formatDisplayParams(display, mounted.map(({ layer }) => layer)));
  };

  try {
    const store = openStore(scene.data.href);
    store.catch((error) => addNote(`Cannot open the data: ${error.message}`));

    const shift = worldShift(scene.area.bbox);
    addOutline(map, scene, shift, addNote, () => isMounted);
    addSlotAnchors(map);
    mounted.push(...mountLayerViews(map, scene.layers, store, shift, addNote, display));
    views.push(...mounted.map(({ view }) => view));

    mountCards(map, mounted, display, box, changed);
    box.append(outlineCard(map));
    changed();

    timeline = createSceneTimeline(views, scene.period, onTime);
    if (timeline) timeBar.append(timeline.element);
  } catch (error) {
    unmount();
    throw error;
  }

  const layerIds = views.flatMap((view) => view.parts.flatMap((part) => part.layerIds));

  return { unmount, addNote, timeline, layerIds };
}

// Rasters past the antimeridian are drawn one world west, so the outline is shifted to match.
function addOutline(
  map: MapLibreMap,
  scene: Scene,
  shift: number,
  addNote: (text: string) => void,
  isMounted: () => boolean,
) {
  const data = shift === 0 ? scene.area.geometry_href : EMPTY_FEATURES;

  map.addSource(OUTLINE_ID, { type: "geojson", data });

  map.addLayer(
    {
      id: OUTLINE_ID,
      type: "line",
      source: OUTLINE_ID,
      paint: { "line-color": OUTLINE_COLOR, "line-width": OUTLINE_WIDTH_PX },
    },
    firstSymbolId(map),
  );

  if (shift === 0) return;

  showShiftedOutline(map, scene.area.geometry_href, shift, isMounted)
    .catch((error) => addNote(`Area outline: ${error.message}`));
}

function addSlotAnchors(map: MapLibreMap) {
  for (const id of Object.values(SLOTS)) {
    map.addLayer({ id, type: "background", layout: { visibility: "none" } }, OUTLINE_ID);
  }
}

async function showShiftedOutline(
  map: MapLibreMap,
  geometryHref: string,
  shift: number,
  isMounted: () => boolean,
) {
  const feature = await loadAreaFeature(geometryHref);
  if (!isMounted()) return;

  const { geometry } = feature;
  const shifted = {
    ...feature,
    geometry: { ...geometry, coordinates: shiftLongitudes(geometry.coordinates, shift) },
  };

  (map.getSource(OUTLINE_ID) as GeoJSONSource).setData(shifted as GeoJsonData);
}

// Unknown kinds get a note, and a layer that fails to start does not stop the others.
function mountLayerViews(
  map: MapLibreMap,
  layers: LayerDoc[],
  store: Promise<Store>,
  shift: number,
  addNote: (text: string) => void,
  display: SceneDisplay,
): MountedLayer[] {
  const layersWithKind = layers.map((layer) => ({
    layer,
    kind: LAYER_KINDS.get(layer.style.kind),
  }));

  for (const { layer } of layersWithKind.filter(({ kind }) => !kind)) {
    addNote(`${layer.title}: display not supported yet`);
  }

  const supported = layersWithKind
    .filter(({ kind }) => kind)
    .sort((first, second) => first.kind!.stack - second.kind!.stack);

  const mounted: MountedLayer[] = [];
  for (const { layer, kind } of supported) {
    const report = (error: unknown) => addNote(`${layer.title}: ${(error as Error).message}`);

    try {
      const view = kind!.create({
        map,
        store,
        layer,
        shift,
        slots: SLOTS,
        beforeId: SLOTS.lines,
        display: display.layers[layer.id],
        report,
      });
      view.ready?.catch(report);
      mounted.push({ layer, view });
    } catch (error) {
      report(error);
    }
  }
  return mounted;
}

// The user's pick decides who holds colour. Every other visible layer then draws its fallback.
function mountCards(
  map: MapLibreMap,
  mounted: MountedLayer[],
  display: SceneDisplay,
  box: HTMLElement,
  changed: () => void,
) {
  const docs = mounted.map(({ layer }) => layer);
  const units = docs.flatMap(layerUnits);
  const colourDocs = docs.filter((layer) => layerDraws(layer).colour);
  const hasChoice = colourDocs.length >= 2;
  const picker = colourPicker(colourDocs, (unit) => act({ kind: "pick", unit }));
  const cards = mounted.map((layer) => layerCard(layer, display, hasChoice, act, changed));
  const shown = new Map<LayerView, Draw | null>();
  let isUnderColour: boolean | null = null;

  box.append(picker.row, ...cards.map(({ element }) => element));
  refresh();

  function act(action: ColourAction) {
    const next = applyColourAction({ pick: display.colour, off: display.off }, action, docs);
    if (next.pick !== display.colour) storePick(next.pick);
    display.colour = next.pick;
    display.off = new Set(next.off);
    refresh();
    changed();
  }

  function refresh() {
    const on = new Set(units.filter((unit) => !display.off.has(unit)));
    const { owner, draws } = allocate(docs, on, display.colour);

    picker.show(owner, hasChoice);
    cards.forEach((card) => card.show(draws, on));
    mounted.forEach(({ view }) => drawView(map, view, on, draws, shown));

    const isUnder = owner !== null;
    if (isUnder === isUnderColour) return;

    isUnderColour = isUnder;
    mounted.forEach(({ view }) => view.setColourUnder?.(isUnder));
  }
}

type Draws = Map<string, Draw | Hidden>;

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

function drawOf(draw: Draw | Hidden | undefined) {
  return typeof draw === "string" ? draw : null;
}

function colourPicker(layers: LayerDoc[], onPick: (unit: string) => void) {
  const row = makeHtmlElement("label");
  row.className = "colour-picker";
  makeHtmlElement("span", "Colour", row);
  const select = document.createElement("select");
  for (const { id, title } of layers) {
    const option = makeHtmlElement("option", title, select) as HTMLOptionElement;
    option.value = id;
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

interface LayerCard {
  element: HTMLElement;
  show(draws: Draws, on: ReadonlySet<string>): void;
}

function layerCard(
  { layer, view }: MountedLayer,
  display: SceneDisplay,
  hasChoice: boolean,
  act: (action: ColourAction) => void,
  changed: () => void,
): LayerCard {
  const card = makeHtmlElement("section");
  card.className = "card";
  const checks = new Map<string, HTMLInputElement>();
  const slidersByPart = new Map<string, HTMLElement>();
  const reasons = new Map<string, HTMLElement>();
  const chip = makeHtmlElement("span");
  chip.className = "colour-chip";
  const pickButton = makeHtmlElement("button", "Show in colour");
  pickButton.type = "button";
  pickButton.className = "colour-pick";
  pickButton.onclick = () => act({ kind: "pick", unit: view.parts[0].id });

  view.parts.forEach((part, index) => {
    const sliders = part.controls ? partControls(part.controls) : null;
    const row = makeHtmlElement("div", "", card);
    row.className = "check-row";
    const label = checkbox(part.label, !display.off.has(part.id), (isOn) => {
      act({ kind: "toggle", unit: part.id, on: isOn });
    });
    checks.set(part.id, label.querySelector("input")!);
    row.append(label);
    if (index === 0) {
      if (hasChoice && layerDraws(layer).colour) row.append(chip, pickButton);
      addFirstPartExtras(view, row, card, display, changed);
    } else {
      const reason = makeHtmlElement("div", "", card);
      reason.className = "option-note";
      reasons.set(part.id, reason);
    }
    if (sliders) {
      slidersByPart.set(part.id, sliders);
      card.append(sliders);
    }
    if (part.note) {
      part.note.classList.add("option-note");
      card.append(part.note);
    }
  });

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

      const main = view.parts[0].id;
      const draw = draws.get(main);
      chip.textContent = on.has(main) ? chipText(draw) : "";
      chip.hidden = !chip.textContent;
      pickButton.hidden = chip.hidden || draw === "colour";
    },
  };
}

function chipText(draw: Draw | Hidden | undefined) {
  if (draw === undefined) return "";

  return typeof draw === "string" ? CHIP_TEXT[draw] ?? "" : draw.hidden;
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
  if (view.options.length > 0) {
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

  if (view.menu) {
    const { button, popover } = layerMenu(
      view.menu,
      (change) => menuChanged(view, display, change, changed),
    );
    row.append(button);
    card.append(popover);
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

function outlineCard(map: MapLibreMap) {
  const card = makeHtmlElement("section");
  card.className = "card";
  card.append(checkbox("Area outline", true, (on) => setVisible(map, [OUTLINE_ID], on)));
  return card;
}

function setVisible(map: MapLibreMap, layerIds: string[], visible: boolean) {
  for (const id of layerIds) {
    map.setLayoutProperty(id, "visibility", visible ? "visible" : "none");
  }
}

function createSceneTimeline(
  views: LayerView[],
  period: Scene["period"],
  onTime: SceneSlots["onTime"],
) {
  const axes = views.flatMap((view) => (view.time ? [view.time] : []));
  if (!axes.length || !period) return null;

  const steps = axes.map((axis) => axis.step);
  const timeValues = axes.map((axis) => axis.values);
  const times = scrubberTimes(timeValues, period);

  return createTimeline(times, steps, (time) => {
    views.forEach((view) => view.setTime(time));
    onTime(time, formatTime(time, steps));
  });
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
