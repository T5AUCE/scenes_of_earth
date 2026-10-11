import * as zarr from "zarrita";
import type { ArrayDoc, LayerDoc } from "./types";

export type Store = Awaited<ReturnType<typeof openStore>>;

// Bundles are Zarr v3 only, so the v2 probes are skipped. Without consolidated metadata each
// array's own zarr.json is read instead. Suffix ranges read a shard's index in one request
// instead of a HEAD first.
export function openStore(href: string) {
  const store = new zarr.FetchStore(href, { useSuffixRequest: true });
  return zarr.withMaybeConsolidatedMetadata(store, { format: "v3" });
}

type OpenedArray = Awaited<ReturnType<typeof openArray>>;

// An opened array keeps the shard indexes it has read, so it is opened once per path.
const openedArrays = new WeakMap<object, Map<string, Promise<OpenedArray>>>();

function openArray(store: Store, path: string) {
  return zarr.open.v3(zarr.root(store).resolve(path), { kind: "array" });
}

export async function readArray(store: Store, path: string, selection: (number | null)[]) {
  const arrays = openedArrays.get(store) ?? new Map<string, Promise<OpenedArray>>();
  openedArrays.set(store, arrays);
  if (!arrays.has(path)) arrays.set(path, openArray(store, path));

  const array = await arrays.get(path)!;
  const chunk = await zarr.get(array, selection);
  return chunk.data as ArrayLike<number>;
}

export function arrayDoc(layer: LayerDoc, role: string) {
  const doc = layer.arrays[role];
  if (!doc) throw new Error(`Layer "${layer.id}" has no "${role}" array`);
  return doc;
}

export const readMask = (store: Store, layer: LayerDoc) =>
  readArray(store, layer.mask.path, [null, null]);

type Encoding = Pick<ArrayDoc, "scale_factor" | "add_offset" | "fill">;

export function decode(raw: ArrayLike<number>, doc: Encoding) {
  const values = new Float32Array(raw.length);
  for (let i = 0; i < raw.length; i++) {
    values[i] = raw[i] === doc.fill ? NaN : raw[i] * doc.scale_factor + doc.add_offset;
  }
  return values;
}

// Keeps the most recently used results; a failed load is dropped so it can be retried.
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
