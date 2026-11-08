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
import { formatArea, formatLength } from "./units";
import type { Scene } from "./types";

/** Id of the notices heading; the docked panel scrolls the About tab to it. */
export const NOTICES_HEADING_ID = "notices-heading";
const WEB_LINK_PATTERN = /^https?:\/\//;

const BASEMAP_CREDIT = "Basemap: OpenFreeMap, © OpenMapTiles, data from OpenStreetMap.";
// The basemap is the only layer that is not part of the bundle, so its failure is stated here.
const NO_FALLBACK_NOTE =
  "If the basemap cannot load, no other basemap is substituted; the data layers still draw.";
const CLIPPED_NOTICE = "Some layers cover only part of the area; their notices say which.";
const GLIM_DISPLAY_LINE =
  "The Rock type layer comes from the Global Lithological Map (GLiM) at about 1:3.75 million, so "
  + "boundaries are approximate at local scale and seams can show where its 92 source maps meet.";
const OPENLANDMAP_DISPLAY_LINE =
  "The Rock type layer comes from a global map at about 1:3.75 million (OpenLandMap, from "
  + "GLiM), so boundaries are approximate at local scale and seams can show where national "
  + "source maps meet and at 180° longitude.";

const GEOLOGY_AGE_DISPLAY_LINE =
  "The Geological age layer comes from the Geological Survey of Canada world geology map, the "
  + "worldwide fallback, at about 1:35 million, so boundaries are approximate by tens of "
  + "kilometres. About a third of the mapped area is dated only to an era or wider, and ages are "
  + "generalised to ICS periods: each colour is the smallest period or era that holds the whole "
  + "age range of its unit. Colours follow the ICS chart.";

const GEOLOGY_WATER_LINE =
  "Geology is drawn under the map's water and stretched up to about 2 km, or one scene cell "
  + "where cells are larger, into small coastal gaps for display only.";

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

/** Summarise the scene's area and period with its layer count on one line. */
export function summaryText(scene: Scene, elevationUnit = "m") {
  const layerCount = scene.layers.length;
  return [
    areaText(scene, elevationUnit),
    periodText(scene),
    `${layerCount} ${layerCount === 1 ? "layer" : "layers"}`,
  ].join(" · ");
}

function areaText(scene: Scene, elevationUnit = "m") {
  return `≈ ${formatArea(areaKm2(scene), elevationUnit)}`;
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
export function renderAbout(
  scene: Scene,
  elevationUnit = "m",
  displayUnits: Record<string, string> = {},
) {
  const root = makeHtmlElement("div");
  makeHtmlElement("h3", scene.title, root);

  root.append(
    definitionList([
      ["Area", scene.area.boundary?.name ?? "Drawn polygon"],
      ["Level", scene.area.boundary?.level ?? "custom"],
      ["Size", areaText(scene, elevationUnit)],
      ["Period", periodText(scene)],
    ]),
  );

  makeHtmlElement("h4", "Layers", root);
  const layers = makeHtmlElement("ul", "", root);
  for (const layer of scene.layers) {
    const units = displayUnits[layer.id] ?? layer.units;
    const cell = formatCellSize(layer.grid.res, elevationUnit);
    makeHtmlElement("li", `${layer.title} (${units}) — ${cell} cells`, layers);
  }

  appendNotices(root, scene);
  appendDisplay(root, scene);
  appendSmoothing(root, elevationUnit);

  makeHtmlElement("h4", "Versions", root);
  root.append(definitionList(versionRows(scene)));

  return root;
}

function appendNotices(root: HTMLElement, scene: Scene) {
  if (!noticeCount(scene)) return;

  const heading = makeHtmlElement("h4", "Notices and Limits", root);
  heading.id = NOTICES_HEADING_ID;
  const list = makeHtmlElement("ul", "", root);
  if (scene.area.clipped_to_coverage) makeHtmlElement("li", CLIPPED_NOTICE, list);
  for (const limit of scene.notices.limits) makeHtmlElement("li", limit, list);
}

function appendDisplay(root: HTMLElement, scene: Scene) {
  makeHtmlElement("h4", "What the Map Draws", root);
  for (const line of DISPLAY_LINES) makeHtmlElement("p", line, root);
  const geology = scene.layers.find((layer) => layer.id === "geology");
  if (geology) {
    const isGlim = geology.source.name.startsWith("GLiM");
    makeHtmlElement("p", isGlim ? GLIM_DISPLAY_LINE : OPENLANDMAP_DISPLAY_LINE, root);
  }
  if (scene.layers.some((layer) => layer.id === "geology_age")) {
    makeHtmlElement("p", GEOLOGY_AGE_DISPLAY_LINE, root);
  }
  if (scene.layers.some((layer) => layer.id === "geology" || layer.id === "geology_age")) {
    makeHtmlElement("p", GEOLOGY_WATER_LINE, root);
  }
}

function appendSmoothing(root: HTMLElement, elevationUnit = "m") {
  makeHtmlElement("h4", "How the Map Is Smoothed", root);
  for (const line of smoothingLines(elevationUnit)) makeHtmlElement("p", line, root);
}

function smoothingLines(elevationUnit: string) {
  // The source resolutions stay readable because they use the scene's length choice.
  const fine = formatLength(30, elevationUnit);
  const coarse = formatLength(90, elevationUnit);
  const storage = `The values in the files are the cell values of the stored grid, `
    + `never the smoothed picture; terrain statistics may come from coarser cells `
    + `than their ${fine} or ${coarse} source. Bundles keep every cell touched by the area.`;
  const weighting = `Area means weight each valid cell by its area inside the outline, `
    + `adjusted for latitude, so partly covered edge cells count only partly. `
    + `The valid share is the weighted share of the outline with data and the fallback share `
    + `is the weighted share filled from a credited fallback, while the one-cell support ring `
    + `around the area carries zero weight. The shares describe the build analysis grid at its `
    + `stored resolution and cannot recover variation within one coarse cell.`;
  const terrain = `Terrain summaries and the distribution are weighted reductions of the stored `
    + `analysis grid at its stored resolution, never a summit survey or the live display tiles. `
    + `The stored 1% quantiles approximate the curve between knots, while the mean comes from `
    + `the weighted cells directly.`;

  return [
    "Field layers show one colour block per cell by default. Smooth lets your graphics card blend "
      + "the colours of neighbouring cells (linear interpolation), so edges look softer. It blends "
      + "colours, not values, and it never adds data.",
    "Field cells without data are see-through, so smoothing fades the colour out at their edges "
      + "and at the border of the area instead of inventing values there.",
    "Land-cover Smooth draws edges smoothly from per-cell classes while keeping class colours "
      + "separate. Smoothing can shrink small patches, but it adds no data. Softness blends "
      + "colours at their borders over a distance measured in grid cells, so the blend widens on "
      + "screen as you zoom in; 0 leaves a one-pixel anti-aliased border. Without WebGL drawing, "
      + "an image provides smooth edges at a fixed resolution instead.",
    "On Rock Type and Geological Age, Smoothing is measured in grid cells and looks beyond "
      + "the nearby cells, so long staircases become smooth curves, and larger values cut "
      + "corners further while small patches may shrink.",
    "Terrain shading is a live picture drawn by your graphics card from Mapterhorn elevation "
      + "tiles, so it gains detail as you zoom in and may show finer relief than the stored "
      + "summaries.",
    "Contour lines are traced from the same live elevation tiles, with height steps chosen from "
      + "the stored terrain statistics for readability, so they may show different detail than "
      + "the summaries.",
    storage,
    weighting,
    terrain,
    "A hidden one-cell ring of real source data lets isotherms reach the outline but carries "
      + "zero weight in the statistics.",
  ];
}

function versionRows(scene: Scene): [string, string][] {
  const rows: [string, string][] = [
    ["Scenes of Earth", scene.generator.version],
    ["Bundle format", scene.version],
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
