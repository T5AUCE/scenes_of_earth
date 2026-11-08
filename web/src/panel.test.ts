import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { registerHooks, stripTypeScriptTypes } from "node:module";
import { test } from "node:test";
import type { TestContext } from "node:test";
import { runInNewContext } from "node:vm";

import { Window } from "happy-dom";
import type { Map as MapLibreMap } from "maplibre-gl";

import type { AreaHit } from "./types.ts";
import { assertSameNode } from "./testing/dom-assert.ts";
import { routeFor } from "./scene-url.ts";

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
const { createPanel } = await import("./panel.ts").finally(() => hooks.deregister());

test("search results show the country's kind instead of the generic level", async (context) => {
  const root = await panelWithHits(context, [areaHit({ kind: "County" })]);

  assert.deepEqual(await resultTexts(context, root), ["Nakuru · Kenya · County"]);
});

for (const { level, label } of [
  { level: "state", label: "ADM1" },
  { level: "county", label: "ADM2" },
  { level: "country", label: "Country" },
  { level: "city", label: "City" },
]) {
  test(`search results without a kind use the ${level} label`, async (context) => {
    const root = await panelWithHits(context, [areaHit({ level })]);

    assert.deepEqual(await resultTexts(context, root), [`Nakuru · Kenya · ${label}`]);
  });
}

test("search results without a parent omit the empty separator", async (context) => {
  const country = areaHit({ name: "Kenya", parent_name: null, level: "country" });
  const root = await panelWithHits(context, [country]);

  assert.deepEqual(await resultTexts(context, root), ["Kenya · Country"]);
});

test("search results preserve an unfamiliar level when it has no kind", async (context) => {
  const root = await panelWithHits(context, [areaHit({ level: "region" })]);

  assert.deepEqual(await resultTexts(context, root), ["Nakuru · Kenya · region"]);
});

test("the level dropdown shows descriptive labels and preserves API values", async (context) => {
  const root = await panelWithHits(context, []);
  const level = root.querySelector<HTMLSelectElement>("select");
  assert.ok(level);

  assert.deepEqual(
    [...level.options].map((option) => [option.value, option.textContent]),
    [
      ["", "Any Level"],
      ["country", "ADM0 (country, territory, etc.)"],
      ["state", "ADM1 (state, county, etc.)"],
      ["county", "ADM2 (district, county, etc.)"],
      ["city", "City (urban area)"],
    ],
  );
});

test("search works before the layer list arrives", async (context) => {
  const window = new Window();
  context.after(() => window.happyDOM.abort());
  installBrowser(context, window);
  const previousStyle = (globalThis as { getComputedStyle?: unknown }).getComputedStyle;
  (globalThis as { getComputedStyle: unknown }).getComputedStyle = () => ({
    getPropertyValue: () => "",
  });
  context.after(() => {
    if (previousStyle) {
      (globalThis as { getComputedStyle: unknown }).getComputedStyle = previousStyle;
    } else {
      delete (globalThis as { getComputedStyle?: unknown }).getComputedStyle;
    }
  });
  let resolveLayers!: (response: Response) => void;
  const layersGate = new Promise<Response>((resolve) => {
    resolveLayers = resolve;
  });
  context.after(() => {
    resolveLayers(Response.json({ request_step: "P1M", default: [], layers: [] }));
  });
  const searched: string[] = [];
  context.mock.method(globalThis, "fetch", async (url: string) => {
    if (url === "/api/layers") return layersGate;
    if (url.startsWith("/api/areas/search?")) {
      searched.push(url);
      return Response.json([areaHit()]);
    }
    if (url === "/api/areas/cgaz:ADM1:NAKURU") {
      return Response.json({ ...areaHit(), geometry: bboxFeature() });
    }
    assert.fail(`Unexpected request: ${url}`);
  });
  const map = {
    fitBounds() {},
    getLayer() {
      return undefined;
    },
    getSource() {
      return undefined;
    },
    addSource() {},
    addLayer() {},
  } as unknown as MapLibreMap;
  const root = document.createElement("div");
  document.body.append(root);
  const panelPromise = createPanel(root, map, { enter() {} });
  await new Promise((resolve) => setImmediate(resolve));

  const search = root.querySelector<HTMLInputElement>("[role=combobox]");
  const level = root.querySelector<HTMLSelectElement>("select");
  const status = root.querySelector(".status");
  assert.ok(search);
  assert.ok(level);
  assert.ok(status);
  assert.equal(typeof search.oninput, "function");
  assert.equal(typeof level.onchange, "function");

  context.mock.timers.enable({ apis: ["setTimeout"] });
  search.value = "Nakuru";
  search.dispatchEvent(new search.ownerDocument.defaultView!.Event("input"));
  context.mock.timers.tick(SEARCH_DEBOUNCE_MS);
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));

  assert.ok(searched.length > 0);
  assertSameNode(status, root.querySelector(".status"));
  assert.deepEqual(
    [...root.querySelectorAll("[role=option]")].map((item) => item.textContent),
    ["Nakuru · Kenya · ADM1"],
  );

  const option = root.querySelector("[role=option]");
  assert.ok(option);
  option.dispatchEvent(
    new search.ownerDocument.defaultView!.Event("mousedown", { bubbles: true, cancelable: true }),
  );
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(root.querySelector(".chosen")?.textContent, "Nakuru");

  const build = [...root.querySelectorAll("button")].find(
    (button) => button.textContent === "Build scene",
  );
  assert.ok(build);
  build.click();
  assertSameNode(status, root.querySelector(".status"));
  assert.equal(status.textContent, "Select at least one layer.");

  resolveLayers(Response.json({
    request_step: "P1M",
    default: ["terrain"],
    layers: [
      { id: "terrain", title: "Terrain", time_varying: false, time: null },
    ],
  }));
  await panelPromise;

  const terrain = root.querySelector<HTMLInputElement>("input[value='terrain']");
  assert.ok(terrain);
  assertSameNode(terrain, root.querySelector("input[value='terrain']"));
  assert.equal(terrain.checked, true);
});

test("build shows Starting build… before the POST resolves", async (context) => {
  const window = new Window();
  context.after(() => window.happyDOM.abort());
  installBrowser(context, window);
  const previousStyle = (globalThis as { getComputedStyle?: unknown }).getComputedStyle;
  (globalThis as { getComputedStyle: unknown }).getComputedStyle = () => ({
    getPropertyValue: () => "",
  });
  context.after(() => {
    if (previousStyle) {
      (globalThis as { getComputedStyle: unknown }).getComputedStyle = previousStyle;
    } else {
      delete (globalThis as { getComputedStyle?: unknown }).getComputedStyle;
    }
  });
  let resolvePost!: (response: Response) => void;
  const postGate = new Promise<Response>((resolve) => {
    resolvePost = resolve;
  });
  context.after(() => resolvePost(Response.json({ id: "a", status: "failed", error: "aborted" })));
  context.mock.method(globalThis, "fetch", async (url: string, init?: RequestInit) => {
    if (url === "/api/layers") {
      return Response.json({
        request_step: "P1M",
        default: ["terrain"],
        layers: [{ id: "terrain", title: "Terrain", time_varying: false, time: null }],
      });
    }
    if (url.startsWith("/api/areas/search?")) {
      return Response.json([areaHit()]);
    }
    if (url === "/api/areas/cgaz:ADM1:NAKURU") {
      return Response.json({
        ...areaHit(),
        geometry: {
          type: "Polygon",
          coordinates: [[[35, -1], [36, -1], [36, 1], [35, 1], [35, -1]]],
        },
      });
    }
    if (url === "/api/scenes" && init?.method === "POST") {
      return postGate;
    }
    assert.fail(`Unexpected request: ${url} ${init?.method ?? "GET"}`);
  });
  const map = {
    fitBounds() {},
    getLayer() {
      return undefined;
    },
    getSource() {
      return undefined;
    },
    addSource() {},
    addLayer() {},
  } as unknown as MapLibreMap;
  const root = document.createElement("div");
  document.body.append(root);
  await createPanel(root, map, { enter() {} });

  const search = root.querySelector<HTMLInputElement>("[role=combobox]");
  assert.ok(search);
  context.mock.timers.enable({ apis: ["setTimeout"] });
  search.value = "Nakuru";
  search.dispatchEvent(new search.ownerDocument.defaultView!.Event("input"));
  context.mock.timers.tick(SEARCH_DEBOUNCE_MS);
  await new Promise((resolve) => setImmediate(resolve));
  const option = root.querySelector("[role=option]");
  assert.ok(option);
  option.dispatchEvent(
    new search.ownerDocument.defaultView!.Event("mousedown", { bubbles: true, cancelable: true }),
  );
  await new Promise((resolve) => setImmediate(resolve));

  const build = [...root.querySelectorAll("button")].find(
    (button) => button.textContent === "Build scene",
  );
  assert.ok(build);
  const status = root.querySelector(".status");
  assert.ok(status);
  assertSameNode(status, root.querySelector(".status"));

  build.click();

  assert.equal(status.textContent, "Starting build…");
});

test("repick clears a build and a stale 503 never overwrites a newer run", async (context) => {
  const window = new Window();
  context.after(() => window.happyDOM.abort());
  installBrowser(context, window);
  const previousStyle = (globalThis as { getComputedStyle?: unknown }).getComputedStyle;
  (globalThis as { getComputedStyle: unknown }).getComputedStyle = () => ({
    getPropertyValue: () => "",
  });
  context.after(() => {
    if (previousStyle) {
      (globalThis as { getComputedStyle: unknown }).getComputedStyle = previousStyle;
    } else {
      delete (globalThis as { getComputedStyle?: unknown }).getComputedStyle;
    }
  });
  let resolveFirst!: (response: Response) => void;
  let resolveSecond!: (response: Response) => void;
  const firstGate = new Promise<Response>((resolve) => {
    resolveFirst = resolve;
  });
  const secondGate = new Promise<Response>((resolve) => {
    resolveSecond = resolve;
  });
  context.after(() => {
    resolveFirst(Response.json({ id: "a", status: "failed", error: "aborted" }));
    resolveSecond(Response.json({ id: "b", status: "failed", error: "aborted" }));
  });
  let postCalls = 0;
  context.mock.method(globalThis, "fetch", async (url: string, init?: RequestInit) => {
    if (url === "/api/layers") {
      return Response.json({
        request_step: "P1M",
        default: ["terrain"],
        layers: [{ id: "terrain", title: "Terrain", time_varying: false, time: null }],
      });
    }
    if (url.startsWith("/api/areas/search?")) {
      return Response.json([areaHit()]);
    }
    if (url === "/api/areas/cgaz:ADM1:NAKURU") {
      return Response.json({
        ...areaHit(),
        geometry: {
          type: "Polygon",
          coordinates: [[[35, -1], [36, -1], [36, 1], [35, 1], [35, -1]]],
        },
      });
    }
    if (url === "/api/scenes" && init?.method === "POST") {
      postCalls += 1;
      if (postCalls === 1) return firstGate;
      if (postCalls === 2) return secondGate;
    }
    assert.fail(`Unexpected request: ${url} ${init?.method ?? "GET"}`);
  });
  const map = {
    fitBounds() {},
    getLayer() {
      return undefined;
    },
    getSource() {
      return undefined;
    },
    addSource() {},
    addLayer() {},
  } as unknown as MapLibreMap;
  const root = document.createElement("div");
  document.body.append(root);
  await createPanel(root, map, { enter() {} });

  const search = root.querySelector<HTMLInputElement>("[role=combobox]");
  assert.ok(search);
  context.mock.timers.enable({ apis: ["setTimeout"] });
  const pickFirstHit = async () => {
    search.value = "Nakuru";
    search.dispatchEvent(new search.ownerDocument.defaultView!.Event("input"));
    context.mock.timers.tick(SEARCH_DEBOUNCE_MS);
    await new Promise((resolve) => setImmediate(resolve));
    const option = root.querySelector("[role=option]");
    assert.ok(option);
    option.dispatchEvent(
      new search.ownerDocument.defaultView!.Event("mousedown", {
        bubbles: true,
        cancelable: true,
      }),
    );
    await new Promise((resolve) => setImmediate(resolve));
  };
  await pickFirstHit();

  const build = [...root.querySelectorAll("button")].find(
    (button) => button.textContent === "Build scene",
  );
  assert.ok(build);
  const status = root.querySelector(".status");
  assert.ok(status);
  assertSameNode(status, root.querySelector(".status"));

  build.click();
  assert.equal(status.textContent, "Starting build…");
  assert.equal(status.classList.contains("busy"), true);

  await pickFirstHit();
  assertSameNode(status, root.querySelector(".status"));
  assert.equal(status.textContent, "");
  assert.equal(status.classList.contains("busy"), false);
  assert.equal(build.disabled, false);

  build.click();
  assert.equal(status.textContent, "Starting build…");
  assert.equal(status.classList.contains("busy"), true);

  resolveFirst(
    new Response(JSON.stringify({ detail: "old server busy" }), {
      status: 503,
      headers: { "Retry-After": "1" },
    }),
  );
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
  context.mock.timers.tick(1000);
  await new Promise((resolve) => setImmediate(resolve));
  assertSameNode(status, root.querySelector(".status"));
  assert.equal(status.textContent, "Starting build…");

  resolveSecond(
    new Response(JSON.stringify({ detail: "new error" }), { status: 422 }),
  );
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
  assertSameNode(status, root.querySelector(".status"));
  assert.equal(status.textContent, "Error 422: new error");
  assert.equal(build.disabled, false);
  assert.equal(status.classList.contains("busy"), false);
  assert.equal(postCalls, 2);

  await assertDeferredSceneEntries(context);
  await assertLazySceneBoundary();
  await assertLazySceneRetry();
});

async function assertDeferredSceneEntries(context: TestContext): Promise<void> {
  context.mock.method(globalThis, "fetch", async (url: string) => {
    if (url === "/api/layers") {
      return Response.json({ request_step: "P1M", default: [], layers: [] });
    }
    if (url.startsWith("/api/areas/search?")) return Response.json([areaHit()]);
    if (url.startsWith("/api/areas/")) {
      return Response.json({ ...areaHit(), geometry: bboxFeature() });
    }
    if (url.startsWith("/api/scenes/")) {
      return Response.json({
        status: "done",
        bundle_url: `https://bundles.test/${url.split("/").at(-1)}`,
      });
    }
    assert.ok(url.startsWith("https://bundles.test/"));

    return Response.json({
      id: url.split("/").at(-1),
      version: "0.7",
      area: { geometry_href: "area.geojson" },
      data: { href: "data.zarr" },
      layers: [],
    });
  });
  for (const action of ["repick", "cancel", "supersede", "failure", "stale failure"]) {
    const gate = deferred<{ enter(scene: { id: string }): void }>();
    const entered: string[] = [];
    const root = document.createElement("div");
    const map = {
      fitBounds() {},
      getLayer() {},
      getSource() {},
      addSource() {},
      addLayer() {},
    } as unknown as MapLibreMap;
    let loads = 0;
    const panel = await createPanel(root, map, () => {
      loads++;

      return gate.promise;
    });
    assert.equal(loads, 0);
    const first = panel.openScene("first", { time: "2020-02", entry: "replace" });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(loads, 1);
    let next: Promise<void> | undefined;
    if (action === "repick") {
      const search = root.querySelector<HTMLInputElement>("[role=combobox]")!;
      search.value = "Nakuru";
      search.dispatchEvent(new document.defaultView!.Event("input"));
      context.mock.timers.tick(SEARCH_DEBOUNCE_MS);
      await new Promise((resolve) => setImmediate(resolve));
      root.querySelector("[role=option]")!.dispatchEvent(
        new document.defaultView!.Event("mousedown", { bubbles: true, cancelable: true }),
      );
    }
    if (action === "cancel" || action === "stale failure") panel.cancelOpen();
    if (action === "supersede") {
      next = panel.openScene("second", { time: null, entry: "keep" });
      await new Promise((resolve) => setImmediate(resolve));
    }
    if (action.endsWith("failure")) gate.reject(new Error("module unavailable"));
    else gate.resolve({ enter: (scene) => entered.push(scene.id) });
    await Promise.all([first, next]);

    assert.deepEqual(entered, action === "supersede" ? ["second"] : []);
    assert.equal(
      root.querySelector(".status")!.textContent,
      action === "failure" ? "Could not open scene first: module unavailable" : "",
    );
  }
}

function bboxFeature(): { type: "Polygon"; coordinates: number[][][] } {
  return {
    type: "Polygon",
    coordinates: [[[35, -1], [36, -1], [36, 1], [35, 1], [35, -1]]],
  };
}

function lazySceneSource(): string {
  return stripTypeScriptTypes(readFileSync(new URL("./main.ts", import.meta.url), "utf8"))
    .replace(/^import .*;$/gm, "")
    .replace('import("./scene-mode")', "loadModule()");
}

async function assertLazySceneRetry(): Promise<void> {
  const window = new Window({ url: "https://app.test/" });
  const controller = { sceneId: () => "shared" };
  const imports = [Promise.reject(new Error("chunk failed")), Promise.resolve({
    createSceneMode: () => controller,
  })];
  const application = runInNewContext(`${lazySceneSource()}\n({ loadSceneMode });`, {
    document: { getElementById: () => window.document.createElement("div") },
    window: { addEventListener() {} },
    location: window.location,
    history: window.history,
    createMap: () => ({ once() {} }),
    createPanel: () => new Promise(() => {}),
    getHealth: async () => ({ version: "test" }),
    reportMapErrors() {},
    isSceneId: () => true,
    routeFor,
    loadModule: () => imports.shift(),
  }) as { loadSceneMode(): Promise<typeof controller> };
  const failing = application.loadSceneMode();
  assert.equal(application.loadSceneMode(), failing);
  await assert.rejects(failing, /chunk failed/);
  const retry = application.loadSceneMode();
  assert.notEqual(retry, failing);
  assert.equal(await retry, controller);
  assert.equal(application.loadSceneMode(), retry);
  await window.happyDOM.abort();
}

async function assertLazySceneBoundary(): Promise<void> {
  const source = lazySceneSource();
  for (const route of ["world", "stale", "shared"]) {
    const window = new Window({
      url: route === "world" ? "https://app.test/" : "https://app.test/?scene=shared&t=2020-02",
    });
    const panelGate = deferred<unknown>();
    const moduleGate = deferred<unknown>();
    const opened: unknown[][] = [];
    const shown: (string | null)[] = [];
    let imports = 0;
    let created = 0;
    let cancelled = 0;
    let exited = 0;
    let followHistory = () => {};
    const controller = {
      sceneId: () => "shared",
      enter() {},
      exit: () => exited++,
      showFullscreen: (tab: string | null) => shown.push(tab),
    };
    const application = runInNewContext(`${source}\n({ loadSceneMode });`, {
      document: { getElementById: () => window.document.createElement("div") },
      window: {
        addEventListener: (_name: string, listener: () => void) => {
          followHistory = listener;
        },
      },
      location: window.location,
      history: window.history,
      createMap: () => ({ once: (_event: string, ready: () => void) => ready() }),
      createPanel: () => panelGate.promise,
      getHealth: async () => ({ version: "test" }),
      reportMapErrors() {},
      isSceneId: () => true,
      routeFor,
      loadModule: () => {
        imports++;

        return moduleGate.promise;
      },
    }) as { loadSceneMode(): Promise<typeof controller> };
    assert.equal(imports, 0);
    if (route === "stale") {
      window.history.replaceState(null, "", "/");
      followHistory();
    }
    panelGate.resolve({
      openScene: (...args: unknown[]) => opened.push(args),
      showStatus() {},
      cancelOpen: () => cancelled++,
    });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(opened.length, route === "shared" ? 1 : 0);
    if (route === "shared") {
      assert.equal(opened[0][0], "shared");
      const options = opened[0][1] as { time: string; entry: string };
      assert.equal(options.time, "2020-02");
      assert.equal(options.entry, "replace");
    }
    const first = application.loadSceneMode();
    const second = application.loadSceneMode();
    assert.equal(first, second);
    assert.equal(imports, 1);
    moduleGate.resolve({
      createSceneMode: () => {
        created++;

        return controller;
      },
    });
    await first;
    assert.equal(created, 1);
    window.history.replaceState({ panel: "charts" }, "", "?scene=shared");
    followHistory();
    assert.deepEqual(shown, ["charts"]);
    window.history.replaceState(null, "", "/");
    followHistory();
    assert.equal(exited, 1);
    assert.equal(cancelled, 2);
    assert.equal(imports, 1);
    await window.happyDOM.abort();
  }
}

function deferred<Value>(): {
  promise: Promise<Value>;
  resolve(value: Value): void;
  reject(error: Error): void;
} {
  let resolve!: (value: Value) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<Value>((accept, fail) => {
    resolve = accept;
    reject = fail;
  });

  return { promise, resolve, reject };
}

async function panelWithHits(context: TestContext, hits: AreaHit[]): Promise<HTMLElement> {
  const window = new Window();
  context.after(() => window.happyDOM.abort());
  installBrowser(context, window);
  context.mock.method(globalThis, "fetch", async (url: string) => {
    if (url === "/api/layers") {
      return Response.json({ request_step: "P1M", default: [], layers: [] });
    }
    assert.ok(url.startsWith("/api/areas/search?"), `Unexpected request: ${url}`);
    return Response.json(hits);
  });
  const root = document.createElement("div");
  document.body.append(root);
  await createPanel(root, {} as MapLibreMap, { enter() {} });
  return root;
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

async function resultTexts(context: TestContext, root: HTMLElement): Promise<(string | null)[]> {
  const search = root.querySelector<HTMLInputElement>("[role=combobox]");
  assert.ok(search);
  context.mock.timers.enable({ apis: ["setTimeout"] });
  search.value = "Nakuru";
  search.dispatchEvent(new search.ownerDocument.defaultView!.Event("input"));
  context.mock.timers.tick(SEARCH_DEBOUNCE_MS);
  await new Promise((resolve) => setImmediate(resolve));
  return [...root.querySelectorAll("[role=option]")].map((item) => item.textContent);
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
