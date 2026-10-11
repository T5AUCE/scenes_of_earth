import { COLOR_CHANNELS, LAST_ENTRY, RGBA_CHANNELS } from "./render/colormap";

const GRADIENT_STOP_ENTRIES = [0, 64, 128, 192, 255];

export function gradientLegend(
  colors: Uint8ClampedArray,
  domain: [number, number],
  units: string,
) {
  const element = document.createElement("div");
  element.append(gradientBar(colors), domainLabels(domain, units));

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

function domainLabels([low, high]: [number, number], units: string) {
  const lowLabel = document.createElement("span");
  lowLabel.textContent = String(low);

  // The top of the scale is the 98th percentile.
  const highLabel = document.createElement("span");
  highLabel.textContent = `≥ ${Number(high.toPrecision(3))} ${units}`;

  const labels = document.createElement("div");
  labels.className = "legend-labels";
  labels.append(lowLabel, highLabel);

  return labels;
}
