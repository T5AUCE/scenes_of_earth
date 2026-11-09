import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { afterEach, beforeEach, test } from "node:test";

import type { LayerMenu } from "../types.ts";

const menuUrl = new URL("./layer-menu.ts", import.meta.url).href;
const hooks = registerHooks({
  resolve(specifier, context, next) {
    if (context.parentURL !== menuUrl || !specifier.startsWith(".")) {
      return next(specifier, context);
    }

    return next(new URL(`${specifier}.ts`, context.parentURL).href, context);
  },
});
const {
  menuMainSections,
  menuResetButton,
} = await import("./layer-menu.ts").finally(() => hooks.deregister());

const originalDocument = Object.getOwnPropertyDescriptor(globalThis, "document");

beforeEach(() => {
  Object.assign(globalThis, {
    document: { createElement: (tagName: string) => new TestElement(tagName) },
  });
});

afterEach(() => {
  if (originalDocument) Object.defineProperty(globalThis, "document", originalDocument);
  else Reflect.deleteProperty(globalThis, "document");
});

test("the menu shows the edge section without colour radios or notes", () => {
  const { menu } = fieldMenu(false);
  menu.edges = {
    controls: [{ label: "Smoothing", min: 0, max: 0.6, step: 0.05, value: 0.25, set: () => {} }],
    outline: { value: false, set: () => {} },
    get isDefault() {
      return true;
    },
    reset: () => {},
  };
  const sections = sectionsOf(menu);

  assert.deepEqual(legendsOf(sections), ["Edges"]);
  assert.equal(radios(sections).length, 0);
  assert.ok(!descendants(sections).some((element) => element.className === "mode-switch"));
  assert.ok(!descendants(sections).some((element) => element.className === "swatches"));
});

test("a menu without edges has no sections left", () => {
  const { menu } = fieldMenu(false);

  assert.deepEqual(menuMainSections(menu), []);
});

test("reset layer reports a reset after applying the defaults", () => {
  const { menu, changes } = fieldMenu(false);
  const reset = descendants(sectionsOf(menu, changes))
    .find((element) => element.className === "menu-reset")!;

  reset.onclick!();

  assert.equal(changes.at(-1), "reset");
});

test("reset layer returns units to the bundle default", () => {
  const { menu, changes } = fieldMenu(false);
  const sets: string[] = [];
  menu.units = {
    options: ["mm/month", "in/month"],
    defaultUnit: "mm/month",
    get value() {
      return "mm/month";
    },
    set: (next: string) => {
      sets.push(next);
    },
  };
  const reset = descendants(sectionsOf(menu, changes))
    .find((element) => element.className === "menu-reset")!;

  reset.onclick!();

  assert.deepEqual(sets, ["mm/month"]);
  assert.deepEqual(changes.slice(-2), ["units", "reset"]);
});

test("the edges section shows a smoothing radius with its cells unit", () => {
  const { menu } = fieldMenu(false);
  menu.edges = {
    controls: [
      { label: "Smoothing", min: 0, max: 0.6, step: 0.05, value: 0.25, set: () => {} },
      {
        label: "Wide smoothing",
        unit: "cells",
        min: 0,
        max: 2,
        step: 0.05,
        value: 1.5,
        set: () => {},
      },
    ],
    outline: { value: false, set: () => {} },
    get isDefault() {
      return false;
    },
    reset: () => {},
  };
  const sections = sectionsOf(menu);
  const rows = descendants(sections).filter(
    (element) => element.className === "edge-control",
  );
  const smoothing = rows.find((row) => row.textContent.startsWith("Wide smoothing"))!;
  const input = descendants([smoothing]).find((element) => element.type === "range")!;

  assert.equal(input.value, "1.5");
});

function fieldMenu(isDrawn: boolean, ink = "navy", palette = "ink-blue") {
  let isInk = isDrawn;
  let value = ink;
  let paletteValue = palette;
  const changes: string[] = [];
  const menu: LayerMenu = {
    title: "Rainfall",
    heading: "Colours",
    blocks: false,
    palettes: [
      { name: "ink-blue", label: "Ink blue", colors: ["#fff", "#036"] },
      { name: "batlow", label: "Batlow", colors: ["#019", "#fc9"] },
    ],
    defaultPalette: "ink-blue",
    custom: true,
    ink: {
      heading: "Dot ink",
      presets: [
        { name: "navy", label: "Navy", colors: ["#1a3658"] },
        { name: "white", label: "White", colors: ["#ffffff"] },
      ],
      defaultInk: "navy",
      get inUse() {
        return isInk;
      },
      get value() {
        return value;
      },
      set: (next) => {
        value = next;
      },
    },
    get palette() {
      return paletteValue;
    },
    setPalette: (next) => {
      paletteValue = next;
    },
  };

  const setDrawn = (next: boolean) => {
    isInk = next;
  };
  return { menu, changes, setDrawn };
}

function sectionsOf(menu: LayerMenu, changes: string[] = []) {
  const push = (change: string) => changes.push(change);

  return [
    ...menuMainSections(menu),
    menuResetButton(menu, push, () => {}),
  ] as unknown as TestElement[];
}

function descendants(elements: TestElement[]): TestElement[] {
  return elements.flatMap((element) => [element, ...descendants(element.children)]);
}

function legendsOf(sections: TestElement[]) {
  return descendants(sections)
    .filter((element) => element.tagName === "legend")
    .map((element) => element.textContent);
}

function radios(sections: TestElement[]) {
  return descendants(sections).filter((element) => element.type === "radio");
}

class TestElement {
  readonly children: TestElement[] = [];
  readonly style: Record<string, string> = {};
  readonly tagName: string;
  parent: TestElement | null = null;
  className = "";
  type = "";
  value = "";
  checked = false;
  onchange: (() => void) | null = null;
  onclick: (() => void) | null = null;
  private text = "";

  constructor(tagName: string) {
    this.tagName = tagName;
  }

  get textContent(): string {
    return this.text + this.children.map((child) => child.textContent).join("");
  }

  set textContent(text: string) {
    this.text = text;
    this.children.length = 0;
  }

  append(...nodes: (TestElement | string)[]) {
    for (const node of nodes) this.adopt(node, this.children.length);
  }

  replaceChildren(...nodes: (TestElement | string)[]) {
    this.children.length = 0;
    this.append(...nodes);
  }

  after(...nodes: TestElement[]) {
    const siblings = this.parent!.children;
    const next = siblings.indexOf(this) + 1;
    nodes.forEach((node, offset) => this.parent!.adopt(node, next + offset));
  }

  adopt(node: TestElement | string, index: number) {
    const child = typeof node === "string" ? textNode(node) : node;
    child.parent = this;
    this.children.splice(index, 0, child);
  }
}

function textNode(text: string) {
  const node = new TestElement("#text");
  node.textContent = text;
  return node;
}
