/** Caches public map responses while respecting upstream freshness and validators. */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const CACHED_HOSTS = /^https:\/\/(tiles\.mapterhorn\.com|tiles\.openfreemap\.org)\//;
const KEPT_HEADERS = [
  "content-type",
  "cache-control",
  "date",
  "age",
  "expires",
  "etag",
  "last-modified",
  "vary",
];
const MS_PER_SEC = 1000;

/** Revalidates mutable entries across runs and atomically stores successful public responses. */
export async function installCache(context, dir) {
  fs.mkdirSync(dir, { recursive: true });
  const runStartedMs = Date.now();
  await context.route(CACHED_HOSTS, async (route) => {
    const request = route.request();
    if (request.method() !== "GET") return route.continue();

    const digest = crypto.createHash("sha256").update(request.url()).digest("hex");
    const file = path.join(dir, `${digest}.entry.json`);
    const stored = readEntry(file);
    if (stored && isFresh(stored, Date.now(), runStartedMs)) {
      return route.fulfill(makeFulfillment(stored));
    }

    const headers = { ...request.headers(), ...makeValidatorHeaders(stored) };
    const response = await route.fetch({ headers });
    const revalidated = response.status() === 304 && stored;
    const entry = {
      status: revalidated ? stored.status : response.status(),
      headers: {
        ...(revalidated ? stored.headers : {}),
        ...pickHeaders(response.headers()),
        "access-control-allow-origin": "*",
      },
      storedAtMs: Date.now(),
      body: revalidated ? stored.body : await response.body(),
    };
    if (canStore(entry)) writeEntry(file, entry);

    return route.fulfill(makeFulfillment(entry));
  });
}

function makeValidatorHeaders(entry) {
  if (entry?.headers.etag) return { "if-none-match": entry.headers.etag };
  if (entry?.headers["last-modified"]) {
    return { "if-modified-since": entry.headers["last-modified"] };
  }
  return {};
}

function makeFulfillment({ status, headers, body }) {
  return { status, headers, body };
}

/** Checks freshness without allowing mutable entries to bypass a new run's revalidation. */
export function isFresh(entry, nowMs, runStartedMs) {
  if (!canStore(entry)) return false;

  const control = entry.headers["cache-control"] ?? "";
  if (/\bno-cache\b/i.test(control)) return false;
  if (entry.storedAtMs <= runStartedMs && !/\bimmutable\b/i.test(control)) return false;

  const dateMs = Date.parse(entry.headers.date);
  const maxAgeSecs = /\bmax-age\s*=\s*"?(\d+)/i.exec(control)?.[1];
  const expiresMs = Date.parse(entry.headers.expires);
  const lifetimeMs = maxAgeSecs === undefined
    ? expiresMs - (Number.isFinite(dateMs) ? dateMs : entry.storedAtMs)
    : Number(maxAgeSecs) * MS_PER_SEC;
  const apparentAgeMs = Number.isFinite(dateMs) ? Math.max(0, entry.storedAtMs - dateMs) : 0;
  const ageMs = Math.max(apparentAgeMs, Number(entry.headers.age ?? 0) * MS_PER_SEC);

  return ageMs + Math.max(0, nowMs - entry.storedAtMs) < lifetimeMs;
}

function canStore(entry) {
  const control = entry.headers["cache-control"] ?? "";
  const vary = entry.headers.vary?.toLowerCase();
  return entry.status === 200
    && !/\b(no-store|private)\b/i.test(control)
    && (!vary || vary === "accept-encoding");
}

/** Treats incomplete, corrupt or obsolete entries as misses rather than aborting a trial. */
export function readEntry(file) {
  try {
    const entry = JSON.parse(fs.readFileSync(file, "utf8"));
    if (entry.status !== 200 || !Number.isFinite(entry.storedAtMs)) return null;
    if (!entry.headers || typeof entry.headers !== "object" || Array.isArray(entry.headers)) {
      return null;
    }
    if (!Object.values(entry.headers).every((value) => typeof value === "string")) return null;
    if (typeof entry.body !== "string") return null;

    const body = Buffer.from(entry.body, "base64");
    const digest = crypto.createHash("sha256").update(body).digest("hex");
    if (entry.digest !== digest) return null;

    return { status: entry.status, headers: entry.headers, storedAtMs: entry.storedAtMs, body };
  } catch {
    return null;
  }
}

/** Publishes one complete entry so concurrent readers never mix metadata and response bodies. */
export function writeEntry(file, entry) {
  const temporary = `${file}.${crypto.randomUUID()}.tmp`;
  try {
    const serialized = {
      ...entry,
      body: entry.body.toString("base64"),
      digest: crypto.createHash("sha256").update(entry.body).digest("hex"),
    };
    fs.writeFileSync(temporary, JSON.stringify(serialized), { flag: "wx" });
    fs.renameSync(temporary, file);
  } finally {
    fs.rmSync(temporary, { force: true });
  }
}

function pickHeaders(headers) {
  const kept = KEPT_HEADERS.filter((name) => name in headers);
  return Object.fromEntries(kept.map((name) => [name, headers[name]]));
}
