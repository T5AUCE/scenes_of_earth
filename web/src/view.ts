/** Mount scene renderers and coordinate their controls with colour ownership and time. */
import type { GeoJSONSource, Map as MapLibreMap } from "maplibre-gl";

import { loadAreaFeature } from "./api";
import { openStore, type Store } from "./data";
import {
  DROPPED_NOTE,
  formatDisplayParams,
  loadStoredDensities,
  loadStoredInks,
  loadStoredPalettes,
  loadStoredPick,
  NO_TOKENS,
  resolveDisplay,
  type SceneDisplay,
  setLayerDisplay,
} from "./display-state";
import { makeHtmlElement } from "./html";
import { blendPair } from "./layers/allocate";
import { BLEND_TITLE, type BlendView, createBlendView } from "./layers/blend";
import { LAYER_KINDS } from "./layers/registry";
import { firstSymbolId, removeLayerAndSource, showScaleBar } from "./map";
import { shiftLongitudes, worldShift } from "./render/mercator";
import { mountCards, type MountedLayer, outlineCard } from "./scene-cards";
import { createTimeline, formatTime, scrubberTimes } from "./timeline";
import type { DisplayTokens, DrawSlots, LayerDoc, LayerView, Scene } from "./types";

type GeoJsonData = Parameters<GeoJSONSource["setData"]>[0];
type AddNote = (text: string) => () => void;

/** Map layer and source id of the scene's area outline. */
export const OUTLINE_ID = "soe-area-outline";
const OUTLINE_COLOR = "#333";
const OUTLINE_WIDTH_PX = 1.5;
const EMPTY_FEATURES: GeoJsonData = { type: "FeatureCollection", features: [] };

// Hidden anchors keep each kind of drawing in its own band.
const SLOTS: DrawSlots = {
  fill: "soe-slot-fill",
  shade: "soe-slot-shade",
  marks: "soe-slot-marks",
  lines: "soe-slot-lines",
};

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

/** Mount a scene and its controls, removing partial mounts if setup fails. */
export function mountScene(
  map: MapLibreMap,
  scene: Scene,
  { cards, timeBar, onTime, display: linked = NO_TOKENS, onDisplay }: SceneSlots,
) {
  const box = makeHtmlElement("div", "", cards);
  const mounted: MountedLayer[] = [];
  const views: LayerView[] = [];
  let blend: BlendView | null = null;
  let timeline: ReturnType<typeof createSceneTimeline> = null;
  let isMounted = true;

  const notes = makeHtmlElement("div", "", box);
  const addNote = (text: string) => {
    const note = makeHtmlElement("div", text, notes);
    note.className = "notice";
    return () => note.remove();
  };

  const removeScaleBar = showScaleBar(map);

  const unmount = () => {
    isMounted = false;
    removeScaleBar();
    timeline?.destroy();
    views.forEach((view) => view.destroy());
    blend?.destroy();
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
    loadStoredInks(),
    loadStoredDensities(),
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
    mounted.push(...mountLayerViews(map, scene.layers, store, shift, addNote, display, changed));
    views.push(...mounted.map(({ view }) => view));

    blend = mountBlend(map, mounted, store, shift, addNote);

    mountCards(map, mounted, display, box, changed, blend);
    box.append(outlineCard(map, OUTLINE_ID));
    changed();

    timeline = createSceneTimeline(blend ? [...views, blend] : views, scene.period, onTime);
    if (timeline) timeBar.append(timeline.element);
  } catch (error) {
    unmount();
    throw error;
  }

  const layerIds = views.flatMap((view) => view.parts.flatMap((part) => part.layerIds));
  if (blend) layerIds.push(...blend.parts[0].layerIds);

  return { unmount, addNote, timeline, layerIds };
}

// Rasters past the antimeridian are drawn one world west, so the outline is shifted to match.
function addOutline(
  map: MapLibreMap,
  scene: Scene,
  shift: number,
  addNote: AddNote,
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

function addSlotAnchors(map: MapLibreMap) {
  for (const id of Object.values(SLOTS)) {
    map.addLayer({ id, type: "background", layout: { visibility: "none" } }, OUTLINE_ID);
  }
}

// Unsupported or failed renderers must not prevent the other layers from mounting.
function mountLayerViews(
  map: MapLibreMap,
  layers: LayerDoc[],
  store: Promise<Store>,
  shift: number,
  addNote: AddNote,
  display: SceneDisplay,
  onDisplayChange: () => void,
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
        changeDisplay: (change) => {
          setLayerDisplay(display, layer.id, { ...display.layers[layer.id], ...change });
          onDisplayChange();
        },
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

// The blend reads the two layers' own steps and ranges, so it follows their menus.
function mountBlend(
  map: MapLibreMap,
  mounted: MountedLayer[],
  store: Promise<Store>,
  shift: number,
  addNote: AddNote,
) {
  const layerDocs = mounted.map(({ layer }) => layer);
  const pair = blendPair(layerDocs);
  if (!pair) return null;

  const [rain, temperature] = pair.map((id) => layerDocs.find((layer) => layer.id === id)!);
  const rangeOf = (id: string) => {
    const mountedLayer = mounted.find(({ layer }) => layer.id === id);
    return mountedLayer?.view.menu?.range?.value ?? null;
  };
  const report = (error: unknown) => addNote(`${BLEND_TITLE}: ${(error as Error).message}`);

  try {
    return createBlendView(
      [rain, temperature],
      { map, store, shift, slots: SLOTS, report, rangeOf },
    );
  } catch (error) {
    report(error);
    return null;
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
