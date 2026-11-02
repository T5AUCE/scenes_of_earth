/** Saved chart definitions with metadata-driven defaults, hints and validation. */
import { inkColor } from "../render/palettes";
import type { LayerDoc } from "../types";
import { isUnitFor } from "../units";
import {
  buildDistributionTable,
  buildSeasonalCycle,
  buildTimeSeries,
  isDistributionLayer,
  isSeasonalEligible,
  isTimeSeriesLayer,
} from "./series";
import {
  isChartType,
  isContinuousShape,
  type ChartShape,
  type ChartTable,
  type ChartType,
} from "./table";
import {
  densityHint,
  isOffsetUnits,
  offsetFillWarning,
  quantileBarHint,
  validateYRange,
} from "./ticks";

/** The source shapes a saved chart may use; categorical shares stay reserved. */
export type SupportedShape = "time_series" | "seasonal_cycle" | "distribution";

/** Radix and slice bounds for short random chart ids that stay URL safe. */
const ID_RADIX = 36;
const ID_START = 2;
const ID_END = 10;

/** Where a saved chart reads its numbers from, never a copied array or image. */
export interface ChartSource {
  layerId: string;
  shape: SupportedShape;
}

/** Display choices of one saved chart; the reducer and observations stay untouched. */
export interface ChartOptions {
  ink?: string; // follow the layer while absent, else a preset name or #rrggbb
  displayUnit?: string; // follow the viewer while absent, else a compatible explicit unit
  xTitle?: string;
  yTitle?: string;
  yRange?: [number, number] | null; // automatic while absent, explicit in canonical units
  showGrid?: boolean;
  showPoints?: boolean;
  showCurrentTime?: boolean;
  showReferences?: boolean;
}

/** One saved chart; the id survives title and type edits. */
export interface ChartDefinition {
  id: string;
  title: string;
  source: ChartSource;
  chartType: ChartType;
  options: ChartOptions;
}

/** A derived placeholder for a missing default source, never a saved definition. */
export interface UnavailableTemplate {
  shape: SupportedShape;
  title: string;
  reason: string;
}

/** The most definitions one scene keeps in a slice or a share link. */
export const MAX_DEFINITIONS = 32;

/** The most characters in a chart or axis title, to keep links short and text safe. */
export const MAX_TITLE_CHARS = 120;

const SUM_METHOD = "sum";
const SEA_LEVEL_ID = "sea_level";

/** Whether a shape can be saved in v1; categorical shares are reserved for later. */
export function isSupportedShape(shape: unknown): shape is SupportedShape {
  return shape === "time_series" || shape === "seasonal_cycle" || shape === "distribution";
}

/** The default type follows the period method for timed charts and area for hypsometry. */
export function defaultChartTypeFor(shape: SupportedShape, method: string | null): ChartType {
  if (shape === "distribution") return "area";

  return method === SUM_METHOD ? "bar" : "line";
}

/** Every shipped type is allowed for every continuous shape, with a hint where it fits badly. */
export function allowedTypesFor(shape: ChartShape): ChartType[] {
  return isContinuousShape(shape) ? ["line", "bar", "area"] : [];
}

/**
 * Why the chosen type fits badly, or null when it needs no hint. Hints never hide an allowed
 * type; unsupported shapes and types are rejected by validation instead.
 */
export function hintFor(
  shape: SupportedShape,
  chartType: ChartType,
  nativeUnits: string,
  rowCount: number,
): string | null {
  return quantileBarHint(shape, chartType)
    ?? offsetFillWarning(nativeUnits, chartType)
    ?? (chartType === "bar" ? densityHint(rowCount) : null);
}

/** The v2 appearance a new chart starts from. */
export function defaultOptionsFor(): ChartOptions {
  return { showGrid: true, showPoints: false, showCurrentTime: true, showReferences: true };
}

/** Seed one time chart per timed layer and one hypsometry chart per distribution layer. */
export function defaultDefinitions(layers: readonly LayerDoc[]): ChartDefinition[] {
  const definitions: ChartDefinition[] = [];
  for (const layer of layers) {
    if (isTimeSeriesLayer(layer)) {
      const shape: SupportedShape = "time_series";
      definitions.push({
        id: defaultId(layer.id, shape),
        title: `${layer.title} over time`,
        source: { layerId: layer.id, shape },
        chartType: defaultChartTypeFor(shape, layer.time?.method ?? null),
        options: defaultOptionsFor(),
      });
    }
  }
  for (const layer of layers) {
    if (isDistributionLayer(layer)) {
      const shape: SupportedShape = "distribution";
      definitions.push({
        id: defaultId(layer.id, shape),
        title: `${layer.title} distribution`,
        source: { layerId: layer.id, shape },
        chartType: defaultChartTypeFor(shape, null),
        options: defaultOptionsFor(),
      });
    }
  }

  return definitions;
}

function defaultId(layerId: string, shape: SupportedShape) {
  return `${layerId}:${shape}`;
}

/** Placeholders for missing default sources, with no fabricated observations. */
export function unavailableTemplates(layers: readonly LayerDoc[]): UnavailableTemplate[] {
  const templates: UnavailableTemplate[] = [];
  const hasAccumulation = layers.some(
    (layer) => isTimeSeriesLayer(layer) && layer.time?.method === SUM_METHOD,
  );
  if (!hasAccumulation) {
    templates.push({
      shape: "time_series",
      title: "No rainfall accumulation",
      reason: "This scene has no accumulation over time to chart.",
    });
  }

  const hasOffsetSeries = layers.some(
    (layer) => isTimeSeriesLayer(layer) && isOffsetUnits(layer.units),
  );
  if (!hasOffsetSeries) {
    templates.push({
      shape: "time_series",
      title: "No temperature series",
      reason: "This scene has no temperature-like series to chart.",
    });
  }

  const hasDistribution = layers.some((layer) => isDistributionLayer(layer));
  if (!hasDistribution) {
    templates.push({
      shape: "distribution",
      title: "No elevation distribution",
      reason: "This scene has no terrain distribution to draw.",
    });
  }

  return templates;
}

/** Whether New chart can run, with the reason shown when the scene has nothing to draw. */
export function creationAvailability(layers: readonly LayerDoc[]) {
  const allowed = layers.some((layer) =>
    isTimeSeriesLayer(layer) || isSeasonalEligible(layer) || isDistributionLayer(layer),
  );

  return {
    allowed,
    reason: allowed ? null : "This scene has no chartable layer yet.",
  };
}

/**
 * The main chart to show. A null request seeds the initial main with rainfall preference,
 * while a missing id repairs to the first available definition. Valid ids stay unchanged.
 */
export function resolveMainId(
  definitions: readonly ChartDefinition[],
  mainChartId: string | null,
  layers: readonly LayerDoc[],
): string | null {
  if (definitions.some((definition) => definition.id === mainChartId)) return mainChartId;
  if (mainChartId !== null) return definitions[0]?.id ?? null;

  return initialMainId(definitions, layers);
}

function initialMainId(
  definitions: readonly ChartDefinition[],
  layers: readonly LayerDoc[],
) {
  const byId = new Map(layers.map((layer) => [layer.id, layer]));
  const rainfall = definitions.find(
    (definition) => byId.get(definition.source.layerId)?.time?.method === SUM_METHOD,
  );

  return rainfall?.id ?? definitions[0]?.id ?? null;
}

/** A fresh id that does not collide with the slice; edits keep the old id. */
export function newChartId(existing: readonly string[]) {
  const taken = new Set(existing);
  while (true) {
    const candidate = `c${Math.random().toString(ID_RADIX).slice(ID_START, ID_END)}`;
    if (!taken.has(candidate)) return candidate;
  }
}

/**
 * Why a definition cannot be saved, or null when it is valid. Ranges stay in canonical units
 * and must include every observed value plus the bar or area baseline and visible references.
 */
export function validateDefinition(
  definition: unknown,
  layers: readonly LayerDoc[],
  table?: ChartTable | null,
): string | null {
  if (typeof definition !== "object" || definition === null) return "The chart is not an object.";
  if (Array.isArray(definition)) return "The chart is not an object.";
  const { id, title, source, chartType, options } = definition as Partial<ChartDefinition>;
  if (typeof id !== "string" || id.length === 0) return "The chart needs an id.";
  if (typeof title !== "string" || title.length === 0) return "The chart needs a title.";
  if (title.length > MAX_TITLE_CHARS) return "The chart title is too long.";
  if (typeof source !== "object" || source === null || Array.isArray(source)) {
    return "The chart needs a source.";
  }
  if (!isSupportedShape((source as ChartSource).shape)) return "The chart shape is not supported.";
  if (!isChartType(chartType)) return "The chart type is not supported.";

  const byId = new Map(layers.map((layer) => [layer.id, layer]));
  const layer = byId.get((source as ChartSource).layerId);
  if (!layer) return "The chart source layer is missing.";
  const shape = (source as ChartSource).shape;
  if (shape === "time_series" && !isTimeSeriesLayer(layer)) {
    return "The layer has no time series to chart.";
  }
  if (shape === "seasonal_cycle" && !isSeasonalEligible(layer)) {
    return "The layer needs 24 monthly steps for a By month chart.";
  }
  if (shape === "distribution" && !isDistributionLayer(layer)) {
    return "The layer has no distribution to chart.";
  }
  if (!allowedTypesFor(shape).includes(chartType!)) {
    return "The chart type is not supported for this shape.";
  }
  if (
    options === undefined
    || options === null
    || typeof options !== "object"
    || Array.isArray(options)
  ) {
    return "The chart options are not an object.";
  }

  let validationTable = table ?? null;
  if (validationTable === null) {
    try {
      validationTable = canonicalTableFor(layer, shape);
    } catch {
      return "The chart source has no table to validate.";
    }
  }

  return validateOptions(options, layer.units, chartType!, shape, validationTable);
}

/**
 * The canonical source table for validation, reusing the pure builders instead of duplicating
 * seasonal arithmetic. Ranges are always checked against these exact observations.
 */
export function canonicalTableFor(layer: LayerDoc, shape: SupportedShape): ChartTable {
  if (shape === "time_series") return buildTimeSeries(layer);
  if (shape === "seasonal_cycle") return buildSeasonalCycle(layer);

  return buildDistributionTable(layer);
}

function validateOptions(
  options: ChartOptions,
  nativeUnits: string,
  chartType: ChartType,
  shape: SupportedShape,
  table: ChartTable,
): string | null {
  if (typeof options !== "object" || options === null || Array.isArray(options)) {
    return "The chart options are not an object.";
  }
  if (options.ink !== undefined) {
    if (typeof options.ink !== "string" || inkColor(options.ink) === undefined) {
      return "The series ink is not a preset or #rrggbb colour.";
    }
  }
  if (options.displayUnit !== undefined && !isUnitFor(nativeUnits, options.displayUnit)) {
    return "The display unit does not belong to this layer.";
  }
  for (const title of [options.xTitle, options.yTitle]) {
    if (title !== undefined && (typeof title !== "string" || title.length > MAX_TITLE_CHARS)) {
      return "An axis title is too long.";
    }
  }
  for (const flag of [
    options.showGrid,
    options.showPoints,
    options.showCurrentTime,
    options.showReferences,
  ]) {
    if (flag !== undefined && typeof flag !== "boolean") return "A chart toggle is not a boolean.";
  }

  const references = options.showReferences === false
    ? []
    : visibleReferencesFor(shape, table);
  const rangeError = validateYRange(options.yRange ?? null, table, chartType, references);
  if (rangeError) return rangeError;

  return null;
}

function visibleReferencesFor(shape: SupportedShape, table: ChartTable) {
  if (shape !== "distribution" || table.shape !== "distribution") return [];

  const references = [{ id: "mean", value: table.mean }, { id: "median", value: table.median }];
  for (const reference of table.referenceValues) {
    if (reference.id === SEA_LEVEL_ID) references.push(reference);
  }

  return references;
}
