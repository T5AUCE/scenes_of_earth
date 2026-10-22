/** Draw the scene from its shared store so the cards and the map read one state. */
import type { Map as MapLibreMap } from "maplibre-gl";

import { BLEND, blendPair, type BlendPair, type Draw, type Hidden } from "./layers/allocate";
import type { BlendView } from "./layers/blend";
import type { SceneStore } from "./scene-store";
import type { LayerDisplay, LayerDoc, LayerView } from "./types";

/** A layer's view with the layer it draws. */
export interface MountedLayer {
  layer: LayerDoc;
  view: LayerView;
}

type Draws = Map<string, Draw | Hidden>;

/** Draw every mounted layer from the store and return the subscription's teardown. */
export function subscribeDrawing(
  map: MapLibreMap,
  mounted: MountedLayer[],
  blend: BlendView | null,
  store: SceneStore,
) {
  const shown = new Map<LayerView, Draw | null>();
  let isUnderColour: boolean | null = null;
  const pair = blendPair(mounted.map(({ layer }) => layer));
  let previousRanges: string | undefined;

  const apply = () => {
    const { allocation, display, on } = store.getSnapshot();
    mounted.forEach(({ view }) => drawView(map, view, on, allocation.draws, shown));
    if (blend) drawBlend(blend, allocation.draws, shown);

    const ranges = rangeKey(display.layers, pair);
    if (blend && ranges !== previousRanges) {
      blend.restyle();
      previousRanges = ranges;
    }

    const isUnder = allocation.owner !== null;
    if (isUnder === isUnderColour) return;

    isUnderColour = isUnder;
    mounted.forEach(({ view }) => view.setColourUnder?.(isUnder));
  };

  apply();
  return store.subscribe(apply);
}

/** Show or hide the scene's area outline. */
export function setOutline(map: MapLibreMap, layerId: string, visible: boolean) {
  setVisible(map, [layerId], visible);
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

  const legend = blend.legend();
  if (legend) legend.hidden = draw === null;
}

function drawOf(draw: Draw | Hidden | undefined) {
  return typeof draw === "string" ? draw : null;
}

function rangeKey(
  layers: Record<string, LayerDisplay>,
  pair: BlendPair | null,
): string {
  if (!pair) return "";

  return pair
    .map((id) => JSON.stringify([layers[id]?.range ?? null, layers[id]?.units ?? null]))
    .join("|");
}

function setVisible(map: MapLibreMap, layerIds: string[], visible: boolean) {
  for (const id of layerIds) {
    map.setLayoutProperty(id, "visibility", visible ? "visible" : "none");
  }
}
