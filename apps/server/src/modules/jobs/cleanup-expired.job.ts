// `cleanup.expired` (E.2): hourly at minute 20 UTC, installation-wide. Deletes expired rate limit buckets,
// idempotency keys, sign-in and link transactions and SAML assertion ids, and relayed outbox rows older than 7 days;
// revokes expired sessions; marks expired upload intents (`expired`) and export files (soft-deleted) in every
// organisation, and runs the tenant cleanup steps other modules register (`TenantCleanupRegistry`, for example the
// closing of expired guest auditor grants, F.14 step 5) in every organisation whose status the step names (active
// only by default; the expiry of exports of the org-export module, which deletes their vault content, runs for every
// status but deleted, Milestone 3 D.4). Every statement is idempotent.
//
// Milestone 3 (D.6.7, M3-04): technical personal data with a retention period. Ended sessions (with network address
// and browser) are deleted `privacy.session_retention_days` after they ended; used, revoked or expired invitations and
// password tokens `privacy.token_retention_days` after use or expiry; read notifications
// `privacy.notification_retention_days` after they were read, except those a `reminder` row refers to (the reminder is
// the record that it was sent). The days come from the profile.
//
// Milestone 3 M3-12: the expired idempotency keys of principals without an organisation (platform operators, kept
// under `PLATFORM_IDEMPOTENCY_ORG`), and the working folders of organisation export builds that stopped (folders
// `mscd-org-export-*` of the worker's temporary folder nobody touched for 24 hours, `removeStaleWorkDirs`), so their
// scratch files do not wait for the next export. The folders are removed while this run holds the installation's
// export build lock; when a build holds it, the run leaves them (that build removes them when it starts).
import os from 'node:os';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { sql } from 'kysely';
import { Clock } from '../../common/clock';
import { MscdConfig } from '../../config/mscd-config';
import { JobHandler, type JobHandlerInstance } from '../../common/jobs/job-handler';
import type { JobRun } from '../../common/jobs/job-queue';
import { SYSTEM_USER_ID } from '../../common/tokens';
import { DATABASE, type AppDatabase } from '../../db/database.module';
import { withBuildLock } from '../org-export/build-lock';
import { removeStaleWorkDirs } from '../org-export/org-export-build.job';
import { PLATFORM_IDEMPOTENCY_ORG } from '../tenancy/idempotency-store';
import { RateLimitBucketStore } from '../tenancy/rate-limit-store';
import { TENANT_SCHEMA, TenantScope } from '../tenancy/tenant-scope';
import { stepRunsFor, TenantCleanupRegistry } from './tenant-cleanup';

/** Relayed outbox rows are kept this long (E.2). */
export const OUTBOX_RETENTION_DAYS = 7;

export interface CleanupResult {
  rateLimitBuckets: number;
  idempotencyKeys: number;
  authTransactions: number;
  samlAssertions: number;
  outboxRows: number;
  sessionsRevoked: number;
  uploadIntentsExpired: number;
  exportFilesExpired: number;
  /** Milestone 3 D.6.7: ended sessions, used or expired invitations and password tokens, and read notifications deleted. */
  sessionsDeleted: number;
  invitationsDeleted: number;
  passwordTokensDeleted: number;
  notificationsDeleted: number;
  /**
   * Milestone 3 M3-12: working folders of stopped organisation export builds removed from the temporary folder; null
   * when a build held the installation's build lock (the folders wait for the next run).
   */
  staleExportWorkDirs: number | null;
  /** Records ended or changed by each registered tenant cleanup step, summed over the organisations. */
  tenantSteps: Record<string, number>;
  /** Organisations whose tenant cleanup failed (the others are still cleaned). */
  failedOrganisations: string[];
}

@Injectable()
@JobHandler('cleanup.expired', { concurrency: 1, scope: 'installation' })
export class CleanupExpiredJob implements JobHandlerInstance<'cleanup.expired'> {
  private readonly logger = new Logger('cleanup.expired');

  constructor(
    private readonly scope: TenantScope,
    private readonly clock: Clock,
    private readonly rateLimits: RateLimitBucketStore,
    private readonly tenantSteps: TenantCleanupRegistry,
    private readonly config: MscdConfig,
    @Inject(DATABASE) private readonly db: AppDatabase,
  ) {}

  async handle(job: JobRun<'cleanup.expired'>): Promise<void> {
    const result = await this.cleanup(job.env.requestId);
    this.logger.log({ jobId: job.id, attempt: job.attempt, ...result }, 'cleanup.expired done');
    if (result.failedOrganisations.length > 0) {
      throw new Error(`cleanup.expired failed for ${result.failedOrganisations.length} organisation(s): ${result.failedOrganisations.join(', ')}`);
    }
  }

  async cleanup(requestId?: string): Promise<CleanupResult> {
    const now = this.clock.now();
    const retention = this.config.profile.privacy;
    const daysBefore = (days: number) => sql<Date>`${now}::timestamptz - ${days} * interval '1 day'`;
    const rateLimitBuckets = await this.rateLimits.purgeExpired();
    const platform = await this.scope.withPlatform(
      async (trx) => {
        const del = async (query: { executeTakeFirst(): Promise<{ numDeletedRows: bigint }> }) => Number((await query.executeTakeFirst()).numDeletedRows);
        const authTransactions = await del(trx.deleteFrom('platform.auth_transaction').where('expires_at', '<=', now));
        const samlAssertions = await del(trx.deleteFrom('platform.saml_assertion_seen').where('expires_at', '<=', now));
        const outboxRows = await del(
          trx
            .deleteFrom('platform.job_outbox')
            .where('dispatched_at', 'is not', null)
            .where('dispatched_at', '<=', sql<Date>`${now}::timestamptz - ${OUTBOX_RETENTION_DAYS} * interval '1 day'`),
        );
        const revoked = await trx
          .updateTable('platform.session')
          .set({ revoked_at: now, revoke_reason: 'expired' })
          .where('revoked_at', 'is', null)
          .where((eb) => eb.or([eb('idle_expires_at', '<=', now), eb('absolute_expires_at', '<=', now)]))
          .executeTakeFirst();
        // D.6.7: technical personal data past its retention period.
        const sessionsDeleted = await del(
          trx
            .deleteFrom('platform.session')
            .where(sql<boolean>`coalesce(revoked_at, least(idle_expires_at, absolute_expires_at)) <= ${daysBefore(retention.session_retention_days)}`),
        );
        const invitationsDeleted = await del(
          trx
            .deleteFrom('platform.invitation')
            .where(sql<boolean>`least(coalesce(used_at, 'infinity'::timestamptz), coalesce(revoked_at, 'infinity'::timestamptz), expires_at) <= ${daysBefore(retention.token_retention_days)}`),
        );
        const passwordTokensDeleted = await del(
          trx
            .deleteFrom('platform.password_reset_token')
            .where(sql<boolean>`least(coalesce(used_at, 'infinity'::timestamptz), expires_at) <= ${daysBefore(retention.token_retention_days)}`),
        );
        const orgs = await trx
          .selectFrom('platform.organization')
          .select(['id', 'schema_name', 'deleted_at', 'status'])
          .where(sql<boolean>`to_regnamespace(schema_name) IS NOT NULL`)
          .orderBy('position')
          .orderBy('slug')
          .execute();
        return {
          authTransactions, samlAssertions, outboxRows, sessionsRevoked: Number(revoked.numUpdatedRows), sessionsDeleted, invitationsDeleted, passwordTokensDeleted, orgs,
        };
      },
      { scope: 'job', requestId },
    );

    // Keys of principals without an organisation (platform operators): their own scope, like each organisation's below.
    let idempotencyKeys = await this.scope.withPlatform(
      async (trx) => Number((await trx.deleteFrom('platform.idempotency_key').where('expires_at', '<=', now).executeTakeFirst()).numDeletedRows),
      { scope: 'job', orgId: PLATFORM_IDEMPOTENCY_ORG, requestId },
    );
    let uploadIntentsExpired = 0;
    let exportFilesExpired = 0;
    let notificationsDeleted = 0;
    const steps = this.tenantSteps.list();
    const tenantSteps: Record<string, number> = Object.fromEntries(steps.map((step) => [step.name, 0]));
    const failedOrganisations: string[] = [];
    for (const org of platform.orgs) {
      try {
        // `idempotency_key` is visible per organisation only (its RLS has no platform scope, C.4).
        idempotencyKeys += await this.scope.withPlatform(
          async (trx) => Number((await trx.deleteFrom('platform.idempotency_key').where('expires_at', '<=', now).executeTakeFirst()).numDeletedRows),
          { scope: 'job', orgId: org.id, requestId },
        );
        if (org.deleted_at !== null || !TENANT_SCHEMA.test(org.schema_name)) continue;
        const tenantContext = { orgId: org.id, schema: org.schema_name, userId: SYSTEM_USER_ID, requestId };
        const tenant = await this.scope.withTenant(tenantContext, async (trx) => {
          const intents = await trx
            .updateTable('upload_intent')
            .set({ status: 'expired', updated_at: now, updated_by: SYSTEM_USER_ID })
            .where('status', '=', 'open')
            .where('expires_at', '<=', now)
            .where('deleted_at', 'is', null)
            .executeTakeFirst();
          const exportsExpired = await trx
            .updateTable('export_file')
            .set({ deleted_at: now, updated_at: now, updated_by: SYSTEM_USER_ID })
            .where('deleted_at', 'is', null)
            .where('expires_at', '<=', now)
            .executeTakeFirst();
          // D.6.7: read notifications past their retention period, except those a reminder refers to.
          const notifications = await trx
            .deleteFrom('notification')
            .where('read_at', 'is not', null)
            .where('read_at', '<=', daysBefore(retention.notification_retention_days))
            .where(sql<boolean>`not exists (select 1 from reminder r where r.notification_id = notification.id)`)
            .executeTakeFirst();
          return { intents: Number(intents.numUpdatedRows), exports: Number(exportsExpired.numUpdatedRows), notifications: Number(notifications.numDeletedRows) };
        });
        uploadIntentsExpired += tenant.intents;
        exportFilesExpired += tenant.exports;
        notificationsDeleted += tenant.notifications;
        // Registered steps run for the statuses they name (active only by default: a suspended organisation keeps its
        // state until it returns), each in its own tenant transaction, so a failing step rolls back neither the
        // expiries above nor the other steps.
        let stepFailed = false;
        for (const step of steps) {
          if (!stepRunsFor(step, org.status)) continue;
          try {
            tenantSteps[step.name] = (tenantSteps[step.name] ?? 0) + (await this.scope.withTenant(tenantContext, (trx) => step.run(trx, org.id, now)));
          } catch (error) {
            stepFailed = true;
            this.logger.error({ orgId: org.id, step: step.name, error: (error as Error).message }, 'cleanup.expired step failed for an organisation');
          }
        }
        if (stepFailed) failedOrganisations.push(org.id);
      } catch (error) {
        failedOrganisations.push(org.id);
        this.logger.error({ orgId: org.id, error: (error as Error).message }, 'cleanup.expired failed for an organisation');
      }
    }
    const staleExportWorkDirs = await this.removeStaleExportWork();
    return {
      rateLimitBuckets,
      idempotencyKeys,
      authTransactions: platform.authTransactions,
      samlAssertions: platform.samlAssertions,
      outboxRows: platform.outboxRows,
      sessionsRevoked: platform.sessionsRevoked,
      uploadIntentsExpired,
      exportFilesExpired,
      sessionsDeleted: platform.sessionsDeleted,
      invitationsDeleted: platform.invitationsDeleted,
      passwordTokensDeleted: platform.passwordTokensDeleted,
      notificationsDeleted,
      staleExportWorkDirs,
      tenantSteps,
      failedOrganisations,
    };
  }

  /**
   * Removes the working folders of export builds that stopped, under the installation's build lock (M3-12). Returns
   * the number removed, or null when a build holds the lock. Best effort: a failure is logged and never fails the run.
   */
  private async removeStaleExportWork(): Promise<number | null> {
    try {
      // eslint-disable-next-line no-restricted-syntax -- the pool only pins the connection of the session lock (build-lock.ts)
      const run = await withBuildLock(this.db, () => removeStaleWorkDirs(os.tmpdir(), this.logger));
      return run.locked ? run.value.length : null;
    } catch (error) {
      this.logger.warn(`cleanup.expired could not check the working folders of export builds: ${(error as Error).message}`);
      return 0;
    }
  }
}
