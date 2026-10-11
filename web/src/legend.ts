export function gradientLegend(
  colors: Uint8ClampedArray,
  domain: [number, number],
  units: string,
) {
  const stops = [0, 64, 128, 192, 255].map((i) => {
    const [r, g, b] = colors.subarray(i * 4, i * 4 + 3);
    return `rgb(${r}, ${g}, ${b}) ${Math.round((i / 255) * 100)}%`;
  });
  const bar = document.createElement("div");
  bar.className = "legend-bar";
  bar.style.background = `linear-gradient(to right, ${stops.join(", ")})`;

  const labels = document.createElement("div");
  labels.className = "legend-labels";
  const low = document.createElement("span");
  low.textContent = String(domain[0]);
  const high = document.createElement("span");
  high.textContent = `≥ ${Number(domain[1].toPrecision(3))} ${units}`; // the top of the scale is the 98th percentile
  labels.append(low, high);

  const element = document.createElement("div");
  element.append(bar, labels);
  return element;
}
