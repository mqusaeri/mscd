// Writing one dataset of the organisation export (Milestone 3 D.4) into a CSV and a JSON Lines spool: the rows come
// from a query whose single column `j` is the row as JSON text (`row_to_json`), read through a server-side cursor in
// batches of `FETCH_ROWS`, so a large table never sits in memory. A dataset may change rows on the way (pseudonyms of
// erased people, the network address of provider staff); JSON Lines then holds the changed row.
import { sql, type RawBuilder } from 'kysely';
import { toSafeCsv } from '../../common/spreadsheet-safe';
import type { Trx } from '../../common/tokens';
import type { Spool } from './spool';

/** Rows read per cursor fetch. */
export const FETCH_ROWS = 1000;
/** UTF-8 byte order mark at the start of every CSV file, so spreadsheet programs read the text as UTF-8. */
export const CSV_BOM = Buffer.from([0xef, 0xbb, 0xbf]);
const CURSOR = 'mscd_org_export_rows';

/** A row of a dataset as parsed from its JSON text. */
export type DatasetRow = Record<string, unknown>;

/** Changes a row before it is written; null leaves the row out. */
export type RowTransform = (row: DatasetRow) => DatasetRow | null;

/** Sets the transaction's time zone to UTC, so PostgreSQL renders times as ISO 8601 UTC. */
export async function useUtc(trx: Trx): Promise<void> {
  await sql`select set_config('TimeZone', 'UTC', true)`.execute(trx);
}

/** The JSON text of every row of `query` (whose one column is `j`), in batches through a cursor. */
export async function* cursorRows(trx: Trx, query: RawBuilder<unknown>): AsyncGenerator<string[]> {
  await sql`declare ${sql.raw(CURSOR)} no scroll cursor for ${query}`.execute(trx);
  try {
    for (;;) {
      const { rows } = await sql<{ j: string }>`fetch forward ${sql.lit(FETCH_ROWS)} from ${sql.raw(CURSOR)}`.execute(trx);
      if (rows.length === 0) break;
      yield rows.map((r) => r.j);
    }
  } finally {
    await sql`close ${sql.raw(CURSOR)}`.execute(trx);
  }
}

/** A value as the source of one CSV cell (objects and arrays as JSON text; `toSafeCsv` makes every cell formula-safe). */
function cellOf(value: unknown): unknown {
  if (value === null || value === undefined) return null;
  if (typeof value === 'object') return JSON.stringify(value);
  return value;
}

/**
 * Writes every row of `query` to the CSV spool (header row, formula-safe cells, CRLF) and the JSON Lines spool (one
 * object per line); returns the number of rows written. Runs in the caller's transaction, which must use UTC.
 */
export async function writeDataset(
  trx: Trx,
  query: RawBuilder<unknown>,
  columns: readonly string[],
  csv: Spool,
  jsonl: Spool,
  transform?: RowTransform,
): Promise<number> {
  await csv.write(CSV_BOM);
  await csv.write(toSafeCsv([], [...columns]));
  let count = 0;
  for await (const batch of cursorRows(trx, query)) {
    const cells: unknown[][] = [];
    let lines = '';
    for (const text of batch) {
      let row = JSON.parse(text) as DatasetRow;
      if (transform) {
        const changed = transform(row);
        if (!changed) continue;
        row = changed;
        lines += `${JSON.stringify(row)}\n`;
      } else {
        lines += `${text}\n`;
      }
      cells.push(columns.map((c) => cellOf(row[c])));
    }
    if (cells.length === 0) continue;
    await jsonl.write(lines);
    await csv.write(toSafeCsv(cells));
    count += cells.length;
  }
  return count;
}
