// The periodic access review (Milestone 3 D.1, D.9, J.8, M3-07): the routes of `access-reviews.ts` except applying a
// decision (access-review-apply.service.ts).
//
// - Settings with `If-Match` (an organisation without a row shows the defaults of H.9 with the ETag `W/"0"`).
// - Reviews: the list with progress, "Start review now" (access-review-open.service.ts), one review with the
//   organisation part, the status of every system part and the decided revocations still to apply, cancel with a
//   reason, and the report as CSV.
// - Decisions keep, change (with a note) or revoke on the organisation items (Tenant Admins) and on the items of a
//   system (its Management System Managers and Programme Owners). Nobody decides on their own access (REVIEW-OWN-ACCESS);
//   a decision is locked once its part is signed off or the decision applied.
// - Sign-off of a system part when every item is decided (an item only its own subject could decide stays "needs a
//   second reviewer", access-review-data.ts), naming the evidence item for its rows; for a system on ISO/IEC 27001 the
//   part proposes the evidence item whose targets include control A.5.18 (access rights).
// - Completion when every system part is signed off, every organisation item decided (same exception) and every
//   revocation or change applied or explained: the organisation part is signed off by the completer, the report CSV is
//   stored in the organisation's Managed Vault and each system's rows are filed as a new file of the evidence item named
//   at its sign-off (`FileCommandsService.fileGeneratedEvidence`, in this transaction). A failed filing refuses the
//   completion with its problem, so nothing is filed half; it can be completed again once the repository takes files.
import { Readable } from 'node:stream';
import { Inject, Injectable } from '@nestjs/common';
import type {
  AccessReviewCancel, AccessReviewDecide, AccessReviewDetail, AccessReviewPartDetail, AccessReviewPartSummary, AccessReviewSettings,
  AccessReviewSettingsPut, AccessReviewSignOff, AccessReviewSummary, CommandResult, Pair, PutResult, Warning,
} from '@mscd/shared';
import { sql } from 'kysely';
import { Clock } from '../../common/clock';
import { assertIfMatch, etagOf } from '../../common/etag';
import { BusinessRuleError, ConflictError, NotFoundError, ValidationError } from '../../common/problems';
import { toSafeCsv } from '../../common/spreadsheet-safe';
import {
  AUDIT_WRITER, GATEWAY_CLIENT, RECORD_RESOLVER, type AuditWriter, type GatewayClient, type Principal, type RecordResolver, type TenantInfo, type Trx,
} from '../../common/tokens';
import { FileCommandsService } from '../files/file-commands.service';
import { commandResult, orgOf } from '../registers/command-support';
import { ruleMessageKey, ruleMessages } from '../rules';
import { StorageGatewayContext } from '../storage/gateway-context';
import { TenantScope, tenantContextOf } from '../tenancy/tenant-scope';
import {
  hasNoReviewer, itemRows, itemView, lockedItem, needsSecondReviewer, partRows, partSummary, progressOf, reviewRow, reviewRows, reviewSummary,
  reviewersOf, subjectOf, type ItemRow, type PartRow, type ReviewRow, type ReviewSummaryData, type Reviewers,
} from './access-review-data';
import { AccessReviewOpenService, DEFAULT_DAYS_TO_COMPLETE, DEFAULT_FREQUENCY_MONTHS, type SettingsRow } from './access-review-open.service';
import { REFUSALS, REPORT_COLUMNS, noReviewerText, singleReviewerWarning } from './access-review-text';

/** The control whose evidence the sign-off of a system on ISO/IEC 27001 proposes (A.5.18 access rights). */
export const ACCESS_RIGHTS_CONTROL = 'A.5.18';

const iso = (d: Date | string | null): string | null => (d === null ? null : new Date(d).toISOString());

/** 422 `business-rule` REVIEW-OWN-ACCESS. */
function ownAccess(item: ItemRow): BusinessRuleError {
  return new BusinessRuleError('REVIEW-OWN-ACCESS', ruleMessages('REVIEW-OWN-ACCESS'), undefined, { messageKey: ruleMessageKey('REVIEW-OWN-ACCESS'), affected: [item.id] });
}

const conflict = (detail: string, messages: { en: string; id: string }) => new ConflictError(detail, { messages });

/** The settings of the API from a row (or the defaults of H.9). */
function settingsView(row: SettingsRow | null): AccessReviewSettings {
  if (!row) return { frequencyMonths: DEFAULT_FREQUENCY_MONTHS, nextDueOn: null, daysToComplete: DEFAULT_DAYS_TO_COMPLETE, etag: etagOf(0) };
  return { frequencyMonths: row.frequency_months, nextDueOn: row.next_due_on, daysToComplete: row.days_to_complete, etag: etagOf(row.updated_at) };
}

/** The warning REVIEW-SINGLE-ADMIN of items that only their own person could decide; empty when there are none. */
function secondReviewerWarnings(items: readonly ItemRow[], reviewers: Reviewers): Warning[] {
  const exempt = items.filter((i) => needsSecondReviewer(i, reviewers));
  if (!exempt.length) return [];
  return [singleReviewerWarning({
    organisation: exempt.some((i) => i.part_ms_id === null),
    systems: [...new Set(exempt.flatMap((i) => (i.part_ms_id === null ? [] : [i.ms_code ?? i.ms ?? ''])))],
    names: [...new Set(exempt.map((i) => subjectOf(i).displayName))].sort(),
  })];
}

@Injectable()
export class AccessReviewsService {
  constructor(
    private readonly tenancy: TenantScope,
    private readonly clock: Clock,
    private readonly opener: AccessReviewOpenService,
    private readonly files: FileCommandsService,
    private readonly storage: StorageGatewayContext,
    @Inject(GATEWAY_CLIENT) private readonly gateway: GatewayClient,
    @Inject(RECORD_RESOLVER) private readonly records: RecordResolver,
    @Inject(AUDIT_WRITER) private readonly audit: AuditWriter,
  ) {}

  // -------------------------------------------------------------------------------------------------------------
  // Settings
  // -------------------------------------------------------------------------------------------------------------

  async settings(principal: Principal): Promise<AccessReviewSettings> {
    return this.tenancy.withTenant(tenantContextOf(principal), async (trx) => settingsView(await this.opener.settings(trx)));
  }

  async putSettings(principal: Principal, body: AccessReviewSettingsPut, ifMatch: string | undefined): Promise<AccessReviewSettings> {
    const org = orgOf(principal);
    const actor = principal.user.id;
    return this.tenancy.withTenant(tenantContextOf(principal), async (trx) => {
      const today = this.clock.todayIn(org.timeZone);
      if (body.nextDueOn < today) throw new ValidationError([{ path: 'body.nextDueOn', message: 'The next due date is today or later' }]);
      const current = await this.opener.settings(trx, { forUpdate: true });
      assertIfMatch(ifMatch, current?.updated_at ?? 0);
      const before = settingsView(current);
      if (current && current.frequency_months === body.frequencyMonths && current.next_due_on === body.nextDueOn && current.days_to_complete === body.daysToComplete) {
        return before;
      }
      if (current) {
        await sql`update access_review_setting set frequency_months = ${body.frequencyMonths}, next_due_on = ${body.nextDueOn}::date,
                   days_to_complete = ${body.daysToComplete}, version = version + 1, updated_at = now(), updated_by = ${actor} where id = ${current.id}`.execute(trx);
      } else {
        await trx
          .insertInto('access_review_setting')
          .values({ frequency_months: body.frequencyMonths, next_due_on: body.nextDueOn, days_to_complete: body.daysToComplete, created_by: actor, updated_by: actor })
          .execute();
      }
      const after = (await this.opener.settings(trx))!;
      await this.audit.record(trx, {
        action: 'access_review.settings_changed',
        entityType: 'access_review_setting',
        entityId: after.id,
        entityCode: 'access_review_setting',
        before: { frequencyMonths: before.frequencyMonths, nextDueOn: before.nextDueOn, daysToComplete: before.daysToComplete },
        after: { frequencyMonths: body.frequencyMonths, nextDueOn: body.nextDueOn, daysToComplete: body.daysToComplete },
      });
      return settingsView(after);
    });
  }

  // -------------------------------------------------------------------------------------------------------------
  // Reviews of the organisation
  // -------------------------------------------------------------------------------------------------------------

  async list(principal: Principal): Promise<AccessReviewSummary[]> {
    return this.tenancy.withTenant(tenantContextOf(principal), async (trx) => {
      const rows = await reviewRows(trx);
      const progress = await progressOf(trx, rows.map((r) => r.id));
      return rows.map((r) => reviewSummary(r, progress.get(r.id)));
    });
  }

  async create(principal: Principal): Promise<CommandResult> {
    const org = orgOf(principal);
    return this.tenancy.withTenant(tenantContextOf(principal), async (trx) => {
      const opened = await this.opener.open(trx, org, this.clock.todayIn(org.timeZone), principal.user.id);
      return commandResult([], {
        count: opened.items,
        message: [`Access review ${opened.reviewNo} started with ${opened.items} item(s) to review`, `Tinjauan akses ${opened.reviewNo} dimulai dengan ${opened.items} item untuk ditinjau`],
        data: { id: opened.id, reviewNo: opened.reviewNo, dueOn: opened.dueOn },
      });
    });
  }

  async get(principal: Principal, id: string): Promise<AccessReviewDetail> {
    const org = orgOf(principal);
    return this.tenancy.withTenant(tenantContextOf(principal), async (trx) => {
      const review = await reviewRow(trx, id);
      const parts = await partRows(trx, { reviewIds: [id] });
      const items = await itemRows(trx, { reviewId: id });
      const reviewers = await reviewersOf(trx, org.id);
      const progress = await progressOf(trx, [id]);
      const orgPart = parts.find((p) => p.management_system_id === null);
      if (!orgPart) throw new NotFoundError('No such access review');
      const caller = principal.user.id;
      return {
        ...reviewSummary(review, progress.get(id)),
        organisationPart: {
          ...partSummary(orgPart, items, reviewers),
          rows: items.filter((i) => i.access_review_part_id === orgPart.id).map((i) => itemView(i, caller, reviewers)),
          suggestedEvidence: null,
        },
        parts: parts.filter((p) => p.management_system_id !== null).map((p) => partSummary(p, items, reviewers)),
        pendingApplications: items
          .filter((i) => (i.decision === 'revoke' || i.decision === 'change') && i.applied_at === null && i.not_applied_reason === null)
          .map((i) => itemView(i, caller, reviewers)),
        warnings: this.warningsOf(review, items, reviewers),
      };
    });
  }

  /** The stored warnings of a completed review, else the ones completing it now would give. */
  private warningsOf(review: ReviewRow, items: readonly ItemRow[], reviewers: Reviewers): Warning[] {
    if (review.status === 'completed') return [...(review.summary?.warnings ?? [])];
    if (review.status !== 'open') return [];
    return secondReviewerWarnings(items, reviewers);
  }

  async decide(principal: Principal, id: string, itemId: string, body: AccessReviewDecide): Promise<CommandResult> {
    return this.tenancy.withTenant(tenantContextOf(principal), async (trx) => {
      const review = await reviewRow(trx, id, { forUpdate: true });
      const item = await lockedItem(trx, id, itemId);
      if (item.part_ms_id !== null) throw new NotFoundError('No such organisation item in this access review');
      return this.recordDecision(trx, principal, review, item, body);
    });
  }

  async cancel(principal: Principal, id: string, body: AccessReviewCancel): Promise<CommandResult> {
    const actor = principal.user.id;
    return this.tenancy.withTenant(tenantContextOf(principal), async (trx) => {
      const review = await reviewRow(trx, id, { forUpdate: true });
      if (review.status !== 'open') throw conflict('The access review is not open', REFUSALS.notOpen);
      await sql`update access_review set status = 'cancelled', cancel_reason = ${body.reason}, updated_at = now(), updated_by = ${actor} where id = ${id}`.execute(trx);
      const closed = await this.closeTasks(trx, id, 'cancelled', actor);
      await this.audit.record(trx, {
        action: 'access_review.cancelled',
        entityType: 'access_review',
        entityId: id,
        entityCode: review.review_no,
        before: { status: 'open' },
        after: { status: 'cancelled', reason: body.reason, tasksCancelled: closed },
      });
      const systems = (await partRows(trx, { reviewIds: [id] })).flatMap((p) => (p.ms ? [p.ms] : []));
      return commandResult(systems, { message: [`Access review ${review.review_no} cancelled`, `Tinjauan akses ${review.review_no} dibatalkan`] });
    });
  }

  async complete(principal: Principal, id: string): Promise<CommandResult> {
    const org = orgOf(principal);
    const actor = principal.user.id;
    return this.tenancy.withTenant(tenantContextOf(principal), async (trx) => {
      const review = await reviewRow(trx, id, { forUpdate: true });
      if (review.status !== 'open') throw conflict('The access review is not open', REFUSALS.notOpen);
      const parts = await partRows(trx, { reviewIds: [id] }, { forUpdate: true });
      const items = await itemRows(trx, { reviewId: id });
      const reviewers = await reviewersOf(trx, org.id);
      this.assertCompletable(parts, items, reviewers);

      const now = this.clock.now();
      const orgPart = parts.find((p) => p.management_system_id === null)!;
      await sql`update access_review_part set status = 'signed_off', signed_off_by = ${actor}, signed_off_at = ${now}, updated_at = now(), updated_by = ${actor}
                 where id = ${orgPart.id} and status = 'open'`.execute(trx);

      // The report in the Managed Vault (null when the organisation has none; the report route still answers).
      const today = this.clock.todayIn(org.timeZone);
      const report = this.reportCsv(review, items, reviewers);
      const reportObjectId = await this.storeReport(trx, org, review, report, actor);

      // Each system's rows as a new file of the evidence item named at its sign-off.
      const filed: { ms: string; evidenceCode: string; storageObjectId: string }[] = [];
      for (const part of parts) {
        if (part.management_system_id === null || !part.evidence_id) continue;
        const rows = items.filter((i) => i.access_review_part_id === part.id);
        const result = await this.files.fileGeneratedEvidence(trx, { userId: actor, kind: 'user' }, {
          msId: part.management_system_id,
          evidenceId: part.evidence_id,
          fileName: `access-review-${review.review_no}-${part.ms}-${today}.csv`,
          mimeType: 'text/csv',
          bytes: Buffer.from(this.reportCsv(review, rows, reviewers), 'utf8'),
        });
        await sql`update access_review_part set evidence_filed_at = ${now}, updated_at = now(), updated_by = ${actor} where id = ${part.id}`.execute(trx);
        filed.push({ ms: part.ms!, evidenceCode: part.evidence_code ?? '', storageObjectId: result.storageObjectId });
      }

      const warnings = this.warningsOf(review, items, reviewers);
      const counted = (d: string) => items.filter((i) => i.decision === d).length;
      const summary: ReviewSummaryData = {
        ...(review.summary ?? {}),
        completed: {
          items: items.length,
          kept: counted('keep'),
          changed: counted('change'),
          revoked: counted('revoke'),
          applied: items.filter((i) => i.applied_at !== null).length,
          notApplied: items.filter((i) => i.not_applied_reason !== null).length,
          needsSecondReviewer: items.filter((i) => needsSecondReviewer(i, reviewers)).length,
          filed,
          reportStored: reportObjectId !== null,
        },
        warnings: warnings.map((w) => ({ rule: 'REVIEW-SINGLE-ADMIN' as const, messages: { en: w.messages.en, id: w.messages.id } })),
      };
      await sql`update access_review set status = 'completed', completed_at = ${now}, completed_by = ${actor}, summary = ${JSON.stringify(summary)}::jsonb,
                 report_object_id = ${reportObjectId}, updated_at = now(), updated_by = ${actor} where id = ${id}`.execute(trx);
      await this.audit.record(trx, {
        action: 'access_review.completed',
        entityType: 'access_review',
        entityId: id,
        entityCode: review.review_no,
        before: { status: 'open' },
        after: { status: 'completed', ...summary.completed, warnings: warnings.map((w) => w.rule) },
      });
      const systems = parts.flatMap((p) => (p.ms ? [p.ms] : []));
      const message: Pair = filed.length
        ? [`Access review ${review.review_no} completed; the rows of ${filed.length} system(s) were filed as evidence`, `Tinjauan akses ${review.review_no} selesai; baris dari ${filed.length} sistem diarsipkan sebagai bukti`]
        : [`Access review ${review.review_no} completed`, `Tinjauan akses ${review.review_no} selesai`];
      return commandResult(systems, { message, warnings, data: { filed: filed.map((f) => ({ ms: f.ms, evidenceCode: f.evidenceCode })), reportStored: reportObjectId !== null } });
    });
  }

  /** 409 `conflict` naming what still holds up the completion. */
  private assertCompletable(parts: readonly PartRow[], items: readonly ItemRow[], reviewers: Reviewers): void {
    const unsigned = parts.filter((p) => p.management_system_id !== null && p.status !== 'signed_off');
    const codeOf = (p: PartRow) => p.ms_code ?? p.ms ?? '';
    const noReviewer = unsigned.filter((p) => hasNoReviewer(p, reviewers)).map(codeOf);
    const openSystems = unsigned.filter((p) => !hasNoReviewer(p, reviewers)).map(codeOf);
    const orgPart = parts.find((p) => p.management_system_id === null);
    const undecided = items.filter((i) => i.access_review_part_id === orgPart?.id && i.decision === null && !needsSecondReviewer(i, reviewers)).length;
    const waiting = items.filter((i) => (i.decision === 'revoke' || i.decision === 'change') && i.applied_at === null && i.not_applied_reason === null).length;
    const en: string[] = [];
    const id: string[] = [];
    if (openSystems.length) {
      en.push(`not signed off yet: ${openSystems.join(', ')}`);
      id.push(`belum ditandatangani: ${openSystems.join(', ')}`);
    }
    for (const code of noReviewer) {
      const text = noReviewerText(code);
      en.push(text.en);
      id.push(text.id);
    }
    if (undecided) {
      en.push(`${undecided} organisation item(s) to decide`);
      id.push(`${undecided} item organisasi belum diputuskan`);
    }
    if (waiting) {
      en.push(`${waiting} revocation(s) or change(s) to apply or explain`);
      id.push(`${waiting} pencabutan atau perubahan belum diterapkan atau dijelaskan`);
    }
    if (en.length) {
      throw conflict('The access review cannot be completed yet', {
        en: `The review cannot be completed yet: ${en.join('; ')}.`,
        id: `Tinjauan belum dapat diselesaikan: ${id.join('; ')}.`,
      });
    }
  }

  /** The review (or some of its rows) as a formula-safe CSV (F.15). */
  reportCsv(review: ReviewRow, items: readonly ItemRow[], reviewers: Reviewers): string {
    const name = (handle: string | null, display: string | null) => (handle ? `${display ?? handle} (${handle})` : '');
    return toSafeCsv(
      items.map((i) => {
        const subject = subjectOf(i);
        return [
          review.review_no, review.opened_on, review.due_on, i.ms_code ?? '', i.item_kind, subject.displayName, subject.handle, i.role ?? '',
          i.ref.approvalStatus === 'pending_approval' ? 'yes' : 'no', name(i.granted_handle, i.granted_name), name(i.requested_handle, i.requested_name),
          name(i.approved_handle, i.approved_name), iso(i.granted_at) ?? '', i.valid_until ?? '',
          iso(i.last_sign_in_at) ?? '', i.decision ?? '', i.decision_note ?? '', name(i.decided_handle, i.decided_name), iso(i.decided_at) ?? '',
          needsSecondReviewer(i, reviewers) ? 'yes' : 'no', i.applied_action ?? '', i.ref.appliedNote ?? '', name(i.applied_handle, i.applied_name),
          iso(i.applied_at) ?? '', i.not_applied_reason ?? '',
        ];
      }),
      REPORT_COLUMNS,
    );
  }

  /** `GET .../report`: the CSV of the whole review, its file name and its row count. */
  async report(principal: Principal, id: string): Promise<{ csv: string; fileName: string; rows: number; reviewNo: string }> {
    const org = orgOf(principal);
    return this.tenancy.withTenant(tenantContextOf(principal), async (trx) => {
      const review = await reviewRow(trx, id);
      const items = await itemRows(trx, { reviewId: id });
      const reviewers = await reviewersOf(trx, org.id);
      return { csv: this.reportCsv(review, items, reviewers), fileName: `access-review-${review.review_no}-${org.slug}.csv`, rows: items.length, reviewNo: review.review_no };
    });
  }

  /** Stores the report in the organisation's first Managed Vault (`access-reviews/<review id>`); null without one. */
  private async storeReport(trx: Trx, org: TenantInfo, review: ReviewRow, csv: string, actor: string): Promise<string | null> {
    const repository = await trx
      .selectFrom('storage_repository')
      .selectAll()
      .where('adapter', '=', 'managed_vault')
      .where('deleted_at', 'is', null)
      .orderBy('position')
      .orderBy('slug')
      .executeTakeFirst();
    if (!repository) return null;
    const bytes = Buffer.from(csv, 'utf8');
    const fileName = `access-review-${review.review_no}.csv`;
    const header = {
      tenant: await this.storage.tenant(trx, org.id),
      repository: await this.storage.repository(trx, repository),
      scopeRoot: { folderId: null, path: '' },
      folderPath: `access-reviews/${review.id}`,
      fileName,
      maxBytes: Math.max(1, bytes.length),
      metadataMinimization: repository.metadata_minimization,
    };
    const r = await this.gateway.putObject<PutResult>(header, Readable.from([bytes]));
    const now = this.clock.now();
    const object = await trx
      .insertInto('storage_object')
      .values({
        storage_repository_id: repository.id,
        external_item_id: r.externalItemId,
        external_version_id: r.externalVersionId,
        version_label: r.versionLabel.slice(0, 30),
        display_name: fileName,
        mime_type: r.detectedMimeType.slice(0, 100),
        size_bytes: String(r.sizeBytes),
        hash_algorithm: 'sha256',
        hash_value: r.hashValue,
        hash_source: 'computed',
        provider_created_at: r.providerCreatedAt ? new Date(r.providerCreatedAt) : now,
        provider_modified_at: r.providerCreatedAt ? new Date(r.providerCreatedAt) : now,
        folder_path: r.folderPath,
        web_url: r.webUrl ?? null,
        encryption: r.encryption ? JSON.stringify(r.encryption) : null,
        link_status: 'intact',
        link_status_since: now,
        last_verified_at: now,
        last_good_check_at: now,
        created_by: actor,
        updated_by: actor,
      } as never)
      .returning('id')
      .executeTakeFirstOrThrow();
    return object.id;
  }

  // -------------------------------------------------------------------------------------------------------------
  // The parts of a system
  // -------------------------------------------------------------------------------------------------------------

  async msList(principal: Principal, ms: string): Promise<AccessReviewPartSummary[]> {
    const org = orgOf(principal);
    return this.tenancy.withTenant(tenantContextOf(principal), async (trx) => {
      const system = await this.records.resolveMs(trx, ms);
      const parts = await partRows(trx, { msId: system.id });
      const items = await itemRows(trx, { partIds: parts.map((p) => p.id) });
      const reviewers = await reviewersOf(trx, org.id);
      return parts
        .map((p) => partSummary(p, items, reviewers))
        .sort((a, b) => Number(b.reviewStatus === 'open') - Number(a.reviewStatus === 'open'));
    });
  }

  async msGet(principal: Principal, ms: string, id: string): Promise<AccessReviewPartDetail> {
    const org = orgOf(principal);
    return this.tenancy.withTenant(tenantContextOf(principal), async (trx) => {
      const system = await this.records.resolveMs(trx, ms);
      const part = await this.systemPart(trx, id, system.id);
      const items = await itemRows(trx, { partIds: [part.id] });
      const reviewers = await reviewersOf(trx, org.id);
      return {
        ...partSummary(part, items, reviewers),
        rows: items.map((i) => itemView(i, principal.user.id, reviewers)),
        suggestedEvidence: await this.suggestedEvidence(trx, system.id),
      };
    });
  }

  async msDecide(principal: Principal, ms: string, id: string, itemId: string, body: AccessReviewDecide): Promise<CommandResult> {
    return this.tenancy.withTenant(tenantContextOf(principal), async (trx) => {
      const system = await this.records.resolveMs(trx, ms);
      const review = await reviewRow(trx, id, { forUpdate: true });
      const item = await lockedItem(trx, id, itemId);
      if (item.part_ms_id !== system.id) throw new NotFoundError('No such item in this system\'s part of the access review');
      return this.recordDecision(trx, principal, review, item, body);
    });
  }

  async signOff(principal: Principal, ms: string, id: string, body: AccessReviewSignOff): Promise<CommandResult> {
    const org = orgOf(principal);
    const actor = principal.user.id;
    return this.tenancy.withTenant(tenantContextOf(principal), async (trx) => {
      const system = await this.records.resolveMs(trx, ms);
      const review = await reviewRow(trx, id, { forUpdate: true });
      const part = await this.systemPart(trx, id, system.id, { forUpdate: true });
      if (review.status !== 'open') throw conflict('The access review is not open', REFUSALS.notOpen);
      if (part.status === 'signed_off') throw conflict('This part is signed off already', REFUSALS.partSignedOff);
      const items = await itemRows(trx, { partIds: [part.id] });
      const reviewers = await reviewersOf(trx, org.id);
      const undecided = items.filter((i) => i.decision === null && !needsSecondReviewer(i, reviewers));
      if (undecided.length) throw new ConflictError(`${undecided.length} item(s) are not decided`, { messages: REFUSALS.undecided, affected: undecided.map((i) => i.id) });
      let evidence: { id: string; code: string } | null = null;
      if (body.evidenceId) {
        const resolved = await this.records.resolve(trx, ms, 'evidence', body.evidenceId);
        evidence = { id: resolved.id, code: String(resolved.row.evidence_code ?? '') };
      }
      const now = this.clock.now();
      await sql`update access_review_part set status = 'signed_off', signed_off_by = ${actor}, signed_off_at = ${now}, evidence_id = ${evidence?.id ?? null},
                 updated_at = now(), updated_by = ${actor} where id = ${part.id}`.execute(trx);
      await this.closeTasks(trx, id, 'done', actor, part.id);
      await this.audit.record(trx, {
        action: 'access_review.signed_off',
        msId: system.id,
        entityType: 'access_review_part',
        entityId: part.id,
        entityCode: review.review_no,
        before: { status: 'open' },
        after: {
          status: 'signed_off', items: items.length, kept: items.filter((i) => i.decision === 'keep').length,
          changed: items.filter((i) => i.decision === 'change').length, revoked: items.filter((i) => i.decision === 'revoke').length,
          needsSecondReviewer: items.length - items.filter((i) => i.decision !== null).length, evidence: evidence?.code ?? null,
        },
      });
      const code = part.ms_code ?? system.slug;
      const message: Pair = evidence
        ? [`${code} signed off; its rows are filed to ${evidence.code} when the review completes`, `${code} ditandatangani; barisnya diarsipkan ke ${evidence.code} saat tinjauan selesai`]
        : [`${code} signed off`, `${code} ditandatangani`];
      return commandResult([system.slug], { message, warnings: secondReviewerWarnings(items, reviewers) });
    });
  }

  // -------------------------------------------------------------------------------------------------------------

  /** Records a decision on a locked item of an open review (REVIEW-OWN-ACCESS, locked parts and applied items). */
  private async recordDecision(trx: Trx, principal: Principal, review: ReviewRow, item: ItemRow, body: AccessReviewDecide): Promise<CommandResult> {
    const actor = principal.user.id;
    if (review.status !== 'open') throw conflict('The access review is not open', REFUSALS.notOpen);
    const [part] = await partRows(trx, { partId: item.access_review_part_id });
    if (part?.status === 'signed_off') throw conflict('This part is signed off', REFUSALS.partSignedOff);
    if (item.applied_at !== null || item.not_applied_reason !== null) throw conflict('The decision has been applied', REFUSALS.applied);
    if (item.subject_user_id === actor) throw ownAccess(item);
    const note = body.note ?? null;
    const now = this.clock.now();
    await sql`update access_review_item set decision = ${body.decision}, decision_note = ${note}, decided_by = ${actor}, decided_at = ${now},
               updated_at = now(), updated_by = ${actor} where id = ${item.id}`.execute(trx);
    const subject = subjectOf(item);
    await this.audit.record(trx, {
      action: 'access_review.item_decided',
      msId: item.part_ms_id,
      entityType: 'access_review_item',
      entityId: item.id,
      entityCode: review.review_no,
      after: { decision: body.decision, note, previous: item.decision, kind: item.item_kind, subject: subject.handle, role: item.role, ms: item.ms },
    });
    return commandResult(item.ms ? [item.ms] : [], { data: { decision: body.decision } });
  }

  /** The part of system `msId` in review `reviewId` (404 otherwise). */
  private async systemPart(trx: Trx, reviewId: string, msId: string, options: { forUpdate?: boolean } = {}): Promise<PartRow> {
    const [part] = (await partRows(trx, { reviewIds: [reviewId], msId }, options));
    if (!part) throw new NotFoundError('No such access review of this system');
    return part;
  }

  /**
   * For a system on ISO/IEC 27001, the evidence item of the system whose targets include control A.5.18 (access
   * rights), by its code; null otherwise.
   */
  private async suggestedEvidence(trx: Trx, msId: string): Promise<{ id: string; code: string } | null> {
    const { rows } = await sql<{ id: string; code: string }>`
      select e.id, e.evidence_code as code
        from evidence e
        join evidence_target t on t.evidence_id = e.id and t.deleted_at is null and t.management_system_id = ${msId}
        join management_system ms on ms.id = t.management_system_id
        join ref.framework_version fv on fv.id = ms.framework_version_id
        left join ref.catalogue_item ci on ci.id = t.catalogue_item_id
        left join ref.requirement rq on rq.id = t.requirement_id
       where e.deleted_at is null and fv.pack_id like 'ISO27001%'
         and (ci.item_code = ${ACCESS_RIGHTS_CONTROL} or rq.requirement_code = ${ACCESS_RIGHTS_CONTROL})
       order by e.evidence_code
       limit 1`.execute(trx);
    return rows[0] ?? null;
  }

  /** Closes the open tasks of a review (of one part when given); returns how many. */
  private async closeTasks(trx: Trx, reviewId: string, status: 'done' | 'cancelled', actor: string, partId?: string): Promise<number> {
    const parts = partId ? [partId] : (await partRows(trx, { reviewIds: [reviewId] })).map((p) => p.id);
    if (parts.length === 0) return 0;
    const closed = await trx
      .updateTable('task')
      .set({ status, closed_by: actor, closed_at: sql<Date>`now()`, updated_by: actor, updated_at: sql<Date>`now()` })
      .where('source_rule', '=', 'access_review')
      .where('entity_type', '=', 'access_review_part')
      .where('entity_id', 'in', parts)
      .where('status', '=', 'open')
      .where('deleted_at', 'is', null)
      .returning('id')
      .execute();
    return closed.length;
  }
}
