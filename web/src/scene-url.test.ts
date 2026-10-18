import assert from "node:assert/strict";
import { test } from "node:test";

import { routeFor, sceneUrl, timeForPrefix } from "./scene-url.ts";
import { formatTime } from "./timeline.ts";

const id = "0123456789abcdef0123";

test("a link keeps the date to the finest step's precision", () => {
  const linkTo = (time: string, steps: string[]) => sceneUrl(id, formatTime(time, steps));

  assert.equal(linkTo("2026-03-01", ["P1M"]), `?scene=${id}&t=2026-03`);
  assert.equal(linkTo("2026-03-17", ["P1M", "P16D"]), `?scene=${id}&t=2026-03-17`);
  assert.equal(linkTo("2025-01-01", ["P5Y"]), `?scene=${id}&t=2025`);
  assert.equal(sceneUrl(id, null), `?scene=${id}`);
});

test("an address without a scene is the world view", () => {
  assert.deepEqual(routeFor("", null), { kind: "world" });
  assert.deepEqual(routeFor("?t=2026-03", null), { kind: "world" });
});

test("a scene link reads the time and ignores a malformed one", () => {
  assert.deepEqual(routeFor(`?scene=${id}&t=2026-03`, null), {
    kind: "scene",
    id,
    time: "2026-03",
    panel: null,
  });

  const timeOf = (t: string) =>
    (routeFor(`?scene=${id}&t=${t}`, null) as { time: string | null }).time;

  assert.equal(timeOf("2026"), "2026");
  assert.equal(timeOf("2026-03-17"), "2026-03-17");
  assert.equal(timeOf("2026-13"), null);
  assert.equal(timeOf("soon"), null);
});

test("the full view is open, on its tab, only when the history entry says so", () => {
  const open = routeFor(`?scene=${id}`, { panel: "credits" });
  const closed = routeFor(`?scene=${id}`, {});

  assert.equal((open as { panel: string | null }).panel, "credits");
  assert.equal((closed as { panel: string | null }).panel, null);
});

test("a month selects the first step that starts in it", () => {
  const sixteenDay = ["2020-01-01", "2020-01-17", "2020-02-02"];

  assert.equal(timeForPrefix(sixteenDay, "2020-01"), "2020-01-01");
  assert.equal(timeForPrefix(sixteenDay, "2020-02"), "2020-02-02");
  assert.equal(timeForPrefix(sixteenDay, "2020-03"), undefined);
});

test("a year link selects the first step in that year", () => {
  const steps = ["2019-12-01", "2020-01-01", "2020-02-01"];

  assert.equal(timeForPrefix(steps, "2020"), "2020-01-01");
});
