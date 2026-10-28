// Queue age of `JobQueue.stats()` on the pg-boss and BullMQ drivers (M2-S08 follow-up, metric
// `mscd_queue_oldest_age_seconds`): the age counts from the start time of the jobs that are due. A job queued to start
// later counts 0 until its start time, a due job counts from its start time (the time it was queued plays no part),
// and a retry counts from its retry time. `waiting` still counts every job not yet taken. Times in the past are written
// into the pg-boss job table, or given to BullMQ as the `timestamp` of a job, so no test waits for hours.
import { randomBytes } from 'node:crypto';
import type { JobName } from '@mscd/shared';
import { Worker } from 'bullmq';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { JobQueue, QueueStats } from '../../../src/common/jobs/job-queue';
import { BullMqJobQueue, redisConnection } from '../../../src/modules/jobs/bullmq-job-queue';
import { PgBossJobQueue } from '../../../src/modules/jobs/pgboss-job-queue';
import { ensurePgBossSchema } from '../../../src/modules/jobs/pgboss-schema';
import { useTestDatabase } from '../../setup/test-db';
import { startValkey, type StartedValkey } from './helpers';

const ENV = { orgId: null, payload: {} };
const HOUR_MS = 3_600_000;

async function statOf(queue: JobQueue, name: JobName): Promise<QueueStats | undefined> {
  return (await queue.stats()).find((s) => s.name === name);
}

describe('queue age from the start time of due jobs (M2-S08 follow-up)', () => {
  const db = useTestDatabase('empty');
  let valkey: StartedValkey | undefined;

  beforeAll(async () => {
    await ensurePgBossSchema(db.urls.migrator);
    valkey = await startValkey();
  }, 180_000);
  afterAll(async () => {
    await valkey?.stop();
  });

  describe('pg-boss driver', () => {
    let queue: PgBossJobQueue;

    /** Moves the queue time and the start time of a job (seconds relative to now; negative is in the past). */
    async function setTimes(id: string, times: { createdIn?: number; startIn?: number }): Promise<void> {
      await sql`
        UPDATE pgboss.job
           SET created_on = coalesce(now() + ${times.createdIn ?? null}::int * interval '1 second', created_on),
               start_after = coalesce(now() + ${times.startIn ?? null}::int * interval '1 second', start_after)
         WHERE id = ${id}::uuid`.execute(db.app);
    }

    beforeAll(() => {
      // No supervisor and no worker: the jobs stay where the tests put them.
      queue = new PgBossJobQueue({ connectionString: db.urls.app });
    });
    afterAll(async () => {
      await queue?.stop();
    });

    it('counts a job queued to start later as 0 until its start time', async () => {
      // Queued two hours ago to start in an hour: counted from the time it was queued, the age would be two hours.
      const id = (await queue.send('drift.evaluate', ENV, { startAfterSeconds: 3600 }))!;
      await setTimes(id, { createdIn: -7200 });
      expect(await statOf(queue, 'drift.evaluate')).toMatchObject({ waiting: 1, active: 0, oldestAgeSeconds: 0 });
      // Ten seconds before its start time it still counts 0; ten seconds after it counts those ten seconds.
      await setTimes(id, { startIn: 10 });
      expect(await statOf(queue, 'drift.evaluate')).toMatchObject({ waiting: 1, active: 0, oldestAgeSeconds: 0 });
      await setTimes(id, { startIn: -10 });
      const stat = await statOf(queue, 'drift.evaluate');
      expect(stat).toMatchObject({ waiting: 1, active: 0 });
      expect(stat!.oldestAgeSeconds).toBeGreaterThanOrEqual(10);
      expect(stat!.oldestAgeSeconds).toBeLessThan(40);
    });

    it('counts a due job from its start time, while the time it was queued plays no part', async () => {
      // Queued two hours ago to start ten minutes ago (a daily job of scheduler.tick whose start time has come).
      const planned = (await queue.send('cycle.derive', ENV, { startAfterSeconds: 3600 }))!;
      await setTimes(planned, { createdIn: -7200, startIn: -600 });
      // A job queued a minute ago without a delay, and one queued two hours ago that starts in ten minutes.
      const recent = (await queue.send('cycle.derive', ENV))!;
      await setTimes(recent, { createdIn: -60, startIn: -60 });
      const later = (await queue.send('cycle.derive', ENV, { startAfterSeconds: 600 }))!;
      await setTimes(later, { createdIn: -7200 });
      const stat = await statOf(queue, 'cycle.derive');
      expect(stat).toMatchObject({ waiting: 3, active: 0 });
      expect(stat!.oldestAgeSeconds).toBeGreaterThanOrEqual(600);
      expect(stat!.oldestAgeSeconds).toBeLessThan(630);
    });

    it('counts a retry from its retry time', async () => {
      const id = (await queue.send('integrity.rehash', ENV, { retryLimit: 1 }))!;
      await setTimes(id, { createdIn: -7200, startIn: -7200 });
      const [job] = await queue.instance.fetch('integrity.rehash');
      expect(job?.id).toBe(id);
      await queue.instance.fail('integrity.rehash', id, { message: 'first attempt fails' });
      const { rows } = await sql<{ state: string; waits: boolean }>`
        SELECT state::text AS state, start_after > now() AS waits FROM pgboss.job WHERE id = ${id}::uuid`.execute(db.app);
      // pg-boss keeps the failed job as a retry whose start time is the failure time plus the backoff.
      expect(rows[0]).toEqual({ state: 'retry', waits: true });
      // A long backoff: the retry waits and does not count.
      await setTimes(id, { startIn: 3600 });
      expect(await statOf(queue, 'integrity.rehash')).toMatchObject({ waiting: 1, active: 0, oldestAgeSeconds: 0 });
      // The retry time came 90 seconds ago and the age counts from it; the queue time would give two hours.
      await setTimes(id, { startIn: -90 });
      const stat = await statOf(queue, 'integrity.rehash');
      expect(stat).toMatchObject({ waiting: 1, active: 0 });
      expect(stat!.oldestAgeSeconds).toBeGreaterThanOrEqual(90);
      expect(stat!.oldestAgeSeconds).toBeLessThan(120);
    });
  });

  describe('BullMQ driver', () => {
    let queue: BullMqJobQueue;
    let prefix: string;

    beforeAll(() => {
      prefix = `t${randomBytes(4).toString('hex')}`;
      queue = new BullMqJobQueue({ url: valkey!.url, prefix });
    });
    afterAll(async () => {
      await queue?.stop();
    });

    it('counts a job queued to start later as 0 until its start time', async () => {
      await queue.send('drift.evaluate', ENV, { startAfterSeconds: 3600 });
      expect(await statOf(queue, 'drift.evaluate')).toMatchObject({ waiting: 1, active: 0, oldestAgeSeconds: 0 });
      // Queued two hours ago to start in an hour: its start time, not the time it was queued, decides. Read by its
      // queue time (the `timestamp` of the job), the age would be two hours.
      const bull = queue.queue('drift.evaluate');
      const later = await bull.add('drift.evaluate', ENV, { jobId: 'later', timestamp: Date.now() - 2 * HOUR_MS, delay: 3 * HOUR_MS });
      expect(await later.getState()).toBe('delayed');
      expect(await statOf(queue, 'drift.evaluate')).toMatchObject({ waiting: 2, active: 0, oldestAgeSeconds: 0 });
    });

    it('counts a due job from its start time, in the delayed set and after a worker moved it to the waiting list', async () => {
      const bull = queue.queue('cycle.derive');
      const now = Date.now();
      // Queued two hours ago to start ten minutes ago. No worker runs, so the job stays in the delayed set.
      const planned = await bull.add('cycle.derive', ENV, { jobId: 'planned', timestamp: now - 2 * HOUR_MS, delay: 2 * HOUR_MS - 600_000 });
      let stat = await statOf(queue, 'cycle.derive');
      expect(stat).toMatchObject({ waiting: 1, active: 0 });
      expect(stat!.oldestAgeSeconds).toBeGreaterThanOrEqual(600);
      expect(stat!.oldestAgeSeconds).toBeLessThan(630);
      // A job queued a minute ago without a delay enters the waiting list first; then the planned job is moved there,
      // as a worker does when it fetches its next job (BullMQ sets the job's delay field to 0).
      await bull.add('cycle.derive', ENV, { jobId: 'recent', timestamp: now - 60_000 });
      await planned.promote();
      expect(await bull.getJobCounts('wait', 'delayed')).toMatchObject({ wait: 2, delayed: 0 });
      expect((await bull.getJob('planned'))?.delay).toBe(0);
      stat = await statOf(queue, 'cycle.derive');
      expect(stat).toMatchObject({ waiting: 2, active: 0 });
      expect(stat!.oldestAgeSeconds).toBeGreaterThanOrEqual(600);
      expect(stat!.oldestAgeSeconds).toBeLessThan(630);
    });

    it('finds the oldest due job in the prioritized set, which is ordered by priority', async () => {
      const bull = queue.queue('tasks.overdue');
      const now = Date.now();
      await bull.add('tasks.overdue', ENV, { jobId: 'urgent', priority: 1, timestamp: now - 60_000 });
      await bull.add('tasks.overdue', ENV, { jobId: 'patient', priority: 50, timestamp: now - 300_000 });
      expect(await bull.getRanges(['prioritized'], 0, -1, true)).toEqual(['urgent', 'patient']);
      const stat = await statOf(queue, 'tasks.overdue');
      expect(stat).toMatchObject({ waiting: 2, active: 0 });
      expect(stat!.oldestAgeSeconds).toBeGreaterThanOrEqual(300);
      expect(stat!.oldestAgeSeconds).toBeLessThan(330);
    });

    it('counts a retry from its retry time', async () => {
      const bull = queue.queue('integrity.rehash');
      // Queued two hours ago; the first run fails and the retry waits 3 seconds.
      await bull.add('integrity.rehash', ENV, { jobId: 'retried', timestamp: Date.now() - 2 * HOUR_MS, attempts: 2, backoff: { type: 'fixed', delay: 3000 } });
      const worker = new Worker('integrity.rehash', null, { connection: redisConnection(valkey!.url), prefix });
      try {
        const token = 'queue-age-test';
        const job = await worker.getNextJob(token);
        expect(job?.id).toBe('retried');
        const failedAt = Date.now();
        await job!.moveToFailed(new Error('first attempt fails'), token);
        // BullMQ keeps the retry in the delayed set until its retry time.
        expect(await job!.getState()).toBe('delayed');
        expect(await statOf(queue, 'integrity.rehash')).toMatchObject({ waiting: 1, active: 0, oldestAgeSeconds: 0 });
        // The retry time has passed; no worker fetched a job, so the retry is still in the delayed set.
        await new Promise((resolve) => setTimeout(resolve, Math.max(0, failedAt + 5500 - Date.now())));
        let stat = await statOf(queue, 'integrity.rehash');
        expect(stat).toMatchObject({ waiting: 1, active: 0 });
        expect(stat!.oldestAgeSeconds).toBeGreaterThanOrEqual(1);
        expect(stat!.oldestAgeSeconds).toBeLessThan(10);
        // Moved to the waiting list it keeps no retry time and counts from the start of its failed run.
        await job!.promote();
        stat = await statOf(queue, 'integrity.rehash');
        expect(stat).toMatchObject({ waiting: 1, active: 0 });
        expect(stat!.oldestAgeSeconds).toBeGreaterThanOrEqual(1);
        expect(stat!.oldestAgeSeconds).toBeLessThan(60);
      } finally {
        await worker.close();
      }
    });
  });
});
