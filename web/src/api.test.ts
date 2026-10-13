import assert from "node:assert/strict";
import { test } from "node:test";

import { BUILD_REQUEST_TIMEOUT_MS, isSceneId, searchUrl } from "./api.ts";

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
