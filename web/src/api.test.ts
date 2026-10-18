import assert from "node:assert/strict";
import { test } from "node:test";

import { BUILD_REQUEST_TIMEOUT_MS, isSceneId, loadScene, searchUrl } from "./api.ts";

const REVISION_LOOKUP_TIMEOUT_MS = 15 * 1000; // REVISION_TIMEOUT_SECS in soe/sources.py.

test("a scene id is exactly 20 lowercase hex characters", () => {
  assert.ok(isSceneId("0123456789abcdef0123"));

  assert.ok(!isSceneId("0123456789abcdef012"));
  assert.ok(!isSceneId("0123456789abcdef01234"));
  assert.ok(!isSceneId("0123456789ABCDEF0123"));
  assert.ok(!isSceneId("0123456789abcdef012g"));
});

test("path tricks and empty values are not scene ids", () => {
  assert.ok(!isSceneId(""));
  assert.ok(!isSceneId("../../etc/passwd/xxxxx"));
  assert.ok(!isSceneId("0123456789abcdef0123\n"));
});

test("the build request waits longer than the backend revision lookup of 15 s", () => {
  assert.ok(BUILD_REQUEST_TIMEOUT_MS > REVISION_LOOKUP_TIMEOUT_MS);
});

test("the search URL encodes the query and the level alike", () => {
  assert.equal(searchUrl("Nairobi", ""), "/api/areas/search?q=Nairobi");
  assert.equal(
    searchUrl("Côte d'Ivoire", "country"),
    "/api/areas/search?q=C%C3%B4te+d%27Ivoire&level=country",
  );
  assert.equal(searchUrl("a", "x&y=1"), "/api/areas/search?q=a&level=x%26y%3D1");
});

test("loadScene accepts format 0.4 and rejects format 0.3", async (context) => {
  const locationDescriptor = Object.getOwnPropertyDescriptor(globalThis, "location");
  Object.defineProperty(globalThis, "location", {
    configurable: true,
    value: { href: "https://example.test/" },
  });
  context.after(() => {
    if (locationDescriptor) {
      Object.defineProperty(globalThis, "location", locationDescriptor);
    } else {
      Reflect.deleteProperty(globalThis, "location");
    }
  });
  const scene = {
    version: "0.4",
    area: { geometry_href: "area.geojson" },
    data: { href: "data.zarr" },
  };
  context.mock.method(globalThis, "fetch", async () => Response.json(scene));

  const loaded = await loadScene("/scenes/example/scene.json");
  assert.equal(loaded.version, "0.4");
  assert.equal(loaded.area.geometry_href, "https://example.test/scenes/example/area.geojson");
  assert.equal(loaded.data.href, "https://example.test/scenes/example/data.zarr");

  scene.version = "0.3";
  await assert.rejects(loadScene("/scenes/example/scene.json"), /format 0\.3/);
});
