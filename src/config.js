import { state } from "./state.js";

export async function loadConfig(datasetId) {
  const [datasets, assistant] = await Promise.all([
    fetch("config/datasets.json", { cache: "no-cache" }).then((response) => response.json()),
    fetch("config/assistant.json", { cache: "no-cache" }).then((response) => response.json()),
  ]);
  const id = datasets.datasets[datasetId] ? datasetId : datasets.default;
  state.dataset = { id, ...datasets.datasets[id] };
  state.assistant = assistant;
  state.filters.parameter = state.dataset.defaultParameter;
}

export function parameterLabel(code, name) {
  if (code === "all") return "All elements";
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
