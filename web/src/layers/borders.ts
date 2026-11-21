/** Draw scene borders from the runs of area.geojson, so the line sits on the mask edge. */
import type { Map as MapLibreMap } from "maplibre-gl";

import { outlineCss, outlineWidthRamp, type OutlineState } from "../display-state";
import { polygonParts } from "../label-filter";
import { shiftLongitudes } from "../render/mercator";
import type { AreaFeature } from "../types";

/** The source holding every border run. */
export const BORDER_SOURCE_ID = "soe-border-runs";

/** The solid border line. */
export const BORDER_LINE_ID = "soe-border-line";

/** The disputed border line, drawn dashed over the same source. */
export const BORDER_DISPUTED_ID = "soe-border-disputed";

/** Every border layer, in the order they stack from bottom to top. */
export const BORDER_LAYER_IDS = [BORDER_LINE_ID, BORDER_DISPUTED_ID];

// The coast mask keeps only the half of a centred line inside the area, so double the width.
const BORDER_WIDTH_FACTOR = 2;
// Half of Liberty's [1, 2] keeps the dash length at twice the line width.
const DISPUTED_DASH_PATTERN = [0.5, 1];

const DISPUTED_FLAG = 1;

type Position = number[];
type Ring = Position[];

/** A border run as the bundle writes it, with both end vertices included. */
type BorderRun = [ring: number, first: number, last: number, disputed: number];

/** One sliced run before the longitude shift, with its source ring kept for joining. */
interface SlicedRun {
  ring: number;
  first: number;
  last: number;
  disputed: number;
  vertices: Ring;
}

export interface BorderLines {
  type: "FeatureCollection";
  features: {
    type: "Feature";
    properties: { disputed: number };
    geometry: { type: "LineString"; coordinates: Ring };
  }[];
}

/**
 * Cut the area's rings into lines for the border runs, moved by the same longitude shift as
 * the mask rings. A missing property means a plain cut, so the result is null and the viewer
 * keeps the area outline. An empty list means an island without land borders, so the result
 * holds no features while the coast stroke still outlines the shore. Runs of one kind that
 * meet at a ring's closing vertex become one line, so the round join covers the ring start.
 */
export function borderLines(feature: AreaFeature, shift: number): BorderLines | null {
  const runs = feature.properties?.border_runs as BorderRun[] | undefined;
  if (!Array.isArray(runs)) return null;

  // The bundle counts rings polygon by polygon, each exterior followed by its holes.
  const coordinates = feature.geometry.coordinates as number[][][] | number[][][][];
  const rings = polygonParts(feature.geometry.type, coordinates).flat();

  const slices = sliceRuns(runs, rings);

  const joined = joinClosingRuns(slices, rings);

  const features: BorderLines["features"] = joined.map((slice) => ({
    type: "Feature",
    properties: { disputed: slice.disputed },
    geometry: { type: "LineString", coordinates: shiftLongitudes(slice.vertices, shift) as Ring },
  }));

  return { type: "FeatureCollection", features };
}

/** Slice every run to its vertices, skipping runs that point outside their ring. */
function sliceRuns(runs: BorderRun[], rings: Ring[]): SlicedRun[] {
  const slices: SlicedRun[] = [];

  for (const [ring, first, last, disputed] of runs) {
    const vertices = rings[ring]?.slice(first, last + 1);
    if (!vertices || vertices.length < 2) continue;

    slices.push({ ring, first, last, disputed, vertices });
  }

  return slices;
}

/**
 * Join the two runs that meet at a ring's closing vertex when they share the same kind.
 * Only one run can start at zero and one can end at the last vertex, so each ring holds at
 * most one such pair and other runs keep their order.
 */
function joinClosingRuns(slices: SlicedRun[], rings: Ring[]): SlicedRun[] {
  const joined = [...slices];

  const ringIndexes = [...new Set(joined.map((slice) => slice.ring))];

  for (const ringIndex of ringIndexes) {
    const ringLength = rings[ringIndex]?.length ?? 0;
    if (ringLength < 2) continue;

    let startAt = -1;
    let endAt = -1;
    for (const [position, slice] of joined.entries()) {
      if (slice.ring !== ringIndex) continue;
      if (slice.first === 0 && slice.last === ringLength - 1) continue;

      if (slice.first === 0 && startAt < 0) startAt = position;
      if (slice.last === ringLength - 1 && endAt < 0) endAt = position;
    }
    if (startAt < 0 || endAt < 0 || startAt === endAt) continue;

    const start = joined[startAt];
    const end = joined[endAt];
    if (!start || !end) continue;
    if (start.disputed !== end.disputed) continue;

    // The closing vertex ends one slice and starts the other, so it is kept once.
    const vertices = [...end.vertices, ...start.vertices.slice(1)];
    const kept = Math.min(startAt, endAt);
    const removed = Math.max(startAt, endAt);
    joined[kept] = { ...start, first: end.first, vertices };
    joined.splice(removed, 1);
  }

  return joined;
}

/**
 * Add the solid and disputed border lines drawn from the runs, below beforeId. Runs of one
 * kind that meet at a ring's closing vertex arrive joined into one line, so the round join
 * covers the ring start.
 */
export function addBorders(
  map: MapLibreMap,
  lines: BorderLines,
  outline: OutlineState,
  beforeId: string | undefined,
): void {
  if (map.getSource(BORDER_SOURCE_ID)) {
    applyBorders(map, outline);
    return;
  }

  // A zero tolerance keeps every vertex, so the line stays on the mask edge at every zoom.
  map.addSource(BORDER_SOURCE_ID, { type: "geojson", data: lines as never, tolerance: 0 });
  map.addLayer(borderLayer(BORDER_LINE_ID, ["!=", ["get", "disputed"], DISPUTED_FLAG]), beforeId);
  map.addLayer(
    borderLayer(BORDER_DISPUTED_ID, ["==", ["get", "disputed"], DISPUTED_FLAG], {
      "line-dasharray": DISPUTED_DASH_PATTERN,
    }),
    beforeId,
  );
  applyBorders(map, outline);
}

function borderLayer(id: string, filter: unknown[], paint: Record<string, unknown> = {}) {
  return {
    id,
    type: "line",
    source: BORDER_SOURCE_ID,
    filter,
    layout: { "line-join": "round" },
    paint,
  } as Parameters<MapLibreMap["addLayer"]>[0];
}

/** Paint every mounted border line from the area outline's colour, width and visibility. */
export function applyBorders(map: MapLibreMap, outline: OutlineState): void {
  for (const id of BORDER_LAYER_IDS) {
    if (!map.getLayer(id)) continue;

    map.setLayoutProperty(id, "visibility", outline.shown ? "visible" : "none");
    map.setPaintProperty(id, "line-color", outlineCss(outline.color));
    map.setPaintProperty(id, "line-width", outlineWidthRamp(outline.widthPx, BORDER_WIDTH_FACTOR));
    map.setPaintProperty(id, "line-opacity", 1);
  }
}

/** Whether the border lines are mounted, which keeps the fallback outline hidden. */
export function bordersMounted(map: MapLibreMap): boolean {
  return BORDER_LAYER_IDS.some((id) => Boolean(map.getLayer(id)));
}

/** Remove the border lines and their source. */
export function removeBorders(map: MapLibreMap): void {
  for (const id of BORDER_LAYER_IDS) {
    if (map.getLayer(id)) map.removeLayer(id);
  }

  if (map.getSource(BORDER_SOURCE_ID)) map.removeSource(BORDER_SOURCE_ID);
}
