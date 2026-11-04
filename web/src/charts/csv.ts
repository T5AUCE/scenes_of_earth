/** Build RFC 4180 CSV exports in source units with browser-only downloads. */
import { creditEntries, type CreditEntry } from "../scene-info";
import type { LayerDoc, Scene } from "../types";
import {
  buildDistributionTable,
  buildSeasonalCycle,
  buildTimeSeries,
  isDistributionLayer,
  isTimeSeriesLayer,
  unionIntervals,
} from "./series";

/** MIME type of CSV downloads so the browser treats the Blob as text. */
export const CSV_MIME = "text/csv;charset=utf-8";

/** The longest title slug kept in a filename so long titles stay usable. */
const MAX_SLUG_CHARS = 64;

/** A CSV file with its download name and RFC 4180 text. */
export interface CsvDocument {
  filename: string;
  content: string;
}

/**
 * Download a CSV file without any API or storage write. The anchor is removed and the
 * object URL revoked in the same task because the download has already started. Cleanup
 * runs in a finally block so a failed activation never leaks the anchor or URL.
 */
export function downloadCsv(filename: string, content: string): void {
  const blob = new Blob([content], { type: CSV_MIME });
  const url = URL.createObjectURL(blob);
  let anchor: HTMLAnchorElement | null = null;
  try {
    anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = filename;
    document.body.append(anchor);
    anchor.click();
  } finally {
    if (anchor) anchor.remove();
    URL.revokeObjectURL(url);
  }
}

/**
 * Build one area-means file for every time-varying layer over the union of distinct
 * period intervals. Headers name source units so a viewer unit switch never leaks in.
 */
export function buildAreaMeansCsv(scene: Scene): CsvDocument {
  const layers = (scene.layers ?? []).filter(isTimeSeriesLayer);

  return areaMeansFor(scene, layers);
}

/**
 * Build an area-means file for one close-up layer. Metadata still carries the complete
 * scene attribution while data columns cover only that layer.
 */
export function buildLayerAreaMeansCsv(scene: Scene, layer: LayerDoc): CsvDocument {
  return areaMeansFor(scene, [layer]);
}

/**
 * Build a by-month file from the same pure transformation the chart draws. Months with
 * no finite yearly mean stay empty with a zero sample count.
 */
export function buildByMonthCsv(scene: Scene, layer: LayerDoc): CsvDocument {
  const table = buildSeasonalCycle(layer);
  const includeFallback = layer.area_series?.fallback_fraction !== undefined;
  const header = [
    "month",
    "month_label",
    `${layer.id}_mean [${layer.units}]`,
    `${layer.id}_valid_fraction`,
  ];
  if (includeFallback) header.push(`${layer.id}_fallback_fraction`);
  header.push("sample_count", "year_start", "year_end");
  const rows = table.rows.map((row) => {
    const cells = [
      String(row.x),
      row.label,
      formatCsvValue(row.value),
      formatCsvValue(row.validFraction),
    ];
    if (includeFallback) cells.push(formatCsvValue(row.fallbackFraction));
    cells.push(
      String(row.sampleCount),
      row.yearRange ? String(row.yearRange[0]) : "",
      row.yearRange ? String(row.yearRange[1]) : "",
    );

    return cells;
  });
  const metadata = [
    ...baseMetadata(scene),
    `Export: by-month means for ${layer.id} in source units with sample counts and year ranges.`,
    "By month arithmetically averages finite yearly area means per calendar month "
      + "with no interpolation and no normal-period claim.",
  ];

  return { filename: byMonthFilename(scene, layer), content: csvDocument(metadata, header, rows) };
}

/**
 * Build an elevation file from stored quantiles without resampling them. Metadata keeps
 * the exact terrain summaries and any reference markers.
 */
export function buildElevationCsv(scene: Scene, layer: LayerDoc): CsvDocument {
  const table = buildDistributionTable(layer);
  const header = ["share_of_valid_area_below_pct", `elevation [${layer.units}]`];
  const rows = table.rows.map((row) => [String(row.x), formatCsvValue(row.value)]);
  const metadata = [...baseMetadata(scene), ...elevationNotes(layer, table)];

  return {
    filename: elevationFilename(scene, layer),
    content: csvDocument(metadata, header, rows),
  };
}

/**
 * Name an area-means file from the union range. Static-only exports have no intervals
 * so their names omit the absent dates.
 */
export function areaMeansFilename(scene: Scene, layers?: readonly LayerDoc[]): string {
  const slug = titleSlug(scene.title ?? "scene");
  const intervals = unionIntervals(layers ?? scene.layers ?? []);
  if (intervals.length === 0) return `${slug}_area-means.csv`;
  let latestEnd = intervals[0].end;
  for (const interval of intervals) {
    if (interval.end > latestEnd) latestEnd = interval.end;
  }
  const start = datePart(intervals[0].start);
  const end = datePart(latestEnd);

  return `${slug}_${start}_${end}_area-means.csv`;
}

/** Name a by-month file from its layer range so it stays distinct from area-means. */
export function byMonthFilename(scene: Scene, layer: LayerDoc): string {
  const slug = titleSlug(scene.title ?? "scene");
  const starts = layer.time?.values ?? [];
  const end = layer.time?.end;
  if (starts.length === 0 || !end) return `${slug}_by-month.csv`;

  return `${slug}_${datePart(starts[0])}_${datePart(end)}_by-month.csv`;
}

/**
 * Name an elevation file without dates because static layers have none. A scene with
 * several distribution layers adds the layer id so concurrent downloads stay distinct.
 */
export function elevationFilename(scene: Scene, layer: LayerDoc): string {
  const slug = titleSlug(scene.title ?? "scene");
  const distributions = (scene.layers ?? []).filter(isDistributionLayer);
  if (distributions.length > 1) return `${slug}_${layer.id}_elevation-distribution.csv`;

  return `${slug}_elevation-distribution.csv`;
}

/**
 * Escape one CSV cell. Quoted cells double their quotes because that is the only
 * escape the format allows.
 */
export function escapeCsvCell(cell: string): string {
  if (cell.includes('"') || cell.includes(",") || cell.includes("\r") || cell.includes("\n")) {
    return `"${cell.replaceAll('"', '""')}"`;
  }

  return cell;
}

/** Render an exact round-trip number while missing values stay empty. */
export function formatCsvValue(value: number | null | undefined): string {
  return typeof value === "number" && Number.isFinite(value) ? String(value) : "";
}

/** Slug a title for filenames by keeping only lowercase letters and digits. */
export function titleSlug(title: string): string {
  const slug = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, MAX_SLUG_CHARS);

  return slug || "scene";
}

function areaMeansFor(scene: Scene, layers: LayerDoc[]): CsvDocument {
  const intervals = unionIntervals(layers);
  const tables = new Map(layers.map((layer) => [layer.id, buildTimeSeries(layer)]));
  const header = ["period_start", "period_end"];
  for (const layer of layers) header.push(...areaColumnsFor(layer));
  const rows = intervals.map((interval) => {
    const cells = [interval.start, interval.end];
    for (const layer of layers) cells.push(...areaCellsFor(layer, tables, interval));

    return cells;
  });
  const names = layers.map((layer) => `${layer.id} in ${layer.units}`).join(", ");
  const metadata = [
    ...baseMetadata(scene),
    "Export: area means in source units over the union of distinct period intervals "
      + "with no common period invented for unlike layers.",
    "Missing values are empty and numbers keep full round-trip precision "
      + "with no locale formatting.",
    `Layers: ${names || "none"}.`,
  ];
  const content = csvDocument(metadata, header, rows);

  return { filename: areaMeansFilename(scene, layers), content };
}

function areaColumnsFor(layer: LayerDoc): string[] {
  const columns = [`${layer.id}_mean [${layer.units}]`, `${layer.id}_valid_fraction`];
  if (layer.area_series?.fallback_fraction !== undefined) {
    columns.push(`${layer.id}_fallback_fraction`);
  }

  return columns;
}

function areaCellsFor(
  layer: LayerDoc,
  tables: Map<string, ReturnType<typeof buildTimeSeries>>,
  interval: { start: string; end: string },
): string[] {
  const table = tables.get(layer.id);
  const row = table?.rows.find(
    (entry) => entry.interval.start === interval.start
      && entry.interval.end === interval.end,
  ) ?? null;
  if (!row) return areaColumnsFor(layer).map(() => "");
  const cells = [formatCsvValue(row.value), formatCsvValue(row.validFraction)];
  if (layer.area_series?.fallback_fraction !== undefined) {
    cells.push(formatCsvValue(row.fallbackFraction));
  }

  return cells;
}

function elevationNotes(
  layer: LayerDoc,
  table: ReturnType<typeof buildDistributionTable>,
): string[] {
  return [
    `Export: elevation distribution for ${layer.id} in source units.`,
    `Minimum elevation: ${String(table.min)} ${layer.units}.`,
    `Maximum elevation: ${String(table.max)} ${layer.units}.`,
    `Mean elevation: ${String(table.mean)} ${layer.units}.`,
    `Median elevation: ${String(table.median)} ${layer.units}.`,
    `Valid fraction: ${String(table.validFraction)}.`,
    gridLine(layer),
    ...referenceLines(layer, table),
    "Quantiles: the stored 1% samples approximate the curve between knots while the mean "
      + "comes from weighted cells directly.",
    "Shares describe valid area only; ocean and missing data are excluded.",
  ];
}

function gridLine(layer: LayerDoc): string {
  const res = layer.grid?.res;
  if (typeof res === "number" && Number.isFinite(res)) {
    return `Grid resolution: ${String(res)} degrees.`;
  }

  return "Grid resolution: not recorded for this layer.";
}

function referenceLines(
  layer: LayerDoc,
  table: ReturnType<typeof buildDistributionTable>,
): string[] {
  if (table.referenceValues.length === 0) {
    return ["Reference values: none were emitted for this layer."];
  }

  return table.referenceValues.map(
    (reference) => `Reference ${reference.id}: ${String(reference.value)} ${layer.units}.`,
  );
}

function baseMetadata(scene: Scene): string[] {
  return [
    `Scene: ${scene.title ?? "Untitled scene"} (${scene.id ?? "unknown id"}).`,
    periodLine(scene),
    ...((scene.layers ?? []).map(layerLine)),
    "Weights: area means weight each valid cell by its area inside the outline adjusted "
      + "for latitude (cell_area_inside_outline).",
    "Valid and fallback shares are weighted shares of the outlined area while the one-cell "
      + "support ring carries zero weight.",
    "Analysis grid: statistics describe the build analysis grid at its stored resolution and "
      + "cannot recover variation within one coarse cell.",
    ...sourceLines(scene),
    ...((scene.credits?.lines ?? []).map((line) => `Credit: ${line}`)),
    ...((scene.credits?.disclaimers ?? []).map((line) => `Disclaimer: ${line}`)),
    ...(scene.credits?.endorsement ? [`Endorsement: ${scene.credits.endorsement}`] : []),
    ...(scene.credits?.terms_passthrough ? [`Terms: ${scene.credits.terms_passthrough}`] : []),
  ];
}

function periodLine(scene: Scene): string {
  if (scene.period) {
    return `Period: ${scene.period.start} to ${scene.period.end} (${scene.period.step}).`;
  }

  return "Period: static scene with no time axis.";
}

function layerLine(layer: LayerDoc): string {
  const identity = `Layer ${layer.id} (${layer.title}): ${layer.units}`;
  if (layer.time) {
    const starts = layer.time.values ?? [];
    const range = starts.length > 0 ? ` from ${starts[0]} to ${layer.time.end}` : "";
    const method = layer.time.method ? ` (${layer.time.method})` : "";

    return `${identity}, ${layer.time.step}${range}${method}${gridPart(layer)}.`;
  }

  return `${identity}, static${gridPart(layer)}.`;
}

function gridPart(layer: LayerDoc): string {
  const res = layer.grid?.res;

  return typeof res === "number" && Number.isFinite(res) ? `, grid ${String(res)} degrees` : "";
}

function sourceLines(scene: Scene): string[] {
  if (!scene.area || !scene.layers) return [];

  return creditEntries(scene).map(describeSource);
}

function describeSource(entry: CreditEntry): string {
  const name = entry.name ?? "Unnamed source";
  const version = entry.version ? ` (${entry.version})` : "";
  const licence = entry.licence ? `licence ${entry.licence}` : "licence unspecified";
  const url = entry.licence_url ? ` (${entry.licence_url})` : "";
  const extra = [
    entry.attribution,
    entry.citation,
    entry.modified ? `Changes: ${entry.modified}` : null,
    entry.disclaimer,
  ].filter((part): part is string => typeof part === "string" && part.length > 0);

  return [`Source: ${name}${version}; ${licence}${url}`, ...extra].join("; ");
}

function datePart(value: string): string {
  return value.slice(0, 10);
}

/**
 * Join metadata, header and rows with CRLF. Every physical metadata line carries a hash
 * prefix so multiline credits stay comments on every line they occupy.
 */
function csvDocument(metadata: string[], header: string[], rows: string[][]): string {
  // Credits may use CRLF or bare CR so split on every newline form.
  const comments = metadata.flatMap(
    (line) => line.split(/\r\n|\r|\n/).map((physical) => `# ${physical}`),
  );
  const records = [header, ...rows].map((row) => row.map(escapeCsvCell).join(","));

  return [...comments, ...records].join("\r\n") + "\r\n";
}
