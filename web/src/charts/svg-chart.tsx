/** Render chart tables as accessible SVG without changing their stored values. */
import { useEffect, useMemo, useState } from "react";

import { chartPaintFor } from "./paint";
import { autoDomain, formatPresentationValue, ticksForDomain } from "./ticks";
import { finiteValues, type ChartTable, type ChartType } from "./table";
import { useElementWidth } from "./use-element-width";

/** Base heights keep chip, series and distribution previews consistent. */
export const CHIP_HEIGHT_PX = 36;
export const SERIES_HEIGHT_PX = 140;
export const DISTRIBUTION_HEIGHT_PX = 180;

/** Coverage below this share draws hollow marks so gaps stay honest. */
export const LOW_COVERAGE_FRACTION = 0.95;

/** The axes keep a margin for ticks and titles inside the measured width. */
const MARGIN_LEFT_PX = 48;
const MARGIN_RIGHT_PX = 24;
const MARGIN_TOP_PX = 20;
const MARGIN_BOTTOM_PX = 36;

/** Wrapped x titles grow downward so narrow cards keep every word inside the svg. */
const X_TITLE_LINE_HEIGHT_PX = 12;
const X_TICK_OFFSET_PX = 16;
const X_TITLE_OFFSET_PX = 32;

/** Titles average wider than tabular digits, so narrow cards wrap them earlier. */
const TITLE_ESTIMATED_CHAR_PX = 7;

/** The rotated title keeps its own gutter so tick labels never enter it. */
const TITLE_GUTTER_PX = 20;
const TICK_GAP_PX = 4;
const MAX_LEFT_GUTTER_PX = 120;

/** Conservative glyph widths keep tick estimates inside the gutter at 11px. */
const ESTIMATED_CHAR_PX = 6;
const MAX_TICK_LABEL_CHARS = 12;

/** Presentation labels stay short enough for the gutter while keeping distinct values. */
const FALLBACK_TICK_DECIMALS = 2;
const PRESENTATION_TICK_MAX_DECIMALS = 3;
const WHOLE_STEP_THRESHOLD = 1;
const DECIMAL_GUARD_DIGITS = 1;
const MIN_EXPONENT_MANTISSA_DIGITS = 2;
const MAX_EXPONENT_MANTISSA_DIGITS = 6;
const OFFSET_RELATIVE_SPAN_THRESHOLD = 0.001;
const MAX_FIXED_DECIMALS = 20;
const MIN_SCALE_EXPONENT = -300;
const MAX_SCALE_EXPONENT = 300;

/** The offset disclosure sits in the top margin so the rotated title stays short. */
const OFFSET_DISCLOSURE_Y_PX = 12;
const DISCLOSURE_CLEAR_Y_PX = 28;
const DISCLOSURE_LINE_HEIGHT_PX = 12;

/** Reference labels stagger when values sit closer than this many pixels. */
const REFERENCE_STAGGER_PX = 12;

/** Annotation labels start slightly above their line and search both ways for a free lane. */
const ANNOTATION_OFFSET_PX = -4;
const ENDPOINT_OFFSET_PX = -6;
const STAGGER_LIMIT_PX = 60;

/** Annotation labels stay inside the plot frame. */
const MIN_ANNOTATION_Y_PX = 12;
const MIN_ANNOTATION_X_PX = 24;
const BOTTOM_ANNOTATION_MARGIN_PX = 4;
/** Text extends above and below its baseline, so lanes keep that clearance. */
const ANNOTATION_ASCENT_PX = 9;
const ANNOTATION_DESCENT_PX = 4;
/** The fallback scan steps one pixel so a free lane is found when one exists. */
const SCAN_STEP_PX = 1;

/** A cursor mark stays visible even for a single finite value. */
const POINT_RADIUS_PX = 3;
const SINGLE_RADIUS_PX = 4;
const HOLLOW_WIDTH_PX = 1.5;
const BAR_MIN_HEIGHT_PX = 1;

/** Half a month or percent slot keeps edge bars fully inside the plot. */
const BAR_HALF_SLOT = 0.5;

/** A dark edge keeps a light mark visible without rewriting its stored ink. */
const CONTRAST_OUTLINE_PX = 1.5;
const LIGHT_LINE_UNDER_PX = 4;
const LIGHT_COMPACT_LINE_UNDER_PX = 3;
const AREA_EDGE_PX = 2;

/** Time labels keep a gap so neighbouring dates never touch at gallery widths. */
const TIME_LABEL_GAP_PX = 8;

/** Visible grid resolutions use concise values while exact notes stay in titles and tables. */
const FULL_GRID_SUFFIX = "° analysis grid";
const SHORT_GRID_SUFFIX = "° grid";

/** Props of the shared renderer; wrappers convert units and resolve ink first. */
export interface SvgChartProps {
  table: ChartTable;
  chartType: ChartType;
  ink?: string;
  showGrid?: boolean;
  showPoints?: boolean;
  showCurrentTime?: boolean;
  showReferences?: boolean;
  currentTime?: string | null;
  yRange?: [number, number] | null;
  xDomain?: [number, number] | null;
  height_PX?: number;
  compact?: boolean;
  showTable?: boolean;
  showCoverageDetails?: boolean;
  fallbackNames?: string | null;
  resolutionNote?: string | null;
  resolutionValue?: number | null;
  baseline?: number | null;
}

/**
 * Draw any continuous table as line, bar or area without changing its rows. Nulls break lines
 * and areas while zero stays valid, so gaps never read as low values.
 */
export function SvgChart({
  table,
  chartType,
  ink,
  showGrid = true,
  showPoints = false,
  showCurrentTime = true,
  showReferences = true,
  currentTime = null,
  yRange = null,
  xDomain = null,
  height_PX,
  compact = false,
  showTable = true,
  showCoverageDetails = true,
  fallbackNames = null,
  resolutionNote = null,
  resolutionValue = null,
  baseline = null,
}: SvgChartProps): React.ReactElement {
  const [ref, width] = useElementWidth();
  const [cursor, setCursor] = useState<number | null>(null);
  const paint = ink ?? "var(--chart-ink, #1a3658)";
  const height = height_PX ?? heightFor(table, compact);
  const type = effectiveType(table, chartType);
  const convertedZero = convertedBaseline(table, type, baseline);
  const references = useMemo(
    () => visibleReferences(table, showReferences && !compact),
    [table, showReferences, compact],
  );
  const domain = domainFor(table, type, references, convertedZero, yRange);
  const span = xSpan(table, xDomain, type);
  const rowTotal = table.rows.length;
  useEffect(() => {
    setCursor(null);
  }, [table.shape, table.layerId]);
  useEffect(() => {
    if (cursor !== null && cursor >= rowTotal) {
      setCursor(rowTotal > 0 ? rowTotal - 1 : null);
    }
  }, [rowTotal, cursor]);
  const currentIndex = initialCursor(table, currentTime, showCurrentTime);
  const inspection = cursor;
  const tooltip = tooltipFor(
    table,
    inspection,
    currentIndex,
    currentTime,
    showCurrentTime,
    fallbackNames,
    showCoverageDetails,
  );
  const hasDomain = domain !== null;
  const rawTicks = hasDomain ? ticksForDomain(domain!, 4) : [];
  const ticks = dedupeNumericTicks(rawTicks);
  const plan = hasDomain ? tickLabelsFor(domain!, ticks) : null;
  const left = leftGutterFor(plan?.labels ?? [], compact);
  const disclosure = disclosureLinesFor(plan, width, left, compact);
  const showTitles = !compact && table.shape !== "categorical_shares";
  const plotWidth = plotWidthFor(width, left, compact);
  const xTitleLines = showTitles ? xTitleLinesFor(table.xTitle, plotWidth) : [];
  const geometry = chartGeometry(
    compact,
    width,
    height,
    domain ?? [0, 1],
    span,
    left,
    disclosure?.length ?? 0,
    xTitleLines.length,
  );

  return (
    <div ref={ref} className="svg-chart">
      <svg
        width={Math.max(1, Math.round(width))}
        height={height}
        viewBox={`0 0 ${Math.max(1, Math.round(width))} ${height}`}
        role="img"
        aria-label={summaryFor(table, chartType)}
        tabIndex={0}
        onKeyDown={(event) => {
          const next = moveCursor(event.key, table, cursor);
          if (next !== null) {
            event.preventDefault();
            setCursor(next);
          }
        }}
      >
        <title>{summaryFor(table, chartType)}</title>
        {hasDomain ? (
          <>
            {!compact && plotFrame(geometry)}
            {showGrid && !compact && gridLines(ticks, geometry)}
            {!compact && plan && yTicks(ticks, plan, geometry)}
            {!compact && xTicks(table, span, geometry)}
            {axisTitles(table, geometry, compact, disclosure, xTitleLines)}
            {plan && referenceLines(
              table,
              references,
              geometry,
              compact,
              resolutionNote,
              resolutionValue,
              plan,
              disclosure,
            )}
            {marksFor(
              table,
              type,
              compact,
              geometry,
              paint,
              inspection,
              currentIndex,
              showPoints,
              fallbackNames,
              convertedZero,
              showCoverageDetails,
            )}
            {cursorLine(table, currentIndex, showCurrentTime, currentTime, geometry, compact)}
          </>
        ) : (
          <>
            {axisTitles(table, geometry, compact, null, xTitleLines)}
            <text x={geometry.left} y={height / 2}>{"No data to draw."}</text>
          </>
        )}
      </svg>
      <div className="chart-tooltip" role="status" aria-live="polite">
        {tooltip}
      </div>
      {showTable && !compact && chartTable(table, resolutionNote)}
    </div>
  );
}

function heightFor(table: ChartTable, compact: boolean) {
  if (compact) return CHIP_HEIGHT_PX;
  if (table.shape === "distribution") return DISTRIBUTION_HEIGHT_PX;

  return SERIES_HEIGHT_PX;
}

function effectiveType(table: ChartTable, chartType: ChartType): ChartType {
  if (table.shape === "categorical_shares") return "line";

  return chartType;
}

function convertedBaseline(
  table: ChartTable,
  type: ChartType,
  override: number | null | undefined,
) {
  if (type === "line") return null;
  if (typeof override === "number" && Number.isFinite(override)) return override;
  if (table.shape === "categorical_shares") return null;
  const finite = finiteValues(table);
  const minimum = finite.length ? Math.min(...finite) : null;
  if (type === "bar") return 0;
  if (minimum === null) return 0;

  // Areas anchor at the lower of zero and the minimum so negative terrain stays visible.
  return Math.min(0, minimum);
}

function visibleReferences(
  table: ChartTable,
  show: boolean,
): { id: string; value: number }[] {
  if (!show || table.shape !== "distribution") return [];
  const references = [
    { id: "mean", value: table.mean },
    { id: "median", value: table.median },
  ];
  for (const reference of table.referenceValues) {
    if (reference.id === "sea_level") references.push({ ...reference });
  }

  return references;
}

function domainFor(
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

function xSpan(
  table: ChartTable,
  override: [number, number] | null,
  type: ChartType,
): [number, number] {
  const base = baseSpan(table, override);
  if (type !== "bar") return base;

  return barSpan(table, base);
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

function barSpan(table: ChartTable, base: [number, number]): [number, number] {
  if (table.shape === "seasonal_cycle" || table.shape === "distribution") {
    return [base[0] - BAR_HALF_SLOT, base[1] + BAR_HALF_SLOT];
  }
  if (table.shape !== "time_series") return base;
  const half = halfTimeSlot(table);
  if (half === null) return base;

  return [base[0] - half, base[1] + half];
}

function halfTimeSlot(table: ChartTable): number | null {
  if (table.shape !== "time_series") return null;
  const sorted = table.rows.map((row) => row.x).sort((first, second) => first - second);
  let smallest: number | null = null;
  for (let index = 1; index < sorted.length; index += 1) {
    const gap = sorted[index] - sorted[index - 1];
    if (!(gap > 0)) continue;
    if (smallest === null || gap < smallest) smallest = gap;
  }
  if (smallest === null) return null;

  return smallest / 2;
}

function initialCursor(
  table: ChartTable,
  currentTime: string | null,
  show: boolean,
): number | null {
  if (!show || !currentTime) return null;
  if (table.shape === "time_series") {
    const index = table.rows.findIndex(
      (row) => currentTime >= row.interval.start && currentTime < row.interval.end,
    );

    return index >= 0 ? index : null;
  }
  if (table.shape === "seasonal_cycle") {
    const month = Number(currentTime.slice(5, 7));

    return Number.isInteger(month) && month >= 1 && month <= 12 ? month - 1 : null;
  }

  return null;
}

function moveCursor(key: string, table: ChartTable, selected: number | null) {
  const count = table.rows.length;
  if (count === 0) return null;
  if (selected === null) {
    if (key === "ArrowRight" || key === "ArrowLeft" || key === "Home") return 0;
    if (key === "End") return count - 1;

    return null;
  }
  if (key === "ArrowRight") return Math.min(count - 1, selected + 1);
  if (key === "ArrowLeft") return Math.max(0, selected - 1);
  if (key === "Home") return 0;
  if (key === "End") return count - 1;

  return null;
}

function tooltipFor(
  table: ChartTable,
  inspection: number | null,
  currentIndex: number | null,
  currentTime: string | null,
  showCurrentTime: boolean,
  fallbackNames: string | null,
  showCoverageDetails: boolean,
) {
  if (table.shape === "categorical_shares") return "";
  if (inspection !== null) {
    const row = table.rows[inspection];
    if (!row) return "";
    if (table.shape === "time_series" || table.shape === "seasonal_cycle") {
      const text = rowText(table, row, fallbackNames, showCoverageDetails);

      return `Inspection: ${text}`;
    }

    return rowText(table, row, fallbackNames, showCoverageDetails);
  }
  if (currentIndex !== null) {
    const row = table.rows[currentIndex];
    if (!row) return "";
    return rowText(table, row, fallbackNames, showCoverageDetails);
  }
  if (currentTime && showCurrentTime) return "No observation for current time.";

  return currentValueText(table, fallbackNames, showCoverageDetails);
}

function currentValueText(
  table: ChartTable,
  fallbackNames: string | null,
  showCoverageDetails: boolean,
) {
  if (table.shape === "categorical_shares") return "";
  const finite = table.rows.filter((row) => typeof row.value === "number");
  if (finite.length === 0) return "No data in this table.";
  const last = finite[finite.length - 1];

  return rowText(table, last, fallbackNames, showCoverageDetails);
}

// Ordinary inspection uses concise values while tables keep exact numbers for download.
interface RowCoverage {
  value: number | null;
  label: string;
  validFraction: number;
  fallbackFraction: number | null;
  sampleCount?: number;
  yearRange?: [number, number] | null;
}

function rowText(
  table: ChartTable,
  row: RowCoverage,
  fallbackNames: string | null,
  showCoverageDetails = true,
) {
  const units = table.units;
  const value = row.value === null ? "No data" : `${formatPresentationValue(row.value)} ${units}`;
  const label = table.shape === "distribution" ? `${row.label} below` : row.label;
  if (!showCoverageDetails) return `${label}: ${value}`;
  const coverage = `valid ${formatPresentationValue(row.validFraction * 100)}%`;
  const seasonal = seasonalDetail(row);
  const base = `${label}: ${value} (${coverage}${seasonal}`;
  if (row.fallbackFraction === null || row.fallbackFraction === 0 || !fallbackNames) {
    return `${base})`;
  }
  const share = formatPresentationValue(row.fallbackFraction * 100);

  return `${base}, ${share}% of outline filled from ${fallbackNames})`;
}

function seasonalDetail(row: RowCoverage) {
  if (typeof row.sampleCount !== "number") return "";
  const years = row.yearRange ? ` ${String(row.yearRange[0])}-${String(row.yearRange[1])}` : "";

  return `, ${String(row.sampleCount)} years${years}`;
}

function summaryFor(table: ChartTable, chartType: ChartType) {
  const count = table.rows.length;
  const finite = finiteValues(table).length;
  const shape = table.shape === "distribution"
    ? "hypsometry"
    : table.shape === "seasonal_cycle"
      ? "By month"
      : "time series";

  return `${table.yTitle} as ${chartType}, ${shape} with ${String(finite)} of `
    + `${String(count)} values.`;
}

interface ChartGeometry {
  width: number;
  height: number;
  left: number;
  plotWidth: number;
  plotHeight: number;
  plotTop: number;
  plotBottom: number;
  xOf(x: number): number;
  yOf(value: number): number;
}

function chartGeometry(
  compact: boolean,
  width: number,
  height: number,
  domain: [number, number],
  span: [number, number],
  left: number,
  disclosureLines = 0,
  xTitleLines = 1,
): ChartGeometry {
  const safeWidth = Math.max(1, Math.round(width));
  const right = compact ? 2 : MARGIN_RIGHT_PX;
  const extraTop = disclosureLines > 0 ? (disclosureLines - 1) * DISCLOSURE_LINE_HEIGHT_PX : 0;
  const top = (compact ? 8 : MARGIN_TOP_PX) + extraTop;
  const extraBottom = xTitleLines > 1 ? (xTitleLines - 1) * X_TITLE_LINE_HEIGHT_PX : 0;
  const bottom = (compact ? 2 : MARGIN_BOTTOM_PX) + extraBottom;
  const plotWidth = Math.max(1, safeWidth - left - right);
  const plotHeight = Math.max(1, height - top - bottom);
  const [low, high] = domain;
  const [xLow, xHigh] = span;
  const plotTop = top;
  const plotBottom = top + plotHeight;

  return {
    width: safeWidth,
    height,
    left,
    plotWidth,
    plotHeight,
    plotTop,
    plotBottom,
    xOf: (x: number) => xPositionFor(x, xLow, xHigh, left, plotWidth),
    yOf: (value: number) => yPositionFor(value, low, high, plotTop, plotBottom, plotHeight),
  };
}

function plotWidthFor(width: number, left: number, compact: boolean): number {
  const safeWidth = Math.max(1, Math.round(width));
  const right = compact ? 2 : MARGIN_RIGHT_PX;

  return Math.max(1, safeWidth - left - right);
}

// Long titles wrap on word boundaries so narrow cards keep every word inside the svg.
function xTitleLinesFor(title: string, plotWidthPx: number): string[] {
  const maxChars = Math.max(1, Math.floor(plotWidthPx / TITLE_ESTIMATED_CHAR_PX));
  if (title.length <= maxChars) return [title];

  return wrapEquation(title, maxChars);
}

// A finite positive span maps across the plot, while a degenerate domain stays centered.
function xPositionFor(
  x: number,
  low: number,
  high: number,
  left: number,
  plotWidth: number,
) {
  if (!(high > low) || !Number.isFinite(low) || !Number.isFinite(high)) {
    return left + plotWidth / 2;
  }
  if (!Number.isFinite(x)) return left + plotWidth / 2;
  return left + ((x - low) / (high - low)) * plotWidth;
}

// Dividing before multiplying keeps tiny spans stable instead of compressing them.
function yPositionFor(
  value: number,
  low: number,
  high: number,
  top: number,
  bottom: number,
  plotHeight: number,
) {
  if (!(high > low) || !Number.isFinite(low) || !Number.isFinite(high)) {
    return top + plotHeight / 2;
  }
  if (!Number.isFinite(value)) return top + plotHeight / 2;
  return top + ((high - value) / (high - low)) * plotHeight;
}

// Wide labels widen the left gutter so ticks clear the rotated title.
function leftGutterFor(labels: string[], compact: boolean) {
  if (compact) return 2;
  if (labels.length === 0) return MARGIN_LEFT_PX;
  const longest = Math.max(...labels.map((label) => label.length));
  const estimated = longest * ESTIMATED_CHAR_PX;
  const gutter = TITLE_GUTTER_PX + estimated + TICK_GAP_PX;

  return Math.min(Math.max(gutter, MARGIN_LEFT_PX), MAX_LEFT_GUTTER_PX);
}

function gridLines(ticks: number[], geometry: ChartGeometry) {
  return (
    <g className="chart-grid">
      {ticks.map((tick) => (
        <line
          key={String(tick)}
          x1={geometry.left}
          x2={geometry.left + geometry.plotWidth}
          y1={geometry.yOf(tick)}
          y2={geometry.yOf(tick)}
          stroke="var(--chart-grid, #ddd)"
          strokeWidth={1}
        />
      ))}
    </g>
  );
}

// A diagonal line keeps its client box equal to the plot while staying out of bar counts.
function plotFrame(geometry: ChartGeometry) {
  return (
    <line
      className="chart-plot-frame"
      x1={geometry.left}
      y1={geometry.plotTop}
      x2={geometry.left + geometry.plotWidth}
      y2={geometry.plotBottom}
      stroke="transparent"
      strokeWidth={1}
      opacity={0}
      pointerEvents="none"
      aria-hidden="true"
    />
  );
}

function yTicks(ticks: number[], plan: TickPlan, geometry: ChartGeometry) {
  return (
    <g className="chart-y-ticks">
      {ticks.map((tick, index) => (
        <text
          key={String(tick)}
          x={geometry.left - TICK_GAP_PX}
          y={clampY(geometry.yOf(tick) + 4, geometry.height)}
          textAnchor="end"
          fontSize={11}
          fill="var(--chart-axis, #444)"
        >
          {plan.labels[index]}
        </text>
      ))}
    </g>
  );
}

function xTicks(
  table: ChartTable,
  span: [number, number],
  geometry: ChartGeometry,
) {
  const marks = xTickMarks(table, span, geometry);
  if (!marks) return null;
  const edgeAnchors = table.shape === "time_series" && marks.length > 1;

  return (
    <g className="chart-x-ticks">
      {marks.map((mark, index) => (
        <text
          key={String(mark.x)}
          x={clampX(geometry.xOf(mark.x), geometry.width)}
          y={geometry.plotBottom + X_TICK_OFFSET_PX}
          textAnchor={anchorFor(index, marks.length, edgeAnchors)}
          fontSize={11}
          fill="var(--chart-axis, #444)"
        >
          {mark.label}
        </text>
      ))}
    </g>
  );
}

function anchorFor(index: number, count: number, edges: boolean) {
  if (!edges) return "middle";
  if (index === 0) return "start";
  if (index === count - 1) return "end";

  return "middle";
}

function xTickMarks(
  table: ChartTable,
  span: [number, number],
  geometry: ChartGeometry,
): { x: number; label: string }[] | null {
  if (table.shape === "time_series") return timeMarksFor(span, geometry);
  if (table.shape === "seasonal_cycle") return seasonalMarksFor(table, geometry);
  if (table.shape === "distribution") {
    return ticksForDomain([0, 100], 5).map((tick) => ({
      x: tick,
      label: `${String(tick)}%`,
    }));
  }

  return null;
}

// Narrow gallery cards keep the most ticks that still leave a gap between dates.
function timeMarksFor(
  span: [number, number],
  geometry: ChartGeometry,
): { x: number; label: string }[] {
  for (const count of [4, 3, 2]) {
    const marks = dedupeMarks(ticksForDomain(span, count).map((tick) => ({
      x: tick,
      label: dateLabel(tick),
    })));
    if (marks.length <= 1) return marks;
    if (xMarksFit(marks, geometry, true)) return marks;
  }
  const single = (span[0] + span[1]) / 2;

  return [{ x: single, label: dateLabel(single) }];
}

// Short month names thin by step so the survivors keep their gap at gallery widths.
function seasonalMarksFor(
  table: ChartTable,
  geometry: ChartGeometry,
): { x: number; label: string }[] | null {
  if (table.shape !== "seasonal_cycle") return null;
  const rows = table.rows.map((row) => ({ x: row.x, label: row.label }));
  for (const step of [1, 2, 3, 6]) {
    const thinned = rows.filter((_, index) => index % step === 0);
    if (thinned.length <= 1) return thinned;
    if (xMarksFit(thinned, geometry, false)) return thinned;
  }

  return [rows[Math.floor(rows.length / 2)]];
}

// Estimated boxes must leave a gap because real glyphs vary around the average width.
function xMarksFit(
  marks: { x: number; label: string }[],
  geometry: ChartGeometry,
  edges: boolean,
): boolean {
  if (marks.length <= 1) return true;
  const positions = marks.map((mark) => clampX(geometry.xOf(mark.x), geometry.width));
  const widths = marks.map((mark) => mark.label.length * ESTIMATED_CHAR_PX);
  for (let index = 0; index < marks.length - 1; index += 1) {
    const right = edgeRightFor(index, positions[index], widths[index], edges);
    const left = edgeLeftFor(
      index + 1,
      positions[index + 1],
      widths[index + 1],
      edges,
      marks.length,
    );
    if (right + TIME_LABEL_GAP_PX > left) return false;
  }

  return true;
}

function edgeRightFor(index: number, x: number, width: number, edges: boolean) {
  if (edges && index === 0) return x + width;

  return x + width / 2;
}

function edgeLeftFor(
  index: number,
  x: number,
  width: number,
  edges: boolean,
  count: number,
) {
  if (edges && index === count - 1) return x - width;

  return x - width / 2;
}

// A singleton span samples milliseconds that share one calendar date, so keep one label.
function dedupeMarks(marks: { x: number; label: string }[]) {
  const seen = new Set<string>();
  const unique: { x: number; label: string }[] = [];
  for (const mark of marks) {
    if (seen.has(mark.label)) continue;
    seen.add(mark.label);
    unique.push(mark);
  }

  return unique;
}

function dateLabel(timeMs: number) {
  if (!Number.isFinite(timeMs)) return "";

  return new Date(timeMs).toISOString().slice(0, 10);
}

function axisTitles(
  table: ChartTable,
  geometry: ChartGeometry,
  compact: boolean,
  disclosure: string[] | null,
  xTitleLines: string[],
) {
  if (compact || table.shape === "categorical_shares") return null;
  const centerY = geometry.plotTop + geometry.plotHeight / 2;
  const centerX = geometry.left + geometry.plotWidth / 2;
  const firstTitleY = geometry.plotBottom + X_TITLE_OFFSET_PX;

  return (
    <g className="chart-axes">
      {xTitleLines.map((line, index) => (
        <text
          key={`${index}-${line}`}
          x={centerX}
          y={firstTitleY + index * X_TITLE_LINE_HEIGHT_PX}
          textAnchor="middle"
          fontSize={11}
          fill="var(--chart-axis, #444)"
        >
          {line}
        </text>
      ))}
      <text
        x={12}
        y={centerY}
        textAnchor="middle"
        fontSize={11}
        fill="var(--chart-axis, #444)"
        transform={`rotate(-90 12 ${String(centerY)})`}
      >
        {table.yTitle}
      </text>
      {(disclosure ?? []).map((line, index) => (
        <text
          key={`${index}-${line}`}
          x={geometry.left}
          y={OFFSET_DISCLOSURE_Y_PX + index * DISCLOSURE_LINE_HEIGHT_PX}
          textAnchor="start"
          fontSize={11}
          fill="var(--chart-axis, #444)"
          className="chart-offset"
        >
          {line}
        </text>
      ))}
    </g>
  );
}

// A shared base stays in a top-margin caption so short deltas keep their absolute meaning.
function offsetEquationFor(plan: TickPlan | null) {
  if (!plan || plan.offset === null) return null;
  if (!Number.isFinite(plan.offset)) return null;
  const base = String(plan.offset);
  const scale = plan.scale;
  if (scale === null || scale === 1) return `ticks + ${base} = value`;
  if (!Number.isFinite(scale)) return `ticks + ${base} = value`;
  return `ticks x ${compactScaleText(scale)} + ${base} = value`;
}

// Exact powers of ten stay short because 1e notation round-trips to the same double.
function compactScaleText(scale: number) {
  const exponent = Math.round(Math.log10(scale));
  if (!Number.isFinite(exponent)) return String(scale);
  if (Math.pow(10, exponent) !== scale) return String(scale);
  return `1e${String(exponent)}`;
}

// Long equations wrap inside the measured width so every line stays in the svg.
function disclosureLinesFor(
  plan: TickPlan | null,
  width: number,
  left: number,
  compact: boolean,
): string[] | null {
  if (compact) return null;
  const equation = offsetEquationFor(plan);
  if (equation === null) return null;
  const safeWidth = Math.max(1, Math.round(width));
  const available = Math.max(1, safeWidth - Math.round(left));
  const maxChars = Math.max(1, Math.floor(available / ESTIMATED_CHAR_PX));
  if (equation.length <= maxChars) return [equation];
  return wrapEquation(equation, maxChars);
}

// Words stay whole so the base never splits across lines.
function wrapEquation(equation: string, maxChars: number) {
  const words = equation.split(" ");
  const lines: string[] = [];
  let current = "";
  for (const word of words) {
    const next = current === "" ? word : `${current} ${word}`;
    if (next.length <= maxChars) {
      current = next;
      continue;
    }
    if (current !== "") lines.push(current);
    current = word;
  }
  if (current !== "") lines.push(current);
  if (lines.length === 0) return [equation];
  return lines;
}

function referenceLines(
  table: ChartTable,
  references: { id: string; value: number }[],
  geometry: ChartGeometry,
  compact: boolean,
  resolutionNote: string | null,
  resolutionValue: number | null,
  plan: TickPlan,
  disclosure: string[] | null,
) {
  if (table.shape !== "distribution" || compact) return null;
  const bounds = annotationBounds(geometry, disclosure);
  const desired = [
    ...references.map((reference) => geometry.yOf(reference.value) + ANNOTATION_OFFSET_PX),
    geometry.yOf(table.min) + ENDPOINT_OFFSET_PX,
    geometry.yOf(table.max) + ENDPOINT_OFFSET_PX,
  ];
  const allY = placeAnnotations(desired, bounds.low, bounds.high);
  const referenceY = allY.slice(0, references.length);
  const endpointY = allY.slice(references.length);

  return (
    <g className="chart-references">
      {references.map((reference, index) => (
        <g key={reference.id}>
          <title>
            {`${referenceLabel(reference.id)} ${formatPresentationValue(reference.value)}`}
          </title>
          <line
            x1={geometry.left}
            x2={geometry.left + geometry.plotWidth}
            y1={geometry.yOf(reference.value)}
            y2={geometry.yOf(reference.value)}
            stroke="var(--chart-muted, #888)"
            strokeWidth={1}
            strokeDasharray={reference.id === "sea_level" ? "4 2" : "6 2"}
          />
          <text
            x={geometry.left + geometry.plotWidth}
            y={referenceY[index]}
            textAnchor="end"
            fontSize={11}
            fill="var(--chart-axis, #444)"
          >
            {`${referenceLabel(reference.id)} ${formatPlanValue(reference.value, plan)}`}
          </text>
        </g>
      ))}
      {endpointMarkers(table, geometry, resolutionNote, resolutionValue, endpointY, bounds)}
    </g>
  );
}

function endpointMarkers(
  table: ChartTable,
  geometry: ChartGeometry,
  resolutionNote: string | null,
  resolutionValue: number | null,
  endpointY: number[],
  bounds: { low: number; high: number },
) {
  if (table.shape !== "distribution") return null;
  const lowX = geometry.xOf(100);
  const highX = geometry.xOf(0);
  const exactNote = resolutionNote ? ` (${resolutionNote})` : "";
  const displayNumber = displayResolutionNumber(resolutionValue, resolutionNote);
  const lowLabel = endpointLabelFor("Lowest cell", displayNumber, geometry.plotWidth);
  const highLabel = endpointLabelFor("Highest cell", displayNumber, geometry.plotWidth);
  const firstY = endpointY[0] ?? clampAnnotation(
    geometry.yOf(table.min) + ENDPOINT_OFFSET_PX,
    bounds,
  );
  const secondY = endpointY[1] ?? clampAnnotation(
    geometry.yOf(table.max) + ENDPOINT_OFFSET_PX,
    bounds,
  );

  return (
    <g className="chart-endpoints">
      <circle
        cx={lowX}
        cy={geometry.yOf(table.min)}
        r={POINT_RADIUS_PX}
        fill="var(--chart-axis, #444)"
      >
        <title>{`Lowest cell ${formatPresentationValue(table.min)}${exactNote}`}</title>
      </circle>
      <text
        x={lowX}
        y={firstY}
        textAnchor="end"
        fontSize={11}
        fill="var(--chart-axis, #444)"
      >
        {lowLabel}
      </text>
      <circle
        cx={highX}
        cy={geometry.yOf(table.max)}
        r={POINT_RADIUS_PX}
        fill="var(--chart-axis, #444)"
      >
        <title>{`Highest cell ${formatPresentationValue(table.max)}${exactNote}`}</title>
      </circle>
      <text
        x={highX}
        y={secondY}
        textAnchor="start"
        fontSize={11}
        fill="var(--chart-axis, #444)"
      >
        {highLabel}
      </text>
    </g>
  );
}

// Exact titles keep the stored resolution while visible labels use concise values.
function displayResolutionNumber(
  value: number | null,
  note: string | null,
): string | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    return formatPresentationValue(value);
  }
  const parsed = parseResolutionValue(note);
  if (parsed !== null) return formatPresentationValue(parsed);

  return null;
}

function parseResolutionValue(note: string | null): number | null {
  if (!note) return null;
  const match = /^\s*([+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?)/.exec(note);
  if (!match) return null;
  const parsed = Number(match[1]);

  return Number.isFinite(parsed) ? parsed : null;
}

// Short suffixes fit narrow plots while the table keeps the full analysis wording.
function endpointLabelFor(
  cell: string,
  displayNumber: string | null,
  plotWidthPx: number,
): string {
  if (displayNumber === null) return cell;
  const full = `${cell} (${displayNumber}${FULL_GRID_SUFFIX})`;
  if (fitsPlot(full, plotWidthPx)) return full;
  const short = `${cell} (${displayNumber}${SHORT_GRID_SUFFIX})`;
  if (fitsPlot(short, plotWidthPx)) return short;

  return cell;
}

function fitsPlot(label: string, plotWidthPx: number) {
  return label.length * ESTIMATED_CHAR_PX <= Math.max(1, plotWidthPx);
}

function annotationLow(hasDisclosure: boolean, lineCount = 1) {
  if (!hasDisclosure) return MIN_ANNOTATION_Y_PX;

  return DISCLOSURE_CLEAR_Y_PX + Math.max(0, lineCount - 1) * DISCLOSURE_LINE_HEIGHT_PX;
}

// Reference text stays below the disclosure and above the x ticks with its own descent.
function annotationBounds(
  geometry: ChartGeometry,
  disclosure: string[] | null,
) {
  const lines = disclosure?.length ?? 0;
  const low = Math.max(
    annotationLow(lines > 0, Math.max(1, lines)),
    ANNOTATION_ASCENT_PX + 3,
  );
  const plotBottom = geometry.plotBottom;
  const high = Math.max(low, plotBottom - ANNOTATION_DESCENT_PX);

  return { low, high };
}

function clampAnnotation(value: number, bounds: { low: number; high: number }) {
  return Math.min(Math.max(value, bounds.low), bounds.high);
}

function referenceLabel(id: string) {
  if (id === "mean") return "Mean";
  if (id === "median") return "Median";
  if (id === "sea_level") return "Sea level";

  return id;
}

// Overlapping labels share one staggered lane so references and endpoints stay readable.
function placeAnnotations(desired: number[], low: number, high: number) {
  const boundedHigh = Math.max(low, high);
  const result: number[] = [];
  for (const target of desired) {
    const candidate = freeLaneFor(target, result, low, boundedHigh);
    result.push(candidate);
  }

  return reflowLanes(result, low, boundedHigh);
}

function freeLaneFor(target: number, placed: number[], low: number, high: number) {
  const start = Math.min(Math.max(target, low), high);
  const limit = Math.max(STAGGER_LIMIT_PX, high - low);
  for (let offset = 0; offset <= limit; offset += REFERENCE_STAGGER_PX) {
    const candidates = offset === 0 ? [start] : [start + offset, start - offset];
    for (const candidate of candidates) {
      if (candidate < low || candidate > high) continue;
      if (placed.every((other) => Math.abs(other - candidate) >= REFERENCE_STAGGER_PX)) {
        return candidate;
      }
    }
  }
  for (let candidate = low; candidate <= high; candidate += SCAN_STEP_PX) {
    if (placed.every((other) => Math.abs(other - candidate) >= REFERENCE_STAGGER_PX)) {
      return candidate;
    }
  }

  return bestLaneFor(start, placed, low, high);
}

// A full lane keeps a colliding clamp from being accepted when no free pixel remains.
function bestLaneFor(start: number, placed: number[], low: number, high: number) {
  if (placed.length === 0) return start;
  let best = start;
  let bestClearance = -1;
  for (let candidate = low; candidate <= high; candidate += SCAN_STEP_PX) {
    const clearance = Math.min(...placed.map((other) => Math.abs(other - candidate)));
    if (clearance > bestClearance) {
      bestClearance = clearance;
      best = candidate;
    }
  }

  return best;
}

// Later labels near a clamped edge push earlier ones back inside instead of colliding.
function reflowLanes(combined: number[], low: number, high: number) {
  const boundedHigh = Math.max(low, high);
  const order = combined.map((lane, index) => ({ lane, index }));
  order.sort((first, second) => first.lane - second.lane || first.index - second.index);
  for (let index = 1; index < order.length; index++) {
    const previous = order[index - 1].lane;
    if (order[index].lane - previous < REFERENCE_STAGGER_PX) {
      order[index].lane = previous + REFERENCE_STAGGER_PX;
    }
  }
  const overflow = order.length ? order[order.length - 1].lane - boundedHigh : 0;
  if (overflow > 0) {
    for (const entry of order) entry.lane -= overflow;
    for (let index = order.length - 2; index >= 0; index--) {
      const next = order[index + 1].lane;
      if (next - order[index].lane < REFERENCE_STAGGER_PX) {
        order[index].lane = next - REFERENCE_STAGGER_PX;
      }
    }
  }
  if (order.length && order[0].lane < low) {
    const deficit = low - order[0].lane;
    for (const entry of order) entry.lane += deficit;
  }
  order.sort((first, second) => first.index - second.index);

  return order.map((entry) => Math.min(Math.max(entry.lane, low), boundedHigh));
}

function marksFor(
  table: ChartTable,
  chartType: ChartType,
  compact: boolean,
  geometry: ChartGeometry,
  paint: string,
  inspection: number | null,
  currentIndex: number | null,
  showPoints: boolean,
  fallbackNames: string | null,
  convertedZero: number | null,
  showCoverageDetails: boolean,
) {
  if (table.shape === "categorical_shares") return null;
  if (chartType === "bar") {
    return barsFor(
      table,
      geometry,
      paint,
      inspection,
      currentIndex,
      fallbackNames,
      convertedZero,
      showCoverageDetails,
    );
  }
  const isolated = isolatedIndices(table);
  if (chartType === "area") {
    return areaFor(
      table,
      geometry,
      paint,
      inspection,
      currentIndex,
      showPoints,
      fallbackNames,
      isolated,
      convertedZero,
      showCoverageDetails,
    );
  }

  return linesFor(
    table,
    geometry,
    paint,
    inspection,
    currentIndex,
    compact,
    showPoints,
    fallbackNames,
    isolated,
    showCoverageDetails,
  );
}

function barsFor(
  table: ChartTable,
  geometry: ChartGeometry,
  paint: string,
  inspection: number | null,
  currentIndex: number | null,
  fallbackNames: string | null,
  convertedZero: number | null,
  showCoverageDetails: boolean,
) {
  if (table.shape === "categorical_shares") return null;
  const baseline = convertedZero ?? 0;
  const baseY = geometry.yOf(baseline);
  const widths = barWidths(table, geometry);
  const selected = inspection ?? currentIndex;
  const resolved = chartPaintFor(paint);
  const stroke = resolved.edge ?? resolved.ink;

  return (
    <g className="chart-bars">
      {table.rows.map((row, index) => {
        if (typeof row.value !== "number") return null;
        const centre = geometry.xOf(xPosition(table, row));
        const half = widths[index] / 2;
        const hollow = row.validFraction < LOW_COVERAGE_FRACTION;
        const outlined = hollow || selected === index || resolved.edge !== null;
        const outline = outlined ? CONTRAST_OUTLINE_PX : 0;
        const strokeHalf = outlined ? outline / 2 : 0;
        const horizontal = clippedBarHorizontal(centre, half, geometry, strokeHalf);
        const vertical = clippedBarVertical(geometry.yOf(row.value), baseY, geometry, strokeHalf);

        return (
          <rect
            key={index}
            x={horizontal.x}
            y={vertical.y}
            width={horizontal.width}
            height={vertical.height}
            fill={hollow ? "none" : resolved.ink}
            stroke={outlined ? stroke : "none"}
            strokeWidth={outlined ? outline : 0}
          >
            <title>{rowText(table, row, fallbackNames, showCoverageDetails)}</title>
          </rect>
        );
      })}
    </g>
  );
}

// True centres stay shared with ticks and cursor, so edge rectangles clip instead of shifting.
function clippedBarHorizontal(
  centre: number,
  halfPx: number,
  geometry: ChartGeometry,
  strokeHalfPx: number,
): { x: number; width: number } {
  const innerLeft = geometry.left + strokeHalfPx;
  const innerRight = geometry.left + geometry.plotWidth - strokeHalfPx;
  if (!(innerRight > innerLeft)) {
    return { x: geometry.left, width: 1 };
  }
  const rawLeft = centre - halfPx;
  const rawRight = centre + halfPx;
  let left = Math.max(rawLeft, innerLeft);
  let right = Math.min(rawRight, innerRight);
  if (right - left < 1) {
    if (rawLeft < innerLeft) {
      left = innerLeft;
    } else if (rawRight > innerRight) {
      left = innerRight - 1;
    } else {
      left = centre - 0.5;
    }
    left = Math.min(Math.max(left, innerLeft), innerRight - 1);
    right = left + 1;
  }

  return { x: left, width: right - left };
}

// Minimum heights grow inward so zero bars stay inside the plot including their stroke.
function clippedBarVertical(
  top: number,
  baseY: number,
  geometry: ChartGeometry,
  strokeHalfPx: number,
): { y: number; height: number } {
  const innerTop = geometry.plotTop + strokeHalfPx;
  const innerBottom = geometry.plotBottom - strokeHalfPx;
  if (!(innerBottom > innerTop)) {
    return { y: geometry.plotTop, height: BAR_MIN_HEIGHT_PX };
  }
  const rawTop = Math.min(top, baseY);
  const rawBottom = Math.max(top, baseY);
  const clampedTop = Math.min(Math.max(rawTop, innerTop), innerBottom);
  const clampedBottom = Math.max(Math.min(rawBottom, innerBottom), innerTop);
  if (clampedBottom - clampedTop >= BAR_MIN_HEIGHT_PX) {
    return { y: clampedTop, height: clampedBottom - clampedTop };
  }
  let y = clampedTop;
  if (clampedTop >= innerBottom - BAR_MIN_HEIGHT_PX) {
    y = innerBottom - BAR_MIN_HEIGHT_PX;
  } else if (clampedTop <= innerTop) {
    y = innerTop;
  }
  y = Math.min(Math.max(y, innerTop), innerBottom - BAR_MIN_HEIGHT_PX);

  return { y, height: BAR_MIN_HEIGHT_PX };
}

function areaFor(
  table: ChartTable,
  geometry: ChartGeometry,
  paint: string,
  inspection: number | null,
  currentIndex: number | null,
  showPoints: boolean,
  fallbackNames: string | null,
  isolated: Set<number>,
  convertedZero: number | null,
  showCoverageDetails: boolean,
) {
  if (table.shape === "categorical_shares") return null;
  const baseline = convertedZero ?? 0;
  const baseY = geometry.yOf(baseline);
  const segments = segmentsFor(table);
  const selected = inspection ?? currentIndex;
  const resolved = chartPaintFor(paint);
  const edge = resolved.edge;

  return (
    <g className="chart-areas">
      {segments.map((segment, index) => (
        <polygon
          key={index}
          points={areaPoints(segment, geometry, baseY)}
          fill={resolved.ink}
          opacity={0.3}
          stroke={edge ?? resolved.ink}
          strokeWidth={edge ? AREA_EDGE_PX : 1}
        />
      ))}
      {edge && segments.map((segment, index) => (
        <polyline
          key={`edge-${index}`}
          points={linePoints(segment, geometry)}
          fill="none"
          stroke={edge}
          strokeWidth={AREA_EDGE_PX}
          aria-hidden={true}
        />
      ))}
      {circlesFor(
        table,
        geometry,
        paint,
        selected,
        showPoints,
        fallbackNames,
        isolated,
        showCoverageDetails,
      )}
    </g>
  );
}

function linesFor(
  table: ChartTable,
  geometry: ChartGeometry,
  paint: string,
  inspection: number | null,
  currentIndex: number | null,
  compact: boolean,
  showPoints: boolean,
  fallbackNames: string | null,
  isolated: Set<number>,
  showCoverageDetails: boolean,
) {
  if (table.shape === "categorical_shares") return null;
  const segments = segmentsFor(table);
  const selected = inspection ?? currentIndex;
  const resolved = chartPaintFor(paint);
  const edge = resolved.edge;
  const width = compact ? 1 : 2;
  const under = compact ? LIGHT_COMPACT_LINE_UNDER_PX : LIGHT_LINE_UNDER_PX;

  return (
    <g className="chart-lines">
      {edge && segments.map((segment, index) => (
        <polyline
          key={`under-${index}`}
          points={linePoints(segment, geometry)}
          fill="none"
          stroke={edge}
          strokeWidth={under}
          aria-hidden={true}
        />
      ))}
      {segments.map((segment, index) => (
        <polyline
          key={index}
          points={linePoints(segment, geometry)}
          fill="none"
          stroke={resolved.ink}
          strokeWidth={width}
        />
      ))}
      {circlesFor(
        table,
        geometry,
        paint,
        selected,
        showPoints,
        fallbackNames,
        isolated,
        showCoverageDetails,
      )}
    </g>
  );
}

function circlesFor(
  table: ChartTable,
  geometry: ChartGeometry,
  paint: string,
  selected: number | null,
  showPoints: boolean,
  fallbackNames: string | null,
  isolated: Set<number>,
  showCoverageDetails: boolean,
) {
  if (table.shape === "categorical_shares") return null;
  const resolved = chartPaintFor(paint);
  const stroke = resolved.edge ?? resolved.ink;

  return (
    <g className="chart-points">
      {table.rows.map((row, index) => {
        if (typeof row.value !== "number") return null;
        const hollow = row.validFraction < LOW_COVERAGE_FRACTION;
        const single = isolated.has(index);
        if (!showPoints && !hollow && selected !== index && !single) return null;
        const x = xPosition(table, row);
        const radius = single ? SINGLE_RADIUS_PX : POINT_RADIUS_PX;
        const outlined = hollow || selected === index || resolved.edge !== null;
        const width = hollow ? HOLLOW_WIDTH_PX : selected === index ? 2 : CONTRAST_OUTLINE_PX;

        return (
          <circle
            key={index}
            cx={geometry.xOf(x)}
            cy={geometry.yOf(row.value)}
            r={radius}
            fill={hollow ? "none" : resolved.ink}
            stroke={outlined ? stroke : "none"}
            strokeWidth={outlined ? width : 0}
          >
            <title>{rowText(table, row, fallbackNames, showCoverageDetails)}</title>
          </circle>
        );
      })}
    </g>
  );
}

function isolatedIndices(table: ChartTable) {
  if (table.shape === "categorical_shares") return new Set<number>();
  const isolated = new Set<number>();
  table.rows.forEach((row, index) => {
    if (typeof row.value !== "number" || !Number.isFinite(row.value)) return;
    const before = index > 0 ? table.rows[index - 1].value : null;
    const after = index + 1 < table.rows.length ? table.rows[index + 1].value : null;
    const beforeFinite = typeof before === "number" && Number.isFinite(before);
    const afterFinite = typeof after === "number" && Number.isFinite(after);
    if (!beforeFinite && !afterFinite) isolated.add(index);
  });

  return isolated;
}

function linePoints(segment: [number, number][], geometry: ChartGeometry) {
  return segment
    .map(([x, value]) => `${String(geometry.xOf(x))},${String(geometry.yOf(value))}`)
    .join(" ");
}

function areaPoints(segment: [number, number][], geometry: ChartGeometry, baseY: number) {
  const top = linePoints(segment, geometry);
  const first = segment[0][0];
  const last = segment[segment.length - 1][0];

  return `${String(geometry.xOf(first))},${String(baseY)} ${top} `
    + `${String(geometry.xOf(last))},${String(baseY)}`;
}

function segmentsFor(table: ChartTable) {
  if (table.shape === "categorical_shares") return [] as [number, number][][];
  const segments: [number, number][][] = [];
  let current: [number, number][] = [];
  for (const row of table.rows) {
    if (typeof row.value !== "number" || !Number.isFinite(row.value)) {
      if (current.length > 0) segments.push(current);
      current = [];
      continue;
    }
    current.push([xPosition(table, row), row.value]);
  }
  if (current.length > 0) segments.push(current);

  return segments;
}

function xPosition(
  table: ChartTable,
  row: { x: number },
) {
  if (table.shape === "distribution") return 100 - row.x;

  return row.x;
}

function barWidths(table: ChartTable, geometry: ChartGeometry) {
  if (table.shape === "categorical_shares") return table.rows.map(() => 8);
  if (table.shape === "seasonal_cycle") return table.rows.map(() => geometry.plotWidth / 12 * 0.7);
  if (table.shape === "distribution") return table.rows.map(() => geometry.plotWidth / 101 * 0.8);
  const positions = table.rows.map((row) => geometry.xOf(xPosition(table, row)));
  const sorted = [...positions].sort((first, second) => first - second);
  const gaps = sorted.slice(1).map((value, index) => value - sorted[index]);
  const smallest = gaps.length ? Math.min(...gaps) : geometry.plotWidth;

  return positions.map(() => Math.max(1, smallest * 0.7));
}

function cursorLine(
  table: ChartTable,
  currentIndex: number | null,
  show: boolean,
  currentTime: string | null,
  geometry: ChartGeometry,
  compact: boolean,
) {
  if (!show || currentIndex === null || table.shape === "distribution") return null;
  if (table.shape === "categorical_shares") return null;
  const row = table.rows[currentIndex];
  if (!row) return null;
  const x = geometry.xOf(xPosition(table, row));

  return (
    <g className="chart-cursor">
      <line
        x1={x}
        x2={x}
        y1={compact ? 0 : geometry.plotTop}
        y2={compact ? geometry.height : geometry.plotBottom}
        stroke="var(--chart-muted, #888)"
        strokeWidth={1}
        strokeDasharray="3 2"
      />
      <title>{`Current ${currentTime ?? row.label}`}</title>
    </g>
  );
}

function chartTable(table: ChartTable, resolutionNote: string | null) {
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

function yearRangeText(range: [number, number] | null) {
  if (!range) return "";

  return `${String(range[0])}-${String(range[1])}`;
}

function distributionReferences(table: Extract<ChartTable, { shape: "distribution" }>) {
  if (table.referenceValues.length === 0) return "No sea-level reference was emitted.";
  const names = table.referenceValues.map(
    (reference) => `${reference.id} ${String(reference.value)}`,
  );

  return `References: ${names.join(", ")}.`;
}

function clampY(y: number, height: number, low = MIN_ANNOTATION_Y_PX) {
  return Math.min(
    Math.max(y, low),
    Math.max(low, height - BOTTOM_ANNOTATION_MARGIN_PX),
  );
}

function clampX(x: number, width: number) {
  return Math.min(
    Math.max(x, MIN_ANNOTATION_X_PX),
    Math.max(MIN_ANNOTATION_X_PX, width - MIN_ANNOTATION_X_PX),
  );
}

// Visible ticks round to their spacing so long stored decimals never reach the axes.
interface TickPlan {
  labels: string[];
  decimals: number;
  offset: number | null;
  scale: number | null;
  exponentialDigits: number | null;
}

// Narrow relative spans show scaled deltas from a disclosed base so ticks stay distinct.
function tickLabelsFor(domain: readonly [number, number], ticks: number[]): TickPlan {
  const unique = dedupeNumericTicks(ticks);
  const spacing = tickSpacingFor(domain, unique.length);
  const decimals = presentationDecimals(spacing);
  const fixed = unique.map((tick) => formatFixedValue(tick, decimals));
  if (distinctLabels(fixed) && fitsGutter(fixed)) {
    return { labels: fixed, decimals, offset: null, scale: null, exponentialDigits: null };
  }
  const base = offsetBaseFor(domain, unique);
  const scale = scaleFor(domain);
  if (base !== null && scale !== null) {
    const scaled = scaledPlanFor(unique, base, scale);
    if (scaled !== null) return scaled;
  }
  for (
    let digits = MIN_EXPONENT_MANTISSA_DIGITS;
    digits <= MAX_EXPONENT_MANTISSA_DIGITS;
    digits += 1
  ) {
    const exponential = unique.map((tick) => (
      tick === 0 ? "0" : shortExponential(tick, digits)
    ));
    if (distinctLabels(exponential) && fitsGutter(exponential)) {
      return {
        labels: exponential,
        decimals,
        offset: null,
        scale: null,
        exponentialDigits: digits,
      };
    }
  }
  if (base !== null) {
    for (
      let digits = MIN_EXPONENT_MANTISSA_DIGITS;
      digits <= MAX_EXPONENT_MANTISSA_DIGITS;
      digits += 1
    ) {
      const deltas = unique.map((tick) => (
        tick === base ? "0" : shortExponential(tick - base, digits)
      ));
      if (distinctLabels(deltas) && fitsGutter(deltas)) {
        return { labels: deltas, decimals, offset: base, scale: null, exponentialDigits: digits };
      }
    }
  }
  const fallbackBase = base ?? domain[0];
  const fallbackScale = scale ?? 1;
  const fallback = scaledPlanFor(unique, fallbackBase, fallbackScale, MAX_FIXED_DECIMALS);
  if (fallback !== null) return fallback;

  // Indexed labels keep the last resort bounded and distinct because ticks are deduped.
  const indexed = unique.map((_, index) => String(index));
  return {
    labels: indexed,
    decimals,
    offset: null,
    scale: null,
    exponentialDigits: null,
  };
}

// Adjacent representable values collapse to one tick, so exact duplicates never reach keys.
function dedupeNumericTicks(ticks: number[]) {
  const seen = new Set<number>();
  const unique: number[] = [];
  for (const tick of ticks) {
    if (seen.has(tick)) continue;
    seen.add(tick);
    unique.push(tick);
  }

  return unique;
}

// A narrow relative span needs a shared base at any magnitude so deltas stay readable.
function offsetBaseFor(domain: readonly [number, number], ticks: number[]) {
  const span = domain[1] - domain[0];
  const magnitude = maxAbsOf(ticks);
  if (!(span > 0) || !Number.isFinite(span)) return null;
  if (!Number.isFinite(magnitude) || !(magnitude > 0)) return null;
  if (span / magnitude >= OFFSET_RELATIVE_SPAN_THRESHOLD) return null;
  const base = domain[0];
  if (!Number.isFinite(base)) return null;
  return base;
}

// A shared power-of-ten scale keeps narrow deltas short without per-label exponents.
function scaleFor(domain: readonly [number, number]) {
  const span = domain[1] - domain[0];
  if (!(span > 0) || !Number.isFinite(span)) return null;
  const exponent = Math.floor(Math.log10(span));
  if (!Number.isFinite(exponent)) return null;
  const bounded = Math.min(Math.max(exponent, MIN_SCALE_EXPONENT), MAX_SCALE_EXPONENT);
  const scale = Math.pow(10, bounded);
  if (!(scale > 0) || !Number.isFinite(scale)) return null;
  return scale;
}

// Scaled deltas stay short because the shared scale keeps them near single digits.
function scaledPlanFor(
  ticks: number[],
  base: number,
  scale: number,
  maxDecimals = MAX_EXPONENT_MANTISSA_DIGITS,
) {
  if (!(scale > 0) || !Number.isFinite(scale)) return null;
  if (!Number.isFinite(base)) return null;
  for (let decimals = 0; decimals <= maxDecimals; decimals += 1) {
    const labels = ticks.map((tick) => formatFixedValue((tick - base) / scale, decimals));
    if (distinctLabels(labels) && fitsGutter(labels)) {
      return { labels, decimals, offset: base, scale, exponentialDigits: null };
    }
  }
  return null;
}

function distinctLabels(labels: string[]) {
  return new Set(labels).size === labels.length;
}

function fitsGutter(labels: string[]) {
  return longestLabel(labels) <= MAX_TICK_LABEL_CHARS;
}

function longestLabel(labels: string[]) {
  if (labels.length === 0) return 0;

  return Math.max(...labels.map((label) => label.length));
}

function maxAbsOf(ticks: number[]) {
  if (ticks.length === 0) return 0;

  return Math.max(...ticks.map((tick) => Math.abs(tick)));
}

// References share the tick plan so their deltas and exponents match the axis.
function formatPlanValue(value: number, plan: TickPlan) {
  if (!Number.isFinite(value)) return "";
  if (plan.offset !== null) {
    const scale = plan.scale ?? 1;
    const delta = (value - plan.offset) / scale;
    if (!Number.isFinite(delta)) return "";
    if (plan.exponentialDigits !== null) {
      if (delta === 0) return "0";

      return shortExponential(delta, plan.exponentialDigits);
    }

    return formatFixedValue(delta, plan.decimals);
  }
  if (plan.exponentialDigits !== null) {
    if (value === 0) return "0";

    return shortExponential(value, plan.exponentialDigits);
  }

  return formatFixedValue(value, plan.decimals);
}

// Bounded precision keeps tiny spans inside the toFixed API limit.
function formatFixedValue(value: number, decimals: number) {
  if (!Number.isFinite(value)) return "";
  const bounded = Math.min(Math.max(Math.floor(decimals), 0), MAX_FIXED_DECIMALS);
  if (bounded <= 0) return cleanInteger(value);

  return cleanFixed(value, bounded);
}

function tickSpacingFor(domain: readonly [number, number], count: number) {
  const span = domain[1] - domain[0];
  if (!(span > 0) || !Number.isFinite(span)) return Number.NaN;
  const safeCount = Math.max(2, Math.floor(count));

  return span / (safeCount - 1);
}

// Whole steps need no decimals while sub-unit steps keep one guard digit past the spacing.
function presentationDecimals(spacing: number) {
  if (!Number.isFinite(spacing) || !(spacing > 0)) return FALLBACK_TICK_DECIMALS;
  if (spacing >= WHOLE_STEP_THRESHOLD) return 0;
  const decimals = Math.max(0, -Math.floor(Math.log10(spacing))) + DECIMAL_GUARD_DIGITS;

  return Math.min(decimals, PRESENTATION_TICK_MAX_DECIMALS);
}

// Short exponentials stay readable where fixed decimals would run past the margin.
function shortExponential(value: number, digits: number) {
  const text = value.toExponential(digits);
  const trimmed = text.replace(/(\.\d*?)0+e/, "$1e").replace(/\.e/, "e");

  return trimmed;
}

function cleanInteger(value: number) {
  const rounded = Math.round(value);
  if (rounded === 0) return "0";

  return String(rounded);
}

function cleanFixed(value: number, decimals: number) {
  const fixed = value.toFixed(decimals);
  const trimmed = fixed.replace(/(\.\d*?)0+$/, "$1").replace(/\.$/, "");
  if (trimmed === "-0") return "0";

  return trimmed;
}
