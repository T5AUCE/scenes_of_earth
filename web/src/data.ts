import * as zarr from "zarrita";

import type { ArrayDoc, LayerDoc } from "./types";

/** An opened bundle store, as returned by openStore. */
export type Store = Awaited<ReturnType<typeof openStore>>;

type OpenedArray = Awaited<ReturnType<typeof openArray>>;

type Encoding = Pick<ArrayDoc, "scale_factor" | "add_offset" | "fill">;

// An opened array keeps the shard indexes it has read, so it is opened once per path.
const openedArrays = new WeakMap<object, Map<string, Promise<OpenedArray>>>();

/** Opens a bundle's Zarr v3 store; suffix ranges read a shard index without a HEAD first. */
export function openStore(href: string) {
  const store = new zarr.FetchStore(href, { useSuffixRequest: true });
  return zarr.withMaybeConsolidatedMetadata(store, { format: "v3" });
}

/** Reads a selection of one array from the bundle's Zarr store. */
export async function readArray(store: Store, path: string, selection: (number | null)[]) {
  const array = await openedArray(store, path);
  const chunk = await zarr.get(array, selection);
  return chunk.data as ArrayLike<number>;
}

/** Reads the layer's whole inside-the-area mask. */
export const readMask = (store: Store, layer: LayerDoc) =>
  readArray(store, layer.mask.path, [null, null]);

/** The layer's array for a role; throws when the layer has none. */
export function arrayDoc(layer: LayerDoc, role: string) {
  const doc = layer.arrays[role];
  if (!doc) throw new Error(`Layer "${layer.id}" has no "${role}" array`);

  return doc;
}

/** Applies scale factor and offset; fill values become NaN. */
export function decode(raw: ArrayLike<number>, doc: Encoding) {
  const values = new Float32Array(raw.length);
  for (let index = 0; index < raw.length; index++) {
    const isFill = raw[index] === doc.fill;
    values[index] = isFill ? NaN : raw[index] * doc.scale_factor + doc.add_offset;
  }
  return values;
}

/** Keeps the most recently used results; a failed load is dropped so it can be retried. */
export function cacheByIndex<T>(limit: number, load: (index: number) => Promise<T>) {
  const entries = new Map<number, Promise<T>>();

  return (index: number) => {
    let entry = entries.get(index);
    if (entry) {
      entries.delete(index);
    } else {
      entry = load(index);
      entry.catch(() => entries.delete(index));
    }

    entries.set(index, entry);

    if (entries.size > limit) entries.delete(entries.keys().next().value!);

    return entry;
  };
}

function openedArray(store: Store, path: string) {
  const arrays = openedArrays.get(store) ?? new Map<string, Promise<OpenedArray>>();
  openedArrays.set(store, arrays);

  if (!arrays.has(path)) {
    const opening = openArray(store, path);
    // A failed open is dropped so it can be retried.
    opening.catch(() => arrays.delete(path));
    arrays.set(path, opening);
  }
  return arrays.get(path)!;
}

function openArray(store: Store, path: string) {
  return zarr.open.v3(zarr.root(store).resolve(path), { kind: "array" });
}
