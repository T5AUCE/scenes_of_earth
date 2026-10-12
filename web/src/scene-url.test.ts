import assert from "node:assert/strict";
import { test } from "node:test";
import { routeFor, sceneUrl, timeForMonth } from "./scene-url.ts";

const id = "0123456789abcdef0123";

test("the link keeps the scene and only the month of the step", () => {
  assert.equal(sceneUrl(id, "2026-03-01"), `?scene=${id}&t=2026-03`);
  assert.equal(sceneUrl(id, null), `?scene=${id}`);
});

test("an address without a scene is the world view", () => {
  assert.deepEqual(routeFor("", null), { kind: "world" });
  assert.deepEqual(routeFor("?t=2026-03", null), { kind: "world" });
});

test("a scene link reads the month and ignores a malformed one", () => {
  assert.deepEqual(routeFor(`?scene=${id}&t=2026-03`, null), {
    kind: "scene",
    id,
    month: "2026-03",
    panel: null,
  });

  assert.equal((routeFor(`?scene=${id}&t=2026-13`, null) as { month: string | null }).month, null);
  assert.equal((routeFor(`?scene=${id}&t=soon`, null) as { month: string | null }).month, null);
});

test("the full view is open, on its tab, only when the history entry says so", () => {
  const open = routeFor(`?scene=${id}`, { panel: "credits" });
  const closed = routeFor(`?scene=${id}`, {});

  assert.equal((open as { panel: string | null }).panel, "credits");
  assert.equal((closed as { panel: string | null }).panel, null);
});

test("a month selects the first step that starts in it", () => {
  const sixteenDay = ["2020-01-01", "2020-01-17", "2020-02-02"];

  assert.equal(timeForMonth(sixteenDay, "2020-01"), "2020-01-01");
  assert.equal(timeForMonth(sixteenDay, "2020-02"), "2020-02-02");
  assert.equal(timeForMonth(sixteenDay, "2020-03"), undefined);
});
