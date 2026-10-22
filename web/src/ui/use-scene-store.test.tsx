import assert from "node:assert/strict";
import { test } from "node:test";

import { Window } from "happy-dom";
// Tests sit outside the tsconfig, so tsx gives them the classic JSX runtime.
import React from "react";

import { createSceneStore } from "../scene-store.ts";
import type { LayerDoc } from "../types.ts";

const RAIN = layer("rain", ["ramp", "dots"]);
const TEMP = layer("temp", ["ramp", "isolines"]);
const LAYERS = [RAIN, TEMP];

test("useSceneStore re-renders when a Show as choice is dispatched", async (context) => {
  const window = new Window();
  context.after(() => window.happyDOM.abort());
  installBrowser(window);
  const { act } = await import("react");
  const { createRoot } = await import("react-dom/client");
  const { useSceneStore } = await import("./use-scene-store.ts");
  const store = createSceneStore(LAYERS, { layers: {}, off: new Set(), showAs: {} });

  function Label(): React.ReactElement {
    const { allocation } = useSceneStore(store);

    return <span>{allocation.owner}</span>;
  }

  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);

  await act(async () => root.render(<Label />));
  assert.equal(container.textContent, "temp");

  await act(async () => {
    store.dispatch({ kind: "choose", unit: "rain", draw: "colour" });
  });
  assert.equal(container.textContent, "rain");

  await act(async () => root.unmount());
});

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
  ] as const;
  for (const name of names) {
    defineGlobal(name, window[name]);
  }
  defineGlobal("window", window);
  defineGlobal("document", window.document);
  defineGlobal("navigator", window.navigator);
  defineGlobal("IS_REACT_ACT_ENVIRONMENT", true);
}

function defineGlobal(name: string, value: unknown): void {
  Object.defineProperty(globalThis, name, { value, configurable: true });
}

function layer(id: string, encodings: string[]): LayerDoc {
  return {
    id,
    style: { kind: "field", encodings },
  } as unknown as LayerDoc;
}
