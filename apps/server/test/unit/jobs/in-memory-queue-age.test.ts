// Queue age of the in-memory driver's `stats()` (M2-S08 follow-up, metric `mscd_queue_oldest_age_seconds`), the
// same rule as the pg-boss and BullMQ drivers (test/int/jobs/queue-age.test.ts): the age counts from the start time
// of the jobs that are due. Only `Date` is faked, so the queue's own timers keep working.
import { Logger } from '@nestjs/common';
import type { JobName } from '@mscd/shared';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { InMemoryJobQueue } from '../../../src/common/jobs/in-memory-job-queue';
import type { QueueStats } from '../../../src/common/jobs/job-queue';

const T0 = Date.parse('2026-10-28T02:05:00Z');
const MINUTE = 60_000;
const ENV = { orgId: null, payload: {} };

async function statOf(queue: InMemoryJobQueue, name: JobName): Promise<QueueStats | undefined> {
  return (await queue.stats()).find((s) => s.name === name);
}

// The queue logs failed jobs through Nest's logger; one test fails a job on purpose.
beforeAll(() => Logger.overrideLogger(false));

describe('in-memory job queue: queue age from the start time of due jobs', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'], now: T0 });
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('counts a job queued to start later as 0 until its start time', async () => {
    const queue = new InMemoryJobQueue({ autoRun: false });
    // scheduler.tick at 02:05 queues a daily job for 02:45.
    await queue.send('drift.evaluate', ENV, { startAfterSeconds: 40 * 60 });
    expect(await statOf(queue, 'drift.evaluate')).toMatchObject({ waiting: 1, active: 0, oldestAgeSeconds: 0 });
    vi.setSystemTime(T0 + 39 * MINUTE);
    expect(await statOf(queue, 'drift.evaluate')).toMatchObject({ waiting: 1, oldestAgeSeconds: 0 });
    vi.setSystemTime(T0 + 40 * MINUTE);
    expect(await statOf(queue, 'drift.evaluate')).toMatchObject({ waiting: 1, oldestAgeSeconds: 0 });
  });

  it('counts a due job from its start time, while the time it was queued plays no part', async () => {
    const queue = new InMemoryJobQueue({ autoRun: false });
    await queue.send('drift.evaluate', ENV, { startAfterSeconds: 40 * 60 });
    vi.setSystemTime(T0 + 50 * MINUTE);
    await queue.send('drift.evaluate', ENV);
    await queue.send('drift.evaluate', ENV, { startAfterSeconds: 30 * 60 });
    // 15 minutes after 02:45; the job queued at 02:55 and the one that starts at 03:25 do not change it.
    vi.setSystemTime(T0 + 55 * MINUTE);
    expect(await statOf(queue, 'drift.evaluate')).toMatchObject({ waiting: 3, active: 0, oldestAgeSeconds: 15 * 60 });
  });

  it('counts a retry from its retry time', async () => {
    const queue = new InMemoryJobQueue();
    const gates = new Map<string, () => void>();
    await queue.work('integrity.rehash', { concurrency: 1 }, async (job) => {
      if (job.attempt > 1) return;
      await new Promise<void>((resolve) => gates.set(job.id, resolve));
      if (job.env.requestId === 'fails-once') throw new Error('first attempt fails');
    });
    // The first job runs; the second waits for the worker (concurrency 1).
    const failing = (await queue.send('integrity.rehash', { ...ENV, requestId: 'fails-once' }, { retryLimit: 1 }))!;
    const other = (await queue.send('integrity.rehash', ENV))!;
    expect(await statOf(queue, 'integrity.rehash')).toMatchObject({ waiting: 1, active: 1, oldestAgeSeconds: 0 });
    // Two hours later the first run fails: the other job runs next and the retry, due at once, waits for the worker.
    vi.setSystemTime(T0 + 120 * MINUTE);
    gates.get(failing)!();
    // Let the failure and the next run settle (vi.waitFor would move the faked clock).
    for (let round = 0; round < 100 && !gates.has(other); round += 1) await new Promise((resolve) => setImmediate(resolve));
    expect(gates.has(other)).toBe(true);
    vi.setSystemTime(T0 + 120 * MINUTE + 90_000);
    expect(queue.waitingJobs('integrity.rehash')).toEqual([expect.objectContaining({ id: failing, attempt: 2 })]);
    // Counted from the retry time: 90 seconds, where the queue time would give two hours.
    expect(await statOf(queue, 'integrity.rehash')).toMatchObject({ waiting: 1, active: 1, oldestAgeSeconds: 90 });
    const stopping = queue.stop();
    gates.get(other)!();
    await stopping;
  });
});
