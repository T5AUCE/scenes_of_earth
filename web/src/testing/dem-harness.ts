import type {
  CustomLayerInterface,
  CustomRenderMethodInput,
  Map as MapLibreMap,
} from "maplibre-gl";

import { DEM_TILE_SIZE_PX, edgeStrips } from "../gpu/dem/decode";
import type { DemTexture, DemTextureStore, DemWorkerPort } from "../gpu/dem/pool";
import type { DemWorkerRequest, DemWorkerResponse } from "../gpu/dem/worker";

/** The first of the sampler units; the fake context adds a unit to it like the real one. */
const TEXTURE0 = 100;

export const SCENE_BBOX: [number, number, number, number] = [36, -2, 37, -1];

class FlatWorker implements DemWorkerPort {
  requests: DemWorkerRequest[] = [];
  terminated = false;
  private handler: (response: DemWorkerResponse) => void = () => {};

  constructor(
    private readonly onPost: () => void,
    private readonly settled: () => void,
  ) {}

  post(request: DemWorkerRequest) {
    this.requests.push(request);

    if (request.type !== "load") return;

    this.onPost();

    const heights = new Float32Array(DEM_TILE_SIZE_PX ** 2);
    setTimeout(() => {
      this.handler({
        kind: "tile",
        id: request.id,
        heights,
        strips: edgeStrips(heights),
        decodeMs: 1,
      });
      this.settled();
    }, 0);
  }

  onResponse(handler: (response: DemWorkerResponse) => void) {
    this.handler = handler;
  }

  terminate() {
    this.terminated = true;
  }
}

/** A recording WebGL context, a map around it and fake workers that answer with flat tiles. */
export function createDemHarness(options: { linear?: boolean } = {}) {
  const workers: FlatWorker[] = [];
  const created: DemTexture[] = [];
  const removed: DemTexture[] = [];
  const uniforms = new Map<string, unknown>();
  const draws: {
    uniforms: Map<string, unknown>;
    textures: Map<number, unknown>;
    colorMask: boolean[];
    isScissored: boolean;
  }[] = [];
  const boundTextures = new Map<number, unknown>();
  const deleted = { programs: [] as unknown[], arrays: [] as unknown[], buffers: [] as unknown[] };
  const canvasListeners: { name: string; capture: boolean; listener: () => void }[] = [];
  const renderListeners = new Set<() => void>();
  const layoutProperties = new Map<string, unknown>();
  const failures: Error[] = [];
  let activeUnit = 0;
  // The bindings and switches a warm-up must leave as it found them.
  const glState = {
    program: null as unknown,
    vertexArray: null as unknown,
    switches: new Map<number, boolean>(),
    scissor: [0, 0, 800, 600],
    colorMask: [true, true, true, true],
    blend: [1, 0, 1, 0],
  };
  let pendingReplies = 0;
  let repaints = 0;
  let time = 0;
  let zoom = 8;
  let isContextLost = false;

  const store: DemTextureStore = {
    linear: true,
    create: () => {
      const texture = { id: created.length };
      created.push(texture);

      return texture;
    },
    patch: () => {},
    remove: (texture) => removed.push(texture),
  };

  const gl = {
    TEXTURE0,
    TRIANGLE_STRIP: 5,
    TEXTURE_2D: 15,
    BLEND: 1,
    DEPTH_TEST: 2,
    STENCIL_TEST: 3,
    SCISSOR_TEST: 4,
    ACTIVE_TEXTURE: 5,
    TEXTURE_BINDING_2D: 6,
    CURRENT_PROGRAM: 7,
    VERTEX_ARRAY_BINDING: 8,
    SCISSOR_BOX: 9,
    COLOR_WRITEMASK: 10,
    BLEND_SRC_RGB: 11,
    BLEND_DST_RGB: 12,
    BLEND_SRC_ALPHA: 13,
    BLEND_DST_ALPHA: 14,
    ONE: 16,
    ONE_MINUS_SRC_ALPHA: 17,
    COMPILE_STATUS: 2,
    LINK_STATUS: 3,
    createProgram: () => ({ program: true }),
    createShader: () => ({}),
    shaderSource: () => {},
    compileShader: () => {},
    getShaderParameter: () => true,
    attachShader: () => {},
    linkProgram: () => {},
    getProgramParameter: () => true,
    deleteShader: () => {},
    deleteProgram: (program: unknown) => deleted.programs.push(program),
    getExtension: (name: string) =>
      name === "OES_texture_float_linear" && options.linear !== false ? {} : null,
    createVertexArray: () => ({ vertexArray: true }),
    createBuffer: () => ({ buffer: true }),
    bindVertexArray: (array: unknown) => {
      glState.vertexArray = array;
    },
    bindBuffer: () => {},
    bufferData: () => {},
    getAttribLocation: () => 0,
    enableVertexAttribArray: () => {},
    vertexAttribPointer: () => {},
    deleteVertexArray: (array: unknown) => deleted.arrays.push(array),
    deleteBuffer: (buffer: unknown) => deleted.buffers.push(buffer),
    getUniformLocation: (_program: unknown, name: string) => name,
    useProgram: (program: unknown) => {
      glState.program = program;
    },
    disable: (capability: number) => glState.switches.set(capability, false),
    enable: (capability: number) => glState.switches.set(capability, true),
    isEnabled: (capability: number) => glState.switches.get(capability) ?? false,
    scissor: (...box: number[]) => {
      glState.scissor = box;
    },
    colorMask: (...mask: boolean[]) => {
      glState.colorMask = mask;
    },
    blendFunc: (source: number, destination: number) => {
      glState.blend = [source, destination, source, destination];
    },
    blendFuncSeparate: (...funcs: number[]) => {
      glState.blend = funcs;
    },
    getParameter: (name: number) => {
      const parameters: Record<number, unknown> = {
        5: TEXTURE0 + activeUnit,
        6: boundTextures.get(activeUnit) ?? null,
        7: glState.program,
        8: glState.vertexArray,
        9: glState.scissor,
        10: glState.colorMask,
        11: glState.blend[0],
        12: glState.blend[1],
        13: glState.blend[2],
        14: glState.blend[3],
      };

      return parameters[name];
    },
    bindSampler: () => {},
    uniform1i: (name: string, value: unknown) => uniforms.set(name, value),
    uniform1f: (name: string, value: unknown) => uniforms.set(name, value),
    uniform2f: (name: string, ...values: number[]) => uniforms.set(name, values),
    uniform3f: (name: string, ...values: number[]) => uniforms.set(name, values),
    uniformMatrix4fv: (name: string, _transpose: boolean, value: unknown) => {
      uniforms.set(name, value);
    },
    activeTexture: (unit: number) => {
      activeUnit = unit - TEXTURE0;
    },
    bindTexture: (_target: unknown, texture: unknown) => boundTextures.set(activeUnit, texture),
    drawArrays: () =>
      draws.push({
        uniforms: new Map(uniforms),
        textures: new Map(boundTextures),
        colorMask: glState.colorMask,
        isScissored: glState.switches.get(4) === true,
      }),
    isContextLost: () => isContextLost,
  } as unknown as WebGL2RenderingContext;

  const mapLayers = new Map<string, CustomLayerInterface>();
  const canvas = {
    addEventListener: (name: string, listener: () => void, capture?: boolean) => {
      canvasListeners.push({ name, capture: capture === true, listener });
    },
    removeEventListener: (name: string, listener: () => void) => {
      const index = canvasListeners.findIndex(
        (entry) => entry.name === name && entry.listener === listener,
      );
      if (index >= 0) canvasListeners.splice(index, 1);
    },
  };

  const map = {
    getZoom: () => zoom,
    getBounds: () => ({
      getWest: () => 36.3,
      getEast: () => 36.7,
      getSouth: () => -1.7,
      getNorth: () => -1.3,
    }),
    triggerRepaint: () => {
      repaints++;
    },
    getCanvas: () => canvas,
    addLayer: (layer: CustomLayerInterface) => {
      mapLayers.set(layer.id, layer);
      layer.onAdd?.(map, gl);
    },
    removeLayer: (id: string) => {
      mapLayers.get(id)?.onRemove?.(map, gl);
      mapLayers.delete(id);
    },
    getLayer: (id: string) => mapLayers.get(id),
    on: (_type: "render", listener: () => void) => renderListeners.add(listener),
    off: (_type: string, listener: () => void) => renderListeners.delete(listener),
    getLayersOrder: () => [...mapLayers.keys()],
    getLayoutProperty: (id: string) => layoutProperties.get(id),
    setLayoutProperty: (id: string, _name: string, value: unknown) => {
      layoutProperties.set(id, value);
    },
    setLayerZoomRange: () => {},
    getMaxZoom: () => 22,
    isStyleLoaded: () => true,
  } as unknown as MapLibreMap;

  const input = {
    defaultProjectionData: { mainMatrix: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1] },
  } as unknown as CustomRenderMethodInput;

  return {
    gl,
    map,
    input,
    glState,
    boundTextures,
    failures,
    uniforms,
    draws,
    deleted,
    removed,
    canvasListeners,
    workers,
    store,
    created: () => created,
    repaints: () => repaints,
    now: () => time,
    /** Tell the map listeners that a frame has been drawn, as MapLibre's render event does. */
    endFrame: () => renderListeners.forEach((listener) => listener()),
    /** Fire a canvas event the way a browser does, listeners for capture first. */
    dispatch: (name: string) => {
      const entries = canvasListeners.filter((entry) => entry.name === name);
      for (const { listener } of [
        ...entries.filter((entry) => entry.capture),
        ...entries.filter((entry) => !entry.capture),
      ]) {
        listener();
      }
    },
    setContextLost: (value: boolean) => {
      isContextLost = value;
    },
    advance: (ms: number) => {
      time += ms;
    },
    setZoom: (value: number) => {
      zoom = value;
    },
    poolOptions: {
      now: () => time,
      createStore: () => store,
      createWorker: () => {
        const worker = new FlatWorker(
          () => pendingReplies++,
          () => pendingReplies--,
        );
        workers.push(worker);

        return worker;
      },
    },
    /** Let every posted load come back, so the next frames can upload them. */
    async landLoads() {
      // The posted-load callbacks lower pendingReplies while this loop waits.
      // oxlint-disable-next-line eslint/no-unmodified-loop-condition
      for (let turn = 0; turn < 50 && pendingReplies > 0; turn++) {
        await new Promise((resolve) => setTimeout(resolve, 0));
      }
    },
  };
}
