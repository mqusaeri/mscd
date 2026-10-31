// The purge of one organisation (Milestone 3 D.5.2 to D.5.5; M3-03), run by `org.purge` in the worker. It deletes, for
// good, an archived organisation whose deletion is running and due, in ten steps that each write their result into
// `organization_deletion.report`; a step that is done is never run again, so a retry (`ops.deletion.retry`) continues
// from the failed step:
//   1. check        the deletion is running and due, the organisation archived (or deleted by an earlier run that
//                   failed later), and no other purge runs (session advisory lock on a pinned connection);
//   2. access       sessions, invitations, calendar feed tokens and guest auditor grants of the organisation end;
//   3. accounts     each account whose only membership is this one (no platform operator, no system account) is
//                   anonymised (AccountAnonymiser); the values to replace in the audit entries are sealed in the
//                   report with platform.key until step 6 uses them;
//   4. vault        `gateway.tenants.purge`: every version of every object under tenants/<orgId>/ and the gateway's
//                   cached data key;
//   5. database     `platform.purge_organization`: the schema, the organisation's platform rows and its data key;
//   6. audit        the platform audit entries of the organisation, redacted with one attestation (AuditRedactor);
//   7. organization status deleted, with a status event; slug, name, time zone and region stay;
//   8. checks       D.5.3, each recorded with its result; one that fails fails the purge;
//   9. certificate  the signed certificate (D.5.5); the deletion is completed;
//  10. emails       the certificate to the Tenant Admins captured at scheduling and to every platform operator; the
//                   sealed address list is cleared.
// A failure marks the deletion failed with the step and an error text without personal data, audits
// `tenant.purge_failed` and emails the platform operators. R-20: only `org.lifecycle`, `ops.deletion.retry` and the
// commands of cli/tenant.ts queue this job, never before the deletion date.
import { createHash, randomUUID } from 'node:crypto';
import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { sql } from 'kysely';
import { Clock } from '../../../common/clock';
import { localDate } from '../../../common/dates';
import { AUDIT_WRITER, GATEWAY_CLIENT, SYSTEM_USER_ID, type AuditWriter, type GatewayClient, type Trx } from '../../../common/tokens';
import { MscdConfig } from '../../../config/mscd-config';
import { DATABASE, type AppDatabase } from '../../../db/database.module';
import { AuditRedactor } from '../../audit/audit-redactor';
import { AuditChainVerifier } from '../../audit/chain-verifier';
import { AccountAnonymiser } from '../../identity/account-anonymiser';
import { inPlatformScope } from '../../identity/platform-scope';
import { anchorPlatformHead, loadAnchorSigningKey, type AnchorSigningKey } from '../../jobs/audit-verify-chain.job';
import type { FileKeyProvider } from '../../keys/file-key-provider';
import { PLATFORM_KEY_PROVIDER } from '../../keys/secret-box';
import { publishTenantChange } from '../../license/tenant-change';
import { purgeTenantStorage } from '../../storage/gateway-client';
import { TenantResolver } from '../../tenancy/tenant-resolver';
import { TENANT_SCHEMA, TenantScope } from '../../tenancy/tenant-scope';
import { CERTIFICATE_TYPE, certificateFileName, certificateFileText, signCertificate, type DeletionCertificate } from './certificate';
import { EXPORT_STATUSES_AFTER_PURGE, KEPT_PLATFORM_TABLES, PURGED_PLATFORM_TABLES } from './deletion-coverage';
import { DeletionMailer } from './deletion-mailer';
import {
  PURGE_STEPS,
  addDaysTo,
  archivedAt,
  deletionById,
  lifecyclePeriods,
  offboardingStartedAt,
  openNotifyEmails,
  platformOperators,
  reportOf,
  type DeletionRow,
  type PurgeCheckResult,
  type PurgeReport,
  type PurgeStep,
} from './deletion-records';

/** Key of the session advisory lock that lets one purge run at a time in the installation. */
const PURGE_LOCK_KEY = 0x6d736364; // 'mscd'
const PURGE_LOCK_CLASS = 7003;

/** The organisation a purge works on. */
interface PurgeOrg {
  id: string;
  slug: string;
  name: string;
  schema_name: string;
  status: string;
  time_zone: string;
  region: string | null;
}

/** What a step returns: a line for the report and its counts, and the report members it adds. */
interface StepOutcome {
  detail: string;
  counts?: Record<string, number | boolean>;
  patch?: Partial<PurgeReport>;
}

/** A purge step stops with this error; the message is safe to store and show (no personal data). */
export class PurgeStepError extends Error {}

/** The outcome of one run. */
export interface PurgeRunResult {
  deletionId: string;
  status: 'completed' | 'failed' | 'skipped';
  failedStep?: PurgeStep;
  reason?: string;
}

function messageOf(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error);
  // Never store an email address in the error column (the report holds no personal data).
  return text.replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, '[email]').slice(0, 1000);
}

/** A pseudonym for an account that keeps its values (another membership, an operator): stable for one deletion. */
export function keptPseudonym(deletionId: string, userId: string): string {
  return `erased-${createHash('sha256').update(`${deletionId}:${userId}`).digest('hex').slice(0, 8)}`;
}

@Injectable()
export class PurgeRunner {
  private readonly logger = new Logger('org.purge');
  private anchorKey?: AnchorSigningKey | null;

  constructor(
    private readonly config: MscdConfig,
    private readonly scope: TenantScope,
    private readonly clock: Clock,
    private readonly tenants: TenantResolver,
    private readonly anonymiser: AccountAnonymiser,
    private readonly redactor: AuditRedactor,
    private readonly verifier: AuditChainVerifier,
    private readonly mailer: DeletionMailer,
    @Inject(DATABASE) private readonly db: AppDatabase,
    @Inject(PLATFORM_KEY_PROVIDER) private readonly keys: FileKeyProvider,
    @Inject(AUDIT_WRITER) private readonly audit: AuditWriter,
    @Optional() @Inject(GATEWAY_CLIENT) private readonly gateway?: GatewayClient,
  ) {}

  /** Runs one deletion from its first or failed step while holding the purge lock. */
  async run(deletionId: string, requestId?: string): Promise<PurgeRunResult> {
    // The session advisory lock needs one pinned connection for the whole run; it reads no table, and every step
    // queries through withPlatform or withTenant.
    // eslint-disable-next-line no-restricted-syntax
    return this.db.connection().execute(async (conn) => {
      const locked = await sql<{ ok: boolean }>`select pg_try_advisory_lock(${PURGE_LOCK_CLASS}, ${PURGE_LOCK_KEY}) as ok`.execute(conn);
      if (!locked.rows[0]?.ok) {
        this.logger.warn({ deletionId }, 'Another purge runs in this installation; org.lifecycle queues this one again within the hour');
        return { deletionId, status: 'skipped', reason: 'another purge runs' };
      }
      try {
        return await this.runLocked(deletionId, requestId);
      } finally {
        await sql`select pg_advisory_unlock(${PURGE_LOCK_CLASS}, ${PURGE_LOCK_KEY})`.execute(conn).catch(() => undefined);
      }
    });
  }

  private async runLocked(deletionId: string, requestId?: string): Promise<PurgeRunResult> {
    const loaded = await this.platform((trx) => this.load(trx, deletionId), requestId);
    if (!loaded) return { deletionId, status: 'skipped', reason: 'unknown deletion' };
    const { row, org } = loaded;
    if (row.status !== 'running') {
      this.logger.warn({ deletionId, status: row.status }, 'The deletion is not running; nothing to do');
      return { deletionId, status: 'skipped', reason: `deletion ${row.status}` };
    }
    let report = reportOf(row.report);
    if (!row.started_at) {
      await this.platform(async (trx) => {
        await trx.updateTable('platform.organization_deletion').set({ started_at: this.clock.now() }).where('id', '=', deletionId).execute();
        await this.audit.record(trx, {
          action: 'tenant.purge_started',
          actor: { userId: SYSTEM_USER_ID, kind: 'system' },
          organizationId: org.id,
          entityType: 'organization_deletion',
          entityId: deletionId,
          entityCode: org.slug,
          after: { scheduledFor: row.scheduled_for.toISOString(), reapplied: report.reapplied ?? null },
          sourceIp: null,
          userAgent: null,
        });
      }, requestId);
    }

    for (const step of PURGE_STEPS) {
      const current = report.steps.find((s) => s.step === step)!;
      if (current.status === 'done') continue;
      try {
        report = await this.runStep(step, deletionId, org, report, requestId);
      } catch (error) {
        if (step === 'emails') {
          // The deletion is complete; a mail failure is logged and the step recorded as failed without failing it.
          this.logger.error({ deletionId }, `The certificate emails failed: ${messageOf(error)}`);
          break;
        }
        await this.fail(deletionId, org, report, step, error, requestId);
        return { deletionId, status: 'failed', failedStep: step, reason: messageOf(error) };
      }
    }
    return { deletionId, status: 'completed' };
  }

  /** One step: its work, then the report (and the step's status) written, in one transaction where the step allows. */
  private async runStep(step: PurgeStep, deletionId: string, org: PurgeOrg, report: PurgeReport, requestId?: string): Promise<PurgeReport> {
    const mark = (r: PurgeReport, outcome: StepOutcome): PurgeReport => ({
      ...r,
      ...outcome.patch,
      steps: r.steps.map((s) =>
        s.step === step ? { step, status: 'done', at: this.clock.now().toISOString(), detail: outcome.detail.slice(0, 500), ...(outcome.counts ? { counts: outcome.counts } : {}) } : s,
      ),
    });
    switch (step) {
      case 'check':
        return this.persist(deletionId, mark(report, await this.platform((trx) => this.stepCheck(trx, deletionId, org, report), requestId)), requestId);
      case 'access': {
        const outcome = await this.stepAccess(org, requestId);
        return this.persist(deletionId, mark(report, outcome), requestId);
      }
      case 'accounts':
        return this.platform(async (trx) => this.persistIn(trx, deletionId, mark(report, await this.stepAccounts(trx, deletionId, org))), requestId);
      case 'vault': {
        const outcome = await this.stepVault(org, requestId);
        // The count goes into `vault_objects_deleted` at once, in its own transaction, and a retry keeps the larger
        // value: a retry after a failed write finds nothing left in the vault, and the backup guard allowance (D.5.6)
        // must still count the objects this purge removed.
        const deleted = outcome.patch?.vault?.objectsDeleted ?? 0;
        const total = await this.platform(async (trx) => {
          const row = await trx
            .updateTable('platform.organization_deletion')
            .set({ vault_objects_deleted: sql<string>`greatest(coalesce(vault_objects_deleted, 0), ${deleted}::bigint)` })
            .where('id', '=', deletionId)
            .returning('vault_objects_deleted')
            .executeTakeFirstOrThrow();
          return Number(row.vault_objects_deleted ?? deleted);
        }, requestId);
        const counted: StepOutcome =
          total > deleted && outcome.patch?.vault
            ? {
                detail: `${outcome.detail}; ${total} object(s) in all, removed by an earlier attempt of this step`,
                counts: { ...outcome.counts, objectsDeleted: total },
                patch: { vault: { ...outcome.patch.vault, objectsDeleted: total } },
              }
            : outcome;
        return this.persist(deletionId, mark(report, counted), requestId);
      }
      case 'database':
        return this.platform(async (trx) => this.persistIn(trx, deletionId, mark(report, await this.stepDatabase(trx, org))), requestId);
      case 'audit':
        return this.platform(async (trx) => this.persistIn(trx, deletionId, mark(report, await this.stepAudit(trx, deletionId, org, report))), requestId);
      case 'organization': {
        const next = await this.platform(async (trx) => this.persistIn(trx, deletionId, mark(report, await this.stepOrganization(trx, deletionId, org))), requestId);
        this.tenants.invalidate(org.id);
        return next;
      }
      case 'checks': {
        const checks = await this.stepChecks(deletionId, org, report, requestId);
        const failed = checks.checks.filter((c) => !c.passed);
        if (failed.length > 0) {
          await this.persist(deletionId, { ...report, checks: checks.checks, anchor: checks.anchor }, requestId);
          throw new PurgeStepError(`${failed.length} check(s) failed: ${failed.map((c) => c.check).join(', ')}`);
        }
        return this.persist(
          deletionId,
          mark({ ...report, checks: checks.checks, anchor: checks.anchor }, { detail: `${checks.checks.length} checks passed`, counts: { checks: checks.checks.length } }),
          requestId,
        );
      }
      case 'certificate':
        return this.platform(async (trx) => this.stepCertificate(trx, deletionId, org, report, mark), requestId);
      case 'emails': {
        const outcome = await this.stepEmails(deletionId, org, requestId);
        return this.persist(deletionId, mark(report, outcome), requestId);
      }
    }
  }

  // -----------------------------------------------------------------------------------------------------------------
  // Steps
  // -----------------------------------------------------------------------------------------------------------------

  /** 1. The deletion is running and due and the organisation archived (or deleted by an earlier, later-failed run). */
  private async stepCheck(trx: Trx, deletionId: string, org: PurgeOrg, report: PurgeReport): Promise<StepOutcome> {
    const row = await deletionById(trx, deletionId, { lock: true });
    if (!row || row.status !== 'running') throw new PurgeStepError(`The deletion is ${row?.status ?? 'missing'}; only a running deletion is purged`);
    const due = await sql<{ due: boolean }>`select ${row.scheduled_for}::timestamptz <= now() as due`.execute(trx);
    if (!due.rows[0]?.due) throw new PurgeStepError(`The deletion is due on ${row.scheduled_for.toISOString()} and runs from that date`);
    const current = await trx.selectFrom('platform.organization').select('status').where('id', '=', org.id).executeTakeFirstOrThrow();
    const organizationDone = report.steps.find((s) => s.step === 'organization')?.status === 'done';
    if (current.status !== 'archived' && !(current.status === 'deleted' && organizationDone)) {
      throw new PurgeStepError(`The organisation is ${current.status}; only an archived organisation is purged`);
    }
    return { detail: `Deletion due since ${row.scheduled_for.toISOString()}; organisation ${current.status}` };
  }

  /** 2. Sessions, invitations, calendar feed tokens and guest auditor grants end. */
  private async stepAccess(org: PurgeOrg, requestId?: string): Promise<StepOutcome> {
    const now = this.clock.now();
    const platform = await this.platform(async (trx) => {
      const sessions = await trx
        .updateTable('platform.session')
        .set({ revoked_at: now, revoke_reason: 'organisation_deleted' })
        .where((eb) => eb.or([eb('organization_id', '=', org.id), eb('auth_org_id', '=', org.id)]))
        .where('revoked_at', 'is', null)
        .executeTakeFirst();
      const invitations = await trx
        .updateTable('platform.invitation')
        .set({ revoked_at: now })
        .where('organization_id', '=', org.id)
        .where('used_at', 'is', null)
        .where('revoked_at', 'is', null)
        .executeTakeFirst();
      return { sessions: Number(sessions.numUpdatedRows), invitations: Number(invitations.numUpdatedRows) };
    }, requestId);
    let tenant = { calendarFeeds: 0, auditorGrants: 0 };
    if (TENANT_SCHEMA.test(org.schema_name) && (await this.schemaExists(org.schema_name, requestId))) {
      tenant = await this.scope.withTenant({ orgId: org.id, schema: org.schema_name, userId: SYSTEM_USER_ID, requestId }, async (trx) => {
        const feeds = await trx.deleteFrom('calendar_feed_token').executeTakeFirst();
        const grants = await trx
          .updateTable('auditor_access_grant')
          .set({ revoked_at: now, updated_at: now })
          .where('revoked_at', 'is', null)
          .executeTakeFirst();
        return { calendarFeeds: Number(feeds.numDeletedRows), auditorGrants: Number(grants.numUpdatedRows) };
      });
    }
    const counts = { ...platform, ...tenant };
    return {
      detail: `${counts.sessions} session(s) ended, ${counts.invitations} invitation(s) revoked, ${counts.calendarFeeds} calendar feed(s) removed, ${counts.auditorGrants} auditor grant(s) revoked`,
      counts,
    };
  }

  /**
   * 3. Accounts that belonged only to this organisation are anonymised; the others keep everything but this
   * membership (step 5 removes the membership rows). The values to replace in the platform audit entries of step 6 (the
   * email, handle and name of every member and of every actor of those entries) are sealed into the report. Also
   * records the organisation's repositories in the customer's own drives for the certificate (the schema goes in step 5).
   */
  private async stepAccounts(trx: Trx, deletionId: string, org: PurgeOrg): Promise<StepOutcome> {
    const people = await inPlatformScope(trx, async () => {
      const { rows } = await sql<{ id: string; email: string; handle: string; display_name: string; kind: string; member: boolean }>`
        select u.id, u.email, u.handle, u.display_name, u.kind, true as member
          from platform.app_user u
         where u.id in (select m.user_id from platform.org_membership m where m.organization_id = ${org.id})
        union
        select u.id, u.email, u.handle, u.display_name, u.kind, false as member
          from platform.app_user u
         where u.id in (select a.actor_user_id from platform.audit_log a where a.organization_id = ${org.id} and a.actor_user_id is not null)
           and u.id not in (select m.user_id from platform.org_membership m where m.organization_id = ${org.id})`.execute(trx);
      return rows;
    });
    const replacements: Record<string, string> = {};
    const anonymised: string[] = [];
    let kept = 0;
    const add = (values: readonly string[], pseudonym: string) => {
      for (const value of values) if (value && value.trim().length >= 3 && value !== pseudonym) replacements[value] = pseudonym;
    };
    for (const person of people) {
      if (person.id === SYSTEM_USER_ID || person.kind === 'system') continue;
      const old = [person.email, person.handle, person.display_name];
      const done = person.member
        ? await this.anonymiser.anonymise(trx, person.id, { reason: `Organisation ${org.slug} deleted`, organizationId: org.id, leavingOrgId: org.id })
        : null;
      if (done) {
        anonymised.push(person.id);
        add(old, done.handle);
      } else {
        if (person.member) kept += 1;
        add(old, keptPseudonym(deletionId, person.id));
      }
    }
    const repositories = await this.customerRepositories(org);
    const sealed = await this.keys.wrap(Buffer.from(JSON.stringify(replacements), 'utf8'), `deletion-redaction:${deletionId}`);
    return {
      detail: `${anonymised.length} account(s) anonymised, ${kept} kept for their other memberships`,
      counts: { anonymised: anonymised.length, kept, replacements: Object.keys(replacements).length },
      patch: { anonymisedUserIds: anonymised, keptAccounts: kept, replacementsSealed: sealed, repositories },
    };
  }

  /** The organisation's repositories in the customer's Microsoft 365 or Google Drive (adapter and name). */
  private async customerRepositories(org: PurgeOrg): Promise<{ adapter: string; name: string }[]> {
    if (!TENANT_SCHEMA.test(org.schema_name) || !(await this.schemaExists(org.schema_name))) return [];
    return this.scope.withTenant({ orgId: org.id, schema: org.schema_name, userId: SYSTEM_USER_ID }, async (trx) => {
      const rows = await trx
        .selectFrom('storage_repository')
        .select(['adapter', 'name'])
        .where('adapter', 'in', ['m365', 'google_drive'])
        .orderBy('adapter')
        .orderBy('name')
        .execute();
      return rows.map((r) => ({ adapter: r.adapter, name: r.name }));
    });
  }

  /** 4. Every object version of the organisation in the vault bucket, and the gateway's cached data key. */
  private async stepVault(org: PurgeOrg, requestId?: string): Promise<StepOutcome> {
    if (!this.gateway) throw new PurgeStepError('This process has no storage gateway client; the vault step runs in the worker');
    const result = await purgeTenantStorage(this.gateway, org.id, { requestId });
    const retained = result.retained.map((r) => ({ key: r.key, retainUntil: r.retainUntil }));
    return {
      detail: `${result.objectsDeleted} object(s) with ${result.versionsDeleted} version(s) removed${retained.length > 0 ? `; ${retained.length} kept by a bucket retention rule` : ''}`,
      counts: { objectsDeleted: result.objectsDeleted, versionsDeleted: result.versionsDeleted, retained: retained.length },
      patch: { vault: { objectsDeleted: result.objectsDeleted, versionsDeleted: result.versionsDeleted, retained } },
    };
  }

  /** 5. `platform.purge_organization`: the schema, the platform rows of the organisation and its data key. */
  private async stepDatabase(trx: Trx, org: PurgeOrg): Promise<StepOutcome> {
    const { rows } = await sql<{ counts: Record<string, number | boolean> }>`select platform.purge_organization(${org.id}::uuid) as counts`.execute(trx);
    const counts = rows[0]?.counts ?? {};
    return {
      detail: `Schema ${org.schema_name} dropped; ${Number(counts.memberships ?? 0)} membership(s), ${Number(counts.sessions ?? 0)} session(s) and the data key removed`,
      counts,
    };
  }

  /** 6. The platform audit entries of the organisation, redacted with one attestation `tenant.audit_redacted`. */
  private async stepAudit(trx: Trx, deletionId: string, org: PurgeOrg, report: PurgeReport): Promise<StepOutcome> {
    const replacements = report.replacementsSealed
      ? (JSON.parse((await this.keys.unwrap(report.replacementsSealed, `deletion-redaction:${deletionId}`)).toString('utf8')) as Record<string, string>)
      : {};
    const seqs = await this.redactor.platformSeqsOf(trx, org.id);
    const result = await this.redactor.redact(trx, {
      chain: 'platform',
      seqs,
      replacements,
      attestation: {
        action: 'tenant.audit_redacted',
        reason: `Verified deletion of organisation ${org.slug} (deletion ${deletionId})`,
        organizationId: org.id,
        entityType: 'organization',
        entityId: org.id,
        entityCode: org.slug,
      },
    });
    return {
      detail: `${result.redacted} entr${result.redacted === 1 ? 'y' : 'ies'} redacted, ${result.unchanged} held nothing to remove; attestation ${result.attestationSeq}`,
      counts: { redacted: result.redacted, unchanged: result.unchanged, attestationSeq: result.attestationSeq },
      patch: { redaction: { redactionId: result.redactionId, redacted: result.redacted, unchanged: result.unchanged, attestationSeq: result.attestationSeq }, replacementsSealed: null },
    };
  }

  /** 7. Status deleted with a status event; the change notice drops the organisation from every cache. */
  private async stepOrganization(trx: Trx, deletionId: string, org: PurgeOrg): Promise<StepOutcome> {
    const current = await trx.selectFrom('platform.organization').select('status').where('id', '=', org.id).forNoKeyUpdate().executeTakeFirstOrThrow();
    if (current.status !== 'deleted') {
      await trx.updateTable('platform.organization').set({ status: 'deleted', offboarding_ends_at: null }).where('id', '=', org.id).execute();
      await trx
        .insertInto('platform.organization_status_event')
        .values({
          organization_id: org.id,
          from_status: current.status,
          to_status: 'deleted',
          reason: `Verified deletion (deletion ${deletionId})`,
          actor_user_id: null,
          created_at: this.clock.now(),
        })
        .execute();
    }
    await publishTenantChange(trx, org.id);
    return { detail: `Organisation ${org.slug} is deleted; its slug is never used again` };
  }

  /** 8. The checks of D.5.3, and the anchor that covers the attestation of step 6. */
  private async stepChecks(deletionId: string, org: PurgeOrg, report: PurgeReport, requestId?: string): Promise<{ checks: PurgeCheckResult[]; anchor: PurgeReport['anchor'] }> {
    const checks: PurgeCheckResult[] = [];
    const add = (check: string, passed: boolean, detail: string) => checks.push({ check, passed, detail });

    // The schema.
    const schemaGone = !(await this.schemaExists(org.schema_name, requestId));
    add('schema', schemaGone, schemaGone ? `Schema ${org.schema_name} does not exist` : `Schema ${org.schema_name} still exists`);

    // Rows of the platform tables (with the organisation set too: the policy of idempotency_key reads app.org_id only).
    const leftovers = await this.scope.withPlatform(async (trx) => {
      const found: string[] = [];
      for (const table of PURGED_PLATFORM_TABLES) {
        const { rows } = await sql<{ n: string }>`select count(*) as n from ${sql.table(`platform.${table.table}`)} where ${sql.raw(table.where.replaceAll('$1', `'${org.id}'::uuid`))}`.execute(trx);
        const n = Number(rows[0]?.n ?? 0);
        if (n > 0) found.push(`${table.table} (${n})`);
      }
      const exports = await trx
        .selectFrom('platform.organization_export')
        .select((eb) => eb.fn.countAll<string>().as('n'))
        .where('organization_id', '=', org.id)
        .where('status', 'not in', [...EXPORT_STATUSES_AFTER_PURGE])
        .executeTakeFirstOrThrow();
      if (Number(exports.n) > 0) found.push(`organization_export (${exports.n} not expired, rejected or failed)`);
      return found;
    }, { scope: 'job', orgId: org.id, ...(requestId ? { requestId } : {}) });
    add(
      'platform rows',
      leftovers.length === 0,
      leftovers.length === 0
        ? `No row of the organisation remains in ${PURGED_PLATFORM_TABLES.length} platform tables; kept by design: ${Object.keys(KEPT_PLATFORM_TABLES).join(', ')}`
        : `Rows remain in ${leftovers.join(', ')}`,
    );

    // The vault: a second purge finds nothing left but what a bucket rule protects.
    if (this.gateway) {
      try {
        const again = await purgeTenantStorage(this.gateway, org.id, { requestId });
        const ok = again.objectsDeleted === 0 && again.versionsDeleted === 0;
        add('vault', ok, ok ? `No object left under tenants/${org.id}/ (${again.retained.length} kept by a bucket retention rule)` : `${again.objectsDeleted} object(s) were still there and are removed now`);
      } catch (error) {
        add('vault', false, `The vault could not be listed: ${messageOf(error)}`);
      }
    } else {
      add('vault', false, 'This process has no storage gateway client');
    }

    // The data key.
    const keyGone = await this.platform(async (trx) => {
      const row = await trx.selectFrom('platform.tenant_key').select('organization_id').where('organization_id', '=', org.id).executeTakeFirst();
      return row === undefined;
    }, requestId);
    add('data key', keyGone, keyGone ? 'No wrapped data key of the organisation remains, so nothing of it can be unwrapped' : 'The wrapped data key still exists');

    // The accounts.
    const ids = report.anonymisedUserIds ?? [];
    const left = await this.platform((trx) => this.anonymiser.leftovers(trx, ids), requestId);
    add('accounts', left === 0, left === 0 ? `${ids.length} account(s) hold no email, name or secret` : `${left} account(s) still hold an email, a name or a secret`);

    // The platform chain verifies and its newest row (at least the attestation) is covered by an anchor.
    let anchor: PurgeReport['anchor'] = null;
    try {
      const outcome = await anchorPlatformHead(
        { scope: this.scope, verifier: this.verifier, logger: this.logger, gateway: this.gateway, key: this.signingKey(), now: this.clock.now() },
        requestId,
      );
      // D.5.4: the anchor covers this purge's attestation and every other attestation that accepts a redacted row.
      const attestation = Math.max(report.redaction?.attestationSeq ?? 0, outcome.result.redactionHeadSeq ?? 0);
      const intact = (outcome.result.firstBrokenSeq ?? null) === null && outcome.result.anchorOk;
      const covered = outcome.anchoredSeq !== null && outcome.anchoredSeq >= attestation;
      anchor = outcome.anchoredSeq !== null ? { seq: outcome.anchoredSeq, anchoredAt: outcome.anchored?.anchoredAt ?? this.clock.now().toISOString() } : null;
      add(
        'audit chain',
        intact && covered,
        intact
          ? covered
            ? `The platform chain verifies (${outcome.result.checked} entries, ${outcome.result.redacted} redacted) and its head ${outcome.anchoredSeq} is anchored`
            : `The platform chain verifies but its head is not anchored (${outcome.skipped ?? 'no anchor'})`
          : `The platform chain does not verify (first broken entry ${outcome.result.firstBrokenSeq ?? 'none'}, anchor ${outcome.result.anchorOk ? 'ok' : 'not ok'})`,
      );
    } catch (error) {
      add('audit chain', false, `The platform chain could not be verified: ${messageOf(error)}`);
    }
    return { checks, anchor };
  }

  /** 9. The signed certificate; the deletion is completed. */
  private async stepCertificate(
    trx: Trx,
    deletionId: string,
    org: PurgeOrg,
    report: PurgeReport,
    mark: (r: PurgeReport, outcome: StepOutcome) => PurgeReport,
  ): Promise<PurgeReport> {
    const key = this.signingKey();
    if (!key) throw new PurgeStepError('No audit anchor key (audit.anchor_key_file): the certificate cannot be signed');
    const row = await deletionById(trx, deletionId, { lock: true });
    if (!row) throw new PurgeStepError('The deletion record is gone');
    const now = this.clock.now();
    const certificate = await this.buildCertificate(trx, row, org, report, now);
    const { signature, keyId } = signCertificate(certificate, key);
    const next = mark(report, { detail: `Certificate ${certificate.certificateId} signed with key ${keyId}`, counts: {} });
    await trx
      .updateTable('platform.organization_deletion')
      .set({
        status: 'completed',
        completed_at: now,
        failed_step: null,
        error: null,
        certificate: JSON.stringify(certificate),
        certificate_signature: signature,
        certificate_key_id: keyId,
        report: JSON.stringify(next),
      })
      .where('id', '=', deletionId)
      .execute();
    await this.audit.record(trx, {
      action: 'tenant.purged',
      actor: { userId: SYSTEM_USER_ID, kind: 'system' },
      organizationId: org.id,
      entityType: 'organization_deletion',
      entityId: deletionId,
      entityCode: org.slug,
      after: { certificateId: certificate.certificateId, keyId, vaultObjectsDeleted: report.vault?.objectsDeleted ?? 0, checks: report.checks.length },
      sourceIp: null,
      userAgent: null,
    });
    return next;
  }

  /** 10. The certificate emails; the sealed address list is cleared afterwards. */
  private async stepEmails(deletionId: string, org: PurgeOrg, requestId?: string): Promise<StepOutcome> {
    const loaded = await this.platform(async (trx) => {
      const row = await deletionById(trx, deletionId);
      return { row, operators: await platformOperators(trx) };
    }, requestId);
    const row = loaded.row;
    if (!row || !row.certificate || !row.certificate_signature || !row.certificate_key_id) throw new PurgeStepError('The certificate is missing');
    const certificate = row.certificate as DeletionCertificate;
    const admins = await openNotifyEmails(this.keys, deletionId, row.notify_emails_sealed).catch(() => [] as string[]);
    const recipients = [...new Set([...admins, ...loaded.operators.map((o) => o.email)])];
    const fileName = certificateFileName(certificate);
    const content = certificateFileText(certificate, row.certificate_signature, row.certificate_key_id);
    let sent = 0;
    for (const to of recipients) {
      const ok = await this.mailer.send({
        to,
        template: {
          name: 'organization_deletion_certificate',
          organisation: org.name,
          slug: org.slug,
          certificateId: certificate.certificateId,
          completedOn: localDate(new Date(certificate.dates.deletionCompletedAt), org.time_zone),
          backupsEndBy: certificate.backups.copiesEndBy,
          fileName,
        },
        attachment: { fileName, content, contentType: 'application/json' },
      });
      if (ok) sent += 1;
    }
    await this.platform(
      (trx) => trx.updateTable('platform.organization_deletion').set({ notify_emails_sealed: null }).where('id', '=', deletionId).execute(),
      requestId,
    );
    return {
      detail: `The certificate was emailed to ${sent} of ${recipients.length} recipient(s) (${admins.length} Tenant Admin(s) and ${loaded.operators.length} platform operator(s)); the address list is cleared`,
      counts: { recipients: recipients.length, sent, tenantAdmins: admins.length, operators: loaded.operators.length },
      patch: { emails: { recipients: recipients.length, sent } },
    };
  }

  // -----------------------------------------------------------------------------------------------------------------
  // The certificate (D.5.5)
  // -----------------------------------------------------------------------------------------------------------------

  private async buildCertificate(trx: Trx, row: DeletionRow, org: PurgeOrg, report: PurgeReport, now: Date): Promise<DeletionCertificate> {
    const installation = await trx.selectFrom('platform.installation').select('id').executeTakeFirstOrThrow();
    const archived = await archivedAt(trx, org.id);
    const offboarding = await offboardingStartedAt(trx, org.id);
    const finalExport = row.final_export_id
      ? await trx.selectFrom('platform.organization_export').select(['id', 'status', 'completed_at', 'manifest_sha256']).where('id', '=', row.final_export_id).executeTakeFirst()
      : undefined;
    const exportTaken = finalExport && finalExport.completed_at !== null && finalExport.manifest_sha256 !== null;
    const periods = lifecyclePeriods(this.config);
    const copiesEndBy = localDate(addDaysTo(now, periods.backupCopiesEndDays), org.time_zone);
    const repositories = report.repositories ?? [];
    return {
      type: CERTIFICATE_TYPE,
      certificateId: randomUUID(),
      deletionId: row.id,
      installationId: installation.id,
      issuedAt: now.toISOString(),
      organization: { id: org.id, slug: org.slug, name: org.name },
      dates: {
        offboardingStartedAt: offboarding ? offboarding.toISOString() : null,
        archivedAt: archived ? archived.toISOString() : null,
        deletionScheduledAt: row.created_at.toISOString(),
        deletionScheduledBy: row.scheduled_by ? 'platform operator' : 'system',
        deletionScheduledFor: row.scheduled_for.toISOString(),
        deletionCompletedAt: now.toISOString(),
      },
      finalExport: exportTaken ? { id: finalExport.id, readyAt: finalExport.completed_at!.toISOString(), manifestSha256: finalExport.manifest_sha256 } : null,
      finalExportText: exportTaken
        ? `The final export ${finalExport.id} was ready on ${finalExport.completed_at!.toISOString()} with the manifest SHA-256 ${finalExport.manifest_sha256}.`
        : 'No export taken: the organisation was deleted without a completed final export.',
      steps: report.steps
        .filter((s) => s.status === 'done' && s.step !== 'certificate' && s.step !== 'emails')
        .map((s) => ({ step: s.step, detail: s.detail, counts: s.counts ?? {} })),
      checks: report.checks.map((c) => ({ check: c.check, passed: c.passed, detail: c.detail })),
      remains: [
        `The organisation row of ${org.slug} with status deleted (slug, name, time zone and region), its status history and this deletion record: no personal data.`,
        'The platform audit entries of the organisation, redacted: action, time, organisation id and record ids stay; network addresses, browsers, emails and names were removed under an attestation that the audit chain verifies.',
        `The signed anchor files of the deleted audit chain under audit-anchors/${org.schema_name}.audit_trail/ in the vault bucket, outside tenants/${org.id}/, which object lock keeps for 10 years from each anchor. They hold the chain name (which carries the slug), sequence numbers, hashes, times and the installation id, and no personal data.`,
        ...(report.vault && report.vault.retained.length > 0
          ? [`${report.vault.retained.length} vault object(s) that a bucket retention rule still protects; they go when the rule ends (listed in the deletion report).`]
          : []),
        repositories.length > 0
          ? `The files and evidence pack copies in the customer's own repositories (${repositories.map((r) => `${r.adapter}: ${r.name}`).join('; ')}), which belong to the customer and which MSCD does not touch.`
          : 'No repository in the customer\'s own Microsoft 365 or Google Drive was connected.',
      ],
      customerRepositories: repositories,
      backups: {
        statement:
          'The deletion does not reach into the backups at once. The encrypted database backups (14 daily, 8 weekly and 12 monthly copies), the copies of the vault and the pre-deploy database copies age out on their own schedule, and with the recommended off-site bucket settings the last copy that holds this organisation is gone at the latest on the date below. The backups are kept at a second provider and used only to rebuild the whole service after a disaster and by the weekly restore test.',
        copiesEndBy,
        assumes: `The deletion date plus lifecycle.backup_copies_end_days (${periods.backupCopiesEndDays} days: 12 months of restic retention, 7 days to the next prune and 400 days of old versions kept by the off-site bucket's lifecycle rule). The date holds only while the off-site bucket keeps those settings.`,
      },
      howToVerify: 'mscd-server tenant verify-certificate <file> checks the signature against the trusted anchor keys of the release.',
    };
  }

  // -----------------------------------------------------------------------------------------------------------------
  // Helpers
  // -----------------------------------------------------------------------------------------------------------------

  private platform<T>(fn: (trx: Trx) => Promise<T>, requestId?: string): Promise<T> {
    return this.scope.withPlatform(fn, { scope: 'job', ...(requestId ? { requestId } : {}) });
  }

  private async load(trx: Trx, deletionId: string): Promise<{ row: DeletionRow; org: PurgeOrg } | null> {
    const row = await deletionById(trx, deletionId);
    if (!row) return null;
    const org = await trx
      .selectFrom('platform.organization')
      .select(['id', 'slug', 'name', 'schema_name', 'status', 'time_zone', 'region'])
      .where('id', '=', row.organization_id)
      .executeTakeFirst();
    return org ? { row, org } : null;
  }

  private async persist(deletionId: string, report: PurgeReport, requestId?: string): Promise<PurgeReport> {
    return this.platform((trx) => this.persistIn(trx, deletionId, report), requestId);
  }

  private async persistIn(trx: Trx, deletionId: string, report: PurgeReport): Promise<PurgeReport> {
    await trx.updateTable('platform.organization_deletion').set({ report: JSON.stringify(report) }).where('id', '=', deletionId).execute();
    return report;
  }

  private async schemaExists(schema: string, requestId?: string): Promise<boolean> {
    return this.platform(async (trx) => {
      const { rows } = await sql<{ found: boolean }>`select to_regnamespace(${schema}) is not null as found`.execute(trx);
      return rows[0]?.found === true;
    }, requestId);
  }

  private signingKey(): AnchorSigningKey | null {
    if (this.anchorKey === undefined) {
      try {
        this.anchorKey = loadAnchorSigningKey(this.config);
      } catch (error) {
        this.logger.error(`The audit anchor key cannot be read: ${messageOf(error)}`);
        this.anchorKey = null;
      }
    }
    return this.anchorKey;
  }

  /** Marks the deletion failed at `step`, audits it and alerts the platform operators by email. */
  private async fail(deletionId: string, org: PurgeOrg, report: PurgeReport, step: PurgeStep, error: unknown, requestId?: string): Promise<void> {
    const text = messageOf(error);
    this.logger.error({ deletionId, orgId: org.id, step }, `The purge failed at step ${step}: ${text}`);
    const operators = await this.platform(async (trx) => {
      // The stored report (a failed check step stored its checks before it threw), else the one of this run.
      const stored = await deletionById(trx, deletionId, { lock: true });
      const base = stored ? reportOf(stored.report) : report;
      const next: PurgeReport = {
        ...base,
        steps: base.steps.map((s) => (s.step === step ? { ...s, status: 'failed', at: this.clock.now().toISOString(), detail: text.slice(0, 500) } : s)),
      };
      await trx
        .updateTable('platform.organization_deletion')
        .set({ status: 'failed', failed_step: step, error: text, report: JSON.stringify(next) })
        .where('id', '=', deletionId)
        .where('status', '=', 'running')
        .execute();
      await this.audit.record(trx, {
        action: 'tenant.purge_failed',
        actor: { userId: SYSTEM_USER_ID, kind: 'system' },
        organizationId: org.id,
        entityType: 'organization_deletion',
        entityId: deletionId,
        entityCode: org.slug,
        after: { step, error: text.slice(0, 500) },
        sourceIp: null,
        userAgent: null,
      });
      return platformOperators(trx);
    }, requestId).catch((cause: unknown) => {
      this.logger.error({ deletionId }, `The failure could not be recorded: ${messageOf(cause)}`);
      return [];
    });
    for (const operator of operators) {
      await this.mailer.send({
        to: operator.email,
        template: { name: 'organization_deletion_failed', link: this.mailer.appLink('/'), organisation: org.name, slug: org.slug, step },
      });
    }
  }
}
