/**
 * Builds the ring that covers the world outside the scene area for the `within` label clip.
 *
 * The map mask is drawn on the GPU, so this ring only feeds MapLibre's tiled filter until the
 * label clip is replaced. That filter decides holes from winding alone, so the ring has no
 * holes. Each island is joined to the ring around it by a zero-width slit.
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
