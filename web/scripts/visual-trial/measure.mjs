/** Computes visual measurements and builds result records without browser dependencies. */

const MAX_LISTED_MESSAGES = 5;

// The zoom sweep steps the camera by this much per frame, about 1.8 levels per second.
export const ZOOM_STEP = 0.03;
// The sweep starts half a level below the fitted zoom and climbs six levels above it.
export const ZOOM_START_OFFSET = -0.5;
export const ZOOM_END_OFFSET = 6;
// Bands are one zoom level wide, so +0 to +1 is the first full level of zooming in.
export const ZOOM_BAND_WIDTH = 1;
export const ZOOM_BAND_COUNT = 6;
// Frames over a 30 fps budget count as dropped zoom frames.
export const OVER_BUDGET_MS = 1000 / 30;

/** Matches contour overlay layer ids so unrelated map features are not counted. */
export const CONTOUR_LINE_PATTERN = /-contours-\d+$/;
export const CONTOUR_LABEL_PATTERN = /-contours-labels$/;

/** Summarise positive rAF deltas in milliseconds using nearest-rank percentiles. */
export function frameStats(deltas) {
  const sorted = deltas.filter((delta) => Number.isFinite(delta) && delta > 0)
    .sort((first, second) => first - second);
  const percentile = (fraction) => {
    if (!sorted.length) return null;

    return Number(sorted[Math.ceil(sorted.length * fraction) - 1].toFixed(2));
  };
  return { frame_ms_p50: percentile(0.5), frame_ms_p95: percentile(0.95) };
}

/** Summarise the marks-layer pan deltas under the colour trial's field names. */
export function marksFrameStats(deltas) {
  const { frame_ms_p50, frame_ms_p95 } = frameStats(deltas);

  return { marks_frame_ms_p50: frame_ms_p50, marks_frame_ms_p95: frame_ms_p95 };
}

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

/** Names the zoom band of a sweep frame, or "approach" below the fitted zoom. */
export function zoomBand(fittedZoom, zoom) {
  const offset = zoom - fittedZoom;
  if (offset < 0) return "approach";
  const band = Math.min(Math.floor(offset / ZOOM_BAND_WIDTH), ZOOM_BAND_COUNT - 1);
  return `+${band}-${band + 1}`;
}

/** Summarises positive values with nearest-rank percentiles, null when empty. */
export function zoomStats(values) {
  const sorted = values.filter((value) => Number.isFinite(value) && value > 0)
    .sort((first, second) => first - second);
  const percentile = (fraction) => {
    if (!sorted.length) return null;
    return Number(sorted[Math.ceil(sorted.length * fraction) - 1].toFixed(2));
  };
  return { p50: percentile(0.5), p95: percentile(0.95) };
}

/**
 * Bins one sweep into per-band frame numbers. Frames hold zoom, deltaMs, renderMs
 * and tilesLoaded; longtasks hold the zoom and durationMs of each task over 50 ms.
 * The opening frame has no delta and is skipped.
 */
export function summarizeZoomSweep({ frames, longtasks, fittedZoom }) {
  const bands = {};
  for (const frame of frames) {
    if (!(frame.deltaMs > 0)) continue;
    const band = zoomBand(fittedZoom, frame.zoom);
    const bucket = bands[band] ?? { deltas: [], renders: [], waiting: 0 };
    bands[band] = bucket;
    bucket.deltas.push(frame.deltaMs);
    bucket.renders.push(frame.renderMs);
    if (!frame.tilesLoaded) bucket.waiting += 1;
  }
  for (const task of longtasks ?? []) {
    const band = zoomBand(fittedZoom, task.zoom);
    const bucket = bands[band] ?? { deltas: [], renders: [], waiting: 0 };
    bands[band] = bucket;
    bucket.taskMs = [...(bucket.taskMs ?? []), task.durationMs];
  }
  const records = {};
  for (const [band, bucket] of Object.entries(bands)) {
    const deltas = zoomStats(bucket.deltas);
    const renders = zoomStats(bucket.renders);
    const taskMs = (bucket.taskMs ?? []).reduce((sum, value) => sum + value, 0);
    records[band] = {
      frames: bucket.deltas.length,
      frame_ms_p50: deltas.p50,
      frame_ms_p95: deltas.p95,
      over_33ms: bucket.deltas.filter((delta) => delta > OVER_BUDGET_MS).length,
      render_ms_p50: renders.p50,
      render_ms_p95: renders.p95,
      waiting_frames: bucket.waiting,
      longtasks: (bucket.taskMs ?? []).length,
      longtask_ms_total: Number(taskMs.toFixed(2)),
    };
  }
  return records;
}

/** Takes the median of each band number across repeats, ignoring missing bands. */
export function medianZoomBands(repeats) {
  const bands = {};
  for (const summary of repeats) {
    for (const [band, stats] of Object.entries(summary)) {
      const bucket = bands[band] ?? {};
      bands[band] = bucket;
      for (const [key, value] of Object.entries(stats)) {
        if (value !== null) bucket[key] = [...(bucket[key] ?? []), value];
      }
    }
  }
  const medians = {};
  for (const [band, bucket] of Object.entries(bands)) {
    medians[band] = {};
    for (const [key, values] of Object.entries(bucket)) {
      medians[band][key] = median(values);
    }
  }
  return medians;
}

function median(values) {
  const sorted = [...values].sort((first, second) => first - second);
  const middle = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) return sorted[middle];
  return Number(((sorted[middle - 1] + sorted[middle]) / 2).toFixed(2));
}

/**
 * Subtracts baseline band numbers from a variant's, so the trial reports deltas
 * between variants rather than absolute milliseconds. Null stays null.
 */
export function deltaZoomBands(baseline, variant) {
  const deltas = {};
  for (const [band, stats] of Object.entries(variant)) {
    const base = baseline[band];
    if (!base) continue;
    deltas[band] = {};
    for (const [key, value] of Object.entries(stats)) {
      const other = base[key];
      deltas[band][`${key}_delta`] = value === null || other === null
        ? null
        : Number((value - other).toFixed(2));
    }
  }
  return deltas;
}

/** Builds one JSON-ready record per zoom band for a sweep variant. */
export function zoomBandRecord({ spot, scene, variant, band, stats, deltas, requests, repeats }) {
  return {
    mode: "zoom",
    spot,
    scene,
    variant,
    band,
    repeats,
    requests_during_sweep: requests,
    ...stats,
    ...(deltas ?? {}),
  };
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

/** Rejects idle samples until both the mask and requested layer data have initialised. */
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
    ...frameStats(sample?.frameDeltas ?? []),
    ...marksFrameStats(sample?.marksFrameDeltas ?? []),
    gl_errors: sample?.glErrors ?? [],
    context_restored: sample?.contextRestored ?? null,
    display_checks: sample?.displayChecks ?? null,
    timed_out: timedOut,
  };
}
