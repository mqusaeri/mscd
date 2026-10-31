// `org.lifecycle` job handler (Milestone 3 J.3, D.5.1; M3-03): hourly at minute 20 UTC in platform scope (the run
// ledger of the daily jobs skips organisations that are not active), also runnable from the operator console
// (`ops.jobs.run`). Each run:
//   1. offboarding organisations: when `offboarding_ends_at` has passed, the system moves the organisation to archived,
//      which ends every session and schedules the deletion (OrganizationTransitions.endReadOnlyPeriod); before that it
//      reminds the Tenant Admins 7 days and 1 day before the end (`organization_lifecycle`, in the app and by email).
//      An organisation moved to offboarding before Milestone 3 has no end yet: it gets one (the move plus
//      `lifecycle.offboarding_days`, at least 7 days ahead, so both reminders still go out);
//   2. archived organisations with a scheduled deletion: when the date has come the deletion moves to running and
//      `org.purge` is queued; before that the Tenant Admins are reminded 7 days and 1 day before (by email; they can no
//      longer sign in);
//   3. running deletions that no worker has touched for 30 minutes (a worker that stopped during a purge) get their
//      `org.purge` queued again; every purge step is idempotent and a done step never runs twice.
// Each reminder is sent once per stage and date: the in-app notification it writes in the organisation (`entity_ref`
// with the stage and the date) is the record, so a moved date gets its own reminders and a run every hour sends nothing
// twice. In single tenancy the job does nothing (D.5.1): one organisation, no end of contract and no deletion.
import { Inject, Injectable, Logger } from '@nestjs/common';
import { sql } from 'kysely';
import { Clock } from '../../../common/clock';
import { localDate } from '../../../common/dates';
import { JobHandler, type JobHandlerInstance } from '../../../common/jobs/job-handler';
import { JOB_QUEUE, type JobQueue, type JobRun } from '../../../common/jobs/job-queue';
import { SYSTEM_USER_ID } from '../../../common/tokens';
import { MscdConfig } from '../../../config/mscd-config';
import { AccountMailer } from '../../identity/account-mailer';
import { renderTemplate, type AccountTemplate } from '../../identity/mail-templates';
import { TENANT_SCHEMA, TenantScope } from '../../tenancy/tenant-scope';
import { DAY_MS, REOPEN_DAYS, addDaysTo, lifecyclePeriods, offboardingStartedAt, tenantAdminsOf } from './deletion-records';
import { OrganizationTransitions } from './organization-transitions';

/** A running deletion untouched this long gets its purge queued again. */
export const STUCK_PURGE_MS = 30 * 60_000;

/** What one run did (counts only; the operator console and the tests read it). */
export interface LifecycleRunResult {
  archived: number;
  remindersSent: number;
  purgesQueued: number;
  purgesRequeued: number;
  endsSet: number;
}

type Stage = 'offboarding_7d' | 'offboarding_1d' | 'deletion_7d' | 'deletion_1d';

interface LifecycleOrg {
  id: string;
  slug: string;
  name: string;
  schema_name: string;
  time_zone: string;
}

@Injectable()
@JobHandler('org.lifecycle', { concurrency: 1, scope: 'installation' })
export class OrgLifecycleJob implements JobHandlerInstance<'org.lifecycle'> {
  private readonly logger = new Logger('org.lifecycle');

  constructor(
    private readonly config: MscdConfig,
    private readonly scope: TenantScope,
    private readonly clock: Clock,
    private readonly transitions: OrganizationTransitions,
    private readonly mailer: AccountMailer,
    @Inject(JOB_QUEUE) private readonly queue: JobQueue,
  ) {}

  async handle(job: JobRun<'org.lifecycle'>): Promise<void> {
    // Single tenancy: one organisation, no end of contract and no deletion (D.5.1). Nothing to do.
    if (this.config.profile.tenancy.mode !== 'multi') {
      this.logger.debug({ jobId: job.id }, 'org.lifecycle does nothing in single tenancy');
      return;
    }
    const result = await this.run(job.env.requestId);
    this.logger.log({ jobId: job.id, ...result }, 'org.lifecycle done');
  }

  /** One run (the job, and the tests with a fixed clock). */
  async run(requestId?: string): Promise<LifecycleRunResult> {
    const result: LifecycleRunResult = { archived: 0, remindersSent: 0, purgesQueued: 0, purgesRequeued: 0, endsSet: 0 };
    if (this.config.profile.tenancy.mode !== 'multi') return result;
    const now = this.clock.now();
    const periods = lifecyclePeriods(this.config);

    // 1. Offboarding organisations.
    const offboarding = await this.scope.withPlatform(
      (trx) =>
        trx
          .selectFrom('platform.organization')
          .select(['id', 'slug', 'name', 'schema_name', 'time_zone', 'offboarding_ends_at'])
          .where('status', '=', 'offboarding')
          .where('deleted_at', 'is', null)
          .orderBy('position')
          .orderBy('slug')
          .execute(),
      { scope: 'job', requestId },
    );
    for (const org of offboarding) {
      try {
        let endsAt = org.offboarding_ends_at;
        if (!endsAt) {
          endsAt = await this.setMissingEnd(org, now, periods.offboardingDays, requestId);
          result.endsSet += 1;
        }
        if (endsAt.getTime() <= now.getTime()) {
          if (await this.transitions.endReadOnlyPeriod(org.id, requestId)) result.archived += 1;
          continue;
        }
        result.remindersSent += await this.remind(org, endsAt, now, 'offboarding', requestId);
      } catch (error) {
        this.logger.error({ orgId: org.id }, `org.lifecycle could not handle offboarding organisation ${org.slug}: ${(error as Error).message}`);
      }
    }

    // 2. Scheduled deletions of archived organisations.
    const scheduled = await this.scope.withPlatform(
      async (trx) => {
        const { rows } = await sql<LifecycleOrg & { deletion_id: string; scheduled_for: Date }>`
          select o.id, o.slug, o.name, o.schema_name, o.time_zone, d.id as deletion_id, d.scheduled_for
            from platform.organization_deletion d
            join platform.organization o on o.id = d.organization_id
           where d.status = 'scheduled' and o.status = 'archived' and o.deleted_at is null
           order by d.scheduled_for, o.slug`.execute(trx);
        return rows;
      },
      { scope: 'job', requestId },
    );
    for (const row of scheduled) {
      try {
        if (row.scheduled_for.getTime() <= now.getTime()) {
          const queued = await this.scope.withPlatform(
            async (trx) => {
              const moved = await trx
                .updateTable('platform.organization_deletion')
                .set({ status: 'running' })
                .where('id', '=', row.deletion_id)
                .where('status', '=', 'scheduled')
                .executeTakeFirst();
              if (Number(moved.numUpdatedRows) === 0) return false;
              await this.queue.send(
                'org.purge',
                { orgId: null, ...(requestId ? { requestId } : {}), payload: { deletionId: row.deletion_id } },
                { singletonKey: `purge:${row.deletion_id}`, retryLimit: 0 },
                trx,
              );
              return true;
            },
            { scope: 'job', requestId },
          );
          if (queued) result.purgesQueued += 1;
          continue;
        }
        result.remindersSent += await this.remind(row, row.scheduled_for, now, 'deletion', requestId);
      } catch (error) {
        this.logger.error({ orgId: row.id }, `org.lifecycle could not handle the deletion of ${row.slug}: ${(error as Error).message}`);
      }
    }

    // 3. Running deletions that no worker touched for a while.
    const stuck = await this.scope.withPlatform(
      (trx) =>
        trx
          .selectFrom('platform.organization_deletion')
          .select(['id'])
          .where('status', '=', 'running')
          .where('updated_at', '<', new Date(now.getTime() - STUCK_PURGE_MS))
          .execute(),
      { scope: 'job', requestId },
    );
    for (const row of stuck) {
      const id = await this.scope.withPlatform(
        (trx) =>
          this.queue.send('org.purge', { orgId: null, ...(requestId ? { requestId } : {}), payload: { deletionId: row.id } }, { singletonKey: `purge:${row.id}`, retryLimit: 0 }, trx),
        { scope: 'job', requestId },
      );
      if (id) result.purgesRequeued += 1;
    }
    return result;
  }

  /** The end of the read-only period of an organisation moved to offboarding before Milestone 3 (platform scope only). */
  private async setMissingEnd(org: LifecycleOrg, now: Date, days: number, requestId?: string): Promise<Date> {
    return this.scope.withPlatform(
      async (trx) => {
        const started = (await offboardingStartedAt(trx, org.id)) ?? now;
        const fromMove = addDaysTo(started, days);
        const atLeast = addDaysTo(now, REOPEN_DAYS);
        const endsAt = fromMove.getTime() > atLeast.getTime() ? fromMove : atLeast;
        await trx.updateTable('platform.organization').set({ offboarding_ends_at: endsAt }).where('id', '=', org.id).where('offboarding_ends_at', 'is', null).execute();
        return endsAt;
      },
      { scope: 'job', requestId },
    );
  }

  /**
   * The reminder due now for a date (7 days and 1 day before; only the 1-day one when both are due), sent once: the
   * notification of the stage and date in the organisation is the record. Returns how many emails went out.
   */
  private async remind(org: LifecycleOrg, due: Date, now: Date, kind: 'offboarding' | 'deletion', requestId?: string): Promise<number> {
    const left = due.getTime() - now.getTime();
    let stage: Stage | null = null;
    let days = 0;
    if (left <= DAY_MS) {
      stage = kind === 'offboarding' ? 'offboarding_1d' : 'deletion_1d';
      days = 1;
    } else if (left <= 7 * DAY_MS) {
      stage = kind === 'offboarding' ? 'offboarding_7d' : 'deletion_7d';
      days = 7;
    }
    if (!stage || !TENANT_SCHEMA.test(org.schema_name)) return 0;
    const dueIso = due.toISOString();
    const on = localDate(due, org.time_zone);
    const template: AccountTemplate = {
      name: 'organization_lifecycle',
      link: this.mailer.appLink('/'),
      organisation: org.name,
      stage: kind === 'offboarding' ? 'read_only_ends' : 'deletion',
      on,
      days,
    };
    const en = renderTemplate(template, 'en');
    const id = renderTemplate(template, 'id');
    const recipients = await this.scope.withTenant({ orgId: org.id, schema: org.schema_name, userId: SYSTEM_USER_ID, requestId }, async (trx) => {
      const sent = await trx
        .selectFrom('notification')
        .select('id')
        .where('kind', '=', 'organization_lifecycle')
        .where(sql<boolean>`entity_ref ->> 'stage' = ${stage}`)
        .where(sql<boolean>`entity_ref ->> 'due' = ${dueIso}`)
        .limit(1)
        .executeTakeFirst();
      if (sent) return [];
      const admins = await tenantAdminsOf(trx, org.id);
      for (const admin of admins) {
        await trx
          .insertInto('notification')
          .values({
            recipient_user_id: admin.id,
            management_system_id: null,
            kind: 'organization_lifecycle',
            title_en: en.title,
            title_id: id.title,
            body_en: en.paragraphs.join(' '),
            body_id: id.paragraphs.join(' '),
            entity_ref: JSON.stringify({ type: 'organization', id: org.id, stage, due: dueIso }),
            digest: false,
            email_status: 'skipped',
            created_by: SYSTEM_USER_ID,
            updated_by: SYSTEM_USER_ID,
          })
          .execute();
      }
      return admins;
    });
    const results = await Promise.all(recipients.map((admin) => this.mailer.send({ to: { email: admin.email, userId: admin.id }, template })));
    return results.filter(Boolean).length;
  }
}
