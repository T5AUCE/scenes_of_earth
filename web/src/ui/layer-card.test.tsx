import assert from "node:assert/strict";
import { test } from "node:test";

import { Window } from "happy-dom";
// Tests sit outside the tsconfig, so tsx gives them the classic JSX runtime.
import React from "react";

test("a card shows its legend, title, master switch and Edit button", async (context) => {
  const window = new Window({ url: "http://localhost" });
  context.after(() => window.happyDOM.abort());
  installBrowser(window);
  const { act } = await import("react");
  const { createRoot } = await import("react-dom/client");
  const { LayerCard } = await import("./layer-card.tsx");
  const legend = document.createElement("div");
  legend.textContent = "legend";
  let toggled: boolean | null = null;
  let edited = 0;

  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);

  await act(async () => root.render(
    <LayerCard
      title="Rainfall · dots, smoothed"
      checked
      onToggle={(on) => {
        toggled = on;
      }}
      onEdit={() => edited++}
      legend={legend}
    />,
  ));

  assert.match(container.textContent ?? "", /Rainfall · dots, smoothed/);
  assert.equal(container.querySelector(".card-legend")?.textContent, "legend");
  const input = container.querySelector('input[role="switch"]') as HTMLInputElement;
  assert.equal(input.checked, true);

  await act(async () => {
    input.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
  });
  assert.equal(toggled, false);

  await act(async () => {
    container.querySelector("button")!
      .dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
  });
  assert.equal(edited, 1);

  await act(async () => root.unmount());
});

test("a card without Edit keeps only its switch", async (context) => {
  const window = new Window({ url: "http://localhost" });
  context.after(() => window.happyDOM.abort());
  installBrowser(window);
  const { act } = await import("react");
  const { createRoot } = await import("react-dom/client");
  const { LayerCard } = await import("./layer-card.tsx");

  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);

  await act(async () => root.render(
    <LayerCard title="Area outline" checked onToggle={() => {}} legend={null} />,
  ));

  assert.equal(container.querySelectorAll("button").length, 0);
  assert.equal(container.querySelectorAll('input[role="switch"]').length, 1);

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
