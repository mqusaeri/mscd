// Helpers of the organisation export tests (Milestone 3 D.4, M3-02): the full api application (as `mscd-server api`
// builds it, with the org-export module, the jobs module and the expiry step) on the demo template with a storage
// gateway on SeaweedFS, vault files written through the gateway, the builds run in process, and the parts and manifest
// downloaded and unpacked.
import { createHash, randomBytes } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { Readable } from 'node:stream';
import { createGunzip } from 'node:zlib';
import type { OrganizationExportDetail, PutResult } from '@mscd/shared';
import { sql } from 'kysely';
import { GATEWAY_CLIENT, SYSTEM_USER_ID, type GatewayClient } from '../../../src/common/tokens';
import { readTar } from '../../../src/modules/org-export/archive/tar-reader';
import { OrgExportBuildJob } from '../../../src/modules/org-export/org-export-build.job';
import { StorageGatewayContext } from '../../../src/modules/storage/gateway-context';
import { TenantScope } from '../../../src/modules/tenancy/tenant-scope';
import type { TestDatabase } from '../../setup/test-db';
import { Client, createFullApp, ORG_IDS, inOrg, type DemoOrg, type FullApp } from '../contract/harness';
import { inScope } from '../db/helpers';

export { ORG_IDS, type DemoOrg };

export const sha256 = (bytes: Buffer | string) => createHash('sha256').update(bytes).digest('hex');

/** The full api application with the storage gateway at `gatewayUrl` (and other profile overrides). */
export function createExportApp(db: TestDatabase, gatewayUrl: string, env: Record<string, string> = {}): Promise<FullApp> {
  return createFullApp(db, { MSCD__STORAGE__GATEWAY__URL: gatewayUrl, ...env });
}

/** The managed vault repository of a demo organisation (first by position). */
export async function vaultRepository(db: TestDatabase, org: DemoOrg): Promise<{ id: string; slug: string }> {
  return inOrg(db, org, (trx) =>
    trx
      .selectFrom('storage_repository')
      .select(['id', 'slug'])
      .where('adapter', '=', 'managed_vault')
      .where('deleted_at', 'is', null)
      .orderBy('position')
      .orderBy('slug')
      .executeTakeFirstOrThrow(),
  );
}

/** Stores `bytes` in the organisation's Managed Vault through the gateway and records a storage object; returns its id. */
export async function putVaultFile(full: FullApp, db: TestDatabase, org: DemoOrg, fileName: string, bytes: Buffer, folder = 'Evidence/2026/Q3'): Promise<string> {
  const scope = full.get<TenantScope>(TenantScope);
  const storage = full.get<StorageGatewayContext>(StorageGatewayContext);
  const gateway = full.get<GatewayClient>(GATEWAY_CLIENT);
  const repo = await vaultRepository(db, org);
  const context = { orgId: ORG_IDS[org], schema: `org_${org}`, userId: SYSTEM_USER_ID };
  const target = await scope.withTenant(context, async (trx) => {
    const row = await storage.repositoryRow(trx, repo.id);
    return { row, descriptor: await storage.repository(trx, row), tenant: await storage.tenant(trx, ORG_IDS[org]) };
  });
  const result = await gateway.putObject<PutResult>(
    {
      tenant: target.tenant,
      repository: target.descriptor,
      scopeRoot: { folderId: null, path: '' },
      folderPath: folder,
      fileName,
      maxBytes: bytes.length + 1,
      metadataMinimization: target.row.metadata_minimization,
    },
    Readable.from([bytes]),
  );
  const now = new Date();
  const row = await scope.withTenant(context, (trx) =>
    trx
      .insertInto('storage_object')
      .values({
        storage_repository_id: repo.id,
        external_item_id: result.externalItemId,
        external_version_id: result.externalVersionId,
        version_label: result.versionLabel,
        display_name: fileName,
        mime_type: result.detectedMimeType,
        size_bytes: String(result.sizeBytes),
        hash_algorithm: 'sha256',
        hash_value: result.hashValue,
        hash_source: 'computed',
        provider_created_at: now,
        provider_modified_at: now,
        folder_path: result.folderPath,
        encryption: result.encryption ? JSON.stringify(result.encryption) : null,
        link_status: 'intact',
        link_status_since: now,
        created_by: SYSTEM_USER_ID,
        updated_by: SYSTEM_USER_ID,
      } as never)
      .returning('id')
      .executeTakeFirstOrThrow(),
  );
  return row.id;
}

/** True when the gateway still serves the content of a storage object. */
export async function vaultHas(full: FullApp, db: TestDatabase, org: DemoOrg, objectId: string): Promise<boolean> {
  const scope = full.get<TenantScope>(TenantScope);
  const storage = full.get<StorageGatewayContext>(StorageGatewayContext);
  const gateway = full.get<GatewayClient>(GATEWAY_CLIENT);
  const context = { orgId: ORG_IDS[org], schema: `org_${org}`, userId: SYSTEM_USER_ID };
  const request = await scope.withTenant(context, async (trx) => {
    const object = await trx.selectFrom('storage_object').selectAll().where('id', '=', objectId).executeTakeFirstOrThrow();
    const row = await trx.selectFrom('storage_repository').selectAll().where('id', '=', object.storage_repository_id).executeTakeFirstOrThrow();
    return {
      tenant: await storage.tenant(trx, ORG_IDS[org]),
      repository: await storage.repository(trx, row),
      object: {
        externalItemId: object.external_item_id,
        externalVersionId: object.external_version_id,
        hashAlgorithm: object.hash_algorithm,
        hashValue: object.hash_value,
        hashSource: object.hash_source,
        folderPath: object.folder_path,
      },
    };
  });
  try {
    const streamed = await gateway.stream(request);
    for await (const _ of streamed.stream) {
      // drain
    }
    return true;
  } catch (error) {
    if ((error as { gatewaySlug?: string }).gatewaySlug === 'not-found') return false;
    throw error;
  }
}

/** Runs `org-export.build` in process with a small part size. */
export function buildExport(full: FullApp, org: DemoOrg, exportId: string, partBytes = 256 * 1024) {
  return full.get<OrgExportBuildJob>(OrgExportBuildJob).build(ORG_IDS[org], exportId, { partBytes });
}

/** The stored row of an export (as the migrator, platform scope). */
export async function exportRow(db: TestDatabase, id: string) {
  return inScope(db.migrator, { platformScope: true }, (trx) => trx.selectFrom('platform.organization_export').selectAll().where('id', '=', id).executeTakeFirstOrThrow());
}

/** Ends every export of an organisation that is not final, so the next test can request one (fixture reset). */
export async function clearExports(db: TestDatabase, org: DemoOrg): Promise<void> {
  await inScope(db.migrator, { platformScope: true }, (trx) =>
    sql`update platform.organization_export set status = 'expired'
      where organization_id = ${ORG_IDS[org]} and status in ('requested', 'queued', 'building', 'ready', 'failed')`.execute(trx),
  );
}

/** Downloads every part and the manifest of a ready export into `dir`; returns the detail and the file paths. */
export async function downloadExport(client: Client, id: string, dir: string): Promise<{ detail: OrganizationExportDetail; parts: string[]; manifest: string }> {
  await mkdir(dir, { recursive: true });
  const detail = await client.get<OrganizationExportDetail>(`/api/v1/admin/organization/exports/${id}`);
  if (detail.status !== 200) throw new Error(`get ${detail.status} ${detail.text}`);
  const parts: string[] = [];
  for (const part of detail.body.parts) {
    const answer = await client.get(`/api/v1/admin/organization/exports/${id}/parts/${part.part}`);
    if (answer.status !== 200) throw new Error(`part ${part.part}: ${answer.status} ${answer.text}`);
    const file = path.join(dir, part.name);
    await writeFile(file, answer.raw.rawPayload);
    parts.push(file);
  }
  const manifestAnswer = await client.get(`/api/v1/admin/organization/exports/${id}/manifest`);
  if (manifestAnswer.status !== 200) throw new Error(`manifest ${manifestAnswer.status} ${manifestAnswer.text}`);
  const manifest = path.join(dir, detail.body.parts[0]!.name.replace(/-part-\d+\.tar\.gz$/, '-manifest.json'));
  await writeFile(manifest, manifestAnswer.raw.rawPayload);
  return { detail: detail.body, parts, manifest };
}

/** Every entry of the parts by name (pieces joined under the entry name). */
export async function unpackParts(files: readonly string[]): Promise<Map<string, Buffer>> {
  const out = new Map<string, Buffer>();
  for (const file of files) {
    const { createReadStream } = await import('node:fs');
    await readTar(createReadStream(file).pipe(createGunzip()), async (header, body) => {
      const chunks: Buffer[] = [];
      for await (const chunk of body) chunks.push(chunk);
      out.set(header.name, Buffer.concat(chunks));
    });
  }
  for (const name of [...out.keys()]) {
    const match = /^(.*)\.(\d{3})$/.exec(name);
    if (!match || match[2] !== '001') continue;
    const pieces: Buffer[] = [];
    for (let n = 1; out.has(`${match[1]}.${String(n).padStart(3, '0')}`); n += 1) pieces.push(out.get(`${match[1]}.${String(n).padStart(3, '0')}`)!);
    out.set(match[1]!, Buffer.concat(pieces));
  }
  return out;
}

/** Random bytes of a given size (incompressible, like most office files). */
export function randomFile(size: number): Buffer {
  return randomBytes(size);
}
