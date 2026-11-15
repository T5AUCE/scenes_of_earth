/** Fetch and decode a Terrarium DEM tile into heights and the edge strips neighbours need. */

/** The side length of every DEM tile in pixels. */
export const DEM_TILE_SIZE_PX = 512;
/** How many rows or columns of a tile's edge each neighbour reads. */
export const STRIP_WIDTH_PX = 2;

/** One edge of a tile; the strip of a side holds the tile's own outermost pixels there. */
export type StripSide = "top" | "bottom" | "left" | "right";

/** A decoded tile with heights in metres row by row and the four edge strips. */
export interface DemTileData {
  heights: Float32Array;
  strips: Float32Array;
  decodeMs: number;
}

const MISSING_TILE_STATUS = 404;
const STRIP_SIDES: StripSide[] = ["top", "bottom", "left", "right"];
const STRIP_LENGTH = DEM_TILE_SIZE_PX * STRIP_WIDTH_PX;

const BYTES_PER_PIXEL = 4;
const TERRARIUM_RADIX = 256;
const TERRARIUM_OFFSET_M = 32768;

const ALTERED_CANVAS_WARNING =
  "DEM canvas readback altered colours, so tiles need VideoFrame "
  + "bytes and fail where it is unavailable. This usually comes from a browser privacy or "
  + "anti-fingerprinting setting or an extension.";

let canvasAltersBytes: boolean | null = null;
let integrityWarningPosted = false;

/** Load a tile, or null when the server has none; throws on any other failure. */
export async function loadDemTile(url: string, signal: AbortSignal): Promise<DemTileData | null> {
  const decoded = await fetchHeights(url, signal);
  if (!decoded) return null;

  const { heights, decodeMs } = decoded;
  if (heights.length !== DEM_TILE_SIZE_PX ** 2) {
    throw new Error(`Unexpected tile size ${Math.sqrt(heights.length)} px for ${url}`);
  }

  return { heights, strips: edgeStrips(heights), decodeMs };
}

async function fetchHeights(
  url: string,
  signal: AbortSignal,
): Promise<{ heights: Float32Array; decodeMs: number } | null> {
  const response = await fetch(url, { signal });
  if (response.status === MISSING_TILE_STATUS) return null;
  if (!response.ok) throw new Error(`Bad response: ${response.status} for ${url}`);

  const start = performance.now();
  const bitmap = await createImageBitmap(await response.blob(), {
    premultiplyAlpha: "none",
    colorSpaceConversion: "none",
  });

  try {
    const rgba = await extractBitmapRgba(bitmap);
    return { heights: decodeHeights(rgba), decodeMs: performance.now() - start };
  } finally {
    bitmap.close();
  }
}

/**
 * Read exact tile bytes from a bitmap, preferring VideoFrame because canvas readback can alter
 * tile-size pixels while a small probe stays clean. Terrarium decoding stays in `decodeHeights`,
 * so another encoding can reuse this.
 */
export async function extractBitmapRgba(bitmap: ImageBitmap): Promise<Uint8ClampedArray> {
  if (typeof VideoFrame !== "undefined") {
    try {
      return await readBitmapFrame(bitmap);
    } catch (error) {
      const reason = (error as Error).message;
      throw new Error(`DEM tile rejected because VideoFrame decode failed: ${reason}`, {
        cause: error,
      });
    }
  }

  if (canvasAltersBytes === null) {
    // An unverifiable canvas is untrusted, so a probe failure fails the tile.
    canvasAltersBytes = await probeCanvasAltersBytes().catch(() => true);
  }

  if (canvasAltersBytes) {
    warnAlteredCanvasOnce();
    throw new Error(
      "DEM tile rejected because canvas readback alters pixel bytes, likely from a browser "
        + "privacy or anti-fingerprinting setting, and VideoFrame is unavailable in this browser",
    );
  }

  return readBitmapCanvas(bitmap);
}

async function readBitmapFrame(bitmap: ImageBitmap): Promise<Uint8ClampedArray> {
  const frame = new VideoFrame(bitmap, { timestamp: 0 });

  try {
    const format = frame.format;
    if (!format) throw new Error("VideoFrame reported no pixel format");

    const raw = new Uint8Array(frame.allocationSize());
    const layout = await frame.copyTo(raw);
    const stride = layout[0]?.stride ?? bitmap.width * BYTES_PER_PIXEL;
    const offset = layout[0]?.offset ?? 0;

    return frameBytesToRgba(raw, format, bitmap.width, bitmap.height, stride, offset);
  } finally {
    frame.close();
  }
}

/**
 * Pack strided VideoFrame bytes into RGBA, swapping red and blue for BGR layouts. X formats
 * carry no alpha, so those texels become opaque.
 */
export function frameBytesToRgba(
  raw: Uint8Array,
  format: string,
  width: number,
  height: number,
  strideBytes: number,
  offsetBytes: number,
): Uint8ClampedArray {
  const redFirst = format === "RGBA" || format === "RGBX";
  const blueFirst = format === "BGRA" || format === "BGRX";
  if (!redFirst && !blueFirst) throw new Error(`Unsupported VideoFrame format "${format}"`);

  const rowBytes = width * BYTES_PER_PIXEL;
  if (strideBytes < rowBytes) {
    throw new Error(`VideoFrame stride ${strideBytes} is shorter than its ${rowBytes} byte row`);
  }

  if (raw.length < offsetBytes + (height - 1) * strideBytes + rowBytes) {
    throw new Error("VideoFrame bytes are shorter than their layout claims");
  }

  const opaque = format === "RGBX" || format === "BGRX";
  const rgba = new Uint8ClampedArray(width * height * BYTES_PER_PIXEL);

  for (let row = 0; row < height; row++) {
    const rowStart = offsetBytes + row * strideBytes;

    for (let column = 0; column < width; column++) {
      const source = rowStart + column * BYTES_PER_PIXEL;
      const target = (row * width + column) * BYTES_PER_PIXEL;
      rgba[target] = raw[source + (redFirst ? 0 : 2)];
      rgba[target + 1] = raw[source + 1];
      rgba[target + 2] = raw[source + (redFirst ? 2 : 0)];
      rgba[target + 3] = opaque ? 255 : raw[source + 3];
    }
  }

  return rgba;
}

async function probeCanvasAltersBytes(): Promise<boolean> {
  const canvas = new OffscreenCanvas(DEM_TILE_SIZE_PX, DEM_TILE_SIZE_PX);
  const context = canvas.getContext("2d", { willReadFrequently: true });

  // A missing context cannot be verified, so the worker must not trust canvas bytes.
  if (!context) return true;

  const image = context.createImageData(DEM_TILE_SIZE_PX, DEM_TILE_SIZE_PX);
  fillProbeRgba(image.data);
  context.putImageData(image, 0, 0);

  const { data } = context.getImageData(0, 0, DEM_TILE_SIZE_PX, DEM_TILE_SIZE_PX);

  return canvasReadbackAltered(image.data, data);
}

function fillProbeRgba(data: Uint8ClampedArray): void {
  // Neighbouring pixels spread across the byte range, so a size-dependent drift cannot hide.
  for (let pixel = 0; pixel < data.length / BYTES_PER_PIXEL; pixel++) {
    const base = pixel * BYTES_PER_PIXEL;
    data[base] = pixel % 256;
    data[base + 1] = (pixel * 7 + 13) % 256;
    data[base + 2] = (pixel * 13 + 71) % 256;
    // Opaque texels skip premultiplied-alpha rounding, so the round trip must stay exact.
    data[base + 3] = 255;
  }
}

/**
 * Tell whether canvas readback changed any byte. Privacy noise moves single bytes by one,
 * so the comparison is exact.
 */
export function canvasReadbackAltered(
  expected: Uint8ClampedArray,
  actual: Uint8ClampedArray,
): boolean {
  if (actual.length !== expected.length) return true;

  for (let index = 0; index < expected.length; index++) {
    if (actual[index] !== expected[index]) return true;
  }

  return false;
}

function readBitmapCanvas(bitmap: ImageBitmap): Uint8ClampedArray {
  const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
  const context = canvas.getContext("2d", { willReadFrequently: true })!;
  context.drawImage(bitmap, 0, 0);

  return context.getImageData(0, 0, canvas.width, canvas.height).data;
}

function warnAlteredCanvasOnce(): void {
  if (integrityWarningPosted) return;

  integrityWarningPosted = true;
  console.warn(ALTERED_CANVAS_WARNING);
}

/** Decode Terrarium RGBA pixels to metres. */
export function decodeHeights(rgba: Uint8ClampedArray): Float32Array {
  const heights = new Float32Array(rgba.length / BYTES_PER_PIXEL);

  for (let index = 0; index < heights.length; index++) {
    const red = rgba[index * BYTES_PER_PIXEL];
    const green = rgba[index * BYTES_PER_PIXEL + 1];
    const blue = rgba[index * BYTES_PER_PIXEL + 2];
    heights[index] = red * TERRARIUM_RADIX + green + blue / TERRARIUM_RADIX - TERRARIUM_OFFSET_M;
  }

  return heights;
}

/**
 * Copy the outermost two rows and columns of a tile into one buffer. Top and bottom hold two
 * full rows. Left and right hold one pair of pixels per row to match the neighbour halo.
 */
export function edgeStrips(heights: Float32Array): Float32Array {
  const size = DEM_TILE_SIZE_PX;
  const strips = new Float32Array(STRIP_SIDES.length * STRIP_LENGTH);
  stripOf(strips, "top").set(heights.subarray(0, STRIP_LENGTH));
  stripOf(strips, "bottom").set(heights.subarray(size * (size - STRIP_WIDTH_PX)));
  const left = stripOf(strips, "left");
  const right = stripOf(strips, "right");

  for (let row = 0; row < size; row++) {
    const rowStart = row * size;
    const stripStart = row * STRIP_WIDTH_PX;
    left.set(heights.subarray(rowStart, rowStart + STRIP_WIDTH_PX), stripStart);
    right.set(heights.subarray(rowStart + size - STRIP_WIDTH_PX, rowStart + size), stripStart);
  }

  return strips;
}

/** A view of one side inside a buffer made by `edgeStrips`. */
export function stripOf(strips: Float32Array, side: StripSide): Float32Array {
  const start = STRIP_SIDES.indexOf(side) * STRIP_LENGTH;
  return strips.subarray(start, start + STRIP_LENGTH);
}

/** Forget the cached canvas verdict, so tests can probe both paths in one worker. */
export function resetDemIntegrityForTests(): void {
  canvasAltersBytes = null;
  integrityWarningPosted = false;
}
