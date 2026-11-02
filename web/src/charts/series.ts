/** Build time, calendar-month and distribution tables from stored statistics. */
import type { LayerDoc } from "../types";
import type {
  DistributionTable,
  SeasonalCycleTable,
  SeasonalRow,
  TimeSeriesTable,
} from "./table";

/** Monthly layers need two full years before By month stops looking like a normal. */
export const SEASONAL_MIN_STEPS = 24;

/** The P1M step that By month understands; other steps never offer a seasonal shape. */
export const MONTHLY_STEP = "P1M";

const JANUARY_INDEX = 1;

/** Positions of year and month inside an ISO period start such as 2019-01-01. */
const YEAR_START = 0;
const YEAR_END = 4;
const MONTH_START = 5;
const MONTH_END = 7;

/** Short month names for seasonal labels, in calendar order. */
export const MONTH_LABELS = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
];

/** Whether a layer carries per-step area means that a time chart can read. */
export function isTimeSeriesLayer(layer: LayerDoc) {
  return layer.time !== null && layer.time !== undefined && layer.area_series !== undefined;
}

/** Whether a layer carries weighted quantiles that a distribution chart can read. */
export function isDistributionLayer(layer: LayerDoc) {
  return layer.distribution !== undefined;
}

/**
 * Whether By month is available. Monthly steps with two full years average finite yearly means
 * per calendar month, so shorter or non-monthly series stay time-only.
 */
export function isSeasonalEligible(layer: LayerDoc) {
  return isTimeSeriesLayer(layer)
    && layer.time!.step === MONTHLY_STEP
    && layer.time!.values.length >= SEASONAL_MIN_STEPS;
}

/** The shapes a layer can offer, from its stored blocks rather than its renderer kind. */
export function shapesForLayer(layer: LayerDoc) {
  const shapes: ("time_series" | "seasonal_cycle" | "distribution")[] = [];
  if (isTimeSeriesLayer(layer)) shapes.push("time_series");
  if (isSeasonalEligible(layer)) shapes.push("seasonal_cycle");
  if (isDistributionLayer(layer)) shapes.push("distribution");

  return shapes;
}

/** Build a time table with the union of the layer's own intervals and null gaps preserved. */
export function buildTimeSeries(layer: LayerDoc): TimeSeriesTable {
  if (!isTimeSeriesLayer(layer)) {
    throw new Error(`${layer.title} has no area means over time.`);
  }

  const starts = layer.time!.values;
  const method = layer.time!.method;
  const series = layer.area_series!;
  const rows = starts.map((start, index) => {
    const end = index + 1 < starts.length ? starts[index + 1] : layer.time!.end;
    const value = series.values[index] ?? null;

    return {
      x: Date.parse(start),
      value: typeof value === "number" ? value : null,
      label: start,
      validFraction: series.valid_fraction[index] ?? 0,
      fallbackFraction: series.fallback_fraction?.[index] ?? null,
      interval: { start, end },
    };
  });

  return {
    shape: "time_series",
    layerId: layer.id,
    units: layer.units,
    method,
    rows,
    xTitle: "Time",
    yTitle: `${layer.title} (${layer.units})`,
  };
}

/**
 * Build twelve calendar-month rows by arithmetically averaging finite yearly means. Missing
 * months stay null with a zero sample count, so the table never invents a normal period.
 */
export function buildSeasonalCycle(layer: LayerDoc): SeasonalCycleTable {
  if (!isTimeSeriesLayer(layer)) {
    throw new Error(`${layer.title} has no area means over time.`);
  }
  if (layer.time!.step !== MONTHLY_STEP) {
    throw new Error(`${layer.title} is not monthly, so it has no calendar-month cycle.`);
  }

  const starts = layer.time!.values;
  const series = layer.area_series!;
  const hasFallback = series.fallback_fraction !== undefined;
  const rows = MONTH_LABELS.map((label, position) => {
    const month = position + JANUARY_INDEX;
    const contributing = starts.flatMap((start, index) => {
      if (monthOf(start) !== month) return [];
      const value = series.values[index];

      return typeof value === "number" && Number.isFinite(value)
        ? [{ index, value, year: yearOf(start) }]
        : [];
    });
    if (contributing.length === 0) {
      return {
        x: month,
        value: null,
        label,
        validFraction: 0,
        fallbackFraction: hasFallback ? 0 : null,
        sampleCount: 0,
        yearRange: null,
      } as SeasonalRow;
    }

    const values = contributing.map(({ value }) => value);
    const validShares = contributing.map(({ index }) => series.valid_fraction[index] ?? 0);
    const fallbackShares = hasFallback
      ? contributing.map(({ index }) => series.fallback_fraction![index] ?? 0)
      : [];
    const years = contributing.map(({ year }) => year);

    return {
      x: month,
      value: average(values),
      label,
      validFraction: average(validShares),
      fallbackFraction: hasFallback ? average(fallbackShares) : null,
      sampleCount: contributing.length,
      yearRange: [Math.min(...years), Math.max(...years)],
    } as SeasonalRow;
  });

  return {
    shape: "seasonal_cycle",
    layerId: layer.id,
    units: layer.units,
    method: layer.time!.method,
    rows,
    xTitle: "Month",
    yTitle: `${layer.title} by month (${layer.units})`,
  };
}

function monthOf(start: string) {
  return Number(start.slice(MONTH_START, MONTH_END));
}

function yearOf(start: string) {
  return Number(start.slice(YEAR_START, YEAR_END));
}

function average(values: number[]) {
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

/**
 * Build a distribution table from weighted quantiles without resampling them. Rows keep the
 * stored below-percent shares, while exact summaries stay separate for domains and references.
 */
export function buildDistributionTable(layer: LayerDoc): DistributionTable {
  if (!isDistributionLayer(layer)) {
    throw new Error(`${layer.title} has no distribution to chart.`);
  }

  const distribution = layer.distribution!;
  const median = typeof distribution.values[50] === "number"
    ? distribution.values[50]
    : distribution.mean;

  return {
    shape: "distribution",
    layerId: layer.id,
    units: layer.units,
    rows: distribution.values.map((value, index) => ({
      x: index,
      value,
      label: `${index}%`,
      validFraction: distribution.valid_fraction,
      fallbackFraction: null,
    })),
    xTitle: "Share of valid area below (%)",
    yTitle: `${layer.title} (${layer.units})`,
    validFraction: distribution.valid_fraction,
    mean: distribution.mean,
    median,
    min: distribution.min,
    max: distribution.max,
    referenceValues: distribution.reference_values.map((reference) => ({ ...reference })),
  };
}

/** The distinct period intervals of time-varying layers, sorted without inventing a common one. */
export function unionIntervals(layers: readonly LayerDoc[]) {
  const seen = new Map<string, { start: string; end: string }>();
  for (const layer of layers) {
    if (!isTimeSeriesLayer(layer)) continue;

    const starts = layer.time!.values;
    starts.forEach((start, index) => {
      const end = index + 1 < starts.length ? starts[index + 1] : layer.time!.end;
      const key = `${start}\n${end}`;
      if (!seen.has(key)) seen.set(key, { start, end });
    });
  }

  return [...seen.values()].sort((first, second) =>
    first.start < second.start
      ? -1
      : first.start > second.start
        ? 1
        : first.end < second.end
          ? -1
          : first.end > second.end
            ? 1
            : 0,
  );
}

/**
 * The row covering a union time, or null before the layer's first interval and after its last.
 * A later union step never borrows a future value from this layer.
 */
export function rowAtTime(table: TimeSeriesTable, time: string) {
  return table.rows.find((row) => time >= row.interval.start && time < row.interval.end) ?? null;
}
