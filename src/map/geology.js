import { PMTiles, Protocol, FetchSource } from "pmtiles";
import { state } from "../state.js";
import { escapeHtml } from "../lib/format.js";
import { draw, map } from "./map.js";

const $ = (id) => document.getElementById(id);

// The INGEMMET geology of Peru as two overlays over any basemap, read a few tiles at a
// time from one vector PMTiles archive (data/geologia on localhost, its Hugging Face
// repository elsewhere) and coloured with INGEMMET's own symbology (estilos.json).
// Geology is the lithology with its faults and folds on top; geomorphology is the
// landform map. Each draws the most detailed scale the zoom allows: 1:100 000 when the
// map is zoomed out and 1:50 000 from the zoom where that map starts. Units are shown
// as INGEMMET publishes them, without grouping.
const OVERLAYS = {
  geology: [
    { id: "litologia_100k", until: "litologia_50k" },
    { id: "litologia_50k" },
    { id: "fallas_100k", until: "fallas_50k" },
    { id: "pliegues_100k", until: "pliegues_50k" },
    { id: "fallas_50k" },
    { id: "pliegues_50k" },
  ],
  geomorphology: [{ id: "geomorfologia" }],
};
const TITLES = { geology: "Geology", geomorphology: "Geomorphology" };
const POLYGON_OPACITY = 0.5;
const LINE_OPACITY = 0.85;
// Points and drawn areas keep their own clicks; geology answers only where none is hit.
const INTERACTIVE = ["samples", "cluster-circles", "cluster-points", "exceedance", "thematic-points"];
// The legend card stays small: the most frequent units in view.
const LEGEND_ROWS = 5;
const layerId = (id) => `geology-${id}`;
let styles = null;
let active = null;
let loading = false;
let loadingTimer = null;

const rgba = (color) => (color ? `rgba(${color[0]},${color[1]},${color[2]},${(color[3] ?? 255) / 255})` : null);

// The value the official renderer keys its colours on: one field, or several joined.
function keyExpression(style) {
  const parts = style.fields.map((field) => ["to-string", ["coalesce", ["get", field], ""]]);
  return parts.length === 1 ? parts[0] : ["concat", ...parts.flatMap((part, index) => (index ? [style.delimiter, part] : [part]))];
}

function keyOf(style, properties) {
  return style.fields.map((field) => String(properties[field] ?? "")).join(style.delimiter || ",");
}

function colorExpression(style) {
  const pairs = style.values.filter((value) => value.color).flatMap((value) => [String(value.value), rgba(value.color)]);
  const fallback = rgba(style.default?.color) || "rgba(150,150,150,0.7)";
  return pairs.length ? ["match", keyExpression(style), ...pairs, fallback] : fallback;
}

function widthExpression(style) {
  // INGEMMET's widths are drawn for print; at a quarter they read on screen without hiding the units.
  const pairs = style.values.filter((value) => value.width).flatMap((value) => [String(value.value), Math.max(0.5, value.width * 0.25)]);
  return pairs.length ? ["match", keyExpression(style), ...pairs, 0.8] : 0.8;
}

async function source() {
  const config = state.overlays.geology;
  if (!config) return null;
  if (["localhost", "127.0.0.1"].includes(window.location.hostname)) {
    const local = new URL(`${config.localPath}/${config.archive}`, window.location.href).href;
    const found = await fetch(local, { method: "HEAD", cache: "no-store" }).then((response) => response.ok, () => false);
    if (found) return { archive: local, styles: new URL(`${config.localPath}/${config.styles}`, window.location.href).href, headers: new Headers() };
  }
  const base = `https://huggingface.co/datasets/${config.repository}/resolve/${encodeURIComponent(config.revision)}`;
  const headers = new Headers(state.session?.hfToken ? { Authorization: `Bearer ${state.session.hfToken}` } : {});
  return { archive: `${base}/${config.archive}`, styles: `${base}/${config.styles}`, headers };
}

const activeLayers = () => (active ? OVERLAYS[active].map((layer) => layerId(layer.id)) : []);

// The units drawn in the current view, the most frequent first, so the card stays short
// although the layers hold thousands of units. Faults and folds take one line together.
function renderLegend() {
  const card = $("geologyLegend");
  if (!active) {
    card.hidden = true;
    return;
  }
  const counts = new Map();
  let lines = false;
  for (const feature of map.queryRenderedFeatures({ layers: activeLayers() })) {
    const style = styles[feature.sourceLayer];
    if (style.geometry !== "polygon") {
      lines = true;
      continue;
    }
    const key = `${feature.sourceLayer}|${keyOf(style, feature.properties)}`;
    const entry = counts.get(key) || { count: 0, style, feature };
    entry.count += 1;
    counts.set(key, entry);
  }
  const rows = [...counts.values()].sort((a, b) => b.count - a.count);
  const items = rows.slice(0, LEGEND_ROWS).map(({ style, feature }) => {
    const value = style.values.find((item) => String(item.value) === keyOf(style, feature.properties));
    const color = rgba(value?.color) || rgba(style.default?.color) || "rgba(150,150,150,.7)";
    const properties = feature.properties;
    const text = (...fields) => fields.map((field) => String(properties[field] ?? "").trim()).find(Boolean);
    const label = [text("ETIQUETA", "NAME"), text("UNIDAD", "SUBUNIDAD", "DESCRIP")].filter(Boolean).join(" · ");
    return `<li><i style="background:${color}"></i><span>${escapeHtml(label || "Unnamed unit")}</span></li>`;
  });
  if (lines) items.push('<li><i class="line" style="color:#3a2a1a"></i><span>Faults and folds</span></li>');
  const more = rows.length > LEGEND_ROWS ? `+${rows.length - LEGEND_ROWS} more in view · ` : "";
  const body = items.length ? `<ul>${items.join("")}</ul>` : "";
  const status = loading
    ? `<p class="geology-loading"><b aria-hidden="true"></b>Loading ${TITLES[active].toLowerCase()}…</p>`
    : `<p>${more}${items.length ? "Click a unit for details" : "Nothing drawn here"} · INGEMMET</p>`;
  card.innerHTML = `${body}${status}`;
  card.hidden = false;
}

// Tiles come a few at a time from a large archive, so the card says when they are still
// arriving: from the moment an overlay is turned on or the map asks for new tiles, until
// the source reports every requested tile loaded (or 30 s pass).
function watchLoading() {
  if (!active) return;
  const started = performance.now();
  window.clearInterval(loadingTimer);
  loading = true;
  document.querySelector(`[data-overlay="${active}"]`)?.classList.add("loading");
  renderLegend();
  loadingTimer = window.setInterval(() => {
    const elapsed = performance.now() - started;
    if (active && !(elapsed > 30000 || (elapsed > 300 && map.isSourceLoaded("geology")))) return;
    window.clearInterval(loadingTimer);
    loading = false;
    document.querySelectorAll("[data-overlay]").forEach((button) => button.classList.remove("loading"));
    renderLegend();
  }, 200);
}

function popupHtml(feature) {
  const properties = feature.properties;
  const title = properties.UNIDAD || properties.SUBUNIDAD || properties.DESCRIP || "INGEMMET unit";
  const code = properties.ETIQUETA || properties.NAME || "";
  const rows = Object.entries(properties)
    .filter(([, value]) => value !== null && value !== "" && String(value).trim() !== "")
    .map(([name, value]) => `<tr><th>${escapeHtml(name)}</th><td>${escapeHtml(String(value))}</td></tr>`).join("");
  return `<article class="geology-popup"><small>${escapeHtml(TITLES[active])}${code ? ` · ${escapeHtml(code)}` : ""}</small>`
    + `<strong>${escapeHtml(title)}</strong><table>${rows}</table><footer>Source: INGEMMET · GEOCATMIN</footer></article>`;
}

function bindClicks() {
  map.on("click", (event) => {
    if (!active || (draw && draw.getMode() !== "simple_select")) return;
    const box = [[event.point.x - 3, event.point.y - 3], [event.point.x + 3, event.point.y + 3]];
    const present = INTERACTIVE.filter((id) => map.getLayer(id));
    if (present.length && map.queryRenderedFeatures(box, { layers: present }).length) return;
    // Lines lie on top, so a click near a fault reads the fault before the unit under it.
    const [feature] = map.queryRenderedFeatures(box, { layers: [...activeLayers()].reverse() });
    if (!feature) return;
    new maplibregl.Popup({ maxWidth: "340px", className: "geology-popup-shell" }).setLngLat(event.lngLat).setHTML(popupHtml(feature)).addTo(map);
  });
}

// One overlay at a time: both are coloured polygons, and one over the other reads as neither.
function setOverlay(name) {
  active = active === name ? null : name;
  for (const [overlay, layers] of Object.entries(OVERLAYS)) {
    for (const layer of layers) map.setLayoutProperty(layerId(layer.id), "visibility", overlay === active ? "visible" : "none");
  }
  document.querySelectorAll("[data-overlay]").forEach((button) => {
    button.classList.toggle("active", button.dataset.overlay === active);
    button.setAttribute("aria-pressed", String(button.dataset.overlay === active));
  });
  if (active) watchLoading();
  else renderLegend();
}

// Adds both overlays under the catchment and the sample points. Without an archive (an
// unpublished one on the web) the buttons stay hidden and nothing else changes.
export async function addGeologyLayers() {
  const found = await source();
  if (!found) return;
  try {
    const response = await fetch(found.styles, { headers: found.headers, cache: "no-store" });
    if (!response.ok) return;
    styles = (await response.json()).layers;
  } catch {
    return;
  }
  const protocol = new Protocol();
  maplibregl.addProtocol("pmtiles", protocol.tile);
  protocol.add(new PMTiles(new FetchSource(found.archive, found.headers)));
  map.addSource("geology", { type: "vector", url: `pmtiles://${found.archive}`, attribution: `© ${state.overlays.geology.attribution}` });

  const before = map.getLayer("catchment-fill") ? "catchment-fill" : map.getLayer("context-points") ? "context-points" : undefined;
  for (const layer of Object.values(OVERLAYS).flat()) {
    const style = styles[layer.id];
    const base = {
      id: layerId(layer.id), source: "geology", "source-layer": layer.id, minzoom: style.minzoom, layout: { visibility: "none" },
      // The coarser scale hands over to the finer one at the zoom where that one starts.
      ...(layer.until ? { maxzoom: styles[layer.until].minzoom } : {}),
    };
    map.addLayer(style.geometry === "polygon"
      ? { ...base, type: "fill", paint: { "fill-color": colorExpression(style), "fill-opacity": POLYGON_OPACITY } }
      : { ...base, type: "line", paint: { "line-color": colorExpression(style), "line-width": widthExpression(style), "line-opacity": LINE_OPACITY } }, before);
  }

  bindClicks();
  // The legend follows the moves and the arrival of geology tiles.
  let timer;
  const schedule = () => {
    window.clearTimeout(timer);
    timer = window.setTimeout(renderLegend, 350);
  };
  map.on("moveend", schedule);
  map.on("sourcedata", (event) => {
    if (event.sourceId === "geology" && event.tile) schedule();
  });
  map.on("dataloading", (event) => {
    if (event.sourceId === "geology" && active && !loading) watchLoading();
  });
  document.querySelectorAll("[data-overlay]").forEach((button) => {
    button.hidden = false;
    button.addEventListener("click", () => setOverlay(button.dataset.overlay));
  });
}
