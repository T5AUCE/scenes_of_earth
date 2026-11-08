export const WORLD_WIDTH_DEG = 360;

type Polygon = number[][][];

/** The polygons of a Polygon or MultiPolygon; other types give none. */
export function polygonParts(type: string, coordinates: Polygon | Polygon[]): Polygon[] {
  if (type === "Polygon") return [coordinates as Polygon];
  if (type === "MultiPolygon") return coordinates as Polygon[];
  return [];
}
