import assert from "node:assert/strict";
import { test } from "node:test";

import { createHarness, TiledGpuLayer } from "./class-field-harness.test.ts";
import type { TiledGpu } from "./tiled-layer.ts";

class UploadingLayer extends TiledGpuLayer {
  constructor() {
    const grid = { bbox: [36, -2, 37, -1] as [number, number, number, number], nx: 4, ny: 3 };
    super(
      { id: "uploading", grid, shift: 0, onFail: () => {} },
      { name: "tests", vertex: "", fragment: "", uniformNames: [] },
    );
  }

  upload(gl: WebGL2RenderingContext, gpu: TiledGpu, cells: Uint8Array, companion: Uint8Array) {
    this.uploadTiles(gl, gpu, this.options.grid, cells, companion);
  }

  protected hasData() {
    return true;
  }

  protected extendGpu(base: TiledGpu) {
    return base;
  }

  protected extraTextures() {
    return [];
  }

  protected initialize() {}

  protected uploadStaleData() {}

  protected draw() {}
}

test("a failed companion upload frees the primary texture uploaded just before it", () => {
  const harness = createHarness();
  const gl = harness.gl;
  gl.getError = () => (harness.uploads.length >= 2 ? 1285 : 0);
  const gpu = { tiles: [] } as unknown as TiledGpu;
  const cells = new Uint8Array(12);

  assert.throws(() => new UploadingLayer().upload(gl, gpu, cells, cells), /GL error 1285/);

  assert.equal(harness.uploads.length, 2);
  assert.equal(harness.deleted.textures.length, 2);
  assert.equal(gpu.tiles.length, 0);
});

test("a hidden layer does not compile until shown", () => {
  const harness = createHarness();
  let compiles = 0;
  const createProgram = harness.gl.createProgram.bind(harness.gl);
  harness.gl.createProgram = (() => {
    compiles++;
    return createProgram();
  }) as WebGL2RenderingContext["createProgram"];
  const map = harness.map as unknown as {
    getLayoutProperty: (id: string, name: string) => string;
  };
  let visibility = "none";
  map.getLayoutProperty = () => visibility;
  const layer = new UploadingLayer();

  layer.onAdd(harness.map, harness.gl);
  assert.equal(compiles, 0);

  layer.render(harness.gl, harness.input);
  assert.equal(compiles, 0);

  visibility = "visible";
  layer.render(harness.gl, harness.input);
  assert.equal(compiles, 1);

  layer.render(harness.gl, harness.input);
  assert.equal(compiles, 1);
});
