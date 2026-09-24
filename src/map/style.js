import { state } from "../state.js";

export const PALETTE = ["#cce4da", "#79b29f", "#236957", "#ce8b2c", "#a34c32"];
export const YEAR_PALETTE = ["#dfe9e3", "#a9cbbd", "#6aa38f", "#2f7563", "#15473e"];

// Points shrink as the user zooms in so nearby stations separate, and grow when
// zooming out so they stay visible. baseZoom is the zoom that frames the dataset.
export const POINT_SIZE = { base: 4.5, growth: 0.74, min: 3.6, max: 7.5 };
export const EXCEEDANCE_SIZE = { base: 5.5, growth: 0.76, min: 4.6, max: 9 };

export function radiusAt(zoom, size, extra = 0) {
  const radius = size.base * size.growth ** (zoom - state.map.baseZoom);
  return Math.min(size.max, Math.max(size.min, radius)) + extra;
}

export function zoomRadius(size, extra = 0) {
  const stops = [];
  for (let step = -4; step <= 6; step += 1) {
    const zoom = state.map.baseZoom + step;
    stops.push(zoom, radiusAt(zoom, size, extra));
  }
  return ["interpolate", ["linear"], ["zoom"], ...stops];
}

export function categoricalColor(index) {
  return `hsl(${Math.round((index * 137.508 + 158) % 360)}, 52%, 43%)`;
}

export function categories(property) {
  const values = state.map.features.map((feature) => feature.properties[property]).filter((value) => value != null && value !== 0);
  return [...new Set(values)].sort((a, b) => (property === "year" ? a - b : String(a).localeCompare(String(b))));
}

export function percentile(fraction) {
  const values = state.map.features.map((feature) => Number(feature.properties.value)).filter(Number.isFinite).sort((a, b) => a - b);
  if (!values.length) return 1;
  return values[Math.min(values.length - 1, Math.floor((values.length - 1) * fraction))];
}

export function rampExpression(stops, property = "value", colors = PALETTE) {
  const expression = ["interpolate", ["linear"], ["to-number", ["get", property], stops[0]]];
  stops.forEach((value, index) => {
    if (expression.length === 3 || value > expression.at(-2)) expression.push(value, colors[index]);
  });
  return expression;
}

export function colorExpression(field) {
  if (field === "year" || field === "campaign") {
    const list = categories(field);
    return ["match", ["get", field], ...list.flatMap((category, index) => [category, categoricalColor(index)]), "#69736d"];
  }
  const stops = state.scale.stops ?? [0.05, 0.25, 0.5, 0.75, 0.95].map(percentile);
  return rampExpression(stops);
}

export function yearRange() {
  const years = state.map.features.map((feature) => feature.properties.year).filter((year) => year > 0);
  return years.length ? [Math.min(...years), Math.max(...years)] : [0, 1];
}

export function yearExpression() {
  const [first, last] = yearRange();
  const span = Math.max(1, last - first);
  return rampExpression(YEAR_PALETTE.map((_, index) => first + span * index / (YEAR_PALETTE.length - 1)), "year", YEAR_PALETTE);
}
