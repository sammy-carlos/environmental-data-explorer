// Single source of truth shared by the panels, the map and the assistant.
export const state = {
  dataset: null,
  overlays: {},
  assistant: null,
  session: null,
  db: null,
  ready: false,
  view: "data",
  years: { first: null, last: null },
  filters: { parameter: null, quality: "VALID", from: null, to: null, repeated: false },
  mode: "filters",
  sql: { query: null, parameter: null, initial: "" },
  table: { page: 1, pageSize: 50, total: 0, rows: [] },
  area: { active: false, stations: 0, byAssistant: false },
  map: { features: [], mode: "points", colorField: "concentration", baseZoom: 10, basemap: "light", agentShowing: false },
  scale: { p99: null, stops: null, unit: null },
};

export function isAllElements() {
  return state.mode !== "sql" && state.filters.parameter === "all";
}

export function currentParameter() {
  return state.mode === "sql" ? state.sql.parameter : state.filters.parameter;
}
