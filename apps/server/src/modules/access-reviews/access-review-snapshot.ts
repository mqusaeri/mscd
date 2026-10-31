// The snapshot of an access review (Milestone 3 D.9, M3-07): when a review opens, every right in force becomes an item
// of its part, so the report shows the state that was reviewed even when the rights change afterwards.
//
// | Item kind        | Rows                                                                              | Part         |
// |------------------|-----------------------------------------------------------------------------------|--------------|
// | `membership`     | every active or invited membership of a person (guest accounts are reviewed through their grant) | organisation |
// | `admin_role`     | each Tenant Admin and Storage Admin role of those memberships                     | organisation |
// | `linked_sign_in` | each linked company sign-in of a member for one of this organisation's providers  | organisation |
// | `business_role`  | each active or pending role grant of the system, External Auditor roles of members with their end date included; the role row of a guest auditor grant is reviewed as that grant | system |
// | `auditor_access` | each open guest auditor grant of the system                                       | system       |
//
// The last sign-in is the latest session started in this organisation (F.6: a Tenant Admin does not see a member's
// activity in other organisations), or for a guest without one the last use of its grant.
import { sql } from 'kysely';
import type { Trx } from '../../common/tokens';
import { inPlatformScope } from '../identity/platform-scope';
import type { ItemRef } from './access-review-data';
import { dayOf } from './access-review-data';

interface NewItem {
  access_review_id: string;
  access_review_part_id: string;
  subject_user_id: string;
  item_kind: 'membership' | 'admin_role' | 'business_role' | 'auditor_access' | 'linked_sign_in';
  ref: ItemRef;
  role: string | null;
  granted_by: string | null;
  granted_at: Date | null;
  valid_until: string | null;
  last_sign_in_at: Date | null;
}

export interface SnapshotInput {
  orgId: string;
  timeZone: string;
  reviewId: string;
  orgPartId: string;
  /** The system parts: system id to part id. */
  systemParts: ReadonlyMap<string, string>;
  now: Date;
  actorId: string;
}

/** Writes the items of every part; returns how many per part id. */
export async function takeSnapshot(trx: Trx, input: SnapshotInput): Promise<Map<string, number>> {
  const items: NewItem[] = [];
  const base = { access_review_id: input.reviewId };

  const { rows: members } = await sql<{ user_id: string; status: string; invited_by: string | null; created_at: Date; admin_roles: string[] }>`
    select m.user_id, m.status, m.invited_by, m.created_at, m.admin_roles
      from platform.org_membership m join platform.app_user u on u.id = m.user_id
     where m.organization_id = ${input.orgId} and m.deleted_at is null and m.status in ('active', 'invited')
       and u.deleted_at is null and u.kind = 'person'
     order by m.user_id`.execute(trx);
  const memberIds = new Set(members.map((m) => m.user_id));

  const { rows: identities } = await sql<{ user_id: string; provider_id: string; slug: string; subject: string; linked_by: string | null; linked_at: Date; last_login_at: Date | null }>`
    select ui.user_id, ui.identity_provider_id as provider_id, ip.slug, ui.subject, ui.linked_by, ui.linked_at, ui.last_login_at
      from platform.user_identity ui join platform.identity_provider ip on ip.id = ui.identity_provider_id
     where ip.organization_id = ${input.orgId} and ip.deleted_at is null
     order by ui.user_id, ip.slug, ui.subject`.execute(trx);

  const systemIds = [...input.systemParts.keys()];
  const { rows: grants } = systemIds.length
    ? await sql<{
      id: string; user_id: string; management_system_id: string; role: string; valid_until: Date | null; approval_status: string;
      requested_by: string | null; approved_by: string | null; created_by: string | null; created_at: Date;
    }>`
      select r.id, r.user_id, r.management_system_id, r.role, r.valid_until, r.approval_status, r.requested_by, r.approved_by, r.created_by, r.created_at
        from user_ms_role r join platform.app_user u on u.id = r.user_id
       where r.management_system_id = any(${systemIds}::uuid[]) and r.deleted_at is null and r.approval_status in ('active', 'pending_approval')
         and (r.valid_until is null or r.valid_until > ${input.now}) and u.deleted_at is null and u.kind <> 'system'
         and not exists (select 1 from auditor_access_grant g where g.user_ms_role_id = r.id and g.deleted_at is null)
       order by r.management_system_id, r.user_id, r.role`.execute(trx)
    : { rows: [] };

  const { rows: guests } = systemIds.length
    ? await sql<{ id: string; user_id: string; management_system_id: string; user_ms_role_id: string | null; email: string; created_by: string | null; created_at: Date; expires_at: Date; last_used_at: Date | null }>`
      select g.id, g.user_id, g.management_system_id, g.user_ms_role_id, g.email, g.created_by, g.created_at, g.expires_at, g.last_used_at
        from auditor_access_grant g
       where g.management_system_id = any(${systemIds}::uuid[]) and g.deleted_at is null and g.revoked_at is null
         and g.expires_at > ${input.now} and g.user_id is not null
       order by g.management_system_id, g.created_at, g.id`.execute(trx)
    : { rows: [] };

  const people = new Set<string>([...memberIds, ...grants.map((g) => g.user_id), ...guests.map((g) => g.user_id)]);
  const lastSignIn = await lastSignInIn(trx, input.orgId, [...people]);

  for (const m of members) {
    items.push({
      ...base, access_review_part_id: input.orgPartId, subject_user_id: m.user_id, item_kind: 'membership', ref: { userId: m.user_id }, role: m.status,
      granted_by: m.invited_by, granted_at: m.created_at, valid_until: null, last_sign_in_at: lastSignIn.get(m.user_id) ?? null,
    });
    for (const role of [...m.admin_roles].sort()) {
      items.push({
        ...base, access_review_part_id: input.orgPartId, subject_user_id: m.user_id, item_kind: 'admin_role', ref: { userId: m.user_id, role }, role,
        granted_by: null, granted_at: null, valid_until: null, last_sign_in_at: lastSignIn.get(m.user_id) ?? null,
      });
    }
  }

  // One item per member and provider (a member may hold several subjects of one provider).
  const linked = new Map<string, { user_id: string; provider_id: string; slug: string; subjects: string[]; linked_by: string | null; linked_at: Date; last_login_at: Date | null }>();
  for (const i of identities) {
    if (!memberIds.has(i.user_id)) continue;
    const key = `${i.user_id}:${i.provider_id}`;
    const entry = linked.get(key);
    if (entry) {
      entry.subjects.push(i.subject);
      if (i.linked_at < entry.linked_at) [entry.linked_at, entry.linked_by] = [i.linked_at, i.linked_by];
      if (i.last_login_at && (!entry.last_login_at || i.last_login_at > entry.last_login_at)) entry.last_login_at = i.last_login_at;
    } else {
      linked.set(key, { ...i, subjects: [i.subject] });
    }
  }
  for (const l of linked.values()) {
    items.push({
      ...base, access_review_part_id: input.orgPartId, subject_user_id: l.user_id, item_kind: 'linked_sign_in',
      ref: { userId: l.user_id, providerId: l.provider_id, provider: l.slug, subjects: l.subjects }, role: l.slug.slice(0, 30),
      granted_by: l.linked_by, granted_at: l.linked_at, valid_until: null, last_sign_in_at: l.last_login_at,
    });
  }

  for (const g of grants) {
    const partId = input.systemParts.get(g.management_system_id)!;
    items.push({
      ...base, access_review_part_id: partId, subject_user_id: g.user_id, item_kind: 'business_role',
      ref: { roleId: g.id, role: g.role, approvalStatus: g.approval_status, requestedBy: g.requested_by, approvedBy: g.approved_by },
      role: g.role, granted_by: g.approved_by ?? g.requested_by ?? g.created_by, granted_at: g.created_at,
      valid_until: dayOf(g.valid_until, input.timeZone), last_sign_in_at: lastSignIn.get(g.user_id) ?? null,
    });
  }

  for (const g of guests) {
    const partId = input.systemParts.get(g.management_system_id)!;
    items.push({
      ...base, access_review_part_id: partId, subject_user_id: g.user_id, item_kind: 'auditor_access',
      ref: { grantId: g.id, roleId: g.user_ms_role_id ?? undefined, email: g.email }, role: 'external_auditor', granted_by: g.created_by,
      granted_at: g.created_at, valid_until: dayOf(g.expires_at, input.timeZone), last_sign_in_at: lastSignIn.get(g.user_id) ?? g.last_used_at,
    });
  }

  const counts = new Map<string, number>();
  for (let start = 0; start < items.length; start += 500) {
    const chunk = items.slice(start, start + 500);
    await trx
      .insertInto('access_review_item')
      .values(chunk.map((i) => ({ ...i, ref: JSON.stringify(i.ref), created_by: input.actorId, updated_by: input.actorId })) as never)
      .execute();
  }
  for (const i of items) counts.set(i.access_review_part_id, (counts.get(i.access_review_part_id) ?? 0) + 1);
  return counts;
}

/** The latest session each person started in this organisation (platform scope inside the tenant transaction). */
async function lastSignInIn(trx: Trx, orgId: string, userIds: readonly string[]): Promise<Map<string, Date>> {
  if (userIds.length === 0) return new Map();
  const rows = await inPlatformScope(trx, async () => {
    const { rows: found } = await sql<{ user_id: string; at: Date }>`
      select user_id, max(created_at) as at from platform.session
       where user_id = any(${[...userIds]}::uuid[]) and (organization_id = ${orgId} or auth_org_id = ${orgId})
       group by user_id`.execute(trx);
    return found;
  });
  return new Map(rows.map((r) => [r.user_id, new Date(r.at)]));
}
