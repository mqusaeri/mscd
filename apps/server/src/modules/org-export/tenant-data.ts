// The tables of the organisation's schema in the export (Milestone 3 D.4): `data/tenant/<table>.csv` and `.jsonl` with
// every row, rows marked deleted included, and every column as stored minus the excluded ones (`exclusions.ts`).
// Rows are read through a server-side cursor inside the organisation's tenant transaction (`datasets.ts`); PostgreSQL
// renders each row as JSON (`row_to_json`), with times in ISO 8601 UTC because the transaction uses the time zone UTC.
import { sql } from 'kysely';
import type { Trx } from '../../common/tokens';
import { writeDataset } from './datasets';
import { excludedTenantColumns, TENANT_TABLES } from './exclusions';
import type { Spool } from './spool';

/** Folder label prefix of the parts and manifests of organisation exports in the Managed Vault. */
export const EXPORT_FOLDER_PREFIX = 'exports/organization/';

export interface TenantTable {
  name: string;
  /** Every column in table order. */
  columns: string[];
  /** Primary key columns (empty when the table has none). */
  primaryKey: string[];
}

/** The tables of the transaction's tenant schema with their columns and primary keys (migration tables left out). */
export async function tenantTables(trx: Trx): Promise<TenantTable[]> {
  const { rows } = await sql<{ table_name: string; column_name: string }>`
    select c.table_name, c.column_name
    from information_schema.columns c
    join information_schema.tables t on t.table_schema = c.table_schema and t.table_name = c.table_name and t.table_type = 'BASE TABLE'
    where c.table_schema = current_schema() and c.table_name not like 'kysely\\_%'
    order by c.table_name, c.ordinal_position`.execute(trx);
  const { rows: keys } = await sql<{ table_name: string; column_name: string }>`
    select cl.relname as table_name, a.attname as column_name
    from pg_index i
    join pg_class cl on cl.oid = i.indrelid
    join pg_namespace n on n.oid = cl.relnamespace and n.nspname = current_schema()
    join lateral unnest(i.indkey) with ordinality as k(attnum, ord) on true
    join pg_attribute a on a.attrelid = cl.oid and a.attnum = k.attnum
    where i.indisprimary
    order by cl.relname, k.ord`.execute(trx);
  const tables = new Map<string, TenantTable>();
  for (const row of rows) {
    let table = tables.get(row.table_name);
    if (!table) {
      table = { name: row.table_name, columns: [], primaryKey: [] };
      tables.set(row.table_name, table);
    }
    table.columns.push(row.column_name);
  }
  for (const key of keys) tables.get(key.table_name)?.primaryKey.push(key.column_name);
  return [...tables.values()].sort((a, b) => a.name.localeCompare(b.name));
}

/** True when the table goes to `data/tenant/` (every table except the audit trail, which has its own folder). */
export function exportedAsData(table: string): boolean {
  return (TENANT_TABLES[table]?.file ?? 'data') === 'data';
}

/** The exported columns of a table: every column minus the excluded ones. */
export function exportedColumns(table: TenantTable): string[] {
  const excluded = excludedTenantColumns(table.name);
  return table.columns.filter((c) => !excluded.has(c));
}

export interface DumpOptions {
  /** Ids of storage objects left out (the parts and manifests of organisation exports). */
  skipStorageObjects?: readonly string[];
}

/**
 * Writes one table into its CSV and JSON Lines spools; returns the number of rows. Runs in the caller's tenant
 * transaction, which must use UTC (`useUtc`).
 */
export async function dumpTenantTable(trx: Trx, table: TenantTable, csv: Spool, jsonl: Spool, options: DumpOptions = {}): Promise<number> {
  const columns = exportedColumns(table);
  const select = sql.join(columns.map((c) => sql.ref(c)));
  const order = table.primaryKey.length > 0 ? sql`order by ${sql.join(table.primaryKey.map((c) => sql.ref(c)))}` : sql``;
  const skip = options.skipStorageObjects ?? [];
  // The parts of this build are uploaded while it runs, so their rows are left out by their folder as well.
  const filter =
    table.name === 'storage_object'
      ? sql`where not (id = any(${[...skip]}::uuid[])) and coalesce(folder_path, '') not like ${`${EXPORT_FOLDER_PREFIX}%`}`
      : sql``;
  const query = sql`select row_to_json(x)::text as j from (select ${select} from ${sql.table(table.name)} ${filter} ${order}) x`;
  return writeDataset(trx, query, columns, csv, jsonl);
}
