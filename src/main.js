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

async function start() {
  const datasetId = new URLSearchParams(window.location.search).get("dataset");
  await loadConfig(datasetId);
  readUrlState();
  useProjection(state.dataset.projection);
  document.getElementById("datasetTitle").textContent = state.dataset.title;
  bindLayout();
  showTab(state.view);

  state.session = await signIn();
  bindSignOut();
  bindChat();

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
    addCatchmentLayers();
    // The geology overlay loads on its own; the map is usable without it.
    addGeologyLayers().catch((error) => console.warn("Geology overlay unavailable:", error));
    applyStyling();
    bindMapToolbar();
    bindAreas();
    bindPopups();

    loaderStep("Rendering map");
    await waitForTiles();
    state.ready = true;
    setAssistantView(state.view === "assistant");
    writeUrlState();
    registerWebMcpTools();
    hideLoader();
  } catch (error) {
    console.error(error);
    loaderFailed(error.message || "Data load failed");
  }
}

start();
