// Required documented information of an edition and the mapping of pack document codes to registered documents
// (Milestone 2 D.1 `documented-info.list` and `documented-info.link`).
//
// A pack names documents by its own codes (template codes such as `POL-01`, activity output document codes). A
// customer that keeps its own codes (`ISP-001`) links one of its documents to the pack code (`document_code_link`).
// `resolvePackDocument` is the one rule every reader applies (BR-40 of `rules/activity.rules.ts`, this list, the read
// model): the live document of the system with that code, else the document linked to the code.
//
// The list shows, per `ref.documented_info` row of the system's edition, the document that maintains it (by template
// code, by a link of the template code or of the row's own code, or by the implementing documents of the applicability
// entry of its clause) with status, review date and owner, or for `retain` rows the evidence of the clause with its
// freshness. States: `missing`, `draft`, `in_review`, `approved`, `review_overdue` (maintain), `fresh`,
// `out_of_date`, `missing` (retain). The scope policy applies: own-scoped roles see only their own documents and
// evidence (the state stays that of the full data, D-04), Top Management and guest auditors see no owner or review
// date of other people's documents, and guest auditors see evidence only through ready evidence packs.
import { Inject, Injectable } from '@nestjs/common';
import type { CommandResult, DocumentedInfoItem, DocumentedInfoLink, DocumentedInfoState, FreshnessStatus } from '@mscd/shared';
import { uiDocStatus } from '@mscd/shared';
import { sql } from 'kysely';
import { erasedJoin, shownHandle } from '../privacy/pseudonym';
import { Clock } from '../../common/clock';
import { JOB_QUEUE, type JobQueue } from '../../common/jobs/job-queue';
import { NotFoundError, ProblemError } from '../../common/problems';
import { currentRequestId } from '../../common/request-context';
import { AUDIT_WRITER, RECORD_RESOLVER, type AuditWriter, type MsRef, type Principal, type RecordResolver, type Trx } from '../../common/tokens';
import { ScopePolicyService, type ScopeContext } from '../authz/scope-policy';
import { freshnessBand, thresholdsFor, type ThresholdRow } from '../read-model/derive/freshness';
import { TenantScope, tenantContextOf } from '../tenancy/tenant-scope';
import { commandResult, orgOf, todayOf } from './command-support';

/** D.6: commands that feed readiness queue it 60 seconds later, one waiting job per organisation and system. */
const READINESS_DELAY_SECONDS = 60;

/** A live document of the system that stands for a pack code. */
export interface ResolvedPackDocument {
  id: string;
  docCode: string;
  /** True when the document was found through `document_code_link`, not by its own code. */
  linked: boolean;
}

/**
 * The document a pack document code stands for in a system: the live document with that code (linked to the system
 * or organisation-wide), else the live document linked to the code with `documented-info.link`. Null when neither
 * exists.
 */
export async function resolvePackDocument(trx: Trx, msId: string, code: string): Promise<ResolvedPackDocument | null> {
  const { rows } = await sql<{ id: string; doc_code: string; linked: boolean }>`
    select d.id, d.doc_code, false as linked, 0 as rank from document d
     where d.deleted_at is null and d.doc_code = ${code}
       and (d.is_org_wide or exists (select 1 from entity_ms_link l where l.entity_type = 'document' and l.entity_id = d.id
                                       and l.management_system_id = ${msId} and l.deleted_at is null))
    union all
    select d.id, d.doc_code, true as linked, 1 as rank from document_code_link k
      join document d on d.id = k.document_id and d.deleted_at is null
     where k.management_system_id = ${msId} and k.pack_code = ${code} and k.deleted_at is null
       and (d.is_org_wide or exists (select 1 from entity_ms_link l where l.entity_type = 'document' and l.entity_id = d.id
                                       and l.management_system_id = ${msId} and l.deleted_at is null))
    order by rank limit 1`.execute(trx);
  const row = rows[0];
  return row ? { id: row.id, docCode: row.doc_code, linked: row.linked } : null;
}

/** Pack document codes of a system's edition: template codes, activity output codes and documented information codes. */
export async function packDocumentCodes(trx: Trx, msId: string): Promise<Set<string>> {
  const { rows } = await sql<{ code: string }>`
    with v as (select framework_version_id as id from management_system where id = ${msId})
    select t.code from ref.document_template t, v where t.framework_version_id = v.id
    union select a.output_document_code from ref.activity_template a, v where a.framework_version_id = v.id and a.output_document_code is not null
    union select i.code from ref.documented_info i, v where i.framework_version_id = v.id
    union select i.template_code from ref.documented_info i, v where i.framework_version_id = v.id and i.template_code is not null`.execute(trx);
  return new Set(rows.map((r) => r.code));
}

interface InfoRow {
  code: string;
  requirement_code: string;
  kind: 'maintain' | 'retain';
  title: string;
  template_code: string | null;
}

interface DocumentFacts {
  id: string;
  doc_code: string;
  title: string;
  status: 'draft' | 'in_review' | 'approved' | 'expired';
  next_review_at: string | null;
  owner_user_id: string | null;
  owner_handle: string | null;
  pending_holder_user_id: string | null;
  classification: 'public' | 'internal' | 'confidential' | 'restricted';
  ms_ids: string[] | null;
}

interface EvidenceFacts {
  id: string;
  evidence_code: string;
  title: string;
  owner_user_id: string | null;
  classification: 'public' | 'internal' | 'confidential' | 'restricted';
  produced_at: string | null;
  frequency_code: string;
  requirement_code: string;
}

function unprocessable(messageKey: string, en: string, id: string): ProblemError {
  return new ProblemError('business-rule', { messageKey, messages: { en, id }, detail: en });
}

/** State of a `maintain` row from its document (`missing` without one). */
export function maintainState(doc: Pick<DocumentFacts, 'status' | 'next_review_at'> | null, today: string): DocumentedInfoState {
  if (!doc) return 'missing';
  if (doc.status === 'expired' || (doc.status === 'approved' && doc.next_review_at !== null && doc.next_review_at < today)) return 'review_overdue';
  return doc.status;
}

/** State of a `retain` row from the freshness of its evidence: fresh while one item is fresh or ageing. */
export function retainState(freshness: readonly FreshnessStatus[]): DocumentedInfoState {
  if (freshness.length === 0) return 'missing';
  return freshness.some((f) => f === 'fresh' || f === 'aging') ? 'fresh' : 'out_of_date';
}

/** True for a clause code that is the code or a sub-clause of `parent` (`9.2` covers `9.2` and `9.2.1`). */
function underClause(code: string, parent: string): boolean {
  return code === parent || code.startsWith(`${parent}.`);
}

@Injectable()
export class DocumentedInfoService {
  constructor(
    private readonly tenancy: TenantScope,
    private readonly clock: Clock,
    private readonly policy: ScopePolicyService,
    @Inject(RECORD_RESOLVER) private readonly records: RecordResolver,
    @Inject(AUDIT_WRITER) private readonly audit: AuditWriter,
    @Inject(JOB_QUEUE) private readonly queue: JobQueue,
  ) {}

  // -------------------------------------------------------------------------------------------------------------
  // GET /ms/{ms}/documented-information
  // -------------------------------------------------------------------------------------------------------------

  async list(principal: Principal, ms: string): Promise<DocumentedInfoItem[]> {
    const org = orgOf(principal);
    const today = todayOf(this.clock, org);
    return this.tenancy.withTenant(tenantContextOf(principal), async (trx) => {
      const system = await this.records.resolveMs(trx, ms);
      const scope = await this.policy.scopeContext(trx, principal, ms);
      const infos = (
        await sql<InfoRow>`
          select i.code, i.requirement_code, i.kind, i.title, i.template_code
            from ref.documented_info i join management_system m on m.framework_version_id = i.framework_version_id
           where m.id = ${system.id} order by i.sort_order, i.code`.execute(trx)
      ).rows;
      if (infos.length === 0) return [];

      const documents = await this.documentsOf(trx, system);
      const byCode = new Map(documents.map((d) => [d.doc_code, d]));
      const byId = new Map(documents.map((d) => [d.id, d]));
      const links = new Map(
        (await sql<{ pack_code: string; document_id: string }>`
          select pack_code, document_id from document_code_link where management_system_id = ${system.id} and deleted_at is null`.execute(trx)).rows
          .map((l) => [l.pack_code, l.document_id]),
      );
      // Implementing documents of the requirement entries of the system (by clause code, in link order).
      const implementing = (
        await sql<{ requirement_code: string; document_id: string }>`
          select rq.requirement_code, ed.document_id
            from applicability_entry e
            join ref.requirement rq on rq.id = e.requirement_id
            join applicability_entry_document ed on ed.applicability_entry_id = e.id and ed.deleted_at is null
           where e.management_system_id = ${system.id} and e.deleted_at is null and e.target_type = 'requirement'
           order by rq.sort_order, ed.position`.execute(trx)
      ).rows;
      const evidence = infos.some((i) => i.kind === 'retain') ? await this.evidenceOf(trx, system) : [];
      const periods = await this.periodsOf(trx, system);
      const thresholds = await this.thresholdsOf(trx, system);

      const documentFor = (info: InfoRow): { doc: DocumentFacts; linked: boolean } | null => {
        for (const code of [info.template_code, info.code]) {
          if (!code) continue;
          const own = byCode.get(code);
          if (own) return { doc: own, linked: false };
          const linkedId = links.get(code);
          const linked = linkedId ? byId.get(linkedId) : undefined;
          if (linked) return { doc: linked, linked: true };
        }
        const entryDoc = implementing.find((r) => underClause(r.requirement_code, info.requirement_code) && byId.has(r.document_id));
        return entryDoc ? { doc: byId.get(entryDoc.document_id)!, linked: false } : null;
      };

      return infos.map((info): DocumentedInfoItem => {
        const base = {
          code: info.code,
          requirementCode: info.requirement_code,
          kind: info.kind,
          title: info.title,
          templateCode: info.template_code,
        };
        if (info.kind === 'retain') {
          const items = evidence
            .filter((e) => underClause(e.requirement_code, info.requirement_code))
            .filter((e, i, all) => all.findIndex((x) => x.id === e.id) === i)
            .map((e) => ({
              e,
              fresh: freshnessBand(e.produced_at, periods.get(e.frequency_code) ?? 0, today, thresholdsFor(thresholds, system.id, e.frequency_code)),
            }));
          // D-04: the state is that of the full data; the list keeps only the evidence the caller may see.
          const state = retainState(items.map((x) => x.fresh));
          const visible = items.filter(({ e }) => this.evidenceVisible(scope, e));
          return { ...base, state, document: null, evidence: visible.map(({ e, fresh }) => ({ code: e.evidence_code, title: e.title, fresh })) };
        }
        const found = documentFor(info);
        const state = maintainState(found?.doc ?? null, today);
        if (!found || !this.documentVisible(scope, found.doc)) return { ...base, state, document: null, evidence: [] };
        const { doc, linked } = found;
        const holderShown = this.holderShown(scope, doc);
        return {
          ...base,
          state,
          document: {
            id: doc.id,
            code: doc.doc_code,
            title: doc.title,
            status: uiDocStatus(doc.status, doc.next_review_at, today),
            nextReviewAt: holderShown ? doc.next_review_at : null,
            owner: holderShown ? (doc.owner_handle ?? 'none') : 'none',
            linked,
          },
          evidence: [],
        };
      });
    });
  }

  // -------------------------------------------------------------------------------------------------------------
  // PUT /ms/{ms}/documented-information/{code}/link
  // -------------------------------------------------------------------------------------------------------------

  /**
   * Maps a pack document code of the system's edition to a registered document of the system (linked to it or
   * organisation-wide), or with `documentId: null` removes the mapping. 404 for a code the edition does not use, 422
   * for a document outside the system. Audited `document_code.linked`; readiness is recomputed (documented
   * information, D.6).
   */
  async link(principal: Principal, ms: string, code: string, body: DocumentedInfoLink): Promise<CommandResult> {
    const org = orgOf(principal);
    const actor = principal.user.id;
    return this.tenancy.withTenant(tenantContextOf(principal), async (trx) => {
      const system = await this.records.resolveMs(trx, ms);
      if (!(await packDocumentCodes(trx, system.id)).has(code)) {
        throw new NotFoundError(`${code} is not a document code of the edition in use`);
      }
      // One change of a code's link at a time.
      await sql`select pg_advisory_xact_lock(hashtextextended(${`document-code-link:${system.id}:${code}`}, 0))`.execute(trx);
      const { rows: current } = await sql<{ id: string; document_id: string; doc_code: string }>`
        select k.id, k.document_id, d.doc_code from document_code_link k join document d on d.id = k.document_id
         where k.management_system_id = ${system.id} and k.pack_code = ${code} and k.deleted_at is null for update of k`.execute(trx);
      const existing = current[0] ?? null;

      let target: { id: string; doc_code: string } | null = null;
      if (body.documentId !== null) {
        const { rows } = await sql<{ id: string; doc_code: string }>`
          select d.id, d.doc_code from document d
           where d.id = ${body.documentId} and d.deleted_at is null
             and (d.is_org_wide or exists (select 1 from entity_ms_link l where l.entity_type = 'document' and l.entity_id = d.id
                                             and l.management_system_id = ${system.id} and l.deleted_at is null))`.execute(trx);
        target = rows[0] ?? null;
        if (!target) {
          throw unprocessable(
            'documented_info.unknown_document',
            'The document is not registered for this management system',
            'Dokumen tidak terdaftar untuk sistem manajemen ini',
          );
        }
      }
      if ((existing?.document_id ?? null) === (target?.id ?? null)) {
        return commandResult([system.slug], { message: ['Nothing to change', 'Tidak ada yang diubah'], data: { code, documentId: target?.id ?? null } });
      }
      let linkId = existing?.id ?? null;
      if (existing && target) {
        await sql`update document_code_link set document_id = ${target.id}, updated_at = now(), updated_by = ${actor} where id = ${existing.id}`.execute(trx);
      } else if (existing) {
        await sql`update document_code_link set deleted_at = now(), updated_at = now(), updated_by = ${actor} where id = ${existing.id}`.execute(trx);
      } else if (target) {
        const { rows } = await sql<{ id: string }>`
          insert into document_code_link (management_system_id, pack_code, document_id, created_by, updated_by)
          values (${system.id}, ${code}, ${target.id}, ${actor}, ${actor}) returning id`.execute(trx);
        linkId = rows[0]!.id;
      }
      await this.audit.record(trx, {
        action: 'document_code.linked',
        msId: system.id,
        entityType: 'document_code_link',
        entityId: linkId,
        entityCode: code,
        before: { pack_code: code, document: existing?.doc_code ?? null },
        after: { pack_code: code, document: target?.doc_code ?? null },
      });
      await this.queue.send(
        'readiness.recompute',
        { orgId: org.id, requestId: currentRequestId(), requestedBy: actor, payload: { msId: system.id } },
        { singletonKey: `rr:${org.id}:${system.id}`, startAfterSeconds: READINESS_DELAY_SECONDS, retryLimit: 3 },
        trx,
      );
      return commandResult([system.slug], { data: { code, documentId: target?.id ?? null } });
    });
  }

  // -------------------------------------------------------------------------------------------------------------
  // Helpers
  // -------------------------------------------------------------------------------------------------------------

  /** Live documents of the system: linked to it, or organisation-wide. */
  private async documentsOf(trx: Trx, system: MsRef): Promise<DocumentFacts[]> {
    const { rows } = await sql<DocumentFacts>`
      select d.id, d.doc_code, d.title, d.status, d.next_review_at, d.owner_user_id, ${shownHandle('u', 'ue')} as owner_handle, d.pending_holder_user_id,
             d.classification,
             (select array_agg(l2.management_system_id) from entity_ms_link l2
               where l2.entity_type = 'document' and l2.entity_id = d.id and l2.deleted_at is null) as ms_ids
        from document d
        left join platform.app_user u on u.id = d.owner_user_id
        ${erasedJoin('ue', 'd.owner_user_id')}
       where d.deleted_at is null
         and (d.is_org_wide or exists (select 1 from entity_ms_link l where l.entity_type = 'document' and l.entity_id = d.id
                                         and l.management_system_id = ${system.id} and l.deleted_at is null))
       order by d.position, d.doc_code`.execute(trx);
    return rows;
  }

  /** Live evidence of the requirement entries of the system, with the clause code of each target. */
  private async evidenceOf(trx: Trx, system: MsRef): Promise<EvidenceFacts[]> {
    const { rows } = await sql<EvidenceFacts>`
      select ev.id, ev.evidence_code, ev.title, ev.owner_user_id, ev.classification, ev.produced_at, ev.frequency_code, rq.requirement_code
        from evidence_target t
        join applicability_entry e on e.id = t.applicability_entry_id and e.deleted_at is null and e.target_type = 'requirement'
        join ref.requirement rq on rq.id = e.requirement_id
        join evidence ev on ev.id = t.evidence_id and ev.deleted_at is null
       where t.deleted_at is null and t.management_system_id = ${system.id}
       order by ev.position, ev.evidence_code`.execute(trx);
    return rows;
  }

  private async periodsOf(trx: Trx, system: MsRef): Promise<Map<string, number>> {
    const { rows } = await sql<{ code: string; period_days: number }>`
      select f.code, f.period_days from ref.evidence_frequency_rule f join management_system m on m.framework_version_id = f.framework_version_id
       where m.id = ${system.id}`.execute(trx);
    return new Map(rows.map((r) => [r.code, Number(r.period_days)]));
  }

  private async thresholdsOf(trx: Trx, system: MsRef): Promise<ThresholdRow[]> {
    const { rows } = await sql<{ management_system_id: string | null; frequency_code: string; fresh_grace_days: string; aging_factor: string; expired_factor: string }>`
      select management_system_id, frequency_code, fresh_grace_days, aging_factor, expired_factor from freshness_threshold
       where deleted_at is null and (management_system_id is null or management_system_id = ${system.id})`.execute(trx);
    return rows.map((t) => ({
      managementSystemId: t.management_system_id,
      frequencyCode: t.frequency_code,
      freshGraceDays: Number(t.fresh_grace_days),
      agingFactor: Number(t.aging_factor),
      expiredFactor: Number(t.expired_factor),
    }));
  }

  /** Owner scope and classification of a document (F.7, D-34). */
  private documentVisible(scope: ScopeContext, doc: DocumentFacts): boolean {
    return this.policy.recordVisible(scope, {
      ownerUserId: doc.owner_user_id,
      holderUserId: doc.pending_holder_user_id,
      classification: doc.classification,
      linkedMsIds: doc.ms_ids ?? [],
    });
  }

  /** Owner scope, classification and, for guest auditors, ready evidence packs. */
  private evidenceVisible(scope: ScopeContext, e: EvidenceFacts): boolean {
    return this.policy.recordVisible(scope, { ownerUserId: e.owner_user_id, classification: e.classification, evidenceId: e.id });
  }

  /** Q-8: Top Management sees owners and review dates of its own documents only; guest auditors never. */
  private holderShown(scope: ScopeContext, doc: DocumentFacts): boolean {
    if (scope.kind === 'external_auditor') return false;
    if (scope.kind === 'top_management') return doc.owner_user_id === scope.userId || doc.pending_holder_user_id === scope.userId;
    return true;
  }
}
