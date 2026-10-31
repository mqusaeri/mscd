// Retention and disposal review of a system (Milestone 3 D.8, D.1, J.8, M3-06): the routes of `retention.ts`.
//
// - Rules: the period in force per record class (and per document type for document versions), the system's own row
//   of `retention_rule` marked `set`, else 36 months marked `default` (H.8), as the freshness limits of M2-07 list them.
//   Setting upserts the row; a null period resets it (soft delete). Audited `retention_rule.changed`.
// - Reviews: the daily job `retention.review` opens them (retention-review.service.ts). A manager decides keep (until
//   a date), extend (by months) or dispose; a disposal is refused under a hold (RET-HOLD), before the period ends
//   under the rule in force (RET-NOT-DUE), for a current version or file (RET-CURRENT) and while the record has open
//   dependants (`records.open_dependants`), and waits for a second person (`disposal_approval_pending`). The approver
//   may not be the proposer (SOD-SELF-APPROVE); approval runs the disposal at once (retention-disposal.ts); a
//   rejection sends the review back to `open` with a note.
// - Holds keep an item whatever its period says until released with a reason; an open review of a held item leaves
//   the review list.
// - The register lists the decided reviews (kept, extended, disposed) and downloads as formula-safe CSV (F.15). Its
//   period is the one in force when the review was decided (or, for a disposal, approved): `retention_review` has no
//   column for it (J.7), so `retention_review.decided` and `retention_review.approved` carry `retainMonths` in their
//   after data and the register reads the latest of them; a later rule change does not rewrite the evidence. Reviews
//   decided before that entry existed fall back to the rule in force today.
import { Inject, Injectable } from '@nestjs/common';
import type {
  CommandResult, Pair, RetentionDecide, RetentionHoldCreate, RetentionHoldItem, RetentionRecordClass, RetentionRegisterItem,
  RetentionReviewItem, RetentionReviewListQuery, RetentionRuleItem, RetentionRulePut,
} from '@mscd/shared';
import { sql } from 'kysely';
import { erasedJoin, shownHandle, shownName } from '../privacy/pseudonym';
import { Clock } from '../../common/clock';
import { ConflictError, NotFoundError, ProblemError, BusinessRuleError, ValidationError } from '../../common/problems';
import { toSafeCsv } from '../../common/spreadsheet-safe';
import {
  AUDIT_WRITER, NOTIFICATION_WRITER, RECORD_RESOLVER, type AuditWriter, type MsRef, type NotificationWriter, type Principal,
  type RecordResolver, type TenantInfo, type Trx,
} from '../../common/tokens';
import { commandResult, orgOf } from '../registers/command-support';
import { ruleMessageKey, ruleMessages } from '../rules';
import { TenantScope, tenantContextOf } from '../tenancy/tenant-scope';
import { RetentionDisposal, type DisposalProgress } from './retention-disposal';
import { itemFactsById, itemIdByCode, openDependants, type ItemFacts } from './retention-items';
import { DEFAULT_RETAIN_MONTHS, RECORD_CLASSES, addMonths, laterOf, monthsFor, ruleKey } from './retention-model';

/** A review row with the people who decided and approved it. */
interface ReviewRow {
  id: string;
  management_system_id: string;
  record_class: RetentionRecordClass;
  item_id: string;
  item_code: string | null;
  item_title: string | null;
  retention_ends_on: string;
  status: RetentionReviewItem['status'];
  decision: RetentionReviewItem['decision'];
  decided_by: string | null;
  decided_at: Date | null;
  reason: string | null;
  keep_until: string | null;
  approved_by: string | null;
  approved_at: Date | null;
  rejected_note: string | null;
  disposed_at: Date | null;
  file_action: RetentionReviewItem['fileAction'];
  file_removed_by: string | null;
  file_removed_at: Date | null;
  decided_handle: string | null;
  decided_name: string | null;
  approved_handle: string | null;
  approved_name: string | null;
  on_hold: boolean;
  doc_type: string | null;
  /** The period in force at the decision or approval (register only), from the audit entry; null when not recorded. */
  decided_months: number | null;
  total: string;
}

interface HoldRow {
  id: string;
  record_class: RetentionRecordClass;
  item_id: string;
  reason: string;
  set_by: string | null;
  set_at: Date;
  released_by: string | null;
  released_at: Date | null;
  release_reason: string | null;
  set_handle: string | null;
  set_name: string | null;
  released_handle: string | null;
  released_name: string | null;
}

export interface Page<T> {
  items: T[];
  page: number;
  pageSize: number;
  total: number;
}

const iso = (d: Date | null): string | null => (d ? new Date(d).toISOString() : null);
const person = (handle: string | null, name: string | null) => (handle ? { handle, displayName: name ?? handle } : null);

/** The rule codes and texts of a refused item (422 `business-rule`). */
function refusal(rule: 'RET-HOLD' | 'RET-NOT-DUE' | 'RET-CURRENT' | 'SOD-SELF-APPROVE', item: string | null, date?: string): BusinessRuleError {
  const vars: Record<string, string> = {};
  if (item) vars.item = item;
  if (date) vars.date = date;
  return new BusinessRuleError(rule, ruleMessages(rule, vars), undefined, { messageKey: ruleMessageKey(rule), ...(item ? { affected: [item] } : {}) });
}

@Injectable()
export class RetentionService {
  constructor(
    private readonly tenancy: TenantScope,
    private readonly clock: Clock,
    private readonly disposal: RetentionDisposal,
    @Inject(RECORD_RESOLVER) private readonly records: RecordResolver,
    @Inject(AUDIT_WRITER) private readonly audit: AuditWriter,
    @Inject(NOTIFICATION_WRITER) private readonly notifications: NotificationWriter,
  ) {}

  // -------------------------------------------------------------------------------------------------------------
  // Rules: GET and PUT /ms/{ms}/retention/rules
  // -------------------------------------------------------------------------------------------------------------

  async rules(principal: Principal, ms: string): Promise<RetentionRuleItem[]> {
    return this.tenancy.withTenant(tenantContextOf(principal), async (trx) => {
      const system = await this.records.resolveMs(trx, ms);
      const docTypes = await this.docTypes(trx, system.id);
      const stored = await this.storedRules(trx, system.id, false);
      const out: RetentionRuleItem[] = [];
      for (const recordClass of RECORD_CLASSES) {
        if (recordClass !== 'document_version') {
          const own = stored.find((r) => r.record_class === recordClass);
          out.push({ recordClass, docType: null, docTypeLabel: null, retainMonths: own?.retain_months ?? DEFAULT_RETAIN_MONTHS, source: own ? 'set' : 'default', basis: own?.basis ?? null });
          continue;
        }
        const codes = [...docTypes.map((d) => d.code), ...stored.filter((r) => r.record_class === 'document_version' && r.doc_type && !docTypes.some((d) => d.code === r.doc_type)).map((r) => r.doc_type!)];
        for (const code of codes) {
          const own = stored.find((r) => r.record_class === 'document_version' && r.doc_type === code);
          const label = docTypes.find((d) => d.code === code);
          out.push({
            recordClass, docType: code, docTypeLabel: label ? [label.label_en, label.label_id] : [code, code],
            retainMonths: own?.retain_months ?? DEFAULT_RETAIN_MONTHS, source: own ? 'set' : 'default', basis: own?.basis ?? null,
          });
        }
      }
      return out;
    });
  }

  async putRule(principal: Principal, ms: string, recordClass: RetentionRecordClass, body: RetentionRulePut): Promise<CommandResult> {
    const actor = principal.user.id;
    return this.tenancy.withTenant(tenantContextOf(principal), async (trx) => {
      const system = await this.records.resolveMs(trx, ms);
      const docType = body.docType ?? null;
      if (recordClass === 'document_version' && !docType) {
        throw new ValidationError([{ path: 'body.docType', message: 'Name the document type of the document versions' }]);
      }
      if (recordClass !== 'document_version' && docType) {
        throw new ValidationError([{ path: 'body.docType', message: 'Only document versions take a document type' }]);
      }
      if (docType && !(await this.docTypes(trx, system.id)).some((d) => d.code === docType)) {
        throw new NotFoundError(`Document type ${docType} is not defined by the edition in use`);
      }
      const stored = await this.storedRules(trx, system.id, true);
      const own = stored.find((r) => r.record_class === recordClass && (r.doc_type ?? null) === docType) ?? null;
      const before = { recordClass, docType, retainMonths: own?.retain_months ?? DEFAULT_RETAIN_MONTHS, source: own ? 'set' : 'default', basis: own?.basis ?? null };
      let entityId = own?.id ?? null;
      let after: Record<string, unknown>;
      if (body.retainMonths === null) {
        if (!own) return commandResult([system.slug], { message: ['Nothing to change', 'Tidak ada yang diubah'] });
        await sql`update retention_rule set deleted_at = now(), updated_at = now(), updated_by = ${actor} where id = ${own.id}`.execute(trx);
        after = { recordClass, docType, retainMonths: DEFAULT_RETAIN_MONTHS, source: 'default', basis: body.basis };
      } else {
        if (own && own.retain_months === body.retainMonths && own.basis === body.basis) {
          return commandResult([system.slug], { message: ['Nothing to change', 'Tidak ada yang diubah'] });
        }
        const { rows } = await sql<{ id: string }>`
          insert into retention_rule (management_system_id, record_class, doc_type, retain_months, basis, created_by, updated_by)
          values (${system.id}, ${recordClass}, ${docType}, ${body.retainMonths}, ${body.basis}, ${actor}, ${actor})
          on conflict (management_system_id, record_class, coalesce(doc_type, '')) where deleted_at is null
          do update set retain_months = excluded.retain_months, basis = excluded.basis, updated_at = now(), updated_by = excluded.updated_by
          returning id`.execute(trx);
        entityId = rows[0]?.id ?? entityId;
        after = { recordClass, docType, retainMonths: body.retainMonths, source: 'set', basis: body.basis };
      }
      await this.audit.record(trx, {
        action: 'retention_rule.changed',
        msId: system.id,
        entityType: 'retention_rule',
        entityId,
        entityCode: (docType ? `${recordClass}:${docType}` : recordClass).slice(0, 80),
        before,
        after,
      });
      return commandResult([system.slug], { data: after });
    });
  }

  // -------------------------------------------------------------------------------------------------------------
  // Reviews: GET /ms/{ms}/retention/reviews, POST .../decide, .../approve, .../reject, .../file-removed
  // -------------------------------------------------------------------------------------------------------------

  async reviews(principal: Principal, ms: string, query: RetentionReviewListQuery): Promise<Page<RetentionReviewItem>> {
    return this.tenancy.withTenant(tenantContextOf(principal), async (trx) => {
      const system = await this.records.resolveMs(trx, ms);
      const rows = await this.reviewRows(trx, system.id, {
        status: query.status ? [query.status] : null,
        recordClass: query.recordClass ?? null,
        code: query.code ?? null,
        // D.8: a hold set on an item with an open review takes it out of the review list.
        hideHeldOpen: true,
        page: query.page,
        pageSize: query.pageSize,
        order: 'due',
      });
      return { items: rows.map((r) => this.reviewItem(r)), page: query.page, pageSize: query.pageSize, total: Number(rows[0]?.total ?? 0) };
    });
  }

  async decide(principal: Principal, ms: string, body: RetentionDecide): Promise<CommandResult> {
    const org = orgOf(principal);
    const actor = principal.user.id;
    const today = this.clock.todayIn(org.timeZone);
    if (body.decision === 'keep' && body.keepUntil! <= today) {
      throw new ValidationError([{ path: 'body.keepUntil', message: 'Keep until a date after today' }]);
    }
    return this.tenancy.withTenant(tenantContextOf(principal), async (trx) => {
      const system = await this.records.resolveMs(trx, ms);
      const ids = [...new Set(body.ids)];
      const reviews = await this.lockReviews(trx, system.id, ids);
      const items = await this.factsOfReviews(trx, org, today, reviews);
      const rules = await this.ruleMap(trx, system.id);
      const now = this.clock.now();
      for (const review of reviews) {
        if (review.status !== 'open') {
          throw new ConflictError(`${review.item_code ?? review.id} is not open for a decision`, { messageKey: 'retention.review_not_open' });
        }
        const item = items.get(review.id);
        const label = review.item_code ?? item?.code ?? null;
        let set: Record<string, unknown>;
        let status: 'kept' | 'extended' | 'awaiting_approval';
        if (body.decision === 'keep') {
          status = 'kept';
          set = { keep_until: body.keepUntil! };
        } else if (body.decision === 'extend') {
          const ends = addMonths(review.retention_ends_on, body.extendMonths!);
          if (ends <= today) {
            throw new ValidationError([{ path: 'body.extendMonths', message: `${label ?? 'The item'} would still end before today (${ends}); extend by more months` }]);
          }
          status = 'extended';
          set = { retention_ends_on: ends, keep_until: null };
        } else {
          if (!item) throw new NotFoundError(`The item of ${label ?? review.id} no longer exists`);
          await this.assertDisposable(trx, review, item, rules, today);
          status = 'awaiting_approval';
          set = { keep_until: null };
        }
        await trx
          .updateTable('retention_review')
          .set({
            ...set,
            status,
            decision: body.decision,
            decided_by: actor,
            decided_at: now,
            reason: body.reason,
            approved_by: null,
            approved_at: null,
            rejected_note: null,
            updated_at: now,
            updated_by: actor,
          })
          .where('id', '=', review.id)
          .execute();
        await this.audit.record(trx, {
          action: 'retention_review.decided',
          msId: system.id,
          entityType: 'retention_review',
          entityId: review.id,
          entityCode: label?.slice(0, 80) ?? null,
          before: { status: review.status, retentionEndsOn: review.retention_ends_on, keepUntil: review.keep_until },
          after: {
            status,
            decision: body.decision,
            reason: body.reason,
            recordClass: review.record_class,
            itemId: review.item_id,
            // The period in force at this decision, read back by the disposal register.
            retainMonths: monthsFor(rules, review.record_class, review.doc_type ?? item?.docType),
            ...(status === 'kept' ? { keepUntil: body.keepUntil } : {}),
            ...(status === 'extended' ? { retentionEndsOn: set.retention_ends_on, extendMonths: body.extendMonths } : {}),
          },
        });
      }
      if (body.decision === 'dispose') await this.notifyApprovers(trx, system, actor, reviews);
      const message: Pair =
        body.decision === 'dispose'
          ? [`${reviews.length} disposal(s) sent for approval`, `${reviews.length} pemusnahan dikirim untuk persetujuan`]
          : body.decision === 'keep'
            ? [`${reviews.length} item(s) kept until ${body.keepUntil}`, `${reviews.length} item disimpan sampai ${body.keepUntil}`]
            : [`${reviews.length} item(s) kept ${body.extendMonths} months longer`, `${reviews.length} item disimpan ${body.extendMonths} bulan lebih lama`];
      return commandResult([system.slug], { count: reviews.length, message });
    });
  }

  async approve(principal: Principal, ms: string, id: string): Promise<CommandResult> {
    const today = this.clock.todayIn(orgOf(principal).timeZone);
    // Vault deletes that succeeded: when the approval fails after one of them, those objects are marked disposed in a
    // transaction of their own (retention-disposal.ts), so no deleted content is left looking available.
    const progress: DisposalProgress = { input: null, vaultDeleted: [] };
    try {
      return await this.approveIn(principal, ms, id, today, progress);
    } catch (error) {
      if (progress.vaultDeleted.length > 0) {
        await this.tenancy.withTenant(tenantContextOf(principal), (trx) => this.disposal.markContentDeleted(trx, progress, error));
      }
      throw error;
    }
  }

  private async approveIn(principal: Principal, ms: string, id: string, today: string, progress: DisposalProgress): Promise<CommandResult> {
    const org = orgOf(principal);
    const actor = principal.user.id;
    return this.tenancy.withTenant(tenantContextOf(principal), async (trx) => {
      const system = await this.records.resolveMs(trx, ms);
      const [review] = await this.lockReviews(trx, system.id, [id]);
      if (review!.status !== 'awaiting_approval') {
        throw new ConflictError('This disposal does not wait for approval', { messageKey: 'retention.not_awaiting_approval' });
      }
      const label = review!.item_code;
      if (review!.decided_by === actor) throw refusal('SOD-SELF-APPROVE', label);
      const item = (await this.factsOfReviews(trx, org, today, [review!])).get(review!.id);
      if (!item) throw new NotFoundError(`The item of ${label ?? review!.id} no longer exists`);
      const rules = await this.ruleMap(trx, system.id);
      await this.assertDisposable(trx, review!, item, rules, today);
      const now = this.clock.now();
      const result = await this.disposal.dispose(trx, {
        orgId: org.id,
        msId: system.id,
        review: { id: review!.id, recordClass: review!.record_class, itemCode: label },
        item,
        actor,
        reason: review!.reason,
        today,
        now,
      }, progress);
      await trx
        .updateTable('retention_review')
        .set({ status: 'disposed', approved_by: actor, approved_at: now, disposed_at: now, file_action: result.fileAction, updated_at: now, updated_by: actor })
        .where('id', '=', review!.id)
        .execute();
      await this.audit.record(trx, {
        action: 'retention_review.approved',
        msId: system.id,
        entityType: 'retention_review',
        entityId: review!.id,
        entityCode: label?.slice(0, 80) ?? null,
        before: { status: 'awaiting_approval' },
        after: {
          status: 'disposed',
          recordClass: review!.record_class,
          itemId: review!.item_id,
          // The period in force when the disposal ran (the one RET-NOT-DUE checked), read back by the disposal register.
          retainMonths: monthsFor(rules, item.recordClass, item.docType),
          fileAction: result.fileAction,
          ...(result.recordDeleted ? { recordDeleted: true } : {}),
          ...(result.ownerTaskId ? { ownerTaskId: result.ownerTaskId } : {}),
        },
      });
      const message: Pair =
        result.fileAction === 'owner_asked'
          ? [`${label ?? 'The item'} disposed of. Its owner is asked to delete the file in the customer repository.`, `${label ?? 'Item'} dimusnahkan. Pemiliknya diminta menghapus berkas di repositori pelanggan.`]
          : [`${label ?? 'The item'} disposed of`, `${label ?? 'Item'} dimusnahkan`];
      return commandResult([system.slug], { message, data: { fileAction: result.fileAction, recordDeleted: result.recordDeleted, vaultObjects: result.vaultDeleted.length } });
    });
  }

  async reject(principal: Principal, ms: string, id: string, note: string): Promise<CommandResult> {
    const actor = principal.user.id;
    return this.tenancy.withTenant(tenantContextOf(principal), async (trx) => {
      const system = await this.records.resolveMs(trx, ms);
      const [review] = await this.lockReviews(trx, system.id, [id]);
      if (review!.status !== 'awaiting_approval') {
        throw new ConflictError('This disposal does not wait for approval', { messageKey: 'retention.not_awaiting_approval' });
      }
      const now = this.clock.now();
      // The proposal (proposer, date and reason) stays on the review until the next decision; the audit trail keeps every step.
      await trx
        .updateTable('retention_review')
        .set({ status: 'open', decision: null, rejected_note: note, updated_at: now, updated_by: actor })
        .where('id', '=', review!.id)
        .execute();
      await this.audit.record(trx, {
        action: 'retention_review.rejected',
        msId: system.id,
        entityType: 'retention_review',
        entityId: review!.id,
        entityCode: review!.item_code?.slice(0, 80) ?? null,
        before: { status: 'awaiting_approval', decision: 'dispose' },
        after: { status: 'open', decision: null, note },
      });
      return commandResult([system.slug], { message: [`Disposal of ${review!.item_code ?? 'the item'} sent back to review`, `Pemusnahan ${review!.item_code ?? 'item'} dikembalikan untuk ditinjau`] });
    });
  }

  async fileRemoved(principal: Principal, ms: string, id: string): Promise<CommandResult> {
    const actor = principal.user.id;
    return this.tenancy.withTenant(tenantContextOf(principal), async (trx) => {
      const system = await this.records.resolveMs(trx, ms);
      const [review] = await this.lockReviews(trx, system.id, [id]);
      if (review!.status !== 'disposed' || review!.file_action !== 'owner_asked' || review!.file_removed_at) {
        throw new ConflictError('No file of this disposal waits to be removed in the customer repository', { messageKey: 'retention.no_file_to_remove' });
      }
      const now = this.clock.now();
      await trx.updateTable('retention_review').set({ file_removed_by: actor, file_removed_at: now, updated_at: now, updated_by: actor }).where('id', '=', review!.id).execute();
      // The owner's task (retention-disposal.ts) is done.
      await trx
        .updateTable('task')
        .set({ status: 'done', closed_by: actor, closed_at: now, updated_at: now, updated_by: actor })
        .where('source_rule', '=', 'manual')
        .where('entity_type', '=', 'retention_review')
        .where('entity_id', '=', review!.id)
        .where('status', '=', 'open')
        .execute();
      await this.audit.record(trx, {
        action: 'retention_review.file_removed',
        msId: system.id,
        entityType: 'retention_review',
        entityId: review!.id,
        entityCode: review!.item_code?.slice(0, 80) ?? null,
        before: { fileRemoved: false },
        after: { fileRemoved: true, recordClass: review!.record_class, itemId: review!.item_id },
      });
      return commandResult([system.slug], { message: [`Removal of the file of ${review!.item_code ?? 'the item'} recorded`, `Penghapusan berkas ${review!.item_code ?? 'item'} dicatat`] });
    });
  }

  // -------------------------------------------------------------------------------------------------------------
  // Register: GET /ms/{ms}/retention/register (JSON page or CSV)
  // -------------------------------------------------------------------------------------------------------------

  async register(principal: Principal, ms: string, page: number, pageSize: number): Promise<Page<RetentionRegisterItem>> {
    return this.tenancy.withTenant(tenantContextOf(principal), async (trx) => {
      const system = await this.records.resolveMs(trx, ms);
      const rules = await this.ruleMap(trx, system.id);
      const rows = await this.reviewRows(trx, system.id, { status: ['kept', 'extended', 'disposed'], recordClass: null, code: null, hideHeldOpen: false, page, pageSize, order: 'decided' });
      return {
        items: rows.map((r) => ({ ...this.reviewShape(r), retainMonths: r.decided_months ?? monthsFor(rules, r.record_class, r.doc_type) })),
        page,
        pageSize,
        total: Number(rows[0]?.total ?? 0),
      };
    });
  }

  /** The whole register as formula-safe CSV (F.15), and the system's id for the download's audit entry. */
  async registerCsv(principal: Principal, ms: string): Promise<{ csv: string; msId: string; rows: number }> {
    return this.tenancy.withTenant(tenantContextOf(principal), async (trx) => {
      const system = await this.records.resolveMs(trx, ms);
      const rules = await this.ruleMap(trx, system.id);
      const rows = await this.reviewRows(trx, system.id, { status: ['kept', 'extended', 'disposed'], recordClass: null, code: null, hideHeldOpen: false, page: 1, pageSize: null, order: 'decided' });
      const header = [
        'item_code', 'item_title', 'record_class', 'retention_months', 'retention_ends_on', 'status', 'decision', 'reason', 'keep_until',
        'decided_by', 'decided_at', 'approved_by', 'approved_at', 'disposed_at', 'file_action', 'file_removed_at',
      ];
      const csv = toSafeCsv(
        rows.map((r) => [
          r.item_code, r.item_title, r.record_class, r.decided_months ?? monthsFor(rules, r.record_class, r.doc_type), r.retention_ends_on, r.status, r.decision, r.reason,
          r.keep_until, r.decided_name ?? r.decided_handle, iso(r.decided_at), r.approved_name ?? r.approved_handle, iso(r.approved_at), iso(r.disposed_at),
          r.file_action, iso(r.file_removed_at),
        ]),
        header,
      );
      return { csv, msId: system.id, rows: rows.length };
    });
  }

  // -------------------------------------------------------------------------------------------------------------
  // Holds: GET and POST /ms/{ms}/retention/holds, POST .../holds/{id}/release
  // -------------------------------------------------------------------------------------------------------------

  async holds(principal: Principal, ms: string): Promise<RetentionHoldItem[]> {
    const org = orgOf(principal);
    const today = this.clock.todayIn(org.timeZone);
    return this.tenancy.withTenant(tenantContextOf(principal), async (trx) => {
      const system = await this.records.resolveMs(trx, ms);
      const { rows } = await sql<HoldRow>`
        select h.id, h.record_class, h.item_id, h.reason, h.set_by, h.set_at, h.released_by, h.released_at, h.release_reason,
               ${shownHandle('su', 'se')} as set_handle, ${shownName('su', 'se')} as set_name, ${shownHandle('ru', 're')} as released_handle,
               ${shownName('ru', 're')} as released_name
          from retention_hold h
          left join platform.app_user su on su.id = h.set_by
          ${erasedJoin('se', 'h.set_by')}
          left join platform.app_user ru on ru.id = h.released_by
          ${erasedJoin('re', 'h.released_by')}
         where h.management_system_id = ${system.id} and h.deleted_at is null
         order by (h.released_at is null) desc, coalesce(h.released_at, h.set_at) desc, h.id`.execute(trx);
      const codes = new Map<string, string>();
      for (const recordClass of RECORD_CLASSES) {
        const ids = rows.filter((r) => r.record_class === recordClass).map((r) => r.item_id);
        if (ids.length === 0) continue;
        for (const [itemId, facts] of await itemFactsById(trx, recordClass, ids, { timeZone: org.timeZone, today })) codes.set(`${recordClass}:${itemId}`, facts.code);
      }
      return rows.map((h) => ({
        id: h.id,
        recordClass: h.record_class,
        itemId: h.item_id,
        itemCode: codes.get(`${h.record_class}:${h.item_id}`) ?? null,
        reason: h.reason,
        setBy: person(h.set_handle, h.set_name),
        setAt: new Date(h.set_at).toISOString(),
        releasedBy: person(h.released_handle, h.released_name),
        releasedAt: iso(h.released_at),
        releaseReason: h.release_reason,
      }));
    });
  }

  async createHold(principal: Principal, ms: string, body: RetentionHoldCreate): Promise<CommandResult> {
    const org = orgOf(principal);
    const actor = principal.user.id;
    const today = this.clock.todayIn(org.timeZone);
    return this.tenancy.withTenant(tenantContextOf(principal), async (trx) => {
      const system = await this.records.resolveMs(trx, ms);
      const itemId = body.itemId ?? (await itemIdByCode(trx, body.recordClass, system.id, body.itemCode!));
      const item = (await itemFactsById(trx, body.recordClass, [itemId], { timeZone: org.timeZone, today })).get(itemId);
      if (!item || item.msId !== system.id) throw new NotFoundError(`No ${body.recordClass.replace(/_/g, ' ')} with this id in this system`);
      const existing = await trx
        .selectFrom('retention_hold')
        .select('id')
        .where('record_class', '=', body.recordClass)
        .where('item_id', '=', itemId)
        .where('released_at', 'is', null)
        .where('deleted_at', 'is', null)
        .executeTakeFirst();
      if (existing) throw this.alreadyHeld(item.code);
      let row: { id: string };
      try {
        row = await trx
          .insertInto('retention_hold')
          .values({ management_system_id: system.id, record_class: body.recordClass, item_id: itemId, reason: body.reason, set_by: actor, created_by: actor, updated_by: actor })
          .returning('id')
          .executeTakeFirstOrThrow();
      } catch (error) {
        if ((error as { code?: string }).code === '23505') throw this.alreadyHeld(item.code);
        throw error;
      }
      await this.audit.record(trx, {
        action: 'retention_hold.created',
        msId: system.id,
        entityType: 'retention_hold',
        entityId: row.id,
        entityCode: item.code.slice(0, 80),
        after: { recordClass: body.recordClass, itemId, reason: body.reason },
      });
      return commandResult([system.slug], { message: [`${item.code} is on hold`, `${item.code} ditahan`], data: { holdId: row.id, itemId, itemCode: item.code } });
    });
  }

  async releaseHold(principal: Principal, ms: string, id: string, reason: string): Promise<CommandResult> {
    const actor = principal.user.id;
    return this.tenancy.withTenant(tenantContextOf(principal), async (trx) => {
      const system = await this.records.resolveMs(trx, ms);
      const hold = await trx
        .selectFrom('retention_hold')
        .select(['id', 'record_class', 'item_id', 'released_at'])
        .where('id', '=', id)
        .where('management_system_id', '=', system.id)
        .where('deleted_at', 'is', null)
        .forUpdate()
        .executeTakeFirst();
      if (!hold) throw new NotFoundError('No such hold in this system');
      if (hold.released_at) throw new ConflictError('This hold is already released', { messageKey: 'retention.hold_released' });
      const now = this.clock.now();
      await trx
        .updateTable('retention_hold')
        .set({ released_by: actor, released_at: now, release_reason: reason, updated_at: now, updated_by: actor })
        .where('id', '=', hold.id)
        .execute();
      await this.audit.record(trx, {
        action: 'retention_hold.released',
        msId: system.id,
        entityType: 'retention_hold',
        entityId: hold.id,
        before: { released: false },
        after: { released: true, reason, recordClass: hold.record_class, itemId: hold.item_id },
      });
      return commandResult([system.slug], { message: ['Hold released', 'Penahanan dilepas'] });
    });
  }

  // -------------------------------------------------------------------------------------------------------------
  // Shared steps
  // -------------------------------------------------------------------------------------------------------------

  private alreadyHeld(code: string): ConflictError {
    return new ConflictError(`${code} is already on hold`, {
      messageKey: 'retention.already_held',
      messages: { en: `${code} is already on hold.`, id: `${code} sudah ditahan.` },
    });
  }

  /**
   * D.8 dispose checks: RET-HOLD, RET-CURRENT, RET-NOT-DUE under the rule in force today (a longer period set after the
   * review opened moves the end), and the record's open dependants.
   */
  private async assertDisposable(trx: Trx, review: ReviewRow, item: ItemFacts, rules: ReadonlyMap<string, number>, today: string): Promise<void> {
    const label = review.item_code ?? item.code;
    const held = await trx
      .selectFrom('retention_hold')
      .select('id')
      .where('record_class', '=', review.record_class)
      .where('item_id', '=', review.item_id)
      .where('released_at', 'is', null)
      .where('deleted_at', 'is', null)
      .executeTakeFirst();
    if (held) throw refusal('RET-HOLD', label);
    if (item.current) throw refusal('RET-CURRENT', label);
    if (!item.startsOn) throw refusal('RET-NOT-DUE', label);
    const ends = laterOf(review.retention_ends_on, addMonths(item.startsOn, monthsFor(rules, item.recordClass, item.docType)))!;
    if (ends > today) throw refusal('RET-NOT-DUE', label, ends);
    const dependants = await openDependants(trx, item.recordClass, item.itemId);
    if (dependants.length > 0) {
      throw new ProblemError('business-rule', {
        messageKey: 'records.open_dependants',
        messages: {
          en: `${label} still has open dependent records: ${dependants.join(', ')}. Close or reassign them first.`,
          id: `${label} masih memiliki rekaman turunan yang terbuka: ${dependants.join(', ')}. Tutup atau alihkan terlebih dahulu.`,
        },
        detail: `${label} still has open dependent records: ${dependants.join(', ')}`,
        affected: dependants,
      });
    }
  }

  /** The `disposal_approval_pending` notice to the system's other managers and Programme Owners (J.4). */
  private async notifyApprovers(trx: Trx, system: MsRef, proposer: string, reviews: ReviewRow[]): Promise<void> {
    const { rows } = await sql<{ user_id: string }>`
      select distinct user_id from user_ms_role
       where management_system_id = ${system.id} and role in ('ms_manager', 'programme_owner') and approval_status = 'active'
         and deleted_at is null and (valid_until is null or valid_until > now()) and user_id <> ${proposer}
       order by user_id`.execute(trx);
    const n = reviews.length;
    const first = reviews[0]?.item_code ?? '';
    const name = (await trx.selectFrom('management_system').select('code').where('id', '=', system.id).executeTakeFirst())?.code ?? system.slug.toUpperCase();
    for (const r of rows) {
      await this.notifications.create(trx, {
        recipientUserId: r.user_id,
        kind: 'disposal_approval_pending',
        msId: system.id,
        title: n === 1
          ? { en: `Disposal of ${first} waits for your approval`, id: `Pemusnahan ${first} menunggu persetujuan Anda` }
          : { en: `${n} disposals wait for your approval`, id: `${n} pemusnahan menunggu persetujuan Anda` },
        body: {
          en: `A second person must approve before records of ${name} are disposed of. Open Retention and disposal, Awaiting approval.`,
          id: `Orang kedua harus menyetujui sebelum catatan ${name} dimusnahkan. Buka Retensi dan pemusnahan, Menunggu persetujuan.`,
        },
      });
    }
  }

  /** Reviews of the system by id, locked; 404 for an id that is not a review of this system. */
  private async lockReviews(trx: Trx, msId: string, ids: readonly string[]): Promise<ReviewRow[]> {
    const docTypeOf = this.docTypeOfReview();
    const { rows } = await sql<ReviewRow>`
      select r.*, null::varchar as decided_handle, null::varchar as decided_name, null::varchar as approved_handle, null::varchar as approved_name,
             false as on_hold, ${docTypeOf} as doc_type, null::int as decided_months, '0' as total
        from retention_review r
       where r.id = any(${[...ids]}::uuid[]) and r.management_system_id = ${msId} and r.deleted_at is null
       order by r.retention_ends_on, r.item_code, r.id
       for update of r`.execute(trx);
    if (rows.length !== new Set(ids).size) throw new NotFoundError('No such retention review in this system');
    return rows;
  }

  /** The facts of the items of reviews, by review id. */
  private async factsOfReviews(trx: Trx, org: TenantInfo, today: string, reviews: readonly ReviewRow[]): Promise<Map<string, ItemFacts>> {
    const out = new Map<string, ItemFacts>();
    for (const recordClass of RECORD_CLASSES) {
      const of = reviews.filter((r) => r.record_class === recordClass);
      if (of.length === 0) continue;
      const facts = await itemFactsById(trx, recordClass, of.map((r) => r.item_id), { timeZone: org.timeZone, today });
      for (const r of of) {
        const f = facts.get(r.item_id);
        if (f) out.set(r.id, f);
      }
    }
    return out;
  }

  /** Review rows of a system with people, hold flag and document type, paged (`pageSize` null: every row). */
  private async reviewRows(
    trx: Trx,
    msId: string,
    filter: {
      status: readonly string[] | null; recordClass: RetentionRecordClass | null; code: string | null; hideHeldOpen: boolean; page: number;
      pageSize: number | null; order: 'due' | 'decided';
    },
  ): Promise<ReviewRow[]> {
    const held = sql<boolean>`exists (select 1 from retention_hold h where h.record_class = r.record_class and h.item_id = r.item_id
                                        and h.released_at is null and h.deleted_at is null)`;
    const { rows } = await sql<ReviewRow>`
      select r.*, ${shownHandle('du', 'de')} as decided_handle, ${shownName('du', 'de')} as decided_name, ${shownHandle('au', 'ae')} as approved_handle,
             ${shownName('au', 'ae')} as approved_name,
             ${held} as on_hold,
             ${this.docTypeOfReview()} as doc_type,
             ${filter.order === 'decided'
               ? sql`(select (a.after_data->>'retainMonths')::int from audit_trail a
                       where a.entity_type = 'retention_review' and a.entity_id = r.id
                         and a.action in ('retention_review.decided', 'retention_review.approved')
                         and a.after_data->>'retainMonths' is not null
                       order by a.seq desc limit 1)`
               : sql`null::int`} as decided_months,
             count(*) over () as total
        from retention_review r
        left join platform.app_user du on du.id = r.decided_by
        ${erasedJoin('de', 'r.decided_by')}
        left join platform.app_user au on au.id = r.approved_by
        ${erasedJoin('ae', 'r.approved_by')}
       where r.management_system_id = ${msId} and r.deleted_at is null
         ${filter.status ? sql`and r.status = any(${[...filter.status]}::text[])` : sql``}
         ${filter.recordClass ? sql`and r.record_class = ${filter.recordClass}` : sql``}
         ${filter.code ? sql`and (r.item_code = ${filter.code} or r.item_code like ${`${filter.code.replace(/[\\%_]/g, (c) => `\\${c}`)} %`})` : sql``}
         ${filter.hideHeldOpen ? sql`and not (r.status = 'open' and ${held})` : sql``}
       order by ${filter.order === 'due'
         ? sql`r.retention_ends_on, r.item_code, r.id`
         : sql`coalesce(r.disposed_at, r.decided_at) desc nulls last, r.item_code, r.id`}
       ${filter.pageSize === null ? sql`` : sql`limit ${filter.pageSize} offset ${(filter.page - 1) * filter.pageSize}`}`.execute(trx);
    return rows;
  }

  /** The document type of a document version's review (null for the other classes). */
  private docTypeOfReview() {
    return sql<string | null>`case when r.record_class = 'document_version' then (select d.doc_type from document_version v join document d on d.id = v.document_id where v.id = r.item_id) end`;
  }

  private reviewShape(r: ReviewRow) {
    return {
      id: r.id,
      recordClass: r.record_class,
      itemId: r.item_id,
      itemCode: r.item_code,
      itemTitle: r.item_title,
      retentionEndsOn: r.retention_ends_on,
      status: r.status,
      decision: r.decision,
      decidedBy: person(r.decided_handle, r.decided_name),
      decidedAt: iso(r.decided_at),
      reason: r.reason,
      keepUntil: r.keep_until,
      approvedBy: person(r.approved_handle, r.approved_name),
      approvedAt: iso(r.approved_at),
      rejectedNote: r.rejected_note,
      disposedAt: iso(r.disposed_at),
      fileAction: r.file_action,
      fileRemovedAt: iso(r.file_removed_at),
    };
  }

  private reviewItem(r: ReviewRow): RetentionReviewItem {
    return { ...this.reviewShape(r), onHold: r.on_hold };
  }

  /** Document types of the system's edition (pack lookup `doc_type`), in pack order. */
  private async docTypes(trx: Trx, msId: string): Promise<{ code: string; label_en: string; label_id: string }[]> {
    const { rows } = await sql<{ code: string; label_en: string; label_id: string }>`
      select lv.code, lv.label_en, lv.label_id from ref.lookup_value lv join management_system m on m.framework_version_id = lv.framework_version_id
       where m.id = ${msId} and lv.domain = 'doc_type' order by lv.sort_order, lv.code`.execute(trx);
    return rows;
  }

  private async storedRules(trx: Trx, msId: string, lock: boolean) {
    const { rows } = await sql<{ id: string; record_class: RetentionRecordClass; doc_type: string | null; retain_months: number; basis: string | null }>`
      select id, record_class, doc_type, retain_months, basis from retention_rule
       where management_system_id = ${msId} and deleted_at is null ${lock ? sql`for update` : sql``}`.execute(trx);
    return rows;
  }

  /** The system's set periods by rule key (the default applies to every other key). */
  private async ruleMap(trx: Trx, msId: string): Promise<Map<string, number>> {
    return new Map((await this.storedRules(trx, msId, false)).map((r) => [ruleKey(r.record_class, r.doc_type), r.retain_months]));
  }
}

