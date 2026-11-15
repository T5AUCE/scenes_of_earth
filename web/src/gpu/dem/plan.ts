/** Plan the DEM tiles and their blend weights for one map view. */
import { MAX_CONTOUR_ZOOM } from "../../contour-ladder";
import { mercatorY, tileInScene } from "../../render/tile-viewport";
import type { Bbox } from "../../types";

/** The pinned base moves one level coarser when the fit level needs more tiles than this. */
const PINNED_TILE_LIMIT = 48;

/** How many levels below the sharp level the pool keeps over the zoomed-out area. */
const COARSE_LEVELS = 4;

/** How far ahead of the map centre, in tiles, the ring is sorted towards the pan heading. */
const RING_LEAD_TILES = 2;

/**
 * Pan speed above which the planner wants look-ahead tiles, in CSS px per second. The reviewer
 * probes panned one screen width in 500 ms fast and 2000 ms slow, so on the 1024-1280 px wide
 * desktop viewports slow stays below about 640 px/s while fast passes 2000 px/s.
 */
export const LOOKAHEAD_PAN_SPEED_PX_PER_SEC = 1000;

/** Rows or columns ahead of the view the look-ahead covers while panning fast. */
const LOOKAHEAD_DEPTH_TILES = 2;

/** Rows or columns ahead of the view the look-ahead covers at twice the speed threshold. */
const LOOKAHEAD_FAST_DEPTH_TILES = 3;

/** Shares this close to 0 or 1 count as exactly that, so rounding noise starts no blend. */
const SHARE_SNAP = 1e-9;

/** Default width of the zoom blend around the half-zoom switch, in zoom levels. */
export const DEFAULT_BLEND_WINDOW = 0.1;

/** A wider window would make the share jump at every whole zoom. */
const MAX_BLEND_WINDOW = 0.5;

/** A tile to have in the pool, where `x` is wrapped and the array order is the priority. */
export interface WantedTile {
  z: number;
  x: number;
  y: number;
  tier: "pinned" | "view" | "partner" | "parent" | "lookahead" | "ring" | "coarse";
}

/** A slippy-map tile address. */
export interface TileId {
  z: number;
  x: number;
  y: number;
}

/** The visible area in Mercator world units, where the world is 1 wide and `x` is not wrapped. */
export interface ViewBounds {
  west: number;
  east: number;
  north: number;
  south: number;
}

/** The tiles kept for the whole scene and the level they sit at. */
export interface PinnedBase {
  zoom: number;
  tiles: WantedTile[];
}

/** Smoothed pan direction in world units with its speed, which sizes the look-ahead. */
export interface PanHeading {
  x: number;
  y: number;
  /** CSS px per second; missing means still, so nothing looks ahead. */
  speedPxPerSec?: number;
}

/** What the planner needs to know about the map and the scene. */
export interface DemPlanRequest {
  zoom: number;
  view: ViewBounds;
  bbox: Bbox;
  fitLevel: number;
  maxZoom: number;
  /** Width of the blend around the half-zoom switch; 0 is a hard switch. */
  blendWindow?: number;
  /** The pinned base from `pinnedBase`, which the caller can compute once per scene and refit. */
  base?: PinnedBase;
  /** Smoothed pan direction in world units; a zero vector means no heading. */
  heading?: PanHeading;
}

/** The levels in play at one zoom and how the finer one is mixed over the lower one. */
export interface DemLevels {
  sharp: number;
  lower: number;
  fine: number;
  /** Weight of the fine level, from 0 to 1; the lower level takes the rest. */
  fineShare: number;
}

/** A quad to draw, placed at an unwrapped x, with the textures it mixes. */
export interface PlacedTile {
  z: number;
  /** Unwrapped, so the quad lands on the world copy the view shows. */
  x: number;
  y: number;
  /** The key of the texture, which is wrapped. */
  wrappedX: number;
  selfWeight: number;
  /** Weight of this tile's parent texture, which is the lower level while blending. */
  parentWeight: number;
  /** Wrapped ancestors from the parent down to the pinned level, nearest first. */
  ancestors: TileId[];
}

/** Everything the layer and the pool need for one frame. */
export interface DemPlan {
  levels: DemLevels;
  /** The level the pinned base sits at, which ends every ancestor chain. */
  baseZoom: number;
  wanted: WantedTile[];
  quads: PlacedTile[];
}

interface TileRect {
  x0: number;
  x1: number;
  y0: number;
  y1: number;
}

/** The tiles to keep loaded and the quads to draw for one frame, most urgent first. */
export function planDemTiles(request: DemPlanRequest): DemPlan {
  const { zoom, view, bbox, fitLevel, maxZoom, heading } = request;
  const blendWindow = request.blendWindow ?? DEFAULT_BLEND_WINDOW;
  const levels = demLevels(zoom, fitLevel, maxZoom, blendWindow);
  const base = request.base ?? pinnedBase(bbox, fitLevel);
  const centre = { x: (view.west + view.east) / 2, y: (view.north + view.south) / 2 };

  const viewTilesAt = (level: number) => tilesOf(level, rectOf(level, view), bbox, centre);
  const viewTiles = viewTilesAt(levels.sharp);
  const partnerLevel = blendPartnerLevel(levels);
  const partnerTiles = partnerLevel === null ? [] : viewTilesAt(partnerLevel);
  const parentTiles = levels.sharp > fitLevel ? viewTilesAt(levels.sharp - 1) : [];
  const lookaheadTiles = lookaheadTilesOf(levels.sharp, view, bbox, centre, heading);
  const ringTiles = ringTilesOf(levels.sharp, view, bbox, centre, heading);
  const coarseTiles = coarseTilesOf(levels.sharp, fitLevel, view, bbox, centre);

  const wanted = withoutRepeats([
    ...base.tiles,
    ...viewTiles.map((tile) => wantedOf(tile, "view")),
    ...partnerTiles.map((tile) => wantedOf(tile, "partner")),
    ...parentTiles.map((tile) => wantedOf(tile, "parent")),
    ...lookaheadTiles.map((tile) => wantedOf(tile, "lookahead")),
    ...ringTiles.map((tile) => wantedOf(tile, "ring")),
    ...coarseTiles.map((tile) => wantedOf(tile, "coarse")),
  ]);

  const isBlending = partnerLevel !== null;
  const drawLevel = isBlending ? levels.fine : levels.sharp;
  const drawTiles = drawLevel === levels.sharp ? viewTiles : partnerTiles;
  const selfWeight = isBlending ? levels.fineShare : 1;
  const quads = drawTiles.map((tile) => placedOf(tile, selfWeight, base.zoom));

  return { levels, baseZoom: base.zoom, wanted, quads };
}

/**
 * The sharp level, the two levels around the zoom and the share of the finer one. The sharp
 * level is the rounded zoom that MapLibre picks for raster tiles. The share climbs from 0 to 1
 * across the window around the half-zoom switch, and a zero window switches at once with ties
 * going to the finer level.
 */
export function demLevels(
  zoom: number,
  fitLevel: number,
  maxZoom: number,
  blendWindow: number,
): DemLevels {
  const top = Math.min(maxZoom, MAX_CONTOUR_ZOOM);
  const clampLevel = (level: number) => Math.min(Math.max(level, fitLevel), top);
  const whole = Math.floor(zoom);
  const lower = clampLevel(whole);
  const fine = clampLevel(whole + 1);
  const sharp = clampLevel(Math.round(zoom));

  if (fine === lower) return { sharp, lower, fine, fineShare: 1 };

  const fraction = zoom - whole;
  const window = Math.min(blendWindow, MAX_BLEND_WINDOW);
  const share = window > 0 ? (fraction - 0.5) / (2 * window) + 0.5 : fraction >= 0.5 ? 1 : 0;

  return { sharp, lower, fine, fineShare: snapShare(Math.min(Math.max(share, 0), 1)) };
}

function snapShare(share: number): number {
  if (share < SHARE_SNAP) return 0;
  if (share > 1 - SHARE_SNAP) return 1;

  return share;
}

function blendPartnerLevel(levels: DemLevels): number | null {
  if (levels.fineShare <= 0 || levels.fineShare >= 1) return null;
  return levels.sharp === levels.fine ? levels.lower : levels.fine;
}

/**
 * The tiles to keep for the whole scene, at the fit level or one coarser when that needs more
 * than the limit, so something always covers the view.
 */
export function pinnedBase(bbox: Bbox, fitLevel: number): PinnedBase {
  const sceneBounds = sceneBoundsOf(bbox);
  const centre = {
    x: (sceneBounds.west + sceneBounds.east) / 2,
    y: (sceneBounds.north + sceneBounds.south) / 2,
  };
  // A scene as wide as the world lists its edge tile twice, so the repeats go before counting.
  const tilesAt = (zoom: number) =>
    withoutRepeats(
      tilesOf(zoom, rectOf(zoom, sceneBounds), bbox, centre).map((tile) =>
        wantedOf(tile, "pinned"),
      ),
    );
  const fitTiles = tilesAt(fitLevel);
  if (fitTiles.length <= PINNED_TILE_LIMIT || fitLevel === 0) {
    return { zoom: fitLevel, tiles: fitTiles };
  }

  return { zoom: fitLevel - 1, tiles: tilesAt(fitLevel - 1) };
}

function ringTilesOf(
  zoom: number,
  view: ViewBounds,
  bbox: Bbox,
  centre: { x: number; y: number },
  heading: PanHeading | undefined,
): TileId[] {
  const count = 2 ** zoom;
  const length = Math.hypot(heading?.x ?? 0, heading?.y ?? 0);
  const lead = length > 0 ? RING_LEAD_TILES / length / count : 0;
  const ahead = { x: centre.x + (heading?.x ?? 0) * lead, y: centre.y + (heading?.y ?? 0) * lead };

  const inner = rectOf(zoom, view);
  const outer: TileRect = {
    x0: inner.x0 - 1,
    x1: inner.x1 + 1,
    y0: Math.max(inner.y0 - 1, 0),
    y1: Math.min(inner.y1 + 1, count - 1),
  };

  return tilesOf(zoom, outer, bbox, ahead, inner);
}

/**
 * Extra view-level rows or columns ahead of the pan heading, nearest first. The band starts at
 * the view edge so its first row overlaps the ring and only reprioritises it, while the rows
 * past it are new. Nothing is wanted while still or panning slowly, and twice the speed
 * threshold reaches one row further.
 */
function lookaheadTilesOf(
  zoom: number,
  view: ViewBounds,
  bbox: Bbox,
  centre: { x: number; y: number },
  heading: PanHeading | undefined,
): TileId[] {
  if (heading === undefined) return [];

  const depth = lookaheadDepthTiles(heading.speedPxPerSec ?? 0);
  if (depth === 0 || (heading.x === 0 && heading.y === 0)) return [];

  const inner = rectOf(zoom, view);
  const outer = leadingRect(inner, heading, depth, zoom);

  return tilesOf(zoom, outer, bbox, centre, inner);
}

/** How many rows or columns ahead the look-ahead reaches at one pan speed, or 0 below it. */
function lookaheadDepthTiles(speedPxPerSec: number): number {
  if (speedPxPerSec >= 2 * LOOKAHEAD_PAN_SPEED_PX_PER_SEC) return LOOKAHEAD_FAST_DEPTH_TILES;
  if (speedPxPerSec >= LOOKAHEAD_PAN_SPEED_PX_PER_SEC) return LOOKAHEAD_DEPTH_TILES;

  return 0;
}

/** The view rect grown past its leading edge along the dominant pan axis. */
function leadingRect(rect: TileRect, heading: PanHeading, depth: number, zoom: number): TileRect {
  if (Math.abs(heading.x) >= Math.abs(heading.y)) {
    return heading.x > 0 ? { ...rect, x1: rect.x1 + depth } : { ...rect, x0: rect.x0 - depth };
  }

  const count = 2 ** zoom;

  return heading.y > 0
    ? { ...rect, y1: Math.min(rect.y1 + depth, count - 1) }
    : { ...rect, y0: Math.max(rect.y0 - depth, 0) };
}

/**
 * The area each zoom-out level would show, so a zoom-out finds it already uploaded. Each depth
 * scales the view by 2x around the centre, which tilesOf clips to the scene.
 */
function coarseTilesOf(
  sharp: number,
  fitLevel: number,
  view: ViewBounds,
  bbox: Bbox,
  centre: { x: number; y: number },
): TileId[] {
  const tiles: TileId[] = [];

  for (let depth = 1; depth <= COARSE_LEVELS; depth++) {
    const level = sharp - depth;
    if (level < fitLevel) break;

    tiles.push(...tilesOf(level, rectOf(level, zoomedOutView(view, centre, depth)), bbox, centre));
  }

  return tiles;
}

/** The view scaled by 2^depth around the centre, which is what a zoom-out shows. */
function zoomedOutView(
  view: ViewBounds,
  centre: { x: number; y: number },
  depth: number,
): ViewBounds {
  const scale = 2 ** depth;

  return {
    west: centre.x - (centre.x - view.west) * scale,
    east: centre.x + (view.east - centre.x) * scale,
    north: centre.y - (centre.y - view.north) * scale,
    south: centre.y + (view.south - centre.y) * scale,
  };
}

function rectOf(zoom: number, bounds: ViewBounds): TileRect {
  const count = 2 ** zoom;
  const clampRow = (row: number) => Math.min(Math.max(row, 0), count - 1);

  return {
    x0: Math.floor(bounds.west * count),
    x1: Math.floor(bounds.east * count),
    y0: clampRow(Math.floor(bounds.north * count)),
    y1: clampRow(Math.floor(bounds.south * count)),
  };
}

function sceneBoundsOf(bbox: Bbox): ViewBounds {
  return {
    west: (bbox[0] + 180) / 360,
    east: (bbox[2] + 180) / 360,
    north: mercatorY(bbox[3]),
    south: mercatorY(bbox[1]),
  };
}

/**
 * The tiles of a rectangle that touch the scene, without those of `hole`, nearest the focus
 * (in world units) first. Their x stays unwrapped.
 */
function tilesOf(
  zoom: number,
  rect: TileRect,
  bbox: Bbox,
  focus: { x: number; y: number },
  hole?: TileRect,
): TileId[] {
  const tiles: TileId[] = [];
  const rows = sceneRows(zoom, rect, bbox);

  for (const x of sceneColumns(zoom, rect, bbox)) {
    for (let y = rows.y0; y <= rows.y1; y += 1) {
      const isHole =
        hole !== undefined && x >= hole.x0 && x <= hole.x1 && y >= hole.y0 && y <= hole.y1;
      if (!isHole && tileInScene({ z: zoom, x: wrapX(x, zoom), y }, bbox)) {
        tiles.push({ z: zoom, x, y });
      }
    }
  }

  const count = 2 ** zoom;
  const distance = (tile: TileId) =>
    (tile.x + 0.5 - focus.x * count) ** 2 + (tile.y + 0.5 - focus.y * count) ** 2;

  return tiles.sort((left, right) => distance(left) - distance(right));
}

/** The unwrapped columns of the rectangle that fall in a world copy of the scene. */
function sceneColumns(zoom: number, rect: TileRect, bbox: Bbox): number[] {
  const count = 2 ** zoom;
  const scene = sceneBoundsOf(bbox);
  const columns = new Set<number>();
  const firstCopy = Math.floor(rect.x0 / count - scene.east);
  const lastCopy = Math.ceil((rect.x1 + 1) / count - scene.west);

  for (let copy = firstCopy; copy <= lastCopy; copy += 1) {
    const first = Math.max(rect.x0, Math.floor((scene.west + copy) * count));
    const last = Math.min(rect.x1, Math.floor((scene.east + copy) * count));
    for (let x = first; x <= last; x += 1) columns.add(x);
  }

  return [...columns];
}

function sceneRows(zoom: number, rect: TileRect, bbox: Bbox): { y0: number; y1: number } {
  const scene = rectOf(zoom, sceneBoundsOf(bbox));
  return { y0: Math.max(rect.y0, scene.y0), y1: Math.min(rect.y1, scene.y1) };
}

function wantedOf(tile: TileId, tier: WantedTile["tier"]): WantedTile {
  return { z: tile.z, x: wrapX(tile.x, tile.z), y: tile.y, tier };
}

function withoutRepeats(tiles: WantedTile[]): WantedTile[] {
  const seen = new Set<string>();

  return tiles.filter((tile) => {
    const key = `${tile.z}/${tile.x}/${tile.y}`;
    if (seen.has(key)) return false;

    seen.add(key);

    return true;
  });
}

function placedOf(tile: TileId, selfWeight: number, baseZoom: number): PlacedTile {
  const wrappedX = wrapX(tile.x, tile.z);
  const ancestors: TileId[] = [];

  for (let z = tile.z - 1; z >= baseZoom; z -= 1) {
    const up = tile.z - z;
    ancestors.push({ z, x: wrappedX >> up, y: tile.y >> up });
  }

  return {
    z: tile.z,
    x: tile.x,
    y: tile.y,
    wrappedX,
    selfWeight,
    parentWeight: 1 - selfWeight,
    ancestors,
  };
}

function wrapX(x: number, zoom: number): number {
  const count = 2 ** zoom;
  return ((x % count) + count) % count;
}
