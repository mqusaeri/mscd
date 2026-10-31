// The schema of Milestone 3 (docs/platform/MILESTONE-3.md D.3, J.7): tenant migration 0009 and platform migration 0007,
// written by M3-01. The CHECK lists and partial unique indexes of the new tenant tables, the person columns that carry
// no member check (`erased_person.erased_user_id`), forced row-level security of every new table, the new columns of
// existing tables, and on the platform side the organisation status `deleted`, the export and deletion records with
// their one-at-a-time indexes, their status changes in platform scope only, and the redaction columns of the audit log.
import { sql, type Transaction } from 'kysely';
import { beforeAll, describe, expect, it } from 'vitest';
import type { CreatedTenant } from '../../../src/db/tenant-provisioner';
import type { DB } from '../../../src/db/types';
import { createTenant } from '../../setup/global-db';
import { useTestDatabase } from '../../setup/test-db';
import { addFramework, addManagementSystem, addUser, expectPgError, inScope, rolledBack, type FrameworkFixture } from './helpers';

const M3_TENANT_TABLES = [
  'access_review', 'access_review_item', 'access_review_part', 'access_review_setting', 'acknowledgement', 'acknowledgement_request',
  'erased_person', 'privacy_check', 'privacy_request', 'retention_hold', 'retention_review', 'retention_rule',
];

describe('Milestone 3 tenant schema (tenant 0009)', () => {
  const db = useTestDatabase('empty');
  let tenant: CreatedTenant;
  let fw: FrameworkFixture;
  let msId: string;
  let otherMsId: string;
  let member: string;
  let stranger: string;

  beforeAll(async () => {
    tenant = await createTenant(db, 'mthree');
    fw = await addFramework(db.migrator);
    msId = await addManagementSystem(db.migrator, tenant, fw.versionId, 'isms');
    otherMsId = await addManagementSystem(db.migrator, tenant, fw.versionId, 'qms');
    member = await addUser(db.migrator, 'm3.member', [tenant.id]);
    stranger = await addUser(db.migrator, 'm3.stranger', []);
  });

  const scope = () => ({ orgId: tenant.id, schema: tenant.schemaName, userId: member });
  const request = (trx: Transaction<DB>, no = 'PR-2026-001') =>
    sql<{ id: string }>`insert into privacy_request (request_no, request_type, subject_kind, subject_name, channel, received_at, due_at)
      values (${no}, 'access', 'other', 'Visitor', 'email', '2026-10-01T08:00:00Z', '2026-10-04T08:00:00Z') returning id`.execute(trx).then((r) => r.rows[0]!.id);

  it('secures every new table with forced row-level security and one policy (C.4)', async () => {
    const { rows } = await sql<{ relname: string; rls: boolean; forced: boolean; policies: number }>`
      select c.relname, c.relrowsecurity as rls, c.relforcerowsecurity as forced, (select count(*)::int from pg_policy p where p.polrelid = c.oid) as policies
      from pg_class c join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = ${tenant.schemaName} and c.relkind = 'r' and c.relname = any(${M3_TENANT_TABLES}) order by c.relname`.execute(db.migrator);
    expect(rows).toEqual(M3_TENANT_TABLES.map((relname) => ({ relname, rls: true, forced: true, policies: 1 })));
  });

  it('checks requests from one person: number, subject, due time, closing and one check per system (J.7)', async () => {
    await rolledBack(db.app, scope(), async (trx) => {
      const id = await request(trx);
      await sql`insert into privacy_check (privacy_request_id, management_system_id) values (${id}, ${msId}), (${id}, ${otherMsId})`.execute(trx);
      const { rows } = await sql<{ n: number }>`select count(*)::int as n from privacy_check where privacy_request_id = ${id}`.execute(trx);
      expect(rows[0]!.n).toBe(2);
    });
    const bad = [
      sql`insert into privacy_request (request_no, request_type, subject_kind, subject_name, channel, received_at, due_at) values ('PR-26-1', 'access', 'other', 'V', 'email', now(), now())`,
      sql`insert into privacy_request (request_no, request_type, subject_kind, subject_name, channel, received_at, due_at) values ('PR-2026-002', 'portability', 'other', 'V', 'email', now(), now())`,
      sql`insert into privacy_request (request_no, request_type, subject_kind, channel, received_at, due_at) values ('PR-2026-003', 'erasure', 'member', 'email', now(), now())`,
      sql`insert into privacy_request (request_no, request_type, subject_kind, channel, received_at, due_at) values ('PR-2026-004', 'erasure', 'other', 'email', now(), now())`,
      sql`insert into privacy_request (request_no, request_type, subject_kind, subject_name, channel, received_at, due_at) values ('PR-2026-005', 'access', 'other', 'V', 'email', now(), now() - interval '1 hour')`,
      sql`insert into privacy_request (request_no, request_type, status, subject_kind, subject_name, channel, received_at, due_at) values ('PR-2026-006', 'access', 'completed', 'other', 'V', 'email', now(), now())`,
    ];
    for (const query of bad) await expectPgError(rolledBack(db.app, scope(), (trx) => query.execute(trx)), '23514');
    await expectPgError(
      rolledBack(db.app, scope(), async (trx) => {
        const id = await request(trx);
        await sql`insert into privacy_check (privacy_request_id, management_system_id) values (${id}, ${msId}), (${id}, ${msId})`.execute(trx);
      }),
      '23505',
      /privacy_check_uq/,
    );
    await expectPgError(rolledBack(db.app, scope(), async (trx) => (await request(trx), await request(trx))), '23505', /privacy_request_no_uq/);
  });

  it('keeps an erased person without a member check, with a pseudonym nobody else has (D.6.5)', async () => {
    await rolledBack(db.app, scope(), async (trx) => {
      // The erased person is no longer a member: the row is written all the same.
      await sql`insert into erased_person (erased_user_id, pseudonym) values (${stranger}, 'Former user 3f9a')`.execute(trx);
    });
    const other = await addUser(db.migrator, 'm3.former', []);
    await expectPgError(
      rolledBack(db.app, scope(), (trx) => sql`insert into erased_person (erased_user_id, pseudonym) values (${stranger}, 'Former user 3f9a'), (${other}, 'Former user 3f9a')`.execute(trx)),
      '23505',
      /erased_person_pseudonym_uq/,
    );
  });

  it('checks read confirmation: document settings, one open request per version, one confirmation per person (J.7)', async () => {
    await rolledBack(db.app, scope(), async (trx) => {
      const doc = await trx.insertInto('document').values({ doc_code: 'ISP-001', title: 'Policy', doc_type: 'policy' }).returning(['id', 'acknowledgement_required', 'acknowledgement_scope', 'acknowledgement_due_days']).executeTakeFirstOrThrow();
      expect(doc).toMatchObject({ acknowledgement_required: false, acknowledgement_scope: 'system_roles', acknowledgement_due_days: 14 });
      const object = await trx.insertInto('storage_object').values({ storage_repository_id: tenant.vaultRepositoryId, external_item_id: `tenants/${tenant.id}/0b1c2d3e-4f5a-4b6c-8d7e-9f0a1b2c3d4e`, hash_source: 'computed' }).returning(['id', 'replaced_at', 'content_disposed_at']).executeTakeFirstOrThrow();
      expect(object).toMatchObject({ replaced_at: null, content_disposed_at: null });
      const version = await trx.insertInto('document_version').values({ document_id: doc.id, version_label: '1', storage_object_id: object.id, status: 'approved' }).returning('id').executeTakeFirstOrThrow();
      const ask = () => sql<{ id: string }>`insert into acknowledgement_request (management_system_id, document_id, document_version_id, audience_scope, audience_roles, due_on)
        values (${msId}, ${doc.id}, ${version.id}, 'roles', array['ms_manager'], '2026-10-15') returning id`.execute(trx).then((r) => r.rows[0]!.id);
      const open = await ask();
      await sql`insert into acknowledgement (acknowledgement_request_id, user_id, status) values (${open}, ${member}, 'pending')`.execute(trx);
      await sql`update acknowledgement_request set status = 'closed', closed_at = now() where id = ${open}`.execute(trx);
      // A closed request makes room for a new open one of the same version.
      await ask();
    });
    const docWith = (scopeName: string, roles: string, due = 14) =>
      sql`insert into document (doc_code, title, doc_type, acknowledgement_required, acknowledgement_scope, acknowledgement_roles, acknowledgement_due_days)
        values ('ISP-009', 'Policy', 'policy', true, ${scopeName}, ${sql.raw(roles)}, ${due})`;
    for (const query of [docWith('roles', 'null'), docWith('roles', "'{}'::text[]"), docWith('organisation', "array['ms_manager']"), docWith('roles', "array['external_auditor']"), docWith('everyone', 'null'), docWith('organisation', 'null', 91), docWith('organisation', 'null', 0)]) {
      await expectPgError(rolledBack(db.app, scope(), (trx) => query.execute(trx)), '23514');
    }
    await rolledBack(db.app, scope(), (trx) => docWith('roles', "array['domain_owner', 'top_management']").execute(trx));
  });

  it('checks retention: one rule per class and type, open reviews, a second approver, holds released with a reason (J.7)', async () => {
    const rule = (cls: string, docType: string | null) =>
      sql`insert into retention_rule (management_system_id, record_class, doc_type, retain_months, basis) values (${msId}, ${cls}, ${docType}, 36, 'ISO 9001 7.5.3')`;
    await rolledBack(db.app, scope(), async (trx) => {
      await rule('document_version', 'policy').execute(trx);
      await rule('document_version', 'procedure').execute(trx);
      await rule('finding', null).execute(trx);
    });
    await expectPgError(rolledBack(db.app, scope(), async (trx) => (await rule('finding', null).execute(trx), await rule('finding', null).execute(trx))), '23505', /retention_rule_uq/);
    for (const query of [rule('document_version', null), rule('finding', 'policy'), rule('evidence', null)]) {
      await expectPgError(rolledBack(db.app, scope(), (trx) => query.execute(trx)), '23514');
    }
    const review = (status: string, decision: string | null = null) =>
      sql`insert into retention_review (management_system_id, record_class, item_id, retention_ends_on, status, decision)
        values (${msId}, 'finding', '6c7d8e9f-0a1b-4c2d-9e3f-4a5b6c7d8e9f', '2026-01-01', ${status}, ${decision})`;
    // One open or waiting review per item; decided reviews of the same item stay beside it.
    await expectPgError(
      rolledBack(db.app, scope(), async (trx) => (await review('open').execute(trx), await review('awaiting_approval', 'dispose').execute(trx))),
      '23505',
      /retention_review_open_uq/,
    );
    await rolledBack(db.app, scope(), async (trx) => {
      await review('kept', 'keep').execute(trx);
      await review('open').execute(trx);
    });
    await expectPgError(
      rolledBack(db.app, scope(), (trx) => sql`insert into retention_review (management_system_id, record_class, item_id, retention_ends_on, status, decision, decided_by, approved_by)
        values (${msId}, 'finding', gen_random_uuid(), '2026-01-01', 'kept', 'keep', ${member}, ${member})`.execute(trx)),
      '23514',
    );
    await expectPgError(
      rolledBack(db.app, scope(), (trx) => sql`insert into retention_review (management_system_id, record_class, item_id, retention_ends_on, status, decision) values (${msId}, 'finding', gen_random_uuid(), '2026-01-01', 'awaiting_approval', 'keep')`.execute(trx)),
      '23514',
    );
    const hold = (released: boolean) =>
      sql`insert into retention_hold (management_system_id, record_class, item_id, reason, released_at, release_reason)
        values (${msId}, 'finding', '7d8e9f0a-1b2c-4d3e-8f4a-5b6c7d8e9f0a', 'Legal claim', ${released ? sql`now()` : sql`null`}, ${released ? null : 'x'})`;
    for (const query of [hold(true), hold(false)]) await expectPgError(rolledBack(db.app, scope(), (trx) => query.execute(trx)), '23514');
  });

  it('checks access reviews: settings, one open review, one part per system and one organisation part (J.7)', async () => {
    await rolledBack(db.app, scope(), async (trx) => {
      const settings = await sql<{ frequency_months: number; days_to_complete: number; version: number }>`insert into access_review_setting default values
        returning frequency_months, days_to_complete, version`.execute(trx);
      expect(settings.rows[0]).toEqual({ frequency_months: 3, days_to_complete: 14, version: 1 });
      const review = (no: string, status = 'open') =>
        sql<{ id: string }>`insert into access_review (review_no, status, opened_on, due_on, completed_at)
          values (${no}, ${status}, '2026-10-01', '2026-10-15', ${status === 'completed' ? sql`now()` : sql`null`}) returning id`.execute(trx).then((r) => r.rows[0]!.id);
      const id = await review('AR-2026-001');
      await review('AR-2025-004', 'completed');
      await sql`insert into access_review_part (access_review_id, management_system_id) values (${id}, ${msId}), (${id}, ${otherMsId}), (${id}, null)`.execute(trx);
    });
    for (const query of [sql`insert into access_review_setting (frequency_months) values (2)`, sql`insert into access_review_setting (days_to_complete) values (61)`]) {
      await expectPgError(rolledBack(db.app, scope(), (trx) => query.execute(trx)), '23514');
    }
    await expectPgError(
      rolledBack(db.app, scope(), (trx) => sql`insert into access_review (review_no, opened_on, due_on) values ('AR-2026-001', '2026-10-01', '2026-10-15'), ('AR-2026-002', '2026-10-01', '2026-10-15')`.execute(trx)),
      '23505',
      /access_review_open_uq/,
    );
    await expectPgError(
      rolledBack(db.app, scope(), async (trx) => {
        const { rows } = await sql<{ id: string }>`insert into access_review (review_no, opened_on, due_on) values ('AR-2026-003', '2026-10-01', '2026-10-15') returning id`.execute(trx);
        await sql`insert into access_review_part (access_review_id, management_system_id) values (${rows[0]!.id}, null), (${rows[0]!.id}, null)`.execute(trx);
      }),
      '23505',
      /access_review_part_uq/,
    );
    await expectPgError(
      rolledBack(db.app, scope(), (trx) => sql`insert into access_review (review_no, status, opened_on, due_on) values ('AR-2026-005', 'cancelled', '2026-10-01', '2026-10-15')`.execute(trx)),
      '23514',
    );
  });

  it('widens task sources and export kinds, and ties a personal data export to its person (J.7)', async () => {
    const { rows } = await sql<{ def: string }>`select pg_get_constraintdef(c.oid) as def from pg_constraint c join pg_class t on t.oid = c.conrelid
      join pg_namespace n on n.oid = t.relnamespace where n.nspname = ${tenant.schemaName} and t.relname = 'task' and c.conname = 'task_source_rule_check'`.execute(db.migrator);
    for (const source of ['acknowledgement', 'access_review', 'privacy_check']) expect(rows[0]!.def).toContain(`'${source}'`);
    const column = await sql<{ max: number }>`select character_maximum_length as max from information_schema.columns
      where table_schema = ${tenant.schemaName} and table_name = 'task' and column_name = 'source_rule'`.execute(db.migrator);
    expect(column.rows[0]!.max).toBe(20);
    const exportFile = (kind: string, format: string, subject: string | null) =>
      sql`insert into export_file (kind, format, expires_at, subject_user_id) values (${kind}, ${format}, now() + interval '1 day', ${subject})`;
    await rolledBack(db.app, scope(), (trx) => exportFile('personal_data', 'json', member).execute(trx));
    for (const query of [exportFile('personal_data', 'json', null), exportFile('soa', 'pdf', member), exportFile('soa', 'docx', null)]) {
      await expectPgError(rolledBack(db.app, scope(), (trx) => query.execute(trx)), '23514');
    }
  });

  it('adds the redaction columns of the tenant audit chain outside the update rights of the app (D.5.4)', async () => {
    const { rows } = await sql<{ column_name: string }>`select column_name from information_schema.columns where table_schema = ${tenant.schemaName}
      and table_name = 'audit_trail' and column_name in ('redacted_at', 'redaction_id') order by column_name`.execute(db.migrator);
    expect(rows.map((r) => r.column_name)).toEqual(['redacted_at', 'redaction_id']);
    const update = await sql<{ granted: boolean }>`select has_table_privilege('mscd_app', ${`${tenant.schemaName}.audit_trail`}, 'UPDATE') as granted`.execute(db.migrator);
    expect(update.rows[0]!.granted).toBe(false);
  });
});

describe('Milestone 3 platform schema (platform 0007)', () => {
  const db = useTestDatabase('empty');
  let alpha: CreatedTenant;
  let beta: CreatedTenant;
  let admin: string;

  beforeAll(async () => {
    alpha = await createTenant(db, 'm3_alpha');
    beta = await createTenant(db, 'm3_beta');
    admin = await addUser(db.migrator, 'm3.admin', [alpha.id]);
  });

  const own = () => ({ orgId: alpha.id, userId: admin });
  const platform = () => ({ platformScope: true, userId: admin });
  const exportRow = (orgId: string, status: string) =>
    sql<{ id: string }>`insert into platform.organization_export (organization_id, status, requested_via, requested_by) values (${orgId}, ${status}, 'tenant_admin', ${admin}) returning id`;

  it('knows the status deleted, the end of the read-only period and the erased accounts (J.7, D.5)', async () => {
    await rolledBack(db.migrator, { platformScope: true }, async (trx) => {
      await sql`update platform.organization set status = 'deleted', offboarding_ends_at = now() where id = ${alpha.id}`.execute(trx);
      await sql`insert into platform.organization_status_event (organization_id, from_status, to_status, reason) values (${alpha.id}, 'archived', 'deleted', 'Purged')`.execute(trx);
      await sql`update platform.app_user set erased_at = now() where id = ${admin}`.execute(trx);
    });
    // The end of the read-only period and the status change in platform scope only: org.lifecycle archives the
    // organisation when the end passes (D.5.1), so an organisation's own scope may not move it.
    await expectPgError(
      rolledBack(db.app, own(), (trx) => sql`update platform.organization set offboarding_ends_at = now() where id = ${alpha.id}`.execute(trx)),
      '42501',
      /needs the platform scope/,
    );
    await expectPgError(rolledBack(db.app, own(), (trx) => sql`update platform.organization set status = 'deleted' where id = ${alpha.id}`.execute(trx)), '42501', /needs the platform scope/);
    await rolledBack(db.app, platform(), (trx) => sql`update platform.organization set offboarding_ends_at = now() where id = ${alpha.id}`.execute(trx));
    // A write of an organisation setting that leaves the date as it is passes in the organisation's scope.
    await rolledBack(db.app, own(), (trx) => sql`update platform.organization set name = name, offboarding_ends_at = offboarding_ends_at where id = ${alpha.id}`.execute(trx));
  });

  it('keeps one running export per organisation, a manifest for every ready export, and moves status in platform scope only (D.4)', async () => {
    // A Tenant Admin requests an export in the organisation's scope; another organisation's row cannot be written.
    const id = await inScope(db.app, own(), async (trx) => (await exportRow(alpha.id, 'requested').execute(trx)).rows[0]!.id);
    await expectPgError(rolledBack(db.app, own(), (trx) => exportRow(beta.id, 'requested').execute(trx)), '42501', /row-level security/);
    await expectPgError(rolledBack(db.app, own(), (trx) => sql`update platform.organization_export set status = 'queued' where id = ${id}`.execute(trx)), '42501', /needs the platform scope/);
    await rolledBack(db.app, platform(), async (trx) => {
      await sql`update platform.organization_export set status = 'queued' where id = ${id}`.execute(trx);
      await expectPgError(exportRow(alpha.id, 'building').execute(trx), '23505', /organization_export_running_uq/);
    });
    await expectPgError(rolledBack(db.app, platform(), (trx) => exportRow(alpha.id, 'ready').execute(trx)), '23514');
    await expectPgError(
      rolledBack(db.app, platform(), (trx) => sql`insert into platform.organization_export (organization_id, status, requested_via) values (${alpha.id}, 'queued', 'customer')`.execute(trx)),
      '23514',
    );
    // Each organisation reads its own exports only.
    const seen = await rolledBack(db.app, { orgId: beta.id, userId: admin }, (trx) => sql<{ n: number }>`select count(*)::int as n from platform.organization_export`.execute(trx));
    expect(seen.rows[0]!.n).toBe(0);
  });

  it('keeps one deletion per organisation that is not cancelled, written in platform scope only (D.5)', async () => {
    const schedule = (orgId: string) =>
      sql<{ id: string }>`insert into platform.organization_deletion (organization_id, status, scheduled_for, reason) values (${orgId}, 'scheduled', now() + interval '30 days', 'Contract ended') returning id`;
    await expectPgError(rolledBack(db.app, own(), (trx) => schedule(alpha.id).execute(trx)), '42501', /row-level security/);
    const id = await inScope(db.app, platform(), async (trx) => (await schedule(alpha.id).execute(trx)).rows[0]!.id);
    await expectPgError(rolledBack(db.app, platform(), (trx) => schedule(alpha.id).execute(trx)), '23505', /organization_deletion_open_uq/);
    await rolledBack(db.app, platform(), async (trx) => {
      await sql`update platform.organization_deletion set status = 'cancelled' where id = ${id}`.execute(trx);
      await schedule(alpha.id).execute(trx);
    });
    for (const query of [
      sql`update platform.organization_deletion set status = 'completed', completed_at = now() where id = ${id}`,
      sql`update platform.organization_deletion set status = 'failed' where id = ${id}`,
    ]) {
      await expectPgError(rolledBack(db.app, platform(), (trx) => query.execute(trx)), '23514');
    }
    // The organisation reads its deletion record and changes nothing in it.
    const changed = await rolledBack(db.app, own(), async (trx) => [
      (await sql<{ n: number }>`select count(*)::int as n from platform.organization_deletion`.execute(trx)).rows[0]!.n,
      Number((await trx.updateTable('platform.organization_deletion').set({ reason: 'Changed' }).where('id', '=', id).executeTakeFirst()).numUpdatedRows),
    ]);
    expect(changed).toEqual([1, 0]);
  });

  it('adds redaction columns to the platform audit log, set together, and no update right for the app (D.5.4)', async () => {
    const privileges = await sql<{ update: boolean }>`select has_table_privilege('mscd_app', 'platform.audit_log', 'UPDATE') as update`.execute(db.migrator);
    expect(privileges.rows[0]).toEqual({ update: false });
    const columns = await sql<{ table_name: string; column_name: string }>`select table_name, column_name from information_schema.columns
      where table_schema = 'platform' and ((table_name = 'audit_log' and column_name in ('redacted_at', 'redaction_id')) or (table_name = 'app_user' and column_name = 'erased_at'))
      order by table_name, column_name`.execute(db.migrator);
    expect(columns.rows).toEqual([
      { table_name: 'app_user', column_name: 'erased_at' },
      { table_name: 'audit_log', column_name: 'redacted_at' },
      { table_name: 'audit_log', column_name: 'redaction_id' },
    ]);
    const { rows } = await sql<{ def: string }>`select pg_get_constraintdef(oid) as def from pg_constraint where conname = 'audit_log_redaction_check'`.execute(db.migrator);
    expect(rows[0]!.def).toMatch(/redacted_at IS NULL\) = \(redaction_id IS NULL/);
  });
});
