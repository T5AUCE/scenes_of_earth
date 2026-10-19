import { COLOR_CHANNELS, LAST_ENTRY, legendTicks, RGBA_CHANNELS } from "./render/colormap";
import type { ClassDoc } from "./types";

const GRADIENT_STOP_ENTRIES = [0, 64, 128, 192, 255];

/** The legend line for contours. */
export function contourLegendText(interval: number, boldInterval: number, units = "m") {
  const emphasis = interval >= boldInterval ? "all bold" : `bold every ${boldInterval} ${units}`;
  return `Contours every ${interval} ${units} (${emphasis})`;
}

/** A colour bar with stop labels under their colours and a separate units caption. */
export function gradientLegend(
  colors: Uint8ClampedArray,
  stops: number[],
  units: string,
) {
  const element = document.createElement("div");
  const unitsCaption = document.createElement("div");
  unitsCaption.textContent = units;
  element.append(unitsCaption, gradientBar(colors), stopLabels(stops));
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

function stopLabels(stops: number[]) {
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
    // The top of the scale is the 98th percentile.
    label.textContent = position === 1 ? `≥ ${value}` : String(value);
    labels.append(label);
  }
  return labels;
}

/** One row per class present in the area: a swatch in the active colour and the class name. */
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
