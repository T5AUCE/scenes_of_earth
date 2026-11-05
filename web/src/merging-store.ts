/** A Zarr store wrapper that merges the byte ranges of one shard asked for in the same tick. */
import type * as zarr from "zarrita";

const REQUEST_MAX_BYTES = 8 * 1024 * 1024;
const REQUEST_GAP_BYTES = 64 * 1024; // chunks closer than this share one request

type FetchOptions = Parameters<zarr.AsyncReadable["get"]>[1];

/** A caller's byte range of a shard, settled with exactly those bytes. */
interface WantedRange {
  offset: number;
  length: number;
  resolve(bytes: Uint8Array | undefined): void;
  reject(error: unknown): void;
}

interface RangeGroup {
  start: number;
  end: number;
  wanted: WantedRange[];
}

/**
 * Lets the byte ranges asked for one shard in the same tick travel in one covering request, which
 * matters because every request costs a round trip and a bill. Reads that are not byte ranges
 * pass through unchanged.
 */
export function mergingStore(
  fetching: zarr.AsyncReadable,
  maxBytes = REQUEST_MAX_BYTES,
): zarr.AsyncReadable {
  const getRange = fetching.getRange!.bind(fetching);
  const waiting = new Map<string, WantedRange[]>();

  const flush = (key: zarr.AbsolutePath, options: FetchOptions) => {
    const wanted = waiting.get(key)!;
    waiting.delete(key);
    for (const group of groupRanges(wanted, maxBytes)) {
      void fetchGroup(getRange, key, group, options);
    }
  };

  return {
    get(key, options) {
      return fetching.get(key, options);
    },
    getRange(key, range, options) {
      if (!("offset" in range)) return getRange(key, range, options);

      return new Promise((resolve, reject) => {
        const wanted = { offset: range.offset, length: range.length, resolve, reject };
        const existing = waiting.get(key);
        if (existing) {
          existing.push(wanted);
          return;
        }

        waiting.set(key, [wanted]);
        setTimeout(() => flush(key, options), 0);
      });
    },
  };
}

/** Joins ranges that touch or nearly touch while a covering request stays under the byte cap. */
function groupRanges(wanted: WantedRange[], maxBytes: number): RangeGroup[] {
  const groups: RangeGroup[] = [];
  const byOffset = [...wanted].sort((first, second) => first.offset - second.offset);
  for (const range of byOffset) {
    const end = range.offset + range.length;
    const group = groups.at(-1);
    const isNear = group !== undefined && range.offset - group.end <= REQUEST_GAP_BYTES;
    if (group && isNear && Math.max(end, group.end) - group.start <= maxBytes) {
      group.end = Math.max(end, group.end);
      group.wanted.push(range);
    } else {
      groups.push({ start: range.offset, end, wanted: [range] });
    }
  }
  return groups;
}

async function fetchGroup(
  getRange: NonNullable<zarr.AsyncReadable["getRange"]>,
  key: zarr.AbsolutePath,
  group: RangeGroup,
  options: FetchOptions,
) {
  const length = group.end - group.start;
  try {
    const bytes = await getRange(key, { offset: group.start, length }, options);
    for (const range of group.wanted) {
      // A copy keeps the bytes aligned at the start of their own buffer for the codecs.
      const from = range.offset - group.start;
      range.resolve(bytes?.slice(from, from + range.length));
    }
  } catch (error) {
    group.wanted.forEach((range) => range.reject(error));
  }
}
