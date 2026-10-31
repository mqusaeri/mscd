// Rows and reads of the periodic access review (Milestone 3 D.9, M3-07): the review, its parts and items with the
// people they name, who may decide the items of a part (the reviewers), and the API views of `access-reviews.ts`.
//
// An item "needs a second reviewer" while it is undecided and only the person it concerns holds the right to decide it:
// for the organisation part the active Tenant Admins, for a system part the active Management System Managers and
// Programme Owners of the system. Nobody decides on their own access (REVIEW-OWN-ACCESS), so such an item stays
// undecided; it does not hold up the sign-off or the completion, and the review completes with the warning
// REVIEW-SINGLE-ADMIN (as M2 D2-12 warns without relaxing a rule). The reviewers are read when the review is read, so a
// second reviewer added during the review can decide the item.
//
// A part that nobody may decide now (a system without an active Management System Manager or Programme Owner) is its
// own case, `noReviewer`: its items do not "need a second reviewer", the part cannot be signed off, and the review
// page and the refusal of "Complete" say that the Tenant Admin assigns a reviewer or cancels the review.
import type {
  AccessReviewDecision, AccessReviewItemKind, AccessReviewItemView, AccessReviewPartStatus, AccessReviewPartSummary, AccessReviewProgress,
  AccessReviewStatus, AccessReviewSummary,
} from '@mscd/shared';
import { sql } from 'kysely';
import { localDate } from '../../common/dates';
import { NotFoundError } from '../../common/problems';
import type { Trx } from '../../common/tokens';
import { handleBase } from '../identity/invitation.service';

export const ITEM_KIND_ORDER: readonly AccessReviewItemKind[] = ['membership', 'admin_role', 'linked_sign_in', 'business_role', 'auditor_access'];

/** Item kinds of the organisation part and of a system part. */
export const ORGANISATION_KINDS: ReadonlySet<AccessReviewItemKind> = new Set(['membership', 'admin_role', 'linked_sign_in']);
export const SYSTEM_KINDS: ReadonlySet<AccessReviewItemKind> = new Set(['business_role', 'auditor_access']);

export interface ReviewRow {
  id: string;
  review_no: string;
  status: AccessReviewStatus;
  opened_on: string;
  due_on: string;
  opened_by: string | null;
  completed_at: Date | null;
  completed_by: string | null;
  cancel_reason: string | null;
  summary: ReviewSummaryData | null;
  report_object_id: string | null;
  updated_at: Date;
  opened_handle: string | null;
  opened_name: string | null;
  completed_handle: string | null;
  completed_name: string | null;
}

export interface PartRow {
  id: string;
  access_review_id: string;
  review_no: string;
  review_status: AccessReviewStatus;
  due_on: string;
  management_system_id: string | null;
  ms: string | null;
  ms_code: string | null;
  status: AccessReviewPartStatus;
  signed_off_by: string | null;
  signed_off_at: Date | null;
  evidence_id: string | null;
  evidence_code: string | null;
  evidence_filed_at: Date | null;
  signed_handle: string | null;
  signed_name: string | null;
}

/** The facts an item keeps in `ref` (the ids of the reviewed row and how a decision was applied). */
export interface ItemRef {
  userId?: string;
  role?: string;
  roleId?: string;
  approvalStatus?: string;
  requestedBy?: string | null;
  approvedBy?: string | null;
  providerId?: string;
  provider?: string;
  subjects?: string[];
  grantId?: string;
  email?: string;
  appliedNote?: string;
  notAppliedAt?: string;
}

export interface ItemRow {
  id: string;
  access_review_id: string;
  access_review_part_id: string;
  part_ms_id: string | null;
  ms: string | null;
  ms_code: string | null;
  subject_user_id: string;
  item_kind: AccessReviewItemKind;
  ref: ItemRef;
  role: string | null;
  granted_by: string | null;
  granted_at: Date | null;
  valid_until: string | null;
  last_sign_in_at: Date | null;
  decision: AccessReviewDecision | null;
  decision_note: string | null;
  decided_by: string | null;
  decided_at: Date | null;
  applied_at: Date | null;
  applied_by: string | null;
  applied_action: string | null;
  not_applied_reason: string | null;
  subject_handle: string;
  subject_email: string;
  subject_name: string;
  subject_invited: boolean;
  granted_handle: string | null;
  granted_name: string | null;
  requested_handle: string | null;
  requested_name: string | null;
  approved_handle: string | null;
  approved_name: string | null;
  decided_handle: string | null;
  decided_name: string | null;
  applied_handle: string | null;
  applied_name: string | null;
}

/** What `access_review.summary` holds: reminder dates while open, the counts and warnings once completed. */
export interface ReviewSummaryData {
  reminders?: { dueSoonOn?: string; overdueOn?: string };
  completed?: {
    items: number;
    kept: number;
    changed: number;
    revoked: number;
    applied: number;
    notApplied: number;
    needsSecondReviewer: number;
    filed: { ms: string; evidenceCode: string; storageObjectId: string }[];
    reportStored: boolean;
  };
  warnings?: { rule: 'REVIEW-SINGLE-ADMIN'; messages: { en: string; id: string } }[];
}

/** Who may decide the items of each part: the organisation part (key `org`) and each system by id. */
export type Reviewers = ReadonlyMap<string, ReadonlySet<string>>;

export const ORG_KEY = 'org';

const iso = (d: Date | string | null): string | null => (d === null ? null : new Date(d).toISOString());
const person = (handle: string | null, name: string | null) => (handle ? { handle, displayName: name ?? handle } : null);

/** The review of this organisation with this id (404 otherwise), locked for update when asked. */
export async function reviewRow(trx: Trx, id: string, options: { forUpdate?: boolean } = {}): Promise<ReviewRow> {
  const lock = options.forUpdate ? sql`for update of r` : sql``;
  const { rows } = await sql<ReviewRow>`
    select r.id, r.review_no, r.status, r.opened_on::text as opened_on, r.due_on::text as due_on, r.opened_by, r.completed_at, r.completed_by,
           r.cancel_reason, r.summary, r.report_object_id, r.updated_at,
           ou.handle as opened_handle, ou.display_name as opened_name, cu.handle as completed_handle, cu.display_name as completed_name
      from access_review r
      left join platform.app_user ou on ou.id = r.opened_by
      left join platform.app_user cu on cu.id = r.completed_by
     where r.id = ${id} and r.deleted_at is null
     ${lock}`.execute(trx);
  const row = rows[0];
  if (!row) throw new NotFoundError('No such access review');
  return row;
}

/** Every review of the organisation, newest first. */
export async function reviewRows(trx: Trx): Promise<ReviewRow[]> {
  const { rows } = await sql<ReviewRow>`
    select r.id, r.review_no, r.status, r.opened_on::text as opened_on, r.due_on::text as due_on, r.opened_by, r.completed_at, r.completed_by,
           r.cancel_reason, r.summary, r.report_object_id, r.updated_at,
           ou.handle as opened_handle, ou.display_name as opened_name, cu.handle as completed_handle, cu.display_name as completed_name
      from access_review r
      left join platform.app_user ou on ou.id = r.opened_by
      left join platform.app_user cu on cu.id = r.completed_by
     where r.deleted_at is null
     order by (r.status = 'open') desc, r.opened_on desc, r.created_at desc, r.id`.execute(trx);
  return rows;
}

const PART_SELECT = sql`
  select p.id, p.access_review_id, r.review_no, r.status as review_status, r.due_on::text as due_on, p.management_system_id,
         ms.slug as ms, ms.code as ms_code, p.status, p.signed_off_by, p.signed_off_at, p.evidence_id, e.evidence_code, p.evidence_filed_at,
         su.handle as signed_handle, su.display_name as signed_name
    from access_review_part p
    join access_review r on r.id = p.access_review_id
    left join management_system ms on ms.id = p.management_system_id
    left join evidence e on e.id = p.evidence_id
    left join platform.app_user su on su.id = p.signed_off_by`;

/** The parts of reviews (the organisation part first, then the systems in their order). */
export async function partRows(trx: Trx, filter: { reviewIds?: readonly string[]; msId?: string; partId?: string }, options: { forUpdate?: boolean } = {}): Promise<PartRow[]> {
  const where = [sql`p.deleted_at is null`, sql`r.deleted_at is null`];
  if (filter.reviewIds) {
    if (filter.reviewIds.length === 0) return [];
    where.push(sql`p.access_review_id = any(${[...filter.reviewIds]}::uuid[])`);
  }
  if (filter.msId) where.push(sql`p.management_system_id = ${filter.msId}`);
  if (filter.partId) where.push(sql`p.id = ${filter.partId}`);
  const lock = options.forUpdate ? sql`for update of p` : sql``;
  const { rows } = await sql<PartRow>`
    ${PART_SELECT}
     where ${sql.join(where, sql` and `)}
     order by r.opened_on desc, r.created_at desc, (p.management_system_id is null) desc, ms.position nulls first, ms.code
     ${lock}`.execute(trx);
  return rows;
}

const ITEM_SELECT = sql`
  select i.id, i.access_review_id, i.access_review_part_id, p.management_system_id as part_ms_id, ms.slug as ms, ms.code as ms_code,
         i.subject_user_id, i.item_kind, i.ref, i.role, i.granted_by, i.granted_at, i.valid_until::text as valid_until, i.last_sign_in_at,
         i.decision, i.decision_note, i.decided_by, i.decided_at, i.applied_at, i.applied_by, i.applied_action, i.not_applied_reason,
         su.handle as subject_handle, su.email as subject_email, su.display_name as subject_name,
         coalesce(m.status = 'invited', false) as subject_invited,
         gu.handle as granted_handle, gu.display_name as granted_name, du.handle as decided_handle, du.display_name as decided_name,
         au.handle as applied_handle, au.display_name as applied_name,
         ru.handle as requested_handle, ru.display_name as requested_name, pu.handle as approved_handle, pu.display_name as approved_name
    from access_review_item i
    join access_review_part p on p.id = i.access_review_part_id
    left join management_system ms on ms.id = p.management_system_id
    join platform.app_user su on su.id = i.subject_user_id
    left join platform.org_membership m on m.user_id = i.subject_user_id and m.organization_id = i.organization_id and m.deleted_at is null
    left join platform.app_user gu on gu.id = i.granted_by
    left join platform.app_user du on du.id = i.decided_by
    left join platform.app_user au on au.id = i.applied_by
    left join platform.app_user ru on ru.id = (i.ref->>'requestedBy')::uuid
    left join platform.app_user pu on pu.id = (i.ref->>'approvedBy')::uuid`;

const ITEM_ORDER = sql`
  order by (p.management_system_id is null) desc, ms.position nulls first, ms.code,
           array_position(array['membership', 'admin_role', 'linked_sign_in', 'business_role', 'auditor_access']::text[], i.item_kind::text),
           lower(su.display_name), su.handle, i.role nulls first, i.id`;

/** The items of parts or of a review, in screen order. */
export async function itemRows(trx: Trx, filter: { partIds?: readonly string[]; reviewId?: string; pendingApplication?: boolean }): Promise<ItemRow[]> {
  const where = [sql`i.deleted_at is null`];
  if (filter.partIds) {
    if (filter.partIds.length === 0) return [];
    where.push(sql`i.access_review_part_id = any(${[...filter.partIds]}::uuid[])`);
  }
  if (filter.reviewId) where.push(sql`i.access_review_id = ${filter.reviewId}`);
  if (filter.pendingApplication) where.push(sql`i.decision in ('revoke', 'change') and i.applied_at is null and i.not_applied_reason is null`);
  const { rows } = await sql<ItemRow>`${ITEM_SELECT} where ${sql.join(where, sql` and `)} ${ITEM_ORDER}`.execute(trx);
  return rows;
}

/** One item of a review, locked for the change (404 when it is not an item of that review). */
export async function lockedItem(trx: Trx, reviewId: string, itemId: string): Promise<ItemRow> {
  await sql`select id from access_review_item where id = ${itemId} and access_review_id = ${reviewId} and deleted_at is null for update`.execute(trx);
  const { rows } = await sql<ItemRow>`${ITEM_SELECT} where i.id = ${itemId} and i.access_review_id = ${reviewId} and i.deleted_at is null`.execute(trx);
  const row = rows[0];
  if (!row) throw new NotFoundError('No such item in this access review');
  return row;
}

/**
 * The people who may decide the items of each part now: active Tenant Admins (key `org`), and per system id the active
 * Management System Managers and Programme Owners (no guest accounts).
 */
export async function reviewersOf(trx: Trx, orgId: string): Promise<Reviewers> {
  const out = new Map<string, Set<string>>();
  const { rows: admins } = await sql<{ user_id: string }>`
    select m.user_id from platform.org_membership m join platform.app_user u on u.id = m.user_id
     where m.organization_id = ${orgId} and m.status = 'active' and m.deleted_at is null and u.status = 'active' and u.deleted_at is null
       and u.kind = 'person' and 'tenant_admin' = any(m.admin_roles)`.execute(trx);
  out.set(ORG_KEY, new Set(admins.map((r) => r.user_id)));
  const { rows: deciders } = await sql<{ management_system_id: string; user_id: string }>`
    select distinct r.management_system_id, r.user_id
      from user_ms_role r
      join platform.app_user u on u.id = r.user_id
      join platform.org_membership m on m.user_id = r.user_id and m.organization_id = ${orgId}
     where r.role in ('ms_manager', 'programme_owner') and r.approval_status = 'active' and r.deleted_at is null
       and (r.valid_until is null or r.valid_until > now())
       and u.status = 'active' and u.deleted_at is null and u.kind = 'person' and m.status = 'active' and m.deleted_at is null`.execute(trx);
  for (const r of deciders) {
    const set = out.get(r.management_system_id) ?? new Set<string>();
    set.add(r.user_id);
    out.set(r.management_system_id, set);
  }
  return out;
}

/** The people who may decide the items of the part of system `msId` (null: the organisation part) now. */
export const decidersOf = (msId: string | null, reviewers: Reviewers): ReadonlySet<string> => reviewers.get(msId ?? ORG_KEY) ?? new Set<string>();

/**
 * True when an undecided item can be decided only by the person it concerns (see the file comment). False when nobody
 * may decide the part now: that part has no reviewer (`hasNoReviewer`), which holds up its sign-off.
 */
export function needsSecondReviewer(item: Pick<ItemRow, 'decision' | 'subject_user_id' | 'part_ms_id'>, reviewers: Reviewers): boolean {
  if (item.decision !== null) return false;
  const deciders = decidersOf(item.part_ms_id, reviewers);
  if (deciders.size === 0) return false;
  for (const id of deciders) if (id !== item.subject_user_id) return false;
  return true;
}

/** True while an open part of an open review has nobody who may decide its items now (see the file comment). */
export function hasNoReviewer(part: Pick<PartRow, 'review_status' | 'status' | 'management_system_id'>, reviewers: Reviewers): boolean {
  return part.review_status === 'open' && part.status === 'open' && decidersOf(part.management_system_id, reviewers).size === 0;
}

/** The person an item names: an invited member shows the email the organisation supplied (F.6), as People and roles. */
export function subjectOf(item: Pick<ItemRow, 'subject_handle' | 'subject_email' | 'subject_name' | 'subject_invited'>): { handle: string; displayName: string } {
  return item.subject_invited
    ? { handle: handleBase(item.subject_email), displayName: item.subject_email }
    : { handle: item.subject_handle, displayName: item.subject_name };
}

/** The API view of an item for the caller `callerId`. */
export function itemView(item: ItemRow, callerId: string, reviewers: Reviewers): AccessReviewItemView {
  return {
    id: item.id,
    kind: item.item_kind,
    subject: subjectOf(item),
    ms: item.ms,
    role: item.role,
    grantedBy: person(item.granted_handle, item.granted_name),
    grantedAt: iso(item.granted_at),
    requestedBy: person(item.requested_handle, item.requested_name),
    approvedBy: person(item.approved_handle, item.approved_name),
    validUntil: item.valid_until,
    lastSignInAt: iso(item.last_sign_in_at),
    decision: item.decision,
    decisionNote: item.decision_note,
    decidedBy: person(item.decided_handle, item.decided_name),
    decidedAt: iso(item.decided_at),
    appliedAt: iso(item.applied_at),
    appliedBy: person(item.applied_handle, item.applied_name),
    appliedAction: item.applied_action,
    appliedNote: item.ref.appliedNote ?? null,
    notAppliedReason: item.not_applied_reason,
    ownAccess: item.subject_user_id === callerId,
    pendingApproval: item.ref.approvalStatus === 'pending_approval',
    needsSecondReviewer: needsSecondReviewer(item, reviewers),
  };
}

/** The API summary of a part, with its item counts. */
export function partSummary(part: PartRow, items: readonly ItemRow[], reviewers: Reviewers): AccessReviewPartSummary {
  const own = items.filter((i) => i.access_review_part_id === part.id);
  return {
    id: part.id,
    reviewId: part.access_review_id,
    reviewNo: part.review_no,
    reviewStatus: part.review_status,
    ms: part.ms,
    status: part.status,
    dueOn: part.due_on,
    items: own.length,
    decided: own.filter((i) => i.decision !== null).length,
    needsSecondReviewer: own.filter((i) => needsSecondReviewer(i, reviewers)).length,
    noReviewer: hasNoReviewer(part, reviewers),
    signedOffBy: person(part.signed_handle, part.signed_name),
    signedOffAt: iso(part.signed_off_at),
    evidenceId: part.evidence_id,
    evidenceCode: part.evidence_code,
    evidenceFiledAt: iso(part.evidence_filed_at),
  };
}

/** Progress of reviews from their counts. */
export async function progressOf(trx: Trx, reviewIds: readonly string[]): Promise<Map<string, AccessReviewProgress>> {
  const out = new Map<string, AccessReviewProgress>();
  if (reviewIds.length === 0) return out;
  const { rows } = await sql<{ id: string; items: number; decided: number; revocations: number; applied: number; parts: number; signed_off: number }>`
    select r.id,
           (select count(*)::int from access_review_item i where i.access_review_id = r.id and i.deleted_at is null) as items,
           (select count(*)::int from access_review_item i where i.access_review_id = r.id and i.deleted_at is null and i.decision is not null) as decided,
           (select count(*)::int from access_review_item i where i.access_review_id = r.id and i.deleted_at is null and i.decision in ('revoke', 'change')) as revocations,
           (select count(*)::int from access_review_item i where i.access_review_id = r.id and i.deleted_at is null and i.decision in ('revoke', 'change')
              and (i.applied_at is not null or i.not_applied_reason is not null)) as applied,
           (select count(*)::int from access_review_part p where p.access_review_id = r.id and p.deleted_at is null) as parts,
           (select count(*)::int from access_review_part p where p.access_review_id = r.id and p.deleted_at is null and p.status = 'signed_off') as signed_off
      from access_review r where r.id = any(${[...reviewIds]}::uuid[])`.execute(trx);
  for (const r of rows) out.set(r.id, { items: r.items, decided: r.decided, revocations: r.revocations, applied: r.applied, parts: r.parts, signedOff: r.signed_off });
  return out;
}

const EMPTY_PROGRESS: AccessReviewProgress = { items: 0, decided: 0, revocations: 0, applied: 0, parts: 0, signedOff: 0 };

/** The API summary of a review. */
export function reviewSummary(row: ReviewRow, progress: AccessReviewProgress | undefined): AccessReviewSummary {
  return {
    id: row.id,
    reviewNo: row.review_no,
    status: row.status,
    openedOn: row.opened_on,
    dueOn: row.due_on,
    openedBy: person(row.opened_handle, row.opened_name),
    completedAt: iso(row.completed_at),
    completedBy: person(row.completed_handle, row.completed_name),
    cancelReason: row.cancel_reason,
    progress: progress ?? EMPTY_PROGRESS,
  };
}

/** An instant as the organisation's local date (`valid_until` of a role or guest grant). */
export const dayOf = (instant: Date | null, timeZone: string): string | null => (instant ? localDate(new Date(instant), timeZone) : null);
