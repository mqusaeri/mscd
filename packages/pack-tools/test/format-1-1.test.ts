// The pack format of engine 1.1.0 (Milestone 2 E.1): retired rows, documented information, the template clause, review
// kinds, internal audit templates, derivation kinds, and the content references (cycle requirement codes, chain
// clause_at_risk values, activity output documents, documented information templates), which are warnings in a pack
// without documented information and errors in a pack with it. Also the engine version rule of the shared format.
import { cpSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { engineVersionSatisfies } from '@mscd/shared';
import { describe, expect, it } from 'vitest';
import { parseCsvRecords } from '../src/csv.js';
import { PackError, buildPack, clauseAtRiskCodes, contentReferencesStrict, verifyPack } from '../src/index.js';
import { SOURCES_DIR, tempDir, testPack } from './helpers.js';

type Row = Record<string, string>;

/** Copy of a repository pack source folder that a test may change. */
function sourceCopy(packId = 'ISO27001-2022'): string {
  const dir = path.join(tempDir(), packId);
  cpSync(path.join(SOURCES_DIR, packId), dir, { recursive: true });
  return dir;
}

function field(value: string): string {
  return /[",\n]/.test(value) ? `"${value.replaceAll('"', '""')}"` : value;
}

function readRows(dir: string, file: string): { header: string[]; rows: Row[] } {
  const [head, ...records] = parseCsvRecords(readFileSync(path.join(dir, file), 'utf8'));
  const header = head!.fields;
  return { header, rows: records.map((r) => Object.fromEntries(header.map((h, i) => [h, r.fields[i] ?? '']))) };
}

function writeRows(dir: string, file: string, header: readonly string[], rows: readonly Row[]): void {
  const lines = [header.join(','), ...rows.map((r) => header.map((h) => field(r[h] ?? '')).join(','))];
  writeFileSync(path.join(dir, file), `${lines.join('\n')}\n`);
}

function editRows(dir: string, file: string, edit: (rows: Row[]) => Row[]): void {
  const { header, rows } = readRows(dir, file);
  writeRows(dir, file, header, edit(rows));
}

function packError(fn: () => unknown): PackError {
  try {
    fn();
  } catch (error) {
    expect(error).toBeInstanceOf(PackError);
    return error as PackError;
  }
  throw new Error('expected a PackError');
}

const key = () => testPack().key;

/** A requirement row of ISO 27001 for a subclause of `parent`. */
function subclause(code: string, parent: string, title: string): Row {
  return {
    requirement_code: code, parent_code: parent, title_short: title, clause_group: code.split('.')[0]!, is_hs_common: 'false',
    documented_info_mandatory: 'false', applicability_assessable: 'false', default_frequency_code: '', evidence_example: '', sort_order: '0', retired: 'false',
  };
}

/** Renumbers `sort_order` 1..n in the given order (requirements must have unique sort orders). */
function renumber(rows: Row[]): Row[] {
  return rows.map((r, i) => ({ ...r, sort_order: String(i + 1) }));
}

describe('retired rows (E.1)', () => {
  it('keeps a retired requirement and catalogue item in the pack', () => {
    const dir = sourceCopy();
    editRows(dir, 'requirements.csv', (rows) => rows.map((r) => (r.requirement_code === '10.3' ? { ...r, retired: 'true' } : r)));
    editRows(dir, 'catalogue.csv', (rows) => rows.map((r) => (r.item_code === 'A.8.34' ? { ...r, retired: 'true' } : r)));
    const pack = buildPack(dir, key().privateKey);
    expect(pack.datasets.requirements.find((r) => r.requirement_code === '10.3')?.retired).toBe(true);
    expect(pack.datasets.requirements.find((r) => r.requirement_code === '10.2')?.retired).toBe(false);
    expect(pack.datasets.catalogue.find((c) => c.item_code === 'A.8.34')?.retired).toBe(true);
    expect(verifyPack(pack.bytes, [key().publicKey]).datasets.requirements).toHaveLength(24);
  });

  it('refuses a row that is not true or false, a live row under a retired parent and a link to a retired requirement', () => {
    const cases: [string, (dir: string) => void, RegExp][] = [
      ['empty flag', (d) => editRows(d, 'requirements.csv', (rows) => rows.map((r) => (r.requirement_code === '4.1' ? { ...r, retired: '' } : r))), /^requirements\.csv:2: retired/],
      ['retired parent', (d) => editRows(d, 'requirements.csv', (rows) => rows.map((r) =>
        r.requirement_code === '10.3' ? { ...r, retired: 'true' } : r.requirement_code === '10.2' ? { ...r, parent_code: '10.3' } : r)), /requirement 10\.2: its parent 10\.3 is retired/],
      ['retired link', (d) => {
        editRows(d, 'requirements.csv', (rows) => rows.map((r) => (r.requirement_code === '10.3' ? { ...r, retired: 'true' } : r)));
        editRows(d, 'catalogue.csv', (rows) => rows.map((r) => (r.item_code === 'A.5.1' ? { ...r, requirement_code: '10.3' } : r)));
      }, /item A\.5\.1: requirement_code 10\.3 names a retired requirement/],
    ];
    for (const [label, change, pattern] of cases) {
      const dir = sourceCopy();
      change(dir);
      const error = packError(() => buildPack(dir, key().privateKey));
      expect(error.code, label).toBe('dataset');
      expect(error.issues.some((i) => pattern.test(i)), `${label}: ${error.issues.join(' | ')}`).toBe(true);
    }
  });
});

describe('new datasets and columns (E.1)', () => {
  it('reads documented information, template clauses, review kinds, internal audit templates and derivation kinds', () => {
    const dir = sourceCopy('ISO22301-2019');
    writeRows(dir, 'document_templates.csv', ['code', 'title', 'doc_type', 'requirement_code'], [
      { code: 'SCO-01', title: 'Scope statement', doc_type: 'record', requirement_code: '4.3' },
      { code: 'TPL-POL', title: 'Business continuity policy', doc_type: 'policy', requirement_code: '' },
    ]);
    writeRows(dir, 'review_inputs.csv', ['code', 'title', 'mandatory', 'sort_order', 'review_kind'], [
      { code: 'MRI-01', title: 'Status of actions from previous reviews', mandatory: 'true', sort_order: '1', review_kind: 'management' },
      { code: 'GBR-01', title: 'Results of the management review', mandatory: 'false', sort_order: '2', review_kind: 'governing_body' },
    ]);
    writeRows(dir, 'audit_activities.csv', ['code', 'event_type', 'clause_ref', 'title', 'auditee_role', 'key_questions', 'evidence_to_request', 'sort_order'], [
      { code: 'AA-IA-01', event_type: 'internal_audit', clause_ref: '9.2', title: 'Check the audit programme', auditee_role: 'Internal Auditor', key_questions: '', evidence_to_request: 'Audit programme', sort_order: '1' },
    ]);
    editRows(dir, 'cycle_requirements.csv', (rows) => rows.map((r, i) => (i === 0 ? { ...r, derivation: '{"kind":"bia_approved"}' } : i === 1 ? { ...r, derivation: '{"kind":"risk_assessment_current","months":12}' } : r)));
    const pack = buildPack(dir, key().privateKey);
    expect(pack.datasets.documentTemplates).toEqual([
      { code: 'SCO-01', title: 'Scope statement', doc_type: 'record', requirement_code: '4.3' },
      { code: 'TPL-POL', title: 'Business continuity policy', doc_type: 'policy', requirement_code: null },
    ]);
    expect(pack.datasets.reviewInputs.map((r) => r.review_kind)).toEqual(['management', 'governing_body']);
    expect(pack.datasets.auditActivities[0]?.event_type).toBe('internal_audit');
    expect(pack.datasets.cycleRequirements[0]?.derivation).toEqual({ kind: 'bia_approved' });
    expect(pack.datasets.cycleRequirements[1]?.derivation).toEqual({ kind: 'risk_assessment_current', months: 12 });
    expect(pack.manifest.datasets['documented_info.csv']).toMatch(/^sha256:/);
  });

  it('refuses unknown values and broken references of the new columns', () => {
    const cases: [string, (dir: string) => void, RegExp][] = [
      ['derivation kind', (d) => editRows(d, 'cycle_requirements.csv', (rows) => rows.map((r, i) => (i === 0 ? { ...r, derivation: '{"kind":"audit_passed"}' } : r))), /^cycle_requirements\.csv:2: derivation\.kind/],
      ['derivation months', (d) => editRows(d, 'cycle_requirements.csv', (rows) => rows.map((r, i) => (i === 0 ? { ...r, derivation: '{"kind":"risk_assessment_current","months":0}' } : r))), /^cycle_requirements\.csv:2: derivation\.months/],
      ['review kind', (d) => writeRows(d, 'review_inputs.csv', ['code', 'title', 'mandatory', 'sort_order', 'review_kind'], [{ code: 'MRI-01', title: 'x', mandatory: 'true', sort_order: '1', review_kind: 'board' }]), /^review_inputs\.csv:2: review_kind/],
      ['governing body only', (d) => writeRows(d, 'review_inputs.csv', ['code', 'title', 'mandatory', 'sort_order', 'review_kind'], [{ code: 'GBR-01', title: 'x', mandatory: 'true', sort_order: '1', review_kind: 'governing_body' }]), /has no input of review_kind management/],
      ['old review header', (d) => writeFileSync(path.join(d, 'review_inputs.csv'), 'code,title,mandatory,sort_order\n'), /^review_inputs\.csv: header is/],
      ['template clause', (d) => writeRows(d, 'document_templates.csv', ['code', 'title', 'doc_type', 'requirement_code'], [{ code: 'SCO-01', title: 'Scope statement', doc_type: 'record', requirement_code: '99.1' }]), /template SCO-01: requirement_code 99\.1 is not in requirements\.csv/],
      ['documented info kind', (d) => writeRows(d, 'documented_info.csv', ['code', 'requirement_code', 'kind', 'title', 'template_code', 'sort_order'], [{ code: 'DI-4.3', requirement_code: '4.3', kind: 'keep', title: 'Scope', template_code: '', sort_order: '1' }]), /^documented_info\.csv:2: kind/],
      ['documented info clause', (d) => writeRows(d, 'documented_info.csv', ['code', 'requirement_code', 'kind', 'title', 'template_code', 'sort_order'], [{ code: 'DI-4.3', requirement_code: '4.9', kind: 'maintain', title: 'Scope', template_code: '', sort_order: '1' }]), /DI-4\.3: requirement_code 4\.9 is not in requirements\.csv/],
      ['documented info code', (d) => writeRows(d, 'documented_info.csv', ['code', 'requirement_code', 'kind', 'title', 'template_code', 'sort_order'], [
        { code: 'DI-4.3', requirement_code: '4.3', kind: 'maintain', title: 'Scope', template_code: '', sort_order: '1' },
        { code: 'DI-4.3', requirement_code: '4.3', kind: 'retain', title: 'Scope', template_code: '', sort_order: '2' },
      ]), /duplicate code: DI-4\.3/],
      ['missing dataset', (d) => cpSync(path.join(d, 'lookups.csv'), path.join(d, 'documented_info.csv')), /^documented_info\.csv: header is/],
    ];
    for (const [label, change, pattern] of cases) {
      const dir = sourceCopy('ISO22301-2019');
      change(dir);
      const error = packError(() => buildPack(dir, key().privateKey));
      expect(error.code, label).toBe('dataset');
      expect(error.issues.some((i) => pattern.test(i)), `${label}: ${error.issues.join(' | ')}`).toBe(true);
    }
  });
});

describe('content references (E.1)', () => {
  it('are warnings in a pack without documented information, so the Milestone 1 content builds', () => {
    const pack = testPack().pack;
    expect(contentReferencesStrict(pack.datasets)).toBe(false);
    expect(pack.warnings).toEqual(expect.arrayContaining([
      'cycle_requirements.csv: RISK_ASSESSMENT: requirement_code 6.1.2 is not in requirements.csv',
      'cycle_requirements.csv: DOCUMENT_REVIEW: requirement_code 7.5.2 is not in requirements.csv',
      'chain.csv: stage risk: clause_at_risk 6.1.2 is not in requirements.csv',
      'chain.csv: stage soa: clause_at_risk 6.1.3 is not in requirements.csv',
      expect.stringMatching(/^activities\.csv: output_document_code POL-01 \(activity 3\.1, 3\.3, 3\.5\) is not in document_templates\.csv$/),
    ]));
    expect(verifyPack(pack.bytes, [testPack().key.publicKey]).warnings).toEqual(pack.warnings);
  });

  it('are errors once the pack lists documented information, and resolve with the subclauses and templates added', () => {
    const dir = sourceCopy();
    const warnings = buildPack(dir, key().privateKey).warnings;
    writeRows(dir, 'documented_info.csv', ['code', 'requirement_code', 'kind', 'title', 'template_code', 'sort_order'], [
      { code: 'DI-4.3', requirement_code: '4.3', kind: 'maintain', title: 'Scope of the management system', template_code: 'SCO-01', sort_order: '1' },
    ]);
    const strict = packError(() => buildPack(dir, key().privateKey));
    expect(strict.code).toBe('dataset');
    // The same references, now as errors, plus the template of the new documented information.
    expect(strict.issues).toEqual(expect.arrayContaining([...warnings, 'documented_info.csv: DI-4.3: template_code SCO-01 is not in document_templates.csv']));

    editRows(dir, 'requirements.csv', (rows) => {
      const all = [...rows, subclause('6.1.2', '6.1', 'Risk assessment'), subclause('6.1.3', '6.1', 'Risk treatment'), subclause('7.5.2', '7.5', 'Creating and updating')];
      const order = (code: string) => code.split('.').map((n) => n.padStart(3, '0')).join('.');
      return renumber(all.sort((a, b) => order(a.requirement_code!).localeCompare(order(b.requirement_code!))));
    });
    const outputs = [...new Set(readRows(dir, 'activities.csv').rows.map((r) => r.output_document_code).filter((c): c is string => !!c))];
    writeRows(dir, 'document_templates.csv', ['code', 'title', 'doc_type', 'requirement_code'], [
      { code: 'SCO-01', title: 'Scope statement', doc_type: 'record', requirement_code: '4.3' },
      ...outputs.map((code) => ({ code, title: `Template ${code}`, doc_type: 'procedure', requirement_code: '' })),
    ]);
    const pack = buildPack(dir, key().privateKey);
    expect(contentReferencesStrict(pack.datasets)).toBe(true);
    expect(pack.warnings).toEqual([]);
    expect(pack.datasets.requirements.find((r) => r.requirement_code === '6.1.2')?.parent_code).toBe('6.1');
  });

  it('reads clause_at_risk as clause codes with an optional list item, several joined by " / "', () => {
    expect(clauseAtRiskCodes('6.1.3 d)')).toEqual(['6.1.3']);
    expect(clauseAtRiskCodes('8.1 / 9.1')).toEqual(['8.1', '9.1']);
    expect(clauseAtRiskCodes('10.2')).toEqual(['10.2']);
    for (const bad of ['', 'Clause 6', '6.1.3d)', '8.1/9.1', '6.1.3 D)', 'A.5.1']) expect(clauseAtRiskCodes(bad), bad).toBeNull();
    const dir = sourceCopy();
    editRows(dir, 'chain.csv', (rows) => rows.map((r) => (r.stage_key === 'metric' ? { ...r, clause_at_risk: 'see 9' } : r)));
    expect(buildPack(dir, key().privateKey).warnings).toContain('chain.csv: stage metric: clause_at_risk "see 9" is not a clause reference such as 6.1.3, 6.1.3 d) or 8.1 / 9.1');
  });
});

describe('engineVersionSatisfies (E.8 step 3)', () => {
  it('compares the release of the server with engine_min_version and accepts versions it cannot compare', () => {
    const cases: [string, string, boolean][] = [
      ['1.1.0', '1.1.0', true],
      ['1.1.1', '1.1.0', true],
      ['2.0.0', '1.1.0', true],
      ['1.0.9', '1.1.0', false],
      ['1.0.0', '1.1.0', false],
      // A release candidate reads the format of its release; an older line's candidate does not.
      ['1.1.0-rc.1', '1.1.0', true],
      ['1.0.0-rc.1', '1.1.0', false],
      ['1.1.0+4863d78', '1.1.0', true],
      ['1.0.0+4863d78', '1.1.0', false],
      // Image tags and development stamps are not versions: no check.
      ['smoke', '1.1.0', true],
      ['demo-4863d78', '1.1.0', true],
      ['unspecified', '99.0.0', true],
    ];
    for (const [server, engine, ok] of cases) expect(engineVersionSatisfies(server, engine), `${server} vs ${engine}`).toBe(ok);
  });
});
