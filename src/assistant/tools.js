import { state } from "../state.js";
import { parameterLabel } from "../config.js";
import { plural, toCsv } from "../lib/format.js";
import { quote, readOnlySql } from "../lib/sql.js";
import { query } from "../data/database.js";
import { METRICS } from "../data/metrics.js";
import { densestStations, showExplorerMap, showFlow, showStations, showThematic } from "../map/assistant-layer.js";
import { applyFilters, applySql } from "../panel/explorer.js";
import { clearAreas } from "../map/areas.js";
import { readDocument } from "./prompt.js";

const sql = { type: "string", description: "One read-only DuckDB SELECT or WITH query" };
const keepArea = { type: "boolean", description: "Keep the area or stations from your earlier answer" };
const mapElement = { type: "string", description: "parameter_code the map is coloured by" };

const DEFINITIONS = [
  ...Object.entries(METRICS).map(([name, metric]) => ({ name, description: metric.description, input_schema: metric.input_schema })),
  {
    name: "run_sql",
    description: "One read-only DuckDB query over observations (other tables through read_parquet). Returns up to 25 rows as CSV; stations in the result are numbered on the map, coloured by parameter. Only when no metric fits.",
    input_schema: { type: "object", properties: { sql, parameter: mapElement }, required: ["sql"] },
  },
  {
    name: "draw_map",
    description: "Any map the question needs that no metric draws: one value per station from a query (a count, a ratio, an index, a year...), coloured on a ramp with a legend. The query returns station_code and the value, highest first.",
    input_schema: {
      type: "object",
      properties: {
        sql,
        title: { type: "string", description: "What the colours mean, e.g. Copper to molybdenum ratio" },
        caption: { type: "string", description: "One short line on how the value was computed" },
      },
      required: ["sql", "title"],
    },
  },
  {
    name: "set_filters",
    description: "Set the element, quality and years shown on the map, table and statistics.",
    input_schema: {
      type: "object",
      properties: {
        parameter: { type: "string", description: "parameter_code, or all for every element" },
        quality: { type: "string", enum: ["VALID", "all", "PENDING_REVIEW", "EXCLUDED_FROM_ANALYSIS"] },
        from_year: { type: "integer" },
        to_year: { type: "integer" },
        keep_area: keepArea,
      },
    },
  },
  {
    name: "update_map",
    description: "Show a custom selection on the map: SELECT * FROM observations WHERE ... for one parameter.",
    input_schema: { type: "object", properties: { sql, keep_area: keepArea }, required: ["sql"] },
  },
  {
    name: "mark_area",
    description: "Only when the user asks for an area around some stations: a polygon around the stations a query returns (station_code), used as the spatial filter.",
    input_schema: { type: "object", properties: { sql, parameter: mapElement }, required: ["sql"] },
  },
  {
    name: "create_chart",
    description: "Chart from a query when no metric draws the one you need: line (time), bar (groups), histogram (distribution of x) or scatter.",
    input_schema: {
      type: "object",
      properties: {
        sql,
        type: { type: "string", enum: ["line", "bar", "histogram", "scatter"] },
        x: { type: "string", description: "Column for the x axis, or the values of a histogram" },
        y: { type: "string", description: "Numeric column for the y axis (not needed for a histogram)" },
        series: { type: "string", description: "Column that splits the rows into one line or bar per value" },
        log: { type: "boolean", description: "Logarithmic value axis, for concentrations" },
        title: { type: "string" },
      },
      required: ["sql", "type", "x", "title"],
    },
  },
  {
    name: "read_doc",
    description: "patterns: verified SQL recipes for run_sql. changelog: release history, only when asked why data was changed or excluded.",
    input_schema: { type: "object", properties: { name: { type: "string", enum: ["patterns", "changelog"] } }, required: ["name"] },
  },
];

// Inputs stream eagerly, so the API no longer validates them against the schema.
export const TOOLS = DEFINITIONS.map((tool) => ({ ...tool, eager_input_streaming: true }));

function unknownCode(input) {
  const unknown = [input.parameter, ...(input.parameters ?? [])].filter((code) => code && code !== "all" && !state.dataset.parameters[code]);
  return unknown.length ? `Unknown parameter_code ${unknown.join(", ")}. Valid codes: ${Object.keys(state.dataset.parameters).join(", ")}.` : null;
}

export function validateInput(name, input) {
  const tool = DEFINITIONS.find((item) => item.name === name);
  if (!tool) return `Unknown tool ${name}.`;
  if (!input || typeof input !== "object" || Array.isArray(input)) return "The input must be an object.";
  const { properties, required = [] } = tool.input_schema;
  for (const key of required) if (input[key] == null || input[key] === "") return `Missing ${key}.`;
  for (const [key, value] of Object.entries(input)) {
    const schema = properties[key];
    if (!schema) return `Unknown field ${key}.`;
    if (schema.type === "integer" && !Number.isInteger(value)) return `${key} must be an integer.`;
    if (schema.type === "number" && !Number.isFinite(value)) return `${key} must be a number.`;
    if (schema.type === "string" && typeof value !== "string") return `${key} must be a string.`;
    if (schema.type === "boolean" && typeof value !== "boolean") return `${key} must be true or false.`;
    if (schema.type === "array" && !(Array.isArray(value) && value.length && value.every((item) => typeof item === "string"))) return `${key} must be a list of codes.`;
    if (schema.enum && !schema.enum.includes(value)) return `${key} must be one of ${schema.enum.join(", ")}.`;
  }
  return null;
}

// Six significant digits are plenty and drop float noise such as 41.245000000000005.
function tidy(row) {
  return Object.fromEntries(Object.entries(row).map(([key, value]) => [key, typeof value === "number" && !Number.isInteger(value) ? Number(value.toPrecision(6)) : value]));
}

// CSV for the model. A column with the same value in every row is stated once above it.
function asTable(rows, limit = 25) {
  if (!rows.length) return "0 rows";
  rows = rows.map(tidy);
  const shown = rows.slice(0, limit);
  const note = rows.length > shown.length ? ` (first ${shown.length} shown)` : "";
  const same = rows.length > 1 ? Object.keys(rows[0]).filter((column) => rows.every((row) => String(row[column]) === String(rows[0][column]))) : [];
  const columns = Object.keys(rows[0]).filter((column) => !same.includes(column));
  const constants = same.length ? `\n${same.map((column) => `${column}: ${rows[0][column]}`).join(", ")}` : "";
  return `${plural(rows.length, "row")}${note}${constants}\n${toCsv(columns, shown)}`;
}

async function selectRows(text, limit = 200) {
  return query(`SELECT * FROM (${readOnlySql(text)}) AS assistant_query LIMIT ${limit}`, { dates: true });
}

// A new map request starts from the whole dataset unless it refers to the last answer.
async function dropAssistantArea(keep) {
  if (!keep && state.area.byAssistant) await clearAreas({ refresh: false });
}

// Shows the stations of a query result on the map, with its element when there is one.
async function showRows(rows, parameter) {
  const codes = [...new Set(rows.map((row) => row.station_code).filter(Boolean))];
  if (!codes.length) return 0;
  const parameters = [...new Set(rows.map((row) => row.parameter_code).filter(Boolean))];
  try {
    const element = parameter ?? (parameters.length === 1 ? parameters[0] : undefined);
    const { shown } = await showStations(codes, { parameter: element, caption: `Stations in the query result${element ? `, ${parameterLabel(element)}` : ""}` });
    return shown.length;
  } catch {
    return 0;
  }
}

// A station code the dataset does not know gets the closest ones back, so a typo costs
// one short retry instead of an empty answer.
async function checkStation(code) {
  const [found] = await query(`SELECT count(*) AS n FROM observations WHERE station_code = ${quote(code)}`);
  if (found.n) return;
  const close = await query(`
    SELECT station_code FROM (SELECT DISTINCT station_code FROM observations WHERE station_code IS NOT NULL)
    ORDER BY jaro_winkler_similarity(lower(station_code), lower(${quote(code)})) DESC LIMIT 5`);
  throw new Error(`Unknown station_code ${code}. Closest codes: ${close.map((row) => row.station_code).join(", ")}.`);
}

// Where distance_profile measures from when nothing is on the map: the centre of the
// densest group of the stations where most elements exceed their P95.
async function hotspotCentre(context) {
  const rows = await query(METRICS.find_hotspots.sql({ draw_area: true }, context));
  return densestStations(rows.map((row) => row.station_code), new Map(rows.map((row) => [row.station_code, row.elements_above])));
}

async function runMetric(name, input, ui) {
  const metric = METRICS[name];
  if (input.within_area && !state.area.active) {
    throw new Error("There is no area on the map. Outline one first, for example with find_hotspots and draw_area.");
  }
  if (input.station_code) await checkStation(input.station_code);
  if (input.from_station) await checkStation(input.from_station);

  const context = { fieldChemistry: state.dataset.fieldChemistry, contaminants: state.dataset.contaminants };
  let origin = "";
  if (name === "distance_profile" && !input.from_station) {
    if (state.area.active) {
      origin = "\ndistance measured from the centre of the area on the map";
    } else {
      const centre = await hotspotCentre(context);
      input = { ...input, centre_codes: centre };
      origin = `\ndistance measured from the centre of the main hotspot group: ${centre.slice(0, 6).join(", ")}${centre.length > 6 ? " and others" : ""}`;
    }
  }
  // A map of several elements shows every station with an exceedance, not only the first ten.
  if (name === "find_hotspots" && !input.parameter && !input.draw_area && !input.limit) input = { ...input, map_all: true };
  const tables = await Promise.all([metric.sql(input, context)].flat().map((text) => query(text, { dates: true })));
  let [rows] = tables;
  if (metric.reshape) rows = metric.reshape(rows, input);
  let drawn = origin;
  const label = (code) => parameterLabel(code);
  if (name === "find_hotspots" && rows.length && !input.parameter) {
    // Several elements: the map colours each station by how many of them exceed their P95.
    const weights = new Map(rows.map((row) => [row.station_code, row.elements_above]));
    const title = input.parameters
      ? `How many of ${input.parameters.map(label).join(", ")} exceed their dataset P${input.percentile || 95}`
      : `How many ${input.all_elements ? "elements" : "metals of concern"} exceed their dataset P${input.percentile || 95}`;
    const { group, shown } = await showThematic(rows.map((row) => ({ code: row.station_code, value: row.elements_above })), {
      title,
      caption: "At each station, counting every result",
      outline: input.draw_area ? "densest" : null,
      weights,
    });
    if (input.draw_area) {
      const [top] = rows;
      const outside = group.includes(top.station_code) ? "" : `; the top station overall, ${top.station_code}, is outside this area`;
      drawn += `\n${rows.length} stations mapped by how many elements exceed; the area outlines the densest group of ${group.length} and filters the map to it${outside}`;
    } else {
      drawn += `; ${rows.length} stations with at least one element above its P95 mapped by how many exceed, the first 10 numbered`;
    }
    rows = rows.slice(0, 15);
    const unmapped = rows.map((row) => row.station_code).filter((code) => !shown.includes(code));
    if (unmapped.length) drawn += `; not on the map because their coordinates are missing or excluded: ${unmapped.join(", ")}`;
  } else if (name === "find_hotspots" && input.draw_area && rows.length) {
    const weights = new Map(rows.map((row) => [row.station_code, row.results_above]));
    const { shown } = await showStations(rows.map((row) => row.station_code), {
      parameter: input.parameter, area: "densest", weights, caption: `Outlined: the area most affected by ${label(input.parameter)}`,
    });
    const [top] = rows;
    const outside = shown.includes(top.station_code) ? "" : `; the top station overall, ${top.station_code}, is outside this area`;
    const total = rows.length;
    rows = rows.filter((row) => shown.includes(row.station_code)).slice(0, 10);
    drawn += `\n${total} stations are above the threshold; the area outlines the densest group of ${shown.length} (the first ${rows.length} are listed and numbered on the map) and filters the map to it${outside}`;
  } else if (metric.map === "stations" && rows.length) {
    const caption = name === "rank_stations" ? `Stations ranked by ${input.statistic || "max"} ${label(input.parameter)}`
      : name === "stations_near" ? `Stations around ${input.station_code}`
      : name === "catchment_profile" ? `Stations with the largest catchments${input.parameter ? `, ranked by ${label(input.parameter)}` : ""}`
      : `Stations where ${label(input.parameter)} is above its dataset P${input.percentile || 95}`;
    const { shown } = await showStations(rows.map((row) => row.station_code), { parameter: input.parameter, caption });
    drawn += `; ${shown.length} stations numbered on the map`;
  } else if (metric.map === "paired" && rows.length && rows[0].station_code) {
    const codes = [...new Set(rows.flatMap((row) => [row.station_code, row.paired_with]))];
    const { shown } = await showStations(codes, { parameter: input.parameter, caption: `${input.group_a} stations and the nearest ${input.group_b} station of each` });
    drawn += `; ${shown.length} stations numbered on the map`;
  } else if (metric.map === "threshold" && rows.length) {
    const name = input.label || `${input.threshold}`;
    const { shown } = await showThematic(rows.map((row) => ({ code: row.station_code, value: row.times_threshold })), {
      title: `${label(input.parameter)}: highest value against ${name}`,
      caption: `Times ${name} (${input.threshold}); only stations above it`,
    });
    drawn += `; ${shown.length} stations above the value mapped by how many times they exceed it`;
  } else if (metric.map === "trend" && rows.length) {
    const { shown } = await showThematic(rows.map((row) => ({ code: row.station_code, value: row.pct_per_year })), {
      title: `${label(input.parameter)}: change per year, as % of each station's median`,
      caption: "Stations sampled in several years; above zero rises, below zero falls",
    });
    drawn += `; ${shown.length} stations mapped by change per year, the ten that rise most numbered`;
  } else if (metric.map === "flow" && rows.length) {
    const { arrows } = await showFlow(rows, input.parameter);
    drawn += `; ${arrows} pairs drawn as arrows from upstream to downstream`;
  } else if (metric.map === "station" && rows.length) {
    const element = input.parameters?.[0];
    const shown = await showStations([input.station_code], { parameter: element, caption: `Station ${input.station_code}${element ? `, ${label(element)}` : ""}` }).catch(() => null);
    drawn += shown ? "; station shown on the map" : "; the station has no usable coordinates";
  }
  if (metric.chart && rows.length) {
    const chartRows = metric.chartSql?.(input) ? await query(metric.chartSql(input), { dates: true }) : rows;
    const spec = metric.chart(chartRows, input, tables, parameterLabel);
    if (spec && spec.rows.length) {
      ui.chart?.(spec);
      drawn += "; chart drawn in the conversation";
    }
  }
  const tablesText = [asTable(rows, metric.contentLimit ?? 120), ...tables.slice(1).map((table) => asTable(table))].join("\n\n");
  return { summary: `${name.replaceAll("_", " ")} · ${plural(rows.length, "row")}`, content: `${tablesText}${metric.note?.(rows, input) ?? ""}${drawn}` };
}

const HANDLERS = {
  async run_sql({ sql: text, parameter }) {
    const rows = await selectRows(text);
    const drawn = await showRows(rows, parameter);
    return { summary: `${plural(rows.length, "row")}${drawn ? ` · ${drawn} on the map` : ""}`, content: `${asTable(rows)}${drawn ? `\n${drawn} stations shown on the map` : ""}` };
  },
  async draw_map({ sql: text, title, caption }) {
    const rows = await selectRows(text, 2000);
    if (!rows.length || !("station_code" in rows[0])) throw new Error("The query must return station_code and a numeric value.");
    const column = Object.keys(rows[0]).find((key) => key === "value") ?? Object.keys(rows[0]).find((key) => key !== "station_code" && typeof rows[0][key] === "number");
    if (!column) throw new Error("The query must return a numeric value column.");
    const { shown, missing } = await showThematic(rows.map((row) => ({ code: row.station_code, value: row[column] })), { title, caption });
    return {
      summary: `Map · ${plural(shown.length, "station")}`,
      content: `${asTable(rows)}\n${shown.length} stations coloured by ${column}${missing ? `; ${missing} without coordinates or value` : ""}`,
    };
  },
  async set_filters({ parameter, quality, from_year, to_year, keep_area }) {
    if (parameter && parameter !== "all" && !state.dataset.parameters[parameter]) throw new Error(`Unknown parameter_code ${parameter}.`);
    const changes = {};
    if (parameter) changes.parameter = parameter;
    if (quality) changes.quality = quality;
    if (from_year) changes.from = from_year;
    if (to_year) changes.to = to_year;
    await dropAssistantArea(keep_area);
    await applyFilters(changes);
    showExplorerMap(`${parameterLabel(state.filters.parameter)}, ${state.filters.from} to ${state.filters.to}`);
    return { summary: `Filters set · ${plural(state.table.total, "measurement")}`, content: `ok: ${state.table.total} results, ${state.map.features.length} on the map` };
  },
  async update_map({ sql: text, keep_area }) {
    await dropAssistantArea(keep_area);
    await applySql(text);
    showExplorerMap(`Custom selection, ${parameterLabel(state.sql.parameter)}`);
    return { summary: `Map updated · ${plural(state.map.features.length, "point")}`, content: `ok: ${state.table.total} results, ${state.map.features.length} on the map` };
  },
  async mark_area({ sql: text, parameter }) {
    const rows = await selectRows(text, 50);
    const codes = [...new Set(rows.map((row) => row.station_code).filter(Boolean))];
    if (!codes.length) throw new Error("The query must return a station_code column with at least one station.");
    const { shown, missing } = await showStations(codes, { area: "all", parameter, caption: "Outlined: the stations of the query" });
    return {
      summary: `Area marked · ${plural(shown.length, "station")}`,
      content: `ok: area drawn around ${shown.length} stations (${shown.join(", ")}) and applied as the spatial filter; ${state.table.total} results inside.${missing ? ` ${missing} stations have no usable coordinates.` : ""}`,
    };
  },
  async create_chart({ sql: text, type, x, y, series, log, title }, ui) {
    const rows = await selectRows(text, 5000);
    if (!rows.length) throw new Error("The chart query returned no rows.");
    if (!(x in rows[0])) throw new Error(`Column ${x} is not in the result.`);
    if (type !== "histogram" && !(y in rows[0])) throw new Error(`Column ${y} is not in the result.`);
    ui.chart?.({ rows, type, x, y, series, log, title });
    return { summary: `Chart · ${title}`, content: `ok: chart drawn with ${rows.length} points` };
  },
  async read_doc({ name }) {
    const text = await readDocument(name);
    return { summary: `Read ${name}`, content: text.slice(0, 8000) };
  },
};

export async function runTool(name, input, ui = {}) {
  const problem = validateInput(name, input) ?? unknownCode(input);
  if (problem) return { summary: `Invalid input · ${problem}`, content: problem, isError: true };
  try {
    return METRICS[name] ? await runMetric(name, input, ui) : await HANDLERS[name](input, ui);
  } catch (error) {
    return { summary: `Error · ${error.message}`, content: error.message || String(error), isError: true };
  }
}
