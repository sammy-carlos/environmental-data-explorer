import { currentParameter, state } from "./state.js";
import { loadConfig } from "./config.js";
import { readUrlState, writeUrlState } from "./url-state.js";
import { bindSignOut, signIn } from "./auth/login.js";
import { useProjection } from "./lib/geo.js";
import { openDatabase } from "./data/database.js";
import { loadScale, yearBounds } from "./data/statistics.js";
import { createMap, map, mapReady } from "./map/map.js";
import { addDataLayers, applyStyling, bindMapToolbar, selectionFeatures } from "./map/layers.js";
import { addAssistantLayers, setAssistantView } from "./map/assistant-layer.js";
import { bindAreas } from "./map/areas.js";
import { bindPopups } from "./map/popups.js";
import { addCatchmentLayers } from "./map/catchment.js";
import { addGeologyLayers } from "./map/geology.js";
import { bindLayout, hideLoader, loaderFailed, loaderStep, showTab } from "./panel/layout.js";
import { bindExplorer, refreshData, setupFilters } from "./panel/explorer.js";
import { bindRecord } from "./panel/record.js";
import { bindChat } from "./assistant/chat.js";
import { registerWebMcpTools } from "./assistant/webmcp.js";

async function waitForTiles(limit = 4000) {
  const started = performance.now();
  while (!(map.isStyleLoaded() && map.areTilesLoaded()) && performance.now() - started < limit) {
    await new Promise((resolve) => window.setTimeout(resolve, 80));
  }
}

function datasetUrl(id) {
  const url = new URL(window.location.href);
  url.search = "";
  url.searchParams.set("dataset", id);
  return `${url.pathname}${url.search}`;
}

// The dataset is chosen in the central strip. Changing it reloads the same explorer
// with ?dataset=<id>; it never opens a second page.
function renderDatasetSelect() {
  const select = document.getElementById("datasetSelect");
  select.replaceChildren(...Object.entries(state.datasets).map(([id, dataset]) => new Option(dataset.title, id)));
  select.value = state.dataset.id;
  select.addEventListener("change", () => window.location.assign(datasetUrl(select.value)));
}

function configureDatasetFeatures() {
  const assistantEnabled = state.dataset.features?.assistant !== false;
  document.body.dataset.datasetProfile = state.dataset.profile || "sediments";
  document.getElementById("assistantTabButton").hidden = !assistantEnabled;
  if (!assistantEnabled && state.view === "assistant") state.view = "data";
  return assistantEnabled;
}

async function start() {
  const datasetId = new URLSearchParams(window.location.search).get("dataset");
  await loadConfig(datasetId);
  readUrlState();
  useProjection(state.dataset.projection);
  renderDatasetSelect();
  const assistantEnabled = configureDatasetFeatures();
  bindLayout();
  showTab(state.view);

  state.session = await signIn();
  bindSignOut();
  if (assistantEnabled) bindChat();

  try {
    loaderStep("Starting DuckDB");
    createMap();
    await openDatabase(loaderStep);
    await yearBounds();
    await setupFilters();
    bindExplorer();
    bindRecord();

    loaderStep("Preparing map");
    await refreshData();
    const [features] = await Promise.all([selectionFeatures(), loadScale(currentParameter()), mapReady]);
    addDataLayers(features);
    addAssistantLayers();
    if (state.dataset.features?.catchment !== false) addCatchmentLayers();
    // The geology overlay loads on its own; the map is usable without it.
    addGeologyLayers().catch((error) => console.warn("Geology overlay unavailable:", error));
    applyStyling();
    bindMapToolbar();
    bindAreas();
    bindPopups();

    loaderStep("Rendering map");
    await waitForTiles();
    state.ready = true;
    setAssistantView(assistantEnabled && state.view === "assistant");
    writeUrlState();
    if (assistantEnabled) registerWebMcpTools();
    hideLoader();
  } catch (error) {
    console.error(error);
    loaderFailed(error.message || "Data load failed");
  }
}

start();
