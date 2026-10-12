import type { AreaFeature } from "./types";

type Polygon = number[][][];

export type TileArea = ReturnType<typeof tileAreaGeometry>;

const WORLD_WIDTH_DEGREES = 360;
const ANTIMERIDIAN_DEGREES = 180;

// An area east of 180 is repeated one world west, where tile features sit.
export function tileAreaGeometry(geometry: AreaFeature["geometry"]) {
  const parts = polygonParts(geometry.type, geometry.coordinates as Polygon | Polygon[]);
  const longitudes = parts.flat(2).map(([longitude]) => longitude);
  const isEastOfAntimeridian = longitudes.some((longitude) => longitude > ANTIMERIDIAN_DEGREES);
  const shifted = parts.map((part) => shiftPolygon(part, -WORLD_WIDTH_DEGREES));

  return {
    type: "MultiPolygon" as const,
    coordinates: isEastOfAntimeridian ? [...parts, ...shifted] : parts,
  };
}

// Text may cross the outline, so roads and rivers that merely cross it stay; icons must be inside.
export function areaFilter(filter: unknown, area: TileArea, hasIcon: boolean) {
  const inArea = hasIcon ? ["within", area] : ["<=", ["distance", area], 0];

  return filter ? ["all", filter, inArea] : inArea;
}

export function polygonParts(type: string, coordinates: Polygon | Polygon[]) {
  if (type === "Polygon") return [coordinates as Polygon];
  if (type === "MultiPolygon") return coordinates as Polygon[];

  return [];
}

function shiftPolygon(polygon: Polygon, degrees: number) {
  return polygon.map((ring) => ring.map(([longitude, ...rest]) => [longitude + degrees, ...rest]));
}
