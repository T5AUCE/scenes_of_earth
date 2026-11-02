/** Define chart tables separately from chart types, in canonical source units. */
import { convertValue } from "../units";

/** The chart types shipped in v1; later types such as pie remain unsupported. */
export type ChartType = "line" | "bar" | "area";

/** The reducers a chart can use; categorical shares stay reserved without builders. */
export type ChartShape =
  | "time_series"
  | "seasonal_cycle"
  | "distribution"
  | "categorical_shares";

/** One monthly or interval mean, with its coverage shares in outlined area. */
export interface TimeSeriesRow {
  x: number; // epoch milliseconds of the period start
  value: number | null;
  label: string; // period start as ISO date
  validFraction: number;
  fallbackFraction: number | null;
  interval: { start: string; end: string };
}

/** One calendar-month mean over its contributing years. */
export interface SeasonalRow {
  x: number; // month index from 1 for January to 12 for December
  value: number | null;
  label: string; // short month name
  validFraction: number;
  fallbackFraction: number | null;
  sampleCount: number; // contributing years with a finite mean
  yearRange: [number, number] | null;
}

/** One quantile height, with x as the share of valid area below it. */
export interface DistributionRow {
  x: number; // share below from 0 to 100, so hypsometry shows 100 minus x
  value: number;
  label: string;
  validFraction: number;
  fallbackFraction: number | null;
}

/** A reserved class share, without a builder in v1. */
export interface CategoricalRow {
  classId: string;
  fraction: number;
  label: string;
}

/** Monthly means over time, in canonical source units. */
export interface TimeSeriesTable {
  shape: "time_series";
  layerId: string;
  units: string;
  method: string | null;
  rows: TimeSeriesRow[];
  xTitle: string;
  yTitle: string;
}

/** Twelve calendar-month means, in canonical source units. */
export interface SeasonalCycleTable {
  shape: "seasonal_cycle";
  layerId: string;
  units: string;
  method: string | null;
  rows: SeasonalRow[];
  xTitle: string;
  yTitle: string;
}

/** Weighted quantiles of one static layer, in canonical source units. */
export interface DistributionTable {
  shape: "distribution";
  layerId: string;
  units: string;
  rows: DistributionRow[];
  xTitle: string;
  yTitle: string;
  validFraction: number;
  mean: number;
  median: number;
  min: number;
  max: number;
  referenceValues: { id: string; value: number }[];
}

/** Reserved class shares, without a builder in v1. */
export interface CategoricalSharesTable {
  shape: "categorical_shares";
  layerId: string;
  units: string;
  rows: CategoricalRow[];
  xTitle: string;
  yTitle: string;
}

/** Any chart table; continuous tables share numeric rows while categorical stays reserved. */
export type ChartTable =
  | TimeSeriesTable
  | SeasonalCycleTable
  | DistributionTable
  | CategoricalSharesTable;

/** Whether a value is one of the three shipped chart types. */
export function isChartType(value: unknown): value is ChartType {
  return value === "line" || value === "bar" || value === "area";
}

/** Whether a shape uses numeric continuous rows that v1 can draw. */
export function isContinuousShape(shape: ChartShape) {
  return shape === "time_series" || shape === "seasonal_cycle" || shape === "distribution";
}

/** The finite values of a table in canonical units, for domains and hints. */
export function finiteValues(table: ChartTable) {
  if (table.shape === "categorical_shares") return [];

  return table.rows
    .map((row) => row.value)
    .filter((value): value is number => typeof value === "number" && Number.isFinite(value));
}

/**
 * Convert a table for display without touching its canonical values. The copy keeps full
 * precision because conversions such as Celsius to Fahrenheit need the exact offset. An
 * explicit y-axis title stays verbatim because suffix text alone cannot tell a custom title
 * from a generated one, so generated titles relabel only when no override is given.
 */
export function toDisplayTable(
  table: ChartTable,
  displayUnit: string,
  explicitYTitle?: string,
): ChartTable {
  if (table.units === displayUnit) {
    if (explicitYTitle === undefined) return copyTable(table);

    return { ...copyTable(table), yTitle: explicitYTitle };
  }
  const yTitle = explicitYTitle ?? displayTitleFor(table.yTitle, table.units, displayUnit);
  if (table.shape === "time_series") {
    return {
      ...table,
      units: displayUnit,
      yTitle,
      rows: table.rows.map((row) => ({
        ...row,
        value: row.value === null ? null : convertValue(row.value, table.units, displayUnit),
        interval: { ...row.interval },
      })),
    };
  }
  if (table.shape === "seasonal_cycle") {
    return {
      ...table,
      units: displayUnit,
      yTitle,
      rows: table.rows.map((row) => ({
        ...row,
        value: row.value === null ? null : convertValue(row.value, table.units, displayUnit),
        yearRange: row.yearRange ? [...row.yearRange] as [number, number] : null,
      })),
    };
  }
  if (table.shape === "distribution") {
    const convert = (value: number) => convertValue(value, table.units, displayUnit);

    return {
      ...table,
      units: displayUnit,
      yTitle,
      rows: table.rows.map((row) => ({ ...row, value: convert(row.value) })),
      mean: convert(table.mean),
      median: convert(table.median),
      min: convert(table.min),
      max: convert(table.max),
      referenceValues: table.referenceValues.map((reference) => ({
        ...reference,
        value: convert(reference.value),
      })),
    };
  }

  return {
    ...table,
    units: displayUnit,
    yTitle,
    rows: table.rows.map((row) => ({ ...row })),
  };
}

function displayTitleFor(title: string, fromUnit: string, toUnit: string) {
  const suffix = `(${fromUnit})`;

  return title.endsWith(suffix) ? `${title.slice(0, -suffix.length)}(${toUnit})` : title;
}

function copyTable(table: ChartTable): ChartTable {
  if (table.shape === "time_series") {
    return { ...table, rows: table.rows.map((row) => ({ ...row, interval: { ...row.interval } })) };
  }

  if (table.shape === "seasonal_cycle") {
    return {
      ...table,
      rows: table.rows.map((row) => ({
        ...row,
        yearRange: row.yearRange ? [...row.yearRange] as [number, number] : null,
      })),
    };
  }

  if (table.shape === "distribution") {
    return {
      ...table,
      rows: table.rows.map((row) => ({ ...row })),
      referenceValues: table.referenceValues.map((reference) => ({ ...reference })),
    };
  }

  return { ...table, rows: table.rows.map((row) => ({ ...row })) };
}
