import { state } from "../state.js";
import { writeUrlState } from "../url-state.js";
import { map } from "../map/map.js";
import { setAssistantView } from "../map/assistant-layer.js";

const $ = (id) => document.getElementById(id);
const STEPS = ["Starting DuckDB", "Loading data", "Building tables", "Preparing map", "Rendering map"];

export function loaderStep(label) {
  const loader = $("appLoader");
  if (!loader || loader.classList.contains("done")) return;
  const step = STEPS.indexOf(label);
  $("loaderLabel").textContent = label;
  if (step >= 0) {
    $("loaderBar").style.width = `${(step + 1) * 100 / STEPS.length}%`;
    $("loaderStep").textContent = `${step + 1} / ${STEPS.length}`;
  }
}

export function loaderFailed(message) {
  const loader = $("appLoader");
  if (!loader) return;
  loader.classList.add("failed");
  $("loaderLabel").textContent = message;
  $("loaderRetry").hidden = false;
}

export function hideLoader() {
  const loader = $("appLoader");
  loader.classList.add("done");
  loader.setAttribute("aria-busy", "false");
  window.setTimeout(() => loader.remove(), 600);
}

export function panelIsOpen() {
  return !document.querySelector(".workspace").classList.contains("panel-closed");
}

export function setPanel(open) {
  document.querySelector(".workspace").classList.toggle("panel-closed", !open);
  $("panelToggle").setAttribute("aria-expanded", String(open));
  window.setTimeout(() => map?.resize(), 320);
}

export function showTab(name) {
  state.view = name;
  document.querySelectorAll(".tabs button").forEach((button) => button.classList.toggle("active", button.dataset.tab === name));
  document.querySelectorAll(".tab-view").forEach((view) => view.classList.toggle("active", view.id === `${name}Tab`));
  if (state.ready) {
    setAssistantView(name === "assistant");
    writeUrlState();
  }
}

export function bindLayout() {
  $("panelToggle").addEventListener("click", () => setPanel(!panelIsOpen()));
  $("closePanel").addEventListener("click", () => setPanel(false));
  $("loaderRetry").addEventListener("click", () => window.location.reload());
  document.querySelectorAll(".tabs button").forEach((button) => button.addEventListener("click", () => showTab(button.dataset.tab)));
}
