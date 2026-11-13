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

test("the flight holds its fitted zoom until it starts and pads by layout offsets", () => {
  seen.length = 0;
  flights.length = 0;
  const flight = flyIn(fakeMap() as never, SCENE as never, fakeRoots(300) as never);

  assert.equal(flight.zoom, 5);
  assert.equal(flights.length, 0);
  assert.deepEqual(seen[0].padding, { top: 24, bottom: 124, left: 24, right: 1004 });

  void flight.start();

  assert.equal(flights.length, 1);
  assert.deepEqual(flights[0].bbox, [33, -5, 42, 5]);
  assert.deepEqual((flights[0].options as { padding: unknown }).padding, seen[0].padding);
});

test("a refit before the start moves the flight to the new layout", () => {
  seen.length = 0;
  flights.length = 0;
  minZooms.length = 0;
  setFitted(8);
  const roots = fakeRoots(300);
  const flight = flyIn(fakeMap() as never, SCENE as never, roots as never);

  roots.column.offsetLeft = 100;
  flight.refit();

  assert.equal(flight.zoom, 8);
  assert.equal(flights.length, 0);
  assert.notDeepEqual(seen[1].padding, seen[0].padding);

  void flight.start();

  assert.equal(flights.length, 1);
  assert.deepEqual((flights[0].options as { padding: unknown }).padding, seen[1].padding);
  assert.deepEqual(minZooms, []);
  setFitted(5);
});

test("the flight lasts longer for more zoom levels up to a cap", () => {
  const durations: number[] = [];
  for (const zoom of [5, 4.5, 3, 0]) {
    flights.length = 0;
    void flyIn(fakeMap({ zoom }) as never, SCENE as never, fakeRoots(300) as never).start();
    durations.push((flights[0].options as { duration: number }).duration);
  }

  assert.deepEqual(durations, [700, 925, 1600, 1800]);
});

test("the flight reports its duration for the interface phase", () => {
  setFitted(5);
  const flight = flyIn(fakeMap({ zoom: 2 }) as never, SCENE as never, fakeRoots(300) as never);

  assert.equal(flight.durationMs, 1800);
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

    void flyIn(fakeMap({ zoom: 2 }) as never, SCENE as never, fakeRoots(300) as never).start();

    const options = flights[0].options as { duration: number; padding: unknown };
    assert.equal(options.duration, 0);
    assert.deepEqual(options.padding, seen[0].padding);
    assert.equal(
      flyIn(fakeMap({ zoom: 2 }) as never, SCENE as never, fakeRoots(300) as never).durationMs,
      0,
    );
  } finally {
    (globalThis as Record<string, unknown>).matchMedia = previous;
  }
});

test("a moving flight lands through its own moveend with no per-tick camera drive", async () => {
  flights.length = 0;
  minZooms.length = 0;
  const jumps: unknown[] = [];
  const map = fakeMap({ isMoving: true, zoom: 4, jumps });
  const flight = flyIn(map as never, SCENE as never, fakeRoots(300) as never);
  let landed = false;

  const landing = flight.start().then(() => {
    landed = true;
  });
  await tick();
  assert.equal(landed, false);

  map.state.zoom = 5;
  map.state.center = { lng: 37, lat: 0 };
  map.emit("moveend");
  await landing;

  assert.equal(flights.length, 1);
  assert.equal(jumps.length, 0);
  assert.equal(map.eases.length, 0);
  assert.deepEqual(minZooms, []);
});

test("landing away from the fit eases there once and then lands", async () => {
  const map = fakeMap({ isMoving: true, zoom: 4 });
  const flight = flyIn(map as never, SCENE as never, fakeRoots(300) as never);
  let landed = false;
  const landing = flight.start().then(() => {
    landed = true;
  });

  map.emit("moveend");
  await tick();

  assert.equal(landed, false);
  assert.equal(map.eases.length, 1);
  assert.equal((map.eases[0] as { duration: number }).duration, 250);
  assert.equal((map.eases[0] as { zoom: number }).zoom, 5);

  map.state.zoom = 5;
  map.state.center = { lng: 37, lat: 0 };
  map.emit("moveend");
  await landing;

  assert.equal(map.eases.length, 1);
});

test("a flight that finishes at once lands without waiting for another event", async () => {
  await flyIn(fakeMap({ zoom: 5 }) as never, SCENE as never, fakeRoots(300) as never).start();
});

test("a refit during the flight makes the landing ease to the new fit", async () => {
  setFitted(5);
  const map = fakeMap({ isMoving: true, zoom: 4 });
  const flight = flyIn(map as never, SCENE as never, fakeRoots(300) as never);
  const landing = flight.start();

  setFitted(6);
  flight.refit();
  map.state.zoom = 5;
  map.state.center = { lng: 37, lat: 0 };
  map.emit("moveend");

  assert.equal((map.eases[0] as { zoom: number }).zoom, 6);
  map.state.zoom = 6;
  map.emit("moveend");
  await landing;
  setFitted(5);
});

test("the view limits start only when the hold is installed and end with stop", () => {
  minZooms.length = 0;
  unlocks.length = 0;
  const map = fakeMap({ zoom: 5 });
  const flight = flyIn(map as never, SCENE as never, fakeRoots(300) as never);

  void flight.start();
  assert.deepEqual(minZooms, []);

  flight.hold();
  assert.deepEqual(minZooms, [5 - 0.15]);

  flight.stop();
  assert.equal(unlocks.length, 1);
  assert.deepEqual(minZooms.at(-1), null);
});

test("stopping the flight drops the pending landing", async () => {
  const map = fakeMap({ isMoving: true, zoom: 4 });
  const flight = flyIn(map as never, SCENE as never, fakeRoots(300) as never);
  let landed = false;
  void flight.start().then(() => {
    landed = true;
  });

  flight.stop();
  map.state.zoom = 5;
  map.state.center = { lng: 37, lat: 0 };
  map.emit("moveend");
  await tick();

  assert.equal(landed, false);
});

test("a resize after landing eases to the latest fit before the hold", async () => {
  setFitted(5);
  minZooms.length = 0;
  const map = fakeMap({ isMoving: true, zoom: 5 });
  const flight = flyIn(map as never, SCENE as never, fakeRoots(300) as never);
  const landing = flight.start();

  map.state.zoom = 5;
  map.state.center = { lng: 37, lat: 0 };
  map.emit("moveend");
  await landing;
  assert.deepEqual(minZooms, []);

  setFitted(6);
  flight.refit();

  assert.equal((map.eases[0] as { zoom: number }).zoom, 6);
  let settled = false;
  const waiting = flight.settled().then(() => {
    settled = true;
  });
  await tick();
  assert.equal(settled, false);

  map.state.zoom = 6;
  map.emit("moveend");
  await waiting;

  assert.equal(settled, true);
  flight.hold();
  assert.deepEqual(minZooms, [6 - 0.15]);

  flight.stop();
  setFitted(5);
});

test("a second refit while awaiting the first keeps one settlement", async () => {
  setFitted(5);
  minZooms.length = 0;
  const map = fakeMap({ isMoving: true, zoom: 5 });
  const flight = flyIn(map as never, SCENE as never, fakeRoots(300) as never);
  const landing = flight.start();

  map.state.zoom = 5;
  map.state.center = { lng: 37, lat: 0 };
  map.emit("moveend");
  await landing;

  setFitted(6);
  flight.refit();
  const first = flight.settled();
  let settled = false;
  void first.then(() => {
    settled = true;
  });

  setFitted(7);
  flight.refit();

  assert.equal(flight.settled(), first);
  assert.equal((map.eases[1] as { zoom: number }).zoom, 7);
  await tick();
  assert.equal(settled, false);

  map.state.zoom = 6;
  map.emit("moveend");
  await tick();
  assert.equal(settled, false);

  map.state.zoom = 7;
  map.emit("moveend");
  await first;

  assert.equal(settled, true);
  flight.hold();
  assert.deepEqual(minZooms, [7 - 0.15]);

  flight.stop();
  setFitted(5);
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

function fakeMap(options: { isMoving?: boolean; zoom?: number; jumps?: unknown[] } = {}) {
  const listeners = new Map<string, Set<(...args: never[]) => void>>();
  const canvasListeners = new Map<string, Set<(...args: never[]) => void>>();
  const state = { zoom: options.zoom ?? 5, center: { lng: 37, lat: 0 } };
  const eases: unknown[] = [];
  return {
    state,
    eases,
    isMoving: () => options.isMoving ?? false,
    getZoom: () => state.zoom,
    getCenter: () => state.center,
    easeTo: (ease: unknown) => {
      eases.push(ease);
    },
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

// The offsets stand for layout metrics, which a slide transform never changes.
function fakeRoots(columnLeft: number) {
  return {
    column: { offsetLeft: columnLeft, offsetTop: 100 },
    timeBar: { offsetTop: 700, offsetHeight: 100 },
  };
}

function setFitted(zoom: number) {
  (globalThis as Record<string, unknown>).cameraTestFitted = {
    center: { lng: 37, lat: 0 },
    zoom,
  };
}

const SCENE = { area: { bbox: [33, -5, 42, 5] } };

const tick = () => new Promise((resolve) => setImmediate(resolve));
