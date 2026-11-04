/**
 * Versioned chart slices with guarded per-scene storage and a compact share codec.
 * Tables stay derived; only committed definitions travel in storage and links.
 */
import { CHARTS_PARAM, chartsTokenFor } from "../scene-url";
import type { LayerDoc } from "../types";
import {
  MAX_DEFINITIONS,
  creationAvailability,
  defaultDefinitions,
  resolveMainId,
  validateDefinition,
  type ChartDefinition,
} from "./definitions";
export { MAX_DEFINITIONS, MAX_TITLE_CHARS } from "./definitions";
export { CHARTS_PARAM, chartsTokenFor };

/** The chart slice version stored per scene and carried in share links. */
export const CHARTS_VERSION = 1;

/** The storage prefix; the full key adds the scene id. */
export const STORAGE_PREFIX = "soe.charts.v1.";

/** The most UTF-8 bytes of decoded JSON accepted before parsing. */
export const MAX_DECODED_BYTES = 32 * 1024;

/**
 * The most characters of encoded token accepted before decoding, derived from the byte
 * limit because base64url carries four characters per three bytes.
 */
export const MAX_TOKEN_CHARS = Math.ceil((MAX_DECODED_BYTES * 4) / 3);

/** The most characters of a complete share URL that still counts as synced. */
export const MAX_COMPLETE_URL_CHARS = 8 * 1024;

const BASE64URL_PATTERN = /^[A-Za-z0-9-_]*$/;
/** Base64 encodes four characters per three bytes, so padding restores the block size. */
const BASE64_BLOCK = 4;

/** The versioned chart slice of one scene. */
export interface ChartSlice {
  version: 1;
  definitions: ChartDefinition[];
  mainChartId: string | null;
}

/** Where resolved charts came from; links never merge with stored slices. */
export type ChartSourceName = "link" | "stored" | "defaults";

/** The notice shown when a link or stored slice falls back. */
export const INVALID_CHARTS_NOTICE =
  "Saved charts in this link or browser could not be used, so defaults are shown.";

/** The notice shown when the complete share URL would be too long. */
export const UNSYNCED_CHARTS_NOTICE = "The share link is too long to include these charts.";

/** The nonblocking notice shown when browser storage cannot be read or written. */
export const STORAGE_DENIED_NOTICE =
  "Charts are kept for this visit only because browser storage is unavailable.";

/** The notice shown when committed charts are too large to persist. */
export const TOO_LARGE_CHARTS_NOTICE =
  "This edit was too large to save, so it was not saved. The current charts remain for this visit.";

/** The storage key of one scene's chart slice. */
export function storageKeyFor(sceneId: string) {
  return `${STORAGE_PREFIX}${sceneId}`;
}

/** The default slice for layers, with the preferred main already resolved. */
export function defaultSlice(layers: readonly LayerDoc[]): ChartSlice {
  const definitions = defaultDefinitions(layers);
  const mainChartId = resolveMainId(definitions, null, layers);

  return { version: CHARTS_VERSION, definitions, mainChartId };
}

/** Whether a slice has the version, unique ids, supported shapes and a member main id. */
export function isValidSlice(slice: unknown, layers: readonly LayerDoc[]): slice is ChartSlice {
  try {
    return isValidSliceInner(slice, layers);
  } catch {
    return false;
  }
}

function isValidSliceInner(slice: unknown, layers: readonly LayerDoc[]) {
  if (typeof slice !== "object" || slice === null || Array.isArray(slice)) return false;

  const { version, definitions, mainChartId } = slice as Partial<ChartSlice>;
  if (version !== CHARTS_VERSION) return false;
  if (!Array.isArray(definitions) || definitions.length > MAX_DEFINITIONS) return false;

  const ids = new Set<string>();
  for (const definition of definitions) {
    if (validateDefinition(definition, layers) !== null) return false;
    if (typeof (definition as ChartDefinition).id !== "string") return false;
    if (ids.has((definition as ChartDefinition).id)) return false;

    ids.add((definition as ChartDefinition).id);
  }
  if (definitions.length === 0) {
    if (mainChartId !== null) return false;

    return !creationAvailability(layers).allowed;
  }
  if (typeof mainChartId !== "string" || !ids.has(mainChartId)) return false;

  return true;
}

/** Encode a slice as compact base64url JSON without whitespace. */
export function encodeSlice(slice: ChartSlice) {
  const payload = {
    version: slice.version,
    definitions: slice.definitions,
    mainChartId: slice.mainChartId,
  };

  return encodeBase64Url(JSON.stringify(payload));
}

/**
 * Decode a share token, validating lengths, schema, sources and options. Invalid input returns
 * null with a notice instead of throwing, so callers can fall back to stored or default charts.
 */
export function decodeToken(
  token: string | null | undefined,
  layers: readonly LayerDoc[],
): { slice: ChartSlice | null; notice: string | null } {
  if (!token) return { slice: null, notice: null };
  if (token.length > MAX_TOKEN_CHARS) return { slice: null, notice: INVALID_CHARTS_NOTICE };
  if (!BASE64URL_PATTERN.test(token)) return { slice: null, notice: INVALID_CHARTS_NOTICE };

  let bytes: Uint8Array;
  try {
    bytes = decodeBase64Bytes(token);
  } catch {
    return { slice: null, notice: INVALID_CHARTS_NOTICE };
  }
  if (bytes.length > MAX_DECODED_BYTES) return { slice: null, notice: INVALID_CHARTS_NOTICE };

  let json: string;
  try {
    json = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return { slice: null, notice: INVALID_CHARTS_NOTICE };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return { slice: null, notice: INVALID_CHARTS_NOTICE };
  }
  if (!isValidSlice(parsed, layers)) return { slice: null, notice: INVALID_CHARTS_NOTICE };

  return { slice: parsed, notice: null };
}

/** Read a scene's stored slice, falling back to defaults with a notice when it is unusable. */
export function loadStoredSlice(
  sceneId: string,
  layers: readonly LayerDoc[],
): { slice: ChartSlice; notice: string | null; stored: boolean } {
  const fallback = defaultSlice(layers);
  let raw: string | null = null;
  try {
    raw = localStorage.getItem(storageKeyFor(sceneId));
  } catch {
    return { slice: fallback, notice: STORAGE_DENIED_NOTICE, stored: false };
  }
  if (!raw) return { slice: fallback, notice: null, stored: false };

  try {
    if (new TextEncoder().encode(raw).length > MAX_DECODED_BYTES) {
      return { slice: fallback, notice: INVALID_CHARTS_NOTICE, stored: false };
    }
  } catch {
    return { slice: fallback, notice: INVALID_CHARTS_NOTICE, stored: false };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { slice: fallback, notice: INVALID_CHARTS_NOTICE, stored: false };
  }
  if (!isValidSlice(parsed, layers)) {
    return { slice: fallback, notice: INVALID_CHARTS_NOTICE, stored: false };
  }

  return { slice: parsed, notice: null, stored: true };
}

/**
 * Persist committed definitions for a bare scene visit. Drafts never reach this helper, and
 * link visits stay session-only so the receiver's storage is left alone. Oversized slices stay
 * in memory with an unsaved result because the loader would reject them on reload.
 */
export function storeSlice(
  sceneId: string,
  slice: ChartSlice,
): { saved: boolean; notice: string | null } {
  let serialized: string;
  try {
    serialized = JSON.stringify(slice);
    if (new TextEncoder().encode(serialized).length > MAX_DECODED_BYTES) {
      return { saved: false, notice: TOO_LARGE_CHARTS_NOTICE };
    }
    localStorage.setItem(storageKeyFor(sceneId), serialized);

    return { saved: true, notice: null };
  } catch {
    return { saved: false, notice: STORAGE_DENIED_NOTICE };
  }
}

/**
 * Resolve charts with link over stored over defaults precedence. Any received link visit stays
 * session-only, even when its payload falls back, so later edits never overwrite storage.
 */
export function resolveCharts(
  layers: readonly LayerDoc[],
  linkToken: string | null | undefined,
  stored: ChartSlice | null,
): { slice: ChartSlice; source: ChartSourceName; notice: string | null; sessionOnly: boolean } {
  const linked = decodeToken(linkToken, layers);
  if (linked.slice) {
    return { slice: linked.slice, source: "link", notice: null, sessionOnly: true };
  }
  if (linkToken) {
    const fallback = stored && isValidSlice(stored, layers) ? stored : defaultSlice(layers);

    return {
      slice: fallback,
      source: stored ? "stored" : "defaults",
      notice: INVALID_CHARTS_NOTICE,
      sessionOnly: true,
    };
  }
  if (stored && isValidSlice(stored, layers)) {
    return { slice: stored, source: "stored", notice: null, sessionOnly: false };
  }

  return { slice: defaultSlice(layers), source: "defaults", notice: null, sessionOnly: false };
}

/** Serialize a slice as a charts query string with URLSearchParams, or empty when absent. */
export function formatChartsParam(slice: ChartSlice | null) {
  if (!slice) return "";

  const parameters = new URLSearchParams();
  parameters.set(CHARTS_PARAM, encodeSlice(slice));

  return `&${parameters.toString()}`;
}

/** Whether a complete share URL is too long to carry its charts. */
export function isCompleteUrlOversized(url: string) {
  return url.length > MAX_COMPLETE_URL_CHARS;
}

function encodeBase64Url(json: string) {
  const bytes = new TextEncoder().encode(json);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);

  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function decodeBase64Bytes(token: string) {
  let base64 = token.replace(/-/g, "+").replace(/_/g, "/");
  const remainder = base64.length % BASE64_BLOCK;
  if (remainder) base64 += "=".repeat(BASE64_BLOCK - remainder);

  const binary = atob(base64);

  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}
