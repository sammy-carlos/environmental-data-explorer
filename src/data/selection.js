import { state } from "../state.js";
import { quote } from "../lib/sql.js";
import { formatNumber } from "../lib/format.js";

export const LOCATED = "coordinate_status IN ('VALID', 'PENDING_REVIEW') AND easting_m IS NOT NULL AND northing_m IS NOT NULL";
// A measured value is reported without "<" and above zero: some historical sheets record
// an undetected value as 0, which is not a measurement.
export const MEASURED = "numeric_value > 0 AND qualifier = 'EQUAL'";

export function recordedAsZero(row) {
  return row.qualifier === "EQUAL" && Number(row.numeric_value) === 0;
}

// What a result reads as: below-limit results as "< limit" without the trailing zeros the
// sources carry, and a value recorded as 0 marked, since it is not a measurement.
export function valueText(row, { unit = row.reported_unit, note = true } = {}) {
  if (recordedAsZero(row)) return note ? "0 · not measured" : "0";
  const value = row.qualifier === "LESS_THAN" && row.reported_limit != null
    ? `< ${formatNumber(row.reported_limit)}`
    : row.reported_value ?? (row.numeric_value == null ? null : formatNumber(row.numeric_value));
  if (value == null || !String(value).trim()) return "–";
  return [value, unit].filter((part) => part != null && String(part).trim()).join(" ");
}

// Most stations were sampled once, for geochemical prospecting; only the monitoring
// network repeats. This keeps the stations that have several dates for what is selected.
export function repeatedStations() {
  const parameter = state.mode === "sql" || state.filters.parameter === "all" ? "" : `parameter_code = ${quote(state.filters.parameter)} AND `;
  return `station_id IN (SELECT station_id FROM observations WHERE ${parameter}${MEASURED} GROUP BY station_id HAVING count(DISTINCT sampling_date) > 1)`;
}

export function selectionSource() {
  return state.mode === "sql" && state.sql.query ? `(${state.sql.query}) AS selection` : "observations";
}

// mapOnly: false (table), "located" (anything with coordinates) or true (located and measured).
// spatial: "inside" the drawn areas, "outside" them, or "ignore" them.
// years: false leaves the period out, for the map, which filters years itself.
export function selectionWhere({ mapOnly = false, spatial = "inside", years = true } = {}) {
  const clauses = [];
  if (state.mode !== "sql") {
    const { parameter, quality, from, to } = state.filters;
    if (parameter !== "all") clauses.push(`parameter_code = ${quote(parameter)}`);
    if (years) clauses.push(`year(sampling_date) BETWEEN ${Number(from)} AND ${Number(to)}`);
    if (quality !== "all") clauses.push(`quality_status = ${quote(quality)}`);
  }
  if (state.filters.repeated) clauses.push(repeatedStations());
  if (mapOnly === true) clauses.push(MEASURED);
  if (mapOnly) clauses.push(LOCATED);
  if (state.area.active && spatial !== "ignore") {
    clauses.push(`CAST(station_id AS VARCHAR) ${spatial === "outside" ? "NOT IN" : "IN"} (SELECT station_id FROM spatial_selection)`);
  }
  return clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
}

export function selectionSql(options) {
  return `SELECT * FROM ${selectionSource()} ${selectionWhere(options)}`.trim();
}
