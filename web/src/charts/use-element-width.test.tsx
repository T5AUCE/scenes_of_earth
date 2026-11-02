import assert from "node:assert/strict";
import { test } from "node:test";

import { Window } from "happy-dom";
// Tests sit outside the tsconfig, so tsx gives them the classic JSX runtime.
import React from "react";

import { FALLBACK_WIDTH_PX } from "./use-element-width.ts";

test("the hook falls back without an observer", async (context) => {
  const window = new Window({ url: "http://localhost" });
  context.after(() => window.happyDOM.abort());
  installBrowser(window);
  const previous = (globalThis as Record<string, unknown>).ResizeObserver;
  Reflect.deleteProperty(globalThis, "ResizeObserver");
  context.after(() => {
    (globalThis as Record<string, unknown>).ResizeObserver = previous;
  });
  const { act } = await import("react");
  const { createRoot } = await import("react-dom/client");
  const { useElementWidth } = await import("./use-element-width.ts");

  let seen = -1;
  function Probe() {
    const [, width] = useElementWidth();

    seen = width;
    return <div />;
  }

  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  await act(async () => {
    root.render(<Probe />);
  });
  assert.equal(seen, FALLBACK_WIDTH_PX);
  await act(async () => {
    root.unmount();
  });
});

test("the hook follows the observer and disconnects on teardown", async (context) => {
  const window = new Window({ url: "http://localhost" });
  context.after(() => window.happyDOM.abort());
  installBrowser(window);
  const observed: unknown[] = [];
  let disconnects = 0;
  let notify: ((width: number) => void) | null = null;
  class TestObserver {
    constructor(callback: (entries: { contentRect: { width: number } }[]) => void) {
      notify = (width: number) => callback([{ contentRect: { width } }]);
    }

    observe(target: unknown) {
      observed.push(target);
    }

    disconnect() {
      disconnects += 1;
    }
  }
  const previous = (globalThis as Record<string, unknown>).ResizeObserver;
  (globalThis as Record<string, unknown>).ResizeObserver = TestObserver;
  context.after(() => {
    (globalThis as Record<string, unknown>).ResizeObserver = previous;
  });
  const { act } = await import("react");
  const { createRoot } = await import("react-dom/client");
  const { useElementWidth } = await import("./use-element-width.ts");

  let seen = -1;
  function Probe() {
    const [ref, width] = useElementWidth(100);

    seen = width;
    return <div ref={ref} />;
  }

  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  await act(async () => {
    root.render(<Probe />);
  });
  assert.equal(observed.length, 1);
  await act(async () => {
    notify?.(480);
  });
  assert.equal(seen, 480);
  await act(async () => {
    root.unmount();
  });
  assert.equal(disconnects, 1);
});

function installBrowser(window: Window): void {
  const names = [
    "Node",
    "Element",
    "HTMLElement",
    "HTMLDivElement",
    "SVGElement",
    "DocumentFragment",
    "Event",
    "CustomEvent",
    "MouseEvent",
    "KeyboardEvent",
  ] as const;
  for (const name of names) defineGlobal(name, window[name]);
  defineGlobal("window", window);
  defineGlobal("document", window.document);
  defineGlobal("navigator", window.navigator);
  defineGlobal("IS_REACT_ACT_ENVIRONMENT", true);
}

function defineGlobal(name: string, value: unknown): void {
  Object.defineProperty(globalThis, name, { value, configurable: true, writable: true });
}
