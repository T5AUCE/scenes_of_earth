import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { test } from "node:test";

import { Window } from "happy-dom";
// Tests sit outside the tsconfig, so tsx gives them the classic JSX runtime.
import React from "react";

registerHooks({
  resolve(specifier, context, next) {
    if (specifier.endsWith(".css")) {
      return { url: "data:text/javascript,export default {}", shortCircuit: true };
    }

    return next(specifier, context);
  },
});

const stopsOf = (pairs: Array<[string, number]>) =>
  pairs.map(([color, position]) => ({ at: position / 100, rgb: hexToRgb(color) }));

function hexToRgb(hex: string) {
  return [1, 3, 5].map((start) => parseInt(hex.slice(start, start + 2), 16));
}

test("handles expose slider semantics in position order with a hint", async (context) => {
  const window = new Window({ url: "http://localhost" });
  context.after(() => window.happyDOM.abort());
  installBrowser(window);
  const { act } = await import("react");
  const { createRoot } = await import("react-dom/client");
  const { GradientStops } = await import("./gradient-stops.tsx");
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);

  await act(async () => root.render(
    <GradientStops
      stops={stopsOf([["#000000", 0], ["#ffffff", 100]])}
      onPreview={() => {}}
      onCommit={() => {}}
    />,
  ));

  const handles = [...container.querySelectorAll(".gradient-stop")] as HTMLElement[];
  assert.equal(handles.length, 2);
  assert.equal(handles[0].getAttribute("role"), "slider");
  assert.equal(handles[0].getAttribute("aria-label"), "Colour 1 of 2");
  assert.equal(handles[0].getAttribute("aria-valuenow"), "0");
  assert.equal(handles[0].getAttribute("aria-valuetext"), "#000000 at 0 %");
  assert.match(container.textContent ?? "", /Click the bar to add a colour/);

  await act(async () => root.unmount());
});

test("keyboard-only entry opens the detail row on the focused handle", async (context) => {
  const window = new Window({ url: "http://localhost" });
  context.after(() => window.happyDOM.abort());
  installBrowser(window);
  const { act } = await import("react");
  const { createRoot } = await import("react-dom/client");
  const { GradientStops } = await import("./gradient-stops.tsx");
  const committed: number[] = [];
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);

  await act(async () => root.render(
    <GradientStops
      stops={stopsOf([["#000000", 0], ["#ffffff", 100]])}
      onPreview={() => {}}
      onCommit={(next) => committed.push(next.length)}
    />,
  ));

  await act(async () => handleByLabel(container, "Colour 1 of 2").focus());
  await act(async () => {
    document.activeElement!.dispatchEvent(
      new window.KeyboardEvent("keydown", { key: "Enter", bubbles: true }),
    );
  });

  const well = container.querySelector('.stop-detail input[type="color"]') as HTMLInputElement;
  assert.ok(well);
  assert.equal(document.activeElement, well);
  assert.equal(committed.length, 0);

  await act(async () => handleByLabel(container, "Colour 2 of 2").focus());
  await act(async () => {
    document.activeElement!.dispatchEvent(
      new window.KeyboardEvent("keydown", { key: "Enter", bubbles: true }),
    );
  });

  const hex = container.querySelector(
    '.stop-detail input[type="text"]',
  ) as HTMLInputElement;
  assert.equal(hex.getAttribute("aria-label"), "Hex colour 2 of 2");
  assert.equal(document.activeElement, well);
  assert.equal(well.value, "#ffffff");

  await act(async () => root.unmount());
});

test("a native well edit after a position edit keeps the new position", async (context) => {
  const window = new Window({ url: "http://localhost" });
  context.after(() => window.happyDOM.abort());
  installBrowser(window);
  const { act } = await import("react");
  const { createRoot } = await import("react-dom/client");
  const { GradientStops } = await import("./gradient-stops.tsx");
  const committed: Array<Array<{ at: number; rgb: number[] }>> = [];
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);

  await act(async () => root.render(
    <GradientStops
      stops={stopsOf([["#000000", 0], ["#888888", 40], ["#ffffff", 100]])}
      onPreview={() => {}}
      onCommit={(next) => committed.push(next)}
    />,
  ));

  await act(async () => handleByLabel(container, "Colour 2 of 3").focus());
  for (let step = 0; step < 20; step++) {
    await act(async () => {
      document.activeElement!.dispatchEvent(
        new window.KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }),
      );
    });
  }

  const well = container.querySelector(
    '.stop-detail input[type="color"]',
  ) as HTMLInputElement;
  await act(async () => {
    well.value = "#112233";
    well.dispatchEvent(new window.Event("input", { bubbles: true }));
  });
  await act(async () => {
    well.dispatchEvent(new window.Event("change", { bubbles: true }));
  });

  const last = committed.at(-1)!;
  assert.deepEqual(last.map(({ at }) => Math.round(at * 100)), [0, 60, 100]);
  assert.deepEqual(last[1].rgb, [0x11, 0x22, 0x33]);

  await act(async () => root.unmount());
});

test("a hex commit followed by a native change does not revert on blur", async (context) => {
  const window = new Window({ url: "http://localhost" });
  context.after(() => window.happyDOM.abort());
  installBrowser(window);
  const { act } = await import("react");
  const { createRoot } = await import("react-dom/client");
  const { GradientStops } = await import("./gradient-stops.tsx");
  const committed: string[] = [];
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);

  await act(async () => root.render(
    <GradientStops
      stops={stopsOf([["#000000", 0], ["#ffffff", 100]])}
      onPreview={() => {}}
      onCommit={(next) => committed.push(next.map(({ rgb }) => rgb.join(",")).join("|"))}
    />,
  ));

  await act(async () => {
    const first = handleByLabel(container, "Colour 1 of 2");
    first.dispatchEvent(pointerDown(window, 10, 10));
    first.dispatchEvent(pointerUp(window, 10, 10));
  });

  const hex = () => container.querySelector(
    '.stop-detail input[type="text"]',
  ) as HTMLInputElement;
  await act(async () => {
    hex().value = "#112233";
    hex().dispatchEvent(new window.KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
  });
  assert.equal(committed.length, 1);

  const well = container.querySelector(
    '.stop-detail input[type="color"]',
  ) as HTMLInputElement;
  await act(async () => {
    well.value = "#445566";
    well.dispatchEvent(new window.Event("change", { bubbles: true }));
  });
  assert.equal(committed.length, 2);
  assert.equal(hex().value, "#445566");

  await act(async () => {
    hex().dispatchEvent(new window.Event("blur", { bubbles: true }));
  });
  assert.equal(committed.length, 2);

  await act(async () => root.unmount());
});

test("a pull-to-remove released before its frame never previews the old stops", async (context) => {
  const window = new Window({ url: "http://localhost" });
  context.after(() => window.happyDOM.abort());
  installBrowser(window);
  const { act } = await import("react");
  const { createRoot } = await import("react-dom/client");
  const { GradientStops } = await import("./gradient-stops.tsx");
  const previews: number[] = [];
  const commits: number[] = [];
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);

  await act(async () => root.render(
    <GradientStops
      stops={stopsOf([["#000000", 0], ["#888888", 40], ["#ffffff", 100]])}
      onPreview={() => previews.push(1)}
      onCommit={() => commits.push(1)}
    />,
  ));

  mockBarRect(container, { left: 0, width: 200, bottom: 24 });
  const handle = handleByLabel(container, "Colour 2 of 3");
  await act(async () => {
    handle.dispatchEvent(pointerDown(window, 80, 10));
  });
  await act(async () => {
    handle.dispatchEvent(pointerMove(window, 120, 100));
  });
  await act(async () => {
    handle.dispatchEvent(pointerUp(window, 120, 100));
  });
  assert.deepEqual(commits, [1]);
  assert.equal(container.querySelectorAll(".gradient-stop").length, 2);

  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 35));
  });
  assert.deepEqual(previews, []);
  assert.match(liveRegion(container), /Colour removed/);

  await act(async () => root.unmount());
});

test("crossing a neighbour then releasing off the handle still commits", async (context) => {
  const window = new Window({ url: "http://localhost" });
  context.after(() => window.happyDOM.abort());
  installBrowser(window);
  const { act } = await import("react");
  const { createRoot } = await import("react-dom/client");
  const { GradientStops } = await import("./gradient-stops.tsx");
  const committed: Array<Array<{ at: number }>> = [];
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);

  await act(async () => root.render(
    <GradientStops
      stops={stopsOf([["#000000", 0], ["#888888", 30], ["#ff0000", 60], ["#ffffff", 100]])}
      onPreview={() => {}}
      onCommit={(next) => committed.push(next)}
    />,
  ));

  mockBarRect(container, { left: 0, width: 200, bottom: 24 });
  const handle = handleByLabel(container, "Colour 2 of 4");
  await act(async () => {
    handle.dispatchEvent(pointerDown(window, 60, 10));
  });
  await act(async () => {
    handle.dispatchEvent(pointerMove(window, 140, 10));
    handle.dispatchEvent(pointerMove(window, 150, 10));
  });
  await act(async () => {
    const bar = container.querySelector(".gradient-bar") as HTMLElement;
    bar.dispatchEvent(pointerUp(window, 150, 10));
  });

  assert.equal(committed.length, 1);
  assert.deepEqual(committed[0].map(({ at }) => Math.round(at * 100)), [0, 60, 75, 100]);
  assert.equal(handleByLabel(container, "Colour 3 of 4").getAttribute("aria-valuenow"), "75");

  await act(async () => root.unmount());
});

test("arrow keys move and reorder while focus follows the pin by id", async (context) => {
  const window = new Window({ url: "http://localhost" });
  context.after(() => window.happyDOM.abort());
  installBrowser(window);
  const { act } = await import("react");
  const { createRoot } = await import("react-dom/client");
  const { GradientStops } = await import("./gradient-stops.tsx");
  const committed: Array<Array<{ at: number }>> = [];
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);

  await act(async () => root.render(
    <GradientStops
      stops={stopsOf([["#000000", 0], ["#888888", 40], ["#ffffff", 60]])}
      onPreview={() => {}}
      onCommit={(next) => committed.push(next)}
    />,
  ));

  const second = handleByLabel(container, "Colour 2 of 3");
  await act(async () => second.focus());
  await act(async () => {
    second.dispatchEvent(new window.KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }));
  });
  for (let step = 0; step < 30; step++) {
    await act(async () => {
      document.activeElement!.dispatchEvent(
        new window.KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }),
      );
    });
  }

  assert.equal(committed.length > 0, true);
  const last = committed.at(-1)!;
  assert.deepEqual(last.map(({ at }) => Math.round(at * 100)), [0, 60, 71]);
  assert.equal(document.activeElement?.getAttribute("aria-label"), "Colour 3 of 3");
  const focused = document.activeElement as HTMLElement;
  assert.equal(focused.getAttribute("aria-valuetext"), "#888888 at 71 %");

  await act(async () => root.unmount());
});

test("Delete removes a stop and focuses its neighbour above the minimum", async (context) => {
  const window = new Window({ url: "http://localhost" });
  context.after(() => window.happyDOM.abort());
  installBrowser(window);
  const { act } = await import("react");
  const { createRoot } = await import("react-dom/client");
  const { GradientStops } = await import("./gradient-stops.tsx");
  const committed: number[] = [];
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);

  await act(async () => root.render(
    <GradientStops
      stops={stopsOf([["#000000", 0], ["#888888", 50], ["#ffffff", 100]])}
      onPreview={() => {}}
      onCommit={(next) => committed.push(next.length)}
    />,
  ));

  await act(async () => handleByLabel(container, "Colour 2 of 3").focus());
  await act(async () => {
    document.activeElement!.dispatchEvent(
      new window.KeyboardEvent("keydown", { key: "Delete", bubbles: true }),
    );
  });

  assert.deepEqual(committed, [2]);
  assert.match(liveRegion(container), /Colour removed/);
  assert.equal(document.activeElement?.getAttribute("aria-label"), "Colour 2 of 2");

  await act(async () => root.unmount());
});

test("the detail row keeps two stops from removal and validates hex", async (context) => {
  const window = new Window({ url: "http://localhost" });
  context.after(() => window.happyDOM.abort());
  installBrowser(window);
  const { act } = await import("react");
  const { createRoot } = await import("react-dom/client");
  const { GradientStops } = await import("./gradient-stops.tsx");
  let commits = 0;
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);

  await act(async () => root.render(
    <GradientStops
      stops={stopsOf([["#000000", 0], ["#ffffff", 100]])}
      onPreview={() => {}}
      onCommit={() => commits++}
    />,
  ));

  await act(async () => {
    const first = handleByLabel(container, "Colour 1 of 2");
    first.dispatchEvent(pointerDown(window, 10, 10));
    first.dispatchEvent(pointerUp(window, 10, 10));
  });
  const remove = buttonWithText(container, "Remove") as HTMLButtonElement;
  assert.equal(remove.disabled, true);
  assert.match(container.textContent ?? "", /at least two colours/);

  const hex = container.querySelector('.stop-detail input[type="text"]') as HTMLInputElement;
  const commitHex = () =>
    hex.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
  await act(async () => {
    hex.value = "not-a-colour";
    commitHex();
  });
  assert.equal(hex.getAttribute("aria-invalid"), "true");
  assert.equal(commits, 0);

  await act(async () => {
    hex.value = "#102030";
    commitHex();
  });
  assert.equal(commits, 1);

  await act(async () => root.unmount());
});

test("a valid hex Enter commit keeps focus in the hex box", async (context) => {
  const window = new Window({ url: "http://localhost" });
  context.after(() => window.happyDOM.abort());
  installBrowser(window);
  const { act } = await import("react");
  const { createRoot } = await import("react-dom/client");
  const { GradientStops } = await import("./gradient-stops.tsx");
  let commits = 0;
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);

  await act(async () => root.render(
    <GradientStops
      stops={stopsOf([["#000000", 0], ["#ffffff", 100]])}
      onPreview={() => {}}
      onCommit={() => commits++}
    />,
  ));

  await act(async () => {
    const first = handleByLabel(container, "Colour 1 of 2");
    first.dispatchEvent(pointerDown(window, 10, 10));
    first.dispatchEvent(pointerUp(window, 10, 10));
  });

  const hex = container.querySelector('.stop-detail input[type="text"]') as HTMLInputElement;
  await act(async () => hex.focus());
  assert.equal(document.activeElement, hex);

  await act(async () => {
    hex.value = "#102030";
    hex.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
  });
  assert.equal(commits, 1);
  assert.equal(document.activeElement, hex);
  assert.equal(hex.value, "#102030");

  await act(async () => root.unmount());
});

test("Escape in the detail row returns to the handle without closing", async (context) => {
  const window = new Window({ url: "http://localhost" });
  context.after(() => window.happyDOM.abort());
  installBrowser(window);
  const { act } = await import("react");
  const { createRoot } = await import("react-dom/client");
  const { GradientStops } = await import("./gradient-stops.tsx");
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);

  await act(async () => root.render(
    <GradientStops
      stops={stopsOf([["#000000", 0], ["#ffffff", 100]])}
      onPreview={() => {}}
      onCommit={() => {}}
    />,
  ));

  await act(async () => {
    const first = handleByLabel(container, "Colour 1 of 2");
    first.dispatchEvent(pointerDown(window, 10, 10));
    first.dispatchEvent(pointerUp(window, 10, 10));
  });
  const hex = container.querySelector('.stop-detail input[type="text"]') as HTMLInputElement;
  await act(async () => hex.focus());

  let prevented = false;
  await act(async () => {
    const event = new window.KeyboardEvent("keydown", {
      key: "Escape",
      bubbles: true,
      cancelable: true,
    });
    hex.dispatchEvent(event);
    prevented = event.defaultPrevented;
  });

  assert.equal(prevented, true);
  assert.equal(document.activeElement?.getAttribute("aria-label"), "Colour 1 of 2");

  await act(async () => root.unmount());
});

test("clicking the bar adds a stop and announces it", async (context) => {
  const window = new Window({ url: "http://localhost" });
  context.after(() => window.happyDOM.abort());
  installBrowser(window);
  const { act } = await import("react");
  const { createRoot } = await import("react-dom/client");
  const { GradientStops } = await import("./gradient-stops.tsx");
  const committed: Array<Array<{ at: number }>> = [];
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);

  await act(async () => root.render(
    <GradientStops
      stops={stopsOf([["#000000", 0], ["#ffffff", 100]])}
      onPreview={() => {}}
      onCommit={(next) => committed.push(next)}
    />,
  ));

  mockBarRect(container, { left: 0, width: 200, bottom: 24 });
  await act(async () => {
    const bar = container.querySelector(".gradient-bar") as HTMLElement;
    bar.dispatchEvent(pointerDown(window, 80, 10));
  });

  assert.equal(committed.length, 1);
  assert.deepEqual(committed[0].map(({ at }) => Math.round(at * 100)), [0, 40, 100]);
  assert.match(liveRegion(container), /Colour added at 40 %/);
  assert.equal(document.activeElement?.getAttribute("aria-valuenow"), "40");

  await act(async () => root.unmount());
});

test("eight stops refuse a ninth with the limit announcement", async (context) => {
  const window = new Window({ url: "http://localhost" });
  context.after(() => window.happyDOM.abort());
  installBrowser(window);
  const { act } = await import("react");
  const { createRoot } = await import("react-dom/client");
  const { GradientStops } = await import("./gradient-stops.tsx");
  let commits = 0;
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const eight = [0, 14, 28, 42, 57, 71, 85, 100].map((position) => ({
    at: position / 100,
    rgb: [position * 2, position, 255 - position],
  }));

  await act(async () => root.render(
    <GradientStops stops={eight} onPreview={() => {}} onCommit={() => commits++} />,
  ));

  mockBarRect(container, { left: 0, width: 200, bottom: 24 });
  await act(async () => {
    const bar = container.querySelector(".gradient-bar") as HTMLElement;
    bar.dispatchEvent(pointerDown(window, 100, 10));
  });

  assert.equal(commits, 0);
  assert.match(liveRegion(container), /Up to 8 colours/);

  await act(async () => root.unmount());
});

test("a drag previews once per frame and commits only on release", async (context) => {
  const window = new Window({ url: "http://localhost" });
  context.after(() => window.happyDOM.abort());
  installBrowser(window);
  const { act } = await import("react");
  const { createRoot } = await import("react-dom/client");
  const { GradientStops } = await import("./gradient-stops.tsx");
  const previews: number[] = [];
  const commits: number[] = [];
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);

  await act(async () => root.render(
    <GradientStops
      stops={stopsOf([["#000000", 0], ["#888888", 40], ["#ffffff", 100]])}
      onPreview={() => previews.push(1)}
      onCommit={() => commits.push(1)}
    />,
  ));

  mockBarRect(container, { left: 0, width: 200, bottom: 24 });
  const handle = handleByLabel(container, "Colour 2 of 3");
  await act(async () => {
    handle.dispatchEvent(pointerDown(window, 80, 10));
  });
  await act(async () => {
    handle.dispatchEvent(pointerMove(window, 100, 10));
    handle.dispatchEvent(pointerMove(window, 110, 10));
    handle.dispatchEvent(pointerMove(window, 120, 10));
  });
  assert.equal(commits.length, 0);
  assert.equal(previews.length, 0);

  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 30));
  });
  assert.equal(previews.length, 1);

  await act(async () => {
    handle.dispatchEvent(pointerUp(window, 120, 10));
  });
  assert.equal(commits.length, 1);
  assert.equal(handleByLabel(container, "Colour 2 of 3").getAttribute("aria-valuenow"), "60");

  await act(async () => root.unmount());
});

function handleByLabel(container: HTMLElement, label: string): HTMLElement {
  return container.querySelector(`.gradient-stop[aria-label="${label}"]`) as HTMLElement;
}

function liveRegion(container: HTMLElement): string {
  return container.querySelector('[aria-live="polite"]')?.textContent ?? "";
}

function buttonWithText(container: HTMLElement, text: string): HTMLButtonElement {
  return [...container.querySelectorAll("button")]
    .find((button) => button.textContent?.trim() === text) as HTMLButtonElement;
}

function mockBarRect(
  container: HTMLElement,
  rect: { left: number; width: number; bottom: number },
): void {
  const bar = container.querySelector(".gradient-bar") as HTMLElement;
  bar.getBoundingClientRect = () => ({
    left: rect.left,
    width: rect.width,
    bottom: rect.bottom,
    top: 0,
    right: rect.left + rect.width,
    height: 24,
    x: rect.left,
    y: 0,
    toJSON: () => {},
  });
}

function pointerEvent(window: Window, type: string, x: number, y: number): Event {
  const event = new window.MouseEvent(type, { bubbles: true, clientX: x, clientY: y });
  (event as unknown as { pointerId: number }).pointerId = 1;
  return event;
}

function pointerDown(window: Window, x: number, y: number): Event {
  return pointerEvent(window, "pointerdown", x, y);
}

function pointerMove(window: Window, x: number, y: number): Event {
  return pointerEvent(window, "pointermove", x, y);
}

function pointerUp(window: Window, x: number, y: number): Event {
  return pointerEvent(window, "pointerup", x, y);
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
