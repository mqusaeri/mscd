// The correction migration of the small follow-ups (docs/platform/MILESTONE-3.md R-14, J.7, M3-15): tenant 0012 widens
// the CHECK of retention_review.file_action with 'kept_in_use' (the only file of a disposed record was kept because
// another record uses it), keeps every value the earlier CHECK allowed, leaves one CHECK on the column, and gives a
// schema that already accepts the value the same result when it runs again.
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { sql } from 'kysely';
import { beforeAll, describe, expect, it } from 'vitest';
import type { CreatedTenant } from '../../../src/db/tenant-provisioner';
import { createTenant } from '../../setup/global-db';
import { useTestDatabase } from '../../setup/test-db';
import { addFramework, addManagementSystem, addUser, expectPgError, rolledBack } from './helpers';

const MIGRATION = path.resolve(__dirname, '../../../migrations/tenant/0012_milestone3_followups.sql');

describe('Milestone 3 correction migration of the follow-ups (tenant 0012)', () => {
  const db = useTestDatabase('empty');
  let tenant: CreatedTenant;
  let msId: string;
  let member: string;

  /** The CHECK constraints of retention_review that name file_action, with their definitions. */
  const fileActionChecks = (schema: string) =>
    sql<{ name: string; def: string }>`
      select con.conname as name, pg_get_constraintdef(con.oid) as def
        from pg_constraint con
        join pg_class rel on rel.oid = con.conrelid
        join pg_namespace n on n.oid = rel.relnamespace
       where n.nspname = ${schema} and rel.relname = 'retention_review' and con.contype = 'c'
         and pg_get_constraintdef(con.oid) like '%file_action%'`
      .execute(db.migrator)
      .then((r) => r.rows);

  // A disposed review: decided by someone else (SOD-SELF-APPROVE is a CHECK too), approved by the member.
  const review = (fileAction: string, itemCode: string) =>
    sql`insert into retention_review (management_system_id, record_class, item_id, item_code, retention_ends_on, status, decision, decided_at,
          approved_by, approved_at, disposed_at, file_action)
        values (${msId}, 'evidence_file', gen_random_uuid(), ${itemCode}, '2026-09-15', 'disposed', 'dispose', now(), ${member}, now(), now(), ${fileAction})`;

  beforeAll(async () => {
    tenant = await createTenant(db, 'mfollow');
    const fw = await addFramework(db.migrator);
    msId = await addManagementSystem(db.migrator, tenant, fw.versionId, 'isms');
    member = await addUser(db.migrator, 'mfollow.member', [tenant.id]);
  });

  it('records the migration as applied', async () => {
    const { rows } = await sql<{ name: string }>`select name from ${sql.id(tenant.schemaName, 'kysely_migration')} where name = '0012_milestone3_followups'`.execute(db.migrator);
    expect(rows).toHaveLength(1);
  });

  it('accepts kept_in_use and every earlier file action, and still refuses any other value', async () => {
    const checks = await fileActionChecks(tenant.schemaName);
    expect(checks).toEqual([{ name: 'retention_review_file_action_check', def: expect.stringContaining("'kept_in_use'") }]);
    await rolledBack(db.app, { orgId: tenant.id, schema: tenant.schemaName, userId: member }, async (trx) => {
      for (const [n, action] of ['vault_content_deleted', 'owner_asked', 'kept_in_use', 'none'].entries()) await review(action, `EV-${n} v1`).execute(trx);
    });
    for (const action of ['kept', 'deleted', 'KEPT_IN_USE']) {
      await expectPgError(rolledBack(db.app, { orgId: tenant.id, schema: tenant.schemaName, userId: member }, (trx) => review(action, `EV-${action}`).execute(trx)), '23514');
    }
  });

  it('runs again on a schema that already accepts the value without a change, and widens a CHECK of the earlier list', async () => {
    const body = await readFile(MIGRATION, 'utf8');
    const run = (schema: string) =>
      db.migrator.transaction().execute(async (trx) => {
        await sql`select set_config('search_path', ${`${schema},ext`}, true)`.execute(trx);
        await sql`select set_config('app.platform_scope', 'on', true)`.execute(trx);
        await sql.raw(body).execute(trx);
      });
    await run(tenant.schemaName);
    expect(await fileActionChecks(tenant.schemaName)).toEqual([{ name: 'retention_review_file_action_check', def: expect.stringContaining("'kept_in_use'") }]);
    // A schema whose CHECK is still the list of tenant/0009 (an organisation not migrated yet) gets the new list.
    await sql`alter table ${sql.id(tenant.schemaName, 'retention_review')} drop constraint retention_review_file_action_check`.execute(db.migrator);
    await sql`alter table ${sql.id(tenant.schemaName, 'retention_review')} add check (file_action in ('vault_content_deleted', 'owner_asked', 'none'))`.execute(db.migrator);
    expect((await fileActionChecks(tenant.schemaName))[0]!.def).not.toContain('kept_in_use');
    await run(tenant.schemaName);
    const after = await fileActionChecks(tenant.schemaName);
    expect(after).toEqual([{ name: 'retention_review_file_action_check', def: expect.stringContaining("'kept_in_use'") }]);
    for (const value of ['vault_content_deleted', 'owner_asked', 'none']) expect(after[0]!.def).toContain(`'${value}'`);
  });
});
