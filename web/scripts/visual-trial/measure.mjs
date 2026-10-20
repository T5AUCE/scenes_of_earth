/** Computes visual measurements and builds result records without browser dependencies. */

const MAX_LISTED_MESSAGES = 5;

/** Summarize positive rAF deltas in milliseconds using nearest-rank percentiles. */
export function frameStats(deltas) {
  const sorted = deltas.filter((delta) => Number.isFinite(delta) && delta > 0)
    .sort((first, second) => first - second);
  const percentile = (fraction) => {
    if (!sorted.length) return null;

    return Number(sorted[Math.ceil(sorted.length * fraction) - 1].toFixed(2));
  };
  return { frame_ms_p50: percentile(0.5), frame_ms_p95: percentile(0.95) };
}

/** Summarize the marks-layer pan deltas under the colour trial's field names. */
export function marksFrameStats(deltas) {
  const { frame_ms_p50, frame_ms_p95 } = frameStats(deltas);

  return { marks_frame_ms_p50: frame_ms_p50, marks_frame_ms_p95: frame_ms_p95 };
}

/** Matches contour overlay layer ids so unrelated map features are not counted. */
export const CONTOUR_LINE_PATTERN = /-contours-\d+$/;
export const CONTOUR_LABEL_PATTERN = /-contours-labels$/;

/**
 * Returns the shortest distance in pixels from a point to any polyline.
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
 * Chooses an area by exact id before trying a case-insensitive name or the first hit.
 * Returns null when there are no hits.
 */
export function pickArea(hits, text) {
  const wanted = text.toLowerCase();
  return (
    hits.find((hit) => hit.id === text)
    ?? hits.find((hit) => hit.name.toLowerCase() === wanted)
    ?? hits[0]
    ?? null
  );
}

/** Classifies failed requests by the resource named in their URL. */
export function classifyFailure(url) {
  if (/tiles\.mapterhorn\.com/.test(url)) return "dem";
  if (/\/fonts\/|\.pbf$/.test(new URL(url).pathname)) return "glyph";
  return "other";
}

/** Returns "fitted" or a numeric zoom as text for result records. */
export function zoomLabel(zoom) {
  return zoom === "fitted" ? "fitted" : String(zoom);
}

/** Makes a file-name-safe slug for screenshots. */
export function slug(text) {
  return text.toLowerCase().replace(/[^a-z0-9.]+/g, "-").replace(/^-|-$/g, "");
}

/** Extracts the contour legend line when one is present. */
export function contourLegend(text) {
  return /Contours every[^\n]*/.exec(text)?.[0] ?? null;
}

/** Compares view samples to detect changes between idle events. */
export function sameSample(first, second) {
  return Boolean(first) && JSON.stringify(first) === JSON.stringify(second);
}

/** Rejects idle samples until both the mask and requested layer data have initialized. */
export function isSettled(previous, sample, idle) {
  return idle && sample.sceneReady === true && sample.tilesLoaded && sameSample(previous, sample);
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
    legend_classes: sample?.classLabels ?? [],
    landcover_renderer: sample?.landcoverRenderer ?? null,
    colour_owner: sample?.colourOwner ?? null,
    draws: sample?.draws ?? {},
    ...frameStats(sample?.frameDeltas ?? []),
    ...marksFrameStats(sample?.marksFrameDeltas ?? []),
    gl_errors: sample?.glErrors ?? [],
    context_restored: sample?.contextRestored ?? null,
    display_checks: sample?.displayChecks ?? null,
    timed_out: timedOut,
  };
}
