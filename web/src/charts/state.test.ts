import assert from "node:assert/strict";
import { afterEach, test } from "node:test";

import {
  CHARTS_PARAM,
  CHARTS_VERSION,
  defaultSlice,
  decodeToken,
  encodeSlice,
  formatChartsParam,
  chartsTokenFor,
  INVALID_CHARTS_NOTICE,
  isCompleteUrlOversized,
  isValidSlice,
  loadStoredSlice,
  MAX_COMPLETE_URL_CHARS,
  MAX_DECODED_BYTES,
  MAX_DEFINITIONS,
  MAX_TITLE_CHARS,
  MAX_TOKEN_CHARS,
  resolveCharts,
  STORAGE_DENIED_NOTICE,
  storageKeyFor,
  storeSlice,
  TOO_LARGE_CHARTS_NOTICE,
  UNSYNCED_CHARTS_NOTICE,
  type ChartSlice,
} from "./state.ts";
import { defaultOptionsFor } from "./definitions.ts";
import type { LayerDoc } from "../types.ts";

const LAYERS = [rainLayer(), terrainLayer()];

afterEach(() => {
  Reflect.deleteProperty(globalThis, "localStorage");
});

test("the slice version and limits are named", () => {
  assert.equal(CHARTS_VERSION, 1);
  assert.equal(MAX_DEFINITIONS, 32);
  assert.equal(MAX_TITLE_CHARS, 120);
  assert.equal(MAX_DECODED_BYTES, 32 * 1024);
  assert.equal(MAX_TOKEN_CHARS, Math.ceil((MAX_DECODED_BYTES * 4) / 3));
  assert.equal(MAX_COMPLETE_URL_CHARS, 8 * 1024);
  assert.ok(MAX_TOKEN_CHARS > MAX_DECODED_BYTES);
  assert.equal(CHARTS_PARAM, "charts");
});

test("every option round trips through the token", () => {
  const slice: ChartSlice = {
    version: 1,
    definitions: [
      {
        id: "rain:time_series",
        title: "Rain over time",
        source: { layerId: "rain", shape: "time_series" },
        chartType: "bar",
        options: {
          ...defaultOptionsFor(),
          ink: "#1a2b3c",
          displayUnit: "in/month",
          xTitle: "Time",
          yTitle: "Rain",
          yRange: [0, 250.75],
          showGrid: false,
          showPoints: true,
          showCurrentTime: false,
          showReferences: true,
        },
      },
    ],
    mainChartId: "rain:time_series",
  };

  const { slice: decoded, notice } = decodeToken(encodeSlice(slice), LAYERS);

  assert.equal(notice, null);
  assert.deepEqual(decoded, slice);
});

test("the codec rejects versions, duplicates, shapes, types and bad options", () => {
  const valid = defaultSlice(LAYERS);
  assert.equal(isValidSlice(valid, LAYERS), true);

  const badVersion = { ...valid, version: 2 };
  assert.equal(isValidSlice(badVersion, LAYERS), false);

  const duplicate = { ...valid, definitions: [valid.definitions[0], valid.definitions[0]] };
  assert.equal(isValidSlice(duplicate, LAYERS), false);

  const badShape = {
    ...valid,
    definitions: [{ ...valid.definitions[0], source: { layerId: "rain", shape: "pie" } }],
  };
  assert.equal(isValidSlice(badShape, LAYERS), false);

  const badType = { ...valid, definitions: [{ ...valid.definitions[0], chartType: "pie" }] };
  assert.equal(isValidSlice(badType, LAYERS), false);

  const badUnit = {
    ...valid,
    definitions: [
      { ...valid.definitions[0], options: { displayUnit: "kelvin" } },
    ],
  };
  assert.equal(isValidSlice(badUnit, LAYERS), false);

  const badMain = { ...valid, mainChartId: "missing" };
  assert.equal(isValidSlice(badMain, LAYERS), false);

  const nullMain = { ...valid, mainChartId: null };
  assert.equal(isValidSlice(nullMain, LAYERS), false);

  const emptyForAvailable = { version: 1 as const, definitions: [], mainChartId: null };
  assert.equal(isValidSlice(emptyForAvailable, LAYERS), false);
  assert.equal(isValidSlice(emptyForAvailable, []), true);

  const missingOptions = {
    ...valid,
    definitions: [{ ...valid.definitions[0], options: undefined }],
  };
  assert.equal(isValidSlice(missingOptions, LAYERS), false);

  const nullOptions = {
    ...valid,
    definitions: [{ ...valid.definitions[0], options: null }],
  };
  assert.equal(isValidSlice(nullOptions, LAYERS), false);

  const arrayOptions = {
    ...valid,
    definitions: [{ ...valid.definitions[0], options: [] }],
  };
  assert.equal(isValidSlice(arrayOptions, LAYERS), false);

  const arrayInk = {
    ...valid,
    definitions: [
      { ...valid.definitions[0], options: { ...valid.definitions[0].options, ink: ["#123456"] } },
    ],
  };
  assert.equal(isValidSlice(arrayInk, LAYERS), false);

  const hostileInk = {
    ...valid,
    definitions: [
      {
        ...valid.definitions[0],
        options: { ...valid.definitions[0].options, ink: { toString: null } },
      },
    ],
  };
  assert.equal(isValidSlice(hostileInk, LAYERS), false);

  const tooMany = {
    ...valid,
    definitions: Array.from({ length: 33 }, (_, index) => ({
      ...valid.definitions[0],
      id: `id-${index}`,
    })),
  };
  assert.equal(isValidSlice(tooMany, LAYERS), false);

  assert.equal(decodeToken(encodeSlice(badVersion as ChartSlice), LAYERS).slice, null);
  assert.equal(decodeToken("!!!", LAYERS).notice, INVALID_CHARTS_NOTICE);
  assert.equal(decodeToken("x".repeat(MAX_TOKEN_CHARS + 1), LAYERS).notice, INVALID_CHARTS_NOTICE);
});

test("malformed options fail closed through link and storage paths", () => {
  const valid = defaultSlice(LAYERS);
  const cases = [
    { ...valid.definitions[0], options: undefined },
    { ...valid.definitions[0], options: null },
    { ...valid.definitions[0], options: [] },
    { ...valid.definitions[0], options: { ink: ["#123456"] } },
    { ...valid.definitions[0], options: { ink: { toString: null } } },
  ];

  for (const definition of cases) {
    const slice = { version: 1 as const, definitions: [definition], mainChartId: definition.id };
    assert.equal(isValidSlice(slice, LAYERS), false);

    const token = encodeSlice(slice as unknown as ChartSlice);
    const decoded = decodeToken(token, LAYERS);
    assert.equal(decoded.slice, null);
    assert.equal(decoded.notice, INVALID_CHARTS_NOTICE);

    const items = useStorage();
    items.set(storageKeyFor("scene-a"), JSON.stringify(slice));
    const loaded = loadStoredSlice("scene-a", LAYERS);
    assert.deepEqual(loaded.slice, defaultSlice(LAYERS));
    assert.equal(loaded.notice, INVALID_CHARTS_NOTICE);
  }
});

test("titles beyond 120 characters never enter a slice", () => {
  const slice = defaultSlice(LAYERS);
  const long = { ...slice.definitions[0], title: "x".repeat(MAX_TITLE_CHARS + 1) };

  assert.equal(isValidSlice({ ...slice, definitions: [long] }, LAYERS), false);
});

test("scenes stay isolated in storage and denied storage keeps a working slice", () => {
  useStorage();
  const slice = defaultSlice(LAYERS);

  assert.deepEqual(storeSlice("scene-a", slice), { saved: true, notice: null });
  const loaded = loadStoredSlice("scene-a", LAYERS);
  assert.deepEqual(loaded.slice, slice);
  assert.equal(loaded.stored, true);
  assert.equal(loadStoredSlice("scene-b", LAYERS).stored, false);

  useBlockedStorage();
  assert.deepEqual(storeSlice("scene-a", slice), { saved: false, notice: STORAGE_DENIED_NOTICE });
  const denied = loadStoredSlice("scene-a", LAYERS);
  assert.equal(denied.stored, false);
  assert.equal(denied.notice, STORAGE_DENIED_NOTICE);
  assert.deepEqual(denied.slice, defaultSlice(LAYERS));
  assert.equal(storageKeyFor("scene-a"), "soe.charts.v1.scene-a");
});

test("throwing getters and failed writes return nonblocking notices", () => {
  Object.assign(globalThis, {
    localStorage: {
      getItem: () => {
        throw new Error("blocked");
      },
      setItem: () => {},
      removeItem: () => {},
    },
  });
  const readDenied = loadStoredSlice("scene-a", LAYERS);
  assert.equal(readDenied.stored, false);
  assert.equal(readDenied.notice, STORAGE_DENIED_NOTICE);

  Object.assign(globalThis, {
    localStorage: {
      getItem: () => null,
      setItem: () => {
        throw new Error("blocked");
      },
      removeItem: () => {},
    },
  });
  const writeDenied = storeSlice("scene-a", defaultSlice(LAYERS));
  assert.equal(writeDenied.saved, false);
  assert.equal(writeDenied.notice, STORAGE_DENIED_NOTICE);
});

test("corrupt storage falls back with a notice instead of throwing", () => {
  const items = useStorage();
  items.set(storageKeyFor("scene-a"), "broken JSON");

  const loaded = loadStoredSlice("scene-a", LAYERS);

  assert.equal(loaded.notice, INVALID_CHARTS_NOTICE);
  assert.deepEqual(loaded.slice, defaultSlice(LAYERS));
});

test("links beat storage which beats defaults without merging deleted charts", () => {
  const defaults = defaultSlice(LAYERS);
  const stored: ChartSlice = {
    version: 1,
    definitions: [defaults.definitions[0]],
    mainChartId: defaults.definitions[0].id,
  };
  const linked = encodeSlice(stored);

  assert.deepEqual(resolveCharts(LAYERS, linked, defaults).slice, stored);
  assert.equal(resolveCharts(LAYERS, linked, defaults).source, "link");
  assert.equal(resolveCharts(LAYERS, linked, defaults).sessionOnly, true);

  const invalid = resolveCharts(LAYERS, "!!!", stored);
  assert.deepEqual(invalid.slice, stored);
  assert.equal(invalid.notice, INVALID_CHARTS_NOTICE);
  assert.equal(invalid.sessionOnly, true);

  assert.deepEqual(resolveCharts(LAYERS, null, stored).slice, stored);
  assert.equal(resolveCharts(LAYERS, null, stored).sessionOnly, false);
  assert.deepEqual(resolveCharts(LAYERS, null, null).slice, defaults);
});

test("invalid links stay session-only so later saves never touch storage", () => {
  const items = useStorage();
  const stored = defaultSlice(LAYERS);
  items.set(storageKeyFor("scene-a"), JSON.stringify(stored));

  const resolved = resolveCharts(LAYERS, "!!!", stored);
  assert.equal(resolved.sessionOnly, true);
  assert.equal(resolved.source, "stored");

  let writes = 0;
  const originalSet = globalThis.localStorage.setItem;
  (globalThis.localStorage as { setItem: (key: string, value: string) => void }).setItem = (
    key: string,
    value: string,
  ) => {
    writes++;
    originalSet(key, value);
  };
  try {
    if (!resolved.sessionOnly) storeSlice("scene-a", resolved.slice);
  } finally {
    (globalThis.localStorage as { setItem: (key: string, value: string) => void }).setItem =
      originalSet;
  }
  assert.equal(writes, 0);
});

test("chart params serialize with URLSearchParams and parse back", () => {
  const slice = defaultSlice(LAYERS);
  const param = formatChartsParam(slice);

  assert.ok(param.startsWith("&charts="));
  assert.ok(!param.includes("%3A"));
  const token = chartsTokenFor(`?scene=abc${param}`);
  assert.equal(typeof token, "string");
  assert.deepEqual(decodeToken(token, LAYERS).slice, slice);
  assert.equal(formatChartsParam(null), "");
  assert.equal(chartsTokenFor("?scene=abc"), null);
});

test("oversized complete URLs use a persistence-neutral notice", () => {
  useStorage();
  const slice = defaultSlice(LAYERS);
  assert.deepEqual(storeSlice("scene-a", slice), { saved: true, notice: null });
  assert.equal(loadStoredSlice("scene-a", LAYERS).stored, true);

  const token = encodeSlice(slice);
  const typical = `?scene=0123456789abcdef0123&t=2019-03&pal=rain:batlow&charts=${token}`;
  assert.equal(isCompleteUrlOversized(typical), false);
  assert.ok(typical.length < MAX_COMPLETE_URL_CHARS);

  const oversized = `?scene=0123456789abcdef0123&charts=${"a".repeat(MAX_COMPLETE_URL_CHARS)}`;
  assert.equal(isCompleteUrlOversized(oversized), true);
  assert.equal(UNSYNCED_CHARTS_NOTICE, "The share link is too long to include these charts.");
  assert.equal(UNSYNCED_CHARTS_NOTICE.includes("visit"), false);
  assert.equal(UNSYNCED_CHARTS_NOTICE.includes("browser"), false);
  assert.equal(UNSYNCED_CHARTS_NOTICE.includes("storage"), false);
  assert.equal(loadStoredSlice("scene-a", LAYERS).stored, true);

  useBlockedStorage();
  assert.deepEqual(storeSlice("scene-a", slice), {
    saved: false,
    notice: STORAGE_DENIED_NOTICE,
  });
  assert.equal(loadStoredSlice("scene-a", LAYERS).notice, STORAGE_DENIED_NOTICE);
  assert.equal(resolveCharts(LAYERS, "!!!", slice).sessionOnly, true);
});

test("valid slices save and reload at the exact byte limit", () => {
  const items = useStorage();
  const makeSlice = (id: string, title: string): ChartSlice => ({
    version: 1,
    definitions: [
      {
        id,
        title,
        source: { layerId: "rain", shape: "time_series" },
        chartType: "bar",
        options: defaultOptionsFor(),
      },
    ],
    mainChartId: id,
  });

  const emptySize = new TextEncoder().encode(JSON.stringify(makeSlice("", "T"))).length;
  const remaining = MAX_DECODED_BYTES - emptySize;
  const idLength = Math.floor(remaining / 2);
  const extraTitleChars = remaining - idLength * 2;
  const id = "a".repeat(idLength);
  const title = `T${"b".repeat(extraTitleChars)}`;
  const exact = makeSlice(id, title);
  assert.equal(new TextEncoder().encode(JSON.stringify(exact)).length, MAX_DECODED_BYTES);
  assert.equal(isValidSlice(exact, LAYERS), true);
  assert.deepEqual(storeSlice("scene-a", exact), { saved: true, notice: null });

  const reloaded = loadStoredSlice("scene-a", LAYERS);
  assert.equal(reloaded.stored, true);
  assert.equal(reloaded.notice, null);
  assert.deepEqual(reloaded.slice, exact);

  const over = makeSlice(id, `${title}x`);
  assert.equal(new TextEncoder().encode(JSON.stringify(over)).length, MAX_DECODED_BYTES + 1);
  assert.equal(isValidSlice(over, LAYERS), true);
  assert.deepEqual(storeSlice("scene-a", over), {
    saved: false,
    notice: TOO_LARGE_CHARTS_NOTICE,
  });
  assert.equal(items.get(storageKeyFor("scene-a")), JSON.stringify(exact));
  assert.deepEqual(loadStoredSlice("scene-a", LAYERS).slice, exact);
});

test("malformed UTF-8 bytes reject before parsing while valid Unicode round trips", () => {
  const unicodeSlice: ChartSlice = {
    version: 1,
    definitions: [
      {
        id: "rain:time_series",
        title: "Rain é ✓ over time",
        source: { layerId: "rain", shape: "time_series" },
        chartType: "bar",
        options: defaultOptionsFor(),
      },
    ],
    mainChartId: "rain:time_series",
  };
  const token = encodeSlice(unicodeSlice);
  const roundTrip = decodeToken(token, LAYERS);
  assert.equal(roundTrip.notice, null);
  assert.deepEqual(roundTrip.slice, unicodeSlice);

  const bytes = Buffer.from(token, "base64url");
  bytes[0] = 0xff;
  const corrupt = bytes.toString("base64url");
  const originalParse = JSON.parse;
  let calls = 0;
  JSON.parse = ((...args: Parameters<typeof JSON.parse>) => {
    calls++;
    return originalParse(...args);
  }) as typeof JSON.parse;
  try {
    const rejected = decodeToken(corrupt, LAYERS);
    assert.equal(calls, 0);
    assert.equal(rejected.slice, null);
    assert.equal(rejected.notice, INVALID_CHARTS_NOTICE);
  } finally {
    JSON.parse = originalParse;
  }
});

test("decoded limits use UTF-8 bytes with exact link boundaries", () => {
  const originalParse = JSON.parse;
  let calls = 0;
  JSON.parse = ((...args: Parameters<typeof JSON.parse>) => {
    calls++;
    return originalParse(...args);
  }) as typeof JSON.parse;
  try {
    const exactJson = `{"data":"${"a".repeat(MAX_DECODED_BYTES - 11)}"}`;
    assert.equal(new TextEncoder().encode(exactJson).length, MAX_DECODED_BYTES);
    const exactToken = Buffer.from(exactJson, "utf8").toString("base64url");

    calls = 0;
    const exact = decodeToken(exactToken, LAYERS);
    assert.equal(calls, 1);
    assert.equal(exact.slice, null);
    assert.equal(exact.notice, INVALID_CHARTS_NOTICE);

    const overJson = `{"data":"${"a".repeat(MAX_DECODED_BYTES - 10)}"}`;
    assert.equal(new TextEncoder().encode(overJson).length, MAX_DECODED_BYTES + 1);
    const overToken = Buffer.from(overJson, "utf8").toString("base64url");

    calls = 0;
    const over = decodeToken(overToken, LAYERS);
    assert.equal(calls, 0);
    assert.equal(over.slice, null);
    assert.equal(over.notice, INVALID_CHARTS_NOTICE);

    const multibyteJson = `{"data":"${"é".repeat(17000)}"}`;
    const multibyteBytes = new TextEncoder().encode(multibyteJson).length;
    assert.ok(multibyteBytes > MAX_DECODED_BYTES);
    assert.ok(multibyteJson.length < MAX_DECODED_BYTES);
    const multibyteToken = Buffer.from(multibyteJson, "utf8").toString("base64url");

    calls = 0;
    const multibyte = decodeToken(multibyteToken, LAYERS);
    assert.equal(calls, 0);
    assert.equal(multibyte.slice, null);
    assert.equal(multibyte.notice, INVALID_CHARTS_NOTICE);
  } finally {
    JSON.parse = originalParse;
  }
});

test("stored limits use UTF-8 bytes with exact boundaries", () => {
  const originalParse = JSON.parse;
  let calls = 0;
  JSON.parse = ((...args: Parameters<typeof JSON.parse>) => {
    calls++;
    return originalParse(...args);
  }) as typeof JSON.parse;
  try {
    const items = useStorage();
    const exactRaw = `{"data":"${"a".repeat(MAX_DECODED_BYTES - 11)}"}`;
    assert.equal(new TextEncoder().encode(exactRaw).length, MAX_DECODED_BYTES);
    items.set(storageKeyFor("scene-a"), exactRaw);

    calls = 0;
    const exact = loadStoredSlice("scene-a", LAYERS);
    assert.equal(calls, 1);
    assert.equal(exact.notice, INVALID_CHARTS_NOTICE);

    const overRaw = `{"data":"${"a".repeat(MAX_DECODED_BYTES - 10)}"}`;
    assert.equal(new TextEncoder().encode(overRaw).length, MAX_DECODED_BYTES + 1);
    items.set(storageKeyFor("scene-a"), overRaw);

    calls = 0;
    const over = loadStoredSlice("scene-a", LAYERS);
    assert.equal(calls, 0);
    assert.equal(over.notice, INVALID_CHARTS_NOTICE);

    const multibyteRaw = `{"data":"${"é".repeat(17000)}"}`;
    assert.ok(new TextEncoder().encode(multibyteRaw).length > MAX_DECODED_BYTES);
    assert.ok(multibyteRaw.length < MAX_DECODED_BYTES);
    items.set(storageKeyFor("scene-a"), multibyteRaw);

    calls = 0;
    const multibyte = loadStoredSlice("scene-a", LAYERS);
    assert.equal(calls, 0);
    assert.equal(multibyte.notice, INVALID_CHARTS_NOTICE);
  } finally {
    JSON.parse = originalParse;
  }
});

function rainLayer() {
  const values = Array.from({ length: 30 }, (_, index) => {
    const date = new Date(Date.UTC(2019, index, 1));
    return date.toISOString().slice(0, 10);
  });

  return {
    id: "rain",
    title: "Rain",
    units: "mm/month",
    style: { kind: "field", encodings: ["ramp"] },
    time: { step: "P1M", values, end: "2021-07-01", method: "sum" },
    area_series: {
      statistic: "mean",
      weights: "cell_area_inside_outline",
      values: values.map(() => 10),
      valid_fraction: values.map(() => 1),
    },
  } as unknown as LayerDoc;
}

function terrainLayer() {
  return {
    id: "terrain",
    title: "Terrain",
    units: "m",
    style: { kind: "terrain", encodings: ["shade"] },
    grid: { res: 0.000833333333333 },
    time: null,
    distribution: {
      statistic: "quantiles",
      weights: "cell_area_inside_outline",
      percent: 1,
      values: Array.from({ length: 101 }, (_, index) => index * 10),
      min: 0,
      max: 1000,
      mean: 500,
      valid_fraction: 0.9,
      reference_values: [],
    },
  } as unknown as LayerDoc;
}

function useStorage() {
  const items = new Map<string, string>();
  Object.assign(globalThis, {
    localStorage: {
      getItem: (key: string) => items.get(key) ?? null,
      setItem: (key: string, value: string) => items.set(key, value),
      removeItem: (key: string) => items.delete(key),
    },
  });
  return items;
}

function useBlockedStorage() {
  const blocked = () => {
    throw new Error("blocked");
  };
  Object.assign(globalThis, {
    localStorage: { getItem: blocked, setItem: blocked, removeItem: blocked },
  });
}
