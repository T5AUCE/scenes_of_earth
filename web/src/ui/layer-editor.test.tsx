import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { test } from "node:test";

import { Window } from "happy-dom";
// Tests sit outside the tsconfig, so tsx gives them the classic JSX runtime.
import React from "react";

import { createSceneStore } from "../scene-store.ts";
import type { LayerDoc, LayerMenu, LayerView } from "../types.ts";

registerHooks({
  resolve(specifier, context, next) {
    if (specifier.endsWith(".css")) {
      return { url: "data:text/javascript,export default {}", shortCircuit: true };
    }

    return next(specifier, context);
  },
});

const RAIN = layer("rain", "Rainfall", ["ramp", "dots", "chroma"]);
const TEMPERATURE = layer("temp", "Temperature", ["ramp", "isolines", "warmth"]);
const LAND = layer("land", "Land cover", ["fill"]);
const TERRAIN = layer("terrain", "Terrain", ["shade"], ["contours"]);

test("Show as chooses the draw and names the displaced layer", async (context) => {
  const window = new Window({ url: "http://localhost" });
  context.after(() => window.happyDOM.abort());
  installBrowser(window);
  const { act } = await import("react");
  const { createRoot } = await import("react-dom/client");
  const { LayerEditor } = await import("./layer-editor.tsx");
  const store = createSceneStore([RAIN, TEMPERATURE], display());
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);

  await act(async () => root.render(
    <Harness
      Editor={LayerEditor}
      target={{ unit: "rain", title: "Rainfall", view: fieldView("rain") }}
      layers={[RAIN, TEMPERATURE]}
      store={store}
    />,
  ));

  const colour = inputByValue(container, "colour");
  assert.equal(colour.checked, false);

  await act(async () => {
    colour.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
  });

  assert.equal(store.getSnapshot().allocation.owner, "rain");
  assert.match(container.textContent ?? "", /Temperature now shows as Lines\./);
  assert.equal(inputByValue(container, "colour").checked, true);

  await act(async () => root.unmount());
});

test("a layer with one draw gets no Show as section", async (context) => {
  const window = new Window({ url: "http://localhost" });
  context.after(() => window.happyDOM.abort());
  installBrowser(window);
  const { act } = await import("react");
  const { createRoot } = await import("react-dom/client");
  const { LayerEditor } = await import("./layer-editor.tsx");
  const store = createSceneStore([LAND], display({ showAs: {} }));
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);

  await act(async () => root.render(
    <Harness
      Editor={LayerEditor}
      target={{ unit: "land", title: "Land cover", view: fieldView("land") }}
      layers={[LAND]}
      store={store}
    />,
  ));

  assert.equal(container.querySelector(".show-as"), null);
  assert.match(container.querySelector(".menu-sections")?.textContent ?? "", /Colours/);

  await act(async () => root.unmount());
});

test("Close and Escape both close the editor", async (context) => {
  const window = new Window({ url: "http://localhost" });
  context.after(() => window.happyDOM.abort());
  installBrowser(window);
  const { act } = await import("react");
  const { createRoot } = await import("react-dom/client");
  const { LayerEditor } = await import("./layer-editor.tsx");
  const store = createSceneStore([RAIN], display());
  let closed = 0;
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);

  await act(async () => root.render(
    <Harness
      Editor={LayerEditor}
      target={{ unit: "rain", title: "Rainfall", view: fieldView("rain") }}
      layers={[RAIN]}
      store={store}
      onClose={() => closed++}
    />,
  ));

  await act(async () => {
    buttonWithText(container, "Close")
      .dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
  });
  assert.equal(closed, 1);

  await act(async () => {
    window.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Escape" }));
  });
  assert.equal(closed, 2);

  await act(async () => root.unmount());
});

test("Reset layer clears the layer's Show as choice", async (context) => {
  const window = new Window({ url: "http://localhost" });
  context.after(() => window.happyDOM.abort());
  installBrowser(window);
  const { act } = await import("react");
  const { createRoot } = await import("react-dom/client");
  const { LayerEditor } = await import("./layer-editor.tsx");
  const store = createSceneStore([RAIN, TEMPERATURE], display());
  store.dispatch({ kind: "choose", unit: "rain", draw: "colour" });
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);

  await act(async () => root.render(
    <Harness
      Editor={LayerEditor}
      target={{ unit: "rain", title: "Rainfall", view: fieldView("rain") }}
      layers={[RAIN, TEMPERATURE]}
      store={store}
    />,
  ));

  await act(async () => {
    buttonWithText(container, "Reset layer")
      .dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
  });

  assert.deepEqual(store.getSnapshot().display.showAs, {});
  assert.equal(store.getSnapshot().allocation.owner, "temp");

  await act(async () => root.unmount());
});

test("a part switch in the editor changes the store's off units", async (context) => {
  const window = new Window({ url: "http://localhost" });
  context.after(() => window.happyDOM.abort());
  installBrowser(window);
  const { act } = await import("react");
  const { createRoot } = await import("react-dom/client");
  const { LayerEditor } = await import("./layer-editor.tsx");
  const store = createSceneStore([TERRAIN], display());
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);

  await act(async () => root.render(
    <Harness
      Editor={LayerEditor}
      target={{ unit: "terrain", title: "Terrain", view: terrainView() }}
      layers={[TERRAIN]}
      store={store}
    />,
  ));

  const contours = checkboxByLabel(container, "Contours");
  await act(async () => {
    contours.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
  });

  assert.equal(store.getSnapshot().display.off.has("terrain.contours"), true);

  await act(async () => root.unmount());
});

test("a later menu or option change clears the displacement notice", async (context) => {
  const window = new Window({ url: "http://localhost" });
  context.after(() => window.happyDOM.abort());
  installBrowser(window);
  const { act } = await import("react");
  const { createRoot } = await import("react-dom/client");
  const { LayerEditor } = await import("./layer-editor.tsx");
  const store = createSceneStore([RAIN, TEMPERATURE], display());
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);

  await act(async () => root.render(
    <Harness
      Editor={LayerEditor}
      target={{ unit: "rain", title: "Rainfall", view: fieldView("rain") }}
      layers={[RAIN, TEMPERATURE]}
      store={store}
    />,
  ));

  const colour = inputByValue(container, "colour");
  await act(async () => {
    colour.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
  });
  assert.match(container.querySelector(".colour-notice")?.textContent ?? "", /Temperature/);

  const batlow = checkboxByLabel(container, "Batlow");
  await act(async () => {
    batlow.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
  });
  assert.equal(container.querySelector(".colour-notice"), null);

  await act(async () => root.unmount());
});

test("an option change clears the displacement notice", async (context) => {
  const window = new Window({ url: "http://localhost" });
  context.after(() => window.happyDOM.abort());
  installBrowser(window);
  const { act } = await import("react");
  const { createRoot } = await import("react-dom/client");
  const { LayerEditor } = await import("./layer-editor.tsx");
  const store = createSceneStore([RAIN, TEMPERATURE], display());
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);

  await act(async () => root.render(
    <Harness
      Editor={LayerEditor}
      target={{ unit: "rain", title: "Rainfall", view: fieldView("rain") }}
      layers={[RAIN, TEMPERATURE]}
      store={store}
    />,
  ));

  const colour = inputByValue(container, "colour");
  await act(async () => {
    colour.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
  });
  assert.match(container.querySelector(".colour-notice")?.textContent ?? "", /Temperature/);

  const smooth = checkboxByLabel(container, "Smooth");
  await act(async () => {
    smooth.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
  });
  assert.equal(container.querySelector(".colour-notice"), null);

  await act(async () => root.unmount());
});

test("reopening and swapping editors leaves no retained part listeners", async (context) => {
  const window = new Window({ url: "http://localhost" });
  context.after(() => window.happyDOM.abort());
  installBrowser(window);
  const { act } = await import("react");
  const { createRoot } = await import("react-dom/client");
  const { LayerEditor } = await import("./layer-editor.tsx");
  const countsA = { adds: 0, removes: 0 };
  const countsB = { adds: 0, removes: 0 };
  const viewA = controlView(countingTarget(countsA));
  const viewB = controlView(countingTarget(countsB));
  const store = createSceneStore([RAIN], display());
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);

  await act(async () => root.render(
    <Harness
      Editor={LayerEditor}
      target={{ unit: "rain", title: "Rainfall", view: viewA }}
      layers={[RAIN]}
      store={store}
    />,
  ));
  assert.ok(countsA.adds > 0);

  await act(async () => root.render(
    <Harness
      Editor={LayerEditor}
      target={{ unit: "temp", title: "Temperature", view: viewB }}
      layers={[RAIN]}
      store={store}
    />,
  ));
  assert.equal(countsA.removes, countsA.adds);
  assert.ok(countsB.adds > 0);

  await act(async () => root.unmount());
  assert.equal(countsB.removes, countsB.adds);
});

test("reopened part controls show the edited relief strength", async (context) => {
  const window = new Window({ url: "http://localhost" });
  context.after(() => window.happyDOM.abort());
  installBrowser(window);
  const { act } = await import("react");
  const { createRoot } = await import("react-dom/client");
  const { LayerEditor } = await import("./layer-editor.tsx");
  let strength = 5;
  const updates = new EventTarget();
  const control = {
    label: "Relief strength",
    min: 0,
    max: 10,
    step: 1,
    get value() {
      return strength;
    },
    set: (next: number) => {
      strength = next;
    },
    updates,
  };
  const terrain = strengthView(control);
  const store = createSceneStore([TERRAIN], display());
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const target = { unit: "terrain", title: "Terrain", view: terrain };

  await act(async () => root.render(
    <Harness Editor={LayerEditor} target={target} layers={[TERRAIN]} store={store} />,
  ));
  const first = container.querySelector(".part-controls input") as HTMLInputElement;
  assert.equal(first.value, "5");

  await act(async () => {
    first.value = "7";
    first.dispatchEvent(new window.Event("input", { bubbles: true }));
  });
  assert.equal(strength, 7);

  await act(async () => root.render(
    <Harness
      Editor={LayerEditor}
      target={{ unit: "rain", title: "Rain", view: fieldView("rain") }}
      layers={[TERRAIN]}
      store={store}
    />,
  ));
  await act(async () => root.render(
    <Harness Editor={LayerEditor} target={target} layers={[TERRAIN]} store={store} />,
  ));
  const reopened = container.querySelector(".part-controls input") as HTMLInputElement;
  assert.equal(reopened.value, "7");

  await act(async () => root.unmount());
});

test("mounting the column keeps its sibling notices", async (context) => {
  const window = new Window({ url: "http://localhost" });
  context.after(() => window.happyDOM.abort());
  installBrowser(window);
  const { act } = await import("react");
  const { mountSceneColumn } = await import("./scene-column.tsx");
  const store = createSceneStore([RAIN], display());
  const box = document.createElement("div");
  document.body.append(box);
  const notes = document.createElement("div");
  box.append(notes);
  const first = document.createElement("div");
  first.textContent = "dropped";
  first.className = "notice";
  notes.append(first);
  const host = document.createElement("div");
  box.append(host);

  let column: { unmount(): void } | null = null;
  await act(async () => {
    column = mountSceneColumn(host, {
      mounted: [{ layer: RAIN, view: fieldView("rain") }],
      blend: null,
      store,
      onOutline: () => {},
    });
  });

  assert.equal(notes.isConnected, true);
  assert.match(notes.textContent ?? "", /dropped/);
  assert.match(host.textContent ?? "", /Rainfall/);

  const late = document.createElement("div");
  late.textContent = "late";
  late.className = "notice";
  notes.append(late);
  assert.equal(late.isConnected, true);
  assert.match(host.textContent ?? "", /Rainfall/);

  await act(async () => column!.unmount());
});

test("closing the editor returns focus to its Edit button", async (context) => {
  const window = new Window({ url: "http://localhost" });
  context.after(() => window.happyDOM.abort());
  installBrowser(window);
  const { act } = await import("react");
  const { mountSceneColumn } = await import("./scene-column.tsx");
  const store = createSceneStore([RAIN, TEMPERATURE], display());
  const container = document.createElement("div");
  document.body.append(container);

  let column: { unmount(): void } | null = null;
  await act(async () => {
    column = mountSceneColumn(container, {
      mounted: [
        { layer: RAIN, view: fieldView("rain") },
        { layer: TEMPERATURE, view: fieldView("temp") },
      ],
      blend: null,
      store,
      onOutline: () => {},
    });
  });

  const edits = () => [...container.querySelectorAll("button.edit-button")] as HTMLButtonElement[];
  await act(async () => {
    edits()[0].dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
  });
  const panel = container.querySelector(".layer-editor") as HTMLElement;
  assert.equal(document.activeElement, panel);

  const close = buttonWithText(container, "Close");
  await act(async () => {
    close.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
  });
  assert.equal(container.querySelector(".layer-editor"), null);
  assert.equal(document.activeElement, edits()[0]);

  await act(async () => {
    edits()[0].dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
  });
  assert.equal(document.activeElement, container.querySelector(".layer-editor"));

  await act(async () => {
    window.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Escape" }));
  });
  assert.equal(container.querySelector(".layer-editor"), null);
  assert.equal(document.activeElement, edits()[0]);

  await act(async () => {
    edits()[0].dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
  });
  await act(async () => {
    edits()[1].dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
  });
  const swapped = container.querySelector(".layer-editor") as HTMLElement;
  assert.match(swapped.getAttribute("aria-label") ?? "", /Temperature/);
  assert.equal(document.activeElement, swapped);

  await act(async () => column!.unmount());
});

test("a contours-only terrain card stays on with its contours title", async (context) => {
  const window = new Window({ url: "http://localhost" });
  context.after(() => window.happyDOM.abort());
  installBrowser(window);
  const { act } = await import("react");
  const { mountSceneColumn } = await import("./scene-column.tsx");
  const terrainLayer = {
    id: "terrain",
    title: "Terrain",
    units: "",
    style: { kind: "terrain", encodings: ["shade"], parts: ["contours"] },
  } as unknown as LayerDoc;
  const view = terrainView();
  const store = createSceneStore([terrainLayer], {
    layers: {},
    off: new Set(["terrain"]),
    showAs: {},
  });
  const container = document.createElement("div");
  document.body.append(container);

  let column: { unmount(): void } | null = null;
  await act(async () => {
    column = mountSceneColumn(container, {
      mounted: [{ layer: terrainLayer, view }],
      blend: null,
      store,
      onOutline: () => {},
    });
  });

  const title = () => container.querySelector(".card-title")?.textContent ?? "";
  const master = () => container.querySelector('input[role="switch"]') as HTMLInputElement;
  assert.equal(title(), "Terrain · contours");
  assert.equal(master().checked, true);

  await act(async () => {
    master().dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
  });
  assert.equal(title(), "Terrain · off");
  assert.equal(master().checked, false);

  await act(async () => {
    master().dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
  });
  assert.equal(title(), "Terrain · contours");
  assert.equal(master().checked, true);

  await act(async () => column!.unmount());
});

test("the blend switch remembers its choice for a fresh scene", async (context) => {
  const window = new Window({ url: "http://localhost" });
  context.after(() => window.happyDOM.abort());
  installBrowser(window);
  const { act } = await import("react");
  const { mountSceneColumn } = await import("./scene-column.tsx");
  const { loadStoredShowAs } = await import("../show-as.ts");
  const blend = {
    parts: [{ id: "blend", label: "Blend", layerIds: ["blend"] }],
    options: [],
    time: null,
    setTime: () => {},
    show: () => {},
    restyle: () => {},
    legend: () => null,
    destroy: () => {},
  };
  const store = createSceneStore([RAIN, TEMPERATURE], display());
  const container = document.createElement("div");
  document.body.append(container);

  let column: { unmount(): void } | null = null;
  await act(async () => {
    column = mountSceneColumn(container, {
      mounted: [
        { layer: RAIN, view: fieldView("rain") },
        { layer: TEMPERATURE, view: fieldView("temp") },
      ],
      blend: blend as unknown as import("../layers/blend.ts").BlendView,
      store,
      onOutline: () => {},
    });
  });

  const blendSwitch = () => {
    const cards = [...container.querySelectorAll(".card")];
    const card = cards.find((element) => element.textContent?.includes("blended"));
    return card!.querySelector('input[role="switch"]') as HTMLInputElement;
  };
  assert.equal(blendSwitch().checked, false);

  await act(async () => {
    blendSwitch().dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
  });
  assert.equal(blendSwitch().checked, true);
  assert.equal(loadStoredShowAs().blend, "colour");

  await act(async () => {
    blendSwitch().dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
  });
  assert.equal(blendSwitch().checked, false);
  assert.equal(loadStoredShowAs().blend, undefined);

  await act(async () => column!.unmount());
});

function Harness({
  Editor,
  target,
  layers,
  store,
  onClose = () => {},
}: {
  Editor: typeof import("./layer-editor.tsx").LayerEditor;
  target: { unit: string; title: string; view: LayerView };
  layers: readonly LayerDoc[];
  store: ReturnType<typeof createSceneStore>;
  onClose?(): void;
}) {
  const [notice, setNotice] = React.useState<string | null>(null);

  return (
    <Editor
      target={target}
      layers={layers}
      store={store}
      optionStates={{}}
      notice={notice}
      onOptionChange={() => {}}
      onNotice={setNotice}
      onClose={onClose}
    />
  );
}

function display({
  showAs = {},
}: {
  showAs?: Record<string, "colour" | "dots" | "isolines">;
} = {}) {
  return { layers: {}, off: new Set<string>(), showAs };
}

function layer(
  id: string,
  title: string,
  encodings: string[],
  parts: string[] = [],
): LayerDoc {
  return {
    id,
    title,
    units: "",
    style: { kind: id === "land" ? "categorical" : "field", encodings, parts },
  } as unknown as LayerDoc;
}

function fieldView(id: string): LayerView {
  return {
    parts: [{ id, label: id, layerIds: [id] }],
    options: [{ label: "Smooth", initial: true, set: () => {} }],
    time: null,
    menu: menu(),
    setTime: () => {},
    legend: () => null,
    destroy: () => {},
  };
}

function terrainView(): LayerView {
  return {
    parts: [
      { id: "terrain", label: "Relief", layerIds: ["terrain"] },
      { id: "terrain.contours", label: "Contours", layerIds: ["terrain.contours"] },
    ],
    options: [],
    time: null,
    setTime: () => {},
    legend: () => null,
    destroy: () => {},
  };
}

function countingTarget(counts: { adds: number; removes: number }): EventTarget {
  const target = new EventTarget();
  const add = target.addEventListener.bind(target);
  const remove = target.removeEventListener.bind(target);
  target.addEventListener = ((...args: Parameters<EventTarget["addEventListener"]>) => {
    counts.adds += 1;

    return add(...args);
  }) as EventTarget["addEventListener"];
  target.removeEventListener = ((...args: Parameters<EventTarget["removeEventListener"]>) => {
    counts.removes += 1;

    return remove(...args);
  }) as EventTarget["removeEventListener"];

  return target;
}

function controlView(updates: EventTarget): LayerView {
  return {
    parts: [{
      id: "rain",
      label: "Rain",
      layerIds: ["rain"],
      controls: [{ label: "Strength", min: 0, max: 10, step: 1, value: 5, set: () => {}, updates }],
    }],
    options: [],
    time: null,
    setTime: () => {},
    legend: () => null,
    destroy: () => {},
  };
}

function strengthView(control: {
  label: string;
  min: number;
  max: number;
  step: number;
  value: number;
  set(next: number): void;
  updates: EventTarget;
}): LayerView {
  return {
    parts: [
      { id: "terrain", label: "Relief", layerIds: ["terrain"], controls: [control] },
      { id: "terrain.contours", label: "Contours", layerIds: ["terrain.contours"] },
    ],
    options: [],
    time: null,
    setTime: () => {},
    legend: () => null,
    destroy: () => {},
  };
}

function menu(): LayerMenu {
  return {
    title: "Rainfall",
    heading: "Colours",
    blocks: false,
    palettes: [
      { name: "ink-blue", label: "Ink blue", colors: ["#fff", "#036"] },
      { name: "batlow", label: "Batlow", colors: ["#019", "#fc9"] },
    ],
    defaultPalette: "ink-blue",
    custom: true,
    palette: "ink-blue",
    setPalette: () => {},
  } as LayerMenu;
}

function inputByValue(container: HTMLElement, value: string): HTMLInputElement {
  return container.querySelector(`input[value="${value}"]`) as HTMLInputElement;
}

function checkboxByLabel(container: HTMLElement, label: string): HTMLInputElement {
  const row = [...container.querySelectorAll("label")]
    .find((element) => element.textContent?.trim() === label);

  return row!.querySelector("input") as HTMLInputElement;
}

function buttonWithText(container: HTMLElement, text: string): HTMLButtonElement {
  return [...container.querySelectorAll("button")]
    .find((button) => button.textContent?.trim() === text) as HTMLButtonElement;
}

function installBrowser(window: Window): void {
  const names = [
    "Node",
    "Element",
    "HTMLElement",
    "SVGElement",
    "DocumentFragment",
    "Event",
    "CustomEvent",
    "MouseEvent",
    "KeyboardEvent",
  ] as const;
  for (const name of names) {
    defineGlobal(name, window[name]);
  }
  defineGlobal("window", window);
  defineGlobal("document", window.document);
  defineGlobal("navigator", window.navigator);
  defineGlobal("localStorage", window.localStorage);
  defineGlobal("IS_REACT_ACT_ENVIRONMENT", true);
}

function defineGlobal(name: string, value: unknown): void {
  Object.defineProperty(globalThis, name, { value, configurable: true });
}
