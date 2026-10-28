// BullMQ driver of the job queue on Valkey (build plan E.1, `jobs.driver: bullmq`). A send inside a business
// transaction inserts a row into `platform.job_outbox` in that transaction; the outbox relay (running in the api and
// the worker, `OutboxRelay`) moves committed rows to BullMQ every 500 ms with the job id `ob-<row id>`, so a row
// that is relayed twice still makes one job. A send without a transaction goes to BullMQ directly.
//
// Singleton keys use BullMQ deduplication (simple mode): a job with the same key is dropped while one is waiting,
// delayed, active or retrying, which is the E.1 contract.
import { randomUUID } from 'node:crypto';
import { Logger } from '@nestjs/common';
import { JOB_NAMES, type JobName } from '@mscd/shared';
import { Queue, Worker, type ConnectionOptions, type JobsOptions } from 'bullmq';
import { sql, type Transaction } from 'kysely';
import type { DB } from '../../db/types';
import { cronRetryLimit } from './schedules';
import { acceptsAfterCommit, afterCommit } from '../../common/transaction-hooks';
import type { JobEnvelope, JobHandlerFn, JobPayloads, JobQueue, QueueStats, SendOptions } from '../../common/jobs/job-queue';

const KNOWN_JOBS: ReadonlySet<string> = new Set(JOB_NAMES);

/** Key prefix of every BullMQ structure in Valkey. */
export const BULLMQ_PREFIX = 'mscd';

/** Rows the relay moves per pass (E.1). */
export const OUTBOX_BATCH = 100;

/**
 * Failed relay attempts after which an outbox row counts as stuck: it is logged once at error level and counted by
 * `countStuckOutboxRows` (metric `mscd_job_outbox_stuck_rows`, WP-34). A row whose failure is transient (a Valkey
 * error such as OOM, READONLY or NOAUTH) keeps being retried every `OUTBOX_MAX_BACKOFF_SECONDS`, so it is relayed
 * as soon as Valkey recovers, however long the outage lasts.
 */
export const OUTBOX_STUCK_ATTEMPTS = 12;

/**
 * `attempts` value of a parked row (the largest `smallint`). Only permanent failures park a row (a job name this build does not know, for
 * example after a rollback): the relay never takes it again and logs it once at error level. Parked rows stay for
 * diagnosis (cleanup removes relayed rows only); an operator who fixed the cause runs
 * `UPDATE platform.job_outbox SET attempts = 0, run_at = now() WHERE dispatched_at IS NULL AND attempts >= 12`.
 */
export const OUTBOX_PARKED_ATTEMPTS = 32_767;

/** Longest wait between two relay attempts of a failing row. */
export const OUTBOX_MAX_BACKOFF_SECONDS = 600;

/** Entries of the waiting list and of the prioritized set read per queue to find the oldest due job (`oldestDueAt`). */
const DUE_SCAN_LIMIT = 1000;

/** BullMQ scores its delayed set with the start time in ms times 0x1000 plus a sequence number (`getDelayedScore.lua`). */
const DELAYED_SCORE_FACTOR = 0x1000;

/**
 * Start time in ms of a waiting or prioritized BullMQ job from the `timestamp`, `opts` and `processedOn` fields of its
 * hash (see `oldestDueAt`), or null when the hash is gone (the job finished or was removed meanwhile).
 */
function startTimeOf(timestamp: string | null, opts: string | null, processedOn: string | null): number | null {
  const queuedAt = timestamp === null ? Number.NaN : Number(timestamp);
  if (!Number.isFinite(queuedAt)) return null;
  let delay = 0;
  try {
    delay = Number((JSON.parse(opts ?? '{}') as { delay?: unknown }).delay ?? 0);
  } catch {
    delay = 0;
  }
  const lastRunAt = processedOn === null ? 0 : Number(processedOn);
  return Math.max(queuedAt + (Number.isFinite(delay) && delay > 0 ? delay : 0), Number.isFinite(lastRunAt) ? lastRunAt : 0);
}

/** Seconds before the next relay attempt of a row that has failed `attempts` times: 2, 4, 8, ... up to 600. */
export function outboxBackoffSeconds(attempts: number): number {
  return Math.min(OUTBOX_MAX_BACKOFF_SECONDS, 2 ** Math.max(1, Math.min(attempts, 20)));
}

/** Outbox rows that are parked or failed at least `OUTBOX_STUCK_ATTEMPTS` times (any driver; zero unless BullMQ). */
export async function countStuckOutboxRows(trx: Transaction<DB>): Promise<{ rows: number; oldestCreatedAt: Date | null }> {
  const row = await trx
    .selectFrom('platform.job_outbox')
    .select((eb) => [eb.fn.countAll<string>().as('rows'), eb.fn.min('created_at').as('oldest')])
    .where('dispatched_at', 'is', null)
    .where('attempts', '>=', OUTBOX_STUCK_ATTEMPTS)
    .executeTakeFirst();
  return { rows: Number(row?.rows ?? 0), oldestCreatedAt: (row?.oldest as Date | null | undefined) ?? null };
}

/** What an outbox row's `payload` holds. */
export interface OutboxPayload {
  env: JobEnvelope<unknown>;
  retryLimit: number;
  priority: number;
}

export interface BullMqJobQueueOptions {
  /** `jobs.bullmq.url` (redis:// or rediss://). */
  url: string;
  prefix?: string;
}

/** Connection options for ioredis from a redis URL; workers need `maxRetriesPerRequest: null`. */
export function redisConnection(url: string): ConnectionOptions {
  const parsed = new URL(url);
  const dbIndex = parsed.pathname.replace(/^\//, '');
  return {
    host: parsed.hostname,
    port: Number(parsed.port || 6379),
    ...(parsed.username ? { username: decodeURIComponent(parsed.username) } : {}),
    ...(parsed.password ? { password: decodeURIComponent(parsed.password) } : {}),
    ...(dbIndex ? { db: Number(dbIndex) } : {}),
    ...(parsed.protocol === 'rediss:' ? { tls: {} } : {}),
    maxRetriesPerRequest: null,
  };
}

export class BullMqJobQueue implements JobQueue {
  private readonly logger = new Logger('BullMqJobQueue');
  private readonly connection: ConnectionOptions;
  private readonly prefix: string;
  private readonly queues = new Map<string, Queue>();
  private readonly workers = new Map<string, Worker>();
  private stopped = false;
  private readonly committedListeners = new Set<() => void>();

  constructor(options: BullMqJobQueueOptions) {
    this.connection = redisConnection(options.url);
    this.prefix = options.prefix ?? BULLMQ_PREFIX;
  }

  /** Called after a transaction that wrote outbox rows commits (the relay of this process picks them up at once). */
  onOutboxCommitted(listener: () => void): () => void {
    this.committedListeners.add(listener);
    return () => this.committedListeners.delete(listener);
  }

  async send<N extends JobName>(name: N, env: JobEnvelope<JobPayloads[N]>, opts: SendOptions = {}, trx?: Transaction<DB>): Promise<string | null> {
    if (!KNOWN_JOBS.has(name)) throw new Error(`Unknown job ${name}`);
    if (this.stopped) throw new Error('The job queue is stopped');
    if (trx) {
      const payload: OutboxPayload = { env: env as JobEnvelope<unknown>, retryLimit: Math.max(0, opts.retryLimit ?? 0), priority: opts.priority ?? 0 };
      const delay = Math.max(0, opts.startAfterSeconds ?? 0);
      const row = await trx
        .insertInto('platform.job_outbox')
        .values({
          queue: name,
          payload: JSON.stringify(payload),
          singleton_key: opts.singletonKey ?? null,
          run_at: sql<Date>`now() + ${delay} * interval '1 second'`,
        })
        .returning('id')
        .executeTakeFirstOrThrow();
      if (acceptsAfterCommit(trx)) {
        afterCommit(trx, () => {
          for (const listener of this.committedListeners) listener();
        });
      }
      return `ob-${row.id}`;
    }
    const id = randomUUID();
    const job = await this.queue(name).add(name, env, this.jobOptions(id, opts.singletonKey, (opts.startAfterSeconds ?? 0) * 1000, opts.retryLimit ?? 0, opts.priority ?? 0));
    return job.id === id ? id : null;
  }

  async schedule(name: JobName, cron: string, env: JobEnvelope<unknown>, tz?: string): Promise<void> {
    if (!KNOWN_JOBS.has(name)) throw new Error(`Unknown job ${name}`);
    await this.queue(name).upsertJobScheduler(
      `cron:${name}`,
      { pattern: cron, ...(tz ? { tz } : {}) },
      { name, data: env, opts: { attempts: cronRetryLimit(name) + 1, backoff: { type: 'exponential', delay: 1000 }, removeOnComplete: { age: 86_400, count: 1000 }, removeOnFail: { age: 7 * 86_400 } } },
    );
  }

  async work<N extends JobName>(name: N, opts: { concurrency: number }, handler: JobHandlerFn<N>): Promise<void> {
    if (!KNOWN_JOBS.has(name)) throw new Error(`Unknown job ${name}`);
    if (this.workers.has(name)) throw new Error(`A worker for ${name} is already registered`);
    const worker = new Worker(
      name,
      async (job) => {
        await handler({ id: String(job.id), name, env: job.data as JobEnvelope<JobPayloads[N]>, attempt: job.attemptsMade + 1 });
      },
      { connection: this.connection, prefix: this.prefix, concurrency: Math.max(1, Math.trunc(opts.concurrency)) },
    );
    worker.on('error', (error) => this.logger.error(`BullMQ worker ${name}: ${error.message}`));
    this.workers.set(name, worker);
    await worker.waitUntilReady();
  }

  async stats(): Promise<QueueStats[]> {
    const out: QueueStats[] = [];
    for (const name of JOB_NAMES) {
      const queue = this.queue(name);
      const counts = await queue.getJobCounts('waiting', 'delayed', 'prioritized', 'active', 'failed');
      // `waiting` counts every job not yet taken, also those whose start time is ahead (the delayed set).
      const waiting = (counts.waiting ?? 0) + (counts.delayed ?? 0) + (counts.prioritized ?? 0);
      const active = counts.active ?? 0;
      const failed = counts.failed ?? 0;
      if (waiting === 0 && active === 0 && failed === 0 && !this.workers.has(name)) continue;
      const now = Date.now();
      const dueAt = waiting > 0 ? await this.oldestDueAt(queue, now) : null;
      out.push({
        name,
        waiting,
        active,
        failed,
        oldestAgeSeconds: dueAt === null ? 0 : Math.max(0, Math.floor((now - dueAt) / 1000)),
      });
    }
    return out;
  }

  /**
   * Start time in ms of the oldest due job of a queue, or null when no job is due. BullMQ keeps a job that no worker
   * has taken in the delayed set, the waiting list or the prioritized set:
   * - The delayed set holds jobs queued with a start delay and retries waiting for their backoff, ordered by start
   *   time (its score). A worker moves due jobs from it to the waiting list only when it fetches its next job, so
   *   while no worker takes jobs a due job stays there: the first entry counts once its start time has passed.
   * - The waiting list (ordered by the time a job entered it) and the prioritized set (ordered by priority, then by
   *   the order of adding) hold jobs that are due, in no order of start time, so up to `DUE_SCAN_LIMIT` entries of
   *   each are read: the waiting list from the job that entered it first, the prioritized set from its highest
   *   priority down. Past `DUE_SCAN_LIMIT` prioritized jobs the lowest-priority ones, which may have waited longest,
   *   are not seen (no caller sets a priority yet).
   * - A job's start time is `timestamp + opts.delay`: BullMQ sets the job's own `delay` field to 0 when the job
   *   leaves the delayed set, while its options keep the delay it was queued with. A job that has run before (a
   *   retry, or a job moved back after its worker stopped) keeps no retry time once it left the delayed set; it
   *   counts from the start of its last run (`processedOn`), earlier than the retry time by the run time and the
   *   backoff.
   */
  private async oldestDueAt(queue: Queue, now: number): Promise<number | null> {
    const client = await queue.client;
    let oldest = Number.POSITIVE_INFINITY;
    const delayedKey = queue.keys.delayed;
    if (delayedKey) {
      const [, score] = await client.zrange(delayedKey, 0, 0, { WITHSCORES: true });
      const startAt = score === undefined ? Number.NaN : Math.floor(Number(score) / DELAYED_SCORE_FACTOR);
      if (startAt <= now) oldest = startAt;
    }
    const ids = await queue.getRanges(['wait', 'paused', 'prioritized'], 0, DUE_SCAN_LIMIT - 1, true);
    const fields = await Promise.all(ids.map((id) => client.hmget(queue.toKey(id), 'timestamp', 'opts', 'processedOn')));
    for (const [timestamp, opts, processedOn] of fields) {
      const startAt = startTimeOf(timestamp, opts, processedOn);
      if (startAt !== null && startAt < oldest) oldest = startAt;
    }
    return Number.isFinite(oldest) ? Math.min(oldest, now) : null;
  }

  async stop(): Promise<void> {
    this.stopped = true;
    await Promise.allSettled([...this.workers.values()].map((w) => w.close()));
    this.workers.clear();
    await Promise.allSettled([...this.queues.values()].map((q) => q.close()));
    this.queues.clear();
  }

  /**
   * One relay pass (E.1): moves up to `OUTBOX_BATCH` committed outbox rows to BullMQ inside `trx` (a platform-scope
   * transaction of the caller), locking them with `FOR UPDATE SKIP LOCKED` so relays in other processes take other
   * rows. Rows that keep failing (for example a job name this build does not know, after a rollback) never block
   * newer jobs: rows are taken by fewest attempts first; a failed row waits `outboxBackoffSeconds(attempts)` before
   * its next attempt (its `run_at` moves forward, never back, so a delayed job never runs early). A permanent failure
   * (unknown job name) parks the row at once; a transient one is retried at most every `OUTBOX_MAX_BACKOFF_SECONDS`
   * and reported once at error level when it reaches `OUTBOX_STUCK_ATTEMPTS`. Returns the number of rows dispatched.
   */
  async relayOutbox(trx: Transaction<DB>): Promise<number> {
    if (this.stopped) return 0;
    const { rows } = await sql<{ id: string; attempts: number; queue: string; payload: OutboxPayload; singleton_key: string | null; delay_ms: string }>`
      SELECT id, attempts, queue, payload, singleton_key,
             greatest(0, ceil(extract(epoch FROM (run_at - now())) * 1000))::bigint AS delay_ms
        FROM platform.job_outbox
       WHERE dispatched_at IS NULL
         AND attempts < ${OUTBOX_PARKED_ATTEMPTS}
         AND (attempts = 0 OR run_at <= now())
       ORDER BY attempts, id
       LIMIT ${OUTBOX_BATCH}
         FOR UPDATE SKIP LOCKED`.execute(trx);
    let dispatched = 0;
    for (const row of rows) {
      const permanent = !KNOWN_JOBS.has(row.queue);
      try {
        if (permanent) throw new Error(`Unknown job ${row.queue}`);
        const payload = row.payload;
        await this.queue(row.queue).add(
          row.queue,
          payload.env,
          this.jobOptions(`ob-${row.id}`, row.singleton_key ?? undefined, Number(row.delay_ms), payload.retryLimit, payload.priority),
        );
        await trx.updateTable('platform.job_outbox').set({ dispatched_at: sql<Date>`now()`, attempts: sql<number>`attempts + 1`, last_error: null }).where('id', '=', row.id).execute();
        dispatched += 1;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const attempts = Number(row.attempts) + 1;
        const backoff = outboxBackoffSeconds(attempts);
        if (permanent) {
          this.logger.error(
            { event: 'job_outbox.stuck', outboxId: row.id, queue: row.queue, attempts, parked: true, lastError: message.slice(0, 500) },
            `Outbox row ${row.id} (${row.queue}) parked after a permanent relay failure; it is no longer relayed (set attempts = 0, run_at = now() to retry): ${message}`,
          );
        } else if (attempts === OUTBOX_STUCK_ATTEMPTS) {
          this.logger.error(
            { event: 'job_outbox.stuck', outboxId: row.id, queue: row.queue, attempts, parked: false, lastError: message.slice(0, 500) },
            `Outbox row ${row.id} (${row.queue}) stuck after ${attempts} failed relay attempts; still retried every ${OUTBOX_MAX_BACKOFF_SECONDS} s: ${message}`,
          );
        } else {
          this.logger.warn(`Outbox row ${row.id} (${row.queue}) not relayed after ${attempts} attempt(s), next attempt in ${backoff} s: ${message}`);
        }
        await trx
          .updateTable('platform.job_outbox')
          .set({
            attempts: permanent ? OUTBOX_PARKED_ATTEMPTS : sql<number>`least(attempts + 1, ${OUTBOX_PARKED_ATTEMPTS - 1})`,
            last_error: message.slice(0, 2000),
            run_at: sql<Date>`greatest(run_at, now() + ${backoff} * interval '1 second')`,
          })
          .where('id', '=', row.id)
          .execute();
      }
    }
    return dispatched;
  }

  /** The BullMQ queue of a job name (created on first use). */
  queue(name: string): Queue {
    let queue = this.queues.get(name);
    if (!queue) {
      queue = new Queue(name, { connection: this.connection, prefix: this.prefix });
      queue.on('error', (error) => this.logger.error(`BullMQ queue ${name}: ${error.message}`));
      this.queues.set(name, queue);
    }
    return queue;
  }

  private jobOptions(jobId: string, singletonKey: string | undefined, delayMs: number, retryLimit: number, priority: number): JobsOptions {
    return {
      jobId,
      ...(singletonKey ? { deduplication: { id: singletonKey } } : {}),
      ...(delayMs > 0 ? { delay: Math.ceil(delayMs) } : {}),
      attempts: Math.max(0, retryLimit) + 1,
      backoff: { type: 'exponential', delay: 1000 },
      // BullMQ priorities run lowest first; E.1 priorities run highest first. 0 means "no priority".
      ...(priority > 0 ? { priority: Math.max(1, 2_097_152 - priority) } : {}),
      // Kept for a day so a relayed row seen twice finds its job id (no duplicate), then removed.
      removeOnComplete: { age: 86_400, count: 10_000 },
      removeOnFail: { age: 7 * 86_400 },
    };
  }
}
