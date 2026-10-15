import { currentParameter, isAllElements, state } from "../state.js";

// A magnitude runs from light green to deep teal (CARTO Emrld), lightness rising evenly so
// it says how much, not whether that is good or bad. The lightest step is pale on the grey
// basemap, so every point keeps a white edge.
export const PALETTE = ["#a8dd93", "#6cc08b", "#3d9a84", "#19696f", "#0b4a5a"];
export const YEAR_PALETTE = PALETTE;
// The darkest step marks the top 5 %; the top 1 % of a metal of concern is drawn larger,
// as geochemical atlases mark anomalies by size rather than by colour.
export const TOP = PALETTE[4];
// Red is kept for one meaning only: above a reference value somebody gave.
export const ABOVE_REFERENCE = ["#e37272", "#d03b3b", "#a82b2b", "#7c1d1d", "#4f1010"];
// Years and campaigns: eight hues in a fixed order that keeps neighbours apart for
// colour-blind readers; any further category is grey.
export const CATEGORIES = ["#2a78d6", "#eb6834", "#1baf7a", "#eda100", "#e87ba4", "#008300", "#4a3aa7", "#e34948"];
export const OTHER_CATEGORY = "#a3a39d";

// Points shrink as the user zooms in so nearby stations separate, and grow when
// zooming out so they stay visible. baseZoom is the zoom that frames the dataset.
export const POINT_SIZE = { base: 4.5, growth: 0.74, min: 3.6, max: 7.5 };
export const EXCEEDANCE_SIZE = { base: 7.6, growth: 0.76, min: 6.2, max: 11.5 };

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
  return CATEGORIES[index] ?? OTHER_CATEGORY;
}

// High values get the top 5 % and top 1 % marks only for the metals of concern, where a
// high value is a reason to look. pH, nutrients or texture are shown on the ramp alone.
export function marksHighValues() {
  return !isAllElements() && state.map.colorField === "concentration" && (state.dataset.contaminants ?? []).includes(currentParameter());
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
    return ["match", ["get", field], ...list.flatMap((category, index) => [category, categoricalColor(index)]), OTHER_CATEGORY];
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
