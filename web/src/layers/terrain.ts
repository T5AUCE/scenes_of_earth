import { removeLayerAndSource } from "../map";
import { CONTOUR_COLORS, contourColor, DEFAULT_CONTOUR_COLOR } from "../render/palettes";
import type {
  LayerContext,
  LayerControl,
  LayerMenu,
  LayerView,
  TerrainStats,
} from "../types";
import { ContourOverlay, sharedDemSource, terrainTileBounds } from "./contour-overlay";
import { RELIEF_STRENGTH, reliefPaint } from "./relief";

// Shade over a colour fill is eased so the colour stays readable.
const COLOUR_UNDER_FACTOR = 0.75;

/** Terrain shading from Mapterhorn tiles and contour lines for one terrain layer. */
export function createTerrainView(context: LayerContext): LayerView {
  const { map, layer, slots, report } = context;
  const { tiles, stats } = layer;
  if (!tiles || !stats) throw new Error("Terrain needs tile metadata and summary statistics");

  const dem = sharedDemSource(tiles);
  const id = `${layer.id}-relief`;
  // Separate translucent hillshades would darken loaded areas while other tiles are pending.
  map.addSource(id, {
    type: "raster-dem",
    tiles: [dem.sharedDemProtocolUrl],
    encoding: tiles.encoding,
    tileSize: tiles.tile_size,
    maxzoom: tiles.maxzoom,
    attribution: tiles.source.attribution,
    ...terrainTileBounds(layer.grid.bbox),
  });
  map.addLayer(
    { id, type: "hillshade", source: id, paint: reliefPaint(RELIEF_STRENGTH.initial) },
    slots.shade,
  );

  const reportTilesUnavailable = (event: object) => {
    const sourceId = (event as { sourceId?: string }).sourceId;
    if (sourceId !== id && sourceId !== `${layer.id}-contours`) return;

    map.off("error", reportTilesUnavailable);
    report(new Error("Terrain shading or contour tiles could not be loaded"));
  };
  map.on("error", reportTilesUnavailable);

  let strengthValue = RELIEF_STRENGTH.initial;
  let isUnderColour = false;
  const applyStrength = () => {
    const effective = strengthValue * (isUnderColour ? COLOUR_UNDER_FACTOR : 1);
    const exaggeration = reliefPaint(effective)["hillshade-exaggeration"];
    map.setPaintProperty(id, "hillshade-exaggeration", exaggeration);
  };

  const strength: LayerControl = {
    label: "Relief strength",
    hint: "Change intensity using slider",
    min: RELIEF_STRENGTH.min,
    max: RELIEF_STRENGTH.max,
    step: RELIEF_STRENGTH.step,
    value: RELIEF_STRENGTH.initial,
    set: (value) => {
      strengthValue = value;
      applyStrength();
    },
  };

  const contourOverlay = new ContourOverlay(context, dem, tiles, stats as TerrainStats);

  let palette = context.display?.palette ?? DEFAULT_CONTOUR_COLOR;
  const menu: LayerMenu = {
    title: layer.title,
    heading: "Contour colour",
    blocks: true,
    palettes: CONTOUR_COLORS.map(({ name, label, color }) => ({ name, label, colors: [color] })),
    defaultPalette: DEFAULT_CONTOUR_COLOR,
    custom: false,
    get palette() {
      return palette;
    },
    setPalette(name) {
      palette = name;
      contourOverlay.setColor(contourColor(name)!);
    },
  };

  return {
    parts: [
      { id: layer.id, label: "Relief", layerIds: [id], controls: [strength] },
      contourOverlay.part,
    ],
    options: [],
    menu,
    time: null,
    setTime: () => {},
    setColourUnder: (isUnder) => {
      isUnderColour = isUnder;
      applyStrength();
    },
    legend: () => null,
    destroy: () => {
      map.off("error", reportTilesUnavailable);
      contourOverlay.destroy();
      removeLayerAndSource(map, id);
    },
  };
}
