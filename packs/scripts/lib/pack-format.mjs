// Pack source file format (BUILD-PLAN E.8, MILESTONE-2 E.1): the dataset files of a pack
// source folder, their CSV headers, and the CSV and JSON encoding rules shared by
// extract-from-sample.mjs and validate-sources.mjs.
//
// Encoding: UTF-8 without a byte order mark, LF line endings, a final newline.
// CSV: a header row, then one row per record; fields are quoted per RFC 4180 when they hold
// a comma, a double quote or a line break (inner quotes doubled). Booleans are `true` or
// `false`; an empty field means null. JSON: pretty-printed with two spaces.

/** CSV datasets of a pack source folder and their header rows, in E.8 order. */
export const CSV_HEADERS = Object.freeze({
  'requirements.csv': [
    'requirement_code', 'parent_code', 'title_short', 'clause_group', 'is_hs_common',
    'documented_info_mandatory', 'applicability_assessable', 'default_frequency_code',
    'evidence_example', 'sort_order', 'retired',
  ],
  'catalogue.csv': [
    'item_code', 'theme_code', 'title_short', 'requirement_code', 'default_frequency_code',
    'evidence_example', 'sort_order', 'retired',
  ],
  'chain.csv': [
    'stage_key', 'position', 'label_en', 'label_id', 'question_en', 'question_id', 'source',
    'entity_type', 'risk_profile_code', 'is_mandatory', 'clause_at_risk', 'overview_clause',
    'gate_type_label_en', 'gate_type_label_id',
  ],
  'activities.csv': [
    'phase_no', 'phase_name_en', 'phase_name_id', 'is_gate_phase', 'activity_no', 'title',
    'clause_ref', 'output_document_code', 'expected_outcome',
  ],
  'frequencies.csv': ['code', 'label_en', 'label_id', 'period_days', 'sort_order'],
  'cycle_requirements.csv': ['code', 'requirement_code', 'title', 'derivation', 'sort_order'],
  'prep_tasks.csv': ['code', 'title', 'days_before_audit', 'skip_on_first_audit', 'sort_order'],
  'review_inputs.csv': ['code', 'title', 'mandatory', 'sort_order', 'review_kind'],
  'finding_conditions.csv': ['code', 'classification', 'requirement_code', 'text'],
  'document_templates.csv': ['code', 'title', 'doc_type', 'requirement_code'],
  'documented_info.csv': ['code', 'requirement_code', 'kind', 'title', 'template_code', 'sort_order'],
  'audit_activities.csv': [
    'code', 'event_type', 'clause_ref', 'title', 'auditee_role', 'key_questions',
    'evidence_to_request', 'sort_order',
  ],
  'lookups.csv': ['domain', 'code', 'label_en', 'label_id', 'sort_order'],
});

/** Header of every optional `mappings/<target>.csv` file. */
export const MAPPING_HEADER = Object.freeze([
  'source_code', 'target_pack_id', 'target_code', 'mapping_type', 'evidence_reusable', 'note',
]);

/** JSON files of a pack source folder. */
export const JSON_FILES = Object.freeze([
  'manifest.json', 'labels.en.json', 'labels.id.json', 'drift_rules.json', 'rules.json',
  'risk_profiles.json',
]);

/** Every file a pack source folder must hold (the optional `mappings/` folder aside). */
export const REQUIRED_FILES = Object.freeze([
  'manifest.json',
  'requirements.csv',
  'catalogue.csv',
  'chain.csv',
  'activities.csv',
  'frequencies.csv',
  'labels.en.json',
  'labels.id.json',
  'cycle_requirements.csv',
  'drift_rules.json',
  'prep_tasks.csv',
  'review_inputs.csv',
  'finding_conditions.csv',
  'document_templates.csv',
  'documented_info.csv',
  'audit_activities.csv',
  'lookups.csv',
  'rules.json',
  'risk_profiles.json',
]);

/** Label keys every pack carries in both languages (E.8); themes add `catalogue.theme.<n>`. */
export const REQUIRED_LABEL_KEYS = Object.freeze([
  'ms.name', 'ms.long_name', 'ms.manager_role', 'gate.name', 'applicability.artefact_name',
  'risk.object_name',
]);

/** Allowed values (C.5, C.9, C.10, E.8). */
export const ALLOWED = Object.freeze({
  packStatus: ['current', 'transition', 'withdrawn'],
  applicabilityTarget: ['catalogue_item', 'requirement'],
  chainSource: ['entity', 'applicability', 'justification', 'document', 'evidence'],
  // Tables that hold chain records (C.9 "Chain records", C.10).
  chainEntityType: [
    'context_issue', 'risk', 'risk_treatment', 'metric', 'quality_objective',
    'prioritized_activity', 'business_impact_analysis', 'exercise', 'business_associate',
    'chain_record',
  ],
  driftSeverity: ['crit', 'risk', 'warn'],
  driftSourceKind: ['manual', 'stale_risk', 'dd_expired', 'metric', 'exercise', 'unverif', 'nohash'],
  auditEventType: ['stage1', 'stage2', 'surveillance', 'recertification', 'transition', 'special', 'internal_audit'],
  documentedInfoKind: ['maintain', 'retain'],
  reviewKind: ['management', 'governing_body'],
  // Derivation kinds of cycle.derive (E.2 and MILESTONE-2 D.4).
  derivationKind: [
    'management_review_closed', 'risk_assessment_current', 'internal_audit_done', 'exercise_performed',
    'corrective_actions_closed', 'metrics_current', 'documents_reviewed_on_time', 'bia_approved',
    'due_diligence_current',
  ],
  findingClassification: ['major', 'minor', 'ofi', 'signal', 'not_a_finding'],
  mappingType: ['equivalent', 'partial', 'related', 'split', 'merged', 'changed', 'new', 'removed'],
  clauseGroup: ['4', '5', '6', '7', '8', '9', '10'],
  // Lookup domains every pack must carry (E.8).
  requiredLookupDomains: ['doc_type', 'treatment_option'],
});

/**
 * Engine version of this pack format (MILESTONE-2 E.1): every pack names it as
 * `engine_min_version`, so a server older than 1.1.0 refuses the new datasets and columns.
 */
export const ENGINE_MIN_VERSION = '1.1.0';

/**
 * The first version of each Milestone 1 pack that must resolve every content reference (cycle
 * requirement codes, chain clause_at_risk values, activity output documents, documented
 * information templates): the content step of MILESTONE-2 E.3 (M2-04). Before it, a pack that
 * lists no documented information reports them as warnings; every other pack must resolve them.
 * The same table as CONTENT_REFERENCES_STRICT_FROM of @mscd/pack-tools (a pack-tools test checks).
 */
export const CONTENT_REFERENCES_STRICT_FROM = Object.freeze({
  'ISO27001-2022': '1.3.0',
  'ISO9001-2015': '1.5.0',
  'ISO9001-2026': '0.10.0',
  'ISO22301-2019': '1.1.0',
  'ISO37001-2016': '1.1.0',
  'ISO37001-2025': '0.7.0',
});

/**
 * True when the content references of a pack must resolve (contentReferencesStrict of
 * @mscd/pack-tools): it lists documented information, it is no Milestone 1 pack, or its version
 * (without a pre-release suffix) has reached the cut-over. A version that is not a semantic
 * version counts as strict.
 */
export function contentReferencesStrict(packId, packVersion, documentedInfoRows) {
  if (documentedInfoRows > 0) return true;
  const from = CONTENT_REFERENCES_STRICT_FROM[packId];
  if (from === undefined || typeof packVersion !== 'string' || !SEMVER_RE.test(packVersion)) return true;
  const a = packVersion.split('-')[0].split('.').map(Number);
  const b = from.split('.').map(Number);
  for (let i = 0; i < 3; i += 1) if (a[i] !== b[i]) return a[i] > b[i];
  return true;
}

/**
 * Key of a row of each CSV dataset: how `packs/content` rows replace extracted rows and how
 * `removed.csv` names a row. Activities are keyed `<phase_no>.<activity_no>`, lookups
 * `<domain>/<code>`, mapping rows `<source_code> <target_code>`.
 */
export const ROW_KEYS = Object.freeze({
  'requirements.csv': (r) => r.requirement_code,
  'catalogue.csv': (r) => r.item_code,
  'chain.csv': (r) => r.stage_key,
  'activities.csv': (r) => `${r.phase_no}.${r.activity_no}`,
  'frequencies.csv': (r) => r.code,
  'cycle_requirements.csv': (r) => r.code,
  'prep_tasks.csv': (r) => r.code,
  'review_inputs.csv': (r) => r.code,
  'finding_conditions.csv': (r) => r.code,
  'document_templates.csv': (r) => r.code,
  'documented_info.csv': (r) => r.code,
  'audit_activities.csv': (r) => r.code,
  'lookups.csv': (r) => `${r.domain}/${r.code}`,
  mapping: (r) => `${r.source_code} ${r.target_code}`,
});

/** One clause reference of `clause_at_risk`: a code with an optional list item (`6.1.3 d)`). */
export const CLAUSE_REFERENCE_RE = /^(\d+(?:\.\d+)*)(?: [a-z]\))?$/;

/** The requirement codes a `clause_at_risk` value names (` / ` between references), or null. */
export function clauseAtRiskCodes(value) {
  const codes = [];
  for (const part of value.split(' / ')) {
    const match = CLAUSE_REFERENCE_RE.exec(part);
    if (!match) return null;
    codes.push(match[1]);
  }
  return codes;
}

export const LOOKUP_CODE_RE = /^[a-z][a-z0-9_]{0,39}$/;
export const RULE_ID_RE = /^BR-[0-9]{2}$/;
export const SEMVER_RE = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?$/;
export const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** Formats one CSV field: null and undefined become empty, booleans `true` or `false`. */
export function csvField(value) {
  if (value === null || value === undefined) return '';
  const s = typeof value === 'boolean' ? (value ? 'true' : 'false') : String(value);
  return /[",\r\n]/.test(s) ? '"' + s.replaceAll('"', '""') + '"' : s;
}

/**
 * Serialises records (objects keyed by header names) to CSV text with a header row.
 * A key that is not in the header is a programming error and throws.
 */
export function toCsv(header, records) {
  const known = new Set(header);
  const lines = [header.join(',')];
  for (const record of records) {
    for (const key of Object.keys(record)) {
      if (!known.has(key)) throw new Error(`CSV column "${key}" is not in the header ${header.join(',')}`);
    }
    lines.push(header.map((h) => csvField(record[h])).join(','));
  }
  return lines.join('\n') + '\n';
}

/** Serialises a JSON value pretty-printed with two spaces and a final newline. */
export function toJson(value) {
  return JSON.stringify(value, null, 2) + '\n';
}

/**
 * Parses RFC 4180 CSV text with LF line endings into an array of records (arrays of
 * strings). Throws an Error naming the line on a carriage return, a stray quote or an
 * unterminated quoted field.
 */
export function parseCsv(text) {
  const records = [];
  let record = [];
  let field = '';
  let atFieldStart = true;
  let inQuotes = false;
  let line = 1;
  let i = 0;
  const n = text.length;
  while (i < n) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        inQuotes = false;
        i += 1;
        if (i < n && text[i] !== ',' && text[i] !== '\n') {
          throw new Error(`line ${line}: unexpected character after a closing quote`);
        }
        continue;
      }
      if (c === '\r') throw new Error(`line ${line}: carriage return found (LF line endings only)`);
      if (c === '\n') line += 1;
      field += c;
      i += 1;
      continue;
    }
    if (c === '"') {
      if (!atFieldStart) throw new Error(`line ${line}: quote inside an unquoted field`);
      inQuotes = true;
      atFieldStart = false;
      i += 1;
      continue;
    }
    if (c === ',') {
      record.push(field);
      field = '';
      atFieldStart = true;
      i += 1;
      continue;
    }
    if (c === '\n') {
      record.push(field);
      records.push(record);
      record = [];
      field = '';
      atFieldStart = true;
      line += 1;
      i += 1;
      continue;
    }
    if (c === '\r') throw new Error(`line ${line}: carriage return found (LF line endings only)`);
    field += c;
    atFieldStart = false;
    i += 1;
  }
  if (inQuotes) throw new Error(`line ${line}: unterminated quoted field`);
  if (!atFieldStart || field !== '' || record.length > 0) {
    record.push(field);
    records.push(record);
  }
  return records;
}

/** Compares clause or control codes segment by segment (`8.2` before `8.10`, `A.5.9` before `A.5.10`). */
export function compareCodes(a, b) {
  const sa = String(a).split('.');
  const sb = String(b).split('.');
  for (let i = 0; i < Math.max(sa.length, sb.length); i += 1) {
    if (sa[i] === undefined) return -1;
    if (sb[i] === undefined) return 1;
    const na = Number(sa[i]);
    const nb = Number(sb[i]);
    const bothNumeric = sa[i] !== '' && sb[i] !== '' && !Number.isNaN(na) && !Number.isNaN(nb);
    const d = bothNumeric ? na - nb : sa[i].localeCompare(sb[i]);
    if (d !== 0) return d;
  }
  return 0;
}
