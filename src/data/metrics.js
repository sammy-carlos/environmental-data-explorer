import { formatNumber } from "../lib/format.js";
import { quote, quoteList } from "../lib/sql.js";
import { LOCATED } from "./selection.js";

// Named, parameterised queries the assistant calls instead of writing SQL from
// scratch. Each one encodes the dataset rules (valid results, measured values,
// no substitution of censored results), so common questions always run the same
// verified query.
//
// sql returns one query or a list; the first result is the main table and the others
// travel with it as context. chart turns the main rows into a chart for the
// conversation, map says how the stations are shown, and note adds a line of text.

const SOURCES = { monitoring: "STANDARDIZED", historical: "HISTORICAL_GEOCHEMISTRY" };
const STATISTICS = {
  max: "max(numeric_value)",
  median: "median(numeric_value)",
  mean: "avg(numeric_value)",
  p95: "quantile_cont(numeric_value, 0.95)",
};

const source = { type: "string", enum: ["all", "monitoring", "historical"], description: "Default all" };
const common = {
  source,
  from_year: { type: "integer" },
  to_year: { type: "integer" },
  within_area: { type: "boolean", description: "Only inside the area on the map" },
  zone: { type: "string", description: "Only one river, creek or site from the field sheets, e.g. rio salado or relavera" },
};

// Field-sheet zones are stored without accents and in lower case.
function zoneText(text) {
  return String(text).normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().trim();
}
const parameter = { type: "string", description: "parameter_code: cu, zn, as..." };
const parameters = { type: "array", items: { type: "string" }, description: "parameter_codes" };
const statistic = { type: "string", enum: Object.keys(STATISTICS), description: "Default median (max for rankings)" };
const limit = { type: "integer", description: "Default 10, at most 50" };
const stationCode = { type: "string", description: "station_code, e.g. DB-02" };

function filters({ parameter: code, source: role = "all", from_year, to_year, within_area, zone }, { measured = true } = {}) {
  const clauses = ["quality_status = 'VALID'"];
  if (code) clauses.push(`parameter_code = ${quote(code)}`);
  if (measured) clauses.push("qualifier = 'EQUAL'", "numeric_value > 0");
  if (SOURCES[role]) clauses.push(`data_role = ${quote(SOURCES[role])}`);
  if (Number.isInteger(from_year)) clauses.push(`year(sampling_date) >= ${from_year}`);
  if (Number.isInteger(to_year)) clauses.push(`year(sampling_date) <= ${to_year}`);
  if (within_area) clauses.push("CAST(station_id AS VARCHAR) IN (SELECT station_id FROM spatial_selection)");
  if (zone) clauses.push(`zone LIKE ${quote(`%${zoneText(zone)}%`)}`);
  return clauses.join(" AND ");
}

function measure(name) {
  return STATISTICS[name] || STATISTICS.median;
}

function codes(list, max = 8) {
  return quoteList(list.slice(0, max));
}

// Dataset-wide percentile of every parameter, as a named CTE.
function percentiles(name, fraction) {
  return `${name} AS (
    SELECT parameter_code, quantile_cont(numeric_value, ${fraction}) AS ${name}
    FROM observations WHERE quality_status = 'VALID' AND qualifier = 'EQUAL' AND numeric_value > 0
    GROUP BY parameter_code
  )`;
}

// Reference median and P95 of each parameter. Zeros are left out: some sheets record an
// undetected value as 0, which would make a median of zero and every ratio infinite.
const MEDIANS = `ref AS (
    SELECT parameter_code, median(numeric_value) AS med, quantile_cont(numeric_value, 0.95) AS p95
    FROM observations WHERE quality_status = 'VALID' AND qualifier = 'EQUAL' AND numeric_value > 0
    GROUP BY parameter_code
  )`;

// Average-linkage families of elements from pairwise correlations: groups keep merging
// while the average correlation between them is 0.5 or more.
function families(pairs) {
  const rho = new Map();
  for (const pair of pairs) {
    rho.set(`${pair.element_a}|${pair.element_b}`, pair.rho);
    rho.set(`${pair.element_b}|${pair.element_a}`, pair.rho);
  }
  const elements = [...new Set(pairs.flatMap((pair) => [pair.element_a, pair.element_b]))];
  const get = (a, b) => rho.get(`${a}|${b}`) ?? 0;
  const link = (a, b) => a.reduce((sum, x) => sum + b.reduce((inner, y) => inner + get(x, y), 0), 0) / (a.length * b.length);
  let groups = elements.map((element) => [element]);
  for (;;) {
    let best = null;
    for (let i = 0; i < groups.length; i += 1) {
      for (let j = i + 1; j < groups.length; j += 1) {
        const value = link(groups[i], groups[j]);
        if (!best || value > best.value) best = { i, j, value };
      }
    }
    if (!best || best.value < 0.5) break;
    groups = groups.filter((_, index) => index !== best.i && index !== best.j).concat([[...groups[best.i], ...groups[best.j]]]);
  }
  groups.sort((a, b) => b.length - a.length);
  return elements.map((element) => {
    const family = groups.find((group) => group.includes(element));
    const partners = elements.filter((other) => other !== element).sort((a, b) => get(element, b) - get(element, a)).slice(0, 3);
    return {
      element,
      family: family.length > 1 ? family.join("+") : "on its own",
      closest: partners.map((other) => `${other} ${get(element, other).toFixed(2)}`).join(", "),
    };
  }).sort((a, b) => a.family.localeCompare(b.family));
}

// Least-squares slope and correlation of the yearly values.
function trendNote(rows) {
  const points = rows.map((row) => [Number(row.year), Number(row.value)]).filter(([x, y]) => Number.isFinite(x) && Number.isFinite(y));
  if (points.length < 3) return "";
  const meanX = points.reduce((sum, [x]) => sum + x, 0) / points.length;
  const meanY = points.reduce((sum, [, y]) => sum + y, 0) / points.length;
  let xy = 0;
  let xx = 0;
  let yy = 0;
  for (const [x, y] of points) {
    xy += (x - meanX) * (y - meanY);
    xx += (x - meanX) ** 2;
    yy += (y - meanY) ** 2;
  }
  const slope = xy / xx;
  const r = yy ? xy / Math.sqrt(xx * yy) : 0;
  return `\ntrend of the yearly values: ${slope >= 0 ? "+" : ""}${formatNumber(slope)} per year, r = ${r.toFixed(2)} over ${points.length} years`;
}

export const METRICS = {
  describe_data: {
    description: "What the data covers and how reliable it is: results, samples and stations by source type and quality status with their years, the reasons results were set aside, and the caveats (values below the detection limit or recorded as 0, estimated dates, preliminary or missing coordinates, missing units). Optional parameter.",
    input_schema: { type: "object", properties: { parameter } },
    sql: (input) => {
      const where = input.parameter ? `parameter_code = ${quote(input.parameter)}` : "true";
      return [
        `SELECT data_role, quality_status, count(*) AS results, count(DISTINCT sample_id) AS samples,
                count(DISTINCT station_code) AS stations, min(year(sampling_date)) AS first_year, max(year(sampling_date)) AS last_year
         FROM observations WHERE ${where} GROUP BY ALL ORDER BY results DESC`,
        `SELECT rule AS reason_set_aside, count(*) AS results
         FROM (SELECT unnest(string_split(quality_rules, ',')) AS rule FROM observations
               WHERE ${where} AND quality_status <> 'VALID' AND quality_rules IS NOT NULL)
         GROUP BY rule ORDER BY results DESC LIMIT 12`,
        `SELECT caveat, results, round(100.0 * results / total, 1) AS pct_of_results FROM (
           SELECT count(*) AS total,
                  count(*) FILTER (WHERE qualifier = 'LESS_THAN') AS "below the detection limit",
                  count(*) FILTER (WHERE qualifier = 'EQUAL' AND numeric_value = 0) AS "value recorded as 0, likely not detected",
                  count(*) FILTER (WHERE date_is_estimated) AS "sampling date estimated",
                  count(*) FILTER (WHERE coordinate_status = 'PENDING_REVIEW') AS "coordinates pending review",
                  count(*) FILTER (WHERE easting_m IS NULL OR coordinate_status IN ('EXCLUDED_FROM_ANALYSIS', 'INVALID')) AS "coordinates missing or excluded",
                  count(*) FILTER (WHERE unit_is_inferred) AS "unit inferred, not reported",
                  count(*) FILTER (WHERE reported_unit IS NULL) AS "no unit at all"
           FROM observations WHERE ${where}
         ) UNPIVOT (results FOR caveat IN (COLUMNS(* EXCLUDE total))) ORDER BY results DESC`,
      ];
    },
  },

  summarize_parameter: {
    description: "How much of one parameter: counts, % below the detection limit, min, median, mean, P95, max, stations, years.",
    input_schema: { type: "object", properties: { parameter, ...common }, required: ["parameter"] },
    sql: (input) => `
      SELECT count(*) AS results,
             count(*) FILTER (WHERE qualifier = 'EQUAL' AND numeric_value > 0) AS measured,
             count(*) FILTER (WHERE qualifier = 'EQUAL' AND numeric_value = 0) AS recorded_as_zero,
             count(*) FILTER (WHERE qualifier = 'LESS_THAN') AS below_limit,
             round(100.0 * count(*) FILTER (WHERE qualifier = 'LESS_THAN') / nullif(count(*), 0), 1) AS below_limit_pct,
             min(numeric_value) FILTER (WHERE qualifier = 'EQUAL' AND numeric_value > 0) AS minimum,
             median(numeric_value) FILTER (WHERE qualifier = 'EQUAL' AND numeric_value > 0) AS median,
             avg(numeric_value) FILTER (WHERE qualifier = 'EQUAL' AND numeric_value > 0) AS mean,
             quantile_cont(numeric_value, 0.95) FILTER (WHERE qualifier = 'EQUAL' AND numeric_value > 0) AS p95,
             max(numeric_value) FILTER (WHERE qualifier = 'EQUAL' AND numeric_value > 0) AS maximum,
             count(DISTINCT station_code) AS stations,
             min(year(sampling_date)) AS first_year,
             max(year(sampling_date)) AS last_year,
             any_value(canonical_unit) AS unit
      FROM observations WHERE ${filters(input, { measured: false })}`,
  },

  distribution: {
    description: "How the values of one parameter are spread, in ranges on a log scale, with the ranges above the dataset P95 and P99 marked. Drawn as a histogram.",
    input_schema: { type: "object", properties: { parameter, ...common }, required: ["parameter"] },
    sql: (input) => {
      const thresholds = `thresholds AS (
        SELECT quantile_cont(numeric_value, 0.95) AS p95, quantile_cont(numeric_value, 0.99) AS p99 FROM observations
        WHERE quality_status = 'VALID' AND qualifier = 'EQUAL' AND numeric_value > 0 AND parameter_code = ${quote(input.parameter)}
      )`;
      return [
        `WITH ${thresholds},
         bins AS (SELECT floor(log10(numeric_value) * 4) / 4 AS bin, count(*) AS results
                  FROM observations WHERE ${filters(input)} AND numeric_value > 0 GROUP BY bin)
         SELECT round(power(10, bin), 3) AS from_value, round(power(10, bin + 0.25), 3) AS to_value, results,
                CASE WHEN power(10, bin) >= p99 THEN 'P99' WHEN power(10, bin) >= p95 THEN 'P95' ELSE '' END AS level
         FROM bins, thresholds ORDER BY bin`,
        `WITH ${thresholds}
         SELECT count(*) AS measured, median(numeric_value) AS median, max(numeric_value) AS maximum,
                round(any_value(p95), 2) AS dataset_p95, round(any_value(p99), 2) AS dataset_p99
         FROM observations, thresholds WHERE ${filters(input)}`,
      ];
    },
    chart: (rows, input, _, label) => ({
      type: "bar",
      rows: rows.map((row) => ({ ...row, range: `${formatNumber(row.from_value)} to ${formatNumber(row.to_value)}` })),
      x: "range",
      y: "results",
      levels: "level",
      title: `${label(input.parameter)}: results per range`,
    }),
  },

  rank_stations: {
    description: "Where one parameter is highest: stations ranked by a statistic, shown and labelled on the map.",
    input_schema: {
      type: "object",
      properties: { parameter, statistic, limit, ...common },
      required: ["parameter"],
    },
    sql: (input) => `
      SELECT station_code, ${measure(input.statistic || "max")} AS value, count(*) AS measured, max(sampling_date) AS last_sampled
      FROM observations WHERE ${filters(input)}
      GROUP BY station_code ORDER BY value DESC
      LIMIT ${Math.min(50, input.limit || 10)}`,
    map: "stations",
  },

  stations_near: {
    description: "Stations within a radius of one station (default 2 km), nearest first, with the median and max of a parameter when given. Shown on the map.",
    input_schema: {
      type: "object",
      properties: { station_code: stationCode, radius_km: { type: "number" }, parameter, source },
      required: ["station_code"],
    },
    sql: (input) => {
      const radius = Math.min(20, Math.max(0.1, Number(input.radius_km) || 2)) * 1000;
      const values = input.parameter
        ? `LEFT JOIN observations o ON o.station_code = near.station_code AND ${filters(input)}`
        : "";
      return `
        WITH origin AS (
          SELECT any_value(easting_m) AS x, any_value(northing_m) AS y FROM observations
          WHERE station_code = ${quote(input.station_code)} AND ${LOCATED}
        ),
        places AS (SELECT station_code, any_value(easting_m) AS x, any_value(northing_m) AS y FROM observations WHERE ${LOCATED} GROUP BY station_code),
        near AS (
          SELECT p.station_code, sqrt(power(p.x - origin.x, 2) + power(p.y - origin.y, 2)) AS metres FROM places p, origin
          WHERE sqrt(power(p.x - origin.x, 2) + power(p.y - origin.y, 2)) <= ${radius}
        )
        SELECT near.station_code, round(near.metres / 1000, 2) AS distance_km
               ${input.parameter ? ", median(o.numeric_value) AS median, max(o.numeric_value) AS maximum, count(o.numeric_value) AS measured" : ""}
        FROM near ${values}
        GROUP BY near.station_code, near.metres ORDER BY near.metres LIMIT 25`;
    },
    map: "stations",
  },

  find_hotspots: {
    description: "Stations with the most problems: values above the dataset P95 (or P99), with where each station is when the field sheet says. parameter: one element. parameters: several elements together (e.g. copper and zinc), stations ranked by how many of them exceed their own threshold, with the maximum of each. Neither: the metals and metalloids of concern (Ag, As, Cd, Co, Cr, Cu, Hg, Mo, Ni, Pb, Sb, Se, Tl, Zn), the way to judge overall contamination; all_elements adds major elements such as Al, Fe, K or Na. draw_area outlines the most affected area, only when the user asks for an area.",
    input_schema: {
      type: "object",
      properties: {
        parameter,
        parameters,
        percentile: { type: "integer", enum: [95, 99] },
        limit,
        all_elements: { type: "boolean", description: "Count every element, not only the metals of concern" },
        draw_area: { type: "boolean" },
        ...common,
      },
    },
    sql: (input, context) => input.parameter ? `
      WITH threshold AS (
        SELECT quantile_cont(numeric_value, ${input.percentile === 99 ? 0.99 : 0.95}) AS value FROM observations
        WHERE quality_status = 'VALID' AND qualifier = 'EQUAL' AND numeric_value > 0 AND parameter_code = ${quote(input.parameter)}
      )
      SELECT station_code, count(*) AS results_above, max(numeric_value) AS max_value, round(any_value(threshold.value), 2) AS threshold,
             left(any_value(zone_description), 80) AS described_as
      FROM observations, threshold
      WHERE ${filters(input)} AND numeric_value > threshold.value
      GROUP BY station_code ORDER BY results_above DESC, max_value DESC
      LIMIT ${Math.min(50, input.limit || (input.draw_area ? 30 : 10))}` : `
      WITH ${percentiles("threshold", input.percentile === 99 ? 0.99 : 0.95)}
      SELECT station_code, count(DISTINCT parameter_code) AS elements_above,
             count(*) AS results_above,
             string_agg(DISTINCT parameter_name, ', ' ORDER BY parameter_name) AS elements,
             left(any_value(zone_description), 80) AS described_as
             ${(input.parameters ?? []).slice(0, 4).map((code) => `, max(numeric_value) FILTER (WHERE parameter_code = ${quote(code)}) AS max_${code}`).join("")}
      FROM observations JOIN threshold USING (parameter_code)
      WHERE ${filters(input)} AND numeric_value > threshold.threshold
        ${input.parameters ? `AND parameter_code IN (${codes(input.parameters)})`
          : input.all_elements ? `AND parameter_code NOT IN (${quoteList(context.fieldChemistry)})` : `AND parameter_code IN (${quoteList(context.contaminants)})`}
      GROUP BY station_code ORDER BY elements_above DESC, results_above DESC
      LIMIT ${input.map_all ? 1000 : Math.min(50, input.limit || (input.draw_area ? 30 : 10))}`,
    map: "stations",
  },

  compare_area: {
    description: "The area on the map against everywhere else, for 1 to 8 elements: median and share above the dataset P95 inside and outside, and how many times higher the median is inside. Needs an area on the map. Drawn as a bar chart.",
    input_schema: { type: "object", properties: { parameters, source, from_year: common.from_year, to_year: common.to_year }, required: ["parameters"] },
    needsArea: true,
    sql: (input) => `
      WITH ${percentiles("p95", 0.95)},
      tagged AS (
        SELECT parameter_code, parameter_name, numeric_value, p95.p95,
               CAST(station_id AS VARCHAR) IN (SELECT station_id FROM spatial_selection) AS inside
        FROM observations JOIN p95 USING (parameter_code)
        WHERE ${filters({ ...input, within_area: false })} AND parameter_code IN (${codes(input.parameters)})
      )
      SELECT parameter_code, any_value(parameter_name) AS element,
             count(*) FILTER (WHERE inside) AS results_inside, count(*) FILTER (WHERE NOT inside) AS results_outside,
             median(numeric_value) FILTER (WHERE inside) AS median_inside, median(numeric_value) FILTER (WHERE NOT inside) AS median_outside,
             round(median(numeric_value) FILTER (WHERE inside) / nullif(median(numeric_value) FILTER (WHERE NOT inside), 0), 1) AS times_higher_inside,
             round(100.0 * count(*) FILTER (WHERE inside AND numeric_value > p95) / nullif(count(*) FILTER (WHERE inside), 0), 1) AS above_p95_inside_pct,
             round(100.0 * count(*) FILTER (WHERE NOT inside AND numeric_value > p95) / nullif(count(*) FILTER (WHERE NOT inside), 0), 1) AS above_p95_outside_pct
      FROM tagged GROUP BY parameter_code ORDER BY times_higher_inside DESC NULLS LAST`,
    chart: (rows) => ({
      type: "bar",
      rows,
      x: "element",
      groups: [{ column: "above_p95_inside_pct", label: "Inside the area" }, { column: "above_p95_outside_pct", label: "Everywhere else" }],
      title: "% of results above the dataset P95",
    }),
  },

  compare_zones: {
    description: "By river, creek or site written on the field sheets (column zone, known for about 13% of the samples), for one parameter: results, stations, median, max and share above the dataset P95, with the original description. Drawn as a bar chart.",
    input_schema: { type: "object", properties: { parameter, ...common }, required: ["parameter"] },
    sql: (input) => [
      `WITH ${percentiles("p95", 0.95)}
       SELECT zone, count(*) AS results, count(DISTINCT station_code) AS stations,
              median(numeric_value) AS median, max(numeric_value) AS maximum,
              round(100.0 * count(*) FILTER (WHERE numeric_value > p95.p95) / count(*), 1) AS above_p95_pct,
              left(string_agg(DISTINCT zone_description, ' | '), 140) AS described_as
       FROM observations JOIN p95 USING (parameter_code)
       WHERE ${filters(input)} AND zone IS NOT NULL
       GROUP BY zone ORDER BY median DESC LIMIT 25`,
      `SELECT count(*) FILTER (WHERE zone IS NOT NULL) AS measured_with_zone, count(*) AS measured FROM observations WHERE ${filters(input)}`,
    ],
    chart: (rows, input, _, label) => ({ type: "bar", horizontal: true, rows: rows.slice(0, 15), x: "zone", y: "median", title: `${label(input.parameter)}: median by zone` }),
  },

  annual_trend: {
    description: "Change over time of one parameter: one value per year, drawn as a line chart, with the slope of the trend. Prefer source monitoring (historical dates are partly estimated).",
    input_schema: { type: "object", properties: { parameter, statistic, ...common }, required: ["parameter"] },
    sql: (input) => `
      SELECT year(sampling_date) AS year, ${measure(input.statistic)} AS value, count(*) AS measured
      FROM observations WHERE ${filters(input)}
      GROUP BY year ORDER BY year`,
    chart: (rows, input, _, label) => ({ type: "line", rows, x: "year", y: "value", title: `${input.statistic || "median"} ${label(input.parameter)} per year` }),
    note: trendNote,
  },

  station_trends: {
    description: "Whether values rise or fall at the same places: for every station sampled in at least min_years different years (default 4), the change per year of its yearly median (least squares) as a share of its median, with the correlation r, plus how many stations clearly rise or fall (|r| of 0.5 or more). Stations that clearly rise come first. A large change with a low r comes from one unusual year. Unlike yearly medians, this does not mix the changing set of stations sampled each year. Mapped by change per year.",
    input_schema: { type: "object", properties: { parameter, min_years: { type: "integer", description: "Default 4" }, ...common }, required: ["parameter"] },
    sql: (input) => {
      const fit = `
        per AS (
          SELECT station_code, year(sampling_date) AS year, median(numeric_value) AS value, any_value(zone_description) AS described_as
          FROM observations WHERE ${filters(input)} GROUP BY station_code, year
        ),
        fit AS (
          SELECT station_code, left(any_value(described_as), 60) AS described_as, count(*) AS years, min(year) AS first_year, max(year) AS last_year, median(value) AS median_value,
                 regr_slope(value, year) AS slope, corr(value, year) AS r
          FROM per GROUP BY station_code HAVING count(*) >= ${Math.max(3, Number(input.min_years) || 4)}
        )`;
      return [
        `WITH ${fit}
         SELECT station_code, described_as, years, first_year, last_year, round(median_value, 2) AS median_value, round(slope, 3) AS change_per_year,
                round(100 * slope / nullif(median_value, 0), 1) AS pct_per_year, round(r, 2) AS r
         FROM fit ORDER BY (slope > 0 AND r >= 0.5) DESC, pct_per_year DESC NULLS LAST`,
        `WITH ${fit}
         SELECT count(*) AS stations, count(*) FILTER (WHERE slope > 0 AND r >= 0.5) AS clearly_rising, count(*) FILTER (WHERE slope < 0 AND r <= -0.5) AS clearly_falling,
                count(*) FILTER (WHERE abs(r) < 0.5 OR r IS NULL) AS no_clear_trend, round(median(100 * slope / nullif(median_value, 0)), 1) AS median_pct_per_year
         FROM fit`,
      ];
    },
    map: "trend",
  },

  compare_trends: {
    description: "Change over time for 2 to 6 elements on one chart: per year, the share of results above each element's dataset P95, and the median. Prefer source monitoring.",
    input_schema: { type: "object", properties: { parameters, ...common }, required: ["parameters"] },
    sql: (input) => `
      WITH ${percentiles("p95", 0.95)}
      SELECT year(sampling_date) AS year, parameter_code AS element,
             round(100.0 * count(*) FILTER (WHERE numeric_value > p95.p95) / count(*), 1) AS above_p95_pct,
             median(numeric_value) AS median, count(*) AS results
      FROM observations JOIN p95 USING (parameter_code)
      WHERE ${filters(input)} AND parameter_code IN (${codes(input.parameters, 6)})
      GROUP BY ALL ORDER BY year, element`,
    chart: (rows) => ({ type: "line", rows, x: "year", y: "above_p95_pct", series: "element", title: "% of results above the dataset P95, per year" }),
  },

  compare_seasons: {
    description: "Wet season (December to March) against dry season (May to September), and the months between, for 1 to 8 elements: median against the dataset median and share above the dataset P95. By default only stations sampled in both seasons, so the same places are compared; all_stations uses every station. Estimated dates are left out. Drawn as a bar chart.",
    input_schema: {
      type: "object",
      properties: { parameters, all_stations: { type: "boolean" }, ...common },
      required: ["parameters"],
    },
    sql: (input) => `
      WITH ${MEDIANS},
      tagged AS (
        SELECT station_code, parameter_code, numeric_value, ref.med, ref.p95,
               CASE WHEN month(sampling_date) IN (12, 1, 2, 3) THEN 'wet (Dec-Mar)'
                    WHEN month(sampling_date) BETWEEN 5 AND 9 THEN 'dry (May-Sep)' ELSE 'between (Apr, Oct-Nov)' END AS season
        FROM observations JOIN ref USING (parameter_code)
        WHERE ${filters(input)} AND NOT coalesce(date_is_estimated, false) AND parameter_code IN (${codes(input.parameters)})
      ),
      both_seasons AS (
        SELECT station_code FROM tagged GROUP BY station_code
        HAVING count(DISTINCT season) FILTER (WHERE season <> 'between (Apr, Oct-Nov)') = 2
      )
      SELECT season, parameter_code AS element, count(*) AS results, count(DISTINCT station_code) AS stations,
             round(median(numeric_value) / nullif(any_value(med), 0), 2) AS times_dataset_median,
             round(100.0 * count(*) FILTER (WHERE numeric_value > p95) / count(*), 1) AS above_p95_pct
      FROM tagged
      WHERE ${input.all_stations ? "true" : "station_code IN (SELECT station_code FROM both_seasons)"}
      GROUP BY ALL ORDER BY element, season`,
    chart: (rows) => ({ type: "bar", rows, x: "element", y: "times_dataset_median", series: "season", title: "Median against the dataset median, by season" }),
  },

  compare_periods: {
    description: "Before a year against that year and after, for 1 to 8 elements: results, median and share above the dataset P95 in each period. Prefer source monitoring. Drawn as a bar chart.",
    input_schema: {
      type: "object",
      properties: { parameters, split_year: { type: "integer" }, source, within_area: common.within_area },
      required: ["parameters", "split_year"],
    },
    sql: (input) => `
      WITH ${percentiles("p95", 0.95)},
      tagged AS (
        SELECT parameter_code, parameter_name, numeric_value, p95.p95, year(sampling_date) >= ${Number(input.split_year)} AS after
        FROM observations JOIN p95 USING (parameter_code)
        WHERE ${filters(input)} AND parameter_code IN (${codes(input.parameters)})
      )
      SELECT parameter_code, any_value(parameter_name) AS element,
             count(*) FILTER (WHERE NOT after) AS results_before, count(*) FILTER (WHERE after) AS results_after,
             median(numeric_value) FILTER (WHERE NOT after) AS median_before, median(numeric_value) FILTER (WHERE after) AS median_after,
             round(100.0 * count(*) FILTER (WHERE NOT after AND numeric_value > p95) / nullif(count(*) FILTER (WHERE NOT after), 0), 1) AS above_p95_before_pct,
             round(100.0 * count(*) FILTER (WHERE after AND numeric_value > p95) / nullif(count(*) FILTER (WHERE after), 0), 1) AS above_p95_after_pct
      FROM tagged GROUP BY parameter_code ORDER BY parameter_code`,
    chart: (rows, input) => ({
      type: "bar",
      rows,
      x: "element",
      groups: [{ column: "above_p95_before_pct", label: `Before ${input.split_year}` }, { column: "above_p95_after_pct", label: `${input.split_year} onwards` }],
      title: "% of results above the dataset P95",
    }),
  },

  compare_campaigns: {
    description: "One value per campaign in date order, drawn as a bar chart.",
    input_schema: { type: "object", properties: { parameter, statistic, ...common }, required: ["parameter"] },
    sql: (input) => `
      SELECT campaign_name, min(sampling_date) AS start_date, ${measure(input.statistic)} AS value, count(*) AS measured
      FROM observations WHERE ${filters(input)}
      GROUP BY campaign_name ORDER BY start_date`,
    chart: (rows, input, _, label) => ({ type: "bar", rows, x: "campaign_name", y: "value", title: `${input.statistic || "median"} ${label(input.parameter)} per campaign` }),
  },

  element_families: {
    description: "How contaminants relate: which elements rise and fall together across samples (Spearman correlation), grouped into families, with each element's closest partners. Uses monitoring samples and the elements with at least 200 measured values; for elements mostly below the detection limit it reflects the higher values only.",
    input_schema: { type: "object", properties: { within_area: common.within_area, from_year: common.from_year, to_year: common.to_year } },
    sql: (input, context) => `
      WITH eligible AS (
        SELECT parameter_code FROM observations
        WHERE data_role = 'STANDARDIZED' AND quality_status = 'VALID' AND parameter_code NOT IN (${quoteList(context.fieldChemistry)})
        GROUP BY parameter_code HAVING count(*) FILTER (WHERE qualifier = 'EQUAL' AND numeric_value > 0) >= 200
      ),
      wide AS (
        SELECT sample_id, parameter_code, avg(numeric_value) AS v FROM observations
        WHERE ${filters({ ...input, source: "monitoring" })} AND numeric_value > 0 AND parameter_code IN (SELECT parameter_code FROM eligible)
        GROUP BY ALL
      ),
      pairs AS (
        SELECT a.parameter_code AS element_a, b.parameter_code AS element_b, a.v AS x, b.v AS y
        FROM wide a JOIN wide b ON a.sample_id = b.sample_id AND a.parameter_code < b.parameter_code
      ),
      ranked AS (
        SELECT element_a, element_b,
               rank() OVER (PARTITION BY element_a, element_b ORDER BY x) AS rx,
               rank() OVER (PARTITION BY element_a, element_b ORDER BY y) AS ry
        FROM pairs
      )
      SELECT element_a, element_b, count(*) AS samples, corr(rx, ry) AS rho FROM ranked GROUP BY ALL HAVING count(*) >= 30`,
    reshape: families,
  },

  distance_profile: {
    description: "How values change with distance from a station, the area on the map or, by default, the main hotspot: median against the dataset median and share above the dataset P95, in bands of 0-2, 2-5, 5-10, 10-20 and over 20 km, for 1 to 8 elements. A steep fall with distance points to a local source; flat means no local source. Drawn as a line chart.",
    input_schema: {
      type: "object",
      properties: { parameters, from_station: { ...stationCode, description: "Measure from this station instead of the area on the map" }, source, from_year: common.from_year, to_year: common.to_year },
      required: ["parameters"],
    },
    sql: (input) => {
      const center = input.from_station
        ? `SELECT any_value(easting_m) AS x, any_value(northing_m) AS y FROM observations WHERE station_code = ${quote(input.from_station)} AND ${LOCATED}`
        : input.centre_codes
          ? `SELECT avg(easting_m) AS x, avg(northing_m) AS y FROM observations WHERE station_code IN (${quoteList(input.centre_codes)}) AND ${LOCATED}`
          : `SELECT avg(easting_m) AS x, avg(northing_m) AS y FROM observations WHERE CAST(station_id AS VARCHAR) IN (SELECT station_id FROM spatial_selection) AND ${LOCATED}`;
      return `
        WITH center AS (${center}), ${MEDIANS},
        d AS (
          SELECT o.parameter_code, o.numeric_value, o.station_code, ref.med, ref.p95,
                 sqrt(power(o.easting_m - center.x, 2) + power(o.northing_m - center.y, 2)) / 1000 AS km
          FROM observations o JOIN ref USING (parameter_code), center
          WHERE ${filters(input)} AND ${LOCATED} AND o.parameter_code IN (${codes(input.parameters)})
        )
        SELECT CASE WHEN km < 2 THEN '0-2 km' WHEN km < 5 THEN '2-5 km' WHEN km < 10 THEN '5-10 km' WHEN km < 20 THEN '10-20 km' ELSE 'over 20 km' END AS distance,
               parameter_code AS element, count(*) AS results, count(DISTINCT station_code) AS stations,
               round(median(numeric_value) / nullif(any_value(med), 0), 2) AS times_dataset_median,
               round(100.0 * count(*) FILTER (WHERE numeric_value > p95) / count(*), 1) AS above_p95_pct
        FROM d GROUP BY ALL ORDER BY min(km), element`;
    },
    chart: (rows) => ({
      type: "line",
      rows,
      x: "distance",
      y: "times_dataset_median",
      series: "element",
      log: true,
      lines: [{ value: 1, label: "Dataset median" }],
      title: "Median against the dataset median, by distance",
    }),
  },

  compare_site_types: {
    description: "By kind of site from the field sheets (tailings, mine works such as adits, waste dumps and pits, creeks, rivers; known for about 13% of the samples), for 1 to 8 elements: median against the dataset median. Drawn as a bar chart.",
    input_schema: { type: "object", properties: { parameters, source, from_year: common.from_year, to_year: common.to_year }, required: ["parameters"] },
    sql: (input) => `
      WITH ${MEDIANS}
      SELECT CASE WHEN zone LIKE '%relave%' THEN 'tailings'
                  WHEN zone LIKE 'bocamina%' OR zone LIKE '%botadero%' OR zone LIKE '%tajo%' OR zone LIKE '%antigua mina%' THEN 'mine works'
                  WHEN zone LIKE 'quebrada%' THEN 'creek' WHEN zone LIKE 'rio%' THEN 'river' ELSE 'other' END AS site,
             parameter_code AS element, count(*) AS results, count(DISTINCT station_code) AS stations,
             round(median(numeric_value) / nullif(any_value(ref.med), 0), 2) AS times_dataset_median
      FROM observations JOIN ref USING (parameter_code)
      WHERE ${filters(input)} AND zone IS NOT NULL AND parameter_code IN (${codes(input.parameters)})
      GROUP BY ALL ORDER BY site, element`,
    chart: (rows) => ({
      type: "bar",
      rows,
      x: "site",
      y: "times_dataset_median",
      series: "element",
      log: true,
      title: "Median against the dataset median, by kind of site",
    }),
  },

  above_threshold: {
    description: "Share of results and stations above a value the user gives (a sediment guideline, a standard, a background level) for one parameter, with the stations that exceed it and by how much. The comparison only holds when the data and the value share a unit: only copper has one (mg/kg, inferred), so say so for any other parameter. Maps stations by their maximum divided by the value.",
    input_schema: {
      type: "object",
      properties: { parameter, threshold: { type: "number" }, label: { type: "string", description: "Name of the value, e.g. CCME PEL" }, ...common },
      required: ["parameter", "threshold"],
    },
    contentLimit: 20,
    sql: (input) => {
      const value = Number(input.threshold);
      return [
        `SELECT station_code, max(numeric_value) AS maximum, round(max(numeric_value) / ${value}, 2) AS times_threshold,
                count(*) FILTER (WHERE numeric_value > ${value}) AS results_above, count(*) AS results,
                max(year(sampling_date)) AS last_year, left(any_value(zone_description), 60) AS described_as
         FROM observations WHERE ${filters(input)}
         GROUP BY station_code HAVING max(numeric_value) > ${value} ORDER BY times_threshold DESC`,
        `SELECT count(*) AS measured, count(*) FILTER (WHERE numeric_value > ${value}) AS above,
                round(100.0 * count(*) FILTER (WHERE numeric_value > ${value}) / nullif(count(*), 0), 1) AS above_pct,
                count(DISTINCT station_code) AS stations, count(DISTINCT station_code) FILTER (WHERE numeric_value > ${value}) AS stations_above,
                any_value(reported_unit) AS unit_in_data, bool_or(unit_is_inferred) AS unit_inferred
         FROM observations WHERE ${filters(input)}`,
      ];
    },
    map: "threshold",
  },

  // The release carries a drainage network derived from MERIT Hydro (90 m): station_links
  // pairs every station with the stations downstream of it, and station_context describes
  // the land draining to each one. These two metrics answer river questions with it
  // instead of with the wording of the field sheets.
  sampling_effort: {
    description: "How often each station was sampled, by source: how many stations each source covers, how many of them have several dates, and the median gap between visits. Use it when the question is why some stations have a series and others a single value, or whether a trend can be measured at all.",
    input_schema: { type: "object", properties: { parameter, ...common } },
    sql: (input) => {
      const where = filters(input, { measured: Boolean(input.parameter) });
      return [`
        WITH per_station AS (
          SELECT station_id, any_value(source_name) AS source_name, any_value(data_role) AS data_role,
                 count(DISTINCT sampling_date) AS dates, min(sampling_date) AS first_date, max(sampling_date) AS last_date
          FROM observations WHERE ${where} GROUP BY station_id
        )
        SELECT source_name, CASE data_role WHEN 'HISTORICAL_GEOCHEMISTRY' THEN 'historical geochemistry' ELSE 'monitoring' END AS kind,
               count(*) AS stations, count(*) FILTER (WHERE dates > 1) AS stations_with_series,
               round(avg(dates), 2) AS avg_dates, max(dates) AS max_dates,
               min(year(first_date)) AS first_year, max(year(last_date)) AS last_year,
               round(median(date_diff('month', first_date, last_date) / nullif(dates - 1, 0)) FILTER (WHERE dates > 1), 1) AS median_months_between
        FROM per_station GROUP BY source_name, kind ORDER BY stations DESC`,
      `
        WITH per_station AS (
          SELECT station_id, count(DISTINCT sampling_date) AS dates FROM observations WHERE ${where} GROUP BY station_id
        )
        SELECT CASE WHEN dates = 1 THEN 'one date' WHEN dates <= 3 THEN '2 to 3 dates' WHEN dates <= 9 THEN '4 to 9 dates' ELSE '10 or more' END AS group_of_stations,
               count(*) AS stations FROM per_station GROUP BY 1 ORDER BY min(dates)`];
    },
    note: () => "\nStations sampled once come from geochemical prospecting; the repeated ones are the monitoring network, so a trend can only be measured on those.",
  },

  river_pairs: {
    description: "Upstream against downstream along the real river network (MERIT Hydro 90 m, in station_links): every pair where the water of one station reaches the other, with the distance along the river, the value on each side and how many times higher it is downstream. Use it for questions about what the river carries, what changes downstream of a place, or whether the mine affects the water; flow_pairs only covers the places the field sheets name. Draws an arrow from each upstream station to its downstream one.",
    input_schema: {
      type: "object",
      properties: {
        parameter,
        max_km: { type: "number", description: "Longest distance along the river between the two stations, default 15" },
        min_times: { type: "number", description: "Only pairs at least this many times higher downstream" },
        min_results: { type: "integer", description: "Results needed at each station, default 2, so a single measurement does not set the ratio" },
        station_code: { type: "string", description: "Only pairs that involve this station" },
        limit,
        ...common,
      },
      required: ["parameter"],
    },
    sql: (input) => {
      const one = input.station_code ? `AND ${quote(input.station_code)} IN (u.station_code, d.station_code)` : "";
      const times = Number.isFinite(input.min_times) ? `AND d.value / nullif(u.value, 0) >= ${Number(input.min_times)}` : "";
      // A station measured once can set a ratio of thousands, which says nothing.
      const enough = Math.max(1, Number(input.min_results) || 2);
      return `
        WITH measured AS (
          SELECT station_id, any_value(station_code) AS station_code, median(numeric_value) AS value,
                 count(*) AS results, max(year(sampling_date)) AS last_year
          FROM observations WHERE ${filters(input)} GROUP BY station_id
        )
        SELECT u.station_code AS upstream_station, d.station_code AS downstream_station,
               round(l.river_km, 2) AS river_km, round(l.elevation_drop_m) AS drop_m,
               round(u.value, 2) AS upstream_value, round(d.value, 2) AS downstream_value,
               round(d.value / nullif(u.value, 0), 2) AS times_higher_downstream,
               u.results AS upstream_results, d.results AS downstream_results, greatest(u.last_year, d.last_year) AS last_year
        FROM read_parquet('station_links.parquet') l
        JOIN measured u ON u.station_id = l.upstream_station_id
        JOIN measured d ON d.station_id = l.downstream_station_id
        WHERE l.river_km > 0 AND l.river_km <= ${Number(input.max_km) || 15}
          AND u.results >= ${enough} AND d.results >= ${enough} ${one} ${times}
        ORDER BY times_higher_downstream DESC NULLS LAST
        LIMIT ${Math.min(Number(input.limit) || 20, 50)}`;
    },
    map: "flow",
    note: (rows, input) => rows.length
      ? `\nEach station needs at least ${Math.max(1, Number(input.min_results) || 2)} results; distances follow the modelled drainage network at 90 m, so stations on nearby creeks can be linked or missed.`
      : "\nNo pair of stations with enough results is connected along the river within this distance; try a longer max_km or min_results 1.",
  },

  catchment_profile: {
    description: "What drains to each station, from station_context (MERIT Hydro, WorldPop, ESA WorldCover): catchment area, how many stations lie upstream, population, land cover, stream order and height above the stream, next to the station's own value for one element. Use it to see whether high values go with a large catchment, more people upstream or a particular land cover, or to describe one station's catchment.",
    input_schema: {
      type: "object",
      properties: {
        parameter,
        station_code: { type: "string", description: "Only this station" },
        statistic,
        limit,
        ...common,
      },
    },
    sql: (input) => {
      const value = input.parameter ? `${measure(input.statistic)}` : "NULL";
      return `
        WITH measured AS (
          SELECT station_id, any_value(station_code) AS station_code, ${value} AS value, count(*) AS results
          FROM observations WHERE ${filters(input, { measured: Boolean(input.parameter) })} GROUP BY station_id
        )
        SELECT m.station_code, round(m.value, 2) AS value, m.results,
               round(c.upstream_area_km2, 2) AS catchment_km2, c.stations_upstream,
               round(c.catchment_population) AS people_upstream, round(c.catchment_population_per_km2, 1) AS people_per_km2,
               round(c.catchment_grass_pct, 1) AS grass_pct, round(c.catchment_bare_pct, 1) AS bare_pct,
               round(c.catchment_built_pct, 1) AS built_pct, round(c.catchment_cropland_pct, 1) AS cropland_pct,
               c.h90_strahler AS stream_order, round(c.hand_m) AS m_above_stream, round(c.dem_elevation_m) AS elevation_m,
               c.next_downstream_station_id IS NOT NULL AS has_station_downstream
        FROM measured m
        JOIN read_parquet('station_context.parquet') c USING (station_id)
        ${input.station_code ? `WHERE m.station_code = ${quote(input.station_code)}` : ""}
        ORDER BY ${input.parameter ? "m.value DESC NULLS LAST" : "c.upstream_area_km2 DESC"}
        LIMIT ${Math.min(Number(input.limit) || 15, 50)}`;
    },
    map: "stations",
    note: () => "\nCatchment figures are modelled at 90 m and 1,819 of 1,832 stations have them; stations without usable coordinates do not.",
  },

  flow_pairs: {
    description: "Upstream against downstream for one element: stations the field sheets describe as aguas arriba and aguas abajo of the same place on the same watercourse, with the value on each side and how many times higher it is downstream, plus the described stations without a pair (such as downstream of a tailings deposit). Draws an arrow from each upstream station to its downstream one. Only the places the field sheets name are covered; river_pairs uses the modelled drainage network instead.",
    input_schema: { type: "object", properties: { parameter, source }, required: ["parameter"] },
    sql: (input) => {
      const sides = `
        described AS (
          SELECT station_code, zone, parameter_code, qualifier, numeric_value, sampling_date,
                 regexp_extract(lower(strip_accents(zone_description)), 'aguas (arriba|abajo)', 1) AS side,
                 trim(regexp_extract(lower(strip_accents(zone_description)), 'aguas (arriba|abajo) (del |de la |de los |de )?([^;]*)', 3), ' .') AS reference
          FROM observations WHERE quality_status = 'VALID' AND zone_description IS NOT NULL
            ${SOURCES[input.source] ? `AND data_role = ${quote(SOURCES[input.source])}` : ""}
        ),
        -- The same place is often written two ways ("union con el rio paccpaco", "union del rio
        -- paccpaco y rio ccamacmayo"), so sides pair on the first river or creek named.
        sides AS (
          SELECT zone, coalesce(nullif(regexp_extract(reference, '(?:rios?|quebradas?) ([a-z]+)', 1), ''), reference) AS place,
                 any_value(reference) AS reference, side, station_code, min(year(sampling_date)) AS year,
                 median(numeric_value) FILTER (WHERE parameter_code = ${quote(input.parameter)} AND qualifier = 'EQUAL' AND numeric_value > 0) AS value
          FROM described WHERE side <> '' GROUP BY zone, place, side, station_code
        )`;
      return [
        `WITH ${sides}
         SELECT up.zone AS watercourse, up.reference, up.station_code AS upstream_station, round(up.value, 2) AS upstream_value,
                down.station_code AS downstream_station, round(down.value, 2) AS downstream_value,
                round(down.value / nullif(up.value, 0), 2) AS times_higher_downstream, up.year AS upstream_year, down.year AS downstream_year
         FROM sides up JOIN sides down ON up.zone = down.zone AND up.place = down.place AND up.side = 'arriba' AND down.side = 'abajo'
         ORDER BY times_higher_downstream DESC NULLS LAST`,
        `WITH ${sides}
         SELECT s.station_code, CASE s.side WHEN 'arriba' THEN 'upstream' ELSE 'downstream' END AS position, s.zone AS watercourse, s.reference, round(s.value, 2) AS value, s.year
         FROM sides s
         WHERE NOT EXISTS (SELECT 1 FROM sides o WHERE o.zone = s.zone AND o.place = s.place AND o.side <> s.side)
         ORDER BY s.value DESC NULLS LAST LIMIT 25`,
      ];
    },
    map: "flow",
  },

  compare_sources: {
    description: "By source study or report (company monitoring, impact studies, OEFA or other agency reports, historical geochemistry), for one parameter: years, stations, results, median against the dataset median and share above the dataset P95. To compare two sources at the same places, give group_a and group_b as patterns of source names (e.g. OEFA and CMA|EIA): each station of group_a is paired with the nearest station of group_b within max_distance_m (default 250 m, since sources often code the same place differently), side by side with a summary. Drawn as a bar chart.",
    input_schema: {
      type: "object",
      properties: {
        parameter,
        group_a: { type: "string", description: "Pattern of source names, e.g. OEFA" },
        group_b: { type: "string", description: "Pattern of source names, e.g. CMA|EIA" },
        max_distance_m: { type: "integer", description: "Default 250" },
        from_year: common.from_year,
        to_year: common.to_year,
        within_area: common.within_area,
      },
      required: ["parameter"],
    },
    sql: (input) => {
      if (!(input.group_a && input.group_b)) {
        return `
          WITH ${MEDIANS}
          SELECT source_name AS source, data_role, min(year(sampling_date)) AS first_year, max(year(sampling_date)) AS last_year,
                 count(DISTINCT station_code) AS stations, count(*) AS results,
                 round(median(numeric_value) / nullif(any_value(ref.med), 0), 2) AS times_dataset_median,
                 round(100.0 * count(*) FILTER (WHERE numeric_value > ref.p95) / count(*), 1) AS above_p95_pct
          FROM observations JOIN ref USING (parameter_code)
          WHERE ${filters(input)}
          GROUP BY source_name, data_role ORDER BY first_year, source_name`;
      }
      const reach = Math.min(2000, Math.max(0, Number(input.max_distance_m) || 250));
      const paired = `
        tagged AS (
          SELECT station_code, easting_m AS x, northing_m AS y, numeric_value, year(sampling_date) AS year,
                 CASE WHEN regexp_matches(source_name, ${quote(input.group_a)}, 'i') THEN 'a'
                      WHEN regexp_matches(source_name, ${quote(input.group_b)}, 'i') THEN 'b' END AS side
          FROM observations WHERE ${filters(input)} AND ${LOCATED}
        ),
        per AS (
          SELECT station_code, side, any_value(x) AS x, any_value(y) AS y, median(numeric_value) AS value, min(year) AS first_year, max(year) AS last_year
          FROM tagged WHERE side IS NOT NULL GROUP BY station_code, side
        ),
        candidates AS (
          SELECT a.station_code, b.station_code AS paired_with, sqrt(power(a.x - b.x, 2) + power(a.y - b.y, 2)) AS metres,
                 a.value AS value_a, a.first_year AS first_year_a, a.last_year AS last_year_a,
                 b.value AS value_b, b.first_year AS first_year_b, b.last_year AS last_year_b,
                 row_number() OVER (PARTITION BY a.station_code ORDER BY sqrt(power(a.x - b.x, 2) + power(a.y - b.y, 2))) AS nearest
          FROM per a JOIN per b ON a.side = 'a' AND b.side = 'b'
          WHERE sqrt(power(a.x - b.x, 2) + power(a.y - b.y, 2)) <= ${reach}
        ),
        pairs AS (SELECT *, value_a / nullif(value_b, 0) AS ratio FROM candidates WHERE nearest = 1)`;
      return [
        `WITH ${paired}
         SELECT station_code, paired_with, round(metres) AS metres, round(value_a, 2) AS value_a, first_year_a || '-' || last_year_a AS years_a,
                round(value_b, 2) AS value_b, first_year_b || '-' || last_year_b AS years_b, round(ratio, 2) AS a_over_b
         FROM pairs ORDER BY ratio DESC NULLS LAST LIMIT 40`,
        `WITH ${paired}
         SELECT count(*) AS pairs, round(median(metres)) AS median_metres, count(*) FILTER (WHERE ratio > 1) AS a_higher, count(*) FILTER (WHERE ratio < 1) AS b_higher,
                round(median(ratio), 2) AS median_a_over_b
         FROM pairs`,
      ];
    },
    chart: (rows, input, _, label) => (input.group_a && input.group_b
      ? { type: "bar", rows, x: "station_code", groups: [{ column: "value_a", label: input.group_a }, { column: "value_b", label: input.group_b }], log: true, title: `${label(input.parameter)} at the stations both sampled` }
      : { type: "bar", horizontal: true, rows, x: "source", y: "times_dataset_median", title: `${label(input.parameter)}: median against the dataset median, by source` }),
    map: "paired",
  },

  compare_elements: {
    description: "Compare 2 to 8 elements side by side: results, % below the limit, median, max, and the share of results and stations above each element's own dataset P95 and P99. Concentrations of different elements are not on one scale, so compare them this way.",
    input_schema: { type: "object", properties: { parameters, ...common }, required: ["parameters"] },
    sql: (input) => `
      WITH ${percentiles("p95", 0.95)},
      ${percentiles("p99", 0.99)}
      SELECT parameter_code, any_value(parameter_name) AS element, count(*) AS results,
             round(100.0 * count(*) FILTER (WHERE qualifier = 'LESS_THAN') / count(*), 1) AS below_limit_pct,
             median(numeric_value) FILTER (WHERE qualifier = 'EQUAL' AND numeric_value > 0) AS median,
             max(numeric_value) FILTER (WHERE qualifier = 'EQUAL' AND numeric_value > 0) AS maximum,
             round(100.0 * count(*) FILTER (WHERE qualifier = 'EQUAL' AND numeric_value > p95.p95) / count(*), 1) AS above_p95_pct,
             count(*) FILTER (WHERE qualifier = 'EQUAL' AND numeric_value > p99.p99) AS above_p99,
             count(DISTINCT station_code) FILTER (WHERE qualifier = 'EQUAL' AND numeric_value > p95.p95) AS stations_above_p95
      FROM observations LEFT JOIN p95 USING (parameter_code) LEFT JOIN p99 USING (parameter_code)
      WHERE ${filters(input, { measured: false })} AND parameter_code IN (${codes(input.parameters)})
      GROUP BY parameter_code ORDER BY above_p95_pct DESC`,
  },

  correlate_elements: {
    description: "Whether 2 to 8 elements rise and fall together across samples: Spearman rank correlation for every pair. Metals that travel together suggest a common source. With two elements, draws a log-log scatter.",
    input_schema: { type: "object", properties: { parameters, ...common }, required: ["parameters"] },
    sql: (input) => `
      WITH wide AS (
        SELECT sample_id, parameter_code, avg(numeric_value) AS v FROM observations
        WHERE ${filters(input)} AND parameter_code IN (${codes(input.parameters)}) GROUP BY ALL
      ),
      pairs AS (
        SELECT a.parameter_code AS element_a, b.parameter_code AS element_b, a.v AS x, b.v AS y
        FROM wide a JOIN wide b ON a.sample_id = b.sample_id AND a.parameter_code < b.parameter_code
      ),
      ranked AS (
        SELECT element_a, element_b,
               rank() OVER (PARTITION BY element_a, element_b ORDER BY x) AS rx,
               rank() OVER (PARTITION BY element_a, element_b ORDER BY y) AS ry
        FROM pairs
      )
      SELECT element_a, element_b, count(*) AS samples, round(corr(rx, ry), 2) AS spearman
      FROM ranked GROUP BY ALL ORDER BY spearman DESC`,
    chartSql: (input) => input.parameters.length !== 2 ? null : `
      WITH wide AS (
        SELECT sample_id, parameter_code, avg(numeric_value) AS v FROM observations
        WHERE ${filters(input)} AND parameter_code IN (${codes(input.parameters)}) GROUP BY ALL
      )
      SELECT a.v AS x, b.v AS y FROM wide a JOIN wide b ON a.sample_id = b.sample_id
      WHERE a.parameter_code = ${quote(input.parameters[0])} AND b.parameter_code = ${quote(input.parameters[1])} AND a.v > 0 AND b.v > 0
      LIMIT 4000`,
    chart: (rows, input, _, label) => input.parameters.length !== 2 ? null : ({
      type: "scatter",
      rows,
      x: "x",
      y: "y",
      log: true,
      xLabel: label(input.parameters[0]),
      yLabel: label(input.parameters[1]),
      title: `${label(input.parameters[0])} against ${label(input.parameters[1])}, one point per sample`,
    }),
  },

  describe_station: {
    description: "One station: its latest sample with every parameter, flagged when above the dataset P95 or P99. Shown on the map.",
    input_schema: { type: "object", properties: { station_code: stationCode }, required: ["station_code"] },
    sql: (input) => `
      WITH latest AS (
        SELECT sample_id FROM observations WHERE station_code = ${quote(input.station_code)}
        ORDER BY sampling_date DESC NULLS LAST LIMIT 1
      ),
      ${percentiles("p95", 0.95)},
      ${percentiles("p99", 0.99)}
      SELECT station_code, sampling_date, zone_description, parameter_name, reported_value, quality_status,
             CASE WHEN qualifier = 'EQUAL' AND numeric_value >= p99.p99 THEN 'above P99'
                  WHEN qualifier = 'EQUAL' AND numeric_value >= p95.p95 THEN 'above P95'
                  ELSE '' END AS level
      FROM observations
      LEFT JOIN p95 USING (parameter_code)
      LEFT JOIN p99 USING (parameter_code)
      WHERE sample_id IN (SELECT sample_id FROM latest)
      ORDER BY parameter_name`,
    map: "station",
  },

  station_history: {
    description: "One station over time for 1 to 4 elements: every valid value with its date, and the dataset P95 and P99 of each element. Drawn as a line chart and shown on the map.",
    input_schema: { type: "object", properties: { station_code: stationCode, parameters }, required: ["station_code", "parameters"] },
    sql: (input) => [
      `SELECT sampling_date, parameter_code AS element, reported_value, numeric_value
       FROM observations
       WHERE station_code = ${quote(input.station_code)} AND quality_status = 'VALID' AND parameter_code IN (${codes(input.parameters, 4)})
       ORDER BY sampling_date, element`,
      `WITH ${percentiles("p95", 0.95)}, ${percentiles("p99", 0.99)}
       SELECT parameter_code AS element, round(p95, 2) AS dataset_p95, round(p99, 2) AS dataset_p99
       FROM p95 JOIN p99 USING (parameter_code) WHERE parameter_code IN (${codes(input.parameters, 4)})`,
    ],
    map: "station",
    chart: (rows, input, tables) => {
      const single = input.parameters.length === 1 ? tables[1][0] : null;
      return {
        type: "line",
        rows: rows.filter((row) => row.numeric_value != null),
        x: "sampling_date",
        y: "numeric_value",
        series: "element",
        log: !single,
        lines: single ? [{ value: single.dataset_p95, label: "P95" }, { value: single.dataset_p99, label: "P99" }] : [],
        title: `${input.station_code} over time`,
      };
    },
  },
};
