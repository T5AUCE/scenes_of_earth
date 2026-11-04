/** Prepare time and seasonal tables for the shared SVG renderer. */
import { contourColor, fieldGradient, inkColor } from "../render/palettes";
import type { LayerDoc } from "../types";
import { convertValue, displayUnitFor } from "../units";
import type { ChartOptions } from "./definitions";
import { chartNotesFor } from "./notes";
import { paletteInkFor } from "./paint";
import { buildSeasonalCycle, buildTimeSeries, rowAtTime } from "./series";
import { SvgChart } from "./svg-chart";
import { toDisplayTable, type ChartType } from "./table";
import { convertedBaseline, displayRange, formatPresentationValue } from "./ticks";

/** Props of a time or seasonal chart; the table stays derived from the layer. */
export interface SeriesChartProps {
  layer: LayerDoc;
  shape: "time_series" | "seasonal_cycle";
  chartType: ChartType;
  options: ChartOptions;
  currentTime?: string | null;
  compact?: boolean;
  height_PX?: number;
  xDomain?: [number, number] | null;
  showTable?: boolean;
  showNotes?: boolean;
  viewerUnit?: string | null;
  effectivePalette?: string | null;
  effectiveInk?: string | null;
}

/**
 * Draw a time or seasonal chart with selected units, ink and options. The canonical table
 * never changes; conversions only affect the displayed copy.
 */
export function SeriesChart({
  layer,
  shape,
  chartType,
  options,
  currentTime = null,
  compact = false,
  height_PX,
  xDomain = null,
  showTable,
  showNotes = true,
  viewerUnit = null,
  effectivePalette = null,
  effectiveInk = null,
}: SeriesChartProps): React.ReactElement {
  const canonical = shape === "time_series"
    ? buildTimeSeries(layer)
    : buildSeasonalCycle(layer);
  const displayUnit = displayUnitFor(layer.units, options.displayUnit ?? viewerUnit);
  const converted = toDisplayTable(canonical, displayUnit, options.yTitle);
  const display = { ...converted, xTitle: options.xTitle ?? converted.xTitle };
  const notes = chartNotesFor(layer, canonical, chartType);
  const current = currentText(layer, shape, currentTime, displayUnit);
  const baseline = convertedBaseline(canonical, chartType, layer.units, displayUnit);

  return (
    <figure className="series-chart">
      <figcaption>{`${layer.title} · ${shapeLabel(shape)}${current}`}</figcaption>
      <SvgChart
        table={display}
        chartType={chartType}
        ink={seriesInkFor(layer, options.ink, effectivePalette, effectiveInk)}
        showGrid={options.showGrid ?? true}
        showPoints={options.showPoints ?? false}
        showCurrentTime={options.showCurrentTime ?? true}
        showReferences={options.showReferences ?? true}
        currentTime={currentTime}
        yRange={displayRange(options.yRange, layer.units, displayUnit)}
        xDomain={xDomain}
        height_PX={height_PX}
        compact={compact}
        showTable={showTable ?? !compact}
        showCoverageDetails={showNotes}
        fallbackNames={fallbackNamesFor(layer)}
        baseline={baseline}
      />
      {showNotes && notes.length > 0 && notesFor(notes)}
    </figure>
  );
}

function notesFor(notes: string[]): React.ReactElement {
  return (
    <div className="chart-notes">
      <h4 data-chart-notes-heading={true} tabIndex={-1}>{"Notes"}</h4>
      {notes.map((note, index) => <p key={index} className="chart-note">{note}</p>)}
    </div>
  );
}

function shapeLabel(shape: "time_series" | "seasonal_cycle") {
  return shape === "time_series" ? "Over time" : "By month";
}

function currentText(
  layer: LayerDoc,
  shape: "time_series" | "seasonal_cycle",
  currentTime: string | null,
  displayUnit: string,
) {
  if (!currentTime) return "";
  if (shape === "time_series") {
    const table = buildTimeSeries(layer);
    const row = rowAtTime(table, currentTime);
    if (!row || typeof row.value !== "number") return " · unavailable for current time";
    const presented = formatPresentationValue(convertValue(row.value, table.units, displayUnit));

    return ` · ${presented} ${displayUnit}`;
  }
  const table = buildSeasonalCycle(layer);
  const month = Number(currentTime.slice(5, 7));
  const row = table.rows.find((entry) => entry.x === month);
  if (!row || typeof row.value !== "number") return " · unavailable for current time";
  const presented = formatPresentationValue(convertValue(row.value, table.units, displayUnit));

  return ` · ${presented} ${displayUnit}`;
}

/** Palette-derived ink keeps series colours with the map until the viewer overrides them. */
export function seriesInkFor(
  layer: LayerDoc,
  ink: string | undefined,
  effectivePalette?: string | null,
  effectiveInk?: string | null,
) {
  if (ink !== undefined) return inkColor(ink) ?? "#1a3658";
  if (effectiveInk) return inkColor(effectiveInk) ?? "#1a3658";
  const palette = effectivePalette ?? layer.style.palette;
  if (palette) {
    const contour = contourColor(palette);
    if (contour) return contour;
    const gradient = fieldGradient(palette);
    if (gradient && gradient.length > 0) return paletteInkFor(gradient, "#1a3658");
  }

  return "#1a3658";
}

function fallbackNamesFor(layer: LayerDoc) {
  const names = (layer.fallback_sources ?? []).map((source) => source.name);

  return names.length ? names.join(", ") : null;
}
