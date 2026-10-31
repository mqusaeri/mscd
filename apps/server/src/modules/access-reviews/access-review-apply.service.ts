// Applying the decisions of an access review (Milestone 3 D.9, M3-07): people who hold the right apply a decided
// revocation through the existing services, each audited as today, plus `access_review.item_applied`:
//
// | Item                    | Applied by                                         | Through                                              |
// |-------------------------|----------------------------------------------------|------------------------------------------------------|
// | `business_role` revoke  | Tenant Admin (`access-reviews.apply`)              | `RoleGrantsService.revoke` (`role.revoked`)          |
// | `admin_role` revoke     | Tenant Admin                                       | `UsersService.update` with the other admin roles     |
// | `membership` revoke     | Tenant Admin                                       | `UsersService.update` with `membershipStatus: disabled` |
// | `linked_sign_in` revoke | Tenant Admin                                       | `IdentitiesService.remove` (`identity.unlinked`)     |
// | `auditor_access` revoke | Management System Manager (`access-reviews.ms.apply`) | `AuditorAccessService.revoke` (`auditor_access.revoked`) |
// | any `change`, or a revocation made elsewhere | the person who holds the right | "Mark as applied" with a note             |
//
// An item that will not be applied gets a reason instead. A right that is gone already when it is applied (revoked on
// People and roles meanwhile, a grant that expired) is recorded as `already_removed`. The service of the right runs in
// its own transaction (it rotates the caller's session when the caller's own roles change, F.1); the item is marked in
// the next one, and a repeated request finds the right gone and completes the mark.
import { Inject, Injectable } from '@nestjs/common';
import type { AccessReviewApply, CommandResult, OrgRole, Pair } from '@mscd/shared';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { sql } from 'kysely';
import { Clock } from '../../common/clock';
import { ConflictError, NotFoundError } from '../../common/problems';
import { AUDIT_WRITER, RECORD_RESOLVER, type AuditWriter, type Principal, type RecordResolver, type Trx } from '../../common/tokens';
import { IdentitiesService } from '../admin-users/identities.service';
import { RoleGrantsService } from '../admin-users/role-grants.service';
import { UsersService } from '../admin-users/users.service';
import { AuditorAccessService } from '../auditor-access/auditor-access.service';
import { commandResult, orgOf } from '../registers/command-support';
import { TenantScope, tenantContextOf } from '../tenancy/tenant-scope';
import { lockedItem, partRows, reviewRow, subjectOf, type ItemRow, type ReviewRow } from './access-review-data';
import { APPLIED_MESSAGES, REFUSALS } from './access-review-text';

/** Which route applies an item: the organisation route (Tenant Admins) or the system route (guest grants). */
export type ApplyRoute = { kind: 'org' } | { kind: 'ms'; ms: string };

interface Checked {
  review: ReviewRow;
  item: ItemRow;
}

const conflict = (detail: string, messages: { en: string; id: string }) => new ConflictError(detail, { messages });

@Injectable()
export class AccessReviewApplyService {
  constructor(
    private readonly tenancy: TenantScope,
    private readonly clock: Clock,
    private readonly users: UsersService,
    private readonly grants: RoleGrantsService,
    private readonly identities: IdentitiesService,
    private readonly auditorAccess: AuditorAccessService,
    @Inject(RECORD_RESOLVER) private readonly records: RecordResolver,
    @Inject(AUDIT_WRITER) private readonly audit: AuditWriter,
  ) {}

  async apply(
    request: FastifyRequest,
    reply: FastifyReply,
    principal: Principal,
    route: ApplyRoute,
    id: string,
    itemId: string,
    body: AccessReviewApply,
  ): Promise<CommandResult> {
    const checked = await this.tenancy.withTenant(tenantContextOf(principal), (trx) => this.check(trx, route, id, itemId, body));
    if (!checked) return this.result(null, null);
    const { item } = checked;
    if (body.action === 'mark_applied' || body.action === 'not_applied') return this.mark(principal, route, id, itemId, body, null);

    // Apply a revocation through the service of the right (its own transaction), then mark the item.
    let action: string;
    if (!(await this.stillInForce(principal, item))) {
      action = 'already_removed';
    } else {
      action = await this.revoke(request, reply, principal, checked);
    }
    return this.mark(principal, route, id, itemId, body, action);
  }

  /**
   * The checks before anything changes; null when the item was applied or explained meanwhile (the request then
   * answers as done).
   */
  private async check(trx: Trx, route: ApplyRoute, id: string, itemId: string, body: AccessReviewApply): Promise<Checked | null> {
    const review = await reviewRow(trx, id);
    const item = await lockedItem(trx, id, itemId);
    if (route.kind === 'ms') {
      const system = await this.records.resolveMs(trx, route.ms);
      if (item.part_ms_id !== system.id) throw new NotFoundError('No such item in this system\'s part of the access review');
    }
    if (review.status !== 'open') throw conflict('The access review is not open', REFUSALS.notOpen);
    if (route.kind === 'ms' && item.item_kind !== 'auditor_access') throw conflict('Only guest auditor grants are applied here', REFUSALS.onlyGuest);
    if (route.kind === 'org' && item.item_kind === 'auditor_access') throw conflict('A guest auditor grant is revoked on the system\'s page', REFUSALS.guestOnSystem);
    if (item.decision === null) throw conflict('The item is not decided', REFUSALS.notDecided);
    if (item.decision === 'keep') throw conflict('The item was decided keep', REFUSALS.nothingToApply);
    if (body.action === 'apply' && item.decision !== 'revoke') throw conflict('Only a revocation is applied this way', REFUSALS.notRevoke);
    if (item.applied_at !== null || item.not_applied_reason !== null) return null;
    if (body.action === 'apply' && item.item_kind === 'membership') {
      const { rows } = await sql<{ status: string }>`
        select m.status from platform.org_membership m where m.user_id = ${item.subject_user_id} and m.organization_id = nullif(current_setting('app.org_id', true), '')::uuid
           and m.deleted_at is null`.execute(trx);
      if (rows[0]?.status === 'invited') throw conflict('An invited membership cannot be disabled', REFUSALS.invitedMembership);
    }
    return { review, item };
  }

  /** True while the reviewed right still exists as the snapshot took it. */
  private async stillInForce(principal: Principal, item: ItemRow): Promise<boolean> {
    const org = orgOf(principal);
    return this.tenancy.withTenant(tenantContextOf(principal), async (trx) => {
      switch (item.item_kind) {
        case 'business_role': {
          const { rows } = await sql<{ id: string }>`
            select id from user_ms_role where id = ${item.ref.roleId ?? null}::uuid and deleted_at is null and approval_status <> 'rejected'
               and (valid_until is null or valid_until > now())`.execute(trx);
          return rows.length > 0;
        }
        case 'admin_role':
        case 'membership': {
          const { rows } = await sql<{ status: string; admin_roles: string[] }>`
            select status, admin_roles from platform.org_membership where user_id = ${item.subject_user_id} and organization_id = ${org.id} and deleted_at is null`.execute(trx);
          const m = rows[0];
          if (!m || m.status === 'disabled') return false;
          return item.item_kind === 'membership' || m.admin_roles.includes(item.ref.role ?? '');
        }
        case 'linked_sign_in':
          return item.ref.providerId ? this.identities.isLinked(trx, item.subject_user_id, item.ref.providerId) : false;
        case 'auditor_access': {
          const { rows } = await sql<{ id: string }>`
            select id from auditor_access_grant where id = ${item.ref.grantId ?? null}::uuid and deleted_at is null and revoked_at is null and expires_at > now()`.execute(trx);
          return rows.length > 0;
        }
        default:
          return false;
      }
    });
  }

  /** Revokes the right through its service; returns the action recorded on the item. */
  private async revoke(request: FastifyRequest, reply: FastifyReply, principal: Principal, { review, item }: Checked): Promise<string> {
    switch (item.item_kind) {
      case 'business_role': {
        const msId = item.part_ms_id!;
        await this.grants.revoke(request, reply, principal, msId, item.ref.roleId!);
        return 'role.revoked';
      }
      case 'admin_role': {
        const org = orgOf(principal);
        const current = await this.tenancy.withTenant(tenantContextOf(principal), async (trx) => {
          const { rows } = await sql<{ admin_roles: OrgRole[] }>`
            select admin_roles from platform.org_membership where user_id = ${item.subject_user_id} and organization_id = ${org.id} and deleted_at is null`.execute(trx);
          return rows[0]?.admin_roles ?? [];
        });
        await this.users.update(request, reply, principal, item.subject_user_id, { adminRoles: current.filter((r) => r !== item.ref.role) });
        return 'membership.admin_role_removed';
      }
      case 'membership':
        await this.users.update(request, reply, principal, item.subject_user_id, { membershipStatus: 'disabled' });
        return 'membership.disabled';
      case 'linked_sign_in': {
        const reason = item.decision_note ? `Access review ${review.review_no}: ${item.decision_note}` : `Access review ${review.review_no}: access no longer needed`;
        await this.identities.remove(principal, item.subject_user_id, { provider: item.ref.provider!, reason: reason.slice(0, 500) });
        return 'identity.unlinked';
      }
      case 'auditor_access': {
        const ms = item.ms!;
        await this.auditorAccess.revoke(principal, ms, item.ref.grantId!);
        return 'auditor_access.revoked';
      }
      default:
        throw new NotFoundError('Unknown item kind');
    }
  }

  /** Marks the item applied (with the action), applied by hand, or not applied with its reason. */
  private async mark(principal: Principal, route: ApplyRoute, id: string, itemId: string, body: AccessReviewApply, action: string | null): Promise<CommandResult> {
    const actor = principal.user.id;
    return this.tenancy.withTenant(tenantContextOf(principal), async (trx) => {
      const review = await reviewRow(trx, id);
      const item = await lockedItem(trx, id, itemId);
      if (item.applied_at !== null || item.not_applied_reason !== null) return this.result(item, null);
      if (review.status !== 'open') throw conflict('The access review is not open', REFUSALS.notOpen);
      const now = this.clock.now();
      let applied: string;
      if (body.action === 'not_applied') {
        const ref = { ...item.ref, notAppliedAt: now.toISOString() };
        await sql`update access_review_item set not_applied_reason = ${body.reason}, applied_by = ${actor}, applied_action = 'not_applied',
                   ref = ${JSON.stringify(ref)}::jsonb, updated_at = now(), updated_by = ${actor} where id = ${item.id}`.execute(trx);
        applied = 'not_applied';
      } else if (body.action === 'mark_applied') {
        const ref = body.note ? { ...item.ref, appliedNote: body.note } : item.ref;
        await sql`update access_review_item set applied_at = ${now}, applied_by = ${actor}, applied_action = 'marked_applied',
                   ref = ${JSON.stringify(ref)}::jsonb, updated_at = now(), updated_by = ${actor} where id = ${item.id}`.execute(trx);
        applied = 'marked_applied';
      } else {
        applied = action ?? 'already_removed';
        await sql`update access_review_item set applied_at = ${now}, applied_by = ${actor}, applied_action = ${applied},
                   updated_at = now(), updated_by = ${actor} where id = ${item.id}`.execute(trx);
      }
      const subject = subjectOf(item);
      await this.audit.record(trx, {
        action: 'access_review.item_applied',
        msId: item.part_ms_id,
        entityType: 'access_review_item',
        entityId: item.id,
        entityCode: review.review_no,
        after: {
          action: body.action, appliedAction: applied, kind: item.item_kind, subject: subject.handle, role: item.role, ms: item.ms, via: route.kind,
          ...(body.action === 'not_applied' ? { reason: body.reason } : {}),
          ...(body.action === 'mark_applied' && body.note ? { note: body.note } : {}),
        },
      });
      const [part] = await partRows(trx, { partId: item.access_review_part_id });
      return this.result({ ...item, ms: part?.ms ?? item.ms }, applied);
    });
  }

  private result(item: Pick<ItemRow, 'ms'> | null, applied: string | null): CommandResult {
    const message: Pair | undefined = applied === null ? undefined : (APPLIED_MESSAGES[applied] ?? ['Applied', 'Diterapkan']);
    return commandResult(item?.ms ? [item.ms] : [], { ...(message ? { message } : {}), data: { appliedAction: applied } });
  }
}
