import type { Bbox } from "../types";

export interface SampleTable {
  width: number;
  height: number;
  src: Int32Array; // per output pixel: source cell index, or -1 when the cell is outside the mask
}

type Corners = [[number, number], [number, number], [number, number], [number, number]];

const MAX_HEIGHT = 4096;

export function mercY(lat: number) {
  return Math.log(Math.tan(Math.PI / 4 + (lat * Math.PI) / 360));
}

function latFromMercY(y: number) {
  return ((2 * Math.atan(Math.exp(y)) - Math.PI / 2) * 180) / Math.PI;
}

// MapLibre stretches an image linearly in Web Mercator, but grid rows are equally spaced in
// latitude. Output rows are equally spaced in Mercator y so the two agree.
export function sampleTable(
  grid: { bbox: Bbox; nx: number; ny: number },
  mask: ArrayLike<number>,
  maxHeight = MAX_HEIGHT,
): SampleTable {
  const { nx, ny } = grid;
  const [, south, , north] = grid.bbox;
  const rowDegrees = (north - south) / ny;
  const yTop = mercY(north);
  const yBottom = mercY(south);

  let finestRow = Infinity;
  for (let row = 0; row < ny; row++) {
    const rowTop = mercY(north - row * rowDegrees);
    const rowBottom = mercY(north - (row + 1) * rowDegrees);
    finestRow = Math.min(finestRow, rowTop - rowBottom);
  }
  // The small subtraction keeps rounding noise from adding a row to an already exact fit.
  const height = Math.min(maxHeight, Math.ceil((yTop - yBottom) / finestRow - 1e-9));
  const pixelHeight = (yTop - yBottom) / height;

  const src = new Int32Array(nx * height);
  for (let j = 0; j < height; j++) {
    const lat = latFromMercY(yTop - (j + 0.5) * pixelHeight);
    const row = Math.min(ny - 1, Math.max(0, Math.floor((north - lat) / rowDegrees)));
    for (let i = 0; i < nx; i++) {
      const cell = row * nx + i;
      src[j * nx + i] = mask[cell] ? cell : -1;
    }
  }
  return { width: nx, height, src };
}

// A centre above 180 would give MapLibre an out-of-range tile, so the image is drawn one
// world to the west instead.
export function imageCorners([west, south, east, north]: Bbox): Corners {
  const shift = (west + east) / 2 > 180 ? -360 : 0;
  return [
    [west + shift, north],
    [east + shift, north],
    [east + shift, south],
    [west + shift, south],
  ];
}
