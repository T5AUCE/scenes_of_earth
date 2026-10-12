import type { GeoJSONSource, Map as MapLibreMap } from "maplibre-gl";
import { loadAreaFeature } from "./api";
import { openStore, type Store } from "./data";
import { makeHtmlElement } from "./html";
import { LAYER_KINDS } from "./layers/registry";
import { firstSymbolId, removeLayerAndSource } from "./map";
import { shiftLongitudes, worldShift } from "./render/mercator";
import { createTimeline, unionTimes } from "./timeline";
import type { LayerDoc, LayerView, Part, Scene } from "./types";

type GeoJsonData = Parameters<GeoJSONSource["setData"]>[0];

const OUTLINE_ID = "soe-area-outline";
const EMPTY_FEATURES: GeoJsonData = { type: "FeatureCollection", features: [] };

// Returns the unmount function; a failure partway removes whatever was already drawn.
export function mountScene(map: MapLibreMap, scene: Scene, root: HTMLElement) {
  const box = makeHtmlElement("div", "", root);
  const views: LayerView[] = [];
  let timeline: ReturnType<typeof createSceneTimeline> = null;
  let isMounted = true;

  const unmount = () => {
    isMounted = false;
    timeline?.destroy();
    views.forEach((view) => view.destroy());
    removeLayerAndSource(map, OUTLINE_ID);
    box.remove();
  };

  try {
    const notes = makeHtmlElement("div", "", box);
    const addNote = (text: string) => {
      makeHtmlElement("div", text, notes).className = "notice";
    };

    const store = openStore(scene.data.href);
    store.catch((error) => addNote(`Cannot open the data: ${error.message}`));

    addOutline(map, scene, addNote, () => isMounted);
    views.push(...mountLayerViews(map, scene.layers, store, addNote));
    box.append(togglesFor(map, views));

    timeline = createSceneTimeline(views);
    if (timeline) box.append(timeline.element);

    for (const view of views) {
      const legend = view.legend();
      if (legend) box.append(legend);
    }

    for (const limit of scene.notices.limits) addNote(limit);
  } catch (error) {
    unmount();
    throw error;
  }

  return unmount;
}

// Rasters past the antimeridian are drawn one world west, so the outline is shifted to match.
function addOutline(
  map: MapLibreMap,
  scene: Scene,
  addNote: (text: string) => void,
  isMounted: () => boolean,
) {
  const shift = worldShift(scene.area.bbox);
  const data = shift === 0 ? scene.area.geometry_href : EMPTY_FEATURES;

  map.addSource(OUTLINE_ID, { type: "geojson", data });

  map.addLayer(
    {
      id: OUTLINE_ID,
      type: "line",
      source: OUTLINE_ID,
      paint: { "line-color": "#333", "line-width": 1.5 },
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

// Unknown kinds get a note, and a layer that fails to start does not stop the others.
function mountLayerViews(
  map: MapLibreMap,
  layers: LayerDoc[],
  store: Promise<Store>,
  addNote: (text: string) => void,
) {
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

  const views: LayerView[] = [];

  for (const { layer, kind } of supported) {
    const report = (error: unknown) => addNote(`${layer.title}: ${(error as Error).message}`);
    try {
      const view = kind!.create({ map, store, layer, beforeId: OUTLINE_ID, report });
      view.ready.catch(report);
      views.push(view);
    } catch (error) {
      report(error);
    }
  }

  return views;
}

function togglesFor(map: MapLibreMap, views: LayerView[]) {
  const toggles = makeHtmlElement("fieldset");
  makeHtmlElement("legend", "Show", toggles);

  const outline: Part = { id: OUTLINE_ID, label: "Area outline", layerIds: [OUTLINE_ID] };

  for (const part of [...views.flatMap((view) => view.parts), outline]) {
    toggles.append(
      checkbox(part.label, true, (on) => {
        setVisible(map, part.layerIds, on);
        part.onToggle?.(on);
      }),
    );
  }

  for (const option of views.flatMap((view) => view.options)) {
    toggles.append(checkbox(option.label, false, option.set));
  }

  return toggles;
}

function setVisible(map: MapLibreMap, layerIds: string[], visible: boolean) {
  for (const id of layerIds) {
    map.setLayoutProperty(id, "visibility", visible ? "visible" : "none");
  }
}

function createSceneTimeline(views: LayerView[]) {
  const axes = views.flatMap((view) => (view.time ? [view.time] : []));
  if (!axes.length) return null;

  return createTimeline(
    unionTimes(axes.map((axis) => axis.values)),
    axes.map((axis) => axis.step),
    (time) => views.forEach((view) => view.setTime(time)),
  );
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
