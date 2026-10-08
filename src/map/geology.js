import { PMTiles, Protocol, FetchSource } from "pmtiles";
import { state } from "../state.js";
import { escapeHtml } from "../lib/format.js";
import { draw, map } from "./map.js";

const $ = (id) => document.getElementById(id);

// The INGEMMET geology of Peru as an overlay: one vector PMTiles archive with every layer,
// coloured with INGEMMET's own symbology (estilos.json). It is read a few tiles at a time,
// from data/geologia on localhost or from its Hugging Face repository elsewhere. Units are
// shown as INGEMMET publishes them, without grouping.
const LAYERS = [
  { id: "geomorfologia", label: "Geomorphology", visible: false },
  { id: "litologia_100k", label: "Lithology 1:100k", visible: false },
  { id: "litologia_50k", label: "Lithology 1:50k", visible: true },
  { id: "fallas_100k", label: "Faults 1:100k", visible: false },
  { id: "pliegues_100k", label: "Folds 1:100k", visible: false },
  { id: "fallas_50k", label: "Faults 1:50k", visible: false },
  { id: "pliegues_50k", label: "Folds 1:50k", visible: false },
];
// Points and drawn areas keep their own clicks; geology answers only where none is hit.
const INTERACTIVE = ["samples", "cluster-circles", "cluster-points", "exceedance", "thematic-points"];
// The legend card stays small: a few units per layer, the rest behind "show all".
const LEGEND_ROWS = 4;
const LEGEND_ALL = 30;
const layerId = (id) => `geology-${id}`;
let styles = null;
let enabled = false;
let legendAll = false;

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

function opacityProperty(layer) {
  return styles[layer.id].geometry === "polygon" ? "fill-opacity" : "line-opacity";
}

function setVisibility(layer) {
  map.setLayoutProperty(layerId(layer.id), "visibility", enabled && layer.visible ? "visible" : "none");
}

function renderControls() {
  $("geologyLayers").replaceChildren(...LAYERS.map((layer) => {
    const row = document.createElement("div");
    row.className = "geology-layer";
    row.title = `Drawn from zoom ${styles[layer.id].minzoom}`;
    row.innerHTML = `<label><input type="checkbox" ${layer.visible ? "checked" : ""}><span>${escapeHtml(layer.label)}</span></label>`
      + `<input type="range" min="0" max="1" step="0.05" value="${layer.opacity}" aria-label="Opacity of ${escapeHtml(layer.label)}">`;
    const [toggle, slider] = row.querySelectorAll("input");
    toggle.addEventListener("change", () => {
      layer.visible = toggle.checked;
      setVisibility(layer);
      window.setTimeout(renderLegend, 400);
    });
    slider.addEventListener("input", () => {
      layer.opacity = Number(slider.value);
      map.setPaintProperty(layerId(layer.id), opacityProperty(layer), layer.opacity);
    });
    return row;
  }));
}

// The legend lists the units drawn in the current view, the most frequent first, so it stays
// short although the layers hold thousands of units.
function renderLegend() {
  if (!enabled) return;
  const sections = [];
  for (const layer of [...LAYERS].reverse()) {
    if (!layer.visible || map.getZoom() < styles[layer.id].minzoom) continue;
    const style = styles[layer.id];
    const values = new Map(style.values.map((value) => [String(value.value), value]));
    const counts = new Map();
    for (const feature of map.queryRenderedFeatures({ layers: [layerId(layer.id)] })) {
      const key = keyOf(style, feature.properties);
      const entry = counts.get(key) || { count: 0, properties: feature.properties };
      entry.count += 1;
      counts.set(key, entry);
    }
    if (!counts.size) continue;
    const rows = [...counts.entries()].sort((a, b) => b[1].count - a[1].count);
    const shown = legendAll ? LEGEND_ALL : LEGEND_ROWS;
    const items = rows.slice(0, shown).map(([key, { properties }]) => {
      const value = values.get(key);
      const color = rgba(value?.color) || rgba(style.default?.color) || "rgba(150,150,150,.7)";
      const label = style.geometry === "polygon"
        ? [properties.ETIQUETA || properties.NAME, properties.UNIDAD || properties.SUBUNIDAD].filter(Boolean).join(" · ")
        : value?.label || properties.DESCRIP || properties.TIPO || key;
      const swatch = style.geometry === "polygon" ? `<i style="background:${color}"></i>` : `<i class="line" style="background:${color}"></i>`;
      return `<li>${swatch}<span>${escapeHtml(label || "Unnamed unit")}</span></li>`;
    });
    const more = rows.length > shown ? `<li class="more">+${rows.length - shown} more in view</li>` : "";
    sections.push(`<section><strong>${escapeHtml(layer.label)}</strong><ul>${items.join("")}${more}</ul></section>`);
  }
  const anyMore = sections.some((section) => section.includes('class="more"'));
  const toggle = anyMore || legendAll ? `<button id="geologyLegendAll" class="geology-legend-all" type="button">${legendAll ? "Show fewer" : "Show all"}</button>` : "";
  // A layer ticked but not drawn yet at this zoom says so, so an empty map is not a mystery.
  const waiting = LAYERS.filter((layer) => layer.visible && map.getZoom() < styles[layer.id].minzoom)
    .map((layer) => `<p class="geology-empty">Zoom in to see ${escapeHtml(layer.label)} (from zoom ${styles[layer.id].minzoom}).</p>`);
  const empty = LAYERS.some((layer) => layer.visible) ? "" : '<p class="geology-empty">Tick a layer to see its units.</p>';
  $("geologyLegend").innerHTML = sections.join("") + waiting.join("") + (sections.length || waiting.length ? "" : empty) + toggle;
  $("geologyLegendAll")?.addEventListener("click", () => {
    legendAll = !legendAll;
    renderLegend();
  });
}

function popupHtml(feature) {
  const layer = LAYERS.find((item) => layerId(item.id) === feature.layer.id);
  const properties = feature.properties;
  const title = properties.UNIDAD || properties.SUBUNIDAD || properties.DESCRIP || "INGEMMET unit";
  const code = properties.ETIQUETA || properties.NAME || "";
  const rows = Object.entries(properties)
    .filter(([, value]) => value !== null && value !== "" && String(value).trim() !== "")
    .map(([name, value]) => `<tr><th>${escapeHtml(name)}</th><td>${escapeHtml(String(value))}</td></tr>`).join("");
  return `<article class="geology-popup"><small>${escapeHtml(layer.label)}${code ? ` · ${escapeHtml(code)}` : ""}</small>`
    + `<strong>${escapeHtml(title)}</strong><table>${rows}</table><footer>Source: INGEMMET · GEOCATMIN</footer></article>`;
}

function bindClicks() {
  map.on("click", (event) => {
    if (!enabled || (draw && draw.getMode() !== "simple_select")) return;
    const box = [[event.point.x - 3, event.point.y - 3], [event.point.x + 3, event.point.y + 3]];
    const present = INTERACTIVE.filter((id) => map.getLayer(id));
    if (present.length && map.queryRenderedFeatures(box, { layers: present }).length) return;
    const visible = LAYERS.filter((layer) => layer.visible).map((layer) => layerId(layer.id)).reverse();
    const [feature] = map.queryRenderedFeatures(box, { layers: visible });
    if (!feature) return;
    new maplibregl.Popup({ maxWidth: "340px", className: "geology-popup-shell" }).setLngLat(event.lngLat).setHTML(popupHtml(feature)).addTo(map);
  });
}

export function setGeology(on) {
  enabled = on && Boolean(styles);
  $("geologyToggle").classList.toggle("active", enabled);
  $("geologyEnabled").checked = enabled;
  if (!styles) return;
  for (const layer of LAYERS) setVisibility(layer);
  if (enabled) window.setTimeout(renderLegend, 400);
}

// The layer controls open in a panel on the left, under the map modes, and stay open
// while they are used; the Geology button or × closes them. The legend card stays while
// geology shows.
function setMenu(open) {
  $("geologyMenu").hidden = !open;
  $("geologyToggle").setAttribute("aria-expanded", String(open));
  if (open) fitMenu();
}

// The panel ends above the cards in the lower left (selection statistics, the series of a
// station, its catchment), whose height changes; it scrolls inside what is left.
function fitMenu() {
  const menu = $("geologyMenu");
  if (menu.hidden) return;
  const shell = menu.offsetParent.getBoundingClientRect();
  const cards = document.querySelector(".map-cards");
  const box = cards?.getBoundingClientRect();
  const floor = box && box.height ? box.top : shell.bottom;
  menu.style.maxHeight = `${Math.max(160, floor - menu.getBoundingClientRect().top - 10)}px`;
}

function bindMenu() {
  $("geologyToggle").addEventListener("click", () => {
    const open = $("geologyMenu").hidden;
    // Opening the panel shows the geology, with Show geology already ticked.
    if (open) setGeology(true);
    setMenu(open);
  });
  $("geologyEnabled").addEventListener("change", (event) => setGeology(event.target.checked));
  $("geologyMenuClose").addEventListener("click", () => setMenu(false));
  const cards = document.querySelector(".map-cards");
  if (cards) new ResizeObserver(fitMenu).observe(cards);
  window.addEventListener("resize", fitMenu);
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && !$("geologyMenu").hidden) setMenu(false);
  });
}

// Adds the overlay under the catchment and the sample points. Without an archive (an
// unpublished one on the web) the Geology button stays hidden and nothing else changes.
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
  for (const layer of LAYERS) {
    const style = styles[layer.id];
    layer.opacity = style.geometry === "polygon" ? 0.5 : 0.85;
    const base = { id: layerId(layer.id), source: "geology", "source-layer": layer.id, minzoom: style.minzoom, layout: { visibility: "none" } };
    map.addLayer(style.geometry === "polygon"
      ? { ...base, type: "fill", paint: { "fill-color": colorExpression(style), "fill-opacity": layer.opacity } }
      : { ...base, type: "line", paint: { "line-color": colorExpression(style), "line-width": widthExpression(style), "line-opacity": layer.opacity } }, before);
  }

  renderControls();
  bindClicks();
  // The map is never idle (the exceedance halo pulses), so the legend follows the moves
  // and the arrival of geology tiles instead.
  let timer;
  const schedule = () => {
    window.clearTimeout(timer);
    timer = window.setTimeout(renderLegend, 350);
  };
  map.on("moveend", schedule);
  map.on("sourcedata", (event) => {
    if (event.sourceId === "geology" && event.tile) schedule();
  });
  $("geologyToggle").hidden = false;
  bindMenu();
}
