// The correction migrations of Milestone 3 (docs/platform/MILESTONE-3.md R-14), written by M3-12: platform 0009 gives
// mscd_app SELECT on each tenant schema's kysely_migration (and nothing on its lock or any write), through
// secure_tenant_schema for new and migrated schemas; tenant 0010 adds the nullable retention_review.retain_months with
// the range of retention_rule.retain_months.
import { sql } from 'kysely';
import { beforeAll, describe, expect, it } from 'vitest';
import type { CreatedTenant } from '../../../src/db/tenant-provisioner';
import { createTenant } from '../../setup/global-db';
import { useTestDatabase } from '../../setup/test-db';
import { addFramework, addManagementSystem, addUser, expectPgError, inScope, rolledBack } from './helpers';

describe('Milestone 3 correction migrations (platform 0009, tenant 0010)', () => {
  const db = useTestDatabase('empty');
  let tenant: CreatedTenant;
  let other: CreatedTenant;
  let msId: string;
  let member: string;

  const privileges = (schema: string, table: string) =>
    sql<{ privs: string[] }>`
      select array(select p from unnest(array['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE']) p
                   where has_table_privilege('mscd_app', format('%I.%I', ${schema}::text, ${table}::text), p)) as privs`
      .execute(db.migrator)
      .then((r) => r.rows[0]!.privs);

  beforeAll(async () => {
    tenant = await createTenant(db, 'mfix');
    other = await createTenant(db, 'mfix_other');
    const fw = await addFramework(db.migrator);
    msId = await addManagementSystem(db.migrator, tenant, fw.versionId, 'isms');
    member = await addUser(db.migrator, 'mfix.member', [tenant.id]);
  });

  it('records both migrations as applied', async () => {
    const platform = await sql<{ name: string }>`select name from platform.kysely_migration where name = '0009_milestone3_fix'`.execute(db.migrator);
    expect(platform.rows).toHaveLength(1);
    const tenantRows = await sql<{ name: string }>`select name from ${sql.id(tenant.schemaName, 'kysely_migration')} where name = '0010_milestone3_fix'`.execute(db.migrator);
    expect(tenantRows.rows).toHaveLength(1);
  });

  it('lets mscd_app read the migrations of a tenant schema, and nothing more of the Kysely tables', async () => {
    expect(await privileges(tenant.schemaName, 'kysely_migration')).toEqual(['SELECT']);
    expect(await privileges(tenant.schemaName, 'kysely_migration_lock')).toEqual([]);
    const names = await inScope(db.app, { orgId: tenant.id, schema: tenant.schemaName, userId: member }, (trx) =>
      sql<{ name: string }>`select name from kysely_migration order by name`.execute(trx).then((r) => r.rows.map((row) => row.name)),
    );
    expect(names).toContain('0009_milestone3');
    expect(names).toContain('0010_milestone3_fix');
    await expectPgError(
      rolledBack(db.app, { orgId: tenant.id, schema: tenant.schemaName, userId: member }, (trx) => sql`delete from kysely_migration`.execute(trx)),
      '42501',
    );
  });

  it('gives the right again whenever secure_tenant_schema runs (new schemas and the reapply of every migration)', async () => {
    await sql`revoke select on ${sql.id(other.schemaName, 'kysely_migration')} from mscd_app`.execute(db.migrator);
    expect(await privileges(other.schemaName, 'kysely_migration')).toEqual([]);
    await sql`select platform.secure_tenant_schema(${other.schemaName})`.execute(db.migrator);
    expect(await privileges(other.schemaName, 'kysely_migration')).toEqual(['SELECT']);
    expect(await privileges(other.schemaName, 'kysely_migration_lock')).toEqual([]);
  });

  it('adds retention_review.retain_months: nullable smallint, 1 to 1200 months', async () => {
    const { rows } = await sql<{ data_type: string; is_nullable: string }>`
      select data_type, is_nullable from information_schema.columns
      where table_schema = ${tenant.schemaName} and table_name = 'retention_review' and column_name = 'retain_months'`.execute(db.migrator);
    expect(rows).toEqual([{ data_type: 'smallint', is_nullable: 'YES' }]);
    const review = (months: number | null, itemCode: string) =>
      sql`insert into retention_review (management_system_id, record_class, item_id, item_code, retention_ends_on, status, retain_months)
          values (${msId}, 'finding', gen_random_uuid(), ${itemCode}, '2026-09-15', 'open', ${months})`;
    await rolledBack(db.app, { orgId: tenant.id, schema: tenant.schemaName, userId: member }, async (trx) => {
      await review(null, 'F-NULL').execute(trx);
      await review(1, 'F-ONE').execute(trx);
      await review(1200, 'F-MAX').execute(trx);
    });
    for (const months of [0, 1201]) {
      await expectPgError(rolledBack(db.app, { orgId: tenant.id, schema: tenant.schemaName, userId: member }, (trx) => review(months, `F-${months}`).execute(trx)), '23514');
    }
  });
});
