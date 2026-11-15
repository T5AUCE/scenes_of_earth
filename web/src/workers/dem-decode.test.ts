import assert from "node:assert/strict";
import { afterEach, test } from "node:test";

import {
  canvasReadbackAltered,
  decodeHeights,
  DEM_TILE_SIZE_PX,
  edgeStrips,
  extractBitmapRgba,
  frameBytesToRgba,
  loadDemTile,
  resetDemIntegrityForTests,
  stripOf,
} from "./dem-decode.ts";

const SIZE_PX = DEM_TILE_SIZE_PX;
const realFetch = globalThis.fetch;
const realOffscreenCanvas = (globalThis as any).OffscreenCanvas;
const realVideoFrame = (globalThis as any).VideoFrame;
const realWarn = console.warn;

let alterProbeBytes = false;
let tileBytes = new Uint8ClampedArray();
let framePayload: { raw: Uint8Array; format: string; stride: number } | null = null;
let probeReads = 0;
let tileReads = 0;
let frameBuilds = 0;
let warnings: string[] = [];

class FakeContext {
  stored: Uint8ClampedArray | null = null;
  createImageData(width: number, height: number): { data: Uint8ClampedArray } {
    return { data: new Uint8ClampedArray(width * height * 4) };
  }
  putImageData(image: { data: Uint8ClampedArray }): void {
    this.stored = image.data.slice();
  }
  drawImage(): void {}
  getImageData(
    _x: number,
    _y: number,
    _width: number,
    _height: number,
  ): { data: Uint8ClampedArray } {
    if (this.stored) {
      probeReads += 1;

      const data = this.stored.slice();

      // Mirror the reported privacy drift of one red byte by one.
      if (alterProbeBytes) data[0] = (data[0] + 1) % 256;

      return { data };
    }

    tileReads += 1;

    return { data: tileBytes.slice() };
  }
}

class FakeCanvas {
  context = new FakeContext();
  constructor(
    public width: number,
    public height: number,
  ) {}
  getContext(): FakeContext {
    return this.context;
  }
}

class FakeBitmap {
  constructor(
    public width: number,
    public height: number,
  ) {}
  close(): void {}
}

class FakeFrame {
  format: string;
  payload: Uint8Array;
  stride: number;
  constructor() {
    frameBuilds += 1;

    if (!framePayload) throw new Error("test must set framePayload when VideoFrame exists");

    this.format = framePayload.format;
    this.payload = framePayload.raw;
    this.stride = framePayload.stride;
  }
  allocationSize(): number {
    return this.payload.length;
  }
  async copyTo(target: Uint8Array): Promise<{ offset: number; stride: number }[]> {
    target.set(this.payload);
    return [{ offset: 0, stride: this.stride }];
  }
  close(): void {}
}

afterEach(() => {
  globalThis.fetch = realFetch;

  if (realOffscreenCanvas === undefined) delete (globalThis as any).OffscreenCanvas;
  else (globalThis as any).OffscreenCanvas = realOffscreenCanvas;

  if (realVideoFrame === undefined) delete (globalThis as any).VideoFrame;
  else (globalThis as any).VideoFrame = realVideoFrame;

  console.warn = realWarn;
  resetDemIntegrityForTests();
  alterProbeBytes = false;
  tileBytes = new Uint8ClampedArray();
  framePayload = null;
  probeReads = 0;
  tileReads = 0;
  frameBuilds = 0;
  warnings = [];
});

test("terrarium bytes decode to metres", () => {
  const rgba = new Uint8ClampedArray([128, 0, 0, 255, 128, 1, 128, 255, 127, 255, 255, 255]);

  assert.deepEqual([...decodeHeights(rgba)], [0, 1.5, -1 / 256]);
});

test("edge strips hold the two outermost rows and columns of each side", () => {
  const heights = Float32Array.from({ length: SIZE_PX * SIZE_PX }, (_, index) => index);
  const strips = edgeStrips(heights);
  const at = (row: number, column: number) => row * SIZE_PX + column;

  assert.equal(strips.byteLength, 16 * 1024);
  assert.deepEqual([...stripOf(strips, "top").subarray(0, 2)], [0, 1]);
  assert.equal(stripOf(strips, "top")[SIZE_PX], at(1, 0));
  assert.equal(stripOf(strips, "bottom")[0], at(SIZE_PX - 2, 0));
  assert.equal(stripOf(strips, "bottom")[2 * SIZE_PX - 1], at(SIZE_PX - 1, SIZE_PX - 1));
  assert.deepEqual(
    [...stripOf(strips, "left").subarray(0, 4)],
    [at(0, 0), at(0, 1), at(1, 0), at(1, 1)],
  );
  assert.deepEqual(
    [...stripOf(strips, "right").subarray(2 * 7, 2 * 7 + 2)],
    [at(7, SIZE_PX - 2), at(7, SIZE_PX - 1)],
  );
});

test("a 404 means the tile does not exist", async () => {
  globalThis.fetch = async () => new Response(null, { status: 404 });

  assert.equal(await loadDemTile("https://dem/1/2/3.png", new AbortController().signal), null);
});

test("any other failed response throws with the url", async () => {
  globalThis.fetch = async () => new Response(null, { status: 500 });

  await assert.rejects(
    loadDemTile("https://dem/1/2/3.png", new AbortController().signal),
    /Bad response: 500 for https:\/\/dem\/1\/2\/3\.png/,
  );
});

test("canvas comparison catches a one-byte red drift", () => {
  const expected = new Uint8ClampedArray([134, 201, 0, 255]);
  const drifted = new Uint8ClampedArray([135, 201, 0, 255]);

  assert.equal(canvasReadbackAltered(expected, expected.slice()), false);
  assert.equal(canvasReadbackAltered(expected, drifted), true);
  assert.equal(canvasReadbackAltered(expected, new Uint8ClampedArray(2)), true);
});

test("frame fallback handles BGR order, padding and offsets", () => {
  // Two terrarium texels per row in BGRX order with a header and padding after each row.
  const raw = new Uint8Array(32).fill(9);
  raw.set([0, 201, 134, 7, 128, 1, 128, 7], 8);
  raw.set([30, 20, 10, 7, 60, 50, 40, 7], 20);

  const rgba = frameBytesToRgba(raw, "BGRX", 2, 2, 12, 8);

  assert.deepEqual([...rgba.subarray(0, 8)], [134, 201, 0, 255, 128, 1, 128, 255]);
  assert.deepEqual([...rgba.subarray(8)], [10, 20, 30, 255, 40, 50, 60, 255]);
  assert.equal(decodeHeights(rgba)[0], 1737);
  assert.throws(() => frameBytesToRgba(raw, "I420", 2, 2, 12, 8), /Unsupported VideoFrame format/);
});

test("videoframe is preferred when available and ignores altered canvas tiles", async () => {
  // The canvas tile drifts red by one while the frame holds the true terrarium bytes.
  tileBytes = new Uint8ClampedArray([135, 202, 1, 255]);
  framePayload = { raw: new Uint8Array([0, 201, 134, 7]), format: "BGRX", stride: 4 };
  (globalThis as any).OffscreenCanvas = FakeCanvas;
  (globalThis as any).VideoFrame = FakeFrame;
  console.warn = (message: string) => {
    warnings.push(message);
  };

  resetDemIntegrityForTests();

  const bitmap = new FakeBitmap(1, 1) as unknown as ImageBitmap;

  const first = await extractBitmapRgba(bitmap);
  const second = await extractBitmapRgba(bitmap);

  assert.deepEqual([...first], [134, 201, 0, 255]);
  assert.deepEqual([...second], [134, 201, 0, 255]);
  assert.equal(probeReads, 0);
  assert.equal(tileReads, 0);
  assert.equal(frameBuilds, 2);
  assert.equal(warnings.length, 0);
});

test("a videoframe failure fails closed without canvas fallback", async () => {
  tileBytes = new Uint8ClampedArray([134, 201, 0, 255]);
  framePayload = { raw: new Uint8Array([0, 0, 0, 0]), format: "I420", stride: 4 };
  (globalThis as any).OffscreenCanvas = FakeCanvas;
  (globalThis as any).VideoFrame = FakeFrame;
  resetDemIntegrityForTests();

  const bitmap = new FakeBitmap(1, 1) as unknown as ImageBitmap;

  await assert.rejects(extractBitmapRgba(bitmap), /VideoFrame decode failed.*Unsupported/);
  assert.equal(probeReads, 0);
  assert.equal(tileReads, 0);
});

test("a canvas-only altered tile-size probe fails the tile with a clear error", async () => {
  alterProbeBytes = true;
  tileBytes = new Uint8ClampedArray([135, 202, 1, 255]);
  (globalThis as any).OffscreenCanvas = FakeCanvas;
  delete (globalThis as any).VideoFrame;
  console.warn = (message: string) => {
    warnings.push(message);
  };

  resetDemIntegrityForTests();

  const bitmap = new FakeBitmap(2, 1) as unknown as ImageBitmap;

  await assert.rejects(
    extractBitmapRgba(bitmap),
    /canvas readback alters pixel bytes.*VideoFrame is unavailable/,
  );
  assert.equal(probeReads, 1);
  assert.equal(tileReads, 0);
  assert.equal(warnings.length, 1);

  await assert.rejects(extractBitmapRgba(bitmap), /canvas readback alters pixel bytes/);
  assert.equal(probeReads, 1);
  assert.equal(tileReads, 0);
  assert.equal(warnings.length, 1);
});

test("a canvas-only clean tile-size probe still decodes through canvas", async () => {
  tileBytes = new Uint8ClampedArray([134, 201, 0, 255, 1, 2, 3, 255]);
  (globalThis as any).OffscreenCanvas = FakeCanvas;
  delete (globalThis as any).VideoFrame;
  console.warn = (message: string) => {
    warnings.push(message);
  };

  resetDemIntegrityForTests();

  const bitmap = new FakeBitmap(2, 1) as unknown as ImageBitmap;

  const first = await extractBitmapRgba(bitmap);
  const second = await extractBitmapRgba(bitmap);

  assert.deepEqual([...first], [...tileBytes]);
  assert.deepEqual([...second], [...tileBytes]);
  assert.equal(probeReads, 1);
  assert.equal(tileReads, 2);
  assert.equal(frameBuilds, 0);
  assert.equal(warnings.length, 0);
});

test("videoframe decode stays close to canvas cost on small tiles", async () => {
  const repeats = 20;
  (globalThis as any).OffscreenCanvas = FakeCanvas;

  tileBytes = new Uint8ClampedArray([134, 201, 0, 255, 1, 2, 3, 255]);
  framePayload = { raw: new Uint8Array([0, 201, 134, 7, 3, 2, 1, 7]), format: "BGRX", stride: 8 };
  (globalThis as any).VideoFrame = FakeFrame;
  resetDemIntegrityForTests();

  const bitmap = new FakeBitmap(2, 1) as unknown as ImageBitmap;
  const frameStart = performance.now();

  for (let round = 0; round < repeats; round++) {
    await extractBitmapRgba(bitmap);
  }

  const frameMs = (performance.now() - frameStart) / repeats;

  delete (globalThis as any).VideoFrame;
  resetDemIntegrityForTests();

  const canvasStart = performance.now();

  for (let round = 0; round < repeats; round++) {
    await extractBitmapRgba(bitmap);
  }

  const canvasMs = (performance.now() - canvasStart) / repeats;

  assert.ok(frameMs < canvasMs * 10 + 10, `frame ${frameMs} ms vs canvas ${canvasMs} ms`);
});
