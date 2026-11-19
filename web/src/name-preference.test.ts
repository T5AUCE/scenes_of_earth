import assert from "node:assert/strict";
import { afterEach, test } from "node:test";

import {
  loadNamePreference,
  NAME_PREFERENCE_KEY,
  preferredName,
  storeNamePreference,
} from "./name-preference.ts";

const originalStorage = Object.getOwnPropertyDescriptor(globalThis, "localStorage");

afterEach(() => {
  if (originalStorage) Object.defineProperty(globalThis, "localStorage", originalStorage);
  else Reflect.deleteProperty(globalThis, "localStorage");
});

test("the name language defaults to english", () => {
  useStorage();

  assert.equal(loadNamePreference(), "english");
});

test("an unknown stored value falls back to english", () => {
  const items = useStorage();

  items.set(NAME_PREFERENCE_KEY, "français");

  assert.equal(loadNamePreference(), "english");
});

test("the remembered language survives for the next visit", () => {
  const items = useStorage();

  storeNamePreference("local");

  assert.equal(items.get(NAME_PREFERENCE_KEY), "local");
  assert.equal(loadNamePreference(), "local");
});

test("the preferred name falls back when the local one is missing", () => {
  assert.equal(preferredName("Norway", null, "local"), "Norway");
  assert.equal(preferredName("Norway", undefined, "local"), "Norway");
  assert.equal(preferredName("Norway", "", "local"), "Norway");
  assert.equal(preferredName("Norway", "Norge", "english"), "Norway");
});

test("the preferred name uses the local one when asked", () => {
  assert.equal(preferredName("Norway", "Norge", "local"), "Norge");
});

test("a blocked store keeps the visit choice without throwing", () => {
  useStorage({
    getItem: () => {
      throw new Error("blocked");
    },
    setItem: () => {
      throw new Error("blocked");
    },
  });

  assert.equal(loadNamePreference(), "english");

  storeNamePreference("local");

  assert.equal(loadNamePreference(), "local");
});

test("the scene title follows a local choice made with blocked storage", () => {
  useStorage({
    getItem: () => {
      throw new Error("blocked");
    },
    setItem: () => {
      throw new Error("blocked");
    },
  });

  storeNamePreference("local");

  const preference = loadNamePreference();

  assert.equal(preferredName("Norway", "Norge", preference), "Norge");
  assert.equal(preferredName("Drawn scene", undefined, preference), "Drawn scene");
});

function useStorage(overrides: object = {}) {
  const items = new Map<string, string>();
  Object.assign(globalThis, {
    localStorage: {
      getItem: (key: string) => items.get(key) ?? null,
      setItem: (key: string, value: string) => items.set(key, value),
      removeItem: (key: string) => items.delete(key),
      ...overrides,
    },
  });

  return items;
}
