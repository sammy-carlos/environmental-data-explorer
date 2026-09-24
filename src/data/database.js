import * as duckdb from "@duckdb/duckdb-wasm";
import { state } from "../state.js";
import { rowsOf } from "../lib/sql.js";
import { datasetFile, localUrl, usesLocalData } from "./source.js";

// One row per analytical result, joined with its sample, event, station, campaign,
// source row and quality issues. The assistant guide documents these columns. zone is
// the watercourse or site written on the field sheet, without accents or the detail
// after a comma, dash or "aguas arriba/abajo", so "Río Salado – Afluentes" and
// "Rio Salado" group together.
const OBSERVATIONS = `
  CREATE OR REPLACE TEMP TABLE observations AS
  SELECT r.result_id, r.analysis_id, s.sample_id, sr.source_record_id,
         coalesce(st.canonical_code, s.reported_code, st.station_id) AS station_code,
         st.station_id, st.easting_m, st.northing_m, st.epsg, st.coordinate_status,
         e.sampling_date, e.campaign_id, cp.campaign_name,
         r.parameter_code, p.parameter_name, r.reported_value, r.numeric_value,
         r.qualifier, r.reported_limit, coalesce(r.reported_unit, r.canonical_unit) AS reported_unit,
         r.quality_status, sf.source_name, sf.relative_path, sf.sheet_name, sr.source_row_number,
         r.canonical_unit, r.reported_unit IS NULL AND r.canonical_unit IS NOT NULL AS unit_is_inferred,
         s.data_role, s.sample_type, a.analysis_type, e.date_precision, e.date_is_estimated,
         e.zone_description,
         nullif(trim(regexp_replace(regexp_replace(strip_accents(lower(e.zone_description)), '\\s*[,;(\\x{2013}-].*$', ''),
           '\\s+(en el|en la|aguas arriba|aguas abajo|a la altura|junto a|cerca de)\\s.*$', '')), '') AS zone,
         nullif(concat_ws(',', qr.rules, qs.rules), '') AS quality_rules
  FROM read_parquet('results.parquet') r
  JOIN read_parquet('parameters.parquet') p USING (parameter_code)
  JOIN read_parquet('analyses.parquet') a USING (analysis_id)
  JOIN read_parquet('samples.parquet') s USING (sample_id)
  JOIN read_parquet('sampling_events.parquet') e USING (sampling_event_id)
  JOIN read_parquet('campaigns.parquet') cp USING (campaign_id)
  LEFT JOIN read_parquet('stations.parquet') st USING (station_id)
  JOIN read_parquet('source_records.parquet') sr ON r.source_record_id = sr.source_record_id
  JOIN read_parquet('source_files.parquet') sf ON sr.source_file_id = sf.source_file_id
  LEFT JOIN (
    SELECT entity_id, string_agg(DISTINCT rule_code, ',') AS rules
    FROM read_parquet('quality_issues.parquet') WHERE entity_type = 'source_record' GROUP BY entity_id
  ) qr ON qr.entity_id = sr.source_record_id
  LEFT JOIN (
    SELECT entity_id, string_agg(DISTINCT rule_code, ',') AS rules
    FROM read_parquet('quality_issues.parquet') WHERE entity_type = 'station' GROUP BY entity_id
  ) qs ON qs.entity_id = st.station_id
`;

export async function openDatabase(onStep) {
  const bundle = await duckdb.selectBundle(duckdb.getJsDelivrBundles());
  const workerUrl = URL.createObjectURL(new Blob([`importScripts("${bundle.mainWorker}");`], { type: "text/javascript" }));
  const db = new duckdb.AsyncDuckDB(new duckdb.VoidLogger(), new Worker(workerUrl));
  await db.instantiate(bundle.mainModule, bundle.pthreadWorker);
  URL.revokeObjectURL(workerUrl);

  onStep("Loading data");
  const local = await usesLocalData();
  await Promise.all(state.dataset.tables.map(async (name) => {
    const path = `data/${name}.parquet`;
    if (local) await db.registerFileURL(`${name}.parquet`, localUrl(path), duckdb.DuckDBDataProtocol.HTTP, false);
    else await db.registerFileBuffer(`${name}.parquet`, await datasetFile(path, "buffer"));
  }));

  onStep("Building tables");
  state.db = await db.connect();
  await state.db.query(OBSERVATIONS);
}

export async function query(sql, options) {
  return rowsOf(await state.db.query(sql), options);
}

export function queryTable(sql) {
  return state.db.query(sql);
}
