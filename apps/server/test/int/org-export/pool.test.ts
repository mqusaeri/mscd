// The database pool an organisation export build needs (Milestone 3 M3-15, M3-12 minor finding 2): a build holds three
// connections at once (the session of the build lock, the snapshot holder and one short read). With
// `database.pool_max` below 3 the build job fails the export at once, before it takes the build lock, with the reason in
// English and Indonesian, audited `organization_export.failed` and shown to the Tenant Admin; it does not wait for a
// connection it never gets, and the queue does not retry it. A worker with such a pool logs a warning at start. The api
// runs on a real pool of 2 connections, and the build lock is held elsewhere, so a build that tried to take it would
// answer `busy`.
import { Logger } from '@nestjs/common';
import { OrganizationExportDetail, API_ROUTES } from '@mscd/shared';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { BUILD_LOCK_CLASS, BUILD_LOCK_KEY } from '../../../src/modules/org-export/build-lock';
import { MIN_BUILD_CONNECTIONS, OrgExportBuildJob, poolTooSmall } from '../../../src/modules/org-export/org-export-build.job';
import { OrgExportModule } from '../../../src/modules/org-export/org-export.module';
import { useTestDatabase } from '../../setup/test-db';
import { callRoute, demoSession, rowsIn, userIdOf, type FullApp } from '../contract/harness';
import { inScope } from '../db/helpers';
import { clearExports, createExportApp, exportRow, ORG_IDS } from './helpers';

const GET = API_ROUTES.find((r) => r.id === 'exports.organization.get')!;

describe('organisation export builds need three database connections (M3-15)', () => {
  const db = useTestDatabase('demo');
  let full: FullApp;

  beforeAll(async () => {
    // No storage gateway runs: a refused build never calls it.
    full = await createExportApp(db, 'http://127.0.0.1:9', { MSCD__DATABASE__POOL_MAX: '2' });
  }, 240_000);
  afterAll(async () => {
    await full?.close();
  });

  /** A queued export of `ndt` requested by its Tenant Admin, as `exports.organization.create` writes it. */
  const queuedExport = async (): Promise<string> => {
    await clearExports(db, 'ndt');
    const requester = await userIdOf(db, 'rina');
    const row = await inScope(db.migrator, { platformScope: true }, (trx) =>
      trx
        .insertInto('platform.organization_export')
        .values({ organization_id: ORG_IDS.ndt, status: 'queued', requested_via: 'tenant_admin', requested_by: requester })
        .returning('id')
        .executeTakeFirstOrThrow(),
    );
    return row.id;
  };

  it('gives the reason in English and Indonesian, with the pool size and the minimum', () => {
    expect(MIN_BUILD_CONNECTIONS).toBe(3);
    const reason = poolTooSmall(2);
    expect(reason.en).toBe(
      'The export was not built: the database pool of the worker allows 2 connections (database.pool_max) and an export build needs 3 at once. ' +
        'Ask your MSCD service provider to set database.pool_max to 3 or more, then request the export again.',
    );
    expect(reason.id).toBe(
      'Ekspor tidak dibuat: kumpulan koneksi basis data worker mengizinkan 2 koneksi (database.pool_max), sedangkan pembuatan ekspor memerlukan 3 koneksi sekaligus. ' +
        'Minta penyedia layanan MSCD Anda mengatur database.pool_max menjadi 3 atau lebih, lalu ajukan ekspor lagi.',
    );
    expect(reason.text).toBe(`${reason.en} ${reason.id}`);
    expect(poolTooSmall(1).en).toContain('allows 1 connection (database.pool_max)');
    expect(reason.text).not.toMatch(/[—·]/);
  });

  it('fails the export at once without the build lock, audits it and shows the reason to the Tenant Admin', async () => {
    const id = await queuedExport();
    const job = full.get<OrgExportBuildJob>(OrgExportBuildJob);
    // The build lock is held by another session: a build that took the lock path would answer `busy` and wait.
    const outcome = await db.migrator.connection().execute(async (conn) => {
      const { rows } = await sql<{ ok: boolean }>`select pg_try_advisory_lock(${BUILD_LOCK_CLASS}, ${BUILD_LOCK_KEY}) as ok`.execute(conn);
      expect(rows[0]!.ok).toBe(true);
      try {
        return await job.build(ORG_IDS.ndt, id);
      } finally {
        await sql`select pg_advisory_unlock(${BUILD_LOCK_CLASS}, ${BUILD_LOCK_KEY})`.execute(conn);
      }
    });
    const reason = poolTooSmall(2).text;
    expect(outcome).toEqual({ exportId: id, status: 'failed', error: reason });
    expect(await exportRow(db, id)).toMatchObject({ status: 'failed', error: reason, part_count: null, manifest_object_id: null });
    const audit = await rowsIn<{ action: string; after_data: Record<string, unknown> }>(db, 'ndt', sql`
      select action, after_data from audit_trail where entity_id = ${id} order by seq`);
    expect(audit).toEqual([{ action: 'organization_export.failed', after_data: { status: 'failed', error: reason } }]);

    const admin = await demoSession(full, db, 'rina', 'ndt');
    const detail = await callRoute<OrganizationExportDetail>(admin, GET, { params: { id } });
    expect(detail.violations).toEqual([]);
    expect(detail.status, detail.text).toBe(200);
    expect(detail.body).toMatchObject({ id, status: 'failed', error: reason });

    // The worker's run of the job finishes without an error, so the queue does not retry a build that cannot run.
    await expect(job.handle({ id: 'job-1', name: 'org-export.build', attempt: 1, env: { orgId: ORG_IDS.ndt, payload: { exportId: id } } })).resolves.toBeUndefined();
    // A row that waits for no build stays as it is, and another organisation's export id changes nothing.
    expect(await job.build(ORG_IDS.ndt, id)).toEqual({ exportId: id, status: 'skipped' });
    const other = await queuedExport();
    expect(await job.build(ORG_IDS.tst, other)).toEqual({ exportId: other, status: 'skipped' });
    expect(await exportRow(db, other)).toMatchObject({ status: 'queued', error: null });
  });

  it('logs a warning when a worker starts with a pool below three connections', () => {
    const warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    try {
      const module = (env: Record<string, string>, runMode: 'api' | 'worker') =>
        new OrgExportModule({ register: () => undefined } as never, {} as never, db.config(env, runMode));
      expect(module({ MSCD__DATABASE__POOL_MAX: '2' }, 'worker').warnSmallPool()).toBe(true);
      expect(warn).toHaveBeenCalledTimes(1);
      expect(String(warn.mock.calls[0]![1])).toContain('database.pool_max is 2: an organisation export build holds 3 database connections at once');
      expect(module({ MSCD__DATABASE__POOL_MAX: '3' }, 'worker').warnSmallPool()).toBe(false);
      expect(module({ MSCD__DATABASE__POOL_MAX: '2' }, 'api').warnSmallPool()).toBe(false);
      expect(warn).toHaveBeenCalledTimes(1);
    } finally {
      warn.mockRestore();
    }
  });
});
