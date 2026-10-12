import { makeHtmlElement } from "./html";
import {
  areaKm2,
  creditEntries,
  extraCreditLines,
  formatCellSize,
  noticeCount,
  type CreditEntry,
} from "./scene-info";
import { formatTime, unionTimes } from "./timeline";
import type { Scene } from "./types";

const BASEMAP_CREDIT = "Basemap: OpenFreeMap, © OpenMapTiles, data from OpenStreetMap.";
// The basemap is the only layer that is not part of the bundle, so its failure is stated here.
const NO_FALLBACK_NOTE =
  "If the basemap cannot load, no other basemap is substituted; the data layers still draw.";
// "YYYY-MM-DDTHH:MM" is the part of an ISO timestamp that is shown.
const ISO_MINUTE_LENGTH = 16;
const CLIPPED_NOTICE = "The area reaches beyond the data coverage and was clipped to it.";

const SMOOTHING_LINES = [
  "Each data cell is one colour block by default. The Smooth option lets your graphics card blend "
    + "the colours of neighbouring cells (linear interpolation), so edges look softer. It blends "
    + "colours, not values, and it never adds data.",
  "Cells without data are see-through, so smoothing fades the colour out at the edge of such a "
    + "cell and at the border of the area instead of inventing values there. The terrain shading "
    + "is always smoothed this way.",
  "Contour lines are drawn from elevation averaged into blocks of at most 1024 cells per side "
    + "and then smoothly interpolated, so they are close to the real relief but not exact at "
    + "very fine scale; zooming in recomputes them in finer blocks.",
  "The values in the files are the cell values of the stored grid, never the smoothed picture; "
    + "terrain may be stored in coarser cells than its 90 m source. Area averages use the raw "
    + "cells whose centre lies inside the outline. For a very small area with no cell centre "
    + "inside, every cell it touches is used and a notice says so.",
];

export function summaryText(scene: Scene) {
  const layerCount = scene.layers.length;

  return [
    areaText(scene),
    periodText(scene),
    `${layerCount} ${layerCount === 1 ? "layer" : "layers"}`,
  ].join(" · ");
}

export const creditsLine = (scene: Scene) =>
  creditEntries(scene).map((entry) => entry.name).join(" · ");

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
  appendSmoothing(root);

  makeHtmlElement("h4", "Versions", root);
  root.append(definitionList(versionRows(scene)));

  return root;
}

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

function areaText(scene: Scene) {
  return `≈ ${Math.round(areaKm2(scene)).toLocaleString("en")} km²`;
}

function periodText(scene: Scene) {
  const axes = scene.layers.flatMap((layer) => (layer.time ? [layer.time] : []));
  if (!axes.length) return "no time axis";

  const times = unionTimes(axes.map((axis) => axis.values));
  const steps = axes.map((axis) => axis.step);
  const first = formatTime(times[0], steps);
  const last = formatTime(times[times.length - 1], steps);

  return first === last ? first : `${first} to ${last}`;
}

function appendNotices(root: HTMLElement, scene: Scene) {
  if (!noticeCount(scene)) return;

  makeHtmlElement("h4", "Notices and limits", root);
  const list = makeHtmlElement("ul", "", root);

  if (scene.area.clipped_to_coverage) makeHtmlElement("li", CLIPPED_NOTICE, list);

  for (const limit of scene.notices.limits) makeHtmlElement("li", limit, list);
}

function appendSmoothing(root: HTMLElement) {
  makeHtmlElement("h4", "How the map is smoothed", root);

  for (const line of SMOOTHING_LINES) makeHtmlElement("p", line, root);
}

function versionRows(scene: Scene): [string, string][] {
  const built = new Date(scene.created).toISOString().slice(0, ISO_MINUTE_LENGTH).replace("T", " ");

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

function definitionList(rows: [string, string][]) {
  const list = makeHtmlElement("dl");

  for (const [term, description] of rows) {
    makeHtmlElement("dt", term, list);
    makeHtmlElement("dd", description, list);
  }

  return list;
}

// The address comes from the bundle, so only web links become clickable.
function link(text: string, href: string) {
  if (!/^https?:\/\//.test(href)) return document.createTextNode(text);

  const anchor = makeHtmlElement("a", text);
  anchor.href = href;
  anchor.target = "_blank";
  anchor.rel = "noopener noreferrer";

  return anchor;
}
