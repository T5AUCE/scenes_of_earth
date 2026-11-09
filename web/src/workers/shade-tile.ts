/** Shade one DEM tile into neutral RGBA the way MapLibre's multidirectional hillshade does. */
import { reliefExaggeration, RELIEF_LIGHTS } from "../layers/relief";

/** One slippy-map tile. */
export interface ShadeTileId {
  z: number;
  x: number;
  y: number;
}

/** Load one DEM tile as metres row by row, or null when the tile does not exist. */
export type LoadHeights = (tile: ShadeTileId) => Promise<Float32Array | null>;

const MISSING_TILE_PREFIX = "Bad response: 404";

// MapLibre's prepare pass writes slopes as slope / 8 + 128 / 255 into 8-bit channels.
const SLOPE_RANGE = 8;
const FLAT_SLOPE_LEVEL = 128 / 255;
const MAX_BYTE = 255;
// The prepare pass divides slopes by 2^(28.2562 - zoom), the metres of one pixel at that zoom.
const PIXEL_SIZE_OFFSET = 28.2562;
const EXAGGERATION_END_ZOOM = 15;

/**
 * Shade a tile with a one-pixel border read from its eight neighbours, so adjacent tiles meet
 * without a seam. Returns straight-alpha RGBA bytes for the tile, which hold the same colours
 * as the hillshade layer for the same strength and zoom.
 */
export async function shadeTile(
  tile: ShadeTileId,
  strength: number,
  loadHeights: LoadHeights,
): Promise<Uint8ClampedArray<ArrayBuffer>> {
  const neighbours = await Promise.all(
    [-1, 0, 1].flatMap((dy) => [-1, 0, 1].map((dx) => loadNeighbour(tile, dx, dy, loadHeights))),
  );
  const own = neighbours[4];
  if (!own) throw new Error(`${MISSING_TILE_PREFIX} for tile ${tile.z}/${tile.x}/${tile.y}`);

  const size = Math.round(Math.sqrt(own.length));
  const padded = padHeights(neighbours, size);
  return shadePadded(padded, size, tile, strength);
}

/** Decode terrarium RGBA pixels to metres. */
export function decodeHeights(rgba: Uint8ClampedArray): Float32Array {
  const heights = new Float32Array(rgba.length / 4);
  for (let index = 0; index < heights.length; index++) {
    const red = rgba[index * 4];
    const green = rgba[index * 4 + 1];
    const blue = rgba[index * 4 + 2];
    heights[index] = red * 256 + green + blue / 256 - 32768;
  }
  return heights;
}

function loadNeighbour(
  tile: ShadeTileId,
  dx: number,
  dy: number,
  loadHeights: LoadHeights,
): Promise<Float32Array | null> {
  const count = 2 ** tile.z;
  const y = tile.y + dy;
  if (y < 0 || y >= count) return Promise.resolve(null);

  return loadHeights({ z: tile.z, x: (tile.x + dx + count) % count, y });
}

/**
 * Surround the tile with one pixel of its neighbours' edges. Missing neighbours repeat the
 * tile's own edge pixel, which is what MapLibre does at the edge of the data.
 */
function padHeights(neighbours: (Float32Array | null)[], size: number): Float32Array {
  const stride = size + 2;
  const own = neighbours[4]!;
  const padded = new Float32Array(stride * stride);
  for (let row = 0; row < size; row++) {
    padded.set(own.subarray(row * size, (row + 1) * size), (row + 1) * stride + 1);
  }
  for (let py = -1; py <= size; py++) {
    const isEdgeRow = py < 0 || py >= size;
    const step = isEdgeRow ? 1 : size + 1;
    for (let px = -1; px <= size; px += step) {
      padded[(py + 1) * stride + px + 1] = borderHeight(neighbours, size, px, py);
    }
  }
  return padded;
}

function borderHeight(
  neighbours: (Float32Array | null)[],
  size: number,
  px: number,
  py: number,
): number {
  const column = px < 0 ? 0 : px >= size ? 2 : 1;
  const row = py < 0 ? 0 : py >= size ? 2 : 1;
  const neighbour = neighbours[row * 3 + column];
  if (neighbour) return neighbour[((py + size) % size) * size + ((px + size) % size)];

  const own = neighbours[4]!;
  return own[Math.min(Math.max(py, 0), size - 1) * size + Math.min(Math.max(px, 0), size - 1)];
}

function shadePadded(
  padded: Float32Array,
  size: number,
  tile: ShadeTileId,
  strength: number,
): Uint8ClampedArray<ArrayBuffer> {
  const stride = size + 2;
  const slopeScale = size / 2 ** (prepareExaggeration(tile.z) + PIXEL_SIZE_OFFSET - tile.z);
  const exaggeration = reliefExaggeration(tile.z, strength);
  const lights = RELIEF_LIGHTS.map((light) => lightTerms(light));
  const pixels = new Uint8ClampedArray(size * size * 4);
  for (let row = 0; row < size; row++) {
    const slopeFactor = exaggeration * 2 / latitudeScale(tile, (row + 0.5) / size);
    for (let column = 0; column < size; column++) {
      const centre = (row + 1) * stride + column + 1;
      const a = padded[centre - stride - 1];
      const b = padded[centre - stride];
      const c = padded[centre - stride + 1];
      const d = padded[centre - 1];
      const f = padded[centre + 1];
      const g = padded[centre + stride - 1];
      const h = padded[centre + stride];
      const i = padded[centre + stride + 1];
      const slopeX = storedSlope((c + f + f + i - (a + d + d + g)) * slopeScale) * slopeFactor;
      const slopeY = storedSlope((g + h + h + i - (a + b + b + c)) * slopeScale) * slopeFactor;
      writeShade(pixels, (row * size + column) * 4, lights, slopeX, slopeY);
    }
  }
  return pixels;
}

function prepareExaggeration(zoom: number): number {
  if (zoom >= EXAGGERATION_END_ZOOM) return 0;

  const factor = zoom < 2 ? 0.4 : zoom < 4.5 ? 0.35 : 0.3;
  return (zoom - EXAGGERATION_END_ZOOM) * factor;
}

/** Round a slope the way the prepare pass's 8-bit channel does. */
function storedSlope(slope: number): number {
  const level = Math.min(Math.max(slope / SLOPE_RANGE + FLAT_SLOPE_LEVEL, 0), 1);
  return (Math.round(level * MAX_BYTE) / MAX_BYTE - FLAT_SLOPE_LEVEL) * SLOPE_RANGE;
}

/** MapLibre divides slopes by the cosine of a latitude that runs linearly down the tile. */
function latitudeScale(tile: ShadeTileId, fractionDown: number): number {
  const count = 2 ** tile.z;
  const north = tileLatitude(tile.y / count);
  const south = tileLatitude((tile.y + 1) / count);
  const latitude = (north - south) * (1 - fractionDown) + south;
  return Math.cos(latitude * Math.PI / 180);
}

function tileLatitude(fraction: number): number {
  return Math.atan(Math.sinh(Math.PI * (1 - 2 * fraction))) * 180 / Math.PI;
}

interface LightTerms {
  sinAltitude: number;
  slopeXTerm: number;
  slopeYTerm: number;
  shadowAlpha: number;
  highlightAlpha: number;
}

function lightTerms(light: (typeof RELIEF_LIGHTS)[number]): LightTerms {
  const altitude = light.altitudeDeg * Math.PI / 180;
  const azimuth = light.azimuthDeg * Math.PI / 180;
  return {
    sinAltitude: Math.sin(altitude),
    slopeXTerm: -Math.sin(azimuth) * Math.cos(altitude),
    slopeYTerm: -Math.cos(azimuth) * Math.cos(altitude),
    shadowAlpha: light.shadowAlpha / RELIEF_LIGHTS.length,
    highlightAlpha: light.highlightAlpha / RELIEF_LIGHTS.length,
  };
}

/**
 * Add the lights the way the shader does and store straight colour. Shadows are black and
 * highlights white, so the premultiplied white sum divided by the alpha is the grey level.
 */
function writeShade(
  pixels: Uint8ClampedArray,
  offset: number,
  lights: readonly LightTerms[],
  slopeX: number,
  slopeY: number,
): void {
  const steepness = Math.sqrt(1 + slopeX * slopeX + slopeY * slopeY);
  let alpha = 0;
  let white = 0;
  for (const light of lights) {
    const angle = (light.sinAltitude - slopeY * light.slopeYTerm + slopeX * light.slopeXTerm)
      / steepness;
    const shade = Math.min(Math.max(angle, 0), 1);
    if (shade > 0.5) {
      const highlight = light.highlightAlpha * (2 * shade - 1);
      alpha += highlight;
      white += highlight;
    } else {
      alpha += light.shadowAlpha * (1 - 2 * shade);
    }
  }
  if (alpha === 0) return;

  const level = Math.round(white / alpha * MAX_BYTE);
  pixels[offset] = level;
  pixels[offset + 1] = level;
  pixels[offset + 2] = level;
  pixels[offset + 3] = Math.round(alpha * MAX_BYTE);
}
