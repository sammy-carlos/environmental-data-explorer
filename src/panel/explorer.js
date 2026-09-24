import { isAllElements, state } from "../state.js";
import { parameterLabel, qualityReasons, shortStatus } from "../config.js";
import { downloadFile, escapeHtml, formatDate, plural, toCsv } from "../lib/format.js";
import { quote, readOnlySql } from "../lib/sql.js";
import { query, queryTable } from "../data/database.js";
import { LOCATED, MEASURED, selectionSource, selectionWhere, valueText } from "../data/selection.js";
import { summarizeSelection } from "../data/statistics.js";
import { refreshMap, showPeriod } from "../map/layers.js";
import { clearAreas } from "../map/areas.js";
import { writeUrlState } from "../url-state.js";
import { renderStatistics } from "./legend.js";
import { openRecord, showParameterInRecord } from "./record.js";

const $ = (id) => document.getElementById(id);

// Columns a custom SQL selection must return so the table, map and record keep working.
const REQUIRED_COLUMNS = ["result_id", "sample_id", "source_record_id", "station_code", "station_id", "easting_m", "northing_m", "epsg", "coordinate_status", "sampling_date", "campaign_name", "parameter_code", "parameter_name", "reported_value", "numeric_value", "qualifier", "reported_limit", "reported_unit", "quality_status", "source_name", "relative_path", "sheet_name", "source_row_number"];

export async function setupFilters() {
  const parameters = await query("SELECT parameter_code, parameter_name FROM read_parquet('parameters.parquet')");
  parameters.sort((a, b) => parameterLabel(a.parameter_code, a.parameter_name).localeCompare(parameterLabel(b.parameter_code, b.parameter_name)));
  const options = () => [
    new Option("All elements", "all"),
    ...parameters.map((item) => new Option(parameterLabel(item.parameter_code, item.parameter_name), item.parameter_code)),
  ];
  $("dataParameter").replaceChildren(...options());
  // The legend on the map carries the same list, so the element can be changed there too.
  $("mapParameter").replaceChildren(...options());
  $("mapParameter").addEventListener("change", async (event) => {
    await applyFilters({ parameter: event.target.value });
    await showParameterInRecord(event.target.value);
  });
  for (const id of ["periodFrom", "periodTo"]) Object.assign($(id), { min: state.years.first, max: state.years.last, step: 1 });
  state.sql.initial = [
    "SELECT *",
    "FROM observations",
    `WHERE parameter_code = ${quote(state.dataset.defaultParameter)}`,
    "  AND quality_status = 'VALID'",
    `  AND year(sampling_date) BETWEEN ${state.years.first} AND ${state.years.last}`,
  ].join("\n");
  $("sqlInput").value = state.sql.initial;
  $("periodValue").textContent = `${state.years.first}–${state.years.last}`;
  syncInputs();
}

function syncInputs() {
  $("dataParameter").value = state.filters.parameter;
  if (state.mode !== "sql") $("mapParameter").value = state.filters.parameter;
  $("dataQuality").value = state.filters.quality;
  $("repeatFilter").dataset.state = state.filters.repeated ? "active" : "idle";
  $("repeatFilter").setAttribute("aria-pressed", String(Boolean(state.filters.repeated)));
  $("periodFrom").value = state.filters.from;
  $("periodTo").value = state.filters.to;
  renderPeriod();
}

function renderPeriod() {
  const { from, to } = state.filters;
  const span = Math.max(1, state.years.last - state.years.first);
  $("periodFromLabel").textContent = from;
  $("periodToLabel").textContent = to;
  $("periodSlider").style.setProperty("--from", `${100 * (from - state.years.first) / span}%`);
  $("periodSlider").style.setProperty("--to", `${100 * (to - state.years.first) / span}%`);
}

export async function refreshData({ updateMap = false, reloadMap = true } = {}) {
  if (!state.db) return;
  $("dataRows").innerHTML = '<div class="data-loading">Querying DuckDB…</div>';
  const source = selectionSource();
  const where = selectionWhere();
  const [counts] = await query(`
    SELECT count(*) AS total,
           count(*) FILTER (WHERE easting_m IS NULL OR northing_m IS NULL OR coordinate_status = 'INVALID') AS no_coordinates,
           count(*) FILTER (WHERE easting_m IS NOT NULL AND northing_m IS NOT NULL AND coordinate_status = 'EXCLUDED_FROM_ANALYSIS') AS outside_area,
           count(*) FILTER (WHERE ${LOCATED} AND qualifier = 'LESS_THAN') AS below_limit,
           count(*) FILTER (WHERE ${LOCATED} AND NOT coalesce(${MEASURED} OR qualifier = 'LESS_THAN', false)) AS no_value
    FROM ${source} ${where}
  `);
  const table = state.table;
  table.total = counts.total;
  table.page = Math.min(table.page, Math.max(1, Math.ceil(table.total / table.pageSize)));
  table.rows = await query(`
    SELECT * FROM ${source} ${where}
    ORDER BY sampling_date DESC NULLS LAST, station_code, result_id
    LIMIT ${table.pageSize} OFFSET ${(table.page - 1) * table.pageSize}
  `);
  const notes = [];
  if (state.filters.repeated) notes.push("only stations sampled on 2 or more dates");
  if (counts.no_coordinates) notes.push(`${counts.no_coordinates.toLocaleString()} without coordinates`);
  if (counts.outside_area) notes.push(`${counts.outside_area.toLocaleString()} outside study area`);
  // A single element maps measured values only, so results below the limit stay in the table.
  if (!isAllElements() && counts.below_limit) notes.push(`${counts.below_limit.toLocaleString()} below limit`);
  if (!isAllElements() && counts.no_value) notes.push(`${counts.no_value.toLocaleString()} no value`);
  $("dataUnmapped").hidden = !notes.length;
  $("dataUnmapped").textContent = notes.map((note) => `· ${note}`).join(" ");
  renderTable();
  renderStatistics(await summarizeSelection());
  if (updateMap) await refreshMap({ reload: reloadMap });
  if (state.ready) writeUrlState();
}

function qualityCell(row) {
  const kind = { EXCLUDED_FROM_ANALYSIS: "excluded", PENDING_REVIEW: "pending" }[row.quality_status] || "";
  const reasons = row.quality_status === "VALID" ? [] : qualityReasons(row.quality_rules);
  const reason = reasons.length ? `<small>${escapeHtml(reasons.join(" · "))}</small>` : "";
  const title = escapeHtml([shortStatus(row.quality_status), ...reasons].join(" · "));
  return `<span class="quality-pill ${kind}${reason ? " has-reason" : ""}" title="${title}"><b>${escapeHtml(shortStatus(row.quality_status))}</b>${reason}</span>`;
}

function renderTable() {
  const { rows, page, pageSize, total } = state.table;
  const body = $("dataRows");
  body.replaceChildren();
  if (!rows.length) body.innerHTML = '<div class="data-loading">No results match these filters.</div>';
  for (const row of rows) {
    const value = valueText(row);
    const button = document.createElement("button");
    button.type = "button";
    button.className = "data-row";
    button.setAttribute("role", "row");
    button.innerHTML = `<span title="${escapeHtml(row.station_code || "–")}">${escapeHtml(row.station_code || "–")}</span>`
      + `<span>${formatDate(row.sampling_date) || "–"}</span><span>${escapeHtml(row.parameter_name)}</span>`
      + `<span title="${escapeHtml(value)}">${escapeHtml(value)}</span>${qualityCell(row)}`;
    button.addEventListener("click", () => openRecord(row));
    body.append(button);
  }
  const start = total ? (page - 1) * pageSize + 1 : 0;
  const end = Math.min(page * pageSize, total);
  $("dataResultCount").textContent = total.toLocaleString();
  $("dataRange").textContent = `${start.toLocaleString()}–${end.toLocaleString()} of ${total.toLocaleString()}`;
  $("pageNumber").textContent = String(page);
  $("previousPage").disabled = page <= 1;
  $("nextPage").disabled = end >= total;
}

// Used by the filter controls, the assistant and the URL.
export async function applyFilters(changes = {}) {
  if (state.mode === "sql") await setDataMode("filters", { refresh: false });
  Object.assign(state.filters, changes);
  const { first, last } = state.years;
  state.filters.from = Math.max(first, Math.min(last, Number(state.filters.from)));
  state.filters.to = Math.max(state.filters.from, Math.min(last, Number(state.filters.to)));
  state.table.page = 1;
  syncInputs();
  await refreshData({ updateMap: true });
}

export async function applySql(sql) {
  const clean = readOnlySql(sql);
  const preview = await queryTable(`SELECT * FROM (${clean}) AS contract LIMIT 0`);
  const columns = new Set(preview.schema.fields.map((field) => field.name));
  const missing = REQUIRED_COLUMNS.filter((column) => !columns.has(column));
  if (missing.length) throw new Error(`The query must return every observations column. Missing: ${missing.join(", ")}`);
  const [contract] = await query(`
    SELECT count(*) AS results, count(DISTINCT parameter_code) AS parameters, min(parameter_code) AS parameter,
           count(*) FILTER (WHERE ${MEASURED} AND ${LOCATED}) AS mapped
    FROM (${clean}) AS contract
  `);
  if (!contract.results) throw new Error("The query returned no observations.");
  if (contract.parameters !== 1) throw new Error(`The query must select exactly one parameter; it returned ${contract.parameters}.`);
  if (!contract.mapped) throw new Error("The query returned no measured values with usable coordinates.");
  state.mode = "sql";
  state.sql.query = clean;
  state.sql.parameter = contract.parameter;
  state.table.page = 1;
  $("sqlInput").value = clean;
  renderMode();
  await refreshData({ updateMap: true });
}

function renderMode() {
  document.querySelectorAll("[data-data-mode]").forEach((button) => button.classList.toggle("active", button.dataset.dataMode === state.mode));
  $("filterMode").hidden = state.mode !== "filters";
  $("sqlMode").hidden = state.mode !== "sql";
}

async function runSqlConsole() {
  const button = $("runSql");
  const status = $("sqlStatus");
  button.disabled = true;
  status.textContent = "Validating…";
  try {
    await applySql($("sqlInput").value);
    status.textContent = `${plural(state.table.total, "result")} applied`;
  } catch (error) {
    status.textContent = error.message || String(error);
  } finally {
    button.disabled = false;
  }
}

export async function setDataMode(mode, { refresh = true } = {}) {
  state.table.page = 1;
  if (mode === "sql") {
    $("filterMode").hidden = true;
    $("sqlMode").hidden = false;
    document.querySelectorAll("[data-data-mode]").forEach((button) => button.classList.toggle("active", button.dataset.dataMode === "sql"));
    await runSqlConsole();
    return;
  }
  state.mode = "filters";
  state.sql.query = null;
  renderMode();
  if (refresh) await refreshData({ updateMap: true });
}

async function exportCsv() {
  const columns = ["station_code", "sampling_date", "campaign_name", "parameter_code", "reported_value", "numeric_value", "qualifier", "reported_limit", "reported_unit", "quality_status", "easting_m", "northing_m", "epsg", "result_id"];
  const rows = await query(`SELECT ${columns.join(", ")} FROM ${selectionSource()} ${selectionWhere()} ORDER BY sampling_date, station_code`, { dates: true });
  downloadFile(`${state.dataset.id}-results-${new Date().toISOString().slice(0, 10)}.csv`, toCsv(columns, rows), "text/csv;charset=utf-8");
}

async function reset() {
  if (state.mode === "sql") {
    $("sqlInput").value = state.sql.initial;
    await clearAreas({ refresh: false });
    await runSqlConsole();
    return;
  }
  await clearAreas({ refresh: false });
  await applyFilters({ parameter: state.dataset.defaultParameter, quality: "VALID", from: state.years.first, to: state.years.last });
}

export function bindExplorer() {
  $("dataParameter").addEventListener("change", async (event) => {
    await applyFilters({ parameter: event.target.value });
    await showParameterInRecord(event.target.value);
  });
  $("dataQuality").addEventListener("change", (event) => applyFilters({ quality: event.target.value }));
  $("repeatFilter").addEventListener("click", () => applyFilters({ repeated: !state.filters.repeated }));
  // The points follow the slider on every step (filtering them takes about 2 ms); the
  // table and statistics catch up once it rests, without loading the points again.
  let timer;
  for (const id of ["periodFrom", "periodTo"]) {
    $(id).addEventListener("input", (event) => {
      const value = Number(event.target.value);
      if (id === "periodFrom") Object.assign(state.filters, { from: value, to: Math.max(value, state.filters.to) });
      else Object.assign(state.filters, { to: value, from: Math.min(value, state.filters.from) });
      syncInputs();
      showPeriod();
      window.clearTimeout(timer);
      timer = window.setTimeout(() => {
        state.table.page = 1;
        refreshData({ updateMap: true, reloadMap: false });
      }, 250);
    });
  }
  document.querySelectorAll("[data-data-mode]").forEach((button) => button.addEventListener("click", () => setDataMode(button.dataset.dataMode)));
  $("runSql").addEventListener("click", runSqlConsole);
  $("previousPage").addEventListener("click", () => {
    if (state.table.page <= 1) return;
    state.table.page -= 1;
    refreshData();
  });
  $("nextPage").addEventListener("click", () => {
    if (state.table.page * state.table.pageSize >= state.table.total) return;
    state.table.page += 1;
    refreshData();
  });
  $("clearDataFilters").addEventListener("click", reset);
  $("exportData").addEventListener("click", exportCsv);
}
