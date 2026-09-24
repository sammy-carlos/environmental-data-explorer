import { state } from "../state.js";
import { writeUrlState } from "../url-state.js";

export let map = null;
export let draw = null;
export let mapReady = null;

// Esri serves a "Map data not yet available" tile beyond these zoom levels over the
// study area, so each basemap stops requesting tiles there and MapLibre overzooms.
const ESRI = "https://server.arcgisonline.com/ArcGIS/rest/services";
const SOURCES = {
  light: { tiles: `${ESRI}/Canvas/World_Light_Gray_Base/MapServer/tile/{z}/{y}/{x}`, maxzoom: 16 },
  "light-labels": { tiles: `${ESRI}/Canvas/World_Light_Gray_Reference/MapServer/tile/{z}/{y}/{x}`, maxzoom: 16 },
  topo: { tiles: `${ESRI}/World_Topo_Map/MapServer/tile/{z}/{y}/{x}`, maxzoom: 16 },
  satellite: { tiles: `${ESRI}/World_Imagery/MapServer/tile/{z}/{y}/{x}`, maxzoom: 17 },
  "satellite-labels": { tiles: `${ESRI}/Reference/World_Boundaries_and_Places/MapServer/tile/{z}/{y}/{x}`, maxzoom: 16 },
};
const BASEMAPS = { light: ["light", "light-labels"], topo: ["topo"], satellite: ["satellite", "satellite-labels"] };

// Drawn areas use the geojson.io palette: indigo features, blue when selected.
const DRAW_COLOR = ["case", ["==", ["get", "active"], "true"], "#3195ff", "#312E81"];
const DRAW_STYLES = [
  { id: "gl-draw-polygon-fill", type: "fill", filter: ["all", ["==", "$type", "Polygon"]], paint: { "fill-color": DRAW_COLOR, "fill-opacity": 0.3 } },
  { id: "gl-draw-lines", type: "line", filter: ["any", ["==", "$type", "LineString"], ["==", "$type", "Polygon"]], layout: { "line-cap": "round", "line-join": "round" }, paint: { "line-color": DRAW_COLOR, "line-width": 2 } },
  { id: "gl-draw-vertex", type: "circle", filter: ["all", ["==", "$type", "Point"], ["==", "meta", "vertex"], ["!=", "mode", "simple_select"]], paint: { "circle-radius": 4.5, "circle-color": "#ffffff", "circle-stroke-width": 2, "circle-stroke-color": "#3195ff" } },
  { id: "gl-draw-midpoint", type: "circle", filter: ["all", ["==", "meta", "midpoint"]], paint: { "circle-radius": 3, "circle-color": "#3195ff" } },
];

export function createMap() {
  const sources = Object.fromEntries(Object.entries(SOURCES).map(([id, source]) => [id, { type: "raster", tiles: [source.tiles], tileSize: 256, maxzoom: source.maxzoom }]));
  map = new maplibregl.Map({
    container: "map",
    center: state.dataset.center,
    zoom: 9.5,
    maxZoom: 19,
    attributionControl: false,
    doubleClickZoom: false,
    style: {
      version: 8,
      glyphs: "https://demotiles.maplibre.org/font/{fontstack}/{range}.pbf",
      sources,
      layers: Object.keys(SOURCES).map((id) => ({ id, type: "raster", source: id, layout: { visibility: "none" } })),
    },
  });
  mapReady = new Promise((resolve) => map.once("load", resolve));
  map.addControl(new maplibregl.NavigationControl({ showCompass: true }), "bottom-right");

  for (const [name, value] of Object.entries({ CANVAS: "maplibregl-canvas", CONTROL_BASE: "maplibregl-ctrl", CONTROL_PREFIX: "maplibregl-ctrl-", CONTROL_GROUP: "maplibregl-ctrl-group" })) {
    MapboxDraw.constants.classes[name] = value;
  }
  draw = new MapboxDraw({ displayControlsDefault: false, styles: DRAW_STYLES });
  map.addControl(draw, "top-left");

  map.once("style.load", () => setBasemap(state.map.basemap));
  document.querySelectorAll("[data-basemap]").forEach((button) => {
    button.addEventListener("click", () => setBasemap(button.dataset.basemap));
  });
}

export function setBasemap(name) {
  const visible = new Set(BASEMAPS[name] || BASEMAPS.light);
  for (const id of Object.keys(SOURCES)) map.setLayoutProperty(id, "visibility", visible.has(id) ? "visible" : "none");
  state.map.basemap = BASEMAPS[name] ? name : "light";
  document.querySelectorAll("[data-basemap]").forEach((button) => button.classList.toggle("active", button.dataset.basemap === state.map.basemap));
  document.querySelector(".map-shell").dataset.basemap = state.map.basemap;
  if (state.ready) writeUrlState();
}

export function mapPadding() {
  const width = map.getContainer().clientWidth;
  const cards = document.querySelector(".map-cards");
  const left = width > 640 && cards?.offsetWidth ? cards.offsetWidth + 40 : 36;
  return { top: 64, right: 56, bottom: 44, left };
}

export function fitTo(coordinates, options = {}) {
  if (!coordinates.length) return;
  const bounds = coordinates.reduce((box, point) => box.extend(point), new maplibregl.LngLatBounds(coordinates[0], coordinates[0]));
  map.fitBounds(bounds, { padding: mapPadding(), maxZoom: 13, ...options });
}
