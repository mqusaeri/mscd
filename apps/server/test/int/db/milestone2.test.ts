// The schema of Milestone 2 (docs/platform/MILESTONE-2.md D.3, J.7): tenant migration 0008 and platform migration 0005,
// written by M2-02. The CHECK lists, the one-open-cycle index, the committed-import index, nullable readiness,
// competence records shared through entity_ms_link, RLS of the new tables, the append-only status history, verified
// domains (one organisation per verified domain; the migration stops on duplicates), per-organisation entitlements,
// and the platform scope that writes domains, entitlements, status history and the organisation status.
import { cp, mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { sql, type Kysely, type Transaction } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { migrateAll } from '../../../src/cli/migrate';
import { MIGRATIONS_ROOT } from '../../../src/db/migrator';
import type { CreatedTenant } from '../../../src/db/tenant-provisioner';
import type { DB } from '../../../src/db/types';
import { createTenant } from '../../setup/global-db';
import { useTestDatabase } from '../../setup/test-db';
import {
  addFramework, addManagementSystem, addUser, connect, createBareDatabase, expectPgError, inScope, rolledBack, type BareDatabase,
  type FrameworkFixture,
} from './helpers';

describe('Milestone 2 tenant schema (tenant 0008)', () => {
  const db = useTestDatabase('empty');
  let tenant: CreatedTenant;
  let fw: FrameworkFixture;
  let msId: string;
  let otherMsId: string;
  let member: string;

  beforeAll(async () => {
    tenant = await createTenant(db, 'mtwo');
    fw = await addFramework(db.migrator);
    msId = await addManagementSystem(db.migrator, tenant, fw.versionId, 'isms');
    otherMsId = await addManagementSystem(db.migrator, tenant, fw.versionId, 'qms');
    member = await addUser(db.migrator, 'm2.member', [tenant.id]);
  });

  const scope = () => ({ orgId: tenant.id, schema: tenant.schemaName, userId: member });

  it('allows one open certification cycle per system, next to a certified one (D.3, D.4)', async () => {
    const cycle = (status: string, ms = msId) =>
      sql`insert into certification_cycle (management_system_id, cycle_start, cycle_end, status) values (${ms}, '2026-01-01', '2028-12-31', ${status})`;
    await rolledBack(db.app, scope(), async (trx) => {
      await cycle('certified').execute(trx);
      await cycle('active').execute(trx);
      await cycle('planned', otherMsId).execute(trx);
      await cycle('closed').execute(trx);
      const { rows } = await sql<{ n: number }>`select count(*)::int as n from certification_cycle where management_system_id = ${msId}`.execute(trx);
      expect(rows[0]!.n).toBe(3);
    });
    for (const second of ['planned', 'active']) {
      await expectPgError(
        rolledBack(db.app, scope(), async (trx) => {
          await cycle('active').execute(trx);
          await cycle(second).execute(trx);
        }),
        '23505',
        /certification_cycle_open_uq/,
      );
    }
    // A soft-deleted open cycle does not count.
    await rolledBack(db.app, scope(), async (trx) => {
      await sql`insert into certification_cycle (management_system_id, cycle_start, cycle_end, status, deleted_at)
        values (${msId}, '2026-01-01', '2028-12-31', 'active', now())`.execute(trx);
      await cycle('active').execute(trx);
    });
    await rolledBack(db.app, scope(), async (trx) => {
      await sql`insert into certification_cycle (management_system_id, cycle_start, cycle_end, status, certificate_no, certified_at,
        certificate_expires_at, certification_body, certified_scope) values (${msId}, '2025-03-14', '2028-03-13', 'certified', 'ISMS-1', '2025-03-14',
        '2028-03-13', 'PT Sertifikasi Nusantara', 'Data centre operations')`.execute(trx);
    });
  });

  it('accepts internal audits with scope and report, and keeps the other event types (J.7)', async () => {
    const event = (type: string) => sql`insert into audit_event (management_system_id, event_type, name_en, name_id, short_label, scheduled_at, scope_text)
      values (${msId}, ${type}, 'Internal audit', 'Audit internal', 'IA', '2026-12-08', 'Clauses 4 to 10') returning id`;
    await rolledBack(db.app, scope(), async (trx) => {
      for (const type of ['stage1', 'stage2', 'surveillance', 'recertification', 'transition', 'special', 'internal_audit']) await event(type).execute(trx);
    });
    await expectPgError(rolledBack(db.app, scope(), (trx) => event('mock_audit').execute(trx)), '23514', /audit_event_event_type_check/);
  });

  it('stores readiness as null until computed, with four dimensions of 0 to 100 (D.6)', async () => {
    await rolledBack(db.app, scope(), async (trx) => {
      await sql`insert into clause_readiness (management_system_id, clause_group, readiness_pct, source) values (${msId}, 4, null, 'computed')`.execute(trx);
      await sql`insert into clause_readiness (management_system_id, clause_group, readiness_pct, documented_pct, implemented_pct, evidenced_pct, measured_pct,
        computed_at, source) values (${msId}, 5, 60, 50, 70, 60, null, now(), 'computed')`.execute(trx);
    });
    await expectPgError(
      rolledBack(db.app, scope(), (trx) =>
        sql`insert into clause_readiness (management_system_id, clause_group, readiness_pct, documented_pct) values (${msId}, 6, 50, 101)`.execute(trx)),
      '23514',
    );
  });

  it('records document origin (internal by default) and version change summaries (J.7)', async () => {
    await rolledBack(db.app, scope(), async (trx) => {
      const doc = await trx.insertInto('document').values({ doc_code: 'EXT-01', title: 'Supplier SLA', doc_type: 'record' }).returning(['id', 'origin']).executeTakeFirstOrThrow();
      expect(doc.origin).toBe('internal');
      await trx.updateTable('document').set({ origin: 'external', external_source: 'Supplier', external_ref: 'SLA-2026', received_at: '2026-10-01' }).where('id', '=', doc.id).execute();
    });
    await expectPgError(
      rolledBack(db.app, scope(), (trx) => sql`insert into document (doc_code, title, doc_type, origin) values ('EXT-02', 'x', 'record', 'supplier')`.execute(trx)),
      '23514',
    );
  });

  it('checks quality objective status and competence proof types, and links competence records to systems (J.7)', async () => {
    await rolledBack(db.app, scope(), async (trx) => {
      for (const status of ['planned', 'on_track', 'at_risk', 'achieved', 'missed', null]) {
        await sql`insert into quality_objective (management_system_id, code, title, status) values (${msId}, ${`QO-${status ?? 'none'}`}, 'Objective', ${status})`.execute(trx);
      }
      const record = await trx
        .insertInto('competence_record')
        .values({ user_id: member, role_title: 'Internal auditor', competence_required: 'ISO 19011 training', proof_type: 'certificate', owner_user_id: member })
        .returning('id')
        .executeTakeFirstOrThrow();
      await trx.insertInto('entity_ms_link').values({ entity_type: 'competence_record', entity_id: record.id, management_system_id: msId, is_primary: true }).execute();
    });
    await expectPgError(
      rolledBack(db.app, scope(), (trx) => sql`insert into quality_objective (management_system_id, code, title, status) values (${msId}, 'QO-X', 'x', 'done')`.execute(trx)),
      '23514',
    );
    await expectPgError(
      rolledBack(db.app, scope(), (trx) =>
        sql`insert into competence_record (user_id, role_title, competence_required, proof_type) values (${member}, 'x', 'y', 'diploma')`.execute(trx)),
      '23514',
    );
  });

  it('commits one file once per system and kind, and links one pack code to one document per system (D.3)', async () => {
    const run = (status: string, sha = 'a'.repeat(64)) => sql`insert into import_run (management_system_id, kind, file_name, file_sha256, status, committed_at)
      values (${msId}, 'risks', 'risks.xlsx', ${sha}, ${status}, ${status === 'committed' ? sql`now()` : null})`;
    await rolledBack(db.app, scope(), async (trx) => {
      await run('validated').execute(trx);
      await run('validated').execute(trx);
      await run('committed').execute(trx);
      await run('committed', 'b'.repeat(64)).execute(trx);
    });
    await expectPgError(
      rolledBack(db.app, scope(), async (trx) => {
        await run('committed').execute(trx);
        await run('committed').execute(trx);
      }),
      '23505',
      /import_run_committed_uq/,
    );
    await expectPgError(rolledBack(db.app, scope(), (trx) => run('committed', 'not-a-digest').execute(trx)), '23514');
    await expectPgError(
      rolledBack(db.app, scope(), (trx) => sql`insert into import_run (management_system_id, kind, file_name, file_sha256, status)
        values (${msId}, 'users', 'u.csv', ${'c'.repeat(64)}, 'validated')`.execute(trx)),
      '23514',
    );
    await expectPgError(
      rolledBack(db.app, scope(), async (trx) => {
        const doc = await trx.insertInto('document').values({ doc_code: 'ISP-001', title: 'Policy', doc_type: 'policy' }).returning('id').executeTakeFirstOrThrow();
        await trx.insertInto('document_code_link').values({ management_system_id: msId, pack_code: 'POL-01', document_id: doc.id }).execute();
        await trx.insertInto('document_code_link').values({ management_system_id: otherMsId, pack_code: 'POL-01', document_id: doc.id }).execute();
        await trx.insertInto('document_code_link').values({ management_system_id: msId, pack_code: 'POL-01', document_id: doc.id }).execute();
      }),
      '23505',
      /document_code_link_uq/,
    );
  });

  it('secures the new tenant tables with forced row-level security (C.4)', async () => {
    const { rows } = await sql<{ relname: string; rls: boolean; forced: boolean; policies: number }>`
      select c.relname, c.relrowsecurity as rls, c.relforcerowsecurity as forced, (select count(*)::int from pg_policy p where p.polrelid = c.oid) as policies
      from pg_class c join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = ${tenant.schemaName} and c.relname in ('document_code_link', 'competence_record', 'import_run') order by c.relname`.execute(db.migrator);
    expect(rows).toEqual([
      { relname: 'competence_record', rls: true, forced: true, policies: 1 },
      { relname: 'document_code_link', rls: true, forced: true, policies: 1 },
      { relname: 'import_run', rls: true, forced: true, policies: 1 },
    ]);
  });
});

describe('Milestone 2 platform schema (platform 0005)', () => {
  const db = useTestDatabase('empty');
  let alpha: CreatedTenant;
  let beta: CreatedTenant;
  let operator: string;

  beforeAll(async () => {
    alpha = await createTenant(db, 'saas_alpha');
    beta = await createTenant(db, 'saas_beta');
    operator = await addUser(db.migrator, 'ops.owner', []);
  });

  it('keeps an append-only status history with a reason (J.8)', async () => {
    const id = await inScope(db.app, { platformScope: true, userId: operator }, async (trx) =>
      (await trx.insertInto('platform.organization_status_event')
        .values({ organization_id: alpha.id, from_status: 'active', to_status: 'suspended', reason: 'Invoice overdue', actor_user_id: operator })
        .returning('id').executeTakeFirstOrThrow()).id,
    );
    await expectPgError(
      inScope(db.app, { platformScope: true }, (trx) => trx.updateTable('platform.organization_status_event').set({ reason: 'changed' }).where('id', '=', id).execute()),
      '42501',
    );
    await expectPgError(
      inScope(db.migrator, { platformScope: true }, (trx) => trx.deleteFrom('platform.organization_status_event').where('id', '=', id).execute()),
      '42501',
      /append-only/,
    );
    for (const [from, to, reason] of [['active', 'active', 'Same'], ['active', 'deleted', 'Unknown'], ['active', 'suspended', '  ']] as const) {
      await expectPgError(
        rolledBack(db.migrator, { platformScope: true }, (trx) => sql`insert into platform.organization_status_event (organization_id, from_status, to_status, reason)
          values (${alpha.id}, ${from}, ${to}, ${reason})`.execute(trx)),
        '23514',
      );
    }
  });

  it('lets one organisation only hold a verified domain, and keeps pending claims apart (D.3)', async () => {
    await inScope(db.migrator, { platformScope: true }, (trx) =>
      trx.insertInto('platform.verified_domain').values({ organization_id: alpha.id, domain: 'alpha.co.id', verified_by: 'operator' }).execute(),
    );
    const row = await inScope(db.migrator, { platformScope: true }, (trx) =>
      trx.selectFrom('platform.verified_domain').selectAll().where('domain', '=', 'alpha.co.id').executeTakeFirstOrThrow(),
    );
    expect(row).toMatchObject({ status: 'verified', method: 'manual', verified_by: 'operator', txt_token_hash: null });
    expect(row.verified_at).toBeInstanceOf(Date);
    // A pending claim of the same domain by another organisation is allowed; verifying it is not.
    await inScope(db.migrator, { platformScope: true }, (trx) =>
      trx.insertInto('platform.verified_domain').values({
        organization_id: beta.id, domain: 'alpha.co.id', status: 'pending', method: 'dns', verified_at: null, verified_by: null,
        txt_token_hash: Buffer.alloc(32, 1), requested_at: new Date(),
      }).execute(),
    );
    await expectPgError(
      inScope(db.migrator, { platformScope: true }, (trx) =>
        trx.updateTable('platform.verified_domain').set({ status: 'verified', verified_at: new Date() })
          .where('organization_id', '=', beta.id).where('domain', '=', 'alpha.co.id').execute()),
      '23505',
      /verified_domain_verified_uq/,
    );
    // A verified row needs its time; a DNS row needs its token hash.
    await expectPgError(
      rolledBack(db.migrator, { platformScope: true }, (trx) =>
        trx.insertInto('platform.verified_domain').values({ organization_id: beta.id, domain: 'beta.co.id', verified_at: null, verified_by: null }).execute()),
      '23514',
      /verified_domain_verified_check/,
    );
    await expectPgError(
      rolledBack(db.migrator, { platformScope: true }, (trx) =>
        trx.insertInto('platform.verified_domain').values({ organization_id: beta.id, domain: 'beta.co.id', status: 'pending', method: 'dns', verified_at: null }).execute()),
      '23514',
      /verified_domain_dns_check/,
    );
  });

  it('stores one entitlement per organisation, readable by its own organisation only (D.3, F.10)', async () => {
    await inScope(db.app, { platformScope: true, userId: operator }, (trx) =>
      trx.insertInto('platform.entitlement').values([
        { organization_id: alpha.id, plan: 'standard', source: 'preset', max_users: 50, max_management_systems: 3, valid_from: '2026-10-01', valid_until: '2027-09-30' },
        { organization_id: beta.id, plan: null, source: 'signed_licence', max_users: 10, max_management_systems: 1, valid_from: '2026-10-01', valid_until: null },
      ]).execute(),
    );
    const seen = await inScope(db.app, { orgId: alpha.id }, (trx) => trx.selectFrom('platform.entitlement').select(['organization_id', 'storage_adapters', 'grace_days', 'version']).execute());
    expect(seen).toEqual([{ organization_id: alpha.id, storage_adapters: ['managed_vault'], grace_days: 30, version: 1 }]);
    const updated = await rolledBack(db.app, { orgId: alpha.id }, (trx) =>
      trx.updateTable('platform.entitlement').set({ max_users: 999 }).where('organization_id', '=', beta.id).executeTakeFirst(),
    );
    expect(Number(updated.numUpdatedRows)).toBe(0);
    await expectPgError(
      rolledBack(db.app, { orgId: alpha.id }, (trx) => trx.deleteFrom('platform.entitlement').where('organization_id', '=', alpha.id).execute()),
      '42501',
    );
    for (const bad of [{ source: 'invoice' }, { max_users: -1 }, { valid_until: '2026-01-01' }]) {
      await expectPgError(
        rolledBack(db.migrator, { platformScope: true }, async (trx) => {
          await trx.deleteFrom('platform.entitlement').where('organization_id', '=', alpha.id).execute();
          await trx.insertInto('platform.entitlement').values({
            organization_id: alpha.id, plan: 'x', source: 'preset', max_users: 5, max_management_systems: 1, valid_from: '2026-10-01', valid_until: null,
            ...(bad as object),
          } as never).execute();
        }),
        '23514',
      );
    }
  });

  it('lets only the platform scope write domains, entitlements and status history; the organisation reads its own (F.10)', async () => {
    const own = { orgId: beta.id, userId: operator };
    await inScope(db.app, { platformScope: true, userId: operator }, async (trx) => {
      await trx.insertInto('platform.verified_domain').values({ organization_id: beta.id, domain: 'beta-own.co.id', verified_by: 'operator' }).execute();
      await trx.updateTable('platform.verified_domain').set({ last_checked_at: new Date() }).where('domain', '=', 'beta-own.co.id').execute();
      await trx.insertInto('platform.organization_status_event')
        .values({ organization_id: beta.id, from_status: 'active', to_status: 'suspended', reason: 'Owner request', actor_user_id: operator }).execute();
    });
    const read = await inScope(db.app, own, async (trx) => ({
      domains: await trx.selectFrom('platform.verified_domain').select(['organization_id', 'domain']).execute(),
      events: (await trx.selectFrom('platform.organization_status_event').select('organization_id').execute()).map((r) => r.organization_id),
      entitlements: (await trx.selectFrom('platform.entitlement').select('organization_id').execute()).map((r) => r.organization_id),
    }));
    expect(read.domains.map((r) => r.domain)).toContain('beta-own.co.id');
    expect(new Set(read.domains.map((r) => r.organization_id))).toEqual(new Set([beta.id]));
    expect({ events: read.events, entitlements: read.entitlements }).toEqual({ events: [beta.id], entitlements: [beta.id] });
    // Writes of the organisation's own rows without the platform scope: inserts fail, updates and deletes see no row.
    const inserts: ((trx: Transaction<DB>) => Promise<unknown>)[] = [
      (trx) => trx.insertInto('platform.verified_domain').values({ organization_id: beta.id, domain: 'beta-jit.co.id', verified_by: 'self' }).execute(),
      (trx) => trx.insertInto('platform.organization_status_event').values({ organization_id: beta.id, from_status: 'suspended', to_status: 'active', reason: 'Self' }).execute(),
      (trx) =>
        trx.insertInto('platform.entitlement')
          .values({ organization_id: beta.id, plan: 'x', source: 'manual', max_users: 1, max_management_systems: 1, valid_from: '2026-10-01' })
          .onConflict((oc) => oc.column('organization_id').doUpdateSet({ max_users: 9999 })).execute(),
    ];
    for (const insert of inserts) await expectPgError(rolledBack(db.app, own, insert), '42501', /row-level security/);
    const changed = await rolledBack(db.app, own, async (trx) => [
      Number((await trx.updateTable('platform.verified_domain').set({ last_checked_at: new Date() }).where('organization_id', '=', beta.id).executeTakeFirst()).numUpdatedRows),
      Number((await trx.deleteFrom('platform.verified_domain').where('organization_id', '=', beta.id).executeTakeFirst()).numDeletedRows),
      Number((await trx.updateTable('platform.entitlement').set({ max_users: 9999 }).where('organization_id', '=', beta.id).executeTakeFirst()).numUpdatedRows),
    ]);
    expect(changed).toEqual([0, 0, 0]);
  });

  it('lets the app role change the status of an organisation in platform scope only (J.8)', async () => {
    await expectPgError(
      rolledBack(db.app, { orgId: alpha.id, userId: operator }, (trx) => trx.updateTable('platform.organization').set({ status: 'suspended' }).where('id', '=', alpha.id).execute()),
      '42501',
      /needs the platform scope/,
    );
    // Other organisation settings and an unchanged status stay writable for the organisation.
    await rolledBack(db.app, { orgId: alpha.id, userId: operator }, (trx) =>
      trx.updateTable('platform.organization').set({ name: 'Alpha renamed', status: 'active' }).where('id', '=', alpha.id).execute(),
    );
    const moved = await rolledBack(db.app, { platformScope: true, userId: operator }, async (trx) => {
      await trx.updateTable('platform.organization').set({ status: 'suspended' }).where('id', '=', alpha.id).execute();
      return (await trx.selectFrom('platform.organization').select('status').where('id', '=', alpha.id).executeTakeFirstOrThrow()).status;
    });
    expect(moved).toBe('suspended');
    // The owner of the table (the migrator: operator commands, maintenance) is not limited.
    await rolledBack(db.migrator, {}, (trx) => trx.updateTable('platform.organization').set({ status: 'suspended' }).where('id', '=', alpha.id).execute());
  });
});

describe('platform 0005 on a database with a domain verified for two organisations', () => {
  let bare: BareDatabase;
  let migrator: Kysely<DB>;
  let tmp: string;

  beforeAll(async () => {
    bare = await createBareDatabase();
    migrator = connect(bare.urls.migrator, 'mscd-test-m2');
    tmp = await mkdtemp(path.join(os.tmpdir(), 'mscd-m2-migrations-'));
    await cp(MIGRATIONS_ROOT, tmp, { recursive: true });
    await rm(path.join(tmp, 'platform', '0005_milestone2_saas.sql'));
    await migrateAll({ connectionString: bare.urls.migrator, migrationsRoot: tmp });
  });

  afterAll(async () => {
    await migrator?.destroy();
    await bare?.drop();
    if (tmp) await rm(tmp, { recursive: true, force: true });
  });

  it('stops and names the duplicates, then applies once they are removed (D.3)', async () => {
    const orgs = await inScope(migrator, { platformScope: true }, async (trx) => {
      const ids: string[] = [];
      for (const slug of ['dup_a', 'dup_b']) {
        ids.push((await trx.insertInto('platform.organization').values({ slug, name: slug, schema_name: `org_${slug}` }).returning('id').executeTakeFirstOrThrow()).id);
      }
      for (const id of ids) await trx.insertInto('platform.verified_domain').values({ organization_id: id, domain: 'shared.co.id', verified_by: 'operator' }).execute();
      return ids;
    });
    await expect(migrateAll({ connectionString: bare.urls.migrator })).rejects.toThrow(/shared\.co\.id \(2 organisations\)/);
    const applied = await sql<{ name: string }>`select name from platform.kysely_migration order by name`.execute(migrator);
    expect(applied.rows.map((r) => r.name)).not.toContain('0005_milestone2_saas');
    await inScope(migrator, { platformScope: true }, (trx) => trx.deleteFrom('platform.verified_domain').where('organization_id', '=', orgs[1]!).execute());
    await migrateAll({ connectionString: bare.urls.migrator });
    const after = await sql<{ name: string }>`select name from platform.kysely_migration order by name`.execute(migrator);
    expect(after.rows.map((r) => r.name)).toContain('0005_milestone2_saas');
  });
});
