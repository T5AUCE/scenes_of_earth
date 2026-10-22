import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { test } from "node:test";

import { Window } from "happy-dom";
// Tests sit outside the tsconfig, so tsx gives them the classic JSX runtime.
import React from "react";

import type { RangeMenu } from "../types.ts";

registerHooks({
  resolve(specifier, context, next) {
    if (specifier.endsWith(".css")) {
      return { url: "data:text/javascript,export default {}", shortCircuit: true };
    }

    return next(specifier, context);
  },
});

test("a valid low and high applies the range", async (context) => {
  const window = new Window({ url: "http://localhost" });
  context.after(() => window.happyDOM.abort());
  installBrowser(window);
  const { act } = await import("react");
  const { createRoot } = await import("react-dom/client");
  const { RangeSection } = await import("./range-section.tsx");
  const { range, sets, changes } = testRange({ fitted: [0, 10] });
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);

  await act(async () => root.render(<RangeSection range={range} onChange={onChange(changes)} />));

  await act(async () => {
    setNumber(container, "Low", "2");
  });
  await act(async () => {
    setNumber(container, "High", "8");
  });
  await act(async () => {
    commitWithEnter(container, "Low");
  });

  assert.deepEqual(sets.at(-1), [2, 8]);
  assert.deepEqual(changes, ["range"]);

  await act(async () => root.unmount());
});

test("a low above the high reverts to the shown range", async (context) => {
  const window = new Window({ url: "http://localhost" });
  context.after(() => window.happyDOM.abort());
  installBrowser(window);
  const { act } = await import("react");
  const { createRoot } = await import("react-dom/client");
  const { RangeSection } = await import("./range-section.tsx");
  const { range, sets, changes } = testRange({ fitted: [0, 10] });
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);

  await act(async () => root.render(<RangeSection range={range} onChange={onChange(changes)} />));

  await act(async () => {
    setNumber(container, "Low", "8");
  });
  await act(async () => {
    setNumber(container, "High", "2");
  });
  await act(async () => {
    commitWithEnter(container, "Low");
  });

  assert.equal(sets.length, 0);
  assert.deepEqual(changes, []);
  assert.equal(inputByLabel(container, "Low").value, "0");
  assert.equal(inputByLabel(container, "High").value, "10");

  await act(async () => root.unmount());
});

test("an empty input reverts to the shown range", async (context) => {
  const window = new Window({ url: "http://localhost" });
  context.after(() => window.happyDOM.abort());
  installBrowser(window);
  const { act } = await import("react");
  const { createRoot } = await import("react-dom/client");
  const { RangeSection } = await import("./range-section.tsx");
  const { range, sets } = testRange({ fitted: [0, 10], value: [2, 8] });
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);

  await act(async () => root.render(<RangeSection range={range} onChange={() => {}} />));

  await act(async () => {
    setNumber(container, "Low", "");
  });
  await act(async () => {
    commitWithEnter(container, "Low");
  });

  assert.equal(sets.length, 0);
  assert.equal(inputByLabel(container, "Low").value, "2");
  assert.equal(inputByLabel(container, "High").value, "8");

  await act(async () => root.unmount());
});

test("Reset returns to the fitted range", async (context) => {
  const window = new Window({ url: "http://localhost" });
  context.after(() => window.happyDOM.abort());
  installBrowser(window);
  const { act } = await import("react");
  const { createRoot } = await import("react-dom/client");
  const { RangeSection } = await import("./range-section.tsx");
  const { range, sets, changes } = testRange({ fitted: [0, 10], value: [2, 8] });
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);

  await act(async () => root.render(<RangeSection range={range} onChange={onChange(changes)} />));

  const reset = container.querySelector(".range-reset") as HTMLButtonElement;
  assert.equal(reset.disabled, false);

  await act(async () => {
    reset.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
  });

  assert.deepEqual(sets.at(-1), null);
  assert.deepEqual(changes, ["range"]);

  await act(async () => root.unmount());
});

test("Low and High share one line", async (context) => {
  const window = new Window({ url: "http://localhost" });
  context.after(() => window.happyDOM.abort());
  installBrowser(window);
  const { act } = await import("react");
  const { createRoot } = await import("react-dom/client");
  const { RangeSection } = await import("./range-section.tsx");
  const { range } = testRange({});
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);

  await act(async () => root.render(<RangeSection range={range} onChange={() => {}} />));

  const low = inputByLabel(container, "Low");
  const high = inputByLabel(container, "High");
  assert.equal(low.closest(".range-row"), high.closest(".range-row"));
  assert.ok(low.closest(".range-row"));

  await act(async () => root.unmount());
});

test("leaving an unchanged range without edits keeps the fitted stops", async (context) => {
  const window = new Window({ url: "http://localhost" });
  context.after(() => window.happyDOM.abort());
  installBrowser(window);
  const { act } = await import("react");
  const { createRoot } = await import("react-dom/client");
  const { RangeSection } = await import("./range-section.tsx");
  const { range, sets, changes } = testRange({ fitted: [0, 10] });
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);

  await act(async () => root.render(<RangeSection range={range} onChange={onChange(changes)} />));

  await act(async () => {
    blurInput(container, "Low");
  });
  await act(async () => {
    blurInput(container, "High");
  });

  assert.equal(sets.length, 0);
  assert.deepEqual(changes, []);
  assert.equal(inputByLabel(container, "Low").value, "0");
  assert.equal(inputByLabel(container, "High").value, "10");

  await act(async () => root.unmount());
});

test("Enter followed by blur commits only once", async (context) => {
  const window = new Window({ url: "http://localhost" });
  context.after(() => window.happyDOM.abort());
  installBrowser(window);
  const { act } = await import("react");
  const { createRoot } = await import("react-dom/client");
  const { RangeSection } = await import("./range-section.tsx");
  const { range, sets, changes } = testRange({ fitted: [0, 10] });
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);

  await act(async () => root.render(<RangeSection range={range} onChange={onChange(changes)} />));

  await act(async () => {
    setNumber(container, "Low", "2");
  });
  await act(async () => {
    setNumber(container, "High", "8");
  });
  await act(async () => {
    commitWithEnter(container, "Low");
  });
  await act(async () => {
    blurInput(container, "Low");
  });

  assert.deepEqual(sets, [[2, 8]]);
  assert.deepEqual(changes, ["range"]);

  await act(async () => root.unmount());
});

test("inches show converted stops and store millimetres", async (context) => {
  const window = new Window({ url: "http://localhost" });
  context.after(() => window.happyDOM.abort());
  installBrowser(window);
  const { act } = await import("react");
  const { createRoot } = await import("react-dom/client");
  const { RangeSection } = await import("./range-section.tsx");
  const { range, sets, changes } = testRange({ fitted: [0, 25.4], displayUnit: "in/month" });
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);

  await act(async () => root.render(<RangeSection range={range} onChange={onChange(changes)} />));

  assert.equal(inputByLabel(container, "Low").value, "0");
  assert.equal(inputByLabel(container, "High").value, "1");
  assert.match(container.textContent ?? "", /in\/month/);

  await act(async () => {
    setNumber(container, "Low", "0");
  });
  await act(async () => {
    setNumber(container, "High", "5");
  });
  await act(async () => {
    commitWithEnter(container, "Low");
  });

  assert.deepEqual(sets, [[0, 127]]);
  assert.deepEqual(changes, ["range"]);

  await act(async () => root.unmount());
});

test("a fractional inch stores the exact millimetres and redisplays stably", async (context) => {
  const window = new Window({ url: "http://localhost" });
  context.after(() => window.happyDOM.abort());
  installBrowser(window);
  const { act } = await import("react");
  const { createRoot } = await import("react-dom/client");
  const { RangeSection } = await import("./range-section.tsx");
  const { range, sets } = testRange({ fitted: [0, 25.4], displayUnit: "in/month" });
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);

  await act(async () => root.render(<RangeSection range={range} onChange={() => {}} />));

  await act(async () => {
    setNumber(container, "Low", "0");
  });
  await act(async () => {
    setNumber(container, "High", "0.1");
  });
  await act(async () => {
    commitWithEnter(container, "Low");
  });

  assert.deepEqual(sets, [[0, 2.54]]);
  assert.equal(inputByLabel(container, "High").value, "0.1");

  await act(async () => root.unmount());
});

test("an untouched endpoint keeps its stored native through display rounding", async (context) => {
  const window = new Window({ url: "http://localhost" });
  context.after(() => window.happyDOM.abort());
  installBrowser(window);
  const { act } = await import("react");
  const { createRoot } = await import("react-dom/client");
  const { RangeSection } = await import("./range-section.tsx");
  const { range, sets } = testRange({
    fitted: [0, 25.4],
    value: [0, 2.54],
    displayUnit: "in/month",
  });
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);

  await act(async () => root.render(<RangeSection range={range} onChange={() => {}} />));

  await act(async () => {
    setNumber(container, "High", "5");
  });
  await act(async () => {
    commitWithEnter(container, "High");
  });

  assert.deepEqual(sets, [[0, 127]]);

  await act(async () => root.unmount());
});

test("an edited low beside a non-round high keeps the high native", async (context) => {
  const window = new Window({ url: "http://localhost" });
  context.after(() => window.happyDOM.abort());
  installBrowser(window);
  const { act } = await import("react");
  const { createRoot } = await import("react-dom/client");
  const { RangeSection } = await import("./range-section.tsx");
  const { convertValue } = await import("../units.ts");
  const { range, sets } = testRange({ fitted: [0, 2.6], displayUnit: "in/month" });
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);

  await act(async () => root.render(<RangeSection range={range} onChange={() => {}} />));

  assert.equal(inputByLabel(container, "Low").value, "0");
  assert.equal(inputByLabel(container, "High").value, "0.102");

  await act(async () => {
    setNumber(container, "Low", "0.102");
  });
  await act(async () => {
    commitWithEnter(container, "Low");
  });

  const expectedLow = convertValue(0.102, "in/month", "mm/month");
  assert.deepEqual(sets, [[expectedLow, 2.6]]);

  await act(async () => root.unmount());
});

test("a unit swap never shows more than the shown decimals", async (context) => {
  const window = new Window({ url: "http://localhost" });
  context.after(() => window.happyDOM.abort());
  installBrowser(window);
  const { act } = await import("react");
  const { createRoot } = await import("react-dom/client");
  const { RangeSection } = await import("./range-section.tsx");
  const { range } = testRange({ fitted: [0, 2.6], displayUnit: "in/month" });
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);

  await act(async () => root.render(<RangeSection range={range} onChange={() => {}} />));

  for (const label of ["Low", "High"]) {
    const text = inputByLabel(container, label).value;
    const decimals = text.includes(".") ? text.split(".")[1].length : 0;

    assert.ok(decimals <= 3, `${label} shows ${text}`);
  }
  assert.equal(inputByLabel(container, "High").value, "0.102");

  await act(async () => root.unmount());
});

test("a Fahrenheit edit stores exact Celsius and redisplays stably", async (context) => {
  const window = new Window({ url: "http://localhost" });
  context.after(() => window.happyDOM.abort());
  installBrowser(window);
  const { act } = await import("react");
  const { createRoot } = await import("react-dom/client");
  const { RangeSection } = await import("./range-section.tsx");
  const { convertValue } = await import("../units.ts");
  const { range, sets } = testRange({
    fitted: [0, 30],
    units: "°C",
    decimals: 1,
    displayUnit: "°F",
  });
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);

  await act(async () => root.render(<RangeSection range={range} onChange={() => {}} />));

  assert.equal(inputByLabel(container, "Low").value, "32");
  assert.equal(inputByLabel(container, "High").value, "86");

  await act(async () => {
    setNumber(container, "Low", "32");
  });
  await act(async () => {
    setNumber(container, "High", "100");
  });
  await act(async () => {
    commitWithEnter(container, "Low");
  });

  const expectedHigh = convertValue(100, "°F", "°C");
  assert.deepEqual(sets, [[0, expectedHigh]]);
  assert.equal(inputByLabel(container, "High").value, "100");

  await act(async () => root.unmount());
});

function testRange({ fitted = [0, 10], value = null, displayUnit, units, decimals }: {
  fitted?: [number, number];
  value?: [number, number] | null;
  displayUnit?: string;
  units?: string;
  decimals?: number;
}): {
  range: RangeMenu;
  sets: Array<[number, number] | null>;
  changes: string[];
} {
  let current = value;
  const sets: Array<[number, number] | null> = [];
  const changes: string[] = [];
  const native = units ?? "mm/month";
  const range: RangeMenu = {
    fitted,
    bounds: [-10, 20],
    decimals: decimals ?? 1,
    units: native,
    get displayUnit() {
      return displayUnit ?? native;
    },
    get value() {
      return current;
    },
    set: (next) => {
      current = next;
      sets.push(next);
    },
  };

  return { range, sets, changes };
}

function onChange(changes: string[]): (change: "range") => void {
  return (change) => {
    changes.push(change);
  };
}

function inputByLabel(container: HTMLElement, label: string): HTMLInputElement {
  const row = [...container.querySelectorAll("label")]
    .find((element) => element.textContent?.includes(label));

  return row!.querySelector("input") as HTMLInputElement;
}

function setNumber(container: HTMLElement, label: string, text: string): void {
  const input = inputByLabel(container, label);
  input.value = text;
  input.dispatchEvent(new window.Event("input", { bubbles: true }));
}

function commitWithEnter(container: HTMLElement, label: string): void {
  inputByLabel(container, label)
    .dispatchEvent(new window.KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
}

function blurInput(container: HTMLElement, label: string): void {
  const input = inputByLabel(container, label);
  input.focus();
  input.blur();
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
