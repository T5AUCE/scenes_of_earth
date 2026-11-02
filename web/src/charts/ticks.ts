/** Derive axis domains, baselines and hints without rounding stored statistics. */
import { finiteValues, type ChartTable, type ChartType } from "./table";

/** Bars pile past this many points, so the editor suggests a line instead of switching. */
export const DENSITY_HINT_THRESHOLD = 60;

/** The fewest ticks an axis keeps, so a degenerate domain still shows its value. */
const MIN_TICK_COUNT = 2;

/** The baseline a chart type must include; lines float while bars and areas are anchored. */
export function baselineFor(chartType: ChartType, minValue: number | null) {
  if (chartType === "bar") return 0;
  if (chartType === "area") return minValue === null ? 0 : Math.min(0, minValue);

  return null;
}

/**
 * The automatic domain in canonical units, including the required baseline and a visible sea
 * level. Null means the table holds no finite value to show.
 */
export function autoDomain(
  table: ChartTable,
  chartType: ChartType,
  visibleReferences: readonly { id: string; value: number }[] = [],
): [number, number] | null {
  const values = [...finiteValues(table)];
  if (table.shape === "distribution") {
    values.push(table.min, table.max, table.mean, table.median);
    for (const reference of visibleReferences) values.push(reference.value);
    if (table.referenceValues.some((reference) => reference.id === "sea_level")) {
      values.push(0);
    }
  } else {
    for (const reference of visibleReferences) values.push(reference.value);
  }

  const finite = values.filter((value) => Number.isFinite(value));
  if (finite.length === 0) return null;

  let low = Math.min(...finite);
  let high = Math.max(...finite);
  const baseline = baselineFor(chartType, low);
  if (baseline !== null) {
    low = Math.min(low, baseline);
    high = Math.max(high, baseline);
  }

  return [low, high];
}

/** Whether an explicit range covers a value, endpoints included. */
export function domainIncludes(range: readonly [number, number], value: number) {
  return range[0] <= value && value <= range[1];
}

/**
 * Why an explicit y-range cannot be saved, or null when it is valid. Ranges live in canonical
 * source units and must stay finite, increasing and wide enough for every observed value plus
 * the baseline and visible references.
 */
export function validateYRange(
  range: unknown,
  table: ChartTable,
  chartType: ChartType,
  visibleReferences: readonly { id: string; value: number }[] = [],
): string | null {
  if (range === null || range === undefined) return null;
  if (!Array.isArray(range) || range.length !== 2) return "The y-range needs a low and high value.";

  const [low, high] = range;
  if (typeof low !== "number" || typeof high !== "number") {
    return "The y-range needs a low and high value.";
  }
  if (!Number.isFinite(low) || !Number.isFinite(high) || low >= high) {
    return "The y-range needs finite numbers with the low end below the high end.";
  }

  const observed = [...finiteValues(table)];
  if (table.shape === "distribution") {
    observed.push(table.min, table.max, table.mean, table.median);
  }
  const finiteObserved = observed.filter((value) => Number.isFinite(value));
  const baseline = baselineFor(
    chartType,
    finiteObserved.length ? Math.min(...finiteObserved) : null,
  );
  if (baseline !== null && !domainIncludes([low, high], baseline)) {
    return "The y-range must include its baseline at zero.";
  }
  for (const value of finiteObserved) {
    if (!domainIncludes([low, high], value)) {
      return "The y-range must include every observed value.";
    }
  }
  for (const reference of visibleReferences) {
    if (!domainIncludes([low, high], reference.value)) {
      return "The y-range must include its visible references.";
    }
  }

  return null;
}

/** Evenly spaced ticks including both domain ends, without rounding the stored precision. */
export function ticksForDomain(domain: readonly [number, number], count: number) {
  const safeCount = Math.max(MIN_TICK_COUNT, Math.floor(count));
  const [low, high] = domain;
  if (!(high > low)) return [low];

  return Array.from({ length: safeCount }, (_, index) =>
    low + ((high - low) * index) / (safeCount - 1),
  );
}

/** Suggest a line once bars would pile into a dense strip, without switching the type. */
export function densityHint(rowCount: number) {
  return rowCount > DENSITY_HINT_THRESHOLD
    ? "Many points crowd bars together; a line keeps the shape readable."
    : null;
}

/** Warn that a filled area of offset units depends on the chosen zero. */
export function offsetFillWarning(nativeUnits: string, chartType: ChartType) {
  return isOffsetUnits(nativeUnits) && chartType === "area"
    ? "Filled size depends on the chosen zero for these units."
    : null;
}

/** Whether units use an offset zero, so filled areas depend on that choice. */
export function isOffsetUnits(nativeUnits: string) {
  return nativeUnits === "°C" || nativeUnits === "°F";
}

/** Explain that distribution bars are quantile heights, not elevation-band frequencies. */
export function quantileBarHint(shape: string, chartType: ChartType) {
  return shape === "distribution" && chartType === "bar"
    ? "Bars show quantile heights, not how much area falls in each band."
    : null;
}
