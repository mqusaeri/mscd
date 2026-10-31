// A person's own read confirmations (Milestone 3 D.1, D.7 "Confirming"): the open and recent confirmations of the
// current organisation, opening the version to read (`opened_at`), and the confirmation, refused before opening with
// rule `ACK-OPEN-FIRST` (H.7: open first, a checkbox and a button, no typed name). Every route acts on the caller's own
// rows only: another person's row is 404.
//
// Opening (D.7): the address is short-lived and names only the version of the request.
// - A file the api streams (Managed Vault, pass-through): the content route of the system in which the person may read
//   it. A person without file rights there cannot read Managed Vault content through the existing routes, so the route
//   refuses with `acknowledgements.file_not_readable` and records nothing. Follow-up 1 of the M3-05 handoff lifts this:
//   a redirect token that names the person's row, which the file routes accept when `acknowledgementFileGrant`
//   (acknowledgement-file-grant.ts) passes.
// - A file kept in the customer's repository: the api's redirect (token of `files/redirect-token.ts`) for a person
//   who may read the file in MSCD, else the provider's address itself, where the person's own access applies.
// The open is audited as `acknowledgement.opened` and `file.opened`; `opened_at` keeps the first time.
import { Inject, Injectable } from '@nestjs/common';
import type { CommandResult, GatewayObjectRef, MyAcknowledgementItem, ObjectOpenResponse, OpenUrlResult } from '@mscd/shared';
import { sql } from 'kysely';
import { Clock } from '../../common/clock';
import { BusinessRuleError, NotFoundError, ProblemError } from '../../common/problems';
import {
  AUDIT_WRITER, GATEWAY_CLIENT, PERMISSION_EVALUATOR, type AuditWriter, type GatewayClient, type PermissionEvaluator, type Principal, type Trx,
} from '../../common/tokens';
import { ScopePolicyService } from '../authz/scope-policy';
import { viaGateway } from '../files/files-support';
import { assertContentNotDisposed, streamsContent } from '../files/object-access.service';
import { RedirectTokens } from '../files/redirect-token';
import { ruleMessageKey, ruleMessages } from '../rules';
import { StorageGatewayContext, type RepositoryRow } from '../storage';
import { TenantScope, tenantContextOf } from '../tenancy/tenant-scope';
import { REFUSALS } from './acknowledgement-text';
import { closeTasks, conflict, refusal } from './acknowledgement.service';
import { orgOf } from './acknowledgement-requests.service';

/** How long the address of an open is offered (the content and redirect routes check again at use). */
const OPEN_URL_TTL_MS = 5 * 60 * 1000;

/** How far back confirmed and excused rows stay in the person's list. */
const RECENT_DAYS = 180;

interface MineRow {
  id: string;
  acknowledgement_request_id: string;
  status: 'pending' | 'confirmed' | 'excused';
  opened_at: Date | null;
  confirmed_at: Date | null;
  due_on: string;
  request_status: 'open' | 'closed';
  doc_code: string;
  title: string;
  version_label: string;
  ms: string;
}

interface OwnRow {
  id: string;
  user_id: string;
  status: 'pending' | 'confirmed' | 'excused';
  opened_at: Date | null;
  request_id: string;
  request_status: 'open' | 'closed';
  request_ms_id: string;
  document_id: string;
  doc_code: string;
  is_org_wide: boolean;
  version_label: string;
  storage_object_id: string | null;
  task_ms_id: string | null;
  task_ms_slug: string | null;
}

interface ObjectRow {
  id: string;
  storage_repository_id: string;
  external_item_id: string;
  external_version_id: string | null;
  display_name: string | null;
  hash_algorithm: GatewayObjectRef['hashAlgorithm'];
  hash_value: string | null;
  hash_source: GatewayObjectRef['hashSource'];
  folder_path: string | null;
}

@Injectable()
export class MeAcknowledgementsService {
  constructor(
    private readonly tenancy: TenantScope,
    private readonly clock: Clock,
    private readonly policy: ScopePolicyService,
    private readonly storage: StorageGatewayContext,
    private readonly tokens: RedirectTokens,
    @Inject(GATEWAY_CLIENT) private readonly gateway: GatewayClient,
    @Inject(PERMISSION_EVALUATOR) private readonly evaluator: PermissionEvaluator,
    @Inject(AUDIT_WRITER) private readonly audit: AuditWriter,
  ) {}

  // -------------------------------------------------------------------------------------------------------------
  // GET /me/acknowledgements
  // -------------------------------------------------------------------------------------------------------------

  /** Pending confirmations of open requests first (by due date), then the confirmed and excused ones of the last 180 days. */
  async list(principal: Principal): Promise<MyAcknowledgementItem[]> {
    const org = orgOf(principal);
    return this.tenancy.withTenant(tenantContextOf(principal), async (trx) => {
      const today = this.clock.todayIn(org.timeZone);
      const { rows } = await sql<MineRow>`
        select a.id, a.acknowledgement_request_id, a.status, a.opened_at, a.confirmed_at, r.due_on, r.status as request_status,
               d.doc_code, d.title, v.version_label, coalesce(tm.slug, rm.slug) as ms
          from acknowledgement a
          join acknowledgement_request r on r.id = a.acknowledgement_request_id and r.deleted_at is null
          join document d on d.id = r.document_id
          join document_version v on v.id = r.document_version_id
          join management_system rm on rm.id = r.management_system_id
          left join lateral (
            select m.slug from task t join management_system m on m.id = t.management_system_id and m.deleted_at is null
             where t.source_rule = 'acknowledgement' and t.entity_type = 'acknowledgement' and t.entity_id = a.id and t.deleted_at is null
             order by t.created_at desc limit 1) tm on true
         where a.user_id = ${principal.user.id}::uuid and a.deleted_at is null
           and ((a.status = 'pending' and r.status = 'open')
                or (a.status <> 'pending' and a.updated_at > now() - make_interval(days => ${RECENT_DAYS})))
         order by (a.status = 'pending') desc, case when a.status = 'pending' then r.due_on end, a.updated_at desc, a.id
         limit 200`.execute(trx);
      return rows.map((r) => ({
        id: r.id,
        requestId: r.acknowledgement_request_id,
        ms: r.ms,
        document: { code: r.doc_code, title: r.title },
        versionLabel: r.version_label,
        status: r.status,
        dueOn: r.due_on,
        openedAt: r.opened_at ? new Date(r.opened_at).toISOString() : null,
        confirmedAt: r.confirmed_at ? new Date(r.confirmed_at).toISOString() : null,
        overdue: r.status === 'pending' && r.due_on < today,
      }));
    });
  }

  // -------------------------------------------------------------------------------------------------------------
  // POST /me/acknowledgements/{id}/open
  // -------------------------------------------------------------------------------------------------------------

  async open(principal: Principal, id: string): Promise<ObjectOpenResponse> {
    const org = orgOf(principal);
    return this.tenancy.withTenant(tenantContextOf(principal), async (trx) => {
      const row = await ownRow(trx, principal.user.id, id);
      if (row.status === 'excused') throw conflict(REFUSALS.excused);
      if (row.status === 'pending' && row.request_status !== 'open') throw conflict(REFUSALS.requestClosed);
      if (!row.storage_object_id) throw refusal(REFUSALS.noFile);
      const objectId = row.storage_object_id;
      await assertContentNotDisposed(trx, objectId);
      const object = await trx
        .selectFrom('storage_object')
        .select(['id', 'storage_repository_id', 'external_item_id', 'external_version_id', 'display_name', 'hash_algorithm', 'hash_value', 'hash_source', 'folder_path'])
        .where('id', '=', objectId)
        .where('deleted_at', 'is', null)
        .executeTakeFirst() as ObjectRow | undefined;
      if (!object) throw refusal(REFUSALS.noFile);
      const repository = await trx.selectFrom('storage_repository').selectAll().where('id', '=', object.storage_repository_id).executeTakeFirstOrThrow() as RepositoryRow;
      const now = this.clock.now();
      const readable = await this.readableSystem(trx, principal, row, objectId);
      let url: string;
      let via: 'content' | 'redirect' | 'provider';
      if (streamsContent({ hash_source: object.hash_source }, repository)) {
        if (!readable) throw refusal(REFUSALS.fileNotReadable);
        url = `/api/v1/storage/objects/${object.id}/content?ms=${encodeURIComponent(readable)}&inline=true`;
        via = 'content';
      } else if (readable) {
        const issued = this.tokens.issue({ u: principal.user.id, g: org.id, m: readable, o: object.id }, now);
        url = `/api/v1/storage/objects/${object.id}/redirect?t=${issued.token}`;
        via = 'redirect';
      } else {
        const tenant = await this.storage.tenant(trx, org.id);
        const descriptor = await this.storage.repository(trx, repository);
        const result = await viaGateway(repository, () =>
          this.gateway.post<OpenUrlResult>('/v1/open-url', { tenant, repository: descriptor, object: objectRef(object) }),
        );
        url = result.url;
        via = 'provider';
      }
      if (!row.opened_at) {
        await trx.updateTable('acknowledgement').set({ opened_at: now, updated_by: principal.user.id }).where('id', '=', row.id).execute();
      }
      const msId = row.task_ms_id ?? row.request_ms_id;
      await this.audit.record(trx, {
        action: 'acknowledgement.opened',
        msId,
        entityType: 'acknowledgement',
        entityId: row.id,
        entityCode: row.doc_code,
        after: { document: row.doc_code, version: row.version_label, via, first: !row.opened_at },
      });
      await this.audit.record(trx, {
        action: 'file.opened',
        msId,
        entityType: 'storage_object',
        entityId: object.id,
        entityCode: object.display_name,
        after: { via: 'acknowledgement', repository: repository.slug, records: [`document:${row.doc_code}`] },
      });
      return { url, expiresAt: new Date(now.getTime() + OPEN_URL_TTL_MS).toISOString() };
    });
  }

  // -------------------------------------------------------------------------------------------------------------
  // POST /me/acknowledgements/{id}/confirm
  // -------------------------------------------------------------------------------------------------------------

  async confirm(principal: Principal, id: string): Promise<CommandResult> {
    const actor = principal.user.id;
    return this.tenancy.withTenant(tenantContextOf(principal), async (trx) => {
      const row = await ownRow(trx, actor, id);
      if (row.status === 'confirmed') throw conflict(REFUSALS.confirmed);
      if (row.status === 'excused') throw conflict(REFUSALS.excused);
      if (row.request_status !== 'open') throw conflict(REFUSALS.requestClosed);
      if (!row.opened_at) {
        // H.7: the person opens the version before confirming it.
        throw new BusinessRuleError('ACK-OPEN-FIRST', ruleMessages('ACK-OPEN-FIRST', { document: row.doc_code }), undefined, {
          messageKey: ruleMessageKey('ACK-OPEN-FIRST'),
        });
      }
      await trx
        .updateTable('acknowledgement')
        .set({ status: 'confirmed', confirmed_at: sql<Date>`now()`, updated_by: actor })
        .where('id', '=', row.id)
        .execute();
      await closeTasks(trx, [row.id], 'done', actor);
      await this.audit.record(trx, {
        action: 'acknowledgement.confirmed',
        msId: row.task_ms_id ?? row.request_ms_id,
        entityType: 'acknowledgement',
        entityId: row.id,
        entityCode: row.doc_code,
        before: { status: 'pending' },
        after: { status: 'confirmed', document: row.doc_code, version: row.version_label },
      });
      return {
        ok: true,
        changed: row.task_ms_slug ? [row.task_ms_slug] : [],
        message: [`You confirmed ${row.doc_code} version ${row.version_label}`, `Anda telah mengonfirmasi ${row.doc_code} versi ${row.version_label}`],
      };
    });
  }

  // -------------------------------------------------------------------------------------------------------------
  // Helpers
  // -------------------------------------------------------------------------------------------------------------

  /**
   * A system the document counts in where the person may read the version's file through the existing file routes
   * (`storage.object.read` there and the scope policy's `canReadObjectIn`, F.7): the task's system first, then the
   * request's, then the others by slug. Null when there is none.
   */
  private async readableSystem(trx: Trx, principal: Principal, row: OwnRow, objectId: string): Promise<string | null> {
    const { rows } = await sql<{ id: string; slug: string }>`
      select m.id, m.slug from management_system m
       where m.deleted_at is null
         and (${row.is_org_wide}::boolean
              or exists (select 1 from entity_ms_link l where l.entity_type = 'document' and l.entity_id = ${row.document_id}::uuid
                           and l.management_system_id = m.id and l.deleted_at is null))
       order by (m.id = ${row.task_ms_id}::uuid) desc nulls last, (m.id = ${row.request_ms_id}::uuid) desc, m.slug`.execute(trx);
    for (const system of rows) {
      if (!(await this.evaluator.evaluate(principal, 'storage.object.read', { scope: 'ms', ms: system.slug }))) continue;
      try {
        const ctx = await this.policy.scopeContext(trx, principal, system.slug);
        if (await this.policy.canReadObjectIn(trx, ctx, objectId)) return system.slug;
      } catch (error) {
        // No role in that system (403) or a system the session cannot see (404): try the next one.
        if (!(error instanceof ProblemError) || ![403, 404].includes(error.status)) throw error;
      }
    }
    return null;
  }
}

/** The caller's own row with its request, document and version; 404 for anyone else's. */
async function ownRow(trx: Trx, userId: string, id: string): Promise<OwnRow> {
  if (!/^[0-9a-f-]{36}$/i.test(id)) throw new NotFoundError();
  const { rows } = await sql<OwnRow>`
    select a.id, a.user_id, a.status, a.opened_at, r.id as request_id, r.status as request_status, r.management_system_id as request_ms_id,
           d.id as document_id, d.doc_code, d.is_org_wide, v.version_label, v.storage_object_id, t.ms_id as task_ms_id, t.ms_slug as task_ms_slug
      from acknowledgement a
      join acknowledgement_request r on r.id = a.acknowledgement_request_id and r.deleted_at is null
      join document d on d.id = r.document_id
      join document_version v on v.id = r.document_version_id
      left join lateral (
        select t.management_system_id as ms_id, m.slug as ms_slug from task t join management_system m on m.id = t.management_system_id
         where t.source_rule = 'acknowledgement' and t.entity_type = 'acknowledgement' and t.entity_id = a.id and t.deleted_at is null
         order by t.created_at desc limit 1) t on true
     where a.id = ${id}::uuid and a.user_id = ${userId}::uuid and a.deleted_at is null
     for update of a`.execute(trx);
  const row = rows[0];
  if (!row) throw new NotFoundError();
  return row;
}

/** The stored facts of an object that gateway calls compare with the provider (D.5 `GatewayObjectRef`). */
function objectRef(object: ObjectRow): GatewayObjectRef {
  return {
    externalItemId: object.external_item_id,
    externalVersionId: object.external_version_id,
    hashAlgorithm: object.hash_algorithm,
    hashValue: object.hash_value,
    hashSource: object.hash_source,
    folderPath: object.folder_path,
  };
}
