import { parameterLabel } from "../config.js";
import { escapeHtml, formatDate, formatNumber } from "../lib/format.js";
import { quote } from "../lib/sql.js";
import { valueText } from "../data/selection.js";
import { query } from "../data/database.js";
import { exceedanceLevel, parameterLimits } from "../data/statistics.js";

const $ = (id) => document.getElementById(id);

// Everything measured at one station over time. A station is usually sampled on several
// dates, which the map draws as points on top of each other; here they are one series:
// a chart of the open element and the list of dates behind it.
const MEASURED = "qualifier = 'EQUAL' AND numeric_value > 0";
// A lighter green than the interface, so the series does not read as a control.
const COLOR = "#3f9b78";
const LIMIT_COLOR = "#8a94a6";
// The same amber and red the map uses for values above the dataset P95 and P99.
export const LEVELS = { p95: "#e0a400", p99: "#d62828" };
export const SERIES_COLORS = { value: COLOR, limit: LIMIT_COLOR };
const CURRENT_COLOR = "#18201d";
let chart = null;
// The series on the map card, kept so it can be downloaded as it is drawn.
let series = null;
// The period of the series shown on the card, as the first and last index of its rows. It
// trims the chart and the downloads, and it is kept while stepping through the dates of the
// same station and element; another station or element starts from the whole series.
let period = null;
let openResult = () => {};

export function destroyHistoryChart() {
  chart?.destroy();
  chart = null;
  series = null;
  const card = document.getElementById("seriesCard");
  if (card) card.hidden = true;
}

// Every result of one element at one station, oldest first.
async function elementHistory(stationId, parameterCode) {
  return query(`
    SELECT result_id, sampling_date, reported_value, numeric_value, qualifier, reported_limit, reported_unit, quality_status, campaign_name
    FROM observations WHERE station_id = ${quote(stationId)} AND parameter_code = ${quote(parameterCode)}
    ORDER BY sampling_date
  `, { dates: true });
}

// The sampling dates of one station, with how many parameters each one carries.
async function sampleHistory(stationId) {
  return query(`
    SELECT sampling_date, any_value(campaign_name) AS campaign_name, count(DISTINCT parameter_code) AS parameters,
           count(*) FILTER (WHERE ${MEASURED}) AS measured
    FROM observations WHERE station_id = ${quote(stationId)}
    GROUP BY sampling_date ORDER BY sampling_date
  `, { dates: true });
}

function valueCell(row, unit) {
  const text = escapeHtml(valueText(row, { unit }));
  // A result without a value of its own is greyed: below a limit, or recorded as 0.
  return row.qualifier === "EQUAL" && row.numeric_value > 0 ? text : `<em>${text}</em>`;
}

export function levelOf(row, limit) {
  return row.qualifier === "EQUAL" ? exceedanceLevel(row.numeric_value, limit.p95, limit.p99) : "";
}

// The chart of one series. The map card draws it at scale 1; the downloaded image draws the
// same chart larger, with its own legend, so scale grows the fonts, lines and points.
export function seriesChartConfig({ rows, label, unit, limit }, { scale = 1, legend = true, current = null } = {}) {
  // The open result is ringed in ink on the card, so the chart shows where the record is.
  const isCurrent = (row) => current != null && row.result_id === current;
  const labels = rows.map((row) => formatDate(row.sampling_date) || "Unknown");
  const measured = rows.map((row) => (row.qualifier === "EQUAL" && row.numeric_value > 0 ? Number(row.numeric_value) : null));
  const limits = rows.map((row) => (row.qualifier === "LESS_THAN" ? Number(row.reported_limit) : null));
  const values = measured.filter((value) => value != null);
  // Concentrations spanning orders of magnitude are unreadable on a linear axis.
  const log = values.length > 1 && Math.max(...values) / Math.min(...values) > 100;
  const font = { size: 9 * scale };
  return {
    data: {
      labels,
      datasets: [
        {
          type: "line", label: unit ? `${label} (${unit})` : label, data: measured, borderColor: COLOR, borderWidth: 2.8 * scale, tension: 0.25, spanGaps: true,
          backgroundColor: rows.map((row) => LEVELS[levelOf(row, limit)] || COLOR),
          pointRadius: rows.map((row) => (isCurrent(row) ? 6 : levelOf(row, limit) ? 5 : 3.5) * scale),
          pointBorderColor: rows.map((row) => (isCurrent(row) ? CURRENT_COLOR : COLOR)),
          pointBorderWidth: rows.map((row) => (isCurrent(row) ? 2.5 : 1) * scale),
        },
        // Below-limit results have no value; they are drawn as hollow marks at their limit.
        {
          type: "scatter", label: "Below limit", data: limits, backgroundColor: "rgba(0,0,0,0)", pointStyle: "triangle",
          borderColor: rows.map((row) => (isCurrent(row) ? CURRENT_COLOR : LIMIT_COLOR)),
          pointRadius: rows.map((row) => (isCurrent(row) ? 6 : 4) * scale),
          borderWidth: rows.map((row) => (isCurrent(row) ? 2.5 : 1) * scale),
        },
      ],
    },
    options: {
      maintainAspectRatio: false,
      animation: false,
      // The card title already names the element, so the legend only appears when there are
      // below-limit marks to explain.
      plugins: { legend: { display: legend && limits.some((value) => value != null), labels: { boxWidth: 10, font } } },
      scales: {
        x: { ticks: { font, maxRotation: 45, autoSkipPadding: 12 * scale } },
        y: log
          ? { type: "logarithmic", ticks: { font, callback: (value) => (Math.abs(Math.log10(value) - Math.round(Math.log10(value))) < 1e-9 ? formatNumber(value) : "") } }
          : { ticks: { font }, beginAtZero: true },
      },
    },
  };
}

function visibleRows() {
  return series.rows.slice(period.from, period.to + 1);
}

function currentIndex() {
  return series.rows.findIndex((item) => item.result_id === series.row.result_id);
}

function drawChart() {
  chart?.destroy();
  const rows = visibleRows();
  const config = seriesChartConfig({ ...series, rows }, { current: series.row.result_id });
  chart = new Chart($("seriesCanvas"), {
    ...config,
    options: {
      ...config.options,
      responsive: true,
      // A point on the chart opens the record of that date.
      onClick: (_event, elements) => {
        if (elements.length) openResult(rows[elements[0].index].result_id);
      },
      onHover: (event, elements) => {
        event.native.target.style.cursor = elements.length ? "pointer" : "";
      },
    },
  });
}

// The period bar under the chart: its handles, the ticks of the dates, and the stepper.
function renderTimeline() {
  const { rows } = series;
  const last = rows.length - 1;
  const index = currentIndex();
  const position = (value) => `${(100 * value) / last}%`;
  for (const [id, value] of [["seriesFrom", period.from], ["seriesTo", period.to]]) Object.assign($(id), { min: 0, max: last, step: 1, value });
  $("seriesSlider").style.setProperty("--from", position(period.from));
  $("seriesSlider").style.setProperty("--to", position(period.to));
  $("seriesFromLabel").textContent = formatDate(rows[period.from].sampling_date) || "–";
  $("seriesToLabel").textContent = formatDate(rows[period.to].sampling_date) || "–";
  // The bar stays a plain line; only the open date is marked on it.
  $("seriesTicks").innerHTML = index >= 0 ? `<i class="current" style="--at:${index / last}"></i>` : "";
  $("seriesCurrentDate").textContent = formatDate(series.row.sampling_date) || "Unknown date";
  $("seriesPrevious").disabled = stepTarget(-1) == null;
  $("seriesNext").disabled = stepTarget(1) == null;
  const shown = period.to - period.from + 1;
  const trimmed = shown < rows.length;
  $("seriesPeriod").textContent = trimmed ? `${shown} of ${rows.length} dates` : `${rows.length} dates`;
  $("seriesReset").hidden = !trimmed;
  // The list of dates in the record greys the ones left out of the period.
  for (const item of document.querySelectorAll(".station-history .history-row[data-index]")) {
    const i = Number(item.dataset.index);
    item.classList.toggle("outside-period", i < period.from || i > period.to);
  }
}

function showSeries(current) {
  series = current;
  const key = `${current.row.station_id}|${current.row.parameter_code}`;
  const last = current.rows.length - 1;
  if (period?.key !== key || period.to > last) period = { key, from: 0, to: last };
  // A record opened outside the period, from the map or the list, widens it to include it.
  const index = currentIndex();
  if (index >= 0) Object.assign(period, { from: Math.min(period.from, index), to: Math.max(period.to, index) });
  drawChart();
  renderTimeline();
}

function setPeriod(from, to) {
  Object.assign(period, { from, to });
  drawChart();
  renderTimeline();
}

// The previous or next date inside the period. When the open record was left out of the
// period, the step lands on the nearest end of it.
function stepTarget(direction) {
  const index = currentIndex();
  const target = direction < 0 ? Math.min(index - 1, period.to) : Math.max(index + 1, period.from);
  return target >= period.from && target <= period.to ? target : null;
}

function step(direction) {
  const target = stepTarget(direction);
  if (target != null) openResult(series.rows[target].result_id);
}

// Fills the placeholder in the open record with this station's series. sampleView lists the
// sampling dates instead, because no single element is open.
export async function renderHistory(target, row, { sampleView = false } = {}) {
  const label = parameterLabel(row.parameter_code, row.parameter_name);
  const rows = sampleView ? await sampleHistory(row.station_id) : await elementHistory(row.station_id, row.parameter_code);
  // A station with a single date has no series, even when two sources reported that date:
  // clear the placeholder and the map card.
  const dates = new Set(rows.map((item) => formatDate(item.sampling_date))).size;
  if (rows.length < 2 || dates < 2) {
    target.outerHTML = "";
    destroyHistoryChart();
    return "";
  }

  const unit = rows.find((item) => item.reported_unit)?.reported_unit || row.reported_unit;
  const limit = sampleView ? {} : (await parameterLimits()).get(row.parameter_code) || {};
  const title = sampleView
    ? `This station over time · ${rows.length} sampling dates`
    : `This station over time · ${label} · ${rows.length} results`;
  const list = rows.map((item, index) => {
    const current = item.result_id === row.result_id;
    const value = sampleView ? `${item.parameters} parameters` : valueCell(item, unit);
    const level = sampleView ? "" : levelOf(item, limit);
    // Every date opens its own record, so the other measurements of the station are one click away.
    const tag = sampleView ? "div" : "button";
    const attributes = sampleView ? "" : ` type="button" data-result="${escapeHtml(item.result_id)}"`;
    return `<${tag} class="history-row${current ? " current" : ""}${level ? ` level-${level}` : ""}" data-index="${index}"${attributes}><span>${formatDate(item.sampling_date) || "Unknown date"}</span>`
      + `<strong>${value}</strong><small title="${escapeHtml(item.campaign_name || "")}">${escapeHtml(item.campaign_name || "")}</small></${tag}>`;
  });
  target.outerHTML = `<section class="detail-section station-history"><h3>${escapeHtml(title)}</h3>`
    + `<div class="history-rows">${list.join("")}</div></section>`;
  // The chart itself sits on the map, above the selection statistics.
  destroyHistoryChart();
  if (!sampleView) {
    $("seriesTitle").textContent = `${row.station_code || "Station"} · ${label} over time`;
    showSeries({ row, rows, label, unit, limit });
    $("seriesCard").hidden = false;
  }
  return title;
}

// The series as the card shows it, trimmed to its period, for the downloads.
export function currentSeries() {
  return series && { ...series, rows: visibleRows(), total: series.rows.length };
}

// Closing the record forgets the period, so the next station starts from its whole series.
export function forgetSeriesPeriod() {
  period = null;
}

export function bindSeriesTimeline(open) {
  openResult = open;
  // The handles push each other, as on the period filter of the explorer.
  $("seriesFrom").addEventListener("input", (event) => {
    const value = Number(event.target.value);
    setPeriod(value, Math.max(value, period.to));
  });
  $("seriesTo").addEventListener("input", (event) => {
    const value = Number(event.target.value);
    setPeriod(Math.min(value, period.from), value);
  });
  $("seriesReset").addEventListener("click", () => setPeriod(0, series.rows.length - 1));
  $("seriesPrevious").addEventListener("click", () => step(-1));
  $("seriesNext").addEventListener("click", () => step(1));
}
