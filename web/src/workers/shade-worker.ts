/** Shades DEM tiles into transparent raster tiles away from the main thread. */
import { decodeHeights, shadeTile, type ShadeTileId } from "./shade-tile";
import { DemCache, MAX_CONCURRENT_SHADE_JOBS, ShadeQueue } from "./shade-queue";

/** What the main thread asks for: one shaded tile, cancellable by id. */
export type ShadeWorkerRequest =
  | {
    type: "shade";
    id: number;
    tile: ShadeTileId;
    strength: number;
    demUrl: string;
  }
  | { type: "cancel"; id: number };

/** The answer to one shade request: a bitmap on success, otherwise the failure text. */
export type ShadeWorkerResponse =
  | { id: number; bitmap: ImageBitmap }
  | { id: number; error: string };

const ABORT_MESSAGE = "aborted";

// Neighbouring tiles share borders, so a few decoded tiles spare most refetching and decoding.
const tileCache = new DemCache(fetchHeights);
// Visible tiles arrive in bursts and neighbours overlap, so a few lanes share the loads.
const jobQueue = new ShadeQueue(MAX_CONCURRENT_SHADE_JOBS);
// Each request id maps to whether the main thread cancelled it while it runs or waits.
const cancelled = new Map<number, boolean>();

onmessage = (event: MessageEvent<ShadeWorkerRequest>) => {
  const request = event.data;
  if (request.type === "cancel") {
    cancelShade(request.id);
    return;
  }

  cancelled.set(request.id, false);
  jobQueue.add(request.id, () => void shade(request));
};

function cancelShade(id: number): void {
  if (!cancelled.has(id)) return;
  cancelled.set(id, true);
  // A queued job never starts, so it needs no settlement; a running one notices it below.
  if (jobQueue.cancel(id)) cancelled.delete(id);
  tileCache.release(id);
}

async function shade(request: Extract<ShadeWorkerRequest, { type: "shade" }>): Promise<void> {
  try {
    // A cancelled request stops before the shading, which is the costly step.
    const pixels = await shadeTile(request.tile, request.strength, async (tile) => {
      const heights = await tileCache.load(tileUrl(tile, request.demUrl), request.id);
      if (cancelled.get(request.id)) throw new Error(ABORT_MESSAGE);

      return heights;
    });
    const size = Math.sqrt(pixels.length / 4);
    const bitmap = await createImageBitmap(new ImageData(pixels, size, size), {
      premultiplyAlpha: "premultiply",
    });
    postMessage({ id: request.id, bitmap } satisfies ShadeWorkerResponse, { transfer: [bitmap] });
  } catch (error) {
    postMessage({ id: request.id, error: (error as Error).message } satisfies ShadeWorkerResponse);
  } finally {
    cancelled.delete(request.id);
    tileCache.release(request.id);
    jobQueue.finish();
  }
}

function tileUrl(tile: ShadeTileId, demUrl: string): string {
  return demUrl
    .replace("{z}", String(tile.z))
    .replace("{x}", String(tile.x))
    .replace("{y}", String(tile.y));
}

async function fetchHeights(url: string, signal: AbortSignal): Promise<Float32Array | null> {
  const response = await fetch(url, { signal });
  if (response.status === 404) return null;
  if (!response.ok) throw new Error(`Bad response: ${response.status} for ${url}`);

  const bitmap = await createImageBitmap(await response.blob(), {
    premultiplyAlpha: "none",
    colorSpaceConversion: "none",
  });
  const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
  const context = canvas.getContext("2d", { willReadFrequently: true })!;
  context.drawImage(bitmap, 0, 0);
  bitmap.close();
  const { data } = context.getImageData(0, 0, canvas.width, canvas.height);
  return decodeHeights(data);
}
