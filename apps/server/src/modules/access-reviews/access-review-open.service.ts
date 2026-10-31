// Opening an access review and the daily run of `access-review.open` (Milestone 3 D.9, J.3, J.4, M3-07).
//
// - Settings: one row per organisation (how often, the next due date, the days to complete; H.9: every 3 months, 14
//   days). An organisation without a row gets one at its first daily run, with the first review due one period later,
//   so every organisation reviews access on the schedule without any setup.
// - Opening (by the schedule on the due date, or by a Tenant Admin at once; one open review at a time): the review
//   number `AR-<year>-<nn>`, the organisation part and one part per system that is not archived, the snapshot
//   (access-review-snapshot.ts), one stored task per system part (source `access_review`, entity `access_review_part`)
//   for the system's primary Management System Manager (C.3: one open task per record), and the notice
//   `access_review_due` to the Tenant Admins and to the reviewers of each system part. The next due date moves on by
//   the frequency: from the due date when the schedule opened it (past every date already gone), from today when a
//   Tenant Admin did.
// - Reminders of an open review: `access_review_due` three days before the due date, and `access_review_overdue` on
//   the day after it and every 7 days after that, to the reviewers whose part is not signed off yet (and to the Tenant
//   Admins while the organisation part or a revocation waits). The dates sent are kept in `access_review.summary`, so a
//   repeated run of a day sends nothing twice.
import { Inject, Injectable } from '@nestjs/common';
import { sql } from 'kysely';
import { Clock } from '../../common/clock';
import { addDays, diffDays } from '../../common/dates';
import { ConflictError } from '../../common/problems';
import { AUDIT_WRITER, NOTIFICATION_WRITER, SYSTEM_USER_ID, type AuditWriter, type NotificationWriter, type TenantInfo, type Trx } from '../../common/tokens';
import { ORG_KEY, reviewersOf, type ReviewSummaryData } from './access-review-data';
import { takeSnapshot } from './access-review-snapshot';
import {
  REFUSALS, dueSoonNotice, openedNoticeForAdmins, openedNoticeForSystem, overdueNotice, taskTitle, type Notice,
} from './access-review-text';

export const DEFAULT_FREQUENCY_MONTHS = 3;
export const DEFAULT_DAYS_TO_COMPLETE = 14;
/** The reminder before the due date goes this many days ahead of it. */
export const DUE_SOON_DAYS = 3;
/** The overdue notice repeats every this many days. */
export const OVERDUE_EVERY_DAYS = 7;

export interface SettingsRow {
  id: string;
  frequency_months: 1 | 3 | 6 | 12;
  next_due_on: string | null;
  days_to_complete: number;
  version: number;
  updated_at: Date;
}

export interface OpenedReview {
  id: string;
  reviewNo: string;
  openedOn: string;
  dueOn: string;
  parts: number;
  items: number;
}

export interface DailyResult {
  initialised: boolean;
  opened: OpenedReview | null;
  dueSoonSent: number;
  overdueSent: number;
}

/** `iso` plus whole months (the day kept, or moved back to the last day of a shorter month). */
export function addMonths(iso: string, months: number): string {
  const [y, m, d] = iso.slice(0, 10).split('-').map(Number) as [number, number, number];
  const total = y * 12 + (m - 1) + months;
  const year = Math.floor(total / 12);
  const month = total - year * 12;
  const last = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
  return `${String(year).padStart(4, '0')}-${String(month + 1).padStart(2, '0')}-${String(Math.min(d, last)).padStart(2, '0')}`;
}

const reviewRef = (id: string, reviewNo: string) => ({ module: 'admin' as const, entityType: 'access_review', id, code: reviewNo });

@Injectable()
export class AccessReviewOpenService {
  constructor(
    private readonly clock: Clock,
    @Inject(AUDIT_WRITER) private readonly audit: AuditWriter,
    @Inject(NOTIFICATION_WRITER) private readonly notifications: NotificationWriter,
  ) {}

  /** The settings row, locked when asked; null when the organisation has none yet. */
  async settings(trx: Trx, options: { forUpdate?: boolean } = {}): Promise<SettingsRow | null> {
    const lock = options.forUpdate ? sql`for update` : sql``;
    const { rows } = await sql<SettingsRow>`
      select id, frequency_months, next_due_on::text as next_due_on, days_to_complete, version, updated_at
        from access_review_setting where deleted_at is null ${lock}`.execute(trx);
    return rows[0] ?? null;
  }

  /**
   * Opens a review now (`opener` null: the schedule). 409 `conflict` when one is open. Runs in the caller's tenant
   * transaction.
   */
  async open(trx: Trx, org: Pick<TenantInfo, 'id' | 'timeZone'>, today: string, opener: string | null): Promise<OpenedReview> {
    const actor = opener ?? SYSTEM_USER_ID;
    let settings = await this.settings(trx, { forUpdate: true });
    if (!settings) settings = await this.insertSettings(trx, null, actor);
    const open = await sql<{ id: string }>`select id from access_review where status = 'open' and deleted_at is null for update`.execute(trx);
    if (open.rows.length > 0) throw new ConflictError('An access review is already open', { messages: REFUSALS.openExists });

    const year = today.slice(0, 4);
    const { rows: numbered } = await sql<{ n: number }>`
      select count(*)::int as n from access_review where review_no like ${`AR-${year}-%`}`.execute(trx);
    const reviewNo = `AR-${year}-${String((numbered[0]?.n ?? 0) + 1).padStart(2, '0')}`;
    const dueOn = addDays(today, settings.days_to_complete);
    const review = await trx
      .insertInto('access_review')
      .values({ review_no: reviewNo, status: 'open', opened_on: today, due_on: dueOn, opened_by: opener, created_by: actor, updated_by: actor })
      .returning('id')
      .executeTakeFirstOrThrow();

    const orgPart = await trx
      .insertInto('access_review_part')
      .values({ access_review_id: review.id, management_system_id: null, created_by: actor, updated_by: actor })
      .returning('id')
      .executeTakeFirstOrThrow();
    const systems = await trx
      .selectFrom('management_system')
      .select(['id', 'slug', 'code'])
      .where('deleted_at', 'is', null)
      .where('status', '<>', 'archived')
      .orderBy('position')
      .orderBy('code')
      .execute();
    const systemParts = new Map<string, string>();
    for (const system of systems) {
      const part = await trx
        .insertInto('access_review_part')
        .values({ access_review_id: review.id, management_system_id: system.id, created_by: actor, updated_by: actor })
        .returning('id')
        .executeTakeFirstOrThrow();
      systemParts.set(system.id, part.id);
    }
    const counts = await takeSnapshot(trx, { orgId: org.id, timeZone: org.timeZone, reviewId: review.id, orgPartId: orgPart.id, systemParts, now: this.clock.now(), actorId: actor });
    const items = [...counts.values()].reduce((a, b) => a + b, 0);

    // One stored task per system part, for the system's primary Management System Manager (else its first one).
    const title = (code: string) => taskTitle(reviewNo, code);
    for (const system of systems) {
      const owner = await this.taskOwner(trx, system.id);
      const t = title(system.code);
      await trx
        .insertInto('task')
        .values({
          management_system_id: system.id,
          source_rule: 'access_review',
          entity_type: 'access_review_part',
          entity_id: systemParts.get(system.id)!,
          entity_code: reviewNo,
          title_en: t.en,
          title_id: t.id,
          owner_user_id: owner,
          due_at: dueOn,
          status: 'open',
          created_by: actor,
          updated_by: actor,
        })
        .execute();
    }

    // The next due date moves on by the frequency.
    let next = settings.next_due_on;
    if (opener || !next) next = addMonths(today, settings.frequency_months);
    else while (next <= today) next = addMonths(next, settings.frequency_months);
    await sql`update access_review_setting set next_due_on = ${next}::date, version = version + 1, updated_at = now(), updated_by = ${actor}
               where id = ${settings.id}`.execute(trx);

    await this.audit.record(trx, {
      action: 'access_review.opened',
      actor: opener ? { userId: opener, kind: 'user' } : { userId: SYSTEM_USER_ID, kind: 'system' },
      entityType: 'access_review',
      entityId: review.id,
      entityCode: reviewNo,
      after: { reviewNo, openedOn: today, dueOn, openedBy: opener ? 'tenant_admin' : 'schedule', parts: systems.length + 1, items, nextDueOn: next },
    });
    await this.noticeOnOpen(trx, org.id, { id: review.id, reviewNo, dueOn }, systems, actor);
    return { id: review.id, reviewNo, openedOn: today, dueOn, parts: systems.length + 1, items };
  }

  /** The daily run for an organisation on its local date `today`, in its transaction as the system user. */
  async daily(trx: Trx, org: Pick<TenantInfo, 'id' | 'timeZone'>, today: string): Promise<DailyResult> {
    const result: DailyResult = { initialised: false, opened: null, dueSoonSent: 0, overdueSent: 0 };
    let settings = await this.settings(trx, { forUpdate: true });
    if (!settings) {
      settings = await this.insertSettings(trx, addMonths(today, DEFAULT_FREQUENCY_MONTHS), SYSTEM_USER_ID);
      result.initialised = true;
    }
    const { rows } = await sql<{ id: string; review_no: string; opened_on: string; due_on: string; summary: ReviewSummaryData | null }>`
      select id, review_no, opened_on::text as opened_on, due_on::text as due_on, summary
        from access_review where status = 'open' and deleted_at is null for update`.execute(trx);
    const open = rows[0];
    if (!open) {
      if (settings.next_due_on && settings.next_due_on <= today) result.opened = await this.open(trx, org, today, null);
      return result;
    }
    const sent = open.summary?.reminders ?? {};
    const reminders = { ...sent };
    if (today > open.due_on) {
      if (!sent.overdueOn || diffDays(sent.overdueOn, today) >= OVERDUE_EVERY_DAYS) {
        result.overdueSent = await this.remind(trx, org.id, open, 'access_review_overdue');
        reminders.overdueOn = today;
      }
    } else if (!sent.dueSoonOn && today >= addDays(open.due_on, -DUE_SOON_DAYS) && addDays(open.due_on, -DUE_SOON_DAYS) > open.opened_on) {
      result.dueSoonSent = await this.remind(trx, org.id, open, 'access_review_due');
      reminders.dueSoonOn = today;
    }
    if (reminders.overdueOn !== sent.overdueOn || reminders.dueSoonOn !== sent.dueSoonOn) {
      const summary: ReviewSummaryData = { ...(open.summary ?? {}), reminders };
      await sql`update access_review set summary = ${JSON.stringify(summary)}::jsonb, updated_at = now(), updated_by = ${SYSTEM_USER_ID} where id = ${open.id}`.execute(trx);
    }
    return result;
  }

  /** A settings row with the defaults of H.9. */
  async insertSettings(trx: Trx, nextDueOn: string | null, actor: string): Promise<SettingsRow> {
    await trx
      .insertInto('access_review_setting')
      .values({ frequency_months: DEFAULT_FREQUENCY_MONTHS, next_due_on: nextDueOn, days_to_complete: DEFAULT_DAYS_TO_COMPLETE, created_by: actor, updated_by: actor })
      .onConflict((oc) => oc.column('organization_id').doNothing())
      .execute();
    return (await this.settings(trx, { forUpdate: true }))!;
  }

  /** The primary Management System Manager of a system, else its first one, else nobody (an unassigned task). */
  private async taskOwner(trx: Trx, msId: string): Promise<string | null> {
    const { rows } = await sql<{ user_id: string }>`
      select r.user_id from user_ms_role r
        join platform.org_membership m on m.user_id = r.user_id and m.organization_id = r.organization_id
       where r.management_system_id = ${msId} and r.role = 'ms_manager' and r.approval_status = 'active' and r.deleted_at is null
         and (r.valid_until is null or r.valid_until > now()) and m.status = 'active' and m.deleted_at is null
       order by r.is_primary desc, r.created_at, r.user_id
       limit 1`.execute(trx);
    return rows[0]?.user_id ?? null;
  }

  private async noticeOnOpen(
    trx: Trx,
    orgId: string,
    review: { id: string; reviewNo: string; dueOn: string },
    systems: readonly { id: string; code: string }[],
    actor: string,
  ): Promise<void> {
    const reviewers = await reviewersOf(trx, orgId);
    const ref = reviewRef(review.id, review.reviewNo);
    await this.send(trx, reviewers.get(ORG_KEY) ?? new Set(), 'access_review_due', openedNoticeForAdmins(review.reviewNo, review.dueOn), null, ref, actor);
    for (const system of systems) {
      await this.send(trx, reviewers.get(system.id) ?? new Set(), 'access_review_due', openedNoticeForSystem(review.reviewNo, system.code, review.dueOn), system.id, ref, actor);
    }
  }

  /** A reminder to the reviewers of every part that still waits; returns how many notices were written. */
  private async remind(
    trx: Trx,
    orgId: string,
    review: { id: string; review_no: string; due_on: string },
    kind: 'access_review_due' | 'access_review_overdue',
  ): Promise<number> {
    const reviewers = await reviewersOf(trx, orgId);
    const ref = reviewRef(review.id, review.review_no);
    const notice = (code: string | null) => (kind === 'access_review_due' ? dueSoonNotice(review.review_no, review.due_on, code) : overdueNotice(review.review_no, review.due_on, code));
    const { rows: parts } = await sql<{ management_system_id: string | null; code: string | null; status: string; waiting: number }>`
      select p.management_system_id, ms.code, p.status,
             (select count(*)::int from access_review_item i where i.access_review_id = p.access_review_id and i.deleted_at is null
                 and i.decision in ('revoke', 'change') and i.applied_at is null and i.not_applied_reason is null) as waiting
        from access_review_part p left join management_system ms on ms.id = p.management_system_id
       where p.access_review_id = ${review.id} and p.deleted_at is null
       order by (p.management_system_id is null) desc, ms.position, ms.code`.execute(trx);
    let sent = 0;
    for (const part of parts) {
      if (part.management_system_id === null) {
        // The organisation part waits until the review completes; the Tenant Admins also apply the revocations.
        sent += await this.send(trx, reviewers.get(ORG_KEY) ?? new Set(), kind, notice(null), null, ref, SYSTEM_USER_ID);
      } else if (part.status === 'open') {
        sent += await this.send(trx, reviewers.get(part.management_system_id) ?? new Set(), kind, notice(part.code), part.management_system_id, ref, SYSTEM_USER_ID);
      }
    }
    return sent;
  }

  private async send(
    trx: Trx,
    recipients: ReadonlySet<string>,
    kind: 'access_review_due' | 'access_review_overdue',
    notice: Notice,
    msId: string | null,
    ref: { module: 'admin'; entityType: string; id: string; code: string },
    actor: string,
  ): Promise<number> {
    let sent = 0;
    for (const userId of [...recipients].sort()) {
      const id = await this.notifications.create(trx, { recipientUserId: userId, kind, title: notice.title, body: notice.body, msId, ref, createdBy: actor });
      if (id) sent += 1;
    }
    return sent;
  }
}
