import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { mock, test } from "node:test";

import { Window } from "happy-dom";
// Tests sit outside the tsconfig, so tsx gives them the classic JSX runtime.
import React from "react";

import { createSceneStore } from "../scene-store.ts";
import { DEFAULT_OUTLINE } from "../display-state.ts";
import { assertSameNode } from "../testing/dom-assert.ts";
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
  assert.match(container.textContent ?? "", /Temperature now shows as isotherms\./);
  assert.equal(inputByValue(container, "colour").checked, true);

  await act(async () => root.unmount());
});

test("a layer with one draw offers Colour and Hidden", async (context) => {
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

  const section = container.querySelector(".show-as");
  assert.ok(section);
  assert.match(section?.textContent ?? "", /Colour/);
  assert.match(section?.textContent ?? "", /Hidden/);
  assert.equal(inputByValue(container, "colour").checked, true);
  assert.equal(inputByValue(container, "hidden").checked, false);
  assert.match(container.querySelector(".editor-colours")?.textContent ?? "", /Colours/);

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

test("an Escape claimed by an inner control keeps the editor open", async (context) => {
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
    const claimed = new window.KeyboardEvent("keydown", { key: "Escape", cancelable: true });
    claimed.preventDefault();
    window.dispatchEvent(claimed);
  });
  assert.equal(closed, 0);
  assert.ok(container.querySelector(".layer-editor"));

  await act(async () => {
    window.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Escape" }));
  });
  assert.equal(closed, 1);

  await act(async () => root.unmount());
});

test("Area Outline opens its colour and thickness editor from Edit", async (context) => {
  const window = new Window({ url: "http://localhost" });
  context.after(() => window.happyDOM.abort());
  installBrowser(window);
  const { act } = await import("react");
  const { mountSceneColumn } = await import("./scene-column.tsx");
  const store = createSceneStore([RAIN], display());
  const container = document.createElement("div");
  document.body.append(container);

  let column: { unmount(): void } | null = null;
  await act(async () => {
    column = mountSceneColumn(container, {
      mounted: [{ layer: RAIN, view: fieldView("rain") }],
      blend: null,
      store,
    });
  });

  for (const title of ["Area Outline", "Map details"]) {
    await act(async () => {
      editButtonFor(container, title)
        .dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
    });
    const panel = container.querySelector(".layer-editor") as HTMLElement;
    assert.equal(panel.getAttribute("aria-label"), `Edit ${title}`);
    assert.equal(panel.querySelector("h2")?.textContent, title);
    const legends = [...panel.querySelectorAll("fieldset > legend")]
      .map((element) => element.textContent);
    if (title === "Area Outline") assert.deepEqual(legends, ["Colour", "Thickness"]);
    else assert.deepEqual(legends, []);
    assert.equal(editButtonFor(container, title).getAttribute("aria-expanded"), "true");
    assert.equal(cardFor(container, title).classList.contains("editing"), true);

    await act(async () => {
      buttonWithText(container, "Close")
        .dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
    });
    assertSameNode(container.querySelector(".layer-editor"), null);
    assertSameNode(document.activeElement, editButtonFor(container, title));
  }

  await act(async () => column!.unmount());
});

test("Reset layer keeps the layer's Show as choice", async (context) => {
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

  assert.deepEqual(store.getSnapshot().display.showAs, { rain: "colour" });
  assert.equal(store.getSnapshot().allocation.owner, "rain");

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

  const batlow = swatchByLabel(container, "Batlow");
  await act(async () => {
    batlow.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
  });
  assertSameNode(container.querySelector(".colour-notice"), null);

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
  assertSameNode(container.querySelector(".colour-notice"), null);

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
    });
  });

  const edits = () => [...container.querySelectorAll("button.edit-button")] as HTMLButtonElement[];
  await act(async () => {
    edits()[0].dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
  });
  const panel = container.querySelector(".layer-editor") as HTMLElement;
  assertSameNode(document.activeElement, panel);

  const close = buttonWithText(container, "Close");
  await act(async () => {
    close.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
  });
  assertSameNode(container.querySelector(".layer-editor"), null);
  assertSameNode(document.activeElement, edits()[0]);

  await act(async () => {
    edits()[0].dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
  });
  assertSameNode(document.activeElement, container.querySelector(".layer-editor"));

  await act(async () => {
    window.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Escape" }));
  });
  assertSameNode(container.querySelector(".layer-editor"), null);
  assertSameNode(document.activeElement, edits()[0]);

  await act(async () => {
    edits()[0].dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
  });
  await act(async () => {
    edits()[1].dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
  });
  const swapped = container.querySelector(".layer-editor") as HTMLElement;
  assert.match(swapped.getAttribute("aria-label") ?? "", /Temperature/);
  assertSameNode(document.activeElement, swapped);

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
    });
  });

  const title = () => container.querySelector(".card-title")?.textContent ?? "";
  const master = () => container.querySelector('input[role="switch"]') as HTMLInputElement;
  assert.equal(title(), "Terrain · Contours");
  assert.equal(master().checked, true);

  await act(async () => {
    master().dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
  });
  assert.equal(title(), "Terrain · Off");
  assert.equal(master().checked, false);

  await act(async () => {
    master().dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
  });
  assert.equal(title(), "Terrain · Contours");
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
    });
  });

  const blendSwitch = () => {
    const cards = [...container.querySelectorAll(".card")];
    const card = cards.find((element) => element.textContent?.includes("Blended"));
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

test("part controls live in Options with no Parts heading", async (context) => {
  const window = new Window({ url: "http://localhost" });
  context.after(() => window.happyDOM.abort());
  installBrowser(window);
  const { act } = await import("react");
  const { createRoot } = await import("react-dom/client");
  const { LayerEditor } = await import("./layer-editor.tsx");
  const store = createSceneStore([RAIN], display());
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);

  await act(async () => root.render(
    <Harness
      Editor={LayerEditor}
      target={{ unit: "rain", title: "Rainfall", view: controlView(new EventTarget()) }}
      layers={[RAIN]}
      store={store}
    />,
  ));

  assertSameNode(container.querySelector(".editor-parts"), null);
  assert.ok(container.querySelector(".editor-options"));
  assert.ok(container.querySelector(".editor-options .part-controls input"));

  await act(async () => root.unmount());
});

test("a single part needs no on/off checkbox", async (context) => {
  const window = new Window({ url: "http://localhost" });
  context.after(() => window.happyDOM.abort());
  installBrowser(window);
  const { act } = await import("react");
  const { createRoot } = await import("react-dom/client");
  const { LayerEditor } = await import("./layer-editor.tsx");
  const store = createSceneStore([RAIN], display());
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);

  await act(async () => root.render(
    <Harness
      Editor={LayerEditor}
      target={{ unit: "rain", title: "Rainfall", view: fieldView("rain") }}
      layers={[RAIN]}
      store={store}
    />,
  ));

  const boxes = [...container.querySelectorAll(".editor-options input[type=\"checkbox\"]")];
  assert.equal(boxes.length, 1);
  assert.match(boxes[0].closest("label")?.textContent ?? "", /Smooth/);

  await act(async () => root.unmount());
});

test("multi-part layers keep per-part checkboxes in Options", async (context) => {
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

  assertSameNode(container.querySelector(".editor-parts"), null);
  assert.ok(checkboxByLabel(container, "Relief"));
  assert.ok(checkboxByLabel(container, "Contours"));
  assert.ok(container.querySelector(".editor-options")?.contains(checkboxByLabel(container, "Relief")));

  await act(async () => root.unmount());
});

test("the terrain editor keeps the contours switch without the interval text", async (context) => {
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

  assert.ok(checkboxByLabel(container, "Contours"));
  assert.doesNotMatch(container.textContent ?? "", /Contours every/);

  await act(async () => root.unmount());
});

test("Show as offers Hidden alongside each draw", async (context) => {
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
      target={{ unit: "temp", title: "Temperature", view: fieldView("temp") }}
      layers={[RAIN, TEMPERATURE]}
      store={store}
    />,
  ));

  const section = container.querySelector(".show-as");
  assert.ok(section);
  assert.match(section?.textContent ?? "", /Colour/);
  assert.match(section?.textContent ?? "", /Isotherms/);
  assert.match(section?.textContent ?? "", /Hidden/);
  assert.ok(!/Lines/.test(section?.textContent ?? ""));

  await act(async () => root.unmount());
});

test("Hidden is selected while the unit is off and a draw shows again", async (context) => {
  const window = new Window({ url: "http://localhost" });
  context.after(() => window.happyDOM.abort());
  installBrowser(window);
  const { act } = await import("react");
  const { createRoot } = await import("react-dom/client");
  const { LayerEditor } = await import("./layer-editor.tsx");
  const store = createSceneStore([RAIN, TEMPERATURE], {
    layers: {},
    off: new Set(["rain"]),
    showAs: {},
  });
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

  assert.equal(inputByValue(container, "hidden").checked, true);
  assert.equal(inputByValue(container, "dots").checked, false);

  await act(async () => {
    inputByValue(container, "dots")
      .dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
  });

  assert.equal(store.getSnapshot().display.off.has("rain"), false);
  assert.equal(inputByValue(container, "dots").checked, true);
  assert.equal(inputByValue(container, "hidden").checked, false);

  await act(async () => root.unmount());
});

test("Hidden is selected while hidden by allocation", async (context) => {
  const window = new Window({ url: "http://localhost" });
  context.after(() => window.happyDOM.abort());
  installBrowser(window);
  const { act } = await import("react");
  const { createRoot } = await import("react-dom/client");
  const { LayerEditor } = await import("./layer-editor.tsx");
  const landOnly = layer("land", "Land cover", ["fill"]);
  const tempOnly = layer("temp", "Temperature", ["ramp", "isolines"]);
  const store = createSceneStore([landOnly, tempOnly], display());
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);

  await act(async () => root.render(
    <Harness
      Editor={LayerEditor}
      target={{ unit: "land", title: "Land cover", view: fieldView("land") }}
      layers={[landOnly, tempOnly]}
      store={store}
    />,
  ));

  assert.equal(store.getSnapshot().allocation.owner, "temp");
  assert.equal(inputByValue(container, "hidden").checked, true);
  assert.equal(inputByValue(container, "colour").checked, false);

  await act(async () => root.unmount());
});

test("clicking Hidden while hidden by allocation switches the unit off", async (context) => {
  const window = new Window({ url: "http://localhost" });
  context.after(() => window.happyDOM.abort());
  installBrowser(window);
  const { act } = await import("react");
  const { createRoot } = await import("react-dom/client");
  const { LayerEditor } = await import("./layer-editor.tsx");
  const landOnly = layer("land", "Land cover", ["fill"]);
  const tempOnly = layer("temp", "Temperature", ["ramp", "isolines"]);
  const store = createSceneStore([landOnly, tempOnly], display());
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);

  await act(async () => root.render(
    <Harness
      Editor={LayerEditor}
      target={{ unit: "land", title: "Land cover", view: fieldView("land") }}
      layers={[landOnly, tempOnly]}
      store={store}
    />,
  ));

  assert.equal(inputByValue(container, "hidden").checked, true);

  await act(async () => {
    inputByValue(container, "hidden")
      .dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
  });

  assert.equal(store.getSnapshot().display.off.has("land"), true);
  assert.equal(inputByValue(container, "hidden").checked, true);

  await act(async () => root.unmount());
});

test("choosing Hidden switches the unit off", async (context) => {
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

  await act(async () => {
    inputByValue(container, "hidden")
      .dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
  });

  assert.equal(store.getSnapshot().display.off.has("rain"), true);
  assert.equal(inputByValue(container, "hidden").checked, true);

  await act(async () => root.unmount());
});

test("the editor shows Low and High on one line", async (context) => {
  const window = new Window({ url: "http://localhost" });
  context.after(() => window.happyDOM.abort());
  installBrowser(window);
  const { act } = await import("react");
  const { createRoot } = await import("react-dom/client");
  const { LayerEditor } = await import("./layer-editor.tsx");
  const store = createSceneStore([RAIN], display());
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);

  await act(async () => root.render(
    <Harness
      Editor={LayerEditor}
      target={{ unit: "rain", title: "Rainfall", view: rangeView() }}
      layers={[RAIN]}
      store={store}
    />,
  ));

  const low = container.querySelector('input[aria-label="Low"]') as HTMLInputElement;
  const high = container.querySelector('input[aria-label="High"]') as HTMLInputElement;
  assert.ok(low);
  assert.ok(high);
  assertSameNode(low.closest(".range-row"), high.closest(".range-row"));

  await act(async () => root.unmount());
});

test("a convertible layer offers a Units choice and others show none", async (context) => {
  const window = new Window({ url: "http://localhost" });
  context.after(() => window.happyDOM.abort());
  installBrowser(window);
  const { act } = await import("react");
  const { createRoot } = await import("react-dom/client");
  const { LayerEditor } = await import("./layer-editor.tsx");
  const store = createSceneStore([RAIN], display());
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);

  await act(async () => root.render(
    <Harness
      Editor={LayerEditor}
      target={{ unit: "rain", title: "Rainfall", view: unitsView("rain", "mm/month") }}
      layers={[RAIN]}
      store={store}
    />,
  ));
  assert.ok(container.querySelector(".editor-units"));
  assert.ok(inputByValue(container, "mm/month"));
  assert.ok(inputByValue(container, "in/month"));

  await act(async () => root.render(
    <Harness
      Editor={LayerEditor}
      target={{ unit: "land", title: "Land cover", view: fieldView("land") }}
      layers={[LAND]}
      store={store}
    />,
  ));
  assertSameNode(container.querySelector(".editor-units"), null);

  await act(async () => root.unmount());
});

test("choosing inches updates the store and Reset returns to millimetres", async (context) => {
  const window = new Window({ url: "http://localhost" });
  context.after(() => window.happyDOM.abort());
  installBrowser(window);
  const { act } = await import("react");
  const { createRoot } = await import("react-dom/client");
  const { LayerEditor } = await import("./layer-editor.tsx");
  const store = createSceneStore([RAIN], display());
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const view = unitsView("rain", "mm/month");

  await act(async () => root.render(
    <Harness
      Editor={LayerEditor}
      target={{ unit: "rain", title: "Rainfall", view }}
      layers={[RAIN]}
      store={store}
    />,
  ));

  await act(async () => {
    inputByValue(container, "in/month")
      .dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
  });
  assert.equal(store.getSnapshot().display.layers.rain?.units, "in/month");

  await act(async () => {
    buttonWithText(container, "Reset layer")
      .dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
  });
  await act(async () => {
    buttonWithText(container, "Reset")
      .dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
  });
  assert.equal(store.getSnapshot().display.layers.rain?.units, undefined);

  await act(async () => root.unmount());
});

test("the notice fades and clears after about three seconds", async (context) => {
  const window = new Window({ url: "http://localhost" });
  context.after(() => {
    mock.timers.reset();
    window.happyDOM.abort();
  });
  installBrowser(window);
  mock.timers.enable({ apis: ["setTimeout"] });
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

  await act(async () => {
    inputByValue(container, "colour")
      .dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
  });
  assert.ok(container.querySelector(".colour-notice"));
  assertSameNode(container.querySelector(".colour-notice.fading"), null);

  await act(async () => {
    mock.timers.tick(3 * 1000);
  });
  assert.ok(container.querySelector(".colour-notice.fading"));

  await act(async () => {
    mock.timers.tick(1600);
  });
  assertSameNode(container.querySelector(".colour-notice"), null);

  await act(async () => root.unmount());
});

test("a new notice restarts the fade timer", async (context) => {
  const window = new Window({ url: "http://localhost" });
  context.after(() => {
    mock.timers.reset();
    window.happyDOM.abort();
  });
  installBrowser(window);
  mock.timers.enable({ apis: ["setTimeout"] });
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

  await act(async () => {
    inputByValue(container, "colour")
      .dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
  });
  await act(async () => {
    mock.timers.tick(2 * 1000);
  });
  assertSameNode(container.querySelector(".colour-notice.fading"), null);

  await act(async () => {
    inputByValue(container, "hidden")
      .dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
  });
  assertSameNode(container.querySelector(".colour-notice"), null);

  await act(async () => {
    inputByValue(container, "colour")
      .dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
  });
  await act(async () => {
    mock.timers.tick(2 * 1000);
  });
  assertSameNode(container.querySelector(".colour-notice.fading"), null);

  await act(async () => {
    mock.timers.tick(1000);
  });
  assert.ok(container.querySelector(".colour-notice.fading"));

  await act(async () => root.unmount());
});

test("unmounting clears the notice timer", async (context) => {
  const window = new Window({ url: "http://localhost" });
  context.after(() => {
    mock.timers.reset();
    window.happyDOM.abort();
  });
  installBrowser(window);
  mock.timers.enable({ apis: ["setTimeout"] });
  const { act } = await import("react");
  const { createRoot } = await import("react-dom/client");
  const { LayerEditor } = await import("./layer-editor.tsx");

  const notices: Array<string | null> = [];
  function SpyHarness({
    Editor,
    target,
    layers,
    store,
  }: {
    Editor: typeof import("./layer-editor.tsx").LayerEditor;
    target: { unit: string; title: string; view: LayerView };
    layers: readonly LayerDoc[];
    store: ReturnType<typeof createSceneStore>;
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
        onNotice={(text) => {
          notices.push(text);
          setNotice(text);
        }}
        onClose={() => {}}
      />
    );
  }

  const target = { unit: "rain", title: "Rainfall", view: fieldView("rain") };
  const layers = [RAIN, TEMPERATURE];

  const firstStore = createSceneStore([RAIN, TEMPERATURE], display());
  const firstHost = document.createElement("div");
  document.body.append(firstHost);
  const firstRoot = createRoot(firstHost);
  await act(async () => firstRoot.render(
    <SpyHarness Editor={LayerEditor} target={target} layers={layers} store={firstStore} />,
  ));

  await act(async () => {
    inputByValue(firstHost, "colour")
      .dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
  });
  assert.ok(firstHost.querySelector(".colour-notice"));
  assert.equal(notices.length, 1);

  await act(async () => firstRoot.unmount());
  await act(async () => {
    mock.timers.tick(4 * 1000);
  });
  assert.equal(notices.length, 1);

  const secondStore = createSceneStore([RAIN, TEMPERATURE], display());
  const secondHost = document.createElement("div");
  document.body.append(secondHost);
  const secondRoot = createRoot(secondHost);
  await act(async () => secondRoot.render(
    <SpyHarness Editor={LayerEditor} target={target} layers={layers} store={secondStore} />,
  ));

  await act(async () => {
    inputByValue(secondHost, "colour")
      .dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
  });
  const beforeFade = notices.length;
  await act(async () => {
    mock.timers.tick(3 * 1000);
  });
  assert.ok(secondHost.querySelector(".colour-notice.fading"));
  assert.equal(notices.length, beforeFade);

  await act(async () => secondRoot.unmount());
  await act(async () => {
    mock.timers.tick(4 * 1000);
  });
  assert.equal(notices.length, beforeFade);
});

test("palette choices are swatches with Custom last and no extra chrome", async (context) => {
  const window = new Window({ url: "http://localhost" });
  context.after(() => window.happyDOM.abort());
  installBrowser(window);
  const { act } = await import("react");
  const { createRoot } = await import("react-dom/client");
  const { LayerEditor } = await import("./layer-editor.tsx");
  const store = createSceneStore([RAIN], display());
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);

  await act(async () => root.render(
    <Harness
      Editor={LayerEditor}
      target={{ unit: "rain", title: "Rainfall", view: fieldView("rain") }}
      layers={[RAIN]}
      store={store}
    />,
  ));

  const group = container.querySelector(".editor-colours [role=\"radiogroup\"]") as HTMLElement;
  assert.equal(group.getAttribute("aria-label"), "Colours");
  const radios = [...group.querySelectorAll('input[type="radio"]')] as HTMLInputElement[];
  assert.deepEqual(radios.map((radio) => radio.value), ["ink-blue", "batlow", "custom"]);
  assert.deepEqual(
    radios.map((radio) => radio.getAttribute("aria-label")),
    ["Ink blue (default)", "Batlow", "Custom"],
  );
  assert.equal(container.querySelector(".swatch-default"), null);
  assert.equal(container.querySelector(".mode-switch"), null);
  assert.doesNotMatch(container.textContent ?? "", /currently shows/);
  assert.equal(container.querySelector(".swatch-caption")?.textContent, "Ink blue (default)");

  await act(async () => root.unmount());
});

test("picking a palette swatch applies it", async (context) => {
  const window = new Window({ url: "http://localhost" });
  context.after(() => window.happyDOM.abort());
  installBrowser(window);
  const { act } = await import("react");
  const { createRoot } = await import("react-dom/client");
  const { LayerEditor } = await import("./layer-editor.tsx");
  const store = createSceneStore([RAIN], display());
  let paletteValue = "ink-blue";
  const view = fieldView("rain");
  const base = view.menu!;
  view.menu = {
    ...base,
    get palette() {
      return paletteValue;
    },
    setPalette: (next: string) => {
      paletteValue = next;
    },
  } as LayerMenu;
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);

  await act(async () => root.render(
    <Harness Editor={LayerEditor} target={{ unit: "rain", title: "Rainfall", view }} layers={[RAIN]} store={store} />,
  ));

  await act(async () => {
    swatchByLabel(container, "Batlow")
      .dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
  });
  assert.equal(paletteValue, "batlow");

  await act(async () => root.unmount());
});

test("Reset keeps a stored custom palette in the Custom box", async (context) => {
  const window = new Window({ url: "http://localhost" });
  context.after(() => window.happyDOM.abort());
  installBrowser(window);
  const { act } = await import("react");
  const { createRoot } = await import("react-dom/client");
  const { LayerEditor } = await import("./layer-editor.tsx");
  const store = createSceneStore([RAIN], display());
  let paletteValue = "ink-blue";
  const view = fieldView("rain");
  const base = view.menu!;
  view.menu = {
    ...base,
    get palette() {
      return paletteValue;
    },
    setPalette: (next: string) => {
      paletteValue = next;
    },
  } as LayerMenu;
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);

  await act(async () => root.render(
    <Harness Editor={LayerEditor} target={{ unit: "rain", title: "Rainfall", view }} layers={[RAIN]} store={store} />,
  ));

  await act(async () => {
    swatchByLabel(container, "Custom")
      .dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
  });
  assert.match(paletteValue, /^custom-/);
  const seeded = paletteValue;
  assert.ok(container.querySelector(".custom-colors input"));

  await act(async () => {
    buttonWithText(container, "Reset layer")
      .dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
  });
  await act(async () => {
    buttonWithText(container, "Reset")
      .dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
  });
  assert.equal(paletteValue, "ink-blue");
  assert.equal(container.querySelector(".custom-colors"), null);
  assert.equal(container.querySelector(".swatch-face.custom-empty"), null);

  await act(async () => {
    swatchByLabel(container, "Custom")
      .dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
  });
  assert.equal(paletteValue, seeded);

  await act(async () => root.unmount());
});

test("ink choices are swatches and Reset keeps a stored custom ink", async (context) => {
  const window = new Window({ url: "http://localhost" });
  context.after(() => window.happyDOM.abort());
  installBrowser(window);
  const { act } = await import("react");
  const { createRoot } = await import("react-dom/client");
  const { LayerEditor } = await import("./layer-editor.tsx");
  const store = createSceneStore([RAIN], display());
  let inkValue = "navy";
  const view = fieldView("rain");
  const base = view.menu!;
  view.menu = {
    ...base,
    ink: {
      heading: "Dot ink",
      presets: [
        { name: "navy", label: "Navy", colors: ["#1a3658"] },
        { name: "white", label: "White", colors: ["#ffffff"] },
      ],
      defaultInk: "navy",
      get inUse() {
        return true;
      },
      get value() {
        return inkValue;
      },
      set: (next: string) => {
        inkValue = next;
      },
    },
  } as LayerMenu;
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);

  await act(async () => root.render(
    <Harness Editor={LayerEditor} target={{ unit: "rain", title: "Rainfall", view }} layers={[RAIN]} store={store} />,
  ));

  const group = container.querySelector(".editor-colours [role=\"radiogroup\"]") as HTMLElement;
  assert.equal(group.getAttribute("aria-label"), "Dot ink");
  const radios = [...group.querySelectorAll('input[type="radio"]')] as HTMLInputElement[];
  assert.deepEqual(radios.map((radio) => radio.value), ["navy", "white", "custom"]);
  assert.equal(container.querySelector(".mode-switch"), null);
  assert.doesNotMatch(container.textContent ?? "", /currently shows/);

  await act(async () => {
    swatchByLabel(container, "Custom")
      .dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
  });
  assert.equal(inkValue, "#1a3658");
  const customInput = container.querySelector(
    '.custom-colors input, .editor-colours input[type="color"]',
  ) as HTMLInputElement;
  assert.ok(customInput);

  await act(async () => {
    customInput.value = "#102030";
    customInput.dispatchEvent(new window.Event("change", { bubbles: true }));
  });
  assert.equal(inkValue, "#102030");

  await act(async () => {
    buttonWithText(container, "Reset layer")
      .dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
  });
  await act(async () => {
    buttonWithText(container, "Reset")
      .dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
  });
  assert.equal(inkValue, "navy");

  await act(async () => {
    swatchByLabel(container, "Custom")
      .dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
  });
  assert.equal(inkValue, "#102030");

  await act(async () => root.unmount());
});

test("the outline editor shows six swatches plus Custom with graphite checked", async (context) => {
  const window = new Window({ url: "http://localhost" });
  context.after(() => window.happyDOM.abort());
  installBrowser(window);
  const { act } = await import("react");
  const { createRoot } = await import("react-dom/client");
  const { OutlineEditor } = await import("./layer-editor.tsx");
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);

  await act(async () => root.render(
    <OutlineEditor
      outline={{ shown: true, color: "graphite", widthPx: 1.5 }}
      onChange={() => {}}
    />,
  ));

  const group = container.querySelector(".editor-colours [role=\"radiogroup\"]") as HTMLElement;
  assert.equal(group.getAttribute("aria-label"), "Colour");
  const radios = [...group.querySelectorAll('input[type="radio"]')] as HTMLInputElement[];
  assert.deepEqual(
    radios.map((radio) => radio.value),
    ["graphite", "black", "navy", "brown", "deep-red", "white", "custom"],
  );
  assert.deepEqual(
    radios.map((radio) => radio.getAttribute("aria-label")),
    ["Graphite (default)", "Black", "Navy", "Brown", "Deep red", "White", "Custom"],
  );
  assert.equal(swatchByLabel(container, "Graphite (default)").checked, true);
  assert.equal(container.querySelector(".swatch-face.custom-empty")?.textContent, "+");
  assertSameNode(container.querySelector('input[type="color"]'), null);
  assert.deepEqual(
    [...container.querySelectorAll("legend")].map((legend) => legend.textContent),
    ["Colour", "Thickness"],
  );

  const slider = container.querySelector('input[type="range"]') as HTMLInputElement;
  assert.equal(slider.getAttribute("aria-label"), "Outline thickness");
  assert.equal(slider.getAttribute("aria-valuetext"), "1.5 pixels");
  assert.equal(slider.min, "0.5");
  assert.equal(slider.max, "4");
  assert.equal(slider.step, "0.5");
  assert.equal(slider.value, "1.5");
  assert.equal(container.querySelector("output")?.textContent, "1.5 px");

  await act(async () => root.unmount());
});

test("picking a colour while the outline is off turns it on", async (context) => {
  const window = new Window({ url: "http://localhost" });
  context.after(() => window.happyDOM.abort());
  installBrowser(window);
  const { act } = await import("react");
  const { createRoot } = await import("react-dom/client");
  const { OutlineEditor } = await import("./layer-editor.tsx");
  const changes: { shown: boolean; color: string; widthPx: number }[] = [];
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);

  await act(async () => root.render(
    <OutlineEditor
      outline={{ shown: false, color: "graphite", widthPx: 1.5 }}
      onChange={(next) => changes.push(next)}
    />,
  ));

  await act(async () => {
    swatchByLabel(container, "Navy")
      .dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
  });

  assert.deepEqual(changes, [{ shown: true, color: "navy", widthPx: 1.5 }]);

  await act(async () => root.unmount());
});

test("the outline editor shows no explanatory note while the outline is off", async (context) => {
  const window = new Window({ url: "http://localhost" });
  context.after(() => window.happyDOM.abort());
  installBrowser(window);
  const { act } = await import("react");
  const { createRoot } = await import("react-dom/client");
  const { OutlineEditor } = await import("./layer-editor.tsx");
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);

  await act(async () => root.render(
    <OutlineEditor
      outline={{ shown: false, color: "graphite", widthPx: 2 }}
      onChange={() => {}}
    />,
  ));

  assertSameNode(container.querySelector(".off-note"), null);
  assert.doesNotMatch(container.textContent ?? "", /turns it on/);

  await act(async () => root.unmount());
});

test("Custom seeds from the shown colour and remembers the custom hex", async (context) => {
  const window = new Window({ url: "http://localhost" });
  context.after(() => window.happyDOM.abort());
  installBrowser(window);
  const { act } = await import("react");
  const { createRoot } = await import("react-dom/client");
  const { OutlineEditor } = await import("./layer-editor.tsx");
  const changes: { shown: boolean; color: string; widthPx: number }[] = [];
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const render = (outline: { shown: boolean; color: string; widthPx: number }) =>
    act(async () => root.render(
      <OutlineEditor outline={outline} onChange={(next) => changes.push(next)} />,
    ));

  await render({ shown: true, color: "graphite", widthPx: 1.5 });

  await act(async () => {
    swatchByLabel(container, "Custom")
      .dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
  });
  assert.deepEqual(changes.at(-1), { shown: true, color: "#333333", widthPx: 1.5 });

  await render({ shown: true, color: "#333333", widthPx: 1.5 });
  const well = container.querySelector('input[type="color"]') as HTMLInputElement;
  assert.equal(well.value, "#333333");

  await act(async () => {
    well.value = "#102030";
    well.dispatchEvent(new window.Event("change", { bubbles: true }));
  });
  assert.deepEqual(changes.at(-1), { shown: true, color: "#102030", widthPx: 1.5 });

  await render({ shown: true, color: "navy", widthPx: 1.5 });
  assert.match(
    container.querySelector(".swatch-option:last-child .swatch-face")?.getAttribute("style") ?? "",
    /102030|16, 32, 48/,
  );

  await act(async () => {
    swatchByLabel(container, "Custom")
      .dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
  });
  assert.deepEqual(changes.at(-1), { shown: true, color: "#102030", widthPx: 1.5 });

  await act(async () => root.unmount());
});

test("the thickness slider commits the width with a labelled preview", async (context) => {
  const window = new Window({ url: "http://localhost" });
  context.after(() => window.happyDOM.abort());
  installBrowser(window);
  const { act } = await import("react");
  const { createRoot } = await import("react-dom/client");
  const { OutlineEditor } = await import("./layer-editor.tsx");
  const changes: { shown: boolean; color: string; widthPx: number }[] = [];
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);

  await act(async () => root.render(
    <OutlineEditor
      outline={{ shown: true, color: "white", widthPx: 1 }}
      onChange={(next) => changes.push(next)}
    />,
  ));

  const preview = container.querySelector(".line-preview i") as HTMLElement;
  assert.match(preview.style.background, /255|ffffff/i);
  assert.equal(preview.style.height, "1px");
  assert.match(preview.style.boxShadow, /999|153/);

  const slider = container.querySelector('input[type="range"]') as HTMLInputElement;
  await act(async () => {
    setRange(window, slider, "2.5");
  });
  assert.deepEqual(changes, [{ shown: true, color: "white", widthPx: 2.5 }]);

  await act(async () => root.render(
    <OutlineEditor
      outline={{ shown: true, color: "white", widthPx: 2.5 }}
      onChange={(next) => changes.push(next)}
    />,
  ));
  assert.equal(container.querySelector("output")?.textContent, "2.5 px");
  assert.equal(
    (container.querySelector('input[type="range"]') as HTMLInputElement)
      .getAttribute("aria-valuetext"),
    "2.5 pixels",
  );

  await act(async () => root.unmount());
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
  return {
    layers: {},
    off: new Set<string>(),
    showAs,
    outline: { ...DEFAULT_OUTLINE },
  };
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

function rangeView(): LayerView {
  const base = fieldView("rain");

  return {
    ...base,
    menu: {
      ...base.menu!,
      range: {
        fitted: [0, 10],
        bounds: [-10, 20],
        decimals: 1,
        units: "mm",
        value: null,
        set: () => {},
      },
    },
  };
}

function unitsView(id: string, native: string): LayerView {
  const base = fieldView(id);
  let value = native;
  const options = native === "mm/month" ? ["mm/month", "in/month"] : ["°C", "°F"];

  return {
    ...base,
    menu: {
      ...base.menu!,
      units: {
        options,
        defaultUnit: native,
        get value() {
          return value;
        },
        set: (next: string) => {
          value = next;
        },
      },
    },
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

function swatchByLabel(container: HTMLElement, label: string): HTMLInputElement {
  return container.querySelector(`.swatch-option input[aria-label="${label}"]`) as HTMLInputElement;
}

function setRange(window: Window, slider: HTMLInputElement, value: string): void {
  const native = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value");
  native?.set?.call(slider, value);
  slider.dispatchEvent(new window.Event("input", { bubbles: true }));
  slider.dispatchEvent(new window.Event("change", { bubbles: true }));
}

function buttonWithText(container: HTMLElement, text: string): HTMLButtonElement {
  return [...container.querySelectorAll("button")]
    .find((button) => button.textContent?.trim() === text) as HTMLButtonElement;
}

function cardFor(container: HTMLElement, title: string): HTMLElement {
  return [...container.querySelectorAll(".card")]
    .find((card) => card.querySelector(".card-title")?.textContent === title) as HTMLElement;
}

function editButtonFor(container: HTMLElement, title: string): HTMLButtonElement {
  return cardFor(container, title).querySelector(".edit-button") as HTMLButtonElement;
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
