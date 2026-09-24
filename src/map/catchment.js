import { escapeHtml, formatNumber } from "../lib/format.js";
import { toLngLat } from "../lib/geo.js";
import { quote } from "../lib/sql.js";
import { query } from "../data/database.js";
import { state } from "../state.js";
import { map } from "./map.js";

// The upstream catchment of the station whose record is open, from the dataset's derived
// context tables (MERIT Hydro, 90 m): its outline, the station and the stations that
// drain to it. Stations without usable coordinates have no catchment.
const EMPTY = { type: "FeatureCollection", features: [] };
const COLOR = "#1D4ED8";
const SOURCES = ["catchment", "catchment-upstream", "catchment-outlet"];
const $ = (id) => document.getElementById(id);
const COVER = { tree: "Tree cover", shrub: "Shrubland", grass: "Grassland", cropland: "Cropland", built: "Built-up", bare: "Bare ground", snow_ice: "Snow and ice", water: "Water", wetland: "Wetland" };
let request = 0;
let shown = null;

export function addCatchmentLayers() {
  for (const id of SOURCES) map.addSource(id, { type: "geojson", data: EMPTY });
  // Under the sample points, so the data stays readable on top of the outline.
  map.addLayer({ id: "catchment-fill", type: "fill", source: "catchment", paint: { "fill-color": COLOR, "fill-opacity": 0.08 } }, "context-points");
  map.addLayer({ id: "catchment-line", type: "line", source: "catchment", paint: { "line-color": COLOR, "line-width": 2, "line-opacity": 0.85 } }, "context-points");
  // Thin rings that grow with zoom, so a catchment with hundreds of stations stays legible.
  map.addLayer({
    id: "catchment-upstream", type: "circle", source: "catchment-upstream",
    paint: {
      "circle-radius": ["interpolate", ["linear"], ["zoom"], 9, 3.5, 14, 7],
      "circle-color": "rgba(0,0,0,0)",
      "circle-stroke-width": ["interpolate", ["linear"], ["zoom"], 9, 0.8, 14, 1.5],
      "circle-stroke-color": COLOR,
      "circle-stroke-opacity": 0.75,
    },
  });
  map.addLayer({
    id: "catchment-outlet", type: "circle", source: "catchment-outlet",
    paint: { "circle-radius": 8, "circle-color": COLOR, "circle-stroke-width": 3, "circle-stroke-color": "#ffffff" },
  });
}

export function clearCatchment() {
  request += 1;
  if (!map?.getSource("catchment")) return;
  shown = null;
  for (const id of SOURCES) map.getSource(id).setData(EMPTY);
  $("catchmentCard").hidden = true;
}

const point = (row) => ({ type: "Feature", properties: {}, geometry: { type: "Point", coordinates: toLngLat(row.easting_m, row.northing_m) } });

// Only the upstream stations the map is showing get a ring: a ring with no point under it,
// because that station has no result for the current element or period, reads as an error.
function drawRings() {
  if (!shown) return;
  const visible = new Set(state.map.features.map((feature) => feature.properties.station_id));
  const rings = shown.upstream.filter((row) => visible.has(row.station_id));
  map.getSource("catchment-upstream").setData({ type: "FeatureCollection", features: rings.map(point) });
  $("catchmentUpstream").textContent = `${rings.length} of ${shown.upstream.length}`;
}

// The map's selection changes with the filters, so the rings follow it.
export function refreshCatchmentRings() {
  if (shown && map?.getSource("catchment-upstream")) drawRings();
}

function coverSummary(context) {
  return Object.entries(COVER)
    .map(([key, label]) => [label, Number(context[`catchment_${key}_pct`]) || 0])
    .filter(([, share]) => share >= 1)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 2)
    .map(([label, share]) => `${label} ${formatNumber(share)}%`)
    .join(", ");
}

// Draws the catchment of a station and fills the card above the statistics. A newer call
// supersedes one still loading; a station without a catchment clears both.
export async function showCatchment(stationId) {
  const current = ++request;
  const [context] = stationId ? await query(`
    SELECT c.*, o.geometry_geojson, s.easting_m, s.northing_m, coalesce(s.canonical_code, s.station_id) AS code,
           coalesce(n.canonical_code, n.station_id) AS next_code
    FROM read_parquet('station_context.parquet') c
    JOIN read_parquet('station_catchment_outlines.parquet') o USING (station_id)
    JOIN read_parquet('stations.parquet') s USING (station_id)
    LEFT JOIN read_parquet('stations.parquet') n ON n.station_id = c.next_downstream_station_id
    WHERE c.station_id = ${quote(stationId)}
  `) : [];
  const upstream = context ? await query(`
    SELECT s.station_id, s.easting_m, s.northing_m
    FROM read_parquet('station_links.parquet') l
    JOIN read_parquet('stations.parquet') s ON s.station_id = l.upstream_station_id
    WHERE l.downstream_station_id = ${quote(stationId)} AND s.easting_m IS NOT NULL
  `) : [];
  // The record can open before the map has its layers, while the page is still loading.
  if (current !== request || !map?.getSource("catchment")) return;
  if (!context) {
    clearCatchment();
    return;
  }

  map.getSource("catchment").setData({ type: "Feature", properties: {}, geometry: JSON.parse(context.geometry_geojson) });
  map.getSource("catchment-outlet").setData(point(context));
  shown = { context, upstream };

  const metrics = [
    ["Area", `${formatNumber(context.upstream_area_km2)} km²`],
    ["Stations up", `<span id="catchmentUpstream">–</span>`],
    ["Population", formatNumber(Math.round(context.catchment_population))],
    ["Mean elev.", context.catchment_mean_elevation_m == null ? "–" : `${formatNumber(context.catchment_mean_elevation_m)} m`],
    ["Strahler", context.h90_strahler ?? "–"],
    ["HAND", `${formatNumber(context.hand_m)} m`],
  ];
  $("catchmentCode").textContent = context.code;
  // "Stations up" carries its own element, filled with how many of them the map shows.
  $("catchmentMetrics").innerHTML = metrics.map(([label, value]) => `<div><small>${escapeHtml(label)}</small><strong>${label === "Stations up" ? value : escapeHtml(value)}</strong></div>`).join("");
  $("catchmentNote").textContent = [
    coverSummary(context),
    // Codes repeat across places, so a station can be upstream of another with its own code.
    context.next_code
      ? `next downstream ${context.next_code}${context.next_code === context.code ? " (another station with the same code)" : ""} at ${formatNumber(context.next_downstream_km)} km`
      : null,
    context.catchment_complete ? null : "part of the catchment lies outside the model, totals are partial",
  ].filter(Boolean).join(" · ");
  $("catchmentCard").hidden = false;
  drawRings();
}
