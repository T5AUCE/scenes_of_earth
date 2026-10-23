/** Parses command-line options and validates visual trial places files. */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const PLACES_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "places");
const DEFAULT_PARALLEL_VIEWS = 3;
const LAYOUT_PRESET = "layout";

/**
 * The layout command checks one fixed scene. It bundles four layers over a period, so Play,
 * the timeline slider, every card switch, Units radios and Reset all exist on one bundle.
 */
const LAYOUT_PLACES = {
  spots: [
    {
      name: "Layout",
      area: "sample:kenya",
      centre: [37.0, 0.5],
      layers: ["terrain", "chirps_monthly", "era5land_temperature", "esa_worldcover"],
      start: "2026-04",
      end: "2026-09",
      layout: true,
    },
  ],
};

export const USAGE =
  "usage: npm run trial -- <places.json|preset> [--start | --app <url>] [--out dir] [--screens]"
  + " [--parallel n]";

/** Parses argv (without node and script) into options. Throws a usage message on bad input. */
export function parseArgs(argv) {
  const options = {
    places: null,
    start: false,
    app: null,
    out: null,
    screens: false,
    parallel: DEFAULT_PARALLEL_VIEWS,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--start") options.start = true;
    else if (argument === "--screens") options.screens = true;
    else if (argument === "--app") options.app = valueAfter(argv, ++index, argument);
    else if (argument === "--out") options.out = valueAfter(argv, ++index, argument);
    else if (argument === "--parallel") {
      options.parallel = Number(valueAfter(argv, ++index, argument));
    } else if (argument.startsWith("--") || options.places) {
      throw new Error(`unexpected argument ${argument}\n${USAGE}`);
    } else options.places = argument;
  }

  if (!options.places) throw new Error(USAGE);
  if (options.start === Boolean(options.app)) {
    throw new Error(`give exactly one of --start and --app <url>\n${USAGE}`);
  }
  if (!(options.parallel >= 1)) throw new Error(`--parallel must be at least 1\n${USAGE}`);

  return options;
}

function valueAfter(argv, index, flag) {
  if (index >= argv.length) throw new Error(`${flag} needs a value\n${USAGE}`);

  return argv[index];
}

/** Reads a places file given by path or by preset name and checks its shape. */
export function loadPlaces(text) {
  if (text === LAYOUT_PRESET) return checkPlaces(LAYOUT_PLACES, LAYOUT_PRESET);

  const direct = path.resolve(text);
  const preset = path.join(PLACES_DIR, text.endsWith(".json") ? text : `${text}.json`);
  const file = [direct, preset].find((candidate) => fs.existsSync(candidate));
  if (!file) throw new Error(`no places file or preset named ${text}`);

  return checkPlaces(JSON.parse(fs.readFileSync(file, "utf8")), file);
}

/** Validates places and fills defaults. Throws an error that names the invalid field. */
export function checkPlaces(data, file = "places") {
  if (!Array.isArray(data.spots) || !data.spots.length) {
    throw new Error(`${file}: "spots" must be a non-empty list`);
  }

  return data.spots.map((spot, index) => {
    const where = `${file}: spot ${index + 1}`;
    if (typeof spot.name !== "string" || typeof spot.area !== "string") {
      throw new Error(`${where} needs a string "name" and "area"`);
    }
    const centre = spot.centre;
    if (!Array.isArray(centre) || centre.length !== 2 || !centre.every(Number.isFinite)) {
      throw new Error(`${where} needs "centre" as [lon, lat]`);
    }
    const zooms = spot.zooms ?? ["fitted"];
    if (!zooms.every((zoom) => zoom === "fitted" || Number.isFinite(zoom))) {
      throw new Error(`${where} "zooms" must hold "fitted" or numbers`);
    }
    if (spot.colour !== undefined && (typeof spot.colour !== "string" || !spot.colour)) {
      throw new Error(`${where} "colour" must be a non-empty string`);
    }
    if (spot.layout !== undefined && typeof spot.layout !== "boolean") {
      throw new Error(`${where} "layout" must be a boolean`);
    }

    return {
      name: spot.name,
      area: spot.area,
      centre,
      zooms,
      layers: spot.layers ?? ["terrain"],
      enable: spot.enable ?? [],
      colour: spot.colour ?? null,
      landcover: spot.landcover === true,
      start: spot.start,
      end: spot.end,
      layout: spot.layout === true,
    };
  });
}
