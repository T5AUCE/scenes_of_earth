import { registerHooks } from "node:module";

import type { CustomRenderMethodInput, Map as MapLibreMap } from "maplibre-gl";

const hooks = registerHooks({
  resolve(specifier, context, next) {
    if (
      context.parentURL?.includes("/src/gpu/")
      && specifier.startsWith("./")
      && !specifier.endsWith(".ts")
    ) {
      return next(new URL(`${specifier}.ts`, context.parentURL).href, context);
    }
    return next(specifier, context);
  },
});
const { createClassFieldLayer } = await import("./class-field-layer.ts");
/** The tiled layer base class, loaded through the same import hooks. */
export const { TiledGpuLayer } = await import("./tiled-layer.ts")
  .finally(() => hooks.deregister());

/** A fake WebGL context and map around a class-field layer, recording uploads, draws and deletes. */
export function createHarness(
  options: {
    compile?: boolean;
    link?: boolean;
    uploadError?: number;
    globe?: boolean;
    nx?: number;
    maxTextureSize?: number;
  } = {},
) {
  const deleted = {
    programs: [] as object[],
    shaders: [] as object[],
    textures: [] as object[],
    buffers: [] as object[],
    arrays: [] as object[],
  };
  const listeners = new Map<string, (event: object) => void>();
  const uploads: unknown[][] = [];
  const draws: unknown[][] = [];
  const failures: Error[] = [];
  const uniforms = new Map<string, unknown>();
  let vertexArray: unknown = null;
  let repaints = 0;
  const gl = {
    MAX_TEXTURE_SIZE: 1,
    COMPILE_STATUS: 2,
    LINK_STATUS: 3,
    NO_ERROR: 0,
    createProgram: () => ({}),
    createShader: () => ({}),
    shaderSource: () => {},
    compileShader: () => {},
    getShaderParameter: () => options.compile ?? true,
    getShaderInfoLog: () => "driver log",
    attachShader: () => {},
    linkProgram: () => {},
    getProgramParameter: () => options.link ?? true,
    getProgramInfoLog: () => "driver log",
    deleteShader: (value: object) => deleted.shaders.push(value),
    deleteProgram: (value: object) => deleted.programs.push(value),
    createVertexArray: () => ({}),
    createBuffer: () => ({}),
    bindVertexArray: (value: unknown) => {
      vertexArray = value;
    },
    bindBuffer: () => {},
    bindSampler: () => {},
    bufferData: () => {},
    getAttribLocation: () => 0,
    enableVertexAttribArray: () => {},
    vertexAttribPointer: () => {},
    deleteBuffer: (value: object) => deleted.buffers.push(value),
    deleteVertexArray: (value: object) => deleted.arrays.push(value),
    createTexture: () => ({}),
    bindTexture: () => {},
    texParameteri: () => {},
    pixelStorei: () => {},
    texImage2D: (...args: unknown[]) => uploads.push(args),
    getError: () => options.uploadError ?? 0,
    deleteTexture: (value: object) => deleted.textures.push(value),
    getParameter: (name: number) => name === 1 ? options.maxTextureSize ?? 4096 : 0,
    getUniformLocation: (_program: unknown, name: string) => name,
    uniform1i: (name: string, value: unknown) => uniforms.set(name, value),
    uniform1f: (name: string, value: unknown) => uniforms.set(name, value),
    uniform2i: () => {},
    uniform4f: () => {},
    uniformMatrix4fv: (name: string, _transpose: boolean, value: unknown) => {
      uniforms.set(name, value);
    },
    activeTexture: () => {},
    useProgram: () => {},
    drawArrays: (...args: unknown[]) => draws.push(args),
  } as unknown as WebGL2RenderingContext;
  const map = {
    triggerRepaint: () => {
      repaints++;
    },
    getProjection: () => ({ type: options.globe ? "globe" : "mercator" }),
    getCanvas: () => ({
      addEventListener: (name: string, listener: (event: object) => void) => {
        listeners.set(name, listener);
      },
      removeEventListener: (name: string) => listeners.delete(name),
    }),
  } as unknown as MapLibreMap;
  const field = createClassFieldLayer({
    id: "classes",
    grid: { bbox: [36, -2, 37, -1], nx: options.nx ?? 4, ny: 3 },
    shift: 0,
    opacity: 0.8,
    edges: { smooth: true, rounding: 0.25, softnessCells: 0, outline: false },
    onFail: (error) => failures.push(error),
  });
  const input = {
    modelViewProjectionMatrix: new Float64Array(16),
    defaultProjectionData: {
      mainMatrix: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1],
    },
  } as unknown as CustomRenderMethodInput;
  return {
    field,
    gl,
    map,
    input,
    listeners,
    uploads,
    draws,
    failures,
    uniforms,
    deleted,
    vertexArray: () => vertexArray,
    repaints: () => repaints,
  };
}

