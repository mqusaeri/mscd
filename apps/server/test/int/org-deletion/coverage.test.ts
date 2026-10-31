// Deletion coverage (Milestone 3 R-21, D.5.3; M3-03): every platform table that holds organisation data, that is with an
// `organization_id` column or a foreign key (directly or through other tables) to a table that has one or to
// `platform.organization`, is either purged by `platform.purge_organization` or kept after the purge with a reason
// (ops/deletion/deletion-coverage.ts). A new platform table that is in neither list fails this test, so the purge and
// its checks cannot forget it. Tenant tables need no list: the purge drops the organisation's schema with all of them.
import { sql } from 'kysely';
import { describe, expect, it } from 'vitest';
import { KEPT_PLATFORM_TABLES, PURGED_PLATFORM_TABLES } from '../../../src/modules/ops/deletion/deletion-coverage';
import { useTestDatabase } from '../../setup/test-db';

describe('deletion coverage of the platform tables (Milestone 3 R-21; M3-03)', () => {
  const db = useTestDatabase('empty');

  it('classifies every platform table that reaches an organisation as purged or kept', async () => {
    const { rows } = await sql<{ relname: string }>`
      with recursive direct as (
        select c.oid, c.relname::text as relname
          from pg_class c join pg_namespace n on n.oid = c.relnamespace
         where n.nspname = 'platform' and c.relkind in ('r', 'p')
           and (c.relname = 'organization'
                or exists (select 1 from pg_attribute a where a.attrelid = c.oid and a.attname = 'organization_id' and not a.attisdropped))
      ), reach(oid, relname) as (
        select oid, relname from direct
        union
        select k.conrelid, c.relname::text
          from pg_constraint k
          join reach r on k.confrelid = r.oid
          join pg_class c on c.oid = k.conrelid
          join pg_namespace n on n.oid = c.relnamespace
         where k.contype = 'f' and n.nspname = 'platform'
      )
      select distinct relname from reach order by relname`.execute(db.migrator);
    const reached = rows.map((r) => r.relname);
    expect(reached.length).toBeGreaterThan(10);
    const purged = new Set(PURGED_PLATFORM_TABLES.map((t) => t.table));
    const kept = new Set(Object.keys(KEPT_PLATFORM_TABLES));
    const unclassified = reached.filter((table) => !purged.has(table) && !kept.has(table));
    expect(unclassified, 'platform tables that reach an organisation but are neither purged nor kept (ops/deletion/deletion-coverage.ts)').toEqual([]);
    // No table is in both lists.
    expect([...purged].filter((t) => kept.has(t))).toEqual([]);
  });

  it('names only tables that exist, each with a reason', async () => {
    const { rows } = await sql<{ relname: string }>`
      select c.relname::text as relname from pg_class c join pg_namespace n on n.oid = c.relnamespace
       where n.nspname = 'platform' and c.relkind in ('r', 'p')`.execute(db.migrator);
    const tables = new Set(rows.map((r) => r.relname));
    for (const table of [...PURGED_PLATFORM_TABLES.map((t) => t.table), ...Object.keys(KEPT_PLATFORM_TABLES)]) {
      expect(tables.has(table), `platform.${table}`).toBe(true);
    }
    for (const table of PURGED_PLATFORM_TABLES) expect(table.why.length, table.table).toBeGreaterThan(10);
    for (const [table, why] of Object.entries(KEPT_PLATFORM_TABLES)) expect(why.length, table).toBeGreaterThan(10);
  });

  it('selects rows of each purged table with a condition that runs', async () => {
    const orgId = '00000000-0000-4000-8000-0000000000ff';
    for (const table of PURGED_PLATFORM_TABLES) {
      await db.migrator.transaction().execute(async (trx) => {
        await sql`select set_config('app.platform_scope', 'on', true), set_config('app.org_id', ${orgId}, true)`.execute(trx);
        const { rows } = await sql<{ n: string }>`select count(*) as n from ${sql.table(`platform.${table.table}`)} where ${sql.raw(table.where.replaceAll('$1', `'${orgId}'::uuid`))}`.execute(trx);
        expect(Number(rows[0]!.n), table.table).toBe(0);
      });
    }
  });
});
