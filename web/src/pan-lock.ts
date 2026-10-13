/** How far the centre may stray from the fitted centre; zero at or below the fitted zoom. */
export function panLimit(fittedSpan: number, fittedZoom: number, zoom: number) {
  const visibleFraction = 2 ** (fittedZoom - zoom);
  return Math.max(0, (fittedSpan * (1 - visibleFraction)) / 2);
}

/** The value held within limit of around. */
export function clampAround(value: number, around: number, limit: number) {
  return Math.min(around + limit, Math.max(around - limit, value));
}

/** The value shifted by whole periods to lie closest to the reference, e.g. a longitude by 360. */
export function nearestEquivalent(value: number, reference: number, period: number) {
  return value + period * Math.round((reference - value) / period);
}
