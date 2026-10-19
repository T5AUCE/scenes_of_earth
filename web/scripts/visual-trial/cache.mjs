/** A disk cache for Mapterhorn and OpenFreeMap responses, so repeat runs need no network. */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const CACHED_HOSTS = /^https:\/\/(tiles\.mapterhorn\.com|tiles\.openfreemap\.org)\//;
const CACHED_STATUSES = [200, 404];
const KEPT_HEADERS = ["content-type"];

/** Serves matching requests of the context from dir, fetching and storing any that are missing. */
export async function installCache(context, dir) {
  fs.mkdirSync(dir, { recursive: true });

  await context.route(CACHED_HOSTS, async (route) => {
    const request = route.request();
    if (request.method() !== "GET") return route.continue();

    const base = path.join(dir, crypto.createHash("sha1").update(request.url()).digest("hex"));
    const stored = readEntry(base);
    if (stored) return route.fulfill(stored);

    const response = await route.fetch();
    const entry = {
      status: response.status(),
      headers: { ...pickHeaders(response.headers()), "access-control-allow-origin": "*" },
      body: await response.body(),
    };
    if (CACHED_STATUSES.includes(entry.status)) writeEntry(base, entry);

    return route.fulfill(entry);
  });
}

function readEntry(base) {
  if (!fs.existsSync(`${base}.json`)) return null;

  const meta = JSON.parse(fs.readFileSync(`${base}.json`, "utf8"));
  return { ...meta, body: fs.readFileSync(`${base}.bin`) };
}

function writeEntry(base, { status, headers, body }) {
  fs.writeFileSync(`${base}.bin`, body);
  // The metadata goes last so a half-written entry is never read.
  fs.writeFileSync(`${base}.json`, JSON.stringify({ status, headers }));
}

function pickHeaders(headers) {
  const kept = KEPT_HEADERS.filter((name) => name in headers);
  return Object.fromEntries(kept.map((name) => [name, headers[name]]));
}
