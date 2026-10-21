/** Render scene summaries and explain display choices with notices and source credits. */
import { makeHtmlElement } from "./html";
import {
  areaKm2,
  creditEntries,
  extraCreditLines,
  formatCellSize,
  noticeCount,
  type CreditEntry,
} from "./scene-info";
import { formatTime, scrubberTimes } from "./timeline";
import type { Scene } from "./types";

/** Id of the notices heading; the docked panel scrolls the About tab to it. */
export const NOTICES_HEADING_ID = "notices-heading";
const ISO_MINUTE_CHARS = 16; // "YYYY-MM-DDTHH:MM"
const WEB_LINK_PATTERN = /^https?:\/\//;

const BASEMAP_CREDIT = "Basemap: OpenFreeMap, © OpenMapTiles, data from OpenStreetMap.";
// The basemap is the only layer that is not part of the bundle, so its failure is stated here.
const NO_FALLBACK_NOTE =
  "If the basemap cannot load, no other basemap is substituted; the data layers still draw.";
const CLIPPED_NOTICE = "The area reaches beyond the data coverage and was clipped to it.";

const DISPLAY_LINES = [
  "One layer holds the map's colour at a time. The Colour row at the top of the layer cards names "
    + "it, while the other visible layers show the same data in a quieter way.",
  "Rainfall without colour becomes dots. Bigger dots mean more rain. Dots sit on the data grid, "
    + "and zooming in adds dots within each cell without adding data. The dot density slider "
    + "packs in more, smaller dots or fewer, larger ones.",
  "Temperature without colour becomes isotherms, the thin dashed lines that join places at the "
    + "same temperature. The legend names their interval and marks every fifth line more boldly.",
  "Land cover without colour keeps only the borders between classes, so the relief and any dots or "
    + "isotherms underneath stay readable.",
  "The blend draws rainfall and temperature at once, with rainfall setting how strong the green is "
    + "and temperature setting how warm it looks, so a wet warm place reads differently from a wet "
    + "cool one.",
  "A diagonal hatch marks cells inside the area that hold no value for the layer being shown, so a "
    + "gap is never taken for a low value.",
];

const SMOOTHING_LINES = [
  "Field layers show one colour block per cell by default. Smooth lets your graphics card blend "
    + "the colours of neighbouring cells (linear interpolation), so edges look softer. It blends "
    + "colours, not values, and it never adds data.",
  "Field cells without data are see-through, so smoothing fades the colour out at their edges "
    + "and at the border of the area instead of inventing values there.",
  "Land-cover Smooth draws edges smoothly from per-cell classes while keeping class colours "
    + "separate. Rounding can shrink small patches, but it adds no data. Edge softness blends "
    + "colours at their borders over a distance measured in grid cells, so the blend widens on "
    + "screen as you zoom in; 0 leaves a one-pixel anti-aliased border. Without WebGL drawing, "
    + "an image provides smooth edges at a fixed resolution instead.",
  "Terrain shading is drawn by your graphics card from Mapterhorn elevation tiles, so it gains "
    + "detail as you zoom in. It is a picture only; the values in the files do not come from it.",
  "Contour lines are drawn from elevation averaged into blocks of at most 1024 cells per side "
    + "and then smoothly interpolated, so they are close to the real relief but not exact at "
    + "very fine scale; zooming in recomputes them in finer blocks.",
  "The values in the files are the cell values of the stored grid, never the smoothed picture; "
    + "terrain may be stored in coarser cells than its 30 m or 90 m source. Bundles generated "
    + "with version 0.5.1 or later keep every cell touched by the area. Area averages give each "
    + "valid cell equal weight, including edge cells that extend outside the outline. Older "
    + "bundles use cell centres, with touched cells only when no centre lies inside the area.",
  "A hidden one-cell ring of real source data lets isotherms reach the outline but is excluded "
    + "from area averages.",
];

/** Summarise the scene's area and period with its layer count on one line. */
export function summaryText(scene: Scene) {
  const layerCount = scene.layers.length;
  return [
    areaText(scene),
    periodText(scene),
    `${layerCount} ${layerCount === 1 ? "layer" : "layers"}`,
  ].join(" · ");
}

function areaText(scene: Scene) {
  return `≈ ${Math.round(areaKm2(scene)).toLocaleString("en")} km²`;
}

function periodText(scene: Scene) {
  const axes = scene.layers.flatMap((layer) => (layer.time ? [layer.time] : []));
  if (!axes.length || !scene.period) return "no time axis";

  const timeValues = axes.map((axis) => axis.values);
  const times = scrubberTimes(timeValues, scene.period);
  const steps = axes.map((axis) => axis.step);
  const first = formatTime(times[0], steps);
  const last = formatTime(times[times.length - 1], steps);

  return first === last ? first : `${first} to ${last}`;
}

/** The credited source names on one line. */
export const creditsLine = (scene: Scene) =>
  creditEntries(scene).map((entry) => entry.name).join(" · ");

/** Render the About tab with scene metadata and explanations of the display. */
export function renderAbout(scene: Scene) {
  const root = makeHtmlElement("div");
  makeHtmlElement("h3", scene.title, root);

  root.append(
    definitionList([
      ["Area", scene.area.boundary?.name ?? "Drawn polygon"],
      ["Level", scene.area.boundary?.level ?? "custom"],
      ["Size", areaText(scene)],
      ["Period", periodText(scene)],
    ]),
  );

  makeHtmlElement("h4", "Layers", root);
  const layers = makeHtmlElement("ul", "", root);
  for (const layer of scene.layers) {
    const cell = formatCellSize(layer.grid.res);
    makeHtmlElement("li", `${layer.title} (${layer.units}) — ${cell} cells`, layers);
  }

  appendNotices(root, scene);
  appendDisplay(root);
  appendSmoothing(root);

  makeHtmlElement("h4", "Versions", root);
  root.append(definitionList(versionRows(scene)));

  return root;
}

function appendNotices(root: HTMLElement, scene: Scene) {
  if (!noticeCount(scene)) return;

  const heading = makeHtmlElement("h4", "Notices and limits", root);
  heading.id = NOTICES_HEADING_ID;
  const list = makeHtmlElement("ul", "", root);
  if (scene.area.clipped_to_coverage) makeHtmlElement("li", CLIPPED_NOTICE, list);
  for (const limit of scene.notices.limits) makeHtmlElement("li", limit, list);
}

function appendDisplay(root: HTMLElement) {
  makeHtmlElement("h4", "What the map draws", root);
  for (const line of DISPLAY_LINES) makeHtmlElement("p", line, root);
}

function appendSmoothing(root: HTMLElement) {
  makeHtmlElement("h4", "How the map is smoothed", root);
  for (const line of SMOOTHING_LINES) makeHtmlElement("p", line, root);
}

function versionRows(scene: Scene): [string, string][] {
  const built = new Date(scene.created).toISOString().slice(0, ISO_MINUTE_CHARS).replace("T", " ");

  const rows: [string, string][] = [
    ["Scenes of Earth", scene.generator.version],
    ["Bundle format", scene.version],
    ["Built", `${built} UTC`],
  ];
  for (const layer of scene.layers) {
    const { name, version } = layer.source;
    if (version) rows.push([name, version]);
  }
  return rows;
}

function definitionList(rows: [string, string][]) {
  const list = makeHtmlElement("dl");
  for (const [term, description] of rows) {
    makeHtmlElement("dt", term, list);
    makeHtmlElement("dd", description, list);
  }
  return list;
}

/** Render source credits and basemap attribution with the terms of use. */
export function renderCredits(scene: Scene) {
  const root = makeHtmlElement("div");

  for (const entry of creditEntries(scene)) root.append(creditCard(entry));

  const basemap = makeHtmlElement("section", "", root);
  makeHtmlElement("h4", "Basemap", basemap);
  makeHtmlElement("p", BASEMAP_CREDIT, basemap);
  makeHtmlElement("p", NO_FALLBACK_NOTE, basemap);

  const terms = makeHtmlElement("section", "", root);
  for (const line of extraCreditLines(scene)) makeHtmlElement("p", line, terms);

  makeHtmlElement("p", scene.credits.endorsement, terms);

  return root;
}

function creditCard(entry: CreditEntry) {
  const card = makeHtmlElement("section");
  makeHtmlElement("h4", entry.version ? `${entry.name} (${entry.version})` : entry.name, card);

  const licence = makeHtmlElement("p", "Licence: ", card);
  licence.append(entry.licence_url ? link(entry.licence, entry.licence_url) : entry.licence);

  for (const text of [entry.attribution, entry.citation]) {
    if (text) makeHtmlElement("p", text, card);
  }

  if (entry.modified) makeHtmlElement("p", `Changes: ${entry.modified}`, card);
  if (entry.disclaimer) makeHtmlElement("p", entry.disclaimer, card).className = "disclaimer";

  return card;
}

// The address comes from the bundle, so only web links become clickable.
function link(text: string, href: string) {
  if (!WEB_LINK_PATTERN.test(href)) return document.createTextNode(text);

  const anchor = makeHtmlElement("a", text);
  anchor.href = href;
  anchor.target = "_blank";
  anchor.rel = "noopener noreferrer";

  return anchor;
}
