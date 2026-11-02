/** Prepare terrain distributions for the shared SVG renderer. */
import { contourColor, inkColor } from "../render/palettes";
import type { LayerDoc } from "../types";
import { convertValue, displayUnitFor } from "../units";
import { hintFor, type ChartOptions } from "./definitions";
import { buildDistributionTable } from "./series";
import { SvgChart } from "./svg-chart";
import { finiteValues, toDisplayTable, type ChartType } from "./table";
import { baselineFor } from "./ticks";

/** Props of a hypsometry chart; the table stays derived from the layer. */
export interface HypsometryChartProps {
  layer: LayerDoc;
  chartType: ChartType;
  options: ChartOptions;
  compact?: boolean;
  height_PX?: number;
  showTable?: boolean;
  viewerUnit?: string | null;
  effectivePalette?: string | null;
  effectiveInk?: string | null;
}

/**
 * Draw a hypsometry curve with exact quantiles and honest references. The x axis shows the
 * share at or above each height, so sea level and endpoints stay readable without resampling.
 */
export function HypsometryChart({
  layer,
  chartType,
  options,
  compact = false,
  height_PX,
  showTable,
  viewerUnit = null,
  effectivePalette = null,
  effectiveInk = null,
}: HypsometryChartProps): React.ReactElement {
  const canonical = buildDistributionTable(layer);
  const displayUnit = displayUnitFor(layer.units, options.displayUnit ?? viewerUnit);
  const converted = toDisplayTable(canonical, displayUnit, options.yTitle);
  const display = {
    ...converted,
    xTitle: options.xTitle ?? "Share of valid area at or above (%)",
  };
  const hint = hintFor("distribution", chartType, layer.units, display.rows.length);
  const mean = String(convertValue(canonical.mean, layer.units, displayUnit));
  const baseline = convertedBaseline(canonical, chartType, layer.units, displayUnit);
  const heading = `${layer.title} · Hypsometry · mean ${mean} ${displayUnit}`;

  return (
    <figure className="hypsometry-chart">
      <figcaption>{heading}</figcaption>
      <SvgChart
        table={display}
        chartType={chartType}
        ink={hypsometryInkFor(options.ink, effectivePalette, effectiveInk)}
        showGrid={options.showGrid ?? true}
        showPoints={options.showPoints ?? false}
        showCurrentTime={false}
        showReferences={options.showReferences ?? true}
        currentTime={null}
        yRange={displayRange(options.yRange, layer.units, displayUnit)}
        height_PX={height_PX}
        compact={compact}
        showTable={showTable ?? !compact}
        fallbackNames={null}
        resolutionNote={resolutionNoteFor(layer)}
        baseline={baseline}
      />
      {hint && <p className="chart-hint">{hint}</p>}
      <p className="chart-note">
        {coverageText(canonical.validFraction, canonical.referenceValues)}
      </p>
    </figure>
  );
}

// Validation and drawing must share one baseline, so convert the canonical requirement.
function convertedBaseline(
  table: ReturnType<typeof buildDistributionTable>,
  chartType: ChartType,
  nativeUnits: string,
  displayUnit: string,
) {
  const values = finiteValues(table);
  const minimum = values.length > 0 ? Math.min(...values) : null;
  const canonical = baselineFor(chartType, minimum);
  if (canonical === null) return null;

  return convertValue(canonical, nativeUnits, displayUnit);
}

/** Neutral grey keeps hypsometry separate from the map palettes until the viewer picks an ink. */
export function hypsometryInkFor(
  ink: string | undefined,
  effectivePalette?: string | null,
  effectiveInk?: string | null,
) {
  if (ink !== undefined) return inkColor(ink) ?? "#6e6e6e";
  if (effectiveInk) return inkColor(effectiveInk) ?? "#6e6e6e";
  if (effectivePalette) return contourColor(effectivePalette) ?? "#6e6e6e";

  return "#6e6e6e";
}

function resolutionNoteFor(layer: LayerDoc) {
  const res = layer.grid?.res;
  if (typeof res !== "number" || !Number.isFinite(res)) return null;

  return `${String(res)}° analysis grid`;
}

function displayRange(
  range: [number, number] | null | undefined,
  nativeUnits: string,
  displayUnit: string,
): [number, number] | null {
  if (!range) return null;

  return [
    convertValue(range[0], nativeUnits, displayUnit),
    convertValue(range[1], nativeUnits, displayUnit),
  ];
}

function coverageText(validFraction: number, references: { id: string }[]) {
  const excluded = String((1 - validFraction) * 100);
  const curve = "The curve joins stored 1% quantiles, so values between knots are approximate, "
    + "while the mean comes from weighted cells directly.";
  const coverage = `Valid terrain covers ${String(validFraction * 100)}% of the outline; `
    + `the other ${excluded}% is ocean or missing data and is excluded. ${curve}`;
  if (references.some((reference) => reference.id === "sea_level")) {
    return `${coverage} Sea level marks 0 m where the bundle emitted it because valid heights `
      + `span zero or the outline overlaps a coarse ocean tile.`;
  }

  return `${coverage} No sea-level reference was emitted for this bundle, which means neither `
    + `condition held and proves nothing about a coastline.`;
}
