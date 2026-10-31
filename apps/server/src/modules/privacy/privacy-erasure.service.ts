// Erasure of one person in one organisation (Milestone 3 D.6.5): `POST /admin/privacy-requests/{id}/erase`.
//
// Preconditions: the request is an erasure in progress; every system check is done; the person holds no open items in
// any system (the holdings of `admin.users.holdings`, without the stored tasks that complete on their own screen,
// read confirmations, access reviews and personal data checks, which the erasure cancels in step 3; else 422 rule
// `ERASE-OPEN-ITEMS`); the person is not the last active Tenant Admin (409 `last_tenant_admin`) and not the caller.
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
//   4. the organisation's audit entries where the person acted or that name them, and the platform audit entries of this
//      organisation about the person, are redacted under one attestation each (`privacy.audit_redacted`,
//      `user.audit_redacted`; D.5.4): no network address, browser, email, handle or name stays in them;
//   5. an account with no other membership that is no platform operator is anonymised (`AccountAnonymiser`).
// The request records what was done (`result`), audited `privacy_request.erased`.
//
// For a person without an account, erasure is the edit of every mention the system checks found: once every check is
// done, the request records that the step is complete.
import { Inject, Injectable } from '@nestjs/common';
import type { CommandResult } from '@mscd/shared';
import { sql } from 'kysely';
import { BusinessRuleError, ForbiddenError } from '../../common/problems';
import { AUDIT_WRITER, type AuditWriter, type Principal, type TenantInfo, type Trx } from '../../common/tokens';
import { AuditRedactor } from '../audit/audit-redactor';
import { ERASED_SUBJECT, renamedPersonalDataFile } from '../exports/personal-data';
import { AccountAnonymiser } from '../identity/account-anonymiser';
import { inPlatformScope } from '../identity/platform-scope';
import { SessionService } from '../identity/session.service';
import { HoldingsService } from '../registers/holdings.service';
import { ruleMessages } from '../rules/messages';
import { TenantScope, tenantContextOf } from '../tenancy/tenant-scope';
import { conflict, freePseudonym, isOpen, orgOf, requestRef, requestRow, type RequestRow } from './privacy-model';
import { pseudonymHandle } from './pseudonym';
import { assertNotLastTenantAdmin, memberFacts, type MemberFacts } from './privacy-requests.service';
import { EXCUSED_BY_ERASURE, REFUSALS } from './privacy-text';

/** Stored task sources that complete on their own screen; an erasure cancels them (step 3), so they are no holdings. */
export const SCREEN_TASK_SOURCES = ['acknowledgement', 'access_review', 'privacy_check'] as const;

/** What an erasure did, stored in `privacy_request.result` (counts only). */
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

@Injectable()
export class PrivacyErasureService {
  constructor(
    private readonly tenancy: TenantScope,
    private readonly redactor: AuditRedactor,
    private readonly anonymiser: AccountAnonymiser,
    private readonly sessions: SessionService,
    private readonly holdings: HoldingsService,
    @Inject(AUDIT_WRITER) private readonly audit: AuditWriter,
  ) {}

  async erase(principal: Principal, id: string): Promise<CommandResult> {
    const org = orgOf(principal);
    const actor = principal.user.id;
    // The refusals in the order the screen explains them: open checks, the last Tenant Admin, one's own membership,
    // then open items. The holdings are counted before the transaction (their service opens its own).
    const subject = await this.tenancy.withTenant(tenantContextOf(principal), async (trx) => {
      const row = await requestRow(trx, id);
      this.assertErasable(row);
      await assertChecksDone(trx, row.id);
      if (row.subject_kind === 'member' && row.subject_user_id) {
        const member = await memberFacts(trx, org.id, row.subject_user_id);
        if (member) await assertNotLastTenantAdmin(trx, org.id, member);
        if (row.subject_user_id === actor) throw new ForbiddenError(REFUSALS.ownMembership.en);
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
      const counts = row.subject_kind === 'member' ? await this.eraseMember(trx, org, row, actor) : emptyCounts();
      counts.erased = 1;
      counts.systemsChecked = checked.length;
      await trx
        .updateTable('privacy_request')
        .set({ result: JSON.stringify({ ...(row.result ?? {}), ...counts }), handled_by: actor, updated_by: actor })
        .where('id', '=', row.id)
        .execute();
      await this.audit.record(trx, {
        action: 'privacy_request.erased',
        entityType: 'privacy_request',
        entityId: row.id,
        entityCode: row.request_no,
        after: { subject_kind: row.subject_kind, ...counts },
      });
      return {
        ok: true,
        changed: [],
        ref: requestRef(row.id, row.request_no),
        data: counts,
        message: row.subject_kind === 'member'
          ? [`The person of ${row.request_no} is erased in this organisation`, `Orang pada ${row.request_no} telah dihapus di organisasi ini`]
          : [`Erasure of ${row.request_no} recorded: every system check is done`, `Penghapusan ${row.request_no} dicatat: setiap pemeriksaan sistem selesai`],
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
    let held: number;
    try {
      const holdings = await this.holdings.userHoldings(principal, userId);
      held = holdings.systems.reduce((sum, s) => sum + s.total, 0);
    } catch (error) {
      // A person whose membership is gone holds nothing the holdings can show.
      if ((error as { status?: number }).status === 404) return 0;
      throw error;
    }
    if (held === 0) return 0;
    const screenTasks = await this.tenancy.withTenant(tenantContextOf(principal), async (trx) => {
      const { rows } = await sql<{ n: number }>`
        select count(*)::int as n from task t join management_system m on m.id = t.management_system_id and m.deleted_at is null
         where t.owner_user_id = ${userId}::uuid and t.status = 'open' and t.deleted_at is null
           and t.source_rule = any(${[...SCREEN_TASK_SOURCES]}::text[])`.execute(trx);
      return rows[0]?.n ?? 0;
    });
    return Math.max(0, held - screenTasks);
  }

  /** Steps 1 to 5 for a member (see the top of the file). */
  private async eraseMember(trx: Trx, org: TenantInfo, row: RequestRow, actor: string): Promise<ErasureCounts> {
    const userId = row.subject_user_id!;
    const counts = emptyCounts();
    await trx.selectFrom('platform.org_membership').select('user_id').where('organization_id', '=', org.id).where('user_id', '=', userId).forUpdate().execute();
    const member = await memberFacts(trx, org.id, userId);
    const already = await trx.selectFrom('erased_person').select('pseudonym').where('erased_user_id', '=', userId).executeTakeFirst();
    if (already) throw conflict(REFUSALS.alreadyErased);
    if (!member) throw conflict(REFUSALS.notMember);
    await assertNotLastTenantAdmin(trx, org.id, member);
    const pseudonym = await freePseudonym(trx);
    const values = personalValues(member, pseudonym);

    // The audit rows to redact, chosen before this erasure writes any entry (step 4).
    const tenantSeqs = await this.tenantSeqs(trx, userId, values);
    const platformSeqs = await this.platformSeqs(trx, org.id, userId, values);

    // Step 1: roles, linked sign-in, invitations, membership, sessions.
    const grants = await trx
      .updateTable('user_ms_role')
      .set({ deleted_at: sql<Date>`now()`, updated_by: actor })
      .where('user_id', '=', userId)
      .where('deleted_at', 'is', null)
      .returning(['id', 'management_system_id', 'role', 'approval_status'])
      .execute();
    for (const grant of grants) {
      await this.audit.record(trx, {
        action: 'role.revoked',
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
    await trx
      .updateTable('platform.org_membership')
      .set({ deleted_at: sql<Date>`now()`, admin_roles: [] })
      .where('organization_id', '=', org.id)
      .where('user_id', '=', userId)
      .execute();
    await this.audit.record(trx, {
      action: 'membership.updated',
      organizationId: org.id,
      entityType: 'org_membership',
      entityId: userId,
      entityCode: pseudonym,
      before: { status: member.membershipStatus, adminRoles: member.adminRoles },
      after: { status: 'removed', adminRoles: [], privacyRequest: row.request_no },
    });
    counts.sessionsEnded = await this.sessions.revokeOrganisationSessions(trx, org.id, 'account_erased', { userId });

    // Step 2: the pseudonym.
    await trx
      .insertInto('erased_person')
      .values({ erased_user_id: userId, pseudonym, privacy_request_id: row.id, erased_by: actor, created_by: actor, updated_by: actor })
      .execute();

    // Step 3: confirmations, tasks, notifications, calendar feeds.
    const excused = await trx
      .updateTable('acknowledgement')
      .set({ status: 'excused', excused_reason: EXCUSED_BY_ERASURE, updated_by: actor })
      .where('user_id', '=', userId)
      .where('status', '=', 'pending')
      .where('deleted_at', 'is', null)
      .returning('id')
      .execute();
    counts.confirmationsExcused = excused.length;
    const tasks = await trx
      .updateTable('task')
      .set({ status: 'cancelled', closed_by: actor, closed_at: sql<Date>`now()`, updated_by: actor })
      .where('owner_user_id', '=', userId)
      .where('status', '=', 'open')
      .where('deleted_at', 'is', null)
      .returning('id')
      .execute();
    counts.tasksCancelled = tasks.length;
    counts.notificationsDeleted = Number((await trx.deleteFrom('notification').where('recipient_user_id', '=', userId).executeTakeFirst()).numDeletedRows);
    counts.calendarFeedsDeleted = Number((await trx.deleteFrom('calendar_feed_token').where('user_id', '=', userId).executeTakeFirst()).numDeletedRows);
    const exports = await this.withdrawPersonalExports(trx, userId, pseudonym, actor);
    counts.exportsWithdrawn = exports.withdrawn;
    counts.notificationsDeleted += exports.notices;

    // Step 4: attested redaction of the chosen audit rows (each chain gets its attestation even with nothing to change,
    // so the request can show that the step ran).
    const reason = `Erasure of a person at their request (${row.request_no})`;
    const tenant = await this.redactor.redact(trx, {
      chain: { schema: org.schema },
      seqs: tenantSeqs,
      replacements: values,
      attestation: { action: 'privacy.audit_redacted', reason, entityType: 'privacy_request', entityId: row.id, entityCode: row.request_no, actor: { userId: actor, kind: 'user' } },
    });
    counts.auditEntriesRedacted = tenant.redacted;
    const platform = await this.redactor.redact(trx, {
      chain: 'platform',
      seqs: platformSeqs,
      replacements: values,
      attestation: {
        action: 'user.audit_redacted', reason, organizationId: org.id, entityType: 'user', entityId: userId, entityCode: pseudonym, actor: { userId: actor, kind: 'user' },
      },
    });
    counts.platformEntriesRedacted = platform.redacted;

    // Step 5: an account that belongs to this organisation only is anonymised.
    const anonymised = await this.anonymiser.anonymise(trx, userId, {
      reason: `Erased at the person's request in this organisation (${row.request_no})`,
      organizationId: org.id,
      leavingOrgId: org.id,
      actor: { userId: actor, kind: 'user' },
    });
    counts.accountAnonymised = anonymised ? 1 : 0;
    return counts;
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

  /** `seq` of the organisation's audit entries where the person acted, that are about the account, or that name them. */
  private async tenantSeqs(trx: Trx, userId: string, values: Record<string, string>): Promise<string[]> {
    const json = JSON.stringify(values);
    const { rows } = await sql<{ seq: string }>`
      select t.seq from audit_trail t
       where t.actor_user_id = ${userId}::uuid
          or (t.entity_id = ${userId}::uuid and t.entity_type in ('user', 'org_membership'))
          or platform.audit_redact_text(t.entity_code, ${json}::jsonb) is distinct from t.entity_code
          or platform.audit_redact_json(t.before_data, ${json}::jsonb) is distinct from t.before_data
          or platform.audit_redact_json(t.after_data, ${json}::jsonb) is distinct from t.after_data
       order by t.seq`.execute(trx);
    return rows.map((r) => String(r.seq));
  }

  /** `seq` of this organisation's platform audit entries where the person acted, that are about the account, or that name them. */
  private async platformSeqs(trx: Trx, orgId: string, userId: string, values: Record<string, string>): Promise<string[]> {
    const json = JSON.stringify(values);
    return inPlatformScope(trx, async () => {
      const { rows } = await sql<{ seq: string }>`
        select p.seq from platform.audit_log p
         where p.organization_id = ${orgId}::uuid
           and (p.actor_user_id = ${userId}::uuid
                or (p.entity_id = ${userId}::uuid and p.entity_type in ('user', 'org_membership'))
                or platform.audit_redact_text(p.entity_code, ${json}::jsonb) is distinct from p.entity_code
                or platform.audit_redact_json(p.before_data, ${json}::jsonb) is distinct from p.before_data
                or platform.audit_redact_json(p.after_data, ${json}::jsonb) is distinct from p.after_data)
         order by p.seq`.execute(trx);
      return rows.map((r) => String(r.seq));
    });
  }
}

/** 409 `privacy.checks_open` while a system check of the request is open. */
async function assertChecksDone(trx: Trx, requestId: string): Promise<void> {
  const open = await trx.selectFrom('privacy_check').select('id').where('privacy_request_id', '=', requestId).where('status', '=', 'open').where('deleted_at', 'is', null).execute();
  if (open.length > 0) throw conflict(REFUSALS.checksOpen);
}

/** The person's identifying values and the pseudonym each becomes (values shorter than 3 characters are not replaced). */
export function personalValues(member: Pick<MemberFacts, 'handle' | 'email' | 'name'>, pseudonym: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const value of [member.email, member.handle, member.name]) {
    const trimmed = value?.trim();
    if (trimmed && trimmed.length >= 3) out[trimmed] = pseudonym;
  }
  return out;
}

function emptyCounts(): ErasureCounts {
  return {
    erased: 0, rolesRevoked: 0, linkedSignInsRemoved: 0, invitationsRemoved: 0, sessionsEnded: 0, confirmationsExcused: 0, tasksCancelled: 0,
    notificationsDeleted: 0, calendarFeedsDeleted: 0, exportsWithdrawn: 0, auditEntriesRedacted: 0, platformEntriesRedacted: 0, accountAnonymised: 0, systemsChecked: 0,
  };
}
