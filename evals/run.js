// Asks the assistant the questions in evals/questions.json through the real chat panel
// and checks each answer against values computed beforehand with DuckDB. Every run
// spends API credit: a few cents per question with Claude Opus 5.
//
// Open the site on localhost, sign in, add an API key in the assistant, then run this
// in the browser console:
//
//   const { runEvals } = await import("/evals/run.js");
//   await runEvals();                          // every question
//   await runEvals(["copper-top-station"]);    // only some of them

import { currentParameter, state } from "../src/state.js";
import { applyFilters } from "../src/panel/explorer.js";
import { showTab } from "../src/panel/layout.js";
import { clearAreas } from "../src/map/areas.js";
import { draw } from "../src/map/map.js";

const TIMEOUT = 180000;

// Reads "9,270", "9.270", "13.42" or "13,42" both the English and the Spanish way.
function readings(token) {
  return [Number(token.replaceAll(",", "")), Number(token.replaceAll(".", "").replace(",", "."))].filter(Number.isFinite);
}

function mentions(text, expected) {
  const close = (value) => Math.abs(value - expected) <= Math.abs(expected) * 0.02
    || (Math.abs(expected) >= 10 && Math.round(value) === Math.round(expected));
  return (text.match(/\d+(?:[.,]\d+)*/g) ?? []).some((token) => readings(token).some(close));
}

async function resetPage() {
  document.getElementById("newChat").click();
  await clearAreas({ refresh: false });
  await applyFilters({ parameter: state.dataset.defaultParameter, quality: "VALID", from: state.years.first, to: state.years.last });
}

function ask(question) {
  const answered = new Promise((resolve, reject) => {
    const timer = window.setTimeout(() => reject(new Error(`No answer after ${TIMEOUT / 1000} s: ${question}`)), TIMEOUT);
    document.addEventListener("assistant:answered", (event) => {
      window.clearTimeout(timer);
      resolve(event.detail);
    }, { once: true });
  });
  const input = document.getElementById("question");
  input.value = question;
  input.form.requestSubmit();
  return answered;
}

function check({ expect = {} }, detail) {
  const failures = [];
  const tools = detail.steps.map((step) => step.name);
  if (detail.error) failures.push(detail.error);
  if (expect.tools && !expect.tools.some((name) => tools.includes(name))) failures.push(`expected ${expect.tools.join(" or ")}`);
  for (const text of expect.text ?? []) {
    if (!detail.answer.toLowerCase().includes(text.toLowerCase())) failures.push(`missing "${text}"`);
  }
  for (const value of expect.numbers ?? []) {
    if (!mentions(detail.answer, value)) failures.push(`missing ${value}`);
  }
  if (expect.area && !state.area.active) failures.push("no area on the map");
  if (expect.polygon === false && draw.getAll().features.length) failures.push("drew a polygon nobody asked for");
  const elements = [expect.parameter ?? []].flat();
  if (elements.length && !elements.includes(currentParameter())) failures.push(`map shows ${currentParameter()}, not ${elements.join(" or ")}`);
  return failures;
}

export async function runEvals(ids) {
  if (!state.ready) throw new Error("Wait until the map has loaded.");
  if (document.getElementById("keyToggle").classList.contains("missing")) throw new Error("Add an Anthropic API key in the assistant first.");
  const cases = await fetch(new URL("questions.json", import.meta.url), { cache: "no-cache" }).then((response) => response.json());
  const selected = ids ? cases.filter((item) => ids.includes(item.id)) : cases;
  showTab("assistant");

  const results = [];
  for (const testCase of selected) {
    await resetPage();
    let detail = null;
    let cost = 0;
    for (const question of [testCase.question].flat()) {
      detail = await ask(question);
      cost += detail.cost ?? 0;
    }
    const failures = check(testCase, detail);
    results.push({ id: testCase.id, passed: !failures.length, failures, tools: detail.steps.map((step) => step.name), cost, answer: detail.answer, review: testCase.review ?? "" });
    console.info(`${failures.length ? "fail" : "pass"} ${testCase.id} · $${cost.toFixed(3)}${failures.length ? ` · ${failures.join("; ")}` : ""}`);
  }
  await resetPage();

  const total = results.reduce((sum, result) => sum + result.cost, 0);
  console.table(results.map(({ id, passed, tools, cost, failures }) => ({ id, passed, tools: tools.join(", "), cost: Number(cost.toFixed(3)), failures: failures.join("; ") })));
  console.info(`${results.filter((result) => result.passed).length} of ${results.length} passed · $${total.toFixed(3)} in total`);
  return results;
}
