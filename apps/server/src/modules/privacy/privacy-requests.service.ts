// Requests from one person, handled by the Tenant Admins (Milestone 3 D.1, D.6, J.8): the register with filters and the
// time left, recording a request (by a Tenant Admin, or by the person from "My account" through `openRequest`), one
// request with its system checks and the steps taken, the moves of J.8 (start after the identity check, refuse or
// record a withdrawal with the reason, add a note), correcting the name and job title of an account that belongs to
// this organisation only (422 `shared_account` otherwise), restricting (the membership is disabled, also for an
// objection) and closing with the answer given after the action of the request's type.
//
// The request keeps the person as entered (name and email), as proof that it was answered (D.6.5); audit entries of a
// request carry its number and type, never the person's name or email. Notes live in the audit entries
// (`privacy_request.created` and `.updated` with action `note`); the detail shows the latest.
import { Inject, Injectable } from '@nestjs/common';
import type {
  CommandResult, Page, PrivacyCheckView, PrivacyClose, PrivacyRectify, PrivacyRequestAction, PrivacyRequestCreate, PrivacyRequestDetail,
  PrivacyRequestItem, PrivacyRequestListQuery, PrivacyRequestPatch, PrivacyRequestType,
} from '@mscd/shared';
import { sql } from 'kysely';
import { Clock } from '../../common/clock';
import { localDate } from '../../common/dates';
import { assertIfMatch } from '../../common/etag';
import { ForbiddenError, NotFoundError, TransitionNotAllowedError } from '../../common/problems';
import { AUDIT_WRITER, NOTIFICATION_WRITER, type AuditWriter, type NotificationWriter, type Principal, type TenantInfo, type Trx } from '../../common/tokens';
import { MscdConfig } from '../../config/mscd-config';
import { MembershipDirectory } from '../authz/membership-directory';
import { SessionService } from '../identity/session.service';
import { TenantScope, tenantContextOf } from '../tenancy/tenant-scope';
import { erasedJoin, shownHandle, shownName } from './pseudonym';
import {
  activeTenantAdmins, conflict, isOpen, nextRequestNo, orgOf, personOf, refusal, requestItem, requestRef, requestRow, requestRows, systemsWithManager,
  type RequestRow,
} from './privacy-model';
import { checkRequestedNotice, checkTaskTitle, receivedNotice, REFUSALS } from './privacy-text';

/** Input of `openRequest`: a request recorded by a Tenant Admin or sent by the person. */
export interface OpenRequestInput {
  type: PrivacyRequestType;
  subject: { kind: 'member'; userId: string; name: string; email: string } | { kind: 'other'; name: string; email: string | null };
  channel: 'self_service' | 'email' | 'letter' | 'provider' | 'other';
  receivedAt: Date;
  note: string | null;
  actorId: string;
}

/** A member of the organisation as a request names them (any membership state that is not removed). */
export interface MemberFacts {
  userId: string;
  handle: string;
  name: string;
  email: string;
  jobTitle: string | null;
  kind: 'person' | 'system' | 'guest';
  membershipStatus: 'active' | 'invited' | 'disabled';
  adminRoles: string[];
}

/** The member `userId` of the organisation, or null when the account holds no membership there that is not removed. */
export async function memberFacts(trx: Trx, orgId: string, userId: string): Promise<MemberFacts | null> {
  const { rows } = await sql<{ id: string; handle: string; display_name: string; email: string; job_title: string | null; kind: MemberFacts['kind']; status: MemberFacts['membershipStatus']; admin_roles: string[] }>`
    select u.id, u.handle, u.display_name, u.email, u.job_title, u.kind, m.status, m.admin_roles
      from platform.org_membership m join platform.app_user u on u.id = m.user_id
     where m.organization_id = ${orgId}::uuid and m.user_id = ${userId}::uuid and m.deleted_at is null and u.deleted_at is null
       and u.kind <> 'system'`.execute(trx);
  const row = rows[0];
  if (!row) return null;
  return {
    userId: row.id, handle: row.handle, name: row.display_name, email: row.email, jobTitle: row.job_title, kind: row.kind,
    membershipStatus: row.status, adminRoles: [...row.admin_roles],
  };
}

/** True when the organisation keeps an active Tenant Admin other than `userId`. */
export async function anotherTenantAdmin(trx: Trx, orgId: string, userId: string): Promise<boolean> {
  return (await activeTenantAdmins(trx, orgId)).some((id) => id !== userId);
}

/** 409 `last_tenant_admin` when the member is the organisation's last active Tenant Admin (D.6.5). */
export async function assertNotLastTenantAdmin(trx: Trx, orgId: string, member: MemberFacts): Promise<void> {
  if (member.adminRoles.includes('tenant_admin') && member.membershipStatus === 'active' && !(await anotherTenantAdmin(trx, orgId, member.userId))) {
    throw conflict(REFUSALS.lastTenantAdmin);
  }
}

@Injectable()
export class PrivacyRequestsService {
  constructor(
    private readonly tenancy: TenantScope,
    private readonly clock: Clock,
    private readonly config: MscdConfig,
    private readonly directory: MembershipDirectory,
    private readonly sessions: SessionService,
    @Inject(AUDIT_WRITER) private readonly audit: AuditWriter,
    @Inject(NOTIFICATION_WRITER) private readonly notifications: NotificationWriter,
  ) {}

  // -------------------------------------------------------------------------------------------------------------
  // GET /admin/privacy-requests
  // -------------------------------------------------------------------------------------------------------------

  async list(principal: Principal, query: PrivacyRequestListQuery): Promise<Page<PrivacyRequestItem>> {
    orgOf(principal);
    const now = this.clock.now();
    return this.tenancy.withTenant(tenantContextOf(principal), async (trx) => {
      const q = query.q?.trim().toLowerCase();
      const rows = (await requestRows(trx)).filter(
        (r) =>
          (!query.status || r.status === query.status) &&
          (!query.type || r.request_type === query.type) &&
          (!q || [r.request_no, r.subject_name, r.subject_handle, r.subject_email].some((v) => v?.toLowerCase().includes(q))),
      );
      // Open requests first, the soonest due first; closed ones after, newest first.
      rows.sort((a, b) => {
        const open = Number(isOpen(b.status)) - Number(isOpen(a.status));
        if (open !== 0) return open;
        if (isOpen(a.status)) return new Date(a.due_at).getTime() - new Date(b.due_at).getTime() || a.request_no.localeCompare(b.request_no);
        return new Date(b.received_at).getTime() - new Date(a.received_at).getTime() || b.request_no.localeCompare(a.request_no);
      });
      const start = (query.page - 1) * query.pageSize;
      return { items: rows.slice(start, start + query.pageSize).map((r) => requestItem(r, now)), page: query.page, pageSize: query.pageSize, total: rows.length };
    });
  }

  // -------------------------------------------------------------------------------------------------------------
  // POST /admin/privacy-requests
  // -------------------------------------------------------------------------------------------------------------

  async create(principal: Principal, body: PrivacyRequestCreate): Promise<CommandResult> {
    const org = orgOf(principal);
    const receivedAt = new Date(body.receivedAt);
    if (receivedAt.getTime() > this.clock.now().getTime() + 5 * 60_000) throw refusal(REFUSALS.receivedLater);
    return this.tenancy.withTenant(tenantContextOf(principal), async (trx) => {
      let subject: OpenRequestInput['subject'];
      if ('userId' in body.subject) {
        const member = await memberFacts(trx, org.id, body.subject.userId);
        if (!member) throw new NotFoundError(REFUSALS.notMember.en);
        subject = { kind: 'member', userId: member.userId, name: member.name, email: member.email };
      } else {
        subject = { kind: 'other', name: body.subject.name, email: body.subject.email ?? null };
      }
      const opened = await this.openRequest(trx, org, {
        type: body.type, subject, channel: body.channel, receivedAt, note: body.note ?? null, actorId: principal.user.id,
      });
      return {
        ok: true,
        changed: opened.checkedSlugs,
        ref: requestRef(opened.id, opened.requestNo),
        data: { id: opened.id, requestNo: opened.requestNo, dueAt: opened.dueAt.toISOString(), checks: opened.checkedSlugs.length },
        message: [`Request ${opened.requestNo} recorded`, `Permintaan ${opened.requestNo} dicatat`],
      };
    });
  }

  /**
   * Writes a request (D.6.2: due `privacy.request_due_hours` after it was received) and, for access and erasure, one
   * check per system with a stored task (source `privacy_check`, entity the check, C.3) and `privacy_check_requested`
   * for the system's primary Management System Manager (D.6.4); audited `privacy_request.created` without the person's
   * name. Returns the request and the slugs of the systems that got a check.
   */
  async openRequest(trx: Trx, org: TenantInfo, input: OpenRequestInput): Promise<{ id: string; requestNo: string; dueAt: Date; checkedSlugs: string[] }> {
    const dueHours = this.config.profile.privacy.request_due_hours;
    const dueAt = new Date(input.receivedAt.getTime() + dueHours * 3_600_000);
    const year = this.clock.todayIn(org.timeZone).slice(0, 4);
    const requestNo = await nextRequestNo(trx, year);
    const request = await trx
      .insertInto('privacy_request')
      .values({
        request_no: requestNo,
        request_type: input.type,
        status: 'received',
        subject_kind: input.subject.kind,
        subject_user_id: input.subject.kind === 'member' ? input.subject.userId : null,
        subject_name: input.subject.name.slice(0, 200),
        subject_email: input.subject.email ? input.subject.email.slice(0, 320) : null,
        channel: input.channel,
        received_at: input.receivedAt,
        due_at: dueAt,
        created_by: input.actorId,
        updated_by: input.actorId,
      })
      .returning('id')
      .executeTakeFirstOrThrow();
    const checkedSlugs: string[] = [];
    if (input.type === 'access' || input.type === 'erasure') {
      const title = checkTaskTitle(requestNo, input.type);
      const notice = checkRequestedNotice(requestNo, input.type, dueAt, org.timeZone);
      for (const system of await systemsWithManager(trx)) {
        const check = await trx
          .insertInto('privacy_check')
          .values({ privacy_request_id: request.id, management_system_id: system.id, status: 'open', created_by: input.actorId, updated_by: input.actorId })
          .returning('id')
          .executeTakeFirstOrThrow();
        checkedSlugs.push(system.slug);
        if (!system.manager) continue;
        await trx
          .insertInto('task')
          .values({
            management_system_id: system.id,
            source_rule: 'privacy_check',
            entity_type: 'privacy_check',
            entity_id: check.id,
            entity_code: requestNo,
            title_en: title.en,
            title_id: title.id,
            owner_user_id: system.manager,
            due_at: localDate(dueAt, org.timeZone),
            status: 'open',
            created_by: input.actorId,
            updated_by: input.actorId,
          })
          .execute();
        await this.notifications.create(trx, {
          recipientUserId: system.manager,
          kind: 'privacy_check_requested',
          title: notice.title,
          body: notice.body,
          msId: system.id,
          ref: { module: 'admin', entityType: 'privacy_check', id: check.id, code: requestNo },
          createdBy: input.actorId,
        });
      }
    }
    await this.audit.record(trx, {
      action: 'privacy_request.created',
      entityType: 'privacy_request',
      entityId: request.id,
      entityCode: requestNo,
      after: {
        type: input.type,
        subject_kind: input.subject.kind,
        channel: input.channel,
        received_at: input.receivedAt.toISOString(),
        due_at: dueAt.toISOString(),
        checks: checkedSlugs.length,
        ...(input.note ? { note: input.note } : {}),
      },
    });
    if (input.channel === 'self_service') {
      const notice = receivedNotice(requestNo, input.type, dueAt, org.timeZone);
      for (const admin of await activeTenantAdmins(trx, org.id)) {
        await this.notifications.create(trx, {
          recipientUserId: admin,
          kind: 'privacy_request_received',
          title: notice.title,
          body: notice.body,
          msId: null,
          ref: requestRef(request.id, requestNo),
          createdBy: input.actorId,
        });
      }
    }
    return { id: request.id, requestNo, dueAt, checkedSlugs };
  }

  // -------------------------------------------------------------------------------------------------------------
  // GET /admin/privacy-requests/{id}
  // -------------------------------------------------------------------------------------------------------------

  async get(principal: Principal, id: string): Promise<PrivacyRequestDetail> {
    orgOf(principal);
    const now = this.clock.now();
    return this.tenancy.withTenant(tenantContextOf(principal), async (trx) => {
      const row = await requestRow(trx, id);
      return this.detailOf(trx, row, now);
    });
  }

  /** The detail of a request row: its checks, the steps of its audit entries, its latest note and its export task. */
  async detailOf(trx: Trx, row: RequestRow, now: Date): Promise<PrivacyRequestDetail> {
    const { rows: checks } = await sql<{ id: string; ms: string; status: 'open' | 'done'; done_handle: string | null; done_name: string | null; done_at: Date | null; note: string | null }>`
      select c.id, m.slug as ms, c.status, ${shownHandle('u', 'e')} as done_handle,
             ${shownName('u', 'e')} as done_name,
             c.done_at, c.note
        from privacy_check c
        join management_system m on m.id = c.management_system_id
        left join platform.app_user u on u.id = c.done_by
        ${erasedJoin('e', 'c.done_by')}
       where c.privacy_request_id = ${row.id}::uuid and c.deleted_at is null
       order by m.position, m.slug`.execute(trx);
    const { rows: entries } = await sql<{ action: string; occurred_at: Date; handle: string | null; display_name: string | null; after_data: Record<string, unknown> | null }>`
      select t.action, t.occurred_at, ${shownHandle('u', 'e')} as handle,
             ${shownName('u', 'e')} as display_name, t.after_data
        from audit_trail t
        left join platform.app_user u on u.id = t.actor_user_id
        ${erasedJoin('e', 't.actor_user_id')}
       where t.entity_type = 'privacy_request' and t.entity_id = ${row.id}::uuid
       order by t.seq`.execute(trx);
    const actions: PrivacyRequestAction[] = entries.map((e) => ({ action: e.action.slice(0, 60), at: new Date(e.occurred_at).toISOString(), actor: personOf(e.handle, e.display_name) }));
    let note: string | null = null;
    for (const e of entries) {
      const text = e.after_data && typeof e.after_data.note === 'string' ? e.after_data.note : null;
      if (text) note = text;
    }
    const task = await trx
      .selectFrom('background_task')
      .select('id')
      .where('kind', '=', 'export')
      .where(sql<boolean>`params->>'privacyRequestId' = ${row.id}`)
      .where('deleted_at', 'is', null)
      .orderBy('created_at', 'desc')
      .limit(1)
      .executeTakeFirst();
    const checkViews: PrivacyCheckView[] = checks.map((c) => ({
      id: c.id,
      ms: c.ms,
      status: c.status,
      doneBy: personOf(c.done_handle, c.done_name),
      doneAt: c.done_at ? new Date(c.done_at).toISOString() : null,
      note: c.note,
    }));
    return {
      ...requestItem(row, now),
      note,
      identityCheckNote: row.identity_check_note,
      identityCheckedBy: personOf(row.checked_handle, row.checked_name),
      outcome: row.outcome,
      result: row.result ? Object.fromEntries(Object.entries(row.result).filter(([, v]) => Number.isInteger(v) && v >= 0)) : null,
      checks: checkViews,
      actions,
      exportTaskId: task?.id ?? null,
    };
  }

  // -------------------------------------------------------------------------------------------------------------
  // PATCH /admin/privacy-requests/{id}
  // -------------------------------------------------------------------------------------------------------------

  async update(principal: Principal, id: string, patch: PrivacyRequestPatch, ifMatch: string | undefined): Promise<CommandResult> {
    orgOf(principal);
    const actor = principal.user.id;
    return this.tenancy.withTenant(tenantContextOf(principal), async (trx) => {
      const row = await requestRow(trx, id, { forUpdate: true });
      assertIfMatch(ifMatch, row.updated_at, requestRef(row.id, row.request_no, row.updated_at));
      let message: [string, string];
      if (patch.action === 'note') {
        await trx.updateTable('privacy_request').set({ updated_by: actor }).where('id', '=', row.id).execute();
        await this.audit.record(trx, {
          action: 'privacy_request.updated',
          entityType: 'privacy_request',
          entityId: row.id,
          entityCode: row.request_no,
          after: { action: 'note', note: patch.note },
        });
        message = [`Note added to ${row.request_no}`, `Catatan ditambahkan ke ${row.request_no}`];
      } else if (patch.action === 'start') {
        if (row.status !== 'received') throw new TransitionNotAllowedError(row.status, 'in_progress', { ref: requestRef(row.id, row.request_no) });
        await trx
          .updateTable('privacy_request')
          .set({ status: 'in_progress', identity_check_note: patch.identityCheckNote, identity_checked_by: actor, handled_by: actor, updated_by: actor })
          .where('id', '=', row.id)
          .execute();
        await this.audit.record(trx, {
          action: 'privacy_request.updated',
          entityType: 'privacy_request',
          entityId: row.id,
          entityCode: row.request_no,
          before: { status: row.status },
          after: { action: 'start', status: 'in_progress', identity_check_note: patch.identityCheckNote },
        });
        message = [`Work on ${row.request_no} started`, `Penanganan ${row.request_no} dimulai`];
      } else {
        const to = patch.action === 'refuse' ? 'refused' : 'withdrawn';
        if (!isOpen(row.status)) throw new TransitionNotAllowedError(row.status, to, { ref: requestRef(row.id, row.request_no) });
        await trx
          .updateTable('privacy_request')
          .set({ status: to, outcome: patch.reason, closed_at: sql<Date>`now()`, handled_by: actor, updated_by: actor })
          .where('id', '=', row.id)
          .execute();
        await cancelCheckTasks(trx, row.id, actor);
        await this.audit.record(trx, {
          action: 'privacy_request.updated',
          entityType: 'privacy_request',
          entityId: row.id,
          entityCode: row.request_no,
          before: { status: row.status },
          after: { action: patch.action, status: to, reason: patch.reason },
        });
        message = patch.action === 'refuse'
          ? [`Request ${row.request_no} refused`, `Permintaan ${row.request_no} ditolak`]
          : [`Withdrawal of ${row.request_no} recorded`, `Penarikan ${row.request_no} dicatat`];
      }
      return { ok: true, changed: [], ref: requestRef(row.id, row.request_no), message };
    });
  }

  // -------------------------------------------------------------------------------------------------------------
  // POST /admin/privacy-requests/{id}/rectify
  // -------------------------------------------------------------------------------------------------------------

  async rectify(principal: Principal, id: string, body: PrivacyRectify): Promise<CommandResult> {
    const org = orgOf(principal);
    const actor = principal.user.id;
    // The account check reads other organisations' memberships through the directory, before the transaction.
    const subjectUserId = await this.tenancy.withTenant(tenantContextOf(principal), async (trx) => {
      const row = await requestRow(trx, id);
      this.assertAction(row, 'rectification');
      return row.subject_user_id;
    });
    if (subjectUserId && (await this.directory.hasOtherActiveMembership(org.id, subjectUserId))) throw refusal(REFUSALS.sharedAccount);
    return this.tenancy.withTenant(tenantContextOf(principal), async (trx) => {
      const row = await requestRow(trx, id, { forUpdate: true });
      this.assertAction(row, 'rectification');
      const member = await memberFacts(trx, org.id, row.subject_user_id!);
      if (!member) throw conflict(REFUSALS.notMember);
      const changes: { display_name?: string; job_title?: string | null } = {};
      if (body.displayName !== undefined && body.displayName !== member.name) changes.display_name = body.displayName;
      if (body.jobTitle !== undefined && (body.jobTitle || null) !== member.jobTitle) changes.job_title = body.jobTitle || null;
      const fields = Object.keys(changes);
      if (fields.length > 0) {
        await trx.updateTable('platform.app_user').set({ ...changes, updated_by: actor }).where('id', '=', member.userId).execute();
        const before: Record<string, unknown> = {};
        const after: Record<string, unknown> = {};
        if (changes.display_name !== undefined) [before.displayName, after.displayName] = [member.name, changes.display_name];
        if (changes.job_title !== undefined) [before.jobTitle, after.jobTitle] = [member.jobTitle, changes.job_title];
        await this.audit.record(trx, {
          action: 'user.updated',
          organizationId: org.id,
          entityType: 'user',
          entityId: member.userId,
          entityCode: member.handle,
          before,
          after: { ...after, privacyRequest: row.request_no },
        });
      }
      const result = { ...(row.result ?? {}), rectified: (row.result?.rectified ?? 0) + 1, fieldsChanged: (row.result?.fieldsChanged ?? 0) + fields.length };
      await trx.updateTable('privacy_request').set({ result: JSON.stringify(result), handled_by: actor, updated_by: actor }).where('id', '=', row.id).execute();
      await this.audit.record(trx, {
        action: 'privacy_request.rectified',
        entityType: 'privacy_request',
        entityId: row.id,
        entityCode: row.request_no,
        after: { fields: fields.map((f) => (f === 'display_name' ? 'displayName' : 'jobTitle')) },
      });
      return {
        ok: true,
        changed: [],
        ref: requestRef(row.id, row.request_no),
        count: fields.length,
        message: fields.length > 0
          ? [`Account of ${row.request_no} corrected`, `Akun ${row.request_no} dikoreksi`]
          : ['Nothing changed: the values were already correct', 'Tidak ada perubahan: nilainya sudah benar'],
      };
    });
  }

  // -------------------------------------------------------------------------------------------------------------
  // POST /admin/privacy-requests/{id}/restrict
  // -------------------------------------------------------------------------------------------------------------

  /**
   * Restriction, also for an objection (D.6.3): the membership is disabled, so the person cannot sign in to this
   * organisation, gets no notifications and no new work here; the account and its other memberships stay. Their
   * sessions in this organisation end (F.1).
   */
  async restrict(principal: Principal, id: string): Promise<CommandResult> {
    const org = orgOf(principal);
    const actor = principal.user.id;
    return this.tenancy.withTenant(tenantContextOf(principal), async (trx) => {
      const row = await requestRow(trx, id, { forUpdate: true });
      this.assertAction(row, 'restriction');
      const userId = row.subject_user_id!;
      await trx.selectFrom('platform.org_membership').select('user_id').where('organization_id', '=', org.id).where('user_id', '=', userId).where('deleted_at', 'is', null).forUpdate().execute();
      const member = await memberFacts(trx, org.id, userId);
      if (!member) throw conflict(REFUSALS.notMember);
      if (member.membershipStatus === 'disabled') throw conflict(REFUSALS.alreadyRestricted);
      await assertNotLastTenantAdmin(trx, org.id, member);
      if (userId === actor) throw new ForbiddenError(REFUSALS.ownMembership.en);
      await trx.updateTable('platform.org_membership').set({ status: 'disabled' }).where('organization_id', '=', org.id).where('user_id', '=', userId).execute();
      await this.audit.record(trx, {
        action: 'membership.updated',
        organizationId: org.id,
        entityType: 'org_membership',
        entityId: userId,
        entityCode: member.handle,
        before: { status: member.membershipStatus, adminRoles: member.adminRoles },
        after: { status: 'disabled', adminRoles: member.adminRoles, privacyRequest: row.request_no },
      });
      const sessions = await this.sessions.revokeOrganisationSessions(trx, org.id, 'membership_removed', { userId });
      const result = { ...(row.result ?? {}), restricted: 1, sessionsEnded: (row.result?.sessionsEnded ?? 0) + sessions };
      await trx.updateTable('privacy_request').set({ result: JSON.stringify(result), handled_by: actor, updated_by: actor }).where('id', '=', row.id).execute();
      await this.audit.record(trx, {
        action: 'privacy_request.restricted',
        entityType: 'privacy_request',
        entityId: row.id,
        entityCode: row.request_no,
        after: { membership: 'disabled', sessions_ended: sessions },
      });
      return {
        ok: true,
        changed: [],
        ref: requestRef(row.id, row.request_no),
        message: [`Membership disabled for ${row.request_no}; the person cannot sign in to this organisation`, `Keanggotaan dinonaktifkan untuk ${row.request_no}; orang tersebut tidak dapat masuk ke organisasi ini`],
      };
    });
  }

  // -------------------------------------------------------------------------------------------------------------
  // POST /admin/privacy-requests/{id}/close
  // -------------------------------------------------------------------------------------------------------------

  /**
   * Completes a request in progress with the answer given (J.8), after the action of its type: access and erasure need
   * every system check done, and for a member the person export queued (access) or the erasure done (erasure); a
   * restriction needs the membership disabled. A correction may be answered without changing the account (the person
   * corrects a shared account in My account; record owners correct text in records).
   */
  async close(principal: Principal, id: string, body: PrivacyClose): Promise<CommandResult> {
    orgOf(principal);
    const actor = principal.user.id;
    return this.tenancy.withTenant(tenantContextOf(principal), async (trx) => {
      const row = await requestRow(trx, id, { forUpdate: true });
      if (row.status !== 'in_progress') {
        if (!isOpen(row.status)) throw new TransitionNotAllowedError(row.status, 'completed', { ref: requestRef(row.id, row.request_no) });
        throw conflict(REFUSALS.startFirst);
      }
      const result = row.result ?? {};
      if (row.request_type === 'access' || row.request_type === 'erasure') {
        const open = await trx.selectFrom('privacy_check').select('id').where('privacy_request_id', '=', row.id).where('status', '=', 'open').where('deleted_at', 'is', null).execute();
        if (open.length > 0) throw conflict(REFUSALS.checksOpen);
      }
      const member = row.subject_kind === 'member';
      const done =
        row.request_type === 'rectification' ||
        (row.request_type === 'access' && (!member || (result.exportsQueued ?? 0) > 0)) ||
        (row.request_type === 'erasure' && (result.erased ?? 0) > 0) ||
        (row.request_type === 'restriction' && (!member || (result.restricted ?? 0) > 0));
      if (!done) throw conflict(REFUSALS.actionFirst);
      await trx
        .updateTable('privacy_request')
        .set({ status: 'completed', outcome: body.outcome, closed_at: sql<Date>`now()`, handled_by: actor, updated_by: actor })
        .where('id', '=', row.id)
        .execute();
      await cancelCheckTasks(trx, row.id, actor);
      await this.audit.record(trx, {
        action: 'privacy_request.closed',
        entityType: 'privacy_request',
        entityId: row.id,
        entityCode: row.request_no,
        before: { status: row.status },
        after: { status: 'completed', outcome: body.outcome, ...(Object.keys(result).length > 0 ? { result } : {}) },
      });
      return { ok: true, changed: [], ref: requestRef(row.id, row.request_no), message: [`Request ${row.request_no} completed`, `Permintaan ${row.request_no} selesai`] };
    });
  }

  // -------------------------------------------------------------------------------------------------------------
  // Helpers
  // -------------------------------------------------------------------------------------------------------------

  /** The request must be in progress, of `type`, and about a member (409 otherwise). */
  private assertAction(row: RequestRow, type: PrivacyRequestType): void {
    if (!isOpen(row.status)) throw conflict(REFUSALS.closed);
    if (row.request_type !== type) throw conflict(REFUSALS.wrongType);
    if (row.status !== 'in_progress') throw conflict(REFUSALS.startFirst);
    if (row.subject_kind !== 'member' || !row.subject_user_id) throw conflict(REFUSALS.noAccount);
  }
}

/** Cancels the open stored tasks of a request's checks (the request closed before the checks were done). */
export async function cancelCheckTasks(trx: Trx, requestId: string, actorId: string): Promise<number> {
  const rows = await trx
    .updateTable('task')
    .set({ status: 'cancelled', closed_by: actorId, closed_at: sql<Date>`now()`, updated_by: actorId })
    .where('source_rule', '=', 'privacy_check')
    .where('entity_type', '=', 'privacy_check')
    .where('status', '=', 'open')
    .where('deleted_at', 'is', null)
    .where(sql<boolean>`entity_id in (select c.id from privacy_check c where c.privacy_request_id = ${requestId}::uuid)`)
    .returning('id')
    .execute();
  return rows.length;
}
