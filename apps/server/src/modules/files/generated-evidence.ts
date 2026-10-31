// Evidence files the server writes itself (Milestone 3 D.7, D.9): the read confirmation register that closes a request
// (M3-05) and the access review report of each system (M3-07) become a new file of an evidence item.
//
// `attachEvidenceFile` is the one code path that makes a stored object the current file of an evidence item. The route
// `POST /ms/{ms}/evidence/{id}/files` (`FileCommandsService.evidenceFile`) and `fileGeneratedEvidence` both call it:
// the file sequence and the vault label, the evidence's freshness and integrity in the same transaction, the warnings
// BR-30, BR-36 and BR-23, the audit entry (`evidence.file_linked` or `evidence.file_uploaded`), and the
// `freshness.recompute`, `readiness.recompute` and `cycle.derive` jobs of every system the evidence counts in.
//
// `fileGeneratedEvidence` stores the bytes first, in the repository and mode that the routing rules choose for evidence
// of the system (as an upload intent would), through `PUT /v1/objects`, then attaches the new object in the caller's
// transaction. The gateway call runs inside that transaction, so it is meant for small files such as a CSV register.
import { Readable } from 'node:stream';
import type { ActorKind, PutHeader, PutResult, UploadMode } from '@mscd/shared';
import { sql } from 'kysely';
import type { Clock } from '../../common/clock';
import { addDays, localDate } from '../../common/dates';
import { NotFoundError } from '../../common/problems';
import type { AuditWriter, GatewayClient, JobQueue, Trx } from '../../common/tokens';
import { enqueueDerived } from '../implementation/readiness/readiness-queue';
import { crossSystemNonReusable } from '../risk-registers/rules';
import type { RepositoryRow, RoutingService, StorageGatewayContext } from '../storage';
import { deriveEvidence } from './evidence-state';
import {
  assertRepositoryUsable,
  refusal,
  scopeRootOf,
  storedFileName,
  uploadFolder,
  viaGateway,
  warning,
  type AdapterAvailability,
  type Warning,
} from './files-support';
import { insertUploadedObject, type NewObject } from './storage-objects';

/** Upload modes in which the server sends the bytes itself (zero-transit uploads go from the browser to the provider). */
const SERVER_UPLOAD_MODES: readonly UploadMode[] = ['stored', 'pass_through'];

/** E.2: producers debounce `freshness.recompute` by 5 seconds; one waiting job per organisation and system. */
export const FRESHNESS_DELAY_SECONDS = 5;

/** Who files a generated evidence file: the user of the request, or the system user for a job (with its kind). */
export interface EvidenceFileActor {
  userId: string;
  kind: ActorKind;
}

/** The evidence row that receives a file, read with a row lock by the caller. */
export interface EvidenceFileTarget {
  id: string;
  evidence_code: string;
  produced_at: string | null;
  storage_object_id: string | null;
  file_sequence: number;
  frequency_code: string;
}

export interface AttachEvidenceFileInput {
  org: { id: string; timeZone: string };
  /** The system of the audit entry (the route's system, or the system the generated file belongs to). */
  msId: string;
  evidence: EvidenceFileTarget;
  object: NewObject;
  repository: RepositoryRow;
  /** `relink` keeps the file sequence (a file that cannot be verified is replaced); `submit` counts a new file. */
  mode: 'submit' | 'relink';
  /** The request's source, or `generated` for a file the server wrote. */
  source: 'link' | 'upload' | 'client_upload' | 'generated';
  producedAt: string;
  today: string;
  now: Date;
  /** The user who files it; the jobs it queues name this user as requester. */
  userId: string;
  /** The audit actor; absent: the request's user (the route). */
  actor?: EvidenceFileActor;
  /** Extra facts of the audit entry's `after`. */
  auditAfter?: Record<string, unknown>;
}

export interface AttachEvidenceFileResult {
  sequence: number;
  versionLabel: string | null;
  updatedAt: Date;
  systems: { ids: string[]; slugs: string[] };
  warnings: Warning[];
}

/** The systems an evidence item counts in: its links and its targets. */
export async function evidenceSystemsOf(trx: Trx, evidenceId: string): Promise<{ ids: string[]; slugs: string[] }> {
  const { rows } = await sql<{ id: string; slug: string }>`
    select distinct ms.id, ms.slug, ms.position from management_system ms
     where ms.deleted_at is null
       and (exists (select 1 from entity_ms_link l where l.entity_type = 'evidence' and l.entity_id = ${evidenceId}
                      and l.management_system_id = ms.id and l.deleted_at is null)
            or exists (select 1 from evidence_target t where t.evidence_id = ${evidenceId}
                         and t.management_system_id = ms.id and t.deleted_at is null))
     order by ms.position, ms.slug`.execute(trx);
  return { ids: rows.map((r) => r.id), slugs: rows.map((r) => r.slug) };
}

/**
 * Makes `object` the current file of the evidence item (the shared step of `evidenceFile` and `fileGeneratedEvidence`):
 * the file sequence and the vault label, freshness and integrity, warnings, the audit entry and the queued jobs.
 */
export async function attachEvidenceFile(
  trx: Trx,
  deps: { audit: AuditWriter; jobs: JobQueue },
  input: AttachEvidenceFileInput,
): Promise<AttachEvidenceFileResult> {
  const { evidence: row, object, repository, now } = input;
  const sequence = input.mode === 'relink' ? Math.max(row.file_sequence, 1) : row.file_sequence + 1;
  if (repository.adapter === 'managed_vault') {
    // D-10 vault objects are immutable; their label is the evidence's file sequence (WP-13 handoff deviation 3).
    await trx.updateTable('storage_object').set({ version_label: `v${sequence}`, updated_at: now }).where('id', '=', object.id).execute();
    object.versionLabel = `v${sequence}`;
  }
  const stored = await trx
    .selectFrom('storage_object')
    .select(['link_status', 'hash_algorithm', 'hash_source', 'link_status_since', 'link_status_reason'])
    .where('id', '=', object.id)
    .executeTakeFirstOrThrow();
  const derived = await deriveEvidence(trx, {
    evidenceId: row.id,
    frequencyCode: row.frequency_code,
    producedAt: input.producedAt,
    object: {
      linkStatus: stored.link_status,
      hashAlgorithm: stored.hash_algorithm,
      hashSource: stored.hash_source,
      linkStatusSince: stored.link_status_since,
      linkStatusReason: stored.link_status_reason,
    },
    today: input.today,
    now,
  });
  const updated = await trx
    .updateTable('evidence')
    .set({
      storage_object_id: object.id,
      produced_at: input.producedAt,
      file_sequence: sequence,
      freshness_status: derived.freshness,
      integrity_status: derived.integrity,
      derived_at: now,
      updated_at: now,
      updated_by: input.userId,
    })
    .where('id', '=', row.id)
    .returning(['updated_at'])
    .executeTakeFirstOrThrow();

  const warnings: Warning[] = [];
  if (repository.ownership_type === 'personal') warnings.push(warning('BR-30'));
  if (object.providerCreatedAt && input.producedAt > addDays(localDate(object.providerCreatedAt, input.org.timeZone), 1)) warnings.push(warning('BR-36'));
  if (await crossSystemNonReusable(trx, row.id)) warnings.push(warning('BR-23'));

  const systems = await evidenceSystemsOf(trx, row.id);
  await deps.audit.record(trx, {
    action: input.source === 'link' ? 'evidence.file_linked' : 'evidence.file_uploaded',
    ...(input.actor ? { actor: input.actor } : {}),
    msId: input.msId,
    entityType: 'evidence',
    entityId: row.id,
    entityCode: row.evidence_code,
    before: { producedAt: row.produced_at, storageObjectId: row.storage_object_id, fileSequence: row.file_sequence },
    after: {
      producedAt: input.producedAt,
      storageObjectId: object.id,
      fileSequence: sequence,
      mode: input.mode,
      source: input.source,
      repository: repository.slug,
      versionLabel: object.versionLabel,
      hashAlgorithm: object.hashAlgorithm,
      ...(input.auditAfter ?? {}),
    },
  });
  for (const msId of systems.ids) {
    await deps.jobs.send(
      'freshness.recompute',
      { orgId: input.org.id, requestedBy: input.userId, payload: { msId } },
      { singletonKey: `fr:${input.org.id}:${msId}`, startAfterSeconds: FRESHNESS_DELAY_SECONDS, retryLimit: 3 },
      trx,
    );
    await enqueueDerived(deps.jobs, trx, input.org, msId, input.userId);
  }
  return { sequence, versionLabel: object.versionLabel, updatedAt: updated.updated_at, systems, warnings };
}

/** What `fileGeneratedEvidence` files. */
export interface GeneratedEvidenceInput {
  msId: string;
  evidenceId: string;
  /** The file name the bytes get (the stored name follows the repository's metadata rule, as for uploads). */
  fileName: string;
  /** The type the server wrote; recorded in the audit entry. The stored type is the gateway's detection (F.13). */
  mimeType: string;
  bytes: Buffer;
}

export interface GeneratedEvidenceResult {
  storageObjectId: string;
  versionLabel: string | null;
  producedAt: string;
  fileSequence: number;
  repository: string;
  warnings: Warning[];
}

/** The services `fileGeneratedEvidence` uses (given by `FileCommandsService`). */
export interface GeneratedEvidenceDeps {
  routing: RoutingService;
  storage: StorageGatewayContext;
  gateway: GatewayClient;
  audit: AuditWriter;
  jobs: JobQueue;
  clock: Clock;
  adapters(orgId: string): AdapterAvailability;
}

/** The server's upload mode in a routed repository: the rule's stored or pass-through mode, else the repository's first. */
function serverUploadMode(ruleMode: string, repository: Pick<RepositoryRow, 'modes'>): UploadMode | null {
  const serverModes: readonly string[] = SERVER_UPLOAD_MODES;
  if (serverModes.includes(ruleMode) && (repository.modes as readonly string[]).includes(ruleMode)) return ruleMode as UploadMode;
  return (repository.modes.find((m) => serverModes.includes(m)) as UploadMode | undefined) ?? null;
}

/**
 * Stores server-generated bytes as a new file of an evidence item of the system `msId` and makes it the current file
 * (Milestone 3 D.7 close and file, D.9 completion). Runs in the caller's tenant transaction; the evidence row is locked
 * for the rest of it. 404 when the system or the evidence item (of that system) does not exist; BR-29 when the routed
 * repository cannot take files; 422 `files.no_upload_mode` when it only links or only takes browser uploads.
 */
export async function fileGeneratedEvidence(
  deps: GeneratedEvidenceDeps,
  trx: Trx,
  actor: EvidenceFileActor,
  input: GeneratedEvidenceInput,
): Promise<GeneratedEvidenceResult> {
  const org = await trx
    .selectFrom('platform.organization')
    .select(['id', 'time_zone'])
    .where(sql<boolean>`id = nullif(current_setting('app.org_id', true), '')::uuid`)
    .executeTakeFirst();
  if (!org) throw new Error('fileGeneratedEvidence needs the transaction of an organisation');
  const ms = await trx
    .selectFrom('management_system')
    .select(['id', 'slug', 'code'])
    .where('id', '=', input.msId)
    .where('deleted_at', 'is', null)
    .executeTakeFirst();
  if (!ms) throw new NotFoundError('No such management system');
  const evidence = await trx
    .selectFrom('evidence')
    .select(['id', 'evidence_code', 'produced_at', 'storage_object_id', 'file_sequence', 'frequency_code', 'classification'])
    .where('id', '=', input.evidenceId)
    .where('deleted_at', 'is', null)
    .forUpdate()
    .executeTakeFirst();
  if (!evidence || !(await evidenceSystemsOf(trx, evidence.id)).ids.includes(ms.id)) throw new NotFoundError('No such evidence item in this management system');

  const routed = await deps.routing.resolve(trx, { msId: ms.id, classification: evidence.classification, objectKind: 'evidence' });
  const repository = routed.repository;
  const mode = serverUploadMode(routed.mode, repository);
  if (!mode) {
    throw refusal('files.no_upload_mode', {
      en: `Repository ${repository.name} does not take files from the server; set a routing rule to a repository that stores files.`,
      id: `Repositori ${repository.name} tidak menerima berkas dari server; atur aturan perutean ke repositori yang menyimpan berkas.`,
    });
  }
  await assertRepositoryUsable(repository, deps.adapters(org.id));

  const now = deps.clock.now();
  // The organisation's today, or `demo.fixed_today` (as the route's producedAt default).
  const today = deps.clock.todayIn(org.time_zone);
  const sequence = evidence.file_sequence + 1;
  const storedName = storedFileName({ minimise: repository.metadata_minimization, code: evidence.evidence_code, sequence, fileName: input.fileName });
  const header: PutHeader = {
    tenant: await deps.storage.tenant(trx, org.id),
    repository: await deps.storage.repository(trx, repository),
    scopeRoot: scopeRootOf(repository, ms),
    folderPath: uploadFolder('evidence', today),
    fileName: storedName,
    maxBytes: Math.max(1, input.bytes.length),
    metadataMinimization: repository.metadata_minimization,
  };
  const result = await viaGateway(repository, () => deps.gateway.putObject<PutResult>(header, Readable.from([input.bytes])));
  const label = repository.adapter === 'managed_vault' ? `v${sequence}` : result.versionLabel;
  const object = await insertUploadedObject(trx, { repository, result, displayName: storedName, versionLabel: label ?? `v${sequence}`, userId: actor.userId, now });
  const attached = await attachEvidenceFile(trx, deps, {
    org: { id: org.id, timeZone: org.time_zone },
    msId: ms.id,
    evidence,
    object,
    repository,
    mode: 'submit',
    source: 'generated',
    producedAt: today,
    today,
    now,
    userId: actor.userId,
    actor,
    auditAfter: { generated: { fileName: input.fileName, mimeType: input.mimeType, uploadMode: mode } },
  });
  return {
    storageObjectId: object.id,
    versionLabel: attached.versionLabel,
    producedAt: today,
    fileSequence: attached.sequence,
    repository: repository.slug,
    warnings: attached.warnings,
  };
}
