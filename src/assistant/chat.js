import { state } from "../state.js";
import { ownApiKey, setOwnApiKey } from "../auth/credentials.js";
import { escapeHtml } from "../lib/format.js";
import { codeBlock, markdownToHtml } from "../lib/markdown.js";
import { assistantDrawings, clearAssistantDrawings } from "../map/assistant-layer.js";
import { Anthropic, modelLabel, streamTurn } from "./claude.js";
import { renderChart } from "./charts.js";
import { downloadConversation, downloadTurn, keepTurnMap } from "./report.js";
import { selectionNote, systemPrompt } from "./prompt.js";
import { TOOLS, runTool } from "./tools.js";

const $ = (id) => document.getElementById(id);
const EMPTY_CHAT = '<p class="chat-empty">Ask anything about the data: a summary, the highest values, a trend over time or a comparison between campaigns. Answers follow the current selection in Data explorer.</p>';
const STEP_LABELS = {
  describe_data: "Checking the data…",
  summarize_parameter: "Summarizing…",
  distribution: "Looking at the distribution…",
  rank_stations: "Ranking stations…",
  stations_near: "Looking around the station…",
  find_hotspots: "Looking for hotspots…",
  compare_area: "Comparing the area with the rest…",
  compare_zones: "Comparing rivers and sites…",
  annual_trend: "Computing the trend…",
  compare_trends: "Comparing trends…",
  station_trends: "Checking the trend at each station…",
  compare_periods: "Comparing periods…",
  compare_seasons: "Comparing wet and dry seasons…",
  compare_campaigns: "Comparing campaigns…",
  compare_elements: "Comparing elements…",
  element_families: "Finding which elements travel together…",
  distance_profile: "Measuring the change with distance…",
  compare_site_types: "Comparing tailings, mine works and rivers…",
  flow_pairs: "Comparing upstream and downstream…",
  above_threshold: "Comparing with the value…",
  compare_sources: "Comparing sources…",
  correlate_elements: "Checking which elements move together…",
  describe_station: "Reading the station…",
  station_history: "Reading the station history…",
  draw_map: "Drawing a map…",
  run_sql: "Querying DuckDB…",
  set_filters: "Changing filters…",
  update_map: "Updating the map…",
  mark_area: "Marking the area…",
  create_chart: "Drawing a chart…",
  read_doc: "Reading documentation…",
};

const DOWNLOAD_ICON = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 4v11M7.5 10.5 12 15l4.5-4.5M5 19h14"/></svg>';

const history = [];
let busy = false;
// How many drawings the map had when the current question was asked.
let drawingsBefore = 0;

function apiKey() {
  return ownApiKey() || state.session?.anthropicApiKey || "";
}

function append(element) {
  const log = $("chatLog");
  log.querySelector(".chat-empty")?.remove();
  log.append(element);
  log.scrollTop = log.scrollHeight;
  return element;
}

function message(role, content) {
  const element = document.createElement("div");
  element.className = `chat-message ${role}`;
  if (role === "assistant") element.innerHTML = markdownToHtml(content);
  else element.textContent = content;
  return append(element);
}

// Closes an answer with its download button. When the answer drew on the map, the map is
// kept as it is now, so the PDF shows what this answer showed.
function closeTurn() {
  const closing = append(Object.assign(document.createElement("div"), {
    className: "turn-actions",
    innerHTML: `<button class="turn-pdf" type="button" title="Download this answer as a PDF">${DOWNLOAD_ICON}<b>PDF</b></button>`,
  }));
  keepTurnMap(closing, assistantDrawings() !== drawingsBefore);
}

function describeError(error) {
  if (error instanceof Anthropic.AuthenticationError) return "The API key was rejected. Add a valid key with the key button below.";
  if (error instanceof Anthropic.RateLimitError) return "The assistant is busy (rate limit). Wait a moment and try again.";
  if (error instanceof Anthropic.BadRequestError && /not scoped to a workspace/i.test(error.message)) {
    return "This key works across several workspaces. In the Claude Console, create a key inside one workspace (Settings > API keys) and add that one.";
  }
  if (error instanceof Anthropic.BadRequestError && /credit balance/i.test(error.message)) {
    return "This key has run out of credit. Add credit in the Claude Console (Settings > Billing) or use another key.";
  }
  if (error instanceof Anthropic.APIError) return `The assistant service answered ${error.status ?? ""}: ${error.message}`;
  return error.message || String(error);
}

async function runStep(block) {
  const step = document.createElement("details");
  step.className = "tool-step running";
  // The PDF reads the tool back, to say in its appendix what each query was for.
  step.dataset.tool = block.name;
  step.innerHTML = `<summary>${escapeHtml(STEP_LABELS[block.name] || block.name)}</summary>${typeof block.input?.sql === "string" ? codeBlock(block.input.sql, "sql") : ""}`;
  append(step);
  const result = await runTool(block.name, block.input, { chart: (spec) => renderChart($("chatLog"), spec) });
  step.classList.remove("running");
  step.classList.toggle("failed", Boolean(result.isError));
  step.querySelector("summary").textContent = result.summary;
  return { type: "tool_result", tool_use_id: block.id, content: result.content, ...(result.isError ? { is_error: true } : {}) };
}

// Adds up the tokens of every request a question needed and logs what it cost.
function addUsage(total, usage) {
  if (!usage) return;
  total.input += usage.input_tokens ?? 0;
  total.cacheWrite += usage.cache_creation_input_tokens ?? 0;
  total.cacheRead += usage.cache_read_input_tokens ?? 0;
  total.output += usage.output_tokens ?? 0;
}

function costOf(total) {
  const price = state.assistant.pricePerMTok;
  if (!price) return null;
  return (total.input * price.input + total.cacheWrite * price.cacheWrite + total.cacheRead * price.cacheRead + total.output * price.output) / 1e6;
}

function logCost(total) {
  const input = total.input + total.cacheWrite + total.cacheRead;
  if (!input) return;
  const cost = costOf(total);
  console.info(`Question used ${input.toLocaleString()} input tokens (${total.cacheRead.toLocaleString()} from cache) and ${total.output.toLocaleString()} output tokens${cost == null ? "" : `, about $${cost.toFixed(3)}`}`);
}

async function ask(question) {
  busy = true;
  updateComposer();
  message("user", question);
  drawingsBefore = assistantDrawings();
  const start = history.length;
  history.push({ role: "user", content: `${question}\n\n${selectionNote()}` });
  const typing = append(Object.assign(document.createElement("div"), { className: "typing", innerHTML: "<i></i><i></i><i></i>" }));
  let parseRetries = 0;
  let answer = "";
  let failure = null;
  const steps = [];
  const usage = { input: 0, cacheWrite: 0, cacheRead: 0, output: 0 };
  try {
    const system = await systemPrompt();
    for (let step = 0; step < state.assistant.maxSteps; step += 1) {
      let bubble = null;
      let text = "";
      let frame = 0;
      const onText = (delta) => {
        text += delta;
        bubble ??= append(Object.assign(document.createElement("div"), { className: "chat-message assistant" }));
        typing.remove();
        cancelAnimationFrame(frame);
        frame = requestAnimationFrame(() => {
          bubble.innerHTML = markdownToHtml(text);
          $("chatLog").scrollTop = $("chatLog").scrollHeight;
        });
      };
      let reply;
      try {
        reply = await streamTurn({ apiKey: apiKey(), system, tools: TOOLS, messages: history, onText });
        addUsage(usage, reply.usage);
        parseRetries = 0;
      } catch (error) {
        // With eager input streaming an unparseable tool input rejects the stream; re-issue that turn.
        if (error instanceof Anthropic.APIError || parseRetries++ >= 2) throw error;
        bubble?.remove();
        continue;
      }
      if (bubble) {
        cancelAnimationFrame(frame);
        bubble.innerHTML = markdownToHtml(text);
      }
      if (text) answer = text;
      history.push({ role: "assistant", content: reply.content });
      if (reply.stop_reason === "refusal") {
        failure = "The assistant declined this request.";
        message("error", failure);
        return;
      }
      if (reply.stop_reason === "max_tokens") {
        failure = "The answer was cut off. Try a narrower question.";
        message("error", failure);
        return;
      }
      const toolUses = reply.content.filter((block) => block.type === "tool_use");
      if (reply.stop_reason !== "tool_use" || !toolUses.length) return;
      const results = [];
      for (const block of toolUses) {
        const result = await runStep(block);
        steps.push({ name: block.name, input: block.input, isError: Boolean(result.is_error) });
        results.push(result);
      }
      history.push({ role: "user", content: results });
      append(typing);
    }
    failure = "The assistant stopped after several steps without a final answer. Try asking more specifically.";
    message("error", failure);
  } catch (error) {
    console.error(error);
    history.length = start;
    failure = describeError(error);
    message("error", failure);
  } finally {
    logCost(usage);
    // Lets scripts such as evals/run.js follow each answer without reading the page.
    document.dispatchEvent(new CustomEvent("assistant:answered", { detail: { question, answer, steps, usage, cost: costOf(usage), error: failure } }));
    typing.remove();
    if (answer) closeTurn();
    busy = false;
    updateComposer();
  }
}

function updateComposer() {
  const question = $("question");
  const ready = Boolean(apiKey());
  question.disabled = !ready || busy;
  question.placeholder = ready ? "For example: which stations have the highest copper?" : "Add an Anthropic API key with the key button below to start";
  document.querySelector(".composer button[type=submit]").disabled = !ready || busy || !question.value.trim();
  $("newChat").hidden = busy || !$("chatLog").querySelector(".chat-message");
  $("exportChat").hidden = busy || !$("chatLog").querySelector(".turn-actions");
}

function renderKeyStatus() {
  const own = Boolean(ownApiKey());
  const demo = Boolean(state.session?.anthropicApiKey);
  $("keyStatus").textContent = `${own ? "Your key" : demo ? "Demo key" : "No key · add yours"} · ${modelLabel()}`;
  $("keyToggle").classList.toggle("missing", !own && !demo);
  $("keyClear").hidden = !own;
  $("keyClear").textContent = demo ? "Use demo key" : "Remove key";
  updateComposer();
}

// A turn decided outside the page, for trying questions without the API: a developer
// tool acting as the model shows the question, runs each tool through the same steps
// and charts, reads what the tool returned, and writes the answer.
export function playQuestion(question) {
  message("user", question);
  drawingsBefore = assistantDrawings();
  return selectionNote();
}

export async function playStep(name, input) {
  const result = await runStep({ id: `local_${Date.now()}`, name, input });
  return result.content;
}

export function playAnswer(text) {
  message("assistant", text);
  closeTurn();
  updateComposer();
}

export function bindChat() {
  const form = document.querySelector(".composer");
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    const text = $("question").value.trim();
    if (!text || busy || !apiKey()) return;
    $("question").value = "";
    ask(text);
  });
  $("question").addEventListener("input", updateComposer);
  $("question").addEventListener("keydown", (event) => {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      form.requestSubmit();
    }
  });
  $("newChat").addEventListener("click", () => {
    history.length = 0;
    $("chatLog").innerHTML = EMPTY_CHAT;
    clearAssistantDrawings();
    updateComposer();
  });
  $("exportChat").addEventListener("click", () => downloadConversation($("exportChat")));
  $("chatLog").addEventListener("click", async (event) => {
    const pdf = event.target.closest(".turn-pdf");
    if (pdf) {
      downloadTurn(pdf);
      return;
    }
    const button = event.target.closest(".copy-button");
    if (!button) return;
    const label = button.querySelector("b");
    try {
      await navigator.clipboard.writeText(button.closest(".code-block").querySelector("code").textContent);
      label.textContent = "Copied";
    } catch {
      label.textContent = "Copy failed";
    }
    button.classList.add("done");
    window.setTimeout(() => {
      label.textContent = "Copy";
      button.classList.remove("done");
    }, 1400);
  });

  $("keyToggle").addEventListener("click", () => {
    $("keyPanel").hidden = !$("keyPanel").hidden;
    if (!$("keyPanel").hidden) $("keyInput").focus();
  });
  $("keySave").addEventListener("click", () => {
    const value = $("keyInput").value.trim();
    if (!value) return;
    setOwnApiKey(value);
    $("keyInput").value = "";
    $("keyPanel").hidden = true;
    renderKeyStatus();
  });
  $("keyClear").addEventListener("click", () => {
    setOwnApiKey("");
    $("keyPanel").hidden = true;
    renderKeyStatus();
  });
  $("chatLog").innerHTML = EMPTY_CHAT;
  renderKeyStatus();
}
