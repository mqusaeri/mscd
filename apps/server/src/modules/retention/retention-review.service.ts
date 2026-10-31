// The daily retention review of an organisation (Milestone 3 D.8, J.3, M3-06), run by the `retention.review` job in the
// organisation's transaction as the system user:
//
// 1. `replaced_at` of older replaced evidence files: M3-06 sets it when a file is replaced (file-commands.service.ts);
//    files replaced before that get it from the `evidence.file_uploaded` and `evidence.file_linked` audit entries
//    (`before.storageObjectId`, the time of the first entry that replaced them). Idempotent, so every run may do it.
// 2. Every item of every record class whose period ended (start plus the system's period, 36 months by default) gets a
//    `retention_review` in `open`, unless the item is under a hold, its review waits for a decision or approval, it was
//    disposed of, or a "keep until" date or an extended end lies ahead. An item kept or extended earlier opens again as a
//    new review on that date, so the register keeps every decision (the earlier review stays `kept` or `extended`).
// 3. The Management System Managers of each system with new reviews get the digest notice `retention_review_due` (J.4).
import { Inject, Injectable } from '@nestjs/common';
import type { RetentionRecordClass } from '@mscd/shared';
import { sql } from 'kysely';
import { NOTIFICATION_WRITER, SYSTEM_USER_ID, type NotificationWriter, type TenantInfo, type Trx } from '../../common/tokens';
import { itemsOf } from './retention-items';
import { RECORD_CLASSES, addMonths, laterOf, monthsFor, ruleKey } from './retention-model';

export interface RetentionReviewResult {
  /** Older replaced evidence files that got `replaced_at` from the audit trail. */
  backfilled: number;
  /** Reviews opened by this run. */
  opened: number;
  /** Reviews opened per system slug. */
  bySystem: Record<string, number>;
}

interface LatestReview {
  status: 'open' | 'kept' | 'extended' | 'awaiting_approval' | 'disposed';
  keep_until: string | null;
  retention_ends_on: string;
}

@Injectable()
export class RetentionReviewService {
  constructor(@Inject(NOTIFICATION_WRITER) private readonly notifications: NotificationWriter) {}

  async run(trx: Trx, org: Pick<TenantInfo, 'id' | 'timeZone'>, today: string): Promise<RetentionReviewResult> {
    const backfilled = await this.backfillReplacedAt(trx);
    const systems = await trx.selectFrom('management_system').select(['id', 'slug', 'code']).where('deleted_at', 'is', null).execute();
    const systemIds = new Set(systems.map((s) => s.id));
    const rules = await this.rules(trx);
    const holds = await this.activeHolds(trx);
    const latest = await this.latestReviews(trx);
    const opened = new Map<string, number>();

    for (const recordClass of RECORD_CLASSES) {
      const items = await itemsOf(trx, recordClass, { kind: 'discover' }, { timeZone: org.timeZone, today });
      for (const item of items) {
        if (!item.msId || !systemIds.has(item.msId) || !item.startsOn) continue;
        const key = `${recordClass}:${item.itemId}`;
        if (holds.has(key)) continue;
        const ends = addMonths(item.startsOn, monthsFor(rules.get(item.msId) ?? new Map(), recordClass, item.docType));
        const last = latest.get(key);
        let due = ends;
        if (last) {
          if (last.status === 'open' || last.status === 'awaiting_approval' || last.status === 'disposed') continue;
          due = laterOf(ends, last.status === 'kept' ? last.keep_until : last.retention_ends_on)!;
        }
        if (due > today) continue;
        if (await this.open(trx, item.msId, recordClass, item.itemId, item.code, item.title, due)) {
          opened.set(item.msId, (opened.get(item.msId) ?? 0) + 1);
        }
      }
    }

    const bySystem: Record<string, number> = {};
    for (const system of systems) {
      const n = opened.get(system.id) ?? 0;
      if (n === 0) continue;
      bySystem[system.slug] = n;
      await this.notifyManagers(trx, system, n);
    }
    return { backfilled, opened: [...opened.values()].reduce((a, b) => a + b, 0), bySystem };
  }

  /** `replaced_at` of replaced evidence files that do not have it yet, from the evidence file audit entries. */
  private async backfillReplacedAt(trx: Trx): Promise<number> {
    const { rows } = await sql<{ id: string }>`
      update storage_object o set replaced_at = src.at
        from (select distinct on (obj) nullif(a.before_data->>'storageObjectId', '')::uuid as obj, a.occurred_at as at
                from audit_trail a
               where a.action in ('evidence.file_uploaded', 'evidence.file_linked') and a.entity_type = 'evidence'
                 and nullif(a.before_data->>'storageObjectId', '') is not null
                 and (a.before_data->>'storageObjectId') is distinct from (a.after_data->>'storageObjectId')
               order by obj, a.seq) src
       where o.id = src.obj and o.replaced_at is null
         and not exists (select 1 from evidence e where e.storage_object_id = o.id and e.deleted_at is null)
      returning o.id`.execute(trx);
    return rows.length;
  }

  /** Set periods of every system: system id to (rule key to months). */
  private async rules(trx: Trx): Promise<Map<string, Map<string, number>>> {
    const { rows } = await sql<{ management_system_id: string; record_class: RetentionRecordClass; doc_type: string | null; retain_months: number }>`
      select management_system_id, record_class, doc_type, retain_months from retention_rule where deleted_at is null`.execute(trx);
    const out = new Map<string, Map<string, number>>();
    for (const r of rows) {
      const of = out.get(r.management_system_id) ?? new Map<string, number>();
      of.set(ruleKey(r.record_class, r.doc_type), r.retain_months);
      out.set(r.management_system_id, of);
    }
    return out;
  }

  private async activeHolds(trx: Trx): Promise<Set<string>> {
    const { rows } = await sql<{ record_class: string; item_id: string }>`
      select record_class, item_id from retention_hold where released_at is null and deleted_at is null`.execute(trx);
    return new Set(rows.map((r) => `${r.record_class}:${r.item_id}`));
  }

  /** The latest review of every item that has one (a review waiting for a decision or approval comes first). */
  private async latestReviews(trx: Trx): Promise<Map<string, LatestReview>> {
    const { rows } = await sql<LatestReview & { record_class: string; item_id: string }>`
      select distinct on (record_class, item_id) record_class, item_id, status, keep_until, retention_ends_on
        from retention_review where deleted_at is null
       order by record_class, item_id, (status in ('open', 'awaiting_approval')) desc, (status = 'disposed') desc, created_at desc, id desc`.execute(trx);
    return new Map(rows.map((r) => [`${r.record_class}:${r.item_id}`, r]));
  }

  /** Opens a review; false when one already waits (another run of the same day). */
  private async open(trx: Trx, msId: string, recordClass: RetentionRecordClass, itemId: string, code: string, title: string | null, endsOn: string): Promise<boolean> {
    const { rows } = await sql<{ id: string }>`
      insert into retention_review (management_system_id, record_class, item_id, item_code, item_title, retention_ends_on, status, created_by, updated_by)
      values (${msId}, ${recordClass}, ${itemId}, ${code.slice(0, 60)}, ${title ? title.slice(0, 300) : null}, ${endsOn}::date, 'open', ${SYSTEM_USER_ID}, ${SYSTEM_USER_ID})
      on conflict (record_class, item_id) where status in ('open', 'awaiting_approval') do nothing
      returning id`.execute(trx);
    return rows.length > 0;
  }

  /** The digest notice `retention_review_due` to the system's Management System Managers (J.4). */
  private async notifyManagers(trx: Trx, system: { id: string; code: string }, n: number): Promise<void> {
    const { rows } = await sql<{ user_id: string }>`
      select distinct user_id from user_ms_role
       where management_system_id = ${system.id} and role = 'ms_manager' and approval_status = 'active'
         and deleted_at is null and (valid_until is null or valid_until > now())
       order by user_id`.execute(trx);
    for (const r of rows) {
      await this.notifications.create(trx, {
        recipientUserId: r.user_id,
        kind: 'retention_review_due',
        msId: system.id,
        digest: true,
        createdBy: SYSTEM_USER_ID,
        title: n === 1
          ? { en: `1 record of ${system.code} is due for a retention review`, id: `1 catatan ${system.code} jatuh tempo untuk tinjauan retensi` }
          : { en: `${n} records of ${system.code} are due for a retention review`, id: `${n} catatan ${system.code} jatuh tempo untuk tinjauan retensi` },
        body: {
          en: 'Their retention period ended. Decide to keep, extend or dispose of each in Retention and disposal, Due for review.',
          id: 'Masa retensinya telah berakhir. Putuskan untuk menyimpan, memperpanjang, atau memusnahkan masing-masing di Retensi dan pemusnahan, Jatuh tempo tinjauan.',
        },
      });
    }
  }
}
