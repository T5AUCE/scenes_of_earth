import assert from "node:assert/strict";
import { test } from "node:test";
import { BUILD_REQUEST_TIMEOUT_MS, isSceneId } from "./api.ts";

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

test("the build request waits longer than the backend vintage lookup of 15 s", () => {
  assert.ok(BUILD_REQUEST_TIMEOUT_MS > 15_000);
});
