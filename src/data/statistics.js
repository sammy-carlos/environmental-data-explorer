import { state } from "../state.js";
import { quote } from "../lib/sql.js";
import { query } from "./database.js";
import { MEASURED, selectionSource, selectionWhere } from "./selection.js";

let limits = null;

// P95 and P99 of every parameter across the whole release, the reference for the
// amber and red highlights. They never change with the filters.
export async function parameterLimits() {
  if (limits) return limits;
  const rows = await query(`
    SELECT parameter_code, quantile_cont(numeric_value, 0.95) AS p95, quantile_cont(numeric_value, 0.99) AS p99
    FROM observations WHERE quality_status = 'VALID' AND ${MEASURED}
    GROUP BY parameter_code
  `);
  limits = new Map(rows.map((row) => [row.parameter_code, row]));
  return limits;
}

export async function loadScale(parameter) {
  if (!parameter || parameter === "all") {
    state.scale = { p99: null, stops: null, unit: null };
    return;
  }
  const [row] = await query(`
    SELECT quantile_cont(numeric_value, [0.05, 0.25, 0.5, 0.75, 0.95]) AS stops,
           quantile_cont(numeric_value, 0.99) AS p99,
           mode(reported_unit) AS unit
    FROM observations
    WHERE parameter_code = ${quote(parameter)} AND quality_status = 'VALID' AND ${MEASURED}
  `);
  state.scale = {
    p99: row?.p99 ?? null,
    stops: row?.stops ? Array.from(row.stops, Number) : null,
    unit: row?.unit ?? null,
  };
}

export function exceedanceLevel(value, p95, p99) {
  const number = Number(value);
  if (value == null || !Number.isFinite(number)) return "";
  const reaches = (threshold) => threshold != null && number >= threshold - Math.abs(threshold) * 1e-9;
  if (reaches(p99)) return "p99";
  if (reaches(p95)) return "p95";
  return "";
}

export async function summarizeSelection() {
  const measured = `FILTER (WHERE ${MEASURED})`;
  const [row] = await query(`
    SELECT min(numeric_value) ${measured} AS minimum,
           avg(numeric_value) ${measured} AS mean,
           median(numeric_value) ${measured} AS median,
           quantile_cont(numeric_value, 0.95) ${measured} AS p95,
           quantile_cont(numeric_value, 0.99) ${measured} AS p99,
           max(numeric_value) ${measured} AS maximum
    FROM ${selectionSource()} ${selectionWhere()}
  `);
  return row;
}

export async function yearBounds() {
  const [row] = await query("SELECT min(year(sampling_date)) AS first, max(year(sampling_date)) AS last FROM observations WHERE sampling_date IS NOT NULL");
  state.years = { first: row.first, last: row.last };
  state.filters.from = Math.max(row.first, Math.min(row.last, state.filters.from ?? row.first));
  state.filters.to = Math.max(state.filters.from, Math.min(row.last, state.filters.to ?? row.last));
}
