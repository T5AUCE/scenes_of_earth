import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { test } from "node:test";
import type { TestContext } from "node:test";

import { Window } from "happy-dom";
import type { Map as MapLibreMap } from "maplibre-gl";

import type { AreaHit } from "./types.ts";

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
  const globals = { document: window.document, Option: createOption };
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
