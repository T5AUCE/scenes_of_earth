import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { test } from "node:test";

import { Window } from "happy-dom";
// Tests sit outside the tsconfig, so tsx gives them the classic JSX runtime.
import React from "react";

import type { SwatchOption } from "./swatch-picker.tsx";

registerHooks({
  resolve(specifier, context, next) {
    if (specifier.endsWith(".css")) {
      return { url: "data:text/javascript,export default {}", shortCircuit: true };
    }

    return next(specifier, context);
  },
});

test("the picker names the default for screen readers with no visual marker", async (context) => {
  const window = new Window({ url: "http://localhost" });
  context.after(() => window.happyDOM.abort());
  installBrowser(window);
  const { act } = await import("react");
  const { createRoot } = await import("react-dom/client");
  const { SwatchPicker } = await import("./swatch-picker.tsx");
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);

  await act(async () => root.render(
    <SwatchPicker
      legend="Colours"
      group="palette"
      options={paletteOptions()}
      value="ink-blue"
      defaultValue="ink-blue"
      tiles
      onSelect={() => {}}
    />,
  ));

  const group = container.querySelector('[role="radiogroup"]') as HTMLElement;
  assert.equal(group.getAttribute("aria-label"), "Colours");
  const radios = [...container.querySelectorAll('input[type="radio"]')] as HTMLInputElement[];
  assert.deepEqual(radios.map((radio) => radio.name), ["palette", "palette", "palette"]);
  assert.deepEqual(
    radios.map((radio) => radio.getAttribute("aria-label")),
    ["Ink blue (default)", "Batlow", "Custom"],
  );
  assert.equal(container.querySelector(".swatch-default"), null);
  assert.equal(container.querySelector(".swatch-caption")?.textContent, "Ink blue (default)");

  await act(async () => root.unmount());
});

test("the Custom box stays last and an empty one shows a plus", async (context) => {
  const window = new Window({ url: "http://localhost" });
  context.after(() => window.happyDOM.abort());
  installBrowser(window);
  const { act } = await import("react");
  const { createRoot } = await import("react-dom/client");
  const { SwatchPicker } = await import("./swatch-picker.tsx");
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);

  await act(async () => root.render(
    <SwatchPicker
      legend="Dot ink"
      group="ink"
      options={inkOptions([])}
      value="navy"
      defaultValue="navy"
      onSelect={() => {}}
    />,
  ));

  const radios = [...container.querySelectorAll('input[type="radio"]')] as HTMLInputElement[];
  assert.equal(radios.at(-1)?.value, "custom");
  assert.equal(radios[0].checked, true);
  const faces = [...container.querySelectorAll(".swatch-face")];
  assert.equal(faces.at(-1)?.textContent, "+");
  assert.ok(faces.at(-1)?.classList.contains("custom-empty"));

  await act(async () => root.unmount());
});

test("choosing a box selects it and shows its ring, check and caption", async (context) => {
  const window = new Window({ url: "http://localhost" });
  context.after(() => window.happyDOM.abort());
  installBrowser(window);
  const { act } = await import("react");
  const { createRoot } = await import("react-dom/client");
  const { SwatchPicker } = await import("./swatch-picker.tsx");
  const picked: string[] = [];
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);

  await act(async () => root.render(
    <SwatchPicker
      legend="Colours"
      group="palette"
      options={paletteOptions()}
      value="ink-blue"
      defaultValue="ink-blue"
      tiles
      onSelect={(next) => picked.push(next)}
    />,
  ));

  const batlow = container.querySelector('input[value="batlow"]') as HTMLInputElement;
  await act(async () => {
    batlow.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
  });
  assert.deepEqual(picked, ["batlow"]);
  const tip = batlow.closest("label")?.querySelector(".swatch-tip")?.textContent;
  assert.equal(tip, "Batlow");
  assert.ok(batlow.closest("label")?.querySelector(".swatch-check"));

  await act(async () => root.render(
    <SwatchPicker
      legend="Colours"
      group="palette"
      options={paletteOptions()}
      value="batlow"
      defaultValue="ink-blue"
      tiles
      onSelect={(next) => picked.push(next)}
    />,
  ));
  assert.equal(
    (container.querySelector('input[value="batlow"]') as HTMLInputElement).checked,
    true,
  );
  assert.equal(container.querySelector(".swatch-caption")?.textContent, "Batlow");

  await act(async () => root.unmount());
});

test("hiding the caption keeps the radio names", async (context) => {
  const window = new Window({ url: "http://localhost" });
  context.after(() => window.happyDOM.abort());
  installBrowser(window);
  const { act } = await import("react");
  const { createRoot } = await import("react-dom/client");
  const { SwatchPicker } = await import("./swatch-picker.tsx");
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);

  await act(async () => root.render(
    <SwatchPicker
      legend="Colours"
      group="palette"
      options={paletteOptions()}
      value="ink-blue"
      defaultValue="ink-blue"
      tiles
      showCaption={false}
      onSelect={() => {}}
    />,
  ));

  const radios = [...container.querySelectorAll('input[type="radio"]')] as HTMLInputElement[];
  assert.deepEqual(
    radios.map((radio) => radio.getAttribute("aria-label")),
    ["Ink blue (default)", "Batlow", "Custom"],
  );
  assert.equal(container.querySelector(".swatch-caption"), null);

  await act(async () => root.unmount());
});

test("gradient faces blend colours while block faces keep one span per colour", async (context) => {
  const window = new Window({ url: "http://localhost" });
  context.after(() => window.happyDOM.abort());
  installBrowser(window);
  const { act } = await import("react");
  const { createRoot } = await import("react-dom/client");
  const { SwatchPicker } = await import("./swatch-picker.tsx");
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);

  await act(async () => root.render(
    <SwatchPicker
      legend="Colours"
      group="palette"
      options={[
        { value: "ink-blue", label: "Ink blue", colors: ["#ffffff", "#003366"] },
        { value: "painted", label: "Painted", colors: ["#ff0000", "#00ff00"], blocks: true },
      ]}
      value="ink-blue"
      defaultValue="ink-blue"
      tiles
      onSelect={() => {}}
    />,
  ));

  const faces = [...container.querySelectorAll(".swatch-face")];
  assert.match((faces[0] as HTMLElement).style.background, /linear-gradient/);
  assert.equal(faces[1].querySelectorAll("span").length, 2);

  await act(async () => root.unmount());
});

function paletteOptions(): SwatchOption[] {
  return [
    { value: "ink-blue", label: "Ink blue", colors: ["#ffffff", "#003366"] },
    { value: "batlow", label: "Batlow", colors: ["#011959", "#facafa"] },
    { value: "custom", label: "Custom", colors: ["#1a2b3c", "#88cc44"] },
  ];
}

function inkOptions(custom: string[]): SwatchOption[] {
  return [
    { value: "navy", label: "Navy", colors: ["#1a3658"] },
    { value: "white", label: "White", colors: ["#ffffff"] },
    { value: "custom", label: "Custom", colors: custom },
  ];
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
