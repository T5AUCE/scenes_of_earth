/** Mount the scene's calm cards and its single persistent editor panel from one store. */
import { useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";

import { cardTitle, drawLabel } from "../card-title";
import { layerUnits } from "../display-state";
import { BLEND, drawOptions, type Draw, type Hidden } from "../layers/allocate";
import { BLEND_TITLE, type BlendView } from "../layers/blend";
import type { MountedLayer } from "../scene-cards";
import type { SceneStore, SceneStoreSnapshot } from "../scene-store";
import { storeShowAs } from "../show-as";
import type { LayerDoc, LayerView } from "../types";
import { LayerCard } from "./layer-card";
import { LayerEditor, type EditorTarget } from "./layer-editor";
import { isMasterOn, masterChangedUnits } from "./master-switch";
import { useSceneStore } from "./use-scene-store";

const OUTLINE_TITLE = "Area outline";

const LAST_FIELD = "field";

interface SceneColumnProps {
  mounted: MountedLayer[];
  blend: BlendView | null;
  store: SceneStore;
  onOutline(on: boolean): void;
}

/** Mount the React scene column into a container and return its teardown. */
export function mountSceneColumn(
  host: HTMLElement,
  props: SceneColumnProps,
): { unmount(): void } {
  const root = createRoot(host);
  root.render(<SceneColumn {...props} />);

  return { unmount: () => root.unmount() };
}

function SceneColumn({
  mounted,
  blend,
  store,
  onOutline,
}: SceneColumnProps): React.ReactElement {
  const { display, allocation } = useSceneStore(store);
  const [selected, setSelected] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [optionStates, setOptionStates] = useState<Record<string, boolean[]>>({});
  const [outlineOn, setOutlineOn] = useState(true);
  const remembered = useRef(new Map<string, string[]>());
  const editButton = useRef<HTMLButtonElement | null>(null);
  useEditFocus(selected, editButton);

  const select = (unit: string, button: HTMLButtonElement) => {
    editButton.current = button;
    setSelected(unit);
    setNotice(null);
  };
  const toggleLayer = (entry: MountedLayer, on: boolean) => {
    toggleLayerUnits(entry, on, display.off, remembered.current, store);
    setNotice(null);
  };
  const toggleBlend = (on: boolean) => {
    toggleBlendUnit(store, on);
    setNotice(null);
  };
  const toggleOutline = (on: boolean) => {
    setOutlineOn(on);
    onOutline(on);
  };
  const optionChange = (unit: string, index: number, on: boolean) => {
    setOptionStates((current) => {
      const states = [...(current[unit] ?? initialOptions(mounted, blend, unit))];
      states[index] = on;

      return { ...current, [unit]: states };
    });
  };

  const ordinary = ordinaryCards(
    mounted,
    display,
    allocation,
    optionStates,
    toggleLayer,
    select,
  );
  const blendIndex = mounted.map(({ layer }) => layer.style.kind).lastIndexOf(LAST_FIELD);
  const target = editorTarget(mounted, blend, selected);
  const toggleTarget = (on: boolean) => {
    if (selected === BLEND) {
      toggleBlend(on);

      return;
    }
    const entry = mounted.find(({ layer }) => layer.id === selected);
    if (!entry) return;
    toggleLayer(entry, on);
  };

  return (
    <>
      {ordinary.slice(0, blendIndex + 1)}
      {blend && blendCard(
        blend,
        display,
        allocation,
        optionStates,
        toggleBlend,
        select,
      )}
      {ordinary.slice(blendIndex + 1)}
      {outlineCard(outlineOn, toggleOutline)}
      {target && (
        <LayerEditor
          key={target.unit}
          target={target}
          layers={mounted.map(({ layer }) => layer)}
          store={store}
          optionStates={optionStates}
          notice={notice}
          onOptionChange={optionChange}
          onNotice={setNotice}
          onClose={() => setSelected(null)}
          onToggleTarget={toggleTarget}
        />
      )}
    </>
  );
}

function useEditFocus(
  selected: string | null,
  editButton: { current: HTMLButtonElement | null },
): void {
  const previous = useRef<string | null>(null);
  useEffect(() => {
    const closed = previous.current !== null && selected === null;
    previous.current = selected;
    if (!closed) return;
    const button = editButton.current;
    // The button may belong to a layer that has since left the scene.
    if (button?.isConnected) button.focus();
  }, [selected, editButton]);
}

function toggleLayerUnits(
  entry: MountedLayer,
  on: boolean,
  off: ReadonlySet<string>,
  remembered: Map<string, string[]>,
  store: SceneStore,
): void {
  const saved = remembered.get(entry.layer.id);
  const changed = masterChangedUnits(entry.layer, off, saved, on);
  if (on) remembered.delete(entry.layer.id);
  else if (changed.length > 0) remembered.set(entry.layer.id, changed);
  if (changed.length === 0) return;
  // One dispatch keeps subscribers to a single drawing pass.
  store.dispatch({
    kind: "toggleMany",
    units: changed,
    on,
  });
}

function toggleBlendUnit(store: SceneStore, on: boolean): void {
  store.dispatch({
    kind: "toggle",
    unit: BLEND,
    on,
  });
  // The blend has no Show as radios, so the switch itself remembers the choice.
  storeShowAs(BLEND, on ? "colour" : null);
}

function ordinaryCards(
  mounted: MountedLayer[],
  display: SceneStoreSnapshot["display"],
  allocation: SceneStoreSnapshot["allocation"],
  optionStates: Readonly<Record<string, readonly boolean[]>>,
  onToggle: (entry: MountedLayer, on: boolean) => void,
  onEdit: (unit: string, button: HTMLButtonElement) => void,
): React.ReactElement[] {
  return mounted.map((entry) => ordinaryCard(
    entry,
    display,
    allocation,
    optionStates,
    onToggle,
    onEdit,
  ));
}

function ordinaryCard(
  entry: MountedLayer,
  display: SceneStoreSnapshot["display"],
  allocation: SceneStoreSnapshot["allocation"],
  optionStates: Readonly<Record<string, readonly boolean[]>>,
  onToggle: (entry: MountedLayer, on: boolean) => void,
  onEdit: (unit: string, button: HTMLButtonElement) => void,
): React.ReactElement {
  const smoothed = smoothedFor(entry.view.options, optionStates[entry.layer.id]);
  const title = layerCardTitle(entry.layer, display, allocation, smoothed);
  const checked = isMasterOn(entry.layer, display.off);

  return (
    <LayerCard
      key={entry.layer.id}
      title={title}
      checked={checked}
      onToggle={(on) => onToggle(entry, on)}
      onEdit={(button) => onEdit(entry.layer.id, button)}
      legend={entry.view.legend()}
    />
  );
}

function layerCardTitle(
  layer: LayerDoc,
  display: SceneStoreSnapshot["display"],
  allocation: SceneStoreSnapshot["allocation"],
  smoothed: boolean,
): string {
  // A layer with no draw never moves, so its title names the parts that are on.
  if (drawOptions(layer).length === 0) {
    return cardTitle(layer, {
      draw: undefined,
      off: !isMasterOn(layer, display.off),
      parts: onPartTitles(layer, display, allocation),
    });
  }
  const draw = allocation.draws.get(layer.id) ?? activePartDraw(layer, display, allocation);

  return cardTitle(layer, {
    draw,
    off: !isMasterOn(layer, display.off),
    smoothed,
  });
}

function onPartTitles(
  layer: LayerDoc,
  display: SceneStoreSnapshot["display"],
  allocation: SceneStoreSnapshot["allocation"],
): string[] {
  const titles: string[] = [];
  for (const unit of layerUnits(layer)) {
    if (display.off.has(unit)) continue;
    const draw = allocation.draws.get(unit);
    if (typeof draw === "string") titles.push(drawLabel(draw, layer));
  }

  return titles;
}

function activePartDraw(
  layer: LayerDoc,
  display: SceneStoreSnapshot["display"],
  allocation: SceneStoreSnapshot["allocation"],
): Draw | Hidden | undefined {
  for (const unit of layerUnits(layer)) {
    if (display.off.has(unit)) continue;
    const draw = allocation.draws.get(unit);
    if (draw !== undefined) return draw;
  }
  return undefined;
}

function smoothedFor(
  options: LayerView["options"],
  states: readonly boolean[] | undefined,
): boolean {
  const index = options.findIndex(({ label }) => label === "Smooth");
  if (index < 0) return false;

  return states?.[index] ?? options[index].initial ?? false;
}

function blendCard(
  blend: BlendView,
  display: SceneStoreSnapshot["display"],
  allocation: SceneStoreSnapshot["allocation"],
  optionStates: Readonly<Record<string, readonly boolean[]>>,
  onToggle: (on: boolean) => void,
  onEdit: (unit: string, button: HTMLButtonElement) => void,
): React.ReactElement {
  const smoothed = smoothedFor(blend.options, optionStates[BLEND]);
  const blendOn = allocation.as.get(BLEND) === "colour";
  const title = cardTitle({ title: BLEND_TITLE, units: "" }, {
    draw: allocation.draws.get(BLEND),
    off: !blendOn,
    smoothed,
  });

  return (
    <LayerCard
      key={BLEND}
      title={title}
      checked={blendOn}
      onToggle={onToggle}
      onEdit={(button) => onEdit(BLEND, button)}
      legend={blend.legend()}
    />
  );
}

function outlineCard(
  checked: boolean,
  onToggle: (on: boolean) => void,
): React.ReactElement {
  return (
    <LayerCard
      key={OUTLINE_TITLE}
      title={OUTLINE_TITLE}
      checked={checked}
      onToggle={onToggle}
      legend={null}
    />
  );
}

function initialOptions(
  mounted: MountedLayer[],
  blend: BlendView | null,
  unit: string,
): boolean[] {
  const view = unit === BLEND
    ? blend
    : mounted.find(({ layer }) => layer.id === unit)?.view;

  return (view?.options ?? []).map(({ initial }) => initial ?? false);
}

function editorTarget(
  mounted: MountedLayer[],
  blend: BlendView | null,
  selected: string | null,
): EditorTarget | null {
  if (selected === BLEND) {
    return blend ? { unit: BLEND, title: BLEND_TITLE, view: blend } : null;
  }

  const entry = mounted.find(({ layer }) => layer.id === selected);
  return entry ? { unit: entry.layer.id, title: entry.layer.title, view: entry.view } : null;
}
