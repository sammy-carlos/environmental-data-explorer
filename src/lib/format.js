const HTML_ESCAPES = { "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" };

export function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>'"]/g, (character) => HTML_ESCAPES[character]);
}

export function formatNumber(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return "–";
  return number.toLocaleString(undefined, Math.abs(number) < 1 ? { maximumSignificantDigits: 2 } : { maximumFractionDigits: 1 });
}

export function formatDate(value) {
  return value == null ? null : new Date(value).toISOString().slice(0, 10);
}

export function plural(count, singular, pluralForm = `${singular}s`) {
  return `${Number(count).toLocaleString()} ${count === 1 ? singular : pluralForm}`;
}

export function toCsv(columns, rows) {
  const cell = (value) => {
    if (value == null) return "";
    const text = String(value);
    return /[",\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
  };
  return [columns.join(","), ...rows.map((row) => columns.map((column) => cell(row[column])).join(","))].join("\n");
}

export function downloadFile(name, content, type) {
  const link = document.createElement("a");
  link.href = URL.createObjectURL(new Blob([content], { type }));
  link.download = name;
  link.click();
  URL.revokeObjectURL(link.href);
}
