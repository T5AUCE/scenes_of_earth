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
    display: { pal: "", range: "", off: "", colour: "" },
  });

  const timeOf = (label: string) =>
    (routeFor(`?scene=${id}&t=${label}`, null) as { time: string | null }).time;

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

test("display params round trip through the address", () => {
  const params = "&pal=chirps_monthly:batlow&range=chirps_monthly:0:250&off=terrain.contours";
  const url = sceneUrl(id, "2019-03", params);
  const route = routeFor(url, null) as { display: unknown };

  assert.equal(url, `?scene=${id}&t=2019-03${params}`);
  assert.deepEqual(route.display, {
    pal: "chirps_monthly:batlow",
    range: "chirps_monthly:0:250",
    off: "terrain.contours",
    colour: "",
  });
});

test("the colour param round trips through the address", () => {
  const url = sceneUrl(id, null, "&colour=blend");
  const route = routeFor(url, null) as { display: { colour: string } };

  const plain = routeFor(`?scene=${id}`, null) as { display: { colour: string } };

  assert.equal(url, `?scene=${id}&colour=blend`);
  assert.equal(route.display.colour, "blend");
  assert.equal(plain.display.colour, "");
});

test("colons and commas are not percent encoded", () => {
  const url = sceneUrl(id, null, "&pal=a:b,c:custom-1a2b3c-88cc44&off=terrain.contours");

  assert.ok(!url.includes("%"));
});

test("repeated display parameters are joined in order", () => {
  const route = routeFor(`?scene=${id}&pal=a:x&pal=b:y&off=u`, null) as {
    display: { pal: string; off: string };
  };

  assert.equal(route.display.pal, "a:x,b:y");
  assert.equal(route.display.off, "u");
});

test("a link without display params is unchanged", () => {
  assert.equal(sceneUrl(id, "2019-03"), `?scene=${id}&t=2019-03`);
  assert.equal(sceneUrl(id, null, ""), `?scene=${id}`);
});
