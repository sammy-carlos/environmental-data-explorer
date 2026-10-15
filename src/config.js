import { state } from "./state.js";

export async function loadConfig(datasetId) {
  const [datasets, assistant] = await Promise.all([
    fetch("config/datasets.json", { cache: "no-cache" }).then((response) => response.json()),
    fetch("config/assistant.json", { cache: "no-cache" }).then((response) => response.json()),
  ]);
  state.datasets = datasets.datasets;
  state.defaultDataset = datasets.default;
  state.frame = datasets.frame || null;
  state.overlays = datasets.overlays || {};
  state.assistant = assistant;
  selectDataset(datasets.datasets[datasetId] ? datasetId : datasets.default);
}

// Makes a dataset the current one and starts its selection from the defaults. Its tables
// are opened by openDatabase, which keeps each dataset loaded once it has been opened.
export function selectDataset(id) {
  state.dataset = { id, ...state.datasets[id] };
  Object.assign(state.filters, { parameter: state.dataset.defaultParameter, quality: "VALID", from: null, to: null, repeated: false });
  state.mode = "filters";
  state.table.page = 1;
}

export function parameterLabel(code, name) {
  if (code === "all") return state.dataset.allParametersLabel || "All elements";
  return state.dataset.parameters[code] || name || code;
}

export function qualityReasons(rules) {
  return String(rules || "")
    .split(",")
    .filter(Boolean)
    .map((rule) => state.dataset.qualityReasons[rule] || rule.replaceAll("_", " "));
}

export function shortStatus(status) {
  return { VALID: "Valid", WARNING: "Warning", PENDING_REVIEW: "Pending", EXCLUDED_FROM_ANALYSIS: "Excluded", INVALID: "Invalid" }[status] || status;
}
