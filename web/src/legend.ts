import { COLOR_CHANNELS, LAST_ENTRY, legendTicks, RGBA_CHANNELS } from "./render/colormap";
import type { ClassDoc } from "./types";

const GRADIENT_STOP_ENTRIES = [0, 64, 128, 192, 255];

/** The legend line for contours. */
export function contourLegendText(interval: number, boldInterval: number, units = "m") {
  const emphasis = interval >= boldInterval ? "all bold" : `bold every ${boldInterval} ${units}`;
  return `Contours every ${interval} ${units} (${emphasis})`;
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
