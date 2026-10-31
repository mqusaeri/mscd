// Coverage of the mention search (Milestone 3 D.6.4, R-21): every text column of a freshly migrated tenant schema
// (`text`, `character varying`, `jsonb`, `json` and arrays) is either searched (`MENTION_TABLES`) or listed as not
// searched with the reason (`NOT_SEARCHED`), and every listed column exists. A package that adds a tenant text column
// classifies it in `apps/server/src/modules/privacy/mention-columns.ts`, so an erasure never leaves a name behind in a
// column nobody looked at. The search query of every searched table runs once against the empty schema.
import { sql } from 'kysely';
import { describe, expect, it } from 'vitest';
import { MENTION_TABLES, NOT_SEARCHED } from '../../../src/modules/privacy/mention-columns';
import { searchMentions } from '../../../src/modules/privacy/mention-search';
import { createTenant } from '../../setup/global-db';
import { useTestDatabase } from '../../setup/test-db';
import { inScope } from '../db/helpers';

describe('mention search coverage (D.6.4)', () => {
  const db = useTestDatabase('empty');

  it('classifies every tenant text column, lists no column that does not exist, and runs every table query', async () => {
    const tenant = await createTenant(db, 'mentions', { name: 'Mention coverage' });
    const { rows } = await sql<{ table: string; column: string }>`
      select c.table_name as table, c.column_name as column
        from information_schema.columns c
        join information_schema.tables t on t.table_schema = c.table_schema and t.table_name = c.table_name and t.table_type = 'BASE TABLE'
       where c.table_schema = ${tenant.schemaName} and c.table_name not like 'kysely\\_%'
         and c.data_type in ('text', 'character varying', 'jsonb', 'json', 'ARRAY')
       order by 1, 2`.execute(db.migrator);
    expect(rows.length).toBeGreaterThan(300);
    const { rows: all } = await sql<{ table: string; column: string }>`
      select table_name as table, column_name as column from information_schema.columns where table_schema = ${tenant.schemaName}`.execute(db.migrator);
    const exists = new Set(all.map((r) => `${r.table}.${r.column}`));

    const searched = new Set(Object.entries(MENTION_TABLES).flatMap(([table, def]) => def.columns.map((c) => `${table}.${c}`)));
    const skipped = new Set(Object.entries(NOT_SEARCHED).flatMap(([table, cols]) => Object.keys(cols).map((c) => `${table}.${c}`)));
    const unclassified = rows.map((r) => `${r.table}.${r.column}`).filter((key) => !searched.has(key) && !skipped.has(key));
    const both = [...searched].filter((key) => skipped.has(key));
    const stale = [...searched, ...skipped].filter((key) => !exists.has(key));
    expect({ unclassified, both, stale }).toEqual({ unclassified: [], both: [], stale: [] });
    for (const [table, cols] of Object.entries(NOT_SEARCHED)) {
      for (const [column, reason] of Object.entries(cols)) expect(reason.length, `${table}.${column}`).toBeGreaterThan(10);
    }

    // Every table query is valid SQL over the schema (no rows, nothing found).
    await inScope(db.migrator, { orgId: tenant.id, schema: tenant.schemaName }, async (trx) => {
      const found = await searchMentions(trx, '00000000-0000-4000-8000-000000000000', ['Larasati Permana', 'larasati.permana@contractor.example', 'larasati']);
      expect(found).toEqual({ items: [], truncated: false });
    });
  });
});
