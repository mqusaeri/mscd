// Tenant scoping per request (build plan D-03, F.10). Every tenant read and write runs in one transaction that sets
// `search_path` to the tenant schema and `ext`, and `app.org_id`, `app.user_id` and `app.request_id`, all
// transaction-local. `withPlatform` sets `app.platform_scope = 'on'` for the organisation-scoped platform tables
// (D-31); lint rules allow it only in the folders that may cross organisations.
//
// Milestone 3 (M3-12): `withTenant` takes `{ snapshot: true }` for a REPEATABLE READ, READ ONLY transaction, so a reader
// that runs many statements sees the organisation as it was at one instant. The isolation level and the access mode are
// part of the statement that starts the transaction (`start transaction isolation level repeatable read read only`),
// before `set_config`, so the first statement takes the snapshot and everything after it reads the same one.
//
// A reader that works for a long time between its reads (the organisation export uploads archive parts) uses
// `holdSnapshot` instead: one transaction that reads no table exports its snapshot (`pg_export_snapshot`) and stays open,
// and each short `withTenant(ctx, fn, { snapshot: held })` imports it (`SET TRANSACTION SNAPSHOT`, before `set_config`).
// Every short transaction sees the same instant, while each keeps its table locks only until it ends, so a migration
// that alters a table waits for one short read at most, never for the whole export. A table that was rewritten or
// emptied after the snapshot (TRUNCATE, an ALTER TABLE that rewrites it, VACUUM FULL) shows no rows to an older
// snapshot, so a transaction that imported one checks the tables it read before it ends and fails instead
// (`SnapshotTableRewrittenError`).
import { randomUUID } from 'node:crypto';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { sql, type Transaction } from 'kysely';
import { currentRequestId } from '../../common/request-context';
import type { Principal, TenantInfo, Trx } from '../../common/tokens';
import { SYSTEM_USER_ID } from '../../common/tokens';
import { discardTransactionHooks, openTransactionHooks, runAfterCommitHooks } from '../../common/transaction-hooks';
import { DATABASE, type AppDatabase } from '../../db/database.module';
import type { DB } from '../../db/types';

/** C.4: tenant schemas are `org_<slug>`. */
export const TENANT_SCHEMA = /^org_[a-z0-9_]{1,59}$/;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Who acts in which organisation (F.10). */
export interface TenantContext {
  orgId: string;
  /** `org_<slug>`. */
  schema: string;
  /** Acting user; jobs use the system user (`SYSTEM_USER_ID`). */
  userId: string;
  /** Default: the current request id, else a new UUID. */
  requestId?: string;
}

/** Why platform scope is used (F.10): sign-in, platform operator, cross-tenant job, command line. */
export type PlatformScopeKind = 'auth' | 'operator' | 'job' | 'cli';

/** `pg_export_snapshot()` ids look like `00000003-0000001B-1`. */
const SNAPSHOT_ID = /^[0-9A-F]{1,16}-[0-9A-F]{1,16}(?:-[0-9]{1,10})?$/i;

/**
 * A database snapshot held open by `TenantScope.holdSnapshot` (Milestone 3 M3-12): pass it as `withTenant`'s
 * `snapshot` option to read that snapshot in a short transaction of its own. It is valid only while the `holdSnapshot`
 * callback runs.
 */
export class HeldSnapshot {
  private ended = false;

  /** Made by `TenantScope.holdSnapshot` only. */
  constructor(
    /** The id `pg_export_snapshot()` gave. */
    readonly id: string,
    private readonly holder: Transaction<DB>,
  ) {
    if (!SNAPSHOT_ID.test(id)) throw new Error('bad snapshot id');
  }

  /** True once the `holdSnapshot` callback has ended (the snapshot can no longer be imported). */
  get isEnded(): boolean {
    return this.ended;
  }

  /**
   * Imports the snapshot into `trx`, which must be a REPEATABLE READ transaction that has run no query yet. A statement
   * in the holding transaction first starts its idle timer again, so the holder's idle limit applies between two
   * imports and not to the whole time it is held.
   */
  async importInto(trx: Transaction<DB>): Promise<void> {
    if (this.ended) throw new Error('The held snapshot has ended; it cannot be read any more');
    await sql`select 1`.execute(this.holder);
    await sql`set transaction snapshot ${sql.lit(this.id)}`.execute(trx);
  }

  /** Called by `holdSnapshot` when its callback ends. */
  end(): void {
    this.ended = true;
  }
}

/**
 * A transaction that imported a held snapshot read a table that was rewritten or emptied after the snapshot was taken
 * (TRUNCATE, an ALTER TABLE that rewrites it, VACUUM FULL, typically an upgrade migration that ran meanwhile). After a
 * TRUNCATE or a rewriting ALTER TABLE the old snapshot sees none of the table's rows, so what the transaction read may be
 * incomplete; run the reader again.
 */
export class SnapshotTableRewrittenError extends Error {
  constructor(readonly tables: readonly string[]) {
    super(
      `The table(s) ${tables.join(', ')} were rewritten or emptied after the snapshot was taken (an upgrade migration, TRUNCATE or ` +
        'VACUUM FULL ran meanwhile), so this snapshot may not show their rows; start the reader again',
    );
    this.name = 'SnapshotTableRewrittenError';
  }
}

/** How `withTenant` runs its transaction (Milestone 3 M3-12). Without options: READ COMMITTED, read and write. */
export interface TenantTransactionOptions {
  /**
   * `true`: a REPEATABLE READ, READ ONLY transaction: every statement of `fn` reads one snapshot of the database, taken
   * by the first statement; a write fails with SQLSTATE 25006. For readers that must see a consistent state over many
   * queries. A `HeldSnapshot` (`holdSnapshot`): the same, reading that held snapshot, so several short transactions see
   * the same instant; before it commits, the transaction fails with `SnapshotTableRewrittenError` when a table it read
   * was rewritten after the snapshot.
   */
  snapshot?: boolean | HeldSnapshot;
  /**
   * `idle_in_transaction_session_timeout` of this transaction in seconds (0 turns it off; default: the role's 60
   * seconds), for a snapshot reader that does slow work between its statements (writing and uploading archive parts).
   */
  idleTimeoutSeconds?: number;
}

export interface PlatformScopeOptions {
  scope: PlatformScopeKind;
  /** Also sets `app.org_id` (for example to write an organisation's `platform.audit_log` row). */
  orgId?: string | null;
  userId?: string | null;
  requestId?: string;
}

/** The tenant context of a request's principal (its current organisation and user). */
export function tenantContextOf(principal: Principal, requestId?: string): TenantContext {
  if (!principal.org) throw new Error('The principal has no current organisation');
  return { orgId: principal.org.id, schema: principal.org.schema, userId: principal.user.id, requestId };
}

/** The tenant context of a job or command acting for an organisation as the system user. */
export function systemContextOf(org: Pick<TenantInfo, 'id' | 'schema'>, requestId?: string): TenantContext {
  return { orgId: org.id, schema: org.schema, userId: SYSTEM_USER_ID, requestId };
}

/** The idle timeout option checked: a whole number of seconds from 0 to a day, or undefined. */
function checkedIdle(idle: number | undefined): number | undefined {
  if (idle !== undefined && (!Number.isInteger(idle) || idle < 0 || idle > 86_400)) throw new Error('bad idle timeout');
  return idle;
}

/**
 * Fails with `SnapshotTableRewrittenError` when a table this transaction read (every table it holds a lock on) got a
 * new file after the transaction's snapshot: `pg_class` read in the snapshot still names the file of that instant, while
 * `pg_relation_filenode` names the current one. The transaction holds its lock on each table it read, so no rewrite can
 * happen between its reads and this check. System catalogs (mapped catalogs name file 0) are left out.
 */
async function assertReadTablesIntact(trx: Transaction<DB>): Promise<void> {
  const { rows } = await sql<{ name: string }>`
    select distinct n.nspname || '.' || c.relname as name
    from pg_locks l
    join pg_class c on c.oid = l.relation
    join pg_namespace n on n.oid = c.relnamespace
    where l.locktype = 'relation' and l.pid = pg_backend_pid() and l.granted
      and c.relkind = 'r' and c.relfilenode <> 0 and n.nspname not in ('pg_catalog', 'information_schema')
      and c.relfilenode <> pg_relation_filenode(c.oid)
    order by 1`.execute(trx);
  if (rows.length > 0) throw new SnapshotTableRewrittenError(rows.map((r) => r.name));
}

@Injectable()
export class TenantScope {
  private readonly logger = new Logger(TenantScope.name);

  constructor(@Inject(DATABASE) private readonly db: AppDatabase) {}

  /**
   * Runs `fn` in one transaction scoped to an organisation (F.10). `options.snapshot` makes it a REPEATABLE READ, READ
   * ONLY transaction, reading a held snapshot when it is one (Milestone 3 M3-12); callers without options keep READ
   * COMMITTED.
   */
  async withTenant<T>(ctx: TenantContext, fn: (trx: Trx) => Promise<T>, options: TenantTransactionOptions = {}): Promise<T> {
    if (!TENANT_SCHEMA.test(ctx.schema)) throw new Error('bad schema');
    if (!UUID.test(ctx.orgId) || !UUID.test(ctx.userId)) throw new Error('bad tenant context');
    const idle = checkedIdle(options.idleTimeoutSeconds);
    const held = options.snapshot instanceof HeldSnapshot ? options.snapshot : null;
    const requestId = ctx.requestId ?? currentRequestId() ?? randomUUID();
    return this.transaction(async (trx) => {
      // SET TRANSACTION SNAPSHOT must come before the first query of the transaction, set_config included.
      if (held) await held.importInto(trx);
      await sql`select set_config('search_path', ${`"${ctx.schema}", ext`}, true),
                       set_config('app.org_id', ${ctx.orgId}, true),
                       set_config('app.user_id', ${ctx.userId}, true),
                       set_config('app.request_id', ${requestId}, true)`.execute(trx);
      if (idle !== undefined) await sql`select set_config('idle_in_transaction_session_timeout', ${`${idle}s`}, true)`.execute(trx);
      const result = await fn(trx);
      if (held) await assertReadTablesIntact(trx);
      return result;
    }, options.snapshot === true || held !== null);
  }

  /**
   * Holds one snapshot of the database while `fn` runs (Milestone 3 M3-12): a REPEATABLE READ, READ ONLY transaction on
   * a connection of its own exports its snapshot (`pg_export_snapshot()`) and reads no table, so it holds no table lock.
   * `fn` reads in short transactions of its own with `withTenant(ctx, read, { snapshot: held })`, which all see that
   * instant. `idleTimeoutSeconds` (0 to 86400; default: the role's limit) is the holder's
   * `idle_in_transaction_session_timeout`; each import starts its idle timer again, so it bounds the time between two
   * reads. The holder keeps PostgreSQL from removing row versions newer than its snapshot until `fn` ends.
   */
  async holdSnapshot<T>(fn: (snapshot: HeldSnapshot) => Promise<T>, options: Pick<TenantTransactionOptions, 'idleTimeoutSeconds'> = {}): Promise<T> {
    const idle = checkedIdle(options.idleTimeoutSeconds);
    return this.db
      .transaction()
      .setIsolationLevel('repeatable read')
      .setAccessMode('read only')
      .execute(async (holder) => {
        if (idle !== undefined) await sql`select set_config('idle_in_transaction_session_timeout', ${`${idle}s`}, true)`.execute(holder);
        const { rows } = await sql<{ id: string }>`select pg_export_snapshot() as id`.execute(holder);
        const snapshot = new HeldSnapshot(rows[0]!.id, holder);
        try {
          return await fn(snapshot);
        } finally {
          snapshot.end();
        }
      });
  }

  /**
   * Runs `fn` in one transaction with platform scope (F.10, D-31): the organisation-scoped platform tables show
   * every row. Tenant tables stay invisible (no tenant schema, RLS on `app.org_id`).
   */
  async withPlatform<T>(fn: (trx: Trx) => Promise<T>, options: PlatformScopeOptions): Promise<T> {
    if (options.orgId && !UUID.test(options.orgId)) throw new Error('bad organisation id');
    if (options.userId && !UUID.test(options.userId)) throw new Error('bad user id');
    const requestId = options.requestId ?? currentRequestId() ?? randomUUID();
    return this.transaction(async (trx) => {
      await sql`select set_config('app.platform_scope', 'on', true),
                       set_config('app.org_id', ${options.orgId ?? ''}, true),
                       set_config('app.user_id', ${options.userId ?? ''}, true),
                       set_config('app.request_id', ${requestId}, true)`.execute(trx);
      return fn(trx);
    });
  }

  /**
   * A transaction with after-commit hooks (`src/common/transaction-hooks.ts`). `snapshot`: REPEATABLE READ, READ ONLY,
   * both set by the statement that starts the transaction (Kysely sends `start transaction isolation level repeatable
   * read read only`), so they apply before the first query of `fn`.
   */
  private async transaction<T>(fn: (trx: Transaction<DB>) => Promise<T>, snapshot = false): Promise<T> {
    let opened: Transaction<DB> | undefined;
    const builder = snapshot ? this.db.transaction().setIsolationLevel('repeatable read').setAccessMode('read only') : this.db.transaction();
    try {
      const result = await builder.execute(async (trx) => {
        opened = trx;
        openTransactionHooks(trx);
        return fn(trx);
      });
      if (opened) {
        await runAfterCommitHooks(opened, (error) =>
          this.logger.error(`An after-commit hook failed: ${error instanceof Error ? error.message : String(error)}`),
        );
      }
      return result;
    } catch (error) {
      if (opened) discardTransactionHooks(opened);
      throw error;
    }
  }
}
