import { state } from "../state.js";
import { downloadFile, formatDate, formatNumber, toCsv } from "../lib/format.js";
import { LEVELS, SERIES_COLORS, currentSeries, levelOf, seriesChartConfig } from "./history.js";

const $ = (id) => document.getElementById(id);

// The downloaded chart has to read on its own, in a report or a message, so it carries what
// the map card leaves to its surroundings: the station and element in a title, what the
// colours mean, where the data comes from, and the product logo.
const WIDTH = 1200;
const HEIGHT = 700;
const RATIO = 2;
const PAD = 48;
const INK = "#18201d";
const MUTED = "#69736d";
const LINE = "#d7dcd5";
const SANS = "Manrope, system-ui, sans-serif";
const MONO = '"DM Mono", ui-monospace, monospace';

function trimmed({ rows, total }) {
  return total != null && rows.length < total;
}

// A trimmed series names its period, so two downloads of the same station do not collide.
function fileStem(series) {
  const { row, rows } = series;
  const code = String(row.parameter_code || "element");
  const element = code.charAt(0).toUpperCase() + code.slice(1);
  const period = trimmed(series) ? `${formatDate(rows[0].sampling_date)}_${formatDate(rows[rows.length - 1].sampling_date)}` : "over-time";
  return `${row.station_code || "station"}_${element}_${period}`.replace(/[^\w.-]+/g, "-");
}

// The local date: in the evening in Peru the UTC date is already tomorrow.
function today() {
  const now = new Date();
  return [now.getFullYear(), now.getMonth() + 1, now.getDate()].map((part) => String(part).padStart(2, "0")).join("-");
}

// Percentiles come out of DuckDB with floating point noise (970.3650000000023).
function rounded(value) {
  return value == null ? null : Math.round(Number(value) * 1e4) / 1e4;
}

// An SVG with only a viewBox has no size of its own, and some browsers will not draw it on
// a canvas; the logo is given one before it is loaded.
async function loadLogo() {
  const text = await (await fetch("./assets/kipu360.svg")).text();
  const [, , , width, height] = text.match(/viewBox="([\d.-]+) ([\d.-]+) ([\d.]+) ([\d.]+)"/) || [];
  const sized = width ? text.replace("<svg ", `<svg width="${width}" height="${height}" `) : text;
  const url = URL.createObjectURL(new Blob([sized], { type: "image/svg+xml" }));
  try {
    const image = new Image();
    image.src = url;
    await image.decode();
    return image;
  } finally {
    URL.revokeObjectURL(url);
  }
}

// Chart.js draws on a canvas it can measure, so the export chart is laid out off screen.
async function renderChart(series, width, height) {
  const holder = document.createElement("div");
  holder.style.cssText = `position:fixed;left:-10000px;top:0;width:${width}px;height:${height}px;`;
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  holder.append(canvas);
  document.body.append(holder);
  const config = seriesChartConfig(series, { scale: 1.55, legend: false });
  // The image is wide enough to label every date of a usual series.
  config.options.scales.x.ticks.autoSkip = series.rows.length > 30;
  const chart = new Chart(canvas, { ...config, options: { ...config.options, responsive: false, devicePixelRatio: RATIO } });
  return { canvas, done: () => { chart.destroy(); holder.remove(); } };
}

// The legend names only what the chart shows: the values, and the P95, P99 and below-limit
// marks when at least one date has them.
function legendItems({ rows, label, unit, limit }) {
  const items = [{ kind: "value", color: SERIES_COLORS.value, text: unit ? `${label}, ${unit}` : label }];
  const levels = new Set(rows.map((row) => levelOf(row, limit)));
  const threshold = (value) => (unit ? `${formatNumber(value)} ${unit}` : formatNumber(value));
  if (levels.has("p95")) items.push({ kind: "dot", color: LEVELS.p95, text: `≥ P95 of the dataset (${threshold(limit.p95)})` });
  if (levels.has("p99")) items.push({ kind: "dot", color: LEVELS.p99, text: `≥ P99 of the dataset (${threshold(limit.p99)})` });
  if (rows.some((row) => row.qualifier === "LESS_THAN")) items.push({ kind: "limit", color: SERIES_COLORS.limit, text: "Below detection limit, drawn at the limit" });
  return items;
}

function drawLegend(context, items, x, y) {
  context.font = `500 14px ${SANS}`;
  context.textBaseline = "middle";
  for (const item of items) {
    context.fillStyle = item.color;
    context.strokeStyle = item.color;
    if (item.kind === "value") {
      context.lineWidth = 3;
      context.beginPath();
      context.moveTo(x, y);
      context.lineTo(x + 22, y);
      context.stroke();
      context.beginPath();
      context.arc(x + 11, y, 4.5, 0, 2 * Math.PI);
      context.fill();
      x += 30;
    } else if (item.kind === "dot") {
      context.beginPath();
      context.arc(x + 6, y, 6, 0, 2 * Math.PI);
      context.fill();
      x += 18;
    } else {
      context.lineWidth = 1.6;
      context.beginPath();
      context.moveTo(x + 6, y - 6);
      context.lineTo(x + 12, y + 5);
      context.lineTo(x, y + 5);
      context.closePath();
      context.stroke();
      x += 20;
    }
    context.fillStyle = INK;
    context.fillText(item.text, x, y);
    x += context.measureText(item.text).width + 28;
  }
}

async function seriesImage(series) {
  const { row, rows, label, unit } = series;
  await Promise.all([document.fonts.load(`700 26px ${SANS}`), document.fonts.load(`500 14px ${SANS}`), document.fonts.load(`13px ${MONO}`)]);
  const [logo, chart] = await Promise.all([loadLogo(), renderChart(series, WIDTH - 2 * PAD + 16, 440)]);
  try {
    const canvas = document.createElement("canvas");
    canvas.width = WIDTH * RATIO;
    canvas.height = HEIGHT * RATIO;
    const context = canvas.getContext("2d");
    context.scale(RATIO, RATIO);
    context.fillStyle = "#fff";
    context.fillRect(0, 0, WIDTH, HEIGHT);

    // Title on the left, the product logo in the right corner.
    context.fillStyle = INK;
    context.textBaseline = "alphabetic";
    context.font = `700 26px ${SANS}`;
    context.fillText(`${row.station_code || "Station"} · ${label} over time`, PAD, 62);
    const dates = rows.map((item) => formatDate(item.sampling_date)).filter(Boolean);
    const span = dates.length ? `${dates[0]} to ${dates[dates.length - 1]}` : "";
    context.fillStyle = MUTED;
    context.font = `13px ${MONO}`;
    const count = trimmed(series) ? `${rows.length} of ${series.total} results` : `${rows.length} results`;
    context.fillText([count, span, unit].filter(Boolean).join("  ·  "), PAD, 90);
    const logoWidth = 176;
    const logoHeight = logoWidth * logo.naturalHeight / logo.naturalWidth;
    context.drawImage(logo, WIDTH - PAD - logoWidth, 40, logoWidth, logoHeight);

    context.fillStyle = LINE;
    context.fillRect(PAD, 112, WIDTH - 2 * PAD, 1);
    context.drawImage(chart.canvas, PAD - 8, 128, WIDTH - 2 * PAD + 16, 440);
    drawLegend(context, legendItems(series), PAD, 600);

    context.fillStyle = LINE;
    context.fillRect(PAD, HEIGHT - 56, WIDTH - 2 * PAD, 1);
    context.fillStyle = MUTED;
    context.font = `12px ${MONO}`;
    const dataset = [state.dataset?.title, state.dataset?.revision].filter(Boolean).join(" ");
    context.fillText(`Environmental Data Explorer  ·  ${dataset} dataset  ·  downloaded ${today()}`, PAD, HEIGHT - 26);
    return await new Promise((resolve) => canvas.toBlob(resolve, "image/png"));
  } finally {
    chart.done();
  }
}

export async function downloadSeriesPng(series) {
  const button = $("seriesPng");
  button.disabled = true;
  try {
    downloadFile(`${fileStem(series)}.png`, await seriesImage(series), "image/png");
  } finally {
    button.disabled = false;
  }
}

// One line per result, with the dataset P95 and P99 so the levels can be checked.
export function downloadSeriesCsv(series) {
  const { row, rows, label, unit, limit } = series;
  const columns = ["station_code", "parameter_code", "parameter", "sampling_date", "reported_value", "numeric_value", "qualifier", "reported_limit", "unit",
    "level", "dataset_p95", "dataset_p99", "quality_status", "campaign_name", "result_id"];
  const lines = rows.map((item) => ({
    station_code: row.station_code,
    parameter_code: row.parameter_code,
    parameter: label,
    sampling_date: formatDate(item.sampling_date),
    reported_value: item.reported_value,
    numeric_value: item.numeric_value,
    qualifier: item.qualifier,
    reported_limit: item.reported_limit,
    unit: item.reported_unit || unit,
    level: levelOf(item, limit).toUpperCase(),
    dataset_p95: rounded(limit.p95),
    dataset_p99: rounded(limit.p99),
    quality_status: item.quality_status,
    campaign_name: item.campaign_name,
    result_id: item.result_id,
  }));
  downloadFile(`${fileStem(series)}.csv`, toCsv(columns, lines), "text/csv;charset=utf-8");
}

export function bindSeriesDownloads() {
  $("seriesPng").addEventListener("click", () => {
    const series = currentSeries();
    if (series) downloadSeriesPng(series);
  });
  $("seriesCsv").addEventListener("click", () => {
    const series = currentSeries();
    if (series) downloadSeriesCsv(series);
  });
}
