import { state } from "./state.js";

// Views are shareable: ?element=zn&quality=VALID&years=2010-2026&view=assistant&basemap=satellite&mode=density
const QUALITIES = new Set(["VALID", "all", "PENDING_REVIEW", "EXCLUDED_FROM_ANALYSIS"]);

export function readUrlState() {
  const params = new URLSearchParams(window.location.search);
  const element = params.get("element");
  if (element && (element === "all" || state.dataset.parameters[element])) state.filters.parameter = element;
  if (QUALITIES.has(params.get("quality"))) state.filters.quality = params.get("quality");
  const years = /^(\d{4})-(\d{4})$/.exec(params.get("years") || "");
  if (years) [state.filters.from, state.filters.to] = [Number(years[1]), Number(years[2])];
  if (params.get("repeat") === "1") state.filters.repeated = true;
  if (params.get("view") === "assistant") state.view = "assistant";
  if (["light", "topo", "satellite"].includes(params.get("basemap"))) state.map.basemap = params.get("basemap");
  if (["points", "density", "clusters"].includes(params.get("mode"))) state.map.mode = params.get("mode");
  return params.get("dataset");
}

export function writeUrlState() {
  const params = new URLSearchParams(window.location.search);
  const set = (key, value, fallback) => (value == null || value === fallback ? params.delete(key) : params.set(key, value));
  set("element", state.filters.parameter, state.dataset.defaultParameter);
  set("quality", state.filters.quality, "VALID");
  const fullRange = state.filters.from === state.years.first && state.filters.to === state.years.last;
  set("years", fullRange || state.filters.from == null ? null : `${state.filters.from}-${state.filters.to}`);
  set("repeat", state.filters.repeated ? "1" : null);
  set("view", state.view === "assistant" ? "assistant" : null);
  set("basemap", state.map.basemap, "light");
  set("mode", state.map.mode, "points");
  const query = params.toString();
  window.history.replaceState(null, "", `${window.location.pathname}${query ? `?${query}` : ""}`);
}
