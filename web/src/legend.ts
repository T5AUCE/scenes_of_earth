import {
  COLOR_CHANNELS,
  LAST_ENTRY,
  legendTicks,
  LUT2D_SIZE,
  RGBA_CHANNELS,
} from "./render/colormap";
import { BOLD_ISOTHERM_MULTIPLE, ISOTHERM_COLOR } from "./render/isolines";
import { bayerRank, dotCount, DOT_RADIUS_RATIO } from "./render/lattice";
import type { ClassDoc } from "./types";

const GRADIENT_STOP_ENTRIES = [0, 64, 128, 192, 255];

const ISOTHERM_SAMPLE_WIDTH_PX = 24;
const ISOTHERM_SAMPLE_BORDER_PX = 2;
const ISOTHERM_SAMPLE_GAP_PX = 6;

/** The red, green and blue of the rain dots, a dark blue that reads on every colour. */
export const DOT_INK_RGB: [number, number, number] = [26, 54, 88];
const DOT_BOX_PX = 28;
const DOT_LEGEND_LEVEL = 2;
const DOT_LEGEND_THRESHOLD = 0.5;
const BIVARIATE_SIZE_PX = 112;
const BIVARIATE_GRID_ALPHA = 0.35;
const BIVARIATE_READING = "Darker is wetter. Blue is cool, green mild and terracotta hot.";

const KM_PER_DEGREE = 111.2;
const KM_DECIMALS = 1;

/** The legend line for contours. */
export function contourLegendText(interval: number, boldInterval: number, units = "m") {
  const emphasis = interval >= boldInterval ? "all bold" : `bold every ${boldInterval} ${units}`;
  return `Contours every ${interval} ${units} (${emphasis})`;
}

/** A dashed sample of the isotherm ink with its interval and bold step. */
export function isothermLegend(interval: number) {
  const element = document.createElement("div");
  const sample = document.createElement("span");
  sample.className = "legend-isotherm";
  sample.style.borderTop =
    `${ISOTHERM_SAMPLE_BORDER_PX}px dashed ${ISOTHERM_COLOR}`;
  sample.style.display = "inline-block";
  sample.style.marginRight = `${ISOTHERM_SAMPLE_GAP_PX}px`;
  sample.style.verticalAlign = "middle";
  sample.style.width = `${ISOTHERM_SAMPLE_WIDTH_PX}px`;
  const boldInterval = interval * BOLD_ISOTHERM_MULTIPLE;
  const label = document.createElement("span");
  label.textContent =
    `Isotherms every ${interval} °C (bold every ${boldInterval} °C)`;
  element.append(sample, label);
  return element;
}

/**
 * Five boxes drawn with the map's own dot count, each with the value its density stands for.
 * blockCells above 1 adds the zoomed-out note that one dot site covers several cells.
 */
export function dotLegend(stops: number[], units: string, resDeg: number, blockCells = 1) {
  const element = document.createElement("div");
  const unitsCaption = document.createElement("div");
  unitsCaption.textContent = units;
  const boxes = document.createElement("div");
  boxes.className = "legend-dot-row";
  const labels = document.createElement("div");
  labels.className = "legend-dot-row";
  for (const { position, value } of legendTicks(stops)) {
    boxes.append(dotBox(position));
    const label = document.createElement("span");
    label.textContent = openLabel(position, value, false);
    labels.append(label);
  }
  const note = document.createElement("div");
  const cellKm = (resDeg * KM_PER_DEGREE).toFixed(KM_DECIMALS);
  note.textContent = `More dots mean higher values. Dots sit on the ${resDeg}° grid `
    + `(≈ ${cellKm} km); zooming in adds dots inside each cell, not data.`;
  element.append(unitsCaption, boxes, labels, note);
  if (blockCells > 1) {
    const block = document.createElement("div");
    block.textContent = `Here: 1 dot site per ${blockCells}×${blockCells} cells`;
    element.append(block);
  }
  return element;
}

/** One axis of the two-way legend: its name, units, fitted or custom stops and open ends. */
export interface BivariateLegendAxis {
  title: string;
  units: string;
  stops: number[];
  isBottomOpen: boolean;
}

/**
 * A square of the blend's colours with rain rising and temperature growing warmer to the right.
 * Faint lines mark the nine stops of each axis, and labels name the first, middle and last.
 */
export function bivariateLegend(
  colors: Uint8ClampedArray,
  rain: BivariateLegendAxis,
  temperature: BivariateLegendAxis,
  isFitted: boolean,
) {
  const element = document.createElement("div");
  element.className = "legend-bivariate";
  const rainTitle = axisTitle(`↑ ${rain.title}`, rain.units);
  const temperatureTitle = axisTitle(`${temperature.title} →`, temperature.units);

  const plot = document.createElement("div");
  plot.className = "legend-bivariate-plot";
  plot.append(
    axisLabels(rain, "legend-bivariate-rows"),
    bivariateSquare(colors, rain.stops.length, temperature.stops.length),
    document.createElement("span"),
    axisLabels(temperature, "legend-bivariate-columns"),
  );

  const scale = document.createElement("div");
  scale.textContent = isFitted ? "Fitted to this area" : "Custom range";
  const reading = document.createElement("div");
  reading.textContent = BIVARIATE_READING;
  element.append(rainTitle, plot, temperatureTitle, scale, reading);
  return element;
}

function axisTitle(text: string, units: string) {
  const title = document.createElement("div");
  title.textContent = `${text} (${units})`;
  return title;
}

function bivariateSquare(colors: Uint8ClampedArray, rowStops: number, columnStops: number) {
  const canvas = document.createElement("canvas");
  canvas.width = BIVARIATE_SIZE_PX;
  canvas.height = BIVARIATE_SIZE_PX;
  const context = canvas.getContext("2d")!;
  const image = context.createImageData(BIVARIATE_SIZE_PX, BIVARIATE_SIZE_PX);
  const lastPixel = BIVARIATE_SIZE_PX - 1;

  for (let y = 0; y < BIVARIATE_SIZE_PX; y++) {
    const row = Math.round((1 - y / lastPixel) * (LUT2D_SIZE - 1));
    for (let x = 0; x < BIVARIATE_SIZE_PX; x++) {
      const column = Math.round((x / lastPixel) * (LUT2D_SIZE - 1));
      const start = (row * LUT2D_SIZE + column) * RGBA_CHANNELS;
      const pixel = (y * BIVARIATE_SIZE_PX + x) * RGBA_CHANNELS;
      image.data.set(colors.subarray(start, start + RGBA_CHANNELS), pixel);
    }
  }
  context.putImageData(image, 0, 0);

  context.fillStyle = `rgba(255, 255, 255, ${BIVARIATE_GRID_ALPHA})`;
  for (let stop = 0; stop < rowStops; stop++) {
    context.fillRect(0, Math.round((stop / (rowStops - 1)) * lastPixel), BIVARIATE_SIZE_PX, 1);
  }
  for (let stop = 0; stop < columnStops; stop++) {
    context.fillRect(Math.round((stop / (columnStops - 1)) * lastPixel), 0, 1, BIVARIATE_SIZE_PX);
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

function dotBox(position: number) {
  const slots = 2 ** DOT_LEGEND_LEVEL;
  const spacingPx = DOT_BOX_PX / slots;
  const diameterPx = 2 * DOT_RADIUS_RATIO * spacingPx;
  const count = dotCount(position, DOT_LEGEND_LEVEL, DOT_LEGEND_THRESHOLD);
  const box = document.createElement("span");
  box.className = "legend-dot-box";
  for (let row = 0; row < slots; row++) {
    for (let column = 0; column < slots; column++) {
      if (bayerRank(column, row, DOT_LEGEND_LEVEL) >= count) continue;

      const dot = document.createElement("span");
      dot.className = "legend-dot";
      dot.style.width = `${diameterPx}px`;
      dot.style.height = `${diameterPx}px`;
      dot.style.left = `${(column + 0.5) * spacingPx - diameterPx / 2}px`;
      dot.style.top = `${(row + 0.5) * spacingPx - diameterPx / 2}px`;
      box.append(dot);
    }
  }
  return box;
}

/**
 * A colour bar with stop labels under their colours and a separate units caption. The top label
 * is open ended, and so is the bottom one when the scale is a custom range.
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
