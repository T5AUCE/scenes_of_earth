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
  MIN_DOT_RADIUS_PX,
  POSITION_JITTER_RATIO,
  VALUE_RADIUS_EXPONENT,
  dotAppearance,
  dotLattice,
  highZoomDotOpacity,
  highZoomDotSizeScale,
  levelRadiusPx,
  levelSpacingPx,
  representativeRadiusPx,
  representativeSpacingPx,
  siteNoise,
  writeContinuousLattice,
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
const MAX_DOTS_PER_SIDE = 6;
// Matches HALO_ALPHA in gpu/field-marks-shaders.ts.
const DOT_SWATCH_HALO_ALPHA = 0.7;

// Each preview site keeps the shader's jitter, cached once because the grid is bounded.
const SITE_JITTER: { x: number; y: number }[] = [];
for (let row = 0; row < MAX_DOTS_PER_SIDE; row++) {
  for (let column = 0; column < MAX_DOTS_PER_SIDE; column++) {
    SITE_JITTER.push(siteNoise(column, row));
  }
}

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
  // Shares the contour line's smaller text so both interval notes read alike and fit one line.
  element.className = "legend-contour";
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
  element.textContent = "No data";
  return element;
}

/**
 * Swatches that show the dots of the value labelled below at the map's dot size. The lowest
 * value is left out because its dots have no area. Rebuild the legend when the style changes
 * and repaint its retained canvases when the zoom or density changes.
 */
export function dotLegend(
  stops: number[],
  units: string,
  grid: GridDoc,
  zoom: number,
  density: number,
  ink: InkPaint,
) {
  return createDotLegend(stops, units, grid, zoom, density, ink, pixelRatio()).element;
}

/** A dot legend whose canvases stay while the zoom or density repaints them in place. */
export interface DotLegendHandle {
  element: HTMLElement;
  repaint(zoom: number, density: number, pixelRatio: number): void;
}

/** One retained swatch canvas with the context its repaints reuse. */
interface RetainedSwatch {
  canvas: HTMLCanvasElement;
  context: CanvasRenderingContext2D;
}

/**
 * Build a dot legend and paint its swatches at the map's dot size. The handle repaints the
 * retained canvases without rebuilding the legend or allocating per-dot objects.
 */
export function createDotLegend(
  stops: number[],
  units: string,
  grid: GridDoc,
  zoom: number,
  density: number,
  ink: InkPaint,
  pixelRatio: number,
): DotLegendHandle {
  const shell = buildDotShell(stops, units, grid, ink);
  const repaint = createSwatchRepaint(shell);
  repaint(zoom, density, pixelRatio);

  return { element: shell.element, repaint };
}

interface DotShell {
  element: HTMLElement;
  swatches: RetainedSwatch[];
  positions: number[];
  inkCss: string;
  haloCss: string;
  cellDegrees: { width: number; height: number };
  latitude: number;
}

function buildDotShell(
  stops: number[],
  units: string,
  grid: GridDoc,
  ink: InkPaint,
): DotShell {
  const element = document.createElement("div");
  const unitsCaption = document.createElement("div");
  unitsCaption.className = "legend-units";
  unitsCaption.textContent = units;
  const boxes = document.createElement("div");
  boxes.className = "legend-dot-row";
  const labels = document.createElement("div");
  labels.className = "legend-dot-row";
  const ticks = legendTicks(stops).slice(1);
  const columns = `repeat(${ticks.length}, ${DOT_SWATCH_PX + DOT_SWATCH_GAP_PX}px)`;
  boxes.style.gridTemplateColumns = columns;
  labels.style.gridTemplateColumns = columns;
  const positions = ticks.map(({ position }) => position);
  const inkCss = rgbCss(ink.ink);
  const haloCss = rgbCss(ink.halo);
  const [west, south, east, north] = grid.bbox;
  const cellDegrees = { width: (east - west) / grid.nx, height: (north - south) / grid.ny };
  const latitude = (south + north) / 2;
  const swatches: RetainedSwatch[] = [];
  for (const { position, value } of ticks) {
    const canvas = document.createElement("canvas");
    canvas.className = "legend-dot-box";
    canvas.style.width = `${DOT_SWATCH_PX}px`;
    canvas.style.height = `${DOT_SWATCH_PX}px`;
    boxes.append(canvas);
    swatches.push({ canvas, context: canvas.getContext("2d")! });
    const label = document.createElement("span");
    label.textContent = openLabel(position, value, false);
    labels.append(label);
  }
  element.append(unitsCaption, boxes, labels);

  return { element, swatches, positions, inkCss, haloCss, cellDegrees, latitude };
}

function createSwatchRepaint(shell: DotShell): DotLegendHandle["repaint"] {
  const lattice: DotLattice = {
    level: 0,
    fade: 0,
    sidesPx: { width: 1, height: 1 },
    aimedPx: 1,
    density: 1,
    pixelRatio: 1,
    zoom: 0,
  };
  let lastZoom = NaN;
  let lastDensity = NaN;
  let lastRatio = NaN;

  return (nextZoom, nextDensity, nextRatio) => {
    if (nextZoom === lastZoom && nextDensity === lastDensity && nextRatio === lastRatio) return;

    lastZoom = nextZoom;
    lastDensity = nextDensity;
    lastRatio = nextRatio;
    writeContinuousLattice(
      lattice,
      shell.cellDegrees,
      shell.latitude,
      nextZoom,
      nextDensity,
      nextRatio,
    );
    const radiusPx = representativeRadiusPx(lattice);
    // The swatch shrinks with the map, so its reach check uses the displayed size.
    const sizeScale = highZoomDotSizeScale(nextZoom, nextRatio);
    const count = previewDotsPerSide(
      representativeSpacingPx(lattice),
      radiusPx * sizeScale,
      (HALO_WIDTH_PX / nextRatio) * sizeScale,
    );
    const opacity = highZoomDotOpacity(nextZoom, nextRatio);
    for (let index = 0; index < shell.swatches.length; index++) {
      paintSwatch(
        shell.swatches[index],
        shell.positions[index],
        shell.inkCss,
        shell.haloCss,
        radiusPx,
        count,
        opacity,
        nextRatio,
        sizeScale,
      );
    }
  };
}

function paintSwatch(
  swatch: RetainedSwatch,
  position: number,
  inkCss: string,
  haloCss: string,
  radiusPx: number,
  dotsPerSide: number,
  opacity: number,
  pixelRatio: number,
  sizeScale: number,
) {
  const { canvas, context } = swatch;
  const backingPx = Math.round(DOT_SWATCH_PX * pixelRatio);
  if (canvas.width !== backingPx || canvas.height !== backingPx) {
    canvas.width = backingPx;
    canvas.height = backingPx;
  }
  // Resizing clears the transform, so reset it before every redraw.
  context.setTransform(pixelRatio, 0, 0, pixelRatio, 0, 0);
  context.clearRect(0, 0, DOT_SWATCH_PX, DOT_SWATCH_PX);
  if (opacity === 0) return;

  // The size fade shrinks the radius first, so tiny swatch dots fade rather than persisting.
  const fullPx = radiusPx * position ** VALUE_RADIUS_EXPONENT * sizeScale;
  const drawnPx = fullPx >= MIN_DOT_RADIUS_PX ? fullPx : MIN_DOT_RADIUS_PX;
  const fullAlpha = fullPx >= MIN_DOT_RADIUS_PX ? 1 : (fullPx / MIN_DOT_RADIUS_PX) ** 2;
  const spacingPx = DOT_SWATCH_PX / dotsPerSide;
  const haloPx = (HALO_WIDTH_PX / pixelRatio) * sizeScale;
  for (let row = 0; row < dotsPerSide; row++) {
    for (let column = 0; column < dotsPerSide; column++) {
      const jitter = SITE_JITTER[row * MAX_DOTS_PER_SIDE + column];
      const x = (column + 0.5 + jitter.x * POSITION_JITTER_RATIO) * spacingPx;
      const y = (row + 0.5 + jitter.y * POSITION_JITTER_RATIO) * spacingPx;
      const dotOpacity = fullAlpha;
      const haloOpacity = DOT_SWATCH_HALO_ALPHA * fullAlpha;
      fillCircle(context, x, y, drawnPx + haloPx, haloCss, haloOpacity);
      fillCircle(context, x, y, drawnPx, inkCss, dotOpacity);
    }
  }
  // The composed swatch fades once, so overlapping dot and halo alphas scale together.
  context.globalCompositeOperation = "destination-in";
  context.globalAlpha = opacity;
  context.fillRect(0, 0, DOT_SWATCH_PX, DOT_SWATCH_PX);
  context.globalCompositeOperation = "source-over";
  context.globalAlpha = 1;
}

/** A dot of a legend swatch in css px, with its sub-pixel fade applied to radius and opacity. */
export interface DotSwatchDot {
  x: number;
  y: number;
  radiusPx: number;
  opacity: number;
}

/** Refreshes a zoom-dependent legend on every map render, but only while it is switched on. */
export function createZoomWatch(map: Pick<MapLibreMap, "on" | "off">, refresh: () => void) {
  let isActive = false;
  return {
    setActive(next: boolean) {
      if (next === isActive) return;

      isActive = next;
      if (next) map.on("render", refresh);
      else map.off("render", refresh);
    },
  };
}

/**
 * Identify a dot legend's structure so callers rebuild only when the style or labels change.
 * The zoom and densities only repaint the retained canvases, so they stay out of the key.
 */
export function dotLegendKey(
  stops: number[],
  units: string,
  grid: GridDoc,
  ink: InkPaint,
  hasHatched: boolean,
): string {
  const ticks = legendTicks(stops).slice(1);
  return JSON.stringify([ticks, units, grid.bbox, grid.nx, grid.ny, ink, hasHatched]);
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
  { sidesPx, aimedPx, pixelRatio, density, zoom }: DotLattice,
  level: number,
) {
  const spacingPx = levelSpacingPx(sidesPx, level);
  // The cap bounds the share at close zoom while the size fade leaves it alone.
  const radiusPx = levelRadiusPx(sidesPx, level, aimedPx, pixelRatio, density, zoom);
  return Math.PI * radiusPx ** 2 / (spacingPx.x * spacingPx.y);
}

/**
 * How many whole sample sites fit across a swatch box at the map's spacing. The radius keeps
 * the map size, so the reach check only lowers the count and one centred dot always remains.
 */
export function previewDotsPerSide(
  spacingPx: number,
  radiusPx: number,
  haloPx: number,
): number {
  const roomy = Math.max(1, Math.min(MAX_DOTS_PER_SIDE, Math.floor(DOT_SWATCH_PX / spacingPx) + 1));
  for (let dots = roomy; dots > 1; dots--) {
    if (swatchFits(dots, spacingPx, radiusPx, haloPx)) return dots;
  }

  return 1;
}

function swatchFits(
  dotsPerSide: number,
  spacingPx: number,
  radiusPx: number,
  haloPx: number,
): boolean {
  const firstPx = (DOT_SWATCH_PX - (dotsPerSide - 1) * spacingPx) / 2;
  const reachPx = radiusPx + haloPx + POSITION_JITTER_RATIO * spacingPx;

  return firstPx - reachPx >= 0;
}

function pixelRatio() {
  return typeof window === "undefined" ? 1 : window.devicePixelRatio;
}

/**
 * A square grid of whole dots centred in their sites, each shifted by the shader's site jitter.
 * The dots use the map's radius at the lattice, so the count sets the layout while the radius
 * keeps the map size.
 */
export function dotSwatchDots(
  position: number,
  lattice: DotSwatchLattice,
  dotsPerSide: number,
): DotSwatchDot[] {
  if (lattice.opacity === 0) return [];

  const spacingPx = DOT_SWATCH_PX / dotsPerSide;
  // The swatch reports the displayed radius, shrunk through the close-zoom size fade.
  const sizeScale = highZoomDotSizeScale(lattice.zoom, lattice.pixelRatio);
  const fullPx = representativeRadiusPx(lattice) * position ** VALUE_RADIUS_EXPONENT * sizeScale;
  const appearance = dotAppearance(fullPx);
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
  css: string,
  opacity: number,
) {
  context.globalAlpha = opacity;
  context.fillStyle = css;
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
  unitsCaption.className = "legend-units";
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

/**
 * Render a swatch and name for each class present in the area. Classes with a group are listed
 * under a heading button that expands and collapses them, collapsed unless its group is in
 * `expandedGroups`. The set keeps the state between redraws of the caller; classes without a
 * group form a flat list.
 */
export function classLegend(
  classes: ClassDoc[],
  presentValues: Set<number>,
  colors: Map<number, number[]>,
  expandedGroups = new Set<string>(),
) {
  const element = document.createElement("div");
  const lists = new Map<string, HTMLElement>();
  for (const { value, label, group } of classes.filter((entry) => presentValues.has(entry.value))) {
    const color = colors.get(value)!;
    if (group && !lists.has(group)) {
      const section = groupSection(group, color, expandedGroups);
      lists.set(group, section.list);
      element.append(section.element);
    }
    (group ? lists.get(group)! : element).append(classRow(label, color));
  }
  // Without families the rows look like geology family headings, minus the expand arrow.
  if (lists.size === 0) element.className = "legend-class-list";
  return element;
}

function classRow(label: string, color: number[]) {
  const row = document.createElement("div");
  const name = document.createElement("span");
  name.textContent = label;
  row.append(legendSwatch(color), name);
  return row;
}

function legendSwatch(color: number[]) {
  const swatch = document.createElement("span");
  swatch.className = "legend-swatch";
  swatch.style.background = `rgb(${color.join(", ")})`;
  return swatch;
}

/**
 * A hatched swatch and label for in-area cells with no class, shown only when a scene has them.
 */
export function classNoDataLegend() {
  const row = document.createElement("div");
  const swatch = document.createElement("span");
  row.className = "legend-nodata";
  swatch.className = "legend-swatch legend-hatch";
  const name = document.createElement("span");
  name.textContent = "No data";
  row.append(swatch, name);
  return row;
}

/** A heading button, showing the colour of the group's first class, above its hidden list. */
function groupSection(group: string, color: number[], expandedGroups: Set<string>) {
  const element = document.createElement("div");
  element.className = "legend-group";
  const toggle = document.createElement("button");
  toggle.type = "button";
  toggle.className = "legend-group-toggle";
  const name = document.createElement("span");
  name.textContent = group;
  toggle.append(legendSwatch(color), name);
  const list = document.createElement("div");
  list.className = "legend-group-list";

  const show = () => {
    const isExpanded = expandedGroups.has(group);
    toggle.setAttribute("aria-expanded", String(isExpanded));
    list.hidden = !isExpanded;
  };
  toggle.addEventListener("click", () => {
    if (expandedGroups.has(group)) expandedGroups.delete(group);
    else expandedGroups.add(group);
    show();
  });
  show();
  element.append(toggle, list);
  return { element, list };
}
