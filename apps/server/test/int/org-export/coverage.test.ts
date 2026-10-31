// Coverage of the organisation export (Milestone 3 rule R-21, D.4): every table and column that holds organisation data
// is in the export or in the exclusion list with a reason. The test fails on
// - a tenant table of a freshly migrated tenant schema that `TENANT_TABLES` does not list (and on a listed table that
//   no longer exists), and on an excluded tenant column that does not exist;
// - a platform table with `organization_id`, or with a foreign key to a table that has one, that `PLATFORM_TABLES`
//   does not list;
// - a column of an exported platform table that is neither exported nor excluded (and on a listed column that does not
//   exist);
// - a file of `PLATFORM_TABLES` without a dataset of the build, or a dataset without a file there.
// A package that adds a table or column runs this test and classifies it in `org-export/exclusions.ts`.
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ACCOUNT_TABLE_EXCLUSIONS, exclusionList, PLATFORM_TABLES, TENANT_TABLES } from '../../../src/modules/org-export/exclusions';
import { PLATFORM_DATASETS } from '../../../src/modules/org-export/platform-data';
import type { CreatedTenant } from '../../../src/db/tenant-provisioner';
import { createTenant } from '../../setup/global-db';
import { useTestDatabase } from '../../setup/test-db';

describe('organisation export coverage (R-21)', () => {
  const db = useTestDatabase('empty');
  let tenant: CreatedTenant;
  let columns: Map<string, Set<string>>;

  beforeAll(async () => {
    tenant = await createTenant(db, 'coverage', { name: 'Coverage check' });
    const { rows } = await sql<{ schema: string; table: string; column: string }>`
      select c.table_schema as schema, c.table_name as table, c.column_name as column
      from information_schema.columns c
      join information_schema.tables t on t.table_schema = c.table_schema and t.table_name = c.table_name and t.table_type = 'BASE TABLE'
      where c.table_schema in ('platform', ${tenant.schemaName}) and c.table_name not like 'kysely\\_%'`.execute(db.migrator);
    columns = new Map();
    for (const row of rows) {
      const key = row.schema === 'platform' ? `platform.${row.table}` : row.table;
      if (!columns.has(key)) columns.set(key, new Set());
      columns.get(key)!.add(row.column);
    }
  });
  afterAll(() => undefined);

  it('classifies every tenant table and every excluded tenant column', () => {
    const tenantTables = [...columns.keys()].filter((k) => !k.startsWith('platform.')).sort();
    expect(tenantTables.length).toBeGreaterThan(70);
    const unclassified = tenantTables.filter((t) => !(t in TENANT_TABLES));
    const stale = Object.keys(TENANT_TABLES).filter((t) => !tenantTables.includes(t));
    expect({ unclassified, stale }).toEqual({ unclassified: [], stale: [] });
    for (const [table, plan] of Object.entries(TENANT_TABLES)) {
      for (const column of Object.keys(plan.excludedColumns ?? {})) expect(columns.get(table)?.has(column), `${table}.${column}`).toBe(true);
    }
  });

  it('classifies every platform table that holds organisation data', async () => {
    const withOrg = [...columns].filter(([k, cols]) => k.startsWith('platform.') && cols.has('organization_id')).map(([k]) => k);
    const { rows } = await sql<{ table: string; referenced: string }>`
      select 'platform.' || c.relname as table, 'platform.' || r.relname as referenced
      from pg_constraint k
      join pg_class c on c.oid = k.conrelid join pg_namespace n on n.oid = c.relnamespace and n.nspname = 'platform'
      join pg_class r on r.oid = k.confrelid
      where k.contype = 'f'`.execute(db.migrator);
    const viaKey = rows.filter((r) => withOrg.includes(r.referenced)).map((r) => r.table);
    const required = [...new Set([...withOrg, ...viaKey])].sort();
    expect(required).toEqual(expect.arrayContaining(['platform.org_membership', 'platform.session', 'platform.user_identity', 'platform.audit_log']));
    const unclassified = required.filter((t) => !(t in PLATFORM_TABLES));
    expect(unclassified).toEqual([]);
    for (const table of [...Object.keys(PLATFORM_TABLES), ...Object.keys(ACCOUNT_TABLE_EXCLUSIONS)]) expect(columns.has(table), table).toBe(true);
  });

  it('classifies every column of an exported platform table', () => {
    const problems: string[] = [];
    for (const [table, plan] of Object.entries(PLATFORM_TABLES)) {
      if (plan.excluded) {
        expect(plan.exported, table).toBeUndefined();
        continue;
      }
      const stored = columns.get(table)!;
      const classified = new Set([...(plan.exported ?? []), ...Object.keys(plan.excludedColumns ?? {})]);
      for (const column of stored) if (!classified.has(column)) problems.push(`${table}.${column} is neither exported nor excluded`);
      for (const column of classified) if (!stored.has(column)) problems.push(`${table}.${column} is listed but does not exist`);
    }
    expect(problems).toEqual([]);
  });

  it('builds a dataset for every platform file and lists every exclusion once with a reason', () => {
    const files = new Set(
      Object.values(PLATFORM_TABLES)
        .map((p) => p.file)
        .filter((f): f is string => typeof f === 'string' && f.startsWith('data/platform/'))
        .map((f) => f.slice('data/platform/'.length)),
    );
    expect([...files].sort()).toEqual(PLATFORM_DATASETS.map((d) => d.name).sort());
    const list = exclusionList();
    expect(new Set(list.map((e) => e.item)).size).toBe(list.length);
    for (const entry of list) expect(entry.reason.length, entry.item).toBeGreaterThan(20);
    expect(list.map((e) => e.item)).toEqual(
      expect.arrayContaining([
        'platform.app_user.password_hash', 'platform.mfa_factor', 'platform.mfa_recovery_code', 'platform.session.id_hash', 'platform.invitation',
        'platform.password_reset_token', 'calendar_feed_token.token_hash', 'auditor_access_grant.token_hash', 'storage_credential.sealed_blob',
        'platform.identity_provider.oidc_client_secret_sealed', 'platform.tenant_key', 'platform.idempotency_key', 'platform.rate_limit_bucket',
      ]),
    );
  });
});
