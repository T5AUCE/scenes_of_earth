/** Fit chart axes to their tables while leaving room for edge bars at both ends of the x span. */
import { autoDomain } from "./ticks";
import type { ChartTable, ChartType } from "./table";

/** Half a month or percent slot keeps edge bars fully inside the plot. */
const BAR_HALF_SLOT = 0.5;

/** Choose an explicit y domain, or widen the values so a filled chart includes its baseline. */
export function domainFor(
  table: ChartTable,
  type: ChartType,
  references: readonly { id: string; value: number }[],
  convertedZero: number | null,
  explicit: [number, number] | null,
): [number, number] | null {
  if (explicit) return [explicit[0], explicit[1]];
  const valuesOnly = autoDomain(table, "line", references);
  if (!valuesOnly) return null;
  if (type === "line" || convertedZero === null) return valuesOnly;

  return [Math.min(valuesOnly[0], convertedZero), Math.max(valuesOnly[1], convertedZero)];
}

/** The x span of a chart, widened by half a slot on each side for bars. */
export function xSpan(
  table: ChartTable,
  override: [number, number] | null,
  type: ChartType,
): [number, number] {
  const base = baseSpan(table, override);
  const half = type === "bar" ? halfBarSlot(table) : null;
  if (half === null) return base;

  return [base[0] - half, base[1] + half];
}

function baseSpan(
  table: ChartTable,
  override: [number, number] | null,
): [number, number] {
  if (override) return override;
  if (table.shape === "seasonal_cycle") return [1, 12];
  if (table.shape === "distribution") return [0, 100];
  if (table.shape === "categorical_shares") return [0, 1];
  const values = table.rows.map((row) => row.x);
  if (values.length === 0) return [0, 1];
  const low = Math.min(...values);
  const high = Math.max(...values);
  if (!(high > low)) return [low - 1, low + 1];

  return [low, high];
}

function halfBarSlot(table: ChartTable): number | null {
  if (table.shape === "seasonal_cycle" || table.shape === "distribution") return BAR_HALF_SLOT;
  if (table.shape !== "time_series") return null;

  const sorted = table.rows.map((row) => row.x).sort((first, second) => first - second);
  const gaps = sorted.slice(1).map((x, index) => x - sorted[index]).filter((gap) => gap > 0);
  return gaps.length ? Math.min(...gaps) / 2 : null;
}
