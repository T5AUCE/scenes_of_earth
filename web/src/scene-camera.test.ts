import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { test } from "node:test";

const seen: { bbox: unknown; padding: unknown }[] = [];
const flights: { bbox: unknown; options: unknown }[] = [];
const minZooms: (number | null)[] = [];
const unlocks: number[] = [];

Object.assign(globalThis, {
  cameraTestSeen: seen,
  cameraTestFlights: flights,
  cameraTestMinZooms: minZooms,
  cameraTestUnlocks: unlocks,
  cameraTestFitted: { center: { lng: 37, lat: 0 }, zoom: 5 },
  matchMedia: () => ({ matches: false }),
  window: fakeWindow(),
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
      export const lockPan = () => {
        return () => {
          globalThis.cameraTestUnlocks.push(1);
        };
      };`;
      return { url: `data:text/javascript,${encodeURIComponent(source)}`, shortCircuit: true };
    }
    return next(specifier, context);
  },
});
const { flightDuration, flyIn, watchResize } = await import("./scene-camera.ts");
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

test("the start flies once with the full duration and measured padding", () => {
  seen.length = 0;
  flights.length = 0;
  const scene = { area: { bbox: [33, -5, 42, 5] } };
  const roots = fakeRoots(300);
  const flight = flyIn(fakeMap() as never, scene as never, roots as never, () => {});

  flight.start();
  flight.start();

  assert.equal(flights.length, 1);
  const options = flights[0].options as { duration: number; padding: unknown };
  assert.equal(options.duration, 1800);
  assert.deepEqual(options.padding, seen[0].padding);
});

test("reduced motion shortens the flight to zero while the padding stays measured", () => {
  const previous = (globalThis as Record<string, unknown>).matchMedia;
  (globalThis as Record<string, unknown>).matchMedia = (query: string) => ({
    matches: query.includes("reduce"),
  });
  try {
    assert.equal(flightDuration(), 0);
    seen.length = 0;
    flights.length = 0;
    const scene = { area: { bbox: [33, -5, 42, 5] } };
    const flight = flyIn(fakeMap() as never, scene as never, fakeRoots(300) as never, () => {});

    flight.start();

    assert.equal(flights.length, 1);
    const options = flights[0].options as { duration: number; padding: unknown };
    assert.equal(options.duration, 0);
    assert.deepEqual(options.padding, seen[0].padding);
  } finally {
    (globalThis as Record<string, unknown>).matchMedia = previous;
  }
});

test("a moving map lands through its own moveend with no per-tick camera drive", () => {
  flights.length = 0;
  minZooms.length = 0;
  unlocks.length = 0;
  const jumps: unknown[] = [];
  let landed = 0;
  const scene = { area: { bbox: [33, -5, 42, 5] } };
  const map = fakeMap({ isMoving: true, jumps });
  const flight = flyIn(map as never, scene as never, fakeRoots(300) as never, () => {
    landed += 1;
  });

  flight.start();
  assert.equal(landed, 0);

  map.emit("moveend");
  assert.equal(landed, 1);
  assert.deepEqual(minZooms.at(-1), 5 - 0.15);
  assert.equal(flights.length, 1);
  assert.equal(jumps.length, 0);

  flight.stopClamp();
  assert.equal(unlocks.length, 1);
  assert.deepEqual(minZooms.at(-1), null);
});

test("stopping the clamp drops the pending landing and releases the zoom limit", () => {
  minZooms.length = 0;
  let landed = 0;
  const map = fakeMap({ isMoving: true });
  const flight = flyIn(
    map as never,
    { area: { bbox: [33, -5, 42, 5] } } as never,
    fakeRoots(300) as never,
    () => {
      landed += 1;
    },
  );

  flight.start();
  flight.stopClamp();
  map.emit("moveend");

  assert.equal(landed, 0);
  assert.deepEqual(minZooms.at(-1), null);
});

test("the resize watch settles once and its cleanup drops the pending callback", async () => {
  let settled = 0;
  const stop = watchResize(() => {
    settled += 1;
  });

  (globalThis as { window: ReturnType<typeof fakeWindow> }).window.emit("resize");
  (globalThis as { window: ReturnType<typeof fakeWindow> }).window.emit("resize");
  await new Promise((resolve) => setTimeout(resolve, 300));
  assert.equal(settled, 1);

  (globalThis as { window: ReturnType<typeof fakeWindow> }).window.emit("resize");
  stop();
  await new Promise((resolve) => setTimeout(resolve, 300));
  assert.equal(settled, 1);
});

function fakeWindow() {
  const listeners = new Map<string, Set<(...args: never[]) => void>>();
  return {
    innerWidth: 1280,
    innerHeight: 800,
    addEventListener: (type: string, listener: (...args: never[]) => void) => {
      if (!listeners.has(type)) listeners.set(type, new Set());
      listeners.get(type)!.add(listener);
    },
    removeEventListener: (type: string, listener: (...args: never[]) => void) => {
      listeners.get(type)?.delete(listener);
    },
    emit: (type: string) => {
      for (const listener of [...(listeners.get(type) ?? [])]) listener();
    },
  };
}

function fakeMap(options: { isMoving?: boolean; jumps?: unknown[] } = {}) {
  const listeners = new Map<string, Set<(...args: never[]) => void>>();
  const canvasListeners = new Map<string, Set<(...args: never[]) => void>>();
  return {
    isMoving: () => options.isMoving ?? false,
    setMinZoom: (zoom: number | null) => {
      (globalThis as Record<string, unknown> & { cameraTestMinZooms: (number | null)[] })
        .cameraTestMinZooms.push(zoom);
    },
    on: (type: string, listener: (...args: never[]) => void) => {
      if (!listeners.has(type)) listeners.set(type, new Set());
      listeners.get(type)!.add(listener);
    },
    off: (type: string, listener: (...args: never[]) => void) => {
      listeners.get(type)?.delete(listener);
    },
    emit: (type: string) => {
      for (const listener of [...(listeners.get(type) ?? [])]) listener();
    },
    stop: () => {},
    jumpTo: (jump: unknown) => {
      options.jumps?.push(jump);
    },
    getCanvasContainer: () => ({
      addEventListener: (type: string, listener: (...args: never[]) => void) => {
        if (!canvasListeners.has(type)) canvasListeners.set(type, new Set());
        canvasListeners.get(type)!.add(listener);
      },
      removeEventListener: (type: string, listener: (...args: never[]) => void) => {
        canvasListeners.get(type)?.delete(listener);
      },
    }),
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
