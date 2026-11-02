/** One accessible SVG renderer for line, bar and area chart tables. */
import { useEffect, useMemo, useState } from "react";

import { autoDomain, ticksForDomain } from "./ticks";
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
const MARGIN_BOTTOM_PX = 32;

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
/** The fallback scan steps one pixel so a free lane is found when one exists. */
const SCAN_STEP_PX = 1;

/** A cursor mark stays visible even for a single finite value. */
const POINT_RADIUS_PX = 3;
const SINGLE_RADIUS_PX = 4;
const HOLLOW_WIDTH_PX = 1.5;
const BAR_MIN_HEIGHT_PX = 1;

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
  fallbackNames?: string | null;
  resolutionNote?: string | null;
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
  fallbackNames = null,
  resolutionNote = null,
  baseline = null,
}: SvgChartProps): React.ReactElement {
  const [ref, width] = useElementWidth();
  const [cursor, setCursor] = useState<number | null>(null);
  const paint = ink ?? "var(--chart-ink, #1a3658)";
  const height = height_PX ?? heightFor(table, compact);
  const type = effectiveType(table, chartType, compact);
  const convertedZero = convertedBaseline(table, type, baseline);
  const references = useMemo(
    () => visibleReferences(table, showReferences && !compact),
    [table, showReferences, compact],
  );
  const domain = domainFor(table, type, references, convertedZero, yRange);
  const span = xSpan(table, xDomain);
  const rowTotal = rowCount(table);
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
  );
  const hasDomain = domain !== null;
  const geometry = chartGeometry(compact, width, height, domain ?? [0, 1], span);
  const ticks = hasDomain ? ticksForDomain(domain!, 4) : [];

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
            {showGrid && !compact && gridLines(ticks, geometry)}
            {!compact && yTicks(ticks, geometry)}
            {!compact && xTicks(table, span, geometry)}
            {axisTitles(table, geometry, compact)}
            {referenceLines(table, references, geometry, compact, resolutionNote)}
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
            )}
            {cursorLine(table, currentIndex, showCurrentTime, currentTime, geometry, compact)}
          </>
        ) : (
          <>
            {axisTitles(table, geometry, compact)}
            <text x={MARGIN_LEFT_PX} y={height / 2}>{"No data to draw."}</text>
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

function effectiveType(
  table: ChartTable,
  chartType: ChartType,
  compact: boolean,
): ChartType {
  if (compact) return "line";
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
  const count = rowCount(table);
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

function rowCount(table: ChartTable) {
  return table.rows.length;
}

function tooltipFor(
  table: ChartTable,
  inspection: number | null,
  currentIndex: number | null,
  currentTime: string | null,
  showCurrentTime: boolean,
  fallbackNames: string | null,
) {
  if (table.shape === "categorical_shares") return "";
  if (inspection !== null) {
    const row = table.rows[inspection];
    if (!row) return "";
    if (table.shape === "time_series" || table.shape === "seasonal_cycle") {
      const text = rowText(table, row, fallbackNames);

      return `Inspection: ${text}`;
    }

    return rowText(table, row, fallbackNames);
  }
  if (currentIndex !== null) {
    const row = table.rows[currentIndex];
    if (!row) return "";
    return rowText(table, row, fallbackNames);
  }
  if (currentTime && showCurrentTime) return "No observation for current time.";

  return currentValueText(table, fallbackNames);
}

function currentValueText(table: ChartTable, fallbackNames: string | null) {
  if (table.shape === "categorical_shares") return "";
  const finite = table.rows.filter((row) => typeof row.value === "number");
  if (finite.length === 0) return "No data in this table.";
  const last = finite[finite.length - 1];

  return rowText(table, last, fallbackNames);
}

// Full precision stays in the tooltip because String never rounds the stored value.
interface RowCoverage {
  value: number | null;
  label: string;
  validFraction: number;
  fallbackFraction: number | null;
  sampleCount?: number;
  yearRange?: [number, number] | null;
}

function rowText(table: ChartTable, row: RowCoverage, fallbackNames: string | null) {
  const units = table.units;
  const value = row.value === null ? "No data" : `${String(row.value)} ${units}`;
  const coverage = `valid ${String(row.validFraction * 100)}%`;
  const seasonal = seasonalDetail(row);
  const label = table.shape === "distribution" ? `${row.label} below` : row.label;
  const base = `${label}: ${value} (${coverage}${seasonal}`;
  if (row.fallbackFraction === null || row.fallbackFraction === 0 || !fallbackNames) {
    return `${base})`;
  }

  return `${base}, `
    + `${String(row.fallbackFraction * 100)}% of outline filled from ${fallbackNames})`;
}

function seasonalDetail(row: RowCoverage) {
  if (typeof row.sampleCount !== "number") return "";
  const years = row.yearRange ? ` ${String(row.yearRange[0])}-${String(row.yearRange[1])}` : "";

  return `, ${String(row.sampleCount)} years${years}`;
}

function summaryFor(table: ChartTable, chartType: ChartType) {
  const count = rowCount(table);
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
  plotWidth: number;
  plotHeight: number;
  xOf(x: number): number;
  yOf(value: number): number;
}

function chartGeometry(
  compact: boolean,
  width: number,
  height: number,
  domain: [number, number],
  span: [number, number],
): ChartGeometry {
  const safeWidth = Math.max(1, Math.round(width));
  const left = compact ? 2 : MARGIN_LEFT_PX;
  const right = compact ? 2 : MARGIN_RIGHT_PX;
  const top = compact ? 8 : MARGIN_TOP_PX;
  const bottom = compact ? 2 : MARGIN_BOTTOM_PX;
  const plotWidth = Math.max(1, safeWidth - left - right);
  const plotHeight = Math.max(1, height - top - bottom);
  const [low, high] = domain;
  const [xLow, xHigh] = span;

  return {
    width: safeWidth,
    height,
    plotWidth,
    plotHeight,
    xOf: (x: number) => left + (plotWidth * (x - xLow)) / Math.max(1e-12, xHigh - xLow),
    yOf: (value: number) => top + (plotHeight * (high - value)) / Math.max(1e-12, high - low),
  };
}

function gridLines(ticks: number[], geometry: ChartGeometry) {
  return (
    <g className="chart-grid">
      {ticks.map((tick) => (
        <line
          key={String(tick)}
          x1={MARGIN_LEFT_PX}
          x2={MARGIN_LEFT_PX + geometry.plotWidth}
          y1={geometry.yOf(tick)}
          y2={geometry.yOf(tick)}
          stroke="var(--chart-grid, #ddd)"
          strokeWidth={1}
        />
      ))}
    </g>
  );
}

function yTicks(ticks: number[], geometry: ChartGeometry) {
  return (
    <g className="chart-y-ticks">
      {ticks.map((tick) => (
        <text
          key={String(tick)}
          x={MARGIN_LEFT_PX - 4}
          y={clampY(geometry.yOf(tick) + 4, geometry.height)}
          textAnchor="end"
          fontSize={11}
          fill="var(--chart-axis, #444)"
        >
          {String(tick)}
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
  const marks = xTickMarks(table, span);
  if (!marks) return null;

  return (
    <g className="chart-x-ticks">
      {marks.map((mark) => (
        <text
          key={String(mark.x)}
          x={clampX(geometry.xOf(mark.x), geometry.width)}
          y={geometry.height - 16}
          textAnchor="middle"
          fontSize={11}
          fill="var(--chart-axis, #444)"
        >
          {mark.label}
        </text>
      ))}
    </g>
  );
}

function xTickMarks(
  table: ChartTable,
  span: [number, number],
): { x: number; label: string }[] | null {
  if (table.shape === "time_series") {
    const marks = ticksForDomain(span, 4).map((tick) => ({
      x: tick,
      label: dateLabel(tick),
    }));

    return dedupeMarks(marks);
  }
  if (table.shape === "seasonal_cycle") {
    return table.rows.map((row) => ({ x: row.x, label: row.label }));
  }
  if (table.shape === "distribution") {
    return ticksForDomain([0, 100], 5).map((tick) => ({
      x: tick,
      label: `${String(tick)}%`,
    }));
  }

  return null;
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

function dateLabel(time_MS: number) {
  if (!Number.isFinite(time_MS)) return "";

  return new Date(time_MS).toISOString().slice(0, 10);
}

function axisTitles(table: ChartTable, geometry: ChartGeometry, compact: boolean) {
  if (compact || table.shape === "categorical_shares") return null;

  return (
    <g className="chart-axes">
      <text
        x={MARGIN_LEFT_PX + geometry.plotWidth / 2}
        y={geometry.height - 4}
        textAnchor="middle"
        fontSize={11}
        fill="var(--chart-axis, #444)"
      >
        {table.xTitle}
      </text>
      <text
        x={12}
        y={MARGIN_TOP_PX + geometry.plotHeight / 2}
        textAnchor="middle"
        fontSize={11}
        fill="var(--chart-axis, #444)"
        transform={`rotate(-90 12 ${String(MARGIN_TOP_PX + geometry.plotHeight / 2)})`}
      >
        {table.yTitle}
      </text>
    </g>
  );
}

function referenceLines(
  table: ChartTable,
  references: { id: string; value: number }[],
  geometry: ChartGeometry,
  compact: boolean,
  resolutionNote: string | null,
) {
  if (table.shape !== "distribution" || compact) return null;
  const desired = [
    ...references.map((reference) => geometry.yOf(reference.value) + ANNOTATION_OFFSET_PX),
    geometry.yOf(table.min) + ENDPOINT_OFFSET_PX,
    geometry.yOf(table.max) + ENDPOINT_OFFSET_PX,
  ];
  const allY = placeAnnotations(desired, geometry.height);
  const referenceY = allY.slice(0, references.length);
  const endpointY = allY.slice(references.length);

  return (
    <g className="chart-references">
      {references.map((reference, index) => (
        <g key={reference.id}>
          <line
            x1={MARGIN_LEFT_PX}
            x2={MARGIN_LEFT_PX + geometry.plotWidth}
            y1={geometry.yOf(reference.value)}
            y2={geometry.yOf(reference.value)}
            stroke="var(--chart-muted, #888)"
            strokeWidth={1}
            strokeDasharray={reference.id === "sea_level" ? "4 2" : "6 2"}
          />
          <text
            x={MARGIN_LEFT_PX + geometry.plotWidth}
            y={referenceY[index]}
            textAnchor="end"
            fontSize={11}
            fill="var(--chart-axis, #444)"
          >
            {`${referenceLabel(reference.id)} ${String(reference.value)}`}
          </text>
        </g>
      ))}
      {endpointMarkers(table, geometry, resolutionNote, endpointY)}
    </g>
  );
}

function endpointMarkers(
  table: ChartTable,
  geometry: ChartGeometry,
  resolutionNote: string | null,
  endpointY: number[],
) {
  if (table.shape !== "distribution") return null;
  const lowX = geometry.xOf(100);
  const highX = geometry.xOf(0);
  const note = resolutionNote ? ` (${resolutionNote})` : "";
  const lowY = endpointY[0] ?? clampY(
    geometry.yOf(table.min) + ENDPOINT_OFFSET_PX,
    geometry.height,
  );
  const highY = endpointY[1] ?? clampY(
    geometry.yOf(table.max) + ENDPOINT_OFFSET_PX,
    geometry.height,
  );

  return (
    <g className="chart-endpoints">
      <circle
        cx={lowX}
        cy={geometry.yOf(table.min)}
        r={POINT_RADIUS_PX}
        fill="var(--chart-axis, #444)"
      >
        <title>{`Lowest cell ${String(table.min)}${note}`}</title>
      </circle>
      <text
        x={lowX}
        y={lowY}
        textAnchor="end"
        fontSize={11}
        fill="var(--chart-axis, #444)"
      >
        {`Lowest cell${note}`}
      </text>
      <circle
        cx={highX}
        cy={geometry.yOf(table.max)}
        r={POINT_RADIUS_PX}
        fill="var(--chart-axis, #444)"
      >
        <title>{`Highest cell ${String(table.max)}${note}`}</title>
      </circle>
      <text
        x={highX}
        y={highY}
        textAnchor="start"
        fontSize={11}
        fill="var(--chart-axis, #444)"
      >
        {`Highest cell${note}`}
      </text>
    </g>
  );
}

function referenceLabel(id: string) {
  if (id === "mean") return "Mean";
  if (id === "median") return "Median";
  if (id === "sea_level") return "Sea level";

  return id;
}

// Overlapping labels share one staggered lane so references and endpoints stay readable.
function placeAnnotations(desired: number[], height: number) {
  const result: number[] = [];
  for (const target of desired) {
    const candidate = freeLaneFor(target, result, height);
    result.push(candidate);
  }

  return reflowLanes(result, height);
}

function freeLaneFor(target: number, placed: number[], height: number) {
  const low = MIN_ANNOTATION_Y_PX;
  const high = Math.max(low, height - BOTTOM_ANNOTATION_MARGIN_PX);
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
function reflowLanes(combined: number[], height: number) {
  const low = MIN_ANNOTATION_Y_PX;
  const high = Math.max(low, height - BOTTOM_ANNOTATION_MARGIN_PX);
  const order = combined.map((lane, index) => ({ lane, index }));
  order.sort((first, second) => first.lane - second.lane || first.index - second.index);
  for (let index = 1; index < order.length; index++) {
    const previous = order[index - 1].lane;
    if (order[index].lane - previous < REFERENCE_STAGGER_PX) {
      order[index].lane = previous + REFERENCE_STAGGER_PX;
    }
  }
  const overflow = order.length ? order[order.length - 1].lane - high : 0;
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

  return order.map((entry) => Math.min(Math.max(entry.lane, low), high));
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
) {
  if (table.shape === "categorical_shares") return null;
  if (chartType === "bar") {
    return barsFor(table, geometry, paint, inspection, currentIndex, fallbackNames, convertedZero);
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
) {
  if (table.shape === "categorical_shares") return null;
  const baseline = convertedZero ?? 0;
  const baseY = geometry.yOf(baseline);
  const widths = barWidths(table, geometry);
  const selected = inspection ?? currentIndex;

  return (
    <g className="chart-bars">
      {table.rows.map((row, index) => {
        if (typeof row.value !== "number") return null;
        const x = xPosition(table, row);
        const centre = geometry.xOf(x);
        const half = widths[index] / 2;
        const top = geometry.yOf(row.value);
        const y = Math.min(top, baseY);
        const height = Math.max(BAR_MIN_HEIGHT_PX, Math.abs(top - baseY));
        const hollow = row.validFraction < LOW_COVERAGE_FRACTION;

        return (
          <rect
            key={index}
            x={centre - half}
            y={y}
            width={Math.max(1, widths[index])}
            height={height}
            fill={hollow ? "none" : paint}
            stroke={paint}
            strokeWidth={hollow || selected === index ? HOLLOW_WIDTH_PX : 0}
          >
            <title>{rowText(table, row, fallbackNames)}</title>
          </rect>
        );
      })}
    </g>
  );
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
) {
  if (table.shape === "categorical_shares") return null;
  const baseline = convertedZero ?? 0;
  const baseY = geometry.yOf(baseline);
  const segments = segmentsFor(table);
  const selected = inspection ?? currentIndex;

  return (
    <g className="chart-areas">
      {segments.map((segment, index) => (
        <polygon
          key={index}
          points={areaPoints(segment, geometry, baseY)}
          fill={paint}
          opacity={0.3}
          stroke={paint}
          strokeWidth={1}
        />
      ))}
      {circlesFor(table, geometry, paint, selected, showPoints, fallbackNames, isolated)}
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
) {
  if (table.shape === "categorical_shares") return null;
  const segments = segmentsFor(table);
  const selected = inspection ?? currentIndex;

  return (
    <g className="chart-lines">
      {segments.map((segment, index) => (
        <polyline
          key={index}
          points={linePoints(segment, geometry)}
          fill="none"
          stroke={paint}
          strokeWidth={compact ? 1 : 2}
        />
      ))}
      {circlesFor(table, geometry, paint, selected, showPoints, fallbackNames, isolated)}
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
) {
  if (table.shape === "categorical_shares") return null;

  return (
    <g className="chart-points">
      {table.rows.map((row, index) => {
        if (typeof row.value !== "number") return null;
        const hollow = row.validFraction < LOW_COVERAGE_FRACTION;
        const single = isolated.has(index);
        if (!showPoints && !hollow && selected !== index && !single) return null;
        const x = xPosition(table, row);
        const radius = single ? SINGLE_RADIUS_PX : POINT_RADIUS_PX;

        return (
          <circle
            key={index}
            cx={geometry.xOf(x)}
            cy={geometry.yOf(row.value)}
            r={radius}
            fill={hollow ? "none" : paint}
            stroke={paint}
            strokeWidth={hollow ? HOLLOW_WIDTH_PX : selected === index ? 2 : 0}
          >
            <title>{rowText(table, row, fallbackNames)}</title>
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
        y1={compact ? 0 : MARGIN_TOP_PX}
        y2={compact ? geometry.height : MARGIN_TOP_PX + geometry.plotHeight}
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
      <summary>{"Table"}</summary>
      <div className="chart-table-scroll">
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
      <summary>{"Table"}</summary>
      <div className="chart-table-scroll">
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
      <summary>{"Table"}</summary>
      <div className="chart-table-scroll">
        <p>
          {`Mean ${String(table.mean)}, median ${String(table.median)}, `
            + `lowest cell ${String(table.min)}, highest cell ${String(table.max)}${note}. `
            + `Valid terrain covers ${String(table.validFraction * 100)}% of the outline. `
            + distributionReferences(table)}
        </p>
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

function clampY(y: number, height: number) {
  return Math.min(
    Math.max(y, MIN_ANNOTATION_Y_PX),
    Math.max(MIN_ANNOTATION_Y_PX, height - BOTTOM_ANNOTATION_MARGIN_PX),
  );
}

function clampX(x: number, width: number) {
  return Math.min(
    Math.max(x, MIN_ANNOTATION_X_PX),
    Math.max(MIN_ANNOTATION_X_PX, width - MIN_ANNOTATION_X_PX),
  );
}
