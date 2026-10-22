/** Convert layer values and scene distances between display units while bundles stay native. */
const MM_PER_IN = 25.4;
const DEGF_PER_DEGC = 9 / 5;
const DEGF_AT_ZERO_DEGC = 32;
const METERS_PER_FOOT = 0.3048;

/** Metres in a kilometre, for area arithmetic outside the display helpers. */
export const METERS_PER_KILOMETER = 1000;
const METERS_PER_MILE = 1609.344;
const CELL_ROUNDING_M = 10;
const CELL_ROUNDING_FT = 10;

const MAX_DISPLAY_DECIMALS = 3;
// A power of ten can sit a hair above its logarithm, which would add a spurious decimal.
const LOG_TOLERANCE = 1e-9;

const UNIT_OPTIONS: Record<string, readonly string[]> = {
  "mm/month": ["mm/month", "in/month"],
  "°C": ["°C", "°F"],
  "m": ["m", "ft"],
};

/** The display choices for a bundle's native units, or null when the layer has none. */
export function unitOptions(nativeUnits: string): readonly string[] | null {
  return UNIT_OPTIONS[nativeUnits] ?? null;
}

/** Whether a display unit belongs to a bundle's native units. */
export function isUnitFor(nativeUnits: string, unit: string): boolean {
  return unitOptions(nativeUnits)?.includes(unit) ?? false;
}

/** The stored or linked unit when it belongs to the layer, else the bundle's native units. */
export function displayUnitFor(nativeUnits: string, unit: string | undefined | null): string {
  return unit !== undefined && unit !== null && isUnitFor(nativeUnits, unit)
    ? unit
    : nativeUnits;
}

/** Convert a value from one unit of a pair to the other, leaving unknown pairs unchanged. */
export function convertValue(value: number, fromUnit: string, toUnit: string): number {
  if (fromUnit === toUnit) return value;
  if (fromUnit === "mm/month" && toUnit === "in/month") return value / MM_PER_IN;
  if (fromUnit === "in/month" && toUnit === "mm/month") return value * MM_PER_IN;
  if (fromUnit === "°C" && toUnit === "°F") return value * DEGF_PER_DEGC + DEGF_AT_ZERO_DEGC;
  if (fromUnit === "°F" && toUnit === "°C") return (value - DEGF_AT_ZERO_DEGC) / DEGF_PER_DEGC;
  if (fromUnit === "m" && toUnit === "ft") return value / METERS_PER_FOOT;
  if (fromUnit === "ft" && toUnit === "m") return value * METERS_PER_FOOT;

  return value;
}

/** Convert both ends of a range, keeping the low end first. */
export function convertRange(
  range: readonly [number, number],
  fromUnit: string,
  toUnit: string,
): [number, number] {
  return [
    convertValue(range[0], fromUnit, toUnit),
    convertValue(range[1], fromUnit, toUnit),
  ];
}

/** The decimals that keep a display step as precise as a native one, capped for labels. */
export function displayDecimals(
  nativeDecimals: number,
  nativeUnits: string,
  displayUnit: string,
): number {
  const slope = Math.abs(
    convertValue(1, nativeUnits, displayUnit) - convertValue(0, nativeUnits, displayUnit),
  );
  const resolution = 10 ** -nativeDecimals * slope;
  const decimals = Math.max(0, Math.ceil(-Math.log10(resolution) - LOG_TOLERANCE));

  return Math.min(decimals, MAX_DISPLAY_DECIMALS);
}

/** Convert fitted stops for a legend, rounding to the layer's display precision. */
export function displayStops(
  stops: readonly number[],
  nativeUnits: string,
  displayUnit: string,
  nativeDecimals: number,
): number[] {
  if (nativeUnits === displayUnit) return [...stops];

  // A converted step keeps the precision of a native one, so labels match the editor.
  const decimals = displayDecimals(nativeDecimals, nativeUnits, displayUnit);
  return stops.map(
    (stop) => Number(convertValue(stop, nativeUnits, displayUnit).toFixed(decimals)),
  );
}

/** The MapLibre scale unit matching an elevation display unit. */
export function scaleUnitForElevation(elevationUnit: string): "metric" | "imperial" {
  return usesImperialDistances(elevationUnit) ? "imperial" : "metric";
}

/** A length from metres, favouring kilometres or miles once past one of them. */
export function formatLength(meters: number, elevationUnit: string): string {
  if (usesImperialDistances(elevationUnit)) return formatImperialLength(meters);

  return formatMetricLength(meters);
}

/** An area from square kilometres, in square miles when elevation displays in feet. */
export function formatArea(areaKm2: number, elevationUnit: string): string {
  if (usesImperialDistances(elevationUnit)) {
    const areaMi2 = areaKm2 / (METERS_PER_MILE / METERS_PER_KILOMETER) ** 2;
    return `${Math.round(areaMi2).toLocaleString("en")} mi²`;
  }

  return `${Math.round(areaKm2).toLocaleString("en")} km²`;
}

/** Whether scene distances use miles because elevation displays in feet. */
export function usesImperialDistances(elevationUnit: string): boolean {
  return elevationUnit === "ft";
}

function formatMetricLength(meters: number): string {
  if (meters >= METERS_PER_KILOMETER) {
    return `${Number((meters / METERS_PER_KILOMETER).toPrecision(2))} km`;
  }

  return `${Math.round(meters / CELL_ROUNDING_M) * CELL_ROUNDING_M} m`;
}

function formatImperialLength(meters: number): string {
  if (meters >= METERS_PER_MILE) {
    return `${Number((meters / METERS_PER_MILE).toPrecision(2))} mi`;
  }

  const feet = meters / METERS_PER_FOOT;
  return `${Math.round(feet / CELL_ROUNDING_FT) * CELL_ROUNDING_FT} ft`;
}
