import type { Map as MapLibreMap } from "maplibre-gl";
import { openStore } from "./data";
import { LAYER_KINDS } from "./layers/registry";
import { firstSymbolId, removeLayerAndSource } from "./map";
import { createTimeline, unionTimes } from "./timeline";
import type { LayerView, Part, Scene } from "./types";

const OUTLINE_ID = "soe-area-outline";

function el<K extends keyof HTMLElementTagNameMap>(tag: K, text = "", parent?: HTMLElement) {
  const e = document.createElement(tag);
  e.textContent = text;
  parent?.append(e);
  return e;
}

function checkbox(label: string, checked: boolean, onChange: (on: boolean) => void) {
  const row = el("label");
  const box = document.createElement("input");
  box.type = "checkbox";
  box.checked = checked;
  box.onchange = () => onChange(box.checked);
  row.append(box, ` ${label}`);
  return row;
}

// Draws the scene's layers on the map and their controls into root. Returns the unmount function.
export function mountScene(map: MapLibreMap, scene: Scene, root: HTMLElement) {
  const box = el("div", "", root);
  const notes = el("div", "", box);
  const note = (text: string) => {
    el("div", text, notes).className = "notice";
  };

  const store = openStore(scene.data.href);
  store.catch((e) => note(`Cannot open the data: ${e.message}`));

  map.addSource(OUTLINE_ID, { type: "geojson", data: scene.area.geometry_href });
  map.addLayer(
    {
      id: OUTLINE_ID,
      type: "line",
      source: OUTLINE_ID,
      paint: { "line-color": "#333", "line-width": 1.5 },
    },
    firstSymbolId(map),
  );

  const views: LayerView[] = [];
  const kinds = scene.layers.map((layer) => ({ layer, kind: LAYER_KINDS.get(layer.style.kind) }));
  const known = kinds.filter((k) => k.kind).sort((a, b) => a.kind!.stack - b.kind!.stack);
  for (const { layer, kind } of kinds.filter((k) => !k.kind)) {
    note(`${layer.title}: display not supported yet`);
  }
  for (const { layer, kind } of known) {
    const report = (e: unknown) => note(`${layer.title}: ${(e as Error).message}`);
    try {
      const view = kind!.create({ map, store, layer, beforeId: OUTLINE_ID, report });
      view.ready.catch(report);
      views.push(view);
    } catch (e) {
      report(e);
    }
  }

  const toggles = el("fieldset", "", box);
  el("legend", "Show", toggles);
  const parts: Part[] = [
    ...views.flatMap((v) => v.parts),
    { id: OUTLINE_ID, label: "Area outline", layerIds: [OUTLINE_ID] },
  ];
  for (const part of parts) {
    toggles.append(
      checkbox(part.label, true, (on) => {
        for (const id of part.layerIds) {
          map.setLayoutProperty(id, "visibility", on ? "visible" : "none");
        }
      }),
    );
  }
  for (const option of views.flatMap((v) => v.options)) {
    toggles.append(checkbox(option.label, false, option.set));
  }

  const axes = views.flatMap((v) => (v.time ? [v.time] : []));
  const timeline = axes.length
    ? createTimeline(
        unionTimes(axes.map((a) => a.values)),
        axes.map((a) => a.step),
        (t) => views.forEach((v) => v.setTime(t)),
      )
    : null;
  if (timeline) box.append(timeline.element);

  for (const view of views) {
    const legend = view.legend();
    if (legend) box.append(legend);
  }
  for (const text of scene.notices.limits) note(text);

  return () => {
    timeline?.destroy();
    views.forEach((v) => v.destroy());
    removeLayerAndSource(map, OUTLINE_ID);
    box.remove();
  };
}
