// One organisation export build at a time in the installation (Milestone 3 D.4): every build needs temporary space for
// one part and the gateway's bandwidth, and the worker may run as several processes (Compose replicas, the Helm
// worker's autoscaling), so `concurrency: 1` of the job is not enough. A build holds a session advisory lock on one
// pinned connection while it runs; the lock ends with that connection if the process dies. The worker job and
// `mscd-server export organization` take the same lock.
import { sql } from 'kysely';
import type { AppDatabase } from '../../db/database.module';

/** Class and key of the session advisory lock of organisation export builds (`org.purge` uses class 7003). */
export const BUILD_LOCK_CLASS = 7004;
export const BUILD_LOCK_KEY = 0x6d736364; // 'mscd'

/** Seconds before a build that found another one running is tried again. */
export const BUILD_BUSY_RETRY_SECONDS = 120;

/** The refusal of `export organization` while another build runs. */
export const BUILD_BUSY_MESSAGE =
  'Another organisation export is being built in this installation; one build runs at a time. Try again when it has finished.';

/**
 * Runs `fn` while holding the installation's build lock. Resolves to `{ locked: false }` without running `fn` when
 * another build holds it.
 */
export async function withBuildLock<T>(db: AppDatabase, fn: () => Promise<T>): Promise<{ locked: true; value: T } | { locked: false }> {
  // The session lock needs one pinned connection for the whole build. The connection reads no table: every query of the
  // build goes through withTenant (F.10).
  // eslint-disable-next-line no-restricted-syntax
  return db.connection().execute(async (conn) => {
    const { rows } = await sql<{ ok: boolean }>`select pg_try_advisory_lock(${BUILD_LOCK_CLASS}, ${BUILD_LOCK_KEY}) as ok`.execute(conn);
    if (!rows[0]?.ok) return { locked: false as const };
    try {
      return { locked: true as const, value: await fn() };
    } finally {
      await sql`select pg_advisory_unlock(${BUILD_LOCK_CLASS}, ${BUILD_LOCK_KEY})`.execute(conn).catch(() => undefined);
    }
  });
}
