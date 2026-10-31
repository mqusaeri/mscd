// Drops the api's database and creates it again from a template database (D.3 `POST /test/reset`), through the
// administrator URL of `test.admin_database_url_file`. Database-level privileges are not copied by
// `CREATE DATABASE ... TEMPLATE` (C.2), so the grants of the template are applied to the new database. On PostgreSQL
// 15 and later the copy uses `STRATEGY FILE_COPY` (M2-21): it copies the files of the template instead of writing
// every page to the WAL, which is much faster for a template of tens of megabytes on the test server.
//
// A reset without a write only deletes the minted sessions (`deleteSessions`). It keeps its administrator connection
// to the api's database open between resets (M2-21: a new connection and its password exchange cost more than the
// delete itself); the connection is closed before the database is dropped and when the api stops.
import pg from 'pg';

/** A plain PostgreSQL identifier (the profile schema allows only these for `test.template_database`). */
const PLAIN_NAME = /^[a-z_][a-z0-9_]{0,62}$/;

export interface RecreateDatabaseOptions {
  /** Administrator URL (superuser or a role with CREATEDB that owns the database). Any database of the server. */
  adminUrl: string;
  /** The database to drop and create, the one the api's role URLs name. */
  database: string;
  /** The template it is created from. */
  template: string;
}

/** Name of the database a PostgreSQL URL names (its path). */
export function databaseOf(url: string): string {
  const name = decodeURIComponent(new URL(url).pathname.replace(/^\//, ''));
  if (!name) throw new Error('The database URL names no database');
  return name;
}

/** `CREATE DATABASE ... STRATEGY` exists from PostgreSQL 15 (`server_version_num` 150000). */
const FILE_COPY_SINCE = 150000;

/** A privilege of the template, as `aclexplode` lists it. */
interface DatabaseGrant {
  grantee: string | null;
  privilege_type: string;
}

function quoteIdent(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

/**
 * `DROP DATABASE <database> WITH (FORCE)` (connections of other clients are ended) and
 * `CREATE DATABASE <database> TEMPLATE <template>`, then the database grants of the template.
 */
export async function recreateDatabase(options: RecreateDatabaseOptions): Promise<void> {
  const { database, template } = options;
  if (!PLAIN_NAME.test(database)) throw new Error(`The database name ${JSON.stringify(database)} is not a plain name`);
  if (!PLAIN_NAME.test(template)) throw new Error(`The template name ${JSON.stringify(template)} is not a plain name`);
  if (database === template) throw new Error('The template database must differ from the database it recreates');
  const url = new URL(options.adminUrl);
  // The administrator cannot drop the database it is connected to.
  if (databaseOf(options.adminUrl) === database) url.pathname = '/postgres';
  const client = new pg.Client({ connectionString: url.toString(), application_name: 'mscd-test-reset' });
  client.on('notice', () => undefined);
  client.on('error', () => undefined);
  await client.connect();
  // The kept connection of `deleteSessions` would be ended by the drop anyway; close it first.
  await closeKeptConnections();
  try {
    const found = await client.query<{ datacl: string | null }>('select datacl::text from pg_database where datname = $1', [template]);
    if (found.rowCount === 0) throw new Error(`The template database ${template} does not exist`);
    const grants =
      found.rows[0]!.datacl === null
        ? null
        : (
            await client.query<DatabaseGrant>(
              `select case when a.grantee = 0 then null else a.grantee::regrole::text end as grantee, a.privilege_type
                 from pg_database d, aclexplode(d.datacl) a where d.datname = $1`,
              [template],
            )
          ).rows;
    const version = await client.query<{ server_version_num: string }>('show server_version_num');
    const fileCopy = Number(version.rows[0]?.server_version_num ?? 0) >= FILE_COPY_SINCE ? ' STRATEGY FILE_COPY' : '';
    await client.query(`DROP DATABASE IF EXISTS ${quoteIdent(database)} WITH (FORCE)`);
    await client.query(`CREATE DATABASE ${quoteIdent(database)} TEMPLATE ${quoteIdent(template)}${fileCopy}`);
    if (grants !== null) {
      // Same access as the template: PUBLIC keeps only what the template gives it.
      await client.query(`REVOKE ALL ON DATABASE ${quoteIdent(database)} FROM PUBLIC`);
      for (const grant of grants) {
        if (!/^[A-Z ]+$/.test(grant.privilege_type)) continue;
        const grantee = grant.grantee === null ? 'PUBLIC' : grant.grantee.startsWith('"') ? grant.grantee : quoteIdent(grant.grantee);
        await client.query(`GRANT ${grant.privilege_type} ON DATABASE ${quoteIdent(database)} TO ${grantee}`);
      }
    }
  } finally {
    await client.end().catch(() => undefined);
  }
}

export interface DeleteSessionsOptions {
  /** Administrator URL, as for `recreateDatabase`. */
  adminUrl: string;
  /** The database of the api. */
  database: string;
  /** `platform.session.id_hash` of each session to delete. */
  idHashes: readonly Buffer[];
}

/** The administrator connection of `deleteSessions` per database URL, kept between resets. */
const kept = new Map<string, Promise<pg.Client>>();

function keptConnection(url: string): Promise<pg.Client> {
  const existing = kept.get(url);
  if (existing) return existing;
  const client = new pg.Client({ connectionString: url, application_name: 'mscd-test-reset' });
  const forget = () => {
    if (kept.get(url) === connected) kept.delete(url);
  };
  client.on('notice', () => undefined);
  // An ended or broken connection is dropped; the next reset opens a new one.
  client.on('error', forget);
  client.on('end', forget);
  const connected = client.connect().then(() => client);
  connected.catch(forget);
  kept.set(url, connected);
  return connected;
}

/** Closes the kept administrator connections (before a drop, and when the api stops). */
export async function closeKeptConnections(): Promise<void> {
  const clients = [...kept.values()];
  kept.clear();
  await Promise.all(clients.map((connected) => connected.then((client) => client.end()).catch(() => undefined)));
}

/**
 * Deletes sessions by their `id_hash` (the sessions `POST /test/session` minted since the last reset), through the
 * administrator URL on the api's database. A reset without any other write since the last one does only this
 * (M2-21, `write-tracker.ts`). It uses the kept connection, and a new one when that fails.
 */
export async function deleteSessions(options: DeleteSessionsOptions): Promise<void> {
  if (options.idHashes.length === 0) return;
  if (!PLAIN_NAME.test(options.database)) throw new Error(`The database name ${JSON.stringify(options.database)} is not a plain name`);
  const url = new URL(options.adminUrl);
  url.pathname = `/${options.database}`;
  const target = url.toString();
  const run = async () => {
    const client = await keptConnection(target);
    await client.query('delete from platform.session where id_hash = any($1::bytea[])', [options.idHashes]);
  };
  try {
    await run();
  } catch {
    // A connection that was ended since the last reset: once more on a new one.
    const stale = kept.get(target);
    kept.delete(target);
    await stale?.then((client) => client.end()).catch(() => undefined);
    await run();
  }
}
