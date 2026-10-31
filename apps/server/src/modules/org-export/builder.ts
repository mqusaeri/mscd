// The organisation export build (Milestone 3 D.4): reads the organisation's tenant schema, its platform rows, its audit
// chain and anchors, and the decrypted content of every Managed Vault file, and writes them as gzipped tar parts with a
// manifest (`archive/archive-writer.ts`). It runs in the organisation's tenant scope only, so data of another
// organisation never enters it; the one platform-scope read (sessions) is filtered by the organisation id. Used by the
// worker job `org-export.build` (parts go to the vault) and by `mscd-server export organization` (parts stay in a
// folder). The caller checks the free space of the working folder first (`checkFreeSpace`).
import { createPublicKey } from 'node:crypto';
import { statfs } from 'node:fs/promises';
import path from 'node:path';
import { Readable } from 'node:stream';
import { Inject, Injectable, Logger } from '@nestjs/common';
import type { GatewayObjectRef, GatewayRepository, GatewayTenant } from '@mscd/shared';
import { sql } from 'kysely';
import { ConflictError } from '../../common/problems';
import { GATEWAY_CLIENT, type GatewayClient, type TenantInfo, type Trx } from '../../common/tokens';
import { MscdConfig } from '../../config/mscd-config';
import { MIGRATIONS_BY_FOLDER, REVISION, VERSION } from '../../generated/build-info';
import { anchorKeyId } from '../audit/anchors';
import { AUDIT_ANCHOR_KEYS, tenantChainName, type AnchorKeys } from '../audit/chain-verifier';
import { loadAnchorSigningKey } from '../jobs/audit-verify-chain.job';
import { GatewayProblemError } from '../storage/gateway-client';
import { StorageGatewayContext } from '../storage/gateway-context';
import { TenantScope, systemContextOf } from '../tenancy/tenant-scope';
import { ArchiveWriter, type ArchivePart, type WrittenEntry } from './archive/archive-writer';
import { anchorFiles, dumpAuditTrail } from './audit-data';
import { useUtc, writeDataset } from './datasets';
import { exclusionList } from './exclusions';
import {
  MANIFEST_FORMAT,
  MANIFEST_FORMAT_VERSION,
  MANIFEST_NAME,
  manifestBytes,
  manifestEntry,
  type ExportManifest,
  type FileWithoutContent,
  type ManifestEntry,
} from './manifest';
import { inDatasetScope, peopleContext, PLATFORM_DATASETS, type PeopleContext } from './platform-data';
import { readmeText } from './readme';
import { Spool } from './spool';
import { dumpTenantTable, EXPORT_FOLDER_PREFIX, exportedAsData, tenantTables } from './tenant-data';

/** Folder label of the parts and manifest of an export in the Managed Vault. */
export function exportFolder(exportId: string): string {
  return `${EXPORT_FOLDER_PREFIX}${exportId}`;
}

/** 409 `conflict` with messageKey `export_too_large` (J.6). */
export function exportTooLarge(bytes: number, limit: number): ConflictError {
  const gib = (n: number) => (n / 1024 ** 3).toFixed(1);
  return new ConflictError(`The stored files take ${bytes} bytes, more than lifecycle.export_max_bytes (${limit})`, {
    messageKey: 'export_too_large',
    messages: {
      en: `The organisation stores ${gib(bytes)} GiB of files, more than the ${gib(limit)} GiB an export may hold. Ask your MSCD service provider to raise the limit.`,
      id: `Organisasi menyimpan ${gib(bytes)} GiB berkas, lebih dari ${gib(limit)} GiB yang dapat dimuat sebuah ekspor. Minta penyedia layanan MSCD Anda menaikkan batasnya.`,
    },
  });
}

/** Total plaintext size of the Managed Vault files an export holds (disposed and removed content and export parts left out). */
export async function storedFileBytes(trx: Trx, orgId: string): Promise<number> {
  const skip = await ownExportObjects(trx, orgId);
  const { rows } = await sql<{ bytes: string | null }>`
    select coalesce(sum(so.size_bytes), 0)::text as bytes
    from storage_object so join storage_repository r on r.id = so.storage_repository_id
    where r.adapter = 'managed_vault' and so.deleted_at is null and so.content_disposed_at is null
      and not (so.id = any(${skip}::uuid[]))`.execute(trx);
  return Number(rows[0]?.bytes ?? 0);
}

/** Storage objects that hold the parts and manifests of organisation exports (left out of every export). */
export async function ownExportObjects(trx: Trx, orgId: string): Promise<string[]> {
  const rows = await trx.selectFrom('platform.organization_export').select(['manifest_object_id', 'parts']).where('organization_id', '=', orgId).execute();
  const ids = new Set<string>();
  for (const row of rows) {
    if (row.manifest_object_id) ids.add(row.manifest_object_id);
    for (const part of partsOf(row.parts)) if (part.storageObjectId) ids.add(part.storageObjectId);
  }
  const folders = await sql<{ id: string }>`select id from storage_object where folder_path like ${`${EXPORT_FOLDER_PREFIX}%`}`.execute(trx);
  for (const row of folders.rows) ids.add(row.id);
  return [...ids];
}

/** A part as stored in `organization_export.parts`. */
export interface StoredPart {
  part: number;
  name: string;
  sizeBytes: number;
  sha256: string;
  storageObjectId: string | null;
}

/** The parts of an export row (an empty list for anything that is not one). */
export function partsOf(value: unknown): StoredPart[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((p: unknown) => {
    const o = (p ?? {}) as Record<string, unknown>;
    return typeof o.part === 'number' && typeof o.name === 'string' && typeof o.sizeBytes === 'number' && typeof o.sha256 === 'string'
      ? [{ part: o.part, name: o.name, sizeBytes: o.sizeBytes, sha256: o.sha256, storageObjectId: typeof o.storageObjectId === 'string' ? o.storageObjectId : null }]
      : [];
  });
}

/** Free bytes of the file system of `dir`. */
export async function freeBytes(dir: string): Promise<number> {
  const stats = await statfs(dir);
  return Number(stats.bavail) * Number(stats.bsize);
}

/** Throws when `dir` has less free space than `needed` bytes (D.4: the worker's folder must hold one part). */
export async function checkFreeSpace(dir: string, needed: number): Promise<void> {
  const free = await freeBytes(dir);
  if (free < needed) {
    throw new Error(
      `The folder ${dir} has ${free} bytes free and the export needs ${needed} (one part and the largest table). ` +
        'Give the worker a larger scratch folder (TMPDIR: the worker-tmp volume or MSCD_WORKER_TMP in Compose, worker.scratch.sizeLimit in Helm; ' +
        'section 19.1 of the on-premise guide) or lower lifecycle.export_part_bytes',
    );
  }
}

/** The migrations of an organisation schema as the manifest names them. */
export interface TenantMigrations {
  names: readonly string[];
  source: ExportManifest['tenantMigrationsSource'];
}

/**
 * The migrations applied to the transaction's tenant schema, from its `kysely_migration` table when the role may read
 * it. The application role may not (the table is private to the migrator, platform 0001), so the build's list is used
 * then and marked `build`.
 */
export async function appliedTenantMigrations(trx: Trx): Promise<TenantMigrations> {
  const { rows: access } = await sql<{ readable: boolean }>`
    select case when to_regclass(format('%I.kysely_migration', current_schema())) is null then false
                else has_table_privilege(format('%I.kysely_migration', current_schema()), 'SELECT') end as readable`.execute(trx);
  if (!access[0]?.readable) return { names: MIGRATIONS_BY_FOLDER.tenant, source: 'build' };
  const { rows } = await sql<{ name: string }>`select name from kysely_migration order by name`.execute(trx);
  return { names: rows.map((r) => r.name), source: 'schema' };
}

/** A file name safe as the last segment of an archive path: no control characters, no separators, at most 200 characters. */
export function safeFileName(name: string | null): string {
  // eslint-disable-next-line no-control-regex
  const cleaned = (name ?? '').normalize('NFC').replace(/[\u0000-\u001f\u007f-\u009f/\\:*?"<>|]/g, '-').replace(/\s+/g, ' ').trim();
  const cut = [...cleaned].slice(0, 200).join('').trim();
  return cut === '' || cut === '.' || cut === '..' ? 'file' : cut;
}

export interface BuildRequest {
  org: TenantInfo;
  exportId: string;
  requestedVia: string;
  /** Handles as the customer sees them (null for the system or the provider). */
  requestedBy: string | null;
  approvedBy: string | null;
  isFinal: boolean;
  /** Folder of the spools and the parts. */
  workDir: string;
  /** Largest part (gzipped bytes). */
  partBytes: number;
  /** Instant of the build (file times and names). */
  now: Date;
  /** Local date of the organisation (file names). */
  localDate: string;
  /** Each closed part, in order; the next part starts after it returns. */
  onPart(part: ArchivePart): Promise<void>;
  requestId?: string;
  /**
   * PEM of the installation's public anchor key, for a caller that cannot read `audit.anchor_key_file` (the command
   * line's `--anchor-key`, since the `cli` service has no private anchor key). The export names it; nothing trusts it.
   */
  anchorPublicKeyPem?: string;
}

export interface BuildResult {
  baseName: string;
  parts: ArchivePart[];
  /** The full manifest (`copy: "download"`) and its bytes. */
  manifest: ExportManifest;
  manifestBytes: Buffer;
  fileCount: number;
  sizeBytes: number;
  /** Key ids of anchors whose public key the build did not know (listed with a null PEM in `audit/anchor-keys.json`). */
  anchorKeyIdsWithoutKey: string[];
}

/** A public anchor key the export can name. */
interface NamedAnchorKey {
  keyId: string;
  publicKeyPem: string;
}

/** The public anchor key of a PEM (public or private; only the public half is kept), with its key id. */
export function publicAnchorKey(pem: string): NamedAnchorKey {
  const publicKey = createPublicKey(pem);
  if (publicKey.asymmetricKeyType !== 'ed25519') throw new Error('An anchor key must be an Ed25519 key');
  return { keyId: anchorKeyId(publicKey), publicKeyPem: publicKey.export({ type: 'spki', format: 'pem' }).toString() };
}

interface VaultFile {
  id: string;
  display_name: string | null;
  size_bytes: string | null;
  hash_algorithm: string;
  hash_value: string | null;
  hash_source: string;
  external_item_id: string;
  external_version_id: string | null;
  folder_path: string | null;
  deleted_at: Date | null;
  content_disposed_at: Date | null;
  repository_id: string;
  repository_slug: string;
}

interface Plan {
  tables: Awaited<ReturnType<typeof tenantTables>>;
  migrations: TenantMigrations;
  skip: string[];
  people: PeopleContext;
  files: VaultFile[];
  tenant: GatewayTenant;
  repositories: Map<string, GatewayRepository>;
  frameworkPacks: ExportManifest['frameworkPacks'];
}

@Injectable()
export class OrgExportBuilder {
  private readonly logger = new Logger('org-export');
  /** The public half of `audit.anchor_key_file` (read once; null when this process cannot read it). */
  private installationKey?: NamedAnchorKey | null;

  constructor(
    private readonly scope: TenantScope,
    private readonly config: MscdConfig,
    private readonly storage: StorageGatewayContext,
    @Inject(GATEWAY_CLIENT) private readonly gateway: GatewayClient,
    @Inject(AUDIT_ANCHOR_KEYS) private readonly anchorKeys: AnchorKeys,
  ) {}

  /**
   * The public anchor keys the export can name, with the key id of the installation's signing key: the public half of
   * `audit.anchor_key_file` (the key the worker signs anchors with; on-premise each installation makes its own), the key
   * the caller gives (`anchorPublicKeyPem`), then the keys compiled into the build.
   */
  private exportAnchorKeys(request: BuildRequest): { keys: AnchorKeys; installationKeyId: string | null } {
    if (this.installationKey === undefined) {
      try {
        const key = loadAnchorSigningKey(this.config);
        this.installationKey = key ? { keyId: key.keyId, publicKeyPem: key.publicKey.export({ type: 'spki', format: 'pem' }).toString() } : null;
      } catch (error) {
        this.logger.warn(`The audit anchor key (audit.anchor_key_file) cannot be read: ${(error as Error).message}; the export names the anchor keys it knows only`);
        this.installationKey = null;
      }
    }
    const given = request.anchorPublicKeyPem ? publicAnchorKey(request.anchorPublicKeyPem) : null;
    const keys: NamedAnchorKey[] = [];
    for (const key of [this.installationKey, given, ...this.anchorKeys]) {
      if (key && !keys.some((k) => k.keyId === key.keyId)) keys.push({ keyId: key.keyId, publicKeyPem: key.publicKeyPem });
    }
    return { keys, installationKeyId: this.installationKey?.keyId ?? given?.keyId ?? null };
  }

  /** Bytes the working folder needs: one part, or the whole export when it is smaller, with room for one table. */
  async neededSpace(org: TenantInfo, partBytes: number): Promise<number> {
    const estimate = await this.scope.withTenant(systemContextOf(org), async (trx) => {
      const files = await storedFileBytes(trx, org.id);
      const { rows } = await sql<{ bytes: string }>`
        select coalesce(sum(pg_total_relation_size(c.oid)), 0)::text as bytes
        from pg_class c join pg_namespace n on n.oid = c.relnamespace
        where n.nspname = current_schema() and c.relkind = 'r'`.execute(trx);
      return { files, tables: Number(rows[0]?.bytes ?? 0) };
    });
    // CSV and JSON Lines together take about twice the table size; one table is spooled while a part is open.
    return Math.min(partBytes, estimate.files + estimate.tables * 2) + Math.min(estimate.tables * 2, partBytes) + 16 * 1024 * 1024;
  }

  /** Builds the export into `workDir`, calling `onPart` for every closed part. */
  async build(request: BuildRequest): Promise<BuildResult> {
    const { org } = request;
    const context = systemContextOf(org, request.requestId);
    const plan = await this.scope.withTenant(context, (trx) => this.plan(trx, org));
    const baseName = `mscd-export-${org.slug}-${request.localDate}`;
    const writer = new ArchiveWriter({ dir: request.workDir, baseName, partBytes: request.partBytes, mtime: request.now, onPart: request.onPart });
    const entries: ManifestEntry[] = [];
    const withoutContent: FileWithoutContent[] = [];
    let spoolCount = 0;
    const spool = (suffix: string) => new Spool(path.join(request.workDir, `spool-${(spoolCount += 1)}.${suffix}`));

    /** Writes one dataset pair (CSV and JSON Lines) through spools into the archive. */
    const dataset = async (base: string, kind: 'table' | 'platform' | 'audit', write: (trx: Trx, csv: Spool, jsonl: Spool) => Promise<number>) => {
      const csv = spool('csv');
      const jsonl = spool('jsonl');
      try {
        const rows = await this.scope.withTenant(context, async (trx) => {
          await useUtc(trx);
          return write(trx, csv, jsonl);
        });
        await csv.close();
        await jsonl.close();
        entries.push(manifestEntry(await writer.add(`${base}.csv`, csv.size, csv.read()), kind, { rows }));
        entries.push(manifestEntry(await writer.add(`${base}.jsonl`, jsonl.size, jsonl.read()), kind, { rows }));
        return rows;
      } finally {
        await csv.remove();
        await jsonl.remove();
      }
    };

    try {
      const readme = Buffer.from(
        readmeText({ organisation: org.name, slug: org.slug, createdAt: request.now.toISOString(), mscdVersion: VERSION, baseName }),
        'utf8',
      );
      entries.push(manifestEntry(await writer.addBuffer('README.txt', readme), 'readme'));

      let tableCount = 0;
      let rowCount = 0;
      for (const table of plan.tables) {
        if (!exportedAsData(table.name)) continue;
        tableCount += 1;
        rowCount += await dataset(`data/tenant/${table.name}`, 'table', (trx, csv, jsonl) =>
          dumpTenantTable(trx, table, csv, jsonl, { skipStorageObjects: plan.skip }),
        );
      }
      for (const set of PLATFORM_DATASETS) {
        rowCount += await dataset(`data/platform/${set.name}`, 'platform', (trx, csv, jsonl) =>
          inDatasetScope(trx, set, () => writeDataset(trx, set.query(plan.people), set.columns, csv, jsonl, set.transform?.(plan.people))),
        );
      }

      const auditRows = await dataset('audit/audit_trail', 'audit', (trx, csv, jsonl) => dumpAuditTrail(trx, csv, jsonl));
      const chain = tenantChainName(org.schema);
      const anchorKeys = this.exportAnchorKeys(request);
      const anchors = await this.scope.withTenant(context, (trx) => anchorFiles(trx, chain, anchorKeys.keys, anchorKeys.installationKeyId));
      entries.push(manifestEntry(await writer.addBuffer('audit/anchors.jsonl', anchors.anchors), 'anchors', { rows: anchors.count }));
      entries.push(manifestEntry(await writer.addBuffer('audit/audit-anchor.pub', anchors.publicKey), 'key'));
      entries.push(manifestEntry(await writer.addBuffer('audit/anchor-keys.json', anchors.keys), 'key'));
      const anchorKeyIds = anchors.keyIds;

      const externalFiles = await this.externalFiles(context, writer, entries, spool);

      let fileCount = 0;
      let fileBytes = 0;
      for (const file of plan.files) {
        const written = await this.addVaultFile(writer, plan, file, withoutContent, request.workDir, request.requestId);
        if (!written) continue;
        entries.push(manifestEntry(written, 'file', { objectId: file.id }));
        fileCount += 1;
        fileBytes += written.sizeBytes;
      }

      const manifestFor = (copy: 'download' | 'last-part', parts: ExportManifest['parts']): ExportManifest => ({
        format: MANIFEST_FORMAT,
        formatVersion: MANIFEST_FORMAT_VERSION,
        copy,
        exportId: request.exportId,
        organization: { id: org.id, slug: org.slug, name: org.name },
        createdAt: request.now.toISOString(),
        requestedVia: request.requestedVia,
        requestedBy: request.requestedBy,
        approvedBy: request.approvedBy,
        isFinal: request.isFinal,
        mscd: { version: VERSION, revision: REVISION },
        tenantMigrations: plan.migrations.names,
        tenantMigrationsSource: plan.migrations.source,
        frameworkPacks: plan.frameworkPacks,
        parts,
        entries,
        filesWithoutContent: withoutContent,
        audit: { chain, rows: auditRows, anchors: anchors.count, anchorKeyIds },
        excluded: exclusionList(),
        counts: {
          tables: tableCount,
          rows: rowCount,
          files: fileCount,
          filesWithoutContent: withoutContent.length,
          externalFiles,
          fileBytes,
          entries: entries.length,
          parts: parts.length,
        },
      });
      const closedParts = () => writer.parts.map((p) => ({ part: p.part, name: p.name, sizeBytes: p.sizeBytes as number | null, sha256: p.sha256 as string | null }));
      const { lastPart } = await writer.finish(MANIFEST_NAME, (last) =>
        manifestBytes(manifestFor('last-part', [...closedParts().filter((p) => p.part < last), { part: last, name: writer.partName(last), sizeBytes: null, sha256: null }])),
      );
      const parts = [...writer.parts];
      if (parts.at(-1)?.part !== lastPart) throw new Error('The last part of the export is missing');
      const manifest = manifestFor('download', closedParts());
      return {
        baseName,
        parts,
        manifest,
        manifestBytes: manifestBytes(manifest),
        fileCount,
        sizeBytes: parts.reduce((n, p) => n + p.sizeBytes, 0),
        anchorKeyIdsWithoutKey: anchors.unknownKeyIds,
      };
    } catch (error) {
      await writer.abort();
      throw error;
    }
  }

  /** Reads what the build needs before writing (one tenant transaction). */
  private async plan(trx: Trx, org: TenantInfo): Promise<Plan> {
    const tables = await tenantTables(trx);
    const skip = await ownExportObjects(trx, org.id);
    const people = await peopleContext(trx, org.id);
    const { rows: files } = await sql<VaultFile>`
      select so.id, so.display_name, so.size_bytes::text as size_bytes, so.hash_algorithm, so.hash_value, so.hash_source, so.external_item_id,
             so.external_version_id, so.folder_path, so.deleted_at, so.content_disposed_at, r.id as repository_id, r.slug as repository_slug
      from storage_object so join storage_repository r on r.id = so.storage_repository_id
      where r.adapter = 'managed_vault' and not (so.id = any(${skip}::uuid[]))
      order by r.slug, so.created_at, so.id`.execute(trx);
    const repositories = new Map<string, GatewayRepository>();
    const repositoryRows = await trx.selectFrom('storage_repository').selectAll().where('adapter', '=', 'managed_vault').execute();
    for (const row of repositoryRows) repositories.set(row.id, await this.storage.repository(trx, row, { withCredential: false }));
    const { rows: packs } = await sql<{ system: string; pack_id: string; pack_version: string; role: string }>`
      select ms.code as system, fv.pack_id, fv.pack_version, 'active' as role
      from management_system ms join ref.framework_version fv on fv.id = ms.framework_version_id
      where ms.deleted_at is null
      union all
      select ms.code, fv.pack_id, fv.pack_version, 'transition_target'
      from management_system ms join ref.framework_version fv on fv.id = ms.transition_target_version_id
      where ms.deleted_at is null
      order by 1, 4`.execute(trx);
    return {
      tables,
      migrations: await appliedTenantMigrations(trx),
      skip,
      people,
      files,
      tenant: await this.storage.tenant(trx, org.id),
      repositories,
      frameworkPacks: packs.map((p) => ({ system: p.system, packId: p.pack_id, packVersion: p.pack_version, role: p.role })),
    };
  }

  /** `files/external-files.csv`: the files kept in the customer's Microsoft 365 or Google Drive repositories. */
  private async externalFiles(
    context: ReturnType<typeof systemContextOf>,
    writer: ArchiveWriter,
    entries: ManifestEntry[],
    spool: (suffix: string) => Spool,
  ): Promise<number> {
    const columns = [
      'object_id', 'adapter', 'repository', 'repository_name', 'folder_path', 'name', 'external_item_id', 'external_version_id', 'version_label',
      'hash_algorithm', 'hash_value', 'link_status', 'link_status_since', 'last_verified_at', 'web_url', 'deleted_at',
    ];
    const csv = spool('csv');
    const jsonl = spool('jsonl');
    try {
      const rows = await this.scope.withTenant(context, async (trx) => {
        await useUtc(trx);
        const query = sql`select row_to_json(x)::text as j from (
            select so.id as object_id, r.adapter, r.slug as repository, r.name as repository_name, so.folder_path, so.display_name as name,
                   so.external_item_id, so.external_version_id, so.version_label, so.hash_algorithm, so.hash_value, so.link_status,
                   so.link_status_since, so.last_verified_at, so.web_url, so.deleted_at
            from storage_object so join storage_repository r on r.id = so.storage_repository_id
            where r.adapter <> 'managed_vault'
            order by r.slug, so.folder_path, so.display_name, so.id) x`;
        return writeDataset(trx, query, columns, csv, jsonl);
      });
      await csv.close();
      entries.push(manifestEntry(await writer.add('files/external-files.csv', csv.size, csv.read()), 'file-list', { rows }));
      return rows;
    } finally {
      await csv.remove();
      await jsonl.remove();
    }
  }

  /** One Managed Vault file as `files/<repository>/<object id>/<name>`, or null when it is listed without content. */
  private async addVaultFile(
    writer: ArchiveWriter,
    plan: Plan,
    file: VaultFile,
    withoutContent: FileWithoutContent[],
    workDir: string,
    requestId?: string,
  ): Promise<WrittenEntry | null> {
    const name = safeFileName(file.display_name);
    const listed = (reason: FileWithoutContent['reason'], detail: string) => {
      withoutContent.push({ objectId: file.id, repository: file.repository_slug, name: file.display_name, reason, detail });
      return null;
    };
    if (file.content_disposed_at) return listed('disposed', `Disposed under the retention rules on ${file.content_disposed_at.toISOString()}`);
    if (file.deleted_at) return listed('removed', `Content removed from the Managed Vault on ${file.deleted_at.toISOString()} (an expired export file)`);
    const repository = plan.repositories.get(file.repository_id);
    if (!repository) return listed('missing', 'The repository of the file is no Managed Vault');
    const object: GatewayObjectRef = {
      externalItemId: file.external_item_id,
      externalVersionId: file.external_version_id,
      hashAlgorithm: file.hash_algorithm as GatewayObjectRef['hashAlgorithm'],
      hashValue: file.hash_value,
      hashSource: file.hash_source as GatewayObjectRef['hashSource'],
      folderPath: file.folder_path,
    };
    let streamed: Awaited<ReturnType<GatewayClient['stream']>>;
    try {
      streamed = await this.gateway.stream({ tenant: plan.tenant, repository, object }, requestId ? { requestId } : undefined);
    } catch (error) {
      if (error instanceof GatewayProblemError && error.gatewaySlug === 'not-found') {
        this.logger.warn({ objectId: file.id }, 'org-export: a Managed Vault file is missing; it is listed without content');
        return listed('missing', 'The Managed Vault has no content for this file');
      }
      throw error;
    }
    const archivePath = `files/${file.repository_slug}/${file.id}/${name}`;
    const size = streamed.size ?? (file.size_bytes === null ? null : Number(file.size_bytes));
    if (size !== null && Number.isSafeInteger(size) && size >= 0) return writer.add(archivePath, size, streamed.stream as Readable);
    // No size from the gateway or the database: the bytes are spooled first.
    const spooled = new Spool(path.join(workDir, `file-${file.id}`));
    try {
      for await (const chunk of streamed.stream) await spooled.write(chunk as Buffer);
      await spooled.close();
      return await writer.add(archivePath, spooled.size, spooled.read());
    } finally {
      await spooled.remove();
    }
  }
}
