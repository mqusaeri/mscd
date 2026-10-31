// Email domains of an organisation, verified by a DNS TXT record (Milestone 2 D.1, J.3, K.6; M2-S11). Multi tenancy
// only: in single tenancy the routes answer 409 `conflict` with messageKey `single_tenancy` (J.6), and on-premise keeps
// the operator command `tenant verify-domain`.
//
// - `GET /ops/organizations/{org}/domains`: every domain of the organisation with its status, method, times and, while
//   pending, the end of its hourly checks.
// - `POST /ops/organizations/{org}/domains`: normalises the domain (lower case, IDN to punycode), refuses free mail
//   domains (422 `domain_not_allowed`) and a domain another organisation holds verified (409 `domain_taken`), stores
//   the SHA-256 of a new 32-byte token (never the token) and answers the record `_mscd-verify.<domain>` TXT
//   `mscd-verify=<token>` once. Adding a pending or failed domain again gives a new token and 7 more days. Queues a
//   first check a minute later (a record put in place beforehand is found at once). Audited `ops.domain_added`.
// - `POST .../{domain}/verify`: checks the record now. Found: pending or failed becomes verified (`ops.domain_verified`).
//   Not found: `ops.domain_verification_failed`; a pending domain past its 7 days becomes failed, a verified one stays
//   verified. 503 when no resolver answers, 409 `domain_taken` when another organisation verified the domain meanwhile.
// - `DELETE .../{domain}`: removes the domain (`ops.domain_removed`); sign-in discovery and accounts made at first
//   sign-in (JIT, D-25) stop using it at once.
// - `domain.verify` (worker, `domain-verify.job.ts`): the hourly sweep checks every pending domain and marks it failed
//   after 7 days, and checks verified DNS domains whose last check is 30 days old; when such a record is gone, the
//   platform operators get the `domain_record_missing` email and the domain stays verified. With a payload it checks
//   one domain (the first check after `add`).
// - `tenant verify-domain` in multi tenancy (`verifyManually`): verified by hand with a reason, method `manual`,
//   audited `ops.domain_verified`.
// The DNS lookup runs outside the database transaction; its result is applied to the row locked again, and only when
// the token it was checked against is still the row's token. Every write runs in platform scope (M2-02 follow-up 9).
import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import type { OrgDomain, OrgDomainAdded, OrgDomainCheck } from '@mscd/shared';
import { sql } from 'kysely';
import { Clock } from '../../../common/clock';
import { JOB_QUEUE, type JobQueue } from '../../../common/jobs/job-queue';
import { ConflictError, DependencyUnavailableError, NotFoundError, ProblemError, ValidationError } from '../../../common/problems';
import { currentRequestId } from '../../../common/request-context';
import { AUDIT_WRITER, type AuditWriter, type Trx } from '../../../common/tokens';
import { MscdConfig } from '../../../config/mscd-config';
import { AccountMailer, type AccountMail } from '../../identity/account-mailer';
import { inPlatformScope } from '../../identity/platform-scope';
import { TenantScope } from '../../tenancy/tenant-scope';
import { type OperatorActor, singleTenancyRefusal, unknownOrganisation } from '../organizations.service';
import { DnsTxtChecker, type TxtCheck } from './dns-txt';
import {
  newToken, normaliseDomainName, pendingExpired, pendingUntil, recheckBefore, tokenHash, txtNameOf, txtValueOf, type NormalisedDomain,
} from './domain-names';

/** Delay of the first check after a domain is added. */
const FIRST_CHECK_DELAY_SECONDS = 60;
/** Most rows of each kind one sweep checks (the rest wait for the next hour). */
const SWEEP_LIMIT = 500;
/** `verified_by` of a domain verified by its DNS record. */
const BY_DNS = 'DNS TXT record';

type DomainRow = {
  organization_id: string;
  domain: string;
  status: 'pending' | 'verified' | 'failed';
  method: 'dns' | 'manual';
  txt_token_hash: Buffer | null;
  requested_at: Date | null;
  verified_at: Date | null;
  last_checked_at: Date | null;
};

const DOMAIN_COLUMNS = ['organization_id', 'domain', 'status', 'method', 'txt_token_hash', 'requested_at', 'verified_at', 'last_checked_at'] as const;

interface OrgRow {
  id: string;
  slug: string;
  name: string;
  status: string;
}

/** Who runs a check: the operator ("Verify now") or the hourly job. */
type CheckActor = { kind: 'operator'; actor: OperatorActor } | { kind: 'job' };

/** What a check did to a domain. */
export interface CheckOutcome {
  domain: string;
  organizationId: string;
  /** The check's lookup result. */
  check: TxtCheck['kind'];
  /** Status before and after. */
  from: DomainRow['status'];
  to: DomainRow['status'];
  /** The row changed after the lookup (re-added or removed): nothing was written. */
  skipped?: 'changed' | 'taken';
  /** Operators emailed about a missing record of a verified domain. */
  operatorsEmailed: number;
}

export interface SweepResult {
  checked: number;
  verified: number;
  failed: number;
  stillPending: number;
  recordMissing: number;
  unreachable: number;
  operatorsEmailed: number;
}

/** Result of `tenant verify-domain` in multi tenancy. */
export interface ManualVerification {
  organizationId: string;
  domain: string;
  /** False when the domain was already verified for the organisation (nothing changed). */
  created: boolean;
}

/** 409 `conflict` with messageKey `domain_taken` (J.6): another organisation holds the domain verified. */
export function domainTaken(domain: string): ConflictError {
  const en = `The domain ${domain} is already verified for another organisation. A verified domain belongs to one organisation only; remove it there first.`;
  const id = `Domain ${domain} sudah diverifikasi untuk organisasi lain. Domain terverifikasi hanya dimiliki satu organisasi; hapus dulu di sana.`;
  return new ConflictError(en, { messageKey: 'domain_taken', messages: { en, id } });
}

/** The refusal of a typed domain: 400 for a name that is not a domain, 422 `domain_not_allowed` for free mail. */
function refusalOf(input: string, result: Extract<NormalisedDomain, { ok: false }>, path: string): ProblemError {
  if (result.problem === 'invalid') {
    return new ValidationError([{ path, message: `${JSON.stringify(input.trim())} is not an email domain such as example.co.id` }]);
  }
  const en = `${input.trim()} is a free mail domain that anyone can use; only a domain the organisation owns can be verified.`;
  const id = `${input.trim()} adalah domain email gratis yang dapat dipakai siapa saja; hanya domain milik organisasi yang dapat diverifikasi.`;
  return new ProblemError('business-rule', { detail: en, messageKey: 'domain_not_allowed', messages: { en, id } });
}

function iso(value: Date | null): string | null {
  return value ? new Date(value).toISOString() : null;
}

/** The API view of a row. */
export function domainView(row: DomainRow): OrgDomain {
  return {
    domain: row.domain,
    status: row.status,
    method: row.method,
    requestedAt: iso(row.requested_at),
    verifiedAt: iso(row.verified_at),
    lastCheckedAt: iso(row.last_checked_at),
    pendingUntil: row.status === 'pending' && row.requested_at ? pendingUntil(new Date(row.requested_at)).toISOString() : null,
    txtName: txtNameOf(row.domain),
  };
}

function isUniqueViolation(error: unknown): boolean {
  return (error as { code?: unknown })?.code === '23505';
}

@Injectable()
export class DomainsService {
  private readonly logger = new Logger('Domains');

  constructor(
    private readonly config: MscdConfig,
    private readonly scope: TenantScope,
    private readonly dns: DnsTxtChecker,
    @Inject(AUDIT_WRITER) private readonly audit: AuditWriter,
    @Optional() @Inject(JOB_QUEUE) private readonly queue?: JobQueue,
    @Optional() private readonly mailer?: AccountMailer,
    @Optional() private readonly clock?: Clock,
  ) {}

  private now(): Date {
    return this.clock ? this.clock.now() : new Date();
  }

  private assertMultiTenancy(): void {
    if (this.config.profile.tenancy.mode !== 'multi') throw singleTenancyRefusal();
  }

  /** `GET /ops/organizations/{org}/domains`. */
  async list(slug: string): Promise<OrgDomain[]> {
    this.assertMultiTenancy();
    return this.scope.withPlatform(
      async (trx) => {
        const org = await organisationOf(trx, slug);
        const rows = await trx.selectFrom('platform.verified_domain').select(DOMAIN_COLUMNS).where('organization_id', '=', org.id).orderBy('domain').execute();
        return rows.map((row) => domainView(row));
      },
      { scope: 'operator' },
    );
  }

  /** `POST /ops/organizations/{org}/domains`. */
  async add(actor: OperatorActor, slug: string, input: string): Promise<OrgDomainAdded> {
    this.assertMultiTenancy();
    const normalised = normaliseDomainName(input);
    if (!normalised.ok) throw refusalOf(input, normalised, 'body.domain');
    const domain = normalised.domain;
    const token = newToken();
    const hash = tokenHash(token);
    const now = this.now();
    await this.scope.withPlatform(
      async (trx) => {
        const org = await organisationOf(trx, slug, { lock: true });
        if (org.status === 'archived' || org.status === 'deleted') {
          throw new ConflictError(`The organisation ${slug} is archived; its domains cannot change`, { messageKey: 'organization_archived' });
        }
        await assertNotTakenElsewhere(trx, org.id, domain);
        const existing = await trx
          .selectFrom('platform.verified_domain')
          .select(DOMAIN_COLUMNS)
          .where('organization_id', '=', org.id)
          .where('domain', '=', domain)
          .forUpdate()
          .executeTakeFirst();
        if (existing?.status === 'verified') {
          const en = `The domain ${domain} is already verified for ${slug}.`;
          throw new ConflictError(en, { messageKey: 'domain_already_verified', messages: { en, id: `Domain ${domain} sudah diverifikasi untuk ${slug}.` } });
        }
        const values = {
          status: 'pending' as const,
          method: 'dns' as const,
          txt_token_hash: hash,
          requested_at: now,
          last_checked_at: null,
          verified_at: null,
          verified_by: null,
        };
        if (existing) {
          await trx.updateTable('platform.verified_domain').set(values).where('organization_id', '=', org.id).where('domain', '=', domain).execute();
        } else {
          await trx.insertInto('platform.verified_domain').values({ organization_id: org.id, domain, ...values }).execute();
        }
        await this.audit.record(trx, {
          action: 'ops.domain_added',
          actor: { userId: actor.userId, kind: 'operator' },
          organizationId: org.id,
          entityType: 'verified_domain',
          entityId: null,
          entityCode: domain,
          ...(existing ? { before: { status: existing.status } } : {}),
          after: { domain, status: 'pending', method: 'dns', txtName: txtNameOf(domain), pendingUntil: pendingUntil(now).toISOString(), renewed: existing !== undefined },
        });
        await this.queue?.send(
          'domain.verify',
          { orgId: null, requestId: currentRequestId(), ...(actor.userId ? { requestedBy: actor.userId } : {}), payload: { organizationId: org.id, domain } },
          { singletonKey: `dv:${org.id}:${domain}`, startAfterSeconds: FIRST_CHECK_DELAY_SECONDS, retryLimit: 1 },
          trx,
        );
      },
      { scope: actor.scope, userId: actor.userId, requestId: currentRequestId() },
    );
    return { domain, txtName: txtNameOf(domain), txtValue: txtValueOf(token), status: 'pending' };
  }

  /** `POST /ops/organizations/{org}/domains/{domain}/verify`. */
  async verifyNow(actor: OperatorActor, slug: string, domain: string): Promise<OrgDomainCheck> {
    this.assertMultiTenancy();
    const found = await this.scope.withPlatform(
      async (trx) => {
        const org = await organisationOf(trx, slug);
        const row = await trx.selectFrom('platform.verified_domain').select(DOMAIN_COLUMNS).where('organization_id', '=', org.id).where('domain', '=', domain).executeTakeFirst();
        return { org, row };
      },
      { scope: 'operator' },
    );
    if (!found.row) throw new NotFoundError(`The organisation ${slug} has no domain ${domain}`);
    if (found.org.status === 'archived' || found.org.status === 'deleted') {
      throw new ConflictError(`The organisation ${slug} is archived; its domains are not checked`, { messageKey: 'organization_archived' });
    }
    if (!found.row.txt_token_hash) {
      const en = `The domain ${domain} was verified by the operator command without a DNS record, so there is nothing to check.`;
      throw new ConflictError(en, { messageKey: 'domain_not_dns', messages: { en, id: `Domain ${domain} diverifikasi dengan perintah operator tanpa catatan DNS, sehingga tidak ada yang diperiksa.` } });
    }
    const check = await this.dns.check(domain, found.row.txt_token_hash);
    if (check.kind === 'unreachable') {
      throw new DependencyUnavailableError(`The DNS servers did not answer the lookup of ${txtNameOf(domain)} (${check.code}); try again later`);
    }
    let outcome: CheckOutcome;
    try {
      outcome = await this.apply(found.org, found.row, check, { kind: 'operator', actor });
    } catch (error) {
      // Another organisation verified the domain between the check and the write (the unique index of 0005).
      if (isUniqueViolation(error)) throw domainTaken(domain);
      throw error;
    }
    if (outcome.skipped === 'taken') throw domainTaken(domain);
    if (outcome.skipped === 'changed') {
      throw new ConflictError(`The domain ${domain} was changed while it was checked; check it again`, { messageKey: 'domain_changed' });
    }
    const after = await this.scope.withPlatform(
      (trx) => trx.selectFrom('platform.verified_domain').select(DOMAIN_COLUMNS).where('organization_id', '=', found.org.id).where('domain', '=', domain).executeTakeFirstOrThrow(),
      { scope: 'operator' },
    );
    return { ...domainView(after), recordFound: check.kind === 'found' };
  }

  /** `DELETE /ops/organizations/{org}/domains/{domain}`. */
  async remove(actor: OperatorActor, slug: string, domain: string): Promise<void> {
    this.assertMultiTenancy();
    await this.scope.withPlatform(
      async (trx) => {
        const org = await organisationOf(trx, slug);
        const removed = await trx
          .deleteFrom('platform.verified_domain')
          .where('organization_id', '=', org.id)
          .where('domain', '=', domain)
          .returning(['status', 'method'])
          .executeTakeFirst();
        if (!removed) throw new NotFoundError(`The organisation ${slug} has no domain ${domain}`);
        await this.audit.record(trx, {
          action: 'ops.domain_removed',
          actor: { userId: actor.userId, kind: 'operator' },
          organizationId: org.id,
          entityType: 'verified_domain',
          entityId: null,
          entityCode: domain,
          before: { domain, status: removed.status, method: removed.method },
        });
      },
      { scope: actor.scope, userId: actor.userId, requestId: currentRequestId() },
    );
  }

  /**
   * `tenant verify-domain` in multi tenancy: records the domain as verified by hand (method `manual`) with the reason,
   * audited `ops.domain_verified`. A pending or failed DNS claim of the organisation becomes this verification; a domain
   * another organisation holds verified is refused (409 `domain_taken`).
   */
  async verifyManually(actor: OperatorActor, slug: string, input: string, details: { verifiedBy: string; reason: string }): Promise<ManualVerification> {
    this.assertMultiTenancy();
    const normalised = normaliseDomainName(input);
    if (!normalised.ok) throw refusalOf(input, normalised, '--domain');
    const domain = normalised.domain;
    const verifiedBy = details.verifiedBy.trim();
    const reason = details.reason.trim();
    if (verifiedBy === '' || verifiedBy.length > 150) throw new ValidationError([{ path: '--by', message: 'must have 1 to 150 characters' }]);
    if (reason.length < 3 || reason.length > 500) throw new ValidationError([{ path: '--manual-reason', message: 'must have 3 to 500 characters' }]);
    const now = this.now();
    try {
      return await this.scope.withPlatform(
        async (trx) => {
          const org = await organisationOf(trx, slug, { lock: true });
          await assertNotTakenElsewhere(trx, org.id, domain);
          const existing = await trx
            .selectFrom('platform.verified_domain')
            .select(DOMAIN_COLUMNS)
            .where('organization_id', '=', org.id)
            .where('domain', '=', domain)
            .forUpdate()
            .executeTakeFirst();
          if (existing?.status === 'verified') return { organizationId: org.id, domain, created: false };
          const values = { status: 'verified' as const, method: 'manual' as const, txt_token_hash: null, verified_at: now, verified_by: verifiedBy, last_checked_at: null };
          if (existing) {
            await trx.updateTable('platform.verified_domain').set(values).where('organization_id', '=', org.id).where('domain', '=', domain).execute();
          } else {
            await trx.insertInto('platform.verified_domain').values({ organization_id: org.id, domain, requested_at: null, ...values }).execute();
          }
          await this.audit.record(trx, {
            action: 'ops.domain_verified',
            actor: { userId: actor.userId, kind: 'operator' },
            organizationId: org.id,
            entityType: 'verified_domain',
            entityId: null,
            entityCode: domain,
            ...(existing ? { before: { status: existing.status, method: existing.method } } : {}),
            after: { domain, status: 'verified', method: 'manual', verifiedBy, reason, via: actor.scope === 'cli' ? 'cli' : 'operator' },
          });
          return { organizationId: org.id, domain, created: true };
        },
        { scope: actor.scope, userId: actor.userId, requestId: currentRequestId() },
      );
    } catch (error) {
      if (isUniqueViolation(error)) throw domainTaken(domain);
      throw error;
    }
  }

  /** The first check after `add` (job payload `{organizationId, domain}`): checks the domain when it is still pending. */
  async checkOne(organizationId: string, domain: string): Promise<CheckOutcome | null> {
    const found = await this.scope.withPlatform(
      async (trx) => {
        const row = await trx
          .selectFrom('platform.verified_domain')
          .select(DOMAIN_COLUMNS)
          .where('organization_id', '=', organizationId)
          .where('domain', '=', domain)
          .executeTakeFirst();
        const org = await trx.selectFrom('platform.organization').select(['id', 'slug', 'name', 'status']).where('id', '=', organizationId).where('deleted_at', 'is', null).executeTakeFirst();
        return row && org ? { row, org } : null;
      },
      { scope: 'job' },
    );
    if (!found || found.row.status !== 'pending' || !found.row.txt_token_hash || found.org.status === 'archived' || found.org.status === 'deleted') return null;
    const check = await this.dns.check(domain, found.row.txt_token_hash);
    return this.apply(found.org, found.row, check, { kind: 'job' });
  }

  /**
   * The hourly sweep of `domain.verify`: every pending DNS domain, and every verified DNS domain last checked
   * 30 days ago or more, of organisations that are not deleted or archived (oldest check first, at most 500 of each).
   */
  async sweep(): Promise<SweepResult> {
    const now = this.now();
    const due = await this.scope.withPlatform(
      async (trx) => {
        const base = () =>
          trx
            .selectFrom('platform.verified_domain as d')
            .innerJoin('platform.organization as o', 'o.id', 'd.organization_id')
            .select(['d.organization_id', 'd.domain', 'd.status', 'd.method', 'd.txt_token_hash', 'd.requested_at', 'd.verified_at', 'd.last_checked_at'])
            .select(['o.id as org_id', 'o.slug as org_slug', 'o.name as org_name', 'o.status as org_status'])
            .where('o.deleted_at', 'is', null)
            .where('o.status', 'not in', ['archived', 'deleted'])
            .where('d.method', '=', 'dns')
            .where('d.txt_token_hash', 'is not', null);
        const pending = await base().where('d.status', '=', 'pending').orderBy(sql`d.last_checked_at nulls first`).orderBy('d.requested_at').limit(SWEEP_LIMIT).execute();
        const verified = await base()
          .where('d.status', '=', 'verified')
          .where(sql<boolean>`coalesce(d.last_checked_at, d.verified_at, d.requested_at) <= ${recheckBefore(now)}`)
          .orderBy(sql`coalesce(d.last_checked_at, d.verified_at, d.requested_at)`)
          .limit(SWEEP_LIMIT)
          .execute();
        return [...pending, ...verified];
      },
      { scope: 'job' },
    );
    const result: SweepResult = { checked: 0, verified: 0, failed: 0, stillPending: 0, recordMissing: 0, unreachable: 0, operatorsEmailed: 0 };
    for (const item of due) {
      const org: OrgRow = { id: item.org_id, slug: item.org_slug, name: item.org_name, status: item.org_status };
      const row: DomainRow = {
        organization_id: item.organization_id, domain: item.domain, status: item.status, method: item.method, txt_token_hash: item.txt_token_hash,
        requested_at: item.requested_at, verified_at: item.verified_at, last_checked_at: item.last_checked_at,
      };
      try {
        const check = await this.dns.check(row.domain, row.txt_token_hash!);
        const outcome = await this.apply(org, row, check, { kind: 'job' });
        result.checked += 1;
        if (check.kind === 'unreachable') result.unreachable += 1;
        if (outcome.skipped) continue;
        if (outcome.from !== 'verified' && outcome.to === 'verified') result.verified += 1;
        if (outcome.from !== 'failed' && outcome.to === 'failed') result.failed += 1;
        if (outcome.to === 'pending') result.stillPending += 1;
        if (outcome.from === 'verified' && check.kind === 'missing') result.recordMissing += 1;
        result.operatorsEmailed += outcome.operatorsEmailed;
      } catch (error) {
        this.logger.error({ domain: row.domain, orgId: org.id }, `domain.verify could not check ${row.domain}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    return result;
  }

  /**
   * Applies the result of a lookup to a domain, in one platform transaction with the row locked: nothing is written
   * when the row was removed or given a new token since the lookup (`skipped: 'changed'`).
   */
  private async apply(org: OrgRow, checked: DomainRow, check: TxtCheck, by: CheckActor): Promise<CheckOutcome> {
    const now = this.now();
    const domain = checked.domain;
    const base = { domain, organizationId: org.id, check: check.kind, from: checked.status, operatorsEmailed: 0 };
    // The job writes as the system user (the writer's default without a request user).
    const actor = by.kind === 'operator' ? { userId: by.actor.userId, kind: 'operator' as const } : null;
    const via = by.kind === 'operator' ? 'operator' : 'job';
    const mails: AccountMail[] = [];
    const outcome = await this.scope.withPlatform(
      async (trx): Promise<CheckOutcome> => {
        const row = await trx
          .selectFrom('platform.verified_domain')
          .select(DOMAIN_COLUMNS)
          .where('organization_id', '=', org.id)
          .where('domain', '=', domain)
          .forUpdate()
          .executeTakeFirst();
        if (!row || !row.txt_token_hash || !checked.txt_token_hash || !row.txt_token_hash.equals(checked.txt_token_hash)) {
          return { ...base, to: row?.status ?? checked.status, skipped: 'changed' };
        }
        // `before` only when the status changes (the writer stores the changed keys of `after` when both are given).
        const audit = (action: 'ops.domain_verified' | 'ops.domain_verification_failed', after: { status: DomainRow['status'] } & Record<string, unknown>) =>
          this.audit.record(trx, {
            action,
            ...(actor ? { actor } : {}),
            organizationId: org.id,
            entityType: 'verified_domain',
            entityId: null,
            entityCode: domain,
            ...(after.status !== row.status ? { before: { status: row.status } } : {}),
            after: { domain, method: 'dns', via, ...after },
          });
        if (check.kind === 'found') {
          if (row.status === 'verified') {
            await trx.updateTable('platform.verified_domain').set({ last_checked_at: now }).where('organization_id', '=', org.id).where('domain', '=', domain).execute();
            if (by.kind === 'operator') await audit('ops.domain_verified', { status: 'verified', recheck: true });
            return { ...base, to: 'verified' };
          }
          if (await takenElsewhere(trx, org.id, domain)) {
            if (by.kind === 'operator') return { ...base, to: row.status, skipped: 'taken' };
            // The job cannot verify a domain another organisation holds: the claim ends.
            await trx.updateTable('platform.verified_domain').set({ status: 'failed', last_checked_at: now }).where('organization_id', '=', org.id).where('domain', '=', domain).execute();
            await audit('ops.domain_verification_failed', { status: 'failed', reason: 'domain_taken' });
            return { ...base, to: 'failed' };
          }
          const verifiedBy = by.kind === 'operator' ? `${BY_DNS} (Verify now)` : `${BY_DNS} (hourly check)`;
          await trx
            .updateTable('platform.verified_domain')
            .set({ status: 'verified', verified_at: now, verified_by: verifiedBy, last_checked_at: now })
            .where('organization_id', '=', org.id)
            .where('domain', '=', domain)
            .execute();
          await audit('ops.domain_verified', { status: 'verified' });
          return { ...base, to: 'verified' };
        }
        const expired = row.status === 'pending' && pendingExpired(row.requested_at, now);
        if (check.kind === 'unreachable') {
          // Nothing is known about the record; only a pending domain past its 7 days ends.
          if (!expired) return { ...base, to: row.status };
          await trx.updateTable('platform.verified_domain').set({ status: 'failed', last_checked_at: now }).where('organization_id', '=', org.id).where('domain', '=', domain).execute();
          await audit('ops.domain_verification_failed', { status: 'failed', reason: 'expired', lookup: check.code });
          return { ...base, to: 'failed' };
        }
        const to = expired ? 'failed' : row.status;
        await trx.updateTable('platform.verified_domain').set({ status: to, last_checked_at: now }).where('organization_id', '=', org.id).where('domain', '=', domain).execute();
        const reason = expired ? 'expired' : check.detail === 'no_record' ? 'record_missing' : 'record_mismatch';
        if (row.status === 'verified') {
          // The monthly check: the record is gone, the domain stays verified, the operators are told.
          await audit('ops.domain_verification_failed', { status: 'verified', reason, statusKept: true });
          if (by.kind === 'job' && this.mailer) {
            const link = this.mailer.appLink('/ops');
            for (const operator of await operatorsOf(trx)) {
              mails.push({
                to: { email: operator.email, userId: operator.id },
                template: { name: 'domain_record_missing', link, organisation: org.name, slug: org.slug, domain, txtName: txtNameOf(domain), verifiedAt: iso(row.verified_at) },
              });
            }
          }
          return { ...base, to: 'verified' };
        }
        // A pending domain is audited when the operator checks it and when its checks end; the hourly misses only
        // move its last check time.
        if (by.kind === 'operator' || to === 'failed') await audit('ops.domain_verification_failed', { status: to, reason });
        return { ...base, to };
      },
      by.kind === 'operator'
        ? { scope: by.actor.scope, userId: by.actor.userId, requestId: currentRequestId() }
        : { scope: 'job', requestId: currentRequestId() },
    );
    for (const mail of mails) {
      if (await this.mailer!.send(mail)) outcome.operatorsEmailed += 1;
    }
    if (mails.length > 0 && outcome.operatorsEmailed < mails.length) {
      this.logger.error({ domain, orgId: org.id }, `The missing record of ${domain} was emailed to ${outcome.operatorsEmailed} of ${mails.length} operators`);
    }
    return outcome;
  }
}

/** The organisation of a slug (not deleted), optionally locked against concurrent domain changes; 404 otherwise. */
async function organisationOf(trx: Trx, slug: string, options: { lock?: boolean } = {}): Promise<OrgRow> {
  let query = trx.selectFrom('platform.organization').select(['id', 'slug', 'name', 'status']).where('slug', '=', slug).where('deleted_at', 'is', null);
  if (options.lock) query = query.forNoKeyUpdate();
  const org = await query.executeTakeFirst();
  if (!org) throw unknownOrganisation(slug);
  return org;
}

/** True when another organisation holds the domain verified. */
async function takenElsewhere(trx: Trx, orgId: string, domain: string): Promise<boolean> {
  const other = await trx
    .selectFrom('platform.verified_domain')
    .select('organization_id')
    .where(sql<string>`lower(domain)`, '=', domain.toLowerCase())
    .where('status', '=', 'verified')
    .where('organization_id', '<>', orgId)
    .executeTakeFirst();
  return other !== undefined;
}

async function assertNotTakenElsewhere(trx: Trx, orgId: string, domain: string): Promise<void> {
  if (await takenElsewhere(trx, orgId, domain)) throw domainTaken(domain);
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
