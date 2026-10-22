import assert from "node:assert/strict";
import { test } from "node:test";

import { isMasterOn, masterChangedUnits } from "./master-switch.ts";
import type { LayerDoc } from "../types.ts";

const TERRAIN = layer("terrain", ["shade"], ["contours"]);

test("the switch shows on while any part is on", () => {
  assert.equal(isMasterOn(TERRAIN, new Set()), true);
  assert.equal(isMasterOn(TERRAIN, new Set(["terrain"])), true);
  assert.equal(isMasterOn(TERRAIN, new Set(["terrain", "terrain.contours"])), false);
});

test("turning off changes every unit that is still on", () => {
  assert.deepEqual(masterChangedUnits(TERRAIN, new Set(), undefined, false), [
    "terrain",
    "terrain.contours",
  ]);
  assert.deepEqual(masterChangedUnits(TERRAIN, new Set(["terrain"]), undefined, false), [
    "terrain.contours",
  ]);
  assert.deepEqual(
    masterChangedUnits(TERRAIN, new Set(["terrain", "terrain.contours"]), [], false),
    [],
  );
});

test("turning on restores the remembered parts or the main part", () => {
  assert.deepEqual(
    masterChangedUnits(
      TERRAIN,
      new Set(["terrain", "terrain.contours"]),
      ["terrain.contours"],
      true,
    ),
    ["terrain.contours"],
  );
  assert.deepEqual(
    masterChangedUnits(TERRAIN, new Set(["terrain"]), undefined, true),
    ["terrain"],
  );
});

function layer(id: string, encodings: string[], parts: string[] = []): LayerDoc {
  return {
    id,
    style: { kind: "terrain", encodings, parts },
  } as unknown as LayerDoc;
}
