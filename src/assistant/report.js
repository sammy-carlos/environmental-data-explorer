import { state } from "../state.js";
import { downloadFile, localDate } from "../lib/format.js";
import { loadLogo } from "../lib/logo.js";
import { map } from "../map/map.js";

const $ = (id) => document.getElementById(id);

// The conversation as a PDF: every question with its answer, the tables as tables, the
// charts, and the map each answer drew. It is laid out with jsPDF in the explorer's fonts,
// which are loaded only when a PDF is asked for.
const FONT_ROOT = "https://cdn.jsdelivr.net/npm/@expo-google-fonts";
const FONTS = [
  ["Manrope", "normal", `${FONT_ROOT}/manrope@0.4.2/400Regular/Manrope_400Regular.ttf`],
  ["Manrope", "bold", `${FONT_ROOT}/manrope@0.4.2/700Bold/Manrope_700Bold.ttf`],
  ["DMMono", "normal", `${FONT_ROOT}/dm-mono@0.4.2/400Regular/DMMono_400Regular.ttf`],
];
const PAGE = { width: 210, height: 297, margin: 18, top: 18, bottom: 24 };
const CONTENT = PAGE.width - 2 * PAGE.margin;
const PT = 0.3528;
const INK = "#18201d";
const MUTED = "#69736d";
const LINE = "#d7dcd5";
const FOREST = "#1c5b4f";
const MINT = "#e4efea";
const DANGER = "#b3261e";
const CODE_BACKGROUND = "#f2f3ef";
// The report is read in Spanish, even though the explorer itself is in English.
const NOTE = "Generado por un asistente de IA a partir del dataset; verifica las cifras clave antes de citarlas.";
// The explorer's legend labels and the tools' row counts, as the report says them.
const LEGEND_WORDS = { Low: "Bajo", Typical: "Típico", High: "Alto", First: "Primero", Categories: "Categorías", Last: "Último" };

function spanishNote(text) {
  return text.replace(/\b(\d[\d,]*) rows?\b/g, (_, count) => `${count} ${count === "1" ? "fila" : "filas"}`);
}

// The map as each answer left it, keyed by the element that closes the answer.
const mapShots = new WeakMap();
let fonts = null;

function base64(buffer) {
  const bytes = new Uint8Array(buffer);
  let text = "";
  for (let index = 0; index < bytes.length; index += 0x8000) text += String.fromCharCode(...bytes.subarray(index, index + 0x8000));
  return btoa(text);
}

function loadFonts() {
  fonts ??= Promise.all(FONTS.map(async ([family, style, url]) => {
    const response = await fetch(url);
    if (!response.ok) throw new Error(`Could not load the ${family} font (${response.status}).`);
    return { family, style, file: url.split("/").pop(), data: base64(await response.arrayBuffer()) };
  }));
  fonts.catch(() => { fonts = null; });
  return fonts;
}

// A CSS gradient drawn on a canvas, for the legend of a map.
function rampImage(element) {
  const css = element ? getComputedStyle(element).backgroundImage : "";
  const stops = [...css.matchAll(/(rgba?\([^)]*\)|#[0-9a-f]{3,8})\s*([\d.]+%)?\s*([\d.]+%)?/gi)];
  if (!stops.length) return null;
  const canvas = Object.assign(document.createElement("canvas"), { width: 600, height: 24 });
  const context = canvas.getContext("2d");
  const gradient = context.createLinearGradient(0, 0, canvas.width, 0);
  stops.forEach(([, color, start, end], index) => {
    const even = stops.length > 1 ? index / (stops.length - 1) : 0;
    gradient.addColorStop(start ? parseFloat(start) / 100 : even, color);
    if (end) gradient.addColorStop(parseFloat(end) / 100, color);
  });
  context.fillStyle = gradient;
  context.fillRect(0, 0, canvas.width, canvas.height);
  return canvas.toDataURL("image/png");
}

// What the map legend says next to the drawing: the assistant's own ramp for a thematic
// map, the explorer's legend when the assistant filtered the explorer's points.
function mapLegend() {
  if (!$("thematicLegend").hidden) {
    return {
      title: $("thematicTitle").textContent,
      caption: $("thematicCaption").textContent,
      ramp: rampImage(document.querySelector(".thematic-ramp i")),
      values: [["", $("thematicMin").textContent], ["", $("thematicMax").textContent]],
    };
  }
  const parameter = $("mapParameter").selectedOptions[0]?.textContent || "";
  return {
    title: [parameter, $("legendTitle").textContent].filter(Boolean).join(" · "),
    caption: "",
    ramp: rampImage($("legendRamp")),
    values: ["Min", "Mid", "Max"].map((slot) => {
      const name = $(`legend${slot}Label`).textContent;
      return [LEGEND_WORDS[name] || name, $(`legend${slot}`).textContent];
    }),
  };
}

function settle(promise, ms) {
  return Promise.race([promise, new Promise((resolve) => window.setTimeout(() => resolve(null), ms))]);
}

// Waits for the map to finish moving and loading tiles, then reads the next frame. A map
// that is not on screen draws no frames, and the answer goes without it.
async function captureMap() {
  if (!map || document.hidden) return null;
  if (!map.loaded() || map.isMoving()) await settle(new Promise((resolve) => map.once("idle", resolve)), 6000);
  const frame = await settle(new Promise((resolve) => {
    map.once("render", () => {
      try {
        const source = map.getCanvas();
        const scale = Math.min(1, 1800 / source.width);
        const canvas = Object.assign(document.createElement("canvas"), { width: Math.round(source.width * scale), height: Math.round(source.height * scale) });
        canvas.getContext("2d").drawImage(source, 0, 0, canvas.width, canvas.height);
        resolve({ image: canvas.toDataURL("image/jpeg", 0.86), width: canvas.width, height: canvas.height });
      } catch {
        resolve(null);
      }
    });
    map.triggerRepaint();
  }), 3000);
  if (!frame) return null;
  return { ...frame, caption: $("agentBar").hidden ? "" : $("agentCaption").textContent, legend: mapLegend() };
}

// Called when an answer ends, with the element that closes it: when the answer drew on
// the map, the map is kept as it looks now.
export function keepTurnMap(closing, drew) {
  if (drew && state.map.agentShowing) mapShots.set(closing, captureMap().catch(() => null));
}

// The conversation read back from the page: each question with the answers, charts and
// errors that followed it, up to the element that closes it.
function turnsOf(log) {
  const turns = [];
  let turn = null;
  for (const element of log.children) {
    if (element.matches(".chat-message.user")) {
      turn = { question: element.textContent, blocks: [], closing: null };
      turns.push(turn);
    } else if (!turn) {
      continue;
    } else if (element.matches(".turn-actions")) {
      turn.closing = element;
    } else if (element.matches(".chat-message.assistant, .chat-message.error, figure.chat-chart, details.tool-step")) {
      turn.blocks.push(element);
    }
  }
  return turns.filter((item) => item.blocks.some((block) => block.matches(".chat-message.assistant")));
}

// A Chart.js chart drawn again off screen for the page; the one in the conversation is
// sized for the panel, and stretched to the page its labels would be as large as the
// headings. It is drawn about 680 px wide, which prints its 9 px labels at about 6.5 pt.
// When that fails, the panel's own pixels are used.
function chartImage(canvas) {
  const chart = window.Chart?.getChart(canvas);
  // A conversation that is not on screen lays its charts out at 0 px; they get the size
  // they have in the panel.
  const shownWidth = canvas.clientWidth || 340;
  const shownHeight = canvas.clientHeight || 190;
  const scale = Math.max(1, 680 / shownWidth);
  const width = Math.round(shownWidth * scale);
  const height = Math.round(shownHeight * Math.min(scale, 1.6));
  let source = canvas;
  let cleanup = () => {};
  if (chart) {
    try {
      const holder = document.createElement("div");
      holder.style.cssText = `position:fixed;left:-10000px;top:0;width:${width}px;height:${height}px;`;
      const copy = Object.assign(document.createElement("canvas"), { width, height });
      holder.append(copy);
      document.body.append(holder);
      const clone = new Chart(copy, {
        type: chart.config.type,
        data: JSON.parse(JSON.stringify(chart.config.data)),
        options: { ...chart.config.options, responsive: false, animation: false, devicePixelRatio: 2.5 },
      });
      source = copy;
      cleanup = () => { clone.destroy(); holder.remove(); };
    } catch {
      source = canvas;
    }
  }
  if (!source.width || !source.height) {
    cleanup();
    return null;
  }
  // Chart canvases are transparent; the PDF gets them on white.
  const flat = Object.assign(document.createElement("canvas"), { width: source.width, height: source.height });
  const context = flat.getContext("2d");
  context.fillStyle = "#fff";
  context.fillRect(0, 0, flat.width, flat.height);
  context.drawImage(source, 0, 0);
  cleanup();
  return { image: flat.toDataURL("image/png"), width, height };
}

function logoImage(logo) {
  const canvas = Object.assign(document.createElement("canvas"), { width: 900, height: Math.round(900 * logo.naturalHeight / logo.naturalWidth) });
  canvas.getContext("2d").drawImage(logo, 0, 0, canvas.width, canvas.height);
  return { image: canvas.toDataURL("image/png"), ratio: canvas.height / canvas.width };
}

// The runs of text inside an element, bold and code kept apart so each gets its font.
function runsOf(node, style = "normal", runs = []) {
  for (const child of node.childNodes) {
    if (child.nodeType === Node.TEXT_NODE) runs.push({ text: child.textContent, style });
    else if (child.nodeType === Node.ELEMENT_NODE) runsOf(child, ["STRONG", "B"].includes(child.tagName) ? "bold" : child.tagName === "CODE" ? "code" : style, runs);
  }
  return runs;
}

// What each tool's query was for, as the appendix names it.
const QUERY_KINDS = { run_sql: "Consulta", create_chart: "Gráfico", draw_map: "Mapa", update_map: "Selección en el mapa" };

// SQL compared without its layout, so a query the assistant ran and then showed is listed once.
function sameQuery(text) {
  return text.replace(/\s+/g, " ").replace(/;\s*$/, "").trim().toLowerCase();
}

function writer(doc, autoTable) {
  let y = PAGE.top;
  // The queries behind the answers go to an appendix at the end, numbered A1, A2…; the
  // answers point to them.
  const queries = [];
  const queryIds = new Map();
  let current = null;

  const register = (text, { kind, note = "", language = "sql" }) => {
    const key = sameQuery(text);
    if (!key) return null;
    if (!queryIds.has(key)) {
      const id = `A${queries.length + 1}`;
      queryIds.set(key, id);
      // A tool's summary that only repeats what the query is for adds nothing.
      queries.push({ id, text: text.trim(), kind, note: note === kind ? "" : note, language, turn: current });
    }
    const id = queryIds.get(key);
    if (current && !current.refs.includes(id)) current.refs.push(id);
    return id;
  };

  const font = (style, size) => {
    if (style === "code") doc.setFont("DMMono", "normal").setFontSize(size * 0.9);
    else doc.setFont("Manrope", style === "bold" ? "bold" : "normal").setFontSize(size);
  };

  const room = (height) => {
    if (y + height > PAGE.height - PAGE.bottom) {
      doc.addPage();
      y = PAGE.top;
    }
  };

  // Breaks runs into lines of at most `width`, measuring each word in its own font. A word
  // longer than a line, such as a long identifier, is cut where it overflows.
  const lines = (runs, width, size) => {
    const result = [[]];
    let used = 0;
    let space = false;
    const words = runs.flatMap((run) => run.text.split(/(\s+)/).filter(Boolean).map((text) => ({ text, style: run.style })));
    for (const word of words) {
      if (/^\s+$/.test(word.text)) {
        space = used > 0;
        continue;
      }
      font(word.style, size);
      let text = word.text;
      let wide = doc.getTextWidth(text);
      const gap = space ? doc.getTextWidth(" ") : 0;
      if (used && used + gap + wide > width) {
        result.push([]);
        used = 0;
      } else if (space) {
        result.at(-1).push({ text: " ", style: word.style, width: gap });
        used += gap;
      }
      while (wide > width - used && text.length > 1) {
        let cut = text.length - 1;
        while (cut > 1 && doc.getTextWidth(text.slice(0, cut)) > width - used) cut -= 1;
        result.at(-1).push({ text: text.slice(0, cut), style: word.style, width: doc.getTextWidth(text.slice(0, cut)) });
        result.push([]);
        used = 0;
        text = text.slice(cut);
        wide = doc.getTextWidth(text);
      }
      result.at(-1).push({ text, style: word.style, width: wide });
      used += wide;
      space = false;
    }
    return result.filter((line) => line.length);
  };

  const lineHeight = (size) => size * PT * 1.45;

  const rich = (runs, { x = PAGE.margin, width = CONTENT, size = 9.5, color = INK } = {}) => {
    const height = lineHeight(size);
    for (const line of lines(runs, width, size)) {
      room(height);
      let cursor = x;
      for (const part of line) {
        font(part.style, size);
        doc.setTextColor(part.style === "code" ? FOREST : color);
        doc.text(part.text, cursor, y, { baseline: "top" });
        cursor += part.width;
      }
      y += height;
    }
  };

  const label = (text, color = MUTED) => {
    room(6);
    font("code", 7.8);
    doc.setTextColor(color);
    doc.text(text.toUpperCase(), PAGE.margin, y, { baseline: "top", charSpace: 0.35 });
    y += 4.2;
  };

  const rule = (gapBefore = 0, gapAfter = 0) => {
    y += gapBefore;
    doc.setDrawColor(LINE).setLineWidth(0.25).line(PAGE.margin, y, PAGE.width - PAGE.margin, y);
    y += gapAfter;
  };

  const image = ({ image: data, width, height }, maxHeight, format) => {
    let w = CONTENT;
    let h = (w * height) / width;
    if (h > maxHeight) {
      h = maxHeight;
      w = (h * width) / height;
    }
    room(h);
    doc.addImage(data, format, PAGE.margin + (CONTENT - w) / 2, y, w, h, undefined, "FAST");
    y += h;
  };

  const table = (element) => {
    const head = [[...element.querySelectorAll("thead th")].map((cell) => cell.textContent.trim())];
    const body = [...element.querySelectorAll("tbody tr")].map((row) => [...row.children].map((cell) => cell.textContent.trim()));
    // Columns of numbers, with or without a unit or a < or ≥ sign, line up on the right.
    const numeric = head[0].map((_, index) => body.length > 0 && body.every((row) => /^([<>≤≥~≈]\s*)?-?\d[\d.,\s]*(%|[a-zµ/]+(\/[a-z]+)?)?$|^[–-]?$/i.test(row[index] ?? "")));
    room(12);
    autoTable(doc, {
      head,
      body,
      startY: y,
      theme: "grid",
      margin: { left: PAGE.margin, right: PAGE.margin, top: PAGE.top, bottom: PAGE.bottom },
      styles: { font: "Manrope", fontSize: 7.8, cellPadding: 1.5, textColor: INK, lineColor: LINE, lineWidth: 0.2, overflow: "linebreak" },
      headStyles: { font: "Manrope", fontStyle: "bold", fillColor: MINT, textColor: FOREST },
      alternateRowStyles: { fillColor: "#fafbf9" },
      columnStyles: Object.fromEntries(numeric.map((right, index) => [index, right ? { halign: "right" } : {}])),
    });
    y = doc.lastAutoTable.finalY + 3.5;
  };

  const reference = (text) => {
    rich([{ text, style: "code" }], { size: 8.4, color: MUTED });
    y += 2.2;
  };

  // Points to a query where the answer used it; the closing line lists only the rest.
  const cite = (id, what = "Consulta") => {
    current?.cited.push(id);
    reference(`${what} ${id} · ver anexo`);
  };

  const code = (text) => {
    const size = 8;
    const height = lineHeight(size);
    font("code", size);
    const rows = text.split("\n").flatMap((row) => doc.splitTextToSize(row || " ", CONTENT - 6));
    y += 1;
    for (const row of rows) {
      room(height);
      doc.setFillColor(CODE_BACKGROUND).rect(PAGE.margin, y, CONTENT, height, "F");
      font("code", size);
      doc.setTextColor(INK);
      doc.text(row, PAGE.margin + 3, y + 0.4, { baseline: "top" });
      y += height;
    }
    y += 3;
  };

  const answer = (element) => {
    for (const block of element.children) {
      const tag = block.tagName;
      if (/^H[1-6]$/.test(tag)) {
        y += 1.5;
        room(lineHeight(11) + 4);
        rich(runsOf(block, "bold"), { size: 10.5 });
        y += 1;
      } else if (tag === "P") {
        rich(runsOf(block));
        y += 2.2;
      } else if (tag === "UL" || tag === "OL") {
        [...block.children].forEach((item, index) => {
          room(lineHeight(9.5));
          font("normal", 9.5);
          doc.setTextColor(tag === "OL" ? INK : FOREST);
          doc.text(tag === "OL" ? `${index + 1}.` : "•", PAGE.margin + 1, y, { baseline: "top" });
          rich(runsOf(item), { x: PAGE.margin + 6, width: CONTENT - 6 });
          y += 1;
        });
        y += 1.4;
      } else if (tag === "TABLE") {
        table(block);
      } else if (block.classList.contains("code-block")) {
        const language = block.querySelector(".code-head span")?.textContent || "sql";
        const id = register(block.querySelector("code")?.textContent || "", { kind: "Escrita en la respuesta", language });
        if (id) cite(id, /sql/i.test(language) ? "Consulta" : "Código");
      } else if (block.textContent.trim()) {
        rich([{ text: block.textContent, style: "normal" }]);
        y += 2.2;
      }
    }
  };

  const chart = (figure, query) => {
    const title = figure.querySelector("strong")?.textContent || "Gráfico";
    const canvas = figure.querySelector("canvas");
    if (!canvas) return;
    const picture = chartImage(canvas);
    if (!picture) return;
    room(8 + Math.min(105, (CONTENT * picture.height) / picture.width));
    y += 1.5;
    rich([{ text: title, style: "bold" }], { size: 9 });
    y += 1.2;
    image(picture, 105, "PNG");
    y += 1.5;
    if (query) cite(query);
    else y += 2.5;
  };

  // The query a tool ran, when it ran one and it worked. A chart drawn from it is named
  // after the chart.
  const step = (element) => {
    const text = element.querySelector("code")?.textContent;
    if (!text || element.classList.contains("failed")) return null;
    const tool = element.dataset.tool || "";
    const figure = element.nextElementSibling?.matches("figure.chat-chart") ? element.nextElementSibling : null;
    const title = figure?.querySelector("strong")?.textContent;
    const kind = title ? `${QUERY_KINDS[tool] || "Consulta"} · ${title}` : QUERY_KINDS[tool] || tool.replaceAll("_", " ") || "Consulta";
    // A chart's title already says what the query was for; other tools add their row count.
    return register(text, { kind, note: title ? "" : spanishNote(element.querySelector("summary")?.textContent || "") });
  };

  const legend = ({ title, caption, ramp, values }) => {
    const width = 80;
    if (title) rich([{ text: title, style: "bold" }], { size: 8.5 });
    if (caption) rich([{ text: caption, style: "normal" }], { size: 8, color: MUTED });
    if (!ramp) return;
    room(10);
    y += 1;
    doc.addImage(ramp, "PNG", PAGE.margin, y, width, 2.6);
    y += 3.6;
    font("code", 7.5);
    values.forEach(([name, value], index) => {
      const x = PAGE.margin + (width * index) / Math.max(1, values.length - 1);
      const align = index === 0 ? "left" : index === values.length - 1 ? "right" : "center";
      doc.setTextColor(MUTED);
      doc.text([name, value].filter(Boolean).join(" "), x, y, { baseline: "top", align });
    });
    y += 4;
  };

  const mapShot = (shot) => {
    room(12 + Math.min(118, (CONTENT * shot.height) / shot.width));
    y += 1.5;
    rich([{ text: "Mapa", style: "bold" }], { size: 9 });
    if (shot.caption) rich([{ text: shot.caption, style: "normal" }], { size: 8, color: MUTED });
    y += 1.2;
    const top = y;
    image(shot, 118, "JPEG");
    doc.setDrawColor(LINE).setLineWidth(0.25).rect(PAGE.margin, top, CONTENT, y - top);
    y += 3;
    legend(shot.legend);
    y += 2;
  };

  const question = (text, number) => {
    const size = 10.5;
    const rows = lines([{ text, style: "bold" }], CONTENT - 10, size);
    const height = rows.length * lineHeight(size) + 11;
    room(height + 4);
    doc.setFillColor(MINT).roundedRect(PAGE.margin, y, CONTENT, height, 1.8, 1.8, "F");
    doc.setFillColor(FOREST).rect(PAGE.margin, y, 1.1, height, "F");
    y += 3.6;
    font("code", 7.5);
    doc.setTextColor(FOREST);
    doc.text(`PREGUNTA ${number}`, PAGE.margin + 5, y, { baseline: "top", charSpace: 0.35 });
    y += 4.4;
    rich([{ text, style: "bold" }], { x: PAGE.margin + 5, width: CONTENT - 10, size });
    y += 3.4 + 4;
  };

  const header = async (title, subtitle) => {
    try {
      const logo = logoImage(await loadLogo());
      const width = 44;
      doc.addImage(logo.image, "PNG", PAGE.width - PAGE.margin - width, y - 1, width, width * logo.ratio);
    } catch {
      // The report reads the same without its logo.
    }
    font("bold", 18);
    doc.setTextColor(INK);
    doc.text(title, PAGE.margin, y, { baseline: "top" });
    y += 9;
    font("code", 8);
    doc.setTextColor(MUTED);
    doc.text(subtitle, PAGE.margin, y, { baseline: "top" });
    y += 6;
    rule(0, 7);
  };

  const footers = () => {
    const pages = doc.getNumberOfPages();
    const dataset = [state.dataset?.title, state.dataset?.revision].filter(Boolean).join(" ");
    for (let page = 1; page <= pages; page += 1) {
      doc.setPage(page);
      const top = PAGE.height - PAGE.bottom + 8;
      doc.setDrawColor(LINE).setLineWidth(0.25).line(PAGE.margin, top, PAGE.width - PAGE.margin, top);
      font("code", 7);
      doc.setTextColor(MUTED);
      doc.text(NOTE, PAGE.margin, top + 2.5, { baseline: "top" });
      doc.text(`Environmental Data Explorer · dataset ${dataset}`, PAGE.margin, top + 6, { baseline: "top" });
      doc.text(`Página ${page} de ${pages}`, PAGE.width - PAGE.margin, top + 6, { baseline: "top", align: "right" });
    }
  };

  const turn = async (item, number) => {
    current = { number, question: item.question, refs: [], cited: [] };
    question(item.question, number);
    label("Respuesta");
    y += 0.5;
    let last = null;
    for (const block of item.blocks) {
      if (block.matches("details.tool-step")) last = { element: block, id: step(block) };
      else if (block.matches(".chat-message.assistant")) answer(block);
      else if (block.matches("figure.chat-chart")) chart(block, last?.element === block.previousElementSibling ? last.id : null);
      else rich([{ text: block.textContent, style: "normal" }], { color: DANGER, size: 9 });
    }
    const rest = current.refs.filter((id) => !current.cited.includes(id));
    if (rest.length) {
      y += 1;
      reference(`${current.cited.length ? "Otras consultas de esta respuesta" : "Consultas de esta respuesta"}: ${rest.join(", ")} · ver anexo`);
    }
    const shot = item.closing ? await mapShots.get(item.closing) : null;
    if (shot) mapShot(shot);
  };

  // The last pages: every query, grouped under the question it answered.
  const appendix = () => {
    if (!queries.length) return;
    doc.addPage();
    y = PAGE.top;
    font("bold", 14);
    doc.setTextColor(INK);
    doc.text("Anexo · Consultas", PAGE.margin, y, { baseline: "top" });
    y += 8;
    rich([{ text: "Las consultas que el asistente ejecutó o escribió para cada respuesta, en SQL de DuckDB sobre las observaciones del dataset. Cada una se puede volver a ejecutar en la pestaña SQL de Data explorer.", style: "normal" }], { size: 8.5, color: MUTED });
    y += 3;
    rule(0, 5);
    let group = null;
    for (const item of queries) {
      if (item.turn !== group) {
        group = item.turn;
        if (group) {
          room(lineHeight(9.5) * 2 + 12);
          y += 1;
          rich([{ text: `Pregunta ${group.number} · `, style: "bold" }, { text: group.question, style: "normal" }], { size: 9.5 });
          y += 2.5;
        }
      }
      room(lineHeight(8.4) + lineHeight(8) * 3 + 6);
      rich([{ text: item.id, style: "bold" }, { text: `  ${item.kind}${item.note ? ` · ${item.note}` : ""}`, style: "normal" }], { size: 8.4, color: MUTED });
      y += 0.5;
      code(item.text);
    }
  };

  return { header, turn, appendix, footers, rule: () => rule(3, 9) };
}

async function build(turns, { title, file, numbers, counted }) {
  const [{ jsPDF }, { autoTable }, loaded] = await Promise.all([import("jspdf"), import("jspdf-autotable"), loadFonts()]);
  const doc = new jsPDF({ unit: "mm", format: "a4", compress: true });
  for (const { family, style, file: name, data } of loaded) {
    doc.addFileToVFS(name, data);
    doc.addFont(name, family, style);
  }
  doc.setProperties({ title, subject: "Environmental Data Explorer", creator: "Kipu360 · Environmental Data Explorer" });
  const page = writer(doc, autoTable);
  const now = new Date();
  const time = `${localDate(now)} ${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}`;
  const dataset = [state.dataset?.title, state.dataset?.revision].filter(Boolean).join(" ");
  // A conversation says how many questions it has; one answer is numbered in its own box.
  const count = counted ? `${turns.length} ${turns.length === 1 ? "pregunta" : "preguntas"}` : "";
  await page.header(title, [dataset && `dataset ${dataset}`, count, time].filter(Boolean).join("  ·  "));
  for (const [index, item] of turns.entries()) {
    if (index) page.rule();
    await page.turn(item, numbers[index]);
  }
  page.appendix();
  page.footers();
  downloadFile(file, doc.output("blob"), "application/pdf");
}

// Runs a download from a button, which shows it is working and says so when it fails.
async function fromButton(button, work) {
  if (button.disabled) return;
  const label = button.querySelector("b");
  const original = label?.textContent;
  button.disabled = true;
  button.classList.add("working");
  try {
    await work();
  } catch (error) {
    console.error(error);
    if (label) label.textContent = "Failed";
    window.setTimeout(() => { if (label) label.textContent = original; }, 1800);
  } finally {
    button.disabled = false;
    button.classList.remove("working");
  }
}

export function downloadConversation(button) {
  return fromButton(button, async () => {
    const turns = turnsOf($("chatLog"));
    if (!turns.length) return;
    await build(turns, { title: "Informe del asistente", file: `kipu360-asistente-${localDate()}.pdf`, numbers: turns.map((_, index) => index + 1), counted: true });
  });
}

export function downloadTurn(button) {
  return fromButton(button, async () => {
    const closing = button.closest(".turn-actions");
    const turns = turnsOf($("chatLog"));
    const index = turns.findIndex((item) => item.closing === closing);
    if (index < 0) return;
    await build([turns[index]], { title: "Respuesta del asistente", file: `kipu360-asistente-respuesta-${index + 1}-${localDate()}.pdf`, numbers: [index + 1] });
  });
}
