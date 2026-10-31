// Shared pieces of the privacy module (Milestone 3 D.6): the stored request row and its API forms, the record refs, the
// refusals, the people a request involves (the active Tenant Admins, the primary Management System Manager of each
// system) and the pseudonym of an erased person ("Former user" and 4 to 8 hex characters, D.6.5, which
// `platform.redact_audit_rows` accepts as a replacement, `REDACTION_PSEUDONYM`).
import { randomBytes } from 'node:crypto';
import type { MyPrivacyRequestItem, PrivacyRequestItem, PrivacyRequestStatus, PrivacyRequestType, PrivacySubjectView, RecordRef } from '@mscd/shared';
import { sql } from 'kysely';
import { etagOf } from '../../common/etag';
import { ConflictError, NotFoundError, ProblemError } from '../../common/problems';
import type { Principal, TenantInfo, Trx } from '../../common/tokens';
import { erasedJoin, shownHandle, shownName } from './pseudonym';
import { REFUSALS, type Refusal } from './privacy-text';

/** A stored `privacy_request` row with the names of the people who handled it. */
export interface RequestRow {
  id: string;
  request_no: string;
  request_type: PrivacyRequestType;
  status: PrivacyRequestStatus;
  subject_kind: 'member' | 'other';
  subject_user_id: string | null;
  subject_name: string | null;
  subject_email: string | null;
  subject_handle: string | null;
  channel: 'self_service' | 'email' | 'letter' | 'provider' | 'other';
  received_at: Date;
  due_at: Date;
  identity_check_note: string | null;
  identity_checked_by: string | null;
  handled_by: string | null;
  closed_at: Date | null;
  outcome: string | null;
  result: Record<string, number> | null;
  updated_at: Date;
  created_at: Date;
  handled_handle: string | null;
  handled_name: string | null;
  checked_handle: string | null;
  checked_name: string | null;
  note: string | null;
}

/** Statuses of a request that is still being answered (J.8). */
export const OPEN_STATUSES: readonly PrivacyRequestStatus[] = ['received', 'in_progress'];

/** True while a request is being answered. */
export function isOpen(status: PrivacyRequestStatus): boolean {
  return OPEN_STATUSES.includes(status);
}

const iso = (value: Date | string | null): string | null => (value === null ? null : new Date(value).toISOString());

/**
 * A person as the API names them; for a person erased in this organisation the handle form of the pseudonym and the
 * pseudonym itself (`pseudonym.ts`).
 */
export function personOf(handle: string | null, name: string | null): { handle: string; displayName: string } | null {
  return handle ? { handle, displayName: name ?? handle } : null;
}

/** The person of a request as entered (the request keeps the name as proof that it was answered, D.6.5). */
export function subjectOf(row: RequestRow): PrivacySubjectView {
  return {
    kind: row.subject_kind,
    userId: row.subject_user_id,
    handle: row.subject_kind === 'member' ? row.subject_handle : null,
    name: row.subject_name ?? row.subject_handle ?? '',
    email: row.subject_email,
  };
}

/** The list item of a request row; `now` decides `overdue`. */
export function requestItem(row: RequestRow, now: Date): PrivacyRequestItem {
  return {
    id: row.id,
    requestNo: row.request_no,
    type: row.request_type,
    status: row.status,
    subject: subjectOf(row),
    channel: row.channel,
    receivedAt: new Date(row.received_at).toISOString(),
    dueAt: new Date(row.due_at).toISOString(),
    closedAt: iso(row.closed_at),
    handledBy: personOf(row.handled_handle, row.handled_name),
    overdue: isOpen(row.status) && new Date(row.due_at).getTime() < now.getTime(),
    etag: etagOf(row.updated_at),
  };
}

/** The "My account" item of one of the caller's own requests. */
export function myRequestItem(row: Pick<RequestRow, 'id' | 'request_no' | 'request_type' | 'status' | 'received_at' | 'due_at' | 'closed_at'>): MyPrivacyRequestItem {
  return {
    id: row.id,
    requestNo: row.request_no,
    type: row.request_type,
    status: row.status,
    receivedAt: new Date(row.received_at).toISOString(),
    dueAt: new Date(row.due_at).toISOString(),
    closedAt: iso(row.closed_at),
  };
}

/** The record ref of a request (command results and notifications). */
export function requestRef(id: string, code: string, updatedAt?: Date): RecordRef {
  return { module: 'admin', entityType: 'privacy_request', id, code, ...(updatedAt ? { etag: etagOf(updatedAt) } : {}) };
}

/** The record ref of a system check. */
export function checkRef(id: string, code: string): RecordRef {
  return { module: 'admin', entityType: 'privacy_check', id, code };
}

/** 422 `business-rule` with a message key and both texts. */
export function refusal(entry: Refusal): ProblemError {
  return new ProblemError('business-rule', { messageKey: entry.key, messages: { en: entry.en, id: entry.id }, detail: entry.en });
}

/** 409 `conflict` with a message key and both texts. */
export function conflict(entry: Refusal): ConflictError {
  return new ConflictError(entry.en, { messageKey: entry.key, messages: { en: entry.en, id: entry.id } });
}

/** The current organisation of a session (every route of this area runs in one). */
export function orgOf(principal: Principal): TenantInfo {
  if (!principal.org) throw new NotFoundError(REFUSALS.noOrganisation.en);
  return principal.org;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** True for a uuid (path ids are checked before they reach a query). */
export function isUuid(value: string): boolean {
  return UUID.test(value);
}

/**
 * The request rows of the organisation, newest first (or one of them), with the names of the subject's account and of
 * the people who handled them. The subject's handle is the account's own, the pseudonym after an erasure.
 */
export async function requestRows(trx: Trx, filter: { id?: string; subjectUserId?: string; forUpdate?: boolean } = {}): Promise<RequestRow[]> {
  if (filter.id !== undefined && !isUuid(filter.id)) return [];
  if (filter.forUpdate && filter.id) await sql`select id from privacy_request where id = ${filter.id}::uuid and deleted_at is null for update`.execute(trx);
  const { rows } = await sql<RequestRow>`
    select r.id, r.request_no, r.request_type, r.status, r.subject_kind, r.subject_user_id, r.subject_name, r.subject_email,
           ${shownHandle('su', 'se')} as subject_handle, r.channel, r.received_at, r.due_at, r.identity_check_note,
           r.identity_checked_by, r.handled_by, r.closed_at, r.outcome, r.result, r.updated_at, r.created_at,
           ${shownHandle('hu', 'he')} as handled_handle, ${shownName('hu', 'he')} as handled_name,
           ${shownHandle('cu', 'ce')} as checked_handle, ${shownName('cu', 'ce')} as checked_name,
           null::text as note
      from privacy_request r
      left join platform.app_user su on su.id = r.subject_user_id
      ${erasedJoin('se', 'r.subject_user_id')}
      left join platform.app_user hu on hu.id = r.handled_by
      ${erasedJoin('he', 'r.handled_by')}
      left join platform.app_user cu on cu.id = r.identity_checked_by
      ${erasedJoin('ce', 'r.identity_checked_by')}
     where r.deleted_at is null
       and (${filter.id ?? null}::uuid is null or r.id = ${filter.id ?? null}::uuid)
       and (${filter.subjectUserId ?? null}::uuid is null or r.subject_user_id = ${filter.subjectUserId ?? null}::uuid)
     order by r.received_at desc, r.request_no desc`.execute(trx);
  return rows;
}

/** One request; 404 when the organisation has none with this id. */
export async function requestRow(trx: Trx, id: string, options: { forUpdate?: boolean } = {}): Promise<RequestRow> {
  const [row] = await requestRows(trx, { id, forUpdate: options.forUpdate });
  if (!row) throw new NotFoundError('No such personal data request');
  return row;
}

/** The next business number of the year: `PR-<year>-<nnn>` (three digits at least), under a transaction lock. */
export async function nextRequestNo(trx: Trx, year: string): Promise<string> {
  await sql`select pg_advisory_xact_lock(hashtext('privacy_request_no'))`.execute(trx);
  const { rows } = await sql<{ n: number }>`
    select coalesce(max(substring(request_no from 9)::int), 0)::int as n from privacy_request where request_no like ${`PR-${year}-%`}`.execute(trx);
  return `PR-${year}-${String((rows[0]?.n ?? 0) + 1).padStart(3, '0')}`;
}

/** Ids of the active Tenant Admins of the organisation (active account and membership). */
export async function activeTenantAdmins(trx: Trx, orgId: string): Promise<string[]> {
  const { rows } = await sql<{ user_id: string }>`
    select m.user_id from platform.org_membership m join platform.app_user u on u.id = m.user_id
     where m.organization_id = ${orgId}::uuid and m.status = 'active' and m.deleted_at is null
       and 'tenant_admin' = any(m.admin_roles) and u.status = 'active' and u.deleted_at is null
     order by u.handle`.execute(trx);
  return rows.map((r) => r.user_id);
}

/** The systems of the organisation (not deleted) with the primary Management System Manager of each, in system order. */
export async function systemsWithManager(trx: Trx): Promise<{ id: string; slug: string; manager: string | null }[]> {
  const { rows } = await sql<{ id: string; slug: string; manager: string | null }>`
    select m.id, m.slug,
           (select r.user_id from user_ms_role r
             where r.management_system_id = m.id and r.role = 'ms_manager' and r.is_primary and r.deleted_at is null
               and r.approval_status = 'active' and (r.valid_until is null or r.valid_until > now())
             order by r.created_at limit 1) as manager
      from management_system m
     where m.deleted_at is null
     order by m.position, m.slug`.execute(trx);
  return rows;
}

/** Length of the hex part of a new pseudonym; a clash moves to a longer one after a few draws. */
const PSEUDONYM_LENGTHS = [4, 4, 4, 6, 6, 8, 8, 8] as const;

/** A pseudonym of the form "Former user 7F3A" (D.6.5). */
export function newPseudonym(hexLength: 4 | 6 | 8 = 4): string {
  return `Former user ${randomBytes(4).toString('hex').slice(0, hexLength).toUpperCase()}`;
}

/** A pseudonym no erased person of the organisation holds yet (the unique index of `erased_person` holds the rule). */
export async function freePseudonym(trx: Trx): Promise<string> {
  for (const length of PSEUDONYM_LENGTHS) {
    const candidate = newPseudonym(length);
    const taken = await trx.selectFrom('erased_person').select('erased_user_id').where('pseudonym', '=', candidate).executeTakeFirst();
    if (!taken) return candidate;
  }
  throw new ConflictError('No free pseudonym; try again');
}

/** The pseudonym of a person erased in the organisation, or null. */
export async function pseudonymOf(trx: Trx, userId: string): Promise<string | null> {
  const row = await trx.selectFrom('erased_person').select('pseudonym').where('erased_user_id', '=', userId).where('deleted_at', 'is', null).executeTakeFirst();
  return row?.pseudonym ?? null;
}
