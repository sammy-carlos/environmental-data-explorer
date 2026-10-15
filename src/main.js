import { currentParameter, state } from "./state.js";
import { loadConfig, selectDataset } from "./config.js";
import { readUrlState, writeUrlState } from "./url-state.js";
import { bindSignOut, signIn } from "./auth/login.js";
import { useProjection } from "./lib/geo.js";
import { openDatabase } from "./data/database.js";
import { loadScale, yearBounds } from "./data/statistics.js";
import { createMap, map, mapReady } from "./map/map.js";
import { addDataLayers, applyStyling, bindMapToolbar, selectionFeatures } from "./map/layers.js";
import { addAssistantLayers, setAssistantView } from "./map/assistant-layer.js";
import { bindAreas, clearAreas } from "./map/areas.js";
import { bindPopups } from "./map/popups.js";
import { addCatchmentLayers, clearCatchment } from "./map/catchment.js";
import { addGeologyLayers } from "./map/geology.js";
import { bindLayout, hideLoader, loaderFailed, loaderStep, showTab } from "./panel/layout.js";
import { bindExplorer, refreshData, setDataMode, setupFilters } from "./panel/explorer.js";
import { bindRecord, closeRecord } from "./panel/record.js";
import { bindChat, chatIsBusy, resetChat } from "./assistant/chat.js";
import { registerWebMcpTools } from "./assistant/webmcp.js";

const $ = (id) => document.getElementById(id);
let chatBound = false;
let switching = false;

async function waitForTiles(limit = 4000) {
  const started = performance.now();
  while (!(map.isStyleLoaded() && map.areTilesLoaded()) && performance.now() - started < limit) {
    await new Promise((resolve) => window.setTimeout(resolve, 80));
  }
}

// The dataset is chosen in the central strip. Changing it swaps the data in the same
// explorer: the map keeps its place, basemap and overlays, and a dataset opened before
// comes back from memory.
function renderDatasetSelect() {
  const select = $("datasetSelect");
  select.replaceChildren(...Object.entries(state.datasets).map(([id, dataset]) => new Option(dataset.title, id)));
  select.value = state.dataset.id;
  select.addEventListener("change", () => switchDataset(select.value));
}

function configureDatasetFeatures() {
  const assistantEnabled = state.dataset.features?.assistant !== false;
  document.body.dataset.datasetProfile = state.dataset.profile || "sediments";
  $("assistantTabButton").hidden = !assistantEnabled;
  if (!assistantEnabled && state.view === "assistant") state.view = "data";
  if (assistantEnabled && !chatBound) {
    bindChat();
    chatBound = true;
  }
  return assistantEnabled;
}

// An element from the address bar is kept only when the release has it.
function checkParameter() {
  const code = state.filters.parameter;
  if (code !== "all" && !state.dataset.parameters[code]) state.filters.parameter = state.dataset.defaultParameter;
}

async function openDataset(onStep) {
  await openDatabase(onStep);
  checkParameter();
  await yearBounds();
  await setupFilters();
}

async function switchDataset(id) {
  const select = $("datasetSelect");
  if (switching || id === state.dataset.id || !state.datasets[id]) return;
  if (chatIsBusy()) {
    select.value = state.dataset.id;
    return;
  }
  switching = true;
  select.disabled = true;
  const notice = $("datasetLoading");
  notice.textContent = `Loading ${state.datasets[id].title}…`;
  notice.hidden = false;
  try {
    closeRecord();
    await clearAreas({ refresh: false });
    selectDataset(id);
    useProjection(state.dataset.projection);
    const assistantEnabled = configureDatasetFeatures();
    if (state.view === "assistant" && !assistantEnabled) showTab("data");
    if (chatBound) resetChat();
    await openDataset(() => {});
    await setDataMode("filters", { refresh: false });
    if (state.dataset.features?.catchment !== false) addCatchmentLayers();
    else clearCatchment();
    await refreshData({ updateMap: true });
    setAssistantView(assistantEnabled && state.view === "assistant");
    writeUrlState();
  } catch (error) {
    console.error(error);
    notice.textContent = `Could not open ${state.datasets[id].title}: ${error.message || error}`;
    window.setTimeout(() => { notice.hidden = true; }, 6000);
    return;
  } finally {
    switching = false;
    select.disabled = false;
    select.value = state.dataset.id;
  }
  notice.hidden = true;
}

async function start() {
  const datasetId = new URLSearchParams(window.location.search).get("dataset");
  await loadConfig(datasetId);
  readUrlState();
  useProjection(state.dataset.projection);
  renderDatasetSelect();
  bindLayout();
  showTab(state.view);

  state.session = await signIn();
  bindSignOut();
  const assistantEnabled = configureDatasetFeatures();

  try {
    loaderStep("Starting DuckDB");
    createMap();
    await openDataset(loaderStep);
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
