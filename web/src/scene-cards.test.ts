import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { afterEach, beforeEach, test } from "node:test";

import type { Map as MapLibreMap } from "maplibre-gl";

import type { MountedLayer } from "./scene-cards.ts";
import type { LayerDoc } from "./types.ts";

const cardsUrl = new URL("./scene-cards.ts", import.meta.url).href;
const sourceRoot = new URL("./", cardsUrl).href;
const hooks = registerHooks({
  resolve(specifier, context, next) {
    if (specifier.endsWith(".css")) {
      return { url: "data:text/javascript,export default {}", shortCircuit: true };
    }
    if (context.parentURL?.startsWith(sourceRoot) && specifier.startsWith(".")) {
      if (specifier.endsWith(".ts")) return next(specifier, context);
      return next(new URL(`${specifier}.ts`, context.parentURL).href, context);
    }
    return next(specifier, context);
  },
});
const { mountCards } = await import("./scene-cards.ts").finally(() => hooks.deregister());

const LAYERS = [
  {
    id: "temperature",
    title: "Temperature",
    style: { kind: "field", encodings: ["ramp", "isolines"] },
  },
  {
    id: "rainfall",
    title: "Rainfall",
    style: { kind: "field", encodings: ["ramp", "dots"] },
  },
  {
    id: "esa_worldcover",
    title: "Land cover",
    style: { kind: "categorical", encodings: ["fill"] },
  },
] as unknown as LayerDoc[];
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

test("a checked primary layer hidden by colour shows its reason and clears it when visible or off", () => {
  const box = new TestElement("div");
  mountCards(
    { setLayoutProperty: () => {} } as unknown as MapLibreMap,
    LAYERS.map(mountedLayer),
    { layers: {}, off: new Set(), colour: null },
    box as unknown as HTMLElement,
    () => {},
    null,
  );
  const land = cardTitled(box, "Land cover");

  assert.equal(reasonText(land), "Shown only in colour");
  assert.equal(descendants(box).some((element) => element.className.includes("colour-chip")), false);

  toggle(land);
  assert.equal(reasonText(land), "");

  toggle(land);
  assert.equal(reasonText(land), "Shown only in colour");

  toggle(cardTitled(box, "Temperature"));
  toggle(cardTitled(box, "Rainfall"));
  assert.equal(reasonText(land), "");

  toggle(land);
  assert.equal(reasonText(land), "");

  toggle(land);
  assert.equal(reasonText(land), "");
});

function mountedLayer(layer: LayerDoc): MountedLayer {
  return {
    layer,
    view: {
      parts: [{ id: layer.id, label: layer.title, layerIds: [layer.id] }],
      options: [],
      time: null,
      legend: () => null,
      setTime: () => {},
      destroy: () => {},
    },
  };
}

function cardTitled(box: TestElement, title: string): TestElement {
  return box.children.find((child) => child.attributes["aria-label"] === title)!;
}

function reasonText(card: TestElement): string {
  return card.children.find((child) => child.className === "option-note")!.textContent;
}

function toggle(card: TestElement): void {
  const input = card.querySelector("input")!;
  input.checked = !input.checked;
  input.onchange!();
}

function descendants(element: TestElement): TestElement[] {
  return element.children.flatMap((child) => [child, ...descendants(child)]);
}

class TestElement {
  readonly children: TestElement[] = [];
  readonly style: Record<string, string> = {};
  readonly attributes: Record<string, string> = {};
  readonly tagName: string;
  parent: TestElement | null = null;
  className = "";
  type = "";
  value = "";
  checked = false;
  hidden = false;
  onchange: (() => void) | null = null;
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

  setAttribute(name: string, value: string) {
    this.attributes[name] = value;
  }

  querySelector(selector: string): TestElement | null {
    const tagName = selector.replace(/[^a-z]/gi, "") || "input";
    return descendants(this).find((element) => element.tagName === tagName) ?? null;
  }

  append(...nodes: (TestElement | string)[]) {
    for (const node of nodes) this.adopt(node, this.children.length);
  }

  adopt(node: TestElement | string, index: number) {
    const child = typeof node === "string" ? textNode(node) : node;
    child.parent = this;
    this.children.splice(index, 0, child);
  }
}

function textNode(text: string): TestElement {
  const node = new TestElement("#text");
  node.textContent = text;
  return node;
}
