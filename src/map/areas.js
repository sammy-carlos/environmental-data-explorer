import { state } from "../state.js";
import { plural } from "../lib/format.js";
import { boundingBox, pointInPolygon, polygonsOf, toLngLat, toLngLatDeep } from "../lib/geo.js";
import { quote } from "../lib/sql.js";
import { query } from "../data/database.js";
import { LOCATED } from "../data/selection.js";
import { refreshData } from "../panel/explorer.js";
import { draw, fitTo, map } from "./map.js";

const $ = (id) => document.getElementById(id);
let stations = null;
let drawState = "idle";
let finishedAt = 0;
let cancelling = false;
let startIds = new Set();

export function isDrawing() {
  // The double click that closes a polygon also reaches the point layers.
  return drawState === "drawing" || performance.now() - finishedAt < 500;
}

async function stationPoints() {
  if (!stations) {
    const rows = await query(`SELECT DISTINCT station_id, easting_m, northing_m FROM observations WHERE ${LOCATED}`);
    stations = rows.map((row) => ({ id: String(row.station_id), point: toLngLat(row.easting_m, row.northing_m) }));
  }
  return stations;
}

function setDrawState(next, message) {
  const button = $("drawArea");
  const areas = draw.getAll().features.length;
  button.dataset.state = next;
  button.setAttribute("aria-pressed", String(next === "drawing"));
  button.querySelector("span").textContent = { idle: "Draw area", drawing: "Cancel", active: "Add area" }[next];
  button.title = { idle: "Draw an area on the map to filter results", drawing: "Cancel drawing (Esc)", active: "Draw another area" }[next];
  $("removeArea").disabled = next === "idle" || (next === "drawing" && !state.area.active);
  $("spatialStatus").textContent = message ?? {
    idle: "All locations · drop a GeoJSON on the map",
    drawing: "Click to add vertices · double-click to close",
    active: `${plural(areas, "area")} applied`,
  }[next];
  if (drawState === "drawing" && next !== "drawing") finishedAt = performance.now();
  drawState = next;
  map.getCanvasContainer().classList.toggle("is-drawing", next === "drawing");
  if (next === "drawing") map.getCanvas().style.cursor = "";
}

async function saveSelection(ids) {
  const values = ids.length ? `VALUES ${ids.map((id) => `(${quote(String(id))})`).join(",")}` : "SELECT NULL::VARCHAR WHERE false";
  await state.db.query(`CREATE OR REPLACE TEMP TABLE spatial_selection AS SELECT * FROM (${values}) AS selection(station_id)`);
  state.area.active = true;
  state.area.stations = ids.length;
  state.table.page = 1;
}

export async function applyAreas({ refresh = true } = {}) {
  const polygons = draw.getAll().features.flatMap(polygonsOf).filter((polygon) => polygon[0]?.length >= 4);
  if (!polygons.length) {
    await clearAreas({ refresh });
    return;
  }
  setDrawState("active", "Applying area…");
  const boxes = polygons.map((polygon) => boundingBox(polygon[0]));
  const selected = (await stationPoints()).filter(({ point: [x, y] }) => polygons.some((polygon, index) => {
    const [west, south, east, north] = boxes[index];
    return x >= west && x <= east && y >= south && y <= north && pointInPolygon([x, y], polygon);
  }));
  await saveSelection(selected.map((station) => station.id));
  setDrawState("active", `${plural(draw.getAll().features.length, "area")} · ${plural(selected.length, "station")}`);
  if (refresh) await refreshData({ updateMap: true });
}

// Filters to stations the assistant picked, without drawing a polygon.
export async function selectStations(ids, { refresh = true } = {}) {
  stopDrawing();
  draw.deleteAll();
  await saveSelection(ids);
  setDrawState("active", `${plural(ids.length, "station")} picked by the assistant`);
  if (refresh) await refreshData({ updateMap: true });
}

export async function clearAreas({ refresh = true } = {}) {
  draw.deleteAll();
  draw.changeMode("simple_select");
  map.getSource("marked-stations")?.setData({ type: "FeatureCollection", features: [] });
  state.area.active = false;
  state.area.byAssistant = false;
  state.table.page = 1;
  setDrawState("idle");
  if (refresh) await refreshData({ updateMap: true });
}

function startDrawing() {
  startIds = new Set(draw.getAll().features.map((feature) => feature.id));
  draw.changeMode("draw_polygon");
  setDrawState("drawing");
}

export function stopDrawing() {
  if (drawState !== "drawing") return;
  cancelling = true;
  draw.changeMode("simple_select");
  const unfinished = draw.getAll().features.map((feature) => feature.id).filter((id) => !startIds.has(id));
  if (unfinished.length) draw.delete(unfinished);
  cancelling = false;
  setDrawState(state.area.active ? "active" : "idle");
}

// Accepts Polygon, MultiPolygon, Feature and FeatureCollection. Coordinates outside
// the longitude/latitude range are read in the dataset's projected CRS.
async function loadGeoJson(file) {
  if (!state.ready) return;
  const status = $("spatialStatus");
  try {
    const json = JSON.parse(await file.text());
    const items = json.type === "FeatureCollection" ? json.features : json.type === "Feature" ? [json] : [{ type: "Feature", geometry: json }];
    let features = items.flatMap((item) => polygonsOf(item).map((polygon) => ({ type: "Feature", properties: {}, geometry: { type: "Polygon", coordinates: polygon } })));
    if (!features.length) {
      status.textContent = `${file.name}: no polygons found`;
      return;
    }
    const projected = features.some((feature) => feature.geometry.coordinates.flat(1).some(([x, y]) => Math.abs(x) > 180 || Math.abs(y) > 90));
    if (projected) features = features.map((feature) => ({ ...feature, geometry: { type: "Polygon", coordinates: toLngLatDeep(feature.geometry.coordinates) } }));
    stopDrawing();
    draw.add({ type: "FeatureCollection", features });
    fitTo(features.flatMap((feature) => feature.geometry.coordinates[0]), { maxZoom: 14, duration: 600 });
    await applyAreas();
    if (projected) status.textContent += ` · reprojected from ${state.dataset.sourceCrs}`;
  } catch (error) {
    console.error(error);
    status.textContent = `${file.name}: invalid GeoJSON`;
  }
}

export function bindAreas() {
  map.on("draw.create", () => { if (!cancelling) applyAreas(); });
  map.on("draw.update", () => applyAreas());
  map.on("draw.delete", () => applyAreas());
  map.on("draw.modechange", (event) => {
    if (drawState === "drawing" && event.mode !== "draw_polygon" && !cancelling) setDrawState(state.area.active ? "active" : "idle");
  });
  document.addEventListener("keydown", (event) => { if (event.key === "Escape") stopDrawing(); });

  $("drawArea").addEventListener("click", () => (drawState === "drawing" ? stopDrawing() : startDrawing()));
  $("removeArea").addEventListener("click", () => clearAreas());
  $("loadArea").addEventListener("click", () => $("areaFile").click());
  $("areaFile").addEventListener("change", async (event) => {
    for (const file of event.target.files) await loadGeoJson(file);
    event.target.value = "";
  });

  const shell = document.querySelector(".map-shell");
  const carriesFiles = (event) => [...(event.dataTransfer?.types || [])].includes("Files");
  let depth = 0;
  shell.addEventListener("dragenter", (event) => {
    if (!carriesFiles(event)) return;
    event.preventDefault();
    depth += 1;
    shell.classList.add("drop-active");
  });
  shell.addEventListener("dragover", (event) => {
    if (!carriesFiles(event)) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = "copy";
  });
  shell.addEventListener("dragleave", () => {
    depth = Math.max(0, depth - 1);
    if (!depth) shell.classList.remove("drop-active");
  });
  shell.addEventListener("drop", async (event) => {
    if (!carriesFiles(event)) return;
    event.preventDefault();
    depth = 0;
    shell.classList.remove("drop-active");
    for (const file of event.dataTransfer.files) await loadGeoJson(file);
  });
}
