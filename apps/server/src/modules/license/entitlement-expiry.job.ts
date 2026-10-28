// `entitlement.expiry` (Milestone 2 J.3, K.6 M2-S10): daily per organisation through `scheduler.tick` and its run
// ledger (`platform.daily_job_run`, one run per organisation and local date, key `ee:<org>:<local date>`). The job
// works on the date of its run (`localDate` of the payload, `Clock.runDate`):
// - every platform operator gets one email per organisation and notice day, 30, 7 and 1 days before `valid_until`
//   of the organisation's entitlement (template `entitlement_expiring`);
// - the organisation's Tenant Admins get the `licence_expiring` notice 30 and 7 days before, which
//   `notifications.dispatch` emails. `license.check` writes the same notice (60, 30 and 7 days) and the two share it,
//   so a Tenant Admin gets one notice and one email per notice day, whichever job runs first.
// Nothing is sent for an entitlement without an end date or one that is not valid on the run's date (in grace, not
// yet valid, or a clock set back). The emails go out after the transaction commits; a failed send is logged.
//
// A failed send (`AccountMailer.send` answers false, it never throws). When no operator email of the run could be
// sent (the mail server cannot be reached), the job deletes the run's ledger row in platform scope, the way the tick
// hands back a run whose send the queue dropped: the next hourly tick catches the run up while its date is still the
// current or the previous local date, and nobody got the email before, so nobody gets it twice. The Tenant Admins'
// notice is written once whatever the number of runs. When only some emails could be sent, the row stays: a second
// run would email again the operators who got it, so the others miss that reminder and the job logs an error.
//
// Entitlements exist in multi tenancy only, so the handler exists only there: `entitlementExpiryJobProvider` gives no
// instance in single tenancy, and `scheduler.tick` schedules only jobs that have a handler (no ledger rows, no job).
import { Injectable, Logger, type FactoryProvider } from '@nestjs/common';
import { Clock } from '../../common/clock';
import { JOB_HANDLER_METADATA, JobHandler, type JobHandlerInstance } from '../../common/jobs/job-handler';
import type { JobRun } from '../../common/jobs/job-queue';
import { SYSTEM_USER_ID, type Trx } from '../../common/tokens';
import { MscdConfig } from '../../config/mscd-config';
import { AccountMailer, type AccountMail } from '../identity/account-mailer';
import { inPlatformScope } from '../identity/platform-scope';
import { TenantResolver } from '../tenancy/tenant-resolver';
import { TenantScope } from '../tenancy/tenant-scope';
import { LicenceService } from './licence.service';

/** Days before `valid_until` on which every platform operator is emailed (J.3). */
export const OPERATOR_EXPIRY_NOTICE_DAYS = [30, 7, 1] as const;
/** Days before `valid_until` on which the Tenant Admins get the `licence_expiring` notice (J.3). */
export const ADMIN_EXPIRY_NOTICE_DAYS = [30, 7] as const;

export interface EntitlementExpiryResult {
  /** The local date the run worked on. */
  today: string;
  /** Days from `today` to `valid_until`; null without an entitlement that ends and is valid today. */
  days: number | null;
  /** `licence_expiring` notices written for Tenant Admins (0 when `license.check` wrote them first). */
  adminNotices: number;
  /** Operator emails sent. */
  operatorEmails: number;
  /** Operator emails that could not be sent. */
  operatorEmailsFailed: number;
  /** True when no operator email could be sent and the run's ledger row was deleted, so the next tick runs it again. */
  handedBack: boolean;
}

@Injectable()
@JobHandler('entitlement.expiry', { concurrency: 1, scope: 'tenant' })
export class EntitlementExpiryJob implements JobHandlerInstance<'entitlement.expiry'> {
  private readonly logger = new Logger('entitlement.expiry');

  constructor(
    private readonly licences: LicenceService,
    private readonly scope: TenantScope,
    private readonly tenants: TenantResolver,
    private readonly clock: Clock,
    private readonly mailer: AccountMailer | null,
  ) {}

  async handle(job: JobRun<'entitlement.expiry'>): Promise<void> {
    const result = await this.run(job.env.orgId, job.env.requestId, job.env.payload.localDate);
    const fields = {
      jobId: job.id,
      orgId: job.env.orgId,
      attempt: job.attempt,
      days: result?.days ?? null,
      adminNotices: result?.adminNotices ?? 0,
      operatorEmails: result?.operatorEmails ?? 0,
      operatorEmailsFailed: result?.operatorEmailsFailed ?? 0,
    };
    if (!result || result.operatorEmailsFailed === 0) {
      this.logger.log(fields, 'entitlement.expiry done');
    } else if (result.handedBack) {
      this.logger.warn(fields, `entitlement.expiry: no operator email could be sent; the next scheduler.tick runs the date ${result.today} again`);
    } else {
      this.logger.error(fields, `entitlement.expiry: ${result.operatorEmailsFailed} of ${result.operatorEmails + result.operatorEmailsFailed} operator emails could not be sent and are not sent again`);
    }
  }

  /** One run for an organisation on its local date; null when the organisation is gone or not active. */
  async run(orgId: string | null, requestId?: string, runLocalDate?: string): Promise<EntitlementExpiryResult | null> {
    if (!orgId) throw new Error('entitlement.expiry needs the organisation of the job envelope');
    const org = await this.tenants.resolveById(orgId);
    if (!org || org.status !== 'active') return null;
    const today = await this.clock.runDate(org.id, runLocalDate);
    const mails: AccountMail[] = [];
    const result = await this.scope.withTenant({ orgId: org.id, schema: org.schema, userId: SYSTEM_USER_ID, requestId }, async (trx) => {
      const out: EntitlementExpiryResult = { today, days: null, adminNotices: 0, operatorEmails: 0, operatorEmailsFailed: 0, handedBack: false };
      const evaluated = await this.licences.evaluate(trx, org.id, { reportRollback: false, runLocalDate: today });
      const row = evaluated?.entitlement;
      if (!evaluated || !row || row.validUntil === null || evaluated.state !== 'valid' || evaluated.notYetValid) return out;
      const days = evaluated.daysToExpiry;
      out.days = days;
      if ((ADMIN_EXPIRY_NOTICE_DAYS as readonly number[]).includes(days)) {
        out.adminNotices = await this.licences.notifyExpiring(trx, evaluated, days, await this.licences.tenantAdmins(trx, org.id));
      }
      if ((OPERATOR_EXPIRY_NOTICE_DAYS as readonly number[]).includes(days) && this.mailer) {
        const link = this.mailer.appLink('/ops');
        for (const operator of await operatorsOf(trx)) {
          mails.push({
            to: { email: operator.email, userId: operator.id },
            template: {
              name: 'entitlement_expiring',
              link,
              organisation: org.name,
              slug: org.slug,
              plan: row.source === 'signed_licence' ? null : row.plan,
              licenceId: row.source === 'signed_licence' ? evaluated.record.licenseId : null,
              validUntil: row.validUntil,
              days,
              graceDays: row.graceDays,
            },
          });
        }
      }
      return out;
    });
    // After the commit: the run's ledger row keeps it to one run per date, so each operator gets one email.
    for (const mail of mails) {
      if (await this.mailer!.send(mail)) result.operatorEmails += 1;
      else result.operatorEmailsFailed += 1;
    }
    if (result.operatorEmailsFailed > 0 && result.operatorEmails === 0) {
      // Nobody got the email: hand the run back to the tick (see the file comment).
      await this.scope.withPlatform(
        (trx) =>
          trx.deleteFrom('platform.daily_job_run').where('organization_id', '=', org.id).where('job', '=', 'entitlement.expiry').where('local_date', '=', today).execute(),
        { scope: 'job', requestId },
      );
      result.handedBack = true;
    }
    return result;
  }
}

/** Active platform operators with an address (platform scope, read only). */
async function operatorsOf(trx: Trx): Promise<{ id: string; email: string }[]> {
  return inPlatformScope(trx, () =>
    trx
      .selectFrom('platform.platform_role as r')
      .innerJoin('platform.app_user as u', 'u.id', 'r.user_id')
      .select(['u.id', 'u.email'])
      .where('r.role', '=', 'platform_operator')
      .where('r.revoked_at', 'is', null)
      .where('u.status', '=', 'active')
      .where('u.deleted_at', 'is', null)
      .orderBy('u.email')
      .execute(),
  );
}

/**
 * The provider of the handler: an instance with tenancy.mode multi, none (null) in single tenancy. The handler registry
 * reads the `@JobHandler` metadata from a provider's metatype, which for a factory provider is the factory, so the
 * factory carries the class's metadata; with a null instance the registry skips the provider.
 */
function createEntitlementExpiryJob(
  config: MscdConfig,
  licences: LicenceService,
  scope: TenantScope | undefined,
  tenants: TenantResolver | undefined,
  clock: Clock | undefined,
  mailer: AccountMailer | undefined,
): EntitlementExpiryJob | null {
  if (config.profile.tenancy.mode !== 'multi' || !scope || !tenants) return null;
  return new EntitlementExpiryJob(licences, scope, tenants, clock ?? new Clock(config), mailer ?? null);
}
Reflect.defineMetadata(JOB_HANDLER_METADATA, Reflect.getMetadata(JOB_HANDLER_METADATA, EntitlementExpiryJob), createEntitlementExpiryJob);

export const entitlementExpiryJobProvider: FactoryProvider<EntitlementExpiryJob | null> = {
  provide: EntitlementExpiryJob,
  useFactory: createEntitlementExpiryJob,
  inject: [
    MscdConfig,
    LicenceService,
    { token: TenantScope, optional: true },
    { token: TenantResolver, optional: true },
    { token: Clock, optional: true },
    { token: AccountMailer, optional: true },
  ],
};

