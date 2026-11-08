/**
 * Builds a world-wide mask polygon with the scene area cut out of it.
 *
 * MapLibre tiles the polygon with geojson-vt and then decides which rings are holes only from
 * their winding. Quantising a tiny island to the tile grid can flip that winding, which makes
 * every later hole (the mainland) part of the wrong polygon and fills the tile white over the
 * area. A hole that touches the clipped tile box on several sides is also dropped by earcut. So
 * the mask has no holes at all. Each island is joined to the ring around it by a zero-width
 * slit, and the result is one ring. Lakes use the same slit with the lake as the outer ring, so
 * nested islands stay cut out.
 */

const HALF_WORLD_DEG = 180;
// The world ring stops here because Web Mercator tiles end at this latitude.
const MAX_LATITUDE_DEG = 85.051129;
// An empty area centres the world at Greenwich so the mask still builds.
const EMPTY_CENTRE_DEG = 0;

type Position = number[];
type Ring = Position[];

/**
 * Returns one closed ring that covers the world outside the given areas.
 * Islands join from the north so that no slit crosses an island that is not yet joined.
 */
export function maskRing(islands: Ring[]): Ring {
  const world = worldRing(islands);
  const canonical = Math.sign(signedArea(world));

  return keyholeRing(world, islands, canonical);
}

/**
 * Returns the world mask plus one mask polygon per lake, with nested islands cut back out.
 * Every water polygon keeps the world winding so MapLibre paints it as a separate polygon.
 */
export function buildMaskRings(exteriors: Ring[], interiors: Ring[]): Ring[] {
  const parents = parentIndex([...exteriors, ...interiors]);
  const topLevel = exteriors.filter((ring) => parents.get(ring) === null);
  const centred = topLevel.length > 0 ? topLevel : exteriors;
  const world = worldRing(centred.length > 0 ? centred : interiors);
  const canonical = Math.sign(signedArea(world));
  const worldKeyhole = keyholeRing(world, topLevel, canonical);
  const lakeKeyholes = interiors.map((lake) => {
    const children = exteriors.filter((land) => parents.get(land) === lake);

    return keyholeRing(lake, children, canonical);
  });

  return [worldKeyhole, ...lakeKeyholes];
}

function parentIndex(rings: Ring[]): Map<Ring, Ring | null> {
  const parents = new Map<Ring, Ring | null>();
  for (const ring of rings) parents.set(ring, parentOf(ring, rings));

  return parents;
}

function parentOf(ring: Ring, candidates: Ring[]): Ring | null {
  let parent: Ring | null = null;
  let parentArea = Infinity;
  for (const candidate of candidates) {
    if (candidate === ring) continue;
    if (!isInsideRing(candidate, ring[0])) continue;
    const area = Math.abs(signedArea(candidate));
    if (area < parentArea) {
      parent = candidate;
      parentArea = area;
    }
  }

  return parent;
}

function isInsideRing(outer: Ring, point: Position): boolean {
  let inside = false;
  for (let i = 0, j = outer.length - 1; i < outer.length; j = i++) {
    const [x1, y1] = outer[i];
    const [x2, y2] = outer[j];
    if (y1 > point[1] === y2 > point[1]) continue;
    const crossing = x1 + ((point[1] - y1) / (y2 - y1)) * (x2 - x1);
    if (crossing > point[0]) inside = !inside;
  }

  return inside;
}

// The ring is one world wide and centred on the area, as MapLibre cannot cut holes in a wider one.
function worldRing(islands: Ring[]): Ring {
  let westmost = Infinity;
  let eastmost = -Infinity;
  for (const ring of islands) {
    for (const [longitude] of ring) {
      if (longitude < westmost) westmost = longitude;
      if (longitude > eastmost) eastmost = longitude;
    }
  }
  const centre = westmost <= eastmost ? (westmost + eastmost) / 2 : EMPTY_CENTRE_DEG;
  const west = centre - HALF_WORLD_DEG;
  const east = centre + HALF_WORLD_DEG;

  return [
    [west, -MAX_LATITUDE_DEG],
    [east, -MAX_LATITUDE_DEG],
    [east, MAX_LATITUDE_DEG],
    [west, MAX_LATITUDE_DEG],
    [west, -MAX_LATITUDE_DEG],
  ];
}

function keyholeRing(outer: Ring, inners: Ring[], canonical: number): Ring {
  const outerPoints = openRing(outer);
  if (Math.sign(signedArea(outerPoints)) !== canonical) outerPoints.reverse();
  const ordered = inners
    .map((ring) => openRing(ring))
    .map((points) => (Math.sign(signedArea(points)) === canonical ? points.reverse() : points))
    .map((points) => startAtNorth(points))
    .sort((a, b) => b[0][1] - a[0][1]);
  let ring = outerPoints;
  for (const island of ordered) ring = joinIsland(ring, island);

  return [...ring, ring[0]];
}

const openRing = (ring: Ring): Ring => ring.slice(0, -1);

function startAtNorth(points: Ring): Ring {
  let north = 0;
  for (let i = 1; i < points.length; i++) {
    if (points[i][1] > points[north][1]) north = i;
  }

  return [...points.slice(north), ...points.slice(0, north)];
}

// A due-north slit from the northernmost vertex cannot cross the island itself.
function joinIsland(ring: Ring, island: Ring): Ring {
  const start = island[0];
  let slitY = Infinity;
  let edge = -1;
  for (let i = 0; i < ring.length; i++) {
    const a = ring[i];
    const b = ring[(i + 1) % ring.length];
    if (a[0] === b[0]) continue;
    if (start[0] < Math.min(a[0], b[0]) || start[0] >= Math.max(a[0], b[0])) continue;
    const y = a[1] + ((start[0] - a[0]) / (b[0] - a[0])) * (b[1] - a[1]);
    if (y > start[1] && y < slitY) {
      slitY = y;
      edge = i;
    }
  }
  if (edge < 0) throw new Error("Mask island has no ring above it");

  const top = [start[0], slitY];

  return [
    ...ring.slice(0, edge + 1),
    top,
    ...island,
    start,
    top,
    ...ring.slice(edge + 1),
  ];
}

function signedArea(points: Ring): number {
  let sum = 0;
  for (let i = 0, j = points.length - 1; i < points.length; j = i++) {
    sum += (points[j][0] - points[i][0]) * (points[i][1] + points[j][1]);
  }

  return sum;
}
