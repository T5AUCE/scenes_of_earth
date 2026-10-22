/** Build legends for colour scales and the map's non-colour encodings. */
import type { Map as MapLibreMap } from "maplibre-gl";

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
import {
  HALO_WIDTH_PX,
  POSITION_JITTER_RATIO,
  VALUE_RADIUS_EXPONENT,
  dotAppearance,
  dotLattice,
  highZoomDotOpacity,
  levelRadiusPx,
  levelSpacingPx,
  siteNoise,
  type DotLattice,
} from "./render/lattice";
import { type InkPaint, rgbCss } from "./render/palettes";
import type { ClassDoc, GridDoc } from "./types";

const GRADIENT_STOP_ENTRIES = [0, 64, 128, 192, 255];

const ISOTHERM_SAMPLE_WIDTH_PX = 24;
const ISOTHERM_SAMPLE_LINE_PX = 2;
const ISOTHERM_SAMPLE_CASING_PX = ISOTHERM_SAMPLE_LINE_PX * ISOTHERM_CASING_RATIO;
const ISOTHERM_SAMPLE_GAP_PX = 6;

const DOT_SWATCH_PX = 48;
const DOT_SWATCH_GAP_PX = 2;
const MOST_DOTS_PER_SIDE = 3;
const FEWEST_DOTS_PER_SIDE = 2;
const MAX_DOTS_PER_SIDE = 6;
const MIN_THREE_DOT_RADIUS_PX = 1.5;
const MIN_FULL_DOT_RADIUS_PX = 1.2;
// Matches HALO_ALPHA in gpu/field-marks-shaders.ts.
const DOT_SWATCH_HALO_ALPHA = 0.7;

const BIVARIATE_SIZE_PX = 112;
const BIVARIATE_GRID_ALPHA = 0.35;

/** The legend line for contours. */
export function contourLegendText(interval: number, boldInterval: number, units = "m") {
  const emphasis = interval >= boldInterval ? "all bold" : `bold every ${boldInterval} ${units}`;
  return `Contours every ${interval} ${units} (${emphasis})`;
}

/** A dashed sample of the isotherm ink and its casing with the interval and bold step. */
export function isothermLegend(interval: number, ink: InkPaint, units = "°C") {
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
  label.textContent = `Isotherms every ${interval} ${units} (bold every ${boldInterval} ${units})`;
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
 * Swatches that show the dots of the value labelled below as a grid of whole dots. The lowest
 * value is left out because its dots have no area.
 * The dots of a swatch ink the same share of its box as the map's dots ink of the map at the
 * current zoom and density, so the caller redraws it when either changes.
 */
export function dotLegend(
  stops: number[],
  units: string,
  grid: GridDoc,
  zoom: number,
  density: number,
  ink: InkPaint,
) {
  const element = document.createElement("div");
  const unitsCaption = document.createElement("div");
  unitsCaption.textContent = units;
  const boxes = document.createElement("div");
  boxes.className = "legend-dot-row";
  const labels = document.createElement("div");
  labels.className = "legend-dot-row";
  const ticks = legendTicks(stops).slice(1);
  const columns = `repeat(${ticks.length}, ${DOT_SWATCH_PX + DOT_SWATCH_GAP_PX}px)`;
  boxes.style.gridTemplateColumns = columns;
  labels.style.gridTemplateColumns = columns;
  const lattice = dotSwatchLattice(grid, zoom, pixelRatio(), density);
  const dotsPerSide = dotsPerSideFor(ticks[0].position, lattice);
  for (const { position, value } of ticks) {
    boxes.append(dotSwatch(position, ink, lattice, dotsPerSide));
    const label = document.createElement("span");
    label.textContent = openLabel(position, value, false);
    labels.append(label);
  }
  element.append(unitsCaption, boxes, labels);
  return element;
}

// The lowest value decides the base grid because its dots are the smallest.
function dotsPerSideFor(lowestPosition: number, lattice: DotSwatchLattice) {
  const radiusPx = swatchRadiusPx(lowestPosition, lattice, MOST_DOTS_PER_SIDE);
  const base = radiusPx >= MIN_THREE_DOT_RADIUS_PX ? MOST_DOTS_PER_SIDE : FEWEST_DOTS_PER_SIDE;
  return Math.max(1, Math.min(Math.round(base * lattice.density), maxDotsPerSide(lattice)));
}

// Rounding keeps the grid responsive to density while the full dot stays near the readable radius.
function maxDotsPerSide(lattice: DotSwatchLattice) {
  const fullRadiusPx = Math.sqrt((lattice.inkShare * DOT_SWATCH_PX ** 2) / Math.PI);
  return Math.min(
    MAX_DOTS_PER_SIDE,
    Math.max(1, Math.round(fullRadiusPx / MIN_FULL_DOT_RADIUS_PX)),
  );
}

/** The radius that makes the box's dots ink the share of it that the map's dots ink. */
function swatchRadiusPx(position: number, lattice: DotSwatchLattice, dotsPerSide: number) {
  const fullRadiusPx = Math.sqrt(
    (lattice.inkShare * DOT_SWATCH_PX ** 2) / (Math.PI * dotsPerSide ** 2),
  );
  return fullRadiusPx * position ** VALUE_RADIUS_EXPONENT;
}

/** A dot of a legend swatch in css px, with its sub-pixel fade applied to radius and opacity. */
export interface DotSwatchDot {
  x: number;
  y: number;
  radiusPx: number;
  opacity: number;
}

/** Refreshes a zoom-dependent legend after each zoom, but only while it is switched on. */
export function createZoomWatch(map: Pick<MapLibreMap, "on" | "off">, refresh: () => void) {
  let isActive = false;
  return {
    setActive(next: boolean) {
      if (next === isActive) return;

      isActive = next;
      if (next) map.on("zoomend", refresh);
      else map.off("zoomend", refresh);
    },
  };
}

/** The map's dot lattice with how much it inks and how visible its dots are. */
export interface DotSwatchLattice extends DotLattice {
  opacity: number;
  /** The share of a surface that the dots at the full value ink, before the high-zoom fade. */
  inkShare: number;
}

/** The dot lattice the map draws for a grid at a zoom, density and device pixel ratio. */
export function dotSwatchLattice(
  grid: GridDoc,
  zoom: number,
  pixelRatio: number,
  density: number,
): DotSwatchLattice {
  const [west, south, east, north] = grid.bbox;
  const cellDegrees = { width: (east - west) / grid.nx, height: (north - south) / grid.ny };
  const lattice = dotLattice(cellDegrees, (south + north) / 2, zoom, density, pixelRatio);
  return {
    ...lattice,
    opacity: highZoomDotOpacity(zoom, pixelRatio),
    inkShare: fullValueInkShare(lattice),
  };
}

/**
 * The full-value ink share. Area jitter cancels across each complete level while the shader
 * mixes parent and child areas linearly. The minimum-radius fade also preserves ink area.
 */
function fullValueInkShare(lattice: DotLattice) {
  const { level, fade } = lattice;
  const parentShare = levelInkShare(lattice, level);
  if (fade === 0) return parentShare;

  return (1 - fade) * parentShare + fade * levelInkShare(lattice, level + 1);
}

function levelInkShare(
  { sidesPx, aimedPx, pixelRatio, density }: DotLattice,
  level: number,
) {
  const spacingPx = levelSpacingPx(sidesPx, level);
  const radiusPx = levelRadiusPx(sidesPx, level, aimedPx, pixelRatio, density);
  return Math.PI * radiusPx ** 2 / (spacingPx.x * spacingPx.y);
}

function dotSwatch(
  position: number,
  ink: InkPaint,
  lattice: DotSwatchLattice,
  dotsPerSide: number,
) {
  const swatch = document.createElement("canvas");
  swatch.className = "legend-dot-box";
  swatch.style.width = `${DOT_SWATCH_PX}px`;
  swatch.style.height = `${DOT_SWATCH_PX}px`;
  swatch.width = DOT_SWATCH_PX * lattice.pixelRatio;
  swatch.height = DOT_SWATCH_PX * lattice.pixelRatio;
  const context = swatch.getContext("2d")!;
  context.scale(lattice.pixelRatio, lattice.pixelRatio);
  drawSwatchDots(context, position, ink, lattice, dotsPerSide);
  return swatch;
}

function pixelRatio() {
  return typeof window === "undefined" ? 1 : window.devicePixelRatio;
}

function drawSwatchDots(
  context: CanvasRenderingContext2D,
  position: number,
  ink: InkPaint,
  lattice: DotSwatchLattice,
  dotsPerSide: number,
) {
  const haloWidthPx = haloReachPx(lattice);
  for (const { x, y, radiusPx, opacity } of dotSwatchDots(position, lattice, dotsPerSide)) {
    const haloOpacity = DOT_SWATCH_HALO_ALPHA * opacity;
    fillCircle(context, x, y, radiusPx + haloWidthPx, ink.halo, haloOpacity);
    fillCircle(context, x, y, radiusPx, ink.ink, opacity);
  }
}

/** The halo width in css px, which the shader adds in device px so high-DPI screens narrow it. */
function haloReachPx(lattice: DotSwatchLattice) {
  return HALO_WIDTH_PX / lattice.pixelRatio;
}

/**
 * A square grid of whole dots centred in their sites, each shifted by the shader's site jitter.
 * The dots share the radius that gives the map's ink share, so none leaves the box.
 */
export function dotSwatchDots(
  position: number,
  lattice: DotSwatchLattice,
  dotsPerSide: number,
): DotSwatchDot[] {
  if (lattice.opacity === 0) return [];

  const spacingPx = DOT_SWATCH_PX / dotsPerSide;
  const appearance = dotAppearance(swatchRadiusPx(position, lattice, dotsPerSide));
  const dots: DotSwatchDot[] = [];
  for (let row = 0; row < dotsPerSide; row++) {
    for (let column = 0; column < dotsPerSide; column++) {
      const jitter = siteNoise(column, row);
      dots.push({
        x: (column + 0.5 + jitter.x * POSITION_JITTER_RATIO) * spacingPx,
        y: (row + 0.5 + jitter.y * POSITION_JITTER_RATIO) * spacingPx,
        radiusPx: appearance.radiusPx,
        opacity: appearance.opacity * lattice.opacity,
      });
    }
  }
  return dots;
}

function fillCircle(
  context: CanvasRenderingContext2D,
  x: number,
  y: number,
  radiusPx: number,
  color: number[],
  opacity: number,
) {
  context.globalAlpha = opacity;
  context.fillStyle = rgbCss(color);
  context.beginPath();
  context.arc(x, y, radiusPx, 0, Math.PI * 2);
  context.fill();
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
