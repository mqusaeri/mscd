// Erasure of one person in one organisation (Milestone 3 D.6.5): `POST /admin/privacy-requests/{id}/erase`.
//
// Preconditions: the request is an erasure in progress; every system check is done; for a member, the person holds no
// open items in any system (the holdings of `admin.users.holdings`, without the stored tasks that complete on their own
// screen, read confirmations, access reviews and personal data checks, which the erasure cancels in step 3; else 422
// rule `ERASE-OPEN-ITEMS`), is not the last active Tenant Admin (409 `last_tenant_admin`), is not the caller, and still
// has the name the request recorded (409 `privacy.name_changed`: the redaction removes the name as the request recorded
// it, so a later rename would leave the new name behind or remove an ordinary word; `me.profile` refuses a new name
// while the erasure is open, M3-13 after security review 1).
//
// Then, in one transaction (the audit rows to redact are chosen first, so the entries this erasure writes are not among
// them; the entries it writes name the pseudonym only):
//   1. business roles revoked (`role.revoked` per grant), linked company sign-in of this organisation's providers and
//      the open invitations of this organisation removed, the membership marked removed (`deleted_at`, audited
//      `membership.updated`), the person's sessions in this organisation ended (`account_erased`);
//   2. an `erased_person` row gives the pseudonym ("Former user 7F3A"), which this organisation shows wherever it showed
//      the name (read model, user lists, audit trail views, exports, the organisation export);
//   3. pending confirmations become `excused`, open stored tasks of the person are cancelled, the person's notifications
//      and calendar feed tokens in this organisation are deleted, and the personal data exports about the person are
//      withdrawn: a queued build fails, a file expires now (no one can download it, and the next `cleanup.expired`
//      deletes its vault content), its name and the task result take the handle form of the pseudonym, and the
//      `export_ready` notices about it (to the Tenant Admin who asked for it) are deleted;
//   4. the audit entries are redacted in two sets per chain (erasure-scope.ts), each under its own attestation
//      (`privacy.audit_redacted` on the organisation's trail, `user.audit_redacted` on the platform log; D.5.4): (a) the
//      entries where the person acted, the entries about the account, the membership or the person's business roles,
//      and every entry of a record a manager edited for this request lose the email, the handle and the name; (b) every
//      other entry that holds the email or the handle loses those two; no network address or browser stays in a
//      redacted entry;
//   5. an account with no other membership that is no platform operator is anonymised (`AccountAnonymiser`).
// The request records what was done (`result`, with the pseudonym) and the erasure receipt (erasure-receipt.ts), which
// the worker signs and emails; audited `privacy_request.erased`. The erasure queues an `org.lifecycle` run when it
// commits, whose handler sends the receipt first in single and multi tenancy (ops/deletion/erasure-receipts.ts); the
// daily `privacy.deadlines` run and, in multi tenancy, the hourly `org.lifecycle` schedule try again after a failed send.
//
// A person without an account (ISO review M3) has no actor, account or platform entries: the managers edit the records
// that name the person during the checks, and the erasure then runs the attested redaction of the organisation's trail
// with the name and email the request recorded: the email in every entry, the name in the entries of the records the
// managers edited for the request. The pseudonym comes from `freePseudonym` and is kept in `result.pseudonym`.
//
// `reapply` (CLI `tenant erasure --reapply`) runs the same steps again, as the system, after a restore from a backup
// older than the erasure, with the pseudonym of the signed receipt.
import { randomUUID } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import type { CommandResult } from '@mscd/shared';
import { sql } from 'kysely';
import { BusinessRuleError, ForbiddenError } from '../../common/problems';
import {
  AUDIT_WRITER, JOB_QUEUE, SYSTEM_USER_ID, type AuditWriter, type JobQueue, type Principal, type TenantInfo, type Trx,
} from '../../common/tokens';
import { AuditRedactor, type RedactionAttestation } from '../audit/audit-redactor';
import { ERASED_SUBJECT, renamedPersonalDataFile } from '../exports/personal-data';
import { AccountAnonymiser } from '../identity/account-anonymiser';
import { inPlatformScope } from '../identity/platform-scope';
import { SessionService } from '../identity/session.service';
import { cronRetryLimit } from '../jobs/schedules';
import { HoldingsService } from '../registers/holdings.service';
import { ruleMessages } from '../rules/messages';
import { TenantScope, systemContextOf, tenantContextOf } from '../tenancy/tenant-scope';
import { ERASURE_RECEIPT_TYPE, ERASURE_RECEIPT_VERSION, type ErasureReceipt } from './erasure-receipt';
import { fullValues, partialValues, redactionSets, type ErasureSubject } from './erasure-scope';
import { conflict, freePseudonym, isOpen, orgOf, requestRef, requestRow, type RequestRow } from './privacy-model';
import { pseudonymHandle } from './pseudonym';
import { assertNotLastTenantAdmin, memberFacts, type MemberFacts } from './privacy-requests.service';
import { EXCUSED_BY_ERASURE, REFUSALS } from './privacy-text';

/** Stored task sources that complete on their own screen; an erasure cancels them (step 3), so they are no holdings. */
export const SCREEN_TASK_SOURCES = ['acknowledgement', 'access_review', 'privacy_check'] as const;

/** What an erasure did, stored in `privacy_request.result` (counts; the pseudonym is stored beside them). */
export interface ErasureCounts {
  erased: number;
  rolesRevoked: number;
  linkedSignInsRemoved: number;
  invitationsRemoved: number;
  sessionsEnded: number;
  confirmationsExcused: number;
  tasksCancelled: number;
  notificationsDeleted: number;
  calendarFeedsDeleted: number;
  /** Personal data exports about the person withdrawn: files expired and queued builds stopped. */
  exportsWithdrawn: number;
  auditEntriesRedacted: number;
  platformEntriesRedacted: number;
  accountAnonymised: number;
  systemsChecked: number;
}

/** Who carries out an erasure: a Tenant Admin, or the system when a receipt is applied again after a restore. */
interface ErasureActor {
  userId: string;
  kind: 'user' | 'system';
}

/** What steps 1 to 5 did, with the redactions of step 4 (their ids go into the receipt). */
interface ErasureRun {
  counts: ErasureCounts;
  redactionIds: string[];
}

/** The outcome of applying a receipt again (`tenant erasure --reapply`). */
export type ReapplyOutcome =
  | { status: 'erased'; counts: ErasureCounts; pseudonym: string; requestNo: string | null }
  | { status: 'skipped'; reason: 'already_erased'; pseudonym: string }
  | { status: 'open_items'; systems: { ms: string; name: string; total: number }[] }
  | { status: 'last_tenant_admin' }
  | { status: 'request_missing'; requestNo: string }
  | { status: 'account_missing' };

@Injectable()
export class PrivacyErasureService {
  constructor(
    private readonly tenancy: TenantScope,
    private readonly redactor: AuditRedactor,
    private readonly anonymiser: AccountAnonymiser,
    private readonly sessions: SessionService,
    private readonly holdings: HoldingsService,
    @Inject(AUDIT_WRITER) private readonly audit: AuditWriter,
    @Inject(JOB_QUEUE) private readonly queue: JobQueue,
  ) {}

  async erase(principal: Principal, id: string): Promise<CommandResult> {
    const org = orgOf(principal);
    const actor: ErasureActor = { userId: principal.user.id, kind: 'user' };
    // The refusals in the order the screen explains them: open checks, the last Tenant Admin, one's own membership, a
    // changed name, then open items. The holdings are counted before the transaction (their service opens its own).
    const subject = await this.tenancy.withTenant(tenantContextOf(principal), async (trx) => {
      const row = await requestRow(trx, id);
      this.assertErasable(row);
      await assertChecksDone(trx, row.id);
      if (row.subject_kind === 'member' && row.subject_user_id) {
        const member = await memberFacts(trx, org.id, row.subject_user_id);
        if (member) await assertNotLastTenantAdmin(trx, org.id, member);
        if (row.subject_user_id === actor.userId) throw new ForbiddenError(REFUSALS.ownMembership.en);
        if (member) assertSameName(row, member);
      }
      return row;
    });
    if (subject.subject_kind === 'member' && subject.subject_user_id) {
      const open = await this.openItems(principal, subject.subject_user_id);
      if (open > 0) {
        throw new BusinessRuleError(
          'ERASE-OPEN-ITEMS',
          ruleMessages('ERASE-OPEN-ITEMS', { person: subject.subject_name ?? subject.request_no, count: open }),
          requestRef(subject.id, subject.request_no),
          { messageKey: 'rule.ERASE-OPEN-ITEMS' },
        );
      }
    }
    return this.tenancy.withTenant(tenantContextOf(principal), async (trx) => {
      const row = await requestRow(trx, id, { forUpdate: true });
      this.assertErasable(row);
      await assertChecksDone(trx, row.id);
      const checked = await trx.selectFrom('privacy_check').select('id').where('privacy_request_id', '=', row.id).where('deleted_at', 'is', null).execute();
      const pseudonym = await freePseudonym(trx);
      const run = row.subject_kind === 'member'
        ? await this.eraseMember(trx, org, row, pseudonym, actor, {})
        : await this.eraseOther(trx, org, row, pseudonym, actor);
      run.counts.erased = 1;
      run.counts.systemsChecked = checked.length;
      const receipt = receiptOf(org, row, pseudonym, run.redactionIds, new Date());
      await trx
        .updateTable('privacy_request')
        .set({
          result: JSON.stringify({ ...(row.result ?? {}), ...run.counts, pseudonym }),
          erasure_receipt: JSON.stringify(receipt),
          handled_by: actor.userId,
          updated_by: actor.userId,
        })
        .where('id', '=', row.id)
        .execute();
      await this.audit.record(trx, {
        action: 'privacy_request.erased',
        entityType: 'privacy_request',
        entityId: row.id,
        entityCode: row.request_no,
        after: { subject_kind: row.subject_kind, ...run.counts, receiptId: receipt.receiptId },
      });
      // The receipt goes out within minutes, in single tenancy too (which has no hourly `org.lifecycle` schedule).
      await this.queue.send(
        'org.lifecycle',
        { orgId: null, requestedBy: actor.userId, payload: {} },
        { singletonKey: `erasure-receipt:${row.id}`, retryLimit: cronRetryLimit('org.lifecycle') },
        trx,
      );
      return {
        ok: true,
        changed: [],
        ref: requestRef(row.id, row.request_no),
        data: run.counts,
        message: [
          `The personal data of the person in ${row.request_no} is erased in this organisation`,
          `Data pribadi orang dalam ${row.request_no} telah dihapus di organisasi ini`,
        ],
      };
    });
  }

  /** The request must be an erasure in progress that has not been carried out yet (409 otherwise). */
  private assertErasable(row: RequestRow): void {
    if (!isOpen(row.status)) throw conflict(REFUSALS.closed);
    if (row.request_type !== 'erasure') throw conflict(REFUSALS.wrongType);
    if (row.status !== 'in_progress') throw conflict(REFUSALS.startFirst);
    if ((row.result?.erased ?? 0) > 0) throw conflict(REFUSALS.alreadyErased);
  }

  /** Open items the person holds in every system, without the stored tasks that complete on their own screen. */
  async openItems(principal: Principal, userId: string): Promise<number> {
    return (await this.openItemsBySystem(principal, userId)).reduce((sum, s) => sum + s.total, 0);
  }

  /** The open items per system (the holdings), without the stored tasks that complete on their own screen. */
  private async openItemsBySystem(principal: Principal, userId: string): Promise<{ ms: string; name: string; total: number }[]> {
    let systems: { ms: string; name: string; total: number }[];
    try {
      const holdings = await this.holdings.userHoldings(principal, userId);
      systems = holdings.systems.map((s) => ({ ms: s.ms, name: s.name, total: s.total }));
    } catch (error) {
      // A person whose membership is gone holds nothing the holdings can show.
      if ((error as { status?: number }).status === 404) return [];
      throw error;
    }
    if (systems.length === 0) return [];
    const screenTasks = await this.tenancy.withTenant(tenantContextOf(principal), async (trx) => {
      const { rows } = await sql<{ ms: string; n: number }>`
        select m.slug as ms, count(*)::int as n from task t join management_system m on m.id = t.management_system_id and m.deleted_at is null
         where t.owner_user_id = ${userId}::uuid and t.status = 'open' and t.deleted_at is null
           and t.source_rule = any(${[...SCREEN_TASK_SOURCES]}::text[])
         group by m.slug`.execute(trx);
      return new Map(rows.map((r) => [r.ms, r.n]));
    });
    return systems.map((s) => ({ ...s, total: Math.max(0, s.total - (screenTasks.get(s.ms) ?? 0)) })).filter((s) => s.total > 0);
  }

  /**
   * Applies an erasure receipt again after a restore from a backup older than the erasure (CLI `tenant erasure
   * --reapply`; the caller checked the signature and the organisation). A member already in `erased_person` is skipped;
   * one who holds open items in the restored copy is refused with the list (hand them over, then run it again);
   * otherwise steps 1 to 5 run again as the system with the receipt's pseudonym. For a person without an account the
   * redaction runs again from the restored request, or the request number is returned when the restored copy is older
   * than the request. Audited `privacy_request.erased` with `reapplied: true`.
   */
  async reapply(org: TenantInfo, receipt: ErasureReceipt, signed?: { signature: string; keyId: string }): Promise<ReapplyOutcome> {
    const actor: ErasureActor = { userId: SYSTEM_USER_ID, kind: 'system' };
    const context = systemContextOf(org);
    const system: Principal = {
      user: { id: SYSTEM_USER_ID, handle: 'system', email: '', displayName: 'System', jobTitle: null, kind: 'system' },
      org,
      session: null,
    };
    if (receipt.subjectKind === 'member') {
      const userId = receipt.erasedUserId!;
      const pre = await this.tenancy.withTenant(context, async (trx) => {
        const already = await trx.selectFrom('erased_person').select('pseudonym').where('erased_user_id', '=', userId).executeTakeFirst();
        if (already) return { status: 'skipped', reason: 'already_erased', pseudonym: already.pseudonym } as const;
        const account = await inPlatformScope(trx, () => trx.selectFrom('platform.app_user').select('id').where('id', '=', userId).executeTakeFirst());
        if (!account) return { status: 'account_missing' } as const;
        const member = await memberFacts(trx, org.id, userId);
        if (member) {
          try {
            await assertNotLastTenantAdmin(trx, org.id, member);
          } catch {
            return { status: 'last_tenant_admin' } as const;
          }
        }
        return null;
      });
      if (pre) return pre;
      const open = await this.openItemsBySystem(system, userId);
      if (open.length > 0) return { status: 'open_items', systems: open };
      return this.tenancy.withTenant(context, async (trx) => {
        const row = await restoredRequest(trx, receipt.request.id);
        const facts: RequestRow = row ?? receiptRequestRow(receipt);
        const run = await this.eraseMember(trx, org, facts, receipt.pseudonym, actor, { reapply: true, requestExists: Boolean(row) });
        run.counts.erased = 1;
        if (row) await this.recordReapplied(trx, row, receipt, run.counts, actor, signed);
        await this.audit.record(trx, {
          action: 'privacy_request.erased',
          actor,
          entityType: 'privacy_request',
          entityId: receipt.request.id,
          entityCode: receipt.request.number,
          after: { subject_kind: 'member', ...run.counts, receiptId: receipt.receiptId, reapplied: true },
        });
        return { status: 'erased', counts: run.counts, pseudonym: receipt.pseudonym, requestNo: receipt.request.number } as const;
      });
    }
    return this.tenancy.withTenant(context, async (trx) => {
      const row = await restoredRequest(trx, receipt.request.id);
      if (!row) return { status: 'request_missing', requestNo: receipt.request.number } as const;
      if ((row.result?.erased ?? 0) > 0) return { status: 'skipped', reason: 'already_erased', pseudonym: row.result_pseudonym ?? receipt.pseudonym } as const;
      const run = await this.eraseOther(trx, org, row, receipt.pseudonym, actor);
      run.counts.erased = 1;
      await this.recordReapplied(trx, row, receipt, run.counts, actor, signed);
      await this.audit.record(trx, {
        action: 'privacy_request.erased',
        actor,
        entityType: 'privacy_request',
        entityId: row.id,
        entityCode: row.request_no,
        after: { subject_kind: 'other', ...run.counts, receiptId: receipt.receiptId, reapplied: true },
      });
      return { status: 'erased', counts: run.counts, pseudonym: receipt.pseudonym, requestNo: row.request_no } as const;
    });
  }

  /**
   * The restored request of a re-applied receipt records the erasure again, with the receipt as it was sent: signed and
   * sent already when the caller gives the signature (the worker does not email it a second time).
   */
  private async recordReapplied(
    trx: Trx,
    row: RequestRow,
    receipt: ErasureReceipt,
    counts: ErasureCounts,
    actor: ErasureActor,
    signed?: { signature: string; keyId: string },
  ): Promise<void> {
    await trx
      .updateTable('privacy_request')
      .set({
        result: JSON.stringify({ ...(row.result ?? {}), ...counts, pseudonym: receipt.pseudonym, reapplied: 1 }),
        erasure_receipt: JSON.stringify(receipt),
        ...(signed ? { erasure_receipt_signature: signed.signature, erasure_receipt_key_id: signed.keyId, erasure_receipt_sent_at: sql<Date>`now()` } : {}),
        updated_by: actor.userId,
      })
      .where('id', '=', row.id)
      .execute();
  }

  /** Steps 1 to 5 for a member (see the top of the file). */
  private async eraseMember(
    trx: Trx,
    org: TenantInfo,
    row: RequestRow,
    pseudonym: string,
    actor: ErasureActor,
    options: { reapply?: boolean; requestExists?: boolean },
  ): Promise<ErasureRun> {
    const userId = row.subject_user_id!;
    const counts = emptyCounts();
    await trx.selectFrom('platform.org_membership').select('user_id').where('organization_id', '=', org.id).where('user_id', '=', userId).forUpdate().execute();
    const member = await memberFacts(trx, org.id, userId);
    const already = await trx.selectFrom('erased_person').select('pseudonym').where('erased_user_id', '=', userId).executeTakeFirst();
    if (already) throw conflict(REFUSALS.alreadyErased);
    if (!member && !options.reapply) throw conflict(REFUSALS.notMember);
    if (member) {
      await assertNotLastTenantAdmin(trx, org.id, member);
      if (!options.reapply) assertSameName(row, member);
    }
    const account = await inPlatformScope(trx, () =>
      trx.selectFrom('platform.app_user').select(['email', 'handle', 'display_name']).where('id', '=', userId).executeTakeFirstOrThrow());
    const subject: ErasureSubject = {
      userId,
      email: account.email,
      handle: account.handle,
      // The name as the request recorded it; a re-applied receipt without its request uses the restored account's name.
      name: row.subject_name ?? account.display_name,
      since: new Date(row.received_at),
    };

    // The audit rows to redact, chosen before this erasure writes any entry (step 4).
    const tenantSets = await redactionSets(trx, { kind: 'tenant' }, subject);
    const platformSets = await redactionSets(trx, { kind: 'platform', orgId: org.id }, subject);

    // Step 1: roles, linked sign-in, invitations, membership, sessions.
    const grants = await trx
      .updateTable('user_ms_role')
      .set({ deleted_at: sql<Date>`now()`, updated_by: actor.userId })
      .where('user_id', '=', userId)
      .where('deleted_at', 'is', null)
      .returning(['id', 'management_system_id', 'role', 'approval_status'])
      .execute();
    for (const grant of grants) {
      await this.audit.record(trx, {
        action: 'role.revoked',
        actor,
        msId: grant.management_system_id,
        entityType: 'user_ms_role',
        entityId: grant.id,
        entityCode: pseudonym,
        before: { approvalStatus: grant.approval_status },
        after: { user: pseudonym, role: grant.role, revoked: true, privacyRequest: row.request_no },
      });
    }
    counts.rolesRevoked = grants.length;
    const removed = await inPlatformScope(trx, async () => {
      const identities = await trx
        .deleteFrom('platform.user_identity')
        .where('user_id', '=', userId)
        .where('identity_provider_id', 'in', trx.selectFrom('platform.identity_provider').select('id').where('organization_id', '=', org.id))
        .executeTakeFirst();
      const invitations = await trx.deleteFrom('platform.invitation').where('user_id', '=', userId).where('organization_id', '=', org.id).executeTakeFirst();
      return { identities: Number(identities.numDeletedRows), invitations: Number(invitations.numDeletedRows) };
    });
    counts.linkedSignInsRemoved = removed.identities;
    counts.invitationsRemoved = removed.invitations;
    if (member) {
      await trx
        .updateTable('platform.org_membership')
        .set({ deleted_at: sql<Date>`now()`, admin_roles: [] })
        .where('organization_id', '=', org.id)
        .where('user_id', '=', userId)
        .execute();
      await this.audit.record(trx, {
        action: 'membership.updated',
        actor,
        organizationId: org.id,
        entityType: 'org_membership',
        entityId: userId,
        entityCode: pseudonym,
        before: { status: member.membershipStatus, adminRoles: member.adminRoles },
        after: { status: 'removed', adminRoles: [], privacyRequest: row.request_no },
      });
    }
    counts.sessionsEnded = await this.sessions.revokeOrganisationSessions(trx, org.id, 'account_erased', { userId });

    // Step 2: the pseudonym.
    await trx
      .insertInto('erased_person')
      .values({
        erased_user_id: userId,
        pseudonym,
        privacy_request_id: options.reapply && !options.requestExists ? null : row.id,
        erased_by: actor.userId,
        created_by: actor.userId,
        updated_by: actor.userId,
      })
      .execute();

    // Step 3: confirmations, tasks, notifications, calendar feeds, personal data exports.
    const excused = await trx
      .updateTable('acknowledgement')
      .set({ status: 'excused', excused_reason: EXCUSED_BY_ERASURE, updated_by: actor.userId })
      .where('user_id', '=', userId)
      .where('status', '=', 'pending')
      .where('deleted_at', 'is', null)
      .returning('id')
      .execute();
    counts.confirmationsExcused = excused.length;
    const tasks = await trx
      .updateTable('task')
      .set({ status: 'cancelled', closed_by: actor.userId, closed_at: sql<Date>`now()`, updated_by: actor.userId })
      .where('owner_user_id', '=', userId)
      .where('status', '=', 'open')
      .where('deleted_at', 'is', null)
      .returning('id')
      .execute();
    counts.tasksCancelled = tasks.length;
    counts.notificationsDeleted = Number((await trx.deleteFrom('notification').where('recipient_user_id', '=', userId).executeTakeFirst()).numDeletedRows);
    counts.calendarFeedsDeleted = Number((await trx.deleteFrom('calendar_feed_token').where('user_id', '=', userId).executeTakeFirst()).numDeletedRows);
    const exports = await this.withdrawPersonalExports(trx, userId, pseudonym, actor.userId);
    counts.exportsWithdrawn = exports.withdrawn;
    counts.notificationsDeleted += exports.notices;

    // Step 4: attested redaction of the chosen audit rows, two sets per chain. Set (a) of each chain gets its
    // attestation even with nothing to change, so the request can show that the step ran.
    const reason = `Erasure of a person at their request (${row.request_no})${options.reapply ? ', applied again after a restore' : ''}`;
    const redactionIds: string[] = [];
    const tenantAttestation: RedactionAttestation = {
      action: 'privacy.audit_redacted', reason, entityType: 'privacy_request', entityId: row.id, entityCode: row.request_no, actor,
    };
    const tenant = await this.redactChain(trx, { schema: org.schema }, tenantSets, subject, pseudonym, tenantAttestation);
    counts.auditEntriesRedacted = tenant.redacted;
    redactionIds.push(...tenant.ids);
    const platformAttestation: RedactionAttestation = {
      action: 'user.audit_redacted', reason, organizationId: org.id, entityType: 'user', entityId: userId, entityCode: pseudonym, actor,
    };
    const platform = await this.redactChain(trx, 'platform', platformSets, subject, pseudonym, platformAttestation);
    counts.platformEntriesRedacted = platform.redacted;
    redactionIds.push(...platform.ids);

    // Step 5: an account that belongs to this organisation only is anonymised.
    const anonymised = await this.anonymiser.anonymise(trx, userId, {
      reason: `Erased at the person's request in this organisation (${row.request_no})`,
      organizationId: org.id,
      leavingOrgId: org.id,
      actor,
    });
    counts.accountAnonymised = anonymised ? 1 : 0;
    return { counts, redactionIds };
  }

  /** The redaction of a person without an account (see the top of the file): the organisation's trail only. */
  private async eraseOther(trx: Trx, org: TenantInfo, row: RequestRow, pseudonym: string, actor: ErasureActor): Promise<ErasureRun> {
    const counts = emptyCounts();
    const subject: ErasureSubject = { userId: null, email: row.subject_email, handle: null, name: row.subject_name, since: new Date(row.received_at) };
    const sets = await redactionSets(trx, { kind: 'tenant' }, subject);
    const tenant = await this.redactChain(trx, { schema: org.schema }, sets, subject, pseudonym, {
      action: 'privacy.audit_redacted',
      reason: `Erasure of a person without an account at their request (${row.request_no})`,
      entityType: 'privacy_request',
      entityId: row.id,
      entityCode: row.request_no,
      actor,
    });
    counts.auditEntriesRedacted = tenant.redacted;
    return { counts, redactionIds: tenant.ids };
  }

  /** Set (a) with every personal value, then set (b) with the email and the handle, each under its own attestation. */
  private async redactChain(
    trx: Trx,
    chain: 'platform' | { schema: string },
    sets: { full: string[]; partial: string[] },
    subject: ErasureSubject,
    pseudonym: string,
    attestation: RedactionAttestation,
  ): Promise<{ redacted: number; ids: string[] }> {
    const full = await this.redactor.redact(trx, { chain, seqs: sets.full, replacements: fullValues(subject, pseudonym), attestation });
    let redacted = full.redacted;
    const ids = [full.redactionId];
    const partial = partialValues(subject, pseudonym);
    if (sets.partial.length > 0 && Object.keys(partial).length > 0) {
      const done = await this.redactor.redact(trx, {
        chain,
        seqs: sets.partial,
        replacements: partial,
        attestation: { ...attestation, reason: `${attestation.reason}: email and handle in other entries`.slice(0, 500) },
      });
      redacted += done.redacted;
      ids.push(done.redactionId);
    }
    return { redacted, ids };
  }

  /**
   * Step 3 for the personal data exports about the person (D.6.3), whoever asked for them: queued or running builds
   * fail (`export.build` refuses an erased person too), every file expires now and is marked deleted, the file, its
   * stored object and its task result take the handle form of the pseudonym in place of the person's handle, and the
   * `export_ready` notices about these tasks are deleted. The task rows are locked first (see `export.build`, step 4).
   */
  private async withdrawPersonalExports(trx: Trx, userId: string, pseudonym: string, actor: string): Promise<{ withdrawn: number; notices: number }> {
    const tasks = await trx
      .selectFrom('background_task')
      .select(['id', 'status'])
      .where('kind', '=', 'export')
      .where(sql<boolean>`params->>'type' = 'personal_data' and params->>'subjectUserId' = ${userId}`)
      .forUpdate()
      .execute();
    const taskIds = tasks.map((t) => t.id);
    const stopped = taskIds.length === 0 ? [] : await trx
      .updateTable('background_task')
      .set({ status: 'failed', error: ERASED_SUBJECT, finished_at: sql<Date>`now()`, updated_at: sql<Date>`now()`, updated_by: actor })
      .where('id', 'in', taskIds)
      .where('status', 'in', ['queued', 'running'])
      .returning('id')
      .execute();
    const handle = pseudonymHandle(pseudonym);
    const files = await trx
      .selectFrom('export_file')
      .select(['id', 'file_name', 'created_at', 'storage_object_id', 'background_task_id', 'deleted_at'])
      .where('kind', '=', 'personal_data')
      .where((eb) => (taskIds.length === 0 ? eb('subject_user_id', '=', userId) : eb.or([eb('subject_user_id', '=', userId), eb('background_task_id', 'in', taskIds)])))
      .execute();
    let expired = 0;
    for (const file of files) {
      const fileName = renamedPersonalDataFile(file.file_name, handle, new Date(file.created_at));
      await trx
        .updateTable('export_file')
        .set({
          file_name: fileName,
          expires_at: sql<Date>`least(expires_at, now())`,
          deleted_at: sql<Date>`coalesce(deleted_at, now())`,
          updated_at: sql<Date>`now()`,
          updated_by: actor,
        })
        .where('id', '=', file.id)
        .execute();
      if (file.deleted_at === null) expired += 1;
      if (file.storage_object_id) {
        await trx.updateTable('storage_object').set({ display_name: fileName, updated_by: actor }).where('id', '=', file.storage_object_id).execute();
      }
      if (file.background_task_id) {
        await trx
          .updateTable('background_task')
          .set({ result: sql`jsonb_set(result, '{fileName}', to_jsonb(${fileName}::text))`, updated_by: actor })
          .where('id', '=', file.background_task_id)
          .where(sql<boolean>`result ? 'fileName'`)
          .execute();
      }
    }
    const notices = taskIds.length === 0 ? 0 : Number((await trx
      .deleteFrom('notification')
      .where('kind', '=', 'export_ready')
      .where(sql<boolean>`entity_ref->>'id' = any(${taskIds}::text[])`)
      .executeTakeFirst()).numDeletedRows);
    return { withdrawn: expired + stopped.length, notices };
  }
}

/** 409 `privacy.checks_open` while a system check of the request is open. */
async function assertChecksDone(trx: Trx, requestId: string): Promise<void> {
  const open = await trx.selectFrom('privacy_check').select('id').where('privacy_request_id', '=', requestId).where('status', '=', 'open').where('deleted_at', 'is', null).execute();
  if (open.length > 0) throw conflict(REFUSALS.checksOpen);
}

/** 409 `privacy.name_changed` when the account's display name differs from the name the request recorded. */
function assertSameName(row: Pick<RequestRow, 'subject_name'>, member: Pick<MemberFacts, 'name'>): void {
  if (row.subject_name !== null && row.subject_name.trim() !== member.name.trim()) throw conflict(REFUSALS.nameChanged);
}

/** The request of a receipt in the restored database, or null when the restored copy is older than the request. */
async function restoredRequest(trx: Trx, requestId: string): Promise<RequestRow | null> {
  const found = await trx.selectFrom('privacy_request').select('id').where('id', '=', requestId).executeTakeFirst();
  return found ? requestRow(trx, requestId, { forUpdate: true }) : null;
}

/** The facts of a member's request as the receipt gives them, when the restored copy is older than the request. */
function receiptRequestRow(receipt: ErasureReceipt): RequestRow {
  return {
    id: receipt.request.id,
    request_no: receipt.request.number,
    request_type: 'erasure',
    status: 'in_progress',
    subject_kind: 'member',
    subject_user_id: receipt.erasedUserId,
    subject_name: null,
    subject_email: null,
    subject_handle: null,
    channel: 'other',
    received_at: new Date(receipt.erasedAt),
    due_at: new Date(receipt.erasedAt),
    identity_check_note: null,
    identity_checked_by: null,
    handled_by: null,
    closed_at: null,
    outcome: null,
    result: null,
    result_pseudonym: null,
    erasure_receipt: null,
    updated_at: new Date(receipt.erasedAt),
    created_at: new Date(receipt.erasedAt),
    handled_handle: null,
    handled_name: null,
    checked_handle: null,
    checked_name: null,
    note: null,
  };
}

/** The receipt of an erasure (names no person; erasure-receipt.ts). */
function receiptOf(org: TenantInfo, row: RequestRow, pseudonym: string, redactionIds: string[], now: Date): ErasureReceipt {
  return {
    type: ERASURE_RECEIPT_TYPE,
    version: ERASURE_RECEIPT_VERSION,
    receiptId: randomUUID(),
    organization: { id: org.id, slug: org.slug },
    request: { id: row.id, number: row.request_no },
    subjectKind: row.subject_kind,
    erasedUserId: row.subject_kind === 'member' ? row.subject_user_id : null,
    pseudonym,
    erasedAt: now.toISOString(),
    redactionIds,
  };
}

function emptyCounts(): ErasureCounts {
  return {
    erased: 0, rolesRevoked: 0, linkedSignInsRemoved: 0, invitationsRemoved: 0, sessionsEnded: 0, confirmationsExcused: 0, tasksCancelled: 0,
    notificationsDeleted: 0, calendarFeedsDeleted: 0, exportsWithdrawn: 0, auditEntriesRedacted: 0, platformEntriesRedacted: 0, accountAnonymised: 0, systemsChecked: 0,
  };
}
