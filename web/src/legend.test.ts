import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { afterEach, beforeEach, test } from "node:test";

import { lut } from "./render/colormap.ts";
import { classColors, fieldGradient } from "./render/palettes.ts";

const legendUrl = new URL("./legend.ts", import.meta.url).href;
const hooks = registerHooks({
  resolve(specifier, context, next) {
    if (context.parentURL !== legendUrl || !specifier.startsWith("./")) {
      return next(specifier, context);
    }

    return next(new URL(`${specifier}.ts`, context.parentURL).href, context);
  },
});
const { classLegend, contourLegendText, gradientLegend } =
  await import("./legend.ts").finally(() => hooks.deregister());

const KENYA_RAINFALL_STOPS = [0, 10, 30, 40, 60, 80, 100, 130, 200];
const originalDocument = Object.getOwnPropertyDescriptor(globalThis, "document");

beforeEach(() => {
  Object.assign(globalThis, {
    document: { createElement: (tagName: string) => new TestElement(tagName) },
  });
});

afterEach(() => {
  if (originalDocument) {
    Object.defineProperty(globalThis, "document", originalDocument);
    return;
  }

  Reflect.deleteProperty(globalThis, "document");
});

test("the fitted Fiji contour legend describes only visible bold lines", () => {
  assert.equal(contourLegendText(1000, 100), "Contours every 1000 m (all bold)");
  assert.equal(contourLegendText(100, 100), "Contours every 100 m (all bold)");
});

test("the contour legend keeps the bold step when finer minor lines are visible", () => {
  assert.equal(contourLegendText(50, 100), "Contours every 50 m (bold every 100 m)");
  assert.equal(contourLegendText(50, 100, "ft"), "Contours every 50 ft (bold every 100 ft)");
});

test("Kenya rainfall keeps numeric ticks and shows its units once outside them", () => {
  const legend = renderLegend(KENYA_RAINFALL_STOPS, "mm/month");
  const [caption, bar, labels] = legend.children;

  assert.equal(legend.children.length, 3);
  assert.equal(caption.tagName, "div");
  assert.equal(caption.textContent, "mm/month");
  assert.equal(caption.style.position, undefined);
  assert.equal(bar.className, "legend-bar");
  assert.equal(labels.className, "legend-labels");
  assert.deepEqual(
    labels.children.map((label) => label.textContent),
    ["0", "30", "60", "100", "≥ 200"],
  );
  assert.equal(legend.textContent.split("mm/month").length - 1, 1);
  assert.ok(labels.children.every((label) => !label.textContent.includes("mm/month")));
});

test("Kenya rainfall keeps each tick at its original palette position", () => {
  const legend = renderLegend(KENYA_RAINFALL_STOPS, "mm/month");
  const labels = legend.children[2];

  assert.equal(labels.style.position, "relative");
  assert.equal(labels.style.height, "1.3em");
  assert.deepEqual(
    labels.children.map((label) => label.style.left),
    ["0%", "25%", "50%", "75%", "100%"],
  );
  assert.deepEqual(
    labels.children.map((label) => label.style.transform),
    [
      "translateX(0%)",
      "translateX(-25%)",
      "translateX(-50%)",
      "translateX(-75%)",
      "translateX(-100%)",
    ],
  );
  assert.ok(labels.children.every((label) => label.style.position === "absolute"));
  assert.ok(labels.children.every((label) => label.style.whiteSpace === "nowrap"));
});

test("the rainfall gradient keeps its original palette colours and stop positions", () => {
  const legend = renderLegend(KENYA_RAINFALL_STOPS, "mm/month");
  const bar = legend.children[1];

  assert.equal(
    bar.style.background,
    "linear-gradient(to right, rgb(247, 251, 255) 0%, rgb(198, 219, 239) 25%, "
      + "rgb(106, 174, 214) 50%, rgb(32, 112, 180) 75%, rgb(8, 48, 107) 100%)",
  );
});

test("temperature keeps negative and decimal ticks with a separate degrees caption", () => {
  const stops = [-12, -8, -5.5, -2, 0, 2.5, 5, 7.5, 10];
  const legend = renderLegend(stops, "°C", "climate");
  const [caption, , labels] = legend.children;

  assert.equal(caption.textContent, "°C");
  assert.equal(caption.style.position, undefined);
  assert.equal(legend.textContent.split("°C").length - 1, 1);
  assert.deepEqual(
    labels.children.map((label) => label.textContent),
    ["-12", "-5.5", "0", "5", "≥ 10"],
  );
});

test("a constant two-stop field keeps both endpoints without units in either tick", () => {
  const units = "millimetres per calendar month";
  const legend = renderLegend([3, 3], units);
  const [caption, , labels] = legend.children;

  assert.equal(caption.textContent, units);
  assert.equal(caption.style.position, undefined);
  assert.equal(legend.textContent.split(units).length - 1, 1);
  assert.deepEqual(labels.children.map((label) => label.textContent), ["3", "≥ 3"]);
  assert.deepEqual(labels.children.map((label) => label.style.left), ["0%", "100%"]);
  assert.deepEqual(
    labels.children.map((label) => label.style.transform),
    ["translateX(0%)", "translateX(-100%)"],
  );
});

test("a custom range labels both open ends", () => {
  const stops = [5, 8, 11, 14, 17, 20, 23, 26, 29];
  const labelsOf = (isBottomOpen: boolean) =>
    renderLegend(stops, "°C", "climate", isBottomOpen).children[2].children
      .map((label) => label.textContent);

  assert.deepEqual(labelsOf(true), ["≤ 5", "11", "17", "23", "≥ 29"]);
  assert.deepEqual(labelsOf(false), ["5", "11", "17", "23", "≥ 29"]);
});

test("the class legend lists only the classes present, in class order", () => {
  const classes = [
    { value: 10, label: "Tree cover", color: "#006400" },
    { value: 20, label: "Shrubland", color: "#ffbb22" },
    { value: 30, label: "Grassland", color: "#ffff4c" },
  ];
  const legend = classLegend(
    classes,
    new Set([30, 10]),
    classColors(classes),
  ) as unknown as TestElement;

  assert.deepEqual(
    legend.children.map((row) => row.textContent),
    ["Tree cover", "Grassland"],
  );
});

test("class legend swatches follow the active colours", () => {
  const classes = [{ value: 10, label: "Tree cover", color: "#006400" }];
  const swatchOf = (palette?: string) => {
    const legend = classLegend(
      classes,
      new Set([10]),
      classColors(classes, palette),
    ) as unknown as TestElement;
    return legend.children[0].children[0].style.background;
  };

  assert.equal(swatchOf(), "rgb(0, 100, 0)");
  assert.equal(swatchOf("painted"), "rgb(69, 109, 59)");
});

function renderLegend(
  stops: number[],
  units: string,
  palette = "ink-blue",
  isBottomOpen = false,
) {
  const colors = lut(fieldGradient(palette)!);
  return gradientLegend(colors, stops, units, isBottomOpen) as unknown as TestElement;
}

class TestElement {
  readonly children: TestElement[] = [];
  readonly style: Record<string, string> = {};
  readonly tagName: string;
  className = "";
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

  append(...children: TestElement[]) {
    this.children.push(...children);
  }
}
