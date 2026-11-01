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

test("loadScene accepts format 0.7 and rejects format 0.6", async (context) => {
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
  const distributionValues = Array.from({ length: 101 }, (_, index) => index);
  const seriesWithFallback = {
    statistic: "mean",
    weights: "cell_area_inside_outline",
    values: [10.123456789012345, null, 0, -3.75],
    valid_fraction: [1, 0, 0.5, 0.7],
    fallback_fraction: [0.2, 0, 0, 0.1],
  };
  const seriesWithoutFallback = {
    statistic: "mean",
    weights: "cell_area_inside_outline",
    values: [1.5, 2.5],
    valid_fraction: [1, 1],
  };
  const fallbackSources = [
    {
      name: "ERA5 fallback",
      licence: "CC BY 4.0",
      attribution: "contains modified Copernicus information",
    },
  ];
  const distribution = {
    statistic: "quantiles",
    weights: "cell_area_inside_outline",
    percent: 1,
    values: distributionValues,
    min: 0,
    max: 100,
    mean: 50,
    valid_fraction: 0.9,
    reference_values: [{ id: "sea_level", value: 0 }],
  };
  const scene = {
    version: "0.7",
    area: { geometry_href: "area.geojson" },
    data: { href: "data.zarr" },
    credits: {
      lines: ["contains modified Copernicus information"],
      disclaimers: [],
      endorsement: "Scenes of Earth is not endorsed by the data providers.",
      terms_passthrough: "Reuse is subject to each source licence.",
    },
    layers: [
      {
        time: {
          values: ["2015-01-01", "2015-02-01", "2015-03-01", "2015-04-01"],
        },
        area_series: seriesWithFallback,
        fallback_sources: fallbackSources,
        tiles: { url: "../../terrain/v1/{z}/{x}/{y}.webp" },
      },
      {
        distribution,
        tiles: { url: "https://tiles.mapterhorn.com/{z}/{x}/{y}.webp" },
      },
      {
        time: { values: ["2015-01-01", "2015-02-01"] },
        area_series: seriesWithoutFallback,
      },
      {
        time: null,
        style: {
          kind: "categorical",
          encodings: ["classes"],
          classes: [{ value: 10, label: "Tree cover", color: "#006400" }],
        },
      },
    ],
  };
  context.mock.method(globalThis, "fetch", async () => Response.json(scene));

  const loaded = await loadScene("/scenes/example/scene.json");
  assert.equal(loaded.version, "0.7");
  assert.equal(loaded.area.geometry_href, "https://example.test/scenes/example/area.geojson");
  assert.equal(loaded.data.href, "https://example.test/scenes/example/data.zarr");
  assert.equal(loaded.layers[0].tiles?.url, "https://example.test/terrain/v1/{z}/{x}/{y}.webp");
  assert.equal(loaded.layers[1].tiles?.url, "https://tiles.mapterhorn.com/{z}/{x}/{y}.webp");
  assert.deepEqual(loaded.layers[0].area_series, seriesWithFallback);
  assert.deepEqual(loaded.layers[0].fallback_sources, fallbackSources);
  assert.deepEqual(loaded.credits.lines, ["contains modified Copernicus information"]);
  assert.deepEqual(loaded.layers[1].distribution, distribution);
  assert.deepEqual(loaded.layers[2].area_series, seriesWithoutFallback);
  assert.ok(!("fallback_fraction" in (loaded.layers[2].area_series ?? {})));
  assert.ok(!("fallback_sources" in loaded.layers[2]));
  assert.ok(!("area_series" in loaded.layers[1]));
  assert.ok(!("distribution" in loaded.layers[0]));
  assert.ok(!("area_series" in loaded.layers[3]));
  assert.ok(!("distribution" in loaded.layers[3]));
  assert.equal(loaded.credits.terms_passthrough, "Reuse is subject to each source licence.");

  scene.version = "0.6";
  await assert.rejects(loadScene("/scenes/example/scene.json"), /format 0\.6/);
});
