import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { test } from "node:test";

const seen: { bbox: unknown; padding: unknown }[] = [];
const flights: { bbox: unknown; options: unknown }[] = [];
const minZooms: (number | null)[] = [];

Object.assign(globalThis, {
  cameraTestSeen: seen,
  cameraTestFlights: flights,
  cameraTestMinZooms: minZooms,
  cameraTestFitted: { center: { lng: 37, lat: 0 }, zoom: 5 },
  matchMedia: () => ({ matches: false }),
  window: { innerWidth: 1280, innerHeight: 800 },
});

const cameraUrl = new URL("./scene-camera.ts", import.meta.url).href;
const hooks = registerHooks({
  resolve(specifier, context, next) {
    if (specifier === "./map" && context.parentURL === cameraUrl) {
      const source = `export const fitCamera = (map, bbox, padding) => {
        globalThis.cameraTestSeen.push({ bbox, padding });
        return globalThis.cameraTestFitted;
      };
      export const fitToBbox = (map, bbox, options) => {
        globalThis.cameraTestFlights.push({ bbox, options });
      };
      export const lockPan = () => () => {};`;
      return { url: `data:text/javascript,${encodeURIComponent(source)}`, shortCircuit: true };
    }
    return next(specifier, context);
  },
});
const { flyIn } = await import("./scene-camera.ts");
hooks.deregister();

test("the flight holds its fitted zoom until it starts", () => {
  seen.length = 0;
  flights.length = 0;
  let landed = 0;
  const scene = { area: { bbox: [33, -5, 42, 5] } };
  const roots = fakeRoots(300);

  const flight = flyIn(fakeMap() as never, scene as never, roots as never, () => {
    landed += 1;
  });

  assert.equal(flight.zoom, 5);
  assert.equal(flights.length, 0);
  assert.equal(landed, 0);

  flight.start();

  assert.equal(flights.length, 1);
  assert.deepEqual(flights[0].bbox, [33, -5, 42, 5]);
  assert.deepEqual((flights[0].options as { padding: unknown }).padding, seen[0].padding);
  assert.equal(landed, 1);
});

test("a refit before the start moves the flight and its clamp to the new layout", () => {
  seen.length = 0;
  flights.length = 0;
  minZooms.length = 0;
  (globalThis as Record<string, unknown>).cameraTestFitted = {
    center: { lng: 37, lat: 0 },
    zoom: 8,
  };
  const scene = { area: { bbox: [33, -5, 42, 5] } };
  const roots = fakeRoots(300);
  const flight = flyIn(fakeMap() as never, scene as never, roots as never, () => {});

  roots.rect.left = 100;
  flight.refit();

  assert.equal(flight.zoom, 8);
  assert.equal(flights.length, 0);
  assert.notDeepEqual(seen[1].padding, seen[0].padding);

  flight.start();

  assert.equal(flights.length, 1);
  assert.deepEqual((flights[0].options as { padding: unknown }).padding, seen[1].padding);
  assert.deepEqual(minZooms, [8 - 0.15]);

  (globalThis as Record<string, unknown>).cameraTestFitted = {
    center: { lng: 37, lat: 0 },
    zoom: 5,
  };
});

function fakeMap() {
  return {
    isMoving: () => false,
    setMinZoom: (zoom: number | null) => {
      (globalThis as Record<string, unknown> & { cameraTestMinZooms: (number | null)[] })
        .cameraTestMinZooms.push(zoom);
    },
    on: () => {},
    off: () => {},
    getCanvasContainer: () => ({ addEventListener: () => {}, removeEventListener: () => {} }),
  };
}

function fakeRoots(columnLeft: number) {
  const rect = { left: columnLeft, top: 100, height: 0 };
  return {
    rect,
    column: { getBoundingClientRect: () => rect },
    timeBar: { getBoundingClientRect: () => ({ top: 700, height: 100 }) },
  };
}
