import { isAllElements, currentParameter, state } from "../state.js";
import { toLngLat } from "../lib/geo.js";
import { query } from "../data/database.js";
import { selectionSource, selectionWhere } from "../data/selection.js";
import { loadScale } from "../data/statistics.js";
import { renderLegend } from "../panel/legend.js";
import { writeUrlState } from "../url-state.js";
import { fitTo, map } from "./map.js";
import { refreshCatchmentRings } from "./catchment.js";
import { EXCEEDANCE_SIZE, PALETTE, POINT_SIZE, TOP, colorExpression, marksHighValues, yearExpression, zoomRadius } from "./style.js";

const EMPTY = { type: "FeatureCollection", features: [] };
const DATA_LAYERS = ["context-points", "sample-halo", "samples", "sample-density", "cluster-circles", "cluster-count", "cluster-points", "exceedance", "selected-halo", "selected-point", "selected-label"];
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
  // Every dataset opens on the same frame, so switching keeps looking at the same place.
  const frame = state.frame ?? state.map.features.map((feature) => feature.geometry.coordinates);
  fitTo(frame, { animate: false, maxZoom: 12 });
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
    paint: { "circle-radius": zoomRadius(POINT_SIZE), "circle-color": PALETTE[1], "circle-stroke-width": 1.1, "circle-stroke-color": "#ffffff", "circle-opacity": 0.92 },
  });
  map.addLayer({
    id: "sample-density", type: "heatmap", source: "samples", layout: { visibility: "none" },
    paint: {
      "heatmap-weight": 1,
      "heatmap-intensity": ["interpolate", ["linear"], ["zoom"], 7, 0.7, 13, 2.2],
      "heatmap-radius": ["interpolate", ["linear"], ["zoom"], 7, 8, 13, 28],
      "heatmap-opacity": 0.82,
      "heatmap-color": ["interpolate", ["linear"], ["heatmap-density"], 0, "rgba(168,221,147,0)", 0.25, "#cdeebd", 0.5, PALETTE[0], 0.75, PALETTE[2], 1, PALETTE[4]],
    },
  });
  map.addLayer({
    id: "cluster-circles", type: "circle", source: "sample-clusters", filter: ["has", "point_count"], layout: { visibility: "none" },
    paint: {
      "circle-color": ["step", ["get", "point_count"], PALETTE[0], 25, PALETTE[2], 100, PALETTE[4]],
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
    paint: { "circle-radius": zoomRadius(POINT_SIZE), "circle-color": PALETTE[1], "circle-stroke-width": 1.1, "circle-stroke-color": "#ffffff" },
  });
  // The top 1 % of a metal of concern: the darkest step, drawn larger.
  map.addLayer({
    id: "exceedance", type: "circle", source: "samples", filter: exceedanceFilter(),
    paint: { "circle-radius": zoomRadius(EXCEEDANCE_SIZE), "circle-color": TOP, "circle-stroke-width": 1.4, "circle-stroke-color": "#ffffff" },
  });
  map.addLayer({
    id: "selected-halo", type: "circle", source: "selected-result",
    paint: { "circle-radius": 20, "circle-color": "rgba(24,32,29,.1)", "circle-stroke-width": 1, "circle-stroke-color": "rgba(24,32,29,.28)" },
  });
  map.addLayer({
    id: "selected-point", type: "circle", source: "selected-result",
    paint: { "circle-radius": 9, "circle-color": PALETTE[1], "circle-stroke-width": 3, "circle-stroke-color": "#18201d" },
  });
  map.addLayer({
    id: "selected-label", type: "symbol", source: "selected-result",
    layout: { "text-field": ["get", "code"], "text-size": 11, "text-offset": [0, -2.3], "text-anchor": "bottom", "text-allow-overlap": true, "text-ignore-placement": true },
    paint: { "text-color": "#18201d", "text-halo-color": "#ffffff", "text-halo-width": 2 },
  });

  setMapMode(state.map.mode);
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
  map.setFilter("exceedance", exceedanceFilter());
  renderLegend();
}

function exceedanceFilter() {
  const limit = marksHighValues() ? state.scale.p99 : null;
  return [">", ["to-number", ["get", "value"], -1], limit ?? Number.MAX_VALUE];
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
  for (const layer of ["context-points", "exceedance"]) map.setLayoutProperty(layer, "visibility", show(mode !== "clusters"));
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
