// E.8 pack installation as `mscd_pack_installer` (D-17): the six development packs and their rows, reinstall as a
// no-op, an in-place minor update that never rewrites tenant activity copies (D-30), downgrades, the J.5 archive
// cases, tampering and untrusted keys (nothing written), supersession in either order (TS 6.3).
import { generateKeyPairSync } from 'node:crypto';
import { parse as parseCsv } from 'csv-parse/sync';
import { sql } from 'kysely';
import { beforeAll, describe, expect, it } from 'vitest';
import type { CreatedTenant } from '../../../src/db/tenant-provisioner';
import { VERSION } from '../../../src/generated/build-info';
import { ChainedAuditWriter } from '../../../src/modules/audit/audit-writer';
import { compiledTrustAnchors } from '../../../src/modules/license/trust-anchors';
import { PackInstaller } from '../../../src/modules/packs/pack-installer';
import { PackRejectedError } from '../../../src/modules/packs/pack-verification';
import { TenantScope } from '../../../src/modules/tenancy/tenant-scope';
import { FAKE_PRINCIPAL_HEADER } from '../../setup/auth-fakes';
import { createTenant } from '../../setup/global-db';
import { useTestDatabase, type TestDatabase } from '../../setup/test-db';
import { expectPgError, inScope, rolledBack } from '../db/helpers';
import {
  DEV_PACK_IDS,
  addMember,
  archiveEntries,
  archiveOf,
  changedPack,
  createPackApp,
  devLicence,
  devPack,
  editDataset,
  gzipBomb,
  installDevPacks,
  orgIdentities,
  testInstaller,
  type MutableSource,
} from './fixtures';

const OPERATOR = { userId: null, kind: 'operator' as const };

async function refCounts(db: TestDatabase, packId: string): Promise<Record<string, number>> {
  const { rows } = await sql<Record<string, string>>`
    select
      (select count(*) from ref.requirement r where r.framework_version_id = v.id) as requirements,
      (select count(*) from ref.catalogue_item c where c.framework_version_id = v.id) as catalogue,
      (select count(*) from ref.traceability_chain_def c where c.framework_version_id = v.id) as chain,
      (select count(*) from ref.activity_template a where a.framework_version_id = v.id) as activities,
      (select count(distinct a.phase_no) from ref.activity_template a where a.framework_version_id = v.id) as phases,
      (select count(*) from ref.evidence_frequency_rule f where f.framework_version_id = v.id) as frequencies,
      (select count(*) from ref.label l where l.framework_version_id = v.id) as labels,
      (select count(*) from ref.lookup_value l where l.framework_version_id = v.id) as lookups,
      (select count(*) from ref.audit_activity_template a where a.framework_version_id = v.id) as audit_activities,
      (select count(*) from ref.finding_condition f where f.framework_version_id = v.id) as finding_conditions,
      (select count(*) from ref.cycle_requirement_def c where c.framework_version_id = v.id) as cycle_requirements,
      (select count(*) from ref.drift_rule_def d where d.framework_version_id = v.id) as drift_rules,
      (select count(*) from ref.prep_task_template p where p.framework_version_id = v.id) as prep_tasks,
      (select count(*) from ref.rule_activation r where r.framework_version_id = v.id) as rules,
      (select count(*) from ref.risk_profile r where r.framework_version_id = v.id) as risk_profiles
    from ref.framework_version v where v.pack_id = ${packId}`.execute(db.migrator);
  return Object.fromEntries(Object.entries(rows[0] ?? {}).map(([k, v]) => [k, Number(v)]));
}

async function totalRefRows(db: TestDatabase): Promise<number> {
  const { rows } = await sql<{ n: string }>`
    select (select count(*) from ref.framework) + (select count(*) from ref.framework_version) + (select count(*) from ref.requirement)
         + (select count(*) from ref.catalogue_item) + (select count(*) from ref.activity_template) + (select count(*) from ref.label)
         + (select count(*) from ref.lookup_value) + (select count(*) from ref.rule_activation) as n`.execute(db.migrator);
  return Number(rows[0]!.n);
}

async function packInstallRows(db: TestDatabase): Promise<{ pack_id: string; pack_version: string; status: string }[]> {
  const { rows } = await sql<{ pack_id: string; pack_version: string; status: string }>`
    select pack_id, pack_version, status from platform.pack_install order by pack_id, created_at`.execute(db.migrator);
  return rows;
}

async function auditActions(db: TestDatabase, action: string): Promise<{ entity_code: string | null; organization_id: string | null; actor_kind: string; after_data: Record<string, unknown> | null }[]> {
  return inScope(db.migrator, { platformScope: true }, async (trx) => {
    const { rows } = await sql<{ entity_code: string | null; organization_id: string | null; actor_kind: string; after_data: Record<string, unknown> | null }>`
      select entity_code, organization_id, actor_kind, after_data from platform.audit_log where action = ${action} order by seq`.execute(trx);
    return rows;
  });
}

async function expectRejected(promise: Promise<unknown>, code: string, message?: RegExp): Promise<PackRejectedError> {
  let caught: unknown;
  try {
    await promise;
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(PackRejectedError);
  const rejected = caught as PackRejectedError;
  expect(rejected.code).toBe(code);
  if (message) expect([rejected.message, ...rejected.issues].join('\n')).toMatch(message);
  return rejected;
}

describe('installing the development packs (E.8)', () => {
  const db = useTestDatabase('empty');

  it('installs the six packs with every dataset as mscd_pack_installer', async () => {
    const outcomes = await installDevPacks(db);
    expect(outcomes.map((o) => [o.packId, o.status])).toEqual(DEV_PACK_IDS.map((id) => [id, 'installed']));

    expect(await refCounts(db, 'ISO27001-2022')).toEqual({
      requirements: 35, catalogue: 93, chain: 8, activities: 69, phases: 9, frequencies: 7, labels: 20, lookups: 11,
      audit_activities: 6, finding_conditions: 6, cycle_requirements: 6, drift_rules: 4, prep_tasks: 7, rules: 40, risk_profiles: 1,
    });
    // The content step of M2-04 (E.2): every requirement row is kept, retired rows included, and the ISO 9001:2026
    // edition drops the transition phase and the transition cycle item of the demo (E.4).
    expect(await refCounts(db, 'ISO9001-2026')).toMatchObject({ requirements: 84, catalogue: 0, chain: 8, activities: 43, phases: 8, lookups: 11, rules: 39, prep_tasks: 5, cycle_requirements: 5 });
    expect(await refCounts(db, 'ISO9001-2015')).toMatchObject({ requirements: 84, activities: 57, phases: 9 });
    expect(await refCounts(db, 'ISO22301-2019')).toMatchObject({ requirements: 60, chain: 8, activities: 43, lookups: 15 });
    expect(await refCounts(db, 'ISO37001-2025')).toMatchObject({ requirements: 52, chain: 6, activities: 43, lookups: 19, rules: 40, prep_tasks: 5 });
    expect(await refCounts(db, 'ISO37001-2016')).toMatchObject({ requirements: 52, chain: 6, prep_tasks: 5 });

    const gate = await sql<{ phase_no: number }>`
      select distinct a.phase_no from ref.activity_template a join ref.framework_version v on v.id = a.framework_version_id
      where v.pack_id = 'ISO27001-2022' and a.is_gate_phase`.execute(db.migrator);
    expect(gate.rows.map((r) => r.phase_no)).toEqual([4]);
    const catalogue = await sql<{ item_code: string; theme_code: string; requirement_id: string | null }>`
      select c.item_code, c.theme_code, c.requirement_id from ref.catalogue_item c join ref.framework_version v on v.id = c.framework_version_id
      where v.pack_id = 'ISO27001-2022' order by c.sort_order limit 1`.execute(db.migrator);
    expect(catalogue.rows[0]).toMatchObject({ item_code: 'A.5.1', theme_code: 'A.5' });

    const versions = await sql<{ pack_id: string; pack_version: string; status: string; pre_release: boolean; transition_ends_at: string | null; supersedes: string | null; target: string }>`
      select v.pack_id, v.pack_version, v.status, v.pre_release, v.transition_ends_at, s.pack_id as supersedes, v.applicability_target as target
      from ref.framework_version v left join ref.framework_version s on s.id = v.supersedes_version_id order by v.pack_id`.execute(db.migrator);
    expect(versions.rows).toEqual([
      { pack_id: 'ISO22301-2019', pack_version: '1.1.0', status: 'current', pre_release: false, transition_ends_at: null, supersedes: null, target: 'requirement' },
      { pack_id: 'ISO27001-2022', pack_version: '1.3.0', status: 'current', pre_release: false, transition_ends_at: null, supersedes: null, target: 'catalogue_item' },
      { pack_id: 'ISO37001-2016', pack_version: '1.1.0', status: 'withdrawn', pre_release: false, transition_ends_at: null, supersedes: null, target: 'requirement' },
      { pack_id: 'ISO37001-2025', pack_version: '0.7.0', status: 'current', pre_release: true, transition_ends_at: null, supersedes: null, target: 'requirement' },
      { pack_id: 'ISO9001-2015', pack_version: '1.5.0', status: 'transition', pre_release: false, transition_ends_at: '2029-09-15', supersedes: null, target: 'requirement' },
      { pack_id: 'ISO9001-2026', pack_version: '0.10.0', status: 'current', pre_release: false, transition_ends_at: null, supersedes: 'ISO9001-2015', target: 'requirement' },
    ]);
    const frameworks = await sql<{ code: string; name: string }>`select code, name from ref.framework order by code`.execute(db.migrator);
    expect(frameworks.rows).toEqual([
      { code: 'ISO22301', name: 'ISO 22301' },
      { code: 'ISO27001', name: 'ISO/IEC 27001' },
      { code: 'ISO37001', name: 'ISO 37001' },
      { code: 'ISO9001', name: 'ISO 9001' },
    ]);
    const br02 = await sql<{ pack_id: string }>`
      select v.pack_id from ref.rule_activation r join ref.framework_version v on v.id = r.framework_version_id
      where r.rule_id = 'BR-02' order by v.pack_id`.execute(db.migrator);
    expect(br02.rows.map((r) => r.pack_id)).toEqual(['ISO27001-2022', 'ISO37001-2016', 'ISO37001-2025']);

    const installs = await sql<{ pack_id: string; status: string; signature_key_id: string; archive_sha256: string; framework_version_id: string | null }>`
      select pack_id, status, signature_key_id, archive_sha256, framework_version_id from platform.pack_install order by pack_id`.execute(db.migrator);
    expect(installs.rows).toHaveLength(6);
    for (const row of installs.rows) {
      const pack = devPack(row.pack_id as (typeof DEV_PACK_IDS)[number]);
      expect(row).toMatchObject({ status: 'installed', signature_key_id: pack.keyId, archive_sha256: pack.sha256 });
      expect(row.framework_version_id).not.toBeNull();
    }
    const audited = await auditActions(db, 'pack.installed');
    expect(audited.map((a) => a.entity_code)).toEqual(DEV_PACK_IDS.map((id) => `${id} ${devPack(id).manifest.pack_version}`));
    expect(audited.every((a) => a.organization_id === null && a.actor_kind === 'operator')).toBe(true);
    expect(audited[1]!.after_data).toMatchObject({ pack_id: 'ISO27001-2022', rows: { catalogue: 93, activities: 69, chain: 8 } });
  });

  it('holds the content step of M2-04 (E.2): clause trees, Annex A links, documented information, templates and review inputs', async () => {
    const content = async (packId: string) => {
      const { rows } = await sql<Record<string, string | null>>`
        select
          (select count(*) from ref.requirement r where r.framework_version_id = v.id and not r.retired) as live,
          (select string_agg(r.requirement_code, ',' order by r.sort_order) from ref.requirement r where r.framework_version_id = v.id and r.retired) as retired,
          (select count(*) from ref.documented_info d where d.framework_version_id = v.id) as documented_info,
          (select count(*) from ref.document_template t where t.framework_version_id = v.id) as templates,
          (select count(*) from ref.review_input_def i where i.framework_version_id = v.id and i.mandatory) as review_inputs,
          (select count(*) from ref.requirement r where r.framework_version_id = v.id and r.applicability_assessable) as assessable,
          (select count(*) from ref.requirement r where r.framework_version_id = v.id and not r.retired and coalesce(r.evidence_example, '') = ''
              and not exists (select 1 from ref.requirement c where c.parent_id = r.id and not c.retired)) as leaves_without_example,
          (select count(*) from ref.activity_template a where a.framework_version_id = v.id and a.output_document_code is not null
              and not exists (select 1 from ref.document_template t where t.framework_version_id = v.id and t.code = a.output_document_code)) as open_outputs,
          (select count(*) from ref.documented_info d where d.framework_version_id = v.id and d.template_code is not null
              and not exists (select 1 from ref.document_template t where t.framework_version_id = v.id and t.code = d.template_code)) as open_templates
        from ref.framework_version v where v.pack_id = ${packId}`.execute(db.migrator);
      const r = rows[0]!;
      return {
        live: Number(r.live), retired: r.retired ?? '', documentedInfo: Number(r.documented_info), templates: Number(r.templates), reviewInputs: Number(r.review_inputs),
        assessable: Number(r.assessable), open: Number(r.leaves_without_example) + Number(r.open_outputs) + Number(r.open_templates),
      };
    };
    expect(await content('ISO27001-2022')).toEqual({ live: 34, retired: '10.3', documentedInfo: 15, templates: 25, reviewInputs: 10, assessable: 0, open: 0 });
    expect(await content('ISO9001-2015')).toEqual({ live: 84, retired: '', documentedInfo: 27, templates: 25, reviewInputs: 12, assessable: 10, open: 0 });
    expect(await content('ISO9001-2026')).toEqual({ live: 84, retired: '', documentedInfo: 27, templates: 25, reviewInputs: 13, assessable: 10, open: 0 });
    expect(await content('ISO22301-2019')).toEqual({ live: 59, retired: '10.3', documentedInfo: 15, templates: 23, reviewInputs: 13, assessable: 0, open: 0 });
    expect(await content('ISO37001-2016')).toEqual({ live: 50, retired: '6.3,10.3', documentedInfo: 13, templates: 23, reviewInputs: 11, assessable: 0, open: 0 });
    expect(await content('ISO37001-2025')).toEqual({ live: 51, retired: '10.3', documentedInfo: 13, templates: 24, reviewInputs: 12, assessable: 0, open: 0 });

    // Clause 10 per standard: retitled and retired, never deleted.
    const clause10 = async (packId: string) =>
      (await sql<{ code: string; title: string; retired: boolean }>`
        select r.requirement_code as code, r.title_short as title, r.retired from ref.requirement r join ref.framework_version v on v.id = r.framework_version_id
         where v.pack_id = ${packId} and r.requirement_code like '10.%' order by r.sort_order`.execute(db.migrator)).rows.map((r) => `${r.code} ${r.title}${r.retired ? ' (retired)' : ''}`);
    expect(await clause10('ISO27001-2022')).toEqual(['10.1 Continual improvement', '10.2 Nonconformity and corrective action', '10.3 Continual improvement (retired)']);
    expect(await clause10('ISO9001-2015')).toEqual(['10.1 Improvement: general', '10.2 Nonconformity and corrective action', '10.2.1 Responding to a nonconformity', '10.2.2 Records of nonconformities and corrective actions', '10.3 Continual improvement']);
    expect(await clause10('ISO22301-2019')).toEqual(['10.1 Nonconformity and corrective action', '10.2 Continual improvement', '10.3 Continual improvement (retired)']);
    expect(await clause10('ISO37001-2016')).toEqual(['10.1 Nonconformity and corrective action', '10.2 Continual improvement', '10.3 Continual improvement (retired)']);
    expect(await clause10('ISO37001-2025')).toEqual(['10.1 Continual improvement', '10.2 Nonconformity and corrective action', '10.3 Continual improvement (retired)']);

    // Annex A: 84 controls support 8.3 and nine a closer clause; every control has an evidence example.
    const links = await sql<{ code: string; n: string; examples: string }>`
      select r.requirement_code as code, count(*) as n, count(nullif(c.evidence_example, '')) as examples from ref.catalogue_item c
        join ref.framework_version v on v.id = c.framework_version_id join ref.requirement r on r.id = c.requirement_id
       where v.pack_id = 'ISO27001-2022' group by r.requirement_code`.execute(db.migrator);
    expect(Object.fromEntries(links.rows.map((r) => [r.code, Number(r.n)]))).toEqual({ '4.2': 1, '5.1': 1, '5.2': 1, '5.3': 1, '7.3': 1, '7.4': 1, '7.5.3': 1, '8.3': 84, '9.1': 1, '9.2': 1 });
    expect(links.rows.reduce((sum, r) => sum + Number(r.examples), 0)).toBe(93);

    // SCO-01 answers clause 4.3; the activities of ISO/IEC 27001 name 13 output documents, each a template of the pack.
    const sco = await sql`select t.code, r.requirement_code from ref.document_template t join ref.framework_version v on v.id = t.framework_version_id
      left join ref.requirement r on r.framework_version_id = v.id and r.requirement_code = t.requirement_code where v.pack_id = 'ISO27001-2022' and t.code = 'SCO-01'`.execute(db.migrator);
    expect(sco.rows).toEqual([{ code: 'SCO-01', requirement_code: '4.3' }]);
    const outputs = await sql<{ code: string }>`select distinct a.output_document_code as code from ref.activity_template a join ref.framework_version v on v.id = a.framework_version_id
      where v.pack_id = 'ISO27001-2022' and a.output_document_code is not null order by 1`.execute(db.migrator);
    expect(outputs.rows.map((r) => r.code)).toEqual(['IMS-01', 'IMS-02', 'IMS-03', 'IMS-04', 'PLN-01', 'POL-01', 'PRC-04', 'PRC-07', 'PRC-08', 'PRC-11', 'PRC-13', 'SCO-01', 'SOA-01']);

    // The ISO 37001 chain asks its questions in both languages and names a clause at risk per stage.
    const chain = await sql<{ stage_key: string; clause_at_risk: string | null; en: string; id: string }>`
      select c.stage_key, c.clause_at_risk, c.auditor_question_en as en, c.auditor_question_id as id from ref.traceability_chain_def c
        join ref.framework_version v on v.id = c.framework_version_id where v.pack_id = 'ISO37001-2025' order by c.position`.execute(db.migrator);
    expect(chain.rows.map((r) => [r.stage_key, r.clause_at_risk])).toEqual([['context', '4.1'], ['brisk', '4.5'], ['control', '8.1'], ['associate', '8.2'], ['document', '7.5'], ['evidence', '8.1 / 9.1']]);
    expect(chain.rows.every((r) => r.en !== '' && r.id !== '' && r.en !== r.id)).toBe(true);

    // Derivation JSON on the cycle requirements that have a data source; no demo facts in prep tasks.
    const cycle = await sql<{ code: string; kind: string | null }>`
      select d.code, d.derivation->>'kind' as kind from ref.cycle_requirement_def d join ref.framework_version v on v.id = d.framework_version_id
       where v.pack_id = 'ISO27001-2022' order by d.sort_order`.execute(db.migrator);
    expect(cycle.rows).toEqual([
      { code: 'RISK_ASSESSMENT', kind: 'risk_assessment_current' },
      { code: 'INTERNAL_AUDIT', kind: 'internal_audit_done' },
      { code: 'MGMT_REVIEW', kind: 'management_review_closed' },
      { code: 'CORRECTIVE_ACTION', kind: 'corrective_actions_closed' },
      { code: 'PERFORMANCE_EVALUATION', kind: 'metrics_current' },
      { code: 'DOCUMENT_REVIEW', kind: 'documents_reviewed_on_time' },
    ]);
    const demoText = await sql<{ n: string }>`
      select (select count(*) from ref.prep_task_template where title ~ '(NC-2025-02|SoA v3\\.0|DC Jakarta|SharePoint|Internal audit 2026 report|EX-01)')
           + (select count(*) from ref.cycle_requirement_def where title ~ '(NC-2025-02|SoA v3\\.0|DC Jakarta|SharePoint)') as n`.execute(db.migrator);
    expect(Number(demoText.rows[0]!.n)).toBe(0);
    // A system certified on ISO 9001:2026 gets general cycle items: the demo's transition wording stays in the 2015
    // edition, whose demo system moves to 2026 (the seed links the demo cycle items by title).
    const cycleTitles = async (packId: string) =>
      (await sql<{ code: string; title: string }>`
        select d.code, d.title from ref.cycle_requirement_def d join ref.framework_version v on v.id = d.framework_version_id
         where v.pack_id = ${packId} order by d.sort_order`.execute(db.migrator)).rows.map((r) => `${r.code} ${r.title}`);
    expect(await cycleTitles('ISO9001-2026')).toEqual([
      'RISK_ASSESSMENT Risks and opportunities reviewed',
      'CUSTOMER_SATISFACTION Customer satisfaction analysed',
      'INTERNAL_AUDIT Internal audit covering all requirements',
      'MGMT_REVIEW Management review with all mandatory inputs',
      'CORRECTIVE_ACTION Corrective actions closed with verification',
    ]);
    expect(await cycleTitles('ISO9001-2015')).toContain('EDITION_TRANSITION Edition transition tasks complete');
  });

  it('treats a second installation of the same versions as a no-op', async () => {
    const before = { ref: await totalRefRows(db), installs: await packInstallRows(db), audited: (await auditActions(db, 'pack.installed')).length };
    const outcomes = await installDevPacks(db);
    expect(outcomes.map((o) => o.status)).toEqual(DEV_PACK_IDS.map(() => 'unchanged'));
    expect(await totalRefRows(db)).toBe(before.ref);
    expect(await packInstallRows(db)).toEqual(before.installs);
    expect((await auditActions(db, 'pack.installed')).length).toBe(before.audited);
  });

  describe('a newer minor version of an installed edition', () => {
    let tenant: CreatedTenant;

    beforeAll(async () => {
      tenant = await createTenant(db, 'upd');
      const ta = await addMember(db, 'ta.upd', tenant.id, ['tenant_admin']);
      const mm = await addMember(db, 'mm.upd', tenant.id);
      const app = await createPackApp(db, { identities: orgIdentities(tenant, { ta, mm }) });
      try {
        const headers = { [FAKE_PRINCIPAL_HEADER]: 'ta@upd' };
        expect((await app.app.inject({ method: 'PUT', url: '/api/v1/admin/license', headers, payload: devLicence(tenant.id) })).statusCode).toBe(200);
        const created = await app.app.inject({
          method: 'POST',
          url: '/api/v1/admin/management-systems',
          headers,
          payload: { slug: 'isms', code: 'ISMS', name: 'Information security', packId: 'ISO27001-2022', edition: '2022', scopeStatement: 'Whole organisation', defaultRepository: 'vault', color: '#e8731a' },
        });
        expect(created.statusCode).toBe(201);
      } finally {
        await app.close();
      }
    });

    it('updates titles, labels and lookups in place, adds rows, and leaves tenant activity copies unchanged (D-30)', async () => {
      const before = await sql<{ id: string; n: string }>`
        select v.id, (select count(*) from ref.requirement r where r.framework_version_id = v.id) as n
        from ref.framework_version v where v.pack_id = 'ISO27001-2022'`.execute(db.migrator);
      const update = changedPack('ISO27001-2022', (s) => {
        s.manifest.pack_version = '1.4.0';
        editDataset(s, 'activities.csv', ',Secure top management mandate,', ',Secure the mandate of top management,');
        editDataset(s, 'requirements.csv', 'Understanding the organization and its context', 'Understanding the organisation and its context');
        editDataset(s, 'catalogue.csv', 'Policies for information security', 'Information security policies');
        editDataset(s, 'labels.en.json', '"ISMS Manager"', '"ISMS Lead"');
        editDataset(s, 'lookups.csv', 'doc_type,policy,Policy,', 'doc_type,policy,Policy document,');
      });
      const outcome = await testInstaller(db.packInstaller).install(update.bytes, { actor: OPERATOR });
      expect(outcome).toMatchObject({ status: 'installed', version: '1.4.0', updatedEdition: true, previousVersion: '1.3.0' });

      const after = await sql<{ id: string; pack_version: string; status: string; n: string }>`
        select v.id, v.pack_version, v.status, (select count(*) from ref.requirement r where r.framework_version_id = v.id) as n
        from ref.framework_version v where v.pack_id = 'ISO27001-2022'`.execute(db.migrator);
      expect(after.rows).toEqual([{ id: before.rows[0]!.id, pack_version: '1.4.0', status: 'current', n: before.rows[0]!.n }]);
      const titles = await sql<{ requirement: string; item: string; activity: string; label: string; lookup: string }>`
        select (select title_short from ref.requirement where framework_version_id = v.id and requirement_code = '4.1') as requirement,
               (select title_short from ref.catalogue_item where framework_version_id = v.id and item_code = 'A.5.1') as item,
               (select title from ref.activity_template where framework_version_id = v.id and phase_no = 1 and activity_no = 1) as activity,
               (select value from ref.label where framework_version_id = v.id and key = 'ms.manager_role' and lang = 'en') as label,
               (select label_en from ref.lookup_value where framework_version_id = v.id and domain = 'doc_type' and code = 'policy') as lookup
        from ref.framework_version v where v.pack_id = 'ISO27001-2022'`.execute(db.migrator);
      expect(titles.rows[0]).toEqual({
        requirement: 'Understanding the organisation and its context',
        item: 'Information security policies',
        activity: 'Secure the mandate of top management',
        label: 'ISMS Lead',
        lookup: 'Policy document',
      });
      const installs = (await packInstallRows(db)).filter((r) => r.pack_id === 'ISO27001-2022');
      expect(installs).toEqual([
        { pack_id: 'ISO27001-2022', pack_version: '1.3.0', status: 'superseded' },
        { pack_id: 'ISO27001-2022', pack_version: '1.4.0', status: 'installed' },
      ]);

      // The tenant's activity copies keep the titles and the template version of the activation.
      const scoped = await db.migrator.transaction().execute(async (trx) => {
        await sql`select set_config('app.org_id', ${tenant.id}, true)`.execute(trx);
        return sql<{ title: string; template_pack_version: string }>`
          select title, template_pack_version from ${sql.id(tenant.schemaName, 'implementation_activity_progress')} order by phase_no, activity_no`.execute(trx);
      });
      expect(scoped.rows).toHaveLength(69);
      expect(scoped.rows[0]).toEqual({ title: 'Secure top management mandate', template_pack_version: '1.3.0' });
      expect(scoped.rows.every((r) => r.template_pack_version === '1.3.0')).toBe(true);
    });

    it('rejects an older version than the installed one and writes nothing but the rejection', async () => {
      const refBefore = await totalRefRows(db);
      const installsBefore = await packInstallRows(db);
      const older = changedPack('ISO27001-2022', (s) => {
        s.manifest.pack_version = '1.1.0';
      });
      await expectRejected(testInstaller(db.packInstaller).install(older.bytes, { actor: OPERATOR }), 'downgrade', /older than the installed version 1\.4\.0/);
      expect(await totalRefRows(db)).toBe(refBefore);
      expect(await packInstallRows(db)).toEqual(installsBefore);
      const rejected = await auditActions(db, 'pack.rejected');
      expect(rejected.at(-1)).toMatchObject({ entity_code: 'ISO27001-2022 1.1.0', after_data: { reason: 'downgrade' } });
    });
  });
});

describe('packs that are refused before anything is written (E.8 steps 1 to 4, J.5)', () => {
  const db = useTestDatabase('empty');
  const base = () => devPack('ISO22301-2019');

  async function expectNothingWritten(): Promise<void> {
    expect(await totalRefRows(db)).toBe(0);
    expect(await packInstallRows(db)).toEqual([]);
  }

  it('rejects a tampered dataset (checksum) with no row written', async () => {
    const entries = archiveEntries(base().bytes).map((e) =>
      e.path === 'requirements.csv' ? { ...e, data: Buffer.from(e.data!.toString('utf8').replace('Understanding', 'Misunderstanding')) } : e,
    );
    await expectRejected(testInstaller(db.packInstaller).install(archiveOf(entries), { actor: OPERATOR }), 'checksum', /requirements\.csv/);
    await expectNothingWritten();
    expect((await auditActions(db, 'pack.rejected')).at(-1)).toMatchObject({ after_data: { reason: 'checksum' } });
  });

  it('rejects path traversal, duplicate names, an extra file, a link and a decompression bomb', async () => {
    const installer = testInstaller(db.packInstaller);
    const entries = archiveEntries(base().bytes);
    const cases: [string, Buffer, RegExp][] = [
      ['traversal', archiveOf([...entries.slice(0, -1), { path: '../evil.csv', data: Buffer.from('x') }, entries.at(-1)!]), /\.\./],
      ['duplicate', archiveOf([...entries.slice(0, -1), { path: 'requirements.csv', data: Buffer.from('x') }, entries.at(-1)!]), /more than once/],
      ['extra file', archiveOf([...entries.slice(0, -1), { path: 'extra.csv', data: Buffer.from('x') }, entries.at(-1)!]), /extra\.csv/],
      ['symbolic link', archiveOf([...entries.slice(0, -1), { path: 'link.csv', type: 'symlink', linkPath: '/etc/passwd' }, entries.at(-1)!]), /link/i],
      ['bomb', gzipBomb(), /larger than/],
    ];
    for (const [name, bytes, message] of cases) {
      const rejected = await expectRejected(installer.install(bytes, { actor: OPERATOR }), 'archive', message);
      expect(rejected.status, name).toBe(400);
    }
    await expectNothingWritten();
  });

  it('rejects a pack signed with a key that is not compiled into the build', async () => {
    const stranger = generateKeyPairSync('ed25519').privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
    const foreign = changedPack('ISO22301-2019', () => undefined, stranger);
    await expectRejected(testInstaller(db.packInstaller).install(foreign.bytes, { actor: OPERATOR }), 'untrusted_key', /not a trusted pack key/);
    await expectNothingWritten();
  });

  it('rejects a pack that needs a newer server (422) or names an unknown chain table (400)', async () => {
    const future = changedPack('ISO22301-2019', (s) => {
      s.manifest.engine_min_version = '99.0.0';
    });
    const engine = await expectRejected(testInstaller(db.packInstaller).install(future.bytes, { actor: OPERATOR }), 'engine_version', /99\.0\.0/);
    expect(engine.status).toBe(422);
    const unknownTable = changedPack('ISO22301-2019', (s) => {
      editDataset(s, 'chain.csv', ',entity,context_issue,', ',entity,invoice,');
    });
    const reference = await expectRejected(testInstaller(db.packInstaller).install(unknownTable.bytes, { actor: OPERATOR }), 'reference', /entity type invoice/);
    expect(reference.status).toBe(400);
    await expectNothingWritten();
  });

  it('moves a superseded edition to transition when the newer edition was installed first (TS 6.3)', async () => {
    const installer = testInstaller(db.packInstaller);
    await installer.install(devPack('ISO9001-2026').bytes, { actor: OPERATOR });
    await installer.install(devPack('ISO9001-2015').bytes, { actor: OPERATOR });
    const { rows } = await sql<{ pack_id: string; status: string; transition_ends_at: string | null; supersedes: string | null }>`
      select v.pack_id, v.status, v.transition_ends_at, s.pack_id as supersedes from ref.framework_version v
      left join ref.framework_version s on s.id = v.supersedes_version_id order by v.pack_id`.execute(db.migrator);
    expect(rows).toEqual([
      { pack_id: 'ISO9001-2015', status: 'transition', transition_ends_at: '2029-09-15', supersedes: null },
      { pack_id: 'ISO9001-2026', status: 'current', transition_ends_at: null, supersedes: 'ISO9001-2015' },
    ]);
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// The pack format of engine 1.1.0 (Milestone 2 E.1, M2-03)
// ---------------------------------------------------------------------------------------------------------------------

type CsvRow = Record<string, string>;

function csvField(value: string): string {
  return /[",\n]/.test(value) ? `"${value.replaceAll('"', '""')}"` : value;
}

/** Rewrites one CSV dataset of a mutable source through `edit` on its rows. */
function editCsv(source: MutableSource, file: string, edit: (rows: CsvRow[]) => CsvRow[]): void {
  const [header, ...records] = parseCsv(source.datasets.get(file)!.toString('utf8')) as string[][];
  const rows = edit(records.map((r) => Object.fromEntries(header!.map((h, i) => [h, r[i] ?? '']))));
  source.datasets.set(file, Buffer.from(`${[header!.join(','), ...rows.map((r) => header!.map((h) => csvField(r[h] ?? '')).join(','))].join('\n')}\n`, 'utf8'));
}

function setCsv(source: MutableSource, file: string, header: readonly string[], rows: readonly CsvRow[]): void {
  source.datasets.set(file, Buffer.from(`${[header.join(','), ...rows.map((r) => header.map((h) => csvField(r[h] ?? '')).join(','))].join('\n')}\n`, 'utf8'));
}

/**
 * ISO 22301 of the content step (M2-04, E.2), which holds documented information, template clauses, sub-clauses and
 * a retired row, with a governing body review input and an internal audit template added (the development pack has
 * neither).
 */
function iso22301WithInternalAudit(version: string) {
  return changedPack('ISO22301-2019', (s) => {
    s.manifest.pack_version = version;
    editCsv(s, 'review_inputs.csv', (rows) => [
      ...rows,
      { code: 'GB-01', title: 'Results of the management review', mandatory: 'false', sort_order: String(rows.length + 1), review_kind: 'governing_body' },
    ]);
    setCsv(s, 'audit_activities.csv', ['code', 'event_type', 'clause_ref', 'title', 'auditee_role', 'key_questions', 'evidence_to_request', 'sort_order'], [
      { code: 'AA-IA-01', event_type: 'internal_audit', clause_ref: '9.2', title: 'Check the audit programme', auditee_role: 'Internal Auditor', key_questions: '', evidence_to_request: 'Audit programme', sort_order: '1' },
    ]);
  });
}

describe('the pack format of engine 1.1.0 (Milestone 2 E.1)', () => {
  const db = useTestDatabase('empty');

  it('writes retired rows, documented information, template clauses, review kinds and internal audit templates', async () => {
    const pack = iso22301WithInternalAudit('1.1.1');
    expect(pack.warnings).toEqual([]);
    const outcome = await testInstaller(db.packInstaller).install(pack.bytes, { actor: OPERATOR });
    expect(outcome).toMatchObject({ status: 'installed', version: '1.1.1', updatedEdition: false, changes: null, warnings: [] });
    expect(outcome.status === 'installed' && outcome.rows).toMatchObject({ documentedInfo: 15, documentTemplates: 23, reviewInputs: 14, auditActivities: 1, requirements: 60 });
    const version = (await sql<{ id: string }>`select id from ref.framework_version where pack_id = 'ISO22301-2019'`.execute(db.migrator)).rows[0]!.id;
    const info = await sql`select code, requirement_code, kind, title, template_code, sort_order from ref.documented_info where framework_version_id = ${version} order by sort_order`.execute(db.migrator);
    expect(info.rows).toHaveLength(15);
    expect(info.rows.slice(0, 2)).toEqual([
      { code: 'DI-01', requirement_code: '4.2.2', kind: 'maintain', title: 'Legal, regulatory and other requirements', template_code: 'REG-B02', sort_order: 1 },
      { code: 'DI-02', requirement_code: '4.3.2', kind: 'maintain', title: 'Scope of the BCMS and the reasons for any exclusion', template_code: 'SCO-B01', sort_order: 2 },
    ]);
    const tree = await sql<{ requirement_code: string; retired: boolean; parent: string | null }>`
      select r.requirement_code, r.retired, p.requirement_code as parent from ref.requirement r left join ref.requirement p on p.id = r.parent_id
       where r.framework_version_id = ${version} and (r.retired or r.parent_id is not null) order by r.sort_order`.execute(db.migrator);
    expect(tree.rows.filter((r) => r.retired)).toEqual([{ requirement_code: '10.3', retired: true, parent: null }]);
    expect(tree.rows.filter((r) => r.parent)).toHaveLength(33);
    expect(tree.rows.filter((r) => r.parent === '8.2')).toEqual([
      { requirement_code: '8.2.1', retired: false, parent: '8.2' },
      { requirement_code: '8.2.2', retired: false, parent: '8.2' },
      { requirement_code: '8.2.3', retired: false, parent: '8.2' },
    ]);
    expect(tree.rows.find((r) => r.requirement_code === '7.5.3.1')).toEqual({ requirement_code: '7.5.3.1', retired: false, parent: '7.5.3' });
    expect((await sql`select requirement_code from ref.document_template where framework_version_id = ${version} and code = 'SCO-B01'`.execute(db.migrator)).rows).toEqual([{ requirement_code: '4.3.2' }]);
    const kinds = (await sql<{ code: string; review_kind: string }>`select code, review_kind from ref.review_input_def where framework_version_id = ${version} order by sort_order`.execute(db.migrator)).rows;
    expect(kinds).toHaveLength(14);
    expect(kinds[0]).toEqual({ code: 'MR-01', review_kind: 'management' });
    expect(kinds.at(-1)).toEqual({ code: 'GB-01', review_kind: 'governing_body' });
    expect((await sql`select event_type from ref.audit_activity_template where framework_version_id = ${version}`.execute(db.migrator)).rows).toEqual([{ event_type: 'internal_audit' }]);
    expect((await sql`select derivation from ref.cycle_requirement_def where framework_version_id = ${version} order by sort_order limit 1`.execute(db.migrator)).rows).toEqual([{ derivation: { kind: 'bia_approved' } }]);
  });

  it('keeps the CHECK lists of ref 0002 (kind, review kind, one mapping source, internal audit templates)', async () => {
    const version = (await sql<{ id: string }>`select id from ref.framework_version where pack_id = 'ISO22301-2019'`.execute(db.migrator)).rows[0]!.id;
    await expectPgError(
      rolledBack(db.packInstaller, {}, (trx) => sql`insert into ref.documented_info (framework_version_id, code, requirement_code, kind, title) values (${version}, 'X', '4.1', 'keep', 'x')`.execute(trx)),
      '23514',
    );
    await expectPgError(
      rolledBack(db.packInstaller, {}, (trx) => sql`update ref.review_input_def set review_kind = 'board' where framework_version_id = ${version}`.execute(trx)),
      '23514',
    );
    const requirement = (await sql<{ id: string }>`select id from ref.requirement where framework_version_id = ${version} limit 1`.execute(db.migrator)).rows[0]!.id;
    await expectPgError(
      rolledBack(db.packInstaller, {}, (trx) => sql`insert into ref.requirement_mapping (target_requirement_id, mapping_type) values (${requirement}, 'related')`.execute(trx)),
      '23514',
      /requirement_mapping_one_source/,
    );
    await expectPgError(
      rolledBack(db.packInstaller, {}, (trx) => sql`update ref.audit_activity_template set event_type = 'internal' where framework_version_id = ${version}`.execute(trx)),
      '23514',
    );
    await expectPgError(rolledBack(db.packInstaller, {}, (trx) => sql`delete from ref.documented_info`.execute(trx)), '42501');
  });

  it('checks the engine version against the release of the server (1.1.0-rc.1 reads 1.1.0 packs; an image tag is not compared)', () => {
    const bytes = devPack('ISO27001-2022').bytes;
    expect(devPack('ISO27001-2022').manifest.engine_min_version).toBe('1.1.0');
    const installer = (serverVersion: string) =>
      new PackInstaller({ installerDb: db.packInstaller, audit: new ChainedAuditWriter(new TenantScope(db.packInstaller)), trust: compiledTrustAnchors(), serverVersion });
    for (const accepted of ['1.1.0', '1.1.0-rc.1', '1.2.0', 'smoke', VERSION]) expect(installer(accepted).verify(bytes).manifest.pack_id).toBe('ISO27001-2022');
    for (const refused of ['1.0.0', '1.0.9-rc.2']) {
      let caught: unknown;
      try {
        installer(refused).verify(bytes);
      } catch (error) {
        caught = error;
      }
      expect(caught, refused).toMatchObject({ code: 'engine_version', status: 422 });
    }
  });
});

describe('mapping rows whose target pack is not installed yet (Milestone 2 E.1)', () => {
  const db = useTestDatabase('empty');

  const mappings = (rows: CsvRow[]) => (s: MutableSource) =>
    setCsv(s, 'mappings/ISO22301-2019.csv', ['source_code', 'target_pack_id', 'target_code', 'mapping_type', 'evidence_reusable', 'note'], rows);
  const ROWS: CsvRow[] = [
    { source_code: '4.1', target_pack_id: 'ISO22301-2019', target_code: '4.1', mapping_type: 'equivalent', evidence_reusable: 'true', note: '' },
    { source_code: 'A.5.29', target_pack_id: 'ISO22301-2019', target_code: '8.4', mapping_type: 'related', evidence_reusable: 'false', note: 'Continuity during disruption' },
    { source_code: '9.2', target_pack_id: 'ISO22301-2019', target_code: '99.9', mapping_type: 'related', evidence_reusable: 'false', note: '' },
  ];
  const mappingRows = () =>
    sql<{ source: string; kind: string; target: string; mapping_type: string; evidence_reusable: boolean; note: string | null }>`
      select coalesce(r.requirement_code, c.item_code) as source, case when m.source_requirement_id is null then 'catalogue_item' else 'requirement' end as kind,
             t.requirement_code as target, m.mapping_type, m.evidence_reusable, m.note
        from ref.requirement_mapping m
        left join ref.requirement r on r.id = m.source_requirement_id left join ref.catalogue_item c on c.id = m.source_catalogue_item_id
        join ref.requirement t on t.id = m.target_requirement_id order by source`.execute(db.migrator);

  it('keeps the skipped rows in the audit entry and writes them when the target pack is installed', async () => {
    const source = changedPack('ISO27001-2022', mappings(ROWS));
    const first = await testInstaller(db.packInstaller).install(source.bytes, { actor: OPERATOR });
    expect(first).toMatchObject({ status: 'installed', skippedMappings: 3, mappingsRetried: 0 });
    expect((await mappingRows()).rows).toEqual([]);
    const entry = (await auditActions(db, 'pack.installed')).at(-1)!;
    expect(entry.after_data).toMatchObject({ skipped_mappings: [expect.objectContaining({ source_code: '4.1' }), expect.objectContaining({ source_code: 'A.5.29' }), expect.objectContaining({ source_code: '9.2' })] });

    const target = await testInstaller(db.packInstaller).install(devPack('ISO22301-2019').bytes, { actor: OPERATOR });
    expect(target).toMatchObject({ status: 'installed', mappingsRetried: 2 });
    expect((await auditActions(db, 'pack.installed')).at(-1)!.after_data).toMatchObject({ mappings_retried: 2 });
    const written = [
      { source: '4.1', kind: 'requirement', target: '4.1', mapping_type: 'equivalent', evidence_reusable: true, note: null },
      { source: 'A.5.29', kind: 'catalogue_item', target: '8.4', mapping_type: 'related', evidence_reusable: false, note: 'Continuity during disruption' },
    ];
    expect((await mappingRows()).rows).toEqual(written);

    // A newer target version retries again without writing a row twice; the row that never resolves stays out.
    const newer = changedPack('ISO22301-2019', (s) => {
      s.manifest.pack_version = '1.1.1';
    });
    expect(await testInstaller(db.packInstaller).install(newer.bytes, { actor: OPERATOR })).toMatchObject({ status: 'installed', mappingsRetried: 2 });
    expect((await mappingRows()).rows).toEqual(written);
  });

  it('writes catalogue item sources directly when the target pack is installed', async () => {
    const update = changedPack('ISO27001-2022', (s) => {
      s.manifest.pack_version = '1.3.1';
      mappings([{ source_code: 'A.5.30', target_pack_id: 'ISO22301-2019', target_code: '8.4', mapping_type: 'partial', evidence_reusable: 'true', note: '' }])(s);
    });
    expect(await testInstaller(db.packInstaller).install(update.bytes, { actor: OPERATOR })).toMatchObject({ status: 'installed', skippedMappings: 0, mappingsRetried: 0 });
    expect((await mappingRows()).rows.map((r) => [r.source, r.kind, r.target])).toEqual([
      ['4.1', 'requirement', '4.1'],
      ['A.5.29', 'catalogue_item', '8.4'],
      ['A.5.30', 'catalogue_item', '8.4'],
    ]);
  });
});
