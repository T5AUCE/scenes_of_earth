/** The texture layouts the GPU layers use; all are read without filtering. */
export type TextureFormat = "ids" | "floats" | "colors";

/** Everything a GPU layer creates, so that one call can free it. */
export interface GlResources {
  programs?: (WebGLProgram | null)[];
  textures?: (WebGLTexture | null)[];
  buffers?: (WebGLBuffer | null)[];
  vertexArrays?: (WebGLVertexArrayObject | null)[];
}

/** Compile and link a program, throwing the driver's log when either step fails. */
export function linkProgram(gl: WebGL2RenderingContext, vertex: string, fragment: string) {
  const shaders: WebGLShader[] = [];
  const program = gl.createProgram();
  if (!program) throw new Error("Cannot allocate a shader program");

  try {
    shaders.push(compileShader(gl, gl.VERTEX_SHADER, vertex));
    shaders.push(compileShader(gl, gl.FRAGMENT_SHADER, fragment));
    for (const shader of shaders) gl.attachShader(program, shader);
    gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
      throw new Error(`Cannot link the shader program: ${gl.getProgramInfoLog(program)}`);
    }
    return program;
  } catch (error) {
    gl.deleteProgram(program);
    throw error;
  } finally {
    // The program retains the code after the shader objects are deleted.
    for (const shader of shaders) gl.deleteShader(shader);
  }
}

function compileShader(gl: WebGL2RenderingContext, type: number, source: string) {
  const shader = gl.createShader(type);
  if (!shader) throw new Error("Cannot allocate a shader");

  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (gl.getShaderParameter(shader, gl.COMPILE_STATUS)) return shader;

  const log = gl.getShaderInfoLog(shader);
  gl.deleteShader(shader);
  throw new Error(`Cannot compile a shader: ${log}`);
}

/** Upload a texture of one channel (or RGBA for colors), throwing when the GPU rejects it. */
export function uploadTexture(
  gl: WebGL2RenderingContext,
  format: TextureFormat,
  width: number,
  height: number,
  data: ArrayBufferView,
) {
  const { internal, layout, type } = layoutOf(gl, format);
  const texture = gl.createTexture();
  if (!texture) throw new Error("Cannot allocate a texture");

  const alignment = gl.getParameter(gl.UNPACK_ALIGNMENT) as number;
  const flipY = gl.getParameter(gl.UNPACK_FLIP_Y_WEBGL) as boolean;
  const premultiply = gl.getParameter(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL) as boolean;
  const rowLength = gl.getParameter(gl.UNPACK_ROW_LENGTH) as number;
  const skipRows = gl.getParameter(gl.UNPACK_SKIP_ROWS) as number;
  const skipPixels = gl.getParameter(gl.UNPACK_SKIP_PIXELS) as number;
  const unpackBuffer = gl.getParameter(gl.PIXEL_UNPACK_BUFFER_BINDING) as WebGLBuffer | null;
  gl.bindBuffer(gl.PIXEL_UNPACK_BUFFER, null);
  gl.bindTexture(gl.TEXTURE_2D, texture);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);

  // Grid rows have no padding and must not inherit MapLibre's image unpack settings.
  gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
  gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
  gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
  gl.pixelStorei(gl.UNPACK_ROW_LENGTH, 0);
  gl.pixelStorei(gl.UNPACK_SKIP_ROWS, 0);
  gl.pixelStorei(gl.UNPACK_SKIP_PIXELS, 0);
  gl.texImage2D(gl.TEXTURE_2D, 0, internal, width, height, 0, layout, type, data);
  const error = gl.getError();
  gl.pixelStorei(gl.UNPACK_ALIGNMENT, alignment);
  gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, flipY);
  gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, premultiply);
  gl.pixelStorei(gl.UNPACK_ROW_LENGTH, rowLength);
  gl.pixelStorei(gl.UNPACK_SKIP_ROWS, skipRows);
  gl.pixelStorei(gl.UNPACK_SKIP_PIXELS, skipPixels);
  gl.bindBuffer(gl.PIXEL_UNPACK_BUFFER, unpackBuffer);

  if (error !== gl.NO_ERROR) {
    gl.deleteTexture(texture);
    throw new Error(`Cannot upload a ${width} x ${height} texture (GL error ${error})`);
  }
  return texture;
}

function layoutOf(gl: WebGL2RenderingContext, format: TextureFormat) {
  switch (format) {
    case "ids":
      return { internal: gl.R8UI, layout: gl.RED_INTEGER, type: gl.UNSIGNED_BYTE };
    case "floats":
      return { internal: gl.R32F, layout: gl.RED, type: gl.FLOAT };
    case "colors":
      return { internal: gl.RGBA8, layout: gl.RGBA, type: gl.UNSIGNED_BYTE };
  }
}

/** Free every resource in the lists; entries that are already gone are skipped. */
export function deleteResources(gl: WebGL2RenderingContext, resources: GlResources) {
  resources.programs?.forEach((program) => program && gl.deleteProgram(program));
  resources.textures?.forEach((texture) => texture && gl.deleteTexture(texture));
  resources.buffers?.forEach((buffer) => buffer && gl.deleteBuffer(buffer));
  resources.vertexArrays?.forEach((array) => array && gl.deleteVertexArray(array));
}
