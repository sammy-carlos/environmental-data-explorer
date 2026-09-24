import { escapeHtml } from "./format.js";

const COPY_ICON = '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="8" y="8" width="12" height="12" rx="2"/><path d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2"/></svg>';

export function codeBlock(code, language = "") {
  return `<div class="code-block"><div class="code-head"><span>${escapeHtml(language || "code")}</span>`
    + `<button class="copy-button" type="button">${COPY_ICON}<b>Copy</b></button></div>`
    + `<pre><code>${escapeHtml(code)}</code></pre></div>`;
}

function inline(text) {
  return escapeHtml(text)
    .replace(/`([^`]+)`/g, "<code>$1</code>")
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/(^|[^*])\*([^*]+)\*/g, "$1<em>$2</em>");
}

const TABLE_ROW = /^\s*\|.*\|\s*$/;
const TABLE_RULE = /^\s*\|[\s:|-]+\|\s*$/;
const LIST_ITEM = /^\s*([-*]|\d+\.)\s+/;

function cells(row) {
  return row.trim().replace(/^\||\|$/g, "").split("|").map((cell) => cell.trim());
}

// A small renderer for the subset of Markdown the assistant writes: paragraphs,
// headings, lists, tables and fenced code.
export function markdownToHtml(text) {
  const lines = String(text || "").replace(/\r/g, "").split("\n");
  const html = [];
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (line.startsWith("```")) {
      const code = [];
      for (index += 1; index < lines.length && !lines[index].startsWith("```"); index += 1) code.push(lines[index]);
      html.push(codeBlock(code.join("\n"), line.slice(3).trim()));
    } else if (TABLE_ROW.test(line)) {
      const block = [];
      for (; index < lines.length && TABLE_ROW.test(lines[index]); index += 1) block.push(lines[index]);
      index -= 1;
      const [head, ...body] = block.filter((row) => !TABLE_RULE.test(row));
      html.push(`<table><thead><tr>${cells(head).map((cell) => `<th>${inline(cell)}</th>`).join("")}</tr></thead>`
        + `<tbody>${body.map((row) => `<tr>${cells(row).map((cell) => `<td>${inline(cell)}</td>`).join("")}</tr>`).join("")}</tbody></table>`);
    } else if (LIST_ITEM.test(line)) {
      const ordered = /^\s*\d+\./.test(line);
      const items = [];
      for (; index < lines.length && LIST_ITEM.test(lines[index]); index += 1) items.push(lines[index].replace(LIST_ITEM, ""));
      index -= 1;
      const tag = ordered ? "ol" : "ul";
      html.push(`<${tag}>${items.map((item) => `<li>${inline(item)}</li>`).join("")}</${tag}>`);
    } else if (/^#{1,6}\s/.test(line)) {
      html.push(`<h4>${inline(line.replace(/^#{1,6}\s/, ""))}</h4>`);
    } else if (line.trim()) {
      html.push(`<p>${inline(line)}</p>`);
    }
  }
  return html.join("");
}
