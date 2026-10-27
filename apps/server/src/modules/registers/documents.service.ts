// Document register commands of D.3 (WP-35, C.13 `document.status`, A.4 5.7 and 5.8): register a controlled
// document (doc_type from the edition's lookups, linked systems through `entity_ms_link`), change its fields (BR-22
// confirmation for shared documents), and move it through review: start a review (draft or expired), approve it
// (never by the author of the version in review, BR-16) or return it to draft with a note. Approval makes the version
// in review the current one, supersedes the earlier approved version and ends the review (WP-21 follow-up).
//
// Milestone 2 (D.1, D.2, M2-07): a document is internal (default) or external, an external one naming its source
// (who issued it) and optionally the issuer's reference and the date it was received; `DocumentVersionsService` lists
// the versions of a document newest first, with the scope policy of the document (owner scope and classification).
// Every document command queues `readiness.recompute` and `cycle.derive` (D.6) for the systems the document counts
// in (its linked systems; every active system for an organisation-wide document), in the command's transaction.
import { randomUUID } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import type { CommandResult, DocumentCreateRequest, DocumentPatch, DocumentTransitionRequest, DocumentVersionItem } from '@mscd/shared';
import { sql } from 'kysely';
import { Clock } from '../../common/clock';
import { addDays } from '../../common/dates';
import { assertIfMatch } from '../../common/etag';
import { JOB_QUEUE, type JobQueue } from '../../common/jobs/job-queue';
import { ConflictError, ForbiddenError, NotFoundError } from '../../common/problems';
import {
  AUDIT_WRITER, LICENCE_GATE, MEMBERSHIP_SERVICE, PERMISSION_EVALUATOR, RECORD_RESOLVER, type AuditWriter, type AuthzState, type LicenceGate,
  type MembershipService, type PermissionEvaluator, type Principal, type RecordResolver, type TenantInfo, type Trx,
} from '../../common/tokens';
import { ScopePolicyService } from '../authz/scope-policy';
import { enqueueDerived } from '../implementation/readiness/readiness-queue';
import { RuleEngine } from '../rules';
import { TenantScope, tenantContextOf } from '../tenancy/tenant-scope';
import { assertRequires, commandResult, linkedSystems, orgOf, personOf, pickTransition, refOf, todayOf, unprocessable, writeRow } from './command-support';
import type { Br16Input } from './register.rules';
import { SharedChangeGuard } from './shared-change';

const ENTITY = 'document';
const MACHINE = 'document.status' as const;

interface DocumentRow {
  id: string;
  updated_at: Date;
  created_by: string | null;
  doc_code: string;
  title: string;
  status: 'draft' | 'in_review' | 'approved' | 'expired';
  classification: string;
  owner_user_id: string | null;
  approver_user_id: string | null;
  current_version_id: string | null;
  approved_at: string | null;
  next_review_at: string | null;
  is_org_wide: boolean;
  pending_holder_user_id: string | null;
  pending_due_at: string | null;
  review_started_at: string | null;
  origin: 'internal' | 'external';
  external_source: string | null;
  external_ref: string | null;
  received_at: string | null;
}

interface VersionRow {
  id: string;
  version_label: string;
  status: string;
  submitted_by: string | null;
}

@Injectable()
export class DocumentCommandsService {
  constructor(
    private readonly tenancy: TenantScope,
    private readonly clock: Clock,
    private readonly rules: RuleEngine,
    private readonly shared: SharedChangeGuard,
    @Inject(RECORD_RESOLVER) private readonly records: RecordResolver,
    @Inject(MEMBERSHIP_SERVICE) private readonly members: MembershipService,
    @Inject(AUDIT_WRITER) private readonly audit: AuditWriter,
    @Inject(PERMISSION_EVALUATOR) private readonly evaluator: PermissionEvaluator,
    @Inject(LICENCE_GATE) private readonly licence: LicenceGate,
    @Inject(JOB_QUEUE) private readonly queue: JobQueue,
  ) {}

  // -------------------------------------------------------------------------------------------------------------
  // POST /ms/{ms}/documents/{id}/transitions
  // -------------------------------------------------------------------------------------------------------------

  async transition(principal: Principal, authz: AuthzState | null, ms: string, id: string, body: DocumentTransitionRequest, ifMatch: string | undefined): Promise<CommandResult> {
    const org = orgOf(principal);
    const actor = principal.user.id;
    return this.tenancy.withTenant(tenantContextOf(principal), async (trx) => {
      const record = await this.records.resolve(trx, ms, ENTITY, id, { forUpdate: true });
      const doc = record.row as unknown as DocumentRow;
      const currentRef = refOf(ENTITY, id, doc.doc_code, doc.updated_at);
      assertIfMatch(ifMatch, doc.updated_at, currentRef);
      const from = doc.status;
      const to = body.to;
      const transition = pickTransition(MACHINE, from, to, authz, doc.owner_user_id === actor);
      assertRequires(transition, body as Record<string, unknown>);
      const today = todayOf(this.clock, org);
      const systems = await linkedSystems(trx, ENTITY, id, record.ms.id);
      const msIds = systems.length > 0 ? systems.map((s) => s.id) : [record.ms.id];
      const inReview = await this.versionInReview(trx, id);
      const set: Record<string, unknown> = { status: to };
      const before: Record<string, unknown> = { status: from };
      const after: Record<string, unknown> = { status: to };

      if (to === 'in_review') {
        set.review_started_at = today;
        after.review_started_at = today;
      } else if (to === 'approved') {
        // BR-16: the author of what is approved never approves it (the version in review, else the version in
        // force; a register entry without any version: its creator).
        const current = inReview ?? (doc.current_version_id ? await this.version(trx, doc.current_version_id) : null);
        const authors = current ? [current.submitted_by] : [doc.created_by];
        await this.rules.enforce<Br16Input>(trx, 'BR-16', { actorId: actor, authors }, { msIds, ref: currentRef });
        if (inReview) {
          await sql`update document_version set status = 'superseded', updated_at = now(), updated_by = ${actor}
                     where document_id = ${id} and status = 'approved' and id <> ${inReview.id} and deleted_at is null`.execute(trx);
          await sql`update document_version set status = 'approved', approved_by = ${actor}, approved_at = ${today}::date, updated_at = now(),
                     updated_by = ${actor} where id = ${inReview.id}`.execute(trx);
          set.current_version_id = inReview.id;
          before.current_version = doc.current_version_id ? (await this.version(trx, doc.current_version_id))?.version_label ?? null : null;
          after.current_version = inReview.version_label;
        }
        set.approved_at = today;
        // A review confirmed on or after the review date moves the next review a year ahead (BR-10 would expire it again).
        if (!doc.next_review_at || doc.next_review_at <= today) {
          set.next_review_at = addDays(today, 365);
          after.next_review_at = set.next_review_at;
        }
        Object.assign(set, { review_started_at: null, pending_holder_user_id: null, pending_due_at: null });
        after.approved_at = today;
      } else {
        // Rejection (in review to draft): the version in review is rejected with the note; the version in force stays.
        if (inReview) {
          await sql`update document_version set status = 'rejected', rejection_note = ${body.note!}, updated_at = now(), updated_by = ${actor}
                     where id = ${inReview.id}`.execute(trx);
          after.rejected_version = inReview.version_label;
        }
        set.review_started_at = null;
      }
      if (body.note) after.note = body.note;
      const updatedAt = await writeRow(trx, ENTITY, id, set, actor);
      await this.audit.record(trx, { action: 'document.transition', msId: record.ms.id, entityType: ENTITY, entityId: id, entityCode: doc.doc_code, before, after });
      await this.queueDerived(trx, org, doc.is_org_wide, msIds, actor);
      return commandResult(systems.length > 0 ? systems.map((s) => s.slug) : [record.ms.slug], { ref: refOf(ENTITY, id, doc.doc_code, updatedAt) });
    });
  }

  // -------------------------------------------------------------------------------------------------------------
  // POST /ms/{ms}/documents
  // -------------------------------------------------------------------------------------------------------------

  async create(principal: Principal, ms: string, body: DocumentCreateRequest): Promise<CommandResult> {
    const org = orgOf(principal);
    const actor = principal.user.id;
    return this.tenancy.withTenant(tenantContextOf(principal), async (trx) => {
      const system = await this.records.resolveMs(trx, ms);
      const slugs = [...new Set(body.linkedMs)];
      if (!slugs.includes(system.slug)) {
        throw unprocessable('documents.path_system_not_linked', `linkedMs must include ${system.slug}`, `linkedMs harus memuat ${system.slug}`);
      }
      // The path system first: it holds the primary link (A-29).
      const ordered = [system.slug, ...slugs.filter((s) => s !== system.slug)];
      const systems = [];
      for (const slug of ordered) systems.push(await this.records.resolveMs(trx, slug));
      for (const other of systems.slice(1)) {
        if ((await this.evaluator.evaluate(principal, 'document.manage', { scope: 'ms', ms: other.slug })) !== 'full') {
          throw new ForbiddenError(`Linking a document to ${other.slug} needs document.manage there`);
        }
      }
      if (systems.length > 1) await this.licence.assertFeature(org.id, 'integrated_mode', trx);
      await this.assertDocType(trx, system.id, body.docType);
      const duplicate = await sql<{ id: string }>`select id from document where doc_code = ${body.docCode} and deleted_at is null limit 1`.execute(trx);
      if (duplicate.rows.length > 0) throw new ConflictError(`Document ${body.docCode} already exists`, { messageKey: 'documents.duplicate_code' });
      const owner = await this.members.resolveHandle(trx, body.ownerHandle);
      const approver = body.approverHandle ? await this.members.resolveHandle(trx, body.approverHandle) : null;
      const id = randomUUID();
      const origin = body.origin ?? 'internal';
      const position = await sql<{ next: number }>`select coalesce(max(position), -1)::int + 1 as next from document`.execute(trx);
      const { rows } = await sql<{ updated_at: Date }>`
        insert into document (id, doc_code, title, doc_type, status, classification, owner_user_id, approver_user_id, next_review_at,
                              is_org_wide, position, origin, external_source, external_ref, received_at, created_by, updated_by)
        values (${id}, ${body.docCode}, ${body.title}, ${body.docType}, 'draft', ${body.classification}, ${owner}, ${approver},
                ${body.nextReviewAt ?? null}::date, ${body.orgWide}, ${position.rows[0]?.next ?? 0}, ${origin}, ${body.externalSource ?? null},
                ${body.externalRef ?? null}, ${body.receivedAt ?? null}::date, ${actor}, ${actor})
        returning updated_at`.execute(trx);
      for (const [i, s] of systems.entries()) {
        await sql`insert into entity_ms_link (entity_type, entity_id, management_system_id, is_primary, created_by, updated_by)
                  values ('document', ${id}, ${s.id}, ${i === 0}, ${actor}, ${actor})`.execute(trx);
      }
      await this.audit.record(trx, {
        action: 'document.created',
        msId: system.id,
        entityType: ENTITY,
        entityId: id,
        entityCode: body.docCode,
        after: {
          title: body.title,
          doc_type: body.docType,
          status: 'draft',
          classification: body.classification,
          owner: body.ownerHandle,
          ...(body.approverHandle ? { approver: body.approverHandle } : {}),
          ...(body.nextReviewAt ? { next_review_at: body.nextReviewAt } : {}),
          is_org_wide: body.orgWide,
          systems: systems.map((s) => s.slug),
          ...(origin === 'external'
            ? {
                origin,
                external_source: body.externalSource,
                ...(body.externalRef ? { external_ref: body.externalRef } : {}),
                ...(body.receivedAt ? { received_at: body.receivedAt } : {}),
              }
            : {}),
        },
      });
      await this.queueDerived(trx, org, body.orgWide, systems.map((s) => s.id), actor);
      return commandResult(systems.map((s) => s.slug), { ref: refOf(ENTITY, id, body.docCode, rows[0]!.updated_at) });
    });
  }

  // -------------------------------------------------------------------------------------------------------------
  // PATCH /ms/{ms}/documents/{id}
  // -------------------------------------------------------------------------------------------------------------

  async update(principal: Principal, ms: string, id: string, patch: DocumentPatch, ifMatch: string | undefined): Promise<CommandResult> {
    const org = orgOf(principal);
    const actor = principal.user.id;
    return this.tenancy.withTenant(tenantContextOf(principal), async (trx) => {
      const record = await this.records.resolve(trx, ms, ENTITY, id, { forUpdate: true });
      const doc = record.row as unknown as DocumentRow;
      const currentRef = refOf(ENTITY, id, doc.doc_code, doc.updated_at);
      assertIfMatch(ifMatch, doc.updated_at, currentRef);
      // BR-22: the change applies to every linked system.
      const systems = await this.shared.assertConfirmed(trx, { entityType: ENTITY, id, msId: record.ms.id, ref: currentRef }, patch.confirm);
      const set: Record<string, unknown> = {};
      const before: Record<string, unknown> = {};
      const after: Record<string, unknown> = {};
      const change = (column: keyof DocumentRow, value: unknown, shown: { before?: unknown; after?: unknown } = {}) => {
        if ((doc[column] ?? null) === (value ?? null)) return;
        set[column] = value ?? null;
        before[column] = shown.before !== undefined ? shown.before : (doc[column] ?? null);
        after[column] = shown.after !== undefined ? shown.after : (value ?? null);
      };
      if (patch.title !== undefined) change('title', patch.title);
      if (patch.classification !== undefined) change('classification', patch.classification);
      if (patch.nextReviewAt !== undefined) change('next_review_at', patch.nextReviewAt);
      if (patch.ownerHandle !== undefined) {
        const owner = await this.members.resolveHandle(trx, patch.ownerHandle);
        change('owner_user_id', owner, { before: (await personOf(trx, doc.owner_user_id))?.handle ?? 'none', after: patch.ownerHandle });
      }
      if (patch.approverHandle !== undefined) {
        const approver = patch.approverHandle === null ? null : await this.members.resolveHandle(trx, patch.approverHandle);
        change('approver_user_id', approver, { before: (await personOf(trx, doc.approver_user_id))?.handle ?? null, after: patch.approverHandle });
      }
      // Milestone 2 D.2: origin and the external facts. An internal document keeps none of them; an external one names
      // its source.
      const origin = patch.origin ?? doc.origin;
      if (patch.origin !== undefined) change('origin', patch.origin);
      if (origin === 'internal') {
        if ([patch.externalSource, patch.externalRef, patch.receivedAt].some((v) => v !== undefined && v !== null)) {
          throw unprocessable('documents.external_fields_internal', 'Source, reference and date received describe an external document',
            'Sumber, referensi dan tanggal diterima menjelaskan dokumen eksternal');
        }
        change('external_source', null);
        change('external_ref', null);
        change('received_at', null);
      } else {
        if (patch.externalSource !== undefined) change('external_source', patch.externalSource);
        if (patch.externalRef !== undefined) change('external_ref', patch.externalRef);
        if (patch.receivedAt !== undefined) change('received_at', patch.receivedAt);
        const source = patch.externalSource !== undefined ? patch.externalSource : doc.external_source;
        if (!source) {
          throw unprocessable('documents.external_source_required', 'An external document names its source', 'Dokumen eksternal menyebutkan sumbernya');
        }
      }
      const updatedAt = await writeRow(trx, ENTITY, id, set, actor);
      if (Object.keys(after).length > 0) {
        await this.audit.record(trx, {
          action: 'document.updated',
          msId: record.ms.id,
          entityType: ENTITY,
          entityId: id,
          entityCode: doc.doc_code,
          before,
          after: { ...after, ...(systems.length > 1 ? { systems: systems.map((s) => s.slug) } : {}) },
        });
        await this.queueDerived(trx, org, doc.is_org_wide, systems.length > 0 ? systems.map((s) => s.id) : [record.ms.id], actor);
      }
      return commandResult(systems.length > 0 ? systems.map((s) => s.slug) : [record.ms.slug], { ref: refOf(ENTITY, id, doc.doc_code, updatedAt) });
    });
  }

  // -------------------------------------------------------------------------------------------------------------
  // Helpers
  // -------------------------------------------------------------------------------------------------------------

  /**
   * Queues `readiness.recompute` and `cycle.derive` (D.6) for every system the document counts in: its linked systems,
   * or every active system of the organisation for an organisation-wide document (readiness reads those too).
   */
  private async queueDerived(trx: Trx, org: Pick<TenantInfo, 'id'>, orgWide: boolean, msIds: string[], actor: string): Promise<void> {
    const targets = orgWide
      ? (await sql<{ id: string }>`select id from management_system where deleted_at is null and status <> 'archived' order by id`.execute(trx)).rows.map((r) => r.id)
      : [...new Set(msIds)];
    for (const msId of targets) await enqueueDerived(this.queue, trx, org, msId, actor);
  }

  /** 422 unless `docType` is a `doc_type` lookup of the system's edition (`ref.lookup_value`). */
  private async assertDocType(trx: Trx, msId: string, docType: string): Promise<void> {
    const { rows } = await sql<{ code: string }>`
      select l.code from ref.lookup_value l join management_system m on m.framework_version_id = l.framework_version_id
       where m.id = ${msId} and l.domain = 'doc_type' and l.code = ${docType}`.execute(trx);
    if (rows.length === 0) {
      throw unprocessable('documents.unknown_doc_type', `${docType} is not a document type of the edition in use`, `${docType} bukan jenis dokumen dari edisi yang digunakan`);
    }
  }

  private async versionInReview(trx: Trx, documentId: string): Promise<VersionRow | null> {
    const { rows } = await sql<VersionRow>`
      select id, version_label, status, submitted_by from document_version
       where document_id = ${documentId} and status = 'in_review' and deleted_at is null
       order by created_at desc limit 1 for update`.execute(trx);
    return rows[0] ?? null;
  }

  private async version(trx: Trx, versionId: string): Promise<VersionRow | null> {
    const { rows } = await sql<VersionRow>`select id, version_label, status, submitted_by from document_version where id = ${versionId}`.execute(trx);
    return rows[0] ?? null;
  }
}

// ---------------------------------------------------------------------------------------------------------------
// GET /ms/{ms}/documents/{id}/versions (Milestone 2 D.1, M2-07)
// ---------------------------------------------------------------------------------------------------------------

interface VersionListRow {
  id: string;
  version_label: string;
  status: DocumentVersionItem['status'];
  storage_object_id: string;
  submitted_by: string | null;
  submitted_by_id: string | null;
  submitted_at: Date | null;
  approved_by: string | null;
  approved_by_id: string | null;
  approved_at: string | null;
  rejection_note: string | null;
  change_summary: string | null;
}

/**
 * The versions of a document, newest first. The document must be visible to the caller under the scope policy of
 * the system (F.7, D-34): own-scoped roles see only their own documents, `restricted` documents only their owner and
 * the managers, `confidential` ones no guest auditor; otherwise 404, as for a document of another system. Top
 * Management and guest auditors see no submitter or approver of other people (Q-8, G.5).
 */
@Injectable()
export class DocumentVersionsService {
  constructor(
    private readonly tenancy: TenantScope,
    private readonly policy: ScopePolicyService,
    @Inject(RECORD_RESOLVER) private readonly records: RecordResolver,
  ) {}

  async list(principal: Principal, ms: string, id: string): Promise<DocumentVersionItem[]> {
    return this.tenancy.withTenant(tenantContextOf(principal), async (trx) => {
      const record = await this.records.resolve(trx, ms, ENTITY, id);
      const doc = record.row as unknown as DocumentRow;
      const scope = await this.policy.scopeContext(trx, principal, ms);
      const systems = await linkedSystems(trx, ENTITY, id, record.ms.id);
      const visible = this.policy.recordVisible(scope, {
        ownerUserId: doc.owner_user_id,
        holderUserId: doc.pending_holder_user_id,
        classification: doc.classification as 'public' | 'internal' | 'confidential' | 'restricted',
        linkedMsIds: systems.map((s) => s.id),
      });
      if (!visible) throw new NotFoundError();
      const { rows } = await sql<VersionListRow>`
        select v.id, v.version_label, v.status, v.storage_object_id, s.handle as submitted_by, v.submitted_by as submitted_by_id, v.submitted_at,
               a.handle as approved_by, v.approved_by as approved_by_id, v.approved_at, v.rejection_note, v.change_summary
          from document_version v
          left join platform.app_user s on s.id = v.submitted_by
          left join platform.app_user a on a.id = v.approved_by
         where v.document_id = ${id} and v.deleted_at is null
         order by v.created_at desc, v.id desc`.execute(trx);
      const shown = (userId: string | null) =>
        scope.kind === 'external_auditor' ? false : scope.kind === 'top_management' ? userId === scope.userId : true;
      return rows.map((v) => ({
        id: v.id,
        label: v.version_label,
        status: v.status,
        storageObjectId: v.storage_object_id,
        submittedBy: shown(v.submitted_by_id) ? v.submitted_by : null,
        submittedAt: v.submitted_at ? new Date(v.submitted_at).toISOString() : null,
        approvedBy: shown(v.approved_by_id) ? v.approved_by : null,
        approvedAt: v.approved_at,
        rejectionNote: v.rejection_note,
        changeSummary: v.change_summary,
      }));
    });
  }
}
