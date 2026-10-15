import { currentParameter, isAllElements, state } from "../state.js";
import { parameterLabel } from "../config.js";
import { escapeHtml } from "../lib/format.js";
import { formatNumber, plural } from "../lib/format.js";
import { exceedanceLevel } from "../data/statistics.js";
import { OTHER_CATEGORY, PALETTE, YEAR_PALETTE, categoricalColor, categories, marksHighValues, percentile, yearRange } from "../map/style.js";

const $ = (id) => document.getElementById(id);
let lastSummary = null;

export function renderLegend() {
  const all = isAllElements();
  const count = state.map.features.length;
  $("mapCount").textContent = all ? plural(count, "sample") : plural(count, "measurement");
  document.querySelector(".map-cards").classList.toggle("all-elements", all);
  $("yearCard").hidden = !all;
  // In SQL mode the element comes from the query, so the picker only names it.
  const picker = $("mapParameter");
  picker.disabled = state.mode === "sql";
  if (state.mode === "sql") picker.innerHTML = `<option>${escapeHtml(parameterLabel(currentParameter()))} · SQL</option>`;
  else picker.value = state.filters.parameter;

  if (all) {
    const [first, last] = yearRange();
    $("yearRamp").style.background = `linear-gradient(90deg,${YEAR_PALETTE.join(",")})`;
    $("yearMin").textContent = first || "–";
    $("yearMax").textContent = last || "–";
    $("yearSamples").textContent = plural(count, "sample");
  } else if (state.map.colorField === "concentration") {
    const stops = state.scale.stops ?? [0.05, 0.25, 0.5, 0.75, 0.95].map(percentile);
    $("legendTitle").textContent = state.scale.unit || "Unit not reported";
    $("legendRamp").style.background = `linear-gradient(90deg,${PALETTE.join(",")})`;
    setLegendValues(["Low", formatNumber(stops[0])], ["Median", formatNumber(stops[2])], ["Top 5 %", formatNumber(stops[4])]);
  } else {
    const field = state.map.colorField;
    const list = categories(field);
    const swatches = [...Array.from({ length: Math.min(8, Math.max(1, list.length)) }, (_, index) => categoricalColor(index)), ...(list.length > 8 ? [OTHER_CATEGORY] : [])];
    const step = 100 / swatches.length;
    $("legendRamp").style.background = `linear-gradient(90deg,${swatches.map((color, index) => `${color} ${index * step}% ${(index + 1) * step}%`).join(",")})`;
    $("legendTitle").textContent = field === "year" ? "Sampling year · categories" : "Campaign · categories";
    setLegendValues(["First", list[0] || "–"], ["Categories", `${plural(list.length, field === "year" ? "year" : "campaign")}${list.length > 8 ? ", 9th on in grey" : ""}`], ["Last", list.at(-1) || "–"]);
  }
  $("legendTop").hidden = !marksHighValues();

  highlightStatistics();
}

function setLegendValues(...pairs) {
  ["Min", "Mid", "Max"].forEach((slot, index) => {
    $(`legend${slot}Label`).textContent = pairs[index][0];
    $(`legend${slot}`).textContent = pairs[index][1];
  });
}

const STATISTICS = { overviewMinimum: "minimum", overviewMean: "mean", overviewMedian: "median", overviewP95: "p95", overviewP99: "p99", overviewMaximum: "maximum" };

export function renderStatistics(summary) {
  lastSummary = summary;
  for (const [id, key] of Object.entries(STATISTICS)) $(id).textContent = summary?.[key] == null ? "–" : formatNumber(summary[key]);
  highlightStatistics();
}

// For a metal of concern, a statistic that reaches the dataset P95 or P99 takes the marks
// of the map: the dark teal steps, the darkest at the P99.
function highlightStatistics() {
  if (!lastSummary) return;
  const marked = marksHighValues();
  for (const [id, key] of Object.entries(STATISTICS)) {
    const level = marked ? exceedanceLevel(lastSummary[key], state.scale.stops?.[4], state.scale.p99) : "";
    const cell = $(id).parentElement;
    cell.classList.toggle("level-p95", level === "p95");
    cell.classList.toggle("level-p99", level === "p99");
  }
}
