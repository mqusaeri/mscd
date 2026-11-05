// The operator's rerun of the daily retention review (Milestone 3 M3-15, M3-11 follow-up 3): `retention.review` joins
// the allow-list of `POST /ops/jobs/{name}/run`, so after an outage an operator runs the review of one organisation
// from the console. The run follows the rules of every runnable tenant job: it needs an active organisation, its
// singleton key keeps one waiting run per organisation, the job and the `ops.job_run` entry commit together, and only
// the platform operator may start it. The queued run (an empty payload, so the organisation's own today) opens the
// reviews the missed daily run would have opened, in RS Medika Nusantara (`rmn`) of the demo data.
import { JobRunResponse, OPS_RUNNABLE_JOBS } from '@mscd/shared';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { JOB_QUEUE, type JobQueue } from '../../../src/common/jobs/job-queue';
import { manualRunKey, retryLimitOf } from '../../../src/modules/ops/ops.service';
import { RetentionModule } from '../../../src/modules/retention/retention.module';
import { RetentionReviewJob } from '../../../src/modules/retention/retention-review.job';
import { useTestDatabase } from '../../setup/test-db';
import { inScope } from '../db/helpers';
import { createIntApp, type IntApp } from '../platform/helpers';
import { ORG_IDS } from '../read-model/helpers';
import { as, OPS_MODULES, opsIdentities, tenantInfo } from './helpers';

describe('operator run of the daily retention review (M3-15)', () => {
  const db = useTestDatabase('demo');
  let ctx: IntApp;
  let opsUserId: string;

  beforeAll(async () => {
    const users = await db.migrator.selectFrom('platform.app_user').select(['id', 'handle']).where('handle', 'in', ['ops', 'tenant.admin']).execute();
    const byHandle = new Map(users.map((u) => [u.handle, u.id]));
    opsUserId = byHandle.get('ops')!;
    const tst = await tenantInfo(db.migrator, 'tst');
    ctx = await createIntApp(db, { imports: [...OPS_MODULES, RetentionModule] }, {
      auth: { identities: opsIdentities({ id: opsUserId, handle: 'ops' }, { id: byHandle.get('tenant.admin')!, handle: 'tenant.admin', org: tst }) },
    });
  });

  afterAll(async () => {
    await ctx?.close();
  });

  const run = (who: string, body: unknown) =>
    ctx.app.inject({ method: 'POST', url: '/api/v1/ops/jobs/retention.review/run', headers: as(who), payload: body as object });

  /** The retention reviews of an item in RS Medika Nusantara (`rmn`). */
  const reviewsOf = (itemId: string) =>
    inScope(db.migrator, { orgId: ORG_IDS.rmn, schema: 'org_rmn' }, (trx) =>
      sql<{ status: string; item_code: string }>`select status, item_code from retention_review where item_id = ${itemId}::uuid and deleted_at is null`.execute(trx),
    ).then((r) => r.rows);

  it('is in the allow-list, with the retry limit of its daily entry', () => {
    expect(OPS_RUNNABLE_JOBS).toContain('retention.review');
    expect(retryLimitOf('retention.review')).toBe(3);
  });

  it('runs for one active organisation only, with one waiting run per organisation, and only for the platform operator', async () => {
    const without = await run('ops', {});
    expect(without.statusCode).toBe(422);
    expect(without.json().detail).toMatch(/runs for one organisation/);
    expect((await run('ops', { org: 'zzz' })).statusCode).toBe(404);
    expect((await run('ta', { org: 'tst' })).statusCode).toBe(403);

    const queued = await run('ops', { org: 'rmn' });
    expect(queued.statusCode, queued.body).toBe(202);
    const { jobId } = JobRunResponse.parse(queued.json());
    const stats = await ctx.moduleRef.get<JobQueue>(JOB_QUEUE).stats();
    expect(stats.find((q) => q.name === 'retention.review')?.waiting).toBe(1);
    expect(manualRunKey('retention.review', ORG_IDS.rmn)).toBe(`ops:retention.review:${ORG_IDS.rmn}`);

    // Audited like the other runnable jobs: `ops.job_run` in the platform chain, actor kind operator.
    const entries = await inScope(db.migrator, { platformScope: true }, (trx) =>
      trx
        .selectFrom('platform.audit_log')
        .select(['organization_id', 'actor_user_id', 'actor_kind', 'entity_type', 'entity_code', 'after_data'])
        .where('action', '=', 'ops.job_run')
        .orderBy('seq')
        .execute(),
    );
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ organization_id: ORG_IDS.rmn, actor_user_id: opsUserId, actor_kind: 'operator', entity_type: 'job', entity_code: 'retention.review' });
    expect(entries[0]!.after_data).toEqual({ job: 'retention.review', jobId, org: 'rmn' });
  });

  it('opens the reviews the missed daily run would have opened, on the organisation\'s own date', async () => {
    // A finding of the ISMS closed in January 2023: its default period of 36 months ended before the demo's today, and
    // no daily run opened its review (an outage).
    const { rows: [rina] } = await sql<{ id: string }>`select id from platform.app_user where handle = 'rina'`.execute(db.migrator);
    const finding = await inScope(db.migrator, { orgId: ORG_IDS.rmn, schema: 'org_rmn' }, async (trx) => {
      const isms = (await trx.selectFrom('management_system').select('id').where('slug', '=', 'isms').executeTakeFirstOrThrow()).id;
      return (await trx.insertInto('finding').values({
        management_system_id: isms, code: 'OPS-F-1', title: 'Badge reader log gap', classification: 'minor', source: 'other', status: 'closed',
        closed_at: '2023-01-10', owner_user_id: rina!.id,
      }).returning('id').executeTakeFirstOrThrow()).id;
    });
    expect(await reviewsOf(finding)).toEqual([]);

    // The envelope of an operator run: the organisation, the operator and an empty payload (no local date).
    const job = ctx.moduleRef.get(RetentionReviewJob);
    await job.handle({ id: 'ops-run', name: 'retention.review', attempt: 1, env: { orgId: ORG_IDS.rmn, requestedBy: opsUserId, payload: {} } });
    expect(await reviewsOf(finding)).toEqual([{ status: 'open', item_code: 'OPS-F-1' }]);
    // A second run on the same day opens nothing more (the daily run and an operator run may meet).
    expect(await job.run(ORG_IDS.rmn)).toMatchObject({ opened: 0 });
    expect(await reviewsOf(finding)).toHaveLength(1);
  });
});
