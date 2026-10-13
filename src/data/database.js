import * as duckdb from "@duckdb/duckdb-wasm";
import { state } from "../state.js";
import { rowsOf } from "../lib/sql.js";
import { datasetFile, localUrl, usesLocalData } from "./source.js";

// One row per analytical result, joined with its sample, event, station, campaign,
// source row and quality issues. zone is
// the watercourse or site written on the field sheet, without accents or the detail
// after a comma, dash or "aguas arriba/abajo", so "Río Salado – Afluentes" and
// "Rio Salado" group together.
const SEDIMENT_OBSERVATIONS = `
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

// Flora shares the audit trail and analytical-result tables with sediments, but its
// sample identity is biological. This view keeps the shared map/table contract while
// exposing the raw taxon and plant fields for the record panel. It does not infer an
// accepted taxon or a hydrological relationship.
const FLORA_OBSERVATIONS = `
  CREATE OR REPLACE TEMP TABLE observations AS
  SELECT r.result_id, r.analysis_id, s.sample_id, sr.source_record_id,
         coalesce(st.canonical_code, s.reported_code, st.station_id) AS station_code,
         st.station_id, st.easting_m, st.northing_m, st.epsg, st.coordinate_status,
         try_cast(e.sampling_date AS DATE) AS sampling_date, e.campaign_id, cp.campaign_name,
         r.parameter_code, p.parameter_name, r.reported_value, r.numeric_value,
         r.qualifier, r.reported_limit, coalesce(r.reported_unit, r.canonical_unit) AS reported_unit,
         r.quality_status, sf.source_name, sf.relative_path, NULL AS sheet_name, sr.source_row_number,
         r.canonical_unit, r.reported_unit IS NULL AND r.canonical_unit IS NOT NULL AS unit_is_inferred,
         s.data_role, s.matrix_code AS sample_type, a.analysis_group AS analysis_type,
         e.date_precision, e.date_is_estimated, e.zone_description,
         CAST(NULL AS VARCHAR) AS zone,
         s.reported_species, s.plant_part, s.matrix_code, s.treatment, s.reported_treatment,
         s.material_description, a.laboratory, a.analytical_method, a.result_basis, a.washing_status,
         nullif(concat_ws(',', qr.rules, qs.rules, qsample.rules, qa.rules, qresult.rules), '') AS quality_rules
  FROM read_parquet('results.parquet') r
  JOIN read_parquet('parameters.parquet') p USING (parameter_code)
  JOIN read_parquet('analyses.parquet') a USING (analysis_id)
  JOIN read_parquet('samples.parquet') s USING (sample_id)
  JOIN read_parquet('sampling_events.parquet') e USING (sampling_event_id)
  JOIN read_parquet('campaigns.parquet') cp USING (campaign_id)
  LEFT JOIN read_parquet('stations.parquet') st ON st.station_id = e.station_id
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
  LEFT JOIN (
    SELECT entity_id, string_agg(DISTINCT rule_code, ',') AS rules
    FROM read_parquet('quality_issues.parquet') WHERE entity_type = 'sample' GROUP BY entity_id
  ) qsample ON qsample.entity_id = s.sample_id
  LEFT JOIN (
    SELECT entity_id, string_agg(DISTINCT rule_code, ',') AS rules
    FROM read_parquet('quality_issues.parquet') WHERE entity_type = 'analysis' GROUP BY entity_id
  ) qa ON qa.entity_id = a.analysis_id
  LEFT JOIN (
    SELECT entity_id, string_agg(DISTINCT rule_code, ',') AS rules
    FROM read_parquet('quality_issues.parquet') WHERE entity_type = 'result' GROUP BY entity_id
  ) qresult ON qresult.entity_id = r.result_id
`;

// Soils share the audit trail with the other datasets, but a station can hold a pit
// with several horizons and a sample can carry several analyses (metals, mercury,
// characterization). The view exposes depth, horizon, sampling design and the limit
// evidence of each result. It does not infer background, units or a limit type.
const SOIL_OBSERVATIONS = `
  CREATE OR REPLACE TEMP TABLE observations AS
  SELECT r.result_id, r.analysis_id, s.sample_id, sr.source_record_id,
         coalesce(s.reported_code, st.canonical_code, st.station_id) AS station_code,
         st.station_id, st.easting_m, st.northing_m, st.epsg, st.coordinate_status,
         e.sampling_date, e.campaign_id, cp.campaign_name,
         r.parameter_code, p.parameter_name, r.reported_value, r.numeric_value,
         r.qualifier, r.reported_limit, coalesce(r.reported_unit, r.canonical_unit) AS reported_unit,
         r.quality_status, sf.source_name, sf.relative_path, sf.source_locator AS sheet_name, sr.source_row_number,
         r.canonical_unit, r.reported_unit IS NULL AND r.canonical_unit IS NOT NULL AS unit_is_inferred,
         s.data_role, s.matrix_code AS sample_type, a.analysis_group AS analysis_type,
         e.date_precision, e.date_is_estimated, e.zone_description,
         CAST(NULL AS VARCHAR) AS zone,
         s.matrix_code, s.sampling_method, s.sample_role, s.horizon, s.depth_from_m, s.depth_to_m,
         s.reported_depth, s.sample_category, s.material_description,
         cp.entity_label, cp.study_design,
         a.laboratory, a.analytical_method, a.digestion_type, a.result_basis,
         r.text_value, r.limit_type, r.detection_limit, r.quantification_limit, r.uncertainty,
         nullif(concat_ws(',', qs.rules, qsample.rules, qresult.rules), '') AS quality_rules
  FROM read_parquet('results.parquet') r
  JOIN read_parquet('parameters.parquet') p USING (parameter_code)
  JOIN read_parquet('analyses.parquet') a USING (analysis_id)
  JOIN read_parquet('samples.parquet') s USING (sample_id)
  JOIN read_parquet('sampling_events.parquet') e USING (sampling_event_id)
  JOIN read_parquet('campaigns.parquet') cp USING (campaign_id)
  LEFT JOIN read_parquet('stations.parquet') st ON st.station_id = e.station_id
  JOIN read_parquet('source_records.parquet') sr ON r.source_record_id = sr.source_record_id
  JOIN read_parquet('source_files.parquet') sf ON sr.source_file_id = sf.source_file_id
  LEFT JOIN (
    SELECT entity_id, string_agg(DISTINCT rule_code, ',') AS rules
    FROM read_parquet('quality_issues.parquet') WHERE entity_type = 'station' AND review_status = 'OPEN' GROUP BY entity_id
  ) qs ON qs.entity_id = st.station_id
  LEFT JOIN (
    SELECT entity_id, string_agg(DISTINCT rule_code, ',') AS rules
    FROM read_parquet('quality_issues.parquet') WHERE entity_type = 'sample' AND review_status = 'OPEN' GROUP BY entity_id
  ) qsample ON qsample.entity_id = s.sample_id
  LEFT JOIN (
    SELECT entity_id, string_agg(DISTINCT rule_code, ',') AS rules
    FROM read_parquet('quality_issues.parquet') WHERE entity_type = 'result' AND review_status = 'OPEN' GROUP BY entity_id
  ) qresult ON qresult.entity_id = r.result_id
`;

const OBSERVATIONS = { flora: FLORA_OBSERVATIONS, soils: SOIL_OBSERVATIONS };

export async function openDatabase(onStep) {
  const bundle = await duckdb.selectBundle(duckdb.getJsDelivrBundles());
  const workerUrl = URL.createObjectURL(new Blob([`importScripts("${bundle.mainWorker}");`], { type: "text/javascript" }));
  const db = new duckdb.AsyncDuckDB(new duckdb.VoidLogger(), new Worker(workerUrl));
  await db.instantiate(bundle.mainModule, bundle.pthreadWorker);
  URL.revokeObjectURL(workerUrl);

  onStep("Loading data");
  const local = await usesLocalData();
  const register = async (name) => {
    const path = `data/${name}.parquet`;
    if (local) await db.registerFileURL(`${name}.parquet`, localUrl(path), duckdb.DuckDBDataProtocol.HTTP, false);
    else await db.registerFileBuffer(`${name}.parquet`, await datasetFile(path, "buffer"));
  };
  await Promise.all(state.dataset.tables.map(register));
  // Tables added by later releases are read when the pinned release has them, so the
  // explorer keeps working on an older one; state.dataset.available lists what was found.
  const optional = await Promise.all((state.dataset.optionalTables || []).map(async (name) => {
    if (local && !(await fetch(localUrl(`data/${name}.parquet`), { method: "HEAD", cache: "no-store" }).then((response) => response.ok, () => false))) return null;
    try {
      await register(name);
      return name;
    } catch {
      return null;
    }
  }));
  state.dataset.available = [...state.dataset.tables, ...optional.filter(Boolean)];

  onStep("Building tables");
  state.db = await db.connect();
  await state.db.query(OBSERVATIONS[state.dataset.profile] || SEDIMENT_OBSERVATIONS);
}

export async function query(sql, options) {
  return rowsOf(await state.db.query(sql), options);
}

export function queryTable(sql) {
  return state.db.query(sql);
}
