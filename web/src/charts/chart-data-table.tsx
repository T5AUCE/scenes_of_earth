/** Render exact chart values separately from numeric SVG presentation. */
import type { ChartTable } from "./table";

/** Render the continuous table with exact values and its existing source-unit disclosure. */
export function chartTable(table: ChartTable, resolutionNote: string | null) {
  if (table.shape === "categorical_shares") return null;
  if (table.shape === "seasonal_cycle") return seasonalTable(table);
  if (table.shape === "distribution") return distributionTable(table, resolutionNote);

  return (
    <details className="chart-table">
      <summary>{"Table (exact values)"}</summary>
      <div className="chart-table-scroll">
        <p>{`Values use display units (${table.units}); CSV downloads use source units.`}</p>
        <table>
          <caption>{table.yTitle}</caption>
          <thead>
            <tr>
              <th scope="col">{table.xTitle}</th>
              <th scope="col">{table.yTitle}</th>
              <th scope="col">{"Valid share"}</th>
              <th scope="col">{"Fallback share"}</th>
            </tr>
          </thead>
          <tbody>
            {table.rows.map((row, index) => (
              <tr key={index}>
                <th scope="row">{row.label}</th>
                <td>{row.value === null ? "" : String(row.value)}</td>
                <td>{String(row.validFraction)}</td>
                <td>{row.fallbackFraction === null ? "" : String(row.fallbackFraction)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </details>
  );
}

function seasonalTable(table: Extract<ChartTable, { shape: "seasonal_cycle" }>) {
  return (
    <details className="chart-table">
      <summary>{"Table (exact values)"}</summary>
      <div className="chart-table-scroll">
        <p>{`Values use display units (${table.units}); CSV downloads use source units.`}</p>
        <table>
          <caption>{table.yTitle}</caption>
          <thead>
            <tr>
              <th scope="col">{table.xTitle}</th>
              <th scope="col">{table.yTitle}</th>
              <th scope="col">{"Valid share"}</th>
              <th scope="col">{"Fallback share"}</th>
              <th scope="col">{"Sample count"}</th>
              <th scope="col">{"Year range"}</th>
            </tr>
          </thead>
          <tbody>
            {table.rows.map((row, index) => (
              <tr key={index}>
                <th scope="row">{row.label}</th>
                <td>{row.value === null ? "" : String(row.value)}</td>
                <td>{String(row.validFraction)}</td>
                <td>{row.fallbackFraction === null ? "" : String(row.fallbackFraction)}</td>
                <td>{String(row.sampleCount)}</td>
                <td>{yearRangeText(row.yearRange)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </details>
  );
}

function yearRangeText(range: [number, number] | null) {
  if (!range) return "";

  return `${String(range[0])}-${String(range[1])}`;
}

function distributionTable(
  table: Extract<ChartTable, { shape: "distribution" }>,
  resolutionNote: string | null,
) {
  const note = resolutionNote ? ` (${resolutionNote})` : "";

  return (
    <details className="chart-table">
      <summary>{"Table (exact values)"}</summary>
      <div className="chart-table-scroll">
        <p>
          {`Mean ${String(table.mean)}, median ${String(table.median)}, `
            + `lowest cell ${String(table.min)}, highest cell ${String(table.max)}${note}. `
            + `Valid terrain covers ${String(table.validFraction * 100)}% of the outline. `
            + distributionReferences(table)}
        </p>
        <p>{`Values use display units (${table.units}); CSV downloads use source units.`}</p>
        <table>
          <caption>{table.yTitle}</caption>
          <thead>
            <tr>
              <th scope="col">{"Share of valid area below (%)"}</th>
              <th scope="col">{table.yTitle}</th>
              <th scope="col">{"Valid share"}</th>
              <th scope="col">{"Fallback share"}</th>
            </tr>
          </thead>
          <tbody>
            {table.rows.map((row, index) => (
              <tr key={index}>
                <th scope="row">{row.label}</th>
                <td>{String(row.value)}</td>
                <td>{String(row.validFraction)}</td>
                <td>{row.fallbackFraction === null ? "" : String(row.fallbackFraction)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </details>
  );
}

function distributionReferences(table: Extract<ChartTable, { shape: "distribution" }>) {
  if (table.referenceValues.length === 0) return "No sea-level reference was emitted.";
  const names = table.referenceValues.map(
    (reference) => `${reference.id} ${String(reference.value)}`,
  );

  return `References: ${names.join(", ")}.`;
}
