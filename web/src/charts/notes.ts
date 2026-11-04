/** One policy for the chart Notes that gallery previews hide and detail shows. */
import type { LayerDoc } from "../types";
import { hintFor } from "./definitions";
import type { ChartTable, ChartType } from "./table";
import { formatPresentationValue } from "./ticks";

/** Marks below this share draw hollow so gaps stay honest. */
const LOW_COVERAGE_FRACTION = 0.95;

/**
 * Collect every applicable note for a chart in display order. Numbers use the concise
 * presentation policy while the canonical table stays unchanged for tables and CSV.
 */
export function chartNotesFor(
  layer: LayerDoc,
  table: ChartTable,
  chartType: ChartType,
): string[] {
  if (table.shape === "categorical_shares") return [];
  const notes: string[] = [];
  const hint = hintFor(table.shape, chartType, layer.units, table.rows.length);
  if (hint) notes.push(hint);
  const seasonal = seasonalNoteFor(table);
  if (seasonal) notes.push(seasonal);
  const coverage = coverageNoteFor(table);
  if (coverage) notes.push(coverage);
  const fallback = fallbackNoteFor(layer, table);
  if (fallback) notes.push(fallback);

  return notes;
}

function seasonalNoteFor(table: ChartTable): string | null {
  if (table.shape !== "seasonal_cycle") return null;
  const counts = table.rows.map((row) => row.sampleCount);
  if (counts.length === 0) return null;
  const smallest = Math.min(...counts);
  const largest = Math.max(...counts);

  return `By month averages each available January together; `
    + `the Sample count column shows how many years contributed `
    + `(${String(smallest)}-${String(largest)}).`;
}

function coverageNoteFor(table: ChartTable): string | null {
  if (table.shape === "time_series" || table.shape === "seasonal_cycle") {
    const hollow = table.rows.some((row) => row.validFraction < LOW_COVERAGE_FRACTION);
    if (!hollow) return null;

    return "Hollow marks cover less than 95% of the outline.";
  }
  if (table.shape === "distribution") return distributionNoteFor(table);

  return null;
}

function distributionNoteFor(
  table: Extract<ChartTable, { shape: "distribution" }>,
): string {
  const valid = formatPresentationValue(table.validFraction * 100);
  const excluded = formatPresentationValue((1 - table.validFraction) * 100);
  const coverage = `Valid terrain covers ${valid}% of the outline; `
    + `the other ${excluded}% is ocean or missing data and is excluded. `
    + `The curve joins stored 1% quantiles, so values between knots are approximate, `
    + `while the mean comes from weighted cells directly.`;
  if (table.referenceValues.some((reference) => reference.id === "sea_level")) {
    return `${coverage} Sea level marks 0 m where the bundle emitted it because valid heights `
      + `span zero or the outline overlaps a coarse ocean tile.`;
  }

  return `${coverage} No sea-level reference was emitted for this bundle, which means neither `
    + `condition held and proves nothing about a coastline.`;
}

function fallbackNoteFor(layer: LayerDoc, table: ChartTable): string | null {
  if (table.shape === "categorical_shares") return null;
  const positive = table.rows.some(
    (row) => typeof row.fallbackFraction === "number" && row.fallbackFraction > 0,
  );
  if (!positive) return null;
  const names = (layer.fallback_sources ?? []).map((source) => source.name).filter(
    (name) => name.length > 0,
  );
  const named = names.length > 0 ? names.join(", ") : "the fallback source";

  return `Some periods include data filled from ${named}; shares are area-weighted fractions `
    + `of the outline, so check inspection or Table for each period's share.`;
}
