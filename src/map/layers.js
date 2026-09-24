import { isAllElements, currentParameter, state } from "../state.js";
import { toLngLat } from "../lib/geo.js";
import { query } from "../data/database.js";
import { selectionSource, selectionWhere } from "../data/selection.js";
import { loadScale } from "../data/statistics.js";
import { renderLegend } from "../panel/legend.js";
import { writeUrlState } from "../url-state.js";
import { fitTo, map } from "./map.js";
import { refreshCatchmentRings } from "./catchment.js";
import { EXCEEDANCE_SIZE, POINT_SIZE, colorExpression, radiusAt, yearExpression, zoomRadius } from "./style.js";

const EMPTY = { type: "FeatureCollection", features: [] };
const DATA_LAYERS = ["context-points", "sample-halo", "samples", "sample-density", "cluster-circles", "cluster-count", "cluster-points", "exceedance-pulse", "exceedance", "selected-halo", "selected-point", "selected-label"];
let exceedanceCount = 0;
let allFeatures = [];

function toFeature(row, properties) {
  const date = row.sampling_date ? new Date(row.sampling_date) : null;
  return {
    type: "Feature",
    geometry: { type: "Point", coordinates: toLngLat(row.easting_m, row.northing_m) },
    properties: {
      id: row.result_id,
      code: row.station_code || row.station_id,
      station_id: row.station_id,
      sample_id: row.sample_id,
      date: date ? date.toISOString().slice(0, 10) : "Unknown",
      year: date ? date.getUTCFullYear() : 0,
      campaign: row.campaign_name,
      easting: row.easting_m,
      northing: row.northing_m,
      source: row.source_name,
      ...properties,
    },
  };
}

export async function selectionFeatures() {
  if (isAllElements()) {
    const rows = await query(`
      SELECT sample_id, min(result_id) AS result_id, any_value(station_code) AS station_code, any_value(station_id) AS station_id,
             any_value(easting_m) AS easting_m, any_value(northing_m) AS northing_m, any_value(sampling_date) AS sampling_date,
             any_value(campaign_name) AS campaign_name, any_value(source_name) AS source_name, count(DISTINCT parameter_code) AS parameters
      FROM ${selectionSource()} ${selectionWhere({ mapOnly: "located", years: false })}
      GROUP BY sample_id
    `);
    return rows.map((row) => toFeature(row, { all: true, parameters: row.parameters }));
  }
  const rows = await query(`
    SELECT result_id, station_id, station_code, sample_id, easting_m, northing_m, sampling_date, campaign_name,
           parameter_code, parameter_name, reported_value, numeric_value, qualifier, reported_unit, quality_status, source_name
    FROM ${selectionSource()} ${selectionWhere({ mapOnly: true, years: false })}
  `);
  return rows.map((row) => toFeature(row, {
    value: row.numeric_value,
    reported_value: row.reported_value,
    unit: row.reported_unit,
    parameter: row.parameter_name,
    parameter_code: row.parameter_code,
    quality: row.quality_status,
  }));
}

// Points outside the drawn areas stay visible in grey, without colour or alerts.
async function contextFeatures() {
  if (!state.area.active) return [];
  const rows = await query(`
    SELECT DISTINCT easting_m, northing_m FROM ${selectionSource()}
    ${selectionWhere({ mapOnly: isAllElements() ? "located" : true, spatial: "outside" })}
  `);
  return rows.map((row) => ({ type: "Feature", properties: {}, geometry: { type: "Point", coordinates: toLngLat(row.easting_m, row.northing_m) } }));
}

// The map holds every year of the selection and filters the period itself, so dragging
// the period slider redraws the points on each frame without asking DuckDB.
function inPeriod(features) {
  if (state.mode === "sql") return features;
  const { from, to } = state.filters;
  return features.filter((feature) => feature.properties.year >= from && feature.properties.year <= to);
}

export function showPeriod() {
  if (!map.getSource("samples")) return;
  state.map.features = inPeriod(allFeatures);
  const data = { type: "FeatureCollection", features: state.map.features };
  map.getSource("samples").setData(data);
  map.getSource("sample-clusters").setData(data);
  applyStyling();
  // The open catchment rings the upstream stations that are on the map, which just changed.
  refreshCatchmentRings();
}

export function addDataLayers(features) {
  allFeatures = features;
  state.map.features = inPeriod(features);
  fitTo(state.map.features.map((feature) => feature.geometry.coordinates), { animate: false, maxZoom: 12 });
  state.map.baseZoom = map.getZoom();
  const data = { type: "FeatureCollection", features: state.map.features };

  map.addSource("samples", { type: "geojson", data });
  map.addSource("sample-clusters", { type: "geojson", data, cluster: true, clusterRadius: 44, clusterMaxZoom: 13 });
  map.addSource("context", { type: "geojson", data: EMPTY });
  map.addSource("selected-result", { type: "geojson", data: EMPTY });

  map.addLayer({
    id: "context-points", type: "circle", source: "context",
    paint: { "circle-radius": zoomRadius(POINT_SIZE, -0.4), "circle-color": "#9ca59f", "circle-opacity": 0.55, "circle-stroke-width": 0.5, "circle-stroke-color": "#ffffff", "circle-stroke-opacity": 0.7 },
  });
  map.addLayer({ id: "sample-halo", type: "circle", source: "samples", paint: { "circle-radius": zoomRadius(POINT_SIZE, 1.5), "circle-color": "#ffffff", "circle-opacity": 0 } });
  map.addLayer({
    id: "samples", type: "circle", source: "samples",
    paint: { "circle-radius": zoomRadius(POINT_SIZE), "circle-color": "#1c5b4f", "circle-stroke-width": 0.7, "circle-stroke-color": "#ffffff", "circle-opacity": 0.9 },
  });
  map.addLayer({
    id: "sample-density", type: "heatmap", source: "samples", layout: { visibility: "none" },
    paint: {
      "heatmap-weight": 1,
      "heatmap-intensity": ["interpolate", ["linear"], ["zoom"], 7, 0.7, 13, 2.2],
      "heatmap-radius": ["interpolate", ["linear"], ["zoom"], 7, 8, 13, 28],
      "heatmap-opacity": 0.82,
      "heatmap-color": ["interpolate", ["linear"], ["heatmap-density"], 0, "rgba(204,228,218,0)", 0.25, "#a9d2c3", 0.5, "#55a087", 0.75, "#236957", 1, "#ce8b2c"],
    },
  });
  map.addLayer({
    id: "cluster-circles", type: "circle", source: "sample-clusters", filter: ["has", "point_count"], layout: { visibility: "none" },
    paint: {
      "circle-color": ["step", ["get", "point_count"], "#79b29f", 25, "#236957", 100, "#ce8b2c"],
      "circle-radius": ["step", ["get", "point_count"], 15, 25, 21, 100, 28],
      "circle-stroke-width": 2,
      "circle-stroke-color": "#ffffff",
    },
  });
  map.addLayer({
    id: "cluster-count", type: "symbol", source: "sample-clusters", filter: ["has", "point_count"],
    layout: { visibility: "none", "text-field": ["get", "point_count_abbreviated"], "text-size": 11 },
    paint: { "text-color": "#ffffff" },
  });
  map.addLayer({
    id: "cluster-points", type: "circle", source: "sample-clusters", filter: ["!", ["has", "point_count"]], layout: { visibility: "none" },
    paint: { "circle-radius": zoomRadius(POINT_SIZE), "circle-color": "#1c5b4f", "circle-stroke-width": 0.7, "circle-stroke-color": "#ffffff" },
  });
  map.addLayer({
    id: "exceedance-pulse", type: "circle", source: "samples", filter: exceedanceFilter(),
    paint: { "circle-radius": 10, "circle-color": "rgba(0,0,0,0)", "circle-stroke-color": "#d62828", "circle-stroke-width": 2, "circle-stroke-opacity": 0.6 },
  });
  map.addLayer({
    id: "exceedance", type: "circle", source: "samples", filter: exceedanceFilter(),
    paint: { "circle-radius": zoomRadius(EXCEEDANCE_SIZE), "circle-color": "#d62828", "circle-stroke-width": 1, "circle-stroke-color": "#ffffff" },
  });
  map.addLayer({
    id: "selected-halo", type: "circle", source: "selected-result",
    paint: { "circle-radius": 20, "circle-color": "rgba(24,32,29,.1)", "circle-stroke-width": 1, "circle-stroke-color": "rgba(24,32,29,.28)" },
  });
  map.addLayer({
    id: "selected-point", type: "circle", source: "selected-result",
    paint: { "circle-radius": 9, "circle-color": "#1c5b4f", "circle-stroke-width": 3, "circle-stroke-color": "#18201d" },
  });
  map.addLayer({
    id: "selected-label", type: "symbol", source: "selected-result",
    layout: { "text-field": ["get", "code"], "text-size": 11, "text-offset": [0, -2.3], "text-anchor": "bottom", "text-allow-overlap": true, "text-ignore-placement": true },
    paint: { "text-color": "#18201d", "text-halo-color": "#ffffff", "text-halo-width": 2 },
  });

  setMapMode(state.map.mode);
  if (!window.matchMedia("(prefers-reduced-motion: reduce)").matches) window.requestAnimationFrame(animatePulse);
}

// Recomputes what the map shows from the current selection.
// reload: false keeps the loaded points, for changes of period only.
export async function refreshMap({ reload = true } = {}) {
  const [features, context] = await Promise.all([reload ? selectionFeatures() : allFeatures, contextFeatures(), loadScale(currentParameter())]);
  allFeatures = features;
  map.getSource("context").setData({ type: "FeatureCollection", features: context });
  showPeriod();
}

export function applyStyling() {
  const expression = isAllElements() ? yearExpression() : colorExpression(state.map.colorField);
  for (const layer of ["samples", "cluster-points", "selected-point"]) map.setPaintProperty(layer, "circle-color", expression);
  const weighted = !isAllElements() && state.map.colorField === "concentration" && state.scale.stops;
  map.setPaintProperty("sample-density", "heatmap-weight", weighted ? ["interpolate", ["linear"], ["to-number", ["get", "value"], 0], 0, 0.05, state.scale.stops[4], 1] : 1);
  for (const layer of ["exceedance-pulse", "exceedance"]) map.setFilter(layer, exceedanceFilter());
  exceedanceCount = state.scale.p99 == null ? 0 : state.map.features.filter((feature) => Number(feature.properties.value) > state.scale.p99).length;
  renderLegend();
}

function exceedanceFilter() {
  return [">", ["to-number", ["get", "value"], -1], state.scale.p99 ?? Number.MAX_VALUE];
}

// The ring fades in from the dot, expands, fades out and rests before the next beat.
function animatePulse(time) {
  if (exceedanceCount && map.getLayoutProperty("exceedance-pulse", "visibility") !== "none") {
    const phase = (time % 1600) / 1600;
    const opacity = phase < 0.1 ? phase / 0.1 : Math.max(0, 1 - (phase - 0.1) / 0.65);
    const core = radiusAt(map.getZoom(), EXCEEDANCE_SIZE);
    map.setPaintProperty("exceedance-pulse", "circle-radius", core + (1 - (1 - phase) ** 3) * core * 2.6);
    map.setPaintProperty("exceedance-pulse", "circle-stroke-opacity", 0.9 * opacity);
  }
  window.requestAnimationFrame(animatePulse);
}

export function setMapMode(mode) {
  state.map.mode = mode;
  document.querySelectorAll(".map-toolbar button").forEach((button) => button.classList.toggle("active", button.dataset.mode === mode));
  // The Assistant tab keeps the map empty until an answer shows something.
  if (state.view === "assistant" && !state.map.agentShowing) return;
  const show = (visible) => (visible ? "visible" : "none");
  map.setLayoutProperty("sample-halo", "visibility", show(mode === "points"));
  map.setLayoutProperty("samples", "visibility", show(mode === "points"));
  map.setLayoutProperty("sample-density", "visibility", show(mode === "density"));
  for (const layer of ["context-points", "exceedance-pulse", "exceedance"]) map.setLayoutProperty(layer, "visibility", show(mode !== "clusters"));
  for (const layer of ["cluster-circles", "cluster-count", "cluster-points"]) map.setLayoutProperty(layer, "visibility", show(mode === "clusters"));
  for (const layer of ["selected-halo", "selected-point", "selected-label"]) map.setLayoutProperty(layer, "visibility", "visible");
  if (state.ready) writeUrlState();
}

export function hideDataLayers() {
  for (const layer of DATA_LAYERS) map.setLayoutProperty(layer, "visibility", "none");
}

export function highlightRecord(row) {
  const source = map.getSource("selected-result");
  if (!source) return;
  if (!row || row.easting_m == null || row.northing_m == null) {
    source.setData(EMPTY);
    return;
  }
  const mapped = state.map.features.find((feature) => String(feature.properties.id) === String(row.result_id));
  const date = row.sampling_date ? new Date(row.sampling_date) : null;
  const properties = mapped ? { ...mapped.properties } : { value: row.numeric_value, year: date ? date.getUTCFullYear() : 0, campaign: row.campaign_name };
  properties.code = row.station_code || row.station_id || "";
  source.setData({ type: "FeatureCollection", features: [{ type: "Feature", geometry: { type: "Point", coordinates: toLngLat(row.easting_m, row.northing_m) }, properties }] });
}

export function bindMapToolbar() {
  document.querySelectorAll(".map-toolbar button").forEach((button) => {
    button.addEventListener("click", () => setMapMode(button.dataset.mode));
  });
  document.getElementById("colorField").addEventListener("change", (event) => {
    state.map.colorField = event.target.value;
    applyStyling();
  });
}
