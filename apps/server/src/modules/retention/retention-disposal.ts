// What an approved disposal does (Milestone 3 D.8 "Dispose does", M3-06), in the approval's transaction:
// - file content kept in the Managed Vault is deleted through `gateway.objects.delete` (every stored version), and the
//   object row keeps its name, dates and hash with `content_disposed_at`, so every open and download path answers 404
//   `content_disposed`;
// - a file kept in the customer's own repository (SharePoint, Google Drive) is never deleted by MSCD: the object is
//   marked disposed the same way (MSCD no longer opens or checks it) and the record's owner gets a task in My Tasks
//   to delete the file there; "File removed" (`retention.reviews.file-removed`) records that it was done;
// - a record (audit event, finding, corrective action, management review, competence record) loses its content
//   (product owner decision 18, M3-13): with `writeRow` of registers/command-support.ts its free-text and person columns
//   are cleared (`DISPOSAL_CLEARS` of retention-model.ts, also in its child rows), it is marked deleted and disposed
//   (`deleted_at`, `disposed_at`), the item title of its retention reviews is removed, and every audit entry of the
//   record and of its child rows is redacted (`AuditRedactor`, mode `clear_disposed`) under one `privacy.audit_redacted`
//   attestation whose entity is the review; only then is it audited `record.disposed`, so that entry keeps its values;
// - a file that another live record still uses is kept (`keptInUse` of retention-items.ts, M3-13) and listed in
//   `record.disposed`; when no file of the item was deleted or handed to its owner, the review records the file action
//   `kept_in_use` instead of `none`, so the disposal register says the file stays (M3-15, `fileActionOf`).
// The vault delete is idempotent, so a disposal whose transaction fails after the delete can be approved again. An item
// can hold several vault objects (an evidence pack: archive, manifests and item copies), deleted one after the other:
// when a later delete fails (a bucket retention rule, the gateway down) the approval rolls back, but the content of the
// earlier objects is already gone. `DisposalProgress` collects every delete that succeeded, and the approval then marks
// those objects disposed in a transaction of its own (`markContentDeleted`, audited `record.disposed` with `completed`
// false), so they answer 404 `content_disposed` instead of a gateway error while the review waits to be approved again.
import { Inject, Injectable } from '@nestjs/common';
import type { DisposalFileAction, GatewayObjectRef } from '@mscd/shared';
import { sql } from 'kysely';
import { addDays } from '../../common/dates';
import { ConflictError, ProblemError } from '../../common/problems';
import {
  AUDIT_WRITER, GATEWAY_CLIENT, MEMBERSHIP_SERVICE, type AuditWriter, type GatewayClient, type MembershipService, type Trx,
} from '../../common/tokens';
import { AuditRedactor } from '../audit/audit-redactor';
import { writeRow } from '../registers/command-support';
import { StorageGatewayContext } from '../storage';
import { GatewayProblemError, deleteStoredObject } from '../storage/gateway-client';
import type { ItemFacts } from './retention-items';
import { DISPOSAL_CHILDREN, DISPOSAL_CLEARS, DISPOSED_ENTITY_TYPE, RECORD_TABLE_CLASSES, type DisposalTable } from './retention-model';

/** What stopped a disposal, for the audit entry of `markContentDeleted`: the problem's message key, else its name. */
function failureKey(error: unknown): string {
  if (error instanceof ProblemError && error.extras.messageKey) return error.extras.messageKey;
  return error instanceof Error ? error.name : 'unknown';
}

/** Days the owner of a file in a customer repository gets to delete it (the due date of the task). */
export const OWNER_TASK_DAYS = 30;

interface ObjectRow {
  id: string;
  storage_repository_id: string;
  external_item_id: string;
  external_version_id: string | null;
  hash_algorithm: GatewayObjectRef['hashAlgorithm'];
  hash_value: string | null;
  hash_source: GatewayObjectRef['hashSource'];
  folder_path: string | null;
  display_name: string | null;
  adapter: string;
  repository_name: string;
}

export interface DisposalInput {
  orgId: string;
  msId: string;
  review: { id: string; recordClass: ItemFacts['recordClass']; itemCode: string | null };
  item: ItemFacts;
  /** The approver (the disposal runs as the approval). */
  actor: string;
  reason: string | null;
  today: string;
  now: Date;
}

/** The vault deletes of a disposal that succeeded so far, filled as each one returns (see the header). */
export interface DisposalProgress {
  input: DisposalInput | null;
  vaultDeleted: { objectId: string; versions: number }[];
}

export interface DisposalResult {
  fileAction: DisposalFileAction;
  /** Vault objects whose content was deleted, with the stored versions removed. */
  vaultDeleted: { objectId: string; versions: number }[];
  /** Objects in a customer repository whose owner is asked to delete the file. */
  ownerAsked: { objectId: string; repository: string; name: string | null }[];
  /** The record was marked deleted by this disposal. */
  recordDeleted: boolean;
  /** Files of the item that another live record uses, kept (M3-13). */
  keptInUse: { objectId: string; code: string }[];
  /** The record's content was cleared and its audit entries redacted (records only). */
  contentCleared: boolean;
  /** The owner's task, when one was opened. */
  ownerTaskId: string | null;
}

/**
 * The file action a disposal records in the disposal register (J.7 `retention_review.file_action`): `owner_asked` when
 * a file in a customer repository is left to its owner, else `vault_content_deleted` when Managed Vault content was
 * deleted (by this approval or an earlier refused one), else `kept_in_use` when the item's files are all kept because
 * another live record uses them (M3-15), else `none` (the item has no file).
 */
export function fileActionOf(counts: { ownerAsked: number; vaultDeleted: number; keptInUse: number }): DisposalFileAction {
  if (counts.ownerAsked > 0) return 'owner_asked';
  if (counts.vaultDeleted > 0) return 'vault_content_deleted';
  if (counts.keptInUse > 0) return 'kept_in_use';
  return 'none';
}

@Injectable()
export class RetentionDisposal {
  constructor(
    private readonly storage: StorageGatewayContext,
    @Inject(GATEWAY_CLIENT) private readonly gateway: GatewayClient,
    @Inject(AUDIT_WRITER) private readonly audit: AuditWriter,
    @Inject(MEMBERSHIP_SERVICE) private readonly members: MembershipService,
    private readonly redactor: AuditRedactor,
  ) {}

  async dispose(trx: Trx, input: DisposalInput, progress: DisposalProgress = { input: null, vaultDeleted: [] }): Promise<DisposalResult> {
    const { item, actor, now } = input;
    progress.input = input;
    const objects = await this.objects(trx, item.objectIds);
    const vaultDeleted: DisposalResult['vaultDeleted'] = [];
    const ownerAsked: DisposalResult['ownerAsked'] = [];
    for (const object of objects) {
      if (object.adapter === 'managed_vault') {
        const deleted = { objectId: object.id, versions: await this.deleteFromVault(trx, input.orgId, object, item.code) };
        vaultDeleted.push(deleted);
        progress.vaultDeleted.push(deleted);
      } else {
        ownerAsked.push({ objectId: object.id, repository: object.repository_name, name: object.display_name });
      }
    }
    if (objects.length > 0) {
      await trx
        .updateTable('storage_object')
        .set({ content_disposed_at: now, content_disposed_by: actor, updated_at: now, updated_by: actor })
        .where('id', 'in', objects.map((o) => o.id))
        .execute();
    }

    const table = RECORD_TABLE_CLASSES[item.recordClass] as DisposalTable | undefined;
    const recordDeleted = Boolean(table) && !item.recordDeleted;
    let redaction: { redactionId: string; redacted: number } | null = null;
    if (table) redaction = await this.clearRecord(trx, input, table);

    const ownerTaskId = ownerAsked.length > 0 ? await this.askOwner(trx, input, ownerAsked) : null;
    // Vault objects of this review whose content an earlier, refused approval already deleted (markContentDeleted).
    const earlier = await this.earlierVaultObjects(trx, input);
    const fileAction = fileActionOf({ ownerAsked: ownerAsked.length, vaultDeleted: vaultDeleted.length + earlier.length, keptInUse: item.keptInUse.length });

    await this.audit.record(trx, {
      action: 'record.disposed',
      msId: input.msId,
      entityType: DISPOSED_ENTITY_TYPE[item.recordClass],
      entityId: item.itemId,
      entityCode: item.code,
      before: table ? { deleted: item.recordDeleted } : { contentDisposed: false },
      after: {
        ...(table ? { deleted: true } : { contentDisposed: true }),
        recordClass: item.recordClass,
        reviewId: input.review.id,
        fileAction,
        ...(input.reason ? { reason: input.reason } : {}),
        ...(vaultDeleted.length > 0 ? { vaultObjects: vaultDeleted.map((v) => v.objectId) } : {}),
        ...(earlier.length > 0 ? { earlierVaultObjects: earlier } : {}),
        ...(ownerAsked.length > 0 ? { ownerAsked: ownerAsked.map((o) => ({ objectId: o.objectId, repository: o.repository })) } : {}),
        ...(item.keptInUse.length > 0 ? { keptInUse: item.keptInUse.map((k) => ({ objectId: k.objectId, usedBy: k.code })) } : {}),
        ...(redaction ? { contentCleared: true, auditEntriesCleared: redaction.redacted, redactionId: redaction.redactionId } : {}),
      },
    });
    return { fileAction, vaultDeleted, ownerAsked, recordDeleted, ownerTaskId, keptInUse: item.keptInUse, contentCleared: redaction !== null };
  }

  /**
   * Decision 18 for a record: its free-text and person columns and those of its child rows are cleared, it is marked
   * deleted (unless it was already) and disposed, the item title of its retention reviews is removed, and the audit
   * entries of the record and of its child rows are redacted under one attestation (mode `clear_disposed`).
   */
  private async clearRecord(trx: Trx, input: DisposalInput, table: DisposalTable): Promise<{ redactionId: string; redacted: number }> {
    const { item, actor, now } = input;
    const clears = DISPOSAL_CLEARS[table];
    await writeRow(trx, table, item.itemId, {
      ...Object.fromEntries(clears.nulls.map((c) => [c, null])),
      ...clears.texts,
      deleted_at: item.recordDeleted ? sql`coalesce(deleted_at, ${now})` : now,
      disposed_at: now,
    }, actor);
    const children: { type: string; ids: string[] }[] = [];
    for (const child of DISPOSAL_CHILDREN[table] ?? []) {
      const childClears = DISPOSAL_CLEARS[child.table];
      const assignments = [
        ...childClears.nulls.map((c) => sql`${sql.ref(c)} = null`),
        ...Object.entries(childClears.texts).map(([c, v]) => sql`${sql.ref(c)} = ${v}`),
        sql`updated_by = ${actor}`,
        sql`updated_at = greatest(clock_timestamp(), updated_at + interval '1 millisecond')`,
      ];
      const { rows } = await sql<{ id: string }>`
        update ${sql.table(child.table)} set ${sql.join(assignments)}
         where ${sql.ref(child.parentColumn)} = ${item.itemId} returning id`.execute(trx);
      children.push({ type: child.table, ids: rows.map((r) => r.id) });
    }
    await trx
      .updateTable('retention_review')
      .set({ item_title: null })
      .where('record_class', '=', item.recordClass)
      .where('item_id', '=', item.itemId)
      .execute();
    const childIds = children.flatMap((c) => c.ids);
    const { rows: entries } = await sql<{ seq: string }>`
      select seq::text as seq from audit_trail
       where (entity_type = ${table} and entity_id = ${item.itemId})
          ${childIds.length > 0
            ? sql`or (entity_type = any(${children.map((c) => c.type)}::text[]) and entity_id = any(${childIds}::uuid[]))`
            : sql``}
       order by seq`.execute(trx);
    const result = await this.redactor.redact(trx, {
      chain: { schema: await schemaOf(trx) },
      mode: 'clear_disposed',
      seqs: entries.map((e) => e.seq),
      replacements: {},
      attestation: {
        action: 'privacy.audit_redacted',
        reason: `Disposal of ${item.code}, retention review ${input.review.id}`,
        entityType: 'retention_review',
        entityId: input.review.id,
        entityCode: item.code.slice(0, 80),
        actor: { userId: actor, kind: 'user' },
      },
    });
    return { redactionId: result.redactionId, redacted: result.redacted };
  }

  /**
   * After a refused or failed approval: marks the vault objects whose content was already deleted as disposed, in a
   * transaction of its own (the approval's rolled back), audited `record.disposed` with `completed` false. Objects
   * already marked are left as they are. Returns the objects marked now.
   */
  async markContentDeleted(trx: Trx, progress: DisposalProgress, failure: unknown): Promise<string[]> {
    const input = progress.input;
    const ids = [...new Set(progress.vaultDeleted.map((v) => v.objectId))];
    if (!input || ids.length === 0) return [];
    const { item, actor, now } = input;
    const marked = await trx
      .updateTable('storage_object')
      .set({ content_disposed_at: now, content_disposed_by: actor, updated_at: now, updated_by: actor })
      .where('id', 'in', ids)
      .where('content_disposed_at', 'is', null)
      .returning('id')
      .execute();
    if (marked.length === 0) return [];
    const objectIds = marked.map((m) => m.id).sort();
    await this.audit.record(trx, {
      action: 'record.disposed',
      msId: input.msId,
      entityType: DISPOSED_ENTITY_TYPE[item.recordClass],
      entityId: item.itemId,
      entityCode: item.code,
      before: { contentDisposed: false },
      after: {
        contentDisposed: 'partial',
        completed: false,
        recordClass: item.recordClass,
        reviewId: input.review.id,
        fileAction: 'vault_content_deleted',
        vaultObjects: objectIds,
        failure: failureKey(failure),
      },
    });
    return objectIds;
  }

  /** Vault objects of the review's item that an earlier, refused approval disposed of (markContentDeleted). */
  private async earlierVaultObjects(trx: Trx, input: DisposalInput): Promise<string[]> {
    const { rows } = await sql<{ id: string }>`
      select distinct jsonb_array_elements_text(a.after_data->'vaultObjects') as id from audit_trail a
       where a.action = 'record.disposed' and a.entity_type = ${DISPOSED_ENTITY_TYPE[input.item.recordClass]} and a.entity_id = ${input.item.itemId}
         and a.after_data->>'reviewId' = ${input.review.id} and a.after_data->>'completed' = 'false'
       order by 1`.execute(trx);
    return rows.map((r) => r.id);
  }

  /** The objects of an item whose content is still there, with their repository. */
  private async objects(trx: Trx, ids: readonly string[]): Promise<ObjectRow[]> {
    if (ids.length === 0) return [];
    const { rows } = await sql<ObjectRow>`
      select o.id, o.storage_repository_id, o.external_item_id, o.external_version_id, o.hash_algorithm, o.hash_value, o.hash_source,
             o.folder_path, o.display_name, r.adapter, r.name as repository_name
        from storage_object o join storage_repository r on r.id = o.storage_repository_id
       where o.id = any(${[...ids]}::uuid[]) and o.content_disposed_at is null
       order by o.id
       for update of o`.execute(trx);
    return rows;
  }

  /**
   * Removes every stored version of a vault object (`gateway.objects.delete`). A version that a retention rule of the
   * bucket still protects makes the gateway answer `forbidden`: the disposal is refused with 409 and may be approved
   * again after that date. Any other failure is an error to retry.
   */
  private async deleteFromVault(trx: Trx, orgId: string, object: ObjectRow, code: string): Promise<number> {
    const repository = await trx.selectFrom('storage_repository').selectAll().where('id', '=', object.storage_repository_id).executeTakeFirstOrThrow();
    try {
      const result = await deleteStoredObject(this.gateway, {
        tenant: await this.storage.tenant(trx, orgId),
        repository: await this.storage.repository(trx, repository, { withCredential: false }),
        object: {
          externalItemId: object.external_item_id,
          externalVersionId: object.external_version_id,
          hashAlgorithm: object.hash_algorithm,
          hashValue: object.hash_value,
          hashSource: object.hash_source,
          folderPath: object.folder_path,
        },
      });
      return result.versions;
    } catch (error) {
      if (error instanceof GatewayProblemError && error.gatewaySlug === 'forbidden') {
        const until = /until (\S+?)(;|$)/.exec(error.gatewayDetail ?? '')?.[1] ?? null;
        throw new ConflictError(`A retention rule of the storage bucket keeps the file of ${code}${until ? ` until ${until}` : ''}`, {
          messageKey: 'retention.kept_by_bucket_rule',
          messages: {
            en: `The file storage is set to keep the file of ${code}${until ? ` until ${until.slice(0, 10)}` : ''}, so it cannot be deleted yet. Approve the disposal again after that date.`,
            id: `Penyimpanan berkas diatur untuk menahan berkas ${code}${until ? ` sampai ${until.slice(0, 10)}` : ''}, sehingga belum dapat dihapus. Setujui pemusnahan lagi setelah tanggal tersebut.`,
          },
        });
      }
      throw error;
    }
  }

  /**
   * The owner of the record gets a task to delete the file in the customer's repository (source `manual`, on the
   * review, so "File removed" closes it). An owner who is no longer a member leaves the task unassigned.
   */
  private async askOwner(trx: Trx, input: DisposalInput, files: DisposalResult['ownerAsked']): Promise<string> {
    const owner = input.item.ownerUserId && (await this.members.isMember(trx, input.item.ownerUserId)) ? input.item.ownerUserId : null;
    const code = input.item.code;
    const where = [...new Set(files.map((f) => f.repository))].join(', ');
    const row = await trx
      .insertInto('task')
      .values({
        management_system_id: input.msId,
        source_rule: 'manual',
        entity_type: 'retention_review',
        entity_id: input.review.id,
        entity_code: code.slice(0, 80),
        title_en: `Delete the disposed file of ${code} from ${where}, then tell the Management System Manager`,
        title_id: `Hapus berkas ${code} yang dimusnahkan dari ${where}, lalu beri tahu Management System Manager`,
        owner_user_id: owner,
        due_at: addDays(input.today, OWNER_TASK_DAYS),
        status: 'open',
        created_by: input.actor,
        updated_by: input.actor,
      })
      .onConflict((oc) => oc.columns(['source_rule', 'entity_type', 'entity_id']).where('status', '=', 'open').where('deleted_at', 'is', null).doNothing())
      .returning('id')
      .executeTakeFirst();
    if (row) return row.id;
    const open = await trx
      .selectFrom('task')
      .select('id')
      .where('source_rule', '=', 'manual')
      .where('entity_type', '=', 'retention_review')
      .where('entity_id', '=', input.review.id)
      .where('status', '=', 'open')
      .executeTakeFirstOrThrow();
    return open.id;
  }
}

/** The schema of the transaction's organisation (`withTenant` puts it first on the search path). */
async function schemaOf(trx: Trx): Promise<string> {
  const { rows } = await sql<{ schema: string }>`select current_schema() as schema`.execute(trx);
  const schema = rows[0]?.schema;
  if (!schema || !schema.startsWith('org_')) throw new Error('No organisation schema in the transaction');
  return schema;
}
