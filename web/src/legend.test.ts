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
import type { GridDoc } from "./types.ts";

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
const [legendModule, latticeModule] = await Promise.all([
  import("./legend.ts"),
  import("./render/lattice.ts"),
]).finally(() => hooks.deregister());
const {
  bivariateLegend,
  classLegend,
  classNoDataLegend,
  contourLegendText,
  createDotLegend,
  createZoomWatch,
  dotLegend,
  dotLegendKey,
  dotSwatchDots,
  dotSwatchLattice,
  gradientLegend,
  isothermLegend,
  previewDotsPerSide,
} = legendModule;
const {
  DENSITY_STEP_LOG2,
  DOT_RADIUS_RATIO,
  CLOSE_RADIUS_CAP_PX,
  HALO_WIDTH_PX,
  MAX_DENSITY_RATIO,
  MIN_DENSITY_LOG2,
  MIN_DENSITY_RATIO,
  MIN_DOT_RADIUS_PX,
  MIN_SPACING_PX,
  POSITION_JITTER_RATIO,
  VALUE_RADIUS_EXPONENT,
  aimedSpacingPx,
  areaNoise,
  dotRadiusPx,
  highZoomDotOpacity,
  highZoomDotSizeScale,
  levelRadiusPx,
  representativeRadiusPx,
  representativeSpacingPx,
} = latticeModule;

const KENYA_RAINFALL_STOPS = [0, 10, 30, 40, 60, 80, 100, 130, 200];
const KENYA_RAINFALL_GRID: GridDoc = {
  bbox: [34, -5, 42, 6],
  res: 0.05,
  nx: 160,
  ny: 220,
};
const HIGH_LATITUDE_GRID: GridDoc = { bbox: [0, 58, 8, 62], res: 0.05, nx: 160, ny: 80 };
const BOX_PX = 48;
const SHARE_CASES = [
  { grid: KENYA_RAINFALL_GRID, zoom: 10, density: 1 },
  { grid: KENYA_RAINFALL_GRID, zoom: 10, density: MAX_DENSITY_RATIO },
  { grid: KENYA_RAINFALL_GRID, zoom: 11.2, density: 1 },
  { grid: KENYA_RAINFALL_GRID, zoom: 11.2, density: 0.6 },
  { grid: HIGH_LATITUDE_GRID, zoom: 9.5, density: 1 },
  { grid: KENYA_RAINFALL_GRID, zoom: 10.6, density: 1 },
  { grid: KENYA_RAINFALL_GRID, zoom: 11.85, density: MAX_DENSITY_RATIO },
];
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
  assert.equal(sample.style.height, "3.2px");
  assert.equal(
    line.style.background,
    "repeating-linear-gradient(to right, rgb(49, 63, 77) 0 6px, "
      + "transparent 6px 10px)",
  );
  assert.equal(line.style.height, "2px");
  assert.ok(Math.abs(Number.parseFloat(line.style.top) - 0.6) < 1e-9);
  assert.equal(label.textContent, "Isotherms every 2 °C (bold every 10 °C)");
});

test("the isotherm legend names the chosen units", () => {
  const legend = isothermLegend(2, inkPaint("charcoal"), "°F") as unknown as TestElement;
  const [, label] = legend.children;

  assert.equal(label.textContent, "Isotherms every 2 °F (bold every 10 °F)");
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

test("the dot legend labels four stops over a swatch for each", () => {
  const legend = renderDotLegend();
  const [caption, boxes, labels] = legend.children;

  assert.equal(caption.textContent, "mm/month");
  assert.deepEqual(
    labels.children.map((label) => label.textContent),
    ["30", "60", "100", "≥ 200"],
  );
  assert.equal(boxes.children.length, 4);
  assert.ok(boxes.children.every((swatch) => swatch.tagName === "canvas"));
  assert.ok(
    boxes.children.every((swatch) => swatch.width === 48 && swatch.height === 48),
  );
  assert.ok(boxes.children.every((swatch) => swatch.style.width === "48px"));
  assert.equal(boxes.style.gridTemplateColumns, "repeat(4, 50px)");
  assert.equal(labels.style.gridTemplateColumns, "repeat(4, 50px)");
  assert.doesNotMatch(legend.textContent, /Bigger dots/);
  assert.equal(legend.children.length, 3);
});

function renderDotLegend({
  stops = KENYA_RAINFALL_STOPS,
  zoom = 5,
  density = 1,
  ink = "navy",
} = {}) {
  return dotLegend(
    stops,
    "mm/month",
    KENYA_RAINFALL_GRID,
    zoom,
    density,
    inkPaint(ink),
  ) as unknown as TestElement;
}

test("the dot legend key keeps its structure across zooms and moves with style", () => {
  const key = dotLegendKey(
    KENYA_RAINFALL_STOPS,
    "mm/month",
    KENYA_RAINFALL_GRID,
    inkPaint("navy"),
    false,
  );

  assert.equal(
    key,
    dotLegendKey(KENYA_RAINFALL_STOPS, "mm/month", KENYA_RAINFALL_GRID, inkPaint("navy"), false),
  );
  assert.notEqual(
    key,
    dotLegendKey(KENYA_RAINFALL_STOPS, "mm/month", KENYA_RAINFALL_GRID, inkPaint("charcoal"), false),
  );
  assert.notEqual(
    key,
    dotLegendKey(KENYA_RAINFALL_STOPS, "mm/month", KENYA_RAINFALL_GRID, inkPaint("navy"), true),
  );
  assert.notEqual(
    key,
    dotLegendKey([0, 100, 200], "mm/month", KENYA_RAINFALL_GRID, inkPaint("navy"), false),
  );
});

test("the dot legend repaints its retained canvases without rebuilding", () => {
  const handle = createDotLegend(
    KENYA_RAINFALL_STOPS,
    "mm/month",
    KENYA_RAINFALL_GRID,
    5,
    1,
    inkPaint("navy"),
    1,
  );
  const boxes = (handle.element as unknown as TestElement).children[1];
  const swatch = boxes.children[0];
  const arcsBefore = swatch.arcs.length;
  const transformsBefore = swatch.transforms.length;

  handle.repaint(5, 1, 1);

  assert.equal(swatch.arcs.length, arcsBefore);
  assert.equal(swatch.transforms.length, transformsBefore);

  handle.repaint(6, 1, 1);

  assert.equal((handle.element as unknown as TestElement).children[1].children[0], swatch);
  assert.ok(swatch.transforms.length > transformsBefore);
});

test("every swatch holds a clean grid of whole dots centred in their sites", () => {
  for (const [dotsPerSide, position] of [[2, 1], [3, 0.5]]) {
    const lattice = dotSwatchLattice(KENYA_RAINFALL_GRID, 11, 1, 1);
    const dots = dotSwatchDots(position, lattice, dotsPerSide);
    const spacingPx = BOX_PX / dotsPerSide;

    assert.equal(dots.length, dotsPerSide ** 2);
    assert.ok(dots.every((dot, index) => {
      const column = index % dotsPerSide;
      const row = Math.floor(index / dotsPerSide);
      return Math.abs(dot.x - (column + 0.5) * spacingPx) <= POSITION_JITTER_RATIO * spacingPx
        && Math.abs(dot.y - (row + 0.5) * spacingPx) <= POSITION_JITTER_RATIO * spacingPx;
    }));
  }
});

test("a swatch keeps a bounded count set by the map spacing and radius", () => {
  for (const { grid, zoom, density } of SHARE_CASES) {
    const lattice = dotSwatchLattice(grid, zoom, 1, density);
    const count = previewDotsPerSide(
      representativeSpacingPx(lattice),
      representativeRadiusPx(lattice),
      HALO_WIDTH_PX,
    );

    assert.ok(count >= 1 && count <= 6, `zoom ${zoom} density ${density}`);
    const legend = renderDotLegend({ zoom, density });
    const arcs = legend.children[1].children[0].arcs.length;

    assert.equal(arcs, 2 * count ** 2);
  }
});

test("a swatch draws the representative radius with the value exponent", () => {
  for (const { grid, zoom, density } of SHARE_CASES) {
    const lattice = dotSwatchLattice(grid, zoom, 1, density);
    assert.ok(lattice.level >= 0, `zoom ${zoom}`);
    const fullPx = representativeRadiusPx(lattice);
    for (const position of [0.3, 1]) {
      const dots = dotSwatchDots(position, lattice, 2);
      const scaledPx = fullPx * position ** VALUE_RADIUS_EXPONENT;
      const scaledRadius = scaledPx >= MIN_DOT_RADIUS_PX ? scaledPx : MIN_DOT_RADIUS_PX;
      const scaledAlpha = scaledPx >= MIN_DOT_RADIUS_PX ? 1 : (scaledPx / MIN_DOT_RADIUS_PX) ** 2;

      assert.ok(
        Math.abs(dots[0].radiusPx - scaledRadius) < 1e-9,
        `zoom ${zoom} density ${density} position ${position}`,
      );
      assert.ok(
        Math.abs(dots[0].opacity / lattice.opacity - scaledAlpha) < 1e-9,
        `zoom ${zoom} density ${density} position ${position}`,
      );
    }
  }
});

test("close zoom bounds every reported radius while ordinary zoom stays put", () => {
  for (const zoom of [5, 10, 13]) {
    const lattice = dotSwatchLattice(KENYA_RAINFALL_GRID, zoom, 1, 1);
    const dots = dotSwatchDots(1, lattice, 2);
    assert.ok(Math.abs(dots[0].radiusPx - representativeRadiusPx(lattice)) < 1e-9, `zoom ${zoom}`);
    assert.ok(Math.abs(dots[0].opacity - lattice.opacity) < 1e-9, `zoom ${zoom}`);
  }
  for (const zoom of [15, 16, 17]) {
    const lattice = dotSwatchLattice(KENYA_RAINFALL_GRID, zoom, 1, 1);
    assert.ok(representativeRadiusPx(lattice) <= CLOSE_RADIUS_CAP_PX + 1e-9, `zoom ${zoom}`);
    const dots = dotSwatchDots(1, lattice, 2);
    assert.ok(dots[0].radiusPx <= CLOSE_RADIUS_CAP_PX + 1e-9, `zoom ${zoom}`);
  }
});

test("close zoom shrinks the reported dots through the size fade", () => {
  const lattice = dotSwatchLattice(KENYA_RAINFALL_GRID, 17.75, 1, 1);
  const sizeScale = highZoomDotSizeScale(17.75, 1);
  const q = highZoomDotOpacity(17.75, 1);
  assert.ok(Math.abs(sizeScale - 0.594604) < 1e-5);
  assert.ok(Math.abs(q - 0.5) < 1e-9);
  const dots = dotSwatchDots(1, lattice, 2);
  const fullPx = representativeRadiusPx(lattice) * sizeScale;
  assert.ok(fullPx >= MIN_DOT_RADIUS_PX);
  assert.ok(Math.abs(dots[0].radiusPx - fullPx) < 1e-9);
  assert.ok(Math.abs(dots[0].opacity - q) < 1e-9);

  const faintLattice = dotSwatchLattice(KENYA_RAINFALL_GRID, 17.9, 1, 1);
  const faintScale = highZoomDotSizeScale(17.9, 1);
  const faintQ = highZoomDotOpacity(17.9, 1);
  const faint = dotSwatchDots(0.15, faintLattice, 2);
  const faintPx = representativeRadiusPx(faintLattice) * 0.15 ** VALUE_RADIUS_EXPONENT * faintScale;
  assert.ok(faintPx < MIN_DOT_RADIUS_PX);
  assert.equal(faint[0].radiusPx, MIN_DOT_RADIUS_PX);
  assert.ok(Math.abs(faint[0].opacity - (faintPx / MIN_DOT_RADIUS_PX) ** 2 * faintQ) < 1e-9);
});

test("the swatch fades its composed dots once instead of per circle", () => {
  const legend = renderDotLegend({ zoom: 17.75 });
  const q = highZoomDotOpacity(17.75, 1);
  const swatch = legend.children[1].children.at(-1);
  assert.ok(swatch.fills.length > 0);
  // Circles paint at their ordinary tiny-dot and halo alphas, undimmed by the fade.
  assert.ok(swatch.fills.some((fill) => Math.abs(fill.alpha - 1) < 1e-9));
  assert.ok(swatch.fills.some((fill) => Math.abs(fill.alpha - 0.7) < 1e-9));
  assert.ok(swatch.fills.every((fill) => fill.composite === "source-over"));
  // One full-canvas destination-in fill attenuates the composed swatch by the fade.
  assert.equal(swatch.rectFills.length, 1);
  const attenuation = swatch.rectFills[0];
  assert.equal(attenuation.composite, "destination-in");
  assert.ok(Math.abs(attenuation.alpha - q) < 1e-9);
  assert.equal(attenuation.width, BOX_PX);
  assert.equal(attenuation.height, BOX_PX);
});

test("the faded swatch resets its compositing for the next repaint", () => {
  const handle = createDotLegend(
    KENYA_RAINFALL_STOPS,
    "mm/month",
    KENYA_RAINFALL_GRID,
    17.75,
    1,
    inkPaint("navy"),
    1,
  );
  handle.repaint(5, 1, 1);
  const boxes = (handle.element as unknown as TestElement).children[1];
  for (const swatch of boxes.children) {
    assert.ok(swatch.fills.every((fill) => fill.composite === "source-over"));
    assert.ok(swatch.rectFills.length > 0);
    assert.ok(swatch.rectFills.every((rect) => rect.composite === "destination-in"));
  }
});

test("an identical repaint paints no new dots or attenuation", () => {
  const handle = createDotLegend(
    KENYA_RAINFALL_STOPS,
    "mm/month",
    KENYA_RAINFALL_GRID,
    17.75,
    1,
    inkPaint("navy"),
    1,
  );
  const boxes = (handle.element as unknown as TestElement).children[1];
  const swatch = boxes.children[0];
  const arcs = swatch.arcs.length;
  const attenuations = swatch.rectFills.length;
  assert.ok(arcs > 0 && attenuations > 0);

  handle.repaint(17.75, 1, 1);

  assert.equal(swatch.arcs.length, arcs);
  assert.equal(swatch.rectFills.length, attenuations);
  assert.equal(boxes.children[0], swatch);

  handle.repaint(17.75, MAX_DENSITY_RATIO, 1);

  assert.equal(boxes.children[0], swatch);
  assert.equal(swatch.rectFills.length, attenuations + 1);
});

test("the swatches clear their attenuation at zero fade while labels remain", () => {
  const legend = renderDotLegend({ zoom: 20 });
  const [, boxes, labels] = legend.children;

  assert.ok(boxes.children.every((swatch) => swatch.arcs.length === 0));
  assert.ok(boxes.children.every((swatch) => swatch.rectFills.length === 0));
  assert.deepEqual(
    labels.children.map((label) => label.textContent),
    ["30", "60", "100", "≥ 200"],
  );
});

test("the dot swatch share does not change with the density but its dots shrink", () => {
  const sparse = dotSwatchLattice(KENYA_RAINFALL_GRID, 10, 1, 1);
  const dense = dotSwatchLattice(KENYA_RAINFALL_GRID, 10, 1, MAX_DENSITY_RATIO);

  assert.ok(Math.abs(dense.inkShare / sparse.inkShare - 1) < 1e-9);
  assert.ok(Math.abs(dense.aimedPx - sparse.aimedPx / MAX_DENSITY_RATIO) < 1e-9);
  assert.ok(dense.fade > sparse.fade);
});

test("the swatch grid follows the selected count while its ink share stays put", () => {
  const dotsAt = (density: number, zoom: number) => {
    const legend = renderDotLegend({ zoom, density });
    return legend.children[1].children[0].arcs.length / 2;
  };
  const countAt = (density: number, zoom: number) => {
    const lattice = dotSwatchLattice(KENYA_RAINFALL_GRID, zoom, 1, density);
    return previewDotsPerSide(
      representativeSpacingPx(lattice),
      representativeRadiusPx(lattice),
      HALO_WIDTH_PX,
    ) ** 2;
  };

  for (const zoom of [5, 10]) {
    const sparse = dotsAt(MIN_DENSITY_RATIO, zoom);
    const middle = dotsAt(1, zoom);
    const dense = dotsAt(MAX_DENSITY_RATIO, zoom);

    assert.equal(sparse, countAt(MIN_DENSITY_RATIO, zoom));
    assert.equal(middle, countAt(1, zoom));
    assert.equal(dense, countAt(MAX_DENSITY_RATIO, zoom));
    assert.ok(sparse >= 1 && sparse <= middle && middle <= dense);
  }
});

test("a saturated dot lattice inks the same share at every density", () => {
  for (const zoom of [16, 17]) {
    const shares = [0.5, 0.75, 1, 1.5, 2].map((density) =>
      dotSwatchLattice(KENYA_RAINFALL_GRID, zoom, 1, density).inkShare
    );

    for (const share of shares) assert.ok(Math.abs(share / shares[0] - 1) < 1e-9);
  }
});

test("a density sweep keeps the ink share through level fades", () => {
  const densities = Array.from(
    { length: 17 },
    (_, index) => 2 ** (MIN_DENSITY_LOG2 + index * DENSITY_STEP_LOG2),
  );
  for (const zoom of [5, 10.6]) {
    const lattices = densities.map((density) =>
      dotSwatchLattice(KENYA_RAINFALL_GRID, zoom, 1, density)
    );
    const [first] = lattices;
    assert.ok(lattices.some(({ fade }) => fade > 0), `zoom ${zoom}`);

    for (const lattice of lattices) {
      assert.ok(
        Math.abs(lattice.inkShare / first.inkShare - 1) < 1e-9,
        `zoom ${zoom} density ${lattice.density}`,
      );
    }
  }
});

test("high-latitude containment keeps constant ink including latitude 55 at zoom 5.3", () => {
  const lowZooms = Array.from({ length: 11 }, (_, index) => 5 + index / 10);
  for (const latitude of [45, 50, 55, 60]) {
    const grid = {
      ...HIGH_LATITUDE_GRID,
      bbox: [0, latitude - 2, 8, latitude + 2] as GridDoc["bbox"],
    };
    for (const zoom of lowZooms.concat([8, 10, 12])) {
      const expected = Math.PI * (DOT_RADIUS_RATIO * MIN_SPACING_PX / aimedSpacingPx(zoom)) ** 2;
      for (const pixelRatio of [1, 2]) {
        for (let step = 0; step <= 16; step++) {
          const density = 2 ** (MIN_DENSITY_LOG2 + step * DENSITY_STEP_LOG2);
          const lattice = dotSwatchLattice(grid, zoom, pixelRatio, density);

          assert.ok(
            Math.abs(lattice.inkShare / expected - 1) < 1e-9,
            `${latitude} ${zoom} DPR ${pixelRatio} density ${density}`,
          );
        }
      }
    }
  }
});

test("a higher value inks more of the dot swatch by the radius exponent", () => {
  const lattice = dotSwatchLattice(KENYA_RAINFALL_GRID, 5, 1, 1);
  const inkOf = (position: number) => inkShareOf(dotSwatchDots(position, lattice, 2));

  assert.ok(inkOf(0.3) > inkOf(0.15));
  assert.ok(inkOf(1) > inkOf(0.3));
  assert.ok(Math.abs(inkOf(0.3) / inkOf(1) - 0.3 ** (2 * VALUE_RADIUS_EXPONENT)) < 1e-9);
});

test("no selected swatch dot or halo crosses the box edge at any zoom or density", () => {
  const grids = [KENYA_RAINFALL_GRID, HIGH_LATITUDE_GRID];
  for (const grid of grids) {
    for (let zoom = 2; zoom < 18; zoom += 0.25) {
      for (const density of [0.5, 1, 2]) {
        const lattice = dotSwatchLattice(grid, zoom, 1, density);
        const dotsPerSide = previewDotsPerSide(
          representativeSpacingPx(lattice),
          representativeRadiusPx(lattice),
          HALO_WIDTH_PX,
        );
        for (const position of [0.15, 0.6, 1]) {
          const dots = dotSwatchDots(position, lattice, dotsPerSide);
          const message = `zoom ${zoom} density ${density} position ${position}`;

          assert.ok(dots.every((dot) => {
            const reachPx = dot.radiusPx + HALO_WIDTH_PX;
            return dot.x - reachPx >= 0
              && dot.x + reachPx <= BOX_PX
              && dot.y - reachPx >= 0
              && dot.y + reachPx <= BOX_PX;
          }), message);
        }
      }
    }
  }
});

test("the dot swatches are empty at zoom 20 while their labels remain", () => {
  const legend = renderDotLegend({ zoom: 20 });
  const [, boxes, labels] = legend.children;

  assert.ok(boxes.children.every((swatch) => swatch.fills.length === 0));
  assert.ok(boxes.children.every((swatch) => swatch.arcs.length === 0));
  assert.deepEqual(
    labels.children.map((label) => label.textContent),
    ["30", "60", "100", "≥ 200"],
  );
});

test("the dot swatches draw the current ink over its halo", () => {
  const legend = renderDotLegend({ ink: "white" });
  const swatch = legend.children[1].children[0];
  const colors = new Set(swatch.fills.map((fill) => fill.color));

  assert.ok(colors.has("rgb(255, 255, 255)"));
  assert.ok(colors.has("rgb(31, 31, 31)"));
});

test("the dot swatch halo is the shader's device-px width at every pixel ratio", () => {
  const swatchAt = (ratio: number) => {
    Object.assign(globalThis, { window: { devicePixelRatio: ratio } });
    const legend = dotLegend(
      KENYA_RAINFALL_STOPS,
      "mm/month",
      KENYA_RAINFALL_GRID,
      5,
      1,
      inkPaint("navy"),
    ) as unknown as TestElement;
    return legend.children[1].children[0];
  };

  try {
    const normal = swatchAt(1);
    const normalGap = normal.arcs[0] - normal.arcs[1];
    assert.ok(Math.abs(normalGap - HALO_WIDTH_PX) < 1e-9);

    const retina = swatchAt(2);
    const retinaGap = retina.arcs[0] - retina.arcs[1];
    assert.ok(Math.abs(retinaGap - HALO_WIDTH_PX / 2) < 1e-9);
    assert.equal(retina.width, 96);
    assert.equal(retina.height, 96);
    assert.equal(retina.transforms[0], 2);
    assert.equal(normal.transforms[0], 1);
  } finally {
    Reflect.deleteProperty(globalThis, "window");
  }
});

test("a fractional backing store survives zoom and density repaints", () => {
  Object.assign(globalThis, { window: { devicePixelRatio: 1.2 } });
  try {
    const handle = createDotLegend(
      KENYA_RAINFALL_STOPS,
      "mm/month",
      KENYA_RAINFALL_GRID,
      5,
      1,
      inkPaint("navy"),
      1.2,
    );
    const boxes = (handle.element as unknown as TestElement).children[1];
    for (const swatch of boxes.children) swatch.sizeWrites = 0;

    handle.repaint(6, 1, 1.2);
    handle.repaint(6, MAX_DENSITY_RATIO, 1.2);

    assert.ok(boxes.children.every((swatch) => swatch.sizeWrites === 0));
    assert.ok(boxes.children.every((swatch) => swatch.transforms.at(-1) === 1.2));
  } finally {
    Reflect.deleteProperty(globalThis, "window");
  }
});

test("the zoom watch listens only while active and never twice", () => {
  const calls: string[] = [];
  const map = {
    on: (type: string) => calls.push(`on ${type}`),
    off: (type: string) => calls.push(`off ${type}`),
  };
  const watch = createZoomWatch(map as unknown as Parameters<typeof createZoomWatch>[0], () => {});

  watch.setActive(false);
  watch.setActive(true);
  watch.setActive(true);
  watch.setActive(false);
  watch.setActive(true);
  watch.setActive(false);
  watch.setActive(false);

  assert.deepEqual(calls, ["on render", "off render", "on render", "off render"]);
});

test("Kenya rainfall keeps numeric ticks at palette positions with its units shown once", () => {
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
    classColors("esa_worldcover", classes),
  ) as unknown as TestElement;

  assert.deepEqual(
    legend.children.map((row) => row.textContent),
    ["Tree cover", "Grassland"],
  );
});

test("the flat class legend uses its own list styled like the family headings", () => {
  const classes = [
    { value: 10, label: "Tree cover", color: "#006400" },
    { value: 20, label: "Shrubland", color: "#ffbb22" },
  ];
  const legend = classLegend(
    classes,
    new Set([10, 20]),
    classColors("esa_worldcover", classes),
  ) as unknown as TestElement;

  assert.equal(legend.className, "legend-class-list");
  assert.deepEqual(
    legend.children.map((row) => row.textContent),
    ["Tree cover", "Shrubland"],
  );
  assert.ok(legend.children.every((row) => row.children[0].className === "legend-swatch"));
});

const GROUPED_CLASSES = [
  { value: 1, label: "Sand", color: "#ffff00", group: "Sediments" },
  { value: 2, label: "Clay", color: "#aaaa00", group: "Sediments" },
  { value: 3, label: "Basalt", color: "#aa0000", group: "Volcanic" },
  { value: 4, label: "Granite", color: "#ff0000", group: "Plutonic" },
];

function groupedLegend(expandedGroups?: Set<string>) {
  return classLegend(
    GROUPED_CLASSES,
    new Set([1, 2, 4]),
    classColors("geology", GROUPED_CLASSES),
    expandedGroups,
  ) as unknown as TestElement;
}

test("the class legend gives each group of the listed classes one collapsed heading", () => {
  const legend = groupedLegend();
  const [sediments, plutonic] = legend.children;
  const [toggle, list] = sediments.children;

  assert.equal(legend.children.length, 2);
  assert.deepEqual(
    legend.children.map((section) => section.children[0].textContent),
    ["Sediments", "Plutonic"],
  );
  assert.equal(toggle.tagName, "button");
  assert.equal(toggle.type, "button");
  assert.equal(toggle.attributes["aria-expanded"], "false");
  assert.equal(list.hidden, true);
  assert.deepEqual(list.children.map((row) => row.textContent), ["Sand", "Clay"]);
  assert.deepEqual(plutonic.children[1].children.map((row) => row.textContent), ["Granite"]);
});

const AGE_CLASSES = [
  { value: 1, label: "Quaternary", color: "#f9f97f", group: "Cenozoic" },
  { value: 4, label: "Cenozoic undivided", color: "#f2f91d", group: "Cenozoic" },
  { value: 5, label: "Cretaceous", color: "#7fc64e", group: "Mesozoic" },
  { value: 20, label: "Archean", color: "#f0047f", group: "Precambrian" },
];

test("the age legend lists the eras that the area holds in the order of the classes", () => {
  const legend = classLegend(
    AGE_CLASSES,
    new Set([20, 1, 4, 5]),
    classColors("geology_age", AGE_CLASSES),
  ) as unknown as TestElement;
  const [cenozoic] = legend.children;

  assert.deepEqual(
    legend.children.map((section) => section.children[0].textContent),
    ["Cenozoic", "Mesozoic", "Precambrian"],
  );
  assert.deepEqual(
    cenozoic.children[1].children.map((row) => row.textContent),
    ["Quaternary", "Cenozoic undivided"],
  );
  assert.equal(cenozoic.children[0].children[0].style.background, "rgb(249, 249, 127)");
});

test("a collapsed group heading shows the swatch of its first listed class", () => {
  const toggle = groupedLegend().children[0].children[0];

  assert.equal(toggle.children[0].style.background, "rgb(255, 255, 0)");
});

test("pressing a group heading expands and collapses its classes", () => {
  const legend = groupedLegend();
  const [toggle, list] = legend.children[0].children;

  toggle.click();

  assert.equal(toggle.attributes["aria-expanded"], "true");
  assert.equal(list.hidden, false);

  toggle.click();

  assert.equal(toggle.attributes["aria-expanded"], "false");
  assert.equal(list.hidden, true);
});

test("a redrawn class legend keeps the groups the viewer expanded", () => {
  const expanded = new Set<string>();
  groupedLegend(expanded).children[0].children[0].click();
  const [toggle, list] = groupedLegend(expanded).children[0].children;

  assert.equal(toggle.attributes["aria-expanded"], "true");
  assert.equal(list.hidden, false);
});

test("class legend swatches follow the active colours", () => {
  const classes = [{ value: 10, label: "Tree cover", color: "#006400" }];
  const swatchOf = (palette?: string) => {
    const legend = classLegend(
      classes,
      new Set([10]),
      classColors("esa_worldcover", classes, palette),
    ) as unknown as TestElement;
    return legend.children[0].children[0].style.background;
  };

  assert.equal(swatchOf(), "rgb(0, 100, 0)");
  assert.equal(swatchOf("painted"), "rgb(69, 109, 59)");
});

test("the no-data legend row names its hatched swatch", () => {
  const row = classNoDataLegend() as unknown as TestElement;
  const [swatch, label] = row.children;

  assert.equal(label.textContent, "No data");
  assert.equal(swatch.className, "legend-swatch legend-hatch");
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
  private backingWidth = 0;
  private backingHeight = 0;
  sizeWrites = 0;
  image: { data: Uint8ClampedArray; width: number; height: number } | null = null;
  readonly attributes: Record<string, string> = {};
  readonly fills: { color: string; alpha: number; composite: string }[] = [];
  readonly rectFills: { alpha: number; composite: string; width: number; height: number }[] = [];
  readonly arcs: number[] = [];
  readonly scales: number[] = [];
  readonly transforms: number[] = [];
  clearCount = 0;
  hidden = false;
  type = "";
  private readonly clickListeners: (() => void)[] = [];
  private text = "";

  constructor(tagName: string) {
    this.tagName = tagName;
  }

  get width(): number {
    return this.backingWidth;
  }

  set width(value: number) {
    this.backingWidth = value;
    this.sizeWrites += 1;
  }

  get height(): number {
    return this.backingHeight;
  }

  set height(value: number) {
    this.backingHeight = value;
    this.sizeWrites += 1;
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

  addEventListener(_type: string, listener: () => void) {
    this.clickListeners.push(listener);
  }

  click() {
    for (const listener of this.clickListeners) listener();
  }

  setAttribute(name: string, value: string) {
    this.attributes[name] = value;
  }

  getContext() {
    const context = {
      fillStyle: "",
      globalAlpha: 1,
      globalCompositeOperation: "source-over",
      createImageData: (width: number, height: number) => ({
        data: new Uint8ClampedArray(width * height * 4),
        width,
        height,
      }),
      putImageData: (image: { data: Uint8ClampedArray; width: number; height: number }) => {
        this.image = image;
      },
      fillRect: (x: number, y: number, width: number, height: number) => {
        this.rectFills.push({
          alpha: context.globalAlpha,
          composite: context.globalCompositeOperation,
          width,
          height,
        });
      },
      scale: (ratio: number) => {
        this.scales.push(ratio);
      },
      setTransform: (ratio: number) => {
        this.transforms.push(ratio);
      },
      clearRect: () => {
        this.clearCount += 1;
      },
      beginPath() {},
      arc: (_x: number, _y: number, radiusPx: number) => {
        this.arcs.push(radiusPx);
      },
      fill: () => {
        this.fills.push({
          color: context.fillStyle,
          alpha: context.globalAlpha,
          composite: context.globalCompositeOperation,
        });
      },
    };
    return context;
  }
}

function inkShareOf(dots: { radiusPx: number; opacity: number }[]) {
  const inkPx = dots.reduce((ink, dot) => ink + Math.PI * dot.radiusPx ** 2 * dot.opacity, 0);
  return inkPx / BOX_PX ** 2;
}
