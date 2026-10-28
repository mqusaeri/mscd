// What an import commit holds back until all its rows are applied (Milestone 2 D2-13, M2-08).
//
// The commit applies every row in one transaction through the command services (D2-13), and each command writes its
// audit entry and queues its follow-up jobs in that transaction, as it does for a request. Two of those would make
// other people's writes wait for the whole commit, and fail once they wait longer than the `statement_timeout` of the
// application role (30 seconds in Compose and SaaS installs, deploy/compose/config/postgres/10-mscd-bootstrap.sh):
// - the audit chain: the `chain_hash` trigger takes an advisory lock per audit table, so one per organisation, until
//   the transaction ends; the first audit entry of the commit would hold up every audited write of the organisation;
// - the singleton keys of `freshness.recompute`, `readiness.recompute` and `cycle.derive` (`fr:`, `rr:` and `cd:`, one
//   per system): pg-boss keeps one waiting job per key with a unique index, so another transaction that queues the same
//   key waits until the commit ends.
// While `ImportHold.run` runs, the audit writer of the imports module keeps each entry of the commit's transaction as
// the row the chain writer would insert, and the module's job queue keeps those three jobs, one per job and system.
// When every row is in, still in the same transaction, the jobs are queued once per system under keys of the import
// (`<key>:import:<id>`; freshness for the whole system, since one key keeps only the first command's record ids) and
// the entries are written in order with multi-row inserts. The chain lock is then held only from those inserts to the
// commit. When a row fails, the transaction rolls back and nothing held is written.
import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import { isIP } from 'node:net';
import { Inject, Injectable, Module } from '@nestjs/common';
import { isPlatformAuditAction, type JobName } from '@mscd/shared';
import { sql, type Insertable, type Transaction } from 'kysely';
import { redactAuditData } from '../../common/audit-redaction';
import { JOB_QUEUE, type JobEnvelope, type JobPayloads, type JobQueue, type SendOptions } from '../../common/jobs/job-queue';
import { currentRequestContext, runWithRequestContext, type RequestContextData } from '../../common/request-context';
import { AUDIT_WRITER, SYSTEM_USER_ID, type AuditEntryInput, type AuditWriter, type RecordedAuditEntry, type Trx } from '../../common/tokens';
import type { DB } from '../../db/types';
import type { AuditTrailTable } from '../../db/types/tenant-core';
import { EDITION_COLUMN_LENGTH, changedFields } from '../audit/audit-writer';

/** The application's audit writer, under a token the imports module does not provide itself. */
export const CHAIN_AUDIT_WRITER = Symbol.for('mscd.imports.chainAuditWriter');
/** The application's job queue, under a token the imports module does not provide itself. */
export const SHARED_JOB_QUEUE = Symbol.for('mscd.imports.sharedJobQueue');

/**
 * Gives the imports module the application's audit writer and job queue. The imports module provides its own
 * `AUDIT_WRITER` and `JOB_QUEUE`; this module provides neither, so `useExisting` finds the global ones.
 */
@Module({
  providers: [
    { provide: CHAIN_AUDIT_WRITER, useExisting: AUDIT_WRITER },
    { provide: SHARED_JOB_QUEUE, useExisting: JOB_QUEUE },
  ],
  exports: [CHAIN_AUDIT_WRITER, SHARED_JOB_QUEUE],
})
export class ImportSharedModule {}

/** Jobs the commands queue per system that a commit queues once per system at its end instead. */
export const HELD_JOBS: readonly JobName[] = ['freshness.recompute', 'readiness.recompute', 'cycle.derive'];

/** Rows per insert of the held entries: 14 values a row stay far below the 65,535 parameters of a statement. */
export const AUDIT_ROWS_PER_INSERT = 1000;

type AuditRow = Insertable<AuditTrailTable> & { id: string };

interface HeldJob {
  name: JobName;
  env: JobEnvelope<unknown>;
  opts: SendOptions;
  msId: string;
}

interface Held {
  trx: Trx;
  importId: string;
  /** Tenant entries as the rows the chain writer would insert, in the order they were recorded. */
  rows: AuditRow[];
  /** Platform entries (none of the import's commands writes one today), with the request context they had. */
  platform: { entry: AuditEntryInput; context: RequestContextData | undefined }[];
  /** One job per job name and system, the first one sent. */
  jobs: Map<string, HeldJob>;
  editions: Map<string, Promise<string | null>>;
  slugs: Map<string, Promise<string | null>>;
}

/** Nest lifecycle hooks a stand-in never forwards, so the global provider's hooks run once. */
const LIFECYCLE_HOOKS = new Set<PropertyKey>(['onModuleInit', 'onApplicationBootstrap', 'onModuleDestroy', 'beforeApplicationShutdown', 'onApplicationShutdown']);

/** `target` with some members replaced; every other member is the target's own (methods bound to the target). */
function withOverrides<T extends object>(target: T, overrides: Partial<T>): T {
  return new Proxy(target, {
    get(t, prop) {
      if (Object.prototype.hasOwnProperty.call(overrides, prop)) return (overrides as Record<PropertyKey, unknown>)[prop];
      if (LIFECYCLE_HOOKS.has(prop)) return undefined;
      const value: unknown = Reflect.get(t, prop);
      return typeof value === 'function' ? (value as (...args: unknown[]) => unknown).bind(t) : value;
    },
  });
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function cut(value: string | null | undefined, length: number): string | null {
  if (value === null || value === undefined || value === '') return null;
  return value.length > length ? value.slice(0, length) : value;
}

function uuidOrNull(value: string | null | undefined): string | null {
  return value && UUID.test(value) ? value : null;
}

function cached(map: Map<string, Promise<string | null>>, key: string, load: () => Promise<string | null>): Promise<string | null> {
  let value = map.get(key);
  if (!value) {
    value = load();
    map.set(key, value);
  }
  return value;
}

@Injectable()
export class ImportHold {
  private readonly store = new AsyncLocalStorage<Held>();
  /** The audit writer of the module's services: an entry of a held transaction waits for the end of `run`. */
  readonly auditWriter: AuditWriter;
  /** The job queue of the module's services: a job of HELD_JOBS sent in a held transaction waits for the end of `run`. */
  readonly jobQueue: JobQueue;

  constructor(
    @Inject(CHAIN_AUDIT_WRITER) private readonly writer: AuditWriter,
    @Inject(SHARED_JOB_QUEUE) private readonly queue: JobQueue,
  ) {
    this.auditWriter = withOverrides<AuditWriter>(writer, { record: (trx, entry) => this.record(trx, entry) });
    this.jobQueue = withOverrides<JobQueue>(queue, {
      send: <N extends JobName>(name: N, env: JobEnvelope<JobPayloads[N]>, opts?: SendOptions, trx?: Transaction<DB>) => this.send(name, env, opts, trx),
    });
  }

  /**
   * Runs `fn` (the rows of one import) with the audit entries and the jobs of HELD_JOBS that it writes in `trx` held
   * back; then, in `trx`, queues the jobs once per system and writes the entries in order. The caller commits `trx`.
   */
  async run<T>(trx: Trx, importId: string, fn: () => Promise<T>): Promise<T> {
    const held: Held = { trx, importId, rows: [], platform: [], jobs: new Map(), editions: new Map(), slugs: new Map() };
    const result = await this.store.run(held, fn);
    await this.release(held);
    return result;
  }

  private heldFor(trx: unknown): Held | undefined {
    const held = this.store.getStore();
    return held && held.trx === trx ? held : undefined;
  }

  private async record(trx: Trx, entry: AuditEntryInput): Promise<RecordedAuditEntry> {
    const held = this.heldFor(trx);
    if (!held) return this.writer.record(trx, entry);
    if (isPlatformAuditAction(entry.action)) {
      const context = currentRequestContext();
      held.platform.push({ entry, context: context ? { ...context } : undefined });
      return { chain: 'platform', id: '', seq: '' };
    }
    const row = await this.rowOf(held, entry);
    held.rows.push(row);
    // The chain numbers the entry when it is written, at the end of the commit; no caller reads the number.
    return { chain: 'tenant', id: row.id, seq: '' };
  }

  /**
   * The row `ChainedAuditWriter.record` inserts for a tenant entry (audit/audit-writer.ts), built when the entry is
   * recorded, so it carries the request context and the values of that moment. `occurred_at` and `organization_id`
   * come from the column defaults, which are the same anywhere in the transaction.
   */
  private async rowOf(held: Held, entry: AuditEntryInput): Promise<AuditRow> {
    const context = currentRequestContext();
    const actor = entry.actor ?? (context?.userId ? { userId: context.userId, kind: context.actorKind ?? 'user' } : { userId: SYSTEM_USER_ID, kind: 'system' as const });
    const ip = entry.sourceIp !== undefined ? entry.sourceIp : (context?.ip ?? null);
    let before = entry.before ?? null;
    let after = entry.after ?? null;
    if (before && after) ({ before, after } = changedFields(before, after));
    const slug = entry.msId === undefined ? entry.msSlug : null;
    const msId = slug ? await cached(held.slugs, slug, () => this.msIdOfSlug(held.trx, slug)) : uuidOrNull(entry.msId);
    const edition = entry.edition !== undefined ? entry.edition : msId ? await cached(held.editions, msId, () => this.editionOf(held.trx, msId)) : null;
    return {
      id: randomUUID(),
      management_system_id: msId,
      actor_user_id: uuidOrNull(actor.userId),
      actor_kind: actor.kind,
      action: entry.action,
      entity_type: cut(entry.entityType, 40),
      entity_id: uuidOrNull(entry.entityId),
      entity_code: cut(entry.entityCode, 80),
      before_data: before ? JSON.stringify(redactAuditData(before)) : null,
      after_data: after ? JSON.stringify(redactAuditData(after)) : null,
      edition: cut(edition, EDITION_COLUMN_LENGTH),
      request_id: cut(entry.requestId !== undefined ? entry.requestId : (context?.requestId ?? null), 64),
      source_ip: ip && isIP(ip) ? ip : null,
      user_agent: cut(entry.userAgent !== undefined ? entry.userAgent : (context?.userAgent ?? null), 1000),
    };
  }

  private async send<N extends JobName>(name: N, env: JobEnvelope<JobPayloads[N]>, opts: SendOptions = {}, trx?: Transaction<DB>): Promise<string | null> {
    const held = trx ? this.heldFor(trx) : undefined;
    const msId = (env.payload as { msId?: unknown } | null | undefined)?.msId;
    if (!held || !HELD_JOBS.includes(name) || typeof msId !== 'string') return this.queue.send(name, env, opts, trx);
    const key = `${name} ${msId}`;
    if (!held.jobs.has(key)) held.jobs.set(key, { name, env: env as JobEnvelope<unknown>, opts, msId });
    return null;
  }

  /** The end of `run`: the held jobs and entries go into the commit's transaction. */
  private async release(held: Held): Promise<void> {
    for (const job of held.jobs.values()) {
      const singletonKey = `${job.opts.singletonKey ?? `${job.name}:${job.msId}`}:import:${held.importId}`;
      const env = { ...job.env, payload: { msId: job.msId } } as JobEnvelope<JobPayloads[typeof job.name]>;
      await this.queue.send(job.name, env, { ...job.opts, singletonKey }, held.trx);
    }
    for (const { entry, context } of held.platform) {
      await (context ? runWithRequestContext(context, () => this.writer.record(held.trx, entry)) : this.writer.record(held.trx, entry));
    }
    for (let i = 0; i < held.rows.length; i += AUDIT_ROWS_PER_INSERT) {
      await held.trx.insertInto('audit_trail').values(held.rows.slice(i, i + AUDIT_ROWS_PER_INSERT)).execute();
    }
  }

  /** `management_system.id` of a slug in the transaction's organisation (as the chain writer looks it up). */
  private async msIdOfSlug(trx: Trx, slug: string): Promise<string | null> {
    const row = await trx.selectFrom('management_system').select('id').where('slug', '=', slug).where('deleted_at', 'is', null).executeTakeFirst();
    return row?.id ?? null;
  }

  /** `<pack_id> <version>` of the system's active edition and of a transition target (as the chain writer reads it). */
  private async editionOf(trx: Trx, msId: string): Promise<string | null> {
    const { rows } = await sql<{ edition: string | null }>`
      select string_agg(fv.pack_id || ' ' || fv.pack_version, ', '
                        order by case when fv.id = ms.framework_version_id then 0 else 1 end) as edition
      from management_system ms
      join ref.framework_version fv on fv.id in (ms.framework_version_id, ms.transition_target_version_id)
      where ms.id = ${msId}`.execute(trx);
    return rows[0]?.edition ?? null;
  }
}
