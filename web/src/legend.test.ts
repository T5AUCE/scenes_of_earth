import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { afterEach, beforeEach, test } from "node:test";

import { LUT2D_SIZE, lut, lut2d } from "./render/colormap.ts";
import {
  RAIN_TEMPERATURE_GRID,
  classColors,
  fieldGradient,
  inkPaint,
} from "./render/palettes.ts";

const resolvedParents = ["./legend.ts", "./render/lattice.ts"].map(
  (path) => new URL(path, import.meta.url).href,
);
const hooks = registerHooks({
  resolve(specifier, context, next) {
    if (!resolvedParents.includes(context.parentURL ?? "") || !specifier.startsWith("./")) {
      return next(specifier, context);
    }

    return next(new URL(`${specifier}.ts`, context.parentURL).href, context);
  },
});
const {
  bivariateLegend,
  classLegend,
  contourLegendText,
  dotLegend,
  gradientLegend,
  isothermLegend,
} = await import("./legend.ts").finally(() => hooks.deregister());

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

test("the isotherm legend shows the dashed ink over its dashed casing", () => {
  const legend = isothermLegend(2, inkPaint("charcoal")) as unknown as TestElement;
  const [sample, label] = legend.children;
  const [line] = sample.children;

  assert.equal(sample.className, "legend-isotherm");
  assert.equal(
    sample.style.background,
    "repeating-linear-gradient(to right, rgb(246, 239, 227) 0 6px, "
      + "transparent 6px 10px)",
  );
  assert.equal(sample.style.height, "5px");
  assert.equal(
    line.style.background,
    "repeating-linear-gradient(to right, rgb(49, 63, 77) 0 6px, "
      + "transparent 6px 10px)",
  );
  assert.equal(line.style.height, "2px");
  assert.equal(line.style.top, "1.5px");
  assert.equal(label.textContent, "Isotherms every 2 °C (bold every 10 °C)");
});

test("the bivariate legend puts its ticks at the fitted stops", () => {
  const rain = {
    title: "Rainfall",
    units: "mm/month",
    stops: KENYA_RAINFALL_STOPS,
    isBottomOpen: false,
  };
  const temperature = {
    title: "Temperature",
    units: "°C",
    stops: [5, 8, 11, 14, 17, 20, 23, 26, 29],
    isBottomOpen: false,
  };

  const legend = bivariateLegend(
    lut2d(RAIN_TEMPERATURE_GRID),
    rain,
    temperature,
    true,
  ) as unknown as TestElement;
  const [plot] = legend.children;
  const [temperatureTitle, rows, , columns, rainTitle] = plot.children;

  assert.equal(legend.children.length, 1);
  assert.equal(temperatureTitle.textContent, "Temperature (°C)");
  assert.equal(temperatureTitle.className, "legend-bivariate-title-y");
  assert.equal(rainTitle.textContent, "Rainfall (mm/month)");
  assert.equal(rainTitle.className, "legend-bivariate-title-x");
  assert.deepEqual(rows.children.map((label) => label.textContent), ["5", "17", "≥ 29"]);
  assert.deepEqual(rows.children.map((label) => label.style.top), ["100%", "50%", "0%"]);
  assert.deepEqual(columns.children.map((label) => label.textContent), ["0", "60", "≥ 200"]);
  assert.deepEqual(columns.children.map((label) => label.style.left), ["0%", "50%", "100%"]);
});

test("the bivariate swatch puts rain across and temperature up", () => {
  const rain = { title: "Rainfall", units: "mm/month", stops: [0, 100, 200], isBottomOpen: false };
  const temperature = {
    title: "Temperature",
    units: "°C",
    stops: [8, 20, 31],
    isBottomOpen: false,
  };
  const colors = lut2d(RAIN_TEMPERATURE_GRID);
  const legend = bivariateLegend(colors, rain, temperature, true) as unknown as TestElement;
  const canvas = legend.children[0].children[2];
  const image = canvas.image!;
  const pixel = (x: number, y: number) =>
    Array.from(image.data.subarray((y * image.width + x) * 4, (y * image.width + x) * 4 + 4));
  const entry = (rainRow: number, temperatureColumn: number) =>
    Array.from(
      colors.subarray(
        (rainRow * LUT2D_SIZE + temperatureColumn) * 4,
        (rainRow * LUT2D_SIZE + temperatureColumn) * 4 + 4,
      ),
    );
  const last = image.width - 1;

  assert.deepEqual(pixel(0, last), entry(0, 0));
  assert.deepEqual(pixel(0, 0), entry(0, LUT2D_SIZE - 1));
  assert.deepEqual(pixel(last, last), entry(LUT2D_SIZE - 1, 0));
});

test("the bivariate legend names both axes, their ends and its scale for assistive tools", () => {
  const rain = { title: "Rainfall", units: "mm/month", stops: [0, 100, 200], isBottomOpen: false };
  const temperature = {
    title: "Temperature",
    units: "°C",
    stops: [8, 20, 31],
    isBottomOpen: true,
  };

  const legend = bivariateLegend(
    lut2d(RAIN_TEMPERATURE_GRID),
    rain,
    temperature,
    false,
  ) as unknown as TestElement;
  const description = legend.attributes["aria-label"];

  assert.equal(legend.attributes.role, "img");
  assert.match(
    description,
    /Temperature grows from bottom to top from 8 or less to 31 or more °C, with 20 in the/,
  );
  assert.match(
    description,
    /Rainfall grows from left to right from 0 to 200 or more mm\/month, with 100 in the middle\./,
  );
  assert.doesNotMatch(description, /Darker is wetter\./);
  assert.match(description, /The scale is a custom range\./);
});

test("the dot legend labels four stops over boxes with growing dot sizes", () => {
  const legend = dotLegend(
    KENYA_RAINFALL_STOPS,
    "mm/month",
    0.05,
    inkPaint("navy"),
  ) as unknown as TestElement;
  const [caption, boxes, labels, note] = legend.children;

  assert.equal(caption.textContent, "mm/month");
  assert.deepEqual(
    labels.children.map((label) => label.textContent),
    ["30", "60", "100", "≥ 200"],
  );
  const areas = boxes.children.map((box) => Number.parseFloat(box.children[0].style.width) ** 2);
  areas.forEach((area, index) => assert.ok(Math.abs(area / areas[0] - (index + 1)) < 1e-6));
  assert.equal(boxes.style.gridTemplateColumns, "repeat(4, 34px)");
  assert.equal(labels.style.gridTemplateColumns, "repeat(4, 34px)");
  assert.ok(note.textContent.includes("0.05° grid (≈ 5.6 km)"));
  assert.equal(legend.children.length, 4);
});

test("the dot legend draws its dots in the current ink with the matching halo", () => {
  const legend = dotLegend(
    KENYA_RAINFALL_STOPS,
    "mm/month",
    0.05,
    inkPaint("white"),
  ) as unknown as TestElement;
  const dot = legend.children[1].children[0].children[0];

  assert.equal(dot.style.background, "rgb(255, 255, 255)");
  assert.equal(dot.style.boxShadow, "0 0 0 1px rgb(31, 31, 31)");
});

test("the dot legend adds the block note only when zoomed out", () => {
  const legend = dotLegend(
    KENYA_RAINFALL_STOPS,
    "mm/month",
    0.05,
    inkPaint("navy"),
    2,
  ) as unknown as TestElement;

  assert.equal(legend.children[4].textContent, "Here: 1 dot site per 2×2 cells");
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

test("the rainfall gradient uses the OKLCH ramp at its stop positions", () => {
  const legend = renderLegend(KENYA_RAINFALL_STOPS, "mm/month");
  const bar = legend.children[1];

  assert.equal(
    bar.style.background,
    "linear-gradient(to right, rgb(231, 244, 255) 0%, rgb(170, 196, 223) 25%, "
      + "rgb(114, 149, 192) 50%, rgb(62, 101, 160) 75%, rgb(18, 55, 128) 100%)",
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
  width = 0;
  height = 0;
  image: { data: Uint8ClampedArray; width: number; height: number } | null = null;
  readonly attributes: Record<string, string> = {};
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

  setAttribute(name: string, value: string) {
    this.attributes[name] = value;
  }

  getContext() {
    return {
      fillStyle: "",
      createImageData: (width: number, height: number) => ({
        data: new Uint8ClampedArray(width * height * 4),
        width,
        height,
      }),
      putImageData: (image: { data: Uint8ClampedArray; width: number; height: number }) => {
        this.image = image;
      },
      fillRect() {},
    };
  }
}
