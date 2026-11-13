import assert from "node:assert/strict";
import { test } from "node:test";

import type { CustomRenderMethodInput, Map as MapLibreMap } from "maplibre-gl";

import { buildMaskGeometry, createMaskLayers } from "./mask-layer.ts";
import type { MaskGeometry } from "./mask-layer.ts";

type Ring = number[][];
type Call = [string, unknown[]];

interface FakeGlConfig {
  link?: boolean;
  framebufferComplete?: boolean;
  // Framebuffers wider than this are incomplete, as when the GPU is out of memory.
  maxCompleteWidth?: number;
  contextLost?: boolean;
  maxTextureSize?: number;
}

// Constants start high so that no call argument can be mistaken for one.
const FIRST_CONSTANT = 100_000;

const WORLD_COPIES = [-1, 0, 1];
const MAIN_MATRIX = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
const CANVAS_WIDTH_PX = 800;
const CANVAS_HEIGHT_PX = 600;

const IDS = ["mask"];

const square = (west: number, south: number, size: number): Ring => [
  [west, south],
  [west + size, south],
  [west + size, south + size],
  [west, south + size],
  [west, south],
];

// The lake is cut out of the area and the island sits in the lake.
const AREA_RINGS = [square(10, 10, 20), square(14, 14, 12), square(18, 18, 4)];

test("the world is covered outside the area and inside its lake only", () => {
  const geometry = buildMaskGeometry(AREA_RINGS);

  assert.equal(isMasked(geometry, 0, 0), true);
  assert.equal(isMasked(geometry, 12, 12), false);
  assert.equal(isMasked(geometry, 16, 16), true);
  assert.equal(isMasked(geometry, 20, 20), false);
  assert.equal(isMasked(geometry, 60, 40), true);
});

test("an area across the antimeridian is open on both of its sides", () => {
  const geometry = buildMaskGeometry([square(170, -5, 20)]);

  assert.equal(isMasked(geometry, 175, 0), false);
  assert.equal(isMasked(geometry, 185, 0), false);
  assert.equal(isMasked(geometry, -175, 0), false);
  assert.equal(isMasked(geometry, -160, 0), true);
  assert.equal(isMasked(geometry, 150, 0), true);
});

test("the area is cut out of every world copy", () => {
  const geometry = buildMaskGeometry([square(10, 10, 20)]);

  for (const offset of WORLD_COPIES) {
    assert.equal(isMasked(geometry, 20 + 360 * offset, 20), false);
    assert.equal(isMasked(geometry, 50 + 360 * offset, 20), true);
  }
});

test("vertices stay near the area so single precision holds at high zoom", () => {
  const geometry = buildMaskGeometry([square(100.001, 20.001, 0.002)]);

  const { first, count } = geometry.outlines[0];
  const outline = geometry.vertices.slice(first * 2, (first + count) * 2);
  assert.ok(outline.every((value) => Math.abs(value) < 1e-5));
});

test("a layer at zero opacity builds its programs and target but draws nothing", () => {
  const { gl, calls } = fakeGl();
  const [{ layer }] = createMaskLayers(options(), IDS);

  layer.prerender!(gl, input());
  layer.render(gl, input());

  assert.equal(names(calls, "linkProgram").length, 2);
  assert.equal(names(calls, "renderbufferStorage").length, 1);
  assert.equal(names(calls, "drawArrays").length, 0);
});

test("a hidden layer reports a failure before it is ever shown", async () => {
  const failures: Error[] = [];
  const { gl } = fakeGl({ link: false });
  const [{ layer }] = createMaskLayers(
    { ...options(), onFail: (error) => failures.push(error) },
    IDS,
  );

  layer.prerender!(gl, input());
  await Promise.resolve();

  assert.equal(failures.length, 1);
});

test("a frame on a lost context draws nothing and reports nothing", async () => {
  const failures: Error[] = [];
  const { gl, calls } = fakeGl({ contextLost: true });
  const [{ layer, setOpacity }] = createMaskLayers(
    { ...options(), onFail: (error) => failures.push(error) },
    IDS,
  );
  setOpacity(1);

  layer.prerender!(gl, input());
  layer.render(gl, input());
  await Promise.resolve();

  assert.deepEqual(failures, []);
  assert.deepEqual(names(calls, "getParameter"), []);
  assert.equal(names(calls, "drawArrays").length, 0);
});

test("layers share one target that is filled once while the camera stays put", () => {
  const { gl, calls } = fakeGl();
  const [mask, fade] = createMaskLayers(options(), ["mask", "fade"]);
  mask.setOpacity(1);
  fade.setOpacity(0.6);

  for (const { layer } of [mask, fade]) layer.prerender!(gl, input());

  assert.equal(names(calls, "renderbufferStorage").length, 1);
  assert.equal(names(calls, "clear").length, 1);
  assert.equal(names(calls, "linkProgram").length, 2);
});

test("the target is filled again when the camera moves", () => {
  const { gl, calls } = fakeGl();
  const [{ layer, setOpacity }] = createMaskLayers(options(), IDS);
  setOpacity(1);
  layer.prerender!(gl, input());

  layer.prerender!(gl, input([...MAIN_MATRIX.slice(0, 12), 0.5, 0, 0, 1]));

  assert.equal(names(calls, "clear").length, 2);
});

test("a target that fails at 2x is rebuilt at the canvas size without failing", async () => {
  const failures: Error[] = [];
  const { gl, calls } = fakeGl({ maxCompleteWidth: CANVAS_WIDTH_PX });
  const [{ layer, setOpacity }] = createMaskLayers(
    { ...options(), onFail: (error) => failures.push(error) },
    IDS,
  );
  setOpacity(1);

  layer.prerender!(gl, input());
  layer.prerender!(gl, input());
  await Promise.resolve();

  assert.deepEqual(failures, []);
  const sizes = names(calls, "renderbufferStorage").map((args) => args[2]);
  assert.deepEqual(sizes, [CANVAS_WIDTH_PX * 2, CANVAS_WIDTH_PX]);
  assert.equal(names(calls, "drawArrays").length > 0, true);
});

test("the covered pixels are filled by stencil parity into a supersampled target", () => {
  const { gl, calls, find } = fakeGl();
  const [{ layer, setOpacity }] = createMaskLayers(options(), IDS);
  setOpacity(1);

  layer.prerender!(gl, input());

  assert.deepEqual(find("renderbufferStorage")!.slice(2), [
    CANVAS_WIDTH_PX * 2,
    CANVAS_HEIGHT_PX * 2,
  ]);
  const fans = names(calls, "drawArrays").filter(([mode]) => mode === "TRIANGLE_FAN");
  assert.equal(fans.length, WORLD_COPIES.length * AREA_RINGS.length);
  const quads = names(calls, "drawArrays").filter(([mode]) => mode === "TRIANGLE_STRIP");
  assert.equal(quads.length, 1);
  assert.deepEqual(find("clearStencil"), [1]);
  assert.ok(index(calls, "stencilOp", ["KEEP", "KEEP", "INVERT"]) < lastIndex(calls, "drawArrays"));
  assert.ok(
    index(calls, "stencilFunc", ["EQUAL", 1, 1]) < lastIndex(calls, "drawArrays"),
  );
});

test("the page colour paints the covered pixels", () => {
  const { gl, find } = fakeGl();
  const [{ layer, setOpacity }] = createMaskLayers({ ...options(), color: "#336699" }, IDS);
  setOpacity(1);

  layer.prerender!(gl, input());

  assert.deepEqual(channels(find("uniform3fv")![1]), [0.2, 0.4, 0.6]);
});

test("a short hex colour reads as its doubled digits", () => {
  const { gl, find } = fakeGl();
  const [{ layer, setOpacity }] = createMaskLayers({ ...options(), color: "#fff" }, IDS);
  setOpacity(1);

  layer.prerender!(gl, input());

  assert.deepEqual(channels(find("uniform3fv")![1]), [1, 1, 1]);
});

test("a colour that is not hex fails when the layer is made", () => {
  const make = () => createMaskLayers({ ...options(), color: "rebeccapurple" }, IDS);

  assert.throws(make, /hex colour/);
});

test("the target is composited premultiplied at the layer opacity", () => {
  const { gl, calls, find } = fakeGl();
  const [{ layer, setOpacity }] = createMaskLayers(options(), IDS);
  setOpacity(0.6);
  layer.prerender!(gl, input());
  calls.length = 0;

  layer.render(gl, input());

  assert.deepEqual(find("blendFunc"), ["ONE", "ONE_MINUS_SRC_ALPHA"]);
  assert.deepEqual(find("uniform1f"), ["uOpacity", 0.6]);
  assert.equal(names(calls, "drawArrays").length, 1);
});

test("a frame without an offscreen draw composites nothing", () => {
  const { gl, calls } = fakeGl();
  const [{ layer, setOpacity }] = createMaskLayers(options(), IDS);
  setOpacity(1);
  layer.prerender!(gl, input());
  setOpacity(0);
  layer.prerender!(gl, input());
  calls.length = 0;

  layer.render(gl, input());

  assert.deepEqual(calls, []);
});

test("map state is restored after the offscreen draw", () => {
  const { gl, calls, framebuffer } = fakeGl();
  const [{ layer, setOpacity }] = createMaskLayers(options(), IDS);
  setOpacity(1);

  layer.prerender!(gl, input());

  const binds = names(calls, "bindFramebuffer");
  assert.equal(binds.at(-1)![1], framebuffer);
  assert.deepEqual(names(calls, "viewport").at(-1), [0, 0, CANVAS_WIDTH_PX, CANVAS_HEIGHT_PX]);
  assert.deepEqual(names(calls, "disable").at(-1), ["STENCIL_TEST"]);
  assert.deepEqual(names(calls, "bindVertexArray").at(-1), [null]);
});

test("the target follows the canvas size and frees the old one", () => {
  const fake = fakeGl();
  const [{ layer, setOpacity }] = createMaskLayers(options(), IDS);
  setOpacity(1);
  layer.prerender!(fake.gl, input());

  fake.size.width = 400;
  layer.prerender!(fake.gl, input());

  assert.equal(names(fake.calls, "renderbufferStorage").length, 2);
  assert.equal(names(fake.calls, "deleteFramebuffer").length, 1);
  assert.equal(names(fake.calls, "deleteTexture").length, 1);
});

test("a target bigger than the GPU allows is scaled down to fit", () => {
  const { gl, find } = fakeGl({ maxTextureSize: 1000 });
  const [{ layer, setOpacity }] = createMaskLayers(options(), IDS);
  setOpacity(1);

  layer.prerender!(gl, input());

  assert.deepEqual(find("renderbufferStorage")!.slice(2), [1000, 750]);
});

test("a repeated frame reuses the compiled programs and the target", () => {
  const { gl, calls } = fakeGl();
  const [{ layer, setOpacity }] = createMaskLayers(options(), IDS);
  setOpacity(1);

  layer.prerender!(gl, input());
  layer.prerender!(gl, input());

  assert.equal(names(calls, "linkProgram").length, 2);
  assert.equal(names(calls, "renderbufferStorage").length, 1);
});

test("a shader that fails to link reports once and the layer stays quiet", async () => {
  const failures: Error[] = [];
  const { gl, calls } = fakeGl({ link: false });
  const [{ layer, setOpacity }] = createMaskLayers(
    { ...options(), onFail: (error) => failures.push(error) },
    IDS,
  );
  setOpacity(1);

  layer.prerender!(gl, input());
  layer.prerender!(gl, input());
  layer.render(gl, input());
  await Promise.resolve();

  assert.equal(failures.length, 1);
  assert.match(failures[0].message, /Cannot link the shader program/);
  assert.equal(names(calls, "drawArrays").length, 0);
  assert.equal(names(calls, "deleteProgram").length, 1);
});

test("a framebuffer incomplete at both sizes reports a failure and frees both", async () => {
  const failures: Error[] = [];
  const { gl, calls } = fakeGl({ framebufferComplete: false });
  const [{ layer, setOpacity }] = createMaskLayers(
    { ...options(), onFail: (error) => failures.push(error) },
    IDS,
  );
  setOpacity(1);

  layer.prerender!(gl, input());
  await Promise.resolve();

  assert.equal(failures.length, 1);
  assert.match(failures[0].message, /framebuffer/);
  assert.equal(names(calls, "deleteFramebuffer").length, 2);
  assert.equal(names(calls, "deleteRenderbuffer").length, 2);
});

test("removing the layer frees every resource and a later add draws again", () => {
  const { gl, calls } = fakeGl();
  const map = { triggerRepaint() {} } as unknown as MapLibreMap;
  const [{ layer, setOpacity }] = createMaskLayers(options(), IDS);
  layer.onAdd!(map, gl);
  setOpacity(1);
  layer.prerender!(gl, input());

  layer.onRemove!(map, gl);

  assert.equal(names(calls, "deleteProgram").length, 2);
  assert.equal(names(calls, "deleteBuffer").length, 1);
  assert.equal(names(calls, "deleteVertexArray").length, 1);
  assert.equal(names(calls, "deleteFramebuffer").length, 1);
  assert.equal(names(calls, "deleteRenderbuffer").length, 1);
  assert.equal(names(calls, "deleteTexture").length, 1);

  layer.onAdd!(map, gl);
  layer.prerender!(gl, input());
  assert.equal(names(calls, "linkProgram").length, 4);
});

test("removing one of two layers keeps the shared resources until the last is removed", () => {
  const { gl, calls } = fakeGl();
  const map = { triggerRepaint() {} } as unknown as MapLibreMap;
  const [mask, fade] = createMaskLayers(options(), ["mask", "fade"]);
  for (const { layer, setOpacity } of [mask, fade]) {
    layer.onAdd!(map, gl);
    setOpacity(1);
  }
  mask.layer.prerender!(gl, input());

  mask.layer.onRemove!(map, gl);
  const drawsBefore = names(calls, "drawArrays").length;
  fade.layer.prerender!(gl, input());
  fade.layer.render(gl, input());

  assert.equal(names(calls, "deleteProgram").length, 0);
  assert.equal(names(calls, "deleteTexture").length, 0);
  assert.equal(names(calls, "drawArrays").length, drawsBefore + 1);

  fade.layer.onRemove!(map, gl);

  assert.equal(names(calls, "deleteProgram").length, 2);
  assert.equal(names(calls, "deleteBuffer").length, 1);
  assert.equal(names(calls, "deleteVertexArray").length, 1);
  assert.equal(names(calls, "deleteFramebuffer").length, 1);
  assert.equal(names(calls, "deleteRenderbuffer").length, 1);
  assert.equal(names(calls, "deleteTexture").length, 1);
});

test("changing the opacity asks the map for another frame", () => {
  let repaints = 0;
  const map = { triggerRepaint: () => repaints++ } as unknown as MapLibreMap;
  const [{ layer, setOpacity }] = createMaskLayers(options(), IDS);
  layer.onAdd!(map, fakeGl().gl);

  setOpacity(1);

  assert.equal(repaints, 1);
});

function options() {
  return {
    rings: AREA_RINGS,
    color: "#faf8f3",
    opacity: 0,
    onFail: () => {},
  };
}

function input(mainMatrix = MAIN_MATRIX) {
  return { defaultProjectionData: { mainMatrix } } as unknown as CustomRenderMethodInput;
}

// Single precision channels are compared at the precision of the colour they came from.
const channels = (values: unknown) =>
  Array.from(values as Float32Array, (value) => Math.round(value * 10) / 10);

const names = (calls: Call[], name: string) =>
  calls.filter(([call]) => call === name).map(([, args]) => args);

const index = (calls: Call[], name: string, args: unknown[]) =>
  calls.findIndex(
    ([call, given]) => call === name && JSON.stringify(given) === JSON.stringify(args),
  );

const lastIndex = (calls: Call[], name: string) =>
  calls.map(([call]) => call).lastIndexOf(name);

/** Whether the fans flip the parity bit an odd number of times at a longitude and latitude. */
function isMasked(geometry: MaskGeometry, longitude: number, latitude: number) {
  const { origin, vertices, outlines } = geometry;
  const x = (longitude + 180) / 360 - origin[0];
  const sine = Math.sin((latitude * Math.PI) / 180);
  const y = 0.5 - Math.log((1 + sine) / (1 - sine)) / (4 * Math.PI) - origin[1];
  const covers = (fan: { first: number; count: number }, dx: number) =>
    fanContains(vertices, fan, x - dx, y);

  let flips = 1;
  for (const offset of WORLD_COPIES) {
    for (const fan of outlines) if (covers(fan, offset)) flips++;
  }

  return flips % 2 === 1;
}

/** The parity of the fan's triangles over a point, which is the ring's even-odd inside. */
function fanContains(
  vertices: Float32Array,
  { first, count }: { first: number; count: number },
  x: number,
  y: number,
) {
  const point = (vertex: number) => [vertices[vertex * 2], vertices[vertex * 2 + 1]];
  const centre = point(first);
  let parity = false;
  for (let step = 1; step < count - 1; step++) {
    if (inTriangle([x, y], centre, point(first + step), point(first + step + 1))) {
      parity = !parity;
    }
  }

  return parity;
}

function inTriangle(p: number[], a: number[], b: number[], c: number[]) {
  const side = (u: number[], v: number[]) =>
    (v[0] - u[0]) * (p[1] - u[1]) - (v[1] - u[1]) * (p[0] - u[0]);
  const signs = [side(a, b), side(b, c), side(c, a)];

  return signs.every((value) => value >= 0) || signs.every((value) => value <= 0);
}

/** A WebGL double that records calls under their constant names so tests can read them. */
function fakeGl(config: FakeGlConfig = {}) {
  const calls: Call[] = [];
  const size = { width: CANVAS_WIDTH_PX, height: CANVAS_HEIGHT_PX };
  const framebuffer = { name: "map framebuffer" };
  let framebufferWidth = 0;
  const constants = new Map<string, number>();
  const constant = (name: string) => {
    if (!constants.has(name)) constants.set(name, FIRST_CONSTANT + constants.size);

    return constants.get(name)!;
  };
  const label = (value: unknown) => {
    const name = [...constants].find(([, known]) => known === value)?.[0];

    return name ?? value;
  };
  const returns: Record<string, (...args: unknown[]) => unknown> = {
    getParameter: (name) => {
      if (name === constant("FRAMEBUFFER_BINDING")) return framebuffer;
      if (name === constant("VIEWPORT")) return Int32Array.of(0, 0, size.width, size.height);
      if (name === constant("MAX_TEXTURE_SIZE")) return config.maxTextureSize ?? 16384;

      return null;
    },
    getProgramParameter: () => config.link ?? true,
    getProgramInfoLog: () => "driver log",
    getShaderParameter: () => true,
    isContextLost: () => config.contextLost ?? false,
    renderbufferStorage: (_target, _format, width) => {
      framebufferWidth = width as number;
    },
    checkFramebufferStatus: () => {
      const isComplete = config.framebufferComplete !== false
        && framebufferWidth <= (config.maxCompleteWidth ?? Infinity);

      return isComplete ? constant("FRAMEBUFFER_COMPLETE") : 0;
    },
    getUniformLocation: (_program, name) => name,
  };
  const gl = new Proxy({} as Record<string, unknown>, {
    get(_target, property: string) {
      if (property === "drawingBufferWidth") return size.width;
      if (property === "drawingBufferHeight") return size.height;
      if (/^[A-Z0-9_]+$/.test(property)) return constant(property);
      if (property.startsWith("create")) return () => ({ name: property });

      return (...args: unknown[]) => {
        calls.push([property, args.map(label)]);

        return returns[property]?.(...args);
      };
    },
  }) as unknown as WebGL2RenderingContext;
  const find = (name: string) => calls.find(([call]) => call === name)?.[1];

  return { gl, calls, size, framebuffer, find };
}
