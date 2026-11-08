/** Plan distinct bounded axis labels without rounding stored chart values. */

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

/** Keep tick and reference labels on the same disclosed offset, scale and precision. */
export interface TickPlan {
  labels: string[];
  decimals: number;
  offset: number | null;
  scale: number | null;
  exponentialDigits: number | null;
}

/** Plan scaled deltas from a disclosed base when narrow relative spans need distinct ticks. */
export function tickLabelsFor(domain: readonly [number, number], ticks: number[]): TickPlan {
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

/** Remove exact duplicates so adjacent representable values never repeat SVG keys. */
export function dedupeNumericTicks(ticks: number[]) {
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

/** Format references with the tick plan so their deltas and exponents match the axis. */
export function formatPlanValue(value: number, plan: TickPlan) {
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
