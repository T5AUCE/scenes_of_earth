import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { test } from "node:test";
import type { TestContext } from "node:test";

import { Window } from "happy-dom";
import type { Map as MapLibreMap } from "maplibre-gl";

import type { AreaHit, Bbox } from "./types.ts";

const SEARCH_DEBOUNCE_MS = 300;

const rootUrl = new URL("./", import.meta.url).href;
const hooks = registerHooks({
  resolve(specifier, context, next) {
    // These text checks skip browser CSS because Node cannot load it.
    if (specifier.endsWith(".css")) {
      return { url: "data:text/javascript,export {};", shortCircuit: true };
    }
    if (
      context.parentURL?.startsWith(rootUrl)
      && specifier.startsWith(".")
      && !specifier.endsWith(".ts")
    ) {
      return next(new URL(`${specifier}.ts`, context.parentURL).href, context);
    }
    return next(specifier, context);
  },
});
const { bindAreaSearch, createSearchControls } = await import("./area-search.ts").finally(
  () => hooks.deregister(),
);

test("a pick draws the fetched outline without a bbox preview", async (context) => {
  const outline = gate();
  const harness = await searchWithHits(context, [areaHit()], (url) => {
    if (url.startsWith("/api/areas/")) return outline.promise;
    return null;
  });

  await harness.pick(0);
  await flush();

  assert.equal(harness.sources.length, 0);

  outline.resolve(Response.json({ ...areaHit(), geometry: outlineA() }));
  await flush();

  assert.deepEqual(harness.sources.at(-1), outlineA());
});

test("a 180°-crossing pick draws only the shifted outline", async (context) => {
  const outline = gate();
  const crossing: Bbox = [175, -20, 195, -15];
  const harness = await searchWithHits(context, [areaHit({ bbox: crossing })], (url) => {
    if (url.startsWith("/api/areas/")) return outline.promise;
    return null;
  });

  await harness.pick(0);
  await flush();

  assert.equal(harness.sources.length, 0);

  const fetched = {
    type: "Polygon",
    coordinates: [[[179, -19], [191, -19], [191, -16], [179, -16], [179, -19]]],
  };
  outline.resolve(Response.json({ ...areaHit({ bbox: crossing }), geometry: fetched }));
  await flush();

  assert.deepEqual(harness.sources.at(-1), {
    type: "Polygon",
    coordinates: [
      fetched.coordinates[0].map(([longitude, latitude]) => [longitude - 360, latitude]),
    ],
  });
});

test("a stale outline never overwrites a newer pick", async (context) => {
  const first = gate();
  const second = gate();
  const hits = [
    areaHit({ id: "cgaz:ADM1:FIRST", name: "First", bbox: [35, -1, 36, 1] }),
    areaHit({ id: "cgaz:ADM1:SECOND", name: "Second", bbox: [37, -1, 38, 1] }),
  ];
  const harness = await searchWithHits(context, hits, (url) => {
    if (url.includes("FIRST")) return first.promise;
    if (url.includes("SECOND")) return second.promise;
    return null;
  });

  await harness.pick(0);
  await harness.pick(1);
  await flush();

  assert.equal(harness.sources.length, 0);

  second.resolve(Response.json({ ...hits[1], geometry: outlineB() }));
  await flush();
  first.resolve(Response.json({ ...hits[0], geometry: outlineA() }));
  await flush();

  assert.deepEqual(harness.sources.at(-1), outlineB());
  assert.equal(harness.sources.length, 1);
});

test("a failed outline fetch keeps the bbox rectangle", async (context) => {
  const harness = await searchWithHits(context, [areaHit()], (url) => {
    if (url.startsWith("/api/areas/")) return Promise.reject(new Error("offline"));
    return null;
  });

  await harness.pick(0);
  await flush();

  assert.deepEqual(harness.sources.at(-1), {
    type: "Polygon",
    coordinates: [rectRing([35, -1, 36, 1])],
  });
});

test("a failed outline fetch shows an outline-unavailable notice", async (context) => {
  const harness = await searchWithHits(context, [areaHit()], (url) => {
    if (url.startsWith("/api/areas/")) return Promise.reject(new Error("offline"));
    return null;
  });

  await harness.pick(0);
  await flush();

  assert.equal(harness.notices.length, 1);
  assert.match(harness.notices[0], /outline unavailable/i);
  assert.equal(harness.chosenText(), "Currently selected - Nakuru (approximate outline)");
});

test("a stale failed outline fetch stays silent", async (context) => {
  const hits = [
    areaHit({ id: "cgaz:ADM1:FIRST", name: "First", bbox: [35, -1, 36, 1] }),
    areaHit({ id: "cgaz:ADM1:SECOND", name: "Second", bbox: [37, -1, 38, 1] }),
  ];
  const outline = gate();
  let rejectFirst!: (error: Error) => void;
  const firstFailure = new Promise<Response>((_resolve, reject) => {
    rejectFirst = reject;
  });
  const harness = await searchWithHits(context, hits, (url) => {
    if (url.includes("FIRST")) return firstFailure;
    if (url.includes("SECOND")) return outline.promise;
    return null;
  });

  await harness.pick(0);
  await harness.pick(1);
  await flush();

  outline.resolve(Response.json({ ...hits[1], geometry: outlineB() }));
  await flush();
  rejectFirst(new Error("offline"));
  await flush();

  assert.deepEqual(harness.sources.at(-1), outlineB());
  assert.equal(harness.sources.length, 1);
  assert.deepEqual(harness.notices, []);
  assert.equal(harness.chosenText(), "Currently selected - Second");
});

test("hiding keeps the geometry so showing draws it again", async (context) => {
  const harness = await searchWithHits(context, [areaHit()], (url) => {
    if (url.startsWith("/api/areas/")) {
      return Promise.resolve(Response.json({ ...areaHit(), geometry: outlineA() }));
    }
    return null;
  });

  await harness.pick(0);
  await flush();

  assert.equal(harness.hasOutline(), true);

  harness.hideOutline();

  assert.equal(harness.hasOutline(), false);

  harness.showOutline();

  assert.equal(harness.hasOutline(), true);
  assert.deepEqual(harness.sources.at(-1), outlineA());
});

test("a pending outline fetch stays hidden until it is shown", async (context) => {
  const outline = gate();
  const harness = await searchWithHits(context, [areaHit()], (url) => {
    if (url.startsWith("/api/areas/")) return outline.promise;
    return null;
  });

  await harness.pick(0);
  await flush();

  harness.hideOutline();
  outline.resolve(Response.json({ ...areaHit(), geometry: outlineA() }));
  await flush();

  assert.equal(harness.hasOutline(), false);

  harness.showOutline();
  await flush();

  assert.equal(harness.hasOutline(), true);
  assert.deepEqual(harness.sources.at(-1), outlineA());
});

test("clearing the search forgets the outline so showing stays empty", async (context) => {
  const harness = await searchWithHits(context, [areaHit()], (url) => {
    if (url.startsWith("/api/areas/")) {
      return Promise.resolve(Response.json({ ...areaHit(), geometry: outlineA() }));
    }
    return null;
  });

  await harness.pick(0);
  await flush();

  assert.equal(harness.hasOutline(), true);

  harness.clearSearch();
  await flush();

  assert.equal(harness.hasOutline(), false);

  harness.showOutline();

  assert.equal(harness.hasOutline(), false);
});

test("a pick made while hidden draws its outline", async (context) => {
  const harness = await searchWithHits(context, [areaHit()], (url) => {
    if (url.startsWith("/api/areas/")) {
      return Promise.resolve(Response.json({ ...areaHit(), geometry: outlineA() }));
    }
    return null;
  });

  harness.hideOutline();
  await harness.pick(0);
  await flush();

  assert.equal(harness.hasOutline(), true);
});

test("a failed fetch while hidden keeps its notice until the outline is shown", async (context) => {
  const outline = gate();
  const harness = await searchWithHits(context, [areaHit()], (url) => {
    if (url.startsWith("/api/areas/")) return outline.promise;
    return null;
  });

  await harness.pick(0);
  harness.hideOutline();
  outline.resolve(new Response("", { status: 500 }));
  await flush();

  assert.equal(harness.chosenText(), "Currently selected - Nakuru (approximate outline)");
  assert.deepEqual(harness.notices, []);
  assert.equal(harness.hasOutline(), false);

  harness.showOutline();

  assert.equal(harness.notices.length, 1);
  assert.equal(harness.hasOutline(), true);
});

function gate(): { promise: Promise<Response>; resolve(response: Response): void } {
  let resolve!: (response: Response) => void;
  const promise = new Promise<Response>((accept) => {
    resolve = accept;
  });
  return { promise, resolve };
}

async function searchWithHits(
  context: TestContext,
  hits: AreaHit[],
  areaResponse: (url: string) => Promise<Response> | null,
): Promise<{
  sources: unknown[];
  notices: string[];
  chosenText(): string | null;
  pick(index: number): Promise<void>;
  hasOutline(): boolean;
  hideOutline(): void;
  showOutline(): void;
  clearSearch(): void;
}> {
  const window = new Window();
  context.after(() => window.happyDOM.abort());
  installBrowser(context, window);
  stubOutlineStyle(context);
  context.mock.method(globalThis, "fetch", async (url: string) => {
    if (url.startsWith("/api/areas/search?")) return Response.json(hits);
    const pending = areaResponse(url);
    if (pending) return pending;
    assert.fail(`Unexpected request: ${url}`);
  });
  const sources: unknown[] = [];
  const outlineLayers = new Set<string>();
  const map = {
    fitBounds() {},
    getLayer(id: string) {
      return outlineLayers.has(id) ? {} : undefined;
    },
    getSource(id: string) {
      return outlineLayers.has(id) ? {} : undefined;
    },
    addSource(id: string, source: { data: unknown }) {
      sources.push(source.data);
      outlineLayers.add(id);
    },
    addLayer(spec: { id: string }) {
      outlineLayers.add(spec.id);
    },
    removeLayer(id: string) {
      outlineLayers.delete(id);
    },
    removeSource(id: string) {
      outlineLayers.delete(id);
    },
  } as unknown as MapLibreMap;
  const root = document.createElement("div");
  document.body.append(root);
  const { search, level, results } = createSearchControls(root);
  const chosen = document.createElement("div");
  root.append(chosen);
  const notices: string[] = [];
  const controls = bindAreaSearch(
    { search, level, results, chosen },
    map,
    () => {},
    () => {},
    (text) => {
      notices.push(text);
    },
  );
  context.mock.timers.enable({ apis: ["setTimeout"] });

  const pick = async (index: number) => {
    const box = document.querySelector<HTMLInputElement>("[role=combobox]");
    assert.ok(box);
    box.value = "Nakuru";
    box.dispatchEvent(new window.Event("input"));
    context.mock.timers.tick(SEARCH_DEBOUNCE_MS);
    await flush();
    const options = [...document.querySelectorAll("[role=option]")];
    assert.ok(options[index]);
    options[index].dispatchEvent(
      new window.Event("mousedown", { bubbles: true, cancelable: true }),
    );
    await flush();
  };
  const clearSearch = () => {
    const box = document.querySelector<HTMLInputElement>("[role=combobox]");
    assert.ok(box);
    box.value = "";
    box.dispatchEvent(new window.Event("input"));
  };
  return {
    sources,
    notices,
    chosenText: () => chosen.textContent,
    pick,
    hasOutline: () => outlineLayers.has("soe-picked-area"),
    hideOutline: () => controls.hideOutline(),
    showOutline: () => controls.showOutline(),
    clearSearch,
  };
}

function outlineA(): { type: string; coordinates: number[][][] } {
  return {
    type: "Polygon",
    coordinates: [[[34.9, -1.1], [36.1, -1.1], [36.1, 1.1], [34.9, 1.1], [34.9, -1.1]]],
  };
}

function outlineB(): { type: string; coordinates: number[][][] } {
  return {
    type: "Polygon",
    coordinates: [[[36.9, -1.1], [38.1, -1.1], [38.1, 1.1], [36.9, 1.1], [36.9, -1.1]]],
  };
}

function rectRing([west, south, east, north]: Bbox): number[][] {
  return [[west, south], [east, south], [east, north], [west, north], [west, south]];
}

async function flush(turns = 3): Promise<void> {
  for (let index = 0; index < turns; index++) {
    await new Promise((resolve) => setImmediate(resolve));
  }
}

function areaHit(overrides: Partial<AreaHit> = {}): AreaHit {
  return {
    id: "cgaz:ADM1:NAKURU",
    name: "Nakuru",
    level: "state",
    kind: null,
    iso3: "KEN",
    parent_name: "Kenya",
    bbox: [35, -1, 36, 1],
    cells: 1,
    ...overrides,
  };
}

function installBrowser(context: TestContext, window: Window): void {
  // Happy DOM has option elements but does not implement the browser's Option constructor.
  const globals = { document: window.document, location: window.location, Option: createOption };
  for (const [name, value] of Object.entries(globals)) {
    const previous = Object.getOwnPropertyDescriptor(globalThis, name);
    Object.defineProperty(globalThis, name, { value, configurable: true });
    context.after(() => {
      if (previous) Object.defineProperty(globalThis, name, previous);
      else Reflect.deleteProperty(globalThis, name);
    });
  }
}

function createOption(text: string, value: string): HTMLOptionElement {
  const option = document.createElement("option");
  option.textContent = text;
  option.value = value;
  return option;
}

function stubOutlineStyle(context: TestContext): void {
  const previous = (globalThis as { getComputedStyle?: unknown }).getComputedStyle;
  (globalThis as { getComputedStyle: unknown }).getComputedStyle = () => ({
    getPropertyValue: () => "",
  });
  context.after(() => {
    if (previous) {
      (globalThis as { getComputedStyle: unknown }).getComputedStyle = previous;
    } else {
      delete (globalThis as { getComputedStyle?: unknown }).getComputedStyle;
    }
  });
}
