import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { afterEach, beforeEach, test } from "node:test";

import type { InkMenu, LayerMenu } from "../types.ts";

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
  CUSTOM_INK_NOTE,
  CUSTOM_PALETTE_NOTE,
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

test("a layer drawn as colour shows its palettes and no ink", () => {
  const { menu } = fieldMenu(false);
  const sections = sectionsOf(menu);

  assert.deepEqual(legendsOf(sections), ["Colours"]);
  assert.deepEqual(presetLabels(sections), ["Ink blue (default)", "Batlow"]);
});

test("a layer drawn as dots shows the ink presets and no palettes", () => {
  const { menu } = fieldMenu(true);
  const sections = sectionsOf(menu);

  assert.deepEqual(legendsOf(sections), ["Dot ink"]);
  assert.deepEqual(presetLabels(sections), ["Navy (default)", "White"]);
});

test("the menu follows the draw each time it is built", () => {
  const { menu, setDrawn } = fieldMenu(false);

  setDrawn(true);
  assert.deepEqual(legendsOf(sectionsOf(menu)), ["Dot ink"]);

  setDrawn(false);
  assert.deepEqual(legendsOf(sectionsOf(menu)), ["Colours"]);
});

test("choosing a preset ink applies it and reports an ink change", () => {
  const { menu, changes } = fieldMenu(true);
  const white = findRadio(sectionsOf(menu, changes), "White");

  white.onchange!();

  assert.equal(menu.ink!.value, "white");
  assert.deepEqual(changes, ["ink"]);
});

test("switching to a custom ink starts from the current preset and shows one colour input", () => {
  const { menu, changes } = fieldMenu(true);
  const sections = sectionsOf(menu, changes);

  findRadio(sections, "Custom").onchange!();

  assert.equal(menu.ink!.value, "#1a3658");
  assert.deepEqual(changes, ["ink"]);
  const inputs = descendants(sections).filter((element) => element.type === "color");
  assert.equal(inputs.length, 1);
  assert.equal(inputs[0].value, "#1a3658");
});

test("an ink that is already custom opens on the custom colour", () => {
  const { menu } = fieldMenu(true, "#102030");
  const sections = sectionsOf(menu);

  assert.equal(findRadio(sections, "Custom").checked, true);
  assert.equal(descendants(sections).filter((element) => element.type === "color").length, 1);
});

test("a palette layer offers a custom editor and a preset-only layer does not", () => {
  const { menu } = fieldMenu(false);
  const presetOnly = { ...menu, custom: false };

  assert.equal(hasRadio(sectionsOf(menu), "Custom"), true);
  assert.equal(hasRadio(sectionsOf(presetOnly), "Custom"), false);
});

test("switching a custom ink to Presets keeps that mode and notes the applied ink", () => {
  const { menu, changes } = fieldMenu(true, "#102030");
  findRadio(sectionsOf(menu), "Presets").onchange!();

  const presets = sectionsOf(menu);
  assert.equal(findRadio(presets, "Presets").checked, true);
  assert.equal(descendants(presets).filter((element) => element.type === "color").length, 0);
  assert.ok(descendants(presets).some((element) => element.textContent === CUSTOM_INK_NOTE));
  assert.deepEqual(changes, []);

  findRadio(presets, "Custom").onchange!();
  const custom = sectionsOf(menu);
  const input = descendants(custom).find((element) => element.type === "color")!;
  assert.equal(input.value, "#102030");
});

test("switching custom colours to Presets keeps that mode and the custom draft", () => {
  const { menu, changes } = fieldMenu(false, "navy", "custom-1a2b3c-88cc44");
  findRadio(sectionsOf(menu), "Presets").onchange!();

  const presets = sectionsOf(menu);
  assert.equal(findRadio(presets, "Presets").checked, true);
  assert.equal(descendants(presets).filter((element) => element.type === "color").length, 0);
  assert.ok(descendants(presets).some((element) => element.textContent === CUSTOM_PALETTE_NOTE));
  assert.deepEqual(changes, []);

  findRadio(presets, "Custom").onchange!();
  const custom = sectionsOf(menu);
  const inputs = descendants(custom).filter((element) => element.type === "color");
  assert.deepEqual(inputs.map((input) => input.value), ["#1a2b3c", "#88cc44"]);
});

test("reset layer reports a reset after applying the defaults", () => {
  const { menu, changes } = fieldMenu(false);
  const reset = descendants(sectionsOf(menu, changes))
    .find((element) => element.className === "menu-reset")!;

  reset.onclick!();

  assert.equal(changes.at(-1), "reset");
});

test("picking a preset clears the note about applied custom colours", () => {
  const { menu } = fieldMenu(false, "navy", "custom-1a2b3c-88cc44");
  findRadio(sectionsOf(menu), "Presets").onchange!();

  const presets = sectionsOf(menu);
  findRadio(presets, "Batlow").onchange!();

  assert.equal(menu.palette, "batlow");
  assert.ok(!descendants(presets).some((element) => element.textContent === CUSTOM_PALETTE_NOTE));
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

function fieldMenu(isDrawn: boolean, ink = "navy", palette = "ink-blue") {
  let isInk = isDrawn;
  let value = ink;
  let paletteValue = palette;
  const changes: string[] = [];
  const inkMenu: InkMenu = {
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
  };
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
    ink: inkMenu,
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
    ...menuMainSections(menu, "test", push),
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

function findRadio(sections: TestElement[], label: string) {
  return radios(sections).find((radio) => radio.parent!.textContent.startsWith(label))!;
}

function hasRadio(sections: TestElement[], label: string) {
  return radios(sections).some((radio) => radio.parent!.textContent === label);
}

function presetLabels(sections: TestElement[]) {
  return radios(sections)
    .map((radio) => radio.parent!.textContent)
    .filter((label) => label !== "Presets" && label !== "Custom");
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
