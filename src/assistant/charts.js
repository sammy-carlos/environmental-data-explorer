import { escapeHtml, formatNumber } from "../lib/format.js";

// Charts for the conversation, drawn with Chart.js in the explorer's colours: amber and
// red mark values above the dataset P95 and P99, as on the map.
const COLORS = ["#1c5b4f", "#ce8b2c", "#3a6ea5", "#a34c32", "#6d5a9c", "#2f8f83"];
const LEVELS = { P95: "#e0a400", P99: "#d62828" };
const TICKS = { font: { size: 9 } };

function histogram(values) {
  const min = Math.min(...values);
  const max = Math.max(...values);
  const bins = Math.min(24, Math.max(6, Math.ceil(Math.sqrt(values.length))));
  const width = (max - min) / bins || 1;
  const counts = Array(bins).fill(0);
  for (const value of values) counts[Math.min(bins - 1, Math.floor((value - min) / width))] += 1;
  return { labels: counts.map((_, index) => formatNumber(min + width * index)), counts };
}

function number(value) {
  return value == null || value === "" ? null : Number(value);
}

function datasets({ rows, type, x, y, series, groups, levels }) {
  if (type === "histogram") {
    const { labels, counts } = histogram(rows.map((row) => Number(row[x])).filter(Number.isFinite));
    return { labels, datasets: [{ label: "Results", data: counts, backgroundColor: COLORS[0] }] };
  }
  if (type === "scatter") {
    const points = rows.map((row) => ({ x: number(row[x]), y: number(row[y]) })).filter((point) => Number.isFinite(point.x) && Number.isFinite(point.y));
    return { datasets: [{ label: y, data: points, backgroundColor: "rgba(28,91,79,.45)", pointRadius: 2 }] };
  }
  const style = (index) => ({ backgroundColor: COLORS[index % COLORS.length], borderColor: COLORS[index % COLORS.length], tension: 0.25, pointRadius: 2, spanGaps: true });
  if (series) {
    const labels = [...new Set(rows.map((row) => row[x]))];
    const names = [...new Set(rows.map((row) => row[series]))];
    return {
      labels,
      datasets: names.map((name, index) => {
        const values = new Map(rows.filter((row) => row[series] === name).map((row) => [row[x], number(row[y])]));
        return { label: String(name), data: labels.map((label) => values.get(label) ?? null), ...style(index) };
      }),
    };
  }
  const labels = rows.map((row) => row[x]);
  if (groups) {
    return { labels, datasets: groups.map((group, index) => ({ label: group.label, data: rows.map((row) => number(row[group.column])), ...style(index) })) };
  }
  const dataset = { label: y, data: rows.map((row) => number(row[y])), ...style(0) };
  if (levels) dataset.backgroundColor = rows.map((row) => LEVELS[row[levels]] ?? COLORS[0]);
  return { labels, datasets: [dataset] };
}

// spec: rows, type (line, bar, histogram, scatter), x, y, title, and optionally series
// (one line per value of a column), groups (bars side by side), levels (colour bars
// marked P95 or P99), lines (dashed reference values), log, horizontal, xLabel and yLabel.
export function renderChart(container, spec) {
  const { type, title, lines = [], log = false, horizontal = false, xLabel, yLabel } = spec;
  const figure = document.createElement("figure");
  figure.className = "chat-chart";
  figure.innerHTML = `<strong>${escapeHtml(title)}</strong><canvas></canvas>`;
  // Horizontal bars get a row each, so long names such as river names stay readable.
  if (horizontal) figure.style.setProperty("--chart-height", `${Math.max(160, spec.rows.length * 20 + 40)}px`);
  container.append(figure);

  const data = datasets(spec);
  if (data.labels) {
    for (const line of lines) {
      data.datasets.push({
        type: "line", label: line.label, data: data.labels.map(() => line.value),
        borderColor: LEVELS[line.label] ?? "#69736d", borderDash: [5, 4], borderWidth: 1.2, pointRadius: 0, fill: false,
      });
    }
  }
  const axis = (label, logarithmic) => {
    const scale = { ticks: { ...TICKS, maxRotation: 45 } };
    if (logarithmic) {
      scale.type = "logarithmic";
      // Only powers of ten are labelled, the ticks in between stay unlabelled.
      scale.ticks.callback = (value) => (Math.abs(Math.log10(value) - Math.round(Math.log10(value))) < 1e-9 ? formatNumber(value) : "");
    }
    if (label) scale.title = { display: true, text: label, font: { size: 9 } };
    return scale;
  };
  new Chart(figure.querySelector("canvas"), {
    type: type === "histogram" ? "bar" : type,
    data,
    options: {
      responsive: true,
      maintainAspectRatio: false,
      animation: false,
      indexAxis: horizontal ? "y" : "x",
      plugins: { legend: { display: data.datasets.length > 1, labels: { boxWidth: 10, font: { size: 9 } } } },
      scales: {
        x: type === "scatter" ? { type: "linear", ...axis(xLabel, log) } : axis(xLabel, horizontal && log),
        y: horizontal ? { ticks: { ...TICKS, autoSkip: false } } : axis(yLabel, log),
      },
    },
  });
  return figure;
}
