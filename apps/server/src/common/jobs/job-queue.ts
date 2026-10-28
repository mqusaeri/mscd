// Job queue interface (build plan E.1). WP-08 creates the interface, the token and an in-memory driver for tests;
// WP-22 adds the pg-boss and BullMQ drivers. Producers send inside their business transaction (`trx`), so a job
// is queued only when that transaction commits.
import type { JobName } from '@mscd/shared';
import type { Transaction } from 'kysely';
import type { DB } from '../../db/types';
import type { JobPayloads } from './job-payloads';

export type { JobName } from '@mscd/shared';
export type { JobPayloads } from './job-payloads';

/** What every job carries besides its payload. `orgId` is null for installation-wide jobs. */
export interface JobEnvelope<P> {
  orgId: string | null;
  requestId?: string;
  requestedBy?: string;
  payload: P;
}

export interface SendOptions {
  /** At most one waiting or active job per key (E.2 singleton keys). */
  singletonKey?: string;
  /** Delay before the job may run (debounce, for example `freshness.recompute`). */
  startAfterSeconds?: number;
  /** Retries after a failure (E.2 Retries column). */
  retryLimit?: number;
  priority?: number;
}

/** One run of a job as a handler sees it. */
export interface JobRun<N extends JobName> {
  id: string;
  name: N;
  env: JobEnvelope<JobPayloads[N]>;
  /** 1 for the first run, then 2, 3, ... for retries. */
  attempt: number;
}

export type JobHandlerFn<N extends JobName> = (job: JobRun<N>) => Promise<void>;

export interface QueueStats {
  name: string;
  /** Jobs not yet taken by a worker: due jobs, jobs whose start time is ahead and jobs waiting for a retry. */
  waiting: number;
  active: number;
  failed: number;
  /**
   * Seconds the oldest due job has waited since its start time: the send time plus `startAfterSeconds`, or for a
   * retry the time of the retry. A job whose start time is ahead does not count until it is due; 0 when no job is due.
   * On BullMQ a retry that a worker already moved back to the waiting list keeps no retry time and counts from the
   * start of its failed run, early by the run time and the backoff.
   */
  oldestAgeSeconds: number;
}

export interface JobQueue {
  /**
   * Queues a job. With `trx` the job is queued only when that transaction commits (E.1 transactional send).
   * Resolves to the job id, or null when a job with the same singleton key is already waiting.
   */
  send<N extends JobName>(name: N, env: JobEnvelope<JobPayloads[N]>, opts?: SendOptions, trx?: Transaction<DB>): Promise<string | null>;
  /** Registers a cron schedule (`jobs.schedules_enabled: false` registers none, E.2). */
  schedule(name: JobName, cron: string, env: JobEnvelope<unknown>, tz?: string): Promise<void>;
  /** Starts working on a queue with a handler. */
  work<N extends JobName>(name: N, opts: { concurrency: number }, handler: JobHandlerFn<N>): Promise<void>;
  stats(): Promise<QueueStats[]>;
  stop(): Promise<void>;
}

/** Injection token of the job queue (E.1). */
export const JOB_QUEUE = Symbol.for('mscd.jobQueue');
