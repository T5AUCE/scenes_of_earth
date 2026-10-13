import type { AreaFeature } from "./types";

type Polygon = number[][][];

/** The area as a MultiPolygon in the world copy where tile features sit, for label filters. */
export type TileArea = ReturnType<typeof tileAreaGeometry>;

export const WORLD_WIDTH_DEG = 360;
const ANTIMERIDIAN_DEG = 180;

/** An area east of 180 is repeated one world west, where tile features sit. */
export function tileAreaGeometry(geometry: AreaFeature["geometry"]) {
  const parts = polygonParts(geometry.type, geometry.coordinates as Polygon | Polygon[]);
  const longitudes = parts.flat(2).map(([longitude]) => longitude);
  const isEastOfAntimeridian = longitudes.some((longitude) => longitude > ANTIMERIDIAN_DEG);
  const shifted = parts.map((part) => shiftPolygon(part, -WORLD_WIDTH_DEG));

  return {
    type: "MultiPolygon" as const,
    coordinates: isEastOfAntimeridian ? [...parts, ...shifted] : parts,
  };
}

/** Text may cross the outline, so roads and rivers crossing it stay; icons must be inside. */
export function areaFilter(filter: unknown, area: TileArea, hasIcon: boolean) {
  const inArea = hasIcon ? ["within", area] : ["<=", ["distance", area], 0];
  return filter ? ["all", filter, inArea] : inArea;
}

/** The polygons of a Polygon or MultiPolygon; other types give none. */
export function polygonParts(type: string, coordinates: Polygon | Polygon[]) {
  if (type === "Polygon") return [coordinates as Polygon];
  if (type === "MultiPolygon") return coordinates as Polygon[];
  return [];
}

function shiftPolygon(polygon: Polygon, degrees: number) {
  return polygon.map((ring) => ring.map(([longitude, ...rest]) => [longitude + degrees, ...rest]));
}
