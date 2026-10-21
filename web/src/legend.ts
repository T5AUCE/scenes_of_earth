/** Build legends for colour scales and the map's non-colour encodings. */
import {
  COLOR_CHANNELS,
  LAST_ENTRY,
  legendTicks,
  LUT2D_SIZE,
  RGBA_CHANNELS,
} from "./render/colormap";
import {
  BOLD_ISOTHERM_MULTIPLE,
  ISOTHERM_CASING_RATIO,
  ISOTHERM_DASH_PATTERN,
} from "./render/isolines";
import { DOT_RADIUS_RATIO } from "./render/lattice";
import { type InkPaint, rgbCss } from "./render/palettes";
import type { ClassDoc } from "./types";

const GRADIENT_STOP_ENTRIES = [0, 64, 128, 192, 255];

const ISOTHERM_SAMPLE_WIDTH_PX = 24;
const ISOTHERM_SAMPLE_LINE_PX = 2;
const ISOTHERM_SAMPLE_CASING_PX = ISOTHERM_SAMPLE_LINE_PX * ISOTHERM_CASING_RATIO;
const ISOTHERM_SAMPLE_GAP_PX = 6;

const DOT_BOX_PX = 28;
const HALO_WIDTH_PX = 1;

const BIVARIATE_SIZE_PX = 112;
const BIVARIATE_GRID_ALPHA = 0.35;

const KM_PER_DEGREE = 111.2;
const KM_DECIMALS = 1;

/** The legend line for contours. */
export function contourLegendText(interval: number, boldInterval: number, units = "m") {
  const emphasis = interval >= boldInterval ? "all bold" : `bold every ${boldInterval} ${units}`;
  return `Contours every ${interval} ${units} (${emphasis})`;
}

/** A dashed sample of the isotherm ink and its casing with the interval and bold step. */
export function isothermLegend(interval: number, ink: InkPaint) {
  const element = document.createElement("div");
  const sample = document.createElement("span");
  sample.className = "legend-isotherm";
  sample.style.background = dashGradient(ink.halo);
  sample.style.display = "inline-block";
  sample.style.height = `${ISOTHERM_SAMPLE_CASING_PX}px`;
  sample.style.marginRight = `${ISOTHERM_SAMPLE_GAP_PX}px`;
  sample.style.position = "relative";
  sample.style.verticalAlign = "middle";
  sample.style.width = `${ISOTHERM_SAMPLE_WIDTH_PX}px`;

  const line = document.createElement("span");
  line.style.background = dashGradient(ink.ink);
  line.style.height = `${ISOTHERM_SAMPLE_LINE_PX}px`;
  line.style.left = "0";
  line.style.position = "absolute";
  line.style.right = "0";
  line.style.top = `${(ISOTHERM_SAMPLE_CASING_PX - ISOTHERM_SAMPLE_LINE_PX) / 2}px`;
  sample.append(line);

  const boldInterval = interval * BOLD_ISOTHERM_MULTIPLE;
  const label = document.createElement("span");
  label.textContent = `Isotherms every ${interval} °C (bold every ${boldInterval} °C)`;
  element.append(sample, label);
  return element;
}

function dashGradient(color: number[]) {
  const dashPx = ISOTHERM_DASH_PATTERN[0] * ISOTHERM_SAMPLE_LINE_PX;
  const periodLengths = ISOTHERM_DASH_PATTERN[0] + ISOTHERM_DASH_PATTERN[1];
  const periodPx = periodLengths * ISOTHERM_SAMPLE_LINE_PX;

  return `repeating-linear-gradient(to right, ${rgbCss(color)} 0 ${dashPx}px, `
    + `transparent ${dashPx}px ${periodPx}px)`;
}

/** The legend line for cells inside the area that have no data, which the marks layer hatches. */
export function hatchLegend() {
  const element = document.createElement("div");
  element.textContent = "Hatched: no data";
  return element;
}

/**
 * Boxes holding one dot each, sized like the map's dot at the value labelled below. The lowest
 * value is left out because its dot has no area.
 * The dots take the current ink and blockCells above 1 adds the zoomed-out note that one dot site
 * covers several cells.
 */
export function dotLegend(
  stops: number[],
  units: string,
  resDeg: number,
  ink: InkPaint,
  blockCells = 1,
) {
  const element = document.createElement("div");
  const unitsCaption = document.createElement("div");
  unitsCaption.textContent = units;
  const boxes = document.createElement("div");
  boxes.className = "legend-dot-row";
  const labels = document.createElement("div");
  labels.className = "legend-dot-row";
  const ticks = legendTicks(stops).slice(1);
  const columns = `repeat(${ticks.length}, 34px)`;
  boxes.style.gridTemplateColumns = columns;
  labels.style.gridTemplateColumns = columns;
  for (const { position, value } of ticks) {
    boxes.append(dotBox(position, ink));
    const label = document.createElement("span");
    label.textContent = openLabel(position, value, false);
    labels.append(label);
  }
  const note = document.createElement("div");
  const cellKm = (resDeg * KM_PER_DEGREE).toFixed(KM_DECIMALS);
  note.textContent = `Bigger dots mean higher values. Dots sit on the ${resDeg}° grid `
    + `(≈ ${cellKm} km); zooming in adds dots inside each cell, not data.`;
  element.append(unitsCaption, boxes, labels, note);
  if (blockCells > 1) {
    const block = document.createElement("div");
    block.textContent = `Here: 1 dot site per ${blockCells}×${blockCells} cells`;
    element.append(block);
  }
  return element;
}

function dotBox(position: number, ink: InkPaint) {
  const diameterPx = 2 * DOT_RADIUS_RATIO * DOT_BOX_PX * Math.sqrt(position);
  const box = document.createElement("span");
  box.className = "legend-dot-box";
  const dot = document.createElement("span");
  dot.className = "legend-dot";
  dot.style.width = `${diameterPx}px`;
  dot.style.height = `${diameterPx}px`;
  dot.style.background = rgbCss(ink.ink);
  dot.style.boxShadow = haloShadow(ink);
  dot.style.left = `${(DOT_BOX_PX - diameterPx) / 2}px`;
  dot.style.top = `${(DOT_BOX_PX - diameterPx) / 2}px`;
  box.append(dot);
  return box;
}

function haloShadow({ halo }: InkPaint) {
  return `0 0 0 ${HALO_WIDTH_PX}px ${rgbCss(halo)}`;
}

/** A labelled bivariate scale with an optional open lower end. */
export interface BivariateLegendAxis {
  title: string;
  units: string;
  stops: number[];
  isBottomOpen: boolean;
}

/**
 * A square of the blend's colours with temperature rising upward and rain growing to the right.
 * Faint lines mark each axis's nine stops while labels identify its endpoints and midpoint.
 */
export function bivariateLegend(
  colors: Uint8ClampedArray,
  rain: BivariateLegendAxis,
  temperature: BivariateLegendAxis,
  isFitted: boolean,
) {
  const element = document.createElement("div");
  element.className = "legend-bivariate";

  const plot = document.createElement("div");
  plot.className = "legend-bivariate-plot";
  plot.append(
    axisTitle(`${temperature.title} (${temperature.units})`, "legend-bivariate-title-y"),
    axisLabels(temperature, "legend-bivariate-rows"),
    bivariateSquare(colors, rain.stops.length, temperature.stops.length),
    axisLabels(rain, "legend-bivariate-columns"),
    axisTitle(`${rain.title} (${rain.units})`, "legend-bivariate-title-x"),
  );
  element.append(plot);

  element.setAttribute("role", "img");
  element.setAttribute("aria-label", bivariateDescription(rain, temperature, isFitted));
  return element;
}

function bivariateDescription(
  rain: BivariateLegendAxis,
  temperature: BivariateLegendAxis,
  isFitted: boolean,
) {
  const scale = isFitted ? "The scale is fitted to this area." : "The scale is a custom range.";

  return [
    "Colour key for the blend of rainfall and temperature.",
    axisDescription(temperature, "from bottom to top"),
    axisDescription(rain, "from left to right"),
    scale,
  ].join(" ");
}

function axisDescription(axis: BivariateLegendAxis, direction: string) {
  const last = axis.stops.length - 1;
  const first = axis.stops[0];
  const end = axis.stops[last];
  const middle = axis.stops[Math.round(last / 2)];
  const start = axis.isBottomOpen ? `${first} or less` : String(first);

  return `${axis.title} grows ${direction} from ${start} to ${end} or more ${axis.units}, `
    + `with ${middle} in the middle.`;
}

function axisTitle(text: string, className: string) {
  const title = document.createElement("div");
  title.className = className;
  title.textContent = text;
  return title;
}

function bivariateSquare(colors: Uint8ClampedArray, rainStops: number, temperatureStops: number) {
  const canvas = document.createElement("canvas");
  canvas.width = BIVARIATE_SIZE_PX;
  canvas.height = BIVARIATE_SIZE_PX;
  const context = canvas.getContext("2d")!;
  const image = context.createImageData(BIVARIATE_SIZE_PX, BIVARIATE_SIZE_PX);
  const lastPixel = BIVARIATE_SIZE_PX - 1;

  for (let y = 0; y < BIVARIATE_SIZE_PX; y++) {
    const temperature = Math.round((1 - y / lastPixel) * (LUT2D_SIZE - 1));
    for (let x = 0; x < BIVARIATE_SIZE_PX; x++) {
      const rain = Math.round((x / lastPixel) * (LUT2D_SIZE - 1));
      const start = (rain * LUT2D_SIZE + temperature) * RGBA_CHANNELS;
      const pixel = (y * BIVARIATE_SIZE_PX + x) * RGBA_CHANNELS;
      image.data.set(colors.subarray(start, start + RGBA_CHANNELS), pixel);
    }
  }
  context.putImageData(image, 0, 0);

  context.fillStyle = `rgba(255, 255, 255, ${BIVARIATE_GRID_ALPHA})`;
  for (let stop = 0; stop < temperatureStops; stop++) {
    const y = Math.round((stop / (temperatureStops - 1)) * lastPixel);
    context.fillRect(0, y, BIVARIATE_SIZE_PX, 1);
  }
  for (let stop = 0; stop < rainStops; stop++) {
    const x = Math.round((stop / (rainStops - 1)) * lastPixel);
    context.fillRect(x, 0, 1, BIVARIATE_SIZE_PX);
  }
  return canvas;
}

function axisLabels(axis: BivariateLegendAxis, className: string) {
  const labels = document.createElement("div");
  labels.className = className;
  const last = axis.stops.length - 1;
  for (const index of [0, Math.round(last / 2), last]) {
    const position = index / last;
    const label = document.createElement("span");
    label.textContent = openLabel(position, axis.stops[index], axis.isBottomOpen);
    if (className === "legend-bivariate-rows") label.style.top = `${(1 - position) * 100}%`;
    else label.style.left = `${position * 100}%`;
    labels.append(label);
  }
  return labels;
}

/**
 * Build a colour bar with positioned stop labels and a separate units caption.
 * The top label is open-ended while a custom range also opens the bottom label.
 */
export function gradientLegend(
  colors: Uint8ClampedArray,
  stops: number[],
  units: string,
  isBottomOpen = false,
) {
  const element = document.createElement("div");
  const unitsCaption = document.createElement("div");
  unitsCaption.textContent = units;
  element.append(unitsCaption, gradientBar(colors), stopLabels(stops, isBottomOpen));
  return element;
}

function gradientBar(colors: Uint8ClampedArray) {
  const stops = GRADIENT_STOP_ENTRIES.map((entry) => {
    const start = entry * RGBA_CHANNELS;
    const [red, green, blue] = colors.subarray(start, start + COLOR_CHANNELS);
    const percent = Math.round((entry / LAST_ENTRY) * 100);

    return `rgb(${red}, ${green}, ${blue}) ${percent}%`;
  });

  const bar = document.createElement("div");
  bar.className = "legend-bar";
  bar.style.background = `linear-gradient(to right, ${stops.join(", ")})`;
  return bar;
}

function stopLabels(stops: number[], isBottomOpen: boolean) {
  const labels = document.createElement("div");
  labels.className = "legend-labels";
  labels.style.position = "relative";
  labels.style.height = "1.3em";
  for (const { position, value } of legendTicks(stops)) {
    const label = document.createElement("span");
    label.style.position = "absolute";
    label.style.left = `${position * 100}%`;
    label.style.transform = `translateX(${-position * 100}%)`;
    label.style.whiteSpace = "nowrap";
    // The top of a fitted scale is the 98th percentile.
    label.textContent = openLabel(position, value, isBottomOpen);
    labels.append(label);
  }
  return labels;
}

function openLabel(position: number, value: number, isBottomOpen: boolean) {
  if (position === 1) return `≥ ${value}`;

  return position === 0 && isBottomOpen ? `≤ ${value}` : String(value);
}

/** Render a swatch and name for each class present in the area. */
export function classLegend(
  classes: ClassDoc[],
  presentValues: Set<number>,
  colors: Map<number, number[]>,
) {
  const element = document.createElement("div");
  for (const { value, label } of classes.filter((entry) => presentValues.has(entry.value))) {
    const row = document.createElement("div");
    const swatch = document.createElement("span");
    swatch.className = "legend-swatch";
    swatch.style.background = `rgb(${colors.get(value)!.join(", ")})`;
    const name = document.createElement("span");
    name.textContent = label;
    row.append(swatch, name);
    element.append(row);
  }
  return element;
}
