import { state } from "../state.js";
import { parameterLabel, qualityReasons } from "../config.js";
import { escapeHtml, formatDate } from "../lib/format.js";
import { toLngLat } from "../lib/geo.js";
import { quote } from "../lib/sql.js";
import { query } from "../data/database.js";
import { exceedanceLevel, parameterLimits } from "../data/statistics.js";
import { map } from "../map/map.js";
import { highlightRecord } from "../map/layers.js";
import { clearCatchment, showCatchment } from "../map/catchment.js";
import { destroyHistoryChart, renderHistory } from "./history.js";
import { recordedAsZero, valueText } from "../data/selection.js";
import { setPanel, showTab } from "./layout.js";

const $ = (id) => document.getElementById(id);
let request = 0;
let openRow = null;

function section(title, entries) {
  const rows = entries.map(([label, value]) => `<div class="detail-row"><span>${escapeHtml(label)}</span><strong>${escapeHtml(value ?? "Not reported")}</strong></div>`);
  return `<section class="detail-section"><h3>${escapeHtml(title)}</h3>${rows.join("")}</section>`;
}

async function sampleSection(row, sampleView) {
  const [limits, results] = await Promise.all([
    parameterLimits(),
    query(`SELECT result_id, parameter_code, parameter_name, reported_value, numeric_value, qualifier, reported_limit, reported_unit FROM observations WHERE sample_id = ${quote(row.sample_id)}`),
  ]);
  if (!results.length) return "";
  results.sort((a, b) => parameterLabel(a.parameter_code, a.parameter_name).localeCompare(parameterLabel(b.parameter_code, b.parameter_name)));
  const counts = { p95: 0, p99: 0 };
  const rows = results.map((item) => {
    const limit = limits.get(item.parameter_code) || {};
    const level = item.qualifier === "EQUAL" ? exceedanceLevel(item.numeric_value, limit.p95, limit.p99) : "";
    if (level) counts[level] += 1;
    const value = valueText(item);
    const classes = ["parameter-row", level && `level-${level}`, !sampleView && item.parameter_code === row.parameter_code && "current"].filter(Boolean).join(" ");
    return `<div class="${classes}"><span>${escapeHtml(parameterLabel(item.parameter_code, item.parameter_name))}</span><strong>${escapeHtml(value)}</strong></div>`;
  });
  fillParameterPicker(results, row, sampleView);
  return `<section class="detail-section sample-parameters"><h3>All parameters in this sample · ${results.length}</h3>`
    + `<div class="parameter-legend"><span class="level-p95"><i></i>≥ P95 dataset · ${counts.p95}</span><span class="level-p99"><i></i>≥ P99 dataset · ${counts.p99}</span></div>`
    + `${rows.join("")}</section>`;
}

// The header carries every element of the open sample, so one record leads to the next.
function fillParameterPicker(results, row, sampleView) {
  const picker = $("detailParameter");
  picker.replaceChildren(
    new Option("All parameters", "all", false, sampleView),
    ...results.map((item) => new Option(parameterLabel(item.parameter_code, item.parameter_name), item.result_id, false, !sampleView && item.parameter_code === row.parameter_code)),
  );
  picker.hidden = false;
  picker.onchange = async () => {
    const choice = picker.value;
    const chosen = results.find((item) => item.result_id === choice);
    if (choice === "all") openRecord(row, { fly: false, sampleView: true });
    else openRecordById(choice, { sampleView: false });
    // The map and the table follow the element chosen here.
    const { applyFilters } = await import("./explorer.js");
    await applyFilters({ parameter: choice === "all" ? "all" : chosen.parameter_code });
  };
}

export function openRecord(row, { fly = true, sampleView = false } = {}) {
  const current = ++request;
  openRow = row;
  highlightRecord(row);
  const reasons = qualityReasons(row.quality_rules);
  // Some historical sheets record an undetected value as 0, which is not a measurement.
  if (recordedAsZero(row)) reasons.push("Recorded as 0, which is not a measurement; it is left out of the statistics and the map");
  $("detailTitle").textContent = row.station_code || "Unknown station";
  $("detailDate").textContent = row.sampling_date ? `sampled ${formatDate(row.sampling_date)}` : "";
  $("detailParameter").hidden = true;
  $("detailBody").innerHTML = [
    sampleView ? "" : section("Result", [
      ["Reported value", row.reported_value],
      ["Numeric value", row.numeric_value],
      ["Qualifier", row.qualifier],
      ["Reported limit", row.reported_limit],
      ["Unit", row.unit_is_inferred ? `${row.reported_unit} (inferred)` : row.reported_unit],
      ["Quality", row.quality_status],
      ...(reasons.length ? [["Quality notes", reasons.join(" · ")]] : []),
    ]),
    '<div id="stationHistory" class="detail-loading">Loading this station over time…</div>',
    '<div id="sampleParameters" class="detail-loading">Loading sample parameters…</div>',
    section("Sampling", [["Station", row.station_code], ["Sampling date", formatDate(row.sampling_date)], ["Campaign", row.campaign_name], ["Sample ID", row.sample_id]]),
    section("Location", [
      ["Easting", row.easting_m],
      ["Northing", row.northing_m],
      ["CRS", row.epsg ? `EPSG:${row.epsg} · preliminary` : null],
      ["Coordinate status", row.coordinate_status],
      // VALID next to a preliminary CRS reads as a contradiction, so it is spelled out.
      ...(row.epsg ? [["What preliminary means", "The coordinate passed the checks, but the source does not state its reference system; UTM 19S is assumed and has to be confirmed at source."]] : []),
    ]),
    section("Provenance", [["Source", row.source_name], ["Workbook", row.relative_path], ["Worksheet", row.sheet_name], ["Excel row", row.source_row_number], ["Result ID", row.result_id], ["Source record", row.source_record_id]]),
  ].join("");
  $("stationTabButton").disabled = false;
  // Clicking a point while the assistant is answering leaves its view alone; the Station
  // tab is there when the user wants it.
  if (state.view !== "assistant") showTab("station");
  $("detailBody").scrollTop = 0;
  sampleSection(row, sampleView).then((html) => {
    const target = $("sampleParameters");
    if (target && current === request) target.outerHTML = html;
  });
  renderHistory($("stationHistory"), row, { sampleView }).then(() => {
    for (const item of document.querySelectorAll(".history-row[data-result]")) {
      item.addEventListener("click", () => openRecordById(item.dataset.result, { sampleView: false }));
    }
  }).catch(() => {});
  // The map outlines the station's catchment; clicking another point swaps it.
  showCatchment(row.station_id);
  const located = row.easting_m != null && row.northing_m != null && ["VALID", "PENDING_REVIEW"].includes(row.coordinate_status);
  if (fly && located) map.flyTo({ center: toLngLat(row.easting_m, row.northing_m), zoom: Math.max(map.getZoom(), 12), duration: 700 });
}

export async function openRecordById(resultId, options = {}) {
  const [row] = await query(`SELECT * FROM observations WHERE result_id = ${quote(resultId)} LIMIT 1`);
  if (!row) return;
  setPanel(true);
  openRecord(row, { fly: false, ...options });
}

// Keeps the open record on the element chosen on the map, when this sample has it.
export async function showParameterInRecord(parameter) {
  if (!openRow) return;
  if (parameter === "all") {
    openRecord(openRow, { fly: false, sampleView: true });
    return;
  }
  const [match] = await query(`SELECT * FROM observations WHERE sample_id = ${quote(openRow.sample_id)} AND parameter_code = ${quote(parameter)} LIMIT 1`);
  if (match) openRecord(match, { fly: false });
}

export function closeRecord() {
  openRow = null;
  $("detailParameter").hidden = true;
  $("stationTabButton").disabled = true;
  $("detailBody").replaceChildren();
  destroyHistoryChart();
  highlightRecord(null);
  clearCatchment();
  if (state.view === "station") showTab("data");
}

export function recordIsOpen() {
  return Boolean(openRow);
}

export function bindRecord() {
  $("closeDetail").addEventListener("click", closeRecord);
}
