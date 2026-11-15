/** Fetches and decodes DEM tiles away from the main thread for the DEM pool. */
import { loadDemTile } from "./dem-decode";

/** Asks the worker to load one tile by url or to end an earlier request. */
export type DemWorkerRequest =
  | { type: "load"; id: number; url: string }
  | { type: "cancel"; id: number };

/** Answers one load with the decoded tile, a missing tile or the failure text. */
export type DemWorkerResponse =
  | { kind: "tile"; id: number; heights: Float32Array; strips: Float32Array; decodeMs: number }
  | { kind: "missing"; id: number }
  | { kind: "error"; id: number; message: string };

const controllers = new Map<number, AbortController>();

onmessage = (event: MessageEvent<DemWorkerRequest>) => {
  const request = event.data;
  if (request.type === "cancel") {
    controllers.get(request.id)?.abort();
    return;
  }

  void load(request.id, request.url);
};

async function load(id: number, url: string): Promise<void> {
  const controller = new AbortController();
  controllers.set(id, controller);

  try {
    const tile = await loadDemTile(url, controller.signal);

    // A cancel during decode leaves a stale tile that the pool no longer wants.
    if (controller.signal.aborted) return;

    if (!tile) {
      postMessage({ kind: "missing", id } satisfies DemWorkerResponse);
      return;
    }

    const { heights, strips, decodeMs } = tile;
    postMessage({ kind: "tile", id, heights, strips, decodeMs } satisfies DemWorkerResponse, {
      transfer: [heights.buffer, strips.buffer],
    });
  } catch (error) {
    // The pool already dropped a cancelled request, so it needs no answer.
    if (controller.signal.aborted) return;

    const message = (error as Error).message;
    postMessage({ kind: "error", id, message } satisfies DemWorkerResponse);
  } finally {
    // A newer request with the same id may have replaced this controller.
    if (controllers.get(id) === controller) controllers.delete(id);
  }
}
