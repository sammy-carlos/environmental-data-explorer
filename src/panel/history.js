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
const COLOR = "#1c5b4f";
const LIMIT_COLOR = "#8a94a6";
// The same amber and red the map uses for values above the dataset P95 and P99.
const LEVELS = { p95: "#e0a400", p99: "#d62828" };
let chart = null;

export function destroyHistoryChart() {
  chart?.destroy();
  chart = null;
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

function levelOf(row, limit) {
  return row.qualifier === "EQUAL" ? exceedanceLevel(row.numeric_value, limit.p95, limit.p99) : "";
}

function drawChart(canvas, rows, label, unit, limit) {
  const labels = rows.map((row) => formatDate(row.sampling_date) || "Unknown");
  const measured = rows.map((row) => (row.qualifier === "EQUAL" && row.numeric_value > 0 ? Number(row.numeric_value) : null));
  const limits = rows.map((row) => (row.qualifier === "LESS_THAN" ? Number(row.reported_limit) : null));
  const values = measured.filter((value) => value != null);
  // Concentrations spanning orders of magnitude are unreadable on a linear axis.
  const log = values.length > 1 && Math.max(...values) / Math.min(...values) > 100;
  destroyHistoryChart();
  chart = new Chart(canvas, {
    data: {
      labels,
      datasets: [
        {
          type: "line", label: unit ? `${label} (${unit})` : label, data: measured, borderColor: COLOR, borderWidth: 2.8, tension: 0.25, spanGaps: true,
          backgroundColor: rows.map((row) => LEVELS[levelOf(row, limit)] || COLOR),
          pointRadius: rows.map((row) => (levelOf(row, limit) ? 5 : 3.5)),
        },
        // Below-limit results have no value; they are drawn as hollow marks at their limit.
        { type: "scatter", label: "Below limit", data: limits, borderColor: LIMIT_COLOR, backgroundColor: "rgba(0,0,0,0)", pointStyle: "triangle", pointRadius: 4 },
      ],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      animation: false,
      // The card title already names the element, so the legend only appears when there are
      // below-limit marks to explain.
      plugins: { legend: { display: limits.some((value) => value != null), labels: { boxWidth: 10, font: { size: 9 } } } },
      scales: {
        x: { ticks: { font: { size: 9 }, maxRotation: 45, autoSkipPadding: 12 } },
        y: log
          ? { type: "logarithmic", ticks: { font: { size: 9 }, callback: (value) => (Math.abs(Math.log10(value) - Math.round(Math.log10(value))) < 1e-9 ? formatNumber(value) : "") } }
          : { ticks: { font: { size: 9 } }, beginAtZero: true },
      },
    },
  });
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
  const list = rows.map((item) => {
    const current = item.result_id === row.result_id;
    const value = sampleView ? `${item.parameters} parameters` : valueCell(item, unit);
    const level = sampleView ? "" : levelOf(item, limit);
    // Every date opens its own record, so the other measurements of the station are one click away.
    const tag = sampleView ? "div" : "button";
    const attributes = sampleView ? "" : ` type="button" data-result="${escapeHtml(item.result_id)}"`;
    return `<${tag} class="history-row${current ? " current" : ""}${level ? ` level-${level}` : ""}"${attributes}><span>${formatDate(item.sampling_date) || "Unknown date"}</span>`
      + `<strong>${value}</strong><small title="${escapeHtml(item.campaign_name || "")}">${escapeHtml(item.campaign_name || "")}</small></${tag}>`;
  });
  target.outerHTML = `<section class="detail-section station-history"><h3>${escapeHtml(title)}</h3>`
    + `<div class="history-rows">${list.join("")}</div></section>`;
  // The chart itself sits on the map, above the selection statistics.
  destroyHistoryChart();
  if (!sampleView) {
    $("seriesTitle").textContent = `${row.station_code || "Station"} · ${label} over time`;
    drawChart($("seriesCanvas"), rows, label, unit, limit);
    $("seriesCard").hidden = false;
  }
  return title;
}
