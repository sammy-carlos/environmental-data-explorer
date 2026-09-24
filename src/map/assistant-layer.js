import { state } from "../state.js";
import { escapeHtml, formatNumber, plural } from "../lib/format.js";
import { areaAround, toLngLat } from "../lib/geo.js";
import { quoteList } from "../lib/sql.js";
import { query } from "../data/database.js";
import { LOCATED } from "../data/selection.js";
import { applyFilters, refreshData } from "../panel/explorer.js";
import { draw, fitTo, map } from "./map.js";
import { hideDataLayers, setMapMode } from "./layers.js";
import { applyAreas, clearAreas, selectStations, stopDrawing } from "./areas.js";
import { PALETTE, POINT_SIZE, rampExpression, zoomRadius } from "./style.js";
import { clearCatchment } from "./catchment.js";

// The Assistant tab starts with an empty map and shows each answer in one of two ways:
// - explorer: one element through the explorer's own layers, with its colours, P99 pulse,
//   legend and popups; the assistant sets the element and selects stations.
// - thematic: any value per station the answer computed (how many elements exceed their
//   P95, a ratio, an index), coloured on a ramp with a legend that says what it means.
// The bar at the top says what the map shows, including any area the assistant outlined.
const EMPTY = { type: "FeatureCollection", features: [] };
const GROUP_KM = 2;
const LABELS = 10;
const $ = (id) => document.getElementById(id);
let mode = null;

export function addAssistantLayers() {
  map.addSource("thematic", { type: "geojson", data: EMPTY });
  map.addSource("flow-arrows", { type: "geojson", data: EMPTY });
  map.addLayer({ id: "flow-lines", type: "line", source: "flow-arrows", paint: { "line-color": "#312E81", "line-width": 2, "line-opacity": 0.8 } });
  map.addLayer({
    id: "flow-heads", type: "symbol", source: "flow-arrows",
    layout: { "symbol-placement": "line", "symbol-spacing": 36, "text-field": ">", "text-size": 13, "text-keep-upright": false, "text-allow-overlap": true },
    paint: { "text-color": "#312E81" },
  });
  map.addSource("marked-stations", { type: "geojson", data: EMPTY });
  map.addLayer({
    id: "thematic-points", type: "circle", source: "thematic", layout: { visibility: "none" },
    paint: { "circle-radius": zoomRadius(POINT_SIZE, 1.5), "circle-color": PALETTE[2], "circle-stroke-width": 1, "circle-stroke-color": "#ffffff" },
  });
  map.addLayer({
    id: "marked-ring", type: "circle", source: "marked-stations",
    paint: { "circle-radius": 11, "circle-color": "rgba(49,46,129,.08)", "circle-stroke-width": 2, "circle-stroke-color": "#312E81" },
  });
  map.addLayer({
    id: "marked-label", type: "symbol", source: "marked-stations",
    layout: { "text-field": ["get", "label"], "text-size": 10.5, "text-offset": [0, -1.9], "text-anchor": "bottom" },
    paint: { "text-color": "#312E81", "text-halo-color": "#ffffff", "text-halo-width": 2 },
  });
  map.on("click", "thematic-points", (event) => {
    const { code, value } = event.features[0].properties;
    new maplibregl.Popup({ offset: 10, maxWidth: "280px" })
      .setLngLat(event.features[0].geometry.coordinates)
      .setHTML(`<article class="sample-popup"><header><div><small>Assistant map</small><h3>${escapeHtml(code)}</h3></div></header>
        <div class="popup-value"><strong>${escapeHtml(formatNumber(value))}</strong><span>${escapeHtml($("thematicTitle").textContent)}</span></div></article>`)
      .addTo(map);
  });
  map.on("mouseenter", "thematic-points", () => { map.getCanvas().style.cursor = "pointer"; });
  map.on("mouseleave", "thematic-points", () => { map.getCanvas().style.cursor = ""; });
  $("clearAgentMap").addEventListener("click", () => clearAssistantDrawings());
}

export function setAssistantView(on) {
  const shell = document.querySelector(".map-shell");
  const showing = on && state.map.agentShowing;
  shell.classList.toggle("agent-view", on);
  if (on) clearCatchment();
  shell.classList.toggle("agent-empty", on && !state.map.agentShowing);
  shell.classList.toggle("agent-thematic", showing && mode === "thematic");
  $("agentBar").hidden = !showing;
  $("thematicLegend").hidden = !(showing && mode === "thematic");
  if (!map?.getLayer("samples")) return;
  map.setLayoutProperty("thematic-points", "visibility", showing && mode === "thematic" ? "visible" : "none");
  if (on && !(showing && mode === "explorer")) hideDataLayers();
  else setMapMode(state.map.mode);
}

function show(nextMode, caption) {
  mode = nextMode;
  state.map.agentShowing = true;
  $("agentCaption").textContent = caption || "Assistant view";
  if (state.view === "assistant") setAssistantView(true);
}

// Shows the explorer's current selection in the Assistant tab.
export function showExplorerMap(caption) {
  show("explorer", caption);
}

export async function clearAssistantDrawings() {
  map.getSource("marked-stations").setData(EMPTY);
  map.getSource("flow-arrows").setData(EMPTY);
  map.getSource("thematic").setData(EMPTY);
  state.map.agentShowing = false;
  mode = null;
  if (state.area.byAssistant) await clearAreas();
  if (state.view === "assistant") setAssistantView(true);
}

async function stationPositions(codes) {
  const rows = await query(`
    SELECT station_code, any_value(easting_m) AS easting_m, any_value(northing_m) AS northing_m
    FROM observations WHERE station_code IN (${quoteList(codes)}) AND ${LOCATED}
    GROUP BY station_code
  `);
  return new Map(rows.map((row) => [row.station_code, toLngLat(row.easting_m, row.northing_m)]));
}

async function stationIds(codes) {
  const rows = await query(`SELECT DISTINCT CAST(station_id AS VARCHAR) AS id FROM observations WHERE station_code IN (${quoteList(codes)})`);
  return rows.map((row) => row.id);
}

function distanceKm([lon1, lat1], [lon2, lat2]) {
  const x = (lon2 - lon1) * Math.cos(((lat1 + lat2) / 2) * Math.PI / 180);
  return Math.hypot(x, lat2 - lat1) * 111.32;
}

// Chains stations closer than GROUP_KM and keeps the heaviest group, so the most
// affected area outlines one place instead of every station in the ranking.
function densestGroup(items) {
  const group = new Array(items.length).fill(-1);
  let best = null;
  items.forEach((_, start) => {
    if (group[start] !== -1) return;
    const members = [start];
    group[start] = start;
    for (let i = 0; i < members.length; i += 1) {
      items.forEach((other, index) => {
        if (group[index] === -1 && distanceKm(items[members[i]].point, other.point) <= GROUP_KM) {
          group[index] = start;
          members.push(index);
        }
      });
    }
    const weight = members.reduce((sum, index) => sum + items[index].weight, 0);
    if (!best || weight > best.weight) best = { weight, members };
  });
  return best.members.sort((a, b) => a - b).map((index) => items[index].code);
}

// The densest group of some stations, without drawing anything.
export async function densestStations(codes, weights) {
  const positions = await stationPositions(codes);
  const found = codes.filter((code) => positions.has(code));
  return found.length ? densestGroup(found.map((code) => ({ code, point: positions.get(code), weight: Number(weights?.get(code)) || 1 }))) : [];
}

async function outline(points) {
  const polygon = areaAround(points);
  stopDrawing();
  draw.deleteAll();
  draw.add(polygon);
  await applyAreas({ refresh: false });
  return polygon.geometry.coordinates[0];
}

function numberStations(codes, positions) {
  map.getSource("marked-stations").setData({
    type: "FeatureCollection",
    features: codes.slice(0, LABELS).map((code, index) => ({ type: "Feature", geometry: { type: "Point", coordinates: positions.get(code) }, properties: { label: `${index + 1}. ${code}` } })),
  });
}

// Shows stations through the explorer: sets the element, selects the stations (or an area
// around them) and numbers the first ones in the order given. area is null, "all" or "densest".
export async function showStations(codes, { parameter, area = null, weights = null, caption } = {}) {
  map.getSource("flow-arrows").setData(EMPTY);
  const positions = await stationPositions(codes);
  const found = codes.filter((code) => positions.has(code));
  if (!found.length) throw new Error("None of these stations has usable coordinates.");
  const shown = area === "densest"
    ? densestGroup(found.map((code) => ({ code, point: positions.get(code), weight: Number(weights?.get(code)) || 1 })))
    : found;
  let frame = shown.map((code) => positions.get(code));
  if (area) frame = await outline(frame);
  else await selectStations(await stationIds(shown), { refresh: false });
  state.area.byAssistant = true;
  if ((parameter && parameter !== state.filters.parameter) || state.mode === "sql") await applyFilters(parameter ? { parameter } : {});
  else await refreshData({ updateMap: true });

  numberStations(shown, positions);
  showExplorerMap(caption);
  fitTo(frame, { maxZoom: 14, duration: 700 });
  return { shown, missing: codes.length - found.length };
}

// Upstream to downstream: shows both stations of each pair through the explorer and draws
// an arrow between them in the direction of the flow.
export async function showFlow(pairs, parameter) {
  const codes = [...new Set(pairs.flatMap((pair) => [pair.upstream_station, pair.downstream_station]))];
  const positions = await stationPositions(codes);
  const lines = pairs.filter((pair) => positions.has(pair.upstream_station) && positions.has(pair.downstream_station));
  const result = await showStations(codes, { parameter, caption: "Arrows: from the upstream to the downstream station of each pair" });
  map.getSource("flow-arrows").setData({
    type: "FeatureCollection",
    features: lines.map((pair) => ({ type: "Feature", properties: {}, geometry: { type: "LineString", coordinates: [positions.get(pair.upstream_station), positions.get(pair.downstream_station)] } })),
  });
  return { ...result, arrows: lines.length };
}

// Colours stations by a value the answer computed. rows are { code, value } in the order
// to number them; outline "densest" also draws the area around the heaviest group.
export async function showThematic(rows, { title, caption, outline: area = null, weights = null } = {}) {
  map.getSource("flow-arrows").setData(EMPTY);
  const positions = await stationPositions(rows.map((row) => row.code));
  const found = rows.filter((row) => positions.has(row.code) && Number.isFinite(Number(row.value)));
  if (!found.length) throw new Error("None of these stations has usable coordinates and a numeric value.");
  map.getSource("thematic").setData({
    type: "FeatureCollection",
    features: found.map((row) => ({ type: "Feature", geometry: { type: "Point", coordinates: positions.get(row.code) }, properties: { code: row.code, value: Number(row.value) } })),
  });
  const values = found.map((row) => Number(row.value)).sort((a, b) => a - b);
  const stops = [0, 0.25, 0.5, 0.75, 1].map((fraction) => values[Math.round((values.length - 1) * fraction)]);
  map.setPaintProperty("thematic-points", "circle-color", values[0] < values.at(-1) ? rampExpression(stops) : PALETTE[2]);

  let frame = found.map((row) => positions.get(row.code));
  let group = [];
  if (area === "densest") {
    group = densestGroup(found.map((row) => ({ code: row.code, point: positions.get(row.code), weight: Number(weights?.get(row.code)) || 1 })));
    frame = await outline(group.map((code) => positions.get(code)));
    state.area.byAssistant = true;
    await refreshData({ updateMap: true });
  } else if (state.area.byAssistant) {
    await clearAreas();
  }
  numberStations(found.map((row) => row.code), positions);

  $("thematicTitle").textContent = title;
  $("thematicCaption").textContent = [caption, `${plural(found.length, "station")}; numbers mark the first ${Math.min(LABELS, found.length)}`].filter(Boolean).join(". ");
  $("thematicMin").textContent = formatNumber(values[0]);
  $("thematicMax").textContent = formatNumber(values.at(-1));
  show("thematic", area === "densest" ? `Outlined: the densest group of ${group.length} of these stations` : "Assistant map");
  fitTo(frame, { maxZoom: 14, duration: 700 });
  return { shown: found.map((row) => row.code), group, missing: rows.length - found.length };
}
