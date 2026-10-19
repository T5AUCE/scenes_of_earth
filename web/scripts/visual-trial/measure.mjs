/** Pure helpers of the visual trial: geometry, area choice, response classes and result records. */

const MAX_LISTED_MESSAGES = 5;

/** Layer ids of the contour overlay; change them here if the overlay renames its layers. */
export const CONTOUR_LINE_PATTERN = /-contours-\d+$/;
export const CONTOUR_LABEL_PATTERN = /-contours-labels$/;

/**
 * The shortest distance from a point to any of the polylines, all in pixels.
 * Returns null when there are no segments.
 */
export function nearestPx(polylines, [pointX, pointY]) {
  let nearest = null;
  for (const line of polylines) {
    const points = line.length === 1 ? [line[0], line[0]] : line;
    for (let index = 1; index < points.length; index += 1) {
      const distance = distanceToSegment(points[index - 1], points[index], pointX, pointY);
      if (nearest === null || distance < nearest) nearest = distance;
    }
  }
  return nearest === null ? null : Math.round(nearest);
}

function distanceToSegment([startX, startY], [endX, endY], pointX, pointY) {
  const deltaX = endX - startX;
  const deltaY = endY - startY;
  const lengthSquared = deltaX ** 2 + deltaY ** 2;
  const along = lengthSquared
    ? ((pointX - startX) * deltaX + (pointY - startY) * deltaY) / lengthSquared
    : 0;
  const clamped = Math.max(0, Math.min(1, along));

  return Math.hypot(pointX - (startX + clamped * deltaX), pointY - (startY + clamped * deltaY));
}

/**
 * Chooses the area for a places-file entry. A text that equals a hit id wins, then a hit whose
 * name matches ignoring case, then the first hit. Returns null without hits.
 */
export function pickArea(hits, text) {
  const wanted = text.toLowerCase();
  return (
    hits.find((hit) => hit.id === text) ??
    hits.find((hit) => hit.name.toLowerCase() === wanted) ??
    hits[0] ??
    null
  );
}

/** Which counter a failed response belongs to, by URL. */
export function classifyFailure(url) {
  if (/tiles\.mapterhorn\.com/.test(url)) return "dem";
  if (/\/fonts\/|\.pbf$/.test(new URL(url).pathname)) return "glyph";
  return "other";
}

/** The zoom label used in result records: "fitted" or the number. */
export function zoomLabel(zoom) {
  return zoom === "fitted" ? "fitted" : String(zoom);
}

/** A file-name-safe slug for screenshots. */
export function slug(text) {
  return text.toLowerCase().replace(/[^a-z0-9.]+/g, "-").replace(/^-|-$/g, "");
}

/** The contour line from the legend text, if the legend shows one. */
export function contourLegend(text) {
  return /Contours every[^\n]*/.exec(text)?.[0] ?? null;
}

/** Whether two samples of a view are equal, which means the map has stopped changing. */
export function sameSample(first, second) {
  return Boolean(first) && JSON.stringify(first) === JSON.stringify(second);
}

/** Merges the page-side sample and the collected failures into one JSON-ready record. */
export function viewRecord({ spot, scene, zoom, sample, failures, messages, timedOut }) {
  const count = (kind) => failures.filter((failure) => failure.kind === kind).length;
  const unique = [...new Set(messages)];

  return {
    spot,
    scene,
    zoom: zoomLabel(zoom),
    zoom_actual: sample ? Number(sample.zoom.toFixed(2)) : null,
    label_features: sample?.labelCount ?? null,
    nearest_label_px: sample ? nearestPx(sample.labelLines, sample.centre) : null,
    line_features: sample?.lineCount ?? null,
    tiles_loaded: sample?.tilesLoaded ?? false,
    failed_requests: count("other"),
    dem_404: count("dem"),
    glyph_404: count("glyph"),
    errors: unique.length,
    error_samples: unique.slice(0, MAX_LISTED_MESSAGES),
    legend: sample?.legend ?? null,
    timed_out: timedOut,
  };
}
